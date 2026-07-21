# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Muster is a Tauri v2 desktop app (Rust backend + vanilla-TS frontend) that launches and manages many Claude Code sessions at once — each in its own PTY — and streams live status/cost/context telemetry back into the app. macOS-first; still an early spike.

## Commands

```sh
pnpm install            # first time
pnpm tauri dev      # run the app (Tauri + Vite dev server on fixed port 1420)
pnpm tauri build    # production bundle
pnpm build          # tsc typecheck + vite build (frontend only; the beforeBuildCommand)
pnpm exec tsc --noEmit       # typecheck only (tsconfig is noEmit)
pnpm test               # vitest — frontend unit tests (test/*.test.ts)
```

Rust backend (run from `src-tauri/`): `cargo check`, `cargo test`, `cargo build`. (`cargo clippy` is advisory-only — CI runs it with `|| true`, and it may not be installed locally; don't block on it.)

**Package manager: `pnpm`** for this repo (there's a `pnpm-lock.yaml`; both CI workflows use `pnpm install --frozen-lockfile`, and `packageManager` in `package.json` pins the version for corepack/CI). Use pnpm here, not npm. Windows code-signing / release-signing setup lives in `src-tauri/SIGNING.md`.

Test coverage is **thin and unit-only** — there is no end-to-end harness. What exists: `vitest` over pure frontend logic (currently the diff parser, `test/diff.test.ts`, importing from `src/diff.ts`) and `#[cfg(test)]` integration tests in `lib.rs` that drive real `git` against a temp repo. Anything touching the DOM, PTYs, or live telemetry is still verified by **running the app and exercising it** — the statusLine half of telemetry only fires in interactive mode, so it cannot be checked headlessly with `claude -p`. `tsc` (strict) is the real linter. Requires `claude` on PATH, Node 18+, and Rust stable + Tauri system deps.

CLI *mechanics*, though, often can be checked headlessly — drive `claude -p` against a **throwaway** session in a temp dir and inspect the resulting `.jsonl` (never a real session: resuming appends to it).

## The core mechanism: per-launch instrumentation

This is the one idea that makes the whole app work; everything else hangs off it.

On every launch, the Rust backend (`write_instrument_settings`) generates a throwaway `--settings` file at `$TMPDIR/cc-launcher/instrument-<uuid>.json` containing a `statusLine` command and `hooks` for the full session lifecycle. Each hook/statusLine is a shell command that POSTs its JSON payload to a **localhost `tiny_http` server the app bound to an ephemeral port at startup**. Claude is then spawned as `claude --session-id <uuid> --settings <file>`, so:

- Every event carries the `session_id` we chose, letting the frontend route it to the right pane **before any output appears**.
- No global `~/.claude` mutation and no transcript-file parsing — instrumentation is entirely per-launch and disappears with the temp file.

**Route by the stable launch id, never Claude's runtime `session_id`.** Claude mints a *new* `session_id` on `/clear`, `/compact` and `/resume`, so the payload's `session_id` drifts away from the uuid we launched with — after which telemetry would route to nothing (inspector freezes) and the `SessionEnd` fired at the rotation would leave the pane showing the "ended" `·` glyph while the process runs on. So every hook/statusLine POST is tagged with our stable uuid via an **`X-CC-Session` header** (and the blocking permission hook via **`?sid=`**, since it's `type:"http"` with no shell to add a header). `run_telemetry_server` reads that and *forces* it onto the payload's `session_id` before emitting. As a backstop, the frontend un-ends any session that keeps receiving statusLines (a statusLine only fires from a live REPL).

Two hard constraints shape this code:

- **Claude runs hooks/statusLine with a stripped PATH.** Generated commands use absolute `/usr/bin/curl` and `/bin/cat`, never bare `curl`. Likewise `resolve_claude()` probes known install locations (and falls back to the login shell) and `augmented_path()` rebuilds a usable PATH, because a GUI app launched from Finder also gets a stripped PATH.
- **`PermissionRequest` is a *blocking* `type:"http"` hook**, unlike the other events (`"async": true`, fire-and-forget). The telemetry server holds that request open in `AppState.pending`, emits a `permission` event to the UI, and only responds when `resolve_permission` is called with allow/deny/terminal. Do not make it async or respond early, or Claude will hang or lose the decision.

## Backend (`src-tauri/src/lib.rs`)

A single file. `main.rs` only calls `muster_lib::run()`. `AppState` holds the telemetry `port`, `sessions: HashMap<session_id, Session>` (each = PTY master + writer + child killer), `owned_pids` (see External sessions), the held-open `pending` permission requests, and `caffeinate`.

- **PTY** via `portable-pty`. `spawn_claude` opens a PTY, spawns claude, and (via the shared `stream_pty_session` helper) starts two threads: a reader that base64-encodes output into `pty-output` events, and a reaper that removes the session and emits `pty-exit`. `write_pty` / `resize_pty` / `kill_session` operate by session_id. `spawn_shell` reuses the same path to run a plain login shell (no Claude, no instrumentation) in an embedded pane — the `❯ Terminal` button opens one when the launch engine is embedded (else it opens an external terminal via `open_terminal_here`). Shell panes carry `shell:true` on the frontend `Sess` and skip telemetry/cost.
- **Telemetry server** (`run_telemetry_server`) forwards `/hook` and `/statusline` POSTs as one `telemetry` event each; `/permission` is the blocking path described above.
- Commands are registered in the `invoke_handler![...]` list at the bottom of `run()` — add new `#[tauri::command]` fns there.

## Frontend (`src/main.ts`, `index.html`, `src/styles.css`)

One ~2650-line `main.ts`, no framework. State lives in a `sessions: Map<session_id, Sess>` plus module-level variables; **every mutation ends by calling `renderAll()`**, which re-renders the sidebar, mini-rail, inspector, header, footer, attention badge, and tray from scratch. There is no diffing — follow this render-everything pattern rather than mutating DOM directly.

- **Event wiring**: `listen("pty-output" | "pty-exit" | "telemetry" | "permission" | "tray-select")` at the bottom of the file. Telemetry is routed by `data.session_id?.toLowerCase()` — session ids are matched case-insensitively, so keep them lowercase.
- `applyHook` maps lifecycle events → a `Phase` state machine (idle/thinking/working/done/error/ended) and attention flags; `applyStatusline` fills model/context%/cost/duration. **Rate limits are account-wide**, held in a single `rl` object and shown identically on every session, not per-session.
- **Persistence is all `localStorage`**, ~15 keys prefixed `cc-` (favorites, drag order, colours, icons, engine, font size, sort/grouping, frecency, caffeinate, the `cc-usage` daily cost rollup, the `cc-restore` roster). `grep '"cc-'` for the current set.
- **Debug console** (🐞 button, bottom-right): an in-app event log + live state via `dlog()`/`dbgSnapshot()`. It flags **unrouted telemetry** (the routing-drift class of bug above) and JS errors, and mirrors a snapshot to `$TMPDIR/cc-launcher/muster-debug.json` (written by the `write_debug_file` command) so an external tool or an LLM agent can read live app state while it runs.

## Four launch engines, one telemetry path

`termEngine` selects where the terminal lives; the instrumentation (and thus the cockpit's telemetry) is identical for all:

- **embedded** — xterm.js pane inside the app (the only one that renders in-app).
- **ghostty** — external tinted window (`spawn_ghostty`).
- **terminal / iterm** — `spawn_external_terminal` writes an executable `.command` wrapper and hands it to `open -a`.

`available_terminals` reports which are installed so the UI only offers working ones.

## External (non-Muster) sessions

Muster surfaces Claude sessions started *outside* it, discovered from `~/.claude/sessions/<pid>.json` (one per running interactive session — same path and format on Windows under `%USERPROFILE%`, VS Code-hosted sessions included, verified on CC 2.1.216; format details in the `claude-code-local-session-registry` memory). The **listing is OS-agnostic**: `list_external_sessions` liveness-checks survivors against `ProcTable`, one in-process `sysinfo` snapshot of the process table (no `ps`/`tasklist` spawns — the frontend polls every 3s), so discovery works on macOS, Windows and (untested) Linux alike.

- **Filter owned sessions by pid, never by session id.** Muster's own sessions register there too (confirmed CC 2.1.211), and `/resume`/`/clear` rewrite `<pid>.json` with a *new* id — so an id-based exclude lets a live, Muster-owned session reappear as "external" showing the resumed transcript. `AppState.owned_pids` holds every claude pid Muster spawned; the ancestry walk (`ProcTable::is_descendant_of`) also catches child-terminal launches.
- **That ancestry walk is deliberately broad, and it bites during development.** Anything started from a terminal *inside* Muster — notably `pnpm tauri dev` — becomes its descendant, so a second Muster instance's sessions are silently filtered out of the first's external list. **Run dev builds from a real terminal, not a Muster pane.** (Dev and installed also share one localStorage and one `muster-debug.json`, so prefer quitting the installed app entirely.)
- `read_transcript` mirrors a session read-only (decoding the cwd→`<enc>` path scheme). `focus_external_session` — still **macOS-only** — jumps to its terminal: exact tab focus by tty via AppleScript for Terminal.app/iTerm2, else `open` on the owning top-level `.app`. That `.app` fallback is **required** for Electron hosts like VS Code — their integrated terminal runs under a *helper* process System Events can't target by unix id (fails `-1719`); the tradeoff is we can only front VS Code, not the specific panel.
- **Known gap:** sessions launched into an external Terminal.app/iTerm (via `open -a`) aren't in Muster's process tree, so they still rely on the session-id `exclude` and can leak after a `/resume`.

## Restorable sessions (surviving a restart)

Muster's launch uuid **is** Claude's `--session-id`, so every session it launches already has a transcript at `~/.claude/projects/<enc(workdir)>/<id>.jsonl`. Restore is therefore about remembering what was on screen and under what identity — not capturing conversation state.

- **The roster** (`cc-restore`) holds what was open at quit; `closeSession` removes an entry (an explicit close means done). Shells never join. Saves are debounced *with a ceiling* (`ROSTER_MAX_STALE`) — a busy session's continuous telemetry would reset a pure trailing debounce forever and never write.
- **Resume `resumeId`, not `id`.** Each runtime-id rotation (see the core-mechanism section) starts a **new transcript file**, so the launch uuid goes stale as a resume target. `run_telemetry_server` preserves Claude's incoming id as `claude_session_id` *before* forcing ours on; the frontend tracks it into `Sess.resumeId` and saves immediately on rotation. Routing is unchanged.
- **`--resume` and `--session-id` are mutually exclusive** (resume wins), so all three spawners branch either/or on `resume: Option<String>`. `--settings` stays keyed to our launch uuid, so `X-CC-Session` routes telemetry whatever id Claude runs under.
- **Verified against the real CLI:** resume preserves the id and appends to the *same* transcript; it must run in the **original cwd** (else `No conversation found with session ID: …`); and resuming an **already-live** session silently interleaves both transcripts (Claude takes no lock). Hence `dormantBusy()` gates Resume, and spawners refuse a vanished workdir (deleted worktrees are real).
- `list_past_sessions(workdir)` supplies labels from Claude's `ai-title` record — **last occurrence wins** — falling back `ai-title` → `last-prompt` → first user message. That layout is internal to Claude Code and documented as unstable across releases, so the chain is load-bearing, not padding. Only the 512KB tail is scanned. Entries with **no transcript are dropped** (a session launched but never prompted writes none).
- **The roster is a convenience layer, not a system of record** — `/resume` inside Claude always lists every session for a folder, so nothing dropped or removed is ever lost. Keep UI copy honest about that, and don't build recovery machinery for a problem `/resume` already solves.
- **The stage has one owner:** `activeId` and the `mirror` pointer (`{kind:"ext"|"past"}`) are mutually exclusive — the read-only kinds share one discriminated pointer rather than a flag each. Timer-driven inspector repaints must bail on `mirror`, not just the external case.

## Notes on scope & doc drift

macOS-first assumptions remain in the window/terminal layer: `osascript`, `open -a`, external-terminal engines, per-session CPU/RAM via `ps`, terminal-window focus. Windows has a working embedded-only port (PowerShell/`curl.exe` hook variants behind `#[cfg(windows)]`, cross-platform external-session listing); Linux is unported but the non-`ps` paths are written to be OS-agnostic.

`SPIKE.md` and `README.md` describe an earlier state (single-session, "observe-only" permissions). The code has moved past both — it is multi-session and the permission hook is answerable. **Trust the code over the docs** when they disagree.
