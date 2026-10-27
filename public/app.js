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

// Ids of the last loaded list, so the problem view can step to prev / next.
let listIds = [];

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
  const [data, setData] = useState({ total: 0, items: [] });
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const reqId = useRef(0);

  const fetchPage = useCallback(async (offset) => {
    const id = ++reqId.current;
    const params = new URLSearchParams({ angle, offset, limit: 50, status: filters.status, sort: filters.sort });
    if (filters.q) params.set("q", filters.q);
    if (filters.gmin !== "") params.set("gmin", filters.gmin);
    if (filters.gmax !== "") params.set("gmax", filters.gmax);
    if (filters.bench) params.set("bench", "1");
    setLoading(true);
    try {
      const page = await api(`/api/problems?${params}`);
      if (id !== reqId.current) return;
      setData((prev) => {
        const items = offset === 0 ? page.items : [...prev.items, ...page.items];
        listIds = items.map((p) => p.id);
        return { total: page.total, items };
      });
    } catch (e) {
      toast(e.message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [angle, filters]);

  useEffect(() => {
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
            <a href=${`#/p/${p.id}`}>
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

function AngleRow({ angle, current, attempt, others, onChange }) {
  const tries = attempt?.tries ?? 0;
  const sent = attempt?.sent_at != null;
  return html`
    <div class=${`angle-row ${angle === current ? "cur" : ""} ${sent ? "is-sent" : ""}`}>
      <div class="angle-label">${angle}°</div>
      <div class="stepper">
        <button aria-label="Remove a try" disabled=${tries === 0 || (sent && tries <= 1)} onClick=${() => onChange({ tries: tries - 1, sent })}>−</button>
        <span class="tries"><b>${tries}</b><small>${tries === 1 ? "try" : "tries"}</small></span>
        <button aria-label="Add a try" onClick=${() => onChange({ tries: tries + 1, sent })}>+</button>
      </div>
      <button class=${`send ${sent ? "on" : ""}`} onClick=${() => onChange({ tries: sent ? tries : Math.max(tries, 1), sent: !sent })}>
        ${sent ? (tries === 1 ? "⚡ Flash" : "✓ Sent") : "Sent?"}
      </button>
      ${others.length > 0 && html`
        <div class="others">${others.map((o) => html`<span>${o.user_name}: ${attemptLabel({ tries: o.tries, sent: o.sent_at != null })}</span>`)}</div>
      `}
    </div>
  `;
}

function ProblemView({ id, angle, user }) {
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    setProblem(null);
    api(`/api/problems/${id}`).then(setProblem, (e) => toast(e.message));
  }, [id]);

  async function update(a, change) {
    const previous = problem;
    const optimistic = problem.attempts.filter((x) => !(x.user_id === user.id && x.angle === a));
    if (change.tries > 0 || change.sent) {
      const old = problem.attempts.find((x) => x.user_id === user.id && x.angle === a);
      optimistic.push({ user_id: user.id, user_name: user.name, angle: a, tries: change.tries, sent_at: change.sent ? old?.sent_at ?? Date.now() : null });
    }
    setProblem({ ...problem, attempts: optimistic });
    try {
      await api("/api/attempts", { method: "PUT", body: JSON.stringify({ problemId: problem.id, angle: a, ...change }) });
    } catch (e) {
      setProblem(previous);
      toast(`Not saved: ${e.message}`);
    }
  }

  if (!problem) return html`<p class="muted center">Loading…</p>`;

  const idx = listIds.indexOf(problem.id);
  const prev = idx > 0 ? listIds[idx - 1] : null;
  const next = idx >= 0 && idx < listIds.length - 1 ? listIds[idx + 1] : null;

  return html`
    <section class="problem">
      <div class="problem-head">
        <a class="btn subtle" href=${prev ? `#/p/${prev}` : undefined} aria-disabled=${!prev}>‹</a>
        <div class="title">
          <h2>${problem.name}</h2>
          <p class="muted">
            <b class="grade-inline">${problem.grade}</b>${problem.user_grade && problem.user_grade !== problem.grade ? ` (user ${problem.user_grade})` : ""}${` · ${problem.setter ?? "?"} · ${problem.repeats} repeats`}${problem.is_benchmark ? " · benchmark" : ""}
          </p>
          ${problem.method && html`<p class="muted small">${problem.method}</p>`}
        </div>
        <a class="btn subtle" href=${next ? `#/p/${next}` : undefined} aria-disabled=${!next}>›</a>
      </div>
      <${Board} holds=${problem.holds} />
      <h3>Your attempts</h3>
      ${ANGLES.map((a) => html`
        <${AngleRow}
          angle=${a}
          current=${angle}
          attempt=${problem.attempts.find((x) => x.user_id === user.id && x.angle === a)}
          others=${problem.attempts.filter((x) => x.user_id !== user.id && x.angle === a)}
          onChange=${(c) => update(a, c)}
        />
      `)}
      <p class="muted small">Official grade is for 40°.</p>
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
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000); // picks up a fresh capture from the phone
    return () => clearInterval(t);
  }, []);

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

  useEffect(() => window.scrollTo(0, 0), [route.startsWith("/p/") ? route : ""]);

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

render(html`<${App} />`, document.getElementById("app"));
