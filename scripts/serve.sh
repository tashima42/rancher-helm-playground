#!/usr/bin/env bash
#
# Serves the playground for local development on http://localhost:8080.
#
# The page loads data/ with fetch, which browsers block on file://, so it has to
# be served over http even though it is a plain static site.
#
# Usage: scripts/serve.sh [port]

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${1:-8080}"

if command -v node >/dev/null; then
  exec node "$repo_root/scripts/serve.mjs" "$repo_root" "$port"
fi

if command -v ruby >/dev/null; then
  echo "serving $repo_root on http://localhost:$port" >&2
  exec ruby -run -e httpd -- --port "$port" --bind-address 127.0.0.1 "$repo_root"
fi

echo "error: need node or ruby to serve the site; any static file server works" >&2
exit 1
