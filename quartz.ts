import { loadQuartzConfig, loadQuartzLayout } from "./quartz/plugins/loader/config-loader"
import "./arbor-map-view" // Arbor: register the Bases "map" view into bases-page's registry
import "./arbor-bases-frame" // Arbor: register the `garden-wide` frame used by .base pages
import { ArborPublishFilter } from "./arbor-publish-filter"
import { ArborIndexFile } from "./arbor-index-file"
import { ArborLinkColorizer } from "./arbor-link-colorizer"
import { ArborAtomFeeds } from "./arbor-atom-feeds"
import { ArborProperties } from "./arbor-properties"
import ArborNotFoundConstructor from "./quartz/components/ArborNotFound"
// Arbor: the real filter factory from the installed plugin. The generated plugin
// index only re-exports it as a component-registry stub, so import the dist directly.
import { ArborTaxonomyRecorder } from "./.quartz/plugins/arbor-taxonomy/dist/index.js"

const config = await loadQuartzConfig()
// Arbor: record the FULL pre-filter vault (slug -> type) so arbor-taxonomy can tell
// unpublished-but-existing link targets (padlock) from non-existent ones. Must run
// before any publish/draft filter — unshift to the front of the filter chain.
config.plugins.filters.unshift(ArborTaxonomyRecorder())
// Arbor: apply the publish-subset rules (publish frontmatter overrides; else
// publish unless in an excluded folder). See arbor-publish-filter.ts.
config.plugins.filters.push(ArborPublishFilter())
// Arbor: keep the root Index.md utility note off the `index` slug. Runs first so
// the slug override is in place before link resolution. See arbor-index-file.ts.
config.plugins.transformers.unshift(ArborIndexFile())
// Arbor: per-type properties block (build-time port of publish.js's per-type
// Frontmatter Properties Display). Contributes a tree transform; note-properties
// stays the frontmatter parser but its own view is hidden (hidePropertiesView).
config.plugins.pageTypes ??= []
config.plugins.pageTypes.push(ArborProperties() as (typeof config.plugins.pageTypes)[number])
// Arbor: swap the body of the built-in 404 page type for our own. Mutating the
// existing entry rather than adding one keeps its match/generate/priority — two
// page types generating the slug `404` would collide.
const notFoundPageType = config.plugins.pageTypes.find((pt) => pt.name === "404")
if (notFoundPageType) {
  // The dispatcher calls `body(opts)` itself, so this is the constructor, not the
  // constructed component.
  notFoundPageType.body = ArborNotFoundConstructor as typeof notFoundPageType.body
} else {
  console.warn("Arbor: no built-in 404 page type found; the stock 404 is unchanged.")
}
// Arbor: emit Atom feeds from `feed:`-marked .base files (one feed per view).
// See arbor-atom-feeds.ts. Emits .xml, so it's independent of the colorizer's HTML pass.
config.plugins.emitters.push(ArborAtomFeeds())
// Arbor: build-time pass that colors internal links in components the tree transform
// can't reach (backlinks, properties, bases, tag pages). Page HTML is written in an
// earlier build phase, so this sees every rendered page. As its final step it also
// publishes the home note at `/` (see arbor-index-redirect.ts) — that copy has to
// observe the colorized HTML, and emitters run concurrently, so it can't be its own
// emitter. See arbor-link-colorizer.ts.
config.plugins.emitters.push(ArborLinkColorizer())
export default config
export const layout = await loadQuartzLayout()
