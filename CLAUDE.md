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

Rust backend (run from `src-tauri/`): `cargo check`, `cargo clippy`, `cargo test`, `cargo build`.

**Package manager: `pnpm`** for this repo (there's a `pnpm-lock.yaml`; both CI workflows use `pnpm install --frozen-lockfile`, and `packageManager` in `package.json` pins the version for corepack/CI). Use pnpm here, not npm. Windows code-signing / release-signing setup lives in `src-tauri/SIGNING.md`.

Test coverage is **thin and unit-only** — there is no end-to-end harness. What exists: `vitest` over pure frontend logic (currently the diff parser, `test/diff.test.ts`, importing from `src/diff.ts`) and `#[cfg(test)]` integration tests in `lib.rs` that drive real `git` against a temp repo. Anything touching the DOM, PTYs, or live telemetry is still verified by **running the app and exercising it** — the statusLine half of telemetry only fires in interactive mode, so it cannot be checked headlessly with `claude -p`. Beyond tests, the linters are `tsc` (strict) and `clippy`. Requires `claude` on PATH, Node 18+, and Rust stable + Tauri system deps.

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
format), `.vscode/tasks.json`, `package.json` scripts, `justfile`, `Makefile`.
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
  stored in `cc-trusted`). An untrusted justfile yields a single blocked row, so
  the recipes read as withheld rather than missing. Makefiles are parsed
  statically for exactly this reason — `make -qp` would expand `$(shell …)`.
- **Ids are stable and namespaced** (`npm:test`, `vscode:build`, `just:deploy`).
  Pins (`cc-task-pins`) and palette frecency key off them, so they must survive a
  rescan; `dedupe_ids` guarantees uniqueness.
- **What can't run says so.** `blocked: Some(reason)` renders greyed in the
  picker instead of being dropped — a missing row reads as "Muster didn't find my
  task". VS Code tasks are blocked when they need an editor (`${file}`,
  `${lineNumber}`), use `dependsOn` (running half of it silently is worse than
  declining), or have an unsupported `type`. Supported variables:
  `workspaceFolder`, `workspaceFolderBasename`, `cwd`, `userHome`,
  `pathSeparator`, `env:X`. `${input:X}` is deliberately **left intact** by
  discovery — only the frontend knows the answer, so it prompts (`openInputPrompt`)
  and substitutes via `applyInputs` just before launch. just recipe parameters
  without defaults become the same kind of prompt.

`spawn_task` is the third PTY entry point after `spawn_claude` / `spawn_shell`.
It takes a `TaskSpec { exec, cwd, env }` — a resolved subset of a `Runnable` — and
is deliberately **un-instrumented**: no `--settings` file, no telemetry, no cost,
and its pid never enters `owned_pids`. `Exec::Shell` runs through a *login* shell
so tasks inherit the same PATH and version-manager shims the user's own terminal
has (a task that works in iTerm and fails in Muster is the bug class this avoids).
The `Exec` wire format is pinned by a round-trip test — the frontend hands a
discovered `exec` straight back to `spawn_task`, so a rename there breaks every
launch silently.

Surfaces: the `▶ Run` header button (picker grouped by source), a **Tasks** group
in ⌘K, and a task inspector offering re-run / pin / stop / *send output to a
session*. Successful non-background runs auto-dismiss after 20s unless focused;
failures persist and raise attention.

## Settings window (⌘, · `renderSettings`)

A modal with a **General** and a **Tasks** page. It exists partly because tasks
needed somewhere to put the judgement calls (working directory when several
worktrees are open, dismiss timing, whether a failed run raises attention,
which providers to scan, trust) rather than hardcoding them — and it finally
gives `wtGroup` a control, which until now was reachable only as
`musterWtGroup()` in the console.

Task preferences live in `cc-task-prefs`; trust in `cc-trusted`. The split is
deliberate and worth preserving: **personal preference → `localStorage`;
project fact → `.muster/tasks.toml`**, which is committable and works for a
colleague who never opens Muster. Muster never rewrites a file it didn't create,
so editing a discovered VS Code task should become an *override* in
`tasks.toml`, not a mutation of `.vscode/tasks.json`.

