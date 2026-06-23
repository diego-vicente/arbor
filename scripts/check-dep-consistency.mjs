#!/usr/bin/env node
/**
 * Preflight: every copy of a shared `@quartz-community/*` package in the tree must
 * be byte-identical.
 *
 * Why this exists: these packages are pinned to `github:quartz-community/<pkg>`
 * (no version), so each `npm install` resolves whatever the default branch is AT
 * THAT MOMENT. arbor core and each plugin install at different times, so their
 * bundled copies silently drift — all still stamped `0.1.0`. That bit us once: a
 * stale `@quartz-community/utils` in core kept `<>:"|*` in slugs while the plugins'
 * newer copy stripped them, so base row links never matched the emitted pages and
 * every quoted-title article 404'd. A version check can't catch this (same
 * version, different code), so we fingerprint the actual compiled `dist` JS.
 *
 * Exits non-zero (failing the build) if any package has >1 distinct copy.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import { join, relative } from "path";

const ROOT = process.cwd();
const SCOPE = "@quartz-community";
const PRUNE = new Set([".git", "public", ".quartz-cache", "dist-types", ".cache"]);

/** Collect every installed `@quartz-community/*` package dir: [pkgName, absDir][]. */
function findCopies(dir, found = [], depth = 0) {
  if (depth > 14) return found;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (PRUNE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.name === "node_modules") {
      const scopeDir = join(full, SCOPE);
      if (existsSync(scopeDir)) {
        for (const pkg of readdirSync(scopeDir)) {
          const pkgDir = join(scopeDir, pkg);
          if (existsSync(join(pkgDir, "package.json"))) {
            found.push([`${SCOPE}/${pkg}`, pkgDir]);
          }
        }
      }
      findCopies(full, found, depth + 1); // nested node_modules can hold more copies
    } else {
      findCopies(full, found, depth + 1);
    }
  }
  return found;
}

/** Fingerprint a package's runtime code: every compiled `.js` under it, except
 *  sourcemaps (absolute paths drift per machine) and nested deps. Order-stable. */
function fingerprint(pkgDir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) files.push(full);
    }
  };
  walk(pkgDir);
  files.sort((a, b) => relative(pkgDir, a).localeCompare(relative(pkgDir, b)));
  const h = createHash("sha256");
  for (const f of files) {
    h.update(relative(pkgDir, f));
    h.update(readFileSync(f));
  }
  return h.digest("hex");
}

const copies = findCopies(ROOT);
const byPkg = new Map(); // name -> Map<hash, dir[]>
for (const [name, dir] of copies) {
  const hash = fingerprint(dir);
  if (!byPkg.has(name)) byPkg.set(name, new Map());
  const m = byPkg.get(name);
  if (!m.has(hash)) m.set(hash, []);
  m.get(hash).push(dir);
}

const diverged = [...byPkg.entries()].filter(([, m]) => m.size > 1);

if (diverged.length === 0) {
  const n = byPkg.size;
  console.log(`✓ dep consistency: ${n} ${SCOPE}/* package${n === 1 ? "" : "s"}, all copies identical`);
  process.exit(0);
}

console.error(`\n✗ dep consistency FAILED — diverging copies of ${SCOPE}/* found.\n`);
for (const [name, m] of diverged) {
  console.error(`  ${name}: ${m.size} distinct versions across ${[...m.values()].flat().length} copies`);
  let i = 0;
  for (const [hash, dirs] of m) {
    console.error(`    [${String.fromCharCode(65 + i++)}] ${hash.slice(0, 12)}`);
    for (const d of dirs) console.error(`        ${relative(ROOT, d)}`);
  }
}
console.error(
  `\nThese packages are pinned to github (no version), so installs drift. Align them:` +
    `\n  npm install ${diverged.map(([n]) => `github:quartz-community/${n.split("/")[1]}`).join(" ")}` +
    `\nthen reinstall any plugin whose copy is still behind ` +
    `(rm -r .quartz/plugins/<name> && npx quartz plugin install --from-config).` +
    `\nBuild aborted: a build with mismatched slugify would silently break links.\n`,
);
process.exit(1);
