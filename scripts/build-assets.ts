// Builds dist/, the Worker's static files: public/ plus the browser libraries the import map in
// index.html points at (the local server serves those straight from node_modules).
// Run by wrangler before `wrangler dev` / `wrangler deploy` (see wrangler.jsonc).
import { cpSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT } from "../server/paths.ts";

const DIST = join(ROOT, "dist");
const COPIES: [from: string, to: string][] = [
  ["public", ""],
  ["node_modules/preact/dist", "vendor/preact/dist"],
  ["node_modules/preact/hooks/dist", "vendor/preact/hooks/dist"],
  ["node_modules/htm/dist", "vendor/htm/dist"],
];

rmSync(DIST, { recursive: true, force: true });
for (const [from, to] of COPIES) {
  cpSync(join(ROOT, from), join(DIST, to), { recursive: true, filter: (src) => !basename(src).startsWith(".") });
}
console.log(`Built ${DIST}`);
