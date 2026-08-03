#!/usr/bin/env node
/**
 * Installs the plugins declared in quartz.config.yaml.
 *
 * Reads the YAML directly rather than importing the built config. Importing it
 * pulls in the whole plugin graph — components, emitters and, through
 * componentResources, a `.scss` import that only esbuild can resolve — so under
 * plain tsx this script died with ERR_UNKNOWN_FILE_EXTENSION before doing any
 * work. It also read `config.externalPlugins`, which nothing ever populates, so
 * even when that import succeeded it found an empty list and installed nothing.
 *
 * The normal build does NOT depend on this: config-loader installs any missing
 * plugin while loading. This script exists to install or refresh them on their
 * own, without a full build.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { installPlugins, parsePluginSource } from "./gitLoader.js"

const CONFIG_FILE = "quartz.config.yaml"

interface PluginEntry {
  source?: string
  enabled?: boolean
}

/** Plugin sources from the config, in declaration order and de-duplicated. */
function readPluginSources(configPath: string): string[] {
  const parsed = parseYaml(fs.readFileSync(configPath, "utf-8")) as
    | { plugins?: PluginEntry[] }
    | undefined
  const entries = parsed?.plugins ?? []
  const sources: string[] = []
  for (const entry of entries) {
    // Disabled plugins are installed too: toggling one on shouldn't require a
    // reinstall, and the loader resolves every declared source either way.
    if (typeof entry?.source === "string" && !sources.includes(entry.source)) {
      sources.push(entry.source)
    }
  }
  return sources
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
  const configPath = path.join(repoRoot, CONFIG_FILE)

  if (!fs.existsSync(configPath)) {
    console.error(`Could not find ${CONFIG_FILE} at ${configPath}`)
    process.exit(1)
  }

  const sources = readPluginSources(configPath)
  if (sources.length === 0) {
    console.log(`No plugins declared in ${CONFIG_FILE}.`)
    return
  }

  console.log(`Installing ${sources.length} plugin(s) from Git...`)
  const installed = await installPlugins(
    sources.map((source) => parsePluginSource(source)),
    { verbose: true },
  )

  if (installed.size === sources.length) {
    console.log("✓ All plugins installed successfully")
  } else {
    console.error(`✗ Only ${installed.size}/${sources.length} plugins installed`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Failed to install plugins:", err)
  process.exit(1)
})
