//! gray-pi-index — search the pi extension ecosystem and scaffold gray plugins.
//!
//! `pi_search` queries the npm registry for `keywords:pi-package` and
//! `keywords:pi-extension`, caching the merged index at
//! `~/.gray/pi-index/index.json`. `pi_info` fetches registry details for one
//! package and cross-references ~/grayplugins/PORTS.md to report local
//! availability. `pi_scaffold` creates a new gray account, vendors the npm
//! tarball, and writes a scaffold specification plus an implementation prompt.
//!
//! All network goes through curl; scaffold shells out to `gray account new`
//! and `npm pack`. Errors surface as friendly tool errors.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::{Value, json};

fn manifest() -> Value {
    json!({
        "name": "pi-index",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": "1.1",
        "tools": [
            {
                "name": "pi_search",
                "description": "Search the pi package/extension ecosystem on npm (keywords:pi-package + keywords:pi-extension). Optional `query` narrows results. Results are cached into ~/.gray/pi-index/index.json.",
                "parameters": {
                    "type": "object",
                    "properties": { "query": { "type": "string", "description": "Optional search terms." } }
                }
            },
            {
                "name": "pi_info",
                "description": "Registry details for one npm package plus local availability status (available → gray-X / unavailable / blocked) cross-referenced against ~/grayplugins/PORTS.md.",
                "parameters": {
                    "type": "object",
                    "properties": { "name": { "type": "string", "description": "npm package name, e.g. pi-lens or @scope/pkg." } },
                    "required": ["name"]
                }
            },
            {
                "name": "pi_scaffold",
                "description": "Scaffold a compatible sidecar: `gray account new` for the package, vendor its npm tarball into vendor/, and write SCAFFOLD-SPEC.md with a ready-made implementation prompt. Use after pi_search/pi_info finds an unavailable package.",
                "parameters": {
                    "type": "object",
                    "properties": { "name": { "type": "string", "description": "npm package name to scaffold a sidecar for." } },
                    "required": ["name"]
                }
            }
        ],
        "commands": ["/pi"],
    })
}

