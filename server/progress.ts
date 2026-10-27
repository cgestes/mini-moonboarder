// Keeps progress/ascents.json in sync with the database, so everyone's tries and sends live in git.
// The database stays the source of truth; the file is rewritten after every change and read back
// (missing rows only) at startup and after each problem sync.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Db } from "./db.ts";

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const ms = (value: string | null) => (value == null ? null : Date.parse(value));

export async function writeProgress(db: Db, path: string) {
  const attempts = db.exportAttempts().map((a) => ({
    climber: a.climber,
    problem: a.problem,
    name: a.name,
    grade: a.grade,
    angle: a.angle,
    tries: a.tries,
    sent: iso(a.sent_at),
    updated: iso(a.updated_at),
  }));
  const body = { climbers: db.listUsers().map((u) => u.name), attempts };
  await mkdir(dirname(path), { recursive: true });
  // One attempt per line keeps git diffs small and readable.
  const lines = attempts.map((a) => `    ${JSON.stringify(a)}`).join(",\n");
  const text = `{\n  "climbers": ${JSON.stringify(body.climbers)},\n  "attempts": ${lines ? `[\n${lines}\n  ]` : "[]"}\n}\n`;
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

export async function restoreProgress(db: Db, path: string): Promise<number> {
  let saved;
  try {
    saved = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return 0;
  }
  return db.restoreAttempts(
    saved.climbers ?? [],
    (saved.attempts ?? []).map((a: any) => ({ ...a, sent_at: ms(a.sent), updated_at: ms(a.updated) })),
  );
}

// Coalesces bursts of taps (e.g. +1 +1 +1) into one write.
export function progressWriter(db: Db, path: string, delayMs = 500) {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => writeProgress(db, path).catch((e) => console.error("progress export failed:", e)), delayMs);
  };
}
