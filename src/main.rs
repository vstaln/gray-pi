//! gray-pi — pi-compatible ExtensionAPI host on the gray NDJSON wire.
//!
//! TypeScript extension factories are transpiled in-process with oxc and
//! evaluated in an embedded QuickJS (rquickjs) runtime — no Node, no jiti,
//! no external transpiler. The API surface lives in src/prelude.js; Rust
//! provides the wire transport, module resolver/loader, and a small set of
//! `__r_*` host primitives (stdio, /dev/tty, process exec, files).
//!
//! Async model: QuickJS promises are driven to completion with
//! `Promise::finish()` inside each dispatch. Host round-trips (host/ask,
//! host/say) are synchronous — a reader thread feeds a channel; while a
//! host_call waits, unrelated inbound lines are queued for the main loop.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::exit;
use std::rc::Rc;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use oxc_allocator::Allocator;
use oxc_ast::ast::{ImportDeclarationSpecifier, ModuleExportName, Statement};
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};

use rquickjs::function::Func;
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::{Context, Ctx, Exception, Function, Module, Runtime, Value};
use serde_json::{json, Value as J};

const PRELUDE: &str = include_str!("prelude.js");
const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(120);

// ------------------------------------------------------------------ wire

struct Wire {
    rx: Receiver<String>,
    queued: VecDeque<String>,
    seq: u64,
}

fn send_line(v: &J) {
    let stdout = std::io::stdout();
    let mut o = stdout.lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

impl Wire {
    fn next_line(&mut self) -> Option<String> {
        if let Some(l) = self.queued.pop_front() {
            return Some(l);
        }
        self.rx.recv().ok()
    }

    /// Send a `host/*` request, block until its reply arrives. Lines that
    /// aren't our reply are queued for the main loop — nothing is lost.
    fn host_call(&mut self, method: &str, params_json: &str) -> String {
        self.seq += 1;
        let id = format!("q{}", self.seq);
        let params = serde_json::from_str::<J>(params_json).unwrap_or(J::Null);
        send_line(&json!({ "id": id, "method": method, "params": params }));
        let deadline = Instant::now() + HOST_CALL_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return r#"{"error":"timeout"}"#.into();
            }
            match self.rx.recv_timeout(left) {
                Ok(line) => {
                    let Ok(v) = serde_json::from_str::<J>(&line) else {
                        self.queued.push_back(line);
                        continue;
                    };
                    if v.get("id").and_then(J::as_str) == Some(id.as_str()) {
                        return v
                            .get("result")
                            .cloned()
                            .unwrap_or_else(|| json!({"error":"no result"}))
                            .to_string();
                    }
                    self.queued.push_back(line);
                }
                Err(RecvTimeoutError::Timeout) => return r#"{"error":"timeout"}"#.into(),
                Err(RecvTimeoutError::Disconnected) => return r#"{"error":"eof"}"#.into(),
            }
        }
    }
}

// -------------------------------------------------------------- paths/fs

fn gray_home() -> PathBuf {
    std::env::var_os("GRAY_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".gray")))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn extension_files(cwd: &str) -> Vec<String> {
    let dirs = [
        Path::new(if cwd.is_empty() { "." } else { cwd })
            .join(".pi")
            .join("extensions"),
        home_dir().join(".pi").join("agent").join("extensions"),
        gray_home().join("pi").join("extensions"),
    ];
    let mut files = Vec::new();
    for d in &dirs {
        if let Ok(rd) = std::fs::read_dir(d) {
            let mut names: Vec<String> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|f| {
                    (f.ends_with(".ts") || f.ends_with(".mjs") || f.ends_with(".js"))
                        && !f.ends_with(".d.ts")
                })
                .collect();
            names.sort();
            for n in names {
                files.push(d.join(&n).to_string_lossy().into_owned());
            }
        }
    }
    files
}

// -------------------------------------------------------------- transpile

#[derive(Default, Clone)]
struct ShimUse {
    names: BTreeSet<String>,
    default: bool,
}