fn gray_home() -> PathBuf {
    std::env::var_os("GRAY_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".gray")))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn state_dir() -> PathBuf {
    gray_home().join("pi-index")
}

fn plugins_dir() -> PathBuf {
    std::env::var_os("GRAY_PLUGINS_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join("grayplugins")))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn ports_file() -> PathBuf {
    plugins_dir().join("PORTS.md")
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'@' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out.replace('/', "%2F")
}

fn curl(url: &str, timeout: u64) -> Result<String, String> {
    let out = std::process::Command::new("curl")
        .args(["-sS", "-L", "--max-time", &timeout.to_string(), url])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("couldn't run curl: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().find(|l| l.starts_with("curl:")).unwrap_or("curl failed");
        return Err(line.to_string());
    }
    String::from_utf8(out.stdout).map_err(|_| "registry returned non-utf8".to_string())
}

/// One npm `/-/v1/search` hit → index row.
fn search_rows(text: &str) -> Result<Vec<Value>, String> {
    let url = format!("https://registry.npmjs.org/-/v1/search?size=50&text={text}");
    let body = curl(&url, 20)?;
    let doc: Value = serde_json::from_str(&body).map_err(|_| "bad json from npm".to_string())?;
    let mut rows = Vec::new();
    for obj in doc.get("objects").and_then(Value::as_array).into_iter().flatten() {
        let p = &obj["package"];
        rows.push(json!({
            "name": p.get("name").and_then(Value::as_str).unwrap_or(""),
            "version": p.get("version").and_then(Value::as_str).unwrap_or(""),
            "description": p.get("description").and_then(Value::as_str).unwrap_or(""),
            "fetched_at": now_epoch(),
        }));
    }
    Ok(rows)
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Merge rows into the cached index (dedup by name, newest row wins).
fn update_index(rows: Vec<Value>) {
    let dir = state_dir();
    let file = dir.join("index.json");
    let mut index: serde_json::Map<String, Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    for r in rows {
        if let Some(n) = r.get("name").and_then(Value::as_str) {
            index.insert(n.to_string(), r);
        }
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&file, serde_json::to_string_pretty(&Value::Object(index)).unwrap());
}

fn pi_search(query: Option<&str>) -> Result<String, String> {
    let mut all = Vec::new();
    let mut errs = Vec::new();
    for kw in ["pi-package", "pi-extension"] {
        let text = match query {
            Some(q) if !q.trim().is_empty() => format!("{}+keywords:{kw}", url_encode(q.trim())),
            _ => format!("keywords:{kw}"),
        };
        match search_rows(&text) {
            Ok(rows) => all.extend(rows),
            Err(e) => errs.push(e),
        }
    }
    if all.is_empty() && !errs.is_empty() {
        return Err(format!("npm search failed: {}", errs.join("; ")));
    }
    update_index(all.clone());
    all.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });
    all.dedup_by(|a, b| a["name"] == b["name"]);
    let mut out = String::new();
    for r in all.iter().take(40) {
        out.push_str(&format!(
            "{}@{} — {}\n",
            r["name"].as_str().unwrap_or(""),
            r["version"].as_str().unwrap_or(""),
            r["description"].as_str().unwrap_or("").lines().next().unwrap_or("")
        ));
    }
    if all.len() > 40 {
        out.push_str(&format!("…and {} more (cached in ~/.gray/pi-index/index.json)\n", all.len() - 40));
    }
    if out.is_empty() {
        out = "no pi packages found".into();
    }
    Ok(out.trim_end().to_string())
}

/// Classify a package against the local availability tracker.
fn compat_status(name: &str, ports: &str) -> String {
    let short = name.rsplit('/').next().unwrap_or(name);
    let mut heading = "";
    for line in ports.lines() {
        if line.starts_with('#') {
            heading = line.trim_matches('#').trim().to_lowercase().leak();
        }
        if !(line.contains(name) || (short.len() > 3 && line.contains(short))) {
            continue;
        }
        let lower = heading.to_string();
        if let Some(pos) = line.find("gray-") {
            let tgt: String = line[pos..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            if tgt.len() > 5 {
                return format!("available → {tgt}");
            }
        }
        if lower.contains("not portable") || lower.contains("skip") || lower.contains("deliberately") {
            return format!("blocked: {}", heading.trim());
        }
        if lower.contains("done") || lower.contains("batch") {
            return "available (listed in PORTS.md)".to_string();
        }
        return "mentioned in PORTS.md (status unclear)".to_string();
    }
    "unavailable".to_string()
}

fn pi_info(name: &str) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("missing required argument: name".into());
    }
    let body = curl(&format!("https://registry.npmjs.org/{}", url_encode(name.trim())), 20)
        .map_err(|e| format!("registry lookup failed for {name}: {e}"))?;
    let doc: Value = serde_json::from_str(&body).map_err(|_| format!("{name}: not found or bad json"))?;
    if doc.get("error").is_some() {
        return Err(format!("{name}: {}", doc["error"].as_str().unwrap_or("not found")));
    }
    let latest = doc["dist-tags"]["latest"].as_str().unwrap_or("?");
    let desc = doc["description"].as_str()
        .or_else(|| doc["versions"][latest]["description"].as_str())
        .unwrap_or("");
    let modified = doc["time"]["modified"].as_str().unwrap_or("?");
    let status = match std::fs::read_to_string(ports_file()) {
        Ok(ports) => compat_status(name, &ports),
        Err(_) => "unknown (PORTS.md unreadable)".to_string(),
    };
    Ok(format!(
        "{name}@{latest}\n{desc}\nmodified: {modified}\nport status: {status}"
    ))
}

/// `pi-foo` / `@scope/pi-foo` → `gray-foo`; keeps it filesystem- and tool-safe.
fn grayish_name(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    let base = base.strip_prefix("pi-").unwrap_or(base);
    let safe: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    format!("gray-{}", safe.trim_matches('-'))
}

