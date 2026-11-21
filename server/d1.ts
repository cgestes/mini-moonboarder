// Cloudflare D1 backend, used by the Worker.
import { compile, type Params, type Sql } from "./sql.ts";

// The parts of the D1 API we use (to avoid depending on @cloudflare/workers-types).
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all(): Promise<{ results: any[] }>;
  first(): Promise<any>;
  run(): Promise<unknown>;
}

export function d1Sql(d1: D1Database): Sql {
  function prepare(sql: string, params?: Params) {
    const { text, values } = compile(sql, params);
    return d1.prepare(text).bind(...values);
  }
  return {
    async all(sql, params) {
      return (await prepare(sql, params).all()).results;
    },
    async get(sql, params) {
      return (await prepare(sql, params).first()) ?? undefined;
    },
    async run(sql, params) {
      await prepare(sql, params).run();
    },
    async batch(statements) {
      if (statements.length) await d1.batch(statements.map((s) => prepare(s.sql, s.params)));
    },
  };
}
