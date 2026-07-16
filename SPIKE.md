# cc-launcher — Phase-0 spike

A throwaway spike proving the two risky pieces of a cross-platform desktop
launcher/manager for multiple Claude Code sessions:

1. **Embedded real terminal** — spawn `claude --session-id <uuid>` in a PTY
   (`portable-pty`) and stream it to `xterm.js` inside a Tauri window.
2. **Live telemetry** — instrument that session *per-launch* (via
   `claude --settings <file>`) so Claude Code's **hooks + statusLine** POST
   status / cost / context back to a tiny localhost HTTP server the app runs.
   No global `~/.claude` mutation, no transcript-file parsing.

## Stack

- **Tauri v2** (Rust backend, WKWebView frontend) — light footprint
- **portable-pty 0.9** — the PTY (ConPTY on Windows, forkpty on macOS)
- **tiny_http 0.12** — the localhost telemetry receiver
- **xterm.js** (`@xterm/xterm` + `@xterm/addon-fit`) — terminal rendering
- vanilla TS frontend (Vite)

## How it works

```
Tauri window
├─ xterm.js  ──keystrokes──▶  write_pty (Rust)  ──▶  PTY  ──▶  claude
│     ▲                                                          │
│     └───────  pty-output (base64)  ◀── reader thread ◀─────────┘
│
└─ status panel  ◀── "telemetry" event ◀── tiny_http :EPHEMERAL
                                              ▲   ▲
                    hooks (POST /hook) ───────┘   └─ statusLine (POST /statusline)
                    from `claude --settings <generated instrument.json>`
```

- On launch, Rust generates `${TMPDIR}/cc-launcher/instrument-<uuid>.json`
  containing a `statusLine` command + `hooks` for SessionStart, UserPromptSubmit,
  Pre/PostToolUse, PostToolUseFailure, Notification, Stop, StopFailure,
  SubagentStop, PermissionRequest — each an absolute-path `/usr/bin/curl` POST to
  the app's port (Claude runs hooks with a **stripped PATH**, so bare `curl`
  would fail).
- `claude --session-id <uuid> --settings <file>` → the app knows the session id
  before any output, so every hook/statusline event maps to the right pane by
  `session_id`.
- Hooks are `"async": true` so telemetry never adds latency to Claude.

## What's proven (verified headlessly, Claude Code 2.1.210)

Running `claude -p ... --settings instrument.json` fired the full lifecycle to
the listener:

```
SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop → SessionEnd
```

Every payload includes `session_id` (== the `--session-id` we passed), `cwd`,
`transcript_path`; tool events include `tool_name`; `Stop` includes
`last_assistant_message`. → correlation + status model confirmed.

`/statusline` (cost/context/model/rate-limits) only runs in **interactive** mode,
so it's validated in the running app, not in `-p`.

## Run it

```sh
cd cc-launcher-spike
npm install          # first time
npm run tauri dev
```

Then in the window: click **Launch Claude ▸**, accept Claude's workspace-trust
prompt in the terminal (first time in the sandbox dir), and ask it something.
Watch the status pill + chips (model / context% / cost / 5h-limit / last event).

## Files

- `src-tauri/src/lib.rs` — PTY spawn + reader thread, telemetry HTTP server,
  instrument-settings generation, `spawn_claude` / `write_pty` / `resize_pty`.
- `src/main.ts` — xterm wiring, event→status map, statusLine→chips, per-project
  accent colour (hash of the path).
- `sandbox/` — throwaway folder to launch Claude in.

## Known spike limitations (intentional)

- **Single session** (one PTY). Multi-session sidebar is the next step — the
  correlation is already keyed on `session_id`, so it generalises directly.
- Observe-only: `PermissionRequest` is reported, not answered. A blocking
  `type:"http"` permission hook that returns a decision to Claude is Phase-2.
- macOS-only shell in the generated hooks (`/usr/bin/curl`, `/bin/cat`). Windows
  needs a PowerShell/curl.exe variant.
- Sandbox path is hard-coded in `src/main.ts` (`DEFAULT_WORKDIR`).
