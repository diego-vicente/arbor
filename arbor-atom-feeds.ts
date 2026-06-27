/**
 * Arbor Atom feeds.
 *
 * Turns `feed:`-marked `.base` files into Atom feeds — one feed per VIEW. A base
 * is already a filtered, sorted, limited selection of notes (the bases engine,
 * matching Obsidian); a feed is the same selection serialized as Atom XML instead
 * of an HTML table. So this emitter reuses the bases resolver wholesale.
 *
 * Per base, for each view:
 *   • resolve the view through the bases engine over the PUBLISHED note set
 *     (so a feed can never surface a note the site itself doesn't publish), with
 *     the full vault as the link universe (so `on.asFile()` etc. resolve);
 *   • serialize entries to Atom at `/feeds/<slugified view name>.xml`.
 *
 * Entry conventions (documented in the `.base` too):
 *   • id / link  = the note's slug (stable across text edits → no duplicate items)
 *   • title      = the view's first `order` column (if it's a wikilink, its display
 *                  text is the title and its target is the link)
 *   • updated    = the note's `feed.timestampProperty` field (default `date`)
 *
 * Feed metadata (title/description) comes from `feed.views.<View Name>`; author
 * from `feed.author`.
 */
import path from "node:path"
import fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import type {
  QuartzEmitterPluginInstance,
  BuildCtx,
  ProcessedContent,
  FilePath,
} from "./quartz/plugins/types"
import {
  parseBasesData,
  resolveBasesEntries,
  resolvePropertyValue,
} from "./.quartz/plugins/bases-page/dist/index.js"

const ATOM_NS = "http://www.w3.org/2005/Atom"
const FEEDS_DIR = "feeds"
const DEFAULT_TIMESTAMP_PROP = "date"

type FeedMeta = { title?: string; description?: string }
type FeedConfig = {
  timestampProperty?: string
  author?: string
  views?: Record<string, FeedMeta>
}

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

/** View name → feed file stem (e.g. "Movie Reviews" → "movie-reviews"). */
const slugifyName = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

// A wikilink target may contain a single `]` (e.g. "[REC]³"), never `]]`.
const WIKILINK_RE = /^\[\[((?:[^\]]|\](?!\]))+)\]\]$/
function parseWikilink(value: unknown): { target: string; display: string } | null {
  if (typeof value !== "string") return null
  const inner = value.match(WIKILINK_RE)?.[1]
  if (inner === undefined) return null
  const bar = inner.indexOf("|")
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).split("#")[0]!.trim()
  const display = (bar >= 0 ? inner.slice(bar + 1) : inner).trim()
  return { target, display: display || target }
}

