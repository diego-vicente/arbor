/**
 * Arbor per-type properties block — build-time port of the Obsidian Publish
 * `publish.js` "Frontmatter Properties Display".
 *
 * Publish shows a DIFFERENT set of fields per note `type` (always leading with
 * Type), with each field rendered by `kind` (wikilink/text/date/datetime/url).
 * Quartz's note-properties only does a flat allow-list, so we render this
 * ourselves as a render-time tree transform (note-properties stays enabled as
 * the frontmatter parser, but its own view is hidden via hidePropertiesView).
 *
 * No client JS — the block is built into the page HTML. Internal wikilink values
 * get `data-slug` + `internal` class so the link colorizer tints/greys/padlocks
 * them like any other link.
 */
import type {
  QuartzPageTypePlugin,
  QuartzPageTypePluginInstance,
  TreeTransform,
  QuartzComponent,
  QuartzComponentProps,
  QuartzComponentConstructor,
  FullSlug,
} from "./quartz/plugins/types"
import { slugifyFilePath, resolveRelative } from "./quartz/util/path"
import type { Element, ElementContent, Root } from "hast"

type Kind = "wikilink" | "text" | "date" | "datetime" | "url"
interface Field {
  label: string
  key: string
  kind: Kind
  /** `url` fields print the href as their own link text, which is unreadable for
   *  machine-built URLs (a Maps search query runs to hundreds of characters).
   *  Set this to label the link instead. */
  linkText?: string
}

// Ported verbatim from content/publish.js NOTE_TYPE_CONFIGS. Type is always first.
const TYPE_FIELD: Field = { label: "Type", key: "type", kind: "wikilink" }
const NOTE_TYPE_CONFIGS: Record<string, Field[]> = {
  "[[Artwork]]": [
    { label: "Author", key: "author", kind: "wikilink" },
    { label: "Movement", key: "movement", kind: "wikilink" },
    { label: "Where", key: "where", kind: "wikilink" },
    { label: "Year", key: "year", kind: "text" },
  ],
  "[[Film]]": [
    { label: "Directors", key: "directors", kind: "wikilink" },
    { label: "Genres", key: "genres", kind: "text" },
    { label: "Release Date", key: "release_date", kind: "date" },
  ],
  "[[Coffee Beans]]": [
    { label: "From", key: "from", kind: "wikilink" },
    { label: "Roaster", key: "roaster", kind: "wikilink" },
    { label: "Producer", key: "producer", kind: "wikilink" },
    { label: "Process", key: "process", kind: "wikilink" },
    { label: "Variety", key: "variety", kind: "wikilink" },
    { label: "Altitude", key: "altitude", kind: "text" },
  ],
  "[[Article]]": [
    { label: "Author", key: "author", kind: "wikilink" },
    { label: "Date", key: "date", kind: "date" },
    { label: "URL", key: "url", kind: "url" },
  ],
  "[[Recipe]]": [
    { label: "Author", key: "author", kind: "wikilink" },
    { label: "Tools", key: "tools", kind: "wikilink" },
    { label: "Difficulty", key: "difficulty", kind: "text" },
    { label: "Prep Time", key: "prep_time", kind: "text" },
    { label: "Total Time", key: "total_time", kind: "text" },
    { label: "Serving Size", key: "serving_size", kind: "text" },
  ],
  "[[Book]]": [{ label: "Author", key: "author", kind: "wikilink" }],
  "[[Talk]]": [
    { label: "Author", key: "author", kind: "wikilink" },
    { label: "Date", key: "date", kind: "datetime" },
  ],
  "[[Check-in]]": [
    { label: "On", key: "on", kind: "wikilink" },
    { label: "Rating", key: "rating", kind: "text" },
    { label: "Date", key: "date", kind: "datetime" },
  ],
  "[[Video]]": [
    { label: "Author", key: "author", kind: "wikilink" },
    { label: "Cast", key: "cast", kind: "wikilink" },
    { label: "URL", key: "url", kind: "url" },
  ],
  // Places had no entry, so a Place note showed only its Type. Coordinates, icon
  // and colour stay out — they configure the map, they aren't facts about the place.
  "[[Place]]": [
    { label: "Place Type", key: "placetype", kind: "wikilink" },
    { label: "Where", key: "where", kind: "wikilink" },
    { label: "Address", key: "address", kind: "text" },
    { label: "Google Maps", key: "gmaps_url", kind: "url", linkText: "Open" },
    { label: "Apple Maps", key: "apple_maps_url", kind: "url", linkText: "Open" },
    { label: "Place For", key: "place_for", kind: "text" },
  ],
}

const fieldsFor = (noteType: unknown): Field[] => {
  const extra = typeof noteType === "string" ? (NOTE_TYPE_CONFIGS[noteType] ?? []) : []
  return [TYPE_FIELD, ...extra]
}

// ── hast helpers ────────────────────────────────────────────────────────────
const text = (value: string): ElementContent => ({ type: "text", value })
const el = (
  tagName: string,
  properties: Record<string, unknown>,
  children: ElementContent[],
): Element => ({ type: "element", tagName, properties, children })