/// Per-generation JS state shared between the loader, the resolver and the
/// `__r_load_module` function.
#[derive(Default)]
struct Shared {
    /// bare specifier -> requested export names (for shim synthesis)
    imports: HashMap<String, ShimUse>,
    /// absolute path -> transpiled JS (populated by the pre-scan)
    transpiled: HashMap<String, String>,
    /// absolute path -> relative import specifiers (for the dep scan)
    rel_imports: HashMap<String, Vec<String>>,
    /// visited set for the recursive dep scan
    scanned: BTreeSet<String>,
    /// the wire (for host calls made from inside the engine)
    wire: Option<Rc<RefCell<Wire>>>,
}

fn export_name(n: &ModuleExportName) -> String {
    match n {
        ModuleExportName::IdentifierName(i) => i.name.to_string(),
        ModuleExportName::IdentifierReference(i) => i.name.to_string(),
        ModuleExportName::StringLiteral(s) => s.value.to_string(),
    }
}

/// Record the runtime-needed imports of a (post-transform) program so the
/// loader can synthesize shim modules exporting exactly those names.
/// Relative specifiers land in `rel_imports` so the pre-scan can recurse.
fn collect_imports(program: &oxc_ast::ast::Program, path: &str, shared: &mut Shared) {
    for stmt in &program.body {
        match stmt {
            Statement::ImportDeclaration(d) => {
                let spec = d.source.value.to_string();
                if spec.starts_with('.') || spec.starts_with('/') {
                    shared.rel_imports.entry(path.to_string()).or_default().push(spec);
                    continue;
                }
                let e = shared.imports.entry(spec).or_default();
                if let Some(specs) = &d.specifiers {
                    for s in specs {
                        match s {
                            ImportDeclarationSpecifier::ImportSpecifier(sp) => {
                                e.names.insert(export_name(&sp.imported));
                            }
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => {
                                e.default = true;
                            }
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {}
                        }
                    }
                }
            }
            Statement::ExportFromDeclaration(d) => {
                let spec = d.source.value.to_string();
                if spec.starts_with('.') || spec.starts_with('/') {
                    shared.rel_imports.entry(path.to_string()).or_default().push(spec);
                    continue;
                }
                let e = shared.imports.entry(spec).or_default();
                for s in &d.specifiers {
                    e.names.insert(export_name(&s.local));
                }
            }
            Statement::ExportAllDeclaration(d) => {
                let spec = d.source.value.to_string();
                if spec.starts_with('.') || spec.starts_with('/') {
                    shared.rel_imports.entry(path.to_string()).or_default().push(spec);
                } else {
                    shared.imports.entry(spec).or_default();
                }
            }
            _ => {}
        }
    }
}

fn transpile_source(path: &str, src: &str, shared: &Rc<RefCell<Shared>>) -> Result<String, String> {
    let allocator = Allocator::new();
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::mjs());
    let ret = Parser::new(&allocator, src, source_type).parse();
    if ret.panicked || !ret.diagnostics.is_empty() {
        let msgs: Vec<String> = ret.diagnostics.iter().map(|d| d.to_string()).collect();
        return Err(format!("parse: {}", msgs.join("; ")));
    }
    let mut program = ret.program;
    let scoping = SemanticBuilder::new()
        .build(&program)
        .semantic
        .into_scoping();
    let options = TransformOptions::default();
    let tret = Transformer::new(&allocator, Path::new(path), &options)
        .build_with_scoping(scoping, &mut program);
    if !tret.diagnostics.is_empty() {
        let msgs: Vec<String> = tret.diagnostics.iter().map(|d| d.to_string()).collect();
        return Err(format!("transform: {}", msgs.join("; ")));
    }
    collect_imports(&program, path, &mut shared.borrow_mut());
    Ok(Codegen::new().build(&program).code)
}

fn transpile_file(path: &str, shared: &Rc<RefCell<Shared>>) -> Result<String, String> {
    if let Some(js) = shared.borrow().transpiled.get(path) {
        return Ok(js.clone());
    }
    let src = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    let js = transpile_source(path, &src, shared)?;
    shared
        .borrow_mut()
        .transpiled
        .insert(path.to_string(), js.clone());
    Ok(js)
}

