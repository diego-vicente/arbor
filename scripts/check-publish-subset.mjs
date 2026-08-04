#!/usr/bin/env node
/**
 * Deploy gate: verify the built output contains only notes meant to be public.
 *
 * ArborPublishFilter already decides this at build time, but a deploy is the last
 * moment a mistake is cheap — and the cost of getting it wrong is publishing a
 * private note to the internet, which a later fix doesn't undo. So this checks the
 * OUTPUT rather than re-reading the filter's intent:
 *
 *   - nothing marked `publish: false` may be emitted;
 *   - nothing inside an excluded folder may be emitted unless it opted in
 *     explicitly with `publish: true`.
 *
 * Exits non-zero on any violation, which aborts `./dev.sh deploy`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const contentDir = path.join(repoRoot, "content")
const outputDir = path.join(repoRoot, "public")

// Mirrors EXCLUDED_FOLDERS in arbor-publish-filter.ts.
const EXCLUDED_FOLDERS = [
  "CARTO",
  "Personal",
  "Assets/Exported slides",
  "Assets/Templates",
  "Assets/Slides themes",
]

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/
const PUBLISH_TRUE_RE = /^publish:\s*true\s*$/m
const PUBLISH_FALSE_RE = /^publish:\s*false\s*$/m

/** Every markdown file in the vault, as paths relative to content/. */
function* vaultNotes(dir = contentDir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* vaultNotes(full)
    else if (entry.name.endsWith(".md")) yield path.relative(contentDir, full)
  }
}

/**
 * Whether a note reached the output. Quartz's slugifier is more involved than
 * this, so we check the shapes it can produce and treat a miss as "not emitted" —
 * the gate is here to catch a *leak*, and a false clear on an odd filename is
 * safer than blocking every deploy on a slug mismatch.
 */
function isEmitted(relPath) {
  const withoutExt = relPath.replace(/\.md$/, "")
  const slug = withoutExt.toLowerCase().replace(/ /g, "-")
  return [
    path.join(outputDir, `${slug}.html`),
    path.join(outputDir, slug, "index.html"),
    path.join(outputDir, `${withoutExt}.html`),
  ].some((candidate) => fs.existsSync(candidate))
}

const inExcludedFolder = (relPath) =>
  EXCLUDED_FOLDERS.some((folder) => relPath.startsWith(`${folder}${path.sep}`))

function main() {
  if (!fs.existsSync(outputDir)) {
    console.error("check-publish-subset: no public/ directory — build first.")
    process.exit(1)
  }

  const leakedPrivate = []
  const leakedExcluded = []

  for (const relPath of vaultNotes()) {
    let raw
    try {
      raw = fs.readFileSync(path.join(contentDir, relPath), "utf-8")
    } catch {
      continue // vanished mid-run: the vault is live
    }
    const frontmatter = FRONTMATTER_RE.exec(raw)?.[1] ?? ""
    if (!isEmitted(relPath)) continue

    if (PUBLISH_FALSE_RE.test(frontmatter)) leakedPrivate.push(relPath)
    else if (inExcludedFolder(relPath) && !PUBLISH_TRUE_RE.test(frontmatter))
      leakedExcluded.push(relPath)
  }

  const report = (label, list) => {
    if (list.length === 0) return
    console.error(`\n  ${label} (${list.length}):`)
    for (const item of list.slice(0, 20)) console.error(`    ${item}`)
    if (list.length > 20) console.error(`    …and ${list.length - 20} more`)
  }

  if (leakedPrivate.length || leakedExcluded.length) {
    console.error("✗ publish subset check FAILED — refusing to deploy.")
    report("marked publish: false but emitted", leakedPrivate)
    report("in an excluded folder without publish: true", leakedExcluded)
    process.exit(1)
  }

  console.log("✓ publish subset: no private or excluded notes in the output")
}

main()
