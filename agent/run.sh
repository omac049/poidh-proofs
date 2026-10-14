#!/bin/sh
# Runs claim.mjs with its pinned dependencies, installed outside the shared folder.
#   sh poidh/agent/run.sh status --chain base
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${POIDH_AGENT_WORKDIR:-$HOME/.cache/poidh-agent}"
mkdir -p "$WORK"
cp "$HERE/package.json" "$HERE/package-lock.json" "$HERE/claim.mjs" "$WORK/"
if [ ! -d "$WORK/node_modules/viem" ] || ! cmp -s "$HERE/package-lock.json" "$WORK/.installed-lock"; then
  # No install scripts, and the key is kept out of npm's environment.
  (cd "$WORK" && env -u POIDH_AGENT_KEY npm ci --ignore-scripts --no-audit --no-fund --silent >&2) && cp "$HERE/package-lock.json" "$WORK/.installed-lock"
fi
# Node's fetch only uses the environment's HTTPS proxy when asked to.
NODE_USE_ENV_PROXY=1 exec node --disable-warning=UNDICI-EHPA "$WORK/claim.mjs" "$@"