fn pi_scaffold(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("missing required argument: name".into());
    }
    let dir_name = grayish_name(name);
    let parent = plugins_dir();
    let dest = parent.join(&dir_name);
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    // 1. scaffold the gray account
    let out = std::process::Command::new("gray")
        .args(["account", "new", &dir_name, "--no-repo",
               "--description", &format!("Gray sidecar compatible with npm package {name}")])
        .current_dir(&parent)
        .output()
        .map_err(|e| format!("couldn't run gray: {e}"))?;
    if !out.status.success() {
        return Err(format!("gray account new failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    // 2. vendor the npm tarball
    let vendor = dest.join("vendor");
    let mut vendored = String::from("npm pack failed");
    if std::fs::create_dir_all(&vendor).is_ok() {
        let pack = std::process::Command::new("npm")
            .args(["pack", name, "--pack-destination", vendor.to_str().unwrap_or(".")])
            .current_dir(&vendor)
            .output();
        if let Ok(p) = pack {
            if p.status.success() {
                let tgz = String::from_utf8_lossy(&p.stdout)
                    .lines().last().unwrap_or("").trim().to_string();
                let tgz_path = vendor.join(&tgz);
                let ex = std::process::Command::new("tar")
                    .args(["xzf", &tgz, "--strip-components=1"])
                    .current_dir(&vendor)
                    .output();
                let _ = std::fs::remove_file(&tgz_path);
                vendored = match ex {
                    Ok(e) if e.status.success() => format!("vendored {tgz}"),
                    _ => format!("packed {tgz} but extraction failed"),
                };
            } else {
                vendored = format!("npm pack failed: {}", String::from_utf8_lossy(&p.stderr).trim());
            }
        }
    }
    // 3. SCAFFOLD-SPEC.md stub
    let vendored_src = if vendor.join("package.json").exists() {
        "vendored package lives in vendor/ — read vendor/package.json + entry files."
    } else {
        "vendor/ is empty or unextracted — re-run `npm pack` manually."
    };
    let spec = format!(
        "# SCAFFOLD-SPEC: {name} → {dir_name}\n\n\
         Source package: npm `{name}` — {vendored_src}\n\n\
         ## What the extension registers\n\n\
         TODO — scan vendor/ for `pi.registerTool(`, `pi.registerCommand(`, `pi.on(`.\n\n\
         ## Wire methods to map\n\n\
         - pi.registerTool → `tools` in manifest + `tool/call`\n\
         - pi.registerCommand → `commands` + `command/run`\n\
         - pi.on(\"tool_call\"/\"tool_result\") → `tool/before` / `tool/after` hooks\n\
         - pi.on(\"before_agent_start\"/\"context\") → `prompt/context` hook\n\
         - pi.on(\"turn_end\"/session events) → `event/notify` notification\n\n\
         ## Subagent prompt\n\n\
         Read ~/grayplugins/PORTING.md and ~/grayplugins/gray-notify/src/main.rs. \
         Implement npm `{name}` (vendored under {dir_name}/vendor/) as a gray sidecar in {dir_name}/src/main.rs. \
         Steps: cargo test && cargo build --release && gray account check → \"check ok\", \
         README with wire methods + install line, one commit. Do NOT `gray plugin install`.\n"
    );
    let _ = std::fs::write(dest.join("SCAFFOLD-SPEC.md"), &spec);
    Ok(format!(
        "scaffolded {} in {}\n{}\nwrote SCAFFOLD-SPEC.md\n\nImplementation prompt:\n\
         Read ~/grayplugins/PORTING.md and ~/grayplugins/gray-notify/src/main.rs. \
         Implement npm `{name}` (vendored under {dir_name}/vendor/) as a gray sidecar in {dir_name}/src/main.rs; \
         run cargo test && cargo build --release && gray account check; update README; one commit.",
        dir_name, dest.display(), vendored
    ))
}

fn call_tool(name: &str, args: &Value) -> Result<String, String> {
    match name {
        "pi_search" => pi_search(args.get("query").and_then(Value::as_str)),
        "pi_info" => pi_info(args.get("name").and_then(Value::as_str).unwrap_or("")),
        "pi_scaffold" => pi_scaffold(args.get("name").and_then(Value::as_str).unwrap_or("")),
        other => Err(format!("unknown tool: {other}")),
    }
}

/// `/pi search|info|scaffold …` — argv excludes the command name.
fn run_command(argv: &[&str]) -> String {
    match argv {
        ["search", rest @ ..] => pi_search(rest.first().copied()).unwrap_or_else(|e| e),
        ["info", name, ..] => pi_info(name).unwrap_or_else(|e| e),
        ["scaffold", name, ..] => pi_scaffold(name).unwrap_or_else(|e| e),
        _ => "gray-pi-index — /pi search [query] · /pi info <pkg> · /pi scaffold <pkg>".into(),
    }
}

fn handle(req: &Value) -> (Option<Value>, bool) {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);
    let Some(id) = id else {
        return (None, method == "plugin/shutdown");
    };
    let result = match method {
        "plugin/manifest" => manifest(),
        "tool/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("args").cloned().unwrap_or(Value::Null);
            match call_tool(name, &args) {
                Ok(text) => json!({ "content": text }),
                Err(text) => json!({ "content": text, "is_error": true }),
            }
        }
        "command/run" => {
            let argv: Vec<&str> = params
                .get("argv")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            json!({ "text": run_command(&argv) })
        }
        "plugin/shutdown" => return (Some(json!({ "id": id, "result": {} })), true),
        _ => {
            let error = json!({ "code": -32601, "message": "method not found" });
            return (Some(json!({ "id": id, "error": error })), false);
        }
    };
    (Some(json!({ "id": id, "result": result })), false)
}

