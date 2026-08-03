/**
 * Arbor — Bases "map" view (build-time SSR + MapLibre island).
 *
 * Registers a custom `map` view type into bases-page's globalThis ViewRegistry.
 * At BUILD time it resolves each entry's coordinates / marker color / popup
 * fields (logic ported from obsidianmd/obsidian-maps) and emits a static
 * GeoJSON blob + a container div. At READ time, a small island (afterDOMLoaded)
 * lazy-loads MapLibre GL JS and draws the markers — no per-page query work.
 *
 * This is a local dev registration via the quartz.ts escape hatch. Once proven
 * it will be extracted into a standalone `arbor-bases-map` Quartz plugin.
 */
import { h } from "preact";
import { transformLink, slugifyPath } from "@quartz-community/utils";
import type { FullSlug } from "@quartz-community/types";

// --- Shared registry singleton (same well-known Symbol bases-page uses, so we
// --- attach to the exact same instance regardless of module copy/order). ---
const REGISTRY_KEY = Symbol.for("@quartz-community/bases-page/viewRegistry");

interface ViewTypeRegistration {
  id: string;
  name: string;
  icon?: string;
  render: (props: ViewRendererProps) => unknown;
  css?: string;
  afterDOMLoaded?: string;
}
interface MinimalRegistry {
  register(reg: ViewTypeRegistration): void;
  get(id: string): ViewTypeRegistration | undefined;
  getAll(): ViewTypeRegistration[];
  has(id: string): boolean;
}
// Mirror bases-page's ViewRegistry API so whichever module wins the `??=` race
// exposes a compatible surface.
class ArborViewRegistry implements MinimalRegistry {
  private views = new Map<string, ViewTypeRegistration>();
  register(reg: ViewTypeRegistration): void {
    this.views.set(reg.id, reg);
  }
  get(id: string): ViewTypeRegistration | undefined {
    return this.views.get(id);
  }
  getAll(): ViewTypeRegistration[] {
    return Array.from(this.views.values());
  }
  has(id: string): boolean {
    return this.views.has(id);
  }
}
const g = globalThis as unknown as Record<symbol, MinimalRegistry>;
const viewRegistry: MinimalRegistry = (g[REGISTRY_KEY] ??= new ArborViewRegistry());

// --- Minimal slice of bases-page's ViewRendererProps / BasesEntry. ---
interface BasesEntry {
  slug: string;
  title: string;
  properties: Record<string, unknown>;
  fileProperties: Record<string, unknown>;
  formulaValues: Record<string, unknown>;
}
interface BasesView {
  type: string;
  name?: string;
  order?: string[];
  coordinates?: string;
  markerIcon?: string;
  markerColor?: string;
  center?: string | [number, number];
  defaultZoom?: number;
  minZoom?: number;
  maxZoom?: number;
  mapHeight?: number;
  [key: string]: unknown;
}
interface ViewRendererProps {
  entries: BasesEntry[];
  view: BasesView;
  basesData: unknown;
  total: number;
  locale: string;
  slug: string;
  allSlugs: string[];
  linkResolution: "absolute" | "relative" | "shortest";
}

// --- Defaults (mirroring obsidian-maps constants). ---
const DEFAULT_MAP_HEIGHT = 600;
const DEFAULT_ZOOM = 4;
const TILE_STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const TILE_STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
const MAPLIBRE_VERSION = "5.6.1";

// --- Property resolution: note. / formula. / file. / bare → note. ---
function resolveProp(propId: string | undefined, entry: BasesEntry): unknown {
  if (!propId) return undefined;
  if (propId.startsWith("formula.")) return entry.formulaValues[propId.slice(8)];
  if (propId.startsWith("file.")) return entry.fileProperties[propId.slice(5)];
  if (propId.startsWith("note.")) return entry.properties[propId.slice(5)];
  return entry.properties[propId];
}