/// Resolve a relative specifier against an importing file. Returns the first
/// existing candidate (bare, .ts, .js, .mjs, /index.ts, /index.js).
fn resolve_relative(base_file: &str, spec: &str) -> Option<String> {
    let base_dir = Path::new(base_file).parent().unwrap_or(Path::new("/"));
    let joined = if Path::new(spec).is_absolute() {
        PathBuf::from(spec)
    } else {
        base_dir.join(spec)
    };
    let norm = |p: PathBuf| p.to_string_lossy().into_owned();
    let cands = [
        joined.clone(),
        joined.with_extension("ts"),
        joined.with_extension("js"),
        joined.with_extension("mjs"),
        joined.join("index.ts"),
        joined.join("index.js"),
    ];
    cands.iter().find(|c| c.is_file()).map(|c| norm(c.clone()))
}

/// Pre-transpile every entry-point extension (and its relative deps) so the
/// union of names each shim must export is known before any module links.
fn scan_extensions(files: &[String], shared: &Rc<RefCell<Shared>>) {
    let mut work: Vec<String> = files.to_vec();
    while let Some(path) = work.pop() {
        if !shared.borrow_mut().scanned.insert(path.clone()) {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(&path) else { continue };
        let Ok(js) = transpile_source(&path, &src, shared) else { continue };
        shared.borrow_mut().transpiled.insert(path.clone(), js);
        // recurse into relative imports discovered in this file
        let rel_specs = shared.borrow().rel_imports.get(&path).cloned().unwrap_or_default();
        for s in rel_specs {
            if let Some(dep) = resolve_relative(&path, &s) {
                work.push(dep);
            }
        }
    }
}

// ------------------------------------------------------------- js engine

struct PiResolver;
impl Resolver for PiResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attrs: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        if name.starts_with('.') || name.starts_with('/') {
            if let Some(p) = resolve_relative(base, name) {
                return Ok(p);
            }
            let dir = Path::new(base).parent().unwrap_or(Path::new("/"));
            return Ok(dir.join(name).to_string_lossy().into_owned());
        }
        Ok(format!("__shim:{name}"))
    }
}

struct PiLoader {
    shared: Rc<RefCell<Shared>>,
}

fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        && !s.chars().next().unwrap().is_ascii_digit()
}

/// ESM source for a stub/curated module: every requested export is either the
/// curated implementation or a deep-inert stub.
fn shim_source(spec: &str, use_: &ShimUse) -> String {
    let mut s = String::new();
    s.push_str("const __c = (globalThis.__curated && globalThis.__curated[");
    s.push_str(&serde_json::to_string(spec).unwrap());
    s.push_str("]) || {};\nconst __x = (n) => __c[n] !== undefined ? __c[n] : globalThis.__stub(");
    s.push_str(&serde_json::to_string(spec).unwrap());
    s.push_str(" + \".\" + String(n));\n");
    let mut i = 0;
    for n in &use_.names {
        let tmp = format!("__v{i}");
        i += 1;
        s.push_str(&format!("const {tmp} = __x({});\n", serde_json::to_string(n).unwrap()));
        if is_ident(n) {
            s.push_str(&format!("export {{ {tmp} as {n} }};\n"));
        } else {
            s.push_str(&format!("export {{ {tmp} as {} }};\n", serde_json::to_string(n).unwrap()));
        }
    }
    if use_.default {
        s.push_str("export default __x(\"default\");\n");
    }
    if use_.names.is_empty() && !use_.default {
        s.push_str("export {};\n");
    }
    s
}

impl Loader for PiLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attrs: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, Declared>> {
        if let Some(spec) = name.strip_prefix("__shim:") {
            let src = {
                let sh = self.shared.borrow();
                let u = sh.imports.get(spec).cloned();
                drop(sh);
                let u = u.unwrap_or_default();
                shim_source(spec, &u)
            };
            return Module::declare(ctx.clone(), name, src.as_bytes());
        }
        let js = match transpile_file(name, &self.shared) {
            Ok(js) => js,
            Err(e) => return Err(js_err(ctx, &e)),
        };
        Module::declare(ctx.clone(), name, js.as_bytes())
    }
}

struct Engine {
    #[allow(dead_code)]
    rt: Runtime,
    ctx: Context,
}

fn js_err(ctx: &Ctx, msg: &str) -> rquickjs::Error {
    match Exception::from_message(ctx.clone(), msg) {
        Ok(ex) => ex.throw(),
        Err(_) => rquickjs::Error::Exception,
    }
}

