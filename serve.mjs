// Stable static server for the built site (public/).
//
// Purpose-built (not serve-handler) for two reasons specific to this vault:
//  1. The vault has many non-ASCII filenames (CJK, accents, em-dashes).
//     serve-handler crashes the whole process on those (ERR_INVALID_CHAR in its
//     Content-Disposition header). We set no such header and decode URLs safely.
//  2. Each request is wrapped in try/catch — one bad request returns 500, it
//     never takes down the server. Combined with no content-watching, this
//     survives the live, Obsidian-Sync-churning vault.
//
// Serves Quartz-style clean URLs: /foo/bar -> public/foo/bar.html (or .../index.html).
// Reads public/ fresh per request, so `./dev.sh build` refreshes the live site.
import http from "http";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

async function statFile(p) {
  try {
    const s = await fs.stat(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

// Resolve a request path to an on-disk file, honoring Quartz clean URLs.
async function resolveTarget(urlPath) {
  // Decode %xx and strip any query/hash already removed by caller.
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    rel = urlPath;
  }
  rel = rel.replace(/^\/+/, "");
  // Containment guard against path traversal.
  const base = path.resolve(ROOT, rel);
  if (base !== ROOT && !base.startsWith(ROOT + path.sep)) return null;

  const candidates = [];
  if (rel === "" || rel.endsWith("/")) {
    candidates.push(path.join(base, "index.html"));
  } else {
    candidates.push(base); // exact (e.g. .css/.webp/.js or an explicit .html)
    candidates.push(base + ".html"); // clean URL -> file.html
    candidates.push(path.join(base, "index.html")); // folder -> index.html
  }
  for (const c of candidates) {
    const s = await statFile(c);
    if (s) return { file: c, size: s.size };
  }
  return null;
}

const server = http.createServer((req, res) => {
  (async () => {
    const urlPath = (req.url || "/").split("?")[0].split("#")[0];
    const target = await resolveTarget(urlPath);
    if (!target) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset=utf-8><h1>404</h1><p>Not found: ${urlPath.replace(/</g, "&lt;")}</p>`);
      return;
    }
    const type = MIME[path.extname(target.file).toLowerCase()] || "application/octet-stream";
    // Note: NO Content-Disposition — that's what crashes serve-handler on non-ASCII names.
    res.writeHead(200, { "Content-Type": type, "Content-Length": target.size });
    const data = await fs.readFile(target.file);
    res.end(data);
  })().catch((err) => {
    // One bad request must never kill the server.
    try {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("500: " + (err && err.message ? err.message : "error"));
    } catch {
      /* headers already sent */
    }
  });
});

server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PORT, () => {
  console.log(`Arbor: serving public/ at http://localhost:${PORT} (no watch; re-run "./dev.sh build" to refresh)`);
});
