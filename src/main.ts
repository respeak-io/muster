import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

function loadWebgl(term: Terminal) {
  try {
    const w = new WebglAddon();
    w.onContextLoss(() => w.dispose()); // fall back to the DOM renderer
    term.loadAddon(w);
  } catch { /* WebGL unavailable — DOM renderer is fine */ }
}
let termEngine: "embedded" | "ghostty" =
  localStorage.getItem("cc-term-engine") === "ghostty" ? "ghostty" : "embedded";
function toggleEngine() {
  termEngine = termEngine === "ghostty" ? "embedded" : "ghostty";
  localStorage.setItem("cc-term-engine", termEngine);
  toast(`New sessions open in ${termEngine === "ghostty" ? "Ghostty (external)" : "the embedded terminal"}`);
  renderFoot();
}

// ---------- config ----------
// Home dir resolves at runtime (for `~` path abbreviation). Favorites start
// empty and are added by the user — persisted to localStorage.
let HOME = "";
homeDir().then((h) => { HOME = h.replace(/\/+$/, ""); }).catch(() => {});
interface Favorite { name: string; path: string }
const DEFAULT_FAVORITES: Favorite[] = [];
let FAVORITES: Favorite[] = JSON.parse(localStorage.getItem("cc-favorites") || "null") || DEFAULT_FAVORITES;
function saveFavorites() { localStorage.setItem("cc-favorites", JSON.stringify(FAVORITES)); }
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

// ---------- model ----------
type Phase = "idle" | "thinking" | "working" | "done" | "error" | "ended";
interface Act { ic: string; t: string; time: string; cls: string }
interface Sess {
  id: string; project: string; accent: string; workdir: string; colorKey: string;
  branch: string; worktree: string | null; title: string;
  phase: Phase; attention: string | null; pendingCmd: string; pendingPermId: string | null; subagents: number;
  model: string; ctxPct: number | null; cost: number | null; durMs: number | null;
  rl5h: number | null; rl7d: number | null; rl5hReset: number | null; rl7dReset: number | null; lastEvent: string; activity: Act[];
  external: boolean; term?: Terminal; fit?: FitAddon; pane: HTMLElement;
}
const sessions = new Map<string, Sess>();
let activeId: string | null = null;
let termFontSize = parseFloat(localStorage.getItem("cc-term-font") || "") || 12.5;

// persisted daily usage rollup (survives app + system restarts)
const usage: Record<string, number> = JSON.parse(localStorage.getItem("cc-usage") || "{}");
function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function addUsage(delta: number) { if (!(delta > 0)) return; const k = todayKey(); usage[k] = (usage[k] || 0) + delta; localStorage.setItem("cc-usage", JSON.stringify(usage)); }

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const tilde = (p: string) => (HOME ? p.replace(HOME, "~") : p);

const colorOverrides: Record<string, string> = JSON.parse(localStorage.getItem("cc-colors") || "{}");

