// Moves data between this computer and the Cloudflare deployment.
//
//   npm run cloud:push   problems (from the last `npm run moon:sync` download) and hold photos up to
//                        Cloudflare; on a fresh database, also the climbers and attempts from
//                        progress/ascents.json
//   npm run cloud:pull   writes the deployed app's climbers and attempts to progress/ascents.json
//
// Add `-- --local` to target the local `npm run cloud:dev` instance instead.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOLDS_KEY } from "../server/app.ts";
import { createDb } from "../server/db.ts";
import { importRaw } from "../server/moon.ts";
import { DATA_DIR, PROGRESS_PATH, ROOT } from "../server/paths.ts";
import { restoreProgress, writeProgress } from "../server/progress.ts";
import { wranglerSql } from "./wrangler-sql.ts";

// Must match wrangler.jsonc.
const DATABASE = "moonboard";
const BUCKET = "moonboard-holds";

const command = process.argv[2];
const target = process.argv.includes("--local") ? "local" : "remote";
const db = createDb(wranglerSql(DATABASE, target));

async function push() {
  await db.migrate();

  const rawPath = join(DATA_DIR, "moon-mini2020.json");
  if (!existsSync(rawPath)) throw new Error(`${rawPath} is missing: run npm run moon:sync first.`);
  const r = await importRaw(db, JSON.parse(readFileSync(rawPath, "utf8")));
  console.log(`Problems: ${r.inserted} new, ${r.updated} updated.`);

  // Only seed climbers and attempts into an empty database: once the app is live, it holds the
  // newest data, and re-adding attempts from an older file would undo deletions made there.
  if ((await db.listUsers()).length === 0) {
    const restored = await restoreProgress(db, PROGRESS_PATH);
    console.log(`Climbers and ${restored} attempts restored from ${PROGRESS_PATH}.`);
  } else {
    console.log("Climbers already there: left as they are (use npm run cloud:pull to save them to git).");
  }

  const holds = join(DATA_DIR, "mini2020-holds.json");
  if (existsSync(holds)) {
    try {
      execFileSync(join(ROOT, "node_modules", ".bin", "wrangler"),
        ["r2", "object", "put", `${BUCKET}/${HOLDS_KEY}`, "--file", holds, "--content-type", "application/json", `--${target}`],
        { cwd: ROOT, stdio: "inherit" });
    } catch {
      throw new Error(`Hold photos not uploaded. Does the R2 bucket exist? (npx wrangler r2 bucket create ${BUCKET}) Then run this again.`);
    }
    console.log("Hold photos uploaded.");
  } else {
    console.log(`No ${holds}: the board will show a plain grid.`);
  }
}

async function pull() {
  await writeProgress(db, PROGRESS_PATH);
  const { climbers, attempts } = JSON.parse(readFileSync(PROGRESS_PATH, "utf8"));
  console.log(`Wrote ${climbers.length} climbers and ${attempts.length} attempts to ${PROGRESS_PATH}.`);
}

try {
  if (command === "push") await push();
  else if (command === "pull") await pull();
  else throw new Error("Usage: node scripts/cloud.ts push|pull [--local]");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
