import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { parsePatch, type DiffFile, type DiffHunk } from "./diff";

function loadWebgl(term: Terminal) {
  try {
    const w = new WebglAddon();
    w.onContextLoss(() => w.dispose()); // fall back to the DOM renderer
    term.loadAddon(w);
  } catch { /* WebGL unavailable — DOM renderer is fine */ }
}
// macOS terminal key conventions for the embedded shell. xterm.js emits xterm's
// modified-arrow sequences (Option+Left = \e[1;3D etc.), which a plain login zsh
// doesn't bind by default — so word-nav keys self-insert garbage like ";3D".
// Terminal.app instead maps them to the Meta/emacs sequences zsh binds out of the
// box; we do the same here so the embedded shell navigates like a normal terminal.
// Only plain-shell PTYs get this (Claude's REPL handles its own key input).
function macShellKeys(id: string): (e: KeyboardEvent) => boolean {
  const send = (data: string, e: KeyboardEvent): boolean => { e.preventDefault(); invoke("write_pty", { sessionId: id, data }); return false; };
  return (e: KeyboardEvent) => {
    if (e.type !== "keydown") return true;
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "ArrowLeft") return send("\x1bb", e);      // backward-word
      if (e.key === "ArrowRight") return send("\x1bf", e);     // forward-word
      if (e.key === "Backspace") return send("\x1b\x7f", e);   // backward-kill-word
    }
    if (e.metaKey && !e.altKey && !e.ctrlKey) {
      if (e.key === "ArrowLeft") return send("\x01", e);       // beginning-of-line (^A)
      if (e.key === "ArrowRight") return send("\x05", e);      // end-of-line (^E)
    }
    return true;
  };
}
type Engine = "embedded" | "ghostty" | "terminal" | "iterm";
interface EngineDef { id: Engine; label: string; sub: string }
const ALL_ENGINES: EngineDef[] = [
  { id: "embedded", label: "Embedded", sub: "In-app terminal" },
  { id: "ghostty",  label: "Ghostty",  sub: "External window · tinted" },
  { id: "terminal", label: "Terminal", sub: "macOS Terminal.app" },
  { id: "iterm",    label: "iTerm",    sub: "iTerm2" },
];
function engineDef(id: Engine): EngineDef { return ALL_ENGINES.find((e) => e.id === id) || ALL_ENGINES[0]; }
// Embedded is always available; installed external terminals are filled in from
// the backend on startup (see `available_terminals`).
let availEngines: Engine[] = ["embedded"];
let termEngine: Engine = (localStorage.getItem("cc-term-engine") as Engine) || "embedded";
if (!ALL_ENGINES.some((e) => e.id === termEngine)) termEngine = "embedded";
function setEngine(id: Engine) {
  if (id === termEngine) return;
  termEngine = id;
  localStorage.setItem("cc-term-engine", termEngine);
  const d = engineDef(id);
  toast(id === "embedded" ? "New sessions open in the embedded terminal" : `New sessions open in ${d.label} (external)`);
  renderFoot();
}

// ---------- config ----------
// Home dir resolves at runtime (for `~` path abbreviation). Favorites start
// empty and are added by the user — persisted to localStorage.
let HOME = "";
homeDir().then((h) => { HOME = h.replace(/[/\\]+$/, ""); }).catch(() => {});
interface Favorite { name: string; path: string }
const DEFAULT_FAVORITES: Favorite[] = [];
// Re-derive each display name from its path on load: it's always the basename, and
// this self-heals favorites persisted before the Windows-path fix (whose stored name
// was the full backslash path). `basename` is hoisted, so it's usable here.
let FAVORITES: Favorite[] = (JSON.parse(localStorage.getItem("cc-favorites") || "null") || DEFAULT_FAVORITES)
  .map((f: Favorite) => ({ ...f, name: basename(f.path) }));
function saveFavorites() { localStorage.setItem("cc-favorites", JSON.stringify(FAVORITES)); }
// User-defined sidebar order (project path keys), set by drag-drop. Projects not
// listed here keep their natural order after the listed ones.
let projOrder: string[] = JSON.parse(localStorage.getItem("cc-proj-order") || "null") || [];
function saveProjOrder() { localStorage.setItem("cc-proj-order", JSON.stringify(projOrder)); }
// Sidebar sort: "manual" honours the drag order above; "active" floats the most
// recently-active sessions/projects to the top; "attention" floats the ones that
// need you first (permission > error > your-turn), longest-waiting within a tier.
type SortMode = "manual" | "active" | "attention";
const SORT_MODES: SortMode[] = ["manual", "active", "attention"];
const SORT_META: Record<SortMode, { glyph: string; label: string }> = {
  manual:    { glyph: "≡", label: "Manual order — drag to arrange" },
  active:    { glyph: "◷", label: "Latest activity first" },
  attention: { glyph: "◆", label: "Needs you first" },
};
let sortMode: SortMode = (localStorage.getItem("cc-sort") as SortMode) || "manual";
if (!SORT_MODES.includes(sortMode)) sortMode = "manual";
// --- sidebar worktree grouping -------------------------------------------------
// Sessions of a repo already collapse into one project group (colorKey = repo root);
// this decides how the worktrees WITHIN that group are shown. The distinguishing key
// per worktree is s.workdir (the actual checkout dir); s.worktree holds its branch.
//   off       — flat rows, branch only as a fallback label (legacy behaviour)
//   subheader — a ⑃-branch header per worktree cluster, sessions nested under it
//   toplevel  — each worktree becomes its own top-level group ("repo · branch")
//   chip      — flat rows, each worktree row carries a colour-coded ⑃ chip
// off/subheader/chip differ purely in the render layer; toplevel also splits
// projectList() so close-navigation and the mini-rail stay coherent. A project with a
// single checkout always renders flat, whatever the mode. Persisted under
// cc-worktree-group; no in-app control yet — the settings window (separate branch)
// will own the picker, until then flip it via setWtGroup() / localStorage.
type WtGroup = "off" | "subheader" | "toplevel" | "chip";
const WT_GROUPS: WtGroup[] = ["off", "subheader", "toplevel", "chip"];
let wtGroup: WtGroup = (localStorage.getItem("cc-worktree-group") as WtGroup) || "subheader";
if (!WT_GROUPS.includes(wtGroup)) wtGroup = "subheader";
function setWtGroup(m: WtGroup) {
  wtGroup = WT_GROUPS.includes(m) ? m : "subheader";
  localStorage.setItem("cc-worktree-group", wtGroup);
  renderAll();
}
// Dev affordance until the settings window ships: musterWtGroup("chip") in the console.
(window as unknown as { musterWtGroup: typeof setWtGroup }).musterWtGroup = setWtGroup;
// While a project group is being dragged, renderSidebar() must not rebuild the
// #projects DOM — doing so would destroy the node the browser is dragging,
// killing the drop. Telemetry ticks call renderAll() constantly, so this guard
// is what makes reordering actually work during live sessions.
let draggingProjects = false;
// Leads with the bundled Nerd Font (see @font-face in styles.css) so the terminal
// draws powerline / devicon glyphs on every OS; the rest stay as graceful fallbacks.
const MONO = '"JetBrainsMono Nerd Font", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

// ---------- model ----------
type Phase = "idle" | "thinking" | "working" | "done" | "error" | "ended";
type Risk = "low" | "med" | "high";
// One tool call on the activity timeline. `durMs` is filled in on PostToolUse
// (latency = the Pre→Post gap); null means still running.
interface Act { tool: string; arg: string; time: string; startMs: number; durMs: number | null }
// A single item from a TodoWrite payload (the plan Claude keeps for itself).
interface Todo { content: string; status: string }
// Uncommitted "working set" summary from the git_diffstat backend command, plus
// where the branch sits against its upstream (ahead/behind are as of the last
// fetch, not live — see upstream_state in lib.rs).
interface DiffStat {
  added: number; removed: number; files: number; untracked: number; dirty: number;
  upstream: string | null; ahead: number; behind: number;
}
// Result of a fetch/pull/push. `suggest` is set when the action was refused (or
// git failed) and there's a command worth handing to a real terminal.
interface GitActionResult { ok: boolean; summary: string; output: string; suggest: string | null }
// What a pane actually contains. All three run in an identical PTY; the kind is
// what decides whether telemetry, cost and git actions apply to it.
//   claude — an instrumented `claude` session (the only kind with telemetry)
//   shell  — a plain login shell (❯ Terminal)
//   task   — one run of a Runnable (▶ Run), whose exit code becomes done/error
// Note `external` is orthogonal: it means "the terminal lives in Ghostty/iTerm
// rather than an embedded pane", and only ever applies to a claude session.
type SessKind = "claude" | "shell" | "task";
const isAgent = (s: Sess) => s.kind === "claude";

// The resolved half of a Runnable — what the backend needs to actually start it.
interface Exec { mode: "argv"; program: string; args: string[] }
interface ExecShell { mode: "shell"; line: string }
// One value a task needs before it can run — a VS Code `${input:…}` declaration,
// or a just recipe parameter with no default.
interface InputSpec {
  id: string; kind: "promptString" | "pickString"; description: string;
  default: string | null; options: string[]; password: boolean;
}
interface Runnable {
  id: string; label: string; detail: string | null;
  source: string; sourceFile: string; group: string | null;
  exec: Exec | ExecShell; cwd: string; env: Record<string, string>;
  background: boolean; inputs: InputSpec[]; blocked: string | null;
}

interface Sess {
  id: string; project: string; accent: string; workdir: string; colorKey: string;
  branch: string; worktree: string | null; title: string;
  phase: Phase; phaseSince: number; lastActivity: number; attention: string | null; pendingCmd: string; pendingPermId: string | null; pendRisk: Risk | null; subagents: number;
  model: string; ctxPct: number | null; ctxTokens: number | null; cost: number | null; durMs: number | null;
  curTool: string; curArg: string; todos: Todo[];
  ctxHist: number[]; costHist: number[]; git: DiffStat | null; res: { cpu: number; memMb: number } | null;
  lastEvent: string; activity: Act[];
  kind: SessKind; external: boolean; term?: Terminal; fit?: FitAddon; pane: HTMLElement;
  // task panes only
  run?: { id: string; label: string; source: string; sourceFile: string; cmd: string; background: boolean; startedAt: number; exitCode: number | null; tail: string[] };
}
const sessions = new Map<string, Sess>();
let activeId: string | null = null;
let termFontSize = parseFloat(localStorage.getItem("cc-term-font") || "") || 12.5;

// The WebGL/canvas renderer bakes a glyph texture atlas on first paint. If the
// bundled Nerd Font (font-display:block) isn't ready yet, that atlas caches tofu
// boxes for the icon glyphs and never repaints them on its own. So force the font
// to load, then drop every open terminal's atlas once it's ready — the next frame
// re-rasterizes with real glyphs. Terminals opened after this point are already fine.
void (async () => {
  try {
    await Promise.all([
      document.fonts.load(`${termFontSize}px "JetBrainsMono Nerd Font"`),
      document.fonts.load(`bold ${termFontSize}px "JetBrainsMono Nerd Font"`),
    ]);
    await document.fonts.ready;
  } catch { /* Font Loading API unavailable — the browser still applies the @font-face */ }
  for (const s of sessions.values()) s.term?.clearTextureAtlas();
})();

// Account-wide rate limits. Every session's statusLine reports the same account
// numbers, but only as fresh as *that* session last refreshed them — an idle
// session lags a busy one. Kept as ONE copy shown identically across all sessions.
const rl: { h5: number | null; h5Reset: number | null; d7: number | null; d7Reset: number | null } =
  { h5: null, h5Reset: null, d7: null, d7Reset: null };
// Merge a session's rate-limit reading into the shared copy. Naive last-writer-wins
// made the % flip between sessions' stale snapshots (e.g. 13 ↔ 19 ↔ 21). Within one
// window (same resets_at, ±2min tolerance for clock skew) usage only climbs, so we
// keep the MAX; a genuinely later window supersedes and replaces (so a reset drops
// the number instead of clinging to the old peak). Stale readings from a lagging
// session (an earlier window) are ignored.
function mergeRl(curPct: number | null, curReset: number | null, pct: unknown, reset: unknown): [number | null, number | null] {
  const p = typeof pct === "number" ? pct : null;
  const r = typeof reset === "number" ? reset : null;
  if (p == null) return [curPct, curReset];
  if (r != null && curReset != null) {
    if (r > curReset + 120) return [p, r];              // a genuinely newer window
    if (r < curReset - 120) return [curPct, curReset];  // stale reading from a lagging session
  }
  const np = curPct == null ? p : Math.max(curPct, p);  // same window → the peak is freshest
  return [np, r != null ? Math.max(r, curReset ?? r) : curReset];
}
// Once a window's reset time passes, show 0% until the next statusLine refreshes
// it — otherwise a maxed-out (1xx%) meter would linger past the reset.
function rlPct(pct: number | null, reset: number | null): number | null {
  if (reset != null && reset * 1000 <= Date.now()) return 0;
  return pct;
}
function rlReset(reset: number | null): number | null {
  return (reset != null && reset * 1000 <= Date.now()) ? null : reset;
}

// Claude Code sessions started OUTSIDE Muster (a plain terminal, an IDE). We
// discover them from ~/.claude/sessions/<pid>.json (via the backend), show them
// in the sidebar as read-only, and can jump to their terminal window.
interface ExtSession {
  pid: number; session_id: string; cwd: string; name: string;
  status: string; status_updated_at?: number | null; started_at?: number | null; version: string;
  // repo_root = the main worktree of this session's repo (backend-resolved), so all
  // worktrees of one repo group under it; branch = the branch checked out in cwd.
  repo_root?: string | null; branch?: string | null;
}
let externals: ExtSession[] = [];
let activeExtId: string | null = null;      // session_id of the external session being mirrored
let activeExtPid: number | null = null;     // its pid — stable across session_id rotation, used to re-bind
let extTranscriptTimer: number | undefined;
const extWorking = (e: ExtSession) => !!e.status && !["idle", "sleeping", "done", ""].includes(e.status);

// Uncommitted git state keyed by folder (a session's workdir or an external's cwd),
// polled by refreshDirtyStates. It's the single source of truth for the sidebar's
// "has changes" dot and the external inspector's diff card: s.git only stays fresh
// for the *active* session, so nothing else can rely on it across every project.
const dirtyByFolder = new Map<string, DiffStat | null>();
const isDirty = (g?: DiffStat | null): boolean => !!g && (g.files > 0 || g.untracked > 0);
const folderDirty = (f: string): boolean => isDirty(dirtyByFolder.get(f));

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
// find_project_icon's discovery has improved (it now reaches monorepo subdirs like
// `01_frontend/public/`). When it does, forget projects we'd cached as "no icon"
// (empty string) so they re-probe. Found data-URIs are kept as-is; a user who hid
// an icon will see it re-probed once (acceptable for this spike).
const ICON_CACHE_VERSION = "2";
if (localStorage.getItem("cc-icons-v") !== ICON_CACHE_VERSION) {
  for (const k of Object.keys(icons)) if (!icons[k]) delete icons[k];
  localStorage.setItem("cc-icons-v", ICON_CACHE_VERSION);
  saveIcons();
}
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
// Split on both separators so Windows paths (E:\proj\sub) collapse to the leaf,
// not the whole string — otherwise the sidebar shows the full path as the name.
function basename(p: string) { const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/); return parts[parts.length - 1] || p; }
// Claude prepends an animated spinner to its OSC title: it cycles through braille
// dots (U+2800-U+28FF) and an eight-spoked asterisk (U+2733), e.g. a braille dot or
// a star before "Fixing the bug". Strip any leading run of those so the sidebar
// shows a steady summary; our own status stays in the row's colored .sglyph column.
// Missing the braille range is what left the title glyph flickering. (CC 2.x OSC.)
const TITLE_DECOR = /^(?:[\s•·∙⋅●○◦◆◇✦✧★☆✨✩-✷✺-✽∗＊*⏺⬤⭐⠀-⣿\uFE0F\u200D]|\u{1F31F})+/u;
// Claude Code sets the terminal title (OSC) to an auto-summary; keep it unless it's
// just the folder path/name (which we already show).
function cleanTitle(t: string, s: Sess): string {
  const x = (t || "").replace(TITLE_DECOR, "").trim();
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
  const external = termEngine !== "embedded";
  const eng = engineDef(termEngine);
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);

  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  if (external) {
    pane.innerHTML = `<div class="ext-pane"><div class="ext-logo"></div><h2>Running in ${esc(eng.label)}</h2><p>${esc(project)}${opts.worktree ? " · " + esc(opts.worktree) : ""} — the terminal is in your ${esc(eng.label)} window.<br>Muster still tracks its status, cost &amp; context here.</p></div>`;
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
    phase: "idle", phaseSince: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
    lastEvent: "", activity: [], kind: "claude", external, term, fit, pane,
  };
  sessions.set(id, s);
  term?.onTitleChange((t) => {
    const c = cleanTitle(t, s);
    if (c !== s.title) { s.title = c; renderSidebar(); if (activeId === id) renderHeader(s); }
  });
  setActive(id);
  dlog("info", `launch ${project} · ${id.slice(0, 8)} · ${termEngine}${opts.worktree ? " · worktree" : ""}`);

  try {
    if (termEngine === "ghostty") await invoke("spawn_ghostty", { sessionId: id, workdir, accent, title: project });
    else if (external) await invoke("spawn_external_terminal", { sessionId: id, workdir, engine: termEngine, title: project });
    else await invoke("spawn_claude", { sessionId: id, workdir, rows: term!.rows || 24, cols: term!.cols || 80 });
  } catch (e) {
    dlog("error", `launch failed (${project} · ${id.slice(0, 8)}): ${e}`);
    toast("launch failed: " + e);
    if (term) term.writeln(`\r\n\x1b[31m[launch error] ${e}\x1b[0m`);
    else pane.innerHTML = `<div class="ext-pane"><h2>Couldn't launch ${esc(eng.label)}</h2><p>${esc(String(e))}</p></div>`;
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
  const wasActive = activeId === id;
  // Resolve the successor while the closing session is still in the map, so its
  // sidebar position (same-project neighbour) is known.
  const next = wasActive ? nextAfterClose(s) : null;
  invoke("kill_session", { sessionId: id }).catch(() => {});
  try { s.term?.dispose(); } catch { /* */ }
  s.pane.remove();
  sessions.delete(id);
  if (wasActive) {
    activeId = null;
    if (next) { setActive(next.id); return; }
    document.documentElement.style.setProperty("--accent", "#a78bfa");
    ($("empty") as HTMLElement).style.display = "grid";
  }
  renderAll();
}
function resolvePermission(id: string, behavior: string) {
  invoke("resolve_permission", { id, behavior }).catch(() => {});
  for (const s of sessions.values()) if (s.pendingPermId === id) { s.pendingPermId = null; s.attention = null; s.pendingCmd = ""; }
  renderAll();
}

function setActive(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  closeExternalView();
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
  // Show the branch that's really checked out right now, immediately on activate.
  void refreshBranch(s).then((changed) => { if (changed) { renderSidebar(); if (activeId === id) renderHeader(s); } });
  void refreshSessionStats(s); // working-set diff + CPU/RAM for the inspector
}
// Poll the inspector's on-demand stats for the active session: the uncommitted
// working-set diff (git_diffstat) and the claude process's CPU/RAM
// (session_resources). Both are cheap and only fetched for the visible session.
async function refreshSessionStats(s: Sess) {
  if (!isAgent(s) || s.external) return;
  const [git, res] = await Promise.all([
    invoke<DiffStat | null>("git_diffstat", { workdir: s.workdir }).catch(() => null),
    invoke<{ cpu: number; mem_mb: number } | null>("session_resources", { sessionId: s.id }).catch(() => null),
  ]);
  // Only re-render when the *displayed* values change — CPU/RAM jitter every poll,
  // so comparing rounded values avoids a needless inspector rebuild (which would
  // restart the heartbeat animation) every 4s while a session sits idle.
  const sig = (g: DiffStat | null, r: { cpu: number; memMb: number } | null) =>
    (g ? `${g.added}/${g.removed}/${g.files}/${g.untracked}/${g.ahead}/${g.behind}/${g.upstream}` : "-") + "|" + (r ? `${Math.round(r.cpu)}/${Math.round(r.memMb)}` : "-");
  const before = sig(s.git, s.res);
  s.git = git ?? null;
  s.res = res ? { cpu: res.cpu, memMb: res.mem_mb } : null;
  if (sig(s.git, s.res) !== before && activeId === s.id && !activeExtId) renderInspector(s);
}

