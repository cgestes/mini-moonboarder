import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// Mini MoonBoard 2020: columns A-K, rows 1 (bottom) to 12 (top).
export const COLS = "ABCDEFGHIJK".split("");
export const ROWS = 12;
const CELL = 50;
const PAD = 30;
const W = PAD + COLS.length * CELL + 8;
const H = ROWS * CELL + PAD + 8;
// Hold photos are 90px squares with the hold centred, drawn at the website's scale (50px cells).
const PHOTO = 90;

function pos(p) {
  const col = COLS.indexOf(p[0]);
  const row = Number(p.slice(1));
  return { x: PAD + col * CELL + CELL / 2, y: 8 + (ROWS - row) * CELL + CELL / 2 };
}

// The hold layout is loaded once and shared by every board.
let layoutPromise;
function useLayout() {
  const [layout, setLayout] = useState([]);
  useEffect(() => {
    layoutPromise ??= fetch("/api/holds").then((r) => r.json()).then((d) => d.holds, () => []);
    layoutPromise.then(setLayout);
  }, []);
  return layout;
}

export function Board({ holds }) {
  const layout = useLayout();
  const occupied = new Set(layout.map((l) => l.cell));
  const dots = [];
  for (let r = 1; r <= ROWS; r++) {
    for (const c of COLS) {
      if (occupied.has(c + r)) continue;
      const { x, y } = pos(c + r);
      dots.push(html`<circle cx=${x} cy=${y} r="4" class="board-dot" />`);
    }
  }
  return html`
    <svg class=${`board ${layout.length ? "with-photos" : ""}`} viewBox="0 0 ${W} ${H}" role="img" aria-label="Board with ${holds.length} holds">
      <rect x=${PAD - 4} y="4" width=${COLS.length * CELL + 8} height=${ROWS * CELL + 8} rx="10" class="board-bg" />
      ${COLS.map((c, i) => html`<text x=${PAD + i * CELL + CELL / 2} y=${H - 6} class="board-label">${c}</text>`)}
      ${Array.from({ length: ROWS }, (_, i) => html`<text x=${PAD / 2 - 2} y=${8 + (ROWS - 1 - i) * CELL + CELL / 2 + 5} class="board-label">${i + 1}</text>`)}
      ${dots}
      ${layout.map(({ cell, image, rotation }) => {
        const { x, y } = pos(cell);
        return html`<image href=${`/holds/${image}`} x=${x - PHOTO / 2} y=${y - PHOTO / 2} width=${PHOTO} height=${PHOTO}
          transform=${`rotate(${rotation} ${x} ${y})`} class="board-hold" />`;
      })}
      ${holds.map(({ p, t }) => {
        const { x, y } = pos(p);
        return html`<circle cx=${x} cy=${y} r="23" class=${`hold hold-${t}`}><title>${p}${t === "f" ? " (foot)" : ""}</title></circle>`;
      })}
    </svg>
  `;
}
