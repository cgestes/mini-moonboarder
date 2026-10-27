import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.ts";
import { normalizeAppProblems, parseMoves } from "../server/importer.ts";
import { downloadBoard, syncMini2020 } from "../server/moon.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shape of a problem as returned by the Moon app backend.
function rawProblem(id: number, overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return {
    id,
    name: `Problem ${id}`,
    setter: "Ben",
    moves: "s~D3~|l~f7~|p~G9~|f~B2~|e~K12~",
    climbMethod: "Any marked holds",
    dateInserted: "2021-04-20T16:11:12.990",
    dateDeleted: null,
    configurations: [
      { configuration: "40°", grade: "6b+", userGrade: "6B", isBenchmark: true, repeats: 12, userRating: 3,
        dateUpdated: "2022-01-01T00:00:00.000", dateDeleted: null, ...config },
    ],
    ...overrides,
  };
}

test("parses packed moves", () => {
  assert.deepEqual(parseMoves("s~D3~|l~f7~|r~G9~|p~H10~|m~I11~|f~B2~|e~K12~"), [
    { p: "D3", t: "s" }, { p: "F7", t: "m" }, { p: "G9", t: "m" }, { p: "H10", t: "m" },
    { p: "I11", t: "m" }, { p: "B2", t: "f" }, { p: "K12", t: "e" },
  ]);
  assert.equal(parseMoves("s~A18~|e~B2~"), null); // row 18 doesn't exist on the Mini
  assert.equal(parseMoves(""), null);
});

test("normalizes app problems into rows", () => {
  const { rows, deleted, skipped } = normalizeAppProblems([rawProblem(1)]);
  assert.equal(deleted, 0);
  assert.equal(skipped, 0);
  assert.deepEqual(rows[0], {
    id: 1,
    name: "Problem 1",
    grade: "6B+",
    grade_idx: 7,
    user_grade: "6B",
    setter: "Ben",
    method: "Any marked holds",
    is_benchmark: 1,
    repeats: 12,
    rating: 3,
    holds: [{ p: "D3", t: "s" }, { p: "F7", t: "m" }, { p: "G9", t: "m" }, { p: "B2", t: "f" }, { p: "K12", t: "e" }],
    created_at: Date.UTC(2021, 3, 20, 16, 11, 12, 990),
  });
});

test("drops deleted problems, other angles and unreadable rows", () => {
  const { rows, deleted, skipped } = normalizeAppProblems([
    rawProblem(1, { dateDeleted: "2023-01-01T00:00:00.000" }),
    rawProblem(2, {}, { dateDeleted: "2023-01-01T00:00:00.000" }),
    rawProblem(3, {}, { configuration: "25°" }),
    rawProblem(4, { moves: "s~A18~|e~B2~" }),
    rawProblem(5, {}, { grade: "V5", userGrade: null }),
    rawProblem(6),
  ]);
  assert.deepEqual(rows.map((r) => r.id), [6]);
  assert.equal(deleted, 2);
  assert.equal(skipped, 3);
});

test("sync pages through the catalog by advancing watermarks", async (t) => {
  const catalog = [
    rawProblem(1, { dateInserted: "2021-01-01T00:00:00.000" }),
    rawProblem(2, { dateInserted: "2022-01-01T00:00:00.000" }),
    rawProblem(3, { dateInserted: "2023-01-01T00:00:00.000" }),
  ];
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: any) => {
    urls.push(url);
    assert.equal(init.headers.authorization, "Bearer abc");
    // Fake server: problems inserted after the first watermark, two per page.
    const after = decodeURIComponent(url.split("/")[9]).replace(" ", "T");
    const page = catalog.filter((p) => p.dateInserted > after).slice(0, 2);
    return new Response(JSON.stringify({ updates: page.length ? JSON.stringify(page) : "" }));
  });

  const auth = { host: "moon.test", captured_at: 0, headers: { authorization: "Bearer abc" } };
  const problems = await downloadBoard(auth, 19);
  assert.deepEqual(problems.map((p) => p.id), [1, 2, 3]);
  assert.match(urls[0], /^https:\/\/moon\.test\/_bs_api\/v1\/problems\/get\/19\/0\/2000-01-01%20/);
  assert.equal(urls.length, 3);

  const dir = mkdtempSync(join(tmpdir(), "moon-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  const db = openDb(":memory:");
  const result = await syncMini2020(db, join(dir, "auth.json"), join(dir, "raw.json"));
  assert.equal(result.inserted, 3);
  assert.equal(JSON.parse(db.getMeta("last_sync")!).inserted, 3);
});

test("sync reports an expired session", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
  const auth = { host: "moon.test", captured_at: 0, headers: {} };
  await assert.rejects(downloadBoard(auth, 19), /expired/);
});

