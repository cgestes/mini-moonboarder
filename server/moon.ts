// Downloads the Mini MoonBoard 2020 catalog from the Moon app backend.
//
// The backend sits behind Firebase App Check, so we can't log in from a script. Instead
// tools/moon_capture.py (run through mitmproxy, see `npm run moon:proxy`) saves the auth headers of
// a real request made by the Moon app on the phone, and we replay them against the sync endpoint:
//
//   GET /_bs_api/v1/problems/get/{board}/0/{maxInserted}/{maxUpdated}/{maxDeleted}?api-version=3.0
//
// It's a delta sync on three watermarks, capped server-side at 25000 rows per call. Starting from
// the epoch and advancing the watermarks until a page brings nothing new walks the whole catalog.
// Endpoint discovered by https://github.com/mbdalpha/moonboard-scraper.

import { readFile, writeFile } from "node:fs/promises";
import { MINI_2020_BOARD_ID, normalizeAppProblems } from "./importer.ts";
import type { Db } from "./db.ts";

const EPOCH = "2000-01-01 00:00:00.000";
const MAX_PAGES = 50;

export type MoonAuth = { host: string; captured_at: number; headers: Record<string, string> };

export type SyncResult = {
  at: number;
  downloaded: number;
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
};

export class MoonAuthError extends Error {}

export async function readAuth(path: string): Promise<MoonAuth | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const toWatermark = (iso: string) => iso.replace("T", " ");

function maxOf(values: (string | null | undefined)[]): string | null {
  let max: string | null = null;
  for (const v of values) if (v && (max == null || v > max)) max = v;
  return max;
}

async function fetchPage(auth: MoonAuth, board: number, marks: string[]): Promise<any[]> {
  const path = marks.map(encodeURIComponent).join("/");
  const res = await fetch(`https://${auth.host}/_bs_api/v1/problems/get/${board}/0/${path}?api-version=3.0`, {
    headers: auth.headers,
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new MoonAuthError("The captured Moon app session expired. Open the Moon app again with the proxy on.");
  }
  if (!res.ok) throw new Error(`Moon backend returned HTTP ${res.status}`);
  const body: any = await res.json();
  // "updates" is an array, or a JSON string of one, or "" when there is nothing left.
  const updates = typeof body.updates === "string" ? (body.updates.trim() ? JSON.parse(body.updates) : []) : body.updates;
  return updates ?? [];
}

export async function downloadBoard(auth: MoonAuth, board: number, log: (msg: string) => void = () => {}) {
  const problems = new Map<unknown, any>();
  let marks = [EPOCH, EPOCH, EPOCH];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchPage(auth, board, marks);
    const fresh = batch.filter((p) => !problems.has(p.id)).length;
    for (const p of batch) problems.set(p.id, p);
    log(`page ${page}: ${batch.length} rows (${fresh} new), ${problems.size} total`);
    if (batch.length === 0 || fresh === 0) break;

    const configs = batch.flatMap((p) => p.configurations ?? []);
    const next = [
      maxOf(batch.map((p) => p.dateInserted)),
      maxOf(configs.map((c) => c.dateUpdated)),
      maxOf([...batch.map((p) => p.dateDeleted), ...configs.map((c) => c.dateDeleted)]),
    ].map((v, i) => (v ? toWatermark(v) : marks[i]));
    if (next.every((v, i) => v === marks[i])) break;
    marks = next;
  }
  return [...problems.values()];
}

export async function syncMini2020(db: Db, authPath: string, rawPath: string, log?: (msg: string) => void): Promise<SyncResult> {
  const auth = await readAuth(authPath);
  if (!auth) throw new MoonAuthError("No Moon app session captured yet. Run `npm run moon:proxy` and open the Moon app.");

  const raw = await downloadBoard(auth, MINI_2020_BOARD_ID, log);
  // Keep the raw download around: it lets us re-import without the phone if the mapping changes.
  await writeFile(rawPath, JSON.stringify(raw));
  return importRaw(db, raw);
}

// Re-imports the last download (`npm run moon:sync -- --offline`).
export async function reimportRaw(db: Db, rawPath: string): Promise<SyncResult> {
  return importRaw(db, JSON.parse(await readFile(rawPath, "utf8")));
}

function importRaw(db: Db, raw: any[]): SyncResult {
  const { rows, deleted, skipped } = normalizeAppProblems(raw);
  if (rows.length === 0) throw new Error(`Downloaded ${raw.length} problems but none could be read (skipped ${skipped})`);
  const counts = db.importProblems(rows);
  const result = { at: Date.now(), downloaded: raw.length, ...counts, deleted, skipped };
  db.setMeta("last_sync", JSON.stringify(result));
  return result;
}
