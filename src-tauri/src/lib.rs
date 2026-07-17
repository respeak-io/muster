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
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// OS pid of the spawned `claude` (embedded PTY only). Used to exclude our
    /// own sessions from `list_external_sessions` by pid rather than session id.
    pid: Option<u32>,
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
        let mut data: serde_json::Value =
            serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
        if let Some(sid) = &stable_sid {
            if !data.is_object() {
                data = serde_json::json!({});
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

/// Per-session settings file layered on top of the user's ~/.claude via
/// `claude --settings`. Absolute /usr/bin/curl + /bin/cat because Claude runs
/// hooks/statusline with a stripped PATH.
fn write_instrument_settings(port: u16, session_id: &str) -> std::io::Result<String> {
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir)?;

    // Tag every POST with Muster's STABLE launch id via an `X-CC-Session` header,
    // so telemetry keeps routing to the right pane even after Claude rotates its own
    // runtime session_id (/clear, /compact, /resume all mint a new one). The id is
    // baked into the generated command — no dependence on env propagation.
    let statusline_cmd = format!(
        "i=$(/bin/cat); printf '%s' \"$i\" | /usr/bin/curl -s --max-time 1 -X POST 'http://127.0.0.1:{port}/statusline' -H 'X-CC-Session: {session_id}' --data-binary @- >/dev/null 2>&1; printf 'cc-launcher'"
    );
    let hook_cmd = format!(
        "/usr/bin/curl -s --max-time 2 -X POST 'http://127.0.0.1:{port}/hook' -H 'X-CC-Session: {session_id}' --data-binary @- >/dev/null 2>&1 || true"
    );

    let events = [
        "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
        "PostToolUseFailure", "Notification", "Stop", "StopFailure", "SubagentStart",
        "SubagentStop",
    ];
    let mut hooks = serde_json::Map::new();
    for ev in events {
        hooks.insert(
            ev.to_string(),
            serde_json::json!([
                { "matcher": "", "hooks": [ { "type": "command", "command": hook_cmd, "async": true, "timeout": 5 } ] }
            ]),
        );
    }
    // PermissionRequest is a BLOCKING http hook — Claude waits for the app's decision.
    hooks.insert(
        "PermissionRequest".to_string(),
        serde_json::json!([
            { "matcher": "", "hooks": [ { "type": "http", "url": format!("http://127.0.0.1:{port}/permission?sid={session_id}"), "timeout": 600 } ] }
        ]),
    );

    let settings = serde_json::json!({
        "statusLine": { "type": "command", "command": statusline_cmd, "refreshInterval": 3, "padding": 0 },
        "hooks": hooks
    });

    let path = dir.join(format!("instrument-{session_id}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&settings)?)?;
    Ok(path.to_string_lossy().to_string())
}

/// Resolve the absolute path to the `claude` binary. GUI apps launched from
/// Finder get a stripped PATH, so we check common install locations and fall
/// back to the user's login shell.
fn resolve_claude() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
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
    if let Ok(o) = std::process::Command::new(&shell).args(["-lic", "command -v claude"]).output() {
        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "claude".to_string()
}

/// A PATH that includes the usual per-user bin dirs, so the spawned `claude`
/// (and anything it shells out to) is found even under Finder's stripped PATH.
fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let base = std::env::var("PATH").unwrap_or_default();
    format!("{home}/.local/bin:{home}/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{base}")
}

/// Force a UTF-8 locale on a PTY child. A macOS app launched from Finder inherits no
/// `LANG`, so the child falls back to the C/POSIX locale and mangles non-ASCII output
/// (UTF-8 rendered as Mac Roman — `ü`→`√º`, emoji shredded). Terminal.app/iTerm set a
/// UTF-8 locale on startup; mirror that. Preserve an already-UTF-8 `LANG` (e.g. Muster
/// launched from a terminal), else default one; and pin `LC_CTYPE` so an inherited
/// `LC_CTYPE=C` can't re-break the charset behind a good `LANG`.
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
) -> Result<(), String> {
    let port = state.port;
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let claude = resolve_claude();
    let mut cmd = CommandBuilder::new(&claude);
    cmd.arg("--session-id");
    cmd.arg(&session_id);
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
        Session { master: pair.master, writer, killer, pid: child_pid },
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
        if let Some(st) = app.try_state::<AppState>() {
            st.sessions.lock().unwrap().remove(&session_id);
            if let Some(p) = child_pid {
                st.owned_pids.lock().unwrap().remove(&p);
            }
        }
        let _ = app.emit("pty-exit", serde_json::json!({ "sessionId": session_id, "code": code }));
    });
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

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // login shell, so the user's normal prompt/aliases load
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
        Session { master: pair.master, writer, killer, pid: child_pid },
    );
    stream_pty_session(app, session_id, reader, child, child_pid);
    Ok(())
}

