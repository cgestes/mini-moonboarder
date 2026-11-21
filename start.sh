#!/bin/bash
# Starts mini-moonboarder, opens it in the browser and shows the address to use on a phone.
# Run ./start.sh; Ctrl+C stops it.
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

# Wi-Fi first, then Ethernet.
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

show_phone_url() {
  if [[ -z "$IP" ]]; then
    echo "No network address found: is the Mac on Wi-Fi?"
    return
  fi
  local phone="http://$IP:$PORT"
  echo
  echo "On your phone (same Wi-Fi): $phone"
  if command -v qrencode >/dev/null; then
    qrencode -t ANSIUTF8 -m 2 "$phone"
  fi
  echo
}

if curl -fs -o /dev/null "$URL/api/users"; then
  echo "Already running at $URL"
  show_phone_url
  open "$URL"
  exit 0
fi

[[ -d node_modules ]] || npm install

# Once the server answers: show the phone address and open the browser.
(
  for _ in $(seq 50); do
    if curl -fs -o /dev/null "$URL/api/users"; then
      show_phone_url
      exec open "$URL"
    fi
    sleep 0.2
  done
) &

# caffeinate keeps the Mac from idle-sleeping, so phones can still reach it.
exec caffeinate -i node server/main.ts