// Re-derive a session's branch label from its live git HEAD, so it reflects the
// branch actually checked out rather than the one the worktree/session was born
// with (a worktree shows whatever branch is checked out, and that can change).
// Returns true if the label changed. Detached HEAD shows "(detached @<sha>)".
async function refreshBranch(s: Sess): Promise<boolean> {
  if (!s.workdir) return false;
  const info = await invoke<{ branch: string | null; short: string } | null>("git_head", { workdir: s.workdir }).catch(() => null);
  if (!info) return false; // not a git repo (or gone) — leave the label as-is
  const label = info.branch ?? `(detached @${info.short})`;
  if (label === s.branch) return false;
  s.branch = label;
  return true;
}
async function refreshBranches() {
  const changed = await Promise.all([...sessions.values()].map(refreshBranch));
  if (changed.some(Boolean)) {
    renderSidebar();
    const a = activeId ? sessions.get(activeId) ?? null : null;
    if (a) renderHeader(a);
  }
}

// ---------- external sessions: discovery, jump, read-only transcript ----------
async function refreshExternals() {
  try {
    const list = await invoke<ExtSession[]>("list_external_sessions", { exclude: [...sessions.keys()] });
    externals = list;
    // Scour each external repo for its logo, keyed by the same repo_root the sidebar
    // groups by — otherwise ext-only projects would forever show the accent dot.
    // probeIcon dedupes by key, so this hits the backend at most once per repo.
    for (const e of externals) probeIcon(e.repo_root || e.cwd);
    if (activeExtId) {
      // Re-resolve the mirrored session. If its id rotated (/clear·/compact·/resume
      // rewrite ~/.claude/sessions/<pid>.json with a new session_id), re-bind by the
      // stable pid instead of dropping the selection — otherwise the sidebar silently
      // jumps to an unrelated session (and e.g. the ❯ Terminal button then targets it).
      const e = externals.find((x) => x.session_id === activeExtId)
        ?? (activeExtPid != null ? externals.find((x) => x.pid === activeExtPid) : undefined);
      if (e) {
        activeExtId = e.session_id; activeExtPid = e.pid;
        renderExtHeader(e); renderExtInspector(e);
      } else {
        // Truly gone — fall back to a Muster session or the empty state.
        closeExternalView();
        const next = orderedSessions()[0];
        if (next) setActive(next.id);
        else ($("empty") as HTMLElement).style.display = "grid";
      }
    }
    renderSidebar(); renderMini();
  } catch { /* backend not ready yet */ }
}
// Poll uncommitted git state for every folder in play (session workdirs + external
// cwds), so the sidebar dot and the external diff card are accurate for all projects
// at once — not just whichever session is active. git_diffstat is the same cheap
// call the inspector already makes; here it fans out across the distinct folders.
async function refreshDirtyStates() {
  const folders = new Set<string>();
  for (const s of sessions.values()) if (isAgent(s) && s.workdir) folders.add(s.workdir);
  for (const e of externals) if (e.cwd) folders.add(e.cwd);
  for (const f of [...dirtyByFolder.keys()]) if (!folders.has(f)) dirtyByFolder.delete(f); // prune gone folders
  const sig = (g?: DiffStat | null) => (g ? `${g.files}/${g.untracked}/${g.added}/${g.removed}` : "-");
  let changed = false;
  await Promise.all([...folders].map(async (f) => {
    const g = await invoke<DiffStat | null>("git_diffstat", { workdir: f }).catch(() => null);
    if (sig(dirtyByFolder.get(f)) !== sig(g)) changed = true;
    dirtyByFolder.set(f, g ?? null);
  }));
  if (!changed) return;
  renderSidebar();
  if (activeExtId) { const e = externals.find((x) => x.session_id === activeExtId); if (e) renderExtInspector(e); }
}
function openExternal(sid: string) {
  const e = externals.find((x) => x.session_id === sid);
  if (!e) return;
  activeExtId = sid;
  activeExtPid = e.pid;
  activeId = null;
  for (const x of sessions.values()) x.pane.classList.remove("active");
  ($("empty") as HTMLElement).style.display = "none";
  ($("extPane") as HTMLElement).hidden = false;
  document.documentElement.style.setProperty("--accent", accentFor(e.cwd));
  renderExtHeader(e); renderExtInspector(e); renderSidebar(); renderMini(); renderFoot();
  $("extBody").innerHTML = `<div class="ext-empty">Loading transcript…</div>`;
  void refreshDirtyStates(); // fill the working-set card promptly, not on the next poll tick
  loadTranscript(e, true);
  clearInterval(extTranscriptTimer);
  extTranscriptTimer = window.setInterval(() => {
    const cur = externals.find((x) => x.session_id === activeExtId);
    if (cur) loadTranscript(cur, false);
  }, 2500);
}
function closeExternalView() {
  if (activeExtId == null) return;
  activeExtId = null;
  activeExtPid = null;
  clearInterval(extTranscriptTimer);
  ($("extPane") as HTMLElement).hidden = true;
}
function jumpExternal(pid: number) {
  invoke("focus_external_session", { pid }).catch((e) => toast("jump failed: " + e));
}
async function loadTranscript(e: ExtSession, initial: boolean) {
  try {
    const msgs = await invoke<{ role: string; text: string }[]>("read_transcript", { cwd: e.cwd, sessionId: e.session_id, limit: 80 });
    if (activeExtId !== e.session_id) return; // switched away mid-flight
    renderTranscript(msgs, initial);
  } catch (err) {
    if (activeExtId === e.session_id) $("extBody").innerHTML = `<div class="ext-empty">Couldn't read the transcript.<br><span class="mono">${esc(String(err))}</span></div>`;
  }
}
function renderTranscript(msgs: { role: string; text: string }[], initial: boolean) {
  const body = $("extBody");
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  body.innerHTML = msgs.length
    ? msgs.map((m) => {
        const user = m.role === "user";
        return `<div class="tvmsg ${m.role}"><span class="tvgutter" title="${user ? "You" : "Claude"}">${user ? "❯" : "⏺"}</span><div class="tvtext">${esc(m.text)}</div></div>`;
      }).join("")
    : `<div class="ext-empty">No messages in this session yet.</div>`;
  if (initial || nearBottom) body.scrollTop = body.scrollHeight;
}
function renderExtHeader(e: ExtSession) {
  ($("btnClose") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = basename(e.cwd);
  const hb = $("hBranch"); hb.textContent = "external"; hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = e.name || "";
  $("hPath").textContent = tilde(e.cwd);
}
// A read-only working-set peek for an external session's folder — the same card as a
// Muster session's, minus the fetch/pull/push row (we don't drive this checkout).
// Shown only when the folder actually has uncommitted changes.
function extPeekHtml(e: ExtSession, g: DiffStat): string {
  const tot = g.added + g.removed || 1;
  const aw = Math.round((g.added / tot) * 100);
  const newBadge = g.untracked ? ` · ${g.untracked} new` : "";
  return `<div class="wset ext-wset">
    <div class="lab" style="margin-bottom:2px">Working set · in this folder</div>
    <div class="wpeek" data-diff="${esc(e.cwd)}" data-difftitle="${esc(basename(e.cwd))}" title="Open the uncommitted diff">
      <div class="wtop"><span class="add">+${g.added}</span><span class="del">−${g.removed}</span><span class="files">${g.files} file${g.files === 1 ? "" : "s"}${newBadge}</span><span class="wpeek-cue">⤢</span></div>
      <div class="stackbar"><span class="sa" style="width:${aw}%"></span><span class="sd" style="width:${100 - aw}%"></span></div>
    </div></div>`;
}
function renderExtInspector(e: ExtSession) {
  const working = extWorking(e);
  const pill = $("iPill"); pill.className = "pill " + (working ? "working" : "idle");
  $("iPillTxt").textContent = e.status || "external";
  const started = e.started_at ? new Date(e.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
  const g = dirtyByFolder.get(e.cwd);
  const peek = isDirty(g) ? extPeekHtml(e, g!) : "";
  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">↗ Running outside Muster</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(basename(e.cwd))}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="mono ell">${esc(tilde(e.cwd))}</span></div>
      <div class="ext-meta"><span class="label">Status</span><span>${esc(e.status || "idle")}</span></div>
      <div class="ext-meta"><span class="label">Started</span><span>${esc(started)}</span></div>
      <div class="ext-meta"><span class="label">Claude</span><span>${e.version ? "v" + esc(e.version) : "–"}</span></div>
      <div class="ext-meta"><span class="label">PID</span><span class="mono">${e.pid}</span></div>
      <button class="ext-jump-btn" data-jump="${e.pid}">↗ Jump to its terminal</button>
      <div class="ext-note">Muster can't drive this session — it was launched in another terminal. The panel on the left is a live read-only mirror of its transcript.</div>
    </div>${peek}`;
}

// ---------- telemetry ----------
// Set the phase and, when it actually changes, stamp phaseSince — the anchor for
// the inspector's dwell timer ("0:42 in state") and the "your turn" wait clock.
function setPhase(s: Sess, p: Phase) { if (s.phase !== p) { s.phase = p; s.phaseSince = Date.now(); } }
// The most meaningful field of a tool call, for the vital header + timeline. Paths
// collapse to a basename; commands/prompts keep a short preview.
function toolArg(tool: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? input.description;
  if (typeof v !== "string" || !v.trim()) return "";
  if ((tool === "Read" || tool === "Edit" || tool === "Write") && /[/\\]/.test(v)) return v.split(/[/\\]/).pop() || v;
  return abbr(v, 64);
}
// Open a timeline entry on PreToolUse; closeActivity fills its latency on the
// matching PostToolUse. Matching the most-recent open call of the same tool name
// is approximate under parallel subagents, but right for the common serial case.
function openActivity(s: Sess, tool: string, arg: string) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  s.activity.unshift({ tool, arg, time, startMs: Date.now(), durMs: null });
  if (s.activity.length > 12) s.activity.length = 12;
}
function closeActivity(s: Sess, tool: string) {
  const a = s.activity.find((x) => x.tool === tool && x.durMs == null);
  if (a) a.durMs = Date.now() - a.startMs;
}
// Claude keeps its own to-do list via the TodoWrite tool; the payload rides the
// PreToolUse hook we already receive. Capture it as the session's live plan.
function applyTodos(s: Sess, input: any) {
  const arr = input?.todos;
  if (!Array.isArray(arr)) return;
  s.todos = arr
    .map((t: any) => ({ content: String(t?.content ?? t?.activeForm ?? ""), status: String(t?.status ?? "pending") }))
    .filter((t) => t.content);
}
// Plan mode surfaces its plan via ExitPlanMode, not TodoWrite — the payload is
// freeform markdown (`tool_input.plan`), not structured items. Parse its list/steps
// into the same plan module so plan-mode plans show up too. Every step is "pending":
// it's a proposal, not yet in flight; a later TodoWrite takes over with live status.
function applyPlan(s: Sess, input: any) {
  const md: string = typeof input?.plan === "string" ? input.plan : "";
  if (!md.trim()) return;
  const lines = md.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let steps = lines
    .map((l) => l.match(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/)?.[1])
    .filter((x): x is string => !!x);
  if (!steps.length) steps = lines.filter((l) => !/^#{1,6}\s/.test(l)); // prose fallback
  const todos = steps
    .slice(0, 12)
    .map((c) => ({ content: c.replace(/\*\*/g, "").replace(/`/g, "").trim(), status: "pending" }))
    .filter((t) => t.content);
  if (todos.length) s.todos = todos;
}
function abbr(s: string, n = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
// The abbreviated "what is it asking?" preview shown under the attention header.
// Pulls the most meaningful field from the tool input (command, file, url, the
// question/prompt itself…), falling back to the notification message.
function permCmd(data: any): string {
  const inp = data.tool_input || {};
  const detail = inp.command ?? inp.file_path ?? inp.path ?? inp.url ?? inp.pattern ??
    inp.prompt ?? inp.question ?? inp.query ?? inp.description;
  if (typeof detail === "string" && detail.trim()) return abbr(detail);
  if (typeof data.message === "string" && data.message.trim()) return abbr(data.message);
  return "";
}
// Fully clear a session's pending-permission/attention state — used both when the
// user answers via Muster's buttons and when they answer directly in the CLI (in
// which case a later lifecycle event, not a button, is our signal to reset). If a
// blocking request is still held server-side, release it so it doesn't leak.
function clearPending(s: Sess) {
  if (s.pendingPermId) invoke("resolve_permission", { id: s.pendingPermId, behavior: "terminal" }).catch(() => {});
  s.attention = null; s.pendingPermId = null; s.pendingCmd = "";
}

function applyHook(s: Sess, data: any) {
  const ev: string = data.hook_event_name ?? "?";
  s.lastEvent = ev;
  s.lastActivity = Date.now(); // a lifecycle hook = the session did something (drives "sort by activity")
  const bg = () => s.subagents > 0 || s.phase === "done";
  switch (ev) {
    // Lifecycle events past the permission point → the ask was answered (button
    // OR directly in the CLI), so reset the pending/attention state either way.
    case "SessionStart": setPhase(s, "idle"); clearPending(s); break;
    case "UserPromptSubmit": setPhase(s, "thinking"); clearPending(s); s.curTool = ""; s.curArg = ""; break;
    case "PreToolUse": {
      const tool = data.tool_name || "tool";
      const arg = toolArg(tool, data.tool_input);
      if (tool === "TodoWrite") applyTodos(s, data.tool_input);
      else if (tool === "ExitPlanMode") applyPlan(s, data.tool_input);
      else openActivity(s, tool, arg); // the plan is its own module; keep it off the timeline
      if (!bg()) { setPhase(s, "working"); clearPending(s); s.curTool = tool; s.curArg = arg; }
      break;
    }
    case "PostToolUse": closeActivity(s, data.tool_name); if (!bg()) setPhase(s, "working"); break;
    case "PostToolUseFailure": closeActivity(s, data.tool_name); if (!bg()) setPhase(s, "error"); break;
    case "Stop": setPhase(s, "done"); clearPending(s); s.curTool = ""; s.curArg = ""; break;
    case "StopFailure": setPhase(s, "error"); clearPending(s); break;
    case "SessionEnd": setPhase(s, "ended"); clearPending(s); s.curTool = ""; s.curArg = ""; break;
    case "Notification": {
      const nt: string = data.notification_type ?? "";
      const msg: string = typeof data.message === "string" ? data.message : "";
      if (nt.includes("permission") || /permission/i.test(msg)) { s.attention = "permission needed"; if (msg) s.pendingCmd = abbr(msg); }
      else if (nt === "idle_prompt") { setPhase(s, "done"); clearPending(s); }
      else { s.attention = nt || msg || "notification"; if (msg) s.pendingCmd = abbr(msg); }
      break;
    }
    case "PermissionRequest": s.attention = `permission: ${data.tool_name ?? ""}`; s.pendingCmd = permCmd(data); s.pendRisk = riskLevel(data.tool_name, data.tool_input); break;
    case "SubagentStart": s.subagents++; break;
    case "SubagentStop": s.subagents = Math.max(0, s.subagents - 1); break;
  }
}
function pushHist(arr: number[], v: number, cap = 24) { arr.push(v); if (arr.length > cap) arr.splice(0, arr.length - cap); }
function applyStatusline(s: Sess, data: any) {
  // A statusLine only fires from a live, interactive session. If this one was
  // marked "ended" (e.g. a SessionEnd fired on /clear or /compact while the REPL
  // kept running), the continuing statusLine proves it's alive — clear the stale
  // ended state. A genuine exit stops statusLines and pty-exit re-ends it.
  if (s.phase === "ended") setPhase(s, "idle");
  if (data.model?.display_name) s.model = data.model.display_name;
  const ctx = data.context_window?.used_percentage;
  if (typeof ctx === "number") { s.ctxPct = ctx; pushHist(s.ctxHist, ctx); }
  const tok = data.context_window?.used_tokens ?? data.context_window?.tokens;
  if (typeof tok === "number") s.ctxTokens = tok;
  const cost = data.cost?.total_cost_usd;
  if (typeof cost === "number") { addUsage(cost - (s.cost ?? 0)); s.cost = cost; pushHist(s.costHist, cost); }
  const dur = data.cost?.total_duration_ms; if (typeof dur === "number") s.durMs = dur;
  const r5 = data.rate_limits?.five_hour;
  if (r5) [rl.h5, rl.h5Reset] = mergeRl(rl.h5, rl.h5Reset, r5.used_percentage, r5.resets_at);
  const r7 = data.rate_limits?.seven_day;
  if (r7) [rl.d7, rl.d7Reset] = mergeRl(rl.d7, rl.d7Reset, r7.used_percentage, r7.resets_at);
  // Keep the worktree flag if the statusline reports one, but the branch label
  // itself comes from the live git HEAD poll (refreshBranches), not this field —
  // otherwise the two fight and the label flickers.
  const wt = data.workspace?.git_worktree; if (wt) s.worktree = wt;
}

// ---------- rendering ----------
interface ProjGroup { name: string; path: string; accent: string; sessions: Sess[]; externals: ExtSession[]; wtBranch?: string }
// A worktree cluster = the sessions of one project that share a checkout dir. Order
// follows first appearance in the (already-sorted) session list, so the active/
// attention sort still decides which worktree floats up. The repo-root checkout
// (worktree === null) is the "main" cluster; its label is the live branch.
interface WtCluster { key: string; branch: string; isMain: boolean; sessions: Sess[]; externals: ExtSession[] }
function clusterByWorktree(p: ProjGroup): WtCluster[] {
  const by = new Map<string, WtCluster>();
  const order: WtCluster[] = [];
  const bucket = (key: string, branch: string): WtCluster => {
    let c = by.get(key);
    if (!c) { c = { key, branch, isMain: key === p.path, sessions: [], externals: [] }; by.set(key, c); order.push(c); }
    else if (!c.branch && branch) c.branch = branch;
    return c;
  };
  for (const s of p.sessions) bucket(s.workdir || p.path, s.branch || s.worktree || "").sessions.push(s);
  for (const e of p.externals) bucket(e.cwd || p.path, e.branch || "").externals.push(e);
  // Label clusters that never carried a branch: the repo-root checkout is "main",
  // any other bare dir falls back to its folder name.
  for (const c of order) if (!c.branch) c.branch = c.isMain ? "main" : basename(c.key);
  return order;
}
// A stable colour per branch, from the same hash as project accents so the sidebar's
// colour language stays consistent (a branch and a project just seed different hues).
const branchHue = (c: WtCluster) => accentFor(c.branch || c.key);
// toplevel mode: explode any project whose sessions span >1 worktree into one group
// per worktree. The root checkout keeps the project's identity (path/favourite/
// externals); each worktree gets its own group keyed by its checkout dir, carrying
// the branch in wtBranch. Single-checkout projects pass through untouched.
function splitByWorktree(list: ProjGroup[]): ProjGroup[] {
  const out: ProjGroup[] = [];
  for (const p of list) {
    const cl = clusterByWorktree(p);
    const wts = cl.filter((c) => !c.isMain);
    if (!wts.length) { out.push(p); continue; }
    const root = cl.find((c) => c.isMain);
    // Keep the root group only when it carries something — root-checkout rows or a
    // favourite (a launch target). Drops the phantom empty root of a worktree-only repo.
    if (root || FAVORITES.some((f) => f.path === p.path)) out.push({ ...p, sessions: root?.sessions ?? [], externals: root?.externals ?? [] });
    for (const c of wts) out.push({ name: p.name, path: c.key, accent: p.accent, sessions: c.sessions, externals: c.externals, wtBranch: c.branch });
  }
  return out;
}
function projectList(): ProjGroup[] {
  const list: ProjGroup[] = FAVORITES.map((f) => ({ name: f.name, path: f.path, accent: accentFor(f.path), sessions: [], externals: [] }));
  const byName = new Map(list.map((p) => [p.name, p]));
  const byPath = new Map(list.map((p) => [p.path, p]));
  for (const s of sessions.values()) {
    let p = byName.get(s.project) || byPath.get(s.colorKey);
    if (!p) { p = { name: s.project, path: s.colorKey, accent: accentFor(s.colorKey), sessions: [], externals: [] }; list.push(p); byName.set(s.project, p); byPath.set(s.colorKey, p); }
    p.sessions.push(s);
  }
  for (const e of externals) {
    // Group by the repo's main worktree, not the raw cwd, so every worktree of one
    // repo lands under it (and merges into that repo's favourite when paths match).
    const key = e.repo_root || e.cwd;
    let p = byPath.get(key);
    if (!p) { p = { name: basename(key), path: key, accent: accentFor(key), sessions: [], externals: [] }; list.push(p); byPath.set(key, p); byName.set(p.name, p); }
    p.externals.push(e);
  }
  // Sort sessions within each project first, then (in toplevel mode) split by
  // worktree so each split group inherits the sorted order, then order the groups.
  const sessCmp = sortMode === "active" ? (a: Sess, b: Sess) => b.lastActivity - a.lastActivity
    : sortMode === "attention" ? (a: Sess, b: Sess) => urgencyRank(a) - urgencyRank(b) || a.phaseSince - b.phaseSince
    : null;
  if (sessCmp) for (const p of list) p.sessions.sort(sessCmp);
  const groups = wtGroup === "toplevel" ? splitByWorktree(list) : list;
  if (sortMode === "active") {
    groups.sort((a, b) => projActivity(b) - projActivity(a));
  } else if (sortMode === "attention") {
    groups.sort((a, b) => projUrgency(a) - projUrgency(b) || projWaitSince(a) - projWaitSince(b));
  } else {
    // manual: the user's drag-drop order; unlisted projects keep their natural
    // order after listed ones (stable sort preserves ties).
    const rank = (path: string) => { const i = projOrder.indexOf(path); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    groups.sort((a, b) => rank(a.path) - rank(b.path));
  }
  return groups;
}
// How much a session wants the user's attention (lower = more urgent). Shared by
// the sidebar's "attention" sort and the header reactor.
function urgencyRank(s: Sess): number {
  if (s.kind === "shell") return 6;
  if (s.kind === "task") return s.phase === "error" ? 1 : 6;
  if (s.attention) return 0;         // blocking permission — Claude is waiting on you
  if (s.phase === "error") return 1;
  if (s.phase === "done") return 2;  // your turn
  if (s.phase === "working" || s.phase === "thinking") return 3;
  if (s.phase === "idle") return 4;
  return 5;                          // ended
}
function projActivity(p: ProjGroup): number { return p.sessions.reduce((m, s) => Math.max(m, s.lastActivity), 0); }
function projUrgency(p: ProjGroup): number { return p.sessions.reduce((m, s) => Math.min(m, urgencyRank(s)), 99); }
function projWaitSince(p: ProjGroup): number { return p.sessions.reduce((m, s) => Math.min(m, s.phaseSince), Number.MAX_SAFE_INTEGER); }
function orderedSessions(): Sess[] { return projectList().flatMap((p) => p.sessions); }
// When the active session is closed, decide which one takes over. Prefer staying in
// the same project — the sibling directly above (as shown in the sidebar), else the
// one below — and only leave the project (nearest session in sidebar order) once it
// has no sessions left. Must be called BEFORE the session is removed from the map.
function nextAfterClose(s: Sess): Sess | null {
  const g = projectList().find((p) => p.sessions.includes(s));
  if (g) {
    const gi = g.sessions.indexOf(s);
    const sib = g.sessions[gi - 1] || g.sessions[gi + 1];
    if (sib) return sib;
  }
  const flat = orderedSessions();
  const fi = flat.indexOf(s);
  return flat[fi + 1] || flat[fi - 1] || null;
}

// `chip` (chip mode only) tags the row with its worktree's colour-coded branch,
// which expands from a bare ⑃ to the branch name on row hover.
function sessionRow(s: Sess, chip?: WtCluster): string {
  const k = statusKey(s);
  // Prefer the abbreviated title; fall back to the branch/worktree only until
  // Claude sets a title, so idle rows stay identifiable. (Branch is kept in the
  // stage header — dropped here to save sidebar space.)
  const label = s.kind === "task" ? `▶ ${s.run?.label ?? "task"}` : s.title || (s.worktree ? `⑃ ${s.branch}` : (s.branch || "session"));
  // shells have no telemetry phase — show a terminal prompt glyph (a dot once exited).
  // tasks keep the status glyphs: an exit code *is* a done/error phase, so a red
  // build reads exactly like a broken session in the rail.
  const glyph = s.kind === "shell" ? (s.phase === "ended" ? GLYPH.ended : "❯") : GLYPH[k];
  const gcls = s.kind === "shell" ? (s.phase === "ended" ? GCLASS.ended : "g-idle") : GCLASS[k];
  const chipHtml = chip
    ? `<span class="chip" style="--wtc:${branchHue(chip)}"><span class="fork">⑃</span><span class="lbl">${esc(chip.branch)}</span></span>`
    : "";
  return `<div class="srow${chip ? " o3" : ""} ${s.id === activeId ? "active" : ""}" data-sel="${s.id}">
    <span class="sglyph ${gcls}">${glyph}</span>
    <span class="sbranch" title="${esc(label)}">${esc(label)}</span>${chipHtml}
    <span class="sctx">${s.kind === "task" ? esc(taskStateText(s)) : s.ctxPct != null ? Math.round(s.ctxPct) + "%" : ""}</span>
    <span class="sclose" data-close="${s.id}" title="Close session">✕</span></div>`;
}
// The full body of a project group (owned sessions + external rows), shaped by the
// worktree-grouping mode. subheader → ⑃ cluster headers with nested rows; chip →
// flat rows each tagged with a colour-coded branch chip; off/toplevel → plain flat
// rows. A single-checkout project (one cluster) always renders flat — nothing to
// disambiguate. Externals cluster right alongside owned sessions (same checkout dir).
function groupBody(p: ProjGroup): string {
  const flat = () => p.sessions.map((s) => sessionRow(s)).join("") + p.externals.map((e) => extRow(e)).join("");
  if (wtGroup === "subheader") {
    const cl = clusterByWorktree(p);
    if (cl.length >= 2) return cl.map((c) => {
      const col = branchHue(c), n = c.sessions.length + c.externals.length;
      const body = c.sessions.map((s) => sessionRow(s)).join("") + c.externals.map((e) => extRow(e)).join("");
      return `<div class="wthead"><span class="wtglyph" style="color:${col}">⑃</span>`
        + `<span class="wtname" style="color:${col}" title="${esc(c.branch)}">${esc(c.branch)}</span>`
        + `<span class="wtcount">${n}</span></div>`
        + `<div class="wtsessions" style="--wtc:${col}">${body}</div>`;
    }).join("");
  } else if (wtGroup === "chip") {
    const cl = clusterByWorktree(p);
    if (cl.length >= 2) {
      const byKey = new Map(cl.map((c) => [c.key, c]));
      return p.sessions.map((s) => sessionRow(s, byKey.get(s.workdir || p.path))).join("")
        + p.externals.map((e) => extRow(e, byKey.get(e.cwd || p.path))).join("");
    }
  }
  return flat();
}
function extRow(e: ExtSession, chip?: WtCluster): string {
  const working = extWorking(e);
  const chipHtml = chip
    ? `<span class="chip" style="--wtc:${branchHue(chip)}"><span class="fork">⑃</span><span class="lbl">${esc(chip.branch)}</span></span>`
    : "";
  return `<div class="srow extrow${chip ? " o3e" : ""} ${e.session_id === activeExtId ? "active" : ""}" data-ext="${e.session_id}" data-key="${esc(e.cwd)}">
    <span class="sglyph ${working ? "g-work" : "g-idle"}">${working ? "●" : "○"}</span>
    <span class="sbranch">${esc(e.name || basename(e.cwd))}</span>${chipHtml}
    <span class="ext-tag" title="Running outside Muster · Claude v${esc(e.version)} · pid ${e.pid}">ext</span>
    <span class="sjump" data-jump="${e.pid}" title="Jump to its terminal ↗">↗</span></div>`;
}
function renderSidebar() {
  // Don't stomp the DOM the browser is mid-drag on — see draggingProjects.
  if (draggingProjects) return;
  $("projects").innerHTML = projectList().map((p) => {
    const rows = groupBody(p);
    const total = p.sessions.length + p.externals.length;
    const isFav = FAVORITES.some((f) => f.path === p.path);
    // Any member folder (a session's workdir or an external's cwd) with uncommitted
    // changes lights the project's dot — so a dirty worktree marks its parent too.
    const dirty = p.sessions.some((s) => folderDirty(s.workdir)) || p.externals.some((e) => folderDirty(e.cwd));
    const dot = dirty ? `<span class="pdirty" title="Uncommitted changes in this project"></span>` : "";
    const wtSuffix = p.wtBranch ? `<span class="pwt">· ${esc(p.wtBranch)}</span>` : "";
    let head: string;
    if (p.sessions.length) {
      head = `<div class="phead" data-sel="${p.sessions[0].id}" data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}${wtSuffix}</span>${dot}<span class="pcount">${total}</span><span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}">＋</span></div>`;
    } else if (isFav) {
      const tail = p.externals.length ? `<span class="pcount ext">${p.externals.length} ext</span>` : `<span class="plaunch">launch →</span>`;
      head = `<div class="phead empty-p" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}" data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span>${dot}${tail}<span class="premove" data-remove="${esc(p.path)}" title="Remove project">✕</span></div>`;
    } else {
      // discovered via an external session only — not a saved project
      head = `<div class="phead ext-only" data-key="${esc(p.path)}" title="${esc(tilde(p.path))}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span>${dot}<span class="pcount ext">${p.externals.length} ext</span><span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}" title="Launch a Muster session here">＋</span></div>`;
    }
    return `<div class="pgroup" draggable="true" data-path="${esc(p.path)}">${head}${rows ? `<div class="psessions">${rows}</div>` : ""}</div>`;
  }).join("");
}
// Drag-drop reordering of project groups. Delegated on the persistent #projects
// container so it survives re-renders; the new order is persisted by path.
// A separator line (.dropmark) shows where the group will land; the dragged group
// is only physically moved on drop, then the DOM order is read back and saved.
// NB: this only works because the window sets dragDropEnabled:false in
// tauri.conf.json — otherwise the webview's native handler eats dragover/drop.
function initProjectDnD() {
  const container = $("projects");
  let dragEl: HTMLElement | null = null;
  const marker = document.createElement("div");
  marker.className = "dropmark";

  const cleanup = () => {
    marker.remove();
    container.classList.remove("reordering");
    dragEl?.classList.remove("dragging");
    dragEl = null;
    draggingProjects = false;
  };

  container.addEventListener("dragstart", (e) => {
    const g = (e.target as HTMLElement).closest<HTMLElement>(".pgroup");
    if (!g) return;
    dragEl = g;
    draggingProjects = true;
    container.classList.add("reordering");
    g.classList.add("dragging");
    e.dataTransfer!.effectAllowed = "move";
    try { e.dataTransfer!.setData("text/plain", g.dataset.path || ""); } catch { /* */ }
  });

  container.addEventListener("dragover", (e) => {
    if (!dragEl) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    const over = (e.target as HTMLElement).closest<HTMLElement>(".pgroup");
    if (!over || over === dragEl) return;
    const r = over.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    container.insertBefore(marker, after ? over.nextSibling : over);
  });

  // Drop: slot the dragged group in at the marker, read the new order, persist.
  container.addEventListener("drop", (e) => {
    if (!dragEl) return;
    e.preventDefault();
    if (marker.parentNode) container.insertBefore(dragEl, marker);
    cleanup();
    projOrder = [...container.querySelectorAll<HTMLElement>(".pgroup")].map((el) => el.dataset.path!).filter(Boolean);
    saveProjOrder();
    // A manual drag captures the current visual order and reasserts manual mode
    // (in a sorted mode the drag would otherwise be immediately overridden).
    if (sortMode !== "manual") setSort("manual", false);
    renderAll();
  });

  // dragend fires after drop (no-op then) and on cancel (just clean up, no reorder).
  container.addEventListener("dragend", () => { if (draggingProjects) { cleanup(); renderAll(); } });
}
function renderMini() {
  const activeProj = activeId ? sessions.get(activeId)?.project : null;
  $("railmini").innerHTML =
    `<button class="rm-btn" data-rail="1" title="Expand sidebar (⌘B)">»</button>` +
    projectList().map((p) => {
      const first = p.sessions[0];
      const firstExt = p.externals[0];
      const attn = p.sessions.some((s) => s.attention || s.phase === "error");
      const sel = first ? `data-sel="${first.id}"`
        : firstExt ? `data-ext="${firstExt.session_id}"`
        : `data-launch="${esc(p.path)}" data-proj="${esc(p.name)}"`;
      const ic = iconFor(p.path);
      const glyph = ic ? `<img class="rm-icon" src="${ic}" alt="" />` : `<span class="rm-dot"></span>`;
      const onCls = p.name === activeProj || (activeExtId && p.externals.some((e) => e.session_id === activeExtId)) ? "on" : "";
      const extOnly = !first && firstExt ? "ext" : "";
      return `<button class="rm-proj ${onCls} ${extOnly}" style="--rc:${p.accent}" title="${esc(p.name)}${extOnly ? " (external)" : ""}" data-key="${esc(p.path)}" ${sel}>${glyph}${attn ? '<span class="rm-badge"></span>' : ""}</button>`;
    }).join("") +
    `<button class="rm-btn rm-add" data-pal="1" title="New session (⌘K)">＋</button>`;
}
function renderHeader(s: Sess | null) {
  ($("btnClose") as HTMLButtonElement).hidden = !s;
  const hb = $("hBranch"); hb.classList.remove("ext-chip");
  if (!s) { $("hProj").textContent = "no session"; hb.hidden = true; $("hTitle").textContent = ""; $("hPath").textContent = ""; return; }
  $("hProj").textContent = s.project;
  if (s.kind !== "claude") { hb.textContent = s.kind === "shell" ? "shell" : "task"; hb.hidden = false; hb.classList.add("ext-chip"); }
  else if (s.branch) { hb.textContent = s.worktree ? "⑃ " + s.branch : s.branch; hb.hidden = false; } else hb.hidden = true;
  $("hTitle").textContent = s.kind === "claude" ? (s.title || "") : (s.kind === "task" ? s.run?.label ?? "" : "");
  $("hPath").textContent = tilde(s.workdir);
}
function fmtDur(ms: number) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${String(ss).padStart(2, "0")}s`;
}
// Absolute wall-clock time of a reset (epoch seconds) — "15:45" / "3:45 PM".
function fmtClock(ts: number): string { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
const mc = (v: number) => (v >= 80 ? "hot" : v >= 55 ? "warn" : "");
function renderShellInspector(s: Sess) {
  const ended = s.phase === "ended";
  const pill = $("iPill"); pill.className = "pill " + (ended ? "ended" : "idle");
  $("iPillTxt").textContent = ended ? "exited" : "shell";
  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">❯ Plain shell</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(s.project)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="ell" title="${esc(tilde(s.workdir))}">${esc(tilde(s.workdir))}</span></div>
      <div class="ext-note">A regular login shell running inside Muster — no Claude, no telemetry. Handy for commands you don't want to run inside a session.</div>
    </div>`;
}
// ---------- task settings & trust ----------
// Everything here is *personal* preference and lives in localStorage beside
// cc-favorites. Project-shaped facts (what a task runs, its cwd, its env) belong
// in .muster/tasks.toml, which is committable — the split is what keeps a shared
// repo working for a colleague who never opens Muster.

const ALL_PROVIDERS = ["muster", "vscode", "npm", "just", "make"] as const;
type Provider = (typeof ALL_PROVIDERS)[number];
const PROVIDER_LABEL: Record<Provider, string> = {
  muster: ".muster", vscode: ".vscode", npm: "package.json", just: "justfile", make: "Makefile",
};

interface TaskPrefs {
  providers: Provider[];
  introspect: boolean;        // may a trusted project be *run* to enumerate itself?
  cwd: "session" | "root";    // which directory a run inherits
  dismissMs: number;          // 0 = never auto-dismiss a green run
  attention: boolean;         // does a failed run raise the badge?
}
const DEFAULT_TASK_PREFS: TaskPrefs = {
  providers: [...ALL_PROVIDERS], introspect: true, cwd: "session", dismissMs: 20000, attention: true,
};
const taskPrefs: TaskPrefs = { ...DEFAULT_TASK_PREFS, ...JSON.parse(localStorage.getItem("cc-task-prefs") || "{}") };
function saveTaskPrefs() { localStorage.setItem("cc-task-prefs", JSON.stringify(taskPrefs)); renderAll(); }

// Folders the user has explicitly allowed Muster to introspect. Adding a folder as
// a project counts as saying yes — you chose it deliberately; a directory that
// merely happens to hold a session does not.
const trustedPaths: string[] = JSON.parse(localStorage.getItem("cc-trusted") || "[]");
function saveTrusted() { localStorage.setItem("cc-trusted", JSON.stringify(trustedPaths)); }
function isTrusted(path: string): boolean {
  return FAVORITES.some((f) => f.path === path) || trustedPaths.includes(path);
}
function trustProject(path: string) {
  if (!trustedPaths.includes(path)) { trustedPaths.push(path); saveTrusted(); }
}
function untrustProject(path: string) {
  const i = trustedPaths.indexOf(path);
  if (i >= 0) { trustedPaths.splice(i, 1); saveTrusted(); }
  renderAll();
}
// Only projects the user opted in by hand can be revoked here — a favourite is
// trusted *because* it's a favourite, and removing it is how you undo that.
function explicitlyTrusted(): string[] { return [...trustedPaths]; }

// ---------- runnables (tasks & scripts) ----------
// Discovery lives in Rust (src-tauri/src/tasks.rs) and only ever *parses* files —
// it never executes the project to find out what it can do. This half is choosing
// and observing.

// Pins are personal, not project state, so they sit in localStorage beside
// cc-favorites rather than in the repo. Keyed by project root → Runnable ids,
// which discovery guarantees are stable across a rescan.
const taskPins: Record<string, string[]> = JSON.parse(localStorage.getItem("cc-task-pins") || "{}");
function saveTaskPins() { localStorage.setItem("cc-task-pins", JSON.stringify(taskPins)); }
function pinnedIds(key: string): string[] { return taskPins[key] || []; }
function togglePin(key: string, id: string) {
  const cur = pinnedIds(key);
  taskPins[key] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  if (!taskPins[key].length) delete taskPins[key];
  saveTaskPins();
  renderAll();
}

/// The command as a human reads it — the picker's subtitle and the inspector's
/// "command" row both show exactly what will run.
function execCmd(r: Runnable): string {
  return r.exec.mode === "shell" ? r.exec.line : [r.exec.program, ...r.exec.args].join(" ");
}

// The trailing column in the sidebar, and the palette subtitle. A background run
// never claims to be finished, so it reads "bg" for as long as it lives.
function taskStateText(s: Sess): string {
  const r = s.run;
  if (!r) return "";
  if (s.phase === "working") return r.background ? "bg" : fmtShort(Date.now() - r.startedAt);
  if (r.exitCode == null) return "";
  return r.exitCode === 0 ? fmtShort(Date.now() - r.startedAt) : `exit ${r.exitCode}`;
}
// "a, b and c" — the quit guard lists up to three kinds of running thing.
function listPhrase(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
function fmtShort(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderTaskInspector(s: Sess) {
  const r = s.run!;
  const failed = r.exitCode != null && r.exitCode !== 0;
  const running = r.exitCode == null;
  const pill = $("iPill");
  pill.className = "pill " + (running ? "working" : failed ? "error" : "done");
  $("iPillTxt").textContent = running ? (r.background ? "running · background" : "running") : failed ? `exit ${r.exitCode}` : "passed";

  // Offer the failure to a live agent in the same project — the one thing a plain
  // terminal can't do. Only agents, and only when the run actually failed.
  // Embedded panes only: a session running in Ghostty/iTerm has no PTY we can type
  // into, so offering the handoff there would fail at the click.
  const targets = failed ? [...sessions.values()].filter((x) => isAgent(x) && !x.external && x.colorKey === s.colorKey && x.phase !== "ended") : [];
  const handoff = targets.length
    ? `<button class="tact hero" data-send="${targets[0].id}">↩ Send output to “${esc(targets[0].title || targets[0].branch || "session")}”</button>`
    : "";

  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">▶ ${esc(r.label)}</div>
      <div class="ext-meta"><span class="label">Command</span><span class="mono ell" title="${esc(r.cmd)}">${esc(r.cmd)}</span></div>
      <div class="ext-meta"><span class="label">Source</span><span>${esc(r.source)} · ${esc(r.sourceFile)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="ell" title="${esc(tilde(s.workdir))}">${esc(tilde(s.workdir))}</span></div>
      <div class="ext-meta"><span class="label">${running ? "Running" : "Took"}</span><span class="mono">${esc(fmtShort(Date.now() - r.startedAt))}</span></div>
      ${r.exitCode != null ? `<div class="ext-meta"><span class="label">Exit</span><span class="mono ${failed ? "bad" : "ok"}">${r.exitCode}</span></div>` : ""}
    </div>
    <div class="tacts">
      ${handoff}
      <button class="tact" data-rerun="1">⟳ Re-run</button>
      <button class="tact" data-pin="1">${pinnedIds(s.colorKey).includes(r.id) ? "★ Unpin" : "☆ Pin"}</button>
      ${running ? `<button class="tact" data-kill="1">■ Stop</button>` : ""}
    </div>`;

  const insp = $("inspector");
  insp.querySelector("[data-rerun]")?.addEventListener("click", () => rerunTask(s));
  insp.querySelector("[data-pin]")?.addEventListener("click", () => togglePin(s.colorKey, r.id));
  insp.querySelector("[data-kill]")?.addEventListener("click", () => invoke("kill_session", { sessionId: s.id }).catch(() => {}));
  insp.querySelector("[data-send]")?.addEventListener("click", (e) => {
    sendOutputToSession(s, (e.currentTarget as HTMLElement).dataset.send!);
  });
}

// Type the failure into a Claude session's stdin — deliberately *without* a
// trailing newline, so you read what's about to be sent and press Enter yourself.
// Same contract as handToTerminal: Muster prefills, the human commits.
function sendOutputToSession(task: Sess, targetId: string) {
  const t = sessions.get(targetId);
  if (!t?.term) { toast("That session is gone"); return; }
  const r = task.run!;
  const tail = r.tail.join("\n").trim();
  const msg = `\`${r.cmd}\` failed with exit ${r.exitCode}:\n\n${tail}\n\nPlease fix it.`;
  setActive(targetId);
  invoke("write_pty", { sessionId: targetId, data: msg.replace(/\n/g, "\r") })
    .then(() => toast("Pasted into the session — press Enter to send"))
    .catch((e) => toast("send failed: " + e));
}

// `discoveredIn` is the directory discovery ran in, which is how we tell a task
// that declared its own cwd from one that merely inherited the default.
interface TaskLaunchOpts { colorKey?: string; worktree?: string | null; branch?: string; discoveredIn?: string }

// Start one run of a Runnable in its own pane. Mirrors launchShell — same PTY,
// same xterm setup — because a task genuinely is just another pane.
async function launchTask(r: Runnable, project: string, opts: TaskLaunchOpts = {}): Promise<string | null> {
  if (r.blocked) { toast(`${r.label}: ${r.blocked}`); return null; }
  const id = crypto.randomUUID();
  const colorKey = opts.colorKey ?? r.cwd;
  // Which directory the run inherits (Settings › Tasks). "session" keeps the
  // folder it was discovered in — the active session's, so with several worktrees
  // open "run tests" means *this* worktree. "root" redirects to the repo root.
  // Either way a task that declared its own cwd (tasks.toml `cwd`, VS Code
  // `options.cwd`) keeps it: an explicit directory is never second-guessed.
  const declaredOwnCwd = !!opts.discoveredIn && r.cwd !== opts.discoveredIn;
  const cwd = taskPrefs.cwd === "root" && !declaredOwnCwd ? colorKey : r.cwd;
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: false, scrollback: 8000,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  loadWebgl(term);
  term.open(pane);
  // Tasks are interactive: a prompt, a y/N, a dev server's "r" to reload all work.
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));

  const cmd = execCmd(r);
  const s: Sess = {
    id, project, accent: accentFor(colorKey), workdir: cwd, colorKey,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: r.label,
    phase: "working", phaseSince: Date.now(), lastActivity: Date.now(), attention: null,
    pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
    lastEvent: "", activity: [],
    kind: "task", external: false, term, fit, pane,
    run: { id: r.id, label: r.label, source: r.source, sourceFile: r.sourceFile, cmd, background: r.background, startedAt: Date.now(), exitCode: null, tail: [] },
  };
  sessions.set(id, s);
  setActive(id);
  dlog("info", `task ${r.id} · ${project} · ${cmd}`);
  term.writeln(`\x1b[90m$ ${cmd}\x1b[0m\r\n`);
  try {
    await invoke("spawn_task", {
      sessionId: id,
      spec: { exec: r.exec, cwd, env: r.env },
      rows: term.rows || 24, cols: term.cols || 80,
    });
  } catch (e) {
    dlog("error", `task ${r.id} failed to start: ${e}`);
    toast("task failed: " + e);
    term.writeln(`\r\n\x1b[31m[task error] ${e}\x1b[0m`);
    s.phase = "error";
    s.run!.exitCode = -1;
  }
  renderAll();
  return id;
}

// Re-running reuses nothing — it opens a fresh pane and closes the old one, so the
// sidebar doesn't accumulate a row per attempt while the scrollback stays honest
// about which attempt you're reading.
async function rerunTask(s: Sess) {
  const r = s.run; if (!r) return;
  const spec = lastRunnableById.get(r.id);
  if (!spec) { toast("Task definition is gone — rescan"); return; }
  if (spec.inputs.length) { openInputPrompt(spec, s.project, { colorKey: s.colorKey, worktree: s.worktree, branch: s.branch, discoveredIn: spec.cwd }); return; }
  const project = s.project, colorKey = s.colorKey, worktree = s.worktree, branch = s.branch;
  closeSession(s.id);
  await launchTask(spec, project, { colorKey, worktree, branch });
}

// The most recent discovery result, so a re-run doesn't need the picker open.
const lastRunnableById = new Map<string, Runnable>();

// `trusted` is what lets the backend shell out to `just --dump` — which evaluates
// the justfile. It takes all three of: the global toggle, the provider being on,
// and this specific folder being one the user chose.
async function discoverTasks(workdir: string, colorKey = workdir): Promise<Runnable[]> {
  const trusted = taskPrefs.introspect && taskPrefs.providers.includes("just") && (isTrusted(workdir) || isTrusted(colorKey));
  try {
    const list = (await invoke<Runnable[]>("discover_runnables", { workdir, trusted }))
      .filter((r) => taskPrefs.providers.includes(r.source as Provider));
    for (const r of list) lastRunnableById.set(r.id, r);
    return list;
  } catch (e) {
    dlog("warn", `discover failed (${workdir}): ${e}`);
    return [];
  }
}

// ---------- the inputs prompt ----------
// A task declaring ${input:…} collects its values before anything runs. Discovery
// deliberately leaves the placeholders intact, because only this side knows the
// answers — so this is where they get filled in.
let inputCtx: { r: Runnable; project: string; opts: TaskLaunchOpts } | null = null;

function openInputPrompt(r: Runnable, project: string, opts: TaskLaunchOpts) {
  inputCtx = { r, project, opts };
  $("inSub").textContent = `${r.label} · ${r.inputs.length} input${r.inputs.length === 1 ? "" : "s"}`;
  $("inBody").innerHTML = r.inputs.map((i, n) => {
    const field = i.kind === "pickString"
      ? `<select class="in-ctl" data-n="${n}">${i.options.map((o) => `<option value="${esc(o)}"${o === i.default ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`
      : `<input class="in-ctl" data-n="${n}" type="${i.password ? "password" : "text"}" value="${esc(i.default ?? "")}" placeholder="${esc(i.default ?? "")}" spellcheck="false" autocomplete="off" />`;
    return `<div class="in-field">
      <label class="in-lbl">${esc(i.description)}<span class="in-id">${esc(i.id)}</span></label>
      ${field}
    </div>`;
  }).join("");
  $("inDlg").classList.add("show");
  $("scrim").classList.add("show");
  setTimeout(() => ($("inBody").querySelector(".in-ctl") as HTMLElement | null)?.focus(), 30);
}
function closeInputPrompt() {
  $("inDlg").classList.remove("show");
  if (!$("palette").classList.contains("show") && !$("runPop").classList.contains("show")) $("scrim").classList.remove("show");
  inputCtx = null;
}
function submitInputPrompt() {
  if (!inputCtx) return;
  const { r, project, opts } = inputCtx;
  const vals: Record<string, string> = {};
  $("inBody").querySelectorAll<HTMLInputElement | HTMLSelectElement>(".in-ctl").forEach((el) => {
    vals[r.inputs[+el.dataset.n!].id] = el.value;
  });
  closeInputPrompt();
  void launchTask(applyInputs(r, vals), project, opts);
}

/// Substitute collected values into every string that reaches the command line.
function applyInputs(r: Runnable, vals: Record<string, string>): Runnable {
  const fill = (s: string) => s.replace(/\$\{input:([^}]+)\}/g, (m, id) => (id in vals ? vals[id] : m));
  const exec = r.exec.mode === "shell"
    ? { mode: "shell" as const, line: fill(r.exec.line) }
    : { mode: "argv" as const, program: fill(r.exec.program), args: r.exec.args.map(fill) };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.env)) env[k] = fill(v);
  return { ...r, exec, cwd: fill(r.cwd), env, inputs: [] };
}

// ---- inspector: shared helpers for the redesigned modules ----
const TOOL_VERB: Record<string, string> = { Read: "Reading", Edit: "Editing", Write: "Writing", Bash: "Running", Grep: "Searching", Glob: "Searching", WebFetch: "Browsing", WebSearch: "Searching", TodoWrite: "Planning" };
function toolVerb(tool: string): string {
  if (!tool) return "Working";
  if (tool.startsWith("Task")) return "Delegating";
  if (tool.startsWith("mcp__")) return "Calling tool";
  return TOOL_VERB[tool] || "Working";
}
// Maps a tool to the CSS colour class that tints its dot / name / verb.
function toolClass(tool: string): string {
  if (!tool) return "";
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return "t-read";
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") return "t-edit";
  if (tool === "Bash") return "t-bash";
  if (tool.startsWith("Task")) return "t-task";
  if (tool === "WebFetch" || tool === "WebSearch") return "t-web";
  return "t-mcp";
}
// Heuristic risk for a pending permission — informs the badge, not the decision.
function riskLevel(tool: string, input: any): Risk {
  const cmd = typeof input?.command === "string" ? input.command : "";
  if (tool === "Bash") {
    if (/(^|\s)(sudo|rm\s+-[rf]|rmdir|mkfs|dd|shutdown|reboot|kill(all)?)\b|git\s+clean|--force\b|--hard\b|-fdx\b|>\s*\/dev\/|:\(\)\s*\{|chmod\s+-R|curl[^|]*\|\s*(sh|bash)|npm\s+publish|git\s+push/i.test(cmd)) return "high";
    return "med";
  }
  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") return "med";
  if (tool === "Read" || tool === "Grep" || tool === "Glob" || tool === "WebFetch" || tool === "WebSearch") return "low";
  return "med";
}
const RISK_LABEL: Record<Risk, string> = { low: "low risk", med: "review", high: "high risk" };
// Compact seconds → "M:SS" (under an hour) / "Hh Mm" — the dwell + wait clocks.
function fmtDwell(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}:${String(ss).padStart(2, "0")}`;
}
function fmtLatency(ms: number): string { return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms"; }
function verbFor(s: Sess): string {
  if (s.phase === "thinking") return "Thinking";
  if (s.phase === "working") return toolVerb(s.curTool);
  if (s.phase === "done") return "Your turn";
  if (s.phase === "error") return "Error";
  if (s.phase === "ended") return "Ended";
  return "Idle";
}
// Live text under the state name — recomputed each second by tickTimers().
function dwellText(s: Sess): string {
  if (s.phase === "ended") return "session ended";
  const d = fmtDwell(Date.now() - s.phaseSince);
  if (s.phase === "done") return `waiting ${d}`;
  if (s.phase === "idle") return `idle ${d}`;
  if (s.phase === "error") return `${d} ago`;
  return `${d} in state`;
}
// True when this is the "your turn" session that's been blocked longest — the one
// to jump to first. Only meaningful when several are waiting.
function isLongestWaiting(s: Sess): boolean {
  const waiting = [...sessions.values()].filter((x) => x.phase === "done" && isAgent(x) && !x.attention);
  return waiting.length > 1 && waiting.every((x) => x.id === s.id || x.phaseSince >= s.phaseSince);
}
// A mini area+line sparkline as an inline SVG. Fixed intrinsic size so the endpoint
// dot stays round; scales down within its card. `lo`/`hi` pin the domain (context
// uses 0–100; cost uses 0–max) so the curve reflects absolute fill, not just shape.
function sparkline(vals: number[], opts: { lo?: number; hi?: number } = {}): string {
  const w = 108, h = 24, pad = 3;
  if (vals.length < 2) return "";
  const lo = opts.lo ?? Math.min(...vals);
  let hi = opts.hi ?? Math.max(...vals);
  if (hi <= lo) hi = lo + 1;
  const n = vals.length;
  const px = (i: number) => (i / (n - 1)) * (w - pad);
  const py = (v: number) => h - pad - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (h - pad * 2);
  const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  const line = "M" + pts.join(" L");
  const area = `${line} L${px(n - 1).toFixed(1)},${h} L0,${h} Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><path class="spk-a" d="${area}"></path><path class="spk-l" d="${line}"></path><circle class="spk-d" cx="${px(n - 1).toFixed(1)}" cy="${py(vals[n - 1]).toFixed(1)}" r="2.1"></circle></svg>`;
}
function compactWarn(pct: number | null): { txt: string; cls: string } | null {
  if (pct == null) return null;
  if (pct >= 90) return { txt: "auto-compact imminent", cls: "hot" };
  if (pct >= 78) return { txt: "approaching auto-compact", cls: "warn" };
  return null;
}

// ---- inspector: per-module HTML builders (act → track → reference) ----
function vitalHtml(s: Sess): string {
  const sk = statusKey(s);
  const live = (s.phase === "working" || s.phase === "thinking") && !s.attention;
  const verb = s.attention ? "Needs you" : verbFor(s);
  const tcls = (!s.attention && s.phase === "working") ? toolClass(s.curTool) : "";
  const doing = (!s.attention && s.phase === "working" && s.curTool)
    ? `<div class="doing"><span class="tk ${toolClass(s.curTool)}">${esc(s.curTool)}</span>${s.curArg ? `<code>${esc(s.curArg)}</code>` : ""}</div>` : "";
  const chips = [s.model ? esc(s.model) : "", s.subagents ? `${s.subagents} subagent${s.subagents > 1 ? "s" : ""}` : ""]
    .filter(Boolean).map((c) => `<span class="chip-s">${c}</span>`).join("");
  const longest = s.phase === "done" && isLongestWaiting(s) ? `<span class="chip-s hot">longest waiting</span>` : "";
  const meta = chips || longest ? `<div class="vmeta">${chips}${longest}</div>` : "";
  return `<div class="vital st-${sk}">
    <div class="vtop"><span class="heart ${live ? "" : "still"}"></span><span class="vstate ${tcls}">${verb}</span><span class="dwell" id="iDwell">${esc(dwellText(s))}</span></div>
    ${doing}${meta}</div>`;
}
function gaugesHtml(s: Sess): string {
  const ctx = s.ctxPct;
  const warn = compactWarn(ctx);
  const ctxSpark = sparkline(s.ctxHist, { lo: 0, hi: 100 });
  const costSpark = sparkline(s.costHist, { lo: 0 });
  const tokTxt = s.ctxTokens != null ? `${Math.round(s.ctxTokens / 1000)}k tokens` : "context";
  const ctxFoot = warn ? `<div class="warn-line ${warn.cls}">${warn.txt}</div>` : (ctxSpark ? `<div class="gspark">${ctxSpark}</div>` : "");
  const costFoot = costSpark ? `<div class="gspark">${costSpark}</div>` : "";
  return `<div class="gauges">
    <div class="gauge">
      <div class="grow"><svg class="mini-ring" viewBox="0 0 40 40"><circle class="trk" cx="20" cy="20" r="15"></circle><circle class="fil" cx="20" cy="20" r="15" pathLength="100" stroke-dasharray="${Math.max(0, Math.min(100, ctx ?? 0))} 100"></circle></svg><div><div class="gnum">${ctx != null ? Math.round(ctx) + "%" : "–"}</div><div class="glab">${tokTxt}</div></div></div>
      ${ctxFoot}
    </div>
    <div class="gauge">
      <div class="grow"><div><div class="gnum">${s.cost != null ? "$" + s.cost.toFixed(2) : "–"}</div><div class="glab">${s.durMs != null ? fmtDur(s.durMs) : "cost"}</div></div></div>
      ${costFoot}
    </div>
  </div>`;
}
function planHtml(s: Sess): string {
  const done = s.todos.filter((t) => t.status === "completed").length, total = s.todos.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const rows = s.todos.slice(0, 5).map((t) => {
    const cls = t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : "";
    return `<div class="todo ${cls}"><span class="bx"></span><span class="tx">${esc(t.content)}</span></div>`;
  }).join("");
  const more = total > 5 ? `<div class="todo-more">+${total - 5} more</div>` : "";
  return `<div class="plan"><div class="ph"><span class="lab">Plan</span><span class="frac">${done} / ${total}</span></div><div class="pbar"><i style="width:${pct}%"></i></div>${rows}${more}</div>`;
}
function wsetHtml(s: Sess): string {
  const g = s.git!;
  const tot = g.added + g.removed || 1;
  const aw = Math.round((g.added / tot) * 100);
  const newBadge = g.untracked ? `<span class="unc">${g.untracked} new</span>` : "";
  const dirty = g.files || g.untracked;
  // The diff half is only worth drawing when something is actually uncommitted —
  // a clean tree that's 5 behind still needs the branch/sync row below.
  const diff = dirty
    ? `<div class="wpeek" data-diff="${esc(s.workdir)}" data-difftitle="${esc(s.project + (s.branch ? " · " + s.branch : ""))}" title="Open the uncommitted diff">
      <div class="wtop"><span class="add">+${g.added}</span><span class="del">−${g.removed}</span><span class="files">${g.files} file${g.files === 1 ? "" : "s"}</span><span class="wpeek-cue">⤢</span></div>
      <div class="stackbar"><span class="sa" style="width:${aw}%"></span><span class="sd" style="width:${100 - aw}%"></span></div></div>`
    : "";
  const sync = g.upstream
    ? `<span class="sync${g.ahead || g.behind ? "" : " even"}" title="${esc(g.upstream)} — as of the last fetch">${
        g.ahead || g.behind ? `${g.ahead ? `<span class="ah">↑${g.ahead}</span>` : ""}${g.behind ? `<span class="bh">↓${g.behind}</span>` : ""}` : "in sync"
      }</span>`
    : `<span class="sync none" title="This branch tracks no upstream">no upstream</span>`;
  return `<div class="wset">${diff}
    <div class="branch"><span>${s.worktree ? "⑃ " : ""}<span class="b">${esc(s.branch || "—")}</span>${sync}</span>${newBadge}</div>
    ${gitBtnsHtml(s, g)}</div>`;
}
// Fetch / pull / push for the session's workdir.
//
// A button is only greyed out when there is genuinely *nothing to do* — never for
// the awkward states. A diverged branch, or one with no upstream, keeps its button
// live precisely because that's where the backend refuses with a suggestion and we
// hand the user a prefilled terminal; disabling those would amputate the useful
// half. "Nothing to do" needs a known upstream, since without one ahead/behind are
// both 0 and would otherwise read as "nothing to push".
function gitBtnsHtml(s: Sess, g: DiffStat): string {
  const busy = gitBusy === s.id;
  const up = !!g.upstream;
  const btn = (op: string, label: string, off: string, hint: string) =>
    `<button class="gitb" data-git="${op}" data-gitsid="${s.id}"${busy || off ? " disabled" : ""} title="${esc(off || hint)}">${label}</button>`;
  const pullHint = !up ? "No upstream — opens a terminal to set one"
    : g.ahead && g.behind ? `Diverged — opens a terminal to rebase`
    : `git pull --ff-only (${g.behind} behind)`;
  const pushHint = !up ? "No upstream — opens a terminal to publish the branch"
    : g.behind ? "Behind — opens a terminal to pull first"
    : `git push (${g.ahead} ahead)`;
  return `<div class="gitrow${busy ? " busy" : ""}">
    ${btn("fetch", "fetch", "", "git fetch --prune")}
    ${btn("pull", "pull", up && !g.behind ? "Nothing to pull" : "", pullHint)}
    ${btn("push", "push", up && !g.ahead ? "Nothing to push" : "", pushHint)}
  </div>`;
}

// ---------- working-set diff viewer ----------
// Clicking the +N −M card opens a read-only peek at the uncommitted diff. The
// backend (git_diff) hands us one combined unified-diff patch; parsePatch turns it
// into files/hunks (in ./diff, unit-tested there). Rendering stays here, in the DOM.
const DSTAT: Record<DiffFile["status"], [string, string]> = {
  modified: ["M", "s-mod"], added: ["A", "s-add"], deleted: ["D", "s-del"], renamed: ["R", "s-ren"],
};
let diffOpen = false;
// Keyed by folder (workdir/cwd), not session id, so the same viewer serves Muster's
// own sessions and read-only external ones alike — both are just a git working tree.
async function openDiff(workdir: string, title: string) {
  if (!workdir) return;
  diffOpen = true;
  $("scrim").classList.add("show");
  $("diffDlg").classList.add("show");
  $("diffTitle").textContent = title || basename(workdir);
  $("diffSub").textContent = "reading working tree…";
  $("diffBody").innerHTML = `<div class="diff-empty">Reading the working tree…</div>`;
  try {
    const res = await invoke<{ patch: string; truncated: boolean } | null>("git_diff", { workdir });
    if (!diffOpen) return; // closed while the diff was loading
    renderDiffBody(res ? parsePatch(res.patch) : [], !!res?.truncated);
  } catch (e) {
    if (!diffOpen) return;
    $("diffSub").textContent = "";
    $("diffBody").innerHTML = `<div class="diff-empty">Couldn't read the diff.<br><span class="mono">${esc(String(e))}</span></div>`;
  }
}
function closeDiff() {
  diffOpen = false;
  $("diffDlg").classList.remove("show");
  if (!$("palette").classList.contains("show") && !$("wtDlg").classList.contains("show")) $("scrim").classList.remove("show");
}
function renderDiffBody(files: DiffFile[], truncated: boolean) {
  const tot = files.reduce((a, f) => ({ add: a.add + f.added, rem: a.rem + f.removed }), { add: 0, rem: 0 });
  $("diffSub").innerHTML = files.length
    ? `<span class="add">+${tot.add}</span> <span class="del">−${tot.rem}</span> · ${files.length} file${files.length === 1 ? "" : "s"}`
    : "";
  if (!files.length) { $("diffBody").innerHTML = `<div class="diff-empty">No uncommitted changes to show.</div>`; return; }
  const sections = files.map((f, i) => {
    const [glyph, cls] = DSTAT[f.status];
    const name = f.status === "renamed" && f.oldPath
      ? `<span class="d-old">${esc(f.oldPath)}</span><span class="d-arr">→</span>${esc(f.path)}`
      : esc(f.path);
    const counts = f.binary ? `<span class="d-bin">binary</span>`
      : `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`;
    const body = f.binary
      ? `<div class="d-binbody">Binary file — no textual diff.</div>`
      : f.hunks.map(hunkHtml).join("") || `<div class="d-binbody">No line changes (mode or metadata only).</div>`;
    return `<div class="dfile" data-fi="${i}">
      <div class="dfhead" data-dtoggle="${i}"><span class="dchev">▾</span><span class="dstat ${cls}">${glyph}</span><span class="dpath">${name}</span><span class="dcount">${counts}</span></div>
      <div class="dfbody">${body}</div></div>`;
  }).join("");
  const note = truncated ? `<div class="diff-trunc">Diff truncated — too large to show in full. Open a terminal for the complete diff.</div>` : "";
  $("diffBody").innerHTML = sections + note;
}
function hunkHtml(h: DiffHunk): string {
  const rows = h.lines.map((l) => {
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : "";
    return `<div class="dline ${l.kind}"><span class="ln">${l.oldNo ?? ""}</span><span class="ln">${l.newNo ?? ""}</span><span class="dsign">${sign}</span><span class="lc">${esc(l.text)}</span></div>`;
  }).join("");
  const ctx = h.header ? `<span class="dhh-ctx">${esc(h.header)}</span>` : "";
  return `<div class="dhunk"><div class="dhh">⋯${ctx}</div>${rows}</div>`;
}

function timelineHtml(s: Sess): string {
  const acts = s.activity.slice(0, 8);
  if (!acts.length) return `<div><div class="lab" style="margin-bottom:6px">Activity</div><div class="insp-empty" style="padding:12px 0">No activity yet.</div></div>`;
  const maxDur = Math.max(1, ...acts.map((a) => a.durMs ?? 0));
  const rows = acts.map((a) => {
    const cls = toolClass(a.tool);
    const running = a.durMs == null;
    const w = running ? 100 : Math.max(6, Math.round(((a.durMs ?? 0) / maxDur) * 100));
    const ms = running ? "···" : fmtLatency(a.durMs!);
    return `<div class="row"><span class="dot ${cls}"></span><span class="nm ${cls}">${esc(a.tool)}</span><span class="arg">${esc(a.arg)}</span><span class="lat"><span class="latbar ${running ? "run" : ""}" style="width:${w}%"></span><span class="ms">${ms}</span></span></div>`;
  }).join("");
  return `<div><div class="lab" style="margin-bottom:6px">Activity · by tool</div><div class="tl2">${rows}</div></div>`;
}
function resHtml(s: Sess): string {
  const r = s.res!;
  const cpu = Math.min(100, r.cpu), memPct = Math.min(100, (r.memMb / 2048) * 100);
  return `<div class="res">
    <div class="rr"><span class="rk">cpu</span><span class="rbar ${mc(cpu)}"><i style="width:${cpu}%"></i></span><span class="rv">${r.cpu.toFixed(0)}%</span></div>
    <div class="rr"><span class="rk">mem</span><span class="rbar ${mc(memPct)}"><i style="width:${memPct}%"></i></span><span class="rv">${r.memMb.toFixed(0)} MB</span></div></div>`;
}
function renderInspector(s: Sess | null) {
  if (s?.kind === "shell") { renderShellInspector(s); return; }
  if (s?.kind === "task") { renderTaskInspector(s); return; }
  const pill = $("iPill"); const k = s ? statusKey(s) : "idle";
  pill.className = "pill " + k;
  $("iPillTxt").textContent = s ? (s.attention ? s.attention : PILL_TEXT[s.phase]) : "–";
  if (!s) { $("inspector").innerHTML = `<div class="insp-empty">No session selected.</div>`; return; }

  const html: string[] = [];
  // ACT — a pending permission is the only thing that should ever jump the queue.
  if (s.attention) {
    const risk = s.pendingPermId && s.pendRisk ? `<span class="risk ${s.pendRisk}">${RISK_LABEL[s.pendRisk]}</span>` : "";
    const permBtns = s.pendingPermId
      ? `<div class="attn-btns"><button class="allow" data-perm="allow" data-permid="${s.pendingPermId}">Allow</button><button data-perm="deny" data-permid="${s.pendingPermId}">Deny</button><button data-perm="terminal" data-permid="${s.pendingPermId}">In terminal</button></div>`
      : "";
    html.push(`<div class="attn"><div class="attn-h">🔔 ${esc(s.attention)}${risk}</div>${s.pendingCmd ? `<code>${esc(s.pendingCmd)}</code>` : ""}${permBtns}</div>`);
  }
  html.push(vitalHtml(s));                                        // state, dwell, current tool
  html.push(gaugesHtml(s));                                       // TRACK — context + cost
  if (s.todos.length) html.push(planHtml(s));                     // the plan it's keeping
  // What's changed on disk, and how the branch sits against its upstream. Shown
  // for any repo session — a clean tree that's behind is exactly what you want to
  // see, and it's the only place the fetch/pull/push buttons live.
  if (s.git) html.push(wsetHtml(s));
  html.push(timelineHtml(s));                                     // activity, by tool
  if (s.res) html.push(resHtml(s));                              // REFERENCE — cpu/mem, pinned to the bottom
  $("inspector").innerHTML = html.join("");
}
function renderFoot() {
  const total = usage[todayKey()] || 0;
  $("fSessions").textContent = String(sessions.size);
  $("fCost").textContent = "$" + total.toFixed(2);
  const r = rlPct(rl.h5, rl.h5Reset);
  $("fRl").textContent = r != null ? Math.round(r) + "%" : "–";
  const r7 = rlPct(rl.d7, rl.d7Reset);
  $("fRl7").textContent = r7 != null ? Math.round(r7) + "%" : "–";
  const reset = rlReset(rl.h5Reset);
  $("fRlReset").textContent = reset != null ? ` · resets ${fmtClock(reset)}` : "";
  $("fEngine").textContent = engineDef(termEngine).label;
}
// The fleet's "needs you" set — sessions with a blocking permission, an error, or
// finished and awaiting your reply — most urgent first (waiting wins), longest in
// that state first. Independent of the sidebar sort so the reactor is stable.
// A failed run counts: the whole point of running tasks in Muster is that a red
// build reaches you the same way a blocked session does. A *successful* run does
// not — it settles quietly and auto-dismisses.
function needsYou(s: Sess): boolean {
  if (s.kind === "shell") return false;
  if (s.kind === "task") return taskPrefs.attention && s.phase === "error";
  return !!s.attention || s.phase === "done" || s.phase === "error";
}
function needsYouSessions(): Sess[] {
  return [...sessions.values()].filter(needsYou).sort((a, b) => urgencyRank(a) - urgencyRank(b) || a.phaseSince - b.phaseSince);
}
function reactorState(s: Sess): "attention" | "error" | "done" { return s.attention ? "attention" : s.phase === "error" ? "error" : "done"; }
function reactorLabel(dom: "attention" | "error" | "done", n: number): string {
  if (dom === "attention") return `${n} need${n === 1 ? "s" : ""} you`;
  if (dom === "error") return `${n} error${n === 1 ? "" : "s"}`;
  return `${n} your turn`;
}
// Header "reactor": one rollup of the fleet's most-urgent state. Clicking it jumps
// straight to the longest-waiting session in that state (a picker if several).
function renderAttn() {
  const list = needsYouSessions();
  const b = $("attnBadge");
  if (!list.length) { b.className = "attn-badge"; closeAttnPop(); return; }
  const dom = reactorState(list[0]);
  const n = list.filter((s) => reactorState(s) === dom).length;
  b.className = `attn-badge show react-${dom}${list.length > 1 ? " multi" : ""}`;
  $("attnBadgeTxt").textContent = reactorLabel(dom, n);
  if ($("attnPop").classList.contains("show")) { if (list.length > 1) openAttnPop(list); else closeAttnPop(); }
}
// Click the reactor → jump to the session; if several need you, a dropdown lists
// project + title + reason so you can pick which to jump to.
function badgeLabel(s: Sess) { return s.title || (s.worktree ? `⑃ ${s.branch}` : (s.branch || "session")); }
function openAttnPop(list: Sess[]) {
  const r = $("attnBadge").getBoundingClientRect();
  const pop = $("attnPop");
  pop.innerHTML = list.map((s) => {
    const k = statusKey(s);
    const reason = s.attention || PILL_TEXT[s.phase];
    return `<button class="ap-item" data-sel="${s.id}"><span class="ap-dot ${GCLASS[k]}">${GLYPH[k]}</span><span class="ap-main"><span class="ap-proj">${esc(s.project)}</span><span class="ap-ttl">${esc(badgeLabel(s))}</span></span><span class="ap-reason ${GCLASS[k]}">${esc(abbr(reason, 42))}</span></button>`;
  }).join("");
  pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  pop.style.left = "auto";
  pop.style.top = (r.bottom + 6) + "px";
  pop.classList.add("show");
}
function closeAttnPop() { $("attnPop").classList.remove("show"); }
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
  const needy = needsYouSessions();
  const n = list.length;
  let title = "", tooltip = "Muster — no active sessions";
  if (n > 0) {
    if (needy.length) {
      const dom = reactorState(needy[0]);
      const c = needy.filter((s) => reactorState(s) === dom).length;
      title = `${GLYPH[dom]} ${c}`;
      tooltip = `Muster — ${n} session${n === 1 ? "" : "s"}, ${reactorLabel(dom, c)}`;
    } else {
      title = `● ${n}`;
      tooltip = `Muster — ${n} session${n === 1 ? "" : "s"}`;
    }
  }
  const sig = title + "|" + tooltip + "|" + items.map((i) => i.label).join("§");
  if (sig === lastTraySig) return; // avoid rebuilding the native menu on every telemetry tick
  lastTraySig = sig;
  invoke("update_tray", { title, tooltip, items }).catch(() => {});
}
function renderAll() {
  renderSidebar(); renderMini(); renderFoot(); renderAttn();
  // When mirroring an external session, activeId is null but the stage/inspector
  // belong to that external — render it, NOT the null "no session" state. Skipping
  // this is what let a background Muster session's telemetry tick blank the
  // external header/inspector ~1s after clicking it.
  if (activeExtId) {
    const e = externals.find((x) => x.session_id === activeExtId);
    if (e) { renderExtHeader(e); renderExtInspector(e); }
  } else {
    const s = activeId ? sessions.get(activeId) ?? null : null;
    renderInspector(s); renderHeader(s);
  }
  updateTray();
  reconcileCaf(); // agent-aware mode follows the fleet's phases; no-op otherwise
}

// ---------- debug console ----------
// A lightweight in-app event log + live state snapshot, surfaced via the 🐞 button
// (in the footer) and mirrored to a fixed file (muster-debug.json) so an external
// tool — or an LLM agent debugging the running app — can read what it's doing.
// The most useful signal here is "unrouted telemetry": telemetry arriving for a
// session id the UI doesn't know (the class of bug that made panes look ended).
type DbgLvl = "info" | "warn" | "error";
let appVersion = "";
const dbgLog: { t: number; lvl: DbgLvl; msg: string }[] = [];
let dbgOpen = false;
const telem = { rx: 0, routed: 0, dropped: 0 };
function dlog(lvl: DbgLvl, msg: string) {
  dbgLog.push({ t: Date.now(), lvl, msg });
  if (dbgLog.length > 400) dbgLog.splice(0, dbgLog.length - 400);
  renderDbgBadge();
  if (dbgOpen) renderDbgPanel();
}
function dbgIssues() { return dbgLog.reduce((n, e) => n + (e.lvl === "info" ? 0 : 1), 0); }
function renderDbgBadge() {
  const n = dbgIssues();
  const b = $("dbgBadge");
  b.textContent = String(n);
  (b as HTMLElement).hidden = n === 0;
  $("dbgBtn").classList.toggle("has-issues", n > 0);
}
function dbgSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    version: appVersion, activeId, activeExtId, termEngine, rateLimits: rl, telemetry: telem,
    sessions: [...sessions.values()].map((s) => ({
      id: s.id, project: s.project, phase: s.phase, attention: s.attention, model: s.model,
      ctxPct: s.ctxPct, cost: s.cost, durMs: s.durMs, subagents: s.subagents,
      lastEvent: s.lastEvent, kind: s.kind, external: s.external, branch: s.branch, workdir: s.workdir,
    })),
    externals: externals.map((e) => ({ pid: e.pid, session_id: e.session_id, cwd: e.cwd, status: e.status, dirty: folderDirty(e.cwd) })),
    dirtyFolders: [...dirtyByFolder.entries()].map(([f, g]) => ({ folder: f, added: g?.added ?? 0, removed: g?.removed ?? 0, files: g?.files ?? 0, untracked: g?.untracked ?? 0, dirty: isDirty(g) })),
    log: dbgLog.slice(-250),
  };
}
function dbgTime(t: number) { const d = new Date(t); return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0"); }
function renderDbgPanel() {
  const snap = dbgSnapshot();
  const srows = snap.sessions.length
    ? snap.sessions.map((s) => `<tr><td>${esc(s.project)}</td><td class="mono">${s.id.slice(0, 8)}</td><td class="ph-${s.phase}">${s.phase}${s.attention ? " ⚠" : ""}</td><td>${s.ctxPct != null ? Math.round(s.ctxPct) + "%" : "–"}</td><td>${s.cost != null ? "$" + s.cost.toFixed(2) : "–"}</td><td class="mono">${esc(s.lastEvent || "–")}</td></tr>`).join("")
    : `<tr><td colspan="6" class="dbg-dim">no Muster sessions</td></tr>`;
  const logRows = dbgLog.slice().reverse().slice(0, 250)
    .map((e) => `<div class="dl ${e.lvl}"><span class="dl-t">${dbgTime(e.t)}</span><span class="dl-l">${e.lvl}</span><span class="dl-m">${esc(e.msg)}</span></div>`).join("")
    || `<div class="dbg-dim" style="padding:8px">no events yet</div>`;
  $("dbgBody").innerHTML =
    `<div class="dbg-stats">telemetry: rx ${telem.rx} · routed ${telem.routed} · <span class="${telem.dropped ? "warn" : ""}">dropped ${telem.dropped}</span> · 5h ${rl.h5 != null ? Math.round(rl.h5) + "%" : "–"}</div>
     <table class="dbg-tbl"><thead><tr><th>project</th><th>id</th><th>phase</th><th>ctx</th><th>cost</th><th>last event</th></tr></thead><tbody>${srows}</tbody></table>
     <div class="dbg-log">${logRows}</div>`;
}
function toggleDbg(open?: boolean) {
  dbgOpen = open ?? !dbgOpen;
  ($("dbgPanel") as HTMLElement).hidden = !dbgOpen;
  if (dbgOpen) { renderDbgPanel(); flushDebug(); }
}
async function flushDebug() {
  try {
    const path = await invoke<string>("write_debug_file", { contents: JSON.stringify(dbgSnapshot(), null, 2) });
    $("dbgPath").textContent = path;
  } catch { /* backend not ready */ }
}

// ---------- palette (⌘K) ----------
// A fused switcher + command runner. Prefixes scope the search (⟩ commands,
// @ sessions/projects, / by state); results are grouped with the "Needs you" set
// pinned on top, fuzzy-matched with highlight, and frecency-ranked. ⌘K on a session
// opens an action panel (jump, terminal, worktree, kill, answer permission) without
// leaving the box — a page stack you back out of with Backspace/Esc.
interface PalItem {
  kind: "session" | "launch" | "command" | "action" | "task" | "fallback";
  key: string;                 // stable key for frecency (commands/launches)
  label: string; labelHtml: string; sub?: string;
  sw?: string; icon?: string; glyph?: string;
  shortcut?: string[];         // right-aligned kbd hint, e.g. ["⌘","1"]
  session?: Sess;              // present on session rows → enables the ⌘K action panel
  score?: number;
  run: () => void;
}
interface PalGroup { name: string; count?: number; items: PalItem[] }
let palGroups: PalGroup[] = [];
let palFlat: PalItem[] = [];   // the selectable rows, in display order
let palSel = 0;
let palPage: "root" | "actions" = "root";
let palActionSess: Sess | null = null;

// Frecency: recency × frequency with a ~30-day half-life, for stable command/launch keys.
const frecency: Record<string, { n: number; t: number }> = JSON.parse(localStorage.getItem("cc-frecency") || "{}");
function frecScore(key: string): number { const f = frecency[key]; return f ? f.n * Math.pow(0.5, (Date.now() - f.t) / 2592000000) : 0; }
function bumpFrec(key: string) { if (!key || key.startsWith("session:")) return; const f = frecency[key] || { n: 0, t: 0 }; f.n++; f.t = Date.now(); frecency[key] = f; localStorage.setItem("cc-frecency", JSON.stringify(frecency)); }

// Subsequence fuzzy match with matched-char highlighting. null = no match; higher
// score = better (rewards contiguous runs and matches at word starts).
function fuzzy(text: string, q: string): { score: number; html: string } | null {
  if (!q) return { score: 0, html: esc(text) };
  const tl = text.toLowerCase(), ql = q.toLowerCase();
  const hit: number[] = []; let ti = 0, score = 0, run = 0;
  for (const c of ql) {
    let found = -1;
    for (let k = ti; k < tl.length; k++) if (tl[k] === c) { found = k; break; }
    if (found === -1) return null;
    const boundary = found === 0 || /[\s/·._-]/.test(text[found - 1]);
    run = found === ti ? run + 1 : 1;
    score += 1 + run + (boundary ? 4 : 0) - found * 0.02;
    hit.push(found); ti = found + 1;
  }
  const set = new Set(hit); let html = "";
  for (let k = 0; k < text.length; k++) html += set.has(k) ? `<b class="hit">${esc(text[k])}</b>` : esc(text[k]);
  return { score, html };
}
// Match the label, falling back to the sub (unhighlighted) so a path/status still filters.
function scoreItem(it: PalItem, term: string): PalItem | null {
  const m = fuzzy(it.label, term);
  if (m) return { ...it, labelHtml: m.html, score: m.score };
  if (term && it.sub) { const s = fuzzy(it.sub, term); if (s) return { ...it, labelHtml: esc(it.label), score: s.score - 2 }; }
  return null;
}
function parsePal(raw: string): { mode: "all" | "cmd" | "sess" | "filter"; term: string } {
  const s = raw.replace(/^\s+/, "");
  if (s[0] === ">" || s[0] === "⟩") return { mode: "cmd", term: s.slice(1).trim() };
  if (s[0] === "@") return { mode: "sess", term: s.slice(1).trim() };
  if (s[0] === "/") return { mode: "filter", term: s.slice(1).trim() };
  return { mode: "all", term: s.trim() };
}
// The ⌘K-within action list for one session.
function sessionActions(s: Sess): PalItem[] {
  const mk = (label: string, glyph: string, run: () => void): PalItem => ({ kind: "action", key: "", label, labelHtml: esc(label), glyph, run });
  const a: PalItem[] = [mk("Jump to session", "→", () => setActive(s.id))];
  if (s.pendingPermId) {
    a.push(mk("Allow the pending permission", "✓", () => resolvePermission(s.pendingPermId!, "allow")));
    a.push(mk("Deny the pending permission", "✕", () => resolvePermission(s.pendingPermId!, "deny")));
    a.push(mk("Answer it in the terminal", "❯", () => resolvePermission(s.pendingPermId!, "terminal")));
  }
  if (isAgent(s)) {
    // Only offered for repo sessions — s.git is null when the workdir isn't one.
    if (s.git) {
      const b = s.git.behind, ah = s.git.ahead;
      a.push(mk("Fetch from the remote", "↻", () => runGit(s.id, "fetch")));
      a.push(mk(b ? `Pull ${b} commit${b === 1 ? "" : "s"}` : "Pull (fast-forward only)", "↓", () => runGit(s.id, "pull")));
      a.push(mk(ah ? `Push ${ah} commit${ah === 1 ? "" : "s"}` : "Push", "↑", () => runGit(s.id, "push")));
    }
    a.push(mk("Open a terminal here", "❯", () => { setActive(s.id); openPlainTerminal(); }));
    a.push(mk("New worktree from here", "⑃", () => openWt(s.project, s.colorKey, false)));
  }
  a.push(mk("Close session", "✕", () => closeSession(s.id)));
  return a;
}
const PAL_CMDS: { key: string; label: string; glyph: string; run: () => void; sc?: string[] }[] = [
  { key: "cmd:add", label: "Add a project folder…", glyph: "＋", run: addProject },
  { key: "cmd:term", label: "Open a terminal in the current project", glyph: "❯", run: openPlainTerminal },
  { key: "cmd:run", label: "Run a task in the current project…", glyph: "▶", run: () => { void openRunPicker(); } },
  { key: "cmd:settings", label: "Open settings…", glyph: "⚙", run: () => openSettings(), sc: ["⌘", ","] },
  { key: "cmd:sort", label: "Change the sidebar sort order", glyph: "≡", run: cycleSort },
  { key: "cmd:insp", label: "Toggle the inspector", glyph: "◨", run: toggleInsp, sc: ["⌘", "I"] },
  { key: "cmd:rail", label: "Toggle the sidebar", glyph: "◧", run: toggleRail, sc: ["⌘", "B"] },
  { key: "cmd:theme", label: "Toggle the theme", glyph: "◐", run: toggleTheme },
];
function buildPalGroups(raw: string): PalGroup[] {
  // action panel page — one group of the target session's actions, fuzzy-filtered
  if (palPage === "actions" && palActionSess) {
    const t = raw.trim();
    const items = sessionActions(palActionSess).map((it) => scoreItem(it, t)).filter(Boolean) as PalItem[];
    items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const label = palActionSess.title || palActionSess.branch || "session";
    return [{ name: `↩ ${palActionSess.project} · ${label}`, items }];
  }
  const { mode, term } = parsePal(raw);
  const searchTerm = mode === "filter" ? "" : term;   // in /filter mode the term is a state, not a name
  const emptyTerm = !searchTerm;
  const order = new Map(orderedSessions().map((s, i) => [s.id, i]));
  const stateOf = (s: Sess) => (s.attention ? "waiting" : s.phase);
  const matchesState = mode === "filter" && term ? (s: Sess) => stateOf(s).startsWith(term.toLowerCase()) : () => true;

  const sessCands: PalItem[] = [...sessions.values()].filter(matchesState).map((s) => {
    const i = order.get(s.id);
    const label = `${s.project} · ${s.kind === "task" ? "▶ " + (s.run?.label ?? "task") : s.title || s.branch || (s.kind === "shell" ? "shell" : "session")}`;
    const sub = s.kind === "shell" ? "shell"
      : s.kind === "task" ? `task · ${taskStateText(s)}`
      : `${verbFor(s).toLowerCase()}${s.ctxPct != null ? ` · ${Math.round(s.ctxPct)}% ctx` : ""}${s.cost != null ? ` · $${s.cost.toFixed(2)}` : ""}`;
    return { kind: "session", key: "session:" + s.id, label, labelHtml: esc(label), sub, sw: accentFor(s.colorKey), icon: iconFor(s.colorKey) || undefined, shortcut: i != null && i < 9 ? ["⌘", String(i + 1)] : undefined, session: s, run: () => setActive(s.id) };
  });
  // Tasks for the active project. Discovery is async, so this reads a cache the
  // palette warms on open — an empty first frame is corrected in place.
  const taskCands: PalItem[] = palTasks.map((r) => ({
    kind: "task", key: "task:" + r.id, label: `Run ${r.label}`, labelHtml: esc(`Run ${r.label}`),
    sub: `${r.source} · ${execCmd(r)}`, glyph: r.blocked ? "⃠" : "▶",
    run: () => {
      const c = runTargetCtx(); if (!c) return;
      const o = { colorKey: c.colorKey, worktree: c.worktree, branch: c.branch, discoveredIn: c.workdir };
      if (r.id === "just:__untrusted") { void askTrust(c.colorKey, c.project); return; }
      if (r.inputs.length) { openInputPrompt(r, c.project, o); return; }
      void launchTask(r, c.project, o);
    },
  }));
  const launchCands: PalItem[] = FAVORITES.map((f) => ({ kind: "launch", key: "launch:" + f.path, label: `Launch ${f.name}`, labelHtml: esc(`Launch ${f.name}`), sub: tilde(f.path), sw: accentFor(f.path), icon: iconFor(f.path) || undefined, run: () => requestLaunch(f.name, f.path) }));
  const cmdCands: PalItem[] = PAL_CMDS.map((c) => ({ kind: "command", key: c.key, label: c.label, labelHtml: esc(c.label), sub: "command", glyph: c.glyph, shortcut: c.sc, run: c.run }));
  for (const id of availEngines) { const d = engineDef(id); cmdCands.push({ kind: "command", key: "engine:" + id, label: `New sessions in ${d.label}${id === termEngine ? " ✓" : ""}`, labelHtml: esc(`New sessions in ${d.label}${id === termEngine ? " ✓" : ""}`), sub: d.sub, glyph: id === "embedded" ? "▤" : "⧉", run: () => setEngine(id) }); }

  const score = (arr: PalItem[]) => arr.map((it) => scoreItem(it, searchTerm)).filter(Boolean) as PalItem[];
  const byScore = (a: PalItem, b: PalItem) => (b.score ?? 0) - (a.score ?? 0);
  const byFrec = (a: PalItem, b: PalItem) => frecScore(b.key) - frecScore(a.key);
  const sessNatural = (a: PalItem, b: PalItem) => urgencyRank(a.session!) - urgencyRank(b.session!) || b.session!.lastActivity - a.session!.lastActivity;

  const sess = score(sessCands), launch = score(launchCands), cmds = score(cmdCands), tsk = score(taskCands);
  const needy = sess.filter((i) => needsYou(i.session!)).sort(emptyTerm ? sessNatural : byScore);
  const rest = sess.filter((i) => !needsYou(i.session!)).sort(emptyTerm ? sessNatural : byScore);

  const groups: PalGroup[] = [];
  const recentKeys = new Set<string>();
  if (mode !== "cmd" && needy.length) groups.push({ name: "Needs you", count: needy.length, items: needy });
  if (emptyTerm && mode === "all") {
    const recent = [...cmds, ...launch, ...tsk].filter((i) => frecScore(i.key) > 0).sort(byFrec).slice(0, 3);
    recent.forEach((i) => recentKeys.add(i.key));
    if (recent.length) groups.push({ name: "Recent", items: recent });
  }
  if (mode !== "cmd" && rest.length) groups.push({ name: "Sessions", count: rest.length, items: rest });
  if (mode === "all" || mode === "sess") { const l = launch.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (l.length) groups.push({ name: "Launch", items: l }); }
  if (mode === "all" || mode === "sess") { const t = tsk.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (t.length) groups.push({ name: "Tasks", count: t.length, items: t }); }
  if (mode === "all" || mode === "cmd") { const c = cmds.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (c.length) groups.push({ name: "Commands", items: c }); }
  if (!groups.length) groups.push({ name: "No matches", items: [{ kind: "fallback", key: "", label: "Add a project folder…", labelHtml: esc("Add a project folder…"), glyph: "＋", run: addProject }] });
  return groups;
}
function runPalItem(it: PalItem | undefined) { if (!it) return; bumpFrec(it.key); closePalette(); it.run(); }
function openPalActions(s: Sess) { palPage = "actions"; palActionSess = s; const inp = $("palInput") as HTMLInputElement; inp.value = ""; palSel = 0; refreshPal(); inp.focus(); }
function popPalPage() { palPage = "root"; palActionSess = null; const inp = $("palInput") as HTMLInputElement; inp.value = ""; palSel = 0; refreshPal(); inp.focus(); }
function renderPal() {
  let idx = 0;
  const html = palGroups.map((g) => {
    const rows = g.items.map((it) => {
      const i = idx++;
      const ic = it.icon ? `<img class="pal-icimg" src="${it.icon}" alt="" />` : it.sw ? `<span class="sw" style="background:${it.sw}"></span>` : (it.glyph || "›");
      const sh = it.shortcut ? `<span class="pal-sh">${it.shortcut.map((k) => `<span class="k">${esc(k)}</span>`).join("")}</span>`
        : it.session ? `<span class="pal-sh actions"><span class="k">⌘K</span></span>` : "";
      return `<div class="pal-item ${i === palSel ? "on" : ""}" data-i="${i}"><span class="pal-ic">${ic}</span><span class="pal-main"><span class="pm">${it.labelHtml}</span>${it.sub ? `<span class="ps">${esc(it.sub)}</span>` : ""}</span>${sh}</div>`;
    }).join("");
    return `<div class="pal-gh">${esc(g.name)}${g.count ? `<span class="gc">${g.count}</span>` : ""}</div>${rows}`;
  }).join("");
  $("palList").innerHTML = html || `<div class="pal-item"><span class="pal-main"><span class="pm" style="color:var(--muted)">No matches</span></span></div>`;
  $("palList").querySelectorAll<HTMLElement>(".pal-item[data-i]").forEach((el) => el.addEventListener("click", () => runPalItem(palFlat[+el.dataset.i!])));
  const foot = $("palFoot");
  foot.innerHTML = palPage === "actions"
    ? `<span>↵ run</span><span>⌫ back</span><span class="sp"></span><span>esc close</span>`
    : `<span class="pf-mode">⟩ command</span><span>@ project</span><span>/ state</span><span class="sp"></span><span>⌘K actions · esc</span>`;
  $("palList").querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
}
function refreshPal() { palGroups = buildPalGroups(($("palInput") as HTMLInputElement).value); palFlat = palGroups.flatMap((g) => g.items); palSel = 0; renderPal(); }
let palTasks: Runnable[] = [];
function openPalette() {
  palPage = "root"; palActionSess = null; palSel = 0;
  const c = runTargetCtx();
  palTasks = [];
  if (c) void discoverTasks(c.workdir, c.colorKey).then((l) => { palTasks = l; if ($("palette").classList.contains("show")) refreshPal(); });
  $("scrim").classList.add("show");
  $("palette").classList.add("show");
  ($("palInput") as HTMLInputElement).value = "";
  refreshPal();
  setTimeout(() => ($("palInput") as HTMLInputElement).focus(), 30);
}
function closePalette() { $("scrim").classList.remove("show"); $("palette").classList.remove("show"); palPage = "root"; palActionSess = null; }

// ---------- settings ----------
// The window main.ts has wanted for a while: it finally gives the worktree-grouping
// mode a control (it was reachable only as musterWtGroup() in the console), and it
// owns the task settings that would otherwise be hardcoded bets.

let setPage: "general" | "tasks" = "tasks";
const SET_PAGES: { id: "general" | "tasks"; label: string }[] = [
  { id: "general", label: "General" },
  { id: "tasks", label: "Tasks" },
];

/// A segmented control. `opts` are [value, label] pairs; `cur` is the selected one.
function seg(name: string, cur: string, opts: [string, string][]): string {
  return `<span class="s-ctl">${opts.map(([v, l]) =>
    `<button class="opt${v === cur ? " on" : ""}" data-set="${name}" data-val="${esc(v)}">${esc(l)}</button>`).join("")}</span>`;
}
function sw(name: string, on: boolean): string {
  return `<button class="sw${on ? " on" : ""}" data-set="${name}" data-val="${on ? "0" : "1"}" role="switch" aria-checked="${on}"></button>`;
}
function sRow(title: string, desc: string, ctl: string): string {
  return `<div class="s-row"><div class="s-txt"><b>${title}</b><span>${desc}</span></div>${ctl}</div>`;
}

function renderSettings() {
  $("setNav").innerHTML = SET_PAGES.map((p) =>
    `<button class="set-tab${p.id === setPage ? " on" : ""}" data-page="${p.id}">${esc(p.label)}</button>`).join("");

  const body = setPage === "general" ? settingsGeneral() : settingsTasks();
  $("setBody").innerHTML = body;

  $("setNav").querySelectorAll<HTMLElement>("[data-page]").forEach((el) =>
    el.addEventListener("click", () => { setPage = el.dataset.page as typeof setPage; renderSettings(); }));
  $("setBody").querySelectorAll<HTMLElement>("[data-set]").forEach((el) =>
    el.addEventListener("click", () => applySetting(el.dataset.set!, el.dataset.val!)));
}

function settingsGeneral(): string {
  return `
    <div class="s-grp">Sidebar</div>
    ${sRow("Worktree grouping", "How several checkouts of one repo are arranged in the sidebar.",
      seg("wtGroup", wtGroup, [["subheader", "nested"], ["chip", "chips"], ["toplevel", "separate"], ["off", "flat"]]))}
    ${sRow("Sort order", "What decides the order of projects in the sidebar.",
      seg("sort", sortMode, SORT_MODES.map((m) => [m, SORT_META[m].label] as [string, string])))}
    <div class="s-grp">Sessions</div>
    ${sRow("New sessions open in", "Where the terminal for a new Claude session lives.",
      seg("engine", termEngine, availEngines.map((e) => [e, engineDef(e).label] as [string, string])))}`;
}

function settingsTasks(): string {
  const trusted = explicitlyTrusted();
  const favTrusted = FAVORITES.length;
  return `
    <div class="s-grp">Providers</div>
    ${sRow("Scan for task files", "Which formats Muster looks for when you open the Run picker.",
      `<span class="s-ctl">${ALL_PROVIDERS.map((p) =>
        `<button class="opt${taskPrefs.providers.includes(p) ? " on" : ""}" data-set="prov" data-val="${p}">${esc(PROVIDER_LABEL[p])}</button>`).join("")}</span>`)}

    <div class="s-grp">Trust</div>
    ${sRow("Let trusted projects introspect themselves",
      "Listing justfile recipes means running <code>just --dump</code>, which evaluates the file and can execute code from the folder. Off means those recipes stay undiscovered.",
      sw("introspect", taskPrefs.introspect))}
    ${sRow("Trusted projects",
      trusted.length
        ? `${trusted.map((p) => `<code>${esc(basename(p))}</code>`).join(" ")} — plus your ${favTrusted} project folder${favTrusted === 1 ? "" : "s"}, trusted because you added them.`
        : `Your ${favTrusted} project folder${favTrusted === 1 ? "" : "s"}, trusted because you added them. Anything else asks once.`,
      trusted.length ? `<span class="s-ctl">${trusted.map((p) =>
        `<button class="opt" data-set="untrust" data-val="${esc(p)}" title="${esc(tilde(p))}">revoke ${esc(basename(p))}</button>`).join("")}</span>` : `<span class="s-ctl"><span class="opt quiet">nothing to revoke</span></span>`)}

    <div class="s-grp">Running</div>
    ${sRow("Working directory", "With several worktrees open, “run tests” is otherwise ambiguous.",
      seg("cwd", taskPrefs.cwd, [["session", "active session"], ["root", "repo root"]]))}
    ${sRow("Dismiss successful runs", "Failures always stay until you close them.",
      seg("dismiss", String(taskPrefs.dismissMs), [["0", "never"], ["20000", "after 20s"], ["1", "at once"]]))}
    ${sRow("Raise attention when a run fails", "Uses the same badge and tray notification as a blocked session.",
      sw("attention", taskPrefs.attention))}`;
}

function applySetting(name: string, val: string) {
  switch (name) {
    case "wtGroup": setWtGroup(val as WtGroup); break;
    case "sort": setSort(val as SortMode, false); break;
    case "engine": setEngine(val as Engine); break;
    case "prov": {
      const p = val as Provider;
      const on = taskPrefs.providers.includes(p);
      // Never let every provider be switched off — an empty picker looks broken.
      if (on && taskPrefs.providers.length === 1) { toast("At least one provider has to stay on"); return; }
      taskPrefs.providers = on ? taskPrefs.providers.filter((x) => x !== p) : [...taskPrefs.providers, p];
      saveTaskPrefs();
      break;
    }
    case "introspect": taskPrefs.introspect = val === "1"; saveTaskPrefs(); break;
    case "cwd": taskPrefs.cwd = val as TaskPrefs["cwd"]; saveTaskPrefs(); break;
    case "dismiss": taskPrefs.dismissMs = +val; saveTaskPrefs(); break;
    case "attention": taskPrefs.attention = val === "1"; saveTaskPrefs(); break;
    case "untrust": untrustProject(val); break;
  }
  renderSettings();
}

function openSettings(page: "general" | "tasks" = "tasks") {
  setPage = page;
  $("setDlg").classList.add("show");
  $("scrim").classList.add("show");
  renderSettings();
}
function closeSettings() {
  $("setDlg").classList.remove("show");
  if (!$("palette").classList.contains("show") && !$("runPop").classList.contains("show")) $("scrim").classList.remove("show");
}

// ---------- panels / theme ----------
function setSort(m: SortMode, announce = true) {
  sortMode = m;
  localStorage.setItem("cc-sort", m);
  const b = $("railSort");
  b.textContent = SORT_META[m].glyph;
  b.title = `Sort: ${SORT_META[m].label} · click to change`;
  b.classList.toggle("on", m !== "manual");
  if (announce) toast(SORT_META[m].label);
  renderSidebar(); renderMini();
}
function cycleSort() { setSort(SORT_MODES[(SORT_MODES.indexOf(sortMode) + 1) % SORT_MODES.length]); }
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
  const mainBtn = $("wtMain") as HTMLElement;
  mainBtn.hidden = !allowMain;
  if (allowMain) {
    // Default to a neutral label; refine it to the actual current branch once git answers.
    mainBtn.innerHTML = "without worktree";
    mainBtn.title = "Start a session in the repo itself — no new worktree";
    invoke<string | null>("git_branch", { workdir: repoDir }).then((b) => {
      if (!wtCtx || wtCtx.repoDir !== repoDir) return; // dialog moved on / closed
      if (b) {
        mainBtn.innerHTML = `on <span class="wt-mainbr">${esc(b)}</span>`;
        mainBtn.title = `Start a session on the current branch (${b}) — no new worktree`;
      }
    }).catch(() => {});
  }
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
  const bytes = Uint8Array.from(atob(e.payload.data), (c) => c.charCodeAt(0));
  s.term.write(bytes);
  // A task keeps a small tail of its own output so a failure can be handed to a
  // Claude session without re-reading the pane. Bounded hard — this is a hint for
  // the agent, not a transcript.
  if (s.run) {
    const text = new TextDecoder().decode(bytes).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) s.run.tail.push(line.trimEnd());
    }
    if (s.run.tail.length > 40) s.run.tail.splice(0, s.run.tail.length - 40);
  }
});
listen<{ sessionId: string; code: number }>("pty-exit", (e) => {
  dlog("info", `pty-exit ${e.payload.sessionId.slice(0, 8)} · code ${e.payload.code}`);
  const s = sessions.get(e.payload.sessionId); if (!s) return;
  const code = e.payload.code;
  s.attention = null;
  if (s.kind === "task") {
    // The exit code *is* the phase — that's what buys tasks the sidebar glyphs,
    // the attention badge and the tray without a line of new plumbing.
    s.run!.exitCode = code;
    setPhase(s, code === 0 ? "done" : "error");
    s.term?.writeln(code === 0
      ? `\r\n\x1b[32m✓ ${s.run!.label} — exit 0\x1b[0m`
      : `\r\n\x1b[31m✕ ${s.run!.label} — exit ${code}\x1b[0m`);
    if (code === 0) scheduleDismiss(s);
    dlog(code === 0 ? "info" : "warn", `task ${s.run!.id} exit ${code}`);
  } else {
    s.phase = "ended";
    s.term?.writeln(`\r\n\x1b[90m[${s.kind === "shell" ? "shell" : "claude"} exited: code ${code}]\x1b[0m`);
  }
  renderAll();
});

