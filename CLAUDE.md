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

## Runnables — tasks & scripts (`src-tauri/src/tasks.rs`, `▶ Run`)

Muster runs the task definitions a project already ships. A **`Runnable`** is one
such definition. Providers: `.muster/tasks.toml` (Muster's own committable
format), `.vscode/tasks.json`, `.vscode/launch.json`, `package.json` scripts,
`justfile`, `Taskfile.yml`, `mise.toml`, `Makefile`, `Cargo.toml`.
Discovery is in `tasks.rs`; execution reuses the existing PTY path, because **a
task run is just another `Sess`** — see the `kind` discriminant below. That's what
buys tasks the phase state machine, sidebar glyphs, attention badge, tray and
⌘1–9 for free: a run's **exit code is its phase** (0 → `done`, non-zero →
`error`), delivered over the same `pty-exit` event as everything else.

Three rules constrain `tasks.rs`:

- **Discovery never executes the project.** Most providers only parse. The
  introspecting ones *evaluate* what they read — `just --dump` runs backtick
  variables and imports at parse time — so they sit behind a **trust gate**:
  `discover(root, trusted)`, where the frontend grants `trusted` only if the
  global introspect toggle is on, the `just` provider is enabled, *and* the
  folder is one the user chose (a `cc-favorites` project, or a one-time confirm
  stored in `cc-trusted`). `just`, `task` and `mise` all go through the shared
  `Introspector` shape; untrusted, each yields a single blocked row, so its tasks
  read as withheld rather than missing. Makefiles and Cargo are parsed/inferred
  statically for exactly this reason — `make -qp` would expand `$(shell …)`.
- **Ids are stable and namespaced** (`npm:test`, `vscode:build`, `just:deploy`).
  Pins (`cc-task-pins`) and palette frecency key off them, so they must survive a
  rescan; `dedupe_ids` guarantees uniqueness.
- **What can't run says so.** `blocked: Some(reason)` renders greyed in the
  picker instead of being dropped — a missing row reads as "Muster didn't find my
  task". VS Code tasks are blocked when they need an editor (`${file}`,
  `${lineNumber}`) or have an unsupported `type`. Supported variables:
  `workspaceFolder`, `workspaceFolderBasename`, `cwd`, `userHome`,
  `pathSeparator`, `env:X`. `${input:X}` is deliberately **left intact** by
  discovery — only the frontend knows the answer, so it prompts (`openInputPrompt`)
  and substitutes via `applyInputs` just before launch. just recipe parameters
  without defaults become the same kind of prompt.

`dependsOn` is resolved **in the frontend** (`launchWithDeps`), because only the
side that owns the panes can wait on an exit code. Dependencies are named by
*label*, run in parallel unless `dependsOrder: "sequence"` (VS Code's default,
surprising as it is), and a failed dependency stops the chain. `waitForExit`
resolves from the `pty-exit` listener *before* its early return, and
`closeSession` resolves it with `-1`, so a chain can never deadlock on a pane
that went away.

