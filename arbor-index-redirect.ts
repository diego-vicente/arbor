/**
 * Arbor home redirect.
 *
 * The site home is the "Digital Garden" note, which keeps its natural slug
 * `digital-garden` (so the ~22 inbound `[[Digital Garden]]` links resolve). This
 * emitter writes a tiny `index.html` at the output root that redirects `/` to it.
 *
 * The redirect target is RELATIVE (`./digital-garden`) so it resolves correctly
 * both under the dev server (served from `/`) and in production under a baseUrl
 * subpath, without hardcoding either.
 */
import path from "node:path"
import fs from "node:fs/promises"
import type { QuartzEmitterPluginInstance, BuildCtx, FilePath } from "./quartz/plugins/types"

// Natural slug of the "Digital Garden" note (slugify of "Digital Garden.md").
const HOME_SLUG = "digital-garden"
// Slug the redirect itself is emitted at — the site root.
const REDIRECT_SLUG = "index"

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

export function ArborIndexRedirect(): QuartzEmitterPluginInstance {
  const writeRedirect = async (ctx: BuildCtx): Promise<FilePath[]> => {
    const outputPath = path.join(ctx.argv.output, `${REDIRECT_SLUG}.html`) as FilePath
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, redirectHtml(HOME_SLUG))
    return [outputPath]
  }

  return {
    name: "ArborIndexRedirect",
    async emit(ctx: BuildCtx): Promise<FilePath[]> {
      return writeRedirect(ctx)
    },
    async *partialEmit(ctx: BuildCtx): AsyncGenerator<FilePath> {
      for (const outputPath of await writeRedirect(ctx)) {
        yield outputPath
      }
    },
  }
}
