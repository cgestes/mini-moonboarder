# mini-moonboarder

Track Mini MoonBoard 2020 problems at 20°, 25°, 30°, 35° and 40°: tries and sends per angle, per climber.
Runs locally on your computer; use it from your phone on the same Wi-Fi.

## Run

Requires Node 24+ (uses built-in TypeScript stripping and `node:sqlite`).

```sh
npm install
npm start          # or: npm run dev (restarts on changes)
```

The server prints a `http://192.168.x.x:3000` address. Open it on your phone and use
"Add to Home Screen" to get it as an app icon. Data lives in `data/moonboard.db` (SQLite).

Env vars: `PORT` (default 3000), `DB_PATH` (default `data/moonboard.db`).

## Syncing problems from the Moon app

The MoonBoard website no longer serves problems, and the Moon Climbing app's backend
(`rest-v1.moonclimbing.com`) requires Firebase App Check, so a script can't log in on its own.
Instead we borrow the phone's session: mitmproxy runs as a WireGuard VPN on this computer, the Moon
app makes one request through it, and we replay that request's headers against the problem sync
endpoint (`/_bs_api/v1/problems/get/19/0/...`, found by
[mbdalpha/moonboard-scraper](https://github.com/mbdalpha/moonboard-scraper)).

One-time setup (`brew install --cask mitmproxy` and `brew install wireguard-tools qrencode`):

1. `npm run moon:proxy`, then in another terminal `npm run moon:qr` and scan the QR code with the
   WireGuard app on the phone.
2. With the tunnel on, install and fully trust mitmproxy's CA certificate on the phone
   (`~/.mitmproxy/mitmproxy-ca-cert.pem`; Settings > General > About > Certificate Trust Settings).

Each sync:

1. `npm run moon:proxy` (only `*.ems-x.com` and `*.moonclimbing.com` are decrypted; the rest passes through).
2. Turn the WireGuard tunnel on, open the Moon app and load the Mini MoonBoard 2020 problems.
   The proxy prints `[moon] captured auth ...`.
3. Tap **Sync now** on the app's Sync page (or `npm run moon:sync`) within the hour.
4. Turn the tunnel off and stop the proxy.

Re-syncs update problems in place and keep attempts. `npm run moon:sync -- --offline` re-imports
the last download (`data/moon-mini2020.json`) without the phone. `data/moon-requests.log` lists the
backend calls the app made, which helps if Moon changes its API again.

## Board photos (optional)

The board is drawn from the real hold photos when `data/mini2020-holds.json` exists; otherwise it
shows a plain grid. The file comes from the (retired, but still online) hold setup viewer at
https://www.moonboard.com/HoldSetups/Index: logged in, `POST /HoldSetups/GetHoldsetupHolds` with
`filter=setupid~eq~19` gives each hold's cell, number and rotation, and the photos are at
`/content/images/holds/h{number}.png`. Format: `{ holds: [{cell, image, rotation, set}], images: {"h1.png": base64} }`.
It isn't committed: the photos and the problem catalog are Moon Climbing's content.

## Tries and sends in git

`progress/ascents.json` holds every climber's tries and sends, one line per climber / problem / angle.
The server rewrites it after each change, so commit it whenever you like. At startup, and after
each sync, missing climbers and attempts are restored from it (local data is never overwritten),
so a fresh clone gets its history back once problems are synced.

## How it works

- `server/main.ts`: HTTP server and JSON API, no framework.
- `server/db.ts`: SQLite schema and queries. `attempts` holds one row per climber / problem / angle
  with a try count and an optional send date. A send with one try counts as a flash.
- `server/moon.ts`: downloads the catalog from the Moon backend. `tools/moon_capture.py` is the mitmproxy add-on.
- `server/progress.ts`: keeps `progress/ascents.json` in sync with the database.
- `server/importer.ts`: turns the app's problem JSON into rows (Mini 2020 grid is A–K × 1–12, foot holds included).
- `public/`: Preact + htm app, loaded through an import map, no build step.

There are no passwords: you pick your climber and it's remembered in a cookie. Only run it on a
network you trust.

## Tests

```sh
npm test
```