`launch.json` configs are offered as **run without debugging** (VS Code's ⌃F5).
Muster has no debug adapter, so `request: "attach"` and compound configs are
blocked rather than silently started as plain processes.

`spawn_task` is the third PTY entry point after `spawn_claude` / `spawn_shell`.
It takes a `TaskSpec { exec, cwd, env }` — a resolved subset of a `Runnable` — and
is deliberately **un-instrumented**: no `--settings` file, no telemetry, no cost,
and its pid never enters `owned_pids`. `Exec::Shell` runs through a *login* shell
so tasks inherit the same PATH and version-manager shims the user's own terminal
has (a task that works in iTerm and fails in Muster is the bug class this avoids).
The `Exec` wire format is pinned by a round-trip test — the frontend hands a
discovered `exec` straight back to `spawn_task`, so a rename there breaks every
launch silently.

Surfaces: the `▶ Run` header button (picker: pinned, then a frecency-ranked
**recent** group in the unfiltered view, then grouped by source), a **Tasks** group
in ⌘K, and a task inspector offering re-run / pin / stop / *send output to a
session*. Successful non-background runs auto-dismiss after 20s unless focused;
failures persist and raise attention.

Discovery is **memoised in Rust** (`discover_cached`), keyed by `(root, trusted)`
and invalidated by a *stamp* — the `(mtime, len)` of every file a provider reads,
where a missing file is itself part of the stamp so creating or deleting one
invalidates too. Not a file watcher: no thread, no crate and no per-project
lifecycle to answer what ~20 `metadata()` calls answer instantly. **A new provider
file must be added to `source_files()`**, or its tasks go stale behind the cache.
Known gap: files an introspector pulls in itself (`just` `import`, Taskfile
`includes:`) aren't stamped.

## Run on stop — the agent/task loop

The part a plain terminal can't do, and the reason tasks live inside Muster: the
`Stop` hook already arrives here, so a project can say *"when an agent finishes a
turn in this folder, run this"* and every turn becomes a verified turn. One rule
per project (`cc-task-onstop`, keyed by project root like pins), set with `⟲` in
the project tasks panel, reviewed and revoked in Settings › Tasks.

- **Unattended means unattended.** `stopRuleBlocked` refuses a background task (it
  never finishes a turn, so it could only pile up one dev server per turn), one
  with `${input:…}` (it would block on a dialog nobody opened), and a blocked one.
- **The run must not take the stage.** `launchTask` takes `focus: false` for this
  path only — the pane appears in the sidebar but the session you were reading
  stays on screen. Consequence: an unfocused pane can't be measured, so it starts
  at xterm's default 24×80 and gets a real size when you first activate it.
- **Never two at once, never twice per turn.** A run of the rule still in flight
  wins, and `STOP_RUN_FLOOR` swallows a double-fired `Stop`. The floor timestamp
  *and* a per-project in-flight marker are both claimed *before* the first `await`
  (discovery is async); the marker is what covers a rule with `dependsOn`, whose
  pane doesn't exist until its whole dependency chain has run — so the pane scan
  alone can't see the chain starting.
- **Discovery runs in the session's `workdir`**, so with several worktrees of one
  repo open the run verifies the checkout that agent just edited.
- **A failure goes back to the session that caused it.** `run.forSession` records
  which session's turn was being checked, and the inspector's *↩ Send output to…*
  offers it back to that session alone — if it has ended or lives in an external
  terminal (no PTY to type into), the handoff is withheld rather than misdirected to
  whichever agent in this project sorts first. A hand-run task (no `forSession`)
  still offers the first live agent. The handoff types without a trailing newline —
  Muster prefills, the human presses Enter.

## Task settings (Settings ⌘, → **Tasks** tab)

The settings window is `SET_TABS` + `renderSetControl` — declarative controls, not
hand-written markup per page. Tasks added two control kinds the existing `seg`
couldn't express: **`toggle`** (a single switch) and **`multi`** (independently
toggled values, for "which providers to scan" and the revocable trust list). New
task settings belong in that tab as control descriptors; `applySetting` dispatches
them.

Task preferences live in `cc-task-prefs`, pins in `cc-task-pins`, hidden tasks in
`cc-task-hidden`, run-on-stop rules in `cc-task-onstop`, trust in `cc-trusted`. The split is deliberate and worth
preserving: **personal preference → `localStorage`; project fact →
`.muster/tasks.toml`**, which is committable and works for a colleague who never
opens Muster.

## Project tasks panel (`openTaskManager`)

Pin / hide / create / edit / delete / **override**, reached from ⌘K.
**`.muster/tasks.toml` is the only file Muster writes** — a discovered VS Code task
or justfile belongs to another tool, so editing one writes an `[override."<id>"]`
into `tasks.toml` keyed by its discovered id, **never** a mutation of
`.vscode/tasks.json`. Writes go through `toml_edit`, not a serialize-the-whole-struct
round trip, so a hand-written file keeps its comments, ordering and spacing — there's
a test for exactly that. Creating the file for the first time asks, because a new
committable file in someone's repo is a real side effect.

## Overrides, and the rest of P4

Overrides (`[override.*]`) close the "Muster never rewrites a file it didn't create"
loop: `apply_overrides` patches discovered rows *after* dedupe (so it keys off final
ids), and an override whose target vanished becomes a **blocked row** (`override:<id>`)
rather than a silent no-op — a typo'd id reads as broken, not missing, exactly like
the rest of the module. `save_task_override` writes `background` unconditionally
(unlike a `[[task]]`, whose absent key means `false`) because an override's job
includes turning a discovered background flag *off*. Overriding `run` re-derives its
`${input:…}` prompts (`redetect_inputs`). Reverting removes the key and, if it was the
last, the whole `[override]` table. The panel learns which ids are overridden from
`list_task_overrides` (reads the file, not the cache, so a just-saved override shows).

Four smaller P4 affordances, all in the frontend:

- **Package-runner override** (`cc-task-runner`, per project). Detection stays in
  Rust; the override is applied *after* discovery by swapping an npm task's
  `exec.program` (`applyRunner`), so the discovery cache never has to know about it.
  Surfaced as a strip atop the panel, shown only when the project has npm scripts.
- **Remembered `${input:…}` values** (`cc-task-inputs`, keyed project + task + input).
  Pre-fills the prompt with what you typed last; **never a password** (`i.password`).
