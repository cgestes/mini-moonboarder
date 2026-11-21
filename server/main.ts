// Local server: the shared API (server/app.ts) on node:http, plus static files, the Moon sync and
// progress/ascents.json, which need the local disk.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { createApp, HttpError, type HoldsBundle } from "./app.ts";
import { MoonAuthError, readAuth, syncMini2020 } from "./moon.ts";
import { DATA_DIR, DB_PATH, PROGRESS_PATH, ROOT } from "./paths.ts";
import { progressWriter, restoreProgress, writeProgress } from "./progress.ts";
import { openDb } from "./sqlite-node.ts";

const PORT = Number(process.env.PORT ?? 3000);
const MOON_AUTH = join(DATA_DIR, "moon-auth.json");
const MOON_RAW = join(DATA_DIR, "moon-mini2020.json");
const HOLDS_BUNDLE = join(DATA_DIR, "mini2020-holds.json");

const db = await openDb(DB_PATH);
const saveProgress = progressWriter(db, PROGRESS_PATH);

let holdsCache: Promise<HoldsBundle | null> | undefined;

const app = createApp({
  db,
  holds: () => (holdsCache ??= readFile(HOLDS_BUNDLE, "utf8").then(JSON.parse, () => null)),
  onChange: saveProgress,
  sync: {
    authCapturedAt: async () => (await readAuth(MOON_AUTH))?.captured_at ?? null,
    async run() {
      try {
        const result = await syncMini2020(db, MOON_AUTH, MOON_RAW);
        // Newly synced problems may unlock saved attempts that couldn't be restored before.
        if (await restoreProgress(db, PROGRESS_PATH)) saveProgress();
        return result;
      } catch (e) {
        if (e instanceof MoonAuthError) throw new HttpError(409, e.message);
        throw new HttpError(502, (e as Error).message);
      }
    },
  },
});

// Static roots: the app itself, plus the two browser libraries straight from node_modules.
// (The Worker serves the same layout from dist/, built by scripts/build-assets.ts.)
const STATIC: [prefix: string, dir: string][] = [
  ["/vendor/preact/", join(ROOT, "node_modules", "preact")],
  ["/vendor/htm/", join(ROOT, "node_modules", "htm")],
  ["/", join(ROOT, "public")],
];
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(res: ServerResponse, pathname: string) {
  for (const [prefix, dir] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = pathname === "/" ? "index.html" : pathname.slice(prefix.length);
    const file = normalize(join(dir, decodeURIComponent(rel)));
    if (!file.startsWith(dir)) break;
    try {
      if ((await stat(file)).isFile()) {
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
        return res.end(await readFile(file));
      }
    } catch {}
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value != null) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", "http://localhost"), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit);
}

async function sendResponse(res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer(async (req, res) => {
  try {
    const response = await app(toRequest(req));
    if (response) await sendResponse(res, response);
    else await serveStatic(res, new URL(req.url ?? "/", "http://localhost").pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  }
});

const restored = await restoreProgress(db, PROGRESS_PATH);
if (restored) console.log(`Restored ${restored} attempts from ${PROGRESS_PATH}`);
await writeProgress(db, PROGRESS_PATH);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MoonBoard Angles running (db: ${DB_PATH})`);
  console.log(`  on this computer: http://localhost:${PORT}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) console.log(`  on your phone:    http://${a.address}:${PORT}`);
    }
  }
});