fn find_ghostty() -> Option<String> {
    if let Ok(o) = std::process::Command::new("which").arg("ghostty").output() {
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
) -> Result<(), String> {
    let port = state.port;
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
    cmd.arg("--session-id");
    cmd.arg(&session_id);
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
/// (The embedded terminal is always available and isn't listed here.)
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
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Launch an instrumented `claude` session in a generic external terminal app
/// (Terminal.app / iTerm2). We write an executable `.command` wrapper that sets
/// up PATH, cd's into the workdir and execs claude, then hand it to `open -a`.
/// Telemetry still flows via the per-session settings hooks, so the session shows
/// up in Muster's cockpit just like an embedded/Ghostty one.
#[tauri::command]
fn spawn_external_terminal(
    state: State<AppState>,
    session_id: String,
    workdir: String,
    engine: String,
    title: String,
) -> Result<(), String> {
    let port = state.port;
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;
    let claude = resolve_claude();

    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join(format!("run-{session_id}.command"));

    let body = format!(
        "#!/bin/zsh\n# Muster session: {title}\nexport PATH={path}\ncd {wd} || exit 1\nexec {claude} --session-id {sid} --settings {settings}\n",
        title = title.replace(['\n', '\r'], " "),
        path = sh_quote(&augmented_path()),
        wd = sh_quote(&workdir),
        claude = sh_quote(&claude),
        sid = sh_quote(&session_id),
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

/// Open a plain (non-Claude) shell in an external terminal at `workdir` — a quick
/// scratch terminal for running commands next to a session. There's no
/// instrumentation here: it's just a shell, so it does NOT appear in Muster's
/// cockpit. `engine` is a hint (the user's chosen launch engine); embedded has no
/// external window, so it falls back to Terminal.app.
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
        let _ = s.killer.kill();
        if let Some(p) = s.pid {
            state.owned_pids.lock().unwrap().remove(&p);
        }
    }
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
        std::process::Command::new("git")
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

#[derive(serde::Serialize)]
struct Worktree {
    path: String,
    branch: String,
    is_main: bool,
}

/// List the git worktrees for a repo (parsed from `git worktree list --porcelain`).
/// The first entry is the main working tree.
#[tauri::command]
fn list_worktrees(repo_dir: String) -> Vec<Worktree> {
    let out = std::process::Command::new("git")
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
            res.push(Worktree { path, branch, is_main });
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
    res
}

/// Current git branch for a working directory (None if not a repo / detached).
#[tauri::command]
fn git_branch(workdir: String) -> Option<String> {
    let out = std::process::Command::new("git")
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
        std::process::Command::new("git")
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
        std::process::Command::new("git")
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
    Some(DiffStat { added, removed, files, untracked, dirty })
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
}

/// One `ps -o <fields>=` line for a single pid (trimmed), or None if the process
/// is gone / no output.
fn ps_one(pid: u32, fields: &str) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", fields])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// True if `pid` is `ancestor`, or a descendant of it (walks the ppid chain).
/// Used to recognise `claude` processes Muster launched — directly (embedded
/// PTY) or via a child terminal (e.g. Ghostty) — regardless of their session id.
fn is_descendant_of(pid: u32, ancestor: u32) -> bool {
    let mut cur = pid;
    for _ in 0..24 {
        if cur == ancestor {
            return true;
        }
        match ps_one(cur, "ppid=").and_then(|s| s.trim().parse::<u32>().ok()) {
            Some(ppid) if ppid > 1 => cur = ppid,
            _ => return false,
        }
    }
    false
}

/// List interactive Claude Code sessions running OUTSIDE Muster. `exclude` is the
/// set of session ids Muster already owns (belt-and-suspenders — ours don't
/// register anyway). Dead/stale registry files are filtered by verifying the pid
/// is still a live `claude` process.
#[tauri::command]
fn list_external_sessions(state: State<AppState>, exclude: Vec<String>) -> Vec<ExternalSession> {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return vec![],
    };
    let dir = std::path::Path::new(&home).join(".claude").join("sessions");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let exclude: std::collections::HashSet<String> =
        exclude.into_iter().map(|s| s.to_lowercase()).collect();

    let mut parsed: Vec<ExternalSession> = Vec::new();
    for ent in entries.flatten() {
        let p = ent.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let txt = match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&txt) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("kind").and_then(|k| k.as_str()) != Some("interactive") {
            continue;
        }
        let pid = match v.get("pid").and_then(|x| x.as_u64()) {
            Some(n) => n as u32,
            None => continue,
        };
        let session_id = v.get("sessionId").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if session_id.is_empty() || exclude.contains(&session_id.to_lowercase()) {
            continue;
        }
        parsed.push(ExternalSession {
            pid,
            session_id,
            cwd: v.get("cwd").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            name: v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            status: v.get("status").and_then(|x| x.as_str()).unwrap_or("idle").to_string(),
            status_updated_at: v.get("statusUpdatedAt").and_then(|x| x.as_i64()),
            started_at: v.get("startedAt").and_then(|x| x.as_i64()),
            version: v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        });
    }
    if parsed.is_empty() {
        return parsed;
    }

    // Liveness + identity: one `ps` for all pids; keep those still running `claude`
    // (guards against stale files and pid reuse).
    let pids_csv = parsed.iter().map(|s| s.pid.to_string()).collect::<Vec<_>>().join(",");
    let live: std::collections::HashSet<u32> = std::process::Command::new("ps")
        .args(["-p", &pids_csv, "-o", "pid=,comm="])
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| {
                    let l = l.trim();
                    let mut it = l.splitn(2, char::is_whitespace);
                    let pid = it.next()?.trim().parse::<u32>().ok()?;
                    let comm = it.next().unwrap_or("");
                    if comm.to_lowercase().contains("claude") { Some(pid) } else { None }
                })
                .collect()
        })
        .unwrap_or_default();

    parsed.retain(|s| live.contains(&s.pid));

    // Drop Muster's OWN sessions, matched by pid — NOT by session id. Their id on
    // disk changes when the user runs /resume or /clear (the pid file is rewritten
    // with the new id), so a session-id exclude alone lets a live, Muster-owned
    // session resurface here as "external". The pid is stable for the process'
    // lifetime. `owned_pids` covers embedded PTYs directly; the ancestry walk also
    // catches sessions launched into a child terminal (e.g. Ghostty).
    let self_pid = std::process::id();
    let owned = state.owned_pids.lock().unwrap().clone();
    parsed.retain(|s| !owned.contains(&s.pid) && !is_descendant_of(s.pid, self_pid));

    // most-recently-active first
    parsed.sort_by(|a, b| b.status_updated_at.unwrap_or(0).cmp(&a.status_updated_at.unwrap_or(0)));
    parsed
}

