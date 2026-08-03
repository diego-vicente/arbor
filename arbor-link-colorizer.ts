/**
 * Arbor link colorizer (build-time, no client JS).
 *
 * The article content tree is colored at render time by the `arbor-taxonomy`
 * plugin's tree transform. But backlinks, the properties view, bases tables/cards,
 * tag pages, etc. are rendered by separate components whose links never pass
 * through that transform — so they stay the default color.
 *
 * Rather than fork every one of those components, this emitter runs LAST and does
 * a single build-time pass over the emitted HTML: for each internal `<a>` that
 * isn't already tagged, it resolves the target slug (from `data-slug`, or from the
 * href relative to the page) and injects `data-link-type=<type>`. The same CSS
 * palette then colors it. No runtime code ships to the browser.
 *
 * It also greys MISSING links: bases/component links whose target isn't a
 * published page never get crawl-links' `.broken` class (they bypass it), so they
 * looked like live links. This pass adds `.broken` to them so they read as missing
 * notes, matching the article. The padlock treatment stays article-only.
 */
import path from "node:path"
import fs from "node:fs/promises"
import { publishHomeAtRoot, ROOT_SLUG } from "./arbor-index-redirect"
import type {
  QuartzEmitterPluginInstance,
  BuildCtx,
  ProcessedContent,
  FilePath,
} from "./quartz/plugins/types"
// Single source of truth for `type` frontmatter → slug normalization.
import { normalizeType } from "./.quartz/plugins/arbor-taxonomy/dist/index.js"

const LINK_TYPE_ATTR = "data-link-type"
const HTML_EXT = ".html"

const stripSlashes = (s: string) => s.replace(/^\/+/, "").replace(/\/+$/, "")

/**
 * Decode the HTML entities that attribute serialization introduces, so the slug
 * we recover matches the raw file slug. Critical for slugs containing `"` (kept
 * by slugify and emitted as `&quot;` in href/data-slug) — without this they fail
 * to match `exists`/`types` and get wrongly greyed as broken. `&amp;` last.
 */
const htmlDecode = (s: string): string =>
  s
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/** Resolve an internal link's target to a canonical slug, mirroring crawl-links. */
function resolveSlug(href: string, dataSlug: string | undefined, pageSlug: string): string | null {
  if (dataSlug) return decodeURIComponent(stripSlashes(htmlDecode(dataSlug)))
  // Intra-document anchors and non-internal schemes are not notes.
  if (!href || href.startsWith("#") || /^[a-z]+:/i.test(href)) return null
  try {
    const url = new URL(htmlDecode(href), "https://h/" + stripSlashes(pageSlug))
    let full = stripSlashes(url.pathname.split("#")[0])
    full = decodeURIComponent(full)
    if (full === "" || full.endsWith("/")) full += "index"
    return full
  } catch {
    return null
  }
}

const getAttr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? m[1] : undefined
}

// Whole-anchor match (anchors don't nest, so the first </a> closes it) — lets us
// append a padlock SVG inside unpublished links, not just rewrite the open tag.
const ANCHOR_RE = /<a\b[^>]*>[\s\S]*?<\/a>/g
const BODY_SLUG_RE = /<body[^>]*\bdata-slug="([^"]*)"/

const BROKEN_CLASS = "broken"
const UNPUBLISHED_CLASS = "arbor-unpublished"
const CLASS_RE = /\bclass="([^"]*)"/

// Solid padlock glyph (Material-style), matching the plugin's article-side padlock
// (styled by .arbor-lock). Filled so it reads like an emoji/letter at 1em.
const LOCK_SVG =
  '<svg class="arbor-lock" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"' +
  ' fill="currentColor" aria-hidden="true"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7' +
  " 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6" +
  " 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71" +
  ' 0 3.1 1.39 3.1 3.1v2z"></path></svg>'

interface SlugInfo {
  /** slug → normalized type, for coloring (published markdown notes). */
  types: Map<string, string>
  /** Slugs that ARE a type's own note (e.g. "idea") — colored as that type itself. */
  typeSlugs: Set<string>
  /** Full-vault slug → type (incl. unpublished), to tell unpublished from non-existent. */
  vault: Map<string, string>
  /** Every emitted page slug, for existence checks (incl. tag/folder/base pages). */
  exists: Set<string>
}

/** True if a link target resolves to an emitted page (handle folder → `/index`). */
const isReachable = (slug: string, exists: Set<string>): boolean =>
  exists.has(slug) || exists.has(`${slug}/index`)

/** Add a class to an opening `<a ...>` tag string. */
const addClass = (openTag: string, cls: string): string =>
  openTag.replace(CLASS_RE, `class="$1 ${cls}"`)

/**
 * Process every untagged internal link on one page:
 *  - target is a note WITH a type → inject `data-link-type` (colored).
 *  - target is reachable but typeless → leave default.
 *  - target is unpublished (absent from output, present in the full vault) → color
 *    it, flag `.arbor-unpublished`, and append a padlock — matching article links.
 *  - target is non-existent (absent everywhere) → add `.broken` so it greys out.
 *
 * crawl-links does the broken/padlock distinction for article links; bases and
 * other component-rendered links bypass it, so this closes that gap.
 */
