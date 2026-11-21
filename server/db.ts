import type { ProblemRow } from "./importer.ts";
import type { Sql } from "./sql.ts";

export const ANGLES = [20, 25, 30, 35, 40] as const;

const SCHEMA = `
create table if not exists problems (
  id           integer primary key,   -- official MoonBoard problem id
  name         text not null,
  grade        text not null,         -- official grade (set at 40°)
  grade_idx    integer not null,      -- position in GRADES, for sorting / ranges
  user_grade   text,
  setter       text,
  method       text,
  is_benchmark integer not null default 0,
  repeats      integer not null default 0,
  rating       integer,
  holds        text not null,         -- JSON [{p:"G5",t:"s"|"m"|"e"}]
  created_at   integer,
  imported_at  integer not null
);
create index if not exists problems_grade on problems(grade_idx);

create table if not exists users (
  id         integer primary key,
  name       text not null unique collate nocase,
  created_at integer not null
);

-- One row per user / problem / angle. A row only exists once there is something to record.
create table if not exists attempts (
  user_id    integer not null references users(id) on delete cascade,
  problem_id integer not null references problems(id) on delete cascade,
  angle      integer not null check (angle in (20, 25, 30, 35, 40)),
  tries      integer not null default 0 check (tries >= 0),
  sent_at    integer,                 -- null = not sent yet
  updated_at integer not null,
  primary key (user_id, problem_id, angle)
);
create index if not exists attempts_problem on attempts(problem_id);

create table if not exists meta (
  key   text primary key,
  value text not null
);
`;

// One statement each: D1 can't run a multi-statement string as a prepared statement.
export const SCHEMA_STATEMENTS = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);

export type ListQuery = {
  userId: number;
  angle: number;
  q?: string;
  gradeMin?: number;
  gradeMax?: number;
  benchmark?: boolean;
  // todo: not sent at this angle; sent: sent here; trying: tries but no send here;
  // other: sent at another angle but not this one
  status?: "any" | "todo" | "sent" | "trying" | "other";
  sort?: "repeats" | "grade" | "grade_desc" | "new" | "name" | "recent";
  offset?: number;
  limit?: number;
};

export type AttemptUpdate = { tries: number; sent: boolean };
export type User = { id: number; name: string };

const UPSERT_PROBLEM = `
  insert into problems (id, name, grade, grade_idx, user_grade, setter, method, is_benchmark,
                        repeats, rating, holds, created_at, imported_at)
  values (:id, :name, :grade, :grade_idx, :user_grade, :setter, :method, :is_benchmark,
          :repeats, :rating, :holds, :created_at, :imported_at)
  on conflict(id) do update set
    name = excluded.name, grade = excluded.grade, grade_idx = excluded.grade_idx,
    user_grade = excluded.user_grade, setter = excluded.setter, method = excluded.method,
    is_benchmark = excluded.is_benchmark, repeats = excluded.repeats, rating = excluded.rating,
    holds = excluded.holds, created_at = excluded.created_at, imported_at = excluded.imported_at
`;