/** Coerce a value to an RFC-3339 timestamp (Atom requires a timezone). */
function toRfc3339(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Plain-text rendering of a cell value for use in a summary. */
function plainValue(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (Array.isArray(value)) return value.map(plainValue).filter(Boolean).join(", ")
  const wl = parseWikilink(value)
  if (wl) return wl.display
  return String(value)
}

type BasesEntry = {
  slug: string
  title: string
  properties: Record<string, unknown>
  fileProperties: Record<string, unknown>
  formulaValues: Record<string, unknown>
}
type BasesView = { name: string; order?: string[] }

function evalContextOf(entry: BasesEntry) {
  return { note: entry.properties, file: entry.fileProperties, formula: entry.formulaValues }
}

function renderEntry(
  entry: BasesEntry,
  view: BasesView,
  basesData: { properties?: Record<string, { displayName?: string }> },
  tsProp: string,
  baseUrl: string,
): { xml: string; updated: string | null } {
  const ctx = evalContextOf(entry)
  const order = view.order ?? []

  // Title (+ link) from the first ordered column.
  const titleRaw = order[0] ? resolvePropertyValue(order[0], ctx) : entry.title
  const titleLink = parseWikilink(titleRaw)
  const title = titleLink ? titleLink.display : plainValue(titleRaw) || entry.title
  const url = `${baseUrl}/${entry.slug}`

  const updated = toRfc3339(resolvePropertyValue(tsProp, ctx) ?? entry.properties[tsProp])

  // Summary: the remaining ordered columns as "Label: value" — skipping empties
  // and the timestamp column (already the entry's <published>).
  const bareName = (col: string) => col.replace(/^(formula|note|file)\./, "")
  const labelOf = (col: string): string => {
    const props = basesData.properties ?? {}
    for (const k of [col, `note.${col}`, `formula.${col}`, `file.${col}`]) {
      const dn = props[k]?.displayName
      if (dn) return dn
    }
    return bareName(col)
  }
  const summary = order
    .slice(1)
    .filter((col) => bareName(col) !== bareName(tsProp))
    .map((col) => {
      const text = plainValue(resolvePropertyValue(col, ctx))
      return text ? `${labelOf(col)}: ${text}` : ""
    })
    .filter(Boolean)
    .join(" · ")

  const xml = [
    "  <entry>",
    `    <title>${escapeXml(title)}</title>`,
    `    <id>${escapeXml(url)}</id>`,
    `    <link rel="alternate" href="${escapeXml(url)}"/>`,
    updated ? `    <updated>${updated}</updated>` : "",
    updated ? `    <published>${updated}</published>` : "",
    summary ? `    <summary>${escapeXml(summary)}</summary>` : "",
    "  </entry>",
  ]
    .filter(Boolean)
    .join("\n")

  return { xml, updated }
}

function buildAtom(opts: {
  entries: BasesEntry[]
  view: BasesView
  basesData: { properties?: Record<string, { displayName?: string }> }
  meta: FeedMeta
  author: string
  tsProp: string
  baseUrl: string
  feedSlug: string
}): string {
  const { entries, view, basesData, meta, author, tsProp, baseUrl, feedSlug } = opts
  const rendered = entries.map((e) => renderEntry(e, view, basesData, tsProp, baseUrl))
  const stamps = rendered.map((r) => r.updated).filter((u): u is string => Boolean(u))
  const feedUpdated = stamps.sort().at(-1) ?? new Date(0).toISOString()
  const selfUrl = `${baseUrl}/${feedSlug}.xml`

  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<feed xmlns="${ATOM_NS}">\n` +
    `  <title>${escapeXml(meta.title ?? view.name)}</title>\n` +
    (meta.description ? `  <subtitle>${escapeXml(meta.description)}</subtitle>\n` : "") +
    `  <id>${escapeXml(selfUrl)}</id>\n` +
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(selfUrl)}"/>\n` +
    `  <updated>${feedUpdated}</updated>\n` +
    (author ? `  <author><name>${escapeXml(author)}</name></author>\n` : "") +
    rendered.map((r) => r.xml).join("\n") +
    `\n</feed>\n`
  )
}

async function emitFeeds(ctx: BuildCtx, content: ProcessedContent[]): Promise<FilePath[]> {
  const cfg = (ctx as { cfg?: { configuration?: { baseUrl?: string } } }).cfg
  const rawBase = cfg?.configuration?.baseUrl ?? ""
  const baseUrl = `https://${rawBase.replace(/\/+$/, "")}`

  const published = content.map((c) => c[1].data as Record<string, unknown>)
  const fullVault =
    ((ctx as Record<string, unknown>).fullVaultFiles as Record<string, unknown>[] | undefined) ??
    published

  const allFiles = ((ctx as { allFiles?: string[] }).allFiles ?? []) as string[]
  const written: FilePath[] = []

  for (const rel of allFiles) {
    if (!rel.endsWith(".base")) continue
    let raw: string
    try {
      raw = readFileSync(path.join(ctx.argv.directory, rel), "utf8")
    } catch {
      continue
    }
    const basesData = parseBasesData(raw) as
      | {
          feed?: FeedConfig
          views?: BasesView[]
          properties?: Record<string, { displayName?: string }>
        }
      | null
    const feedCfg = basesData?.feed
    if (!feedCfg || !basesData?.views?.length) continue

    const tsProp = feedCfg.timestampProperty ?? DEFAULT_TIMESTAMP_PROP
    const author = feedCfg.author ?? ""

    for (const view of basesData.views) {
      if (!view?.name) continue
      const { entries } = resolveBasesEntries(
        basesData,
        published,
        view,
        undefined,
        fullVault,
      ) as { entries: BasesEntry[] }

      const feedSlug = `${FEEDS_DIR}/${slugifyName(view.name)}`
      const xml = buildAtom({
        entries,
        view,
        basesData,
        meta: feedCfg.views?.[view.name] ?? {},
        author,
        tsProp,
        baseUrl,
        feedSlug,
      })

      const outPath = path.join(ctx.argv.output, `${feedSlug}.xml`)
      await fs.mkdir(path.dirname(outPath), { recursive: true })
      await fs.writeFile(outPath, xml)
      written.push(`${feedSlug}.xml` as FilePath)
    }
  }

  return written
}

export function ArborAtomFeeds(): QuartzEmitterPluginInstance {
  return {
    name: "ArborAtomFeeds",
    async emit(ctx: BuildCtx, content: ProcessedContent[]): Promise<FilePath[]> {
      return emitFeeds(ctx, content)
    },
  }
}
