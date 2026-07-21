// cc-launcher — Tauri backend (multi-session)
//
// - Manages N concurrent `claude` sessions, each in its own PTY (portable-pty),
//   keyed by a caller-supplied session UUID (also passed to `claude --session-id`
//   so every hook/statusline event correlates back to its pane).
// - Instruments each session per-launch via `claude --settings <file>` so Claude
//   Code's hooks + statusLine POST live status/cost/context to a local HTTP
//   server — no global config mutation, no transcript parsing.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::menu::MenuBuilder;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// OS pid of the spawned `claude` (embedded PTY only). Used to exclude our
    /// own sessions from `list_external_sessions` by pid rather than session id.
    pid: Option<u32>,
    /// Working directory this session runs in. Lets `remove_worktree` refuse to
    /// delete a worktree that still has a live embedded session inside it.
    workdir: String,
}

struct AppState {
    port: u16,
    sessions: Mutex<HashMap<String, Session>>,
    /// PIDs of the `claude` processes Muster spawned in an embedded PTY. Matched
    /// against the on-disk session registry so our own sessions never masquerade
    /// as "external" — robust to the session id changing under /resume or /clear
    /// (which rewrites `~/.claude/sessions/<pid>.json` with the new id).
    owned_pids: Mutex<HashSet<u32>>,
    /// Held-open PermissionRequest HTTP requests, keyed by an id we assign.
    /// Answered later by the `resolve_permission` command.
    pending: Mutex<HashMap<String, tiny_http::Request>>,
    next_perm: std::sync::atomic::AtomicU64,
    /// The single running `caffeinate` child, if the user has toggled it on.
    /// Started with `-w <our pid>` so it self-terminates if Muster ever dies
    /// without a clean stop — no orphaned process keeps the Mac awake forever.
    #[cfg(not(windows))]
    caffeinate: Mutex<Option<std::process::Child>>,
    /// The single live `SetThreadExecutionState` assertion, if the user has
    /// toggled keep-awake on. Windows' equivalent of the `caffeinate` child.
    #[cfg(windows)]
    caffeinate: Mutex<Option<KeepAwake>>,
}

/// Find a request header by (case-insensitive) name.
fn header_value(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

/// Read a query-string param from a URL like `/permission?sid=abc` (no decoding —
/// our values are uuids).
fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split('?').nth(1)?;
    q.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        (it.next() == Some(key)).then(|| it.next().unwrap_or("").to_string())
    })
}

/// Receive hook + statusLine POSTs from Claude Code and forward each to the
/// frontend as a `telemetry` event. Every request carries Muster's stable launch
/// id (`X-CC-Session` header, or `?sid=` for the permission hook); we force it onto
/// the payload as `session_id` so the frontend routes by it — immune to Claude
/// rotating its own runtime session_id on /clear, /compact or /resume.
fn run_telemetry_server(server: tiny_http::Server, app: AppHandle) {
    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        let stable_sid = header_value(&request, "X-CC-Session").or_else(|| query_param(&url, "sid"));
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);
        // A parse failure here silently degrades the whole pane (session shows but
        // no model/cost/phase) — e.g. the PowerShell-BOM class of bug — so it must
        // be loud. Log length + error only, never the body (it can carry prompts).
        let mut data: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => {
                if !body.is_empty() {
                    log::warn!(
                        "telemetry: dropping unparseable {} payload ({} bytes, sid {}): {e}",
                        url,
                        body.len(),
                        stable_sid.as_deref().unwrap_or("?")
                    );
                }
                serde_json::Value::Null
            }
        };
        if let Some(sid) = &stable_sid {
            if !data.is_object() {
                data = serde_json::json!({});
            }
            // Keep Claude's *runtime* id before forcing ours onto the payload. It
            // rotates on /clear, /compact and /resume — and each rotation starts a
            // NEW transcript file. So the runtime id, not our stable launch id, is
            // what `--resume` must target; the frontend records it for restore.
            // Routing still uses `session_id` (ours) and is unaffected.
            if let Some(rt) = data.get("session_id").and_then(|v| v.as_str()) {
                if rt != sid {
                    let rt = rt.to_string();
                    data["claude_session_id"] = serde_json::Value::String(rt);
                }
            }
            data["session_id"] = serde_json::Value::String(sid.clone());
        }

        // Blocking permission hook: hold the request open, ask the UI, answer later.
        if url.contains("permission") {
            let st = app.state::<AppState>();
            let id = format!("p{}", st.next_perm.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
            let _ = app.emit("permission", serde_json::json!({ "id": id, "data": data }));
            st.pending.lock().unwrap().insert(id, request);
            continue; // do NOT respond — resolve_permission will
        }

        let kind = if url.contains("statusline") { "statusline" } else { "hook" };
        let _ = app.emit("telemetry", serde_json::json!({ "kind": kind, "data": data }));
        let _ = request.respond(tiny_http::Response::from_string(""));
    }
}

/// User's home directory — `USERPROFILE` on Windows, `HOME` elsewhere.
fn home_dir() -> String {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").unwrap_or_default()
    }
}

/// A `std::process::Command` that never flashes a console window on Windows. A GUI
/// app spawning a console subprocess (git, where, curl, taskkill) pops a black
/// window for each call without `CREATE_NO_WINDOW`; on other platforms this is a
/// plain `Command::new`.
fn sys_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let c = std::process::Command::new(program);
    #[cfg(windows)]
    let mut c = c;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Per-session settings file layered on top of the user's ~/.claude via
