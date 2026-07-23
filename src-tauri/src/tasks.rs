// Runnables — the task/script layer.
//
// A `Runnable` is anything a project declares it can do: an npm script, a task in
// Muster's own `.muster/tasks.toml`, and (later) a VS Code task, a just recipe, a
// Make target. Providers *discover* them here; one executor (`spawn_task` in
// lib.rs) runs them, reusing the same PTY path as a session or a shell.
//
// Two rules shape this module:
//
// - **Discovery never executes the project.** Every provider here parses a file.
//   The introspecting providers (`just --dump`, `task --list`, `make -qp`) evaluate
//   the file they read — backtick variables and imports run shell at parse time —
//   so they are deliberately absent until there's a trust gate to put them behind.
// - **Ids are stable and namespaced** (`npm:test`, `muster:dev`). The frontend
//   persists pins and frecency against them, so they must survive a rescan.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

/// How to actually run a Runnable. `Argv` is exec'd directly; `Shell` is handed to
/// a login shell, so it may contain pipes, `&&`, globs and other shell syntax.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Exec {
    Argv { program: String, args: Vec<String> },
    Shell { line: String },
}

/// Everything `spawn_task` needs to start a run. A resolved subset of `Runnable` —
/// the frontend sends this after substituting inputs and choosing a working
/// directory, so the backend never has to re-derive either.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpec {
    pub exec: Exec,
    pub cwd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Runnable {
    /// Stable + namespaced: "npm:test", "muster:dev".
    pub id: String,
    pub label: String,
    /// The script body / doc comment — shown under the label in the picker.
    pub detail: Option<String>,
    /// Provider name, used to group the picker: "npm", "muster".
    pub source: String,
    /// Repo-relative file the task came from, for "reveal source".
    pub source_file: String,
    /// build | test | run | check | clean — from the file, else inferred by name.
    pub group: Option<String>,
    pub exec: Exec,
    /// Absolute working directory. Defaults to the discovery root.
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    /// Long-running (dev server, watcher): never auto-marked "done" on output, and
    /// its pane isn't auto-dismissed.
    pub background: bool,
    /// `${input:…}` placeholders this task still contains. The frontend prompts for
    /// them and substitutes before calling `spawn_task` — discovery deliberately
    /// leaves them intact, because their values aren't knowable here.
    pub inputs: Vec<InputSpec>,
    /// Labels of tasks that must run first. The frontend resolves and runs them —
    /// it owns the PTY panes, so it's the only side that can wait on an exit code.
    pub depends_on: Vec<String>,
    /// "parallel" | "sequence". Parallel is VS Code's default when `dependsOn` is
    /// an array, which surprises people — but matching it beats inventing our own.
    pub depends_order: String,
    /// `Some(reason)` → the picker shows it greyed and refuses to run it. Being
    /// honest about what we can't run beats silently omitting it, which reads as
    /// "Muster didn't find your task".
    pub blocked: Option<String>,
}

/// One value the user must supply before a task can run. Mirrors VS Code's
/// `inputs` section; just recipe parameters map onto `PromptString` too.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputSpec {
    pub id: String,
    /// "promptString" | "pickString"
    pub kind: String,
    pub description: String,
    pub default: Option<String>,
    /// Choices, for `pickString`.
    pub options: Vec<String>,
    pub password: bool,
}

/// Discover everything runnable in `root`, in a stable order: Muster's own tasks
/// first (a human wrote those for this app), then VS Code's, then npm scripts,
/// then the file-per-recipe runners.
///
/// `trusted` gates the providers that have to *run* the project to enumerate it —
/// see `just_recipes`. An untrusted project still reports that those files exist,
/// as a blocked row, so the tasks look withheld rather than missing.
pub fn discover(root: &Path, trusted: bool) -> Vec<Runnable> {
    let mut out = Vec::new();
    out.extend(muster_tasks(root));
    out.extend(vscode_tasks(root));
    out.extend(launch_configs(root));
    out.extend(npm_scripts(root));
    out.extend(just_recipes(root, trusted));
    out.extend(run_introspector(root, trusted, &TASKFILE));
    out.extend(run_introspector(root, trusted, &MISE));
    out.extend(make_targets(root));
    out.extend(cargo_tasks(root));
    dedupe_ids(&mut out);
    apply_overrides(&mut out, root);
    out
}

/// Read the `[override.*]` table from `.muster/tasks.toml`. A malformed file already
/// surfaces as a blocked row via `muster_tasks`, so a parse error here is silent —
/// reporting it twice would just add noise.
fn task_overrides(root: &Path) -> BTreeMap<String, MusterOverride> {
    std::fs::read_to_string(root.join(MUSTER_TASKS))
        .ok()
        .and_then(|t| toml::from_str::<MusterFile>(&t).ok())
        .map(|f| f.overrides)
        .unwrap_or_default()
}

/// Patch discovered tasks with the project's committable overrides. Runs *after*
/// dedupe, so it keys off the same final ids the frontend pins and re-runs against.
///
/// An override whose target isn't present becomes a **blocked row** rather than
/// disappearing: a typo'd id (`vscode:tset`) then reads as a broken override, not as
/// nothing — the same honesty the rest of the module applies to what it can't run.
fn apply_overrides(list: &mut Vec<Runnable>, root: &Path) {
    let overrides = task_overrides(root);
    if overrides.is_empty() {
        return;
    }
    let mut dangling = Vec::new();
    for (id, ov) in overrides {
        match list.iter_mut().find(|r| r.id == id) {
            Some(r) => apply_override(r, &ov, root),
            None => dangling.push(blocked_row(
                &format!("override:{id}"),
                &format!("override “{id}”"),
                ".muster/tasks.toml",
                "muster",
                root,
                &format!("overrides “{id}”, which nothing here declares"),
            )),
        }
    }
    list.extend(dangling);
}

/// Apply one override in place. Only fields the override sets are touched. A new
/// `run` becomes a shell command and its `${input:…}` prompts are re-derived — kept
/// from the original task where the id survives, synthesized as a bare prompt where
/// the override introduced one.
fn apply_override(r: &mut Runnable, ov: &MusterOverride, root: &Path) {
    if let Some(label) = &ov.label {
        r.label = label.clone();
    }
    if let Some(group) = &ov.group {
        r.group = (!group.is_empty()).then(|| group.clone());
    }
    if let Some(bg) = ov.background {
        r.background = bg;
    }
    if let Some(cwd) = &ov.cwd {
        // Relative to the project root, exactly like a `[[task]]`'s own `cwd`.
        if !cwd.is_empty() {
            r.cwd = root.join(cwd).display().to_string();
        }
    }
    if let Some(run) = &ov.run {
        r.inputs = redetect_inputs(run, &r.inputs);
        r.exec = Exec::Shell { line: run.clone() };
    }
}

/// The `${input:id}` specs for a rewritten command line: keep the original spec
/// wherever the id still appears, synthesize a plain prompt for any the override
/// newly introduced.
fn redetect_inputs(run: &str, original: &[InputSpec]) -> Vec<InputSpec> {
    referenced_inputs(&[run.to_string()])
        .into_iter()
        .map(|id| {
            original.iter().find(|i| i.id == id).cloned().unwrap_or(InputSpec {
                description: id.clone(),
                id,
                kind: "promptString".into(),
                default: None,
                options: Vec::new(),
                password: false,
            })
        })
        .collect()
}

// ── the discovery cache ─────────────────────────────────────────────────────
//
// Parsing two small files was cheap enough to redo on every picker open. Three of
// the providers now *spawn a process* to enumerate themselves, and run-on-stop
// asks for a project's tasks once per agent turn rather than once per click — so
// repeat discovery goes through a cache keyed by (root, trusted).
//
// Invalidation is by **stamp, not by a watcher**: every file a provider reads is
// probed for (mtime, len), and an entry is stale the moment one of them differs —
// including appearing or being deleted. A file watcher would need a thread, a
// crate and a lifecycle per open project to answer the same question ~20
// `metadata()` calls answer in well under a millisecond, and it would still have
// to stat everything on the first read.
//
// Known gap: files an introspector pulls in *itself* — `just`'s `import`/`mod`,
// a Taskfile `includes:` — aren't stamped, so editing one is invisible until the
// importing file changes. Toggling trust re-keys the entry, which is the escape
// hatch that exists today.

const MUSTER_TASKS: &str = ".muster/tasks.toml";
const VSCODE_TASKS: &str = ".vscode/tasks.json";
const VSCODE_LAUNCH: &str = ".vscode/launch.json";
const PACKAGE_JSON: &str = "package.json";
const CARGO_TOML: &str = "Cargo.toml";
/// `cargo_tasks` reads this only to decide whether there's a binary to `run`, but
/// it *is* an input to discovery, so the stamp has to see it.
const CARGO_MAIN: &str = "src/main.rs";
const JUST_FILES: &[&str] = &["justfile", ".justfile", "Justfile"];
const MAKE_FILES: &[&str] = &["Makefile", "makefile", "GNUmakefile"];
/// `package_runner` reads these by existence to pick the npm task runner, so a
/// lockfile appearing or vanishing changes discovery output (`exec.program`) even
/// when `package.json` is byte-identical — the stamp has to see them too.
const LOCK_FILES: &[&str] =
    &["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"];

/// Every path discovery reads, relative to the project root. **A new provider file
/// belongs in this list too** — one that's missing goes stale behind the cache,
/// which reads as "Muster didn't pick up my edit".
fn source_files() -> Vec<&'static str> {
    let mut v = vec![MUSTER_TASKS, VSCODE_TASKS, VSCODE_LAUNCH, PACKAGE_JSON, CARGO_TOML, CARGO_MAIN];
    v.extend(JUST_FILES);
    v.extend(LOCK_FILES);
    v.extend(TASKFILE.markers);
    v.extend(MISE.markers);
    v.extend(MAKE_FILES);
    v
}

/// `None` = the file isn't there, which is as much a fact about the project as
/// its contents are: deleting a justfile has to invalidate too.
type Stamp = Vec<Option<(std::time::SystemTime, u64)>>;

fn stamp(root: &Path) -> Stamp {
    source_files()
        .iter()
        .map(|rel| {
            std::fs::metadata(root.join(rel))
                .ok()
                .map(|m| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len()))
        })
        .collect()
}

static CACHE: LazyLock<Mutex<HashMap<(String, bool), (Stamp, Vec<Runnable>)>>> =
    LazyLock::new(Default::default);

