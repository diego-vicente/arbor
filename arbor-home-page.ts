/**
 * Arbor home page — publishes the home note at the site root.
 *
 * The site home is the "Digital Garden" note, which keeps its natural slug
 * `digital-garden` so the ~22 inbound `[[Digital Garden]]` links resolve. This
 * emitter publishes that same rendered page at the output root, so `/` serves
 * the home page directly.
 *
 * It used to write a meta-refresh stub instead, which broke under the SPA: the
 * stub isn't a Quartz document, so clicking the site title fetched it and morphed
 * it into the current page, and its relative refresh target then resolved against
 * whatever path the SPA had left in place — from `/reference/films` you landed on
 * `/reference/digital-garden`, a 404. A redirect can't be made reliable here
 * because the client never performs a real document load; serving the page itself
 * sidesteps the problem, and is a better landing experience anyway (no flash, no
 * extra round trip, works with JS disabled).
 *
 * Copying is safe because both files sit at the output root, so every relative
 * link inside resolves identically from either URL. Must run AFTER
 * ArborLinkColorizer so the copy includes its rewrites.
 */
import path from "node:path"
import fs from "node:fs/promises"
import type { BuildCtx, FilePath } from "./quartz/plugins/types"

// Natural slug of the "Digital Garden" note (slugify of "Digital Garden.md").
const HOME_SLUG = "digital-garden"
// Slug the home page is republished at — the site root.
export const ROOT_SLUG = "index"

/** Point search engines at the note's own URL rather than the duplicate at `/`. */
function withCanonical(html: string, targetSlug: string): string {
  const canonical = `<link rel="canonical" href="./${targetSlug}" />`
  if (/<link\s+rel="canonical"[^>]*>/i.test(html)) {
    return html.replace(/<link\s+rel="canonical"[^>]*>/i, canonical)
  }
  return html.replace(/<\/head>/i, `  ${canonical}\n</head>`)
}

/**
 * Fallback for the case where the home note isn't in the published set (it was
 * unpublished or renamed). A stub is still better than no root page at all, and
 * on a full document load its refresh does resolve correctly.
 */
function redirectHtml(targetSlug: string): string {
  const href = `./${targetSlug}`
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=${href}" />
    <link rel="canonical" href="${href}" />
    <title>Diego's Digital Garden</title>
  </head>
  <body>
    <p>Redirecting to <a href="${href}">the Digital Garden</a>…</p>
  </body>
</html>
`
}

/**
 * Republish the rendered home page at the output root.
 *
 * NOT an emitter: emitters run concurrently (`Promise.all` in processors/emit),
 * so being pushed last onto the array guarantees nothing — as an emitter this
 * copied the page before ArborLinkColorizer had rewritten it, and the root lost
 * every typed-link colour. ArborLinkColorizer calls this as the final step of its
 * own pass instead, which is ordered by construction.
 */
export async function publishHomeAtRoot(ctx: BuildCtx): Promise<FilePath[]> {
  const outputPath = path.join(ctx.argv.output, `${ROOT_SLUG}.html`) as FilePath
  const homePath = path.join(ctx.argv.output, `${HOME_SLUG}.html`)

  let html: string
  try {
    html = withCanonical(await fs.readFile(homePath, "utf-8"), HOME_SLUG)
  } catch {
    console.warn(
      `Arbor: no rendered "${HOME_SLUG}" page found; writing a redirect stub at / instead.`,
    )
    html = redirectHtml(HOME_SLUG)
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, html)
  return [outputPath]
}
