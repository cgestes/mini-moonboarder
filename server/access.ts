// Verifies the Cloudflare Access token that Access adds to every request it lets through
// (header Cf-Access-Jwt-Assertion): RS256 signature against the team's public keys, the Access
// application's audience tag, the issuer and the expiry. The Worker checks it on every request,
// so turning Access off, or reaching the Worker by another route, can't expose the app.

export type AccessClaims = { email?: string; aud: string | string[]; iss: string; exp: number; nbf?: number };

const KEY_REFRESH_MS = 60_000;
const keyCache = new Map<string, { fetchedAt: number; keys: Map<string, CryptoKey> }>();

export function issuerFor(teamDomain: string) {
  return `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

function base64UrlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(base64UrlBytes(s)));

async function fetchKeys(issuer: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const out = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA") continue;
    out.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  return out;
}

// Keys are cached per isolate; an unknown key id (Access rotates keys) triggers a refetch,
// at most once a minute.
async function keyFor(issuer: string, kid: string, now: number): Promise<CryptoKey | undefined> {
  let entry = keyCache.get(issuer);
  if (!entry || (!entry.keys.has(kid) && now - entry.fetchedAt > KEY_REFRESH_MS)) {
    entry = { fetchedAt: now, keys: await fetchKeys(issuer) };
    keyCache.set(issuer, entry);
  }
  return entry.keys.get(kid);
}

export async function verifyAccessJwt(token: string, teamDomain: string, audience: string, now = Date.now()): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeJson(headerPart);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unexpected token algorithm");

  const issuer = issuerFor(teamDomain);
  const key = await keyFor(issuer, header.kid, now);
  if (!key) throw new Error("Unknown signing key");
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(signaturePart), signed))) {
    throw new Error("Bad signature");
  }

  const claims = decodeJson(payloadPart) as AccessClaims;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) throw new Error("Wrong audience");
  if (claims.iss !== issuer) throw new Error("Wrong issuer");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw new Error("Expired");
  if (typeof claims.nbf === "number" && claims.nbf * 1000 > now + 60_000) throw new Error("Not valid yet");
  return claims;
}