/// `discover`, memoised against the source files it read. Anything wanting a
/// guaranteed-fresh parse (the tests) calls `discover` directly.
pub fn discover_cached(root: &Path, trusted: bool) -> Vec<Runnable> {
    let key = (root.display().to_string(), trusted);
    let now = stamp(root);
    // A panic in another thread poisoned nothing that matters here — the worst a
    // half-written cache costs is one extra parse.
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((was, list)) = cache.get(&key) {
        if *was == now {
            return list.clone();
        }
    }
    let list = discover(root, trusted);
    // Two entries per project at most, and a session's worth of projects is a
    // handful — but a map that only ever grows is a leak by another name, and
    // dropping the lot costs one re-parse.
    if cache.len() >= 64 {
        cache.clear();
    }
    cache.insert(key, (now, list.clone()));
    list
}

/// Ids must be unique — the frontend keys pins and frecency off them. A collision
/// (two `[[task]]` entries with the same label) gets a numeric suffix rather than
/// silently shadowing.
fn dedupe_ids(list: &mut [Runnable]) {
    let mut seen: BTreeMap<String, u32> = BTreeMap::new();
    for r in list.iter_mut() {
        let n = seen.entry(r.id.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            r.id = format!("{}~{}", r.id, *n);
        }
    }
}

// ── .muster/tasks.toml ──────────────────────────────────────────────────────
// Muster's own, IDE-agnostic format. The file a team commits *because* of Muster,
// and the escape hatch for anything the other providers can't express.

#[derive(Deserialize)]
struct MusterFile {
    #[serde(default)]
    task: Vec<MusterTask>,
    /// `[override."vscode:test"]` — a committable patch over a task some *other*
    /// tool declares, so editing a discovered task never rewrites `.vscode/tasks.json`
    /// or a justfile. Keyed by the discovered id; applied in `discover` after every
    /// provider has run. See `apply_overrides`.
    #[serde(default, rename = "override")]
    overrides: BTreeMap<String, MusterOverride>,
}

/// The patch half of a `[[task]]`. Every field optional: an override that only
/// renames a task carries just `label`. `run`, when present, replaces the command
/// (and re-derives `${input:…}` prompts from the new line).
#[derive(Deserialize, Default)]
struct MusterOverride {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    run: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    background: Option<bool>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct MusterTask {
    label: String,
    run: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    background: bool,
    /// Relative to the project root.
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

fn muster_tasks(root: &Path) -> Vec<Runnable> {
    let path = root.join(MUSTER_TASKS);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let parsed: MusterFile = match toml::from_str(&text) {
        Ok(p) => p,
        // A malformed tasks.toml surfaces as one un-runnable row rather than
        // vanishing — otherwise a typo looks like "Muster ignored my file".
        Err(e) => {
            return vec![blocked_row(
                "muster:__error",
                ".muster/tasks.toml has an error",
                ".muster/tasks.toml",
                "muster",
                root,
                &first_line(&e.to_string()),
            )]
        }
    };

    parsed
        .task
        .into_iter()
        .map(|t| {
            let slug = t.id.unwrap_or_else(|| slugify(&t.label));
            let cwd = match &t.cwd {
                Some(rel) => root.join(rel).display().to_string(),
                None => root.display().to_string(),
            };
            Runnable {
                id: format!("muster:{slug}"),
                group: t.group.or_else(|| infer_group(&t.label, &t.run)),
                detail: t.detail.or_else(|| Some(t.run.clone())),
                label: t.label,
                source: "muster".into(),
                source_file: ".muster/tasks.toml".into(),
                exec: Exec::Shell { line: t.run },
                cwd,
                env: t.env,
                background: t.background,
                inputs: Vec::new(),
                depends_on: Vec::new(),
                depends_order: "parallel".into(),
                blocked: None,
            }
        })
        .collect()
}

// ── package.json ────────────────────────────────────────────────────────────

/// Which package manager to invoke, decided by the lockfile that's actually
/// present. Guessing wrong is worse than it looks: `npm run` in a pnpm workspace
/// resolves a different (or missing) dependency tree.
fn package_runner(root: &Path) -> &'static str {
    for (lock, runner) in [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
        ("package-lock.json", "npm"),
    ] {
        if root.join(lock).exists() {
            return runner;
        }
    }
    "npm"
}

fn npm_scripts(root: &Path) -> Vec<Runnable> {
    let Ok(text) = std::fs::read_to_string(root.join(PACKAGE_JSON)) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) else {
        return Vec::new();
    };
    let runner = package_runner(root);

    scripts
        .iter()
        .filter_map(|(name, body)| {
            let body = body.as_str()?;
            Some(Runnable {
                id: format!("npm:{name}"),
                label: name.clone(),
                detail: Some(body.to_string()),
                source: "npm".into(),
                source_file: "package.json".into(),
                group: infer_group(name, body),
                exec: Exec::Argv {
                    program: runner.to_string(),
                    args: vec!["run".into(), name.clone()],
                },
                cwd: root.display().to_string(),
                env: BTreeMap::new(),
                background: is_background(name, body),
                inputs: Vec::new(),
                depends_on: Vec::new(),
                depends_order: "parallel".into(),
                blocked: None,
            })
        })
        .collect()
}

// ── .vscode/tasks.json ──────────────────────────────────────────────────────
// VS Code's format, minus the editor. Most of the work here is being honest about
// the difference: a task built around ${file} has no meaning in an app with no
// open file, so it's marked blocked rather than run with an empty string spliced in.

/// Expand VS Code's `${…}` variables against what Muster actually knows.
///
/// `${input:…}` is left *intact* — the frontend prompts for it at launch. Anything
/// that needs an open editor (or a VS Code command / setting we can't evaluate)
/// returns `Err(reason)`, which becomes the Runnable's `blocked` message.
fn substitute(s: &str, root: &Path, cwd: &str) -> Result<String, String> {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            // An unterminated ${ is literal text, not a variable.
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let var = &after[..end];
        rest = &after[end + 1..];

        let root_str = root.display().to_string();
        let expanded = match var {
            "workspaceFolder" | "workspaceRoot" => root_str.clone(),
            "workspaceFolderBasename" => root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| root_str.clone()),
            "cwd" => cwd.to_string(),
            "userHome" => home_dir().unwrap_or_default(),
            "pathSeparator" | "/" => std::path::MAIN_SEPARATOR.to_string(),
            v if v.starts_with("env:") => std::env::var(&v[4..]).unwrap_or_default(),
            // Left for the frontend to fill in — re-emitted verbatim.
            v if v.starts_with("input:") => format!("${{{v}}}"),
            // Everything below needs an editor Muster doesn't have.
            "file" | "relativeFile" | "relativeFileDirname" | "fileBasename"
            | "fileBasenameNoExtension" | "fileDirname" | "fileExtname" | "fileWorkspaceFolder" => {
                return Err("needs an open editor file".into())
            }
            "lineNumber" | "selectedText" => return Err("needs an editor selection".into()),
            v if v.starts_with("command:") => return Err("runs a VS Code command".into()),
            v if v.starts_with("config:") => return Err("reads a VS Code setting".into()),
            other => return Err(format!("unsupported variable ${{{other}}}")),
        };
        out.push_str(&expanded);
    }
    out.push_str(rest);
    Ok(out)
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()
}

/// The `${input:id}` ids still present in any of a task's strings, in first-seen
/// order — so the prompt asks in the order the command reads.
fn referenced_inputs(parts: &[String]) -> Vec<String> {
    let mut ids = Vec::new();
    for p in parts {
        let mut rest = p.as_str();
        while let Some(i) = rest.find("${input:") {
            let after = &rest[i + 8..];
            let Some(end) = after.find('}') else { break };
            let id = after[..end].to_string();
            if !ids.contains(&id) {
                ids.push(id);
            }
            rest = &after[end + 1..];
        }
    }
    ids
}

/// The platform-specific override key VS Code applies on this OS.
#[cfg(target_os = "macos")]
const PLATFORM_KEY: &str = "osx";
#[cfg(target_os = "windows")]
const PLATFORM_KEY: &str = "windows";
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const PLATFORM_KEY: &str = "linux";

/// Shallow-merge a task's platform block over its base, the way VS Code does.
fn apply_platform(task: &serde_json::Value) -> serde_json::Value {
    let mut merged = task.clone();
    if let Some(over) = task.get(PLATFORM_KEY).and_then(|v| v.as_object()) {
        if let Some(base) = merged.as_object_mut() {
            for (k, v) in over {
                base.insert(k.clone(), v.clone());
            }
        }
    }
    merged
}