// Per-project icon (a favicon/logo scoured from the repo), keyed by project path.
// Value: data-URI = found, "" = probed & none (or user cleared). Presence of the
// key means "already probed" so we don't hit the backend twice.
const icons: Record<string, string> = JSON.parse(localStorage.getItem("cc-icons") || "{}");
function saveIcons() { localStorage.setItem("cc-icons", JSON.stringify(icons)); }
function iconFor(key: string): string | null { const v = icons[key]; return v ? v : null; }
async function probeIcon(key: string) {
  if (key in icons) return; // already probed
  icons[key] = ""; // mark in-flight so we don't double-probe
  try {
    const r = await invoke<{ data_uri: string } | null>("find_project_icon", { dir: key });
    icons[key] = r?.data_uri || "";
  } catch { icons[key] = ""; }
  saveIcons();
  renderSidebar(); renderMini();
}
function clearIcon(key: string) { icons[key] = ""; saveIcons(); renderSidebar(); renderMini(); }
function projGlyph(key: string, accent: string): string {
  const ic = iconFor(key);
  return ic
    ? `<img class="picon" src="${ic}" alt="" title="${esc(basename(key))} — right-click to recolor / reset icon" />`
    : `<span class="pdot" title="Click to recolor" style="background:${accent};color:${accent}"></span>`;
}
function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const to = (x: number) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
function accentFor(key: string): string {
  if (colorOverrides[key]) return colorOverrides[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return hslToHex(h % 360, 0.68, 0.63);
}
function basename(p: string) { const parts = p.replace(/\/+$/, "").split("/"); return parts[parts.length - 1] || p; }
// Claude Code sets the terminal title (OSC) to an auto-summary; keep it unless it's
// just the folder path/name (which we already show).
function cleanTitle(t: string, s: Sess): string {
  const x = (t || "").trim();
  if (!x) return s.title;
  if (x === s.workdir || x === tilde(s.workdir) || x === s.project || x === basename(s.workdir)) return "";
  return x;
}

const GLYPH: Record<string, string> = { attention: "◆", working: "●", thinking: "●", done: "✓", idle: "○", error: "✕", ended: "·" };
const GCLASS: Record<string, string> = { attention: "g-attn", working: "g-work", thinking: "g-work", done: "g-done", idle: "g-idle", error: "g-error", ended: "g-ended" };
const PILL_TEXT: Record<Phase, string> = { idle: "idle", thinking: "thinking…", working: "working…", done: "your turn", error: "error", ended: "ended" };
const statusKey = (s: Sess) => (s.attention ? "attention" : s.phase);

// ---------- launch ----------
async function launch(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}) {
  const id = crypto.randomUUID();
  const colorKey = opts.colorKey ?? workdir;
  const accent = accentFor(colorKey);
  probeIcon(colorKey);
  const external = termEngine === "ghostty";
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);

  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  if (external) {
    pane.innerHTML = `<div class="ext-pane"><div class="ext-logo"></div><h2>Running in Ghostty</h2><p>${esc(project)}${opts.worktree ? " · " + esc(opts.worktree) : ""} — the terminal is in your Ghostty window.<br>Muster still tracks its status, cost &amp; context here.</p></div>`;
  } else {
    term = new Terminal({
      fontFamily: MONO, fontSize: termFontSize, cursorBlink: true, scrollback: 8000,
      theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    loadWebgl(term);
    term.open(pane);
    term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  }

  const s: Sess = {
    id, project, accent, workdir, colorKey, branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "",
    phase: "idle", attention: null, pendingCmd: "", pendingPermId: null, subagents: 0,
    model: "", ctxPct: null, cost: null, durMs: null, rl5h: null, rl7d: null, rl5hReset: null, rl7dReset: null,
    lastEvent: "", activity: [], external, term, fit, pane,
  };
  sessions.set(id, s);
  term?.onTitleChange((t) => {
    const c = cleanTitle(t, s);
    if (c !== s.title) { s.title = c; renderSidebar(); if (activeId === id) renderHeader(s); }
  });
  setActive(id);

  try {
    if (external) await invoke("spawn_ghostty", { sessionId: id, workdir, accent, title: project });
    else await invoke("spawn_claude", { sessionId: id, workdir, rows: term!.rows || 24, cols: term!.cols || 80 });
  } catch (e) {
    toast("launch failed: " + e);
    if (term) term.writeln(`\r\n\x1b[31m[launch error] ${e}\x1b[0m`);
    else pane.innerHTML = `<div class="ext-pane"><h2>Couldn't launch Ghostty</h2><p>${esc(String(e))}</p></div>`;
  }
  invoke<string | null>("git_branch", { workdir }).then((b) => {
    if (b && !s.branch) { s.branch = b; renderSidebar(); if (activeId === id) renderHeader(s); }
  });
  renderAll();
}

// Offer a worktree when launching into a repo that already has a session.
async function requestLaunch(project: string, path: string) {
  if ([...sessions.values()].some((s) => s.colorKey === path)) {
    const br = await invoke<string | null>("git_branch", { workdir: path });
    if (br) { openWt(project, path, true); return; }
  }
  launch(project, path, { colorKey: path });
}

async function addProject() {
  const dir = await open({ directory: true, multiple: false, title: "Add a project folder" });
  if (!dir || typeof dir !== "string") return;
  if (FAVORITES.some((f) => f.path === dir)) { toast("Already a project"); return; }
  FAVORITES.push({ name: basename(dir), path: dir });
  saveFavorites();
  renderAll();
  probeIcon(dir); // scour the repo for a favicon/logo to use as the project glyph
  toast(`Added ${basename(dir)}`);
}
function removeFavorite(path: string) {
  FAVORITES = FAVORITES.filter((f) => f.path !== path);
  saveFavorites();
  renderAll();
}
function closeSession(id: string) {
  const s = sessions.get(id); if (!s) return;
  invoke("kill_session", { sessionId: id }).catch(() => {});
  try { s.term?.dispose(); } catch { /* */ }
  s.pane.remove();
  const wasActive = activeId === id;
  sessions.delete(id);
  if (wasActive) {
    activeId = null;
    const next = orderedSessions()[0];
    if (next) { setActive(next.id); return; }
    document.documentElement.style.setProperty("--accent", "#a78bfa");
    ($("empty") as HTMLElement).style.display = "grid";
  }
  renderAll();
}
function resolvePermission(id: string, behavior: string) {
  invoke("resolve_permission", { id, behavior }).catch(() => {});
  for (const s of sessions.values()) if (s.pendingPermId === id) { s.pendingPermId = null; s.attention = null; }
  renderAll();
}

function setActive(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  activeId = id;
  ($("empty") as HTMLElement).style.display = "none";
  for (const x of sessions.values()) x.pane.classList.toggle("active", x.id === id);
  document.documentElement.style.setProperty("--accent", accentFor(s.colorKey));
  if (s.term && s.fit) {
    try { s.fit.fit(); } catch { /* pane not measurable yet */ }
    invoke("resize_pty", { sessionId: id, rows: s.term.rows, cols: s.term.cols });
    s.term.focus();
  }
  renderHeader(s); renderInspector(s); renderSidebar(); renderMini(); renderFoot();
}

// ---------- telemetry ----------
function toolGlyph(tool: string): string {
  if (tool === "Read") return "◈"; if (tool === "Edit" || tool === "Write") return "✎";
  if (tool === "Bash") return "▸"; if (tool && tool.startsWith("Task")) return "◻"; return "›";
}
function pushActivity(s: Sess, ic: string, t: string, cls: string) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  s.activity.unshift({ ic, t, time, cls });
  if (s.activity.length > 9) s.activity.length = 9;
}
function permCmd(data: any): string {
  const t = data.tool_name || "tool";
  const inp = data.tool_input || {};
  if (typeof inp.command === "string") return `${inp.command}   (${t})`;
  if (typeof inp.file_path === "string") return `${inp.file_path}   (${t})`;
  return `${t}`;
}