// A green run shouldn't linger — tasks are far more numerous and shorter-lived
// than sessions, and without this the rail silently fills with ticks. A pane you
// are actually looking at is never yanked away, and a failure never auto-closes.
function scheduleDismiss(s: Sess) {
  if (s.run?.background || !taskPrefs.dismissMs) return;
  window.setTimeout(() => {
    const cur = sessions.get(s.id);
    if (!cur || cur.run?.exitCode !== 0) return;   // re-run or still failing → leave it
    if (activeId === cur.id) return;               // you're reading it
    closeSession(cur.id);
  }, taskPrefs.dismissMs);
}
listen<{ kind: string; data: any }>("telemetry", (e) => {
  const { kind, data } = e.payload; if (!data) return;
  telem.rx++;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { telem.dropped++; dlog("warn", `${kind} telemetry for unrouted session ${sid ? sid.slice(0, 8) : "?"} — dropped`); return; }
  telem.routed++;
  if (kind === "statusline") applyStatusline(s, data); else { dlog("info", `hook ${data.hook_event_name ?? "?"} · ${sid!.slice(0, 8)}`); applyHook(s, data); }
  renderAll();
});
// menu-bar (tray) menu → jump to the clicked session
listen<string>("tray-select", (e) => { const id = e.payload; if (sessions.has(id)) setActive(id); });
// blocking permission request — Claude is waiting for our decision
listen<{ id: string; data: any }>("permission", (e) => {
  const { id, data } = e.payload; if (!data) return;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { dlog("warn", `permission for unrouted session ${sid ? sid.slice(0, 8) : "?"} — auto-deferred to terminal`); invoke("resolve_permission", { id, behavior: "terminal" }).catch(() => {}); return; }
  s.attention = `permission: ${data.tool_name || ""}`;
  s.pendingCmd = permCmd(data);
  s.pendingPermId = id;
  s.pendRisk = riskLevel(data.tool_name, data.tool_input);
  renderAll();
});

