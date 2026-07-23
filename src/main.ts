import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
// Platform-aware shortcut hints. Display only: the key handlers already accept
// both modifiers (`e.metaKey || e.ctrlKey`), so only the glyphs differ per OS.
const IS_MAC = navigator.userAgent.includes("Mac");
const MOD = IS_MAC ? "⌘" : "Ctrl";
/** Inline chord text: "⌘K" on macOS, "Ctrl+K" elsewhere. */
const chord = (k: string) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);
// index.html hard-codes the mac glyphs; rewrite its static bits once on other
// platforms (everything rendered from TS goes through MOD/chord instead).
if (!IS_MAC) {
  document.querySelectorAll("kbd").forEach((k) => { if (k.textContent === "⌘") k.textContent = "Ctrl"; });
  document.querySelectorAll<HTMLElement>("[title]").forEach((el) => { if (el.title.includes("⌘")) el.title = el.title.replace(/⌘/g, "Ctrl+"); });
  const fk = document.querySelector(".fseg.fk");
  if (fk) fk.textContent = `${chord("K")} · ${chord("1")}–9 switch · ${chord("B")} sidebar · ${chord("I")} inspector · ${chord("±")} font`;
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

// Persisted theme override (cc-theme). Absent → follow the OS via the CSS
// `color-scheme` default; an explicit value pins light/dark across restarts.
// Applied here at module start (before first paint) so the settings choice sticks.
{
  const savedTheme = localStorage.getItem("cc-theme");
  if (savedTheme === "dark" || savedTheme === "light") document.documentElement.setAttribute("data-theme", savedTheme);
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
// Dev affordance until the settings window ships: episkoWtGroup("chip") in the console.
(window as unknown as { episkoWtGroup: typeof setWtGroup }).episkoWtGroup = setWtGroup;
// While a project group is being dragged, renderSidebar() must not rebuild the
// #projects DOM — doing so would destroy the node the browser is dragging,
// killing the drop. Telemetry ticks call renderAll() constantly, so this guard
// is what makes reordering actually work during live sessions.
let draggingProjects = false;
// Set just after a pointer-driven reorder (see initProjectDnD): swallows the click a
// pointerup may synthesise, so a drag that ends on a project doesn't also select it.
let reorderGuardUntil = 0;
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
interface Sess {
  id: string; project: string; accent: string; workdir: string; colorKey: string;
  // resumeId = the id `claude --resume` must target. It starts equal to `id` (we
  // launch with --session-id id) but tracks Claude's *runtime* id, which rotates
  // on /clear, /compact and /resume — each rotation opening a NEW transcript file.
  // Restoring `id` after a compaction would resurrect the pre-compaction thread.
  resumeId: string;
  branch: string; worktree: string | null; title: string;
  phase: Phase; phaseSince: number; lastActivity: number; attention: string | null; pendingCmd: string; pendingPermId: string | null; pendRisk: Risk | null; subagents: number;
  model: string; ctxPct: number | null; ctxTokens: number | null; cost: number | null; durMs: number | null;
  curTool: string; curArg: string; todos: Todo[];
  ctxHist: number[]; costHist: number[]; git: DiffStat | null; res: { cpu: number; memMb: number } | null;
  lastEvent: string; activity: Act[];
  external: boolean; shell?: boolean; term?: Terminal; fit?: FitAddon; pane: HTMLElement;
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
  // A session opened before the font arrived had its cell width measured against
  // the *fallback* metrics, so its column count (and the size we spawned Claude at)
  // is slightly off and stays off until the next resize. Re-fit now that the real
  // font's metrics are in, so the PTY width matches what we actually render.
  refit();
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

// ---------- Usage-limit forecast ----------
// A percentage alone can't tell you if you're in trouble: 62% burning fast is a
// lockout, 68% sitting flat is fine. So we sample the (merged, monotonic) used-%
// over time, estimate a burn rate, extrapolate it to the window's reset, and turn
// that into a green/amber/red verdict. Samples are in-memory per app run — burn is
// "unknown" until we've seen >=2 readings spanning a little time, and until then we
// colour by level alone rather than invent a slope from a single reading.
const H5_LEN = 5 * 3600, D7_LEN = 7 * 86400; // window lengths, seconds
type RlWin = "h5" | "d7";
interface RlSample { t: number; pct: number }
const rlSamples: Record<RlWin, RlSample[]> = { h5: [], d7: [] };
// look = how far back the slope is measured; minSpan = least span we'll trust.
const BURN_CFG: Record<RlWin, { look: number; minSpan: number }> = {
  h5: { look: 30 * 60_000, minSpan: 3 * 60_000 },
  d7: { look: 6 * 3_600_000, minSpan: 15 * 60_000 },
};
function pushRlSample(win: RlWin, pct: number | null) {
  if (pct == null) return;
  const buf = rlSamples[win], now = Date.now(), last = buf[buf.length - 1];
  if (last && now - last.t < 10_000 && pct === last.pct) return; // nothing new to record
  buf.push({ t: now, pct });
  const cutoff = now - BURN_CFG[win].look;
  while (buf.length > 2 && buf[0].t < cutoff) buf.shift();
}
// %/hour at the recent pace, or null when there isn't enough to trust one.
function burnRate(win: RlWin): number | null {
  const buf = rlSamples[win];
  if (buf.length < 2) return null;
  const a = buf[0], b = buf[buf.length - 1], spanMs = b.t - a.t;
  if (spanMs < BURN_CFG[win].minSpan) return null;
  return Math.max(0, (b.pct - a.pct) / (spanMs / 3_600_000)); // usage only climbs; clamp jitter
}

type FcStatus = "ok" | "warn" | "bad";
interface Forecast {
  status: FcStatus; used: number | null; proj: number | null;
  etaSec: number | null; secLeft: number | null; resetTs: number | null;
  runsOut: boolean; hasRate: boolean;
}
function forecastWin(pct: number | null, reset: number | null, burnPerHr: number | null): Forecast {
  const used = rlPct(pct, reset);
  const resetTs = rlReset(reset);
  const secLeft = resetTs != null ? Math.max(0, resetTs - Math.floor(Date.now() / 1000)) : null;
  if (used == null) return { status: "ok", used: null, proj: null, etaSec: null, secLeft, resetTs, runsOut: false, hasRate: false };
  // No trustworthy slope yet, or no active window → judge by level alone (treat as flat).
  if (burnPerHr == null || secLeft == null) {
    const status: FcStatus = used >= 100 ? "bad" : used >= 85 ? "warn" : "ok";
    return { status, used, proj: used, etaSec: null, secLeft, resetTs, runsOut: used >= 100, hasRate: false };
  }
  const hLeft = secLeft / 3600;
  const proj = used + burnPerHr * hLeft;
  const etaHr = burnPerHr > 1e-6 ? (100 - used) / burnPerHr : Infinity; // hours until 100%
  const runsOut = used >= 100 || etaHr <= hLeft;
  const status: FcStatus = runsOut ? "bad" : (proj >= 80 || used >= 85) ? "warn" : "ok";
  return { status, used, proj, etaSec: isFinite(etaHr) ? etaHr * 3600 : null, secLeft, resetTs, runsOut, hasRate: true };
}
const forecast5h = (): Forecast => forecastWin(rl.h5, rl.h5Reset, burnRate("h5"));
const forecast7d = (): Forecast => forecastWin(rl.d7, rl.d7Reset, burnRate("d7"));

// ---- forecast-vs-actual log: the substrate that makes the model improvable ----
// On every window rotation we record what the closing window actually reached vs.
// what we'd projected at its halfway mark. Purely a measurement store for now
// (localStorage, capped) — nothing consumes it yet; it's what a future threshold-
// calibration / error-band pass reads. Expensive to backfill, cheap to keep.
interface FcLogEntry { w: RlWin; closed: number; final: number; midProj: number | null; err: number | null }
const fcLog: FcLogEntry[] = JSON.parse(localStorage.getItem("cc-forecast-log") || "[]");
const midSnap: Record<RlWin, { proj: number } | null> = { h5: null, d7: null };
function maybeMidSnap(win: RlWin, reset: number | null) {
  if (midSnap[win] || reset == null) return;
  const len = win === "h5" ? H5_LEN : D7_LEN;
  if (reset - Date.now() / 1000 > len / 2) return; // not yet past the halfway mark
  const f = win === "h5" ? forecast5h() : forecast7d();
  if (f.hasRate && f.proj != null) midSnap[win] = { proj: f.proj };
}
function logWindowClose(win: RlWin, finalPct: number | null) {
  if (typeof finalPct !== "number") return;
  const snap = midSnap[win];
  const e: FcLogEntry = {
    w: win, closed: Math.floor(Date.now() / 1000), final: finalPct,
    midProj: snap ? snap.proj : null, err: snap ? finalPct - snap.proj : null,
  };
  fcLog.push(e);
  if (fcLog.length > 200) fcLog.splice(0, fcLog.length - 200);
  localStorage.setItem("cc-forecast-log", JSON.stringify(fcLog));
  dlog("info", `forecast · ${win} window closed at ${Math.round(finalPct)}%` +
    (snap ? ` (predicted ~${Math.round(snap.proj)}%, err ${e.err! >= 0 ? "+" : ""}${Math.round(e.err!)})` : ""));
}
// Called after each merge with the pre/post reset so we can spot a window rotation
// (a genuinely later resets_at). On rotation the old window closed: log how it went,
// and clear the burn samples so the new window's slope starts clean.
function onRlUpdate(win: RlWin, prevPct: number | null, prevReset: number | null, newReset: number | null) {
  if (newReset != null && prevReset != null && newReset > prevReset + 120) {
    logWindowClose(win, prevPct);
    rlSamples[win] = [];
    midSnap[win] = null;
  }
  pushRlSample(win, rlPct(win === "h5" ? rl.h5 : rl.d7, newReset));
  maybeMidSnap(win, newReset);
}

// Claude Code sessions started OUTSIDE Episko (a plain terminal, an IDE). We
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

// ---------- restorable sessions ----------
// Episko's launch uuid IS Claude's --session-id, so every session we launch already
// has a transcript at ~/.claude/projects/<enc(workdir)>/<id>.jsonl. Restoring is
// therefore not about capturing conversation state — Claude already has it — but
// about remembering which sessions were on screen at quit, and with what identity.
interface Restorable {
  id: string;          // the original launch uuid (roster key, stable across restarts)
  resumeId: string;    // what to hand `claude --resume`
  project: string; workdir: string; colorKey: string;
  worktree: string | null; branch: string;
  title: string;       // last known label; refreshed from the transcript on load
  lastActivity: number;
}
let dormants: Restorable[] = [];

// The roster is "what was open when Episko last closed". Closing a session removes
// it — an explicit close means done, so only survivors come back. Shell panes are
// excluded: a login shell has no transcript and nothing to resume.
function rosterEntry(s: Sess): Restorable {
  return {
    id: s.id, resumeId: s.resumeId || s.id, project: s.project, workdir: s.workdir,
    colorKey: s.colorKey, worktree: s.worktree, branch: s.branch,
    title: s.title, lastActivity: s.lastActivity,
  };
}
function saveRoster() {
  const open = [...sessions.values()].filter((s) => !s.shell && s.workdir).map(rosterEntry);
  // Dormant rows the user hasn't dismissed stay on the roster, so a restart that
  // restores only some of them doesn't quietly discard the rest.
  const live = new Set(open.map((r) => r.id));
  const keep = dormants.filter((d) => !live.has(d.id));
  localStorage.setItem("cc-restore", JSON.stringify([...open, ...keep].slice(0, 60)));
}
// Debounced, but with a ceiling: a busy session emits telemetry continuously, and a
// pure trailing debounce would reset forever and never write at all. Force a save
// once the roster has been stale for MAX_STALE regardless of how noisy it is.
let rosterTimer: number | undefined;
let rosterSavedAt = Date.now();
const ROSTER_MAX_STALE = 20000;
function queueRosterSave() {
  if (Date.now() - rosterSavedAt > ROSTER_MAX_STALE) { flushRoster(); return; }
  clearTimeout(rosterTimer);
  rosterTimer = window.setTimeout(flushRoster, 1500);
}
function flushRoster() { clearTimeout(rosterTimer); rosterSavedAt = Date.now(); saveRoster(); }
// The stage shows exactly ONE thing: a live Episko session (activeId), a live
// external session mirrored read-only, or a dormant session restorable from a past
// run. Holding the two read-only kinds in a single discriminated pointer — rather
// than a flag per kind — is what stops them fighting over the stage on the next
// render tick (see the note in renderAll).
//
// The "ext" kind also carries the session's `pid`, because its `id` is Claude's
// runtime session_id and that ROTATES on /clear, /compact and /resume. The pid is
// what stays stable, so refreshExternals re-binds through it instead of dropping
// the selection (which used to silently jump the sidebar to an unrelated session).
// Same rule as Sess.resumeId and the telemetry path: hold the stable handle.
let mirror: { kind: "ext"; id: string; pid: number } | { kind: "past"; id: string } | null = null;
const extMirrorId = (): string | null => (mirror?.kind === "ext" ? mirror.id : null);
const extMirrorPid = (): number | null => (mirror?.kind === "ext" ? mirror.pid : null);
const pastMirrorId = (): string | null => (mirror?.kind === "past" ? mirror.id : null);
let extTranscriptTimer: number | undefined;
const extWorking = (e: ExtSession) => !!e.status && !["idle", "sleeping", "done", ""].includes(e.status);

// Uncommitted git state keyed by folder (a session's workdir or an external's cwd),
// polled by refreshDirtyStates. It's the single source of truth for the sidebar's
// "has changes" dot and the external inspector's diff card: s.git only stays fresh
// for the *active* session, so nothing else can rely on it across every project.
const dirtyByFolder = new Map<string, DiffStat | null>();
const isDirty = (g?: DiffStat | null): boolean => !!g && (g.files > 0 || g.untracked > 0);
const folderDirty = (f: string): boolean => isDirty(dirtyByFolder.get(f));

// The three Claude models collapse to a family so cost splits by tier, not by the
// exact display name ("Opus 4.8", "Sonnet 4.5", …) which changes across releases.
function modelFamily(m: string): string {
  const s = (m || "").toLowerCase();
  if (s.includes("opus")) return "Opus";
  if (s.includes("sonnet")) return "Sonnet";
  if (s.includes("haiku")) return "Haiku";
  return m ? "Other" : "Unknown";
}

// Persisted daily usage rollup (survives app + system restarts). `cc-usage` is the
// authoritative per-day *total* cost — untouched here so the footer keeps working —
// and `cc-usage-detail` layers on the per-model / per-project split + session ids,
// which the Usage analytics tab reads. The split is telemetry-only, so it records
// from the day this ships forward; the totals (and the transcript-scanned tokens)
// still carry full history. See the Usage panel section below.
interface DayDetail { models: Record<string, number>; projects: Record<string, number>; sessions: string[] }
const usage: Record<string, number> = JSON.parse(localStorage.getItem("cc-usage") || "{}");
const usageDetail: Record<string, DayDetail> = JSON.parse(localStorage.getItem("cc-usage-detail") || "{}");
function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function addUsage(delta: number, s?: Sess) {
  if (!(delta > 0)) return;
  const k = todayKey();
  usage[k] = (usage[k] || 0) + delta;
  localStorage.setItem("cc-usage", JSON.stringify(usage));
  if (!s || s.shell) return;
  // Attribute the cost delta to whichever model is active right now and to the
  // session's project — the closest honest split the statusLine data allows.
  const d = usageDetail[k] || (usageDetail[k] = { models: {}, projects: {}, sessions: [] });
  const fam = modelFamily(s.model);
  d.models[fam] = (d.models[fam] || 0) + delta;
  const proj = s.project || basename(s.workdir) || "unknown";
  d.projects[proj] = (d.projects[proj] || 0) + delta;
  if (s.id && !d.sessions.includes(s.id)) d.sessions.push(s.id);
  localStorage.setItem("cc-usage-detail", JSON.stringify(usageDetail));
}

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
// A logo the user picked by hand. Kept in its own key — and consulted first — so
// that neither a re-probe nor an ICON_CACHE_VERSION bump can overwrite a
// deliberate choice with whatever discovery happens to find.
const customIcons: Record<string, string> = JSON.parse(localStorage.getItem("cc-custom-icons") || "{}");
function saveCustomIcons() { localStorage.setItem("cc-custom-icons", JSON.stringify(customIcons)); }
function iconFor(key: string): string | null { const v = customIcons[key] || icons[key]; return v ? v : null; }
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
// "Use the color dot instead" — drops the hand-picked logo *and* marks discovery
// as "probed, none", so the row falls back to its accent dot and stays there.
function clearIcon(key: string) {
  delete customIcons[key]; saveCustomIcons();
  icons[key] = ""; saveIcons();
  renderSidebar(); renderMini();
}
// Pick an image file to use as this project's glyph, in place of whatever the
// backend scoured out of the repo (or the color dot, when it found nothing).
async function pickCustomIcon(key: string) {
  const file = await open({
    multiple: false,
    title: `Logo for ${basename(key)}`,
    defaultPath: key,
    filters: [{ name: "Images", extensions: ["png", "svg", "ico", "jpg", "jpeg", "webp", "gif"] }],
  });
  if (!file || typeof file !== "string") return;
  try {
    const r = await invoke<{ data_uri: string }>("read_custom_icon", { path: file });
    customIcons[key] = r.data_uri;
    saveCustomIcons();
    renderSidebar(); renderMini();
    toast(`Logo set for ${basename(key)}`);
  } catch (e) { toast(String(e)); }
}
// Forget the hand-picked logo and let discovery have another go at the repo.
function resetCustomIcon(key: string) {
  delete customIcons[key]; saveCustomIcons();
  delete icons[key]; saveIcons();
  probeIcon(key); // re-probes, then renders
  renderSidebar(); renderMini();
}
async function openProjectFolder(key: string) {
  try { await invoke("open_folder", { dir: key }); }
  catch (e) { toast(String(e)); }
}
function projGlyph(key: string, accent: string): string {
  const ic = iconFor(key);
  return ic
    ? `<img class="picon" src="${ic}" alt="" title="${esc(basename(key))} — right-click for project actions" />`
    : `<span class="pdot" title="Click to recolor · right-click for project actions" style="background:${accent};color:${accent}"></span>`;
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
async function launch(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string; resume?: string } = {}) {
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
    pane.innerHTML = `<div class="ext-pane"><div class="ext-logo"></div><h2>Running in ${esc(eng.label)}</h2><p>${esc(project)}${opts.worktree ? " · " + esc(opts.worktree) : ""} — the terminal is in your ${esc(eng.label)} window.<br>Episko still tracks its status, cost &amp; context here.</p></div>`;
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
    id, project, accent, workdir, colorKey, resumeId: opts.resume ?? id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "",
    phase: "idle", phaseSince: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
    lastEvent: "", activity: [], external, term, fit, pane,
  };
  sessions.set(id, s);
  term?.onTitleChange((t) => {
    const c = cleanTitle(t, s);
    if (c !== s.title) { s.title = c; renderSidebar(); if (activeId === id) renderHeader(s); }
  });
  setActive(id);
  // A restored session takes over its roster entry: drop the dormant row so the
  // sidebar doesn't show the same conversation twice, live and dormant.
  if (opts.resume) dormants = dormants.filter((d) => d.resumeId !== opts.resume);
  queueRosterSave();
  dlog("info", `${opts.resume ? "resume" : "launch"} ${project} · ${id.slice(0, 8)} · ${termEngine}${opts.worktree ? " · worktree" : ""}${opts.resume ? ` · from ${opts.resume.slice(0, 8)}` : ""}`);

  try {
    if (termEngine === "ghostty") await invoke("spawn_ghostty", { sessionId: id, workdir, accent, title: project, resume: opts.resume ?? null });
    else if (external) await invoke("spawn_external_terminal", { sessionId: id, workdir, engine: termEngine, title: project, resume: opts.resume ?? null });
    else await invoke("spawn_claude", { sessionId: id, workdir, rows: term!.rows || 24, cols: term!.cols || 80, resume: opts.resume ?? null });
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
// Deliberately synchronous: NOTHING may be awaited before the dialog is on screen.
// This used to `await git_branch` first, and because Tauri runs non-async commands on
// the main thread, that one call queued behind whatever git work was already in flight
// (the 3s/4s/5s pollers, or worse a `fetch`) — so "+ Session" felt dead for as long as
// that took. Everything needed to decide is already in memory:
//   • a live session in this repo carries `branch` (set at launch, refreshed every 4s)
//   • an external session carries the branch the registry reported
//   • dirtyByFolder holds a non-null diffstat for anything that IS a git repo
// so repo-ness and the branch label both come for free, with zero IPC.
function requestLaunch(project: string, path: string) {
  // "Is anything already running here?" must include EXTERNAL sessions: they live in
  // their own array, not in `sessions`, so checking only the map sent a click straight
  // to a bare launch in the repo root even when the dialog was the obvious answer.
  const sess = [...sessions.values()].find((s) => s.colorKey === path);
  const ext = externals.find((e) => (e.repo_root || e.cwd) === path);
  if (sess || ext) {
    const branch = sess?.branch || ext?.branch || "";
    // Only offer the worktree dialog for an actual repo — otherwise there is nothing
    // to branch and a plain launch is the honest answer, exactly as before.
    if (branch || dirtyByFolder.get(path) != null) { openWt(project, path, branch); return; }
  }
  launch(project, path, { colorKey: path });
}

async function addProject() {
  const dir = await open({ directory: true, multiple: false, title: "Add a project folder" });
  if (!dir || typeof dir !== "string") return;
  addProjectPath(dir);
}
// Pin a folder to the sidebar. Also reachable from the context menu of a folder
// Episko knows about but hasn't been asked to keep (an external session's cwd).
function addProjectPath(dir: string) {
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
  flushRoster(); // an explicit close means done — it should not come back on restart
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
    fitSession(s);
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
  if (s.shell || s.external) return;
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
  if (sig(s.git, s.res) !== before && activeId === s.id && !extMirrorId()) renderInspector(s);
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
    if (extMirrorId()) {
      // Re-resolve the mirrored session. If its id rotated (/clear·/compact·/resume
      // rewrite ~/.claude/sessions/<pid>.json with a new session_id), re-bind by the
      // stable pid instead of dropping the selection — otherwise the sidebar silently
      // jumps to an unrelated session (and e.g. the ❯ Terminal button then targets it).
      const pid = extMirrorPid();
      const e = externals.find((x) => x.session_id === extMirrorId())
        ?? (pid != null ? externals.find((x) => x.pid === pid) : undefined);
      if (e) {
        mirror = { kind: "ext", id: e.session_id, pid: e.pid };
        renderExtHeader(e); renderExtInspector(e);
      } else {
        // Truly gone — fall back to an Episko session or the empty state.
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
  for (const s of sessions.values()) if (!s.shell && s.workdir) folders.add(s.workdir);
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
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); if (e) renderExtInspector(e); }
}
function openExternal(sid: string) {
  const e = externals.find((x) => x.session_id === sid);
  if (!e) return;
  mirror = { kind: "ext", id: sid, pid: e.pid };
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
    const cur = externals.find((x) => x.session_id === extMirrorId());
    if (cur) loadTranscript(cur, false);
  }, 2500);
}
function closeExternalView() {
  if (mirror == null) return;
  mirror = null;   // clears the ext pid with it — one pointer, one lifetime
  clearInterval(extTranscriptTimer);
  ($("extPane") as HTMLElement).hidden = true;
}
// ---------- dormant (restorable) sessions ----------
// Clicking a dormant row mirrors its transcript read-only — the same pane an
// external session uses — so the user can confirm *which* conversation this is
// before deciding to bring it back.
function openDormant(id: string) {
  const d = dormants.find((x) => x.id === id);
  if (!d) return;
  mirror = { kind: "past", id };
  activeId = null;
  for (const x of sessions.values()) x.pane.classList.remove("active");
  ($("empty") as HTMLElement).style.display = "none";
  ($("extPane") as HTMLElement).hidden = false;
  clearInterval(extTranscriptTimer); // a finished transcript doesn't grow — no polling
  document.documentElement.style.setProperty("--accent", accentFor(d.colorKey));
  renderPastHeader(d); renderPastInspector(d); renderSidebar(); renderMini(); renderFoot();
  $("extBody").innerHTML = `<div class="ext-empty">Loading transcript…</div>`;
  loadTranscriptInto(d.workdir, d.resumeId, true, () => pastMirrorId() === id);
}
function renderPastHeader(d: Restorable) {
  ($("btnClose") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = d.project;
  const hb = $("hBranch"); hb.textContent = "restorable"; hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = d.title || "";
  $("hPath").textContent = tilde(d.workdir);
}
function renderPastInspector(d: Restorable) {
  const busy = dormantBusy(d);
  const pill = $("iPill"); pill.className = "pill idle";
  $("iPillTxt").textContent = "not running";
  const action = busy
    ? `<div class="ext-note warn">This session is running right now — in Episko or another terminal. Resuming it a second time would interleave both conversations into one transcript, so it can't be restored until the other one exits.</div>`
    : `<button class="ext-jump-btn" data-resume="${esc(d.id)}">⟲ Resume this session</button>
       <div class="ext-note">Claude picks the conversation back up where it left off. It may offer to compact the context first — that's normal for a long session.</div>`;
  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">· From your last run</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(d.project)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="mono ell">${esc(tilde(d.workdir))}</span></div>
      ${d.branch ? `<div class="ext-meta"><span class="label">Branch</span><span>${esc(d.branch)}</span></div>` : ""}
      <div class="ext-meta"><span class="label">Last active</span><span>${esc(relTime(d.lastActivity))}</span></div>
      <div class="ext-meta"><span class="label">Session</span><span class="mono">${esc(d.resumeId.slice(0, 8))}</span></div>
      ${action}
      <button class="ext-forget-btn" data-forget="${esc(d.id)}">Remove from list</button>
      <div class="ext-note">Removing only clears this row from Episko. The conversation stays on disk — <span class="mono">/resume</span> inside any Claude session in this folder always lists them all.</div>
    </div>`;
}
function resumeDormant(id: string) {
  const d = dormants.find((x) => x.id === id);
  if (!d) return;
  if (dormantBusy(d)) { toast("That session is already running"); return; }
  closeExternalView();
  launch(d.project, d.workdir, { colorKey: d.colorKey, worktree: d.worktree, branch: d.branch, resume: d.resumeId });
}
function forgetDormant(id: string) {
  dormants = dormants.filter((x) => x.id !== id);
  if (pastMirrorId() === id) {
    closeExternalView();
    const next = orderedSessions()[0];
    if (next) setActive(next.id);
    else ($("empty") as HTMLElement).style.display = "grid";
  }
  flushRoster();
  renderAll();
}
// On boot: reconcile the roster against what Claude actually has on disk. An entry
// with no transcript can't be resumed — a session launched but never prompted never
// writes one — so it's dropped rather than shown as a row that would fail on click.
// Titles are refreshed from disk too: `ai-title` beats our in-memory OSC title and,
// unlike it, exists for sessions launched into an external terminal.
async function loadDormants() {
  let roster: Restorable[] = [];
  try { roster = JSON.parse(localStorage.getItem("cc-restore") || "[]") || []; } catch { roster = []; }
  if (!Array.isArray(roster) || !roster.length) return;
  const live = new Set([...sessions.keys()]);
  const byDir = new Map<string, Restorable[]>();
  for (const r of roster) {
    if (!r || typeof r.id !== "string" || typeof r.workdir !== "string" || !r.workdir) continue;
    if (live.has(r.id)) continue;
    if (!r.resumeId) r.resumeId = r.id;
    const arr = byDir.get(r.workdir);
    if (arr) arr.push(r); else byDir.set(r.workdir, [r]);
  }
  const found: Restorable[] = [];
  await Promise.all([...byDir.entries()].map(async ([workdir, entries]) => {
    const past = await invoke<{ session_id: string; title: string; mtime: number }[]>("list_past_sessions", { workdir }).catch(() => []);
    const byId = new Map(past.map((p) => [p.session_id.toLowerCase(), p]));
    for (const r of entries) {
      const hit = byId.get(r.resumeId.toLowerCase());
      if (!hit) continue; // no transcript → nothing to resume
      found.push({ ...r, title: hit.title || r.title || "", lastActivity: hit.mtime ? hit.mtime * 1000 : r.lastActivity });
    }
  }));
  found.sort((a, b) => b.lastActivity - a.lastActivity);
  dormants = found;
  if (dormants.length) dlog("info", `${dormants.length} restorable session${dormants.length === 1 ? "" : "s"} from a previous run`);
  flushRoster();
  renderAll();
}
function jumpExternal(pid: number) {
  invoke("focus_external_session", { pid }).catch((e) => toast("jump failed: " + e));
}
async function loadTranscript(e: ExtSession, initial: boolean) {
  await loadTranscriptInto(e.cwd, e.session_id, initial, () => extMirrorId() === e.session_id);
}
// `stillCurrent` is re-checked after the await: the user can click away mid-flight,
// and a late reply must not paint over whatever mirror is on the stage by then.
async function loadTranscriptInto(cwd: string, sessionId: string, initial: boolean, stillCurrent: () => boolean) {
  try {
    const msgs = await invoke<{ role: string; text: string }[]>("read_transcript", { cwd, sessionId, limit: 80 });
    if (!stillCurrent()) return;
    renderTranscript(msgs, initial);
  } catch (err) {
    if (stillCurrent()) $("extBody").innerHTML = `<div class="ext-empty">Couldn't read the transcript.<br><span class="mono">${esc(String(err))}</span></div>`;
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
// Episko session's, minus the fetch/pull/push row (we don't drive this checkout).
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
      <div class="ext-hl">↗ Running outside Episko</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(basename(e.cwd))}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="mono ell">${esc(tilde(e.cwd))}</span></div>
      <div class="ext-meta"><span class="label">Status</span><span>${esc(e.status || "idle")}</span></div>
      <div class="ext-meta"><span class="label">Started</span><span>${esc(started)}</span></div>
      <div class="ext-meta"><span class="label">Claude</span><span>${e.version ? "v" + esc(e.version) : "–"}</span></div>
      <div class="ext-meta"><span class="label">PID</span><span class="mono">${e.pid}</span></div>
      <button class="ext-jump-btn" data-jump="${e.pid}">↗ Jump to its terminal</button>
      <div class="ext-note">Episko can't drive this session — it was launched in another terminal. The panel on the left is a live read-only mirror of its transcript.</div>
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
// user answers via Episko's buttons and when they answer directly in the CLI (in
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
  if (typeof cost === "number") { addUsage(cost - (s.cost ?? 0), s); s.cost = cost; pushHist(s.costHist, cost); }
  const dur = data.cost?.total_duration_ms; if (typeof dur === "number") s.durMs = dur;
  const r5 = data.rate_limits?.five_hour;
  if (r5) {
    const p = rl.h5, pr = rl.h5Reset;
    [rl.h5, rl.h5Reset] = mergeRl(rl.h5, rl.h5Reset, r5.used_percentage, r5.resets_at);
    onRlUpdate("h5", p, pr, rl.h5Reset);
  }
  const r7 = data.rate_limits?.seven_day;
  if (r7) {
    const p = rl.d7, pr = rl.d7Reset;
    [rl.d7, rl.d7Reset] = mergeRl(rl.d7, rl.d7Reset, r7.used_percentage, r7.resets_at);
    onRlUpdate("d7", p, pr, rl.d7Reset);
  }
  // Keep the worktree flag if the statusline reports one, but the branch label
  // itself comes from the live git HEAD poll (refreshBranches), not this field —
  // otherwise the two fight and the label flickers.
  const wt = data.workspace?.git_worktree; if (wt) s.worktree = wt;
}

// ---------- rendering ----------
// `dormants` are restorable-from-last-run rows. They hang off the project group
// rather than the worktree clusters: a dormant session has no live checkout state
// to cluster by, and pinning them below the live rows keeps the distinction between
// "running now" and "was running before" visually obvious.
interface ProjGroup { name: string; path: string; accent: string; sessions: Sess[]; externals: ExtSession[]; dormants: Restorable[]; wtBranch?: string }
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
    for (const c of wts) out.push({ name: p.name, path: c.key, accent: p.accent, sessions: c.sessions, externals: c.externals, dormants: [], wtBranch: c.branch });
  }
  return out;
}
// Every project Episko knows about: the favourites, plus any repo discovered from a
// live session, an external (non-Episko) session, or a dormant one. Unsorted and never
// worktree-split — callers that need order or splitting layer it on.
//
// The sidebar and the launch palette MUST agree on this set. Building the palette from
// FAVORITES alone silently hid every externally-detected project, so pressing
// "+ Session" with nothing selected offered an arbitrary-looking subset of what the
// sidebar was showing.
function allProjects(): ProjGroup[] {
  const list: ProjGroup[] = FAVORITES.map((f) => ({ name: f.name, path: f.path, accent: accentFor(f.path), sessions: [], externals: [], dormants: [] }));
  const byName = new Map(list.map((p) => [p.name, p]));
  const byPath = new Map(list.map((p) => [p.path, p]));
  for (const s of sessions.values()) {
    let p = byName.get(s.project) || byPath.get(s.colorKey);
    if (!p) { p = { name: s.project, path: s.colorKey, accent: accentFor(s.colorKey), sessions: [], externals: [], dormants: [] }; list.push(p); byName.set(s.project, p); byPath.set(s.colorKey, p); }
    p.sessions.push(s);
  }
  for (const e of externals) {
    // Group by the repo's main worktree, not the raw cwd, so every worktree of one
    // repo lands under it (and merges into that repo's favourite when paths match).
    const key = e.repo_root || e.cwd;
    let p = byPath.get(key);
    if (!p) { p = { name: basename(key), path: key, accent: accentFor(key), sessions: [], externals: [], dormants: [] }; list.push(p); byPath.set(key, p); byName.set(p.name, p); }
    p.externals.push(e);
  }
  for (const d of dormants) {
    let p = byName.get(d.project) || byPath.get(d.colorKey);
    if (!p) { p = { name: d.project, path: d.colorKey, accent: accentFor(d.colorKey), sessions: [], externals: [], dormants: [] }; list.push(p); byName.set(d.project, p); byPath.set(d.colorKey, p); }
    p.dormants.push(d);
  }
  return list;
}
function projectList(): ProjGroup[] {
  const list = allProjects();
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
  if (s.shell) return 6;
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
  const label = s.title || (s.worktree ? `⑃ ${s.branch}` : (s.branch || "session"));
  // shells have no telemetry phase — show a terminal prompt glyph (a dot once exited)
  const glyph = s.shell ? (s.phase === "ended" ? GLYPH.ended : "❯") : GLYPH[k];
  const gcls = s.shell ? (s.phase === "ended" ? GCLASS.ended : "g-idle") : GCLASS[k];
  const chipHtml = chip
    ? `<span class="chip" style="--wtc:${branchHue(chip)}"><span class="fork">⑃</span><span class="lbl">${esc(chip.branch)}</span></span>`
    : "";
  return `<div class="srow${chip ? " o3" : ""} ${s.id === activeId ? "active" : ""}" data-sel="${s.id}">
    <span class="sglyph ${gcls}">${glyph}</span>
    <span class="sbranch" title="${esc(label)}">${esc(label)}</span>${chipHtml}
    <span class="sctx">${s.ctxPct != null ? Math.round(s.ctxPct) + "%" : ""}</span>
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
// Dormant rows always sit below the live ones, outside any worktree cluster.
function dormantRows(p: ProjGroup): string {
  return p.dormants.map((d) => dormantRow(d)).join("");
}
function dormantRow(d: Restorable): string {
  const busy = dormantBusy(d);
  const label = d.title || (d.worktree ? `⑃ ${d.branch}` : d.branch) || "session";
  const when = relTime(d.lastActivity);
  const tip = busy
    ? "This session is running somewhere else right now — resuming it would interleave both transcripts"
    : `Restore this session · last active ${when}`;
  return `<div class="srow pastrow${busy ? " busy" : ""} ${d.id === pastMirrorId() ? "active" : ""}" data-past="${d.id}" data-key="${esc(d.colorKey)}" title="${esc(tip)}">
    <span class="sglyph g-ended">·</span>
    <span class="sbranch">${esc(label)}</span>
    <span class="past-tag">${busy ? "busy" : when}</span>
    <span class="sclose" data-forget="${d.id}" title="Remove from list — the conversation stays on disk">✕</span></div>`;
}
// A session that's live right now must not be offered for restore: Claude doesn't
// lock the transcript, so a second --resume of the same id silently interleaves
// both conversations into one file.
function dormantBusy(d: Restorable): boolean {
  for (const s of sessions.values()) if (s.resumeId === d.resumeId || s.id === d.id) return true;
  return externals.some((e) => e.session_id === d.resumeId);
}
function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (!(ms > 0) || d < 0) return "—";
  const m = Math.round(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function extRow(e: ExtSession, chip?: WtCluster): string {
  const working = extWorking(e);
  const chipHtml = chip
    ? `<span class="chip" style="--wtc:${branchHue(chip)}"><span class="fork">⑃</span><span class="lbl">${esc(chip.branch)}</span></span>`
    : "";
  return `<div class="srow extrow${chip ? " o3e" : ""} ${e.session_id === extMirrorId() ? "active" : ""}" data-ext="${e.session_id}" data-key="${esc(e.cwd)}">
    <span class="sglyph ${working ? "g-work" : "g-idle"}">${working ? "●" : "○"}</span>
    <span class="sbranch">${esc(e.name || basename(e.cwd))}</span>${chipHtml}
    <span class="ext-tag" title="Running outside Episko · Claude v${esc(e.version)} · pid ${e.pid}">ext</span>
    <span class="sjump" data-jump="${e.pid}" title="Jump to its terminal ↗">↗</span></div>`;
}
function renderSidebar() {
  // Don't stomp the DOM the browser is mid-drag on — see draggingProjects.
  if (draggingProjects) return;
  $("projects").innerHTML = projectList().map((p) => {
    const rows = groupBody(p) + dormantRows(p);
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
      // discovered via an external session or a restorable one only — not a saved project
      const tail = p.externals.length
        ? `<span class="pcount ext">${p.externals.length} ext</span>`
        : `<span class="pcount ext">${p.dormants.length} past</span>`;
      head = `<div class="phead ext-only" data-key="${esc(p.path)}" title="${esc(tilde(p.path))}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span>${dot}${tail}<span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}" title="Launch an Episko session here">＋</span></div>`;
    }
    return `<div class="pgroup" data-path="${esc(p.path)}">${head}${rows ? `<div class="psessions">${rows}</div>` : ""}</div>`;
  }).join("");
}
// Reordering of project groups, on pointer events (not HTML5 drag). The window now
// sets dragDropEnabled:true so external file drops paste a path instead of navigating
// the webview (see initFileDrop) — but that native handler blocks HTML5 drag/drop, so
// the reorder can no longer ride dragstart/dragover/drop. Pointer events are also fully
// cross-platform (the old HTML5 path only worked with dragDropEnabled:false).
//
// Delegated on the persistent #projects container so it survives re-renders; a
// separator line (.dropmark) shows where the group will land; the dragged group is only
// physically moved on release, then the DOM order is read back and saved. A drag only
// begins once the pointer crosses DRAG_SLOP, so a plain click still selects the project.
function initProjectDnD() {
  const container = $("projects");
  const DRAG_SLOP = 5; // px before a press becomes a drag rather than a click
  const marker = document.createElement("div");
  marker.className = "dropmark";
  let dragEl: HTMLElement | null = null;      // the group actually being dragged
  let candidate: HTMLElement | null = null;   // pressed group, promoted to dragEl past the slop
  let startX = 0, startY = 0;

  const cleanup = () => {
    marker.remove();
    container.classList.remove("reordering");
    dragEl?.classList.remove("dragging");
    dragEl = candidate = null;
    draggingProjects = false;
  };

  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const t = e.target as HTMLElement;
    // Leave the interactive bits (launch +, remove ✕, colour dot) to their own clicks.
    if (t.closest(".padd, .plaunch, .premove, .pdot, .pdirty")) return;
    const g = t.closest<HTMLElement>(".pgroup");
    if (!g) return;
    candidate = g;
    startX = e.clientX; startY = e.clientY;
  });

  container.addEventListener("pointermove", (e) => {
    if (!candidate) return;
    if (!dragEl) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP) return;
      // Cross the slop → promote to a real drag.
      dragEl = candidate;
      draggingProjects = true;
      container.classList.add("reordering");
      dragEl.classList.add("dragging");
      try { container.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    e.preventDefault();
    // Place the marker relative to whichever group the pointer is over.
    const over = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const grp = over?.closest<HTMLElement>(".pgroup");
    if (!grp || grp === dragEl) return;
    const r = grp.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    container.insertBefore(marker, after ? grp.nextSibling : grp);
  });

  const finish = (e: PointerEvent) => {
    try { container.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (!dragEl) { candidate = null; return; } // never crossed the slop: it was a click
    if (marker.parentNode) container.insertBefore(dragEl, marker);
    cleanup();
    projOrder = [...container.querySelectorAll<HTMLElement>(".pgroup")].map((el) => el.dataset.path!).filter(Boolean);
    saveProjOrder();
    // A manual drag captures the current visual order and reasserts manual mode
    // (in a sorted mode the drag would otherwise be immediately overridden).
    if (sortMode !== "manual") setSort("manual", false);
    // A pointerup *may* synthesise a click (if the browser still pairs it with the
    // pointerdown after the DOM moved); guard the click handler for a brief window so
    // the reorder doesn't also select. A plain timestamp self-heals if no click fires —
    // a lingering one-shot listener would otherwise eat the user's next real click.
    reorderGuardUntil = performance.now() + 250;
    renderAll();
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", (e) => { try { container.releasePointerCapture(e.pointerId); } catch { /* */ } cleanup(); });
}

// External file drops. With dragDropEnabled:true the webview no longer navigates to a
// dropped file's file:// URL (the old trap: a dropped PDF replaced the whole app with no
// way back). Tauri's native drag-drop event carries the real absolute paths, which HTML5
// drops never expose under WKWebView — so we paste them, shell-escaped, into the active
// embedded session's PTY, matching what dragging a file into a normal terminal does.
function initFileDrop() {
  const zone = $("terminals");
  getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") zone.classList.add("dropping");
    else zone.classList.remove("dropping");
    if (p.type !== "drop") return;
    const paths = p.paths || [];
    if (!paths.length) return;
    const s = activeId ? sessions.get(activeId) : null;
    if (!s || s.external || !s.term) { toast("Drop files onto an embedded session's console to paste their paths"); return; }
    const text = paths.map(shellEscapePath).join(" ") + " ";
    invoke("write_pty", { sessionId: s.id, data: text });
    s.term.focus();
    dlog("info", `dropped ${paths.length} path${paths.length === 1 ? "" : "s"} into ${s.id.slice(0, 8)}`);
  }).catch((err) => dlog("error", `onDragDropEvent wiring failed: ${err}`));
}

// Escape a path for a shell/REPL the way a terminal does on file drop: backslash before
// anything outside the always-safe set, so spaces and metacharacters survive as one arg.
function shellEscapePath(p: string): string {
  return p.replace(/[^A-Za-z0-9_@%+=:,./-]/g, "\\$&");
}
function renderMini() {
  const activeProj = activeId ? sessions.get(activeId)?.project : null;
  $("railmini").innerHTML =
    `<button class="rm-btn" data-rail="1" title="Expand sidebar (${chord("B")})">»</button>` +
    projectList().map((p) => {
      const first = p.sessions[0];
      const firstExt = p.externals[0];
      const attn = p.sessions.some((s) => s.attention || s.phase === "error");
      const sel = first ? `data-sel="${first.id}"`
        : firstExt ? `data-ext="${firstExt.session_id}"`
        : `data-launch="${esc(p.path)}" data-proj="${esc(p.name)}"`;
      const ic = iconFor(p.path);
      const glyph = ic ? `<img class="rm-icon" src="${ic}" alt="" />` : `<span class="rm-dot"></span>`;
      const onCls = p.name === activeProj || (extMirrorId() && p.externals.some((e) => e.session_id === extMirrorId())) ? "on" : "";
      const extOnly = !first && firstExt ? "ext" : "";
      return `<button class="rm-proj ${onCls} ${extOnly}" style="--rc:${p.accent}" title="${esc(p.name)}${extOnly ? " (external)" : ""}" data-key="${esc(p.path)}" ${sel}>${glyph}${attn ? '<span class="rm-badge"></span>' : ""}</button>`;
    }).join("") +
    `<button class="rm-btn rm-add" data-pal="1" title="New session (${chord("K")})">＋</button>`;
}
function renderHeader(s: Sess | null) {
  ($("btnClose") as HTMLButtonElement).hidden = !s;
  const hb = $("hBranch"); hb.classList.remove("ext-chip");
  if (!s) { $("hProj").textContent = "no session"; hb.hidden = true; $("hTitle").textContent = ""; $("hPath").textContent = ""; return; }
  $("hProj").textContent = s.project;
  if (s.shell) { hb.textContent = "shell"; hb.hidden = false; hb.classList.add("ext-chip"); }
  else if (s.branch) { hb.textContent = s.worktree ? "⑃ " + s.branch : s.branch; hb.hidden = false; } else hb.hidden = true;
  $("hTitle").textContent = s.shell ? "" : (s.title || "");
  $("hPath").textContent = tilde(s.workdir);
}
function fmtDur(ms: number) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${String(ss).padStart(2, "0")}s`;
}
// Absolute wall-clock time of a reset (epoch seconds) — "15:45" / "3:45 PM".
function fmtClock(ts: number): string { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
// Time remaining until a reset (epoch seconds) — "2h 10m" / "3d 4h". The weekly
// window can be days out, where fmtClock's time-of-day alone would be misleading.
function fmtUntil(ts: number): string {
  const s = Math.max(0, Math.floor(ts - Date.now() / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
// A raw duration (seconds) — "2h 10m" / "3d 4h" / "45m". Like fmtUntil but for a
// span we already hold, not a wall-clock target (used for forecast etas/headroom).
function fmtSpan(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
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
      <div class="ext-note">A regular login shell running inside Episko — no Claude, no telemetry. Handy for commands you don't want to run inside a session.</div>
    </div>`;
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
  const waiting = [...sessions.values()].filter((x) => x.phase === "done" && !x.shell && !x.attention);
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
// Keyed by folder (workdir/cwd), not session id, so the same viewer serves Episko's
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
// Several dialogs share the one #scrim, so closing any of them must only drop it
// once none of the others are still up.
const SCRIM_DLGS = ["palette", "wtDlg", "diffDlg", "setDlg"];
function dropScrim() {
  if (!SCRIM_DLGS.some((id) => $(id).classList.contains("show"))) $("scrim").classList.remove("show");
}
function closeDiff() {
  diffOpen = false;
  $("diffDlg").classList.remove("show");
  dropScrim();
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
  if (s?.shell) { renderShellInspector(s); return; }
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
  paintFootRl("fRl", "fRlReset", forecast5h());
  paintFootRl("fRl7", "fRl7Reset", forecast7d());
  $("fEngine").textContent = engineDef(termEngine).label;
  if ($("usagePop").classList.contains("show")) renderUsagePop();
}
// Colour the footer % by its forecast (not its raw level), and show a muted
// countdown to that window's reset beside it — see the forecast section above.
function paintFootRl(pctId: string, resetId: string, f: Forecast) {
  const pctEl = $(pctId), resetEl = $(resetId);
  pctEl.textContent = f.used != null ? Math.round(f.used) + "%" : "–";
  pctEl.className = f.used == null ? "" : "s-" + f.status; // neutral until we have a reading
  resetEl.textContent = f.resetTs != null ? "↻ " + fmtUntil(f.resetTs) : "";
}
// Plain-language forecast line for a window ("→ ~86% by reset" / "runs out …").
function foreText(f: Forecast): string {
  if (f.used == null) return "no reading yet";
  if (!f.hasRate) return f.secLeft == null ? "no active window" : "gathering pace…";
  if (f.runsOut && f.etaSec != null && f.secLeft != null)
    return `on pace to hit 100% in ${fmtSpan(f.etaSec)} — ${fmtSpan(f.secLeft - f.etaSec)} before reset`;
  return `at this pace → ~${Math.round(f.proj!)}% by reset`;
}
// The colour-coded verdict chip (empty until we have a trustworthy rate).
function verdictChip(f: Forecast): string {
  if (f.used == null || !f.hasRate) return "";
  if (f.status === "bad" && f.etaSec != null && f.secLeft != null)
    return `<span class="vchip s-bad">runs out ${fmtSpan(f.secLeft - f.etaSec)} early</span>`;
  if (f.status === "warn") return `<span class="vchip s-warn">tight</span>`;
  return `<span class="vchip s-ok">clear</span>`;
}
// One usage window (session/5h or weekly/7d): label, a dual-track meter (solid =
// used now, hatched = projected by reset), the forecast line, and the reset time.
function usageRow(label: string, sub: string, f: Forecast): string {
  const cls = f.used == null ? "" : "s-" + f.status;
  const pctTxt = f.used == null ? "–" : Math.round(f.used) + "%";
  const usedW = f.used == null ? 0 : Math.min(100, Math.max(0, f.used));
  const projW = f.proj == null ? usedW : Math.min(100, Math.max(0, f.proj));
  const ghostW = Math.max(0, projW - usedW);
  const resetTxt = f.resetTs != null
    ? `resets ${fmtClock(f.resetTs)} · in ${fmtUntil(f.resetTs)}`
    : (f.used == null ? "no reading yet" : "no active window");
  return `<div class="up-row">
    <div class="up-top"><span class="up-l">${label}</span><span class="up-sub">${sub}</span><span class="up-pct ${cls}">${pctTxt}</span></div>
    <div class="up-bar ${cls}"><i class="up-fill" style="width:${usedW}%"></i><i class="up-ghost" style="left:${usedW}%;width:${ghostW}%"></i></div>
    <div class="up-fore"><span>${foreText(f)}</span>${verdictChip(f)}</div>
    <div class="up-reset">${resetTxt}</div>
  </div>`;
}
function renderUsagePop() {
  const noData = rl.h5 == null && rl.d7 == null;
  $("usagePop").innerHTML = `<div class="up-h">Claude usage limits</div>
    ${usageRow("Session", "5-hour window", forecast5h())}
    ${usageRow("Weekly", "7-day window", forecast7d())}
    <div class="up-foot"><span>today <b>$${(usage[todayKey()] || 0).toFixed(2)}</b></span><span>${sessions.size} live · account-wide</span></div>
    ${noData ? `<div class="up-note">Appears once a running session reports a statusLine.</div>` : ""}`;
}
function openUsagePop() {
  const r = $("fUsageSeg").getBoundingClientRect();
  const pop = $("usagePop");
  renderUsagePop();
  closeFootMenus("usagePop");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
function closeUsagePop() { $("usagePop").classList.remove("show"); }

// ---------- Usage analytics (the Usage settings tab) ----------
// Money comes from the rollup above: full history for the daily *totals*, plus the
// per-model / per-project split from cc-usage-detail (recorded going forward). Tokens
// are the one figure telemetry can't give us, so they come from an async, cached scan
// of Claude's transcripts (`token_usage_by_day`) and fill in the moment it returns —
// the panel never blocks on the scan.
// One day's transcript-scanned usage: token totals (by type and by model family),
// distinct sessions active, and per-project token totals. Full history — unlike the
// telemetry-only $ split, which records forward from install.
interface DayUsage {
  day: string; input: number; output: number; cache_read: number; cache_write: number;
  opus: number; sonnet: number; haiku: number; other: number;
  sessions: number; projects: Record<string, number>;
}
type UDay = { key: string; cost: number; tok: number; u?: DayUsage };
let tokenDays: DayUsage[] = JSON.parse(localStorage.getItem("cc-usage-tokens") || "[]");
let tokenScanAt = +(localStorage.getItem("cc-usage-tokens-at") || 0);
let tokenScanning = false;
let usageRange = 30;
const USAGE_RANGES: [number, string][] = [[7, "7D"], [30, "30D"], [90, "90D"], [365, "12M"]];
const MODEL_ORDER = ["Opus", "Sonnet", "Haiku", "Other"];
const MODEL_VAR: Record<string, string> = { Opus: "--m-opus", Sonnet: "--m-sonnet", Haiku: "--m-haiku", Other: "--m-other" };
// Sum a day's per-model tokens into a fixed-key record (backfill fields are lowercase).
const uModels = (a: UDay[]): Record<string, number> => {
  const m: Record<string, number> = { Opus: 0, Sonnet: 0, Haiku: 0, Other: 0 };
  for (const d of a) if (d.u) { m.Opus += d.u.opus; m.Sonnet += d.u.sonnet; m.Haiku += d.u.haiku; m.Other += d.u.other; }
  return m;
};

// Scan the transcripts for token totals, at most once per 10 min (a full read of
// the recent corpus). Async + cached, so the tab paints instantly from localStorage
// and re-paints when fresh numbers land. `force` bypasses the throttle.
async function refreshTokens(force = false) {
  if (tokenScanning) return;
  if (!force && tokenDays.length && Date.now() - tokenScanAt < 6e5) return;
  tokenScanning = true;
  if (settingsOpen() && setTab === "usage") renderSettings(); // surface the "scanning…" hint
  try {
    tokenDays = await invoke<DayUsage[]>("token_usage_by_day", { days: 400 });
    tokenScanAt = Date.now();
    localStorage.setItem("cc-usage-tokens", JSON.stringify(tokenDays));
    localStorage.setItem("cc-usage-tokens-at", String(tokenScanAt));
  } catch (e) { dlog("warn", "token scan failed: " + e); }
  finally { tokenScanning = false; if (settingsOpen() && setTab === "usage") renderSettings(); }
}

const uUsd = (n: number) => n >= 10000 ? "$" + (n / 1000).toFixed(1) + "k" : "$" + Math.round(n).toLocaleString();
const uUsd2 = (n: number) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const uTok = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(Math.round(n));
const uDkey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const U_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const U_WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The last n calendar days ending today, oldest→newest, each joined to its cost,
// per-model/project detail and scanned token total.
function usageWindow(n: number): UDay[] {
  const tk = new Map(tokenDays.map((t) => [t.day, t]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out: UDay[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = uDkey(d); const t = tk.get(key);
    out.push({ key, cost: usage[key] || 0, tok: t ? t.input + t.output + t.cache_read + t.cache_write : 0, u: t });
  }
  return out;
}

// A smooth (Catmull-Rom) sparkline; long series are averaged down to ~22 points so
// a 90D/12M spark reads as a trend, not a jagged comb.
function uSpark(raw: number[], w = 64, h = 26): string {
  let series = raw;
  if (series.length > 22) {
    const size = Math.ceil(series.length / 22); const o: number[] = [];
    for (let i = 0; i < series.length; i += size) { const c = series.slice(i, i + size); o.push(c.reduce((s, v) => s + v, 0) / c.length); }
    series = o;
  }
  if (!series.length) return "";
  const max = Math.max(...series, 1), n = series.length, pad = 2.5;
  const pts = series.map((v, i) => [pad + (n <= 1 ? 0 : i / (n - 1)) * (w - pad * 2), h - pad - (v / max) * (h - pad * 2)]);
  let line = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    line += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  const lastX = pts[pts.length - 1][0].toFixed(2), firstX = pts[0][0].toFixed(2);
  return `<svg class="u-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${line} L${lastX},${h} L${firstX},${h} Z" fill="var(--accent)" opacity=".1"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/><circle cx="${lastX}" cy="${pts[pts.length - 1][1].toFixed(2)}" r="2" fill="var(--accent)"/></svg>`;
}

function uSum(a: UDay[], f: (d: UDay) => number): number { return a.reduce((s, d) => s + f(d), 0); }
function uDelta(cur: number, prev: number): string {
  if (prev <= 0) return `<span class="u-delta u-muted">new</span>`;
  const pct = Math.round((cur - prev) / prev * 100);
  return `<span class="u-delta"><span class="u-arw">${pct >= 0 ? "▲" : "▼"}</span><b>${Math.abs(pct)}%</b>&nbsp;vs&nbsp;prev</span>`;
}

function uTiles(): string {
  const all = usageWindow(usageRange * 2);
  const cur = all.slice(usageRange), prev = all.slice(0, usageRange);
  const mean = (a: UDay[], f: (d: UDay) => number) => a.length ? uSum(a, f) / a.length : 0;
  const sess = (a: UDay[]) => uSum(a, (d) => d.u ? d.u.sessions : 0);
  const spend = uSum(cur, (d) => d.cost), tok = uSum(cur, (d) => d.tok);
  const nSess = sess(cur), nPrev = sess(prev);
  const perSess = nSess ? tok / nSess : 0, perPrev = nPrev ? uSum(prev, (d) => d.tok) / nPrev : 0;
  const haveTok = tokenDays.length > 0; // the transcript scan populates tokens/sessions
  const tile = (label: string, val: string, foot: string, series: number[]) =>
    `<div class="u-tile"><div class="label">${label}</div><div class="u-fig mono">${val}</div><div class="u-tfoot">${foot}${uSpark(series)}</div></div>`;
  // Token/session tiles come from the (async) transcript scan: skeleton while it runs.
  const skel = `<span class="u-skel"></span>`;
  const scanFoot = `<span class="u-delta u-muted"><span class="u-spin"></span>scanning…</span>`;
  const noData = `<span class="u-delta u-muted">no data</span>`;
  const wait = (v: string, foot: string) => haveTok ? [v, foot] : [tokenScanning ? skel : "—", tokenScanning ? scanFoot : noData];
  const [tokV, tokF] = wait(uTok(tok), uDelta(mean(cur, (d) => d.tok), mean(prev, (d) => d.tok)));
  const [sesV, sesF] = wait(nSess.toLocaleString("en-US"), uDelta(nSess, nPrev));
  const [avgV, avgF] = wait(nSess ? uTok(perSess) : "—", nSess ? uDelta(perSess, perPrev) : noData);
  return `<div class="u-tiles">
    ${tile("Total spend", uUsd(spend), uDelta(mean(cur, (d) => d.cost), mean(prev, (d) => d.cost)), cur.map((d) => d.cost))}
    ${tile("Tokens processed", tokV, tokF, cur.map((d) => d.tok))}
    ${tile("Sessions", sesV, sesF, cur.map((d) => d.u ? d.u.sessions : 0))}
    ${tile("Avg / session", avgV, avgF, cur.map((d) => d.tok))}
  </div>`;
}

// The GitHub-style spend heatmap — full recorded history, range-independent.
function uHeatmap(): string {
  const DAY = 86400000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const nz = Object.values(usage).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => nz.length ? nz[Math.floor(p * (nz.length - 1))] : 0;
  const th = [q(0.20), q(0.40), q(0.62), q(0.84)];
  const level = (v: number) => v <= 0 ? 0 : v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : 4;
  const end = today.getTime() + (6 - today.getDay()) * DAY;
  const WEEKS = 53, start = end - (WEEKS * 7 - 1) * DAY;
  let months = "", cells = "", colMonth = -1, maxKey = "", maxCost = 0;
  for (let w = 0; w < WEEKS; w++) { const m = new Date(start + w * 7 * DAY).getMonth(); months += `<span>${m !== colMonth ? U_MONTHS[m] : ""}</span>`; if (m !== colMonth) colMonth = m; }
  for (let w = 0; w < WEEKS; w++) for (let r = 0; r < 7; r++) {
    const t = start + (w * 7 + r) * DAY;
    if (t > today.getTime()) { cells += `<i class="u-cell" style="visibility:hidden"></i>`; continue; }
    const d = new Date(t), key = uDkey(d), v = usage[key] || 0;
    if (v > maxCost) { maxCost = v; maxKey = key; }
    const head = `${U_WD[d.getDay()]}, ${U_MONTHS[d.getMonth()]} ${d.getDate()}`;
    cells += `<i class="u-cell l${level(v)}" data-tip="${esc(head + "||" + (v > 0 ? uUsd2(v) : "no sessions"))}"></i>`;
  }
  const active = nz.length;
  let busiest = "—";
  if (maxKey) { const d = new Date(maxKey + "T00:00:00"); busiest = `${U_MONTHS[d.getMonth()]} ${d.getDate()} · ${uUsd2(maxCost)}`; }
  return `<section class="u-card">
    <div class="u-cardh"><div><div class="label">Daily spend</div><h3 class="u-h">Last 12 months</h3>
      <p class="u-hint">Each square is a day — darker means a heavier bill.</p></div>
      <div class="u-scale">less<i style="background:var(--u-g0)"></i><i style="background:var(--u-g1)"></i><i style="background:var(--u-g2)"></i><i style="background:var(--u-g3)"></i><i style="background:var(--u-g4)"></i>more</div></div>
    <div class="u-calwrap"><div class="u-wd"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>
      <div><div class="u-months">${months}</div><div class="u-grid">${cells}</div></div></div>
    <div class="u-calfoot"><span>Busiest day <b>${busiest}</b></span><span><b>${active}</b> active days recorded</span></div>
  </section>`;
}

type UBucket = { label: string; tip: string; total: number; models: Record<string, number> };
function uBuckets(): UBucket[] {
  const cur = usageWindow(usageRange);
  const mk = (label: string, tip: string, days: UDay[]): UBucket => {
    const models = uModels(days);
    return { label, tip, total: models.Opus + models.Sonnet + models.Haiku + models.Other, models };
  };
  if (usageRange <= 31) return cur.map((d) => { const dt = new Date(d.key + "T00:00:00"); return mk(String(dt.getDate()), `${U_MONTHS[dt.getMonth()]} ${dt.getDate()}`, [d]); });
  if (usageRange === 90) {
    const out: UBucket[] = [];
    for (let i = 0; i < cur.length; i += 7) { const wk = cur.slice(i, i + 7); if (!wk.length) continue; const s = new Date(wk[0].key + "T00:00:00"); out.push(mk(`${s.getMonth() + 1}/${s.getDate()}`, `Week of ${U_MONTHS[s.getMonth()]} ${s.getDate()}`, wk)); }
    return out;
  }
  const by = new Map<string, UDay[]>();
  for (const d of cur) { const dt = new Date(d.key + "T00:00:00"); const k = dt.getFullYear() + "-" + dt.getMonth(); let arr = by.get(k); if (!arr) { arr = []; by.set(k, arr); } arr.push(d); }
  return [...by.values()].map((days) => { const dt = new Date(days[0].key + "T00:00:00"); return mk(U_MONTHS[dt.getMonth()], `${U_MONTHS[dt.getMonth()]} ${dt.getFullYear()}`, days); });
}

function uBars(): string {
  const data = uBuckets();
  const max = Math.max(...data.map((d) => d.total), 1), H = 168;
  const parts: [string, string][] = [["Haiku", "--m-haiku"], ["Sonnet", "--m-sonnet"], ["Opus", "--m-opus"], ["Other", "--m-other"]];
  const gap = data.length > 40 ? "2px" : data.length > 16 ? "4px" : "7px";
  const cols = data.map((d) => {
    let segs = "";
    for (const [m, cssvar] of parts) { const v = d.models[m] || 0; if (v > 0) segs += `<i class="u-seg" style="height:${(v / max * H).toFixed(1)}px;background:var(${cssvar})"></i>`; }
    const lines = parts.filter(([m]) => (d.models[m] || 0) > 0).map(([m]) => `${m} ${uTok(d.models[m])}`);
    const tip = [d.tip, ...lines, `Total ${uTok(d.total)}`].join("||");
    return `<div class="u-col" data-tip="${esc(tip)}"><div class="u-stack">${segs}</div></div>`;
  }).join("");
  const step = Math.ceil(data.length / 12);
  const labels = data.map((d, i) => `<span>${(i % step === 0 || i === data.length - 1) ? esc(d.label) : ""}</span>`).join("");
  const title = usageRange <= 31 ? `Last ${usageRange} days` : usageRange === 90 ? "Last 90 days · weekly" : "Last 12 months · monthly";
  const anyOther = data.some((d) => (d.models.Other || 0) > 0);
  const legModels: [string, string][] = anyOther
    ? [["Opus", "--m-opus"], ["Sonnet", "--m-sonnet"], ["Haiku", "--m-haiku"], ["Other", "--m-other"]]
    : [["Opus", "--m-opus"], ["Sonnet", "--m-sonnet"], ["Haiku", "--m-haiku"]];
  const legend = legModels.map(([m, c]) => `<span class="u-lg"><i style="background:var(${c})"></i>${m}</span>`).join("");
  const empty = !data.some((d) => d.total > 0);
  const plot = empty && tokenScanning
    ? `<div class="u-skelbar" style="height:${H}px"></div>`
    : `<div class="u-plot"><div class="u-glabel mono">${uTok(max)}</div><div class="u-bars" style="--barsgap:${gap}">${cols}</div></div>
       <div class="u-xlabels" style="--barsgap:${gap}">${labels}</div>`;
  return `<section class="u-card">
    <div class="u-cardh"><div><div class="label">Daily tokens by model</div><h3 class="u-h">${title}</h3></div><div class="u-legend">${legend}</div></div>
    ${plot}
  </section>`;
}

function uModelMix(): string {
  const models = uModels(usageWindow(usageRange));
  const total = models.Opus + models.Sonnet + models.Haiku + models.Other;
  const rows = MODEL_ORDER.filter((m) => models[m] > 0).map((m) => {
    const v = models[m], pct = total ? v / total * 100 : 0;
    return `<div class="u-srow"><div class="u-stop"><span class="u-sw" style="background:var(${MODEL_VAR[m]})"></span><span class="u-snm">${m}</span><span class="u-susd mono">${uTok(v)}</span></div><div class="u-strack"><i style="width:${pct.toFixed(1)}%;background:var(${MODEL_VAR[m]})"></i></div></div>`;
  }).join("");
  const body = total > 0
    ? `<div class="u-share">${rows}</div>`
    : `<p class="u-hint">${tokenScanning ? "Scanning transcripts…" : "No token data in range yet."}</p>`;
  return `<div class="label">Model mix <span class="u-byline">· by tokens</span></div>${body}`;
}

function uTokenMix(): string {
  const cur = usageWindow(usageRange);
  let inp = 0, out = 0, cr = 0, cw = 0;
  const tk = new Map(tokenDays.map((t) => [t.day, t]));
  for (const d of cur) { const t = tk.get(d.key); if (t) { inp += t.input; out += t.output; cr += t.cache_read; cw += t.cache_write; } }
  const total = inp + out + cr + cw;
  if (!total) {
    const body = tokenScanning
      ? `<div class="u-skelbar"></div><p class="u-hint"><span class="u-spin"></span> Scanning transcripts for token history…</p>`
      : `<p class="u-hint">No token data in range yet.</p>`;
    return `<div class="label" style="margin-top:15px">Token composition</div>${body}`;
  }
  const bar = ([["Cache read", cr, "--u-t4"], ["Cache write", cw, "--u-t3"], ["Input", inp, "--u-t2"], ["Output", out, "--u-t1"]] as [string, number, string][])
    .map(([, v, c]) => v > 0 ? `<i style="width:${(v / total * 100).toFixed(2)}%;background:var(${c})"></i>` : "").join("");
  const leg = ([["Cache read", cr, "--u-t4"], ["Input", inp, "--u-t2"], ["Output", out, "--u-t1"], ["Cache write", cw, "--u-t3"]] as [string, number, string][])
    .map(([nm, v, c]) => `<div><i style="background:var(${c})"></i>${nm}<b>${Math.round(v / total * 100)}%</b></div>`).join("");
  return `<div class="label" style="margin-top:15px">Token composition</div><div class="u-mix">${bar}</div><div class="u-mixleg">${leg}</div>
    <div class="u-insight"><b>~${Math.round(cr / total * 100)}% of tokens are cache reads</b> — most context is reused, not re-billed. Big token counts, cheap dollars.</div>`;
}

function uProjects(): string {
  const cur = usageWindow(usageRange);
  const proj: Record<string, number> = {};
  // `projects` can be absent on DayUsage entries written by an older cc-usage-tokens
  // cache (the field was added after the scan shipped) — guard, or Object.entries throws.
  for (const d of cur) if (d.u) for (const [p, v] of Object.entries(d.u.projects || {})) proj[p] = (proj[p] || 0) + v;
  const entries = Object.entries(proj).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) return `<section class="u-card"><div class="label">Top projects</div><p class="u-hint">${tokenScanning ? "Scanning transcripts…" : "No token data in range yet."}</p></section>`;
  const maxw = entries[0][1] || 1;
  const rows = entries.map(([p, v]) => `<tr><td><span class="u-pj"><span class="u-dot" style="background:${accentFor(p)}"></span>${esc(p)}</span></td><td class="u-num"><span class="u-pjbar"><i style="width:${(v / maxw * 100).toFixed(0)}%"></i></span></td><td class="u-num"><span class="u-usd mono">${uTok(v)}</span></td></tr>`).join("");
  return `<section class="u-card"><div class="u-cardh"><div><div class="label">Attribution</div><h3 class="u-h">Top projects</h3></div><p class="u-hint" style="margin-top:5px">by tokens · working directory</p></div>
    <table class="u-tbl"><thead><tr><th>Project</th><th class="u-num">Share</th><th class="u-num">Tokens</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

// One window of the Usage-tab forecast card: current %, verdict, dual-track meter,
// a timeline with the projected run-out marker, the raw numbers, and a plain-English
// recommendation. Reads the same forecast()/burnRate() the footer & popup use.
function fcWinHtml(name: string, sub: string, f: Forecast, burnPerHr: number | null, len: number, burnUnit: string): string {
  const cls = f.used == null ? "" : "s-" + f.status;
  const pctTxt = f.used == null ? "–" : Math.round(f.used) + "%";
  const usedW = f.used == null ? 0 : Math.min(100, Math.max(0, f.used));
  const projW = f.proj == null ? usedW : Math.min(100, Math.max(0, f.proj));
  const ghostW = Math.max(0, projW - usedW);
  const elapsed = f.secLeft != null ? len - f.secLeft : 0;
  const elapsedPct = Math.min(100, Math.max(0, elapsed / len * 100));
  const outPct = (f.runsOut && f.etaSec != null && f.secLeft != null)
    ? Math.min(100, Math.max(0, (elapsed + f.etaSec) / len * 100)) : null;
  const vc = verdictChip(f);
  const verdict = (f.used != null && f.used >= 100) ? `<span class="vchip s-bad">at cap</span>`
    : vc || `<span class="vchip s-mut">level only</span>`;
  const burnTxt = burnPerHr == null ? "—" : `${burnPerHr.toFixed(burnPerHr < 10 ? 1 : 0)} <small>${burnUnit}</small>`;
  const etaTxt = (f.runsOut && f.etaSec != null && f.etaSec > 0) ? `${fmtSpan(f.etaSec)} <small>to cap</small>` : "—";
  const projTxt = f.proj == null ? "—" : `~${Math.round(f.proj)}%`;
  const resetInTxt = f.resetTs != null ? fmtUntil(f.resetTs) : "—";
  let rec: string;
  if (f.used == null) rec = `<span class="fc-recic">·</span><div>No reading yet — appears once a running session reports a statusLine.</div>`;
  else if (f.used >= 100) rec = `<span class="fc-recic">✕</span><div><b>At the cap</b> — new work on this window is blocked until it resets${f.resetTs != null ? " in " + fmtUntil(f.resetTs) : ""}.</div>`;
  else if (!f.hasRate) rec = `<span class="fc-recic">·</span><div>Gathering pace — the forecast sharpens after a few statusLine ticks. Showing level only for now.</div>`;
  else if (f.status === "bad") rec = `<span class="fc-recic">✕</span><div>On this pace you'll be <b>locked out ~${fmtSpan(f.secLeft! - f.etaSec!)} before reset</b>. Ease off, or move work to the other window.</div>`;
  else if (f.status === "warn") rec = `<span class="fc-recic">!</span><div>On track for <b>~${Math.round(f.proj!)}%</b> by reset — you can keep going, but there isn't much slack.</div>`;
  else rec = `<span class="fc-recic">✓</span><div>Comfortable — projected <b>~${Math.round(f.proj!)}%</b> at reset. Nothing to manage here.</div>`;
  return `<div class="fc-win">
    <div class="fc-head"><span class="fc-name">${name}</span><span class="fc-wsub">${sub}</span></div>
    <div class="fc-big"><span class="fc-num ${cls}">${pctTxt}</span><span class="fc-of">used</span>${verdict}</div>
    <div class="fc-bar ${cls}"><i class="up-fill" style="width:${usedW}%"></i><i class="up-ghost" style="left:${usedW}%;width:${ghostW}%"></i></div>
    <div class="fc-scale"><span>0%</span><span>▨ projected by reset</span><span>100%</span></div>
    <div class="fc-tl">
      <div class="fc-tlab"><span>window opened</span><span>resets ${f.resetTs != null ? fmtClock(f.resetTs) : "—"}</span></div>
      <div class="fc-tltrack"><i class="fc-tlel" style="width:${elapsedPct}%"></i><i class="fc-tlnow" style="left:${elapsedPct}%"></i>${outPct != null ? `<i class="fc-tlout" style="left:${outPct}%"></i>` : ""}<span class="fc-tlreset">${resetInTxt} left</span></div>
    </div>
    <div class="fc-stats">
      <div class="fc-stat"><div class="fc-k">Burn rate</div><div class="fc-v">${burnTxt}</div></div>
      <div class="fc-stat"><div class="fc-k">Projected @ reset</div><div class="fc-v ${cls}">${projTxt}</div></div>
      <div class="fc-stat"><div class="fc-k">Time to cap</div><div class="fc-v">${etaTxt}</div></div>
      <div class="fc-stat"><div class="fc-k">Resets in</div><div class="fc-v">${resetInTxt}</div></div>
    </div>
    <div class="fc-rec">${rec}</div>
  </div>`;
}
function forecastBlockHtml(): string {
  const b7 = burnRate("d7");
  return `<div class="fc-block">
    <div class="label">Forecast <span class="fc-hint">· will you hit a limit before it resets?</span></div>
    <div class="fc-grid">
      ${fcWinHtml("Session", "5-hour window", forecast5h(), burnRate("h5"), H5_LEN, "%/hr")}
      ${fcWinHtml("Weekly", "7-day window", forecast7d(), b7 == null ? null : b7 * 24, D7_LEN, "%/day")}
    </div>
  </div>`;
}
function usagePanelHtml(): string {
  const ranges = USAGE_RANGES.map(([n, l]) => `<button class="u-rbtn${n === usageRange ? " on" : ""}" data-urange="${n}">${l}</button>`).join("");
  return `<div class="u-pane">
    <header class="u-paneh"><div><div class="label">Analytics</div><h2 class="u-title">Usage &amp; spend</h2>
      <p class="u-hint">Every session Episko launches, account-wide. History stays on this machine.</p></div>
      <div class="u-range">${ranges}</div></header>
    ${uTiles()}
    ${forecastBlockHtml()}
    ${uHeatmap()}
    <div class="u-cols">${uBars()}<section class="u-card">${uModelMix()}${uTokenMix()}</section></div>
    ${uProjects()}
  </div>`;
}
// Only one floating footer/overlay menu may be open at a time: every open* closes
// the rest first. (The footer triggers stopPropagation, so the document-level
// outside-click close never fires for them — this is what keeps them exclusive.)
function closeFootMenus(keep?: string) {
  const menus: [string, () => void][] = [
    ["colorPop", closeColorPop], ["enginePop", closeEnginePop], ["cafPop", closeCafPop],
    ["usagePop", closeUsagePop], ["attnPop", closeAttnPop], ["shortPop", closeShortPop],
  ];
  for (const [id, close] of menus) if (id !== keep) close();
}
// Keyboard shortcuts, listed in the footer's ⌘ Shortcuts popover. Keep in sync with
// the global keydown handler (the sole source of truth for what these actually do).
const SHORTCUTS: { label: string; chords: string[][] }[] = [
  { label: "Command palette", chords: [["⌘", "K"]] },
  { label: "Switch to session 1–9", chords: [["⌘", "1–9"]] },
  { label: "Open a terminal here", chords: [["⌘", "T"]] },
  { label: "Toggle sidebar", chords: [["⌘", "B"]] },
  { label: "Toggle inspector", chords: [["⌘", "I"]] },
  { label: "Settings", chords: [["⌘", ","]] },
  { label: "Terminal font size", chords: [["⌘", "+"], ["⌘", "−"], ["⌘", "0"]] },
];
function renderShortPop() {
  const rows = SHORTCUTS.map((s) => {
    const keys = s.chords
      .map((c) => `<span class="sc-chord">${c.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</span>`)
      .join(`<span class="sc-or">/</span>`);
    return `<div class="sc-row"><span class="sc-desc">${esc(s.label)}</span><span class="sc-keys">${keys}</span></div>`;
  }).join("");
  $("shortPop").innerHTML = `<div class="sc-h">Keyboard shortcuts</div>${rows}`;
}
function openShortPop() {
  const r = $("fShortSeg").getBoundingClientRect();
  const pop = $("shortPop");
  renderShortPop();
  closeFootMenus("shortPop");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
function closeShortPop() { $("shortPop").classList.remove("show"); }
// The fleet's "needs you" set — sessions with a blocking permission, an error, or
// finished and awaiting your reply — most urgent first (waiting wins), longest in
// that state first. Independent of the sidebar sort so the reactor is stable.
function needsYou(s: Sess): boolean { return !s.shell && (!!s.attention || s.phase === "done" || s.phase === "error"); }
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
  closeFootMenus("attnPop");
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
  let title = "", tooltip = "Episko — no active sessions";
  if (n > 0) {
    if (needy.length) {
      const dom = reactorState(needy[0]);
      const c = needy.filter((s) => reactorState(s) === dom).length;
      title = `${GLYPH[dom]} ${c}`;
      tooltip = `Episko — ${n} session${n === 1 ? "" : "s"}, ${reactorLabel(dom, c)}`;
    } else {
      title = `● ${n}`;
      tooltip = `Episko — ${n} session${n === 1 ? "" : "s"}`;
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
  // this is what let a background Episko session's telemetry tick blank the
  // external header/inspector ~1s after clicking it.
  if (pastMirrorId()) {
    const d = dormants.find((x) => x.id === pastMirrorId());
    if (d) { renderPastHeader(d); renderPastInspector(d); }
  } else if (extMirrorId()) {
    const e = externals.find((x) => x.session_id === extMirrorId());
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
// (in the footer) and mirrored to a fixed file (episko-debug.json) so an external
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
  // Tee into the backend rolling log so the UI event stream survives a crash and
  // lands in one durable timeline with the backend's own lines (see log_frontend).
  // Fire-and-forget: the in-memory ring above is the source of truth for the panel.
  invoke("log_frontend", { level: lvl, msg }).catch(() => {});
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
    version: appVersion, activeId, activeExtId: extMirrorId(), activePastId: pastMirrorId(), termEngine, rateLimits: rl, telemetry: telem,
    sessions: [...sessions.values()].map((s) => ({
      id: s.id, project: s.project, phase: s.phase, attention: s.attention, model: s.model,
      ctxPct: s.ctxPct, cost: s.cost, durMs: s.durMs, subagents: s.subagents,
      lastEvent: s.lastEvent, external: s.external, branch: s.branch, workdir: s.workdir,
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
    : `<tr><td colspan="6" class="dbg-dim">no Episko sessions</td></tr>`;
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
  kind: "session" | "launch" | "command" | "action" | "fallback";
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
  if (!s.shell) {
    // Only offered for repo sessions — s.git is null when the workdir isn't one.
    if (s.git) {
      const b = s.git.behind, ah = s.git.ahead;
      a.push(mk("Fetch from the remote", "↻", () => runGit(s.id, "fetch")));
      a.push(mk(b ? `Pull ${b} commit${b === 1 ? "" : "s"}` : "Pull (fast-forward only)", "↓", () => runGit(s.id, "pull")));
      a.push(mk(ah ? `Push ${ah} commit${ah === 1 ? "" : "s"}` : "Push", "↑", () => runGit(s.id, "push")));
    }
    a.push(mk("Open a terminal here", "❯", () => { setActive(s.id); openPlainTerminal(); }));
    a.push(mk("New session here…", "⑃", () => openWt(s.project, s.colorKey)));
    // Only when this session lives in a worktree (not the repo's main checkout):
    // clean up its worktree (and merged branch) without dropping to a shell.
    if (s.worktree) a.push(mk("Remove this worktree…", "⌫", () => removeWorktreeSession(s)));
  }
  a.push(mk("Close session", "✕", () => closeSession(s.id)));
  return a;
}
const PAL_CMDS: { key: string; label: string; glyph: string; run: () => void; sc?: string[] }[] = [
  { key: "cmd:add", label: "Add a project folder…", glyph: "＋", run: addProject },
  { key: "cmd:term", label: "Open a terminal in the current project", glyph: "❯", run: openPlainTerminal, sc: ["⌘", "T"] },
  { key: "cmd:sort", label: "Change the sidebar sort order", glyph: "≡", run: cycleSort },
  { key: "cmd:insp", label: "Toggle the inspector", glyph: "◨", run: toggleInsp, sc: [MOD, "I"] },
  { key: "cmd:rail", label: "Toggle the sidebar", glyph: "◧", run: toggleRail, sc: [MOD, "B"] },
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
    const label = `${s.project} · ${s.title || s.branch || (s.shell ? "shell" : "session")}`;
    const sub = s.shell ? "shell" : `${verbFor(s).toLowerCase()}${s.ctxPct != null ? ` · ${Math.round(s.ctxPct)}% ctx` : ""}${s.cost != null ? ` · $${s.cost.toFixed(2)}` : ""}`;
    return { kind: "session", key: "session:" + s.id, label, labelHtml: esc(label), sub, sw: accentFor(s.colorKey), icon: iconFor(s.colorKey) || undefined, shortcut: i != null && i < 9 ? [MOD, String(i + 1)] : undefined, session: s, run: () => setActive(s.id) };
  });
  // Same source as the sidebar (see allProjects) — a project detected from an external
  // session is just as launchable as a favourite, and hiding it here made "+ Session"
  // with nothing selected look like it was picking projects at random.
  const launchCands: PalItem[] = allProjects().map((p) => ({ kind: "launch", key: "launch:" + p.path, label: `Launch ${p.name}`, labelHtml: esc(`Launch ${p.name}`), sub: tilde(p.path), sw: accentFor(p.path), icon: iconFor(p.path) || undefined, run: () => requestLaunch(p.name, p.path) }));
  const cmdCands: PalItem[] = PAL_CMDS.map((c) => ({ kind: "command", key: c.key, label: c.label, labelHtml: esc(c.label), sub: "command", glyph: c.glyph, shortcut: c.sc, run: c.run }));
  for (const id of availEngines) { const d = engineDef(id); cmdCands.push({ kind: "command", key: "engine:" + id, label: `New sessions in ${d.label}${id === termEngine ? " ✓" : ""}`, labelHtml: esc(`New sessions in ${d.label}${id === termEngine ? " ✓" : ""}`), sub: d.sub, glyph: id === "embedded" ? "▤" : "⧉", run: () => setEngine(id) }); }

  const score = (arr: PalItem[]) => arr.map((it) => scoreItem(it, searchTerm)).filter(Boolean) as PalItem[];
  const byScore = (a: PalItem, b: PalItem) => (b.score ?? 0) - (a.score ?? 0);
  const byFrec = (a: PalItem, b: PalItem) => frecScore(b.key) - frecScore(a.key);
  const sessNatural = (a: PalItem, b: PalItem) => urgencyRank(a.session!) - urgencyRank(b.session!) || b.session!.lastActivity - a.session!.lastActivity;

  const sess = score(sessCands), launch = score(launchCands), cmds = score(cmdCands);
  const needy = sess.filter((i) => needsYou(i.session!)).sort(emptyTerm ? sessNatural : byScore);
  const rest = sess.filter((i) => !needsYou(i.session!)).sort(emptyTerm ? sessNatural : byScore);

  const groups: PalGroup[] = [];
  const recentKeys = new Set<string>();
  if (mode !== "cmd" && needy.length) groups.push({ name: "Needs you", count: needy.length, items: needy });
  if (emptyTerm && mode === "all") {
    const recent = [...cmds, ...launch].filter((i) => frecScore(i.key) > 0).sort(byFrec).slice(0, 3);
    recent.forEach((i) => recentKeys.add(i.key));
    if (recent.length) groups.push({ name: "Recent", items: recent });
  }
  if (mode !== "cmd" && rest.length) groups.push({ name: "Sessions", count: rest.length, items: rest });
  if (mode === "all" || mode === "sess") { const l = launch.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (l.length) groups.push({ name: "Launch", items: l }); }
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
        : it.session ? `<span class="pal-sh actions"><span class="k">${chord("K")}</span></span>` : "";
      return `<div class="pal-item ${i === palSel ? "on" : ""}" data-i="${i}"><span class="pal-ic">${ic}</span><span class="pal-main"><span class="pm">${it.labelHtml}</span>${it.sub ? `<span class="ps">${esc(it.sub)}</span>` : ""}</span>${sh}</div>`;
    }).join("");
    return `<div class="pal-gh">${esc(g.name)}${g.count ? `<span class="gc">${g.count}</span>` : ""}</div>${rows}`;
  }).join("");
  $("palList").innerHTML = html || `<div class="pal-item"><span class="pal-main"><span class="pm" style="color:var(--muted)">No matches</span></span></div>`;
  $("palList").querySelectorAll<HTMLElement>(".pal-item[data-i]").forEach((el) => el.addEventListener("click", () => runPalItem(palFlat[+el.dataset.i!])));
  const foot = $("palFoot");
  foot.innerHTML = palPage === "actions"
    ? `<span>↵ run</span><span>⌫ back</span><span class="sp"></span><span>esc close</span>`
    : `<span class="pf-mode">⟩ command</span><span>@ project</span><span>/ state</span><span class="sp"></span><span>${chord("K")} actions · esc</span>`;
  $("palList").querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
}
function refreshPal() { palGroups = buildPalGroups(($("palInput") as HTMLInputElement).value); palFlat = palGroups.flatMap((g) => g.items); palSel = 0; renderPal(); }
function openPalette() { palPage = "root"; palActionSess = null; palSel = 0; $("scrim").classList.add("show"); $("palette").classList.add("show"); ($("palInput") as HTMLInputElement).value = ""; refreshPal(); setTimeout(() => ($("palInput") as HTMLInputElement).focus(), 30); }
function closePalette() { $("scrim").classList.remove("show"); $("palette").classList.remove("show"); palPage = "root"; palActionSess = null; }

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
// The effective theme = an explicit data-theme override, else the OS preference.
function effectiveTheme(): "dark" | "light" {
  const a = document.documentElement.getAttribute("data-theme");
  if (a === "dark" || a === "light") return a;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function setTheme(t: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("cc-theme", t);
  renderSettings(); // keep the settings picker in sync if it's open
}
function toggleTheme() { setTheme(effectiveTheme() === "dark" ? "light" : "dark"); }
// Fit one terminal to its pane, push the new size to its PTY, and force a full
// repaint. The repaint is not cosmetic: on a resize the WebGL renderer only redraws
// cells its damage tracker flagged, so a cell that went glyph→blank can keep a stale
// glyph in the GL framebuffer (the "floating chars" past a shrunk table). refresh()
// re-rasterizes every visible row straight from the buffer, clearing those ghosts.
// Only ever call this on the *active* pane — an inactive one is display:none, so
// fit() would measure a zero-size box and resize the PTY to garbage.
function fitSession(s: Sess) {
  if (!s.term || !s.fit) return;
  try {
    s.fit.fit();
    invoke("resize_pty", { sessionId: s.id, rows: s.term.rows, cols: s.term.cols });
    s.term.refresh(0, s.term.rows - 1);
  } catch { /* pane not measurable yet */ }
}
function refit() { if (!activeId) return; const s = sessions.get(activeId); if (s) fitSession(s); }
function applyFontSize() { for (const s of sessions.values()) if (s.term) s.term.options.fontSize = termFontSize; refit(); localStorage.setItem("cc-term-font", String(termFontSize)); }
function bumpFont(d: number) { termFontSize = Math.max(8, Math.min(28, termFontSize + d)); applyFontSize(); toast(`Terminal font ${termFontSize}px`); }

let toastT: number | undefined;
function toast(m: string) { const el = $("toast"); el.textContent = m; el.classList.add("show"); clearTimeout(toastT); toastT = window.setTimeout(() => el.classList.remove("show"), 1900); }

// ---------- new-session dialog ----------
// Every answer to "where should this session run?" is a directory, so every answer
// is a row: the repo itself, its worktrees, its branches, and whatever you type.
// One list on the left; the consequences of the highlighted row on the right.
//
// The repo row is unconditional — the old dialog only offered the main checkout when
// `requestLaunch` opened it, so the toolbar button, the context menu and the action
// panel each led to a dialog that couldn't start a session in the project itself.
// ahead/behind are versus this branch's OWN remote upstream (empty when it has none),
// not versus whatever HEAD is on — see the BranchInfo doc comment in lib.rs.
type BranchInfo = { name: string; current: boolean; checked_out: boolean; upstream: string; ahead: number; behind: number; gone: boolean; rel: string; unix: number };
type WtInfo = { path: string; branch: string; is_main: boolean; dirty: boolean; merged: boolean; locked: boolean; exists: boolean };
type CommitInfo = { short: string; subject: string; author: string; rel: string };

type DestKind = "repo" | "wt" | "branch" | "create";
interface Dest {
  kind: DestKind;
  group: string;          // "" pins the row above every group (the create row)
  ic: string;
  label: string;          // primary line
  sub: string;            // secondary line ("" = none)
  dir: string;            // the directory this destination runs in (or would create)
  branch: string;         // "" when the checkout is detached
  tags: [string, string][];
  meta: string;           // right-aligned html (ahead/behind + age, branches only)
  stale: boolean;
  verb: string;           // what ⏎ does, spelled out in the footer
  wt?: WtInfo;
  br?: BranchInfo;
  clash?: WtInfo;         // a worktree already owns the folder this row would create
}

let wtCtx: { project: string; repoDir: string } | null = null;
let wtWts: WtInfo[] = [];
let wtBranches: BranchInfo[] = [];
let wtRepoBranch = "";
let wtLoading = true;          // git hasn't answered yet — draw skeleton rows
let wtRows: Dest[] = [];
let wtSel = 0;
let wtArmed = "";              // path of the worktree whose removal is armed
let wtBusy = false;            // a create/remove is in flight
let wtBase = "";               // start-point for a NEW branch ("" = the repo's HEAD)
let wtSwitchTo = "";           // target of an armed root-folder branch switch
let wtGen = 0;                 // bumps on every open/refresh; stales in-flight fetches
let wtAgeT: number | undefined;
let wtLoadedAt = 0;
const wtCommits = new Map<string, CommitInfo | null>();
const wtDirty = new Map<string, DiffStat | null>();

/** Mirror of the backend's path scheme (`create_worktree`): every character git
 *  can't take becomes "-", then "/" does too. Lossy on purpose — and irreversibly
 *  so, which is why nothing here ever tries to derive a branch back out of a folder. */
function wtSlug(branch: string): string {
  return branch.trim().replace(/[^\p{L}\p{N}\-_/.]/gu, "-").replace(/\//g, "-");
}
function parentOf(p: string) { const q = p.replace(/[/\\]+$/, ""); const i = Math.max(q.lastIndexOf("/"), q.lastIndexOf("\\")); return i > 0 ? q.slice(0, i) : q; }
const wtNorm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
/** Where `create_worktree` would put a checkout for `branch` in this repo. */
function wtTargetDir(repoDir: string, branch: string) {
  return `${parentOf(repoDir)}/.cc-worktrees/${basename(repoDir)}/${wtSlug(branch)}`;
}

// The four ways a checkout's folder and its branch can relate. The folder is the
// identity (it's what exists, and what removal deletes); the branch is only a label,
// and `git switch` inside a session rewrites it at will.
type WtState = "aligned" | "diverged" | "detached" | "foreign";
function wtStateOf(w: WtInfo, repoDir: string): WtState {
  const base = wtNorm(`${parentOf(repoDir)}/.cc-worktrees/${basename(repoDir)}`);
  if (!wtNorm(w.path).startsWith(base + "/")) return "foreign";
  if (!w.branch || w.branch === "(detached)") return "detached";
  return wtSlug(w.branch) === basename(w.path) ? "aligned" : "diverged";
}
/** What to call a checkout. Its branch when it has one; otherwise its folder,
 *  because a row still has to be nameable. */
function wtLabelOf(w: WtInfo) {
  return w.branch && w.branch !== "(detached)" ? w.branch : basename(w.path) + "/";
}
const wtSessionsIn = (path: string) => [...sessions.values()].filter((s) => s.workdir === path);

/** Head flexes and ellipsises, tail is pinned: sibling branches often differ only in
 *  their suffix, so a plain tail-ellipsis would render two rows identically. */
function wtName(name: string) {
  const TAIL = 9;
  if (name.length <= TAIL + 4) return `<span class="hd">${esc(name)}</span>`;
  return `<span class="hd">${esc(name.slice(0, name.length - TAIL))}</span><span class="tl">${esc(name.slice(-TAIL))}</span>`;
}

/** A branch's standing against its own remote — the only comparison that answers a
 *  question you'd actually ask here. A branch in sync with its upstream shows nothing;
 *  silence is the clean state. */
function wtSyncMeta(b: BranchInfo): string {
  if (b.gone) return `<span class="wt-tag gone" title="${esc(b.upstream)} no longer exists on the remote — this branch is local-only now">gone</span>`;
  if (!b.upstream) return `<span class="wt-tag det" title="No remote branch tracks this — it has never been pushed">local</span>`;
  return (b.ahead ? `<span class="wt-ab wt-ahead" title="${b.ahead} commit(s) not yet pushed to ${esc(b.upstream)}">↑${b.ahead}</span>` : "")
    + (b.behind ? `<span class="wt-ab wt-behind" title="${b.behind} commit(s) on ${esc(b.upstream)} not pulled yet">↓${b.behind}</span>` : "");
}

/** The same fact as wtSyncMeta, spelled out for the detail pane. */
function wtUpstreamHtml(b: BranchInfo): string {
  if (b.gone) return `<span class="em">${esc(b.upstream)}</span> — deleted on the remote; local-only now`;
  if (!b.upstream) return `<span class="dim">none — never pushed</span>`;
  if (!b.ahead && !b.behind) return `<span class="em">${esc(b.upstream)}</span> <span class="good">· in sync</span>`;
  return `<span class="em">${esc(b.upstream)}</span>`
    + (b.ahead ? ` · <span class="warn">↑${b.ahead} unpushed</span>` : "")
    + (b.behind ? ` · ↓${b.behind} unpulled` : "");
}

async function openWt(project: string, repoDir: string, knownBranch?: string | null) {
  wtCtx = { project, repoDir };
  wtSel = 0; wtArmed = ""; wtBusy = false; wtBase = ""; wtSwitchTo = ""; wtFetchedAt = 0;
  wtRepoBranch = knownBranch || "";   // seeded by requestLaunch, which already asked
  ($("wtQ") as HTMLInputElement).value = "";
  $("wtProj").textContent = project;
  $("wtPath").textContent = repoDir;
  const eng = engineDef(termEngine);
  $("wtEng").textContent = `${termEngine === "embedded" ? "▤" : "⧉"} ${eng.label}`;
  ($("wtEng") as HTMLElement).title = `New sessions open in ${eng.label}`;
  $("scrim").classList.add("show"); $("wtDlg").classList.add("show");
  setTimeout(() => ($("wtQ") as HTMLInputElement).focus(), 30);
  clearInterval(wtAgeT); wtAgeT = window.setInterval(wtTickAge, 1000);
  await wtLoad();
}

// Both lists cost several git calls (a status probe per checkout, a rev-list per ref),
// so the dialog draws its shape first and fills in. The repo row is real from the
// first frame — it's the path we were opened with — so ⏎ works at t=0.
//
// Two layers of freshness, because they cost different things:
//   wtReadLocal — pure local git, instant, safe to run whenever.
//   wtMaybeFetch — network. ahead/behind and `gone` come from %(upstream:track), which
//     compares against refs/remotes/*, a cache only `git fetch` moves. Without this the
//     panel's most useful signal would silently reflect whenever you last fetched.
async function wtLoad(quiet = false) {
  await wtReadLocal(quiet);
  void wtMaybeFetch();
}

// Fetch is throttled and best-effort: it runs in the background, never blocks the list,
// and stays silent on failure (offline, no remote, auth) — a stale number is a better
// outcome than a toast every time you alt-tab with no network.
const WT_FETCH_MIN_MS = 60_000;
let wtFetchedAt = 0;
let wtFetching = false;
async function wtMaybeFetch(force = false) {
  if (!wtCtx || wtFetching) return;
  if (!force && Date.now() - wtFetchedAt < WT_FETCH_MIN_MS) return;
  const gen = wtGen, { repoDir } = wtCtx;
  wtFetching = true;
  $("wtRefresh").classList.add("spin");
  try {
    await invoke<GitActionResult>("git_action", { workdir: repoDir, op: "fetch" });
  } catch { /* offline / no remote / auth — the local read still stands */ }
  wtFetching = false;
  wtFetchedAt = Date.now();
  $("wtRefresh").classList.remove("spin");
  if (gen !== wtGen || !wtCtx || wtCtx.repoDir !== repoDir) return; // dialog moved on
  await wtReadLocal(true);
}

// `quiet` = there is already a list on screen, so don't tear it down: no skeletons, no
// "not a git repository" toast a second time, and one render at the end instead of two.
// Skeletons are for the first paint only.
async function wtReadLocal(quiet = false) {
  if (!wtCtx) return;
  const { repoDir } = wtCtx;
  const gen = ++wtGen;
  // The lazily-fetched facts (HEAD lines, the repo's dirty count) are re-derived: a
  // quiet refresh usually follows something that moved them.
  wtCommits.clear(); wtDirty.clear();
  if (!quiet) { wtLoading = true; wtRender(); }
  const [wts, branches, head] = await Promise.all([
    invoke<WtInfo[]>("list_worktrees", { repoDir }).catch(() => [] as WtInfo[]),
    invoke<BranchInfo[]>("git_branch_list", { repoDir }).catch(() => [] as BranchInfo[]),
    invoke<string | null>("git_branch", { workdir: repoDir }).catch(() => null),
  ]);
  if (gen !== wtGen || !wtCtx || wtCtx.repoDir !== repoDir) return; // dialog moved on
  wtWts = wts; wtBranches = branches; wtRepoBranch = head || wtRepoBranch;
  wtLoading = false;
  wtLoadedAt = Date.now();
  if (!wts.length && !quiet) toast(`${basename(repoDir)} isn't a git repository`);
  wtRender();
}

function wtTickAge() {
  if (!$("wtDlg").classList.contains("show")) { clearInterval(wtAgeT); return; }
  if (wtLoading) { $("wtAge").textContent = "…"; return; }
  const s = Math.round((Date.now() - wtLoadedAt) / 1000);
  $("wtAge").textContent = s < 5 ? "now" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

// One array, four row kinds. Both the list and the detail pane read only from this.
function wtBuild(): Dest[] {
  if (!wtCtx) return [];
  const { repoDir } = wtCtx;
  const raw = ($("wtQ") as HTMLInputElement).value;
  const q = raw.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const out: Dest[] = [];

  const known = [...wtWts.map((w) => w.branch), ...wtBranches.map((b) => b.name), wtRepoBranch];
  const exact = known.some((n) => n && n.toLowerCase() === q);

  // The typed query, promoted to an action. This is what lets the branch field, its
  // datalist and the fixed "Create worktree" button all disappear.
  if (q && !exact) {
    const want = wtSlug(raw);
    const clash = wtWts.find((w) => !w.is_main && basename(w.path) === want);
    out.push({
      kind: "create", group: "", ic: "＋", label: raw.trim(),
      sub: clash ? `folder ${basename(clash.path)}/ is already taken` : `new worktree off ${wtBase || wtRepoBranch || "HEAD"}`,
      dir: wtTargetDir(repoDir, raw), branch: raw.trim(), tags: [], meta: "", stale: false, clash,
      verb: clash ? "blocked — that folder exists" : "create worktree & start session",
    });
  }

  const repoSess = wtSessionsIn(repoDir).length;
  if (hit(wtRepoBranch) || hit(basename(repoDir)) || hit("repo")) {
    out.push({
      kind: "repo", group: "Repo", ic: "⌂",
      label: wtRepoBranch || basename(repoDir), sub: repoDir,
      dir: repoDir, branch: wtRepoBranch,
      tags: repoSess ? [["open", `${repoSess} open`]] : [], meta: "", stale: false,
      verb: "start session in the repo — no worktree",
    });
  }

  for (const w of wtWts) {
    if (w.is_main) continue;
    // Searchable by the branch you want OR the folder you remember — after a
    // `git switch` inside the checkout those are different strings.
    if (!hit(`${w.branch} ${basename(w.path)} ${w.path}`)) continue;
    const st = wtStateOf(w, repoDir);
    const open = wtSessionsIn(w.path).length;
    const tags: [string, string][] = [];
    if (open) tags.push(["open", `${open} open`]);
    if (!w.exists) tags.push(["missing", "missing"]);
    if (w.locked) tags.push(["locked", "locked"]);
    if (st === "diverged") tags.push(["moved", "moved"]);
    if (st === "detached") tags.push(["det", "detached"]);
    if (st === "foreign") tags.push(["ext", "outside"]);
    if (w.dirty) tags.push(["dirty", "uncommitted"]);
    // `merged` is computed against the main branch and skipped for (detached) — never
    // imply a detached checkout is a safe cleanup.
    if (w.merged && st !== "detached") tags.push(["merged", "merged"]);
    out.push({
      kind: "wt", group: "Worktrees", ic: "⑃", wt: w,
      label: wtLabelOf(w),
      sub: st === "diverged" ? `in ${basename(w.path)}/` : st === "foreign" ? w.path : "",
      dir: w.path, branch: w.branch === "(detached)" ? "" : w.branch,
      tags, meta: "", stale: false,
      verb: !w.exists ? "folder is gone — remove it instead"
        : open ? "start another session in this worktree"
        : "start session in this worktree",
    });
  }

  // Branches you could start a NEW worktree on. The current branch (the repo row) and
  // any already checked out (the worktrees above) are excluded — git refuses either a
  // second time, so offering them would only produce an error.
  const STALE = 45 * 86400, now = Date.now() / 1000;
  for (const b of wtBranches) {
    if (b.current || b.checked_out || !hit(b.name)) continue;
    const clash = wtWts.find((w) => !w.is_main && basename(w.path) === wtSlug(b.name));
    out.push({
      kind: "branch", group: "Branches", ic: "⌥", br: b, clash,
      label: b.name, sub: "", dir: wtTargetDir(repoDir, b.name), branch: b.name,
      tags: [], stale: b.unix > 0 && now - b.unix > STALE,
      meta: wtSyncMeta(b) + `<span class="wt-when">${esc(b.rel || "")}</span>`,
      verb: clash ? "blocked — that folder exists" : "create a worktree on this branch & start",
    });
  }
  return out;
}

function wtRender() {
  wtRows = wtBuild();
  if (wtSel >= wtRows.length) wtSel = Math.max(0, wtRows.length - 1);
  const cur = wtRows[wtSel];
  if (!cur || cur.kind === "create" || cur.dir !== wtArmed) wtArmed = "";

  let html = "", lastGroup: string | null = null;
  wtRows.forEach((d, i) => {
    if (d.group && d.group !== lastGroup) {
      lastGroup = d.group;
      const n = wtRows.filter((x) => x.group === d.group).length;
      html += `<div class="wt-gh">${d.group}<span class="gc">${n}</span><span class="rule"></span></div>`;
    }
    html += `<button class="wt-item${d.kind === "create" ? " create" : ""}${d.stale ? " stale" : ""}${i === wtSel ? " on" : ""}"`
      + ` type="button" role="option" aria-selected="${i === wtSel}" data-wti="${i}" title="${esc(d.dir)}&#10;Double-click to ${esc(d.verb)}">`
      + `<span class="wt-ic">${d.ic}</span>`
      + `<span class="wt-main"><span class="wt-br">${wtName(d.label)}</span>`
      + (d.sub ? `<span class="wt-sub2">${esc(d.sub)}</span>` : "")
      + `</span><span class="wt-meta">`
      + d.tags.map(([k, t]) => `<span class="wt-tag ${k}">${esc(t)}</span>`).join("")
      + `${d.meta}</span></button>`;
  });
  if (wtLoading) {
    html += `<div class="wt-gh">Worktrees<span class="rule"></span></div>`
      + [44, 62, 37].map((w) => `<div class="wt-sk"><i class="a"></i><i style="width:${w}%"></i></div>`).join("")
      + `<div class="wt-gh">Branches<span class="rule"></span></div>`
      + [55, 41].map((w) => `<div class="wt-sk"><i class="a"></i><i style="width:${w}%"></i></div>`).join("");
  } else if (!wtRows.length) {
    html += `<div class="wt-empty"><b>Nothing matches that</b>Clear the filter, or type a branch name to create one</div>`;
  }
  $("wtList").innerHTML = html;
  $("wtCount").textContent = wtLoading ? "" : wtRows.length ? `${wtRows.length} destinations` : "";
  $("wtVerb").textContent = cur ? cur.verb : "—";
  $("wtDetail").innerHTML = wtDetailHtml(cur);
  $("wtList").querySelector(".wt-item.on")?.scrollIntoView({ block: "nearest" });
  void wtPrefetch(cur);
}

// The pane's git facts, fetched for the HIGHLIGHTED row only — a repo can hold
// BRANCH_LIST_CAP branches plus every worktree, and one `git log` per row would cost
// far more than the pane is worth.
async function wtPrefetch(d: Dest | undefined) {
  if (!d || !wtCtx) return;
  const gen = wtGen, { repoDir } = wtCtx;
  const jobs: Promise<unknown>[] = [];
  const ck = wtCommitKey(d);
  if (ck && !wtCommits.has(ck)) {
    const [dir, rev] = ck.split("\n");
    jobs.push(invoke<CommitInfo | null>("git_commit_info", { dir, rev }).catch(() => null)
      .then((c) => { wtCommits.set(ck, c); }));
  }
  // list_worktrees skips `dirty` for the main worktree, so the repo row needs its own.
  if (d.kind === "repo" && !wtDirty.has(repoDir)) {
    jobs.push(invoke<DiffStat | null>("git_diffstat", { workdir: repoDir }).catch(() => null)
      .then((g) => { wtDirty.set(repoDir, g); }));
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  if (gen !== wtGen) return;                    // refreshed under us
  if (wtRows[wtSel] !== d) return;              // selection moved on
  $("wtDetail").innerHTML = wtDetailHtml(d);
}
/** `<dir>\n<rev>` — the argument pair for git_commit_info, newline-joined because
 *  git forbids newlines in ref names and a path may contain spaces. "" when there is
 *  nothing to ask about (an unborn create row has no commit yet). */
function wtCommitKey(d: Dest): string {
  if (!wtCtx) return "";
  if (d.kind === "repo") return `${d.dir}\n`;
  if (d.kind === "wt") return d.wt!.exists ? `${d.dir}\n` : "";
  if (d.kind === "branch") return `${wtCtx.repoDir}\n${d.branch}`;
  return "";
}

function wtFacts(pairs: [string, string][]) {
  return `<dl class="wt-facts">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}
function wtCommitHtml(d: Dest): string {
  const ck = wtCommitKey(d);
  if (!ck) return `<span class="dim">—</span>`;
  if (!wtCommits.has(ck)) return `<span class="dim">reading…</span>`;
  const c = wtCommits.get(ck);
  if (!c) return `<span class="dim">no commits yet</span>`;
  return `<span class="em">${esc(c.short)}</span> · ${esc(c.author)} · ${esc(c.rel)}<span class="subj">${esc(c.subject)}</span>`;
}
/** Dim the containing directory, emphasise the leaf — the leaf is the identity. */
function wtPathHtml(p: string) {
  const b = basename(p);
  const i = p.lastIndexOf(b);
  return i <= 0 ? `<span class="em">${esc(p)}</span>` : `<span class="dim">${esc(p.slice(0, i))}</span><span class="em">${esc(b)}</span>`;
}
function wtSessHtml(list: Sess[]) {
  const col: Record<Phase, string> = { idle: "--st-idle", thinking: "--st-working", working: "--st-working", done: "--st-done", error: "--st-error", ended: "--st-idle" };
  return `<div class="wt-sess">${list.map((s) =>
    `<button class="wt-sessb" type="button" data-wtjump="${esc(s.id)}"><i style="background:var(${col[s.phase]})"></i>${esc(s.title || s.branch || "session")}</button>`).join("")}</div>`;
}

function wtDetailHtml(d: Dest | undefined): string {
  if (wtLoading && !d) return `<div class="wt-empty">Reading the repo…</div>`;
  if (!d || !wtCtx) return `<div class="wt-empty">Nothing selected.</div>`;

  if (d.kind === "repo") {
    const g = wtDirty.get(d.dir);
    const sess = wtSessionsIn(d.dir);
    if (wtArmed === d.dir) return wtSwitchHtml();
    return `<div class="wt-dhead"><span class="wt-dkind">The repo itself</span><span class="wt-dname">${wtPathHtml(d.dir)}</span></div>`
      + wtFacts([
        ["Branch", `<span class="em">${esc(wtRepoBranch || "—")}</span>`],
        ["HEAD", wtCommitHtml(d)],
        ["Working tree", !wtDirty.has(d.dir) ? `<span class="dim">reading…</span>`
          : g && g.dirty > 0 ? `<span class="warn">${g.dirty} file${g.dirty === 1 ? "" : "s"} uncommitted</span>`
          : `<span class="good">clean</span>`],
      ])
      + (sess.length ? `<dl class="wt-facts"><dt>Sessions</dt><dd>${wtSessHtml(sess)}</dd></dl>` : "")
      + `<div class="wt-acts"><button class="wt-go" type="button" data-wtact="go">Start session here</button>`
      + `<button class="wt-rm" type="button" data-wtact="arm">Switch branch…</button></div>`;
  }

  if (d.kind === "wt") {
    const w = d.wt!, st = wtStateOf(w, wtCtx.repoDir), sess = wtSessionsIn(w.path);
    if (wtArmed === w.path) return wtConfirmHtml(d);
    let warn = "";
    if (!w.exists) {
      warn = `<div class="wt-warn err"><span class="t">Folder is gone</span>`
        + `Nothing is left at this path — only git's record of it. Removing prunes that record; there's nothing to launch into.</div>`;
    } else if (st === "diverged") {
      // Deliberately does NOT name the branch this folder was created for: wtSlug is
      // lossy (both "/" and every odd character become "-"), so the folder can't be
      // turned back into a branch name. Name the folder, which is what exists.
      warn = `<div class="wt-warn"><span class="t">Folder and branch disagree</span>`
        + `This checkout lives in <b>${esc(basename(w.path))}/</b>, a folder named after the branch it was created for. `
        + `Its HEAD is now <b>${esc(w.branch)}</b> — something switched inside it. `
        + `Removing it deletes the folder; the branch is a separate decision.</div>`;
    } else if (st === "detached") {
      warn = `<div class="wt-warn"><span class="t">No branch checked out</span>`
        + `HEAD is detached here, so commits made in this checkout belong to no branch — Episko can't tell you whether they're merged, and won't offer to delete anything.</div>`;
    } else if (st === "foreign") {
      warn = `<div class="wt-warn"><span class="t">Outside .cc-worktrees</span>`
        + `Episko didn't create this checkout, so it doesn't own the path. Removal still works; the folder just isn't where new worktrees go.</div>`;
    }
    if (w.locked) {
      warn += `<div class="wt-warn"><span class="t">Locked</span>`
        + `<b>git worktree lock</b> was used here. Git refuses to remove a locked worktree even with <b>--force</b>, so unlock it first.</div>`;
    }
    const facts: [string, string][] = [
      ["Folder", wtPathHtml(w.path)],
      ["Branch", w.branch && w.branch !== "(detached)" ? `<span class="em">${esc(w.branch)}</span>` : `<span class="warn">(detached)</span>`],
      ["HEAD", wtCommitHtml(d)],
      ["Working tree", !w.exists ? `<span class="dim">—</span>` : w.dirty ? `<span class="warn">uncommitted changes</span>` : `<span class="good">clean</span>`],
    ];
    if (w.branch && w.branch !== "(detached)") {
      facts.push(["Branch state", w.merged ? `<span class="good">merged into ${esc(wtRepoBranch || "the main branch")}</span>`
        : `<span class="em">has commits</span> ${esc(wtRepoBranch || "the main branch")} doesn't`]);
    }
    return `<div class="wt-dhead"><span class="wt-dkind">Existing worktree</span><span class="wt-dname">${esc(wtLabelOf(w))}</span></div>`
      + warn + wtFacts(facts)
      + (sess.length ? `<dl class="wt-facts"><dt>Sessions</dt><dd>${wtSessHtml(sess)}</dd></dl>` : "")
      + `<div class="wt-acts">`
      + `<button class="wt-go" type="button" data-wtact="go"${w.exists ? "" : " disabled"}>${sess.length ? "Start another session here" : "Start session here"}</button>`
      + `<button class="wt-rm" type="button" data-wtact="arm"${sess.length ? " disabled title=\"Close its sessions first\"" : ""}>Remove worktree…</button>`
      + `</div>`;
  }

  // branch / create — neither has a checkout yet, so both are about the folder that
  // WOULD be made. Showing that path is what catches a collision before git does.
  const clash = d.clash;
  const clashWarn = clash
    ? `<div class="wt-warn err"><span class="t">Folder already taken</span>`
      + `<b>${esc(basename(clash.path))}/</b> exists and has <b>${esc(wtLabelOf(clash))}</b> checked out`
      + `${clash.dirty ? ", with uncommitted changes" : ""}. The folder is derived from the branch name, so this branch has nowhere to go.</div>`
    : "";
  if (d.kind === "branch") {
    const b = d.br!;
    if (wtArmed === d.dir) return wtBranchConfirmHtml(d);
    // No live remote is a fact about the branch, not a reason to avoid it — resuming a
    // branch whose remote was deleted (and pushing a fresh one) is an ordinary thing to
    // want. Say what will happen instead of leaving the red `gone` chip to imply doom.
    const noRemote = (b.gone || !b.upstream) && !clash
      ? `<div class="wt-warn note"><span class="t">No remote branch right now</span>`
        + `${b.gone ? `<b>${esc(b.upstream)}</b> was deleted` : "This branch has never been pushed"} — starting a worktree here is fine. `
        + `The first <b>git push -u</b> from it creates <b>origin/${esc(b.name)}</b> again.</div>`
      : "";
    return `<div class="wt-dhead"><span class="wt-dkind">Branch — no checkout yet</span><span class="wt-dname">${esc(b.name)}</span></div>`
      + clashWarn + noRemote
      + wtFacts([
        ["Last commit", wtCommitHtml(d)],
        ["Upstream", wtUpstreamHtml(b)],
        [clash ? "Would be" : "Will create", wtPathHtml(d.dir)],
      ])
      + `<div class="wt-acts"><button class="wt-go" type="button" data-wtact="go"${clash ? " disabled" : ""}>Create worktree &amp; start</button>`
      + (clash ? `<button class="wt-alt" type="button" data-wtact="openclash">Open that checkout instead</button>` : "")
      + `<button class="wt-rm" type="button" data-wtact="arm">Delete branch…</button>`
      + `</div>`;
  }
  return `<div class="wt-dhead"><span class="wt-dkind">New worktree</span><span class="wt-dname">${esc(d.label)}</span></div>`
    + clashWarn
    + wtFacts([
      ["Branch from", wtBaseSelect()],
      [clash ? "Would be" : "Will create", wtPathHtml(d.dir)],
    ])
    + `<div class="wt-acts"><button class="wt-go" type="button" data-wtact="go"${clash ? " disabled" : ""}>Create worktree &amp; start</button>`
    + (clash ? `<button class="wt-alt" type="button" data-wtact="openclash">Open that checkout instead</button>` : "")
    + `</div>`;
}

// Removal, confirmed in the pane rather than a modal on a modal. The checkout and the
// branch are separate losses — `worktree remove` never touches the branch — so they
// get separate sentences and separate buttons.
function wtConfirmHtml(d: Dest): string {
  const w = d.wt!;
  const folder = `<b>${esc(basename(w.path))}/</b>`;
  if (!w.exists) {
    return `<div class="wt-danger"><span class="q">Prune ${folder}?</span>`
      + `<span class="w">The folder is already gone; this only clears git's record of it. Nothing is lost.</span>`
      + `<span class="row"><button class="wt-cbtn danger" type="button" data-wtact="rm0">Prune it</button>`
      + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  if (w.dirty) {
    return `<div class="wt-danger"><span class="q">Remove ${folder}?</span>`
      + `<span class="w"><span class="em">Uncommitted changes</span> live only in this checkout — nothing else has them. `
      + `Episko won't force it; it'll open a terminal in the repo root with the command ready.</span>`
      + `<span class="row"><button class="wt-cbtn" type="button" data-wtact="rm0">Open a terminal there</button>`
      + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  const hasBranch = !!w.branch && w.branch !== "(detached)";
  const branchLine = !hasBranch
    ? " It has no branch checked out, so only the folder goes."
    : w.merged
      ? ` Its branch <b>${esc(w.branch)}</b> is merged into ${esc(wtRepoBranch || "the main branch")} — deleting it loses nothing.`
      : ` Its branch <b>${esc(w.branch)}</b> has commits ${esc(wtRepoBranch || "the main branch")} doesn't, so it's kept.`;
  return `<div class="wt-danger"><span class="q">Remove ${folder}?</span>`
    + `<span class="w">The checkout is clean.${branchLine}</span>`
    + `<span class="row">`
    + (hasBranch && w.merged ? `<button class="wt-cbtn danger" type="button" data-wtact="rm1">Remove + delete branch</button>` : "")
    + `<button class="wt-cbtn" type="button" data-wtact="rm0">Remove${hasBranch ? ", keep branch" : ""}</button>`
    + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
}

// Deleting a local branch, the counterpart to removing a worktree. The copy has to
// carry one non-obvious fact: a `gone` upstream usually means the PR merged, but if it
// was SQUASH-merged the commits never became ancestors of HEAD, so git's safe delete
// refuses anyway. Say that before the click, not after it fails.
function wtBranchConfirmHtml(d: Dest): string {
  const b = d.br!;
  const name = `<b>${esc(b.name)}</b>`;
  let why: string;
  if (b.gone) {
    why = `<b>${esc(b.upstream)}</b> was deleted on the remote, so this branch is local-only now — often after its pull request merged, `
      + `but not always. If you still want the work, cancel and start a worktree on it instead; a push from there recreates the remote branch.`;
  } else if (!b.upstream) {
    why = `<span class="em">It has never been pushed.</span> Its commits exist here and nowhere else — once it's gone, they're only reachable by sha.`;
  } else if (b.ahead) {
    why = `<span class="em">${b.ahead} commit${b.ahead === 1 ? "" : "s"} are not on <b>${esc(b.upstream)}</b></span> — deleting the branch leaves them only reachable by sha. The remote branch itself stays.`;
  } else {
    why = `It's in sync with <b>${esc(b.upstream)}</b>, which is not touched — the remote branch stays and this can be re-fetched.`;
  }
  return `<div class="wt-danger"><span class="q">Delete ${name}?</span>`
    + `<span class="w">${why}</span>`
    + `<span class="w">Episko only runs the safe <b>git branch -d</b>, so git refuses anything it can't see as merged`
    + `${b.gone ? " — which includes a squash-merged branch" : ""}. If it does, you get a terminal with <b>-D</b> ready.</span>`
    + `<span class="row"><button class="wt-cbtn danger" type="button" data-wtact="delbranch">Delete branch</button>`
    + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
}

// Safe-delete only; on refusal the `-D` command goes to a terminal, never to a click.
async function wtDeleteBranch() {
  const d = wtRows[wtSel];
  if (!d || d.kind !== "branch" || !wtCtx || wtBusy) return;
  const { project, repoDir } = wtCtx, branch = d.br!.name;
  wtBusy = true;
  try {
    const r = await invoke<GitActionResult>("delete_branch", { repoDir, branch });
    dlog(r.ok ? "info" : "warn", `branch delete · ${branch} · ${r.summary}`);
    toast(r.ok ? r.summary : `${r.summary} → opening a terminal`);
    if (!r.ok && r.suggest) {
      closeWt();
      await handToTerminal(project, repoDir, r.suggest, { colorKey: repoDir });
      return;
    }
    wtArmed = "";
    await wtLoad(true);
  } catch (e) {
    dlog("error", `branch delete failed: ${e}`);
    toast("branch: " + e);
  } finally { wtBusy = false; renderAll(); }
}

// The start-point for a NEW branch. Defaults to the repo's HEAD, which is what git
// does — but silently, and that silence is the problem: a root parked on a feature
// branch makes every new worktree a child of it. Naming the parent (and letting it be
// changed) is cheaper and far safer than switching the root just to branch elsewhere.
function wtBaseSelect(): string {
  const head = wtRepoBranch || "HEAD";
  return wtPickBtn("base", wtBase || head) + (wtBase ? "" : ` <span class="dim">the repo's current branch</span>`);
}
/** Options for the base chooser: the repo's HEAD first, then every other local branch. */
function wtBaseOptions(): BranchPick[] {
  const head = wtRepoBranch || "HEAD";
  return [{ name: head, note: "the repo's current branch" }]
    .concat(wtBranches.filter((b) => !b.current).map((b) => ({ name: b.name, note: b.rel || "" })));
}

// Move the root folder itself to another branch. Episko's answer to "work on another
// branch" is normally a worktree, and this stays deliberately secondary — but the root's
// branch is the default parent of every new worktree, so a root parked somewhere stale
// needed an escape that wasn't "drop to a shell".
function wtSwitchHtml(): string {
  if (!wtCtx) return "";
  const running = wtSessionsIn(wtCtx.repoDir).length;
  const pick = wtSwitchable();
  if (running) {
    return `<div class="wt-danger"><span class="q">Switch this folder's branch?</span>`
      + `<span class="w"><span class="em">${running} session${running === 1 ? " is" : "s are"} running here.</span> `
      + `Switching would move the ground under ${running === 1 ? "it" : "them"} mid-edit, so Episko won't. Close ${running === 1 ? "it" : "them"} first.</span>`
      + `<span class="row"><button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  if (!pick.length) {
    return `<div class="wt-danger"><span class="q">Switch this folder's branch?</span>`
      + `<span class="w">Every other branch is already checked out in a worktree, so there is nothing to switch to.</span>`
      + `<span class="row"><button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  const sel = wtSwitchTo || pick[0].name;
  return `<div class="wt-danger"><span class="q">Switch <b>${esc(basename(wtCtx.repoDir))}</b> to another branch?</span>`
    + `<span class="w">The repo's own folder moves — every worktree keeps its own branch, untouched. `
    + `This also changes what new worktrees branch from by default.</span>`
    + `<span class="row">${wtPickBtn("switch", sel)}</span>`
    + `<span class="w">Episko only switches a <b>clean</b> tree: git would carry uncommitted changes across to the new branch, `
    + `which is a change it never announced. If yours is dirty you get a terminal instead.</span>`
    + `<span class="row"><button class="wt-cbtn danger" type="button" data-wtact="doswitch">Switch branch</button>`
    + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
}

/** Branches the root can actually move to: not current, not held by a worktree. */
function wtSwitchOptions(): BranchPick[] {
  // git allows exactly one checkout per branch, so anything a worktree holds — or the
  // root already has — can't be switched to. List them anyway, disabled and explained:
  // silently omitting them is what made `dev` look like it had gone missing.
  const held = new Map<string, string>();
  for (const w of wtWts) if (!w.is_main && w.branch) held.set(w.branch, basename(w.path));
  return wtBranches.map((b) => b.current
    ? { name: b.name, note: "already checked out here", disabled: true }
    : held.has(b.name)
      ? { name: b.name, note: `checked out in ${held.get(b.name)}/`, disabled: true }
      : { name: b.name, note: b.rel || "" });
}
const wtSwitchable = () => wtSwitchOptions().filter((o) => !o.disabled);
async function wtDoSwitch() {
  if (!wtCtx || wtBusy) return;
  const { project, repoDir } = wtCtx;
  const branch = wtSwitchTo || wtSwitchable()[0]?.name;
  if (!branch) return;
  wtBusy = true;
  try {
    const r = await invoke<GitActionResult>("switch_branch", { repoDir, branch });
    dlog(r.ok ? "info" : "warn", `switch · ${basename(repoDir)} · ${r.summary}`);
    toast(r.ok ? r.summary : `${r.summary} → opening a terminal`);
    if (!r.ok && r.suggest) {
      closeWt();
      await handToTerminal(project, repoDir, r.suggest, { colorKey: repoDir });
      return;
    }
    wtArmed = ""; wtSwitchTo = ""; wtRepoBranch = branch;
    await wtLoad(true);
  } catch (e) {
    dlog("error", `switch failed: ${e}`);
    toast("switch: " + e);
  } finally { wtBusy = false; renderAll(); }
}

// ---------- branch chooser ----------
// A picker for the two places the dialog needs one: the new-worktree base, and the
// root-switch target. Built from the .menupop/.mp-item idiom the engine, caffeinate,
// shortcuts, usage and colour menus already share, so it reads as part of the app
// rather than as the one piece of system chrome on a fully custom surface.
//
// It lives at body level (#bPop) because .wtdlg is overflow:hidden — anchored inside,
// it would be clipped. Typing filters, because a repo can hold BRANCH_LIST_CAP refs
// and "scroll until you see it" is not a choice.
interface BranchPick {
  name: string;
  note: string;
  /** Shown, but not choosable — with `note` carrying the reason. A branch that simply
   *  vanishes from the list reads as a bug: you go looking for `dev`, it isn't there,
   *  and nothing tells you it's held by a worktree. */
  disabled?: boolean;
}
let bPopItems: BranchPick[] = [];
let bPopSel = 0;
let bPopOn: ((name: string) => void) | null = null;
let bPopAnchor: HTMLElement | null = null;

function bPopOpen() { return $("bPop").classList.contains("show"); }
function openBranchPop(anchor: HTMLElement, items: BranchPick[], current: string, onPick: (name: string) => void) {
  bPopItems = items; bPopOn = onPick; bPopAnchor = anchor;
  const at = items.findIndex((i) => i.name === current);
  bPopSel = at >= 0 && !items[at].disabled ? at : bPopFirst(items);
  const pop = $("bPop");
  pop.innerHTML = `<div class="bp-q"><span>❯</span><input id="bPopQ" spellcheck="false" autocomplete="off" placeholder="Filter branches…" aria-label="Filter branches" /></div><div class="bp-list" id="bPopList" role="listbox"></div>`;
  pop.classList.add("show");
  anchor.classList.add("open");
  renderBranchPop();
  // Anchor below the trigger, flipping above when that would run off the bottom.
  const r = anchor.getBoundingClientRect(), h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  setTimeout(() => ($("bPopQ") as HTMLInputElement)?.focus(), 20);
}
function renderBranchPop() {
  const q = (($("bPopQ") as HTMLInputElement)?.value || "").trim().toLowerCase();
  const shown = bPopItems.filter((i) => !q || i.name.toLowerCase().includes(q));
  if (bPopSel >= shown.length) bPopSel = Math.max(0, shown.length - 1);
  $("bPopList").innerHTML = shown.length
    ? shown.map((i, n) => `<button class="mp-item${n === bPopSel ? " on" : ""}${i.disabled ? " dis" : ""}" type="button" role="option"`
        + ` aria-selected="${n === bPopSel}" aria-disabled="${!!i.disabled}"${i.disabled ? " disabled" : ""} data-bpick="${esc(i.name)}">`
        + `<span class="mp-ic">${i.disabled ? "⊘" : "⌥"}</span><span class="mp-main"><span class="mp-l">${esc(i.name)}</span>`
        + (i.note ? `<span class="mp-s">${esc(i.note)}</span>` : "")
        + `</span><span class="mp-check">✓</span></button>`).join("")
    : `<div class="bp-none">No branch matches that.</div>`;
  $("bPopList").querySelector(".mp-item.on")?.scrollIntoView({ block: "nearest" });
}
function bPopShown(): BranchPick[] {
  const q = (($("bPopQ") as HTMLInputElement)?.value || "").trim().toLowerCase();
  return bPopItems.filter((i) => !q || i.name.toLowerCase().includes(q));
}
/** Next choosable row in `dir`, or stay put if there is none — so arrow keys step over
 *  the disabled entries instead of parking on something Enter can't take. */
function bPopStep(shown: BranchPick[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (!shown[i].disabled) return i;
  return from;
}
const bPopFirst = (shown: BranchPick[]) => { const i = shown.findIndex((x) => !x.disabled); return i < 0 ? 0 : i; };
function closeBranchPop(refocus = true) {
  if (!bPopOpen()) return;
  $("bPop").classList.remove("show");
  bPopAnchor?.classList.remove("open");
  bPopAnchor = null; bPopOn = null;
  if (refocus && $("wtDlg").classList.contains("show")) ($("wtQ") as HTMLInputElement).focus();
}
function bPopPick(name: string) { const cb = bPopOn; closeBranchPop(); cb?.(name); }

$("bPop").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bpick]");
  if (b) bPopPick(b.dataset.bpick!);
});
$("bPop").addEventListener("input", () => { bPopSel = bPopFirst(bPopShown()); renderBranchPop(); });
$("bPop").addEventListener("keydown", (e) => {
  const shown = bPopShown();
  if (e.key === "ArrowDown") { e.preventDefault(); bPopSel = bPopStep(shown, bPopSel, 1); renderBranchPop(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); bPopSel = bPopStep(shown, bPopSel, -1); renderBranchPop(); }
  else if (e.key === "Enter") { e.preventDefault(); const p = shown[bPopSel]; if (p && !p.disabled) bPopPick(p.name); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBranchPop(); }
});

/** The trigger: reads as a field holding a value, not as a button. */
function wtPickBtn(kind: "base" | "switch", label: string): string {
  return `<button class="wt-pick" type="button" data-wtpick="${kind}" aria-haspopup="listbox">`
    + `<span class="v">${esc(label)}</span><span class="c">▾</span></button>`;
}

function closeWt() {
  closeBranchPop(false);
  $("wtDlg").classList.remove("show"); dropScrim();
  clearInterval(wtAgeT); wtAgeT = undefined;
  wtCtx = null; wtArmed = ""; wtGen++;
}

/** What ⏎ (and the pane's primary button) does for the highlighted row. */
function wtRun(d: Dest | undefined) {
  if (!d || !wtCtx || wtBusy) return;
  const { project, repoDir } = wtCtx;
  if (d.kind === "repo") { closeWt(); launch(project, repoDir, { colorKey: repoDir, branch: wtRepoBranch }); return; }
  if (d.kind === "wt") {
    const w = d.wt!;
    if (!w.exists) { toast(`${basename(w.path)} is gone — remove it instead`); return; }
    closeWt();
    // Always a NEW session: a second agent on one branch is a normal thing to want.
    // The session chips in the pane are what jump to a running one.
    launch(project, w.path, { colorKey: repoDir, worktree: wtLabelOf(w), branch: d.branch });
    return;
  }
  if (d.clash) { toast(`${basename(d.clash.path)}/ already exists`); return; }
  void wtCreate(d.branch, d.kind === "create" ? wtBase : "");
}

async function wtCreate(branch: string, base = "") {
  if (!wtCtx || wtBusy) return;
  const { project, repoDir } = wtCtx;
  wtBusy = true;
  try {
    const path = await invoke<string>("create_worktree", { repoDir, branch, base: base || null });
    closeWt();
    launch(project, path, { colorKey: repoDir, worktree: branch, branch });
    toast(`Worktree ${branch} created`);
  } catch (e) {
    dlog("error", `worktree create failed (${branch}): ${e}`);
    toast("worktree: " + e);
  } finally { wtBusy = false; }
}

// The backend never forces: a dirty tree is refused and its --force command handed to
// a terminal, so nothing uncommitted is ever clobbered by a click here.
async function wtDoRemove(deleteBranch: boolean) {
  const d = wtRows[wtSel];
  if (!d || d.kind !== "wt" || !wtCtx || wtBusy) return;
  const w = d.wt!, { project, repoDir } = wtCtx;
  wtBusy = true;
  try {
    const r = await invoke<GitActionResult>("remove_worktree", { repoDir, path: w.path, branch: w.branch, deleteBranch });
    dlog(r.ok ? "info" : "warn", `worktree remove · ${w.branch || w.path} · ${r.summary}`);
    toast(r.ok ? r.summary : `${r.summary} → opening a terminal`);
    if (!r.ok && r.suggest) {
      // The handoff must run from the repo root, never the worktree being deleted —
      // git refuses to remove the tree you're standing in.
      closeWt();
      await handToTerminal(project, repoDir, r.suggest, { colorKey: repoDir });
      return;
    }
    wtArmed = "";
    await wtLoad(true);
  } catch (e) {
    dlog("error", `worktree remove failed: ${e}`);
    toast("worktree: " + e);
  } finally { wtBusy = false; renderAll(); }
}

// The action-panel "Remove this worktree" flow: guard uncommitted work, then close
// the session and remove its worktree (safe-deleting the branch if it's merged).
async function removeWorktreeSession(s: Sess) {
  const repoDir = s.colorKey, path = s.workdir, branch = s.branch;
  // Never close a session that still has a dirty tree — hand the decision (and a
  // shell) over instead. git_diffstat is null for a non-repo; treat that as "clean
  // enough to try", since the backend still refuses (without forcing) if it's wrong.
  const ds = await invoke<DiffStat | null>("git_diffstat", { workdir: path }).catch(() => null);
  if (ds && ds.dirty > 0) {
    toast(`${branch || "worktree"}: uncommitted changes — commit or discard first`);
    await handToTerminal(s.project, path, "git status", { colorKey: repoDir, worktree: s.worktree, branch });
    return;
  }
  if (!await ask(`Remove the worktree at ${basename(path)}/?\n\nIts session closes, the folder goes, and its branch is deleted only if it's fully merged.`,
    { title: "Remove worktree", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" })) return;
  closeSession(s.id);
  await invoke("kill_session", { sessionId: s.id }).catch(() => {}); // ensure the backend guard sees it gone
  try {
    const r = await invoke<GitActionResult>("remove_worktree", { repoDir, path, branch, deleteBranch: true });
    dlog(r.ok ? "info" : "warn", `worktree remove · ${branch || path} · ${r.summary}`);
    if (r.ok) toast(r.summary);
    else if (r.suggest) { toast(`${r.summary} → opening a terminal`); await handToTerminal(s.project, repoDir, r.suggest, { colorKey: repoDir }); }
    else toast(r.summary);
  } catch (e) {
    dlog("error", `worktree remove failed: ${e}`);
    toast("worktree: " + e);
  }
  renderAll();
}

// ---------- settings dialog ----------
// A sidebar-tab settings window built on the shared #scrim + `.show` overlay (same
// pattern as #wtDlg / #palette). Every control is a small declarative descriptor
// that writes its cc-* key through the SAME setter the rest of the app uses, so a
// change here is instantly live and persisted — there is no separate settings store.
type SetSeg = { value: string; label: string; sub?: string; glyph?: string };
// A control is a segmented picker (radio-style), the font stepper, or the worktree-
// grouping preview grid (segmented pick shown as live mini-sidebars instead of text).
type SetControl =
  | { kind: "seg"; set: string; label: string; hint?: string; active: () => string; segs: () => SetSeg[] }
  | { kind: "font"; label: string; hint?: string }
  | { kind: "wtpreview"; label: string; hint?: string; active: () => string };
// Most tabs are a list of declarative controls; a tab may instead supply `render`
// for a bespoke pane (the Usage analytics tab), which also widens the dialog.
interface SetTab { id: string; label: string; glyph: string; controls: () => SetControl[]; render?: () => string }

const SORT_SHORT: Record<SortMode, string> = { manual: "Manual", active: "Active", attention: "Attention" };
// One-line descriptions of each worktree-grouping mode (mirrors the WtGroup comment block).
const WT_GROUP_SEGS: SetSeg[] = [
  { value: "off",       label: "Off",       glyph: "≡", sub: "Flat rows; branch shown only as a fallback label" },
  { value: "subheader", label: "Subheader", glyph: "⑃", sub: "A branch header per worktree, sessions nested beneath" },
  { value: "toplevel",  label: "Top level", glyph: "⊞", sub: "Each worktree becomes its own top-level project group" },
  { value: "chip",      label: "Chip",      glyph: "◆", sub: "Flat rows; each worktree row carries a colour-coded chip" },
];

const SET_TABS: SetTab[] = [
  {
    id: "appearance", label: "Appearance", glyph: "◐",
    controls: () => [
      { kind: "seg", set: "theme", label: "Theme", hint: "Light or dark surfaces across the whole app.",
        active: () => effectiveTheme(),
        segs: () => [
          { value: "light", label: "Light", glyph: "☀", sub: "Bright surfaces" },
          { value: "dark",  label: "Dark",  glyph: "☾", sub: "Dim surfaces" },
        ] },
      { kind: "font", label: "Terminal font size", hint: "Text size in embedded terminals (also ⌘+ / ⌘− / ⌘0)." },
    ],
  },
  {
    id: "sessions", label: "Sessions", glyph: "▤",
    controls: () => [
      { kind: "seg", set: "engine", label: "Launch engine", hint: "Where a new session's terminal opens.",
        active: () => termEngine,
        segs: () => availEngines.map((id) => { const d = engineDef(id); return { value: id, label: d.label, sub: d.sub, glyph: id === "embedded" ? "▤" : "⧉" }; }) },
      { kind: "seg", set: "sort", label: "Sidebar sort", hint: "How projects and sessions are ordered in the sidebar.",
        active: () => sortMode,
        segs: () => SORT_MODES.map((m) => ({ value: m, label: SORT_SHORT[m], sub: SORT_META[m].label, glyph: SORT_META[m].glyph })) },
    ],
  },
  {
    id: "worktrees", label: "Worktrees", glyph: "⑃",
    controls: () => [
      { kind: "wtpreview", label: "Worktree grouping",
        hint: "How several checkouts of one repo are shown within its project group. Pick the look that reads best for you.",
        active: () => wtGroup },
    ],
  },
  {
    id: "usage", label: "Usage", glyph: "▦",
    controls: () => [],
    render: () => usagePanelHtml(),
  },
];

let setTab = "appearance";
function settingsOpen() { return $("setDlg").classList.contains("show"); }
function openSettings() { $("scrim").classList.add("show"); $("setDlg").classList.add("show"); renderSettings(); }
function closeSettings() {
  $("setDlg").classList.remove("show");
  dropScrim();
}
function renderSettings() {
  if (!settingsOpen()) return;
  $("setTabs").innerHTML = SET_TABS.map((t) =>
    `<button class="set-tab ${t.id === setTab ? "on" : ""}" data-settab="${t.id}"><span class="set-tglyph">${t.glyph}</span>${esc(t.label)}</button>`
  ).join("");
  const tab = SET_TABS.find((t) => t.id === setTab) || SET_TABS[0];
  // The Usage tab is a wide, bespoke pane; every other tab is the narrow control list.
  $("setDlg").classList.toggle("wide", !!tab.render);
  // Preserve scroll across the full-body rebuild so picking a card lower in the
  // (scrollable) Worktrees grid doesn't jump the view back to the top.
  const body = $("setBody");
  const sc = body.scrollTop;
  body.innerHTML = tab.render ? tab.render() : tab.controls().map(renderSetControl).join("");
  body.scrollTop = sc;
  if (tab.id === "usage") refreshTokens(); // kick the (throttled, cached) token scan
}
// Demo roster for the worktree-grouping previews: one repo, a main checkout plus two
// worktrees, so each grouping mode visibly differs. Static on purpose — the preview
// is about layout, not live state — and self-contained so it never drags the real
// sidebar renderers (status glyphs, close buttons, telemetry) into a settings pane.
const WT_DEMO_HUE: Record<string, string> = { dev: "#818cf8", "agent-1": "#2dd4bf", "agent-2": "#f472b6" };
const WT_DEMO_ORDER = ["dev", "agent-1", "agent-2"];
const WT_DEMO: { title: string; st: "work" | "done"; ctx: number; branch: string }[] = [
  { title: "Fix telemetry routing", st: "work", ctx: 12, branch: "dev" },
  { title: "Bump CI actions",       st: "done", ctx: 61, branch: "dev" },
  { title: "Worktree cleanup",      st: "work", ctx: 34, branch: "agent-1" },
  { title: "Settings previews",     st: "done", ctx: 8,  branch: "agent-2" },
];
function wtDemoClusters() {
  return WT_DEMO_ORDER.map((b) => ({ branch: b, hue: WT_DEMO_HUE[b], isMain: b === "dev", sessions: WT_DEMO.filter((s) => s.branch === b) }));
}
function wtDemoRow(s: (typeof WT_DEMO)[number], chip = false): string {
  const chipHtml = chip ? `<span class="p-chip" style="--h:${WT_DEMO_HUE[s.branch]}">⑃ ${esc(s.branch)}</span>` : "";
  return `<div class="p-row"><span class="p-dot p-${s.st}"></span><span class="p-lbl">${esc(s.title)}</span>${chipHtml}<span class="p-ctx">${s.ctx}%</span></div>`;
}
function wtDemoHead(name: string, count: number, wt?: string): string {
  const suffix = wt ? `<span class="p-pwt">· ${esc(wt)}</span>` : "";
  return `<div class="p-phead"><span class="p-pdot"></span><span class="p-pname">${esc(name)}${suffix}</span><span class="p-pcount">${count}</span></div>`;
}
// One mini-sidebar per grouping mode — mirrors groupBody()'s shape (off/toplevel flat,
// subheader nested clusters, chip flat-with-branch-chips) so the card previews what the
// real sidebar does.
function wtPreviewBody(mode: WtGroup): string {
  if (mode === "subheader") {
    return wtDemoHead("episko", WT_DEMO.length) + wtDemoClusters().map((c) =>
      `<div class="p-wthead"><span class="p-fork" style="color:${c.hue}">⑃</span>`
      + `<span class="p-wtname" style="color:${c.hue}">${esc(c.branch)}</span>`
      + `<span class="p-wtcount">${c.sessions.length}</span></div>`
      + `<div class="p-wts" style="--h:${c.hue}">${c.sessions.map((s) => wtDemoRow(s)).join("")}</div>`
    ).join("");
  }
  if (mode === "toplevel") {
    const cs = wtDemoClusters();
    const main = cs.find((c) => c.isMain)!;
    let h = wtDemoHead("episko", main.sessions.length) + `<div class="p-rows">${main.sessions.map((s) => wtDemoRow(s)).join("")}</div>`;
    for (const c of cs.filter((c) => !c.isMain)) h += wtDemoHead("episko", c.sessions.length, c.branch) + `<div class="p-rows">${c.sessions.map((s) => wtDemoRow(s)).join("")}</div>`;
    return h;
  }
  const chip = mode === "chip";
  return wtDemoHead("episko", WT_DEMO.length) + `<div class="p-rows">${WT_DEMO.map((s) => wtDemoRow(s, chip)).join("")}</div>`;
}
// The worktree-grouping picker as a grid of selectable, live-preview cards. Each card
// carries the same data-set/data-val the seg picker uses, so the existing #setBody
// click handler routes it through applySetting → setWtGroup with no new wiring.
function renderWtPreview(active: string): string {
  const cards = WT_GROUP_SEGS.map((m) => {
    const on = m.value === active;
    return `<button class="wtcard${on ? " on" : ""}" data-set="wtgroup" data-val="${esc(m.value)}" aria-pressed="${on}">`
      + `<div class="wtcard-h"><span class="wtcard-glyph">${m.glyph || ""}</span><span class="wtcard-name">${esc(m.label)}</span><span class="wtcard-check">✓</span></div>`
      + `<div class="p-mini">${wtPreviewBody(m.value as WtGroup)}</div>`
      + `<div class="wtcard-desc">${esc(m.sub || "")}</div></button>`;
  }).join("");
  return `<div class="wt-grid has-sel">${cards}</div>`;
}
function renderSetControl(c: SetControl): string {
  const head = `<div class="set-glabel">${esc(c.label)}</div>${c.hint ? `<div class="set-hint">${esc(c.hint)}</div>` : ""}`;
  if (c.kind === "wtpreview") {
    return `<div class="set-group">${head}${renderWtPreview(c.active())}</div>`;
  }
  if (c.kind === "font") {
    return `<div class="set-group">${head}<div class="set-font">
      <button class="set-fbtn" data-setfont="-0.5" title="Smaller" aria-label="Smaller">−</button>
      <span class="set-fval mono">${termFontSize}px</span>
      <button class="set-fbtn" data-setfont="0.5" title="Larger" aria-label="Larger">+</button>
      <button class="set-freset" data-setfont="reset">Reset</button>
    </div></div>`;
  }
  const active = c.active();
  const opts = c.segs().map((s) =>
    `<button class="seg-opt ${s.value === active ? "on" : ""}" data-set="${c.set}" data-val="${esc(s.value)}">` +
      `<span class="seg-top">${s.glyph ? `<span class="seg-glyph">${s.glyph}</span>` : ""}<span class="seg-l">${esc(s.label)}</span><span class="seg-check">✓</span></span>` +
      `${s.sub ? `<span class="seg-s">${esc(s.sub)}</span>` : ""}</button>`
  ).join("");
  return `<div class="set-group">${head}<div class="seg">${opts}</div></div>`;
}
// Dispatch a segmented pick to the existing setter, then repaint the picker.
function applySetting(set: string, val: string) {
  if (set === "theme") setTheme(val as "dark" | "light");
  else if (set === "engine") setEngine(val as Engine);
  else if (set === "sort") setSort(val as SortMode);
  else if (set === "wtgroup") setWtGroup(val as WtGroup);
  renderSettings();
}
function setFontFromSettings(cmd: string) {
  if (cmd === "reset") { termFontSize = 12.5; applyFontSize(); toast("Terminal font 12.5px"); }
  else bumpFont(parseFloat(cmd));
  renderSettings();
}

// ---------- events ----------
listen<{ sessionId: string; data: string }>("pty-output", (e) => {
  const s = sessions.get(e.payload.sessionId); if (!s?.term) return;
  s.term.write(Uint8Array.from(atob(e.payload.data), (c) => c.charCodeAt(0)));
});
listen<{ sessionId: string; code: number }>("pty-exit", (e) => {
  dlog("info", `pty-exit ${e.payload.sessionId.slice(0, 8)} · code ${e.payload.code}`);
  const s = sessions.get(e.payload.sessionId); if (!s) return;
  s.phase = "ended"; s.attention = null;
  s.term?.writeln(`\r\n\x1b[90m[claude exited: code ${e.payload.code}]\x1b[0m`);
  renderAll();
});
listen<{ kind: string; data: any }>("telemetry", (e) => {
  const { kind, data } = e.payload; if (!data) return;
  telem.rx++;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { telem.dropped++; dlog("warn", `${kind} telemetry for unrouted session ${sid ? sid.slice(0, 8) : "?"} — dropped`); return; }
  telem.routed++;
  // Claude's own id, preserved by the telemetry server before it forced ours on.
  // It rotates on /clear, /compact and /resume — and each rotation opens a fresh
  // transcript — so this, not s.id, is what a later --resume has to target.
  const rt: string | undefined = data.claude_session_id?.toLowerCase?.();
  if (rt && rt !== s.resumeId) {
    dlog("info", `session ${s.id.slice(0, 8)} rotated id → ${rt.slice(0, 8)} (restore now targets it)`);
    s.resumeId = rt;
    flushRoster(); // rare and load-bearing — never let a debounce lose this one
  }
  if (kind === "statusline") applyStatusline(s, data); else { dlog("info", `hook ${data.hook_event_name ?? "?"} · ${sid!.slice(0, 8)}`); applyHook(s, data); }
  queueRosterSave();
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
  // A reorder just ended: eat the click a pointerup may have synthesised (see initProjectDnD).
  if (performance.now() < reorderGuardUntil) { reorderGuardUntil = 0; return; }
  const t = e.target as HTMLElement;
  if (!t.closest("#colorPop, #ctxMenu, .pdot, .rm-dot")) closeColorPop();
  if (!t.closest("#ctxMenu, #colorPop")) closeCtxMenu();
  if (!t.closest("#enginePop, #fEngineSeg")) closeEnginePop();
  if (!t.closest("#cafPop, #caf")) closeCafPop();
  if (!t.closest("#usagePop, #fUsageSeg")) closeUsagePop();
  if (!t.closest("#attnPop, #attnBadge")) closeAttnPop();
  if (!t.closest("#shortPop, #fShortSeg")) closeShortPop();
  if (!t.closest("#bPop, [data-wtpick]")) closeBranchPop(false);
  const dot = t.closest<HTMLElement>(".pdot, .rm-dot");
  if (dot) { const owner = dot.closest<HTMLElement>("[data-key]"); if (owner?.dataset.key) { openColorPopover(owner.dataset.key, e.clientX, e.clientY + 6); return; } }
  // data-forget and data-resume sit INSIDE a data-past row, so they must be matched
  // (and dispatched) ahead of it or the row's own click would swallow them.
  const el = t.closest<HTMLElement>("[data-perm],[data-git],[data-diff],[data-close],[data-remove],[data-add],[data-jump],[data-resume],[data-forget],[data-ext],[data-past],[data-sel],[data-launch],[data-pal],[data-rail],[data-toast]");
  if (!el) return;
  if (el.dataset.perm) resolvePermission(el.dataset.permid || "", el.dataset.perm);
  else if (el.dataset.git) runGit(el.dataset.gitsid || "", el.dataset.git);
  else if (el.dataset.diff) openDiff(el.dataset.diff, el.dataset.difftitle || "");
  else if (el.dataset.close) closeSession(el.dataset.close);
  else if (el.dataset.remove) removeFavorite(el.dataset.remove);
  else if (el.dataset.add) addProject();
  else if (el.dataset.jump) jumpExternal(+el.dataset.jump);
  else if (el.dataset.resume) resumeDormant(el.dataset.resume);
  else if (el.dataset.forget) forgetDormant(el.dataset.forget);
  else if (el.dataset.ext) openExternal(el.dataset.ext);
  else if (el.dataset.past) openDormant(el.dataset.past);
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
// Show a floating panel, then clamp it inside the viewport against its *measured*
// size — these panels change height with their optional rows, so a hard-coded
// estimate would hang them off-screen.
function placePop(el: HTMLElement, x: number, y: number) {
  el.classList.add("show");
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)) + "px";
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)) + "px";
}
// The appearance panel: colour swatches + logo. Opens standalone at the cursor
// (clicking a colour dot) or as the context menu's submenu — `flipFrom` is the
// parent menu's rect, so a panel that won't fit to its right lands on its left
// instead of being shoved back over the menu it belongs to.
function openColorPopover(key: string, x: number, y: number, flipFrom?: DOMRect) {
  popKey = key;
  closeFootMenus("colorPop");
  const cur = accentFor(key).toLowerCase();
  const pop = $("colorPop");
  pop.innerHTML =
    SWATCHES.map((c) => `<button class="sw-btn ${c === cur ? "on" : ""}" style="background:${c}" data-c="${c}"></button>`).join("") +
    `<div class="sw-row"><input class="sw-hex" type="text" spellcheck="false" placeholder="#hex" value="${cur}" maxlength="7" /><button class="sw-apply">Set</button></div>` +
    `<button class="sw-auto" data-c="auto">Auto color</button>` +
    `<button class="sw-auto" data-c="seticon">Set custom logo…</button>` +
    (customIcons[key] ? `<button class="sw-auto" data-c="reseticon">Restore repo logo</button>` : "") +
    (iconFor(key) ? `<button class="sw-auto" data-c="delicon">Use color dot (hide icon)</button>` : "");
  pop.classList.add("show"); // shown before measuring, or offsetWidth reads 0
  if (flipFrom && x + pop.offsetWidth > window.innerWidth - 8) x = flipFrom.left - pop.offsetWidth - 6;
  placePop(pop, x, y);
}
function closeColorPop() {
  $("colorPop").classList.remove("show");
  popKey = null;
  $("ctxMenu").querySelector(".sub-open")?.classList.remove("sub-open");
}
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
  // Every button here commits something, so the whole stack (submenu + the menu
  // that opened it) closes with it.
  const key = popKey;
  closeCtxMenu();
  if (b.dataset.c === "delicon") { clearIcon(key); closeColorPop(); return; }
  if (b.dataset.c === "seticon") { closeColorPop(); pickCustomIcon(key); return; }
  if (b.dataset.c === "reseticon") { resetCustomIcon(key); closeColorPop(); return; }
  setColor(key, b.dataset.c === "auto" ? null : b.dataset.c!);
});
$("colorPop").addEventListener("keydown", (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sw-hex") && e.key === "Enter") { e.preventDefault(); commitHex((t as HTMLInputElement).value); }
});
// ---------- project context menu ----------
// Right-clicking anything that carries a project folder (`data-key` — a project
// head, an external row, a rail button) opens a real menu: one verb per row, with
// colour and logo tucked into an Appearance submenu (the swatch panel above,
// reused verbatim) so the everyday actions stay one click deep.
let ctxKey: string | null = null;
const projName = (key: string) => FAVORITES.find((f) => f.path === key)?.name || basename(key);
// Where "Open project folder" actually lands, so the row can name it.
const FILE_MANAGER = navigator.userAgent.includes("Windows") ? "Explorer" : navigator.userAgent.includes("Mac") ? "Finder" : "file manager";

type CtxRow = { act: string; ic: string; label: string; sub?: string; cls?: string; chev?: boolean };
const ctxRowHtml = (r: CtxRow) =>
  `<button class="mp-item ${r.cls || ""}" data-ctx="${r.act}"><span class="mp-ic">${r.ic}</span>`
  + `<span class="mp-main"><span class="mp-l">${esc(r.label)}</span>${r.sub ? `<span class="mp-s">${esc(r.sub)}</span>` : ""}</span>`
  + (r.chev ? `<span class="mp-chev">›</span>` : "") + `</button>`;

function openCtxMenu(key: string, x: number, y: number) {
  closeColorPop();
  ctxKey = key;
  const fav = FAVORITES.some((f) => f.path === key);
  const live = [...sessions.values()].filter((s) => s.colorKey === key && !s.shell).length;
  const ic = iconFor(key);
  const rows: (CtxRow | null)[] = [
    { act: "launch", ic: "＋", label: "New session", sub: live ? `${live} already running here` : "start Claude Code in this folder" },
    { act: "worktree", ic: "⑃", label: "New worktree session…", sub: "on a branch of its own" },
    { act: "terminal", ic: "❯", label: "Open terminal here", sub: termEngine === "embedded" ? "shell pane inside Episko" : engineDef(termEngine).label },
    null,
    { act: "folder", ic: "⌂", label: "Open project folder", sub: FILE_MANAGER },
    { act: "copypath", ic: "⧉", label: "Copy path" },
    null,
    { act: "appearance", ic: "◐", label: "Appearance", sub: "color, logo", chev: true },
    null,
    // Not every group in the sidebar is pinned: a folder also shows up while it has
    // a live or external session, then vanishes with it. So the row is about
    // *permanence*, not presence — say so, or "add" reads as a lie about a project
    // that's plainly already listed.
    fav
      ? { act: "removeproj", ic: "✕", label: "Remove project", sub: "unpins it — sessions keep running", cls: "mp-danger" }
      : { act: "addproj", ic: "☆", label: "Pin to sidebar", sub: "keeps it listed with no session running" },
  ];
  const menu = $("ctxMenu");
  menu.innerHTML =
    `<div class="mp-head">`
    + (ic ? `<img class="mp-hico" src="${ic}" alt="" />` : `<span class="mp-hsw" style="background:${accentFor(key)}"></span>`)
    + `<span class="mp-hmain"><span class="mp-hname">${esc(projName(key))}</span><span class="mp-hpath">${esc(tilde(key))}</span></span></div>`
    + rows.map((r) => (r ? ctxRowHtml(r) : `<div class="mp-sep"></div>`)).join("");
  placePop(menu, x, y);
  // A worktree only means something in a git repo. Ask *after* opening — the menu
  // must feel instant — then either name the branch it would fork from or drop the
  // row entirely. (A detached HEAD also answers None and loses the row; forking a
  // worktree from one is a corner case not worth a second probe.)
  invoke<string | null>("git_branch", { workdir: key }).then((b) => {
    if (ctxKey !== key) return; // menu closed or moved to another project meanwhile
    const row = menu.querySelector<HTMLElement>('[data-ctx="worktree"]');
    if (!row) return;
    if (!b) { row.remove(); placePop(menu, x, y); return; }
    const sub = row.querySelector(".mp-s");
    if (sub) sub.textContent = `branch off ${b}`;
  }).catch(() => {});
}
function closeCtxMenu() { $("ctxMenu").classList.remove("show"); ctxKey = null; }
const ctxMenuOpen = () => $("ctxMenu").classList.contains("show");

// A plain shell in this project's folder — embedded gets an in-app pane, the
// external engines their own window (the same split as openPlainTerminal).
function openTerminalIn(project: string, dir: string) {
  if (termEngine !== "embedded") { invoke("open_terminal_here", { workdir: dir, engine: termEngine }).catch((e) => toast("terminal: " + e)); return; }
  void launchShell(project, dir, { colorKey: dir });
}
async function copyPath(dir: string) {
  try { await navigator.clipboard.writeText(dir); toast("Path copied"); }
  catch { toast(dir); } // clipboard denied — at least show what it was
}

// Appearance is the one row that opens rather than commits: the menu stays put and
// the swatch panel hangs off its edge. Re-entrant — `mouseover` fires again for
// every child span the pointer crosses, and re-rendering the panel under the
// cursor would wipe a half-typed hex.
function openAppearanceSub(row: HTMLElement) {
  if (!ctxKey || row.classList.contains("sub-open")) return;
  row.classList.add("sub-open");
  const m = $("ctxMenu").getBoundingClientRect(), r = row.getBoundingClientRect();
  openColorPopover(ctxKey, m.right + 6, r.top - 6, m);
}
// Hover opens the submenu, the way a menu should. Moving onto any *other* row
// folds it away again; moving right, into the panel itself, leaves the menu
// entirely, so nothing here fires and it stays put.
$("ctxMenu").addEventListener("mouseover", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!row) return;
  if (row.dataset.ctx === "appearance") openAppearanceSub(row);
  else closeColorPop();
});
$("ctxMenu").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!b || !ctxKey) return;
  const key = ctxKey, name = projName(key);
  // Clicking it is the keyboard/touch path to the same thing hover already did.
  if (b.dataset.ctx === "appearance") { openAppearanceSub(b); return; }
  closeCtxMenu(); closeColorPop();
  switch (b.dataset.ctx) {
    case "launch": requestLaunch(name, key); break;
    case "worktree": openWt(name, key); break;
    case "terminal": openTerminalIn(name, key); break;
    case "folder": openProjectFolder(key); break;
    case "copypath": copyPath(key); break;
    case "addproj": addProjectPath(key); break;
    case "removeproj": removeFavorite(key); toast(`Removed ${name}`); break;
  }
});
document.addEventListener("contextmenu", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
  if (!el || !el.dataset.key) return;
  e.preventDefault();
  openCtxMenu(el.dataset.key, e.clientX, e.clientY);
});

// ---------- terminal-engine popover (footer "new in …") ----------
function openEnginePopover() {
  const seg = $("fEngineSeg");
  const r = seg.getBoundingClientRect();
  const pop = $("enginePop");
  closeFootMenus("enginePop");
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
// The flags below are macOS `caffeinate` switches, and they stay the wire format
// on both platforms: the Windows backend maps them onto `SetThreadExecutionState`
// bits (see `execution_state_for`) rather than making the UI speak two dialects.
const IS_WINDOWS = navigator.userAgent.includes("Windows");
const CAF_HOST = IS_WINDOWS ? "PC" : "Mac";
type CafKind = "static" | "timer" | "agents";
interface CafPreset { id: string; kind: CafKind; label: string; desc: string; glyph: string; flags?: string[] }
const ALL_CAF_PRESETS: CafPreset[] = [
  { id: "display", kind: "static", label: "Keep display awake", desc: "Screen + system stay on",     glyph: "☀", flags: ["-d"] },
  { id: "system",  kind: "static", label: "Keep system awake",  desc: "Runs on; screen may sleep",   glyph: "⏻", flags: ["-i"] },
  { id: "full",    kind: "static", label: "Fully caffeinated",  desc: "Display, disk & system",      glyph: "✺", flags: ["-dimsu"] },
  { id: "timer",   kind: "timer",  label: "Timed",              desc: "Stay awake, then auto-off",   glyph: "◷" },
  { id: "agents",  kind: "agents", label: "Until agents idle",  desc: "Awake only while agents work", glyph: "⟳" },
];
// Windows has no disk (`-m`) or user-active (`-u`) assertion, so "Fully
// caffeinated" would be a second, identical "Keep display awake" row there.
// Drop it — the validity check below rewrites a stored "full" to the first preset.
const CAF_PRESETS: CafPreset[] = IS_WINDOWS ? ALL_CAF_PRESETS.filter((p) => p.id !== "full") : ALL_CAF_PRESETS;
// The popover's right-hand chip: the literal flags on macOS, the execution state
// they translate to on Windows, where the raw flags would be meaningless jargon.
function cafChip(p: CafPreset): string {
  const flags = p.kind === "agents" ? ["-i"] : (p.flags ?? []);
  if (!flags.length) return "";
  if (!IS_WINDOWS) return flags.join(" ");
  return flags.some((f) => f.includes("d")) ? "display" : "system";
}
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
    if (s.shell || s.phase === "ended") continue;
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
  $("cafMain").title = !cafArmed ? `Keep this ${CAF_HOST} awake · ${p.label}`
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
    const chip = p.kind === "timer" ? "" : cafChip(p);
    const right = chip ? `<span class="mp-flags">${esc(chip)}</span>` : "";
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
  closeFootMenus("cafPop");
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
$("setBtn").addEventListener("click", () => settingsOpen() ? closeSettings() : openSettings());
$("setClose").addEventListener("click", closeSettings);
$("setTabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-settab]");
  if (b) { setTab = b.dataset.settab!; renderSettings(); }
});
$("setBody").addEventListener("click", (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>("[data-setfont]");
  if (f) { setFontFromSettings(f.dataset.setfont!); return; }
  const r = (e.target as HTMLElement).closest<HTMLElement>("[data-urange]");
  if (r) { usageRange = +r.dataset.urange!; renderSettings(); return; }
  const o = (e.target as HTMLElement).closest<HTMLElement>("[data-set]");
  if (o) applySetting(o.dataset.set!, o.dataset.val!);
});
// Shared hover tooltip for the Usage panel's heatmap cells and cost bars. One
// element on <body> (not #setBody), so a renderSettings() rebuild never drops it.
const uTip = Object.assign(document.createElement("div"), { className: "u-tip", hidden: true });
document.body.appendChild(uTip);
$("setBody").addEventListener("mousemove", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
  if (!t) { uTip.hidden = true; return; }
  // dataset.tip is HTML-decoded on read; re-escape each line before re-inserting.
  uTip.innerHTML = t.dataset.tip!.split("||").map(esc).join("<br>");
  uTip.hidden = false;
  uTip.style.left = e.clientX + "px";
  uTip.style.top = (e.clientY - 14) + "px";
});
$("setBody").addEventListener("mouseleave", () => { uTip.hidden = true; });
$("railCollapse").addEventListener("click", toggleRail);
$("railSort").addEventListener("click", cycleSort);
$("inspBtn").addEventListener("click", toggleInsp);
// The active project context is either an Episko session or an external one.
function activeProjectCtx(): { project: string; path: string } | null {
  // For an external session use its repo root, not the worktree cwd, so launching a
  // session / opening a worktree from it operates on the repo (and groups under it).
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); if (e) { const root = e.repo_root || e.cwd; return { project: basename(root), path: root }; } }
  // A dormant session already stores colorKey (the repo key), so it needs no such resolution.
  if (pastMirrorId()) { const d = dormants.find((x) => x.id === pastMirrorId()); if (d) return { project: d.project, path: d.colorKey }; }
  const s = activeId ? sessions.get(activeId) : null;
  return s ? { project: s.project, path: s.colorKey } : null;
}
// The active session's *actual* cwd (the worktree dir for worktree sessions, not
// the color-grouping repo key) — used when opening a plain terminal there.
function activeCwd(): string | null {
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); return e ? e.cwd : null; }
  if (pastMirrorId()) { const d = dormants.find((x) => x.id === pastMirrorId()); return d ? d.workdir : null; }
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
  const e = extMirrorId() ? externals.find((x) => x.session_id === extMirrorId()) : undefined;
  // A dormant session can also own the stage; it already stores the repo key.
  const d = pastMirrorId() ? dormants.find((x) => x.id === pastMirrorId()) : undefined;
  const colorKey = s ? s.colorKey : e ? (e.repo_root || e.cwd) : d ? d.colorKey : wd;
  const worktree = s ? s.worktree : e ? (e.repo_root && e.cwd !== e.repo_root ? (e.branch || basename(e.cwd)) : null) : d ? d.worktree : null;
  const branch = s ? s.branch : (e?.branch || d?.branch || "");
  launchShell(s ? s.project : (d?.project ?? basename(colorKey)), wd, { colorKey, worktree, branch });
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
  const repaint = () => { if (activeId === s.id && !extMirrorId()) renderInspector(s); };
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
    // resumeId is inert for a shell — it has no transcript and saveRoster skips it.
    id, project, accent: accentFor(colorKey), workdir, colorKey, resumeId: id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "shell",
    phase: "idle", phaseSince: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
    lastEvent: "", activity: [],
    external: false, shell: true, term, fit, pane,
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
$("btnTerm").addEventListener("click", openPlainTerminal);
$("fRepo").addEventListener("click", (e) => { e.preventDefault(); openUrl("https://github.com/respeak-io/episko").catch(() => {}); });
$("fEngineSeg").addEventListener("click", (e) => { e.stopPropagation(); $("enginePop").classList.contains("show") ? closeEnginePop() : openEnginePopover(); });
$("fUsageSeg").addEventListener("click", (e) => { e.stopPropagation(); $("usagePop").classList.contains("show") ? closeUsagePop() : openUsagePop(); });
$("fShortSeg").addEventListener("click", (e) => { e.stopPropagation(); $("shortPop").classList.contains("show") ? closeShortPop() : openShortPop(); });
$("btnClose").addEventListener("click", () => { if (activeId) closeSession(activeId); });
// The dialog handles its own clicks and keys: rows are addressed by index into
// wtRows, so nothing leaks into the global [data-*] dispatcher.
$("wtRefresh").addEventListener("click", () => { void wtReadLocal(true).then(() => wtMaybeFetch(true)); });
// Coming back to the window is the moment the list is most likely to be wrong: you were
// just in a terminal, or someone else pushed. Re-read locally and fetch (throttled).
// Skipped while the branch chooser is open — re-rendering would swap the element its
// popover is anchored to out from under a choice in progress.
window.addEventListener("focus", () => {
  if (!$("wtDlg").classList.contains("show") || bPopOpen()) return;
  void wtReadLocal(true).then(() => wtMaybeFetch());
});
$("wtQ").addEventListener("input", () => { wtSel = 0; wtArmed = ""; wtRender(); });
$("wtQ").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); wtSel = Math.min(wtSel + 1, wtRows.length - 1); wtRender(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); wtSel = Math.max(wtSel - 1, 0); wtRender(); }
  else if (e.key === "Enter") { e.preventDefault(); wtRun(wtRows[wtSel]); }
  else if (e.key === "Escape") {
    e.preventDefault();
    // Esc peels one layer at a time: an armed removal, then the filter, then the dialog.
    if (wtArmed) { wtArmed = ""; wtRender(); }
    else if (($("wtQ") as HTMLInputElement).value) { ($("wtQ") as HTMLInputElement).value = ""; wtSel = 0; wtRender(); }
    else closeWt();
  }
});
$("wtDlg").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const pick = t.closest<HTMLElement>("[data-wtpick]");
  if (pick) {
    if (bPopOpen()) { closeBranchPop(); return; }
    const head = wtRepoBranch || "HEAD";
    if (pick.dataset.wtpick === "base") {
      openBranchPop(pick, wtBaseOptions(), wtBase || head, (n) => { wtBase = n === head ? "" : n; wtRender(); });
    } else {
      openBranchPop(pick, wtSwitchOptions(), wtSwitchTo || wtSwitchable()[0]?.name || "", (n) => { wtSwitchTo = n; wtRender(); });
    }
    return;
  }
  const jump = t.closest<HTMLElement>("[data-wtjump]");
  if (jump) { const id = jump.dataset.wtjump!; closeWt(); setActive(id); return; }
  const act = t.closest<HTMLElement>("[data-wtact]");
  if (act) {
    switch (act.dataset.wtact) {
      case "go": wtRun(wtRows[wtSel]); break;
      case "arm": wtArmed = wtRows[wtSel]?.dir || ""; wtRender(); break;
      case "cancel": wtArmed = ""; wtRender(); break;
      case "rm0": void wtDoRemove(false); break;
      case "rm1": void wtDoRemove(true); break;
      case "delbranch": void wtDeleteBranch(); break;
      case "doswitch": void wtDoSwitch(); break;
      case "openclash": {
        const c = wtRows[wtSel]?.clash;
        if (c && wtCtx) { const { project, repoDir } = wtCtx; closeWt(); launch(project, c.path, { colorKey: repoDir, worktree: wtLabelOf(c), branch: c.branch }); }
        break;
      }
    }
    ($("wtQ") as HTMLInputElement).focus();
    return;
  }
  const row = t.closest<HTMLElement>("[data-wti]");
  if (row) { wtSel = +row.dataset.wti!; wtArmed = ""; wtRender(); ($("wtQ") as HTMLInputElement).focus(); }
});
// Double-click a row to go, so the mouse path doesn't require crossing to the pane's
// button. The first click of the pair already selected it, so this just runs it.
$("wtList").addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-wti]");
  if (row) { e.preventDefault(); wtRun(wtRows[+row.dataset.wti!]); }
});
$("scrim").addEventListener("click", () => { closePalette(); closeWt(); closeDiff(); closeSettings(); });
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
  else if (meta && e.key.toLowerCase() === "t") { e.preventDefault(); openPlainTerminal(); }
  else if (meta && e.key >= "1" && e.key <= "9") { e.preventDefault(); const list = orderedSessions(); const s = list[+e.key - 1]; if (s) setActive(s.id); }
  else if (meta && (e.key === "=" || e.key === "+")) { e.preventDefault(); bumpFont(0.5); }
  else if (meta && e.key === "-") { e.preventDefault(); bumpFont(-0.5); }
  else if (meta && e.key === "0") { e.preventDefault(); termFontSize = 12.5; applyFontSize(); toast("Terminal font 12.5px"); }
  else if (meta && e.key === ",") { e.preventDefault(); settingsOpen() ? closeSettings() : openSettings(); }
  else if (e.key === "Escape" && ctxMenuOpen()) { e.preventDefault(); closeColorPop(); closeCtxMenu(); }
  else if (e.key === "Escape" && diffOpen) { e.preventDefault(); closeDiff(); }
  else if (e.key === "Escape" && settingsOpen()) { e.preventDefault(); closeSettings(); }
});
// Debounce container resizes. A window drag or a sidebar/inspector toggle fires this
// many times per second; without a settle delay each tick pushes a new width to the
// PTY, and Claude's Ink renderer — which erases its previous frame by line count at
// the *old* width — can't keep up, leaving orphaned cells. One resize at the settled
// size lets Ink do a single clean relayout. Direct refit() callers (font/panel
// toggles) stay immediate; this only tames the observer's storm.
let refitTimer: number | undefined;
new ResizeObserver(() => {
  clearTimeout(refitTimer);
  refitTimer = window.setTimeout(refit, 120);
}).observe($("terminals"));

