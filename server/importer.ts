// Normalizes problems from the Moon app backend (see server/moon.ts) into our rows.

export const MINI_2020_BOARD_ID = 19;
// The Mini 2020 only exists at 40° officially; that's where grades, benchmarks and repeats live.
export const OFFICIAL_ANGLE = "40°";

export const GRADES = [
  "4", "4+", "5", "5+",
  "6A", "6A+", "6B", "6B+", "6C", "6C+",
  "7A", "7A+", "7B", "7B+", "7C", "7C+",
  "8A", "8A+", "8B", "8B+", "8C", "8C+",
];

// s = start, m = hand hold, e = finish, f = foot hold
export type HoldType = "s" | "m" | "e" | "f";
export type Hold = { p: string; t: HoldType };

export type ProblemRow = {
  id: number;
  name: string;
  grade: string;
  grade_idx: number;
  user_grade: string | null;
  setter: string | null;
  method: string | null;
  is_benchmark: number;
  repeats: number;
  rating: number | null;
  holds: Hold[];
  created_at: number | null;
};

export function gradeIndex(grade: string): number {
  return GRADES.indexOf(grade.trim().toUpperCase());
}

// "2024-03-01T10:20:30.123" (no zone, server time is UTC) -> ms since epoch
function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(ms) ? null : ms;
}

// Mini 2020 grid: columns A-K, rows 1-12.
const MOVE_RE = /^([a-z])~([a-k](?:[1-9]|1[0-2]))~$/i;
const KIND_TO_TYPE: Record<string, HoldType> = { s: "s", e: "e", f: "f" };

// "s~D5~|p~G8~|l~G11~|f~C3~|e~J12~": s = start, e = end, f = foot,
// anything else (p plain, l/r left/right hand, m match) is a hand hold.
export function parseMoves(moves: unknown): Hold[] | null {
  if (typeof moves !== "string") return null;
  const holds: Hold[] = [];
  for (const token of moves.split("|")) {
    const m = MOVE_RE.exec(token.trim());
    if (!m) return null; // not a Mini 2020 position: wrong board or unknown format
    holds.push({ p: m[2].toUpperCase(), t: KIND_TO_TYPE[m[1].toLowerCase()] ?? "m" });
  }
  return holds.length ? holds : null;
}

export type NormalizeResult = { rows: ProblemRow[]; deleted: number; skipped: number };

export function normalizeAppProblems(problems: any[]): NormalizeResult {
  const rows: ProblemRow[] = [];
  let deleted = 0;
  let skipped = 0;
  for (const p of problems) {
    const cfg = (p?.configurations ?? []).find((c: any) => c?.configuration === OFFICIAL_ANGLE);
    if (p?.dateDeleted || cfg?.dateDeleted) {
      deleted++;
      continue;
    }
    const id = Number(p?.id);
    const grade = String(cfg?.grade ?? cfg?.userGrade ?? "").trim().toUpperCase();
    const holds = parseMoves(p?.moves);
    if (!Number.isSafeInteger(id) || !cfg || gradeIndex(grade) < 0 || !holds) {
      skipped++;
      continue;
    }
    rows.push({
      id,
      name: String(p.name ?? "").trim() || "Untitled",
      grade,
      grade_idx: gradeIndex(grade),
      user_grade: cfg.userGrade ? String(cfg.userGrade).trim().toUpperCase() : null,
      setter: p.setter || null,
      method: p.climbMethod || null,
      is_benchmark: cfg.isBenchmark ? 1 : 0,
      repeats: Number(cfg.repeats) || 0,
      rating: typeof cfg.userRating === "number" ? cfg.userRating : null,
      holds,
      created_at: parseDate(p.dateInserted),
    });
  }
  return { rows, deleted, skipped };
}
