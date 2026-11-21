import { h, render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { Board } from "./board.js";

const html = htm.bind(h);

const ANGLES = [20, 25, 30, 35, 40];
const GRADES = ["4", "4+", "5", "5+", "6A", "6A+", "6B", "6B+", "6C", "6C+", "7A", "7A+", "7B", "7B+", "7C", "7C+", "8A", "8A+", "8B", "8B+", "8C", "8C+"];

// ---------- helpers ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function usePersisted(key, fallback) {
  const [value, setValue] = useState(() => load(key, fallback));
  useEffect(() => save(key, value), [key, value]);
  return [value, setValue];
}

function useHashRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(location.hash || "#/");
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return hash.slice(1);
}

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast") ?? Object.assign(document.createElement("div"), { id: "toast" });
  document.body.append(el);
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function attemptLabel(a) {
  if (!a) return "";
  if (a.sent) return a.tries === 1 ? "flash" : `sent · ${plural(a.tries, "try", "tries")}`;
  return plural(a.tries, "try", "tries");
}

// ---------- list state ----------

// The last loaded list, shared with the problem view: prev / next step through it (loading its
// next page at the end), and going back to the list shows it as it was, at the same scroll
// position. The query and ids are saved too: phones often reload a web app left in the background.
const listState = { key: "", total: 0, ids: [], items: [], scrollY: 0, ...load("list", {}) };

// Adds a page of results (offset 0 starts a new list).
function addListPage(key, offset, page) {
  if (offset === 0 || key !== listState.key) Object.assign(listState, { key, ids: [], items: [] });
  // After a reload only the ids are known; the items come back when the list is loaded again.
  const complete = listState.items.length === listState.ids.length;
  listState.items = complete ? [...listState.items, ...page.items] : [];
  listState.ids = [...listState.ids, ...page.items.map((p) => p.id)];
  listState.total = page.total;
  save("list", { key: listState.key, total: listState.total, ids: listState.ids });
}

function fetchListPage(key, offset) {
  return api(`/api/problems?${key}&offset=${offset}&limit=50`);
}

function listKey(angle, filters) {
  const params = new URLSearchParams({ angle, status: filters.status, sort: filters.sort });
  if (filters.q) params.set("q", filters.q);
  if (filters.gmin !== "") params.set("gmin", filters.gmin);
  if (filters.gmax !== "") params.set("gmax", filters.gmax);
  if (filters.bench) params.set("bench", "1");
  return params.toString();
}

// ---------- user picker ----------

function UserPicker({ onPick }) {
  const [users, setUsers] = useState(null);
  const [name, setName] = useState("");

  useEffect(() => {
    api("/api/users").then(setUsers, (e) => toast(e.message));
  }, []);

  async function pick(userId) {
    onPick(await api("/api/session", { method: "POST", body: JSON.stringify({ userId }) }));
  }

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      onPick(await api("/api/users", { method: "POST", body: JSON.stringify({ name: name.trim() }) }));
    } catch (err) {
      toast(err.message);
    }
  }

  return html`
    <main class="picker">
      <h1>MoonBoard Angles</h1>
      <p class="muted">Mini MoonBoard 2020 · 20° to 40°</p>
      <h2>Who's climbing?</h2>
      <div class="picker-users">
        ${users?.map((u) => html`<button class="btn big" onClick=${() => pick(u.id)}>${u.name}</button>`)}
      </div>
      <form class="picker-new" onSubmit=${create}>
        <input placeholder="New climber name" value=${name} onInput=${(e) => setName(e.target.value)} maxlength="40" />
        <button class="btn" type="submit">Add</button>
      </form>
    </main>
  `;
}

// ---------- shared bits ----------

function AngleBar({ angle, setAngle }) {
  return html`
    <div class="angles" role="radiogroup" aria-label="Board angle">
      ${ANGLES.map((a) => html`
        <button role="radio" aria-checked=${a === angle} class=${a === angle ? "on" : ""} onClick=${() => setAngle(a)}>${a}°</button>
      `)}
    </div>
  `;
}