// delegated clicks (sidebar / mini / inspector buttons)
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("#colorPop, .pdot, .rm-dot")) closeColorPop();
  if (!t.closest("#enginePop, #fEngineSeg")) closeEnginePop();
  if (!t.closest("#cafPop, #caf")) closeCafPop();
  if (!t.closest("#attnPop, #attnBadge")) closeAttnPop();
  const dot = t.closest<HTMLElement>(".pdot, .rm-dot");
  if (dot) { const owner = dot.closest<HTMLElement>("[data-key]"); if (owner?.dataset.key) { openColorPopover(owner.dataset.key, e.clientX, e.clientY); return; } }
  const el = t.closest<HTMLElement>("[data-perm],[data-git],[data-diff],[data-wt],[data-close],[data-remove],[data-add],[data-jump],[data-ext],[data-sel],[data-launch],[data-pal],[data-rail],[data-toast]");
  if (!el) return;
  if (el.dataset.perm) resolvePermission(el.dataset.permid || "", el.dataset.perm);
  else if (el.dataset.git) runGit(el.dataset.gitsid || "", el.dataset.git);
  else if (el.dataset.diff) openDiff(el.dataset.diff, el.dataset.difftitle || "");
  else if (el.dataset.wt) openWorktreeSession(el.dataset.wt, el.dataset.wtbranch || "");
  else if (el.dataset.close) closeSession(el.dataset.close);
  else if (el.dataset.remove) removeFavorite(el.dataset.remove);
  else if (el.dataset.add) addProject();
  else if (el.dataset.jump) jumpExternal(+el.dataset.jump);
  else if (el.dataset.ext) openExternal(el.dataset.ext);
  else if (el.dataset.sel) { setActive(el.dataset.sel); closeAttnPop(); }
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

