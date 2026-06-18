/**
 * Arbor publish-subset filter.
 *
 * Replicates the vault's Obsidian Publish selection rules (per Diego):
 *   - `publish: true`   → publish (overrides folder exclusion)
 *   - `publish: false`  → never publish (overrides everything)
 *   - `publish` missing → publish, UNLESS the note is inside an excluded folder
 *
 * Excluded folders come from `.obsidian/publish.json` (`excluded`). This is a
 * Quartz *filter* (decides emit), wired in via the quartz.ts escape hatch.
 *
 * Note: this applies to the LOCAL build too — so the preview matches the real
 * published site (no CARTO/Personal/`publish:false` notes). Set ARBOR_PUBLISH_ALL=1
 * to bypass and build the entire vault for debugging.
 */
import type { QuartzFilterPluginInstance } from "./quartz/plugins/types"

// Mirror of `.obsidian/publish.json` → `excluded`.
const EXCLUDED_FOLDERS = [
  "CARTO",
  "Personal",
  "Assets/Exported slides",
  "Assets/Templates",
  "Assets/Slides themes",
]

function inExcludedFolder(relPath: string): boolean {
  return EXCLUDED_FOLDERS.some((folder) => relPath.startsWith(`${folder}/`))
}

export function ArborPublishFilter(): QuartzFilterPluginInstance {
  const bypass = process.env.ARBOR_PUBLISH_ALL === "1"
  return {
    name: "ArborPublish",
    shouldPublish(_ctx, [, vfile]) {
      if (bypass) return true
      const data = vfile.data as {
        frontmatter?: Record<string, unknown>
        relativePath?: string
        filePath?: string
      }
      const publish = data.frontmatter?.publish
      // 1. Explicit frontmatter wins, both directions.
      if (publish === true || publish === "true") return true
      if (publish === false || publish === "false") return false
      // 2. Default: publish unless in an excluded folder. Use the original-case
      //    relative path (slug is lowercased, which would break folder matching).
      const relPath = (data.relativePath ?? data.filePath ?? "") as string
      return !inExcludedFolder(relPath)
    },
  }
}