/// `claude --settings`. The generated hook/statusLine commands POST their stdin
/// payload to our telemetry server. Both platforms use absolute paths to a
/// guaranteed `curl` because Claude runs hooks/statusLine with a stripped PATH:
/// `/usr/bin/curl` (macOS/Linux) or `C:\Windows\System32\curl.exe` (Windows,
/// present since Win10 1803). On Windows the command is PowerShell — forced via
/// the hook's `shell` field, since Claude Code's default hook shell there is Git
/// Bash. curl reads Claude's payload straight from the shell's *inherited* stdin
/// (`--data-binary @-`); we deliberately do NOT round-trip it through a PowerShell
/// string (`$x=[Console]::In.ReadToEnd(); $x | curl`), because PowerShell prepends
/// a UTF-8 BOM when piping a string to a native process, which `serde_json` then
/// refuses to parse — silently dropping every payload. (Verified empirically.)
fn write_instrument_settings(port: u16, session_id: &str) -> std::io::Result<String> {
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir)?;

    // Tag every POST with Muster's STABLE launch id via an `X-CC-Session` header,
    // so telemetry keeps routing to the right pane even after Claude rotates its own
    // runtime session_id (/clear, /compact, /resume all mint a new one). The id is
    // baked into the generated command — no dependence on env propagation.
    #[cfg(windows)]
    let (statusline_cmd, hook_cmd, shell): (String, String, Option<&str>) = {
        let curl = r"C:\Windows\System32\curl.exe";
        let statusline = format!(
            "& '{curl}' -s --max-time 1 -X POST 'http://127.0.0.1:{port}/statusline' -H 'X-CC-Session: {session_id}' --data-binary '@-' 1>$null 2>$null; Write-Output 'cc-launcher'"
        );
        let hook = format!(
            "& '{curl}' -s --max-time 2 -X POST 'http://127.0.0.1:{port}/hook' -H 'X-CC-Session: {session_id}' --data-binary '@-' 1>$null 2>$null"
        );
        (statusline, hook, Some("powershell"))
    };
    #[cfg(not(windows))]
    let (statusline_cmd, hook_cmd, shell): (String, String, Option<&str>) = {
        let statusline = format!(
            "i=$(/bin/cat); printf '%s' \"$i\" | /usr/bin/curl -s --max-time 1 -X POST 'http://127.0.0.1:{port}/statusline' -H 'X-CC-Session: {session_id}' --data-binary @- >/dev/null 2>&1; printf 'cc-launcher'"
        );
        let hook = format!(
            "/usr/bin/curl -s --max-time 2 -X POST 'http://127.0.0.1:{port}/hook' -H 'X-CC-Session: {session_id}' --data-binary @- >/dev/null 2>&1 || true"
        );
        (statusline, hook, None)
    };

    // Build the command-hook leaf once (adding `shell` on Windows) and clone it per
    // event, so the platform choice lives in exactly one place.
    let mut hook_leaf = serde_json::json!({ "type": "command", "command": hook_cmd, "async": true, "timeout": 5 });
    if let Some(sh) = shell {
        hook_leaf["shell"] = serde_json::Value::String(sh.to_string());
    }

    let events = [
        "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
        "PostToolUseFailure", "Notification", "Stop", "StopFailure", "SubagentStart",
        "SubagentStop",
    ];
    let mut hooks = serde_json::Map::new();
    for ev in events {
        hooks.insert(
            ev.to_string(),
            serde_json::json!([ { "matcher": "", "hooks": [ hook_leaf.clone() ] } ]),
        );
    }
    // PermissionRequest is a BLOCKING http hook — Claude waits for the app's
    // decision. It's `type:"http"`, so it's shell-independent and identical on
    // every platform.
    hooks.insert(
        "PermissionRequest".to_string(),
        serde_json::json!([
            { "matcher": "", "hooks": [ { "type": "http", "url": format!("http://127.0.0.1:{port}/permission?sid={session_id}"), "timeout": 600 } ] }
        ]),
    );

    let mut statusline = serde_json::json!({ "type": "command", "command": statusline_cmd, "refreshInterval": 3, "padding": 0 });
    if let Some(sh) = shell {
        statusline["shell"] = serde_json::Value::String(sh.to_string());
    }

    let settings = serde_json::json!({
        "statusLine": statusline,
        "hooks": hooks
    });

    let path = dir.join(format!("instrument-{session_id}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&settings)?)?;
    Ok(path.to_string_lossy().to_string())
}

/// Resolve the absolute path to the `claude` binary. GUI apps get a stripped PATH
/// (Finder on macOS, no inherited shell env on Windows), so we check common install
/// locations first and fall back to a `which`/`where` probe.
#[cfg(not(windows))]
fn resolve_claude() -> String {
    let home = home_dir();
    let candidates = [
        format!("{home}/.local/bin/claude"),
        format!("{home}/.claude/local/claude"),
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
        "/usr/bin/claude".to_string(),
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if let Ok(o) = sys_command(&shell).args(["-lic", "command -v claude"]).output() {
        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "claude".to_string()
}

/// Windows: prefer the native installer's `claude.exe` (spawnable directly via
/// CreateProcess, unlike the npm `.cmd` shim which needs a shell), then `where`.
#[cfg(windows)]
fn resolve_claude() -> String {
    let home = home_dir();
    let candidates = [
        format!(r"{home}\.local\bin\claude.exe"),
        format!(r"{home}\.claude\local\claude.exe"),
        format!(r"{home}\AppData\Local\Programs\claude\claude.exe"),
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    // `where` may print several lines (claude.exe + claude.cmd); prefer a .exe.
    if let Ok(o) = sys_command("where").arg("claude").output() {
        let text = String::from_utf8_lossy(&o.stdout);
        let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        if let Some(exe) = lines.iter().find(|l| l.to_lowercase().ends_with(".exe")) {
            return exe.to_string();
        }
        if let Some(first) = lines.first() {
            return first.to_string();
        }
    }
    "claude".to_string()
}

/// A PATH that includes the usual per-user bin dirs, so the spawned `claude`
/// (and anything it shells out to) is found even under a stripped PATH.
#[cfg(not(windows))]
fn augmented_path() -> String {
    let home = home_dir();
    let base = std::env::var("PATH").unwrap_or_default();
    format!("{home}/.local/bin:{home}/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{base}")
}

/// Windows uses `;` as the PATH separator; include the native-installer bin dir and
/// System32 (where `curl.exe` lives), then whatever we inherited.
#[cfg(windows)]
fn augmented_path() -> String {
    let home = home_dir();
    let base = std::env::var("PATH").unwrap_or_default();
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    format!(r"{home}\.local\bin;{home}\.claude\local;{sysroot}\System32;{base}")
}

/// Force a UTF-8 locale on a PTY child. A macOS app launched from Finder inherits no
/// `LANG`, so the child falls back to the C/POSIX locale and mangles non-ASCII output
/// (UTF-8 rendered as Mac Roman — `ü`→`√º`, emoji shredded). Terminal.app/iTerm set a
/// UTF-8 locale on startup; mirror that. Preserve an already-UTF-8 `LANG` (e.g. Muster
/// launched from a terminal), else default one; and pin `LC_CTYPE` so an inherited
/// `LC_CTYPE=C` can't re-break the charset behind a good `LANG`.
#[cfg(windows)]
fn apply_utf8_locale(_cmd: &mut CommandBuilder) {
    // No-op on Windows: the C-locale charset mangling this guards against is a
    // POSIX/Finder concern. ConPTY + claude.exe handle console encoding themselves.
}

#[cfg(not(windows))]
fn apply_utf8_locale(cmd: &mut CommandBuilder) {
    let is_utf8 = |var: &str| {
        std::env::var(var)
            .map(|v| { let u = v.to_ascii_uppercase(); u.contains("UTF-8") || u.contains("UTF8") })
            .unwrap_or(false)
    };
    if !is_utf8("LANG") {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if !is_utf8("LC_CTYPE") {
        cmd.env("LC_CTYPE", "en_US.UTF-8");
    }
}

#[tauri::command]
fn spawn_claude(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    workdir: String,
    rows: u16,
    cols: u16,
    resume: Option<String>,
) -> Result<(), String> {
    let port = state.port;
    // A resume must land in the session's ORIGINAL cwd: Claude looks the id up in
    // `~/.claude/projects/<enc(cwd)>/`, so resuming from elsewhere fails with "no
    // conversation found". Creating the dir would silently produce that failure
    // against an empty project, so refuse up front with something actionable.
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let claude = resolve_claude();
    let mut cmd = CommandBuilder::new(&claude);
    // `--resume` and `--session-id` are mutually exclusive — resume adopts the
    // stored id and ignores ours — so this is either/or, never both. `--settings`
    // stays keyed to OUR launch uuid either way, so every hook still POSTs the
    // `X-CC-Session` header the frontend routes by, whatever id Claude runs under.
    match &resume {
        Some(prev) => {
            cmd.arg("--resume");
            cmd.arg(prev);
        }
        None => {
            cmd.arg("--session-id");
            cmd.arg(&session_id);
        }
    }
    cmd.arg("--settings");
    cmd.arg(&settings_path);
    cmd.cwd(&workdir);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("CC_LAUNCHER_SESSION", &session_id);
    apply_utf8_locale(&mut cmd);

    log::info!(
        "spawn claude · {session_id} · {workdir}{}",
        resume.as_deref().map(|r| format!(" · resume {r}")).unwrap_or_default()
    );
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    // Record the claude pid so we can recognise this session on disk even after
    // its id changes (e.g. the user runs /resume). Captured before `child` moves
    // into the reaper thread below.
    let child_pid = child.process_id();
    if let Some(p) = child_pid {
        state.owned_pids.lock().unwrap().insert(p);
    }

    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session { master: pair.master, writer, killer, pid: child_pid, workdir },
    );

    stream_pty_session(app, session_id, reader, child, child_pid);
    Ok(())
}

/// Spawn the reader (PTY output → `pty-output`) and reaper (`pty-exit` + session
/// cleanup) threads shared by every embedded PTY pane — a `claude` session or a
/// plain shell. `child_pid` is removed from `owned_pids` on exit (a no-op for a
/// shell, which was never inserted there).
fn stream_pty_session(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    child_pid: Option<u32>,
) {
    let app_out = app.clone();
    let sid_out = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = STANDARD.encode(&buf[..n]);
                    if app_out
                        .emit("pty-output", serde_json::json!({ "sessionId": sid_out, "data": encoded }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(0);
        log::info!("pty exit · {session_id} · code {code}");
        if let Some(st) = app.try_state::<AppState>() {
            st.sessions.lock().unwrap().remove(&session_id);
            if let Some(p) = child_pid {
                st.owned_pids.lock().unwrap().remove(&p);
            }
        }
        let _ = app.emit("pty-exit", serde_json::json!({ "sessionId": session_id, "code": code }));
    });
}

/// The interactive shell for a scratch terminal pane: `(program, args)`.
/// macOS/Linux: the user's `$SHELL` as a login shell. Windows: PowerShell 7
/// (`pwsh`) if installed, else Windows PowerShell, else `cmd.exe` — no login flag.
#[cfg(not(windows))]
fn interactive_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    (shell, vec!["-l".to_string()])
}

#[cfg(windows)]
fn interactive_shell() -> (String, Vec<String>) {
    let pwsh = r"C:\Program Files\PowerShell\7\pwsh.exe";
    if std::path::Path::new(pwsh).exists() {
        return (pwsh.to_string(), vec!["-NoLogo".to_string()]);
    }
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let powershell = format!(r"{sysroot}\System32\WindowsPowerShell\v1.0\powershell.exe");
    if std::path::Path::new(&powershell).exists() {
        return (powershell, vec!["-NoLogo".to_string()]);
    }
    (format!(r"{sysroot}\System32\cmd.exe"), vec![])
}

/// Open a plain login shell in an embedded PTY (no Claude, no instrumentation) — a
/// scratch terminal that lives in a Muster pane just like a session. Wired to the
/// same `pty-output` / `write_pty` / `pty-exit` path as `spawn_claude`.
#[tauri::command]
fn spawn_shell(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    workdir: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let (shell, shell_args) = interactive_shell();
    let mut cmd = CommandBuilder::new(&shell);
    for a in &shell_args {
        cmd.arg(a);
    }
    cmd.cwd(&workdir);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    apply_utf8_locale(&mut cmd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let child_pid = child.process_id();
    // Deliberately NOT added to owned_pids: a plain shell isn't a claude process
    // and never registers in ~/.claude/sessions, so it can't leak as "external".
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session { master: pair.master, writer, killer, pid: child_pid, workdir },
    );
    stream_pty_session(app, session_id, reader, child, child_pid);
    Ok(())
}

/// No Ghostty engine on Windows — the embedded xterm.js pane is the only engine.
#[cfg(windows)]
fn find_ghostty() -> Option<String> {
    None
}

#[cfg(not(windows))]
fn find_ghostty() -> Option<String> {
    if let Ok(o) = sys_command("which").arg("ghostty").output() {
        if o.status.success() {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !p.is_empty() {
                return Some(p);
            }
        }
    }
    for c in [
        "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        "/opt/homebrew/bin/ghostty",
        "/usr/local/bin/ghostty",
    ] {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

/// Launch the instrumented `claude` session in an external Ghostty window,
/// tinted to the project's accent. Telemetry still flows via the hooks/statusline,
/// so the session appears in Muster's cockpit — just without an embedded terminal.
#[tauri::command]
fn spawn_ghostty(
    state: State<AppState>,
    session_id: String,
    workdir: String,
    accent: String,
    title: String,
    resume: Option<String>,
) -> Result<(), String> {
    let port = state.port;
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;
    let bin = find_ghostty()
        .ok_or_else(|| "Ghostty not found — install it or add `ghostty` to your PATH".to_string())?;

    let bg = accent.trim_start_matches('#').to_string();
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(format!("--background={bg}"));
    cmd.arg(format!("--title={title}"));
    cmd.arg(format!("--working-directory={workdir}"));
    cmd.arg("-e");
    cmd.arg(resolve_claude());
    // Either/or, never both — see the note in `spawn_claude`.
    match &resume {
        Some(prev) => {
            cmd.arg("--resume");
            cmd.arg(prev);
        }
        None => {
            cmd.arg("--session-id");
            cmd.arg(&session_id);
        }
    }
    cmd.arg("--settings");
    cmd.arg(&settings_path);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.spawn().map_err(|e| format!("launch Ghostty: {e}"))?;
    Ok(())
}

/// Which external terminals are installed, so the UI only offers ones that work.
/// (The embedded terminal is always available and isn't listed here.) Windows has
/// no external-terminal engine yet, so this is empty there and the UI falls back to
/// the embedded pane.
#[cfg(windows)]
#[tauri::command]
fn available_terminals() -> Vec<String> {
    Vec::new()
}

#[cfg(not(windows))]
#[tauri::command]
fn available_terminals() -> Vec<String> {
    let mut v = Vec::new();
    if find_ghostty().is_some() {
        v.push("ghostty".to_string());
    }
    // Terminal.app ships with macOS.
    if std::path::Path::new("/System/Applications/Utilities/Terminal.app").exists()
        || std::path::Path::new("/Applications/Utilities/Terminal.app").exists()
    {
        v.push("terminal".to_string());
    }
    if std::path::Path::new("/Applications/iTerm.app").exists() {
        v.push("iterm".to_string());
    }
    v
}

/// Single-quote a string for safe inclusion in a POSIX shell script.
#[cfg(not(windows))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// No external-terminal engine on Windows yet — the frontend won't offer one (see
/// `available_terminals`), but guard the command so a stray call fails cleanly.
#[cfg(windows)]
#[tauri::command]
fn spawn_external_terminal(
    _session_id: String,
    _workdir: String,
    _engine: String,
    _title: String,
    _resume: Option<String>,
) -> Result<(), String> {
    Err("external terminals aren't supported on Windows yet — use the embedded terminal".to_string())
}

/// Launch an instrumented `claude` session in a generic external terminal app
/// (Terminal.app / iTerm2). We write an executable `.command` wrapper that sets
/// up PATH, cd's into the workdir and execs claude, then hand it to `open -a`.
/// Telemetry still flows via the per-session settings hooks, so the session shows
/// up in Muster's cockpit just like an embedded/Ghostty one.
#[cfg(not(windows))]
#[tauri::command]
fn spawn_external_terminal(
    state: State<AppState>,
    session_id: String,
    workdir: String,
    engine: String,
    title: String,
    resume: Option<String>,
) -> Result<(), String> {
    let port = state.port;
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;
    let claude = resolve_claude();

    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join(format!("run-{session_id}.command"));

    // Either/or, never both — see the note in `spawn_claude`.
    let id_args = match &resume {
        Some(prev) => format!("--resume {}", sh_quote(prev)),
        None => format!("--session-id {}", sh_quote(&session_id)),
    };
    let body = format!(
        "#!/bin/zsh\n# Muster session: {title}\nexport PATH={path}\ncd {wd} || exit 1\nexec {claude} {id_args} --settings {settings}\n",
        title = title.replace(['\n', '\r'], " "),
        path = sh_quote(&augmented_path()),
        wd = sh_quote(&workdir),
        claude = sh_quote(&claude),
        settings = sh_quote(&settings_path),
    );
    std::fs::write(&script, body).map_err(|e| format!("write launcher: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }

    let app_name = match engine.as_str() {
        "iterm" => "iTerm",
        _ => "Terminal",
    };
    std::process::Command::new("open")
        .arg("-a")
        .arg(app_name)
        .arg(&script)
        .spawn()
        .map_err(|e| format!("open {app_name}: {e}"))?;
    Ok(())
}

/// Windows: pop a plain scratch terminal at `workdir` — Windows Terminal (`wt.exe`)
/// if installed, else a PowerShell window via `cmd /c start`. `engine` is ignored
/// (there's only the embedded engine on Windows).
#[cfg(windows)]
#[tauri::command]
fn open_terminal_here(workdir: String, _engine: String) -> Result<(), String> {
    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    // Windows Terminal opens a new tab/window rooted at a directory via `-d`.
    if sys_command("wt.exe").arg("-d").arg(&workdir).spawn().is_ok() {
        return Ok(());
    }
    // Fallback: `cmd /c start` spawns a *new console window* (a bare Command::spawn
    // of powershell from a GUI app gets no window). `-NoExit` keeps it open.
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let powershell = format!(r"{sysroot}\System32\WindowsPowerShell\v1.0\powershell.exe");
    std::process::Command::new(format!(r"{sysroot}\System32\cmd.exe"))
        .args(["/C", "start", "", &powershell, "-NoExit"])
        .current_dir(&workdir)
        .spawn()
        .map_err(|e| format!("open terminal: {e}"))?;
    Ok(())
}

/// Open a plain (non-Claude) shell in an external terminal at `workdir` — a quick
/// scratch terminal for running commands next to a session. There's no
/// instrumentation here: it's just a shell, so it does NOT appear in Muster's
/// cockpit. `engine` is a hint (the user's chosen launch engine); embedded has no
/// external window, so it falls back to Terminal.app.
#[cfg(not(windows))]
#[tauri::command]
fn open_terminal_here(workdir: String, engine: String) -> Result<(), String> {
    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    // Ghostty opens its default shell in the given dir via a CLI flag.
    if engine == "ghostty" {
        if let Some(bin) = find_ghostty() {
            let mut cmd = std::process::Command::new(bin);
            cmd.arg(format!("--working-directory={workdir}"));
            for (k, v) in std::env::vars() {
                cmd.env(k, v);
            }
            cmd.env("PATH", augmented_path());
            cmd.spawn().map_err(|e| format!("launch Ghostty: {e}"))?;
            return Ok(());
        }
    }
    // Terminal.app / iTerm both open a new window at a directory passed to `open -a`.
    let app_name = if engine == "iterm" && std::path::Path::new("/Applications/iTerm.app").exists() {
        "iTerm"
    } else {
        "Terminal"
    };
    std::process::Command::new("open")
        .arg("-a")
        .arg(app_name)
        .arg(&workdir)
        .spawn()
        .map_err(|e| format!("open {app_name}: {e}"))?;
    Ok(())
}

/// Open a project's folder in the OS file manager (Explorer / Finder / the
/// desktop's default handler). Refuses a vanished directory rather than silently
/// doing nothing — deleted worktrees are real.
#[tauri::command]
fn open_folder(dir: String) -> Result<(), String> {
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    #[cfg(windows)]
    {
        // explorer.exe is fire-and-forget: it hands off to the running shell and
        // exits non-zero even when the window opened, so never wait on its status.
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        std::process::Command::new(format!(r"{sysroot}\explorer.exe"))
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("open Explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("open Finder: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
    }
    Ok(())
}

/// Persist a debug snapshot (JSON built by the frontend) to a fixed, discoverable
/// path so an external tool — or an LLM agent debugging the running app — can read
/// live state and the recent event log. Returns the path written.
#[tauri::command]
fn write_debug_file(contents: String) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("muster-debug.json");
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Tee a frontend `dlog()` line into the backend rolling log (muster.log), tagged
/// `[ui]`. The UI's event stream is otherwise only an in-memory ring mirrored to
/// the *overwritten* muster-debug.json snapshot — so it doesn't survive a crash.
/// Forwarding it here puts the whole timeline (UI + backend) in one durable,
/// time-ordered file: after #12 the backend was crash-visible but the UI half
/// wasn't. Fire-and-forget from the frontend; a dropped line is not worth an error.
#[tauri::command]
fn log_frontend(level: String, msg: String) {
    match level.as_str() {
        "error" => log::error!("[ui] {msg}"),
        "warn" => log::warn!("[ui] {msg}"),
        _ => log::info!("[ui] {msg}"),
    }
}

#[tauri::command]
fn write_pty(state: State<AppState>, session_id: String, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    if let Some(s) = map.get_mut(&session_id) {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn resize_pty(state: State<AppState>, session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    if let Some(s) = map.get(&session_id) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Answer a held-open PermissionRequest. behavior = "allow" | "deny" | "terminal"
/// ("terminal" returns 204 so Claude falls back to its own in-terminal prompt).
#[tauri::command]
fn resolve_permission(state: State<AppState>, id: String, behavior: String) {
    if let Some(req) = state.pending.lock().unwrap().remove(&id) {
        if behavior == "terminal" {
            let _ = req.respond(tiny_http::Response::from_string("").with_status_code(204));
        } else {
            let body = if behavior == "deny" {
                r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}"#
            } else {
                r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
            };
            let header =
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
            let _ = req.respond(tiny_http::Response::from_string(body).with_header(header));
        }
    }
}

#[tauri::command]
fn kill_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    let killed = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(mut s) = killed {
        log::info!("kill session · {session_id}");
        let _ = s.killer.kill();
        if let Some(p) = s.pid {
            state.owned_pids.lock().unwrap().remove(&p);
        }
    }
    Ok(())
}

/// A caffeinate flag we're willing to pass through: a short-option cluster over
/// the sleep-assertion letters (`-d -i -m -s -u`, or combined like `-dimsu`),
/// the `-t` timeout switch, or a bare decimal number (its seconds argument).
/// Everything the UI sends is a fixed preset, so this is just belt-and-braces
/// against ever handing an arbitrary string to the shell-less spawn.
#[cfg(not(windows))]
fn valid_caffeinate_flag(f: &str) -> bool {
    if let Some(rest) = f.strip_prefix('-') {
        return !rest.is_empty() && rest.chars().all(|c| "dimsut".contains(c));
    }
    !f.is_empty() && f.chars().all(|c| c.is_ascii_digit())
}

/// Toggle a macOS `caffeinate` power-assertion on or off. Only ever one child
/// runs: any existing one is killed first, so switching presets is just a
/// stop+restart. `active=false` (or an empty `flags`) simply stops it.
#[cfg(not(windows))]
#[tauri::command]
fn set_caffeinate(state: State<AppState>, active: bool, flags: Vec<String>) -> Result<(), String> {
    let mut guard = state.caffeinate.lock().unwrap();
    // Tear down whatever's running (also reaps a child that self-exited on -t).
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if !active || flags.is_empty() {
        return Ok(());
    }
    if let Some(bad) = flags.iter().find(|f| !valid_caffeinate_flag(f)) {
        return Err(format!("refusing unknown caffeinate flag: {bad}"));
    }
    // `-w <our pid>`: caffeinate exits on its own the moment Muster does, so a
    // crash or force-quit can't leave the display pinned awake.
    let mut cmd = std::process::Command::new("/usr/bin/caffeinate");
    cmd.arg("-w").arg(std::process::id().to_string());
    for f in &flags {
        cmd.arg(f);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("caffeinate: {e}"))?;
    *guard = Some(child);
    Ok(())
}

/// A live Windows power assertion. `SetThreadExecutionState` is scoped to the
/// *calling thread* — the assertion dies with that thread — so we park a thread
/// for exactly as long as the user wants the machine awake. That thread-scoping
/// is also the safety net the macOS side gets from `caffeinate -w <our pid>`: a
/// panic or a hard exit can't leave a Windows box pinned awake, because the
/// thread goes with the process.
#[cfg(windows)]
struct KeepAwake {
    /// Dropping this releases the assertion: the parked thread's `recv()` fails,
    /// it clears the execution state and exits.
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(windows)]
impl Drop for KeepAwake {
    fn drop(&mut self) {
        drop(self.stop.take());
        // Join so the state is provably cleared before a replacement assertion
        // is set up — otherwise a preset switch could race the old thread's
        // clearing call and land on ES_CONTINUOUS (i.e. silently off).
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Translate the macOS `caffeinate` flags the UI speaks into Windows execution
/// state bits, so the frontend keeps one vocabulary for both platforms.
///
///   `-d` (display) → `ES_DISPLAY_REQUIRED`   `-i` / `-s` (idle/system) → `ES_SYSTEM_REQUIRED`
///   `-m` (disk) and `-u` (user active) have no Windows equivalent and are dropped.
///   `-t <sec>` is dropped too — the frontend's own timer disarms the preset.
///
/// Anything that asks for the display also implies the system, matching what a
/// user means by "keep the screen on". Returns 0 when nothing was requested.
///
/// Deliberately *not* mapped: `ES_AWAYMODE_REQUIRED`. It's only honoured where
/// the power policy enables away mode, and where it isn't the whole call fails
/// (returns 0) — so asking for it would silently assert nothing at all.
#[cfg(windows)]
fn execution_state_for(flags: &[String]) -> u32 {
    use windows_sys::Win32::System::Power::{ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
    let mut es = 0u32;
    for f in flags {
        let Some(rest) = f.strip_prefix('-') else { continue }; // bare `-t` argument
        for c in rest.chars() {
            match c {
                'd' => es |= ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED,
                'i' | 's' => es |= ES_SYSTEM_REQUIRED,
                _ => {} // m / u / t — nothing to assert
            }
        }
    }
    es
}

/// Toggle a Windows power assertion on or off — the `caffeinate` counterpart.
/// Only ever one assertion is live: an existing one is dropped (which joins its
/// thread and clears the state) first, so switching presets is a stop+restart.
#[cfg(windows)]
#[tauri::command]
fn set_caffeinate(state: State<AppState>, active: bool, flags: Vec<String>) -> Result<(), String> {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
    let mut guard = state.caffeinate.lock().unwrap();
    guard.take(); // drop → releases whatever was asserted
    if !active || flags.is_empty() {
        return Ok(());
    }
    let es = execution_state_for(&flags);
    if es == 0 {
        return Err(format!("no Windows keep-awake equivalent for: {}", flags.join(" ")));
    }
    let (stop, rx) = std::sync::mpsc::channel::<()>();
    // The assertion must be set *and* released on the same thread, so the whole
    // lifetime lives inside this closure: assert, park, clear.
    let (ready, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let thread = std::thread::spawn(move || {
        // SAFETY: a plain flags-in/flags-out Win32 call with no pointers.
        let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | es) };
        if prev == 0 {
            let _ = ready.send(Err("SetThreadExecutionState refused the request".into()));
            return;
        }
        let _ = ready.send(Ok(()));
        let _ = rx.recv(); // park until the sender is dropped
        // SAFETY: same call; ES_CONTINUOUS alone clears our assertion.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    });
    // Surface a refusal as a command error instead of a thread that quietly did
    // nothing — the UI would otherwise paint the cup lit over a sleeping PC.
    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = thread.join();
            return Err(e);
        }
        Err(_) => return Err("keep-awake thread died before asserting".into()),
    }
    *guard = Some(KeepAwake { stop: Some(stop), thread: Some(thread) });
    Ok(())
}

/// Create a git worktree with a new (or existing) branch off `repo_dir`.
/// Returns the absolute worktree path. Worktrees live in a sibling
/// `.cc-worktrees/<repo>/<branch>` folder so the repo stays clean.
#[tauri::command]
fn create_worktree(repo_dir: String, branch: String) -> Result<String, String> {
    // Every git call forces LC_ALL=C: we must never depend on localized output.
    // A German git says "existiert bereits", not "already exists" — parsing error
    // text for control flow (as this used to) silently broke worktree creation on
    // non-English gits. We now branch on exit codes / an explicit existence probe.
    let git = |args: &[&str]| {
        sys_command("git")
            .env("LC_ALL", "C")
            .args(args)
            .output()
    };

    let root_out = git(&["-C", &repo_dir, "rev-parse", "--show-toplevel"])
        .map_err(|e| e.to_string())?;
    if !root_out.status.success() {
        return Err("not a git repository".into());
    }
    let root = String::from_utf8_lossy(&root_out.stdout).trim().to_string();
    let safe: String = branch.trim().chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.') { c } else { '-' })
        .collect();
    if safe.is_empty() {
        return Err("empty branch name".into());
    }

    let root_path = std::path::Path::new(&root);
    let name = root_path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "repo".into());
    let parent = root_path.parent().unwrap_or(root_path);
    let wt_path = parent.join(".cc-worktrees").join(&name).join(safe.replace('/', "-"));
    if let Some(p) = wt_path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let wt_str = wt_path.to_string_lossy().to_string();

    // Decide new-branch (-b) vs attach-existing by probing the ref directly,
    // instead of creating and inspecting a localized error string.
    let branch_exists = git(&["-C", &root, "rev-parse", "--verify", "--quiet", &format!("refs/heads/{safe}")])
        .map(|o| o.status.success())
        .unwrap_or(false);

    let add = if branch_exists {
        git(&["-C", &root, "worktree", "add", &wt_str, &safe])
    } else {
        git(&["-C", &root, "worktree", "add", "-b", &safe, &wt_str])
    }.map_err(|e| e.to_string())?;
    if add.status.success() {
        return Ok(wt_str);
    }

    // Recoverable case: the worktree dir already exists from a previous run and is
    // already on the branch we want — hand it back so re-opening it just works.
    if wt_path.is_dir() {
        if let Ok(o) = git(&["-C", &wt_str, "rev-parse", "--abbrev-ref", "HEAD"]) {
            if o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == safe {
                return Ok(wt_str);
            }
        }
    }
    Err(String::from_utf8_lossy(&add.stderr).trim().to_string())
}

#[derive(serde::Serialize, Debug)]
struct Worktree {
    path: String,
    branch: String,
    is_main: bool,
    /// Working tree has uncommitted or untracked changes (`git status --porcelain`).
    /// A dirty worktree can't be removed without `--force`, so the UI won't offer a
    /// one-click removal for it. Always false for the main worktree (never removable).
    dirty: bool,
    /// This worktree's branch is fully merged into the MAIN worktree's branch (its
    /// commits are an ancestor). Removing such a worktree — and safe-deleting its
    /// branch — loses nothing, so the UI can surface it as the obvious cleanup.
    merged: bool,
}

/// List the git worktrees for a repo (parsed from `git worktree list --porcelain`).
/// The first entry is the main working tree. Each linked worktree is enriched with
/// `dirty` / `merged` cues so the picker can tell which are safe to clean up.
#[tauri::command]
fn list_worktrees(repo_dir: String) -> Vec<Worktree> {
    let out = sys_command("git")
        .arg("-C").arg(&repo_dir).args(["worktree", "list", "--porcelain"])
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut res: Vec<Worktree> = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch = String::new();
    let flush = |res: &mut Vec<Worktree>, path: Option<String>, branch: String| {
        if let Some(path) = path {
            let is_main = res.is_empty();
            res.push(Worktree { path, branch, is_main, dirty: false, merged: false });
        }
    };
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut res, cur_path.take(), std::mem::take(&mut cur_branch));
            cur_path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        } else if line.starts_with("detached") {
            cur_branch = "(detached)".to_string();
        }
    }
    flush(&mut res, cur_path.take(), cur_branch);

    // Second pass: cleanliness cues for the linked worktrees. `merged` is measured
    // against the main worktree's branch. Every git call here is best-effort — any
    // hiccup just leaves the flag false, which only ever makes the UI more cautious.
    let main_branch = res.iter().find(|w| w.is_main)
        .map(|w| w.branch.clone())
        .filter(|b| !b.is_empty() && b != "(detached)");
    for w in res.iter_mut() {
        if w.is_main {
            continue;
        }
        w.dirty = sys_command("git")
            .env("LC_ALL", "C")
            .arg("-C").arg(&w.path)
            .args(["--no-optional-locks", "status", "--porcelain"])
            .output()
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false);
        if let Some(mb) = &main_branch {
            if !w.branch.is_empty() && w.branch != "(detached)" && &w.branch != mb {
                // `merge-base --is-ancestor A B` exits 0 when A is an ancestor of B,
                // i.e. this worktree's branch is fully contained in the main branch.
                w.merged = sys_command("git")
                    .env("LC_ALL", "C")
                    .arg("-C").arg(&repo_dir)
                    .args(["merge-base", "--is-ancestor",
                        &format!("refs/heads/{}", w.branch),
                        &format!("refs/heads/{mb}")])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
            }
        }
    }
    res
}

/// True when two paths point at the same location, tolerant of symlinks and
/// trailing slashes. Falls back to a string compare when either can't be
/// canonicalized (e.g. one has already been deleted).
fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// Remove a linked git worktree, optionally safe-deleting its branch. Mirrors
/// `git_action`'s rule that no button may leave state the UI can't explain: the
/// destructive `--force` (worktree) and `-D` (branch) variants are NEVER run from
/// here — on refusal we hand back the exact shell command to run in a terminal.
///
/// Two guards up front: refuse while a live embedded session runs in the worktree
/// (close it first), and refuse the repo's main worktree. Beyond that, plain
/// `git worktree remove` is the safety net — it declines a dirty/untracked tree on
/// its own, so committed work is never at risk from a click.
#[tauri::command]
fn remove_worktree(
    state: State<AppState>,
    repo_dir: String,
    path: String,
    branch: String,
    delete_branch: bool,
) -> Result<GitActionResult, String> {
    // The one guard that needs live app state: never yank a worktree out from under
    // a running embedded session. The rest is pure git and lives in the helper.
    let label = if branch.is_empty() { "worktree" } else { &branch };
    if state.sessions.lock().unwrap().values().any(|s| same_path(&s.workdir, &path)) {
        return Err(format!("a session is still running in {label} — close it first"));
    }
    remove_worktree_impl(&repo_dir, &path, &branch, delete_branch)
}

/// The git side of `remove_worktree`, free of app state so it's testable against a
/// real temp repo. Refuses the main worktree; removes without `--force`; optionally
/// safe-deletes the branch — handing back the force command on any refusal.
fn remove_worktree_impl(
    repo_dir: &str,
    path: &str,
    branch: &str,
    delete_branch: bool,
) -> Result<GitActionResult, String> {
    let label = if branch.is_empty() { "worktree".to_string() } else { branch.to_string() };

    if list_worktrees(repo_dir.to_string()).iter().any(|w| w.is_main && same_path(&w.path, path)) {
        return Err("that's the repo's main worktree — it can't be removed".into());
    }

    let out = git_run(git_cmd(repo_dir, &["worktree", "remove", path]), 30)?;
    if !out.status.success() {
        let combined = [
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
        let first = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("git refused").to_string();
        return Ok(GitActionResult {
            ok: false,
            summary: first,
            output: combined,
            suggest: Some(format!("git worktree remove --force \"{path}\"")),
        });
    }

    // Best-effort: drop the now-empty `.cc-worktrees/<repo>/` parent so the sibling
    // tree doesn't accumulate empty dirs. `remove_dir` only succeeds when empty.
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = std::fs::remove_dir(parent);
    }

    if delete_branch && !branch.is_empty() && branch != "(detached)" {
        // Safe-delete only: `git branch -d` refuses an unmerged branch. If it does,
        // the worktree is already gone — report success and offer the force command.
        let del = git_run(git_cmd(repo_dir, &["branch", "-d", branch]), 15)?;
        if del.status.success() {
            return Ok(GitActionResult {
                ok: true,
                summary: format!("Removed worktree and branch {branch}"),
                output: String::new(),
                suggest: None,
            });
        }
        return Ok(GitActionResult {
            ok: true,
            summary: format!("Removed worktree — kept branch {branch} (not fully merged)"),
            output: String::from_utf8_lossy(&del.stderr).trim().to_string(),
            suggest: Some(format!("git branch -D \"{branch}\"")),
        });
    }

    Ok(GitActionResult { ok: true, summary: format!("Removed worktree {label}"), output: String::new(), suggest: None })
}

/// One local branch, with enough context for the worktree picker to tell whether
/// it's worth starting on. `current` is the branch the repo's HEAD is on (offered
/// as the "start here" button, not in the pick list). `checked_out` means some
/// worktree already holds it — git refuses a second checkout, so it can't take a
/// new worktree and instead appears in the existing-worktrees list. `ahead`/`behind`
/// are versus the current HEAD; `rel`/`unix` describe the last commit (staleness).
#[derive(serde::Serialize, Debug)]
struct BranchInfo {
    name: String,
    current: bool,
    checked_out: bool,
    ahead: u32,
    behind: u32,
    rel: String,
    unix: i64,
}

/// Local branches for the worktree picker, most-recently-committed first, each with
/// staleness + ahead/behind context (see `BranchInfo`). Nothing is filtered here —
/// the frontend hides `current` and `checked_out` from the pickable list; returning
/// them with flags keeps the command honest and testable. Capped at BRANCH_LIST_CAP
/// so a repo with hundreds of refs can't spawn an unbounded rev-list-per-ref; the cap
/// keeps the newest branches, which is what the picker shows first anyway.
#[tauri::command]
fn git_branch_list(repo_dir: String) -> Vec<BranchInfo> {
    const BRANCH_LIST_CAP: usize = 80;
    // LC_ALL=C for the same reason as create_worktree: never depend on localized output.
    let git = |args: &[&str]| sys_command("git").env("LC_ALL", "C").args(args).output();

    let taken: std::collections::HashSet<String> =
        match git(&["-C", &repo_dir, "worktree", "list", "--porcelain"]) {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.strip_prefix("branch "))
                .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string())
                .collect(),
            _ => Default::default(),
        };

    // The branch HEAD points at (None when detached — then there is no "current").
    let current = git(&["-C", &repo_dir, "symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    // Tab-separated so neither the branch name nor the relative date can collide with
    // the delimiter (a relative date is "3 days ago" — spaces, never tabs).
    let out = match git(&[
        "-C", &repo_dir,
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)\t%(committerdate:unix)\t%(committerdate:relative)",
        "refs/heads",
    ]) {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };
    let text = String::from_utf8_lossy(&out.stdout);

    let mut res = Vec::new();
    for line in text.lines().take(BRANCH_LIST_CAP) {
        let mut parts = line.splitn(3, '\t');
        let name = match parts.next() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let unix = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let rel = parts.next().unwrap_or("").to_string();
        let is_current = current.as_deref() == Some(name.as_str());

        // ahead/behind vs current HEAD. `--left-right --count HEAD...<b>` prints
        // "<left>\t<right>": left = commits in HEAD not in the branch (branch is that
        // far *behind*), right = commits in the branch not in HEAD (branch *ahead*).
        // The current branch is definitionally 0/0, so skip the extra process for it.
        let (mut ahead, mut behind) = (0u32, 0u32);
        if !is_current {
            if let Ok(o) = git(&["-C", &repo_dir, "rev-list", "--left-right", "--count",
                &format!("HEAD...refs/heads/{name}")]) {
                if o.status.success() {
                    let s = String::from_utf8_lossy(&o.stdout);
                    let mut it = s.split_whitespace();
                    behind = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                    ahead = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                }
            }
        }

        res.push(BranchInfo {
            checked_out: taken.contains(&name),
            current: is_current,
            name, ahead, behind, rel, unix,
        });
    }
    res
}

/// Current git branch for a working directory (None if not a repo / detached).
#[tauri::command]
fn git_branch(workdir: String) -> Option<String> {
    let out = sys_command("git")
        .arg("-C")
        .arg(&workdir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if b.is_empty() || b == "HEAD" { None } else { Some(b) }
}

#[derive(serde::Serialize)]
struct HeadInfo {
    /// Branch name when on a branch; None when HEAD is detached.
    branch: Option<String>,
    /// Short commit sha of HEAD (used to label a detached checkout).
    short: String,
}

/// Live HEAD of a working directory, so the UI can show the branch that is
/// *actually* checked out rather than the one a worktree was created with (a
/// worktree shows whatever branch is checked out, and that can change). Returns
/// None if the dir isn't a git repo. LC_ALL=C keeps output locale-independent.
#[tauri::command]
fn git_head(workdir: String) -> Option<HeadInfo> {
    let git = |args: &[&str]| {
        sys_command("git")
            .env("LC_ALL", "C")
            .arg("-C").arg(&workdir)
            .args(args)
            .output()
    };
    let head = git(&["rev-parse", "--short", "HEAD"]).ok()?;
    if !head.status.success() {
        return None;
    }
    let short = String::from_utf8_lossy(&head.stdout).trim().to_string();
    // symbolic-ref succeeds only when on a branch; fails on detached HEAD.
    let branch = git(&["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    Some(HeadInfo { branch, short })
}

/// Resolve `cwd` to its repo's MAIN worktree root and current branch. This is what
/// lets external sessions running in different worktrees of one repo group under that
/// repo (and merge into its project) instead of each cwd becoming its own top-level
/// entry in the sidebar. One git call: line 1 = the common `.git` dir (its parent is
/// the main worktree, identical for the main checkout AND every linked worktree),
/// line 2 = the branch ("HEAD" when detached). (None, None) when `cwd` isn't a repo.
fn git_repo_info(cwd: &str) -> (Option<String>, Option<String>) {
    let out = match git_cmd(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return (None, None),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let common = lines.next().unwrap_or("").trim();
    let branch = lines.next().unwrap_or("").trim();
    let root = std::path::Path::new(common).parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty());
    let branch = if branch.is_empty() || branch == "HEAD" { None } else { Some(branch.to_string()) };
    (root, branch)
}

/// A `git` command hardened for running under a GUI app.
///
/// Three things are non-negotiable here, and each one has bitten this codebase's
/// neighbours already:
/// - `LC_ALL=C` — never parse localized output (the german-git-locale gotcha).
/// - an augmented PATH — a Finder-launched app gets a stripped one, and `git` may
///   well live in `/opt/homebrew/bin`.
/// - every credential prompt disabled — a network op that decides to ask for an
///   SSH passphrase or an HTTPS password has no tty to ask on, so without this it
///   blocks forever and takes the invoke thread with it. `BatchMode=yes` makes ssh
///   fail instead of prompting; an askpass that exits non-zero sends git back to
///   the terminal prompt, which `GIT_TERMINAL_PROMPT=0` then refuses. Credential
///   *helpers* (osxkeychain) are untouched, so stored HTTPS creds still work, as
///   do keys already loaded in ssh-agent. Anything else fails fast and readably —
///   which is exactly when we hand the user a terminal.
fn git_cmd(workdir: &str, args: &[&str]) -> std::process::Command {
    let mut c = sys_command("git");
    c.env("LC_ALL", "C")
        .env("PATH", augmented_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    #[cfg(not(windows))]
    {
        c.env("GIT_ASKPASS", "/usr/bin/false").env("SSH_ASKPASS", "/usr/bin/false");
    }
    #[cfg(windows)]
    {
        // No `/usr/bin/false` to point an askpass at; instead forbid Git Credential
        // Manager's interactive GUI prompt, so a missing credential fails fast rather
        // than popping a dialog that hangs the invoke thread. `git_run`'s hard
        // timeout is the ultimate backstop. Stored creds (GCM cache) still work.
        c.arg("-c").arg("credential.interactive=false");
    }
    c.arg("-C").arg(workdir).args(args);
    c
}

/// Run a git command with a hard timeout. `Child::wait` has no timeout in std, so
/// the wait happens on a scratch thread and we kill by pid if it overruns. Without
/// this, a fetch against an unreachable remote hangs a Tauri worker thread for the
/// rest of the app's life.
fn git_run(mut cmd: std::process::Command, secs: u64) -> Result<std::process::Output, String> {
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("git: {e}"))?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    // wait_with_output consumes the child, so the timeout path kills by pid.
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(secs)) {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(_) => {
            #[cfg(not(windows))]
            let _ = sys_command("kill").arg("-9").arg(pid.to_string()).status();
            #[cfg(windows)]
            let _ = sys_command("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).status();
            Err(format!("no answer after {secs}s — remote unreachable, or it wants credentials"))
        }
    }
}

/// Where this branch sits relative to its upstream: `(upstream_name, ahead, behind)`.
/// All zeros with no name when the branch has no upstream, or HEAD is detached.
///
/// Note these counts are only as fresh as the last fetch — git compares against the
/// local remote-tracking ref, not the network. That's why the UI pairs them with a
/// fetch button rather than pretending they're live.
fn upstream_state(workdir: &str) -> (Option<String>, u32, u32) {
    let name = git_cmd(workdir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(name) = name else { return (None, 0, 0) };
    // --left-right --count over the symmetric difference prints "behind\tahead":
    // left side is upstream-only commits, right side is ours.
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Ok(o) = git_cmd(workdir, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).output() {
        if o.status.success() {
            let text = String::from_utf8_lossy(&o.stdout);
            let mut it = text.split_whitespace();
            behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
    }
    (Some(name), ahead, behind)
}

#[derive(serde::Serialize)]
struct DiffStat {
    /// Insertions in the uncommitted working tree (tracked files, vs HEAD).
    added: u32,
    /// Deletions in the uncommitted working tree.
    removed: u32,
    /// Tracked files with uncommitted changes.
    files: u32,
    /// Untracked files (new, never committed).
    untracked: u32,
    /// Total dirty entries (`git status --porcelain` line count).
    dirty: u32,
    /// Upstream ref this branch tracks ("origin/main"), None if it tracks nothing.
    upstream: Option<String>,
    /// Commits we have that the upstream doesn't (as of the last fetch).
    ahead: u32,
    /// Commits the upstream has that we don't (as of the last fetch).
    behind: u32,
}

/// A summary of a session's *uncommitted* work — the "working set" the inspector's
/// Checks strip shows ("+142 −38 · 7 files · 2 new"). We diff against HEAD rather
/// than a base branch on purpose: during a live session the interesting delta is
/// what's in flight since the last commit, and that's always well-defined (whereas
/// guessing the base branch is not). Returns None when `workdir` isn't a repo or
/// has no commits yet. LC_ALL=C + numeric numstat keep it locale-independent (the
/// german-git-locale gotcha) and `--no-optional-locks` avoids fighting a running
/// `git` in the same worktree.
#[tauri::command]
fn git_diffstat(workdir: String) -> Option<DiffStat> {
    let git = |args: &[&str]| {
        sys_command("git")
            .env("LC_ALL", "C")
            .arg("-C").arg(&workdir)
            .args(args)
            .output()
    };
    let ns = git(&["--no-optional-locks", "diff", "--numstat", "HEAD"]).ok()?;
    if !ns.status.success() {
        return None; // not a repo, or an unborn HEAD (no commits)
    }
    let (mut added, mut removed, mut files) = (0u32, 0u32, 0u32);
    for line in String::from_utf8_lossy(&ns.stdout).lines() {
        let mut it = line.split('\t');
        let a = it.next().unwrap_or("");
        let d = it.next().unwrap_or("");
        files += 1;
        added += a.parse::<u32>().unwrap_or(0); // "-" (binary) parses to 0
        removed += d.parse::<u32>().unwrap_or(0);
    }
    let (mut untracked, mut dirty) = (0u32, 0u32);
    if let Ok(st) = git(&["--no-optional-locks", "status", "--porcelain"]) {
        for line in String::from_utf8_lossy(&st.stdout).lines() {
            if line.is_empty() {
                continue;
            }
            dirty += 1;
            if line.starts_with("??") {
                untracked += 1;
            }
        }
    }
    let (upstream, ahead, behind) = upstream_state(&workdir);
    Some(DiffStat { added, removed, files, untracked, dirty, upstream, ahead, behind })
}

#[derive(serde::Serialize)]
struct GitDiff {
    /// Combined unified-diff patch for the working set: tracked changes vs HEAD,
    /// followed by each untracked file rendered as a new-file diff. The frontend
    /// parses this into files/hunks for the peek viewer.
    patch: String,
    /// True when we stopped early because the patch hit the size/file cap — the
    /// viewer shows a "truncated" note so a partial diff can't read as complete.
    truncated: bool,
}

/// The full *uncommitted* diff behind the working-set card, for the peek viewer.
/// Tracked changes come from `diff HEAD`; untracked files are appended as new-file
/// diffs via `diff --no-index` against `/dev/null` — which, unlike `add -N`, never
/// touches the index (important while a live session may be staging/committing).
/// `core.quotepath=false` keeps non-ASCII paths literal; a size + file-count cap
/// stops a huge working tree from shipping a multi-MB payload into the webview.
#[tauri::command]
fn git_diff(workdir: String) -> Option<GitDiff> {
    const CAP: usize = 800_000; // ~0.8 MB of patch text — ample for a peek
    const MAX_UNTRACKED: usize = 300;

    let tracked = git_cmd(&workdir, &["-c", "core.quotepath=false", "--no-optional-locks", "diff", "HEAD"])
        .output()
        .ok()?;
    if !tracked.status.success() {
        return None; // not a repo, or an unborn HEAD (no commits)
    }
    let mut patch = String::from_utf8_lossy(&tracked.stdout).into_owned();
    let mut truncated = false;
    if patch.len() > CAP {
        patch.truncate(CAP);
        truncated = true;
    }

    // Untracked files, each as its own new-file diff. `--no-index` exits 1 whenever
    // the files differ (always, vs /dev/null), so we read stdout regardless of status.
    if !truncated {
        if let Ok(o) = git_cmd(&workdir, &["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]).output() {
            let listing = String::from_utf8_lossy(&o.stdout);
            let others: Vec<&str> = listing.split('\0').filter(|s| !s.is_empty()).collect();
            if others.len() > MAX_UNTRACKED {
                truncated = true;
            }
            for f in others.into_iter().take(MAX_UNTRACKED) {
                if patch.len() >= CAP {
                    truncated = true;
                    break;
                }
                if let Ok(d) = git_cmd(&workdir, &["-c", "core.quotepath=false", "diff", "--no-index", "--", "/dev/null", f]).output() {
                    patch.push_str(&String::from_utf8_lossy(&d.stdout));
                }
            }
            if patch.len() > CAP {
                patch.truncate(CAP);
                truncated = true;
            }
        }
    }
    Some(GitDiff { patch, truncated })
}

#[derive(serde::Serialize, Debug)]
struct GitActionResult {
    ok: bool,
    /// One line for the toast.
    summary: String,
    /// Combined stdout+stderr, for the debug log.
    output: String,
    /// Set when the action can't be finished safely from a button. The UI offers to
    /// open a terminal prefilled with this, rather than leaving the user guessing.
    suggest: Option<String>,
}

/// Fetch / pull / push for a session's working directory — the "git fluff" a
/// cockpit needs so you don't drop to a shell for the routine half of git.
///
/// The design rule is that **no button may leave the working tree in a state the
/// UI can't explain**, because there is no conflict-resolution surface here. So:
/// pull is `--ff-only` (it can never conflict, never half-merge, and git itself
/// refuses when local edits would be clobbered), push never invents an upstream,
/// and the cases we can predict — a diverged branch, a missing upstream, a stale
/// branch that would be rejected — are refused *before* running git, with the
/// command the user should run instead. Committing deliberately isn't here: it
/// belongs to the session, not to a toolbar.
///
/// Every op is safe against a live Claude in the same worktree: fetch and push
/// don't touch the working tree at all, and ff-only pull won't overwrite edits.
#[tauri::command]
fn git_action(workdir: String, op: String) -> Result<GitActionResult, String> {
    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    let branch = git_cmd(&workdir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    let refuse = |summary: &str, suggest: &str| {
        Ok(GitActionResult {
            ok: false,
            summary: summary.to_string(),
            output: String::new(),
            suggest: Some(suggest.to_string()),
        })
    };

    let (upstream, ahead, behind) = upstream_state(&workdir);
    let args: Vec<&str> = match op.as_str() {
        // Read-only and always safe — this is what makes ahead/behind trustworthy.
        "fetch" => vec!["fetch", "--prune"],
        "pull" => {
            let Some(branch) = branch.as_deref() else {
                return refuse("detached HEAD — nothing to pull into", "git switch -");
            };
            if upstream.is_none() {
                return refuse(
                    &format!("{branch} tracks no upstream"),
                    &format!("git branch --set-upstream-to=origin/{branch} {branch}"),
                );
            }
            // Diverged: ff-only would fail anyway. Refusing up front lets us say why
            // and hand over the rebase, instead of surfacing a raw git error.
            if ahead > 0 && behind > 0 {
                return refuse(
                    &format!("diverged — {ahead} ahead, {behind} behind"),
                    "git pull --rebase",
                );
            }
            if behind == 0 {
                return Ok(GitActionResult {
                    ok: true,
                    summary: "already up to date".into(),
                    output: String::new(),
                    suggest: None,
                });
            }
            vec!["pull", "--ff-only"]
        }
        "push" => {
            let Some(branch) = branch.as_deref() else {
                return refuse("detached HEAD — nothing to push", "git switch -");
            };
            // Never invent a remote branch from a button: the first push of a branch
            // is a publishing decision, so we hand it over instead.
            if upstream.is_none() {
                return refuse(
                    &format!("{branch} tracks no upstream"),
                    &format!("git push -u origin {branch}"),
                );
            }
            if behind > 0 {
                return refuse(
                    &format!("{behind} behind — push would be rejected"),
                    "git pull --ff-only && git push",
                );
            }
            if ahead == 0 {
                return Ok(GitActionResult {
                    ok: true,
                    summary: "nothing to push".into(),
                    output: String::new(),
                    suggest: None,
                });
            }
            vec!["push"]
        }
        _ => return Err(format!("unknown git op: {op}")),
    };

    let out = git_run(git_cmd(&workdir, &args), 45)?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let combined = [stdout, stderr].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");

    if out.status.success() {
        // Re-read after a fetch: the whole point of fetching is the new behind count.
        let summary = match op.as_str() {
            "fetch" => match upstream_state(&workdir).2 {
                0 => "fetched — up to date".into(),
                n => format!("fetched — {n} behind"),
            },
            "pull" => format!("pulled {behind} commit{}", if behind == 1 { "" } else { "s" }),
            _ => format!("pushed {ahead} commit{}", if ahead == 1 { "" } else { "s" }),
        };
        return Ok(GitActionResult { ok: true, summary, output: combined, suggest: None });
    }

    // git said no for a reason we didn't predict (local edits in the way, a hook
    // rejecting the push, a protected branch, a host key we've never seen). Show
    // its own first line — the truthful thing — and offer the same op in a shell.
    let first = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("git failed").to_string();
    Ok(GitActionResult {
        ok: false,
        summary: first,
        output: combined,
        suggest: Some(format!("git {}", args.join(" "))),
    })
}

#[derive(serde::Serialize)]
struct Resources {
    /// %CPU as reported by `ps` (a decaying lifetime average on macOS, so it reads
    /// as a rough gauge, not an instantaneous sample).
    cpu: f32,
    /// Resident set size in MiB.
    mem_mb: f32,
}

/// Per-session CPU/RAM for the embedded-PTY `claude` process, looked up by the
/// session id's stored pid. Measures the `claude` process itself (not its whole
/// subtree) — enough for the inspector's "what's this costing my machine" readout.
/// None for external/shell sessions (no owned pid) or a process that has exited.
#[tauri::command]
fn session_resources(state: State<AppState>, session_id: String) -> Option<Resources> {
    let pid = state.sessions.lock().unwrap().get(&session_id)?.pid?;
    let line = ps_one(pid, "%cpu=,rss=")?;
    let mut it = line.split_whitespace();
    let cpu: f32 = it.next()?.parse().ok()?;
    let rss_kb: f32 = it.next()?.parse().ok()?;
    Some(Resources { cpu, mem_mb: rss_kb / 1024.0 })
}

// ---------- project favicon / logo discovery ----------

#[derive(serde::Serialize)]
struct ProjectIcon {
    path: String,
    data_uri: String,
}

/// Pick an image MIME from magic bytes, falling back to the file extension.
/// Repos routinely ship a PNG named `favicon.ico`; trusting the extension would
/// emit a `data:image/x-icon` URI wrapping PNG bytes, which the WebKit webview can
/// refuse to render — so the icon would be "found" yet show as broken.
fn sniff_mime(bytes: &[u8], ext: &str) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    // SVG is text — look for a `<svg` tag near the start (past any XML prolog).
    let head = &bytes[..bytes.len().min(256)];
    if head.windows(4).any(|w| w.eq_ignore_ascii_case(b"<svg")) {
        return Some("image/svg+xml");
    }
    // Couldn't sniff (e.g. an SVG with a long prolog) — trust the extension.
    match ext {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Read a candidate icon file into a base64 data-URI (small files only). The MIME
/// is sniffed from content (see `sniff_mime`), not assumed from the extension.
fn read_icon(p: &std::path::Path) -> Option<ProjectIcon> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 512 * 1024 {
        return None;
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = std::fs::read(p).ok()?;
    let mime = sniff_mime(&bytes, &ext)?;
    let b64 = STANDARD.encode(&bytes);
    Some(ProjectIcon {
        path: p.to_string_lossy().to_string(),
        data_uri: format!("data:{mime};base64,{b64}"),
    })
}

/// Conventional favicon / logo spots relative to a web / Tauri / Electron project
/// root. Returns the first that exists (no recursive walk — this stays cheap).
fn probe_icon_dir(base: &std::path::Path) -> Option<ProjectIcon> {
    const CANDIDATES: &[&str] = &[
        "favicon.ico", "favicon.svg", "favicon.png",
        "public/favicon.ico", "public/favicon.svg", "public/favicon.png",
        "public/apple-touch-icon.png", "public/logo.svg", "public/logo.png",
        "public/icon.svg", "public/icon.png",
        "static/favicon.ico", "static/favicon.svg", "static/favicon.png",
        "static/logo.svg", "static/logo.png",
        "app/favicon.ico", "app/icon.png", "app/icon.svg",
        "src/favicon.ico", "src/favicon.svg",
        "src/assets/favicon.ico", "src/assets/favicon.svg", "src/assets/favicon.png",
        "src/assets/logo.svg", "src/assets/logo.png",
        "src/assets/icon.svg", "src/assets/icon.png",
        "assets/favicon.png", "assets/logo.png", "assets/logo.svg", "assets/icon.png",
        "resources/icon.png", "build/icon.png",
        "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png",
    ];
    CANDIDATES.iter().find_map(|rel| read_icon(&base.join(rel)))
}

/// Scour a project directory for a favicon / logo we can show as its sidebar
/// glyph. Checks the conventional spots at the repo root, then — for monorepos
/// that keep the web app in a subdirectory (e.g. `01_frontend/`, `frontend/`,
/// `apps/web`) — one shallow level of subdirs, frontend-ish names first. This
/// finds a nested `01_frontend/public/favicon.ico` without a deep filesystem walk.
#[tauri::command]
fn find_project_icon(dir: String) -> Option<ProjectIcon> {
    let base = std::path::Path::new(&dir);
    if !base.is_dir() {
        return None;
    }
    // Fast path: conventional spots at the repo root.
    if let Some(hit) = probe_icon_dir(base) {
        return Some(hit);
    }
    // Fallback: probe immediate subdirectories, skipping heavy / build output dirs.
    let mut subs: Vec<std::path::PathBuf> = std::fs::read_dir(base)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            !name.starts_with('.')
                && !matches!(
                    name,
                    "node_modules" | "target" | "dist" | "build" | "out"
                        | "vendor" | "coverage" | "tmp" | "__pycache__"
                )
        })
        .collect();
    // Prefer frontend-ish directories, then fall back to alphabetical order so the
    // choice is deterministic (e.g. `01_frontend` before `02_backend`).
    subs.sort_by_key(|p| {
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let frontendish = ["front", "web", "client", "app", "ui", "site", "www"]
            .iter()
            .any(|k| name.contains(k));
        (!frontendish, name)
    });
    subs.iter().find_map(|p| probe_icon_dir(p))
}

/// Load a user-picked image as a project's logo. Deliberately runs the same
/// sniff/size gate as discovery (`read_icon`), so a file that isn't really an
/// image — or one too big to sit in localStorage as a data-URI — is rejected here
/// instead of becoming a broken `<img>` in the sidebar.
#[tauri::command]
fn read_custom_icon(path: String) -> Result<ProjectIcon, String> {
    read_icon(std::path::Path::new(&path))
        .ok_or_else(|| "Not a usable image (PNG, SVG, ICO, JPEG, WEBP or GIF, max 512 KB)".to_string())
}

// ---------- external (non-Muster) Claude Code sessions ----------
//
// Claude Code writes a per-process registry file at
// `~/.claude/sessions/<pid>.json` for every running interactive session, e.g.
//   {"pid":80629,"sessionId":"…","cwd":"/…","name":"repo-a3","status":"idle",…}
// Muster's own sessions DO register here too (verified on CC 2.1.211), so we
// filter them out by pid — see `owned_pids` and the ancestry walk in
// `list_external_sessions`. We must NOT filter by session id alone: /resume and
// /clear rewrite this file with a new id, which would otherwise resurface our
// own live session as "external". What remains is the sessions started outside
// Muster (a plain terminal, an IDE, etc.) — we jump to their terminal window and
// show a read-only mirror of their transcript.
//
// The registry format and directory are identical on Windows (verified on CC
// 2.1.216: `%USERPROFILE%\.claude\sessions\<pid>.json`, VS Code-hosted sessions
// included), so LISTING is fully cross-platform: liveness/ownership checks go
// through `ProcTable`, an in-process `sysinfo` snapshot that works the same on
// macOS, Windows and Linux. Only `focus_external_session` (jumping to the
// owning terminal window) remains platform-specific — macOS-only today.

#[derive(serde::Serialize)]
struct ExternalSession {
    pid: u32,
    session_id: String,
    cwd: String,
    name: String,
    status: String,
    status_updated_at: Option<i64>,
    started_at: Option<i64>,
    version: String,
    /// Main worktree root of this session's repo — the key the sidebar groups by, so
    /// every worktree of one repo lands under it. None when cwd isn't a git repo.
    repo_root: Option<String>,
    /// Branch checked out in this session's cwd (None when detached / not a repo).
    branch: Option<String>,
}

/// One `ps -o <fields>=` line for a single pid (trimmed), or None if the process
/// is gone / no output. Windows has no `ps`; the remaining `ps` consumers
/// (per-session CPU/RAM, terminal-window focus) are macOS-only for now, so this
/// is None there. External-session listing does NOT go through here — it uses
/// the cross-platform `ProcTable` below.
#[cfg(windows)]
fn ps_one(_pid: u32, _fields: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
fn ps_one(pid: u32, fields: &str) -> Option<String> {
    let out = sys_command("ps")
        .args(["-p", &pid.to_string(), "-o", fields])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// A point-in-time snapshot of the system process table (pid → parent + name),
/// taken in-process via `sysinfo` so the exact same code serves macOS, Windows
/// and Linux — no `ps`/`tasklist` child processes. The frontend polls external
/// sessions every ~3s; refreshing only the bare process list (no CPU/memory/
/// exe/cmd lookups) keeps a snapshot to a few milliseconds.
struct ProcTable {
    /// pid → (ppid, lowercased process name)
    procs: std::collections::HashMap<u32, (Option<u32>, String)>,
}

impl ProcTable {
    fn snapshot() -> Self {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let procs = sys
            .processes()
            .iter()
            .map(|(pid, p)| {
                (
                    pid.as_u32(),
                    (p.parent().map(|pp| pp.as_u32()), p.name().to_string_lossy().to_lowercase()),
                )
            })
            .collect();
        Self { procs }
    }

    /// True if `pid` is currently a live process whose name contains "claude" —
    /// the identity check that guards against stale registry files and pid
    /// reuse. Matched loosely because the name varies: `claude` on macOS/Linux,
    /// `claude.exe` on Windows, and self-update renames like
    /// `claude.exe.old.<ts>` for a binary updated while running.
    fn is_live_claude(&self, pid: u32) -> bool {
        self.procs.get(&pid).is_some_and(|(_, name)| name.contains("claude"))
    }

    /// True if `pid` is `ancestor`, or a descendant of it (walks the ppid chain).
    /// Used to recognise `claude` processes Muster launched — directly (embedded
    /// PTY) or via a child terminal (e.g. Ghostty) — regardless of their session
    /// id. The iteration cap also bounds ppid cycles, which Windows can produce
    /// after pid reuse (a dead parent's pid handed to a new process).
    fn is_descendant_of(&self, pid: u32, ancestor: u32) -> bool {
        let mut cur = pid;
        for _ in 0..24 {
            if cur == ancestor {
                return true;
            }
            match self.procs.get(&cur).and_then(|(ppid, _)| *ppid) {
                Some(ppid) if ppid > 1 && ppid != cur => cur = ppid,
                _ => return false,
            }
        }
        false
    }
}

/// Parse one `~/.claude/sessions/<pid>.json` registry file into an
/// `ExternalSession` (repo_root/branch enriched later). None for malformed
/// files and non-interactive entries (`claude -p`, SDK runs).
fn parse_registry_entry(txt: &str) -> Option<ExternalSession> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    if v.get("kind").and_then(|k| k.as_str()) != Some("interactive") {
        return None;
    }
    let pid = v.get("pid").and_then(|x| x.as_u64())? as u32;
    let session_id = v.get("sessionId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if session_id.is_empty() {
        return None;
    }
    Some(ExternalSession {
        pid,
        session_id,
        cwd: v.get("cwd").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        name: v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        status: v.get("status").and_then(|x| x.as_str()).unwrap_or("idle").to_string(),
        status_updated_at: v.get("statusUpdatedAt").and_then(|x| x.as_i64()),
        started_at: v.get("startedAt").and_then(|x| x.as_i64()),
        version: v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        repo_root: None,
        branch: None,
    })
}

/// List interactive Claude Code sessions running OUTSIDE Muster. `exclude` is the
/// set of session ids Muster already owns (belt-and-suspenders — ours don't
/// register anyway). Dead/stale registry files are filtered by verifying the pid
/// is still a live `claude` process.
#[tauri::command]
fn list_external_sessions(state: State<AppState>, exclude: Vec<String>) -> Vec<ExternalSession> {
    let home = home_dir();
    if home.is_empty() {
        return vec![];
    }
    let dir = std::path::Path::new(&home).join(".claude").join("sessions");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let exclude: std::collections::HashSet<String> =
        exclude.into_iter().map(|s| s.to_lowercase()).collect();

    let mut parsed: Vec<ExternalSession> = entries
        .flatten()
        .map(|ent| ent.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|txt| parse_registry_entry(&txt))
        .filter(|s| !exclude.contains(&s.session_id.to_lowercase()))
        .collect();
    if parsed.is_empty() {
        return parsed;
    }

    // Liveness + identity: one process-table snapshot for all pids; keep those
    // still running `claude` (guards against stale files and pid reuse).
    let table = ProcTable::snapshot();
    parsed.retain(|s| table.is_live_claude(s.pid));

    // Drop Muster's OWN sessions, matched by pid — NOT by session id. Their id on
    // disk changes when the user runs /resume or /clear (the pid file is rewritten
    // with the new id), so a session-id exclude alone lets a live, Muster-owned
    // session resurface here as "external". The pid is stable for the process'
    // lifetime. `owned_pids` covers embedded PTYs directly; the ancestry walk also
    // catches sessions launched into a child terminal (e.g. Ghostty).
    let self_pid = std::process::id();
    let owned = state.owned_pids.lock().unwrap().clone();
    parsed.retain(|s| !owned.contains(&s.pid) && !table.is_descendant_of(s.pid, self_pid));

    // Enrich survivors with their repo root + branch so worktrees of one repo group
    // together (and merge into that repo's project) rather than each cwd becoming its
    // own top-level entry. After the filters, so no git runs on stale or owned pids.
    for s in parsed.iter_mut() {
        let (root, branch) = git_repo_info(&s.cwd);
        s.repo_root = root;
        s.branch = branch;
    }

    // most-recently-active first
    parsed.sort_by(|a, b| b.status_updated_at.unwrap_or(0).cmp(&a.status_updated_at.unwrap_or(0)));
    parsed
}

/// Walk up the process tree from `pid` to the owning GUI terminal app.
/// Returns (app_pid, app_exe_path) — e.g. (719, "/…/Terminal.app/Contents/MacOS/Terminal").
#[cfg(not(windows))]
fn owning_terminal(pid: u32) -> Option<(u32, String)> {
    let mut cur = pid;
    for _ in 0..16 {
        let line = ps_one(cur, "ppid=,comm=")?;
        let line = line.trim();
        let mut it = line.splitn(2, char::is_whitespace);
        let ppid = it.next()?.trim().parse::<u32>().ok()?;
        let comm = it.next().unwrap_or("").trim().to_string();
        if comm.contains(".app/Contents/MacOS/") {
            return Some((cur, comm));
        }
        if ppid <= 1 {
            return None;
        }
        cur = ppid;
    }
    None
}

/// External-session surfacing (and thus focusing) is macOS-only for now.
#[cfg(windows)]
#[tauri::command]
fn focus_external_session(_pid: u32) -> Result<(), String> {
    Err("focusing external sessions isn't supported on Windows yet".to_string())
}

/// Bring the terminal window/tab hosting an external session to the front.
/// Exact tab focus for Terminal.app + iTerm2 (matched by tty); best-effort app
/// activation for anything else.
#[cfg(not(windows))]
#[tauri::command]
fn focus_external_session(pid: u32) -> Result<(), String> {
    let tty = ps_one(pid, "tty=").unwrap_or_default().trim().to_string();
    let (_app_pid, app_exe) =
        owning_terminal(pid).ok_or_else(|| "couldn't find the terminal window for this session".to_string())?;
    let lower = app_exe.to_lowercase();

    let script = if lower.contains("terminal.app") {
        format!(
            "tell application \"Terminal\"\n  activate\n  repeat with w in windows\n    repeat with t in tabs of w\n      try\n        if tty of t is \"/dev/{tty}\" then\n          set selected of t to true\n          set index of w to 1\n          set frontmost of w to true\n          return \"ok\"\n        end if\n      end try\n    end repeat\n  end repeat\nend tell"
        )
    } else if lower.contains("iterm") {
        format!(
            "tell application \"iTerm2\"\n  activate\n  repeat with w in windows\n    repeat with t in tabs of w\n      repeat with s in sessions of t\n        try\n          if tty of s ends with \"{tty}\" then\n            select t\n            select w\n            return \"ok\"\n          end if\n        end try\n      end repeat\n    end repeat\n  end repeat\nend tell"
        )
    } else {
        // Generic (VS Code, Warp, Ghostty, …): we can't address an individual
        // tab/pane by tty via AppleScript, and Electron apps run the shell under a
        // *helper* process that isn't in System Events' process list — targeting it
        // by unix id fails with -1719. So just bring the owning app to the front by
        // opening its top-level .app bundle (the first `.app` in the exe path).
        let app_bundle = app_exe
            .split_once(".app/")
            .map(|(head, _)| format!("{head}.app"))
            .unwrap_or_else(|| app_exe.clone());
        let out = std::process::Command::new("open")
            .arg(&app_bundle)
            .output()
            .map_err(|e| format!("open: {e}"))?;
        return if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        };
    };

    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct TranscriptMsg {
    role: String,
    text: String,
}

/// Claude stores a project's transcripts under `~/.claude/projects/<enc>/`, where
/// `<enc>` is the cwd with every non-ASCII-alphanumeric char replaced by `-`.
fn project_transcript_dir(cwd: &str) -> Option<std::path::PathBuf> {
    let home = home_dir();
    if home.is_empty() {
        return None;
    }
    let enc: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(std::path::Path::new(&home).join(".claude").join("projects").join(enc))
}

/// A finished (or at least not-currently-owned) session found on disk, offered to
/// the user as restorable via `claude --resume <id>`.
#[derive(serde::Serialize)]
struct PastSession {
    session_id: String,
    title: String,
    last_prompt: String,
    mtime: u64,
}

/// Enumerate the transcripts Claude has written for `workdir`, newest first, so
/// the frontend can label restorable sessions with something human-readable.
///
/// Titles come from the `ai-title` record Claude maintains; it is rewritten as the
/// session evolves, so the LAST occurrence wins. That record type is internal to
/// Claude Code and documented as unstable across releases, hence the fallback
/// chain: `ai-title` → `last-prompt` → first user message → "" (caller labels it).
/// Only the tail is scanned — `ai-title` recurs throughout the file, so a bounded
/// read reliably catches the latest one without paying for a 4MB transcript.
#[tauri::command]
fn list_past_sessions(workdir: String) -> Result<Vec<PastSession>, String> {
    let dir = match project_transcript_dir(&workdir) {
        Some(d) => d,
        None => return Err("no home directory".to_string()),
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]), // project never had a session — not an error
    };

    let mut out: Vec<PastSession> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let (title, last_prompt) = match transcript_meta(&path) {
            Some(m) => m,
            None => continue,
        };
        out.push(PastSession { session_id, title, last_prompt, mtime });
    }

    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

/// Pull `(title, last_prompt)` out of one transcript. Split out of
/// `list_past_sessions` so it can be tested against a fixture file without
/// touching `$HOME` (which the parallel test threads share).
fn transcript_meta(path: &std::path::Path) -> Option<(String, String)> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    const CAP: u64 = 512 * 1024;
    let mut reader = BufReader::new(file);
    if len > CAP {
        reader.seek(SeekFrom::Start(len - CAP)).ok()?;
        let mut discard = String::new(); // drop the partial first line
        let _ = reader.read_line(&mut discard);
    }

    let (mut title, mut last_prompt, mut first_user) = (String::new(), String::new(), String::new());
    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
            // Both records recur through the file and are rewritten as the session
            // evolves — the LAST occurrence is the current one, so keep overwriting.
            "ai-title" => {
                if let Some(s) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    title = s.trim().to_string();
                }
            }
            "last-prompt" => {
                if let Some(s) = v.get("lastPrompt").and_then(|x| x.as_str()) {
                    last_prompt = s.trim().to_string();
                }
            }
            "user" if first_user.is_empty() => {
                if let Some(serde_json::Value::String(s)) =
                    v.get("message").and_then(|m| m.get("content"))
                {
                    first_user = s.trim().chars().take(200).collect();
                }
            }
            _ => {}
        }
    }
    if title.is_empty() {
        title = if !last_prompt.is_empty() { last_prompt.clone() } else { first_user };
    }
    if title.chars().count() > 120 {
        title = title.chars().take(120).collect::<String>() + "…";
    }
    Some((title, last_prompt))
}

/// The three model tiers collapsed to a family (matches the frontend's `modelFamily`).
fn model_family(model: &str) -> &'static str {
    let s = model.to_ascii_lowercase();
    if s.contains("opus") {
        "opus"
    } else if s.contains("sonnet") {
        "sonnet"
    } else if s.contains("haiku") {
        "haiku"
    } else {
        "other"
    }
}

/// One assistant message's usage, pulled from a transcript line.
struct LineUsage {
    day: String,           // YYYY-MM-DD from the line's own ISO timestamp (UTC)
    tokens: [u64; 4],      // [input, output, cache_read, cache_write]
    family: &'static str,  // opus | sonnet | haiku | other
    project: String,       // basename of the line's cwd ("by working directory")
}

/// Parse one transcript line into a `LineUsage`, or `None` for the many lines with no
/// assistant `usage` record (user turns, tool results, meta). Split out of the scan so
/// the load-bearing, format-dependent parsing can be tested without a `$HOME` the
/// parallel tests share.
fn parse_usage_line(line: &str) -> Option<LineUsage> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let usage = v
        .get("message")
        .and_then(|m| m.get("usage"))
        .or_else(|| v.get("usage"))?;
    let day = match v.get("timestamp").and_then(|t| t.as_str()) {
        Some(ts) if ts.len() >= 10 => ts[..10].to_string(),
        _ => return None,
    };
    let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let model = v
        .get("message")
        .and_then(|m| m.get("model"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let project = v
        .get("cwd")
        .and_then(|x| x.as_str())
        .and_then(|c| c.rsplit(|ch: char| ch == '/' || ch == '\\').find(|s| !s.is_empty()))
        .unwrap_or("unknown")
        .to_string();
    Some(LineUsage {
        day,
        tokens: [
            g("input_tokens"),
            g("output_tokens"),
            g("cache_read_input_tokens"),
            g("cache_creation_input_tokens"),
        ],
        family: model_family(model),
        project,
    })
}

/// One calendar day, aggregated across every transcript: token totals by type, token
/// totals by model family, the number of distinct sessions active, and per-project
/// token totals ("by working directory"). Everything except the daily $ total (which
/// lives in the telemetry rollup and can't be recovered from transcripts) is here.
#[derive(serde::Serialize, Default)]
struct DayUsage {
    day: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    opus: u64,
    sonnet: u64,
    haiku: u64,
    other: u64,
    sessions: u64,
    projects: std::collections::BTreeMap<String, u64>,
}

/// Aggregate transcript usage per calendar day across every Claude Code transcript
/// touched within the last `days` days — tokens (by type and by model family), the
/// count of distinct sessions active, and per-project token totals.
///
/// Tokens et al. are the figures the statusLine never reports (it carries only
/// context-window *occupancy* and a $ total), so they're recovered from each assistant
/// message's own `usage` record. That record shape is internal to Claude Code and
/// documented as unstable (the risk `list_past_sessions` already lives with), hence
/// the defensive parsing and the cheap `contains("\"usage\"")` pre-filter that skips
/// the many lines carrying no tokens.
///
/// This is the heavy path: it reads whole transcripts, so the frontend calls it off
/// the render path and caches the result. The mtime filter skips transcripts not
/// written within the window — an old, untouched file cannot hold an in-range day —
/// which keeps a full year's scan bounded to recent work. All of the model / project /
/// session breakdown rides on this one pass; it adds no extra file reads.
#[tauri::command]
async fn token_usage_by_day(days: u64) -> Result<Vec<DayUsage>, String> {
    // The scan reads whole transcripts (the recent corpus can run to ~1GB), so hand
    // it to a blocking thread. A *synchronous* command runs on the main thread and
    // would freeze the entire UI for the length of the first, uncached scan.
    tauri::async_runtime::spawn_blocking(move || scan_usage(days))
        .await
        .map_err(|e| e.to_string())?
}

fn scan_usage(days: u64) -> Result<Vec<DayUsage>, String> {
    use std::collections::{HashMap, HashSet};
    use std::io::{BufRead, BufReader};
    let home = home_dir();
    if home.is_empty() {
        return Err("no home directory".to_string());
    }
    let root = std::path::Path::new(&home).join(".claude").join("projects");
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(days.saturating_mul(86_400)));

    let mut acc: HashMap<String, DayUsage> = HashMap::new();
    let projects = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]), // no transcripts yet — not an error
    };
    for proj in projects.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let files = match std::fs::read_dir(&pdir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in files.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // Skip transcripts untouched within the window: they can't hold in-range days.
            if let (Some(cut), Ok(meta)) = (cutoff, entry.metadata()) {
                if meta.modified().map(|m| m < cut).unwrap_or(false) {
                    continue;
                }
            }
            let file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            // One file == one session; remember the days it touched to count it once each.
            let mut file_days: HashSet<String> = HashSet::new();
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                let Some(lu) = parse_usage_line(&line) else { continue };
                let LineUsage { day, tokens, family, project } = lu;
                let tot: u64 = tokens.iter().sum();
                let e = acc.entry(day.clone()).or_default();
                if e.day.is_empty() {
                    e.day = day.clone();
                }
                e.input += tokens[0];
                e.output += tokens[1];
                e.cache_read += tokens[2];
                e.cache_write += tokens[3];
                match family {
                    "opus" => e.opus += tot,
                    "sonnet" => e.sonnet += tot,
                    "haiku" => e.haiku += tot,
                    _ => e.other += tot,
                }
                *e.projects.entry(project).or_insert(0) += tot;
                file_days.insert(day);
            }
            for d in file_days {
                let e = acc.entry(d.clone()).or_default();
                if e.day.is_empty() {
                    e.day = d;
                }
                e.sessions += 1;
            }
        }
    }
    let mut out: Vec<DayUsage> = acc.into_values().collect();
    out.sort_by(|a, b| a.day.cmp(&b.day));
    Ok(out)
}