// ---------- terminal-engine popover (footer "new in …") ----------
function openEnginePopover() {
  const seg = $("fEngineSeg");
  const r = seg.getBoundingClientRect();
  const pop = $("enginePop");
  pop.innerHTML = availEngines.map((id) => {
    const d = engineDef(id);
    return `<button class="mp-item ${id === termEngine ? "on" : ""}" data-engine="${id}"><span class="mp-ic">${id === "embedded" ? "▤" : "⧉"}</span><span class="mp-main"><span class="mp-l">${esc(d.label)}</span><span class="mp-s">${esc(d.sub)}</span></span><span class="mp-check">✓</span></button>`;
  }).join("");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 228)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
function closeEnginePop() { $("enginePop").classList.remove("show"); }
$("enginePop").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-engine]");
  if (!b) return;
  setEngine(b.dataset.engine as Engine);
  closeEnginePop();
});

// ---------- caffeinate (keep-awake) ----------
// The top-bar split button drives a macOS `caffeinate` power assertion. The icon
// toggles the last-used preset (one click); the caret opens the picker. Three
// kinds of preset:
//   • static  — fixed flags, on until you stop it (display / system / full)
//   • timer   — a chosen duration (15m/1h/2h/4h), auto-off when it elapses
//   • agents  — dynamic: hold the Mac awake ONLY while sessions are busy, and
//               release when the fleet goes dormant; re-arms when work resumes
// "Armed" (the user turned it on) is distinct from "asserting" (a caffeinate
// child is actually running right now). For the agent mode those differ: armed
// but idle shows the cup lit without steam; asserting adds the steam + glow.
// reconcileCaf() is the single choke point — called on every renderAll(), it
// diffs the desired flags against what's running and only pokes the backend on a
// real change (same guarded-invoke pattern as updateTray).
// `caffeinate` is a macOS binary with no Windows equivalent wired up yet, so the
// whole control is hidden there (see initCaf) and reconcileCaf() bails out —
// otherwise every renderAll() would fire an invoke that can only ever error.
const IS_WINDOWS = navigator.userAgent.includes("Windows");
type CafKind = "static" | "timer" | "agents";
interface CafPreset { id: string; kind: CafKind; label: string; desc: string; glyph: string; flags?: string[] }
const CAF_PRESETS: CafPreset[] = [
  { id: "display", kind: "static", label: "Keep display awake", desc: "Screen + system stay on",     glyph: "☀", flags: ["-d"] },
  { id: "system",  kind: "static", label: "Keep system awake",  desc: "Runs on; screen may sleep",   glyph: "⏻", flags: ["-i"] },
  { id: "full",    kind: "static", label: "Fully caffeinated",  desc: "Display, disk & system",      glyph: "✺", flags: ["-dimsu"] },
  { id: "timer",   kind: "timer",  label: "Timed",              desc: "Stay awake, then auto-off",   glyph: "◷" },
  { id: "agents",  kind: "agents", label: "Until agents idle",  desc: "Awake only while agents work", glyph: "⟳" },
];
const CAF_DURATIONS: { sec: number; label: string }[] = [
  { sec: 900, label: "15m" }, { sec: 3600, label: "1h" }, { sec: 7200, label: "2h" }, { sec: 14400, label: "4h" },
];
const cafPreset = (id: string): CafPreset => CAF_PRESETS.find((p) => p.id === id) || CAF_PRESETS[0];
let cafPresetId = localStorage.getItem("cc-caffeinate") || CAF_PRESETS[0].id;
if (!CAF_PRESETS.some((p) => p.id === cafPresetId)) cafPresetId = CAF_PRESETS[0].id;
let cafTimerSec = parseInt(localStorage.getItem("cc-caf-timer") || "", 10) || 3600;
if (!CAF_DURATIONS.some((d) => d.sec === cafTimerSec)) cafTimerSec = 3600;
// agents mode: also count "waiting on you" (permission prompt / your turn) as
// busy, so an unattended run's prompt keeps the screen up. User-toggled switch.
let cafAgentsAwait = localStorage.getItem("cc-caf-await") !== "0";
let cafArmed = false;         // the user turned it on
let cafAssertKey = "";        // flags currently handed to the backend ("" = off)
let cafTimerHandle: number | null = null;

