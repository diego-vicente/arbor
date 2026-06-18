import { PageFrame, PageFrameProps } from "./types"
import HeaderConstructor from "../Header"

const Header = HeaderConstructor()

/**
 * Garden frame — Obsidian-Publish-with-nav-off layout: NO left sidebar, content
 * pulled up-front on the left, and a right column (search, graph, backlinks).
 * Mirrors how garden.diego.codes renders with showNavigation:false.
 *
 * The body is a flexbox (content + right) rather than the base grid — flexbox is
 * predictable and avoids the min-width:100% / auto-track collapse that grid
 * overrides hit. Frame-scoped CSS lives in styles/custom.scss under
 * `.page[data-frame="garden"]`.
 */
export const GardenFrame: PageFrame = {
  name: "garden",
  render({
    componentData,
    header,
    beforeBody,
    pageBody: Content,
    afterBody,
    right,
    footer: Footer,
  }: PageFrameProps) {
    return (
      <>
        <div class="garden-main">
          <div class="center">
            <div class="page-header">
              <Header {...componentData}>
                {header.map((HeaderComponent) => (
                  <HeaderComponent {...componentData} />
                ))}
              </Header>
              <div class="popover-hint">
                {beforeBody.map((BodyComponent) => (
                  <BodyComponent {...componentData} />
                ))}
              </div>
            </div>
            <Content {...componentData} />
            <hr />
            <div class="page-footer">
              {afterBody.map((BodyComponent) => (
                <BodyComponent {...componentData} />
              ))}
            </div>
          </div>
          <div class="right sidebar">
            {right.map((BodyComponent) => (
              <BodyComponent {...componentData} />
            ))}
          </div>
        </div>
        <Footer {...componentData} />
      </>
    )
  },
}