function colorizeHtml(html: string, slugs: SlugInfo): string {
  const pageSlug = html.match(BODY_SLUG_RE)?.[1] ?? ""
  return html.replace(ANCHOR_RE, (anchor) => {
    const gt = anchor.indexOf(">")
    let open = anchor.slice(0, gt + 1)
    const rest = anchor.slice(gt + 1) // inner HTML + "</a>"

    const cls = getAttr(open, "class") ?? ""
    const classes = cls.split(/\s+/)
    // Only genuine internal note links — skip external, tag pills, and anything
    // already handled upstream (colored, broken, or already padlocked by the plugin).
    if (!classes.includes("internal")) return anchor
    if (classes.includes("external") || classes.includes("tag-link")) return anchor
    if (classes.includes(BROKEN_CLASS) || classes.includes(UNPUBLISHED_CLASS)) return anchor
    if (open.includes(`${LINK_TYPE_ATTR}=`)) return anchor

    let slug = resolveSlug(getAttr(open, "href") ?? "", getAttr(open, "data-slug"), pageSlug)
    if (!slug) return anchor

    // Bases are emitted at a clean slug (`Places.base` → `/places`), but Quartz's
    // wikilink resolver still slugifies the `.base` FILE to `…places.base`. A `.base`
    // URL has a file extension, so static hosts serve it verbatim (no `.html`
    // fallback) → 404. Strip `.base` from the href/data-slug and the resolved slug
    // so the link points at the real page. (Folder-index bases are already clean.)
    if (slug.endsWith(".base")) {
      slug = slug.slice(0, -".base".length)
      open = open
        .replace(/(href="[^"#?]*)\.base(?=[#?"])/, "$1")
        .replace(/(data-slug="[^"#?]*)\.base(?=[#?"])/, "$1")
      anchor = open + rest
    }

    // A link to a type's own note (e.g. [[Idea]]) is colored by that type itself.
    const typeOf = (s: string): string | undefined =>
      slugs.typeSlugs.has(s) ? s : slugs.types.get(s)

    if (isReachable(slug, slugs.exists)) {
      const type = typeOf(slug)
      return type ? `${open.slice(0, -1)} ${LINK_TYPE_ATTR}="${type}">${rest}` : anchor
    }

    // Not in the output. Unpublished (exists in the vault) → padlock; else missing → grey.
    if (slugs.vault.has(slug)) {
      const type = slugs.typeSlugs.has(slug) ? slug : slugs.vault.get(slug) || undefined
      let newOpen = addClass(open, UNPUBLISHED_CLASS)
      if (type) newOpen = `${newOpen.slice(0, -1)} ${LINK_TYPE_ATTR}="${type}">`
      const withLock = rest.slice(0, rest.lastIndexOf("</a>")) + LOCK_SVG + "</a>"
      return newOpen + withLock
    }
    return addClass(open, BROKEN_CLASS) + rest
  })
}

/** slug → normalized type, for every published markdown note. */
function buildTypeMap(content: ProcessedContent[]): Map<string, string> {
  const types = new Map<string, string>()
  for (const [, vfile] of content) {
    const data = vfile.data as { slug?: string; frontmatter?: Record<string, unknown> }
    if (typeof data.slug !== "string") continue
    const type = normalizeType(data.frontmatter?.type)
    if (type) types.set(data.slug, type)
  }
  return types
}

/** Slug of an emitted HTML file, relative to the output root (POSIX separators). */
const slugOfEntry = (entry: string): string =>
  entry.slice(0, -HTML_EXT.length).split(path.sep).join("/")

/** Full-vault slug → type map recorded by ArborTaxonomyRecorder (incl. unpublished notes). */
function vaultTypeMap(ctx: BuildCtx): Map<string, string> {
  const stored = (ctx as unknown as Record<string, unknown>).__arborVaultTypes
  return stored instanceof Map ? (stored as Map<string, string>) : new Map<string, string>()
}

async function colorizeOutput(ctx: BuildCtx, content: ProcessedContent[]): Promise<FilePath[]> {
  const outputDir = ctx.argv.output
  const entries = await fs.readdir(outputDir, { recursive: true })
  const htmlEntries = entries.filter((e) => e.endsWith(HTML_EXT))
  // Existence = the set of pages we actually emitted (covers tag/folder/base pages,
  // which aren't in `content`); types come from the published markdown notes.
  const types = buildTypeMap(content)
  const vault = vaultTypeMap(ctx)
  // Type slugs from the FULL vault so unpublished-only types (e.g. journal-entry)
  // are recognized — a link to their note still self-colors.
  const slugs: SlugInfo = {
    types,
    typeSlugs: new Set<string>([...types.values(), ...[...vault.values()].filter(Boolean)]),
    vault,
    // ROOT_SLUG is added explicitly: the home page is published at `/` at the END
    // of this pass, so the readdir above hasn't seen it yet and every "Home"
    // breadcrumb would be treated as a dead link.
    exists: new Set([...htmlEntries.map(slugOfEntry), ROOT_SLUG]),
  }
  const touched: FilePath[] = []

  for (const entry of htmlEntries) {
    const filePath = path.join(outputDir, entry)
    const html = await fs.readFile(filePath, "utf8")
    const colored = colorizeHtml(html, slugs)
    if (colored !== html) {
      await fs.writeFile(filePath, colored)
      touched.push(filePath as FilePath)
    }
  }

  // Republish the home page at `/` once every page above is final. This runs here
  // rather than in its own emitter because emitters execute concurrently, so the
  // copy would race this pass and capture the pre-colorized HTML.
  touched.push(...(await publishHomeAtRoot(ctx)))
  return touched
}

export function ArborLinkColorizer(): QuartzEmitterPluginInstance {
  return {
    name: "ArborLinkColorizer",
    async emit(ctx: BuildCtx, content: ProcessedContent[]): Promise<FilePath[]> {
      return colorizeOutput(ctx, content)
    },
    // Re-run the full pass on incremental builds too (cheap relative to a full build).
    async *partialEmit(ctx: BuildCtx, content: ProcessedContent[]): AsyncGenerator<FilePath> {
      for (const filePath of await colorizeOutput(ctx, content)) {
        yield filePath
      }
    },
  }
}