fn main() -> std::io::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("manifest") {
        println!("{}", manifest());
        return Ok(());
    }
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let (reply, exit) = handle(&req);
        if let Some(reply) = reply {
            writeln!(stdout, "{reply}")?;
            stdout.flush()?;
        }
        if exit {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(method: &str, params: Value) -> Value {
        handle(&json!({ "id": 1, "method": method, "params": params })).0.unwrap()
    }

    #[test]
    fn manifest_has_three_tools_and_pi_command() {
        let m = call("plugin/manifest", Value::Null)["result"].clone();
        assert_eq!(m["name"], "pi-index");
        assert_eq!(m["commands"], json!(["/pi"]));
        let names: Vec<&str> = m["tools"].as_array().unwrap()
            .iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(names, ["pi_search", "pi_info", "pi_scaffold"]);
    }

    #[test]
    fn grayish_names_strip_pi_prefix_and_scope() {
        assert_eq!(grayish_name("pi-lens"), "gray-lens");
        assert_eq!(grayish_name("@moyai/pi-session-hoarder"), "gray-session-hoarder");
        assert_eq!(grayish_name("pi-btw"), "gray-btw");
        assert_eq!(grayish_name("plain"), "gray-plain");
    }

    #[test]
    fn url_encode_handles_scopes() {
        assert_eq!(url_encode("@scope/pkg"), "@scope%2Fpkg");
        assert_eq!(url_encode("pi-lens"), "pi-lens");
    }

    #[test]
    fn compat_status_classifies() {
        let ports = "# Availability tracker\n## done\n- gray-foo ← pi-foo ✅ built\n\
                     ## portable\n- gray-lens ← npm pi-lens: diagnostics\n\
                     ## Not portable (needs wire additions)\n- pi-powerline-footer TUI\n";
        assert_eq!(compat_status("pi-foo", ports), "available → gray-foo");
        assert_eq!(compat_status("pi-lens", ports), "available → gray-lens");
        assert_eq!(compat_status("pi-powerline-footer", ports), "blocked: not portable (needs wire additions)");
        assert_eq!(compat_status("pi-nonexistent", ports), "unavailable");
    }

    #[test]
    fn pi_info_requires_a_name() {
        let r = call("tool/call", json!({ "name": "pi_info", "args": {} }));
        assert_eq!(r["result"]["is_error"], true);
    }

    #[test]
    fn unknown_methods_and_tools_error() {
        assert_eq!(call("nope", Value::Null)["error"]["code"], -32601);
        let r = call("tool/call", json!({ "name": "bogus", "args": {} }));
        assert_eq!(r["result"]["is_error"], true);
    }

    #[test]
    fn bare_pi_command_shows_usage() {
        let r = call("command/run", json!({ "name": "/pi", "argv": [] }));
        assert!(r["result"]["text"].as_str().unwrap().contains("/pi search"));
    }

    #[test]
    fn shutdown_replies_then_exits() {
        let (reply, exit) = handle(&json!({ "id": 2, "method": "plugin/shutdown" }));
        assert!(reply.is_some() && exit);
        let (reply, exit) = handle(&json!({ "method": "plugin/shutdown" }));
        assert!(reply.is_none() && exit);
    }
}