export function createDb(sql: Sql) {
  async function count(table: "problems" | "attempts"): Promise<number> {
    return (await sql.get<{ n: number }>(`select count(*) n from ${table}`))!.n;
  }

  async function migrate() {
    await sql.batch(SCHEMA_STATEMENTS.map((s) => ({ sql: s })));
  }

  async function importProblems(rows: ProblemRow[]): Promise<{ inserted: number; updated: number }> {
    const before = await count("problems");
    const now = Date.now();
    await sql.batch(rows.map((r) => ({ sql: UPSERT_PROBLEM, params: { ...r, holds: JSON.stringify(r.holds), imported_at: now } })));
    const inserted = (await count("problems")) - before;
    return { inserted, updated: rows.length - inserted };
  }

  function listUsers() {
    return sql.all<User>("select id, name from users order by name");
  }

  async function createUser(name: string): Promise<User> {
    await sql.run("insert into users (name, created_at) values (:name, :now) on conflict(name) do nothing", { name, now: Date.now() });
    return (await sql.get<User>("select id, name from users where name = :name", { name }))!;
  }

  function getUser(id: number) {
    return sql.get<User>("select id, name from users where id = :id", { id });
  }

  async function listProblems(query: ListQuery) {
    const where: string[] = [];
    const params: Record<string, string | number> = { user: query.userId, angle: query.angle };
    if (query.q) {
      where.push("(p.name like :q or p.setter like :q)");
      params.q = `%${query.q}%`;
    }
    if (query.gradeMin != null) {
      where.push("p.grade_idx >= :gmin");
      params.gmin = query.gradeMin;
    }
    if (query.gradeMax != null) {
      where.push("p.grade_idx <= :gmax");
      params.gmax = query.gradeMax;
    }
    if (query.benchmark) where.push("p.is_benchmark = 1");

    const here = "select 1 from attempts a where a.user_id = :user and a.problem_id = p.id and a.angle = :angle";
    switch (query.status) {
      case "todo": where.push(`not exists (${here} and a.sent_at is not null)`); break;
      case "sent": where.push(`exists (${here} and a.sent_at is not null)`); break;
      case "trying": where.push(`exists (${here} and a.sent_at is null and a.tries > 0)`); break;
      case "other":
        where.push(`not exists (${here} and a.sent_at is not null)`);
        where.push(`exists (select 1 from attempts a where a.user_id = :user and a.problem_id = p.id
                            and a.angle != :angle and a.sent_at is not null)`);
        break;
    }

    const order = {
      repeats: "p.repeats desc, p.id desc",
      grade: "p.grade_idx asc, p.repeats desc",
      grade_desc: "p.grade_idx desc, p.repeats desc",
      new: "p.created_at desc, p.id desc",
      name: "p.name collate nocase asc",
      recent: "last_activity desc nulls last, p.repeats desc",
    }[query.sort ?? "repeats"];

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    // compile() only binds the parameters a query uses, so :user / :angle can sit unused here.
    const total = (await sql.get<{ n: number }>(`select count(*) n from problems p ${whereSql}`, params))!.n;
    const items = await sql.all(`
      select p.id, p.name, p.grade, p.setter, p.is_benchmark, p.repeats,
             (select json_group_object(a.angle, json_object('tries', a.tries, 'sent', a.sent_at is not null))
                from attempts a where a.user_id = :user and a.problem_id = p.id) as mine,
             (select max(a.updated_at) from attempts a where a.user_id = :user and a.problem_id = p.id) as last_activity
      from problems p ${whereSql}
      order by ${order}
      limit :limit offset :offset
    `, { ...params, limit: Math.min(query.limit ?? 50, 200), offset: query.offset ?? 0 });

    return {
      total,
      items: items.map(({ last_activity, ...it }) => ({
        ...it,
        is_benchmark: !!it.is_benchmark,
        mine: it.mine ? JSON.parse(it.mine) : {},
      })),
    };
  }

  async function getProblem(id: number) {
    const p = await sql.get("select * from problems where id = :id", { id });
    if (!p) return undefined;
    const attempts = await sql.all(`
      select a.user_id, u.name as user_name, a.angle, a.tries, a.sent_at, a.updated_at
      from attempts a join users u on u.id = a.user_id
      where a.problem_id = :id order by a.angle desc, u.name
    `, { id });
    return { ...p, is_benchmark: !!p.is_benchmark, holds: JSON.parse(p.holds), attempts };
  }

  async function setAttempt(userId: number, problemId: number, angle: number, update: AttemptUpdate) {
    const key = { user: userId, problem: problemId, angle };
    const tries = update.sent ? Math.max(update.tries, 1) : update.tries;
    if (tries <= 0 && !update.sent) {
      await sql.run("delete from attempts where user_id = :user and problem_id = :problem and angle = :angle", key);
      return null;
    }
    const now = Date.now();
    await sql.run(`
      insert into attempts (user_id, problem_id, angle, tries, sent_at, updated_at)
      values (:user, :problem, :angle, :tries, :sent_at, :now)
      on conflict(user_id, problem_id, angle) do update set
        tries = excluded.tries,
        -- keep the original send date when the send is re-confirmed
        sent_at = case when :sent then coalesce(attempts.sent_at, excluded.sent_at) else null end,
        updated_at = excluded.updated_at
    `, { ...key, tries, sent_at: update.sent ? now : null, sent: update.sent, now });
    return sql.get("select angle, tries, sent_at from attempts where user_id = :user and problem_id = :problem and angle = :angle", key);
  }

  // Sends per grade and angle for every user, plus problem totals per grade.
  async function stats() {
    const [totals, sends, trying, users] = await Promise.all([
      sql.all("select grade, grade_idx, count(*) n from problems group by grade_idx order by grade_idx"),
      sql.all(`
        select a.user_id, a.angle, p.grade, count(*) n, sum(a.tries = 1) flashes
        from attempts a join problems p on p.id = a.problem_id
        where a.sent_at is not null
        group by a.user_id, a.angle, p.grade_idx
      `),
      sql.all("select user_id, angle, count(*) n from attempts where sent_at is null and tries > 0 group by user_id, angle"),
      listUsers(),
    ]);
    return { totals, sends, trying, users };
  }

  async function getMeta(key: string): Promise<string | null> {
    return (await sql.get<{ value: string }>("select value from meta where key = :key", { key }))?.value ?? null;
  }

  async function setMeta(key: string, value: string) {
    await sql.run("insert into meta (key, value) values (:key, :value) on conflict(key) do update set value = excluded.value", { key, value });
  }

  function problemCount(): Promise<number> {
    return count("problems");
  }

  // Everything needed to rebuild the climbers' history, plus problem name/grade for readable diffs.
  function exportAttempts() {
    return sql.all(`
      select u.name as climber, a.problem_id as problem, p.name, p.grade, a.angle, a.tries, a.sent_at, a.updated_at
      from attempts a join users u on u.id = a.user_id join problems p on p.id = a.problem_id
      order by u.name collate nocase, a.problem_id, a.angle
    `);
  }

  // Adds climbers and attempts that don't exist yet; never overwrites existing data.
  // Attempts on problems that aren't synced yet are skipped (and picked up after the next sync).
  async function restoreAttempts(climbers: string[], attempts: any[]): Promise<number> {
    for (const name of climbers) await createUser(name);
    const before = await count("attempts");
    await sql.batch(attempts.map((a) => ({
      sql: `
        insert into attempts (user_id, problem_id, angle, tries, sent_at, updated_at)
        select u.id, p.id, :angle, :tries, :sent_at, :updated_at
        from users u join problems p on p.id = :problem
        where u.name = :climber
        on conflict do nothing
      `,
      params: {
        climber: a.climber, problem: a.problem, angle: a.angle, tries: a.tries,
        sent_at: a.sent_at ?? null, updated_at: a.updated_at ?? Date.now(),
      },
    })));
    return (await count("attempts")) - before;
  }

  return { migrate, importProblems, getMeta, setMeta, problemCount, exportAttempts, restoreAttempts, listUsers, createUser, getUser, listProblems, getProblem, setAttempt, stats };
}

export type Db = ReturnType<typeof createDb>;