fn parse_input_specs(root: &Path, cwd: &str, raw: Option<&serde_json::Value>) -> Vec<InputSpec> {
    let Some(list) = raw.and_then(|v| v.as_array()) else { return Vec::new() };
    list.iter()
        .filter_map(|i| {
            let id = i.get("id")?.as_str()?.to_string();
            let kind = i.get("type").and_then(|v| v.as_str()).unwrap_or("promptString");
            // `command` inputs run a VS Code command to produce their value — there's
            // nothing to run them with here, so the task that needs one is blocked.
            let kind = match kind {
                "pickString" => "pickString",
                "promptString" => "promptString",
                _ => return None,
            };
            let sub = |v: Option<&serde_json::Value>| {
                v.and_then(|x| x.as_str()).and_then(|x| substitute(x, root, cwd).ok())
            };
            Some(InputSpec {
                description: sub(i.get("description"))
                    .unwrap_or_else(|| format!("Value for {id}")),
                default: sub(i.get("default")),
                options: i
                    .get("options")
                    .and_then(|v| v.as_array())
                    .map(|o| {
                        o.iter()
                            .filter_map(|x| {
                                // options may be plain strings or {label, value}
                                x.as_str()
                                    .map(str::to_string)
                                    .or_else(|| x.get("value")?.as_str().map(str::to_string))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                password: i.get("password").and_then(|v| v.as_bool()).unwrap_or(false),
                id,
                kind: kind.to_string(),
            })
        })
        .collect()
}

fn vscode_tasks(root: &Path) -> Vec<Runnable> {
    let rel = format!(".vscode{}tasks.json", std::path::MAIN_SEPARATOR);
    let path = root.join(VSCODE_TASKS);
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };

    // tasks.json is JSONC: comments and trailing commas are normal, and VS Code's
    // own template ships with both.
    let json: serde_json::Value = match jsonc_parser::parse_to_serde_value(&text, &Default::default()) {
        Ok(Some(v)) => v,
        Ok(None) => return Vec::new(),
        Err(e) => {
            return vec![blocked_row(
                "vscode:__error",
                ".vscode/tasks.json has an error",
                &rel,
                "vscode",
                root,
                &first_line(&e.to_string()),
            )]
        }
    };

    let Some(list) = json.get("tasks").and_then(|t| t.as_array()) else { return Vec::new() };
    let root_str = root.display().to_string();
    let all_inputs = parse_input_specs(root, &root_str, json.get("inputs"));
    let runner = package_runner(root);

    list.iter()
        .filter_map(|raw| {
            let t = apply_platform(raw);
            let label = t.get("label").or_else(|| t.get("taskName"))?.as_str()?.to_string();
            let ttype = t.get("type").and_then(|v| v.as_str()).unwrap_or("process");

            let cwd = match t.get("options").and_then(|o| o.get("cwd")).and_then(|c| c.as_str()) {
                Some(c) => match substitute(c, root, &root_str) {
                    Ok(c) => c,
                    Err(why) => return Some(blocked_row(&format!("vscode:{label}"), &label, &rel, "vscode", root, &why)),
                },
                None => root_str.clone(),
            };

            let mk_blocked = |why: &str| {
                Some(blocked_row(&format!("vscode:{label}"), &label, &rel, "vscode", root, why))
            };

            let command = t.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let args: Vec<String> = t
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| {
                            // args may be strings or {value, quoting}
                            x.as_str().map(str::to_string).or_else(|| Some(x.get("value")?.as_str()?.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();

            // Substitute every string that ends up in the command line; the first
            // failure blocks the whole task, with the reason the picker shows.
            let mut parts = vec![command.to_string()];
            parts.extend(args.iter().cloned());
            let subbed: Result<Vec<String>, String> =
                parts.iter().map(|p| substitute(p, root, &cwd)).collect();
            let subbed = match subbed {
                Ok(v) => v,
                Err(why) => return mk_blocked(&why),
            };

            let mut env = BTreeMap::new();
            if let Some(e) = t.get("options").and_then(|o| o.get("env")).and_then(|e| e.as_object()) {
                for (k, v) in e {
                    let Some(v) = v.as_str() else { continue };
                    match substitute(v, root, &cwd) {
                        Ok(v) => { env.insert(k.clone(), v); }
                        Err(why) => return mk_blocked(&why),
                    }
                }
            }

            let exec = match ttype {
                // A shell task's command+args are one command line, pipes and all.
                "shell" => Exec::Shell { line: subbed.join(" ") },
                "process" => Exec::Argv {
                    program: subbed[0].clone(),
                    args: subbed[1..].to_vec(),
                },
                "npm" => {
                    let script = t.get("script").and_then(|v| v.as_str()).unwrap_or("install");
                    Exec::Argv {
                        program: runner.to_string(),
                        args: vec!["run".into(), script.to_string()],
                    }
                }
                other => return mk_blocked(&format!("task type “{other}” isn't supported yet")),
            };
            if subbed[0].trim().is_empty() && ttype != "npm" {
                return mk_blocked("no command");
            }

            let ids = referenced_inputs(&subbed);
            let inputs: Vec<InputSpec> =
                all_inputs.iter().filter(|i| ids.contains(&i.id)).cloned().collect();
            // A ${input:x} with no matching declaration can never be filled in.
            if let Some(missing) = ids.iter().find(|id| !inputs.iter().any(|i| &&i.id == id)) {
                return mk_blocked(&format!("no input declared for ${{input:{missing}}}"));
            }

            // dependsOn names other tasks by *label*; the frontend resolves them
            // against the same discovery result and runs them before this one.
            let depends_on: Vec<String> = match t.get("dependsOn") {
                Some(serde_json::Value::String(one)) => vec![one.clone()],
                Some(serde_json::Value::Array(many)) => {
                    many.iter().filter_map(|d| Some(d.as_str()?.to_string())).collect()
                }
                _ => Vec::new(),
            };
            let depends_order = t
                .get("dependsOrder")
                .and_then(|v| v.as_str())
                .filter(|v| *v == "sequence")
                .unwrap_or("parallel")
                .to_string();

            let group = t.get("group").and_then(|g| {
                g.as_str().map(str::to_string).or_else(|| Some(g.get("kind")?.as_str()?.to_string()))
            });

            Some(Runnable {
                id: format!("vscode:{}", slugify(&label)),
                detail: t
                    .get("detail")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or_else(|| Some(exec_line(&exec))),
                group: group.or_else(|| infer_group(&label, command)),
                label,
                source: "vscode".into(),
                source_file: rel.clone(),
                exec,
                cwd,
                env,
                background: t.get("isBackground").and_then(|v| v.as_bool()).unwrap_or(false),
                inputs,
                depends_on,
                depends_order,
                blocked: None,
            })
        })
        .collect()
}

// ── .vscode/launch.json ─────────────────────────────────────────────────────
// "Run without debugging" — VS Code's ⌃F5, not F5. Muster has no debug adapter,
// so it starts the same program with the same args, env and cwd, and says so.
// A config that only makes sense *with* a debugger (an attach request) is blocked
// rather than silently started as a plain process.

fn launch_configs(root: &Path) -> Vec<Runnable> {
    let rel = format!(".vscode{}launch.json", std::path::MAIN_SEPARATOR);
    let Ok(text) = std::fs::read_to_string(root.join(VSCODE_LAUNCH)) else {
        return Vec::new();
    };
    let json: serde_json::Value = match jsonc_parser::parse_to_serde_value(&text, &Default::default()) {
        Ok(Some(v)) => v,
        _ => return Vec::new(),
    };
    let Some(list) = json.get("configurations").and_then(|c| c.as_array()) else { return Vec::new() };
    let root_str = root.display().to_string();
    let all_inputs = parse_input_specs(root, &root_str, json.get("inputs"));

    list.iter()
        .filter_map(|raw| {
            let c = apply_platform(raw);
            let name = c.get("name")?.as_str()?.to_string();
            let id = format!("launch:{}", slugify(&name));
            let mk_blocked = |why: &str| Some(blocked_row(&id, &name, &rel, "launch", root, why));

            // A compound config chains other configs; that's dependsOn by another
            // name, and it isn't wired up here yet.
            if c.get("configurations").is_some() {
                return mk_blocked("compound configuration — not supported yet");
            }
            if c.get("request").and_then(|r| r.as_str()) == Some("attach") {
                return mk_blocked("attaches to a running process — needs a debugger");
            }

            let cwd = match c.get("cwd").and_then(|v| v.as_str()) {
                Some(v) => match substitute(v, root, &root_str) {
                    Ok(v) => v,
                    Err(why) => return mk_blocked(&why),
                },
                None => root_str.clone(),
            };
            let sub = |v: Option<&serde_json::Value>| -> Result<Option<String>, String> {
                match v.and_then(|x| x.as_str()) {
                    Some(x) => substitute(x, root, &cwd).map(Some),
                    None => Ok(None),
                }
            };
            let str_list = |key: &str| -> Result<Vec<String>, String> {
                c.get(key)
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str())
                            .map(|x| substitute(x, root, &cwd))
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .unwrap_or_else(|| Ok(Vec::new()))
            };

            let program = match sub(c.get("program")) {
                Ok(p) => p,
                Err(why) => return mk_blocked(&why),
            };
            let runtime = match sub(c.get("runtimeExecutable")) {
                Ok(p) => p,
                Err(why) => return mk_blocked(&why),
            };
            let (args, runtime_args) = match (str_list("args"), str_list("runtimeArgs")) {
                (Ok(a), Ok(r)) => (a, r),
                (Err(why), _) | (_, Err(why)) => return mk_blocked(&why),
            };

            let ctype = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let exec = match ctype {
                "node" | "pwa-node" | "node-terminal" => {
                    let program = program.clone().unwrap_or_default();
                    let mut a = runtime_args.clone();
                    if !program.is_empty() {
                        a.push(program);
                    }
                    a.extend(args.clone());
                    Exec::Argv { program: runtime.clone().unwrap_or_else(|| "node".into()), args: a }
                }
                "python" | "debugpy" => {
                    let mut a = vec![program.clone().unwrap_or_default()];
                    a.extend(args.clone());
                    Exec::Argv { program: runtime.clone().unwrap_or_else(|| "python3".into()), args: a }
                }
                "go" => Exec::Shell {
                    line: format!("go run {}", program.clone().unwrap_or_else(|| ".".into())),
                },
                // Native launchers already point at a built executable.
                "lldb" | "cppdbg" | "cppvsdbg" | "codelldb" => match &program {
                    Some(p) => Exec::Argv { program: p.clone(), args: args.clone() },
                    None => return mk_blocked("no program to run"),
                },
                other => return mk_blocked(&format!("launch type “{other}” isn't supported yet")),
            };

            let mut env = BTreeMap::new();
            if let Some(e) = c.get("env").and_then(|e| e.as_object()) {
                for (k, v) in e {
                    let Some(v) = v.as_str() else { continue };
                    match substitute(v, root, &cwd) {
                        Ok(v) => { env.insert(k.clone(), v); }
                        Err(why) => return mk_blocked(&why),
                    }
                }
            }

            let line = exec_line(&exec);
            let ids = referenced_inputs(std::slice::from_ref(&line));
            let inputs: Vec<InputSpec> =
                all_inputs.iter().filter(|i| ids.contains(&i.id)).cloned().collect();
            if let Some(missing) = ids.iter().find(|id| !inputs.iter().any(|i| &&i.id == id)) {
                return mk_blocked(&format!("no input declared for ${{input:{missing}}}"));
            }

            Some(Runnable {
                id,
                label: name,
                // Says plainly that this is the run half of a debug config.
                detail: Some(format!("{line}  (no debugger)")),
                source: "launch".into(),
                source_file: rel.clone(),
                group: Some("run".into()),
                exec,
                cwd,
                env,
                background: false,
                inputs,
                depends_on: Vec::new(),
                depends_order: "parallel".into(),
                blocked: None,
            })
        })
        .collect()
}

// ── Cargo.toml ──────────────────────────────────────────────────────────────

/// Rust projects don't declare tasks — the toolchain *is* the task list. These are
/// the five commands you'd type anyway, offered without having to write them down.
/// Purely conventional: the file is read only to confirm it's a crate and to see
/// whether there's a binary to `run`.
fn cargo_tasks(root: &Path) -> Vec<Runnable> {
    let Ok(text) = std::fs::read_to_string(root.join(CARGO_TOML)) else { return Vec::new() };
    // A virtual workspace root has no package to build; its members do.
    let is_workspace_only = text.contains("[workspace]") && !text.contains("[package]");
    let has_bin = root.join(CARGO_MAIN).exists() || text.contains("[[bin]]");

    let mut out: Vec<(&str, &str, &str)> = vec![
        ("check", "cargo check", "check"),
        ("test", "cargo test", "test"),
        ("clippy", "cargo clippy --all-targets", "check"),
        ("build", "cargo build", "build"),
    ];
    if has_bin && !is_workspace_only {
        out.push(("run", "cargo run", "run"));
    }
    out.into_iter()
        .map(|(name, line, group)| Runnable {
            id: format!("cargo:{name}"),
            label: name.to_string(),
            detail: Some(line.to_string()),
            source: "cargo".into(),
            source_file: "Cargo.toml".into(),
            group: Some(group.to_string()),
            exec: Exec::Shell { line: line.to_string() },
            cwd: root.display().to_string(),
            env: BTreeMap::new(),
            background: false,
            inputs: Vec::new(),
            depends_on: Vec::new(),
            depends_order: "parallel".into(),
            blocked: None,
        })
        .collect()
}

// ── introspecting providers ─────────────────────────────────────────────────

/// (name, doc) pairs pulled out of a tool's JSON listing.
type TaskListing = Vec<(String, Option<String>)>;

/// Shared shape for the providers that must *run* the project's own tool to list
/// its tasks. Each one evaluates the file it reads, so all of them sit behind the
/// same trust gate — and when untrusted, each reports one blocked row rather than
/// disappearing, so the tasks read as withheld rather than absent.
struct Introspector {
    source: &'static str,
    /// Marker files, any of which means "this project uses me".
    markers: &'static [&'static str],
    program: &'static str,
    args: &'static [&'static str],
    /// Pulls (name, doc) pairs out of the tool's JSON.
    parse: fn(&serde_json::Value) -> TaskListing,
    /// How to invoke one task, given its name.
    line: fn(&str) -> String,
}

fn run_introspector(root: &Path, trusted: bool, i: &Introspector) -> Vec<Runnable> {
    let Some(found) = i.markers.iter().find(|m| root.join(m).exists()) else { return Vec::new() };
    if !trusted {
        return vec![blocked_row(
            &format!("{}:__untrusted", i.source),
            &format!("{} tasks", i.source),
            found,
            i.source,
            root,
            &format!("trust this project to read its {found}"),
        )];
    }
    let out = match std::process::Command::new(i.program).args(i.args).current_dir(root).output() {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            return vec![blocked_row(
                &format!("{}:__error", i.source),
                &format!("{} tasks", i.source),
                found,
                i.source,
                root,
                &first_line(&String::from_utf8_lossy(&o.stderr)),
            )]
        }
        // Tool not installed — the marker file simply isn't actionable here.
        Err(_) => return Vec::new(),
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out) else { return Vec::new() };

    (i.parse)(&json)
        .into_iter()
        .map(|(name, doc)| {
            let line = (i.line)(&name);
            Runnable {
                id: format!("{}:{}", i.source, slugify(&name)),
                group: infer_group(&name, ""),
                detail: doc.or_else(|| Some(line.clone())),
                label: name,
                source: i.source.into(),
                source_file: found.to_string(),
                exec: Exec::Shell { line },
                cwd: root.display().to_string(),
                env: BTreeMap::new(),
                background: false,
                inputs: Vec::new(),
                depends_on: Vec::new(),
                depends_order: "parallel".into(),
                blocked: None,
            }
        })
        .collect()
}

/// go-task. `--list-all` includes tasks without a description, which `--list` hides.
const TASKFILE: Introspector = Introspector {
    source: "taskfile",
    markers: &["Taskfile.yml", "Taskfile.yaml", "taskfile.yml"],
    program: "task",
    args: &["--list-all", "--json"],
    parse: |json| {
        json.get("tasks")
            .and_then(|t| t.as_array())
            .map(|ts| {
                ts.iter()
                    .filter_map(|t| {
                        let name = t.get("name")?.as_str()?.to_string();
                        let doc = t
                            .get("desc")
                            .or_else(|| t.get("summary"))
                            .and_then(|d| d.as_str())
                            .filter(|d| !d.is_empty())
                            .map(str::to_string);
                        Some((name, doc))
                    })
                    .collect()
            })
            .unwrap_or_default()
    },
    line: |n| format!("task {n}"),
};

/// mise. Its `tasks ls --json` returns a bare array.
const MISE: Introspector = Introspector {
    source: "mise",
    markers: &["mise.toml", ".mise.toml", "mise.local.toml", ".config/mise.toml"],
    program: "mise",
    args: &["tasks", "ls", "--json"],
    parse: |json| {
        json.as_array()
            .map(|ts| {
                ts.iter()
                    .filter_map(|t| {
                        let name = t.get("name")?.as_str()?.to_string();
                        let doc = t
                            .get("description")
                            .and_then(|d| d.as_str())
                            .filter(|d| !d.is_empty())
                            .map(str::to_string);
                        Some((name, doc))
                    })
                    .collect()
            })
            .unwrap_or_default()
    },
    line: |n| format!("mise run {n}"),
};

// ── justfile ────────────────────────────────────────────────────────────────

/// just recipes, via `just --dump --dump-format json`.
///
/// This is the one provider that *runs* the project: `just` evaluates backtick
/// variable assignments and processes `import`/`mod` while dumping. That's why it
/// is gated — opening a folder in Muster must never execute code from it. An
/// untrusted project with a justfile gets a single blocked row instead, so the
/// recipes read as withheld rather than absent.
fn just_recipes(root: &Path, trusted: bool) -> Vec<Runnable> {
    let Some(found) = JUST_FILES.iter().find(|n| root.join(n).exists()) else { return Vec::new() };
    if !trusted {
        return vec![blocked_row(
            "just:__untrusted",
            "justfile recipes",
            found,
            "just",
            root,
            "trust this project to read its justfile",
        )];
    }

    let out = std::process::Command::new("just")
        .args(["--dump", "--dump-format", "json", "--unstable"])
        .current_dir(root)
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            return vec![blocked_row(
                "just:__error",
                "justfile recipes",
                found,
                "just",
                root,
                &first_line(&String::from_utf8_lossy(&o.stderr)),
            )]
        }
        // `just` not installed — nothing to report, the file just isn't actionable.
        Err(_) => return Vec::new(),
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out) else { return Vec::new() };
    let Some(recipes) = json.get("recipes").and_then(|r| r.as_object()) else { return Vec::new() };

    let mut list: Vec<Runnable> = recipes
        .iter()
        .filter_map(|(name, r)| {
            // `[private]` recipes and the `_`-prefixed convention are internal.
            if name.starts_with('_') || r.get("private").and_then(|p| p.as_bool()).unwrap_or(false) {
                return None;
            }
            // A recipe parameter with no default has to come from somewhere.
            let inputs: Vec<InputSpec> = r
                .get("parameters")
                .and_then(|p| p.as_array())
                .map(|ps| {
                    ps.iter()
                        .filter(|p| p.get("default").map(|d| d.is_null()).unwrap_or(true))
                        .filter_map(|p| {
                            let id = p.get("name")?.as_str()?.to_string();
                            Some(InputSpec {
                                description: format!("{id} (just parameter)"),
                                id,
                                kind: "promptString".into(),
                                default: None,
                                options: Vec::new(),
                                password: false,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            let arg_line = inputs
                .iter()
                .map(|i| format!(" ${{input:{}}}", i.id))
                .collect::<String>();
            let doc = r.get("doc").and_then(|d| d.as_str()).map(str::to_string);

            Some(Runnable {
                id: format!("just:{}", slugify(name)),
                label: name.clone(),
                detail: doc.or_else(|| Some(format!("just {name}"))),
                source: "just".into(),
                source_file: found.to_string(),
                group: infer_group(name, ""),
                // Through a login shell so `just` resolves the same way it does in
                // the user's own terminal.
                exec: Exec::Shell { line: format!("just {name}{arg_line}") },
                cwd: root.display().to_string(),
                env: BTreeMap::new(),
                background: false,
                inputs,
                depends_on: Vec::new(),
                depends_order: "parallel".into(),
                blocked: None,
            })
        })
        .collect();
    list.sort_by(|a, b| a.label.cmp(&b.label));
    list
}

// ── Makefile ────────────────────────────────────────────────────────────────

/// Make targets by static parse. Deliberately *not* `make -qp`, which expands the
/// whole makefile — including `$(shell …)` — just to list targets.
///
/// Picks up the self-documenting convention (`target: ## description`), which is
/// also the signal that a target is meant for humans.
fn make_targets(root: &Path) -> Vec<Runnable> {
    let Some(found) = MAKE_FILES.iter().find(|n| root.join(n).exists()) else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(root.join(found)) else { return Vec::new() };

    let mut out = Vec::new();
    let mut pending_doc: Option<String> = None;
    for line in text.lines() {
        // A `## doc` line documents the target on the next line.
        if let Some(d) = line.trim().strip_prefix("##") {
            pending_doc = Some(d.trim().to_string());
            continue;
        }
        // Targets start at column 0; recipe bodies are tab-indented.
        if line.starts_with([' ', '\t']) || line.trim().is_empty() || line.starts_with('#') {
            if !line.starts_with([' ', '\t']) {
                pending_doc = None;
            }
            continue;
        }
        let Some(colon) = line.find(':') else { pending_doc = None; continue };
        // `VAR := x` and `VAR ::= x` are assignments, not targets.
        if line[colon..].starts_with(":=") || line[..colon].contains('=') {
            pending_doc = None;
            continue;
        }
        let target = line[..colon].trim();
        // Skip special targets (.PHONY), pattern rules (%.o) and multi-target lines.
        if target.is_empty()
            || target.starts_with('.')
            || target.contains('%')
            || target.contains(' ')
            || !target.chars().all(|c| c.is_alphanumeric() || "-_./".contains(c))
        {
            pending_doc = None;
            continue;
        }
        let inline_doc = line[colon..].split("##").nth(1).map(|d| d.trim().to_string());
        let doc = inline_doc.or_else(|| pending_doc.take());
        if out.iter().any(|r: &Runnable| r.label == target) {
            continue;
        }
        out.push(Runnable {
            id: format!("make:{}", slugify(target)),
            label: target.to_string(),
            detail: doc.or_else(|| Some(format!("make {target}"))),
            source: "make".into(),
            source_file: found.to_string(),
            group: infer_group(target, ""),
            exec: Exec::Shell { line: format!("make {target}") },
            cwd: root.display().to_string(),
            env: BTreeMap::new(),
            background: false,
            inputs: Vec::new(),
            depends_on: Vec::new(),
            depends_order: "parallel".into(),
            blocked: None,
        });
        pending_doc = None;
    }
    out
}

/// A row that exists only to explain why it can't run — a parse error, a missing
/// capability, an untrusted folder.
fn blocked_row(id: &str, label: &str, file: &str, source: &str, root: &Path, why: &str) -> Runnable {
    Runnable {
        id: id.to_string(),
        label: label.to_string(),
        detail: Some(why.to_string()),
        source: source.to_string(),
        source_file: file.to_string(),
        group: None,
        exec: Exec::Shell { line: String::new() },
        cwd: root.display().to_string(),
        env: BTreeMap::new(),
        background: false,
        inputs: Vec::new(),
        depends_on: Vec::new(),
        depends_order: "parallel".into(),
        blocked: Some(why.to_string()),
    }
}

fn exec_line(e: &Exec) -> String {
    match e {
        Exec::Shell { line } => line.clone(),
        Exec::Argv { program, args } => {
            std::iter::once(program.clone()).chain(args.iter().cloned()).collect::<Vec<_>>().join(" ")
        }
    }
}

// ── shared inference ────────────────────────────────────────────────────────

/// Group a task by what it's obviously for. Only used when the source file didn't
/// say (VS Code tasks and tasks.toml can declare a group outright).
fn infer_group(name: &str, body: &str) -> Option<String> {
    let n = name.to_ascii_lowercase();
    let b = body.to_ascii_lowercase();
    let any = |hay: &str, needles: &[&str]| needles.iter().any(|w| hay.contains(*w));

    if any(&n, &["test", "spec", "vitest", "jest"]) {
        return Some("test".into());
    }
    if any(&n, &["lint", "fmt", "format", "typecheck", "tsc", "clippy", "check"]) {
        return Some("check".into());
    }
    if any(&n, &["build", "compile", "bundle", "dist", "package"]) {
        return Some("build".into());
    }
    if any(&n, &["dev", "start", "serve", "watch", "preview"]) {
        return Some("run".into());
    }
    if any(&n, &["clean", "clear", "reset"]) {
        return Some("clean".into());
    }
    // Fall back to the command itself — "e2e": "playwright test" is a test.
    if any(&b, &["vitest", "jest", "playwright", "cargo test"]) {
        return Some("test".into());
    }
    None
}

/// Long-running by convention. Deliberately conservative — a false positive means
/// a finished task never settles into "done", which is more confusing than a dev
/// server that briefly claims it finished. `.muster/tasks.toml` can always say so
/// explicitly with `background = true`.
fn is_background(name: &str, body: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let b = body.to_ascii_lowercase();
    matches!(n.as_str(), "dev" | "start" | "serve" | "watch")
        || n.ends_with(":watch")
        || n.ends_with(":dev")
        || b.contains("--watch")
        || b.contains("nodemon")
        || b.contains("tauri dev")
}

/// A stable, filename-ish id fragment for a human-written label.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "task".into()
    } else {
        out
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or(s).trim().to_string()
}

// ── writing .muster/tasks.toml ──────────────────────────────────────────────
// The one file Muster owns, and the only one it ever writes. Discovered VS Code
// tasks, justfiles and Makefiles are read-only: editing them would mean rewriting
// a file another tool owns, which Muster shouldn't do behind your back.
//
// Edits go through `toml_edit` rather than a serialize-the-whole-struct round trip
// so a hand-written file keeps its comments, ordering and spacing. Someone wrote
// that file by hand; a save shouldn't reformat it.

/// One task as the editor panel sends it.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MusterTaskInput {
    pub label: String,
    pub run: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub background: bool,
    #[serde(default)]
    pub cwd: Option<String>,
}

fn tasks_toml_path(workdir: &str) -> std::path::PathBuf {
    Path::new(workdir).join(".muster").join("tasks.toml")
}

fn load_doc(path: &Path) -> Result<toml_edit::DocumentMut, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => t.parse::<toml_edit::DocumentMut>().map_err(|e| first_line(&e.to_string())),
        Err(_) => Ok(toml_edit::DocumentMut::new()),
    }
}

fn write_doc(path: &Path, doc: &toml_edit::DocumentMut) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create .muster: {e}"))?;
    }
    std::fs::write(path, doc.to_string()).map_err(|e| format!("write tasks.toml: {e}"))
}

