import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

// Arbor's footer, replacing the stock "Created with Quartz" footer. Rendered
// directly by the page frames (GardenFrame, DefaultFrame) — not via the footer
// plugin — so it's consistent across every page type.
const ARBOR_URL = "https://github.com/diego-vicente/arbor"
const QUARTZ_URL = "https://quartz.jzhao.xyz/"
// Quartz core version Arbor forks — mirrors the root package.json. Bump on upgrade.
const QUARTZ_VERSION = "5.0.0"

export default (() => {
  const ArborFooter: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
    const year = new Date().getFullYear()
    return (
      <footer class={`arbor-footer ${displayClass ?? ""}`}>
        <p>
          Created with <a href={ARBOR_URL}>Arbor</a>, a <a href={QUARTZ_URL}>Quartz</a> fork (v
          {QUARTZ_VERSION}) © {year}
        </p>
      </footer>
    )
  }
  return ArborFooter
}) satisfies QuartzComponentConstructor