function applyHook(s: Sess, data: any) {
  const ev: string = data.hook_event_name ?? "?";
  s.lastEvent = ev;
  const bg = () => s.subagents > 0 || s.phase === "done";
  switch (ev) {
    case "SessionStart": s.phase = "idle"; s.attention = null; break;
    case "UserPromptSubmit": s.phase = "thinking"; s.attention = null; break;
    case "PreToolUse":
      if (!bg()) { s.phase = "working"; s.attention = null; }
      pushActivity(s, toolGlyph(data.tool_name), `${data.tool_name || "tool"}`, "");
      break;
    case "PostToolUse": if (!bg()) s.phase = "working"; break;
    case "PostToolUseFailure": if (!bg()) s.phase = "error"; break;
    case "Stop": s.phase = "done"; s.attention = null; s.pendingPermId = null; break;
    case "StopFailure": s.phase = "error"; break;
    case "Notification": {
      const nt: string = data.notification_type ?? "";
      if (nt.includes("permission")) s.attention = "permission needed";
      else if (nt === "idle_prompt") s.phase = "done";
      else s.attention = nt || "notification";
      break;
    }
    case "PermissionRequest": s.attention = `permission: ${data.tool_name ?? ""}`; s.pendingCmd = permCmd(data); break;
    case "SubagentStart": s.subagents++; break;
    case "SubagentStop": s.subagents = Math.max(0, s.subagents - 1); break;
    case "SessionEnd": s.phase = "ended"; break;
  }
}
function applyStatusline(s: Sess, data: any) {
  if (data.model?.display_name) s.model = data.model.display_name;
  const ctx = data.context_window?.used_percentage; if (typeof ctx === "number") s.ctxPct = ctx;
  const cost = data.cost?.total_cost_usd;
  if (typeof cost === "number") { addUsage(cost - (s.cost ?? 0)); s.cost = cost; }
  const dur = data.cost?.total_duration_ms; if (typeof dur === "number") s.durMs = dur;
  const r5 = data.rate_limits?.five_hour;
  if (r5) { if (typeof r5.used_percentage === "number") s.rl5h = r5.used_percentage; if (typeof r5.resets_at === "number") s.rl5hReset = r5.resets_at; }
  const r7 = data.rate_limits?.seven_day;
  if (r7) { if (typeof r7.used_percentage === "number") s.rl7d = r7.used_percentage; if (typeof r7.resets_at === "number") s.rl7dReset = r7.resets_at; }
  const wt = data.workspace?.git_worktree; if (wt) { s.worktree = wt; s.branch = wt; }
}

// ---------- rendering ----------
function projectList() {
  const list = FAVORITES.map((f) => ({ name: f.name, path: f.path, accent: accentFor(f.path), sessions: [] as Sess[] }));
  const byName = new Map(list.map((p) => [p.name, p]));
  for (const s of sessions.values()) {
    let p = byName.get(s.project);
    if (!p) { p = { name: s.project, path: s.colorKey, accent: accentFor(s.colorKey), sessions: [] }; list.push(p); byName.set(s.project, p); }
    p.sessions.push(s);
  }
  return list;
}
function orderedSessions(): Sess[] { return projectList().flatMap((p) => p.sessions); }