/// Write tasks.toml and immediately drop the project's cache — every write goes
/// through here so a saved edit can never be masked by a stale, stamp-matching entry.
/// `workdir` is the project root; `path` is `<workdir>/.muster/tasks.toml`.
fn write_doc_for(workdir: &str, path: &Path, doc: &toml_edit::DocumentMut) -> Result<(), String> {
    write_doc(path, doc)?;
    invalidate(workdir);
    Ok(())
}

fn fill_table(t: &mut toml_edit::Table, task: &MusterTaskInput, id: &str) {
    t["id"] = toml_edit::value(id);
    t["label"] = toml_edit::value(task.label.as_str());
    t["run"] = toml_edit::value(task.run.as_str());
    match &task.group {
        Some(g) if !g.is_empty() => t["group"] = toml_edit::value(g.as_str()),
        _ => { t.remove("group"); }
    }
    match &task.cwd {
        Some(c) if !c.is_empty() => t["cwd"] = toml_edit::value(c.as_str()),
        _ => { t.remove("cwd"); }
    }
    if task.background {
        t["background"] = toml_edit::value(true);
    } else {
        t.remove("background");
    }
}

/// Find the `[[task]]` entry Muster addresses as `id`. Tasks Muster wrote carry an
/// explicit `id`; hand-written ones are matched on their label's slug, which is
/// exactly how discovery derived their id in the first place.
fn find_task_index(arr: &toml_edit::ArrayOfTables, id: &str) -> Option<usize> {
    arr.iter().position(|t| {
        let explicit = t.get("id").and_then(|v| v.as_str());
        let label = t.get("label").and_then(|v| v.as_str()).unwrap_or("");
        explicit == Some(id) || (explicit.is_none() && slugify(label) == id)
    })
}

