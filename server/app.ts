// The JSON API and hold photos, as a fetch-style handler shared by the local server
// (server/main.ts) and the Cloudflare Worker (server/worker.ts). No framework, no Node APIs.
import { ANGLES, type Db, type ListQuery } from "./db.ts";

const MAX_BODY = 1024 * 1024;

// Hold photos + positions saved from moonboard.com's hold setup viewer (see README). Optional.
export type HoldsBundle = { holds: unknown[]; images: Record<string, string> };
// Its key in the Worker's R2 bucket.
export const HOLDS_KEY = "mini2020-holds.json";

// Downloading problems needs the Moon app session captured on the computer, so only the local
// server can do it. The Worker gets its problems from `npm run cloud:push`.
export type MoonSync = {
  authCapturedAt(): Promise<number | null>;
  run(): Promise<unknown>;
};

export type AppOptions = {
  db: Db;
  holds(): Promise<HoldsBundle | null>;
  sync?: MoonSync;
  onChange?(): void; // after climbers or attempts change
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

async function readJson(req: Request): Promise<any> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new HttpError(413, "Body too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Body too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

// The chosen climber is remembered in a plain cookie. Who may use the app at all is decided before
// this: the local server is for a trusted network, the Worker sits behind Cloudflare Access.
function userCookie(req: Request, id: number | null) {
  const value = id == null ? "uid=; Max-Age=0" : `uid=${id}; Max-Age=${60 * 60 * 24 * 365 * 5}`;
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return { "set-cookie": `${value}; Path=/; HttpOnly; SameSite=Lax${secure}` };
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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Returns null for paths it doesn't handle (static files).
export function createApp({ db, holds, sync, onChange = () => {} }: AppOptions) {
  let syncing = false;

  async function currentUser(req: Request) {
    const m = /(?:^|;\s*)uid=(\d+)/.exec(req.headers.get("cookie") ?? "");
    const user = m ? await db.getUser(Number(m[1])) : undefined;
    if (!user) throw new HttpError(401, "Pick a user first");
    return user;
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /api/users") return json(200, await db.listUsers());

    if (route === "GET /api/holds") return json(200, { holds: (await holds())?.holds ?? [] });

    if (route === "POST /api/users") {
      const name = String((await readJson(req)).name ?? "").trim();
      if (!name || name.length > 40) throw new HttpError(400, "Name must be 1-40 characters");
      const user = await db.createUser(name);
      onChange();
      return json(200, user, userCookie(req, user.id));
    }

    if (route === "POST /api/session") {
      const user = await db.getUser(Number((await readJson(req)).userId));
      if (!user) throw new HttpError(404, "No such user");
      return json(200, user, userCookie(req, user.id));
    }

    if (route === "DELETE /api/session") return json(200, { ok: true }, userCookie(req, null));

    const user = await currentUser(req);

    if (route === "GET /api/me") return json(200, user);

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
      return json(200, await db.listProblems(query));
    }

    const problemMatch = /^\/api\/problems\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && problemMatch) {
      const problem = await db.getProblem(Number(problemMatch[1]));
      if (!problem) throw new HttpError(404, "Problem not found");
      return json(200, problem);
    }

    if (route === "PUT /api/attempts") {
      const body = await readJson(req);
      const tries = Number(body.tries);
      if (!Number.isInteger(tries) || tries < 0 || tries > 999) throw new HttpError(400, "tries must be 0-999");
      const problemId = Number(body.problemId);
      if (!(await db.getProblem(problemId))) throw new HttpError(404, "Problem not found");
      const attempt = await db.setAttempt(user.id, problemId, parseAngle(body.angle), { tries, sent: !!body.sent });
      onChange();
      return json(200, { attempt });
    }

    if (route === "GET /api/stats") return json(200, await db.stats());

    if (route === "GET /api/sync") {
      const lastSync = await db.getMeta("last_sync");
      return json(200, {
        problems: await db.problemCount(),
        canSync: !!sync,
        authCapturedAt: (await sync?.authCapturedAt()) ?? null,
        lastSync: lastSync ? JSON.parse(lastSync) : null,
      });
    }

    if (route === "POST /api/sync") {
      if (!sync) throw new HttpError(409, "Problems are synced from the computer: npm run moon:sync, then npm run cloud:push.");
      if (syncing) throw new HttpError(409, "A sync is already running");
      syncing = true;
      try {
        return json(200, await sync.run());
      } finally {
        syncing = false;
      }
    }

    throw new HttpError(404, "Not found");
  }

  const imageCache = new Map<string, Uint8Array>();
  async function holdImage(name: string): Promise<Response> {
    let bytes = imageCache.get(name);
    if (!bytes) {
      const b64 = (await holds())?.images[name];
      if (!b64) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
      bytes = base64ToBytes(b64);
      imageCache.set(name, bytes);
    }
    return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" } });
  }

  return async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, url);
      if (url.pathname.startsWith("/holds/")) return await holdImage(decodeURIComponent(url.pathname.slice("/holds/".length)));
      return null;
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: "Internal error" });
    }
  };
}