function cafPersist() {
  localStorage.setItem("cc-caffeinate", cafPresetId);
  localStorage.setItem("cc-caf-timer", String(cafTimerSec));
  localStorage.setItem("cc-caf-await", cafAgentsAwait ? "1" : "0");
}
// Is any real (non-shell) session doing work worth staying awake for?
function cafAgentsBusy(): boolean {
  for (const s of sessions.values()) {
    if (s.kind === "shell" || s.phase === "ended") continue;
    if (s.phase === "working" || s.phase === "thinking") return true;
    if (cafAgentsAwait && (!!s.attention || s.phase === "done")) return true;
  }
  return false;
}
// The flags we WANT running now, or null for "assert nothing".
function cafDesiredFlags(): string[] | null {
  if (!cafArmed) return null;
  const p = cafPreset(cafPresetId);
  if (p.kind === "agents") return cafAgentsBusy() ? ["-i"] : null;
  if (p.kind === "timer") return ["-di", "-t", String(cafTimerSec)];
  return p.flags ?? null;
}
function cafArmTimer() {
  if (cafTimerHandle !== null) { clearTimeout(cafTimerHandle); cafTimerHandle = null; }
  if (cafArmed && cafPreset(cafPresetId).kind === "timer") {
    cafTimerHandle = window.setTimeout(() => { cafArmed = false; reconcileCaf(); toast("Caffeinate ended"); }, cafTimerSec * 1000);
  }
}
function reconcileCaf() {
  if (IS_WINDOWS) return; // control hidden; the backend command only errors there
  const flags = cafDesiredFlags();
  const key = flags ? flags.join(" ") : "";
  if (key !== cafAssertKey) {
    cafAssertKey = key;
    invoke("set_caffeinate", { active: !!flags, flags: flags ?? [] }).catch((e) => { cafAssertKey = ""; toast("caffeinate: " + e); });
  }
  renderCaf();
}
function renderCaf() {
  const p = cafPreset(cafPresetId);
  $("caf").classList.toggle("on", cafArmed);
  $("caf").classList.toggle("asserting", cafAssertKey !== "");
  $("cafMain").title = !cafArmed ? `Keep this Mac awake · ${p.label}`
    : p.kind === "agents" ? (cafAssertKey ? "Awake — agents are working" : "Armed — sleeps until agents work")
    : p.kind === "timer" ? `Awake · ${cafDurLabel(cafTimerSec)} timer — click to stop`
    : `Awake · ${p.label} — click to stop`;
}
const cafDurLabel = (sec: number) => (CAF_DURATIONS.find((d) => d.sec === sec) || { label: sec + "s" }).label;

