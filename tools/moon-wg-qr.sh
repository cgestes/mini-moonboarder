#!/usr/bin/env bash
# Builds the iPhone's WireGuard config for `npm run moon:proxy` and shows it as a QR code.
# Scan it in the WireGuard app (+ > Create from QR code). Needs: brew install wireguard-tools qrencode
set -euo pipefail
cd "$(dirname "$0")/.."

WGCONF="$HOME/.mitmproxy/wireguard.conf"
[ -f "$WGCONF" ] || { echo "Start the proxy first: npm run moon:proxy"; exit 1; }

key() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$WGCONF" "$1"; }
server_pub=$(key server_key | wg pubkey)
lan_ip=$(ipconfig getifaddr en0 || ipconfig getifaddr en1)

mkdir -p data
umask 077
cat > data/moon-wg.conf <<CONF
[Interface]
PrivateKey = $(key client_key)
Address = 10.0.0.1/32
DNS = 10.0.0.53

[Peer]
PublicKey = $server_pub
AllowedIPs = 0.0.0.0/0
Endpoint = $lan_ip:51820
CONF

qrencode -o data/moon-wg-qr.png -s 10 -m 2 < data/moon-wg.conf
echo "WireGuard config for $lan_ip:51820 -> data/moon-wg-qr.png"
open data/moon-wg-qr.png