/// Stringify a caught JS error: prefer `e.stack`, then `e.message`, then str.
fn err_to_string(ctx: &Ctx, e: rquickjs::Error) -> String {
    match e {
        rquickjs::Error::Exception => {
            let v = ctx.catch();
            if let Some(o) = v.as_object() {
                if let Ok(s) = o.get::<_, String>("stack") {
                    return s;
                }
                if let Ok(s) = o.get::<_, String>("message") {
                    return s;
                }
            }
            let f: Result<Function, _> = ctx.eval("(v)=>String(v)");
            match f {
                Ok(f) => f.call::<_, String>((v,)).unwrap_or_else(|_| "js error".into()),
                Err(_) => "js error".into(),
            }
        }
        other => other.to_string(),
    }
}

fn register_globals<'js>(ctx: &Ctx<'js>, wire: &Rc<RefCell<Wire>>, shared: &Rc<RefCell<Shared>>) -> rquickjs::Result<()> {
    let g = ctx.globals();

    g.set("__r_send", Func::new(|s: String| send_line(&J::String(s))))?;
    g.set("__r_log", Func::new(|s: String| eprintln!("{s}")))?;
    g.set("__R_VERSION", env!("CARGO_PKG_VERSION"))?;

    {
        let w = wire.clone();
        g.set("__r_host_call", Func::new(move |m: String, p: String| -> String {
            w.borrow_mut().host_call(&m, &p)
        }))?;
    }

    g.set("__r_tty", Func::new(|s: String| -> bool {
        std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/tty")
            .and_then(|mut f| f.write_all(s.as_bytes()).and_then(|_| f.flush()))
            .is_ok()
    }))?;

    g.set("__r_exec", Func::new(|cmd: String, args: String, opts: String| -> String {
        exec_impl(&cmd, &args, &opts)
    }))?;

    g.set("__r_read_file", Func::new(|p: String| -> Option<String> {
        std::fs::read_to_string(&p).ok()
    }))?;
    g.set("__r_write_file", Func::new(|p: String, d: String| -> bool {
        std::fs::write(&p, d).is_ok()
    }))?;
    g.set("__r_append_file", Func::new(|p: String, d: String| -> bool {
        std::fs::OpenOptions::new().create(true).append(true).open(&p)
            .and_then(|mut f| f.write_all(d.as_bytes())).is_ok()
    }))?;
    g.set("__r_exists", Func::new(|p: String| -> bool { Path::new(&p).exists() }))?;
    g.set("__r_mkdir_p", Func::new(|p: String| -> bool {
        std::fs::create_dir_all(&p).is_ok()
    }))?;
    g.set("__r_rm", Func::new(|p: String| -> bool {
        let path = Path::new(&p);
        if path.is_dir() { std::fs::remove_dir_all(path).is_ok() } else { std::fs::remove_file(path).is_ok() }
    }))?;
    g.set("__r_stat", Func::new(|p: String| -> String {
        match std::fs::metadata(&p) {
            Ok(m) => json!({
                "file": m.is_file(), "dir": m.is_dir(), "size": m.len(),
                "mtime_ms": m.modified().ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64).unwrap_or(0)
            }).to_string(),
            Err(_) => "null".into(),
        }
    }))?;
    g.set("__r_readdir", Func::new(|p: String| -> String {
        match std::fs::read_dir(&p) {
            Ok(rd) => J::Array(rd.filter_map(|e| e.ok())
                .map(|e| J::String(e.file_name().to_string_lossy().into_owned())).collect()).to_string(),
            Err(_) => "null".into(),
        }
    }))?;
    g.set("__r_env", Func::new(|n: String| -> Option<String> {
        std::env::var(&n).ok()
    }))?;
    g.set("__r_env_all", Func::new(|| -> String {
        J::Object(std::env::vars().map(|(k, v)| (k, J::String(v))).collect()).to_string()
    }))?;
    g.set("__r_home", Func::new(|| home_dir().to_string_lossy().into_owned()))?;
    g.set("__r_tmpdir", Func::new(|| std::env::temp_dir().to_string_lossy().into_owned()))?;
    g.set("__r_cwd", Func::new(|| {
        std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".into())
    }))?;
    g.set("__r_entries_path", Func::new(|| {
        gray_home().join("pi").join("entries.jsonl").to_string_lossy().into_owned()
    }))?;
    g.set("__r_open_editor", Func::new(|p: String| -> bool {
        open_editor(&p)
    }))?;

    {
        let sh = shared.clone();
        g.set("__r_extension_files", Func::new(move |cwd: String| -> String {
            let files = extension_files(&cwd);
            scan_extensions(&files, &sh);
            J::Array(files.into_iter().map(J::String).collect()).to_string()
        }))?;
    }

    {
        let sh = shared.clone();
        g.set("__r_load_module", Func::new(move |ctx: Ctx<'js>, path: String| -> rquickjs::Result<Value<'js>> {
            let js = transpile_file(&path, &sh).map_err(|e| js_err(&ctx, &e))?;
            let module = Module::declare(ctx.clone(), path.as_bytes(), js.as_bytes())
                .map_err(|e| js_err(&ctx, &err_to_string(&ctx, e)))?;
            let (module, promise) = module.eval().map_err(|e| js_err(&ctx, &err_to_string(&ctx, e)))?;
            promise.finish::<()>().map_err(|e| js_err(&ctx, &err_to_string(&ctx, e)))?;
            Ok(module.namespace()?.into_value())
        }))?;
    }

    Ok(())
}

