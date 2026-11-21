// node:sqlite backend for the local server, the sync CLI and tests.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDb, type Db } from "./db.ts";
import { compile, type Params, type Sql } from "./sql.ts";

export function nodeSql(path: string): Sql {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");

  const cache = new Map<string, StatementSync>();
  function prepare(sql: string, params?: Params): [StatementSync, Record<string, string | number | null>] {
    const { names, values } = compile(sql, params); // checks every :name has a value
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return [stmt, Object.fromEntries(names.map((n, i) => [n, values[i]]))];
  }

  return {
    async all(sql, params) {
      const [stmt, values] = prepare(sql, params);
      return stmt.all(values) as any[];
    },
    async get(sql, params) {
      const [stmt, values] = prepare(sql, params);
      return stmt.get(values) as any;
    },
    async run(sql, params) {
      const [stmt, values] = prepare(sql, params);
      stmt.run(values);
    },
    async batch(statements) {
      db.exec("begin");
      try {
        for (const s of statements) {
          const [stmt, values] = prepare(s.sql, s.params);
          stmt.run(values);
        }
        db.exec("commit");
      } catch (e) {
        db.exec("rollback");
        throw e;
      }
    },
  };
}

export async function openDb(path: string): Promise<Db> {
  const db = createDb(nodeSql(path));
  await db.migrate();
  return db;
}