// user actions -------------------------------------------------------------
function cafToggle() { cafArmed = !cafArmed; cafPersist(); cafArmTimer(); reconcileCaf(); dlog("info", `caffeinate ${cafArmed ? "on · " + cafPresetId : "off"}`); }
function cafPick(id: string) { cafPresetId = id; cafArmed = true; cafPersist(); cafArmTimer(); reconcileCaf(); dlog("info", `caffeinate on · ${id}`); }
function cafStop() { cafArmed = false; cafPersist(); cafArmTimer(); reconcileCaf(); }
function cafSetDuration(sec: number) { cafTimerSec = sec; cafPresetId = "timer"; cafArmed = true; cafPersist(); cafArmTimer(); reconcileCaf(); fillCafPop(); }
function cafSetAwait(v: boolean) { cafAgentsAwait = v; cafPersist(); reconcileCaf(); fillCafPop(); }

function fillCafPop() {
  const rows = CAF_PRESETS.map((p) => {
    const active = cafArmed && p.id === cafPresetId;
    const last = !cafArmed && p.id === cafPresetId; // what a plain click would use
    let right = "";
    if (p.kind === "static") right = `<span class="mp-flags">${esc((p.flags ?? []).join(" "))}</span>`;
    else if (p.kind === "agents") right = `<span class="mp-flags">-i</span>`;
    const item = `<button class="mp-item ${active ? "on" : last ? "cur" : ""}" data-caf="${p.id}">`
      + `<span class="mp-ic">${p.glyph}</span>`
      + `<span class="mp-main"><span class="mp-l">${esc(p.label)}</span><span class="mp-s">${esc(p.desc)}</span></span>`
      + right + `</button>`;
    let sub = "";
    if (p.kind === "timer") {
      sub = `<div class="caf-sub caf-durs">` + CAF_DURATIONS.map((d) =>
        `<button class="caf-dur ${d.sec === cafTimerSec ? "on" : ""}" data-cafdur="${d.sec}">${d.label}</button>`).join("") + `</div>`;
    } else if (p.kind === "agents") {
      sub = `<div class="caf-sub caf-switch-row">`
        + `<span class="caf-sw-lbl">Stay awake while agents await you</span>`
        + `<button class="caf-switch ${cafAgentsAwait ? "on" : ""}" role="switch" aria-checked="${cafAgentsAwait}" data-cafawait="1"><span class="caf-knob"></span></button></div>`;
    }
    return `<div class="caf-opt">${item}${sub}</div>`;
  }).join("");
  const off = cafArmed
    ? `<div class="mp-sep"></div><button class="mp-item mp-off" data-caf="off"><span class="mp-ic">⏹</span><span class="mp-main"><span class="mp-l">Stop caffeinate</span></span></button>`
    : "";
  $("cafPop").innerHTML = rows + off;
}
function openCafPop() {
  const r = $("caf").getBoundingClientRect();
  const pop = $("cafPop");
  fillCafPop();
  const w = 260;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
  pop.style.bottom = "auto";
  pop.classList.add("show");
}
function closeCafPop() { $("cafPop").classList.remove("show"); }
$("cafMain").addEventListener("click", (e) => { e.stopPropagation(); closeCafPop(); cafToggle(); });
$("cafCaret").addEventListener("click", (e) => { e.stopPropagation(); $("cafPop").classList.contains("show") ? closeCafPop() : openCafPop(); });
$("cafPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  // Sub-controls rebuild the popover (fillCafPop), which detaches the clicked
  // node — so stop the event before it reaches the document outside-click
  // handler, which would then see a detached target and close the popover.
  const dur = t.closest<HTMLElement>("[data-cafdur]");
  if (dur) { e.stopPropagation(); cafSetDuration(+dur.dataset.cafdur!); return; } // keep open — sub-control
  if (t.closest("[data-cafawait]")) { e.stopPropagation(); cafSetAwait(!cafAgentsAwait); return; } // keep open — sub-control
  const b = t.closest<HTMLElement>("[data-caf]");
  if (!b) return;
  const id = b.dataset.caf!;
  if (id === "off") cafStop(); else cafPick(id);
  closeCafPop();
});

// Reactor click → jump straight to the longest-waiting session, or open a picker
// if several need you.
$("attnBadge").addEventListener("click", () => {
  const list = needsYouSessions();
  if (list.length === 0) return;
  if (list.length === 1) { setActive(list[0].id); closeAttnPop(); return; }
  $("attnPop").classList.contains("show") ? closeAttnPop() : openAttnPop(list);
});

$("kbar").addEventListener("click", openPalette);
$("themeBtn").addEventListener("click", toggleTheme);
$("setBtn").addEventListener("click", () => openSettings());
$("railCollapse").addEventListener("click", toggleRail);
$("railSort").addEventListener("click", cycleSort);
$("inspBtn").addEventListener("click", toggleInsp);
// The active project context is either a Muster session or an external one.
function activeProjectCtx(): { project: string; path: string } | null {
  // For an external session use its repo root, not the worktree cwd, so launching a
  // session / opening a worktree from it operates on the repo (and groups under it).
  if (activeExtId) { const e = externals.find((x) => x.session_id === activeExtId); if (e) { const root = e.repo_root || e.cwd; return { project: basename(root), path: root }; } }
  const s = activeId ? sessions.get(activeId) : null;
  return s ? { project: s.project, path: s.colorKey } : null;
}
// The active session's *actual* cwd (the worktree dir for worktree sessions, not
// the color-grouping repo key) — used when opening a plain terminal there.
function activeCwd(): string | null {
  if (activeExtId) { const e = externals.find((x) => x.session_id === activeExtId); return e ? e.cwd : null; }
  const s = activeId ? sessions.get(activeId) : null;
  return s ? s.workdir : null;
}
// Open a plain (non-Claude) terminal at the active project's cwd for running shell
// commands alongside a session. When the launch engine is "embedded" it opens an
// in-app shell pane (like a session); otherwise it opens the external terminal app.
function openPlainTerminal() {
  const wd = activeCwd();
  if (!wd) { toast("No active session"); return; }
  if (termEngine !== "embedded") { invoke("open_terminal_here", { workdir: wd, engine: termEngine }).catch((e) => toast("terminal: " + e)); return; }
  // Inherit the active session's repo grouping so a shell opened in a worktree nests
  // under its repo (as a worktree cluster) rather than appearing as its own project.
  // The active session/external always shares the shell's cwd, so it labels the cluster.
  const s = activeId ? sessions.get(activeId) : null;
  const e = activeExtId ? externals.find((x) => x.session_id === activeExtId) : undefined;
  const colorKey = s ? s.colorKey : e ? (e.repo_root || e.cwd) : wd;
  const worktree = s ? s.worktree : e ? (e.repo_root && e.cwd !== e.repo_root ? (e.branch || basename(e.cwd)) : null) : null;
  const branch = s ? s.branch : (e?.branch || "");
  launchShell(s ? s.project : basename(colorKey), wd, { colorKey, worktree, branch });
}
// ---------- the ▶ Run picker ----------
// A popover over the stage, grouped by source so it's obvious where each task came
// from. Blocked runnables stay visible but greyed: hiding them reads as "Muster
// didn't find my task", which is the more expensive confusion.
let runCtx: { project: string; colorKey: string; worktree: string | null; branch: string; workdir: string } | null = null;
let runList: Runnable[] = [];
let runSel = 0;

function runTargetCtx() {
  const wd = activeCwd();
  if (!wd) return null;
  const s = activeId ? sessions.get(activeId) : null;
  const e = activeExtId ? externals.find((x) => x.session_id === activeExtId) : undefined;
  return {
    workdir: wd,
    project: s ? s.project : e ? basename(e.repo_root || e.cwd) : basename(wd),
    colorKey: s ? s.colorKey : e ? (e.repo_root || e.cwd) : wd,
    worktree: s ? s.worktree : null,
    branch: s ? s.branch : (e?.branch || ""),
  };
}

async function openRunPicker() {
  const c = runTargetCtx();
  if (!c) { toast("No active project"); return; }
  runCtx = { project: c.project, colorKey: c.colorKey, worktree: c.worktree, branch: c.branch, workdir: c.workdir };
  runList = await discoverTasks(c.workdir, c.colorKey);
  runSel = 0;
  $("runSub").textContent = `${c.project}${c.worktree ? " · ⑃ " + c.branch : ""} · ${tilde(c.workdir)}`;
  const pop = $("runPop");
  pop.classList.add("show");
  $("scrim").classList.add("show");
  renderRunPicker("");
  const inp = $("runInput") as HTMLInputElement;
  inp.value = "";
  setTimeout(() => inp.focus(), 20);
}
function closeRunPicker() {
  $("runPop").classList.remove("show");
  if (!$("palette").classList.contains("show")) $("scrim").classList.remove("show");
  runCtx = null;
}