fn exec_impl(cmd: &str, args_json: &str, opts_json: &str) -> String {
    let args: Vec<String> = serde_json::from_str(args_json).unwrap_or_default();
    let opts: J = serde_json::from_str(opts_json).unwrap_or(J::Null);
    let timeout_secs = opts.get("timeout").and_then(J::as_u64).unwrap_or(120);
    let mut c = std::process::Command::new(cmd);
    c.args(&args).stdin(std::process::Stdio::null());
    if let Some(cwd) = opts.get("cwd").and_then(J::as_str) {
        c.current_dir(cwd);
    }
    if let Some(env) = opts.get("env").and_then(J::as_object) {
        for (k, v) in env {
            if let Some(s) = v.as_str() { c.env(k, s); }
        }
    }
    c.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    match c.spawn() {
        Err(e) => json!({"stdout":"","stderr":e.to_string(),"code":1,"killed":false}).to_string(),
        Ok(mut child) => loop {
            match child.try_wait() {
                Ok(Some(_)) => {
                    return match child.wait_with_output() {
                        Ok(out) => json!({
                            "stdout": String::from_utf8_lossy(&out.stdout),
                            "stderr": String::from_utf8_lossy(&out.stderr),
                            "code": out.status.code().unwrap_or(-1),
                            "killed": false,
                        }).to_string(),
                        Err(e) => json!({"stdout":"","stderr":e.to_string(),"code":1,"killed":false}).to_string(),
                    };
                }
                Ok(None) => {
                    if Instant::now() > deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return json!({"stdout":"","stderr":"timeout","code":124,"killed":true}).to_string();
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return json!({"stdout":"","stderr":e.to_string(),"code":1,"killed":false}).to_string(),
            }
        },
    }
}

fn open_editor(path: &str) -> bool {
    let editor = std::env::var("EDITOR").unwrap_or_else(|_| "vi".into());
    let Ok(tty_r) = std::fs::File::open("/dev/tty") else { return false };
    let Ok(tty_w) = std::fs::OpenOptions::new().write(true).open("/dev/tty") else { return false };
    let Ok(tty_w2) = std::fs::OpenOptions::new().write(true).open("/dev/tty") else { return false };
    std::process::Command::new(editor)
        .arg(path)
        .stdin(tty_r).stdout(tty_w).stderr(tty_w2)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

impl Engine {
    fn new(wire: Rc<RefCell<Wire>>) -> Result<Engine, String> {
        let rt = Runtime::new().map_err(|e| e.to_string())?;
        let shared = Rc::new(RefCell::new(Shared {
            wire: Some(wire),
            ..Default::default()
        }));
        rt.set_loader(PiResolver, PiLoader { shared: shared.clone() });
        let ctx = Context::full(&rt).map_err(|e| e.to_string())?;
        ctx.with(|ctx| -> Result<(), String> {
            register_globals(&ctx, &shared.borrow().wire.as_ref().unwrap().clone(), &shared)
                .map_err(|e| err_to_string(&ctx, e))?;
            ctx.eval::<(), _>(PRELUDE).map_err(|e| err_to_string(&ctx, e))?;
            Ok(())
        })?;
        Ok(Engine { rt, ctx })
    }

    /// Call a JS entry (`__dispatch`/`__notify`), driving promises to
    /// completion; returns the JSON-stringified result.
    fn call_json(&self, entry: &str, arg: &str) -> Result<String, String> {
        self.ctx.with(|ctx| -> Result<String, String> {
            let f: Function = ctx
                .globals()
                .get(entry)
                .map_err(|e| err_to_string(&ctx, e))?;
            let v: Value = f
                .call((arg.to_string(),))
                .map_err(|e| err_to_string(&ctx, e))?;
            let out: Value = if let Some(p) = v.as_promise() {
                p.finish::<Value>().map_err(|e| err_to_string(&ctx, e))?
            } else {
                v
            };
            match ctx.json_stringify(out).map_err(|e| err_to_string(&ctx, e))? {
                Some(s) => Ok(s.to_string().map_err(|e| e.to_string())?),
                None => Ok("null".into()),
            }
        })
    }
}

// ------------------------------------------------------------------ main

fn dispatch_frame(engine: &Engine, id: &J, method: &str, params: &J) -> J {
    let arg = json!({"method": method, "params": params}).to_string();
    match engine.call_json("__dispatch", &arg) {
        Ok(s) => {
            let v: J = serde_json::from_str(&s).unwrap_or(json!({"ok":false,"error":"bad dispatch reply"}));
            if v.get("ok").and_then(J::as_bool).unwrap_or(false) {
                json!({ "id": id, "result": v.get("result").cloned().unwrap_or(J::Null) })
            } else {
                json!({ "id": id, "error": {"code": -32601, "message": v.get("error").cloned().unwrap_or(J::Null)} })
            }
        }
        Err(e) => json!({ "id": id, "error": {"code": -32601, "message": e} }),
    }
}

fn run() -> i32 {
    let arg = std::env::args().nth(1);

    // stdin reader thread — pushes lines into a channel. Never joined: it
    // dies with the process (may be blocked on stdin at exit).
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });

    let wire = Rc::new(RefCell::new(Wire { rx, queued: VecDeque::new(), seq: 0 }));
    let mut engine = match Engine::new(wire.clone()) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("gray-pi: engine init failed: {e}");
            return 2;
        }
    };

    match arg.as_deref() {
        Some("manifest") => {
            let v = dispatch_frame(&engine, &J::Null, "plugin/manifest", &json!({}));
            if let Some(r) = v.get("result") {
                println!("{r}");
            } else {
                println!("{}", json!({"name":"pi-ext","version":env!("CARGO_PKG_VERSION"),"protocol":"2.0","tools":[{"name":"pi_search","description":"Search the pi package/extension ecosystem on npm (keywords:pi-package + keywords:pi-extension). Optional `query` narrows results. Results are cached into ~/.gray/pi-index/index.json.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"Optional search terms."}}}},{"name":"pi_info","description":"Registry details for one npm package plus local availability status cross-referenced against ~/grayplugins/PORTS.md.","parameters":{"type":"object","properties":{"name":{"type":"string","description":"npm package name, e.g. pi-lens or @scope/pkg."}},"required":["name"]}},{"name":"pi_scaffold","description":"Scaffold a compatible sidecar: `gray account new` for the package, vendor its npm tarball into vendor/, and write SCAFFOLD-SPEC.md.","parameters":{"type":"object","properties":{"name":{"type":"string","description":"npm package name to scaffold a sidecar for."}},"required":["name"]}}],"commands":["/pi"],"hooks":[],"capabilities":[]}));
            }
            return 0;
        }
        Some("widget") => {
            let text = engine
                .call_json("__widgetText", "")
                .ok()
                .and_then(|s| serde_json::from_str::<J>(&s).ok())
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "⬢ pi".into());
            println!("{}", json!({"version":1,"text":text,"shimmer_lines":[]}));
            return 0;
        }
        Some("setup") => {
            println!("embedded QuickJS engine — nothing to provision");
            return 0;
        }
        _ => {}
    }

    loop {
        let line = {
            let mut w = wire.borrow_mut();
            w.next_line()
        };
        let Some(line) = line else { break }; // stdin closed
        let Ok(msg) = serde_json::from_str::<J>(&line) else { continue };
        if !msg.is_object() {
            continue;
        }
        // stray host/* replies (id is a string) — consume and drop
        if msg.get("id").and_then(J::as_str).is_some() {
            continue;
        }
        let method = msg.get("method").and_then(J::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(J::Null);
        let id = msg.get("id").cloned();
        match id {
            None => {
                // notification — never reply, never fail loudly
                let _ = engine.call_json("__notify", &json!({"method":method,"params":params}).to_string());
            }
            Some(id) => {
                let reply = dispatch_frame(&engine, &id, method, &params);
                // /pi reload → rebuild the engine, force a fresh loadAll,
                // and answer with the same summary the .mjs produced.
                if reply
                    .get("result")
                    .and_then(|r| r.get("__reload"))
                    .and_then(J::as_bool)
                    .unwrap_or(false)
                {
                    let text;
                    match Engine::new(wire.clone()) {
                        Ok(e2) => {
                            engine = e2;
                            let mf = dispatch_frame(&engine, &id, "plugin/manifest", &params);
                            let r = mf.get("result").cloned().unwrap_or(J::Null);
                            let tools = r.get("tools").and_then(J::as_array).map(|a| a.len()).unwrap_or(0);
                            let cmds = r.get("commands").and_then(J::as_array).map(|a| a.len().saturating_sub(1)).unwrap_or(0);
                            let errs = engine.call_json("__loadErrors", "").ok()
                                .and_then(|s| serde_json::from_str::<J>(&s).ok())
                                .and_then(|v| v.as_array().map(|a| a.len())).unwrap_or(0);
                            text = format!("reloaded — {tools} tools, {cmds} commands{}{}",
                                if errs > 0 { ", " } else { "" },
                                if errs > 0 { format!("{errs} errors") } else { String::new() });
                        }
                        Err(e) => text = format!("reload failed: {e}"),
                    }
                    send_line(&json!({ "id": id, "result": {"text": text} }));
                } else {
                    send_line(&reply);
                }
                if method == "plugin/shutdown" {
                    return 0;
                }
            }
        }
    }
    0
}

fn main() {
    // QA: stderr must never contain "panic". Route panics to a plain line.
    std::panic::set_hook(Box::new(|i| eprintln!("gray-pi fatal: {}", i.payload().downcast_ref::<&str>().map(|s| *s).or_else(|| i.payload().downcast_ref::<String>().map(|s| s.as_str())).unwrap_or("panic payload"))));
    let code = std::panic::catch_unwind(run).unwrap_or(101);
    exit(code);
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> (Engine, Rc<RefCell<Wire>>) {
        let (_tx, rx) = channel::<String>();
        let wire = Rc::new(RefCell::new(Wire { rx, queued: VecDeque::new(), seq: 0 }));
        let e = Engine::new(wire.clone()).expect("engine");
        (e, wire)
    }

    #[test]
    fn transpile_strips_types() {
        let sh = Rc::new(RefCell::new(Shared::default()));
        let js = transpile_source(
            "/tmp/x.ts",
            "interface Foo { a: number }\nexport default function f(pi: { on(e:string,h:()=>void):void }): void { pi.on(\"x\", () => {}); }\n",
            &sh,
        )
        .expect("transpile");
        assert!(!js.contains("interface"), "types left: {js}");
        assert!(js.contains("export default"), "esm kept: {js}");
    }

    #[test]
    fn collect_names_for_shim() {
        let sh = Rc::new(RefCell::new(Shared::default()));
        let _ = transpile_source(
            "/tmp/y.ts",
            "import { Type } from \"typebox\";\nimport type { Foo } from \"@earendil-works/pi-coding-agent\";\nimport { StringEnum } from \"@earendil-works/pi-ai\";\nexport default function() { return StringEnum([\"a\"], Type.String()); }\n",
            &sh,
        )
        .unwrap();
        let sh = sh.borrow();
        assert!(sh.imports["typebox"].names.contains("Type"));
        assert!(sh.imports["@earendil-works/pi-ai"].names.contains("StringEnum"));
        // type-only import stripped — never requested at runtime
        assert!(!sh.imports.contains_key("@earendil-works/pi-coding-agent")
            || sh.imports["@earendil-works/pi-coding-agent"].names.is_empty());
    }

    #[test]
    fn manifest_and_tool_roundtrip() {
        let dir = std::env::temp_dir().join(format!("gray-pi-test-{}", std::process::id()));
        let ext = dir.join(".pi/extensions");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(
            ext.join("mini.ts"),
            r#"import { Type } from "typebox";
export default function (pi: any) {
    pi.registerTool({
        name: "echo", description: "echo args",
        parameters: Type.Object({ msg: Type.String() }),
        async execute(_id: string, params: any) {
            return { content: [{ type: "text", text: "echo:" + JSON.stringify(params) }] };
        },
    });
    pi.registerCommand("mini", { description: "d", handler: async () => "mini-out" });
}
"#,
        )
        .unwrap();
        let (e, _w) = engine();
        let mf = dispatch_frame(&e, &J::from(1), "plugin/manifest",
            &json!({"cwd": dir.to_string_lossy()}));
        let r = mf.get("result").unwrap();
        assert_eq!(r["name"], "pi-ext");
        let tools = r["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "echo"), "manifest: {r}");
        let out = dispatch_frame(&e, &J::from(2), "tool/call",
            &json!({"name":"echo","args":{"msg":"hi"}}));
        assert_eq!(out["result"]["content"], "echo:{\"msg\":\"hi\"}");
        let out = dispatch_frame(&e, &J::from(3), "command/run",
            &json!({"name":"/mini","argv":[],"session":{"id":"t","cwd":"/tmp"}}));
        assert_eq!(out["result"]["text"], "mini-out");
        let out = dispatch_frame(&e, &J::from(4), "tool/before",
            &json!({"name":"x","args":{},"session":{}}));
        assert_eq!(out["result"]["decision"], "allow");
        let out = dispatch_frame(&e, &J::from(5), "tool/call",
            &json!({"name":"nope","args":{}}));
        assert!(out.get("error").is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn broken_extension_does_not_kill_engine() {
        let dir = std::env::temp_dir().join(format!("gray-pi-bad-{}", std::process::id()));
        let ext = dir.join(".pi/extensions");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("bad.ts"), "export default function() { throw new Error('boom'); }\n").unwrap();
        std::fs::write(
            ext.join("good.ts"),
            "export default function(pi: any) { pi.registerTool({name:'ok',description:'d',parameters:{},execute(){return {content:'fine'}}}); }\n",
        )
        .unwrap();
        let (e, _w) = engine();
        let mf = dispatch_frame(&e, &J::from(1), "plugin/manifest",
            &json!({"cwd": dir.to_string_lossy()}));
        let tools = mf["result"]["tools"].as_array().unwrap().clone();
        assert!(tools.iter().any(|t| t["name"] == "ok"), "{mf}");
        let out = dispatch_frame(&e, &J::from(2), "tool/call", &json!({"name":"ok","args":{}}));
        assert_eq!(out["result"]["content"], "fine");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bundled_index_tools() {
        let (e, _w) = engine();
        let mf = dispatch_frame(&e, &J::from(1), "plugin/manifest", &json!({}));
        let tools = mf["result"]["tools"].as_array().unwrap();
        for n in ["pi_search", "pi_info", "pi_scaffold"] {
            assert!(tools.iter().any(|t| t["name"] == n), "missing {n}: {mf}");
        }
        // /pi usage advertises the index subcommands
        let out = dispatch_frame(&e, &J::from(2), "command/run",
            &json!({"name":"/pi","argv":["bogus"],"session":{"id":"t","cwd":"/tmp"}}));
        let text = out["result"]["text"].as_str().unwrap_or("");
        assert!(text.contains("scaffold"), "{text}");
        // /pi info with no name → friendly error text, no network needed
        let out = dispatch_frame(&e, &J::from(3), "command/run",
            &json!({"name":"/pi","argv":["info"],"session":{"id":"t","cwd":"/tmp"}}));
        assert!(out["result"]["text"].as_str().unwrap_or("").contains("missing required argument"), "{out}");
        // tool/call path: validation error surfaces as content + is_error
        let out = dispatch_frame(&e, &J::from(4), "tool/call",
            &json!({"name":"pi_info","args":{}}));
        assert_eq!(out["result"]["is_error"], J::Bool(true), "{out}");
        assert!(out["result"]["content"].as_str().unwrap_or("").contains("missing required argument"), "{out}");
        // unknown tools still error through the JS dispatcher
        let out = dispatch_frame(&e, &J::from(5), "tool/call", &json!({"name":"bogus","args":{}}));
        assert!(out.get("error").is_some(), "{out}");
    }
}
