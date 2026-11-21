// The pieces added for the Cloudflare deployment: SQL parameters, the shared fetch handler and the
// Cloudflare Access check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt } from "../server/access.ts";
import { createApp } from "../server/app.ts";
import { normalizeAppProblems } from "../server/importer.ts";
import { compile, inline } from "../server/sql.ts";
import { openDb } from "../server/sqlite-node.ts";
import worker from "../server/worker.ts";

test("named parameters become numbered ones, repeated names share a number", () => {
  assert.deepEqual(compile("select :a, :b, :a", { a: 1, b: true, unused: 3 }), {
    text: "select ?1, ?2, ?1",
    names: ["a", "b"],
    values: [1, 1],
  });
  assert.throws(() => compile("select :missing", {}), /:missing/);
  assert.equal(inline("insert into t values (:s, :n, :x)", { s: "it's", n: 2.5, x: null }), "insert into t values ('it''s', 2.5, NULL)");
});

async function appWithProblem() {
  const db = await openDb(":memory:");
  await db.importProblems(normalizeAppProblems([{
    id: 7, name: "Seven", setter: "Ben", moves: "s~D3~|e~K12~", dateInserted: "2021-04-20T16:11:12.990",
    configurations: [{ configuration: "40°", grade: "6B", repeats: 1 }],
  }]).rows);
  let changes = 0;
  const app = createApp({ db, holds: async () => null, onChange: () => changes++ });
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app(new Request(`https://moon.example${path}`, { ...init, headers: { cookie: init.cookie ?? "", "content-type": "application/json" } }));
  return { app, call, changes: () => changes };
}

test("API flow through the shared handler: pick a climber, log a send, list it", async () => {
  const { call, changes } = await appWithProblem();
  assert.equal((await call("/api/me"))!.status, 401);

  const created = (await call("/api/users", { method: "POST", body: JSON.stringify({ name: "Nikki" }) }))!;
  assert.equal(created.status, 200);
  const cookie = created.headers.get("set-cookie")!;
  assert.match(cookie, /^uid=\d+; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Lax; Secure$/); // https -> Secure
  const uid = cookie.split(";")[0];

  const put = (await call("/api/attempts", { method: "PUT", cookie: uid, body: JSON.stringify({ problemId: 7, angle: 30, tries: 2, sent: true }) }))!;
  assert.equal(put.status, 200);
  assert.equal(changes(), 2);

  const list = await (await call("/api/problems?angle=30&status=sent", { cookie: uid }))!.json();
  assert.deepEqual(list.items.map((p: any) => [p.id, p.mine]), [[7, { 30: { tries: 2, sent: 1 } }]]);

  // Without a Moon sync (the Worker), the sync page explains instead of syncing.
  const sync = await (await call("/api/sync", { cookie: uid }))!.json();
  assert.equal(sync.canSync, false);
  assert.equal((await call("/api/sync", { method: "POST", cookie: uid }))!.status, 409);

  assert.equal(await call("/index.html"), null); // static files are the platform's job
  assert.equal((await call("/api/attempts", { method: "PUT", cookie: uid, body: "{" }))!.status, 400);
});

// A fake Access team: an RSA key pair whose public half is served at /cdn-cgi/access/certs.
async function fakeAccess(t: any, teamDomain: string) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1", alg: "RS256" };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, `https://${teamDomain}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }));
  });
  const b64 = (data: string | ArrayBuffer) =>
    Buffer.from(typeof data === "string" ? data : new Uint8Array(data)).toString("base64url");
  return async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) => {
    const unsigned = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${b64(sig)}`;
  };
}

test("Access tokens: signature, audience, issuer and expiry are all checked", async (t) => {
  const team = "team-a.cloudflareaccess.com";
  const sign = await fakeAccess(t, team);
  const now = Date.now();
  const good = { aud: ["aud-1"], iss: `https://${team}`, exp: now / 1000 + 600, email: "nikki@example.com" };

  assert.equal((await verifyAccessJwt(await sign(good), team, "aud-1")).email, "nikki@example.com");
  await assert.rejects(verifyAccessJwt(await sign(good), team, "aud-2"), /audience/);
  await assert.rejects(verifyAccessJwt(await sign({ ...good, iss: "https://evil.cloudflareaccess.com" }), team, "aud-1"), /issuer/);
  await assert.rejects(verifyAccessJwt(await sign({ ...good, exp: now / 1000 - 1 }), team, "aud-1"), /Expired/);
  await assert.rejects(verifyAccessJwt(await sign(good, { alg: "none", kid: "k1" }), team, "aud-1"), /algorithm/);

  const [h, , s] = (await sign(good)).split(".");
  const forged = Buffer.from(JSON.stringify({ ...good, email: "mallory@example.com" })).toString("base64url");
  await assert.rejects(verifyAccessJwt(`${h}.${forged}.${s}`, team, "aud-1"), /signature/);
});

test("the Worker refuses everything until Access is configured, and without a valid token", async (t) => {
  const env: any = { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
  const get = (url: string, headers: Record<string, string> = {}) => worker.fetch(new Request(url, { headers }), env);

  assert.equal((await get("https://moonboard-angles.example.workers.dev/")).status, 503);
  assert.equal((await get("https://moonboard-angles.example.workers.dev/api/users")).status, 503);

  env.ACCESS_TEAM_DOMAIN = "team-b.cloudflareaccess.com";
  env.ACCESS_AUD = "aud-1";
  assert.equal((await get("https://moonboard-angles.example.workers.dev/api/users")).status, 403);
  const sign = await fakeAccess(t, env.ACCESS_TEAM_DOMAIN);
  const wrongAud = await sign({ aud: "other", iss: "https://team-b.cloudflareaccess.com", exp: Date.now() / 1000 + 600 });
  assert.equal((await get("https://moonboard-angles.example.workers.dev/", { "cf-access-jwt-assertion": wrongAud })).status, 403);

  // The local-dev bypass only works on localhost.
  env.DEV_NO_ACCESS = "1";
  assert.equal((await get("https://moonboard-angles.example.workers.dev/")).status, 403);
});
