// cc-launcher — Tauri backend (multi-session)
//
// - Manages N concurrent `claude` sessions, each in its own PTY (portable-pty),
//   keyed by a caller-supplied session UUID (also passed to `claude --session-id`
//   so every hook/statusline event correlates back to its pane).
// - Instruments each session per-launch via `claude --settings <file>` so Claude
//   Code's hooks + statusLine POST live status/cost/context to a local HTTP
//   server — no global config mutation, no transcript parsing.

use std::collections::HashMap;
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
}

struct AppState {
    port: u16,
    sessions: Mutex<HashMap<String, Session>>,
    /// Held-open PermissionRequest HTTP requests, keyed by an id we assign.
    /// Answered later by the `resolve_permission` command.
    pending: Mutex<HashMap<String, tiny_http::Request>>,
    next_perm: std::sync::atomic::AtomicU64,
}

/// Receive hook + statusLine POSTs from Claude Code and forward each to the
/// frontend as a `telemetry` event (routed by session_id on the frontend).
fn run_telemetry_server(server: tiny_http::Server, app: AppHandle) {
    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);
        let data: serde_json::Value =
            serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

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

    let statusline_cmd = format!(
        "i=$(/bin/cat); printf '%s' \"$i\" | /usr/bin/curl -s --max-time 1 -X POST 'http://127.0.0.1:{port}/statusline' --data-binary @- >/dev/null 2>&1; printf 'cc-launcher'"
    );
    let hook_cmd = format!(
        "/usr/bin/curl -s --max-time 2 -X POST 'http://127.0.0.1:{port}/hook' --data-binary @- >/dev/null 2>&1 || true"
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
            { "matcher": "", "hooks": [ { "type": "http", "url": format!("http://127.0.0.1:{port}/permission"), "timeout": 600 } ] }
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

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session { master: pair.master, writer, killer },
    );

    // stream PTY output → frontend (base64, tagged with session id)
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

    // reap on exit → drop session + notify
    let app_exit = app.clone();
    let sid_exit = session_id.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(0);
        if let Some(st) = app_exit.try_state::<AppState>() {
            st.sessions.lock().unwrap().remove(&sid_exit);
        }
        let _ = app_exit.emit("pty-exit", serde_json::json!({ "sessionId": sid_exit, "code": code }));
    });

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
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&session_id) {
        let _ = s.killer.kill();
    }
    Ok(())
}

/// Create a git worktree with a new (or existing) branch off `repo_dir`.
/// Returns the absolute worktree path. Worktrees live in a sibling
/// `.cc-worktrees/<repo>/<branch>` folder so the repo stays clean.
#[tauri::command]
fn create_worktree(repo_dir: String, branch: String) -> Result<String, String> {
    let root_out = std::process::Command::new("git")
        .arg("-C").arg(&repo_dir).args(["rev-parse", "--show-toplevel"])
        .output().map_err(|e| e.to_string())?;
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

    let add = std::process::Command::new("git")
        .arg("-C").arg(&root).args(["worktree", "add", "-b", &safe, &wt_str])
        .output().map_err(|e| e.to_string())?;
    if add.status.success() {
        return Ok(wt_str);
    }
    let err = String::from_utf8_lossy(&add.stderr).to_string();
    if err.contains("already exists") {
        // branch already exists — attach it instead of creating
        let add2 = std::process::Command::new("git")
            .arg("-C").arg(&root).args(["worktree", "add", &wt_str, &safe])
            .output().map_err(|e| e.to_string())?;
        if add2.status.success() {
            return Ok(wt_str);
        }
        return Err(String::from_utf8_lossy(&add2.stderr).trim().to_string());
    }
    Err(err.trim().to_string())
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

// ---------- project favicon / logo discovery ----------

#[derive(serde::Serialize)]
struct ProjectIcon {
    path: String,
    data_uri: String,
}

/// Read a candidate icon file into a base64 data-URI (small files only).
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
    let mime = match ext.as_str() {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    };
    let bytes = std::fs::read(p).ok()?;
    let b64 = STANDARD.encode(&bytes);
    Some(ProjectIcon {
        path: p.to_string_lossy().to_string(),
        data_uri: format!("data:{mime};base64,{b64}"),
    })
}

/// Scour a project directory for a favicon / logo we can show as its sidebar
/// glyph. Checks the conventional spots for web / Tauri / Electron projects and
/// returns the first hit (no recursive walk — this stays cheap).
#[tauri::command]
fn find_project_icon(dir: String) -> Option<ProjectIcon> {
    let base = std::path::Path::new(&dir);
    if !base.is_dir() {
        return None;
    }
    let candidates = [
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
    candidates
        .iter()
        .find_map(|rel| read_icon(&base.join(rel)))
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
        .setup(|app| {
            let server = tiny_http::Server::http("127.0.0.1:0")
                .expect("bind telemetry server on 127.0.0.1");
            let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
            println!("[cc-launcher] telemetry server on 127.0.0.1:{port}");

            app.manage(AppState {
                port,
                sessions: Mutex::new(HashMap::new()),
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
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Muster")
                .menu(&tray_menu)
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
            create_worktree,
            resolve_permission,
            list_worktrees,
            spawn_ghostty,
            find_project_icon,
            update_tray
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
