// The async SQL interface db.ts is written against. It has three backends:
//   server/sqlite-node.ts  node:sqlite, for the local server and tests
//   server/d1.ts           Cloudflare D1, in the Worker
//   scripts/wrangler-sql.ts  `wrangler d1 execute`, for the push / pull scripts
// Queries use :named parameters. compile() checks them and turns them into numbered ?N
// placeholders, which D1 accepts (it has no named parameters).

export type Params = Record<string, unknown>;
export type Statement = { sql: string; params?: Params };

export interface Sql {
  all<T = any>(sql: string, params?: Params): Promise<T[]>;
  get<T = any>(sql: string, params?: Params): Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<void>;
  // Runs the statements in one transaction.
  batch(statements: Statement[]): Promise<void>;
}

export type Compiled = { text: string; names: string[]; values: (string | number | null)[] };

export function compile(sql: string, params: Params = {}): Compiled {
  const names: string[] = [];
  const text = sql.replace(/:([A-Za-z_]\w*)/g, (_, name: string) => {
    let i = names.indexOf(name);
    if (i < 0) i = names.push(name) - 1;
    return `?${i + 1}`;
  });
  const values = names.map((name) => {
    if (!(name in params)) throw new Error(`Missing SQL parameter :${name}`);
    return toSqlValue(params[name]);
  });
  return { text, names, values };
}

function toSqlValue(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  throw new Error(`Unsupported SQL value: ${typeof v}`);
}

// Writes the values into the SQL text, for tools that can't bind parameters (wrangler's --command / --file).
export function inline(sql: string, params: Params = {}): string {
  const { text, values } = compile(sql, params);
  return text.replace(/\?(\d+)/g, (_, n: string) => {
    const v = values[Number(n) - 1];
    if (v == null) return "NULL";
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`Can't write ${v} as SQL`);
      return String(v);
    }
    return `'${v.replaceAll("'", "''")}'`;
  });
}