/// Read a read-only slice of an external session's transcript. The transcript
/// lives at `~/.claude/projects/<enc>/<session_id>.jsonl`, where `<enc>` is the
/// cwd with every non-alphanumeric char replaced by `-`. Only the tail (≤512KB)
/// is read; only human/assistant prose is extracted (tool calls, tool results and
/// thinking are dropped), and the last `limit` messages are returned.
#[tauri::command]
fn read_transcript(cwd: String, session_id: String, limit: usize) -> Result<Vec<TranscriptMsg>, String> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let path = project_transcript_dir(&cwd)
        .ok_or_else(|| "no home directory".to_string())?
        .join(format!("{session_id}.jsonl"));
    let file = std::fs::File::open(&path).map_err(|e| format!("transcript not found: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    const CAP: u64 = 512 * 1024;
    let mut reader = BufReader::new(file);
    if len > CAP {
        reader.seek(SeekFrom::Start(len - CAP)).map_err(|e| e.to_string())?;
        let mut discard = String::new(); // drop the partial first line
        let _ = reader.read_line(&mut discard);
    }

    let mut msgs: Vec<TranscriptMsg> = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t != "user" && t != "assistant" {
            continue;
        }
        let content = v.get("message").and_then(|m| m.get("content"));
        let mut text = String::new();
        match content {
            Some(serde_json::Value::String(s)) => text.push_str(s),
            Some(serde_json::Value::Array(arr)) => {
                // Only "text" blocks: tool calls (Bash, Read, Edit, …), tool_result
                // echoes and thinking blocks are noise in a read-only conversation
                // mirror — keep the human/assistant prose. An assistant turn that is
                // only tool calls collapses to empty and is dropped below.
                for blk in arr {
                    if blk.get("type").and_then(|x| x.as_str()) == Some("text") {
                        if let Some(s) = blk.get("text").and_then(|x| x.as_str()) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(s);
                        }
                    }
                }
            }
            _ => {}
        }
        let mut text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if text.len() > 4000 {
            text.truncate(4000);
            text.push('…');
        }
        msgs.push(TranscriptMsg { role: t.to_string(), text });
    }
    let n = msgs.len();
    if n > limit {
        msgs = msgs.split_off(n - limit);
    }
    Ok(msgs)
}

