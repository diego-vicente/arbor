/**
 * Arbor index-file mapping.
 *
 * Obsidian Publish lets you pick the site's landing page via `indexFile`
 * (here: the "Digital Garden" note). We deliberately do NOT re-slug that note to
 * `index`: doing so served it at `/` but orphaned its natural slug
 * (`digital-garden`), 404-ing the ~22 inbound `[[Digital Garden]]` links across
 * the vault. Instead the note keeps its natural slug and {@link ArborIndexRedirect}
 * emits a redirect at `/` → `/digital-garden`.
 *
 * This transformer now only moves the unrelated root `Index.md` utility note off
 * the `index` slug so it doesn't grab `/` (which the redirect owns).
 *
 * Slug is assigned in parse.ts BEFORE markdown transformers run, so reassigning
 * file.data.slug in a markdownPlugin takes effect for link resolution + emit.
 */
import type { QuartzTransformerPluginInstance, FullSlug, FilePath } from "./quartz/plugins/types"

// Slug remaps (vault-relative path → slug). Keeps the root `Index.md` utility
// note off the `index` slug so the home redirect (ArborIndexRedirect) owns `/`.
const SLUG_REMAP: Record<string, string> = {
  "Index.md": "index-entity", // Notebook-Navigator folder-index concept note
}

export function ArborIndexFile(): QuartzTransformerPluginInstance {
  return {
    name: "ArborIndexFile",
    markdownPlugins() {
      return [
        () => (_tree: unknown, file: { data: { relativePath?: FilePath; slug?: FullSlug } }) => {
          const target = file.data.relativePath && SLUG_REMAP[file.data.relativePath]
          if (target) {
            file.data.slug = target as FullSlug
          }
        },
      ]
    },
  }
}
