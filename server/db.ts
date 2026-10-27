import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProblemRow } from "./importer.ts";

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

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec(SCHEMA);

  const upsertProblem = db.prepare(`
    insert into problems (id, name, grade, grade_idx, user_grade, setter, method, is_benchmark,
                          repeats, rating, holds, created_at, imported_at)
    values (:id, :name, :grade, :grade_idx, :user_grade, :setter, :method, :is_benchmark,
            :repeats, :rating, :holds, :created_at, :imported_at)
    on conflict(id) do update set
      name = excluded.name, grade = excluded.grade, grade_idx = excluded.grade_idx,
      user_grade = excluded.user_grade, setter = excluded.setter, method = excluded.method,
      is_benchmark = excluded.is_benchmark, repeats = excluded.repeats, rating = excluded.rating,
      holds = excluded.holds, created_at = excluded.created_at, imported_at = excluded.imported_at
  `);

  function importProblems(rows: ProblemRow[]): { inserted: number; updated: number } {
    const before = (db.prepare("select count(*) n from problems").get() as { n: number }).n;
    const now = Date.now();
    db.exec("begin");
    try {
      for (const r of rows) upsertProblem.run({ ...r, holds: JSON.stringify(r.holds), imported_at: now });
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
    const after = (db.prepare("select count(*) n from problems").get() as { n: number }).n;
    return { inserted: after - before, updated: rows.length - (after - before) };
  }

  function listUsers() {
    return db.prepare("select id, name from users order by name").all() as { id: number; name: string }[];
  }

  function createUser(name: string) {
    db.prepare("insert into users (name, created_at) values (?, ?) on conflict(name) do nothing").run(name, Date.now());
    return db.prepare("select id, name from users where name = ?").get(name) as { id: number; name: string };
  }

  function getUser(id: number) {
    return db.prepare("select id, name from users where id = ?").get(id) as { id: number; name: string } | undefined;
  }

  function listProblems(query: ListQuery) {
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
    const countStmt = db.prepare(`select count(*) n from problems p ${whereSql}`);
    countStmt.setAllowUnknownNamedParameters(true); // :user / :angle only appear with status filters
    const total = (countStmt.get(params) as { n: number }).n;
    const itemsStmt = db.prepare(`
      select p.id, p.name, p.grade, p.setter, p.is_benchmark, p.repeats,
             (select json_group_object(a.angle, json_object('tries', a.tries, 'sent', a.sent_at is not null))
                from attempts a where a.user_id = :user and a.problem_id = p.id) as mine,
             (select max(a.updated_at) from attempts a where a.user_id = :user and a.problem_id = p.id) as last_activity
      from problems p ${whereSql}
      order by ${order}
      limit :limit offset :offset
    `);
    itemsStmt.setAllowUnknownNamedParameters(true);
    const items = itemsStmt.all({ ...params, limit: Math.min(query.limit ?? 50, 200), offset: query.offset ?? 0 }) as any[];

    return {
      total,
      items: items.map(({ last_activity, ...it }) => ({
        ...it,
        is_benchmark: !!it.is_benchmark,
        mine: it.mine ? JSON.parse(it.mine) : {},
      })),
    };
  }

  function getProblem(id: number) {
    const p = db.prepare("select * from problems where id = ?").get(id) as any;
    if (!p) return undefined;
    const attempts = db.prepare(`
      select a.user_id, u.name as user_name, a.angle, a.tries, a.sent_at, a.updated_at
      from attempts a join users u on u.id = a.user_id
      where a.problem_id = ? order by a.angle desc, u.name
    `).all(id);
    return { ...p, is_benchmark: !!p.is_benchmark, holds: JSON.parse(p.holds), attempts };
  }

  function setAttempt(userId: number, problemId: number, angle: number, update: AttemptUpdate) {
    const tries = update.sent ? Math.max(update.tries, 1) : update.tries;
    if (tries <= 0 && !update.sent) {
      db.prepare("delete from attempts where user_id = ? and problem_id = ? and angle = ?").run(userId, problemId, angle);
      return null;
    }
    const now = Date.now();
    db.prepare(`
      insert into attempts (user_id, problem_id, angle, tries, sent_at, updated_at)
      values (:user, :problem, :angle, :tries, :sent_at, :now)
      on conflict(user_id, problem_id, angle) do update set
        tries = excluded.tries,
        -- keep the original send date when the send is re-confirmed
        sent_at = case when :sent then coalesce(attempts.sent_at, excluded.sent_at) else null end,
        updated_at = excluded.updated_at
    `).run({ user: userId, problem: problemId, angle, tries, sent_at: update.sent ? now : null, sent: update.sent ? 1 : 0, now });
    return db.prepare("select angle, tries, sent_at from attempts where user_id = ? and problem_id = ? and angle = ?")
      .get(userId, problemId, angle);
  }

  // Sends per grade and angle for every user, plus problem totals per grade.
  function stats() {
    const totals = db.prepare("select grade, grade_idx, count(*) n from problems group by grade_idx order by grade_idx").all();
    const sends = db.prepare(`
      select a.user_id, a.angle, p.grade, count(*) n, sum(a.tries = 1) flashes
      from attempts a join problems p on p.id = a.problem_id
      where a.sent_at is not null
      group by a.user_id, a.angle, p.grade_idx
    `).all();
    const trying = db.prepare(`
      select user_id, angle, count(*) n from attempts where sent_at is null and tries > 0 group by user_id, angle
    `).all();
    return { totals, sends, trying, users: listUsers() };
  }

  function getMeta(key: string): string | null {
    return (db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  function setMeta(key: string, value: string) {
    db.prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }

  function problemCount(): number {
    return (db.prepare("select count(*) n from problems").get() as { n: number }).n;
  }

  // Everything needed to rebuild the climbers' history, plus problem name/grade for readable diffs.
  function exportAttempts() {
    return db.prepare(`
      select u.name as climber, a.problem_id as problem, p.name, p.grade, a.angle, a.tries, a.sent_at, a.updated_at
      from attempts a join users u on u.id = a.user_id join problems p on p.id = a.problem_id
      order by u.name collate nocase, a.problem_id, a.angle
    `).all() as any[];
  }

  // Adds climbers and attempts that don't exist locally yet; never overwrites local data.
  // Attempts on problems that aren't synced yet are skipped (and picked up after the next sync).
  function restoreAttempts(climbers: string[], attempts: any[]) {
    for (const name of climbers) createUser(name);
    const insert = db.prepare(`
      insert into attempts (user_id, problem_id, angle, tries, sent_at, updated_at)
      select u.id, p.id, :angle, :tries, :sent_at, :updated_at
      from users u join problems p on p.id = :problem
      where u.name = :climber
      on conflict do nothing
    `);
    let added = 0;
    db.exec("begin");
    try {
      for (const a of attempts) {
        added += Number(insert.run({
          climber: a.climber, problem: a.problem, angle: a.angle, tries: a.tries,
          sent_at: a.sent_at ?? null, updated_at: a.updated_at ?? Date.now(),
        }).changes);
      }
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
    return added;
  }

  return { db, importProblems, getMeta, setMeta, problemCount, exportAttempts, restoreAttempts, listUsers, createUser, getUser, listProblems, getProblem, setAttempt, stats };
}

export type Db = ReturnType<typeof openDb>;
