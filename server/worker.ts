// Cloudflare Worker: the shared API (server/app.ts) on D1, hold photos from R2, static files from
// dist/ (built by scripts/build-assets.ts). Every request, static files included, must carry a
// valid Cloudflare Access token; see README "Deploy to Cloudflare".
import { verifyAccessJwt } from "./access.ts";
import { createApp, HOLDS_KEY, type HoldsBundle } from "./app.ts";
import { d1Sql, type D1Database } from "./d1.ts";
import { createDb } from "./db.ts";

// Keep `default` the only runtime export: Workers treat other exports of the main module as entry points.
export type Env = {
  DB: D1Database;
  HOLDS: { get(key: string): Promise<{ json<T>(): Promise<T> } | null> };
  ASSETS: { fetch(request: Request): Promise<Response> };
  ACCESS_TEAM_DOMAIN?: string; // e.g. "myteam.cloudflareaccess.com"
  ACCESS_AUD?: string; // the Access application's "Application Audience (AUD) Tag"
  DEV_NO_ACCESS?: string; // set by `npm run cloud:dev` only; honoured on localhost only
};

function text(status: number, body: string) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

// Returns a response to send instead when the request isn't allowed.
async function checkAccess(request: Request, env: Env): Promise<Response | null> {
  const host = new URL(request.url).hostname;
  if (env.DEV_NO_ACCESS === "1" && (host === "localhost" || host === "127.0.0.1")) return null;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return text(503, "Cloudflare Access isn't set up for this Worker yet (ACCESS_TEAM_DOMAIN / ACCESS_AUD).");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return text(403, "Sign in through Cloudflare Access.");
  try {
    await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    return null;
  } catch (e) {
    console.warn("Access token rejected:", (e as Error).message);
    return text(403, "Sign in through Cloudflare Access.");
  }
}

// Per-isolate state: the schema check runs once, the holds bundle is read from R2 once.
let schemaReady: Promise<void> | undefined;
let holdsCache: Promise<HoldsBundle | null> | undefined;

function loadHolds(env: Env): Promise<HoldsBundle | null> {
  holdsCache ??= env.HOLDS.get(HOLDS_KEY)
    .then((obj) => obj?.json<HoldsBundle>() ?? null)
    .then((bundle) => {
      if (!bundle) holdsCache = undefined; // not uploaded yet: look again next time
      return bundle;
    }, (e) => {
      holdsCache = undefined;
      throw e;
    });
  return holdsCache;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const denied = await checkAccess(request, env);
    if (denied) return denied;

    const db = createDb(d1Sql(env.DB));
    schemaReady ??= db.migrate().catch((e) => {
      schemaReady = undefined;
      throw e;
    });
    await schemaReady;

    const app = createApp({ db, holds: () => loadHolds(env) });
    return (await app(request)) ?? env.ASSETS.fetch(request);
  },
};