## Backend (`src-tauri/src/lib.rs`)

`main.rs` only calls `muster_lib::run()`; `tasks.rs` holds runnable discovery. `AppState` holds the telemetry `port`, a `sessions: HashMap<session_id, Session>` (each = PTY master + writer + child killer), and the held-open `pending` permission requests.

- **PTY** via `portable-pty`. `spawn_claude` opens a PTY, spawns claude, and (via the shared `stream_pty_session` helper) starts two threads: a reader that base64-encodes output into `pty-output` events, and a reaper that removes the session and emits `pty-exit`. `write_pty` / `resize_pty` / `kill_session` operate by session_id. `spawn_shell` reuses the same path to run a plain login shell (no Claude, no instrumentation) in an embedded pane — the `❯ Terminal` button opens one when the launch engine is embedded (else it opens an external terminal via `open_terminal_here`). Shell panes carry `shell:true` on the frontend `Sess` and skip telemetry/cost.
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
- **Persistence is all `localStorage`** (keys prefixed `cc-`): favorites, project drag order, color overrides, per-project icons, terminal engine, font size, and a daily cost rollup (`cc-usage`).
- **Debug console** (🐞 button, bottom-right): an in-app event log + live state via `dlog()`/`dbgSnapshot()`. It flags **unrouted telemetry** (the routing-drift class of bug above) and JS errors, and mirrors a snapshot to `$TMPDIR/cc-launcher/muster-debug.json` (written by the `write_debug_file` command) so an external tool or an LLM agent can read live app state while it runs.

## Four launch engines, one telemetry path

`termEngine` selects where the terminal lives; the instrumentation (and thus the cockpit's telemetry) is identical for all:

- **embedded** — xterm.js pane inside the app (the only one that renders in-app).
- **ghostty** — external tinted window (`spawn_ghostty`).
- **terminal / iterm** — `spawn_external_terminal` writes an executable `.command` wrapper and hands it to `open -a`.

`available_terminals` reports which are installed so the UI only offers working ones.

## External (non-Muster) sessions

Muster also surfaces Claude sessions started *outside* it. Claude writes `~/.claude/sessions/<pid>.json` for each running interactive session. Muster's own sessions **also register there** (confirmed on CC 2.1.211), so `list_external_sessions` filters them out **by pid, not session id**: `AppState.owned_pids` holds every embedded-PTY claude pid Muster spawned, and an ancestry walk (`is_descendant_of`) catches child-terminal launches. Filtering by session id alone is a bug — `/resume` and `/clear` rewrite `<pid>.json` with a new id, which would make a live, Muster-owned session reappear as "external" showing the resumed transcript. `list_external_sessions` reads + liveness-checks the survivors (via `ps`), `read_transcript` shows a read-only transcript mirror (decoding the cwd→`<enc>` path scheme), and `focus_external_session` jumps to their terminal window: exact tab focus (by tty via AppleScript) for Terminal.app/iTerm2, else it activates the owning app's top-level `.app` bundle with `open`. That `.app`-bundle activation is required for Electron hosts like VS Code — their integrated terminal runs under a *helper* process that System Events can't target by unix id (the old code failed there with `-1719`); the tradeoff is we can only bring VS Code to the front, not focus the specific terminal panel. Known gap: sessions launched into an external Terminal.app/iTerm (via `open -a`) aren't under Muster's process tree, so they still rely on the session-id `exclude` and can leak after a `/resume`. See the `claude-code-local-session-registry` memory for the on-disk format details.

## Notes on scope & doc drift

macOS-only assumptions are pervasive and intentional for now: `osascript`, `open -a`, `/bin/zsh` wrappers, hard-coded app paths, `/usr/bin/curl`. Windows would need a PowerShell/`curl.exe` variant of the generated hooks.

`SPIKE.md` and `README.md` describe an earlier state (single-session, "observe-only" permissions). The code has moved past both — it is multi-session and the permission hook is answerable. **Trust the code over the docs** when they disagree.