// --- Coordinate parsing — ported from obsidian-maps/src/map/utils.ts, adapted
// --- to the plain JS values bases-page hands us (arrays / strings / numbers). ---
function parseCoordinate(value: unknown): number | null {
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
function verifyLatLng(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
function coordinateFromValue(value: unknown): [number, number] | null {
  let lat: number | null = null;
  let lng: number | null = null;
  if (Array.isArray(value) && value.length >= 2) {
    lat = parseCoordinate(value[0]);
    lng = parseCoordinate(value[1]);
  } else if (typeof value === "string") {
    const parts = value.trim().split(",");
    if (parts.length >= 2) {
      lat = parseCoordinate(parts[0].trim());
      lng = parseCoordinate(parts[1].trim());
    }
  }
  if (lat != null && lng != null && verifyLatLng(lat, lng)) return [lat, lng];
  return null;
}

function parseCenter(center: string | [number, number] | undefined): [number, number] | null {
  if (!center) return null;
  if (Array.isArray(center)) return coordinateFromValue(center);
  // Stored as e.g. "[40.41834, -3.70131]"
  const cleaned = center.replace(/[[\]]/g, "");
  return coordinateFromValue(cleaned);
}

// Visible text for a wikilink with no alias: the note's own name, not its vault
// path ("Personal Atlas/Foo" reads as "Foo"). URL-shaped targets are left alone —
// `link(url, "Label")` builds a wikilink whose target is a real URL.
function wikilinkLabel(target: string): string {
  if (/^[a-z]+:\/\//i.test(target)) return target;
  const lastSegment = target.slice(target.lastIndexOf("/") + 1);
  return lastSegment || target;
}

function toText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(", ");
  // Strip a leading wikilink target/alias for display
  const s = String(value);
  const m = /^\[\[(.+?)(?:\|(.*))?\]\]$/.exec(s.trim());
  if (m) return (m[2] ?? wikilinkLabel(m[1] ?? "")).trim();
  return s;
}

// --- Link-aware popup rendering (parity with the bases-page tables). ---
// The map island injects popup HTML client-side, so we resolve links to <a>
// strings at BUILD time here rather than shipping the resolver to the browser.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface LinkCtx {
  slug: string;
  allSlugs: string[];
  linkResolution: "absolute" | "relative" | "shortest";
}

// transformLink() runs decodeURI internally and throws on a literal `%` in the
// target; mirror the fork's safeTransformLink fallback so one bad title can't
// crash the build.
function safeLink(from: string, target: string, ctx: LinkCtx): string {
  const opts = { strategy: ctx.linkResolution, allSlugs: ctx.allSlugs as FullSlug[] };
  try {
    return String(transformLink(from as FullSlug, target, opts));
  } catch {
    try {
      return String(transformLink(from as FullSlug, target.replace(/%/g, "%25"), opts));
    } catch {
      return "#";
    }
  }
}

const isExternalHref = (t: string) => /^https?:\/\//i.test(t) || t.startsWith("mailto:");

function anchor(href: string, label: string, external: boolean): string {
  const cls = external ? "external external-link" : "internal internal-link";
  const rel = external ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<a href="${escapeHtml(href)}" class="${cls}"${rel}>${escapeHtml(label)}</a>`;
}

function isFileValue(v: unknown): v is { basename: string; path: string } {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).path === "string" &&
    typeof (v as Record<string, unknown>).basename === "string"
  );
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MDLINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const URL_RE = /https?:\/\/[^\s<>]+/g;

// Linkify a plain string: wikilinks (incl. link()'s `[[url|Label]]` form),
// markdown links, and bare URLs → anchors; everything else HTML-escaped.
function linkifyString(text: string, ctx: LinkCtx): string {
  type Seg = { start: number; end: number; html: string };
  const segs: Seg[] = [];
  const overlaps = (s: number, e: number) => segs.some((g) => s < g.end && e > g.start);

  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = (m[1] ?? "").trim();
    const label = (m[2] ?? wikilinkLabel(target)).trim();
    const ext = isExternalHref(target);
    segs.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      html: anchor(ext ? target : safeLink(ctx.slug, target, ctx), label, ext),
    });
  }
  for (const m of text.matchAll(MDLINK_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (overlaps(s, e)) continue;
    const label = m[1] ?? "";
    const href = m[2] ?? "";
    const ext = isExternalHref(href);
    segs.push({ start: s, end: e, html: anchor(ext ? href : safeLink(ctx.slug, href, ctx), label || href, ext) });
  }
  for (const m of text.matchAll(URL_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (overlaps(s, e)) continue;
    segs.push({ start: s, end: e, html: anchor(m[0], m[0], true) });
  }

  if (segs.length === 0) return escapeHtml(text);
  segs.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const g of segs) {
    if (g.start > cursor) out += escapeHtml(text.slice(cursor, g.start));
    out += g.html;
    cursor = g.end;
  }
  if (cursor < text.length) out += escapeHtml(text.slice(cursor));
  return out;
}

// A resolved property value → popup HTML (links preserved). Mirrors the fork's
// renderCellValue for the value shapes the expression engine produces.
function toHtml(value: unknown, ctx: LinkCtx): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((v) => toHtml(v, ctx)).filter(Boolean).join(", ");
  if (isFileValue(value)) {
    return anchor(safeLink(ctx.slug, slugifyPath(value.path.replace(/\.md$/, "")), ctx), value.basename, false);
  }
  if (typeof value === "string") return linkifyString(value, ctx);
  return escapeHtml(String(value));
}

// Property label: prefer the base's configured displayName, else prettify the
// last path segment (parity with bases-page getColumnLabel).
function propLabel(col: string, basesData: unknown): string {
  const cfg = (basesData as { properties?: Record<string, { displayName?: string }> } | null)?.properties?.[col];
  if (cfg?.displayName) return cfg.displayName;
  const seg = col.split(".").pop() ?? col;
  return seg
    .split("_")
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

// --- GeoJSON FeatureCollection built at BUILD time. ---
function buildFeatureCollection(props: ViewRendererProps) {
  const { entries, view, slug, allSlugs, linkResolution, basesData } = props;
  const ctx: LinkCtx = { slug, allSlugs, linkResolution };
  const coordProp = view.coordinates ?? "note.coordinates";
  const colorProp = view.markerColor;
  const iconProp = view.markerIcon;
  const DEFAULT_COLOR = "#008080";
  // Popup fields = view.order minus the columns the view consumes as map *config*
  // rather than content: coordinates, markerIcon and markerColor. Obsidian doesn't
  // list those as popup rows (they're already expressed by the marker itself), so
  // excluding them here keeps the popup identical to the vault's — driven by the
  // same base configuration, no per-base edits needed.
  const configProps = new Set(
    [coordProp, view.coordinates, view.markerIcon, view.markerColor].filter(Boolean) as string[],
  );
  const orderFields = (view.order ?? []).filter((c) => !configProps.has(c));
  // The FIRST remaining field is the popup title (the note name, linked); the rest
  // become label/value rows.
  const rowFields = orderFields.slice(1);

  const features: unknown[] = [];
  for (const entry of entries) {
    const coords = coordinateFromValue(resolveProp(coordProp, entry));
    if (!coords) continue;
    const [lat, lng] = coords;
    const color = (colorProp ? toText(resolveProp(colorProp, entry)) : "") || DEFAULT_COLOR;
    const icon = iconProp ? toText(resolveProp(iconProp, entry)) : "";
    // Stable composite key so the island builds one sprite per icon+color pair.
    const iconKey = `${icon || "_"}|${color}`;
    // Title: always the note name, linked to its own page.
    const titleField = orderFields[0];
    const titleText = (titleField ? toText(resolveProp(titleField, entry)) : "") || entry.title;
    const titleHref = safeLink(slug, entry.slug, ctx);
    const rows = rowFields
      .map((col) => ({ label: propLabel(col, basesData), html: toHtml(resolveProp(col, entry), ctx) }))
      .filter((r) => r.html);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] }, // GeoJSON = [lng, lat]
      properties: { titleText, titleHref, slug: entry.slug, color, icon: icon || undefined, iconKey, rows },
    });
  }
  return { type: "FeatureCollection", features };
}

// --- The render fn: emits the container + an embedded JSON blob. ---
function MapView(props: ViewRendererProps): unknown {
  const { view } = props;
  const fc = buildFeatureCollection(props);
  const center = parseCenter(view.center);
  const config = {
    center: center ? [center[1], center[0]] : null, // → [lng, lat] for MapLibre
    zoom: typeof view.defaultZoom === "number" ? view.defaultZoom : DEFAULT_ZOOM,
    minZoom: view.minZoom,
    maxZoom: view.maxZoom,
    styleLight: TILE_STYLE_LIGHT,
    styleDark: TILE_STYLE_DARK,
    maplibreVersion: MAPLIBRE_VERSION,
    data: fc,
  };
  const height = typeof view.mapHeight === "number" ? view.mapHeight : DEFAULT_MAP_HEIGHT;
  // dangerouslySetInnerHTML so Preact doesn't HTML-escape the JSON (which would
  // corrupt it inside a <script type="application/json">). Guard </script>.
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return h(
    "div",
    { class: "arbor-map-wrapper" },
    h("div", {
      class: "arbor-map",
      style: `height:${height}px`,
    }),
    h("script", {
      type: "application/json",
      class: "arbor-map-data",
      dangerouslySetInnerHTML: { __html: json },
    }),
  );
}

// --- Scoped CSS injected once on pages with a map view. ---
const css = `
.arbor-map-wrapper { margin: 1em 0; position: relative; }
.arbor-map { width: 100%; border-radius: var(--radius-m, 8px); overflow: hidden; background: var(--background-secondary, #eee); }
.maplibregl-popup-content { font-size: 0.88rem; padding: 10px 12px; }
.arbor-map-popup-title { font-weight: 600; display: block; margin-bottom: 5px; font-size: 1.1em; }
.arbor-map-popup-title a { text-decoration: none; }
.arbor-map-popup-title a:hover { text-decoration: underline; }
.arbor-map-popup-row { display: flex; gap: 6px; line-height: 1.5; }
.arbor-map-popup-label { color: var(--gray, #888); flex: 0 0 auto; }
.arbor-map-popup-value { min-width: 0; word-break: break-word; }
.arbor-map-popup-value a { text-decoration: none; }
.arbor-map-popup-value a:hover { text-decoration: underline; }
`;

// --- The READ-time island. Plain ES2020 (no TS) — injected verbatim into a
// --- <script>. Lazy-loads MapLibre from CDN, draws markers + popups. ---
const afterDOMLoaded = `
(function () {
  function loadCss(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    var l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l);
  }
  async function initMap(wrapper) {
    if (wrapper.dataset.arborInit) return;
    wrapper.dataset.arborInit = "1";
    var el = wrapper.querySelector(".arbor-map");
    var dataEl = wrapper.querySelector(".arbor-map-data");
    if (!el || !dataEl) return;
    var cfg;
    try { cfg = JSON.parse(dataEl.textContent); } catch (e) { return; }
    var ver = cfg.maplibreVersion || "5.6.1";
    loadCss("https://cdn.jsdelivr.net/npm/maplibre-gl@" + ver + "/dist/maplibre-gl.css");
    var maplibregl = (await import("https://esm.sh/maplibre-gl@" + ver)).default;
    var dark = document.documentElement.getAttribute("saved-theme") === "dark"
      || document.documentElement.classList.contains("dark");
    var style = dark ? cfg.styleDark : cfg.styleLight;
    var feats = (cfg.data && cfg.data.features) || [];
    var map = new maplibregl.Map({
      container: el,
      style: style,
      center: cfg.center || [0, 20],
      zoom: cfg.zoom || 4,
      minZoom: cfg.minZoom,
      maxZoom: cfg.maxZoom,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    // Build a composite marker sprite (colored disc + white Lucide icon) per
    // unique icon|color pair, mirroring obsidian-maps' canvas compositing.
    var ICON_BASE = "https://cdn.jsdelivr.net/npm/lucide-static@0.563.0/icons/";
    var svgCache = {};
    function loadIconSvg(name) {
      if (!name) return Promise.resolve(null);
      if (svgCache[name]) return svgCache[name];
      svgCache[name] = fetch(ICON_BASE + name + ".svg")
        .then(function (r) { return r.ok ? r.text() : null; })
        .catch(function () { return null; });
      return svgCache[name];
    }
    function drawSvgToCanvas(ctx, svgText, cx, cy, px) {
      // Recolor Lucide stroke to white and rasterize via an <img>.
      var colored = svgText.replace(/currentColor/g, "#ffffff");
      var url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(colored)));
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () { ctx.drawImage(img, cx - px / 2, cy - px / 2, px, px); resolve(); };
        img.onerror = function () { resolve(); };
        img.src = url;
      });
    }
    async function buildMarker(iconName, color) {
      var scale = 2, size = 44 * scale, r = 13 * scale;
      var canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      var ctx = canvas.getContext("2d");
      var cx = size / 2, cy = size / 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.fillStyle = color || "#008080"; ctx.fill();
      ctx.lineWidth = 1.5 * scale; ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.stroke();
      var svg = await loadIconSvg(iconName);
      if (svg) await drawSvgToCanvas(ctx, svg, cx, cy, 15 * scale);
      else { ctx.beginPath(); ctx.arc(cx, cy, 4 * scale, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill(); }
      return await createImageBitmap(canvas);
    }

    map.on("load", async function () {
      // One sprite per unique iconKey.
      var pairs = {};
      feats.forEach(function (f) {
        var p = f.properties || {};
        if (p.iconKey && !pairs[p.iconKey]) pairs[p.iconKey] = { icon: p.icon || "", color: p.color || "#008080" };
      });
      await Promise.all(Object.keys(pairs).map(async function (key) {
        try {
          var bmp = await buildMarker(pairs[key].icon, pairs[key].color);
          if (!map.hasImage(key)) map.addImage(key, bmp, { pixelRatio: 2 });
        } catch (e) {}
      }));

      map.addSource("arbor-markers", { type: "geojson", data: cfg.data });
      map.addLayer({
        id: "arbor-markers",
        type: "symbol",
        source: "arbor-markers",
        layout: {
          "icon-image": ["get", "iconKey"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 14, 0.75, 18, 0.85],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      // Fit to markers if no explicit center was set.
      if (!cfg.center && feats.length) {
        var b = new maplibregl.LngLatBounds();
        feats.forEach(function (f) { b.extend(f.geometry.coordinates); });
        if (!b.isEmpty()) map.fitBounds(b, { padding: 40, maxZoom: 14, duration: 0 });
      }
      var popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true });
      map.on("click", "arbor-markers", function (e) {
        var f = e.features && e.features[0]; if (!f) return;
        var p = f.properties || {};
        var rows = []; try { rows = JSON.parse(p.rows); } catch (_) { rows = p.rows || []; }
        var title = p.titleHref
          ? '<a class="internal internal-link" href="' + p.titleHref + '">' + (p.titleText || "") + "</a>"
          : (p.titleText || "");
        var html = '<span class="arbor-map-popup-title">' + title + "</span>";
        (rows || []).forEach(function (r) {
          html += '<div class="arbor-map-popup-row"><span class="arbor-map-popup-label">' + r.label + ':</span><span class="arbor-map-popup-value">' + r.html + "</span></div>";
        });
        popup.setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
      });
      map.on("mouseenter", "arbor-markers", function () { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "arbor-markers", function () { map.getCanvas().style.cursor = ""; });
    });
  }
  function initAll() { document.querySelectorAll(".arbor-map-wrapper").forEach(initMap); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initAll);
  else initAll();
  document.addEventListener("nav", initAll);
})();
`;

viewRegistry.register({ id: "map", name: "Map", icon: "map", render: MapView, css, afterDOMLoaded });
