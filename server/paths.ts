import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");
export const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, "moonboard.db");
export const PROGRESS_PATH = process.env.PROGRESS_PATH ?? join(ROOT, "progress", "ascents.json");
