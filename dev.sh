#!/usr/bin/env bash
# Arbor local dev.
#   ./dev.sh build    # one-off build of the full vault (content/ -> "Digital Garden") into public/
#   ./dev.sh serve    # stable static server of public/ at http://localhost:8080 (no watch)
#   ./dev.sh          # build, then serve
#   ./dev.sh deploy   # build, audit the publish subset, upload to Cloudflare Pages
#
# Why no watch: the vault is live (Obsidian Sync), so files appear/vanish
# constantly; Quartz's watch rebuild is fatal on a vanished file. So we build
# on demand and serve statically. `serve` reads public/ fresh per request, so
# you can run `./dev.sh build` in another terminal and just refresh the browser.
#
# Requires Node 22.x (24/26 break the toolchain).
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"
cd "$(dirname "$0")"

cmd="${1:-all}"
# Preflight: every copy of a shared @quartz-community/* package (core + plugins)
# must be byte-identical. They're github-pinned with no version, so installs
# drift silently — and a mismatched slugify breaks every link (see the script).
# Hard gate: with `set -e`, a non-zero exit here aborts the build.
do_check() { node scripts/check-dep-consistency.mjs; }
do_build() { do_check; echo "Building full vault (Node $(node --version))..."; ./quartz/bootstrap-cli.mjs build; }
do_serve() { node serve.mjs; }

# Cloudflare Pages project (direct upload — the vault isn't in git, so there is no
# repo for Pages to build from; we build here and push the finished output).
CF_PROJECT="garden-diego-codes"

# Refuse to publish a private note. The build applies ArborPublishFilter, but this
# is the last point where a mistake is still cheap, so verify the output rather
# than trust the filter: nothing marked `publish: false`, and nothing from an
# excluded folder unless it opted in with `publish: true`.
do_audit() { node scripts/check-publish-subset.mjs; }

do_deploy() {
  do_build
  do_audit
  echo "Deploying to Cloudflare Pages project '$CF_PROJECT'..."
  npx wrangler pages deploy public --project-name "$CF_PROJECT" --branch main --commit-dirty=true
}

case "$cmd" in
  check)  do_check ;;
  build)  do_build ;;
  serve)  do_serve ;;
  audit)  do_audit ;;
  deploy) do_deploy ;;
  all)    do_build; do_serve ;;
  *) echo "usage: ./dev.sh [check|build|serve|audit|deploy]"; exit 1 ;;
esac