/// Create or update a task. `id` is `None` for a new one. Returns its id.
#[tauri::command]
pub fn save_muster_task(
    workdir: String,
    id: Option<String>,
    task: MusterTaskInput,
) -> Result<String, String> {
    if task.label.trim().is_empty() {
        return Err("a task needs a label".into());
    }
    if task.run.trim().is_empty() {
        return Err("a task needs a command".into());
    }
    let path = tasks_toml_path(&workdir);
    let mut doc = load_doc(&path)?;
    if !doc.contains_key("task") {
        doc["task"] = toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new());
    }
    let arr = doc["task"]
        .as_array_of_tables_mut()
        .ok_or("`task` in tasks.toml isn't a [[task]] array")?;

    let existing = id.as_deref().and_then(|i| find_task_index(arr, i));
    let new_id = id.unwrap_or_else(|| slugify(&task.label));
    match existing {
        Some(i) => fill_table(arr.get_mut(i).unwrap(), &task, &new_id),
        None => {
            let mut t = toml_edit::Table::new();
            fill_table(&mut t, &task, &new_id);
            arr.push(t);
        }
    }
    write_doc_for(&workdir, &path, &doc)?;
    Ok(format!("muster:{new_id}"))
}

/// Write `[override."<id>"]` for a task some other provider declared. The key is the
/// discovered id (`vscode:test`, `just:deploy`); `toml_edit` preserves the rest of a
/// hand-authored file. `run` is written verbatim so a `${input:…}` the user typed
/// survives — discovery re-derives the prompt from it.
#[tauri::command]
pub fn save_task_override(
    workdir: String,
    id: String,
    task: MusterTaskInput,
) -> Result<(), String> {
    if task.label.trim().is_empty() {
        return Err("a task needs a label".into());
    }
    if task.run.trim().is_empty() {
        return Err("a task needs a command".into());
    }
    let path = tasks_toml_path(&workdir);
    let mut doc = load_doc(&path)?;
    // A dotted [override."id"] table, implicit at the `override` level so the file
    // reads as one section rather than a run of standalone tables.
    let over = doc
        .entry("override")
        .or_insert(toml_edit::Item::Table({
            let mut t = toml_edit::Table::new();
            t.set_implicit(true);
            t
        }))
        .as_table_mut()
        .ok_or("`override` in tasks.toml isn't a table")?;

    let mut t = toml_edit::Table::new();
    t["label"] = toml_edit::value(task.label.as_str());
    t["run"] = toml_edit::value(task.run.as_str());
    match &task.group {
        Some(g) if !g.is_empty() => t["group"] = toml_edit::value(g.as_str()),
        _ => {}
    }
    match &task.cwd {
        Some(c) if !c.is_empty() => t["cwd"] = toml_edit::value(c.as_str()),
        _ => {}
    }
    // Written unconditionally, unlike a `[[task]]`: an override's job includes turning
    // a discovered `background` flag *off*, which an absent key (meaning "inherit")
    // couldn't express.
    t["background"] = toml_edit::value(task.background);
    over[&id] = toml_edit::Item::Table(t);
    write_doc_for(&workdir, &path, &doc)
}

/// Drop a task's override, reverting it to what its own tool declares. Removing the
/// last one takes the now-empty `[override]` section with it, so reverting your only
/// override leaves no residue.
#[tauri::command]
pub fn remove_task_override(workdir: String, id: String) -> Result<(), String> {
    let path = tasks_toml_path(&workdir);
    let mut doc = load_doc(&path)?;
    let Some(over) = doc.get_mut("override").and_then(|o| o.as_table_mut()) else {
        return Err("no overrides to remove".into());
    };
    if over.remove(&id).is_none() {
        return Err(format!("no override for “{id}”"));
    }
    if over.is_empty() {
        doc.remove("override");
    }
    write_doc_for(&workdir, &path, &doc)
}

/// The discovered ids the project currently overrides — the panel uses this to mark
/// a row overridden and offer *revert*. Reads the file directly (not the cache), so a
/// just-written override shows immediately.
#[tauri::command]
pub fn list_task_overrides(workdir: String) -> Result<Vec<String>, String> {
    Ok(task_overrides(Path::new(&workdir)).into_keys().collect())
}

#[tauri::command]
pub fn delete_muster_task(workdir: String, id: String) -> Result<(), String> {
    let path = tasks_toml_path(&workdir);
    let mut doc = load_doc(&path)?;
    let Some(arr) = doc.get_mut("task").and_then(|t| t.as_array_of_tables_mut()) else {
        return Err("no tasks to delete".into());
    };
    let Some(i) = find_task_index(arr, &id) else {
        return Err(format!("no task “{id}” in tasks.toml"));
    };
    arr.remove(i);
    write_doc_for(&workdir, &path, &doc)
}

/// Whether the project already has a tasks.toml — the panel asks before creating
/// one, because a new committable file in someone's repo is a real side effect.
#[tauri::command]
pub fn muster_tasks_file(workdir: String) -> Result<(String, bool), String> {
    let p = tasks_toml_path(&workdir);
    Ok((p.display().to_string(), p.exists()))
}

/// Drop every cache entry for a project. Called by `rescan_runnables` and by every
/// command that writes `.muster/tasks.toml` — a write must never be masked by a stale
/// entry the `(mtime, len)` stamp happened to match (two edits inside one filesystem
/// mtime tick that leave the length unchanged would otherwise not invalidate).
fn invalidate(workdir: &str) {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.retain(|(root, _), _| root != workdir);
}

/// Force the next `discover_runnables(workdir, …)` to re-parse from disk, dropping
/// both the trusted and untrusted cache entries for this project. The stamp already
/// catches edits to files Muster *reads*; this is the escape hatch for the one thing
/// it can't see — a file an introspector pulls in itself (`just` `import`, a Taskfile
/// `includes:`) — and the honest answer to a "Rescan" button.
#[tauri::command]
pub fn rescan_runnables(workdir: String) {
    invalidate(&workdir);
}