- **↗ Reveal source** — `reveal_path` selects the source file in the OS file manager,
  guarding against a `..` escape and falling back to the folder if the file is gone.
  `run.root` (the discovery dir) is stored on the pane so it resolves the relative
  `sourceFile` even for a task whose run cwd is a subfolder.
- **⟳ Rescan** — `rescan_runnables` drops the project's cache entries; the panel
  button and the picker's ⌘⇧R both route through it. The escape hatch for the one
  thing the stamp can't see: a file an introspector imports itself.

## Backend (`src-tauri/src/lib.rs`)

`main.rs` only calls `muster_lib::run()`; `tasks.rs` holds runnable discovery. `AppState` holds the telemetry `port`, `sessions: HashMap<session_id, Session>` (each = PTY master + writer + child killer), `owned_pids` (see External sessions), the held-open `pending` permission requests, and `caffeinate`.

- **PTY** via `portable-pty`. `spawn_claude` opens a PTY, spawns claude, and (via the shared `stream_pty_session` helper) starts two threads: a reader that base64-encodes output into `pty-output` events, and a reaper that removes the session and emits `pty-exit`. `write_pty` / `resize_pty` / `kill_session` operate by session_id. `spawn_shell` reuses the same path to run a plain login shell (no Claude, no instrumentation) in an embedded pane — the `❯ Terminal` button opens one when the launch engine is embedded (else it opens an external terminal via `open_terminal_here`). Shell panes carry `kind:"shell"` on the frontend `Sess` and skip telemetry/cost; `spawn_task` is the third entry point (see Runnables above).
- **Telemetry server** (`run_telemetry_server`) forwards `/hook` and `/statusline` POSTs as one `telemetry` event each; `/permission` is the blocking path described above.
- Commands are registered in the `invoke_handler![...]` list at the bottom of `run()` — add new `#[tauri::command]` fns there.

## Frontend (`src/main.ts`, `index.html`, `src/styles.css`)

One large `main.ts`, no framework. State lives in a `sessions: Map<session_id, Sess>` plus module-level variables; **every mutation ends by calling `renderAll()`**, which re-renders the sidebar, mini-rail, inspector, header, footer, attention badge, and tray from scratch. There is no diffing — follow this render-everything pattern rather than mutating DOM directly.


- **`Sess.kind`** (`"claude" | "shell" | "task"`) decides whether telemetry, cost
  and git actions apply to a pane — use the `isAgent(s)` helper rather than
  re-testing the string. It is orthogonal to `Sess.external`, which means "the
  terminal lives in Ghostty/iTerm rather than an embedded pane" and only ever
  applies to a claude session.
- **Event wiring**: `listen("pty-output" | "pty-exit" | "telemetry" | "permission" | "tray-select")` at the bottom of the file. Telemetry is routed by `data.session_id?.toLowerCase()` — session ids are matched case-insensitively, so keep them lowercase.
- `applyHook` maps lifecycle events → a `Phase` state machine (idle/thinking/working/done/error/ended) and attention flags; `applyStatusline` fills model/context%/cost/duration. **Rate limits are account-wide**, held in a single `rl` object and shown identically on every session, not per-session.
- **Persistence is all `localStorage`**, ~20 keys prefixed `cc-` (favorites, drag order, colours, icons, engine, font size, sort/grouping, frecency, caffeinate, the `cc-usage` daily cost rollup, the `cc-restore` roster, and the task keys `cc-task-{prefs,pins,hidden,onstop,runner,inputs}` + `cc-trusted`). `grep '"cc-'` for the current set.
- **Debug console** (🐞 button, bottom-right): an in-app event log + live state via `dlog()`/`dbgSnapshot()`. It flags **unrouted telemetry** (the routing-drift class of bug above) and JS errors, and mirrors a snapshot to `$TMPDIR/cc-launcher/muster-debug.json` (written by the `write_debug_file` command) so an external tool or an LLM agent can read live app state while it runs.
- **Two-tier logging — live snapshot vs. durable timeline.** The `muster-debug.json` snapshot is a *state-of-now* blob that is overwritten each flush and does **not** survive a crash (the frontend never flushes if the process dies). The durable tier is the backend rolling `muster.log` (+ `panic.log`) in the OS app-log dir (macOS `~/Library/Logs/io.respeak.cclauncher/`), via `tauri-plugin-log` and a panic hook — the only on-disk trace of a panic that unwinds cleanly out of `main` (no crash dump / WER otherwise). Every `dlog()` line tees into it through the `log_frontend` command (tagged `[ui]`), so the UI and backend event streams land in **one time-ordered file**. A `muster.log` that stops without an `exit · clean shutdown` line is itself evidence of an abnormal termination. Use the snapshot for "what is it doing *now*", the rolling log for "why did it *die*".

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