function AngleDots({ mine, angle }) {
  return html`
    <span class="dots" aria-hidden="true">
      ${ANGLES.map((a) => {
        const m = mine[a];
        const cls = m?.sent ? "sent" : m?.tries ? "tried" : "";
        return html`<span class=${`dot ${cls} ${a === angle ? "cur" : ""}`} title=${`${a}°`}></span>`;
      })}
    </span>
  `;
}

// ---------- problem list ----------

const DEFAULT_FILTERS = { q: "", gmin: "", gmax: "", status: "any", sort: "repeats", bench: false };

function ProblemList({ angle }) {
  const [filters, setFilters] = usePersisted("filters", DEFAULT_FILTERS);
  const key = listKey(angle, filters);
  // Coming back from a problem: the same list is still loaded.
  const restore = useRef(listState.key === key && listState.items.length > 0 && listState.items.length === listState.ids.length);
  const [data, setData] = useState(() => (restore.current ? { total: listState.total, items: listState.items } : { total: 0, items: [] }));
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const reqId = useRef(0);

  const fetchPage = useCallback(async (offset) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const page = await fetchListPage(key, offset);
      if (id !== reqId.current) return;
      addListPage(key, offset, page);
      setData({ total: listState.total, items: listState.items });
    } catch (e) {
      toast(e.message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    if (restore.current) {
      restore.current = false;
      window.scrollTo(0, listState.scrollY);
      return;
    }
    const t = setTimeout(() => fetchPage(0), filters.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [fetchPage]);

  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const activeFilters = ["gmin", "gmax"].filter((k) => filters[k] !== "").length + (filters.bench ? 1 : 0) + (filters.status !== "any" ? 1 : 0);

  return html`
    <section>
      <div class="toolbar">
        <input type="search" placeholder="Search name or setter" value=${filters.q} onInput=${set("q")} />
        <button class=${`btn ${showFilters ? "on" : ""}`} onClick=${() => setShowFilters(!showFilters)}>
          Filters${activeFilters ? ` (${activeFilters})` : ""}
        </button>
      </div>
      ${showFilters && html`
        <div class="filters">
          <label>Status at ${angle}°
            <select value=${filters.status} onChange=${set("status")}>
              <option value="any">All problems</option>
              <option value="todo">Not sent yet</option>
              <option value="trying">Projects (tried, not sent)</option>
              <option value="sent">Sent</option>
              <option value="other">Sent at another angle only</option>
            </select>
          </label>
          <label>Sort
            <select value=${filters.sort} onChange=${set("sort")}>
              <option value="repeats">Most repeats</option>
              <option value="grade">Grade ↑</option>
              <option value="grade_desc">Grade ↓</option>
              <option value="new">Newest</option>
              <option value="recent">My recent activity</option>
              <option value="name">Name</option>
            </select>
          </label>
          <label>From
            <select value=${filters.gmin} onChange=${set("gmin")}>
              <option value="">any</option>
              ${GRADES.map((g, i) => html`<option value=${i}>${g}</option>`)}
            </select>
          </label>
          <label>To
            <select value=${filters.gmax} onChange=${set("gmax")}>
              <option value="">any</option>
              ${GRADES.map((g, i) => html`<option value=${i}>${g}</option>`)}
            </select>
          </label>
          <label class="check"><input type="checkbox" checked=${filters.bench} onChange=${set("bench")} /> Benchmarks only</label>
          <button class="btn subtle" onClick=${() => setFilters(DEFAULT_FILTERS)}>Reset</button>
        </div>
      `}
      <p class="muted count">${data.total.toLocaleString()} problems</p>
      <ul class="list">
        ${data.items.map((p) => html`
          <li>
            <a href=${`#/p/${p.id}`} onClick=${() => { listState.scrollY = window.scrollY; }}>
              <span class="grade">${p.grade}</span>
              <span class="info">
                <span class="name">${p.is_benchmark ? html`<span class="bench" title="Benchmark">B</span>` : ""}${p.name}</span>
                <span class="meta">${p.setter ?? "?"} · ${p.repeats} repeats${p.mine[angle] ? ` · ${attemptLabel(p.mine[angle])}` : ""}</span>
              </span>
              <${AngleDots} mine=${p.mine} angle=${angle} />
            </a>
          </li>
        `)}
      </ul>
      ${data.items.length < data.total && html`
        <button class="btn wide" disabled=${loading} onClick=${() => fetchPage(data.items.length)}>${loading ? "Loading…" : "Load more"}</button>
      `}
      ${!loading && data.total === 0 && html`
        <p class="empty">No problems here. ${filters.q || activeFilters ? "Try clearing filters." : html`<a href="#/sync">Sync problems</a> first.`}</p>
      `}
    </section>
  `;
}

// ---------- problem view ----------

// Recently seen problems, so prev / next show the next one at once (neighbours are prefetched).
const problemCache = new Map();
function rememberProblem(p) {
  problemCache.delete(p.id);
  problemCache.set(p.id, { problem: p, at: Date.now() });
  if (problemCache.size > 30) problemCache.delete(problemCache.keys().next().value);
}
function fetchProblem(id) {
  return api(`/api/problems/${id}`).then((p) => {
    rememberProblem(p);
    return p;
  });
}

// Horizontal swipe: left = next, right = previous. Touches starting at the screen edge are left
// to the browser's own back / forward gesture. (Lowercase handler names: Preact then always
// listens for "touchstart", even where the browser doesn't advertise touch support.)
function useSwipe(onNext, onPrev) {
  const start = useRef(null);
  return {
    ontouchstart(e) {
      const t = e.touches[0];
      start.current = e.touches.length === 1 && t.clientX > 24 && t.clientX < innerWidth - 24 ? { x: t.clientX, y: t.clientY } : null;
    },
    ontouchend(e) {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) (dx < 0 ? onNext : onPrev)();
    },
  };
}

// The angle the board is at: tries and sends are logged here only (switch the angle above to
// log another one). Once sent, the try count is locked, and unsending takes a second tap within
// 3 seconds, so a stray tap can't lose a send.
function CurrentAngle({ angle, attempt, others, onChange }) {
  const tries = attempt?.tries ?? 0;
  const sent = attempt?.sent_at != null;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  function tapSend() {
    if (!sent) return onChange({ tries: Math.max(tries, 1), sent: true });
    if (!armed) return setArmed(true);
    setArmed(false);
    onChange({ tries, sent: false });
  }

  return html`
    <div class=${`angle-row cur ${sent ? "is-sent" : ""}`}>
      <div class="angle-label">${angle}°</div>
      <div class="stepper">
        <button aria-label="Remove a try" disabled=${tries === 0 || sent} onClick=${() => onChange({ tries: tries - 1, sent })}>−</button>
        <span class="tries"><b>${tries}</b><small>${tries === 1 ? "try" : "tries"}</small></span>
        <button aria-label="Add a try" disabled=${sent} onClick=${() => onChange({ tries: tries + 1, sent })}>+</button>
      </div>
      <button class=${`send ${sent ? "on" : ""} ${armed ? "armed" : ""}`} onClick=${tapSend}>
        ${armed ? "Unsend?" : sent ? (tries === 1 ? "⚡ Flash" : "✓ Sent") : "Sent?"}
      </button>
      ${others.length > 0 && html`
        <div class="others">${others.map((o) => html`<span>${o.user_name}: ${attemptLabel({ tries: o.tries, sent: o.sent_at != null })}</span>`)}</div>
      `}
    </div>
  `;
}

// Read-only summary of the other angles that have something on them.
function OtherAngles({ problem, angle, user }) {
  const label = (x) => attemptLabel({ tries: x.tries, sent: x.sent_at != null });
  const rows = ANGLES.filter((a) => a !== angle)
    .map((a) => {
      const here = problem.attempts.filter((x) => x.angle === a);
      const mine = here.find((x) => x.user_id === user.id);
      const people = [
        ...(mine ? [{ who: "You", x: mine, sent: mine.sent_at != null }] : []),
        ...here.filter((x) => x.user_id !== user.id).map((x) => ({ who: x.user_name, x, sent: x.sent_at != null })),
      ];
      return { a, people };
    })
    .filter((r) => r.people.length);
  if (!rows.length) return null;
  return html`
    <h3>Other angles</h3>
    <ul class="other-angles">
      ${rows.map(({ a, people }) => html`
        <li>
          <b>${a}°</b>
          <span>${people.map((p, i) => html`${i ? ", " : ""}<span class=${p.sent ? "sent-text" : ""}>${p.who}: ${label(p.x)}</span>`)}</span>
        </li>
      `)}
    </ul>
  `;
}

function ProblemView({ id, angle, user }) {
  const [problem, setProblem] = useState(() => problemCache.get(id)?.problem ?? null);

  useEffect(() => {
    const cached = problemCache.get(id);
    setProblem(cached?.problem ?? null);
    if (cached && Date.now() - cached.at < 60_000) return; // fresh enough (just prefetched)
    let live = true;
    fetchProblem(id).then((p) => live && setProblem(p), (e) => toast(e.message));
    return () => { live = false; };
  }, [id]);

  const idx = problem ? listState.ids.indexOf(problem.id) : -1;
  const prev = idx > 0 ? listState.ids[idx - 1] : null;
  const next = idx >= 0 && idx < listState.ids.length - 1 ? listState.ids[idx + 1] : null;
  const hasMore = idx >= 0 && idx === listState.ids.length - 1 && listState.ids.length < listState.total;

  // Prefetch the neighbours, so stepping is instant.
  useEffect(() => {
    for (const n of [next, prev]) if (n != null && !problemCache.has(n)) fetchProblem(n).catch(() => {});
  }, [problem?.id]);

  // replace(), not a new history entry: "back" returns to the list, not through every problem seen.
  async function go(step) {
    let target = step < 0 ? prev : next;
    if (target == null && step > 0 && hasMore) {
      try {
        addListPage(listState.key, listState.ids.length, await fetchListPage(listState.key, listState.ids.length));
        target = listState.ids[idx + 1];
      } catch (e) {
        return toast(e.message);
      }
    }
    if (target != null) location.replace(`#/p/${target}`);
  }
  const swipe = useSwipe(() => go(1), () => go(-1));

  async function update(a, change) {
    const previous = problem;
    const optimistic = problem.attempts.filter((x) => !(x.user_id === user.id && x.angle === a));
    if (change.tries > 0 || change.sent) {
      const old = problem.attempts.find((x) => x.user_id === user.id && x.angle === a);
      optimistic.push({ user_id: user.id, user_name: user.name, angle: a, tries: change.tries, sent_at: change.sent ? old?.sent_at ?? Date.now() : null });
    }
    const updated = { ...problem, attempts: optimistic };
    setProblem(updated);
    try {
      await api("/api/attempts", { method: "PUT", body: JSON.stringify({ problemId: problem.id, angle: a, ...change }) });
      rememberProblem(updated);
      // Keep the list's dots right when going back to it.
      const item = listState.items.find((p) => p.id === problem.id);
      if (item) {
        const mine = { ...item.mine };
        if (change.tries > 0 || change.sent) mine[a] = { tries: change.tries, sent: change.sent ? 1 : 0 };
        else delete mine[a];
        item.mine = mine;
      }
    } catch (e) {
      setProblem(previous);
      toast(`Not saved: ${e.message}`);
    }
  }

  if (!problem) return html`<p class="muted center">Loading…</p>`;

  const mine = problem.attempts.find((x) => x.user_id === user.id && x.angle === angle);
  return html`
    <section class=${`problem ${idx >= 0 ? "has-stepbar" : ""}`} ...${swipe}>
      <div class="problem-head">
        <h2>${problem.name}</h2>
        <p class="muted">
          <b class="grade-inline">${problem.grade}</b>${problem.user_grade && problem.user_grade !== problem.grade ? ` (user ${problem.user_grade})` : ""}${` · ${problem.setter ?? "?"} · ${problem.repeats} repeats`}${problem.is_benchmark ? " · benchmark" : ""}
        </p>
        ${problem.method && html`<p class="muted small">${problem.method}</p>`}
      </div>
      <${Board} holds=${problem.holds} />
      <h3>At ${angle}°</h3>
      <${CurrentAngle}
        key=${`${problem.id}-${angle}`}
        angle=${angle}
        attempt=${mine}
        others=${problem.attempts.filter((x) => x.user_id !== user.id && x.angle === angle)}
        onChange=${(c) => update(angle, c)}
      />
      <${OtherAngles} problem=${problem} angle=${angle} user=${user} />
      <p class="muted small">Official grade is for 40°. To log at another angle, switch it above.</p>
      ${idx >= 0 && html`
        <nav class="stepbar" aria-label="Problems">
          <button class="btn" disabled=${prev == null} onClick=${() => go(-1)}>‹ Prev</button>
          <span class="muted small">${idx + 1} / ${listState.total.toLocaleString()}</span>
          <button class="btn" disabled=${next == null && !hasMore} onClick=${() => go(1)}>Next ›</button>
        </nav>
      `}
    </section>
  `;
}

// ---------- progress ----------

function Progress({ user }) {
  const [stats, setStats] = useState(null);
  const [who, setWho] = useState(user.id);

  useEffect(() => {
    api("/api/stats").then(setStats, (e) => toast(e.message));
  }, []);

  if (!stats) return html`<p class="muted center">Loading…</p>`;

  const sends = {};
  let flashes = 0;
  for (const s of stats.sends) {
    if (s.user_id !== who) continue;
    (sends[s.grade] ??= {})[s.angle] = s.n;
    flashes += s.flashes;
  }
  const perAngle = Object.fromEntries(ANGLES.map((a) => [a, stats.sends.filter((s) => s.user_id === who && s.angle === a).reduce((n, s) => n + s.n, 0)]));
  const trying = Object.fromEntries(stats.trying.filter((t) => t.user_id === who).map((t) => [t.angle, t.n]));

  return html`
    <section>
      <div class="chips">
        ${stats.users.map((u) => html`<button class=${`chip ${u.id === who ? "on" : ""}`} onClick=${() => setWho(u.id)}>${u.name}</button>`)}
      </div>
      <div class="tiles">
        ${ANGLES.map((a) => html`
          <div class="tile">
            <span class="tile-angle">${a}°</span>
            <b>${perAngle[a]}</b>
            <small>${trying[a] ? plural(trying[a], "project") : "sends"}</small>
          </div>
        `)}
      </div>
      <p class="muted small">${plural(flashes, "flash", "flashes")} in total</p>
      <table class="grid">
        <thead><tr><th>Grade</th>${ANGLES.map((a) => html`<th>${a}°</th>`)}<th class="muted">Total</th></tr></thead>
        <tbody>
          ${stats.totals.map((t) => html`
            <tr>
              <th>${t.grade}</th>
              ${ANGLES.map((a) => {
                const n = sends[t.grade]?.[a] ?? 0;
                return html`<td class=${n ? "has" : ""} style=${n ? `--fill:${Math.min(1, 0.15 + n / t.n)}` : ""}>${n || ""}</td>`;
              })}
              <td class="muted">${t.n}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </section>
  `;
}

// ---------- sync ----------

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function Sync() {
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api("/api/sync").then(setStatus, (e) => toast(e.message));
  // The deployed app can't sync itself (problems come from `npm run cloud:push`).
  const canSync = status?.canSync !== false;
  useEffect(() => {
    refresh();
    if (!canSync) return;
    const t = setInterval(refresh, 5000); // picks up a fresh capture from the phone
    return () => clearInterval(t);
  }, [canSync]);

  async function sync() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api("/api/sync", { method: "POST" }));
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(false);
      refresh();
    }
  }

  // App Check tokens last about an hour.
  const fresh = status?.authCapturedAt && Date.now() - status.authCapturedAt < 55 * 60000;
  const last = status?.lastSync;

  return html`
    <section class="sync">
      <h2>Sync problems</h2>
      <p>${status ? `${status.problems.toLocaleString()} Mini 2020 problems in the app.` : "…"}
        ${last ? ` Last sync ${ago(last.at)}.` : ""}</p>
      ${!canSync && html`
        <p class="muted">This copy of the app is online: problems are synced from the computer.</p>
        <ol>
          <li>Sync on the computer as usual (<code>npm run moon:sync</code>, see the README).</li>
          <li>Then <code>npm run cloud:push</code> to send the problems here.</li>
        </ol>
        <p class="muted small">Re-syncing is safe: problems are updated in place and your attempts are kept.</p>
      `}
      ${canSync && html`
      <p class=${fresh ? "ok" : "muted"}>
        ${!status?.authCapturedAt ? "No Moon app session captured yet."
          : fresh ? `Moon app session captured ${ago(status.authCapturedAt)}, ready.`
          : `Moon app session captured ${ago(status.authCapturedAt)}, probably expired.`}
      </p>
      <button class="btn wide" disabled=${busy || !status?.authCapturedAt} onClick=${sync}>${busy ? "Syncing…" : "Sync now"}</button>
      ${result?.error && html`<p class="error">${result.error}</p>`}
      ${result && !result.error && html`
        <p class="ok">${result.downloaded} downloaded: ${result.inserted} new, ${result.updated} updated${result.deleted ? `, ${result.deleted} removed upstream` : ""}${result.skipped ? `, ${result.skipped} skipped` : ""}.</p>
      `}
      <h3>How to capture a session</h3>
      <ol>
        <li>On the computer: <code>npm run moon:proxy</code>.</li>
        <li>On the iPhone: turn on the <b>moon</b> tunnel in the WireGuard app.</li>
        <li>Open the Moon app and load the Mini MoonBoard 2020 problems.</li>
        <li>Come back here and tap <b>Sync now</b> within the hour, then turn the tunnel off.</li>
      </ol>
      <p class="muted small">Re-syncing is safe: problems are updated in place and your attempts are kept.</p>
      `}
    </section>
  `;
}

// ---------- app shell ----------

function App() {
  const [user, setUser] = useState(undefined);
  const [angle, setAngle] = usePersisted("angle", 40);
  const route = useHashRoute();

  useEffect(() => {
    api("/api/me").then(setUser, () => setUser(null));
  }, []);

  // A problem opens at the top; the list restores its own position (see ProblemList).
  useEffect(() => {
    if (route.startsWith("/p/")) window.scrollTo(0, 0);
  }, [route]);

  if (user === undefined) return null;
  if (user === null) return html`<${UserPicker} onPick=${setUser} />`;

  async function switchUser() {
    await api("/api/session", { method: "DELETE" });
    setUser(null);
  }

  const problemMatch = /^\/p\/(\d+)$/.exec(route);
  const tab = problemMatch || route === "/" ? "problems" : route.slice(1);
  let page;
  if (problemMatch) page = html`<${ProblemView} id=${Number(problemMatch[1])} angle=${angle} user=${user} />`;
  else if (route === "/progress") page = html`<${Progress} user=${user} />`;
  else if (route === "/sync") page = html`<${Sync} />`;
  else page = html`<${ProblemList} angle=${angle} />`;

  return html`
    <header>
      <div class="bar">
        <nav>
          <a href="#/" class=${tab === "problems" ? "on" : ""}>Problems</a>
          <a href="#/progress" class=${tab === "progress" ? "on" : ""}>Progress</a>
          <a href="#/sync" class=${tab === "sync" ? "on" : ""}>Sync</a>
        </nav>
        <button class="who" onClick=${switchUser} title="Switch climber">${user.name}</button>
      </div>
      ${tab !== "sync" && tab !== "progress" && html`<${AngleBar} angle=${angle} setAngle=${setAngle} />`}
    </header>
    <main>${page}</main>
  `;
}

history.scrollRestoration = "manual"; // scroll positions are handled above
render(html`<${App} />`, document.getElementById("app"));
