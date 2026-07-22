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

use std::collections::BTreeMap;
use std::path::Path;

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
    out.extend(npm_scripts(root));
    out.extend(just_recipes(root, trusted));
    out.extend(make_targets(root));
    dedupe_ids(&mut out);
    out
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
    let path = root.join(".muster").join("tasks.toml");
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
    let Ok(text) = std::fs::read_to_string(root.join("package.json")) else {
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
    let path = root.join(".vscode").join("tasks.json");
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

            // dependsOn changes what running the task *means*; doing half of it
            // silently is worse than declining until P2 implements the ordering.
            if t.get("dependsOn").is_some() {
                return mk_blocked("depends on other tasks — not supported yet");
            }

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
                blocked: None,
            })
        })
        .collect()
}

// ── justfile ────────────────────────────────────────────────────────────────

/// just recipes, via `just --dump --dump-format json`.
///
/// This is the one provider that *runs* the project: `just` evaluates backtick
/// variable assignments and processes `import`/`mod` while dumping. That's why it
/// is gated — opening a folder in Muster must never execute code from it. An
/// untrusted project with a justfile gets a single blocked row instead, so the
/// recipes read as withheld rather than absent.
fn just_recipes(root: &Path, trusted: bool) -> Vec<Runnable> {
    let names = ["justfile", ".justfile", "Justfile"];
    let Some(found) = names.iter().find(|n| root.join(n).exists()) else { return Vec::new() };
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
    let names = ["Makefile", "makefile", "GNUmakefile"];
    let Some(found) = names.iter().find(|n| root.join(n).exists()) else { return Vec::new() };
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

/// Parse the project's runnables. Cheap enough (two small files) to run on every
/// picker open — no cache until a provider needs to shell out.
#[tauri::command]
pub fn discover_runnables(workdir: String, trusted: bool) -> Result<Vec<Runnable>, String> {
    let root = Path::new(&workdir);
    if !root.is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    Ok(discover(root, trusted))
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
    fn a_vscode_task_with_dependson_declines_rather_than_running_half_of_it() {
        let t = Tmp::new("vscdep");
        t.write(
            ".vscode/tasks.json",
            r#"{"tasks":[{"label":"All","type":"shell","command":"echo hi","dependsOn":["Build"]}]}"#,
        );
        let found = discover(&t.0, true);
        assert!(found[0].blocked.as_deref().unwrap().contains("depends on"));
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
}