test("re-import updates problems and keeps attempts", () => {
  const db = openDb(":memory:");
  assert.deepEqual(db.importProblems(normalizeAppProblems([rawProblem(1), rawProblem(2)]).rows), { inserted: 2, updated: 0 });
  const me = db.createUser("Cedric");
  db.setAttempt(me.id, 1, 30, { tries: 3, sent: false });

  const result = db.importProblems(normalizeAppProblems([rawProblem(1, {}, { repeats: 99 }), rawProblem(3)]).rows);
  assert.deepEqual(result, { inserted: 1, updated: 1 });
  const p = db.getProblem(1);
  assert.equal(p.repeats, 99);
  assert.equal(p.attempts.length, 1);
});

test("attempts per angle: tries, sends, flash and clearing", () => {
  const db = openDb(":memory:");
  db.importProblems(normalizeAppProblems([rawProblem(1)]).rows);
  const me = db.createUser("Cedric");

  // Marking sent with zero tries counts as one try (a flash).
  assert.equal((db.setAttempt(me.id, 1, 25, { tries: 0, sent: true }) as any).tries, 1);

  db.setAttempt(me.id, 1, 40, { tries: 2, sent: false });
  const firstSend = db.setAttempt(me.id, 1, 40, { tries: 3, sent: true }) as any;
  // Adding a try after sending keeps the original send date.
  const later = db.setAttempt(me.id, 1, 40, { tries: 4, sent: true }) as any;
  assert.equal(later.sent_at, firstSend.sent_at);

  assert.equal(db.setAttempt(me.id, 1, 25, { tries: 0, sent: false }), null);
  assert.deepEqual(
    db.getProblem(1).attempts.map((a: any) => [a.angle, a.tries, a.sent_at != null]),
    [[40, 4, true]],
  );
});

test("list filters by status at the selected angle", () => {
  const db = openDb(":memory:");
  db.importProblems(normalizeAppProblems([rawProblem(1), rawProblem(2), rawProblem(3), rawProblem(4)]).rows);
  const me = db.createUser("Cedric");
  const wife = db.createUser("Partner");
  db.setAttempt(me.id, 1, 40, { tries: 1, sent: true });
  db.setAttempt(me.id, 2, 30, { tries: 5, sent: false });
  db.setAttempt(me.id, 3, 30, { tries: 2, sent: true });
  db.setAttempt(wife.id, 4, 30, { tries: 1, sent: true });

  const ids = (status: any, angle = 30) =>
    db.listProblems({ userId: me.id, angle, status, sort: "name" }).items.map((p: any) => p.id);
  assert.deepEqual(ids("sent"), [3]);
  assert.deepEqual(ids("trying"), [2]);
  assert.deepEqual(ids("todo"), [1, 2, 4]);
  assert.deepEqual(ids("other"), [1]);

  const item = db.listProblems({ userId: me.id, angle: 30, q: "Problem 3" }).items[0];
  assert.deepEqual(item.mine, { 30: { tries: 2, sent: 1 } });
});

test("user names are unique ignoring case", () => {
  const db = openDb(":memory:");
  const a = db.createUser("Cedric");
  const b = db.createUser("cedric");
  assert.equal(a.id, b.id);
  assert.equal(db.listUsers().length, 1);
});

test("progress file round-trips climbers and attempts", async () => {
  const { writeProgress, restoreProgress } = await import("../server/progress.ts");
  const { readFileSync } = await import("node:fs");
  const path = join(mkdtempSync(join(tmpdir(), "progress-")), "ascents.json");

  const source = openDb(":memory:");
  source.importProblems(normalizeAppProblems([rawProblem(1), rawProblem(2)]).rows);
  const me = source.createUser("Cedric");
  const partner = source.createUser("Partner");
  source.setAttempt(me.id, 1, 30, { tries: 3, sent: true });
  source.setAttempt(partner.id, 2, 40, { tries: 2, sent: false });
  await writeProgress(source, path);
  assert.match(readFileSync(path, "utf8"), /"climber":"Cedric","problem":1,"name":"Problem 1","grade":"6B\+","angle":30,"tries":3/);

  // A fresh database restores climbers right away, and attempts once their problems exist.
  const target = openDb(":memory:");
  assert.equal(await restoreProgress(target, path), 0);
  assert.deepEqual(target.listUsers().map((u) => u.name), ["Cedric", "Partner"]);
  target.importProblems(normalizeAppProblems([rawProblem(1), rawProblem(2)]).rows);
  assert.equal(await restoreProgress(target, path), 2);
  assert.equal(await restoreProgress(target, path), 0); // idempotent
  assert.deepEqual(target.exportAttempts(), source.exportAttempts());
});