// ---------- app quit ----------

/// Actually terminate the app. The Cmd+Q accelerator is bound to our own menu
/// item (see the app menu in `run`), which asks the frontend to confirm instead
/// of quitting; the frontend calls this once the user (or an empty session list)
/// has approved the quit. Kept as a command so the *only* immediate-exit paths
/// are this and the tray's "Quit Muster".
#[tauri::command]
fn confirm_quit(app: AppHandle) {
    app.exit(0);
}

// ---------- macOS menu-bar (tray) ----------

#[derive(serde::Deserialize)]
struct TrayItem {
    id: String,
    label: String,
}

/// Rebuild the tray menu to mirror the sidebar: one clickable row per session
/// (with its status), plus Show / Quit. `title` is the short text shown next to
/// the menu-bar icon (macOS); `tooltip` is the hover text.
#[tauri::command]
fn update_tray(
    app: AppHandle,
    title: String,
    tooltip: String,
    items: Vec<TrayItem>,
) -> Result<(), String> {
    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return Ok(()),
    };
    let mut mb = MenuBuilder::new(&app);
    if items.is_empty() {
        mb = mb.text("none", "No active sessions");
    } else {
        for it in &items {
            mb = mb.text(it.id.clone(), it.label.clone());
        }
    }
    let menu = mb
        .separator()
        .text("show", "Show Muster")
        // Keep this trio in sync with the initial menu built in `run()` — this
        // command *replaces* the whole menu, so anything missing here vanishes the
        // moment the frontend first renders.
        .text("check-updates", "Check for Updates…")
        .separator()
        .text("quit", "Quit Muster")
        .build()
        .map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    let _ = tray.set_tooltip(Some(&tooltip));
    // macOS-only: text label rendered next to the menu-bar icon.
    let _ = tray.set_title(Some(&title));
    Ok(())
}