// Pinned first (they're the ones you run fifty times a day), then by source.
function runGroups(term: string): { name: string; items: Runnable[] }[] {
  const t = term.trim().toLowerCase();
  const match = (r: Runnable) => !t || r.label.toLowerCase().includes(t) || execCmd(r).toLowerCase().includes(t) || (r.group || "").includes(t);
  const list = runList.filter(match);
  const pins = runCtx ? pinnedIds(runCtx.colorKey) : [];
  const groups: { name: string; items: Runnable[] }[] = [];
  const pinned = list.filter((r) => pins.includes(r.id));
  if (pinned.length) groups.push({ name: "pinned", items: pinned });
  const bySource = new Map<string, Runnable[]>();
  for (const r of list) {
    if (pins.includes(r.id)) continue;
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r);
  }
  const SOURCE_LABEL: Record<string, string> = { muster: ".muster/tasks.toml", npm: "package.json" };
  for (const [src, items] of bySource) groups.push({ name: SOURCE_LABEL[src] || src, items });
  return groups;
}

function renderRunPicker(term: string) {
  const groups = runGroups(term);
  const flat = groups.flatMap((g) => g.items);
  if (runSel >= flat.length) runSel = Math.max(0, flat.length - 1);
  const body = $("runList");
  if (!flat.length) {
    body.innerHTML = runList.length
      ? `<div class="run-empty">Nothing matches “${esc(term)}”.</div>`
      : `<div class="run-empty">No tasks found in this project.<br><span class="dim">Muster reads <code>package.json</code> scripts and <code>.muster/tasks.toml</code>.</span></div>`;
    return;
  }
  let i = 0;
  body.innerHTML = groups.map((g) => {
    const rows = g.items.map((r) => {
      const on = i === runSel ? " on" : "";
      const idx = i++;
      const pinned = runCtx && pinnedIds(runCtx.colorKey).includes(r.id);
      return `<div class="run-row${on}${r.blocked ? " blocked" : ""}" data-i="${idx}" title="${esc(r.blocked || execCmd(r))}">
        <span class="ic">${r.blocked ? "⃠" : "▸"}</span>
        <span class="txt"><b>${esc(r.label)}</b><small>${esc(r.detail || execCmd(r))}</small></span>
        <span class="end">${r.blocked ? esc(r.blocked) : r.background ? "bg" : pinned ? "★" : ""}</span>
      </div>`;
    }).join("");
    return `<div class="run-grp">${esc(g.name)}</div>${rows}`;
  }).join("");
  body.querySelectorAll<HTMLElement>(".run-row").forEach((el) => {
    el.addEventListener("click", () => { runSel = +el.dataset.i!; pickRun(false); });
  });
  body.querySelector(".run-row.on")?.scrollIntoView({ block: "nearest" });
}

function pickRun(pin: boolean) {
  const flat = runGroups(($("runInput") as HTMLInputElement).value).flatMap((g) => g.items);
  const r = flat[runSel];
  if (!r || !runCtx) return;
  if (pin) { togglePin(runCtx.colorKey, r.id); renderRunPicker(($("runInput") as HTMLInputElement).value); return; }
  // The trust gate is the one blocked row you can act on: choosing it asks for
  // permission rather than shrugging.
  if (r.id === "just:__untrusted") { void askTrust(runCtx.colorKey, runCtx.project); return; }
  if (r.blocked) { toast(`${r.label}: ${r.blocked}`); return; }
  const ctx = runCtx;
  closeRunPicker();
  bumpFrec("task:" + r.id);
  const o = { colorKey: ctx.colorKey, worktree: ctx.worktree, branch: ctx.branch, discoveredIn: ctx.workdir };
  if (r.inputs.length) { openInputPrompt(r, ctx.project, o); return; }
  void launchTask(r, ctx.project, o);
}

// Trusting a folder means Muster may execute code from it to enumerate tasks, so
// it is asked for plainly and once, never inferred from mere use.
async function askTrust(path: string, project: string) {
  const ok = await ask(
    `Muster will run \`just --dump\` inside ${project} to list its recipes.\n\n`
    + `That evaluates the justfile, which can execute code from this folder. Only do this for projects you trust.`,
    { title: `Trust ${project}?`, kind: "warning", okLabel: "Trust and rescan", cancelLabel: "Cancel" });
  if (!ok) return;
  trustProject(path);
  dlog("info", `trusted ${path}`);
  await openRunPicker();
}

// Hand a command over to a terminal at `workdir` instead of running it ourselves.
// The embedded engine can genuinely prefill: it opens a shell pane and types the
// command *without* a newline, so the user reads it and presses Enter. External
// terminal apps take a directory but no pending input, so there we open the
// terminal and put the command on the clipboard — honest about the extra paste.
async function handToTerminal(project: string, workdir: string, cmd: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}) {
  if (termEngine === "embedded") {
    const id = await launchShell(project, workdir, opts);
    // The login shell needs a moment before its prompt will accept input.
    setTimeout(() => { void invoke("write_pty", { sessionId: id, data: cmd }).catch(() => {}); }, 600);
    toast("Prefilled in a shell — press Enter to run");
    return;
  }
  try { await navigator.clipboard.writeText(cmd); } catch { /* clipboard denied — the toast still names the command */ }
  invoke("open_terminal_here", { workdir, engine: termEngine })
    .then(() => toast("Terminal opened — command copied: " + cmd))
    .catch((e) => toast("terminal: " + e));
}

// Which session (if any) has a git action in flight — the buttons grey out while
// it runs, since fetch/pull/push can take seconds against a slow remote.
let gitBusy: string | null = null;
// Run fetch/pull/push for a session's workdir. A refusal is not an error: the
// backend declines the cases it can't finish safely and names the command that
// would work, which we offer as a terminal handoff rather than a dead end.
async function runGit(sessionId: string, op: string) {
  const s = sessions.get(sessionId);
  if (!s || gitBusy) return;
  gitBusy = sessionId;
  // Only ever paint the inspector when this session still owns it: the palette can
  // fire a git action at a background session, and a terminal handoff switches the
  // active session to the new shell mid-run.
  const repaint = () => { if (activeId === s.id && !activeExtId) renderInspector(s); };
  repaint();
  try {
    const r = await invoke<GitActionResult>("git_action", { workdir: s.workdir, op });
    dlog(r.ok ? "info" : "warn", `git ${op} · ${s.project} · ${r.summary}`);
    if (r.ok) {
      toast(`${op}: ${r.summary}`);
    } else if (r.suggest) {
      // Keep the toast clickable-adjacent: say what blocked it, then hand it over.
      toast(`${op}: ${r.summary} → opening a terminal`);
      await handToTerminal(s.project, s.workdir, r.suggest, { colorKey: s.colorKey, worktree: s.worktree, branch: s.branch });
    } else {
      toast(`${op}: ${r.summary}`);
    }
  } catch (e) {
    dlog("error", `git ${op} failed: ${e}`);
    toast(`git ${op}: ${e}`);
  } finally {
    gitBusy = null;
    void refreshSessionStats(s);   // ahead/behind moved — re-read it
    void refreshBranch(s).then((changed) => { if (changed) renderAll(); });
    repaint();
  }
}

// A plain login shell in an embedded xterm pane — no Claude, no telemetry.
// Returns the new session id so a caller can write into the shell (see handToTerminal).
async function launchShell(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  // Group by the repo root (opts.colorKey), not the raw cwd, so a shell opened in a
  // worktree nests under its repo instead of becoming a standalone top-level project.
  const colorKey = opts.colorKey ?? workdir;
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: true, scrollback: 8000,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  loadWebgl(term);
  term.open(pane);
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  term.attachCustomKeyEventHandler(macShellKeys(id)); // Terminal.app-style ⌥/⌘ nav for the shell
  const s: Sess = {
    id, project, accent: accentFor(colorKey), workdir, colorKey, branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "shell",
    phase: "idle", phaseSince: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
    lastEvent: "", activity: [],
    kind: "shell", external: false, term, fit, pane,
  };
  sessions.set(id, s);
  setActive(id);
  dlog("info", `shell ${project} · ${id.slice(0, 8)}`);
  try {
    await invoke("spawn_shell", { sessionId: id, workdir, rows: term.rows || 24, cols: term.cols || 80 });
  } catch (e) {
    dlog("error", `shell launch failed: ${e}`);
    toast("shell failed: " + e);
    term.writeln(`\r\n\x1b[31m[shell error] ${e}\x1b[0m`);
  }
  renderAll();
  return id;
}
// "+ Session" starts a session in the current project (offering a worktree if it
// already has one). With no active session there's no project context → palette.
$("btnNew").addEventListener("click", () => {
  const c = activeProjectCtx();
  if (c) requestLaunch(c.project, c.path); else openPalette();
});
$("btnWorktree").addEventListener("click", () => { const c = activeProjectCtx(); if (!c) { toast("No active session"); return; } openWt(c.project, c.path, false); });
$("btnTerm").addEventListener("click", openPlainTerminal);
$("btnRun").addEventListener("click", () => { void openRunPicker(); });
$("inCancel").addEventListener("click", closeInputPrompt);
$("inGo").addEventListener("click", submitInputPrompt);
$("inBody").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); submitInputPrompt(); }
  else if (e.key === "Escape") { e.preventDefault(); closeInputPrompt(); }
});
$("setClose").addEventListener("click", closeSettings);
$("runInput").addEventListener("input", () => { runSel = 0; renderRunPicker(($("runInput") as HTMLInputElement).value); });
$("runInput").addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const flat = runGroups(($("runInput") as HTMLInputElement).value).flatMap((g) => g.items);
  if (e.key === "ArrowDown") { e.preventDefault(); runSel = Math.min(runSel + 1, flat.length - 1); renderRunPicker(($("runInput") as HTMLInputElement).value); }
  else if (e.key === "ArrowUp") { e.preventDefault(); runSel = Math.max(runSel - 1, 0); renderRunPicker(($("runInput") as HTMLInputElement).value); }
  else if (e.key === "Enter") { e.preventDefault(); pickRun(meta); }
  else if (meta && e.key.toLowerCase() === "r") { e.preventDefault(); void openRunPicker(); }
  else if (e.key === "Escape") { e.preventDefault(); closeRunPicker(); }
});
$("fRepo").addEventListener("click", (e) => { e.preventDefault(); openUrl("https://github.com/respeak-io/muster").catch(() => {}); });
$("fEngineSeg").addEventListener("click", (e) => { e.stopPropagation(); $("enginePop").classList.contains("show") ? closeEnginePop() : openEnginePopover(); });
$("btnClose").addEventListener("click", () => { if (activeId) closeSession(activeId); });
$("wtGo").addEventListener("click", wtCreate);
$("wtCancel").addEventListener("click", closeWt);
$("wtMain").addEventListener("click", () => { if (!wtCtx) return; const { project, repoDir } = wtCtx; closeWt(); launch(project, repoDir, { colorKey: repoDir }); });
$("wtBranch").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); wtCreate(); } else if (e.key === "Escape") closeWt(); });
$("scrim").addEventListener("click", () => { closePalette(); closeWt(); closeDiff(); closeRunPicker(); closeInputPrompt(); closeSettings(); });
$("diffClose").addEventListener("click", closeDiff);
// Collapse / expand a file section by clicking its header.
$("diffBody").addEventListener("click", (e) => {
  const h = (e.target as HTMLElement).closest<HTMLElement>("[data-dtoggle]");
  if (h) h.parentElement!.classList.toggle("collapsed");
});
$("palInput").addEventListener("input", refreshPal);
$("palInput").addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const val = ($("palInput") as HTMLInputElement).value;
  if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palFlat.length - 1); renderPal(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPal(); }
  else if (e.key === "Enter") { e.preventDefault(); runPalItem(palFlat[palSel]); }
  else if (meta && e.key.toLowerCase() === "k") {
    // ⌘K on a session opens its action panel; otherwise swallow it so the global
    // handler doesn't close the palette out from under an open action list.
    e.preventDefault(); e.stopPropagation();
    const it = palFlat[palSel];
    if (palPage === "root" && it?.session) openPalActions(it.session);
  }
  else if (e.key === "Backspace" && !val && palPage === "actions") { e.preventDefault(); popPalPage(); }
  else if (e.key === "Escape") { if (palPage === "actions") { e.preventDefault(); popPalPage(); } else closePalette(); }
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
  else if (meta && e.key === ",") { e.preventDefault(); $("setDlg").classList.contains("show") ? closeSettings() : openSettings(); }
  else if (meta && e.key.toLowerCase() === "r" && !$("runPop").classList.contains("show")) { e.preventDefault(); void openRunPicker(); }
  else if (e.key === "Escape" && diffOpen) { e.preventDefault(); closeDiff(); }
  else if (e.key === "Escape" && $("setDlg").classList.contains("show")) { e.preventDefault(); closeSettings(); }
});
new ResizeObserver(() => refit()).observe($("terminals"));

// show the running app's version (from tauri.conf.json) in the footer, so it's
// clear which build is installed after an update.
getVersion().then((v) => { appVersion = v; $("fVer").textContent = "v" + v; }).catch(() => {});

// ---------- app self-update (Tauri updater plugin) ----------
// Checks the latest GitHub release (respeak-io/muster) for a newer Muster.
// Installing an update RESTARTS the app, which kills every live PTY/Claude
// session — so we never auto-install: the update surfaces as a footer chip and
// a one-time toast, and only downloads + relaunches after an explicit,
// session-count-aware confirmation. Clicking the version label re-checks.
let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null;
let updateBusy = false;

async function checkForUpdates(manual: boolean) {
  if (updateBusy) return;
  try {
    const upd = await check();
    pendingUpdate = upd;
    const chip = $("fUpdate");
    if (upd) {
      chip.textContent = `⇧ update to v${upd.version}`;
      chip.hidden = false;
      dlog("info", `update available: v${upd.version}`);
      if (manual) toast(`Muster v${upd.version} is available`);
    } else {
      chip.hidden = true;
      if (manual) toast("You're on the latest version");
    }
  } catch (e) {
    const msg = String(e);
    // The update manifest (latest.json) may not list this platform yet — e.g. no
    // Windows release has been published. The updater reports that as "None of the
    // fallback platforms [...] were found in the response platforms object". That's
    // "no update for this platform", not a failure — surface it quietly.
    if (msg.includes("were found in the response")) {
      $("fUpdate").hidden = true;
      dlog("info", "no update published for this platform yet");
      if (manual) toast("No update published for this platform yet");
      return;
    }
    dlog("error", `update check failed: ${msg}`);
    if (manual) toast("Update check failed — see debug console");
  }
}

async function runUpdate() {
  if (!pendingUpdate || updateBusy) return;
  const live = [...sessions.values()].filter((s) => !s.external).length;
  const warn = live
    ? `Muster will download v${pendingUpdate.version}, close ${live} running session${live === 1 ? "" : "s"}, and restart.`
    : `Muster will download v${pendingUpdate.version} and restart.`;
  const ok = await ask(`${warn}\n\nContinue?`, {
    title: "Update Muster",
    kind: "warning",
    okLabel: "Update & restart",
    cancelLabel: "Not now",
  });
  if (!ok) return;
  updateBusy = true;
  try {
    toast(`Downloading v${pendingUpdate.version}…`);
    await pendingUpdate.downloadAndInstall((ev) => {
      if (ev.event === "Finished") toast("Installing update…");
    });
    await relaunch();
  } catch (e) {
    updateBusy = false;
    dlog("error", `update install failed: ${String(e)}`);
    toast("Update failed — see debug console");
  }
}

$("fUpdate").addEventListener("click", runUpdate);
$("fVer").addEventListener("click", () => checkForUpdates(true));
// quiet check on launch, once the app has settled.
setTimeout(() => checkForUpdates(false), 3000);
// "Check for Updates…" in the menu-bar menu. Without this the only checks are the
// one at launch and the easily-missed click on the version label, so a long-running
// Muster never learns about a release until it's restarted. Manual → it reports
// either way ("you're on the latest version"), so the menu item always answers.
listen("tray-check-updates", () => { void checkForUpdates(true); });

// Cmd+Q guard. Cmd+Q is bound to our own menu item in the backend (macOS doesn't
// reliably surface the OS quit as a Tauri event — see tauri#9198), so the keystroke
// arrives here as `quit-requested` rather than tearing the app down. We only nag
// when something would actually be lost — an idle Muster quits immediately, keeping
// the Cmd+Q muscle memory intact.
listen("quit-requested", async () => {
  const live = [...sessions.values()].filter((s) => s.phase !== "ended");
  const agents = live.filter((s) => isAgent(s)).length;
  const terms = live.filter((s) => s.kind === "shell").length;
  const runs = live.filter((s) => s.kind === "task").length;
  const total = agents + terms + runs;
  if (total === 0) { await invoke("confirm_quit"); return; }
  const parts: string[] = [];
  if (agents) parts.push(`${agents} running ${agents === 1 ? "session" : "sessions"}`);
  if (terms) parts.push(`${terms} ${terms === 1 ? "terminal" : "terminals"}`);
  if (runs) parts.push(`${runs} ${runs === 1 ? "task" : "tasks"}`);
  const ok = await ask(`${listPhrase(parts)} still running — quitting ends ${total === 1 ? "it" : "them"}.`, {
    title: "Quit Muster?",
    kind: "warning",
    okLabel: "Quit",
    cancelLabel: "Cancel",
  });
  if (ok) await invoke("confirm_quit");
});

// ---------- debug console wiring ----------
$("dbgBtn").addEventListener("click", () => toggleDbg());
$("dbgClose").addEventListener("click", () => toggleDbg(false));
$("dbgClear").addEventListener("click", () => { dbgLog.length = 0; telem.rx = telem.routed = telem.dropped = 0; renderDbgBadge(); renderDbgPanel(); });
$("dbgCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(dbgSnapshot(), null, 2)); toast("Debug snapshot copied"); } catch { toast("copy failed"); }
});
// surface uncaught JS errors in the console so they're visible (and land in the file)
window.addEventListener("error", (e) => dlog("error", `js error: ${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => dlog("error", `unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`));
dlog("info", "app started");
flushDebug();
setInterval(flushDebug, 4000);

// scour each known project for a favicon/logo once, so the sidebar shows real icons
FAVORITES.forEach((f) => probeIcon(f.path));

// discover which external terminals are installed, so the footer/palette only
// offers ones that actually work (embedded is always available).
invoke<string[]>("available_terminals").then((ids) => {
  availEngines = ALL_ENGINES.map((e) => e.id).filter((id) => id === "embedded" || ids.includes(id));
  if (!availEngines.includes(termEngine)) { termEngine = "embedded"; localStorage.setItem("cc-term-engine", termEngine); }
  renderFoot();
}).catch(() => {});

// keep rate-limit reset countdowns fresh (and flip a maxed meter back to 0 once
// its window resets) even when no new telemetry is arriving.
setInterval(() => {
  if (activeExtId) return; // the external mirror manages its own refresh
  const s = activeId ? sessions.get(activeId) ?? null : null;
  renderInspector(s);
  renderFoot();
}, 30000);

// Tick the inspector's dwell / wait clocks every second WITHOUT a full re-render —
// a targeted textContent update on #iDwell, so the heartbeat animation isn't reset
// each second (innerHTML replacement restarts CSS animations). This is the one
// place we deviate from the render-everything pattern, and it's why the pulse is
// smooth while "waiting 3:40" counts up live.
setInterval(() => {
  if (activeExtId) return;
  const s = activeId ? sessions.get(activeId) ?? null : null;
  if (!s || !isAgent(s)) return;
  const el = document.getElementById("iDwell");
  if (el) el.textContent = dwellText(s);
}, 1000);

// Refresh the active session's working-set diff + CPU/RAM on a slow cadence.
setInterval(() => {
  if (activeExtId) return;
  const s = activeId ? sessions.get(activeId) ?? null : null;
  if (s) void refreshSessionStats(s);
}, 4000);

// discover Claude Code sessions running outside Muster and keep them fresh.
refreshExternals();
setInterval(refreshExternals, 3000);

// keep the sidebar's "uncommitted changes" dot (and the external diff card) honest
// for every project at once — s.git alone only covers the active session.
refreshDirtyStates();
setInterval(refreshDirtyStates, 5000);

// keep each session's branch label honest — re-read the real HEAD so switching
// branches inside a session (or a worktree) is reflected instead of the stale
// creation-time name.
setInterval(refreshBranches, 4000);

setSort(sortMode, false); // paint the sort button's glyph/title for the persisted mode
initProjectDnD();
// No `caffeinate` on Windows — drop the control rather than leave a button whose
// every click reports an error. Its listeners stay wired but unreachable.
if (IS_WINDOWS) $("caf").style.display = "none";
// caffeinate always starts off (its -w guard died with the last run); renderAll's
// reconcileCaf() paints the button. Note this is the ONE place agent-mode could
// auto-assert on launch — but cafArmed is false at boot, so it stays dormant.
renderAll();
