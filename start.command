#!/bin/bash
# Starts mini-moonboarder and opens it in the browser.
# Double-click it in Finder, or run ./start.command. Ctrl+C (or closing the window) stops it.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

if ! command -v node >/dev/null; then
  echo "Node.js is not installed: brew install node" >&2
  exit 1
fi
if (( $(node -p 'process.versions.node.split(".")[0]') < 24 )); then
  echo "Node 24+ is required (found $(node -v)): brew upgrade node" >&2
  exit 1
fi

if curl -fs -o /dev/null "$URL/api/users"; then
  echo "Already running at $URL"
  open "$URL"
  exit 0
fi

[[ -d node_modules ]] || npm install

# Open the browser once the server answers.
(
  for _ in $(seq 50); do
    curl -fs -o /dev/null "$URL/api/users" && exec open "$URL"
    sleep 0.2
  done
) &

# caffeinate keeps the Mac from idle-sleeping, so phones can still reach it.
exec caffeinate -i node server/main.ts
