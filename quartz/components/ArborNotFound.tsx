import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

// Arbor's 404, replacing Quartz's ("Either this page is private or doesn't
// exist"). In a garden most 404s aren't typos — they're notes that exist in the
// vault but sit outside the published subset, so the page names both cases and
// says what to do next instead of leaving the reader at a dead end.
//
// Wired up in quartz.ts by swapping the built-in 404 page type's body.

// Keep in step with arbor-taxonomy: a link to an unpublished note is rendered
// with a padlock, so the reader may well have arrived here from one.
const PADLOCK = "🔒"

export default (() => {
  const ArborNotFound: QuartzComponent = ({ cfg, ctx }: QuartzComponentProps) => {
    const url = new URL(`https://${cfg.baseUrl ?? "example.com"}`)
    // Under `--serve` the dev server has no baseUrl subpath.
    const homeHref = ctx.argv.serve ? "/" : url.pathname

    return (
      <article class="popover-hint arbor-404">
        <p class="arbor-404-code">404</p>
        <h1 class="arbor-404-title">This note isn't here</h1>
        <p class="arbor-404-lede">Two things usually lead here:</p>
        <ul class="arbor-404-reasons">
          <li>
            <strong>The note isn't published.</strong> This garden is a subset of my vault — notes
            I haven't finished, or wouldn't want to share, stay private. Links to them are greyed
            out and marked with a padlock ({PADLOCK}).
          </li>
          <li>
            <strong>The link is broken.</strong> A note may have been renamed or removed, or the
            address mistyped.
          </li>
        </ul>
        <p class="arbor-404-actions">
          Try <a href={homeHref}>the home page</a>, or search for what you were looking for — the
          search box is in the corner of every page.
        </p>
        <script
          dangerouslySetInnerHTML={{
            __html: `
          if (typeof fetchData !== "undefined") {
            fetchData.then(function(index) {
              var basePath = document.body.dataset.basepath || "";
              if (basePath.length > 1 && basePath.endsWith("/")) {
                basePath = basePath.slice(0, -1);
              }
              var pathname = window.location.pathname;
              var hasBasePrefix = basePath.length > 1 && pathname.startsWith(basePath);
              if (hasBasePrefix) {
                pathname = pathname.slice(basePath.length);
              }
              if (pathname.startsWith("/")) {
                pathname = pathname.slice(1);
              }
              if (pathname.endsWith("/")) {
                pathname = pathname.slice(0, -1);
              }
              if (pathname.endsWith(".html")) {
                pathname = pathname.slice(0, -5);
              }
              if (pathname.endsWith("/index")) {
                pathname = pathname.slice(0, -6);
              }
              var lowered = pathname.toLowerCase();
              if (lowered !== pathname && index[lowered] != null) {
                var prefix = hasBasePrefix ? basePath : "";
                var target = prefix + (prefix.endsWith("/") ? "" : "/") + lowered;
                window.location.replace(target);
              }
            });
          }
          `,
          }}
        />
      </article>
    )
  }
  return ArborNotFound
}) satisfies QuartzComponentConstructor