/** Parse `[[Target|Display]]` / `[[Target]]` / plain string → { target, display }. */
function parseWikilink(raw: string): { target: string; display: string } {
  const stripped = raw.replace(/^\[\[/, "").replace(/\]\]$/, "")
  const pipe = stripped.indexOf("|")
  if (pipe !== -1) {
    return { target: stripped.slice(0, pipe).trim(), display: stripped.slice(pipe + 1).trim() }
  }
  return { target: stripped.trim(), display: (stripped.split("/").pop() ?? stripped).trim() }
}

/** Build a name → slug lookup from all files (basename, title, aliases). */
function buildNameMap(allFiles: QuartzComponentProps["allFiles"]): Map<string, string> {
  const map = new Map<string, string>()
  const add = (name: unknown, slug: string) => {
    if (typeof name === "string" && name.trim() && !map.has(name.toLowerCase())) {
      map.set(name.toLowerCase(), slug)
    }
  }
  for (const f of allFiles ?? []) {
    const slug = f?.slug
    if (typeof slug !== "string") continue
    add(slug.split("/").pop(), slug) // basename
    const fm = (f.frontmatter ?? {}) as Record<string, unknown>
    add(fm.title, slug)
    const aliases = fm.aliases
    if (Array.isArray(aliases)) aliases.forEach((a) => add(a, slug))
  }
  return map
}

const toArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v])

const formatDate = (raw: unknown, withTime: boolean): string => {
  const d = new Date(String(raw))
  if (Number.isNaN(d.getTime())) return String(raw)
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : d.toLocaleDateString(undefined, { dateStyle: "medium" })
}

/** Render one field's value to hast inline nodes, per its kind. */
function renderValue(
  field: Field,
  raw: unknown,
  names: Map<string, string>,
  pageSlug: FullSlug,
): ElementContent[] {
  if (field.kind === "url") {
    const href = String(raw)
    return [
      el("a", { href, class: "external external-link", target: "_blank", rel: "noopener noreferrer" }, [
        text(field.linkText ?? href),
      ]),
    ]
  }
  if (field.kind === "date" || field.kind === "datetime") {
    return [text(formatDate(raw, field.kind === "datetime"))]
  }
  if (field.kind === "text") {
    return [text(toArray(raw).map((v) => String(v)).join(", "))]
  }
  // wikilink (possibly an array) → resolved internal links, comma-separated.
  const out: ElementContent[] = []
  toArray(raw).forEach((item, i) => {
    if (i > 0) out.push(text(", "))
    const { target, display } = parseWikilink(String(item))
    const slug = (names.get(target.toLowerCase()) ??
      slugifyFilePath(`${target}.md` as `${string}.md`)) as FullSlug
    out.push(
      el(
        "a",
        {
          href: resolveRelative(pageSlug, slug),
          class: "internal internal-link",
          "data-slug": slug,
        },
        [text(display)],
      ),
    )
  })
  return out
}

/** Render-time transform: prepend the per-type properties block to the content. */
export const renderProperties: TreeTransform = (root, slug, componentData) => {
  const fm = (componentData.fileData?.frontmatter ?? {}) as Record<string, unknown>
  const fields = fieldsFor(fm.type)
  const names = buildNameMap(componentData.allFiles)
  const pageSlug = slug as FullSlug

  const rows: Element[] = []
  for (const field of fields) {
    const raw = fm[field.key]
    if (raw === undefined || raw === null || raw === "") continue
    rows.push(
      el("tr", { class: "note-properties-row" }, [
        el("td", { class: "note-properties-key" }, [text(field.label)]),
        el("td", { class: "note-properties-value" }, renderValue(field, raw, names, pageSlug)),
      ]),
    )
  }

  // Append date rows: Created always; Updated only when it differs from Created
  // (compared at the displayed day granularity). Sources come from the created-
  // modified-date plugin (frontmatter → git → filesystem birthtime/mtime).
  const dateRow = (label: string, value: string) =>
    el("tr", { class: "note-properties-row" }, [
      el("td", { class: "note-properties-key" }, [text(label)]),
      el("td", { class: "note-properties-value" }, [text(value)]),
    ])
  const dates = (componentData.fileData?.dates ?? {}) as Record<string, unknown>
  const createdRaw = dates.created ?? dates.published ?? dates.modified
  if (createdRaw) {
    const created = formatDate(createdRaw, false)
    rows.push(dateRow("Note created", created))
    if (dates.modified) {
      const updated = formatDate(dates.modified, false)
      if (updated !== created) rows.push(dateRow("Last updated", updated))
    }
  }

  if (rows.length === 0) return

  // Reuse the note-properties plugin's markup/classes so it looks like the original
  // collapsible "Properties" box (its CSS is ported into custom.scss).
  const block = el("details", { class: "note-properties", open: true }, [
    el("summary", { class: "note-properties-header" }, [
      el("span", { class: "note-properties-title" }, [text("Properties")]),
      el("span", { class: "note-properties-count" }, [text(String(rows.length))]),
    ]),
    el("table", { class: "note-properties-table" }, [el("tbody", {}, rows)]),
  ])
  ;(root as Root).children.unshift(block)
}

const NoopBody: QuartzComponentConstructor = () => {
  const Component: QuartzComponent = (_props: QuartzComponentProps) => null
  return Component
}

export const ArborProperties: QuartzPageTypePlugin = (): QuartzPageTypePluginInstance => ({
  name: "ArborProperties",
  match: () => false,
  layout: "content",
  body: NoopBody,
  treeTransforms: () => [renderProperties],
})