/// Log every panic — message, location, thread, backtrace — before the process
/// dies. A panic that unwinds out of `main` terminates a GUI app *cleanly* as far
/// as the OS is concerned: no crash dump, no WER/CrashReporter entry, the window
/// just vanishes. This hook is the only on-disk trace of that failure class. It
/// writes through the `log` facade (→ the rolling muster.log) AND appends raw to
/// `panic.log` in the same directory, in case the logger itself is what broke.
fn install_panic_hook(log_dir: std::path::PathBuf) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current();
        let msg = format!(
            "panic on thread '{}': {info}\n{backtrace}",
            thread.name().unwrap_or("<unnamed>")
        );
        log::error!("{msg}");
        let _ = std::fs::create_dir_all(&log_dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("panic.log"))
        {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[unix {secs}] {msg}\n");
        }
        prev(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("muster".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Windows analog of the macOS Cmd+Q catcher in `setup` below: Windows gets
        // no app menu (see there), so quitting means closing the window. Intercept
        // the close and run the same frontend confirm flow — only `confirm_quit`
        // actually exits, and the frontend calls it straight away when idle.
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("quit-requested", ());
            }
            #[cfg(not(windows))]
            let _ = (window, event);
        })
        .setup(|app| {
            // Before anything that can panic: from here on, panics leave a trace.
            install_panic_hook(app.path().app_log_dir()?);
            log::info!("muster v{} starting", app.package_info().version);

            let server = tiny_http::Server::http("127.0.0.1:0")
                .expect("bind telemetry server on 127.0.0.1");
            let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
            log::info!("telemetry server on 127.0.0.1:{port}");

            app.manage(AppState {
                port,
                sessions: Mutex::new(HashMap::new()),
                owned_pids: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                next_perm: std::sync::atomic::AtomicU64::new(1),
                caffeinate: Mutex::new(None),
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || run_telemetry_server(server, handle));

            // macOS menu-bar (tray) icon — its menu mirrors the sidebar and is
            // rebuilt from the frontend via `update_tray`.
            let tray_menu = MenuBuilder::new(app)
                .text("show", "Show Muster")
                .text("check-updates", "Check for Updates…")
                .separator()
                .text("quit", "Quit Muster")
                .build()?;
            // Monochrome `>_` glyph, rendered as a macOS template image so it
            // adapts to the light/dark menu bar. Falls back to the app icon.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate.png"))
                .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Muster")
                .menu(&tray_menu)
                // Double-click the icon → show the window. NOTE: on macOS the tray
                // crate never emits DoubleClick (it's Windows/Linux-only), so there
                // the "Show Muster" menu item is the reliable path; this handler
                // covers the other platforms.
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    let id = event.id().0.as_str();
                    match id {
                        "quit" => app.exit(0),
                        "show" | "none" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        // Must be matched before the `sid` arm below, which treats
                        // any unknown id as a session to select. The window is shown
                        // first because the check reports itself as a toast/chip in
                        // the UI — checking from a hidden window would look like a
                        // menu item that does nothing.
                        "check-updates" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("tray-check-updates", ());
                        }
                        // Cmd+Q is handled by the app menu's own quit item, but that
                        // MenuEvent also reaches this handler — every menu handler shares
                        // one global listener list — so swallow it here instead of letting
                        // it fall through to the session catch-all below.
                        "quit-confirm" => {}
                        sid => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("tray-select", sid.to_string());
                        }
                    }
                })
                .build(app)?;

            // ---- App menu with a Cmd+Q catcher (macOS only) ----
            // Cmd+Q is a "special Apple event" that Tauri does not reliably surface
            // as an app/window event on macOS (tauri-apps/tauri#9198), so
            // RunEvent::ExitRequested/prevent_exit can't be trusted to intercept it.
            // Instead we *own* the Quit item: binding our own menu item to Cmd+Q means
            // the keystroke fires `on_menu_event` (deterministic) rather than the OS
            // `terminate:`. The handler asks the frontend to confirm; only `confirm_quit`
            // actually exits. Replacing the default menu means we must re-add the Edit
            // submenu ourselves, or Cmd+C/X/V/Z/A stop working in the app's inputs.
            //
            // Never install this on Windows: `set_menu` would render it as an
            // in-window menu bar full of mac-only items — and muda's predefined
            // Hide item there does a raw Win32 ShowWindow(SW_HIDE) behind tao's
            // visibility flags, after which tao's show() no-ops and the window is
            // unrecoverable, tray "Show Muster" included (muda 0.19.3
            // windows/mod.rs:1217 vs tao 0.35.3 window_state.rs apply_diff).
            // Windows needs no menu at all: WebView2 handles the edit shortcuts
            // natively, and quitting goes through the CloseRequested hook on the
            // builder above.
            #[cfg(target_os = "macos")]
            {
                let quit_item = MenuItemBuilder::with_id("quit-confirm", "Quit Muster")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Muster")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .item(&quit_item)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .fullscreen()
                    .separator()
                    .close_window()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().0.as_str() == "quit-confirm" {
                        // Surface the window so the confirm dialog has context, then let the
                        // frontend decide (it quits straight away when nothing is running).
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        let _ = app.emit("quit-requested", ());
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_claude,
            write_pty,
            resize_pty,
            kill_session,
            git_branch,
            git_head,
            git_diffstat,
            git_diff,
            git_action,
            session_resources,
            create_worktree,
            set_caffeinate,
            resolve_permission,
            list_worktrees,
            remove_worktree,
            git_branch_list,
            spawn_ghostty,
            spawn_shell,
            available_terminals,
            spawn_external_terminal,
            open_terminal_here,
            list_external_sessions,
            focus_external_session,
            read_transcript,
            list_past_sessions,
            token_usage_by_day,
            find_project_icon,
            read_custom_icon,
            open_folder,
            write_debug_file,
            log_frontend,
            update_tray,
            confirm_quit
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // Record clean shutdowns: a log that ends WITHOUT one of these lines is an
        // abnormal termination — that alone answers "did it crash or was it quit?".
        .run(|_app, event| match event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                log::info!(
                    "exit requested{}",
                    code.map(|c| format!(" (code {c})")).unwrap_or_default()
                );
            }
            tauri::RunEvent::Exit => log::info!("exit · clean shutdown"),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    #[test]
    fn parse_usage_line_extracts_day_tokens_family_and_project() {
        let line = r#"{"type":"assistant","timestamp":"2026-07-21T10:00:00.000Z","cwd":"/Users/tim/dev/muster","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":300,"cache_creation_input_tokens":4}}}"#;
        let lu = parse_usage_line(line).expect("assistant usage line should parse");
        assert_eq!(lu.day, "2026-07-21");
        assert_eq!(lu.tokens, [10, 20, 300, 4]);
        assert_eq!(lu.family, "opus");
        assert_eq!(lu.project, "muster"); // basename of cwd
        // Missing token fields default to 0; unknown model → "other"; no cwd → "unknown".
        let partial = r#"{"timestamp":"2026-07-21T10:00:00Z","message":{"usage":{"output_tokens":7}}}"#;
        let lu = parse_usage_line(partial).expect("should parse");
        assert_eq!(lu.tokens, [0, 7, 0, 0]);
        assert_eq!(lu.family, "other");
        assert_eq!(lu.project, "unknown");
    }

    #[test]
    fn parse_usage_line_skips_lines_without_usage() {
        // The cheap pre-filter and the shape checks both reject non-usage lines.
        assert!(parse_usage_line(r#"{"type":"user","timestamp":"2026-07-21T10:00:00Z"}"#).is_none());
        assert!(parse_usage_line("not json at all").is_none());
        // A usage record with no timestamp can't be bucketed, so it's dropped.
        assert!(parse_usage_line(r#"{"message":{"usage":{"input_tokens":5}}}"#).is_none());
    }

    #[test]
    fn model_family_buckets_by_tier() {
        assert_eq!(model_family("claude-opus-4-8"), "opus");
        assert_eq!(model_family("claude-sonnet-4-5"), "sonnet");
        assert_eq!(model_family("claude-haiku-4-5-20251001"), "haiku");
        assert_eq!(model_family("some-future-model"), "other");
    }

    /// The one piece of the Windows keep-awake path that isn't a Win32 call: the
    /// translation of the UI's `caffeinate` flags into execution-state bits.
    #[cfg(windows)]
    #[test]
    fn caffeinate_flags_map_to_execution_state() {
        use windows_sys::Win32::System::Power::{ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
        let f = |args: &[&str]| execution_state_for(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());

        // Asking for the display implies the system stays powered too.
        assert_eq!(f(&["-d"]), ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        assert_eq!(f(&["-i"]), ES_SYSTEM_REQUIRED);
        assert_eq!(f(&["-dimsu"]), ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        // The timer preset: `-t` and its bare seconds argument assert nothing on
        // their own, and must not be mistaken for a flag cluster.
        assert_eq!(f(&["-di", "-t", "3600"]), ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        // Nothing translatable → 0, which the command reports as an error rather
        // than lighting the cup over a machine that will happily sleep.
        assert_eq!(f(&["-m"]), 0);
        assert_eq!(f(&[]), 0);
    }

    /// A fresh, empty scratch directory under the OS temp dir. No randomness (pid +
    /// an atomic counter keep it unique even under cargo's parallel test threads).
    fn scratch_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("muster_git_diff_test_{}_{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Run a git command in `dir`, asserting success. Identity/signing are passed via
    /// `-c` so the test doesn't depend on (or touch) the developer's global gitconfig.
    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").current_dir(dir).args(args).output().expect("failed to spawn git");
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn git_diff_reports_tracked_and_untracked_changes() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q"]);
        std::fs::write(dir.join("tracked.txt"), "line1\nline2\nline3\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

        // Working-tree changes: edit the tracked file, add an untracked one.
        std::fs::write(dir.join("tracked.txt"), "line1\nCHANGED\nline3\nline4\n").unwrap();
        std::fs::write(dir.join("new.txt"), "brand new\n").unwrap();

        let d = git_diff(dir.to_str().unwrap().to_string()).expect("git_diff returned None for a real repo");
        assert!(!d.truncated);
        // Tracked modification, diffed against HEAD.
        assert!(d.patch.contains("diff --git a/tracked.txt b/tracked.txt"), "missing tracked diff:\n{}", d.patch);
        assert!(d.patch.contains("+CHANGED") && d.patch.contains("-line2"));
        // Untracked file rendered as a new-file diff.
        assert!(d.patch.contains("diff --git a/new.txt b/new.txt"), "missing untracked diff:\n{}", d.patch);
        assert!(d.patch.contains("new file mode") && d.patch.contains("+brand new"));

        // Crucially, surfacing the untracked file must NOT have staged it — `--no-index`
        // leaves the index untouched, which is why we use it over `git add -N`.
        let st = Command::new("git").current_dir(&dir).args(["status", "--porcelain"]).output().unwrap();
        let st = String::from_utf8_lossy(&st.stdout);
        assert!(st.contains("?? new.txt"), "new.txt should still be untracked, got:\n{st}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_diff_returns_none_outside_a_repo() {
        let dir = scratch_dir();
        assert!(git_diff(dir.to_str().unwrap().to_string()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The picker leans on these flags to decide what's pickable: it hides `current`
    /// (the "start here" button) and `checked_out` (git refuses a second checkout, so
    /// those sit in the existing-worktrees list instead). ahead/behind must be
    /// oriented from the branch's point of view versus the current HEAD.
    #[test]
    fn git_branch_list_flags_state_and_orients_ahead_behind() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        git(&dir, &["branch", "test"]);
        git(&dir, &["branch", "feature-x"]);

        // feature-x gains 2 commits; dev then gains 1 → feature-x is 2 ahead, 1 behind.
        git(&dir, &["checkout", "-q", "feature-x"]);
        commit(&dir, "fx1");
        commit(&dir, "fx2");
        git(&dir, &["checkout", "-q", "dev"]);
        commit(&dir, "dev1");

        // Claim `test` with a worktree; `dev` is claimed by the main working tree.
        let wt = dir.join("wt-test");
        git(&dir, &["worktree", "add", "-q", wt.to_str().unwrap(), "test"]);

        let bs = git_branch_list(dir.to_str().unwrap().to_string());
        let by = |n: &str| bs.iter().find(|b| b.name == n).unwrap_or_else(|| panic!("{n} missing from {bs:?}"));

        // dev is `current`; it's also `checked_out` because the main working tree holds
        // it — the frontend hides it via `current`, so that overlap is harmless.
        assert!(by("dev").current, "dev should be current: {bs:?}");
        assert!(by("test").checked_out && !by("test").current, "test should be checked_out: {bs:?}");
        let fx = by("feature-x");
        assert!(!fx.current && !fx.checked_out, "feature-x should be free: {bs:?}");
        assert_eq!((fx.ahead, fx.behind), (2, 1), "feature-x should be 2 ahead / 1 behind dev: {bs:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The label says "New branch" but the field has always taken existing ones —
    /// that's the whole point of the picker, so pin the attach path down.
    #[test]
    fn create_worktree_attaches_an_existing_branch() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
        git(&dir, &["branch", "test"]);

        let path = create_worktree(dir.to_str().unwrap().to_string(), "test".into()).expect("attach failed");
        let head = Command::new("git").current_dir(&path).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "test");

        // The repo it was created from must be undisturbed — this is a second
        // checkout, not a branch switch.
        let orig = Command::new("git").current_dir(&dir).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&orig.stdout).trim(), "dev");

        // Worktrees land in a *sibling* .cc-worktrees tree, never inside the repo.
        let _ = std::fs::remove_dir_all(dir.parent().unwrap().join(".cc-worktrees"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The cleanup path: `list_worktrees` must flag which linked worktrees are safe
    /// to remove (merged, clean), and `remove_worktree_impl` must never force —
    /// safe-deleting a merged branch, keeping an unmerged one, and refusing a dirty
    /// tree with a `--force` handoff instead of clobbering it.
    #[test]
    fn worktree_cleanup_flags_and_safe_removal() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        let repo = dir.to_str().unwrap().to_string();

        // Three linked worktrees: one at dev's tip (merged, clean), one advanced past
        // dev (unmerged), and one with an untracked file (dirty).
        let merged = create_worktree(repo.clone(), "merged-wt".into()).expect("merged worktree");
        let ahead = create_worktree(repo.clone(), "ahead-wt".into()).expect("ahead worktree");
        commit(Path::new(&ahead), "extra");
        let dirty = create_worktree(repo.clone(), "dirty-wt".into()).expect("dirty worktree");
        std::fs::write(Path::new(&dirty).join("scratch.txt"), "wip\n").unwrap();

        let wts = list_worktrees(repo.clone());
        let by = |b: &str| wts.iter().find(|w| w.branch == b).unwrap_or_else(|| panic!("{b} missing from {wts:?}"));
        assert!(by("merged-wt").merged && !by("merged-wt").dirty, "merged-wt should be merged+clean: {wts:?}");
        assert!(!by("ahead-wt").merged && !by("ahead-wt").dirty, "ahead-wt should be unmerged+clean: {wts:?}");
        assert!(by("dirty-wt").dirty, "dirty-wt should be dirty: {wts:?}");
        let main_path = wts.iter().find(|w| w.is_main).expect("a main worktree").path.clone();

        // The main worktree can never be removed.
        assert!(remove_worktree_impl(&repo, &main_path, "dev", false).is_err(), "main worktree must be refused");

        // Merged + delete_branch: worktree gone, branch safe-deleted.
        let r = remove_worktree_impl(&repo, &merged, "merged-wt", true).expect("remove merged");
        assert!(r.ok, "merged removal should succeed: {r:?}");
        assert!(!Path::new(&merged).exists(), "merged worktree dir should be gone");
        let b = Command::new("git").current_dir(&dir).args(["branch", "--list", "merged-wt"]).output().unwrap();
        assert!(String::from_utf8_lossy(&b.stdout).trim().is_empty(), "merged branch should be deleted");

        // Unmerged + delete_branch: worktree gone, branch KEPT with a force handoff.
        let r = remove_worktree_impl(&repo, &ahead, "ahead-wt", true).expect("remove ahead");
        assert!(r.ok && r.suggest.as_deref().unwrap_or("").contains("branch -D"), "unmerged branch delete should be handed off: {r:?}");
        let b = Command::new("git").current_dir(&dir).args(["branch", "--list", "ahead-wt"]).output().unwrap();
        assert!(!String::from_utf8_lossy(&b.stdout).trim().is_empty(), "unmerged branch should be kept");

        // Dirty, no force: refused, tree untouched, force handoff offered.
        let r = remove_worktree_impl(&repo, &dirty, "dirty-wt", false).expect("call returns");
        assert!(!r.ok && r.suggest.as_deref().unwrap_or("").contains("--force"), "dirty removal should be refused with a force handoff: {r:?}");
        assert!(Path::new(&dirty).exists(), "dirty worktree must not be clobbered");

        let _ = std::fs::remove_dir_all(dir.parent().unwrap().join(".cc-worktrees"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `ai-title` and `last-prompt` are rewritten repeatedly as a session evolves,
    /// so the newest one at the end of the file has to win over the earlier ones.
    #[test]
    fn transcript_meta_takes_the_last_title_and_prompt() {
        let dir = scratch_dir();
        let path = dir.join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","message":{"content":"the very first thing I asked"}}"#, "\n",
                r#"{"type":"ai-title","aiTitle":"An early guess"}"#, "\n",
                r#"{"type":"last-prompt","lastPrompt":"an early prompt"}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#, "\n",
                r#"{"type":"ai-title","aiTitle":"What it settled on"}"#, "\n",
                r#"{"type":"last-prompt","lastPrompt":"the latest prompt"}"#, "\n",
            ),
        )
        .unwrap();
        let (title, last) = transcript_meta(&path).unwrap();
        assert_eq!(title, "What it settled on");
        assert_eq!(last, "the latest prompt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The record types are internal to Claude Code and documented as unstable, so a
    /// transcript without `ai-title` must still yield something human-readable.
    #[test]
    fn transcript_meta_falls_back_when_no_ai_title() {
        let dir = scratch_dir();

        // No ai-title → the last prompt stands in.
        let a = dir.join("a.jsonl");
        std::fs::write(
            &a,
            concat!(
                r#"{"type":"user","message":{"content":"opening message"}}"#, "\n",
                r#"{"type":"last-prompt","lastPrompt":"what I asked most recently"}"#, "\n",
            ),
        )
        .unwrap();
        assert_eq!(transcript_meta(&a).unwrap().0, "what I asked most recently");

        // Neither → the first user message stands in.
        let b = dir.join("b.jsonl");
        std::fs::write(&b, "{\"type\":\"user\",\"message\":{\"content\":\"opening message\"}}\n").unwrap();
        assert_eq!(transcript_meta(&b).unwrap().0, "opening message");

        // Garbage lines are skipped, not fatal — a torn write must not lose the title.
        let c = dir.join("c.jsonl");
        std::fs::write(
            &c,
            concat!("not json at all\n", r#"{"type":"ai-title","aiTitle":"Survived"}"#, "\n", "{\"truncated\":"),
        )
        .unwrap();
        assert_eq!(transcript_meta(&c).unwrap().0, "Survived");

        // An empty transcript yields an empty title (the frontend labels it).
        let d = dir.join("d.jsonl");
        std::fs::write(&d, "").unwrap();
        assert_eq!(transcript_meta(&d).unwrap().0, "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A transcript bigger than the 512KB tail cap must still surface the newest
    /// title — the whole point of scanning the tail rather than the head.
    #[test]
    fn transcript_meta_reads_the_tail_of_a_large_transcript() {
        let dir = scratch_dir();
        let path = dir.join("big.jsonl");
        let filler = format!(
            "{}\n",
            serde_json::json!({ "type": "assistant", "message": { "content": "x".repeat(4000) } })
        );
        let mut body = String::new();
        body.push_str(r#"{"type":"ai-title","aiTitle":"Stale head title"}"#);
        body.push('\n');
        while body.len() < 900 * 1024 {
            body.push_str(&filler);
        }
        body.push_str(r#"{"type":"ai-title","aiTitle":"Fresh tail title"}"#);
        body.push('\n');
        std::fs::write(&path, &body).unwrap();

        assert!(body.len() as u64 > 512 * 1024, "fixture must exceed the tail cap");
        assert_eq!(transcript_meta(&path).unwrap().0, "Fresh tail title");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn table(entries: &[(u32, Option<u32>, &str)]) -> ProcTable {
        ProcTable {
            procs: entries.iter().map(|&(pid, ppid, name)| (pid, (ppid, name.to_string()))).collect(),
        }
    }

    #[test]
    fn proc_table_identity_and_ancestry() {
        // muster(100) → ghostty(200) → claude(300); unrelated claude(400) under init.
        let t = table(&[
            (100, Some(1), "muster"),
            (200, Some(100), "ghostty"),
            (300, Some(200), "claude"),
            (400, Some(1), "claude.exe"),
        ]);
        assert!(t.is_descendant_of(300, 100), "grandchild via child terminal");
        assert!(t.is_descendant_of(100, 100), "a pid is its own ancestor");
        assert!(!t.is_descendant_of(400, 100), "unrelated session must stay external");
        assert!(t.is_live_claude(300));
        assert!(t.is_live_claude(400), "windows .exe name still matches");
        assert!(!t.is_live_claude(200), "live but not claude");
        assert!(!t.is_live_claude(999), "dead pid");
    }

    #[test]
    fn proc_table_ancestry_survives_ppid_cycles() {
        // Windows pid reuse can produce ppid cycles; the walk must terminate.
        let t = table(&[(10, Some(20), "a"), (20, Some(10), "b")]);
        assert!(!t.is_descendant_of(10, 99));
    }

    #[test]
    fn proc_table_snapshot_sees_this_process() {
        // Real sysinfo snapshot on whatever OS runs the tests: our own pid must
        // be present and count as its own descendant.
        let t = ProcTable::snapshot();
        let me = std::process::id();
        assert!(t.procs.contains_key(&me), "own pid missing from process snapshot");
        assert!(t.is_descendant_of(me, me));
    }

    #[test]
    fn parse_registry_entry_accepts_interactive_rejects_rest() {
        // Shape verified against a real CC 2.1.216 registry file on Windows;
        // the keys are identical on macOS.
        let win = r#"{"pid":41708,"sessionId":"20283E01-6874-4FBB-B696-C29A89F13CC6","cwd":"E:\\Programming\\Work\\Respeak\\muster","startedAt":1784613714619,"procStart":"639202177128968910","version":"2.1.216","peerProtocol":1,"kind":"interactive","entrypoint":"cli","name":"muster-15","nameSource":"derived","status":"busy","updatedAt":1784614124255,"statusUpdatedAt":1784614124255}"#;
        let s = parse_registry_entry(win).expect("interactive entry should parse");
        assert_eq!(s.pid, 41708);
        assert_eq!(s.cwd, r"E:\Programming\Work\Respeak\muster");
        assert_eq!(s.status, "busy");
        assert_eq!(s.status_updated_at, Some(1784614124255));

        // Non-interactive (`claude -p`, SDK) and malformed entries are skipped.
        assert!(parse_registry_entry(r#"{"pid":1,"sessionId":"x","kind":"print"}"#).is_none());
        assert!(parse_registry_entry(r#"{"sessionId":"x","kind":"interactive"}"#).is_none());
        assert!(parse_registry_entry("not json").is_none());
    }
}