/// Parse the project's runnables. Memoised per (root, trusted) and invalidated by
/// the source files' own mtimes — see the discovery-cache block above — so calling
/// this on every picker open, palette open and agent turn stays cheap.
#[tauri::command]
pub fn discover_runnables(workdir: String, trusted: bool) -> Result<Vec<Runnable>, String> {
    let root = Path::new(&workdir);
    if !root.is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    Ok(discover_cached(root, trusted))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch project directory that cleans itself up.
    struct Tmp(std::path::PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "muster-tasks-{tag}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn write(&self, rel: &str, body: &str) {
            let f = self.0.join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, body).unwrap();
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn finds_npm_scripts_with_the_lockfile_s_runner() {
        let t = Tmp::new("npm");
        t.write(
            "package.json",
            r#"{"scripts":{"test":"vitest run","dev":"vite --watch"}}"#,
        );
        t.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

        let found = discover(&t.0, true);
        let test = found.iter().find(|r| r.id == "npm:test").unwrap();
        assert_eq!(
            test.exec,
            Exec::Argv { program: "pnpm".into(), args: vec!["run".into(), "test".into()] }
        );
        assert_eq!(test.group.as_deref(), Some("test"));
        assert!(!test.background);
        assert_eq!(test.detail.as_deref(), Some("vitest run"));

        let dev = found.iter().find(|r| r.id == "npm:dev").unwrap();
        assert!(dev.background, "a dev script is long-running");
    }

    #[test]
    fn npm_runner_defaults_to_npm_without_a_lockfile() {
        let t = Tmp::new("norunner");
        t.write("package.json", r#"{"scripts":{"build":"tsc"}}"#);
        let found = discover(&t.0, true);
        assert_eq!(
            found[0].exec,
            Exec::Argv { program: "npm".into(), args: vec!["run".into(), "build".into()] }
        );
        assert_eq!(found[0].group.as_deref(), Some("build"));
    }

    #[test]
    fn reads_muster_tasks_toml() {
        let t = Tmp::new("toml");
        t.write(
            ".muster/tasks.toml",
            r#"
[[task]]
label = "Dev server"
run = "pnpm tauri dev"
background = true

[[task]]
label = "Migrate"
run = "just migrate"
group = "run"
cwd = "src-tauri"
env = { RUST_LOG = "debug" }
"#,
        );
        let found = discover(&t.0, true);
        assert_eq!(found.len(), 2);

        assert_eq!(found[0].id, "muster:dev-server");
        assert_eq!(found[0].exec, Exec::Shell { line: "pnpm tauri dev".into() });
        assert!(found[0].background);

        assert_eq!(found[1].id, "muster:migrate");
        assert_eq!(found[1].cwd, t.0.join("src-tauri").display().to_string());
        assert_eq!(found[1].env.get("RUST_LOG").map(String::as_str), Some("debug"));
    }

    #[test]
    fn a_broken_tasks_toml_reports_itself_instead_of_vanishing() {
        let t = Tmp::new("broken");
        t.write(".muster/tasks.toml", "[[task]]\nlabel = \"oops\"\n"); // no `run`
        let found = discover(&t.0, true);
        assert_eq!(found.len(), 1);
        assert!(found[0].blocked.is_some());
        assert!(found[0].label.contains("tasks.toml"));
    }

    #[test]
    fn muster_tasks_come_before_npm_scripts() {
        let t = Tmp::new("order");
        t.write("package.json", r#"{"scripts":{"test":"vitest"}}"#);
        t.write(".muster/tasks.toml", "[[task]]\nlabel = \"Deploy\"\nrun = \"./deploy.sh\"\n");
        let found = discover(&t.0, true);
        assert_eq!(found[0].source, "muster");
        assert_eq!(found[1].source, "npm");
    }

    #[test]
    fn duplicate_labels_get_distinct_ids() {
        let t = Tmp::new("dupe");
        t.write(
            ".muster/tasks.toml",
            "[[task]]\nlabel = \"Test\"\nrun = \"a\"\n\n[[task]]\nlabel = \"Test\"\nrun = \"b\"\n",
        );
        let found = discover(&t.0, true);
        assert_eq!(found[0].id, "muster:test");
        assert_eq!(found[1].id, "muster:test~2");
    }

    #[test]
    fn missing_files_are_not_an_error() {
        let t = Tmp::new("empty");
        assert!(discover(&t.0, true).is_empty());
    }

    #[test]
    fn discover_runnables_rejects_a_non_directory() {
        assert!(discover_runnables("/definitely/not/here".into(), false).is_err());
    }

    /// The frontend hands a discovered `exec` straight back to `spawn_task`, so the
    /// serialized and deserialized shapes have to be the same object. This pins the
    /// wire format both ways — a rename here silently breaks every task launch, and
    /// nothing else in the suite would notice.
    #[test]
    fn exec_round_trips_through_the_shape_the_frontend_sees() {
        let argv = Exec::Argv { program: "pnpm".into(), args: vec!["run".into(), "test".into()] };
        let json = serde_json::to_string(&argv).unwrap();
        assert_eq!(json, r#"{"mode":"argv","program":"pnpm","args":["run","test"]}"#);
        assert_eq!(serde_json::from_str::<Exec>(&json).unwrap(), argv);

        let shell = Exec::Shell { line: "pnpm tauri dev".into() };
        let json = serde_json::to_string(&shell).unwrap();
        assert_eq!(json, r#"{"mode":"shell","line":"pnpm tauri dev"}"#);
        assert_eq!(serde_json::from_str::<Exec>(&json).unwrap(), shell);
    }

    // ── VS Code ──────────────────────────────────────────────────────────

    #[test]
    fn reads_vscode_tasks_including_jsonc_comments_and_trailing_commas() {
        let t = Tmp::new("vsc");
        t.write(
            ".vscode/tasks.json",
            r#"{
  // VS Code ships this comment in its own template.
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Build",
      "type": "shell",
      "command": "cargo",
      "args": ["build", "--manifest-path", "${workspaceFolder}/Cargo.toml"],
      "group": { "kind": "build", "isDefault": true },
      "options": { "env": { "RUST_LOG": "debug" } },
    },
    {
      "label": "Serve",
      "type": "process",
      "command": "node",
      "args": ["server.js"],
      "isBackground": true,
    },
  ],
}"#,
        );
        let found = discover(&t.0, true);
        let build = found.iter().find(|r| r.label == "Build").unwrap();
        assert_eq!(
            build.exec,
            Exec::Shell {
                line: format!("cargo build --manifest-path {}/Cargo.toml", t.0.display())
            }
        );
        assert_eq!(build.group.as_deref(), Some("build"));
        assert_eq!(build.env.get("RUST_LOG").map(String::as_str), Some("debug"));
        assert!(build.blocked.is_none());

        let serve = found.iter().find(|r| r.label == "Serve").unwrap();
        assert_eq!(
            serve.exec,
            Exec::Argv { program: "node".into(), args: vec!["server.js".into()] }
        );
        assert!(serve.background);
    }

    #[test]
    fn a_vscode_task_needing_an_editor_is_blocked_not_hidden() {
        let t = Tmp::new("vscfile");
        t.write(
            ".vscode/tasks.json",
            r#"{"tasks":[{"label":"Test file","type":"shell","command":"vitest ${relativeFile}"}]}"#,
        );
        let found = discover(&t.0, true);
        assert_eq!(found.len(), 1, "the task is listed, not dropped");
        assert_eq!(found[0].blocked.as_deref(), Some("needs an open editor file"));
    }

    #[test]
    fn vscode_dependson_is_carried_through_for_the_frontend_to_order() {
        let t = Tmp::new("vscdep");
        t.write(
            ".vscode/tasks.json",
            r#"{"tasks":[
              {"label":"Build","type":"shell","command":"make"},
              {"label":"All","type":"shell","command":"echo hi","dependsOn":["Build"],"dependsOrder":"sequence"},
              {"label":"One","type":"shell","command":"echo one","dependsOn":"Build"}
            ]}"#,
        );
        let found = discover(&t.0, true);
        let all = found.iter().find(|r| r.label == "All").unwrap();
        assert!(all.blocked.is_none(), "dependsOn no longer blocks a task");
        assert_eq!(all.depends_on, vec!["Build"]);
        assert_eq!(all.depends_order, "sequence");

        // A bare string is the single-dependency shorthand.
        let one = found.iter().find(|r| r.label == "One").unwrap();
        assert_eq!(one.depends_on, vec!["Build"]);
        // VS Code's default is parallel, which surprises people — but it's the default.
        assert_eq!(one.depends_order, "parallel");
    }

    // ── launch.json ──────────────────────────────────────────────────────

    #[test]
    fn launch_configs_run_without_a_debugger() {
        let t = Tmp::new("launch");
        t.write(
            ".vscode/launch.json",
            r#"{
  "version": "0.2.0",
  "configurations": [
    { "name": "Server", "type": "node", "request": "launch",
      "program": "${workspaceFolder}/server.js", "args": ["--port", "3000"],
      "env": { "NODE_ENV": "development" } },
    { "name": "Attach", "type": "node", "request": "attach", "port": 9229 },
    { "name": "Weird", "type": "coreclr", "request": "launch" }
  ]
}"#,
        );
        let found = discover(&t.0, true);

        let server = found.iter().find(|r| r.label == "Server").unwrap();
        assert!(server.blocked.is_none());
        assert_eq!(
            server.exec,
            Exec::Argv {
                program: "node".into(),
                args: vec![
                    format!("{}/server.js", t.0.display()),
                    "--port".into(),
                    "3000".into()
                ],
            }
        );
        assert_eq!(server.env.get("NODE_ENV").map(String::as_str), Some("development"));
        assert!(server.detail.as_deref().unwrap().contains("no debugger"));

        // Honest about the two it can't do.
        let attach = found.iter().find(|r| r.label == "Attach").unwrap();
        assert!(attach.blocked.as_deref().unwrap().contains("attaches"));
        let weird = found.iter().find(|r| r.label == "Weird").unwrap();
        assert!(weird.blocked.as_deref().unwrap().contains("coreclr"));
    }

    // ── Cargo ────────────────────────────────────────────────────────────

    #[test]
    fn cargo_offers_the_commands_you_would_type_anyway() {
        let t = Tmp::new("cargo");
        t.write("Cargo.toml", "[package]\nname = \"x\"\nversion = \"0.1.0\"\n");
        t.write("src/main.rs", "fn main() {}");
        let found = discover(&t.0, true);
        let labels: Vec<_> = found.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(labels, vec!["check", "test", "clippy", "build", "run"]);
        assert_eq!(found[1].exec, Exec::Shell { line: "cargo test".into() });
    }

    #[test]
    fn a_library_crate_has_nothing_to_run() {
        let t = Tmp::new("cargolib");
        t.write("Cargo.toml", "[package]\nname = \"x\"\n");
        t.write("src/lib.rs", "");
        let found = discover(&t.0, true);
        assert!(!found.iter().any(|r| r.label == "run"), "no binary to run");
    }

    #[test]
    fn a_virtual_workspace_root_has_nothing_to_run() {
        let t = Tmp::new("cargows");
        t.write("Cargo.toml", "[workspace]\nmembers = [\"a\"]\n");
        t.write("src/main.rs", "fn main() {}");
        let found = discover(&t.0, true);
        assert!(!found.iter().any(|r| r.label == "run"));
        assert!(found.iter().any(|r| r.label == "test"), "the workspace still tests");
    }

    // ── introspecting providers ──────────────────────────────────────────

    #[test]
    fn every_introspecting_provider_is_withheld_until_trusted() {
        let t = Tmp::new("gates");
        t.write("Taskfile.yml", "version: '3'\ntasks:\n  build:\n    cmds: [echo hi]\n");
        t.write("mise.toml", "[tasks.lint]\nrun = \"echo hi\"\n");
        let found = discover(&t.0, false);
        for src in ["taskfile", "mise"] {
            let row = found.iter().find(|r| r.source == src).unwrap_or_else(|| panic!("{src} row"));
            assert!(row.blocked.as_deref().unwrap().starts_with("trust this project"));
        }
    }

    #[test]
    fn taskfile_json_maps_onto_runnables() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"tasks":[{"name":"build","desc":"Build it"},{"name":"quiet","desc":""}]}"#,
        )
        .unwrap();
        let got = (TASKFILE.parse)(&json);
        assert_eq!(got[0], ("build".to_string(), Some("Build it".to_string())));
        assert_eq!(got[1], ("quiet".to_string(), None), "an empty desc is no desc");
        assert_eq!((TASKFILE.line)("build"), "task build");
    }

    #[test]
    fn mise_json_maps_onto_runnables() {
        let json: serde_json::Value =
            serde_json::from_str(r#"[{"name":"lint","description":"Lint it"}]"#).unwrap();
        let got = (MISE.parse)(&json);
        assert_eq!(got[0], ("lint".to_string(), Some("Lint it".to_string())));
        assert_eq!((MISE.line)("lint"), "mise run lint");
    }

    #[test]
    fn vscode_inputs_are_attached_and_left_for_the_frontend() {
        let t = Tmp::new("vscin");
        t.write(
            ".vscode/tasks.json",
            r#"{
  "tasks": [{ "label": "Deploy", "type": "shell", "command": "deploy --env ${input:environment}" }],
  "inputs": [{
    "id": "environment", "type": "pickString",
    "description": "Target", "default": "staging",
    "options": ["staging", "production"]
  }]
}"#,
        );
        let found = discover(&t.0, true);
        let d = &found[0];
        assert!(d.blocked.is_none());
        // Left intact — only the frontend knows the answer.
        assert_eq!(d.exec, Exec::Shell { line: "deploy --env ${input:environment}".into() });
        assert_eq!(d.inputs.len(), 1);
        assert_eq!(d.inputs[0].kind, "pickString");
        assert_eq!(d.inputs[0].options, vec!["staging", "production"]);
        assert_eq!(d.inputs[0].default.as_deref(), Some("staging"));
    }

    #[test]
    fn an_input_with_no_declaration_cannot_be_filled_in() {
        let t = Tmp::new("vscmissing");
        t.write(
            ".vscode/tasks.json",
            r#"{"tasks":[{"label":"Deploy","type":"shell","command":"deploy ${input:nope}"}]}"#,
        );
        let found = discover(&t.0, true);
        assert!(found[0].blocked.as_deref().unwrap().contains("no input declared"));
    }

    #[test]
    fn substitution_covers_what_muster_knows_and_refuses_what_it_does_not() {
        let root = Path::new("/tmp/proj");
        assert_eq!(substitute("${workspaceFolder}/x", root, "/tmp/proj").unwrap(), "/tmp/proj/x");
        assert_eq!(substitute("${workspaceFolderBasename}", root, "/tmp/proj").unwrap(), "proj");
        assert_eq!(substitute("${cwd}", root, "/elsewhere").unwrap(), "/elsewhere");
        std::env::set_var("MUSTER_TEST_VAR", "yes");
        assert_eq!(substitute("${env:MUSTER_TEST_VAR}", root, "").unwrap(), "yes");
        // An undefined env var is empty, matching VS Code.
        assert_eq!(substitute("[${env:MUSTER_UNSET_VAR}]", root, "").unwrap(), "[]");
        // Inputs survive for the frontend.
        assert_eq!(substitute("a ${input:tag} b", root, "").unwrap(), "a ${input:tag} b");
        // A bare "${" is literal text, not a broken variable.
        assert_eq!(substitute("cost is $${100", root, "").unwrap(), "cost is $${100");
        assert!(substitute("${file}", root, "").is_err());
        assert!(substitute("${command:foo}", root, "").is_err());
        assert!(substitute("${totallyMadeUp}", root, "").is_err());
    }

    // ── justfile ─────────────────────────────────────────────────────────

    #[test]
    fn an_untrusted_justfile_is_withheld_not_ignored() {
        let t = Tmp::new("justgate");
        t.write("justfile", "test:\n    echo hi\n");
        let found = discover(&t.0, false);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].blocked.as_deref(), Some("trust this project to read its justfile"));
        assert_eq!(found[0].source, "just");
    }

    #[test]
    fn a_trusted_justfile_yields_recipes_with_docs_and_parameters() {
        if std::process::Command::new("just").arg("--version").output().is_err() {
            eprintln!("skipping: `just` is not installed");
            return;
        }
        let t = Tmp::new("just");
        t.write(
            "justfile",
            "# Run the test suite\ntest:\n    echo testing\n\ndeploy env:\n    echo {{env}}\n\n_private:\n    echo hidden\n",
        );
        let found = discover(&t.0, true);
        assert!(found.iter().all(|r| r.blocked.is_none()));

        let test = found.iter().find(|r| r.label == "test").unwrap();
        assert_eq!(test.exec, Exec::Shell { line: "just test".into() });
        assert_eq!(test.detail.as_deref(), Some("Run the test suite"));

        // A parameter with no default becomes a prompt, threaded into the command.
        let deploy = found.iter().find(|r| r.label == "deploy").unwrap();
        assert_eq!(deploy.exec, Exec::Shell { line: "just deploy ${input:env}".into() });
        assert_eq!(deploy.inputs.len(), 1);
        assert_eq!(deploy.inputs[0].id, "env");

        assert!(!found.iter().any(|r| r.label == "_private"), "`_` recipes are internal");
    }

    // ── Makefile ─────────────────────────────────────────────────────────

    #[test]
    fn reads_make_targets_and_their_doc_comments() {
        let t = Tmp::new("make");
        t.write(
            "Makefile",
            "CFLAGS := -O2\nPREFIX = /usr/local\n\n.PHONY: build test\n\nbuild: ## Compile everything\n\tcc -o out main.c\n\n## Run the suite\ntest:\n\t./out --test\n\n%.o: %.c\n\tcc -c $<\n",
        );
        let found = discover(&t.0, true);
        let labels: Vec<_> = found.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(labels, vec!["build", "test"], "no assignments, .PHONY or pattern rules");

        let build = found.iter().find(|r| r.label == "build").unwrap();
        assert_eq!(build.exec, Exec::Shell { line: "make build".into() });
        assert_eq!(build.detail.as_deref(), Some("Compile everything"));
        assert_eq!(build.group.as_deref(), Some("build"));

        // A `##` line above the target documents it too.
        let test = found.iter().find(|r| r.label == "test").unwrap();
        assert_eq!(test.detail.as_deref(), Some("Run the suite"));
    }

    // ── writing tasks.toml ───────────────────────────────────────────────

    #[test]
    fn saving_a_task_creates_the_file_then_appends_to_it() {
        let t = Tmp::new("write");
        let wd = t.0.display().to_string();
        let id = save_muster_task(
            wd.clone(),
            None,
            MusterTaskInput {
                label: "Dev server".into(),
                run: "pnpm dev".into(),
                group: None,
                background: true,
                cwd: None,
            },
        )
        .unwrap();
        assert_eq!(id, "muster:dev-server");

        save_muster_task(
            wd.clone(),
            None,
            MusterTaskInput {
                label: "Test".into(),
                run: "pnpm test".into(),
                group: Some("test".into()),
                background: false,
                cwd: Some("app".into()),
            },
        )
        .unwrap();

        // Round-trips through discovery, which is the only proof that matters.
        let found = discover(&t.0, true);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].label, "Dev server");
        assert!(found[0].background);
        assert_eq!(found[1].cwd, t.0.join("app").display().to_string());
        assert_eq!(found[1].group.as_deref(), Some("test"));
    }

    #[test]
    fn editing_a_task_preserves_hand_written_comments_and_order() {
        let t = Tmp::new("preserve");
        let wd = t.0.display().to_string();
        t.write(
            ".muster/tasks.toml",
            "# Our team's tasks — please keep sorted.\n\n[[task]]\nlabel = \"Test\"\nrun = \"pnpm test\"\n\n[[task]]\nlabel = \"Lint\"\nrun = \"eslint .\"\n",
        );
        save_muster_task(
            wd,
            Some("test".into()),   // hand-written entries are addressed by label slug
            MusterTaskInput {
                label: "Test".into(),
                run: "pnpm test --run".into(),
                group: None,
                background: false,
                cwd: None,
            },
        )
        .unwrap();

        let text = std::fs::read_to_string(t.0.join(".muster/tasks.toml")).unwrap();
        assert!(text.contains("# Our team's tasks"), "the comment survives an edit");
        assert!(text.contains("pnpm test --run"));
        assert!(text.contains("eslint ."), "the other task is untouched");
        assert!(text.find("Test").unwrap() < text.find("Lint").unwrap(), "order kept");

        let found = discover(&t.0, true);
        assert_eq!(found.len(), 2, "edited in place, not appended");
    }

    #[test]
    fn deleting_a_task_leaves_the_rest_alone() {
        let t = Tmp::new("delete");
        let wd = t.0.display().to_string();
        t.write(
            ".muster/tasks.toml",
            "[[task]]\nid = \"a\"\nlabel = \"A\"\nrun = \"a\"\n\n[[task]]\nid = \"b\"\nlabel = \"B\"\nrun = \"b\"\n",
        );
        delete_muster_task(wd.clone(), "a".into()).unwrap();
        let found = discover(&t.0, true);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].label, "B");
        assert!(delete_muster_task(wd, "gone".into()).is_err());
    }

    #[test]
    fn an_override_patches_a_discovered_task_without_touching_its_file() {
        let t = Tmp::new("override");
        let wd = t.0.display().to_string();
        let tasks_json = r#"{"tasks":[{"label":"Test","type":"shell","command":"vitest"}]}"#;
        t.write(".vscode/tasks.json", tasks_json);

        // Rename it and give it a different command.
        save_task_override(
            wd.clone(),
            "vscode:test".into(),
            MusterTaskInput {
                label: "Test (changed only)".into(),
                run: "vitest run --changed".into(),
                group: Some("test".into()),
                background: false,
                cwd: None,
            },
        )
        .unwrap();

        let found = discover(&t.0, true);
        let d = found.iter().find(|r| r.id == "vscode:test").unwrap();
        assert_eq!(d.label, "Test (changed only)");
        assert_eq!(d.exec, Exec::Shell { line: "vitest run --changed".into() });
        assert_eq!(d.group.as_deref(), Some("test"));
        // The other tool's file is never rewritten.
        assert_eq!(std::fs::read_to_string(t.0.join(".vscode/tasks.json")).unwrap(), tasks_json);
        assert_eq!(list_task_overrides(wd.clone()).unwrap(), vec!["vscode:test".to_string()]);

        // Revert leaves no residue and restores the original command.
        remove_task_override(wd.clone(), "vscode:test".into()).unwrap();
        assert!(list_task_overrides(wd).unwrap().is_empty());
        let reverted = discover(&t.0, true);
        let d = reverted.iter().find(|r| r.id == "vscode:test").unwrap();
        assert_eq!(d.label, "Test");
        assert_eq!(d.exec, Exec::Shell { line: "vitest".into() });
        // The now-empty [override] table is gone, not left as dead structure.
        assert!(!std::fs::read_to_string(t.0.join(".muster/tasks.toml")).unwrap().contains("override"));
    }

    #[test]
    fn an_override_can_reword_a_command_and_reprompt() {
        let t = Tmp::new("ovin");
        let wd = t.0.display().to_string();
        t.write("package.json", r#"{"scripts":{"deploy":"./deploy.sh"}}"#);
        save_task_override(
            wd,
            "npm:deploy".into(),
            MusterTaskInput {
                label: "deploy".into(),
                run: "./deploy.sh --env ${input:environment}".into(),
                group: None,
                background: false,
                cwd: None,
            },
        )
        .unwrap();
        let found = discover(&t.0, true);
        let d = found.iter().find(|r| r.id == "npm:deploy").unwrap();
        // A prompt the override introduced is synthesized from the id.
        assert_eq!(d.inputs.len(), 1);
        assert_eq!(d.inputs[0].id, "environment");
        assert_eq!(d.inputs[0].kind, "promptString");
    }

    #[test]
    fn an_override_of_a_missing_task_is_a_blocked_row_not_a_ghost() {
        let t = Tmp::new("ovdead");
        let wd = t.0.display().to_string();
        t.write("package.json", r#"{"scripts":{"test":"vitest"}}"#);
        save_task_override(
            wd,
            "vscode:tset".into(), // a typo — no such task
            MusterTaskInput { label: "x".into(), run: "x".into(), group: None, background: false, cwd: None },
        )
        .unwrap();
        let found = discover(&t.0, true);
        let dead = found.iter().find(|r| r.id == "override:vscode:tset").unwrap();
        assert!(dead.blocked.is_some(), "a dangling override is shown, greyed, with why");
        assert!(found.iter().any(|r| r.id == "npm:test"), "real tasks are untouched");
    }

    #[test]
    fn a_write_invalidates_the_cache_immediately() {
        let t = Tmp::new("cacheinval");
        let wd = t.0.display().to_string();
        t.write("package.json", r#"{"scripts":{"test":"vitest"}}"#);
        // Prime the cache.
        assert_eq!(discover_cached(&t.0, true).iter().find(|r| r.id == "npm:test").unwrap().label, "test");
        // A write must be visible on the very next cached read, without waiting for
        // the mtime stamp to happen to differ.
        save_task_override(
            wd,
            "npm:test".into(),
            MusterTaskInput { label: "renamed".into(), run: "vitest run".into(), group: None, background: false, cwd: None },
        )
        .unwrap();
        assert_eq!(discover_cached(&t.0, true).iter().find(|r| r.id == "npm:test").unwrap().label, "renamed");
    }

    #[test]
    fn rescan_drops_the_cached_entry() {
        let t = Tmp::new("rescan");
        let wd = t.0.display().to_string();
        t.write("package.json", r#"{"scripts":{"test":"vitest"}}"#);
        assert_eq!(discover_cached(&t.0, true).len(), 1);
        rescan_runnables(wd);
        // Nothing to assert on timing, but the entry is gone: a subsequent call
        // re-parses rather than serving stale data. Correctness is covered by the
        // stamp test; this just proves the command doesn't panic and clears its key.
        assert_eq!(discover_cached(&t.0, true).len(), 1);
    }

    #[test]
    fn a_task_needs_a_label_and_a_command() {
        let t = Tmp::new("validate");
        let wd = t.0.display().to_string();
        let bad = |label: &str, run: &str| {
            save_muster_task(
                wd.clone(),
                None,
                MusterTaskInput {
                    label: label.into(),
                    run: run.into(),
                    group: None,
                    background: false,
                    cwd: None,
                },
            )
        };
        assert!(bad("  ", "x").is_err());
        assert!(bad("x", "  ").is_err());
        assert!(!tasks_toml_path(&t.0.display().to_string()).exists(), "no file for a rejected task");
    }

    #[test]
    fn muster_tasks_file_reports_whether_it_exists_yet() {
        let t = Tmp::new("exists");
        let wd = t.0.display().to_string();
        let (path, exists) = muster_tasks_file(wd.clone()).unwrap();
        assert!(path.ends_with("tasks.toml"));
        assert!(!exists);
        t.write(".muster/tasks.toml", "");
        assert!(muster_tasks_file(wd).unwrap().1);
    }

    /// Dogfood: discovery has to work on this repo, which has both a package.json
    /// (with a pnpm lockfile) and a committed .muster/tasks.toml. Asserts the shape
    /// rather than specific task names, so renaming a script doesn't break the suite.
    #[test]
    fn discovers_this_repo() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let found = discover(root, true);
        assert!(!found.is_empty(), "muster's own repo should have runnables");
        assert!(found.iter().any(|r| r.source == "muster"), "reads .muster/tasks.toml");
        assert!(found.iter().any(|r| r.source == "npm"), "reads package.json scripts");
        assert!(
            found.iter().all(|r| r.blocked.is_none()),
            "nothing in our own task file should be un-runnable"
        );

        let mut ids: Vec<_> = found.iter().map(|r| r.id.as_str()).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "ids must be unique — pins key off them");

        // The lockfile is pnpm, so npm scripts must invoke pnpm.
        let npm = found.iter().find(|r| r.source == "npm").unwrap();
        match &npm.exec {
            Exec::Argv { program, .. } => assert_eq!(program, "pnpm"),
            other => panic!("npm scripts should be argv, got {other:?}"),
        }
    }

    /// A TaskSpec built from a Runnable the way `launchTask` builds it.
    #[test]
    fn task_spec_accepts_what_launch_task_sends() {
        let spec: TaskSpec = serde_json::from_str(
            r#"{"exec":{"mode":"shell","line":"just test"},"cwd":"/tmp","env":{"RUST_LOG":"debug"}}"#,
        )
        .unwrap();
        assert_eq!(spec.cwd, "/tmp");
        assert_eq!(spec.env.get("RUST_LOG").map(String::as_str), Some("debug"));
        // env is optional — a task with none omits the key entirely.
        let bare: TaskSpec =
            serde_json::from_str(r#"{"exec":{"mode":"argv","program":"ls","args":[]},"cwd":"/tmp"}"#)
                .unwrap();
        assert!(bare.env.is_empty());
    }

    /// The cache must never be the reason an edit doesn't show up: writing,
    /// changing and deleting a provider file each have to be visible on the very
    /// next call.
    #[test]
    fn the_cache_follows_the_files_it_read() {
        let t = Tmp::new("cache");
        t.write("package.json", r#"{"scripts":{"test":"vitest run"}}"#);
        let first = discover_cached(&t.0, false);
        assert_eq!(first.len(), 1, "one npm script");

        // An unchanged tree serves the same answer — that's the whole point.
        assert_eq!(discover_cached(&t.0, false), first);

        t.write("package.json", r#"{"scripts":{"test":"vitest run","build":"tsc"}}"#);
        let grown = discover_cached(&t.0, false);
        assert_eq!(grown.len(), 2, "an edited package.json invalidates the entry");

        // A file appearing counts as a change even though nothing existing moved.
        t.write("Makefile", "build:\n\tcc -o x x.c\n");
        assert!(
            discover_cached(&t.0, false).iter().any(|r| r.source == "make"),
            "a new provider file invalidates the entry"
        );

        // …and so does one going away.
        std::fs::remove_file(t.0.join("Makefile")).unwrap();
        assert!(!discover_cached(&t.0, false).iter().any(|r| r.source == "make"));

        // Trust is part of the key, not part of the stamp: the same tree read
        // untrusted must not answer for a trusted read.
        t.write("Taskfile.yml", "version: '3'\ntasks:\n  hi:\n    cmds: [echo hi]\n");
        let untrusted = discover_cached(&t.0, false);
        assert!(
            untrusted.iter().any(|r| r.blocked.is_some()),
            "untrusted taskfile is withheld, not missing"
        );
        let trusted = discover_cached(&t.0, true);
        assert_ne!(untrusted, trusted, "trust re-keys rather than reusing the entry");
    }

    /// A lockfile is an input to discovery — `package_runner` picks the npm runner
    /// from it — so one appearing must invalidate the cache even though the file that
    /// *declares* the tasks (`package.json`) never changed.
    #[test]
    fn a_new_lockfile_invalidates_the_cache() {
        let t = Tmp::new("lockstamp");
        t.write("package.json", r#"{"scripts":{"build":"tsc"}}"#);
        let prog = |list: &[Runnable]| match &list.iter().find(|r| r.id == "npm:build").unwrap().exec {
            Exec::Argv { program, .. } => program.clone(),
            Exec::Shell { .. } => "shell".into(),
        };
        // No lockfile ⇒ the default runner.
        assert_eq!(prog(&discover_cached(&t.0, false)), "npm");
        // `pnpm install` writes a lockfile and leaves package.json byte-identical.
        t.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
        assert_eq!(prog(&discover_cached(&t.0, false)), "pnpm", "a new lockfile re-picks the runner");
    }
}