/// Walk up the process tree from `pid` to the owning GUI terminal app.
/// Returns (app_pid, app_exe_path) — e.g. (719, "/…/Terminal.app/Contents/MacOS/Terminal").
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

/// Bring the terminal window/tab hosting an external session to the front.
/// Exact tab focus for Terminal.app + iTerm2 (matched by tty); best-effort app
/// activation for anything else.
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

/// Read a read-only slice of an external session's transcript. The transcript
/// lives at `~/.claude/projects/<enc>/<session_id>.jsonl`, where `<enc>` is the
/// cwd with every non-alphanumeric char replaced by `-`. Only the tail (≤512KB)
/// is read; only human/assistant prose is extracted (tool calls, tool results and
/// thinking are dropped), and the last `limit` messages are returned.
#[tauri::command]
fn read_transcript(cwd: String, session_id: String, limit: usize) -> Result<Vec<TranscriptMsg>, String> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let enc: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let path = std::path::Path::new(&home)
        .join(".claude")
        .join("projects")
        .join(&enc)
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
                for blk in arr {
                    match blk.get("type").and_then(|x| x.as_str()) {
                        Some("text") => {
                            if let Some(s) = blk.get("text").and_then(|x| x.as_str()) {
                                if !text.is_empty() {
                                    text.push('\n');
                                }
                                text.push_str(s);
                            }
                        }
                        // Tool calls (Bash, Read, Edit, …), tool_result echoes and
                        // thinking blocks are noise in a read-only conversation
                        // mirror — keep only the human/assistant prose. An assistant
                        // turn that is only tool calls collapses to empty and is
                        // dropped below.
                        _ => {}
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
        .text("quit", "Quit Muster")
        .build()
        .map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    let _ = tray.set_tooltip(Some(&tooltip));
    // macOS-only: text label rendered next to the menu-bar icon.
    let _ = tray.set_title(Some(&title));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let server = tiny_http::Server::http("127.0.0.1:0")
                .expect("bind telemetry server on 127.0.0.1");
            let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
            println!("[cc-launcher] telemetry server on 127.0.0.1:{port}");

            app.manage(AppState {
                port,
                sessions: Mutex::new(HashMap::new()),
                owned_pids: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                next_perm: std::sync::atomic::AtomicU64::new(1),
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || run_telemetry_server(server, handle));

            // macOS menu-bar (tray) icon — its menu mirrors the sidebar and is
            // rebuilt from the frontend via `update_tray`.
            let tray_menu = MenuBuilder::new(app)
                .text("show", "Show Muster")
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
            session_resources,
            create_worktree,
            resolve_permission,
            list_worktrees,
            spawn_ghostty,
            spawn_shell,
            available_terminals,
            spawn_external_terminal,
            open_terminal_here,
            list_external_sessions,
            focus_external_session,
            read_transcript,
            find_project_icon,
            write_debug_file,
            update_tray
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
