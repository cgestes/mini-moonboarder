import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { ANGLES, openDb, type ListQuery } from "./db.ts";
import { MoonAuthError, readAuth, syncMini2020 } from "./moon.ts";
import { DATA_DIR, DB_PATH, PROGRESS_PATH, ROOT } from "./paths.ts";
import { progressWriter, restoreProgress, writeProgress } from "./progress.ts";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY = 1024 * 1024;
const MOON_AUTH = join(DATA_DIR, "moon-auth.json");
const MOON_RAW = join(DATA_DIR, "moon-mini2020.json");
// Hold photos + positions saved from moonboard.com's hold setup viewer (see README). Optional.
const HOLDS_BUNDLE = join(DATA_DIR, "mini2020-holds.json");

const db = openDb(DB_PATH);
let syncing = false;
const saveProgress = progressWriter(db, PROGRESS_PATH);

// Static roots: the app itself, plus the two browser libraries straight from node_modules.
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

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

// No passwords: the chosen user is remembered in a plain cookie. This is a local, trusted-network app.
function currentUser(req: IncomingMessage) {
  const m = /(?:^|;\s*)uid=(\d+)/.exec(req.headers.cookie ?? "");
  const user = m ? db.getUser(Number(m[1])) : undefined;
  if (!user) throw new HttpError(401, "Pick a user first");
  return user;
}

function setUserCookie(res: ServerResponse, id: number | null) {
  const value = id == null ? "uid=; Max-Age=0" : `uid=${id}; Max-Age=${60 * 60 * 24 * 365 * 5}`;
  res.setHeader("set-cookie", `${value}; Path=/; HttpOnly; SameSite=Lax`);
}

function parseAngle(value: unknown): number {
  const angle = Number(value);
  if (!(ANGLES as readonly number[]).includes(angle)) throw new HttpError(400, `Angle must be one of ${ANGLES.join(", ")}`);
  return angle;
}

function optionalInt(value: string | null): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/users") return send(res, 200, db.listUsers());

  if (route === "GET /api/holds") return send(res, 200, { holds: (await holdsBundle())?.holds ?? [] });

  if (route === "POST /api/users") {
    const name = String((await readJson(req)).name ?? "").trim();
    if (!name || name.length > 40) throw new HttpError(400, "Name must be 1-40 characters");
    const user = db.createUser(name);
    saveProgress();
    setUserCookie(res, user.id);
    return send(res, 200, user);
  }

  if (route === "POST /api/session") {
    const user = db.getUser(Number((await readJson(req)).userId));
    if (!user) throw new HttpError(404, "No such user");
    setUserCookie(res, user.id);
    return send(res, 200, user);
  }

  if (route === "DELETE /api/session") {
    setUserCookie(res, null);
    return send(res, 200, { ok: true });
  }

  const user = currentUser(req);

  if (route === "GET /api/me") return send(res, 200, user);

  if (route === "GET /api/problems") {
    const p = url.searchParams;
    const query: ListQuery = {
      userId: user.id,
      angle: parseAngle(p.get("angle") ?? 40),
      q: p.get("q")?.trim() || undefined,
      gradeMin: optionalInt(p.get("gmin")),
      gradeMax: optionalInt(p.get("gmax")),
      benchmark: p.get("bench") === "1",
      status: (p.get("status") as ListQuery["status"]) ?? "any",
      sort: (p.get("sort") as ListQuery["sort"]) ?? "repeats",
      offset: optionalInt(p.get("offset")),
      limit: optionalInt(p.get("limit")),
    };
    return send(res, 200, db.listProblems(query));
  }

  const problemMatch = /^\/api\/problems\/(\d+)$/.exec(url.pathname);
  if (req.method === "GET" && problemMatch) {
    const problem = db.getProblem(Number(problemMatch[1]));
    if (!problem) throw new HttpError(404, "Problem not found");
    return send(res, 200, problem);
  }

  if (route === "PUT /api/attempts") {
    const body = await readJson(req);
    const tries = Number(body.tries);
    if (!Number.isInteger(tries) || tries < 0 || tries > 999) throw new HttpError(400, "tries must be 0-999");
    const problemId = Number(body.problemId);
    if (!db.getProblem(problemId)) throw new HttpError(404, "Problem not found");
    const attempt = db.setAttempt(user.id, problemId, parseAngle(body.angle), { tries, sent: !!body.sent });
    saveProgress();
    return send(res, 200, { attempt });
  }

  if (route === "GET /api/stats") return send(res, 200, db.stats());

  if (route === "GET /api/sync") {
    const auth = await readAuth(MOON_AUTH);
    const lastSync = db.getMeta("last_sync");
    return send(res, 200, {
      problems: db.problemCount(),
      authCapturedAt: auth?.captured_at ?? null,
      lastSync: lastSync ? JSON.parse(lastSync) : null,
    });
  }

  if (route === "POST /api/sync") {
    if (syncing) throw new HttpError(409, "A sync is already running");
    syncing = true;
    try {
      const result = await syncMini2020(db, MOON_AUTH, MOON_RAW);
      // Newly synced problems may unlock saved attempts that couldn't be restored before.
      if (await restoreProgress(db, PROGRESS_PATH)) saveProgress();
      return send(res, 200, result);
    } catch (e) {
      if (e instanceof MoonAuthError) throw new HttpError(409, e.message);
      throw new HttpError(502, (e as Error).message);
    } finally {
      syncing = false;
    }
  }

  throw new HttpError(404, "Not found");
}

let holdsCache: Promise<{ holds: unknown[]; images: Record<string, string> } | null> | undefined;
function holdsBundle() {
  holdsCache ??= readFile(HOLDS_BUNDLE, "utf8").then(JSON.parse, () => null);
  return holdsCache;
}

async function serveHoldImage(res: ServerResponse, name: string) {
  const b64 = (await holdsBundle())?.images[name];
  if (!b64) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
  res.end(Buffer.from(b64, "base64"));
}

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else if (url.pathname.startsWith("/holds/")) await serveHoldImage(res, url.pathname.slice("/holds/".length));
    else await serveStatic(res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: "Internal error" });
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
