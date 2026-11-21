// Sql backend that runs queries on a D1 database through `wrangler d1 execute`, so the push / pull
// scripts can reuse db.ts as-is. Slow (one wrangler run per query), fine for a handful of queries:
// batches go through a single SQL file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../server/paths.ts";
import { inline, type Sql } from "../server/sql.ts";

const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");

export function wranglerSql(database: string, target: "local" | "remote"): Sql {
  function execute(args: string[]): string {
    return execFileSync(WRANGLER, ["d1", "execute", database, `--${target}`, "--json", "--yes", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  }
  const query = (sql: string, params?: Record<string, unknown>): any[] =>
    JSON.parse(execute(["--command", inline(sql, params)]))[0]?.results ?? [];

  return {
    async all(sql, params) {
      return query(sql, params);
    },
    async get(sql, params) {
      return query(sql, params)[0];
    },
    async run(sql, params) {
      query(sql, params);
    },
    async batch(statements) {
      if (!statements.length) return;
      const dir = mkdtempSync(join(tmpdir(), "d1-batch-"));
      try {
        const file = join(dir, "batch.sql");
        writeFileSync(file, statements.map((s) => `${inline(s.sql, s.params).trim()};\n`).join(""));
        execute(["--file", file]); // remote file imports print progress, not JSON
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
