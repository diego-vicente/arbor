/**
 * Arbor — the `garden-wide` page frame (standalone .base pages).
 *
 * A base is a wide table or card grid, so it wants the whole content width; the
 * graph/backlinks rail earns little on an index page. But the toolbar living in
 * that rail (search, theme, reader mode) is still worth keeping, so we can't just
 * drop the right column via `positions: { right: [] }`.
 *
 * The markup is the garden frame's, unchanged — what differs is the NAME, which
 * renderPage emits as `data-frame` and which the stylesheet keys off: under
 * `garden-wide` the content spans the full inner width and the (toolbar-only)
 * rail is lifted out of the flow into the top-right corner. See
 * `.page[data-frame="garden-wide"]` in styles/custom.scss.
 *
 * Registered rather than added to quartz/components/frames so the fork keeps no
 * local edits to core; the registry is consulted ahead of the built-ins.
 */
import { GardenFrame } from "./quartz/components/frames/GardenFrame"
import { frameRegistry } from "./quartz/components/frames/registry"

export const GARDEN_WIDE_FRAME = "garden-wide"

frameRegistry.register(
  GARDEN_WIDE_FRAME,
  { name: GARDEN_WIDE_FRAME, render: GardenFrame.render },
  "arbor",
)