// show the running app's version (from tauri.conf.json) in the footer, so it's
// clear which build is installed after an update.
getVersion().then((v) => { appVersion = v; $("fVer").textContent = "v" + v; }).catch(() => {});

// ---------- app self-update (Tauri updater plugin) ----------
// Checks the latest GitHub release (respeak-io/episko) for a newer Episko.
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
      if (manual) toast(`Episko v${upd.version} is available`);
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
    ? `Episko will download v${pendingUpdate.version}, close ${live} running session${live === 1 ? "" : "s"}, and restart.`
    : `Episko will download v${pendingUpdate.version} and restart.`;
  const ok = await ask(`${warn}\n\nContinue?`, {
    title: "Update Episko",
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
// Episko never learns about a release until it's restarted. Manual → it reports
// either way ("you're on the latest version"), so the menu item always answers.
listen("tray-check-updates", () => { void checkForUpdates(true); });

// Quit guard. On macOS, Cmd+Q is bound to our own menu item in the backend (macOS
// doesn't reliably surface the OS quit as a Tauri event — see tauri#9198); on
// Windows the backend intercepts CloseRequested (closing the window is the quit
// gesture there — it has no app menu). Both arrive here as `quit-requested`
// rather than tearing the app down. We only nag
// when something would actually be lost — an idle Episko quits immediately, keeping
// the Cmd+Q muscle memory intact.
listen("quit-requested", async () => {
  const live = [...sessions.values()].filter((s) => s.phase !== "ended");
  const agents = live.filter((s) => !s.shell).length;
  const terms = live.filter((s) => s.shell).length;
  if (agents + terms === 0) { await invoke("confirm_quit"); return; }
  const parts: string[] = [];
  if (agents) parts.push(`${agents} running ${agents === 1 ? "session" : "sessions"}`);
  if (terms) parts.push(`${terms} ${terms === 1 ? "terminal" : "terminals"}`);
  const ok = await ask(`${parts.join(" and ")} still running — quitting ends ${agents + terms === 1 ? "it" : "them"}.`, {
    title: "Quit Episko?",
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
  if (settingsOpen() && setTab === "usage") renderSettings(); // keep the forecast countdowns/colours current
  if (mirror) return; // a read-only mirror owns the stage — don't paint over it
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
  if (mirror) return;
  const s = activeId ? sessions.get(activeId) ?? null : null;
  if (!s || s.shell) return;
  const el = document.getElementById("iDwell");
  if (el) el.textContent = dwellText(s);
}, 1000);

// Refresh the active session's working-set diff + CPU/RAM on a slow cadence.
setInterval(() => {
  if (mirror) return;
  const s = activeId ? sessions.get(activeId) ?? null : null;
  if (s) void refreshSessionStats(s);
}, 4000);

// discover Claude Code sessions running outside Episko and keep them fresh.
refreshExternals();
setInterval(refreshExternals, 3000);

// surface the sessions that were open when Episko last closed, so they can be
// resumed instead of lost. Read-only until the user actually clicks Resume.
void loadDormants();
// Nothing else persists the roster on the way out: closeSession and the telemetry
// tick both save, but a quit with live, quiet sessions would otherwise write nothing.
window.addEventListener("beforeunload", flushRoster);

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
initFileDrop();
// caffeinate always starts off — the assertion is bound to the last run's process
// (`-w <pid>` on macOS, the parked thread on Windows) and died with it; renderAll's
// reconcileCaf() paints the button. Note this is the ONE place agent-mode could
// auto-assert on launch — but cafArmed is false at boot, so it stays dormant.
renderAll();

