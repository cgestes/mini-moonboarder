// CLI: `npm run moon:sync` downloads the Mini 2020 catalog using the captured Moon app session.
// `npm run moon:sync -- --offline` re-imports the last download instead.
import { openDb } from "./db.ts";
import { DATA_DIR, DB_PATH, PROGRESS_PATH } from "./paths.ts";
import { restoreProgress, writeProgress } from "./progress.ts";
import { reimportRaw, syncMini2020 } from "./moon.ts";
import { join } from "node:path";

const db = openDb(DB_PATH);
try {
  const rawPath = join(DATA_DIR, "moon-mini2020.json");
  const r = process.argv.includes("--offline")
    ? await reimportRaw(db, rawPath)
    : await syncMini2020(db, join(DATA_DIR, "moon-auth.json"), rawPath, console.log);
  console.log(`Done: ${r.downloaded} downloaded, ${r.inserted} new, ${r.updated} updated, ${r.deleted} deleted upstream, ${r.skipped} skipped.`);
  const restored = await restoreProgress(db, PROGRESS_PATH);
  if (restored) {
    await writeProgress(db, PROGRESS_PATH);
    console.log(`Restored ${restored} attempts from ${PROGRESS_PATH}.`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