function sessionRow(s: Sess): string {
  const k = statusKey(s);
  const label = s.worktree ? `⑃ ${s.branch}` : (s.branch || "session");
  return `<div class="srow ${s.id === activeId ? "active" : ""}" data-sel="${s.id}">
    <span class="sglyph ${GCLASS[k]}">${GLYPH[k]}</span>
    <span class="sbranch">${esc(label)}</span>
    <span class="sctx">${s.ctxPct != null ? Math.round(s.ctxPct) + "%" : ""}</span>
    <span class="scost">${s.cost != null ? "$" + s.cost.toFixed(2) : ""}</span>
    <span class="sclose" data-close="${s.id}" title="Close session">✕</span></div>`;
}
function renderSidebar() {
  $("liveCount").textContent = sessions.size + (sessions.size === 1 ? " running" : " running");
  $("projects").innerHTML = projectList().map((p) => {
    const rows = p.sessions.map(sessionRow).join("");
    const head = p.sessions.length
      ? `<div class="phead" data-sel="${p.sessions[0].id}" data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span><span class="pcount">${p.sessions.length}</span><span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}">＋</span></div>`
      : `<div class="phead empty-p" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}" data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span><span class="plaunch">launch →</span><span class="premove" data-remove="${esc(p.path)}" title="Remove project">✕</span></div>`;
    return `<div class="pgroup">${head}${rows ? `<div class="psessions">${rows}</div>` : ""}</div>`;
  }).join("");
}
function renderMini() {
  const activeProj = activeId ? sessions.get(activeId)?.project : null;
  $("railmini").innerHTML =
    `<button class="rm-btn" data-rail="1" title="Expand sidebar (⌘B)">»</button>` +
    projectList().map((p) => {
      const first = p.sessions[0];
      const attn = p.sessions.some((s) => s.attention || s.phase === "error");
      const sel = first ? `data-sel="${first.id}"` : `data-launch="${esc(p.path)}" data-proj="${esc(p.name)}"`;
      const ic = iconFor(p.path);
      const glyph = ic ? `<img class="rm-icon" src="${ic}" alt="" />` : `<span class="rm-dot"></span>`;
      return `<button class="rm-proj ${p.name === activeProj ? "on" : ""}" style="--rc:${p.accent}" title="${esc(p.name)}" data-key="${esc(p.path)}" ${sel}>${glyph}${attn ? '<span class="rm-badge"></span>' : ""}</button>`;
    }).join("") +
    `<button class="rm-btn rm-add" data-pal="1" title="New session (⌘K)">＋</button>`;
}
function renderHeader(s: Sess | null) {
  ($("btnClose") as HTMLButtonElement).hidden = !s;
  if (!s) { $("hProj").textContent = "no session"; $("hBranch").hidden = true; $("hTitle").textContent = ""; $("hPath").textContent = ""; return; }
  $("hProj").textContent = s.project;
  const hb = $("hBranch");
  if (s.branch) { hb.textContent = s.worktree ? "⑃ " + s.branch : s.branch; hb.hidden = false; } else hb.hidden = true;
  $("hTitle").textContent = s.title || "";
  $("hPath").textContent = tilde(s.workdir);
}
function fmtDur(ms: number) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${String(ss).padStart(2, "0")}s`;
}
function fmtReset(ts: number | null): string {
  if (!ts) return "";
  const ms = ts * 1000 - Date.now();
  if (ms <= 0) return "resetting…";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `resets in ${h}h ${m}m` : `resets in ${h}h`;
}
function resetHtml(ts: number | null): string { const t = fmtReset(ts); return t ? ` <span class="rst">· ${t}</span>` : ""; }
const mc = (v: number) => (v >= 80 ? "hot" : v >= 55 ? "warn" : "");
function renderInspector(s: Sess | null) {
  const pill = $("iPill"); const k = s ? statusKey(s) : "idle";
  pill.className = "pill " + k;
  $("iPillTxt").textContent = s ? (s.attention ? s.attention : PILL_TEXT[s.phase]) : "–";
  if (!s) { $("inspector").innerHTML = `<div class="insp-empty">No session selected.</div>`; return; }

  const permBtns = s.pendingPermId
    ? `<div class="attn-btns"><button class="allow" data-perm="allow" data-permid="${s.pendingPermId}">Allow</button><button data-perm="deny" data-permid="${s.pendingPermId}">Deny</button><button data-perm="terminal" data-permid="${s.pendingPermId}">In terminal</button></div>`
    : "";
  const attn = s.attention ? `<div class="attn"><div class="attn-h">🔔 ${esc(s.attention)}</div>${s.pendingCmd ? `<code>${esc(s.pendingCmd)}</code>` : ""}${permBtns}</div>` : "";
  const ctx = s.ctxPct ?? 0;
  const rl5 = s.rl5h, rl7 = s.rl7d;
  const activity = s.activity.length
    ? s.activity.map((a) => `<div class="tl"><span class="tl-ic ${a.cls}">${a.ic}</span><span class="tl-t">${a.t}</span><span class="tl-time">${a.time}</span></div>`).join("")
    : `<div class="insp-empty" style="padding:14px 0">No activity yet.</div>`;

  $("inspector").innerHTML = `${attn}
    <div class="ring-wrap lit"><svg class="ring" viewBox="0 0 40 40"><circle class="trk" cx="20" cy="20" r="16"></circle><circle class="fil" cx="20" cy="20" r="16" pathLength="100" stroke-dasharray="${ctx} 100"></circle></svg><div class="ring-info"><div class="big">${s.ctxPct != null ? Math.round(s.ctxPct) + "%" : "–"}</div><div class="sub">context window</div></div></div>
    <div class="grid2">
      <div class="stat lit"><span class="label">Cost</span><span class="v">${s.cost != null ? "$" + s.cost.toFixed(4) : "–"}</span></div>
      <div class="stat lit"><span class="label">Elapsed</span><span class="v" style="font-size:13px">${s.durMs != null ? fmtDur(s.durMs) : "–"}</span></div>
      <div class="stat lit"><span class="label">Model</span><span class="v" style="font-size:12px">${esc(s.model || "–")}</span></div>
      <div class="stat lit"><span class="label">Background</span><span class="v">${s.subagents}<small> subs</small></span></div>
    </div>
    <div><div class="label" style="margin-bottom:8px">Rate limits</div><div class="meters">
      <div class="mrow"><div class="mtop"><span>5-hour${resetHtml(s.rl5hReset)}</span><b>${rl5 != null ? Math.round(rl5) + "%" : "–"}</b></div><div class="meter ${rl5 != null ? mc(rl5) : ""}"><i style="width:${rl5 ?? 0}%"></i></div></div>
      <div class="mrow"><div class="mtop"><span>7-day${resetHtml(s.rl7dReset)}</span><b>${rl7 != null ? Math.round(rl7) + "%" : "–"}</b></div><div class="meter ${rl7 != null ? mc(rl7) : ""}"><i style="width:${rl7 ?? 0}%"></i></div></div>
    </div></div>
    <div><div class="label" style="margin-bottom:5px">Recent activity</div><div class="timeline">${activity}</div></div>`;
}
function renderFoot() {
  const total = usage[todayKey()] || 0;
  const s = activeId ? sessions.get(activeId) : null;
  $("fProj").textContent = s ? s.project : "–";
  ($("fDot") as HTMLElement).style.background = s ? accentFor(s.colorKey) : "var(--muted-2)";
  $("fSessions").textContent = String(sessions.size);
  $("fCost").textContent = "$" + total.toFixed(2);
  const rls = [...sessions.values()].map((x) => x.rl5h).filter((v): v is number => v != null);
  $("fRl").textContent = rls.length ? Math.round(Math.max(...rls)) + "%" : "–";
  $("fEngine").textContent = termEngine === "ghostty" ? "Ghostty" : "embedded";
}
function renderAttn() {
  const n = [...sessions.values()].filter((s) => s.attention).length;
  const b = $("attnBadge");
  if (n > 0) { b.classList.add("show"); $("attnBadgeTxt").textContent = `${n} need${n === 1 ? "s" : ""} you`; }
  else b.classList.remove("show");
}
// ---------- macOS menu-bar (tray) mirror of the sidebar ----------
let lastTraySig = "";
function updateTray() {
  const list = orderedSessions();
  const items = list.map((s) => {
    const k = statusKey(s);
    const branch = s.worktree ? `⑃ ${s.branch}` : (s.branch || "session");
    const status = s.attention ? s.attention : PILL_TEXT[s.phase];
    return { id: s.id, label: `${GLYPH[k]}  ${s.project} · ${branch}  —  ${status}` };
  });
  const attn = list.filter((s) => s.attention || s.phase === "error").length;
  const n = list.length;
  const title = n === 0 ? "" : attn > 0 ? `◆ ${attn}` : `● ${n}`;
  const tooltip = n === 0
    ? "Muster — no active sessions"
    : `Muster — ${n} session${n === 1 ? "" : "s"}${attn ? `, ${attn} need${attn === 1 ? "s" : ""} you` : ""}`;
  const sig = title + "|" + tooltip + "|" + items.map((i) => i.label).join("§");
  if (sig === lastTraySig) return; // avoid rebuilding the native menu on every telemetry tick
  lastTraySig = sig;
  invoke("update_tray", { title, tooltip, items }).catch(() => {});
}
function renderAll() {
  renderSidebar(); renderMini(); renderFoot(); renderAttn();
  const s = activeId ? sessions.get(activeId) ?? null : null;
  renderInspector(s); renderHeader(s);
  updateTray();
}

// ---------- palette ----------
let palItems: { kind: string; label: string; sub: string; sw?: string; ic?: string; icon?: string; run: () => void }[] = [];
let palSel = 0;
function buildPalItems(q: string) {
  const items: typeof palItems = [];
  for (const s of orderedSessions()) items.push({ kind: "session", label: `${s.project} · ${s.branch || "session"}`, sub: s.title || tilde(s.workdir), sw: accentFor(s.colorKey), icon: iconFor(s.colorKey) || undefined, run: () => setActive(s.id) });
  for (const f of FAVORITES) items.push({ kind: "launch", label: `Launch ${f.name}`, sub: tilde(f.path), sw: accentFor(f.path), icon: iconFor(f.path) || undefined, run: () => requestLaunch(f.name, f.path) });
  ([
    ["Add project…", "＋", addProject],
    [`Terminal engine → ${termEngine === "ghostty" ? "Embedded" : "Ghostty (external)"}`, "⌸", toggleEngine],
    ["Toggle inspector", "◨", toggleInsp],
    ["Toggle sidebar", "◧", toggleRail],
    ["Toggle theme", "◐", toggleTheme],
  ] as [string, string, () => void][])
    .forEach(([l, ic, fn]) => items.push({ kind: "action", label: l, sub: "command", ic, run: fn }));
  const f = q.trim().toLowerCase();
  return f ? items.filter((i) => (i.label + i.sub).toLowerCase().includes(f)) : items;
}
function renderPal() {
  $("palList").innerHTML = palItems.map((i, idx) =>
    `<div class="pal-item ${idx === palSel ? "on" : ""}" data-i="${idx}"><span class="pal-ic">${i.icon ? `<img class="pal-icimg" src="${i.icon}" alt="" />` : i.sw ? `<span class="sw" style="background:${i.sw}"></span>` : (i.ic || "›")}</span><span class="pal-main"><span class="pm">${esc(i.label)}</span><span class="ps">${esc(i.sub)}</span></span><span class="pal-kind">${i.kind}</span></div>`
  ).join("") || `<div class="pal-item"><span class="pal-main"><span class="pm" style="color:var(--muted)">No matches</span></span></div>`;
  $("palList").querySelectorAll<HTMLElement>(".pal-item[data-i]").forEach((el) =>
    el.addEventListener("click", () => { const it = palItems[+el.dataset.i!]; if (it) { it.run(); closePalette(); } }));
}
function refreshPal() { palItems = buildPalItems(($("palInput") as HTMLInputElement).value); palSel = 0; renderPal(); }
function openPalette() { $("scrim").classList.add("show"); $("palette").classList.add("show"); ($("palInput") as HTMLInputElement).value = ""; refreshPal(); setTimeout(() => ($("palInput") as HTMLInputElement).focus(), 30); }
function closePalette() { $("scrim").classList.remove("show"); $("palette").classList.remove("show"); }

// ---------- panels / theme ----------
function toggleRail() { $("app").classList.toggle("rail-mini"); }
function toggleInsp() { $("app").classList.toggle("insp-off"); $("inspBtn").classList.toggle("on", !$("app").classList.contains("insp-off")); refit(); }
function toggleTheme() { const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark"); }
function refit() { if (!activeId) return; const s = sessions.get(activeId); if (!s?.term || !s.fit) return; try { s.fit.fit(); invoke("resize_pty", { sessionId: s.id, rows: s.term.rows, cols: s.term.cols }); } catch { /* */ } }
function applyFontSize() { for (const s of sessions.values()) if (s.term) s.term.options.fontSize = termFontSize; refit(); localStorage.setItem("cc-term-font", String(termFontSize)); }
function bumpFont(d: number) { termFontSize = Math.max(8, Math.min(28, termFontSize + d)); applyFontSize(); toast(`Terminal font ${termFontSize}px`); }

let toastT: number | undefined;
function toast(m: string) { const el = $("toast"); el.textContent = m; el.classList.add("show"); clearTimeout(toastT); toastT = window.setTimeout(() => el.classList.remove("show"), 1900); }

// ---------- worktree dialog ----------
let wtCtx: { project: string; repoDir: string } | null = null;
async function openWt(project: string, repoDir: string, allowMain: boolean) {
  wtCtx = { project, repoDir };
  const n = [...sessions.values()].filter((s) => s.project === project).length + 1;
  $("wtSub").textContent = allowMain ? `${project} already has a running session — open a worktree or make a new one.` : `Open an existing worktree, or create one for ${project}.`;
  ($("wtMain") as HTMLElement).hidden = !allowMain;
  const bi = $("wtBranch") as HTMLInputElement; bi.value = `agent-${n}`;
  ($("wtList") as HTMLElement).hidden = true; $("wtList").innerHTML = "";
  $("scrim").classList.add("show"); $("wtDlg").classList.add("show");
  setTimeout(() => { bi.focus(); bi.select(); }, 30);
  const wts = await invoke<{ path: string; branch: string; is_main: boolean }[]>("list_worktrees", { repoDir }).catch(() => [] as { path: string; branch: string; is_main: boolean }[]);
  if (wtCtx && wtCtx.repoDir === repoDir) renderWtList(wts);
}
function renderWtList(wts: { path: string; branch: string; is_main: boolean }[]) {
  const nonMain = wts.filter((w) => !w.is_main);
  const el = $("wtList");
  if (!nonMain.length) { el.innerHTML = ""; (el as HTMLElement).hidden = true; return; }
  (el as HTMLElement).hidden = false;
  el.innerHTML = `<div class="wt-lbl">Existing worktrees</div>` + nonMain.map((w) => {
    const isOpen = [...sessions.values()].some((s) => s.workdir === w.path);
    return `<button class="wt-item" data-wt="${esc(w.path)}" data-wtbranch="${esc(w.branch)}"><span class="wt-br">⑃ ${esc(w.branch)}</span><span class="wt-open">${isOpen ? "open" : "→"}</span></button>`;
  }).join("");
}
function openWorktreeSession(path: string, branch: string) {
  if (!wtCtx) return;
  const { project, repoDir } = wtCtx;
  closeWt();
  const existing = [...sessions.values()].find((s) => s.workdir === path);
  if (existing) { setActive(existing.id); return; }
  launch(project, path, { colorKey: repoDir, worktree: branch, branch });
}
function closeWt() { $("wtDlg").classList.remove("show"); if (!$("palette").classList.contains("show")) $("scrim").classList.remove("show"); wtCtx = null; }
async function wtCreate() {
  if (!wtCtx) return;
  const branch = ($("wtBranch") as HTMLInputElement).value.trim();
  if (!branch) { toast("Enter a branch name"); return; }
  const { project, repoDir } = wtCtx;
  closeWt();
  try {
    const path = await invoke<string>("create_worktree", { repoDir, branch });
    launch(project, path, { colorKey: repoDir, worktree: branch, branch });
    toast(`Worktree ${branch} created`);
  } catch (e) { toast("worktree: " + e); }
}

// ---------- events ----------
listen<{ sessionId: string; data: string }>("pty-output", (e) => {
  const s = sessions.get(e.payload.sessionId); if (!s?.term) return;
  s.term.write(Uint8Array.from(atob(e.payload.data), (c) => c.charCodeAt(0)));
});
listen<{ sessionId: string; code: number }>("pty-exit", (e) => {
  const s = sessions.get(e.payload.sessionId); if (!s) return;
  s.phase = "ended"; s.attention = null;
  s.term?.writeln(`\r\n\x1b[90m[claude exited: code ${e.payload.code}]\x1b[0m`);
  renderAll();
});
listen<{ kind: string; data: any }>("telemetry", (e) => {
  const { kind, data } = e.payload; if (!data) return;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined; if (!s) return;
  if (kind === "statusline") applyStatusline(s, data); else applyHook(s, data);
  renderAll();
});
// menu-bar (tray) menu → jump to the clicked session
listen<string>("tray-select", (e) => { const id = e.payload; if (sessions.has(id)) setActive(id); });
// blocking permission request — Claude is waiting for our decision
listen<{ id: string; data: any }>("permission", (e) => {
  const { id, data } = e.payload; if (!data) return;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { invoke("resolve_permission", { id, behavior: "terminal" }).catch(() => {}); return; }
  s.attention = `permission: ${data.tool_name || ""}`;
  s.pendingCmd = permCmd(data);
  s.pendingPermId = id;
  renderAll();
});

// delegated clicks (sidebar / mini / inspector buttons)
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("#colorPop, .pdot, .rm-dot")) closeColorPop();
  const dot = t.closest<HTMLElement>(".pdot, .rm-dot");
  if (dot) { const owner = dot.closest<HTMLElement>("[data-key]"); if (owner?.dataset.key) { openColorPopover(owner.dataset.key, e.clientX, e.clientY); return; } }
  const el = t.closest<HTMLElement>("[data-perm],[data-wt],[data-close],[data-remove],[data-add],[data-sel],[data-launch],[data-pal],[data-rail],[data-toast]");
  if (!el) return;
  if (el.dataset.perm) resolvePermission(el.dataset.permid || "", el.dataset.perm);
  else if (el.dataset.wt) openWorktreeSession(el.dataset.wt, el.dataset.wtbranch || "");
  else if (el.dataset.close) closeSession(el.dataset.close);
  else if (el.dataset.remove) removeFavorite(el.dataset.remove);
  else if (el.dataset.add) addProject();
  else if (el.dataset.sel) setActive(el.dataset.sel);
  else if (el.dataset.launch) requestLaunch(el.dataset.proj || basename(el.dataset.launch), el.dataset.launch);
  else if (el.dataset.pal) openPalette();
  else if (el.dataset.rail) toggleRail();
  else if (el.dataset.toast) toast(el.dataset.toast);
});

// recolor a project — click its color dot, or right-click the project
// 12 perceptually distinct hues around the wheel
const SWATCHES = ["#f2555a", "#fb923c", "#facc15", "#a3e635", "#34d399", "#2dd4bf", "#22d3ee", "#38bdf8", "#818cf8", "#a78bfa", "#d084f5", "#f472b6"];
let popKey: string | null = null;
function normalizeHex(v: string): string | null {
  let x = v.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(x)) x = x.split("").map((c) => c + c).join("");
  return /^[0-9a-fA-F]{6}$/.test(x) ? "#" + x.toLowerCase() : null;
}
function openColorPopover(key: string, x: number, y: number) {
  popKey = key;
  const cur = accentFor(key).toLowerCase();
  const pop = $("colorPop");
  pop.innerHTML =
    SWATCHES.map((c) => `<button class="sw-btn ${c === cur ? "on" : ""}" style="background:${c}" data-c="${c}"></button>`).join("") +
    `<div class="sw-row"><input class="sw-hex" type="text" spellcheck="false" placeholder="#hex" value="${cur}" maxlength="7" /><button class="sw-apply">Set</button></div>` +
    `<button class="sw-auto" data-c="auto">Auto color</button>` +
    (iconFor(key) ? `<button class="sw-auto" data-c="delicon">Use color dot (hide icon)</button>` : "");
  pop.style.left = Math.min(x, window.innerWidth - 210) + "px";
  pop.style.top = Math.min(y + 6, window.innerHeight - 182) + "px";
  pop.classList.add("show");
}
function closeColorPop() { $("colorPop").classList.remove("show"); popKey = null; }
function applyColor(key: string) {
  renderAll();
  const s = activeId ? sessions.get(activeId) : null;
  if (s && s.colorKey === key) document.documentElement.style.setProperty("--accent", accentFor(s.colorKey));
}
function setColor(key: string, hex: string | null) {
  if (hex === null) delete colorOverrides[key]; else colorOverrides[key] = hex;
  localStorage.setItem("cc-colors", JSON.stringify(colorOverrides));
  closeColorPop();
  applyColor(key);
}
function commitHex(v: string) {
  if (!popKey) return;
  const h = normalizeHex(v);
  if (!h) { toast("Enter a valid hex, e.g. #7c5cff"); return; }
  setColor(popKey, h);
}
$("colorPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sw-apply")) { const inp = $("colorPop").querySelector<HTMLInputElement>(".sw-hex"); if (inp) commitHex(inp.value); return; }
  const b = t.closest<HTMLElement>("[data-c]");
  if (!b || !popKey) return;
  if (b.dataset.c === "delicon") { clearIcon(popKey); closeColorPop(); return; }
  setColor(popKey, b.dataset.c === "auto" ? null : b.dataset.c!);
});
$("colorPop").addEventListener("keydown", (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sw-hex") && e.key === "Enter") { e.preventDefault(); commitHex((t as HTMLInputElement).value); }
});
document.addEventListener("contextmenu", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
  if (!el || !el.dataset.key) return;
  e.preventDefault();
  openColorPopover(el.dataset.key, e.clientX, e.clientY);
});

$("kbar").addEventListener("click", openPalette);
$("themeBtn").addEventListener("click", toggleTheme);
$("railCollapse").addEventListener("click", toggleRail);
$("inspBtn").addEventListener("click", toggleInsp);
$("btnNew").addEventListener("click", openPalette);
$("btnWorktree").addEventListener("click", () => { const s = activeId ? sessions.get(activeId) : null; if (!s) { toast("No active session"); return; } openWt(s.project, s.colorKey, false); });
$("btnClose").addEventListener("click", () => { if (activeId) closeSession(activeId); });
$("wtGo").addEventListener("click", wtCreate);
$("wtCancel").addEventListener("click", closeWt);
$("wtMain").addEventListener("click", () => { if (!wtCtx) return; const { project, repoDir } = wtCtx; closeWt(); launch(project, repoDir, { colorKey: repoDir }); });
$("wtBranch").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); wtCreate(); } else if (e.key === "Escape") closeWt(); });
$("scrim").addEventListener("click", () => { closePalette(); closeWt(); });
$("palInput").addEventListener("input", refreshPal);
$("palInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); renderPal(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPal(); }
  else if (e.key === "Enter") { e.preventDefault(); const it = palItems[palSel]; if (it) { it.run(); closePalette(); } }
  else if (e.key === "Escape") { closePalette(); }
});
window.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "k") { e.preventDefault(); $("palette").classList.contains("show") ? closePalette() : openPalette(); }
  else if (meta && e.key.toLowerCase() === "b") { e.preventDefault(); toggleRail(); }
  else if (meta && e.key.toLowerCase() === "i") { e.preventDefault(); toggleInsp(); }
  else if (meta && e.key >= "1" && e.key <= "9") { e.preventDefault(); const list = orderedSessions(); const s = list[+e.key - 1]; if (s) setActive(s.id); }
  else if (meta && (e.key === "=" || e.key === "+")) { e.preventDefault(); bumpFont(0.5); }
  else if (meta && e.key === "-") { e.preventDefault(); bumpFont(-0.5); }
  else if (meta && e.key === "0") { e.preventDefault(); termFontSize = 12.5; applyFontSize(); toast("Terminal font 12.5px"); }
});
new ResizeObserver(() => refit()).observe($("terminals"));

// scour each known project for a favicon/logo once, so the sidebar shows real icons
FAVORITES.forEach((f) => probeIcon(f.path));

renderAll();
