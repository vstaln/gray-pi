// gray-pi prelude — the pi ExtensionAPI surface, running inside QuickJS.
// Mirrors reference/gray-pi.mjs. Host primitives (__r_*) are Rust:
//   __r_send(line)            write one NDJSON frame to stdout
//   __r_log(s)                stderr
//   __r_host_call(m, pJson)   blocking host/* round-trip -> result JSON
//   __r_tty(s)                write to /dev/tty -> bool
//   __r_exec(cmd,args,opts)   -> {stdout,stderr,code,killed} JSON
//   __r_read_file / __r_write_file / __r_append_file / __r_exists /
//   __r_mkdir_p / __r_readdir / __r_env / __r_env_all / __r_home /
//   __r_tmpdir / __r_cwd / __r_open_editor / __r_entries_path /
//   __r_extension_files(cwd)  extension scan -> JSON array of paths
//   __r_load_module(path)     transpile+eval an extension file -> namespace

"use strict";

// ---------------------------------------------------------------- shims
// Console / timers / encoders missing from bare QuickJS.
const console = globalThis.console = {
	log: (...a) => __r_log(a.map(String).join(" ")),
	info: (...a) => __r_log(a.map(String).join(" ")),
	warn: (...a) => __r_log(a.map(String).join(" ")),
	error: (...a) => __r_log(a.map(String).join(" ")),
	debug: (...a) => __r_log(a.map(String).join(" ")),
};
if (typeof globalThis.queueMicrotask !== "function")
	globalThis.queueMicrotask = (fn) => Promise.resolve().then(fn);
globalThis.setTimeout = (fn, _ms, ...a) => { Promise.resolve().then(() => fn(...a)); return 1; };
globalThis.clearTimeout = () => {};
globalThis.setInterval = (fn, _ms, ...a) => { Promise.resolve().then(() => fn(...a)); return 1; };
globalThis.clearInterval = () => {};
if (typeof globalThis.structuredClone !== "function")
	globalThis.structuredClone = (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o)));
if (typeof globalThis.TextEncoder !== "function") {
	globalThis.TextEncoder = class { encode(s) { const b = unescape(encodeURIComponent(String(s))); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; } };
	globalThis.TextDecoder = class { decode(u) { let s = ""; for (const c of new Uint8Array(u || [])) s += String.fromCharCode(c); return decodeURIComponent(escape(s)); } };
}
const __envSnapshot = JSON.parse(__r_env_all());
globalThis.process = globalThis.process || {
	env: __envSnapshot,
	argv: ["gray-pi"], pid: 0, platform: "linux",
	cwd: () => __r_cwd(),
	homedir: () => __r_home(),
	stdout: { write: () => {} }, stderr: { write: (s) => __r_log(String(s)) },
};

// Deep-inert stub: callable, constructible, any property is another stub.
// `then` deliberately returns undefined so awaiting a stub is harmless.
const __stub = (globalThis.__stub = (() => {
	const make = (path) => {
		const fn = function () { return make(path); };
		return new Proxy(fn, {
			get(t, p) {
				if (p === "then" || p === "catch" || p === "finally") return undefined;
				if (p === Symbol.toPrimitive) return () => path;
				if (p === "prototype") return make(path + ".prototype");
				if (p === Symbol.iterator) return function* () {};
				if (p === "length" || p === "name") return path;
				return make(path + "." + String(p));
			},
			set: () => true,
			has: () => true,
			construct: () => make(path + "()"),
			apply: () => make(path + "()"),
		});
	};
	return make;
})());

// ---------------------------------------------------------------- typebox
const __T_OPT = Symbol("optional");
const Type = {
	Object: (p, o = {}) => {
		const required = Object.keys(p).filter((k) => !(p[k] && p[k][__T_OPT]));
		return { type: "object", properties: p, ...(required.length ? { required } : {}), ...o };
	},
	String: (o = {}) => ({ type: "string", ...o }),
	Number: (o = {}) => ({ type: "number", ...o }),
	Integer: (o = {}) => ({ type: "integer", ...o }),
	Boolean: (o = {}) => ({ type: "boolean", ...o }),
	Null: (o = {}) => ({ type: "null", ...o }),
	Array: (v, o = {}) => ({ type: "array", items: v, ...o }),
	Optional: (v) => ({ ...v, [__T_OPT]: true }),
	Readonly: (v) => v,
	Union: (items, o = {}) => ({ anyOf: items, ...o }),
	Literal: (v, o = {}) => ({ const: v, ...o }),
	Enum: (e, o = {}) => ({ enum: Object.values(e), ...o }),
	Record: (k, v, o = {}) => ({ type: "object", additionalProperties: v, ...o }),
	Any: (o = {}) => ({ ...o }),
	Unknown: (o = {}) => ({ ...o }),
	Never: (o = {}) => ({ not: {}, ...o }),
	Void: (o = {}) => ({ type: "null", ...o }),
	Function: (o = {}) => ({ ...o }),
	Tuple: (items, o = {}) => ({ type: "array", items, ...o }),
	Intersect: (items, o = {}) => ({ allOf: items, ...o }),
};
const StringEnum = (values, o = {}) => ({ type: "string", enum: [...values], ...o });

// pi-tui bits used by extension render callbacks.
class TuiText {
	constructor(text, x = 0, y = 0) { this.text = String(text); this.x = x; this.y = y; }
	render() { return this.text.split("\n"); }
	invalidate() {}
}
const __visibleWidth = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
const __truncateToWidth = (s, w) => { const v = String(s); return __visibleWidth(v) <= w ? v : v.slice(0, w); };
const __matchesKey = (data, key) => {
	const map = { escape: "\x1b", "ctrl+c": "\x03", return: "\r", enter: "\r", tab: "\t", backspace: "\x7f", space: " ", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C" };
	return String(data) === (map[key] ?? key);
};

// node:* / bare-module curated surface. Anything not listed here resolves to
// an inert stub per missing export (see loader).
const __join = (...a) => {
	let p = a.filter((x) => x && x !== ".").join("/").replace(/\/+/g, "/");
	const parts = [];
	for (const seg of p.split("/")) {
		if (seg === "..") { if (parts.length && parts[parts.length - 1] !== "..") parts.pop(); else if (!p.startsWith("/")) parts.push(".."); }
		else if (seg !== "." && seg !== "") parts.push(seg);
	}
	return (p.startsWith("/") ? "/" : "") + parts.join("/") || (p.startsWith("/") ? "/" : ".");
};
const pathImpl = {
	sep: "/", delimiter: ":",
	join: __join,
	normalize: __join,
	resolve: (...a) => __join(__r_cwd(), ...a),
	dirname: (p) => { p = String(p).replace(/\/+$/, ""); const i = p.lastIndexOf("/"); return i < 0 ? "." : i === 0 ? "/" : p.slice(0, i); },
	basename: (p, ext) => { let b = String(p).split("/").pop() || ""; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
	extname: (p) => { const b = String(p).split("/").pop() || ""; const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; },
	isAbsolute: (p) => String(p).startsWith("/"),
	parse: (p) => ({ root: "/", dir: pathImpl.dirname(p), base: pathImpl.basename(p), ext: pathImpl.extname(p), name: pathImpl.basename(p, pathImpl.extname(p)) }),
};
const fsImpl = {
	readFileSync: (p, enc) => { const s = __r_read_file(String(p)); if (s === null || s === undefined) throw new Error(`ENOENT: ${p}`); return enc ? s : s; },
	writeFileSync: (p, d) => { if (!__r_write_file(String(p), String(d))) throw new Error(`write failed: ${p}`); },
	appendFileSync: (p, d) => { if (!__r_append_file(String(p), String(d))) throw new Error(`append failed: ${p}`); },
	existsSync: (p) => __r_exists(String(p)),
	mkdirSync: (p, o) => { if (!__r_mkdir_p(String(p))) throw new Error(`mkdir failed: ${p}`); },
	readdirSync: (p) => { const r = JSON.parse(__r_readdir(String(p)) || "null"); if (!r) throw new Error(`ENOTDIR: ${p}`); return r; },
	statSync: (p) => { const r = JSON.parse(__r_stat(String(p)) || "null"); if (!r) throw new Error(`ENOENT: ${p}`); return { isFile: () => r.file, isDirectory: () => r.dir, size: r.size, mtimeMs: r.mtime_ms }; },
	lstatSync(p) { return this.statSync(p); },
	rmSync: (p) => { __r_rm(String(p)); },
	unlinkSync: (p) => { __r_rm(String(p)); },
	realpathSync: (p) => String(p),
	promises: undefined,
};
fsImpl.promises = {
	readFile: async (p, enc) => fsImpl.readFileSync(p, enc),
	writeFile: async (p, d) => fsImpl.writeFileSync(p, d),
	appendFile: async (p, d) => fsImpl.appendFileSync(p, d),
	exists: async (p) => fsImpl.existsSync(p),
	mkdir: async (p, o) => fsImpl.mkdirSync(p, o),
	readdir: async (p) => fsImpl.readdirSync(p),
	stat: async (p) => fsImpl.statSync(p),
};
const osImpl = {
	homedir: () => __r_home(), tmpdir: () => __r_tmpdir(), hostname: () => "gray",
	platform: () => "linux", arch: () => "x64", EOL: "\n", type: () => "Linux",
	userInfo: () => ({ username: __r_env("USER") || "user" }),
	env: __envSnapshot,
};
const cpImpl = {
	execFileSync: (cmd, args, o = {}) => { const r = JSON.parse(__r_exec(String(cmd), JSON.stringify(args || []), JSON.stringify(o))); if (r.code !== 0) { const e = new Error(`Command failed: ${cmd}`); e.status = r.code; e.stderr = r.stderr; throw e; } return r.stdout; },
	execSync: (cmd, o = {}) => cpImpl.execFileSync("/bin/sh", ["-c", String(cmd)], o),
	spawnSync: (cmd, args, o = {}) => { const r = JSON.parse(__r_exec(String(cmd), JSON.stringify(args || []), JSON.stringify(o))); return { stdout: r.stdout, stderr: r.stderr, status: r.code, pid: 0 }; },
	spawn: () => { throw new Error("child_process.spawn is inert in gray-pi (use pi.exec)"); },
};
const urlImpl = {
	pathToFileURL: (p) => ({ href: "file://" + encodeURI(String(p)), toString() { return this.href; } }),
	fileURLToPath: (u) => decodeURI(String(u?.href ?? u).replace(/^file:\/\//, "")),
};
const utilImpl = {
	inspect: (v) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } },
	promisify: (fn) => (...a) => Promise.resolve().then(() => fn(...a)),
	format: (f, ...a) => String(f).replace(/%[sdjifoO]/g, () => String(a.shift() ?? "")),
	types: { isNativeError: (e) => e instanceof Error },
};
class __EE {
	constructor() { this._m = new Map(); }
	on(e, f) { (this._m.get(e) || this._m.set(e, []).get(e)).push(f); return this; }
	addListener(e, f) { return this.on(e, f); }
	once(e, f) { const g = (...a) => { this.off(e, g); return f(...a); }; g._o = f; return this.on(e, g); }
	off(e, f) { const l = this._m.get(e); if (l) { const i = l.findIndex((g) => g === f || g._o === f); if (i >= 0) l.splice(i, 1); } return this; }
	removeListener(e, f) { return this.off(e, f); }
	removeAllListeners(e) { e === undefined ? this._m.clear() : this._m.delete(e); return this; }
	emit(e, ...a) { let r = false; for (const f of (this._m.get(e) || []).slice()) { f(...a); r = true; } return r; }
	listeners(e) { return (this._m.get(e) || []).slice(); }
	eventNames() { return [...this._m.keys()]; }
	setMaxListeners() { return this; }
	listenerCount(e) { return (this._m.get(e) || []).length; }
}
const eventsImpl = { EventEmitter: __EE, default: __EE };

// Curated export tables per canonical specifier. Loader consults __curated
// before falling back to __stub for each requested name.
const __curated = (globalThis.__curated = {});
const __reg = (specs, obj) => { for (const s of specs) __curated[s] = obj; };
__reg(["typebox", "@sinclair/typebox", "@mariozechner/typebox"], { Type, default: Type });
__reg(["@earendil-works/pi-ai", "@mariozechner/pi-ai"], {
	StringEnum, Type,
	getEnvApiKey: (k) => __envSnapshot[k] ?? undefined,
	createAssistantMessageEventStream: undefined,
});
__reg(["@earendil-works/pi-tui", "@mariozechner/pi-tui"], {
	Text: TuiText, truncateToWidth: __truncateToWidth, matchesKey: __matchesKey, visibleWidth: __visibleWidth,
});
__reg(["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent", "@earendil-works/agent-base"], {});
__reg(["path", "node:path"], pathImpl);
__reg(["fs", "node:fs", "fs/promises", "node:fs/promises"], fsImpl);
__reg(["os", "node:os"], osImpl);
__reg(["child_process", "node:child_process"], cpImpl);
__reg(["url", "node:url"], urlImpl);
__reg(["util", "node:util"], utilImpl);
__reg(["events", "node:events"], eventsImpl);
__reg(["process", "node:process"], globalThis.process);

// ---------------------------------------------------------------- state
const GRAY_HOME_PI = __r_env("GRAY_HOME") ? __r_env("GRAY_HOME") + "/pi" : __r_home() + "/.gray/pi";
const ENTRIES = GRAY_HOME_PI + "/entries.jsonl";
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const renderers = new Map();
const providers = new Map();
const mcpServers = new Map();
const virtualModels = new Map();
const flags = new Map();
const statusLines = new Map();
const widgetLines = new Map();
const flagsStore = new Map();
const activeTools = new Set();
const thinking = { level: "medium" };
const session = { name: undefined, cwd: __r_cwd(), id: "" };
const bus = new __EE();
const extErrors = [];
let loaded = false;

const oscSafe = (s) => String(s).replace(/[\x1b\x07]/g, "");
function tty(str) { return !!__r_tty(String(str)); }
function paintTitle() {
	const parts = [...statusLines.values()].filter(Boolean);
	if (parts.length) tty(`\x1b]2;⬡ ${parts.join(" · ")}\x07`);
}
function hostCall(method, params) {
	try { return JSON.parse(__r_host_call(method, JSON.stringify(params ?? {}))); }
	catch (e) { return { error: String(e?.message || e) }; }
}
const say = (text) => hostCall("host/say", { text: String(text).slice(0, 8000) });

// ---------------------------------------------------------------- ctx.ui
const ui = {
	select(title, options) {
		const r = hostCall("host/ask", { questions: [{
			id: "q", header: String(title), question: String(title),
			options: (options || []).map((o) => ({ label: String(o), description: "" })),
		}], blocking: true });
		return r?.answers?.q ?? r?.q;
	},
	confirm(title, message) {
		const r = hostCall("host/ask", { questions: [{
			id: "q", header: String(title), question: String(message || title),
			options: [{ label: "Yes" }, { label: "No" }],
		}], blocking: true });
		const a = r?.answers?.q ?? r?.q;
		return typeof a === "string" ? /^y/i.test(a) : !!a;
	},
	input(title, placeholder) {
		const r = hostCall("host/ask", { questions: [{
			id: "q", header: String(title), question: String(placeholder || title), options: [],
		}], blocking: true });
		return r?.answers?.q ?? r?.q;
	},
	editor(title, prefill = "") {
		const f = `${__r_tmpdir()}/gray-pi-edit-${Date.now()}.md`;
		__r_write_file(f, String(prefill));
		__r_open_editor(f);
		const out = __r_read_file(f);
		return out === null || out === undefined ? undefined : out;
	},
	notify(message, type = "info") {
		if (!tty(`\x1b]777;notify;gray · ${oscSafe(type)};${oscSafe(message)}\x07`))
			say(message);
	},
	setStatus(key, text) { text ? statusLines.set(key, text) : statusLines.delete(key); paintTitle(); },
	setWorkingMessage(message) { ui.setStatus("_working", message); },
	setWidget(key, content) {
		if (Array.isArray(content)) widgetLines.set(key, content.map(String));
		else widgetLines.delete(key);
	},
	setHeader() {}, setFooter() {}, setTheme: () => ({ success: false, error: "no theme wire" }),
	custom: async () => undefined, setEditorComponent() {}, setEditorText() {},
	getEditorText: () => "", async waitForIdle() {}, getEditorCursor: () => 0,
};

// ---------------------------------------------------------------- ctx
const sessionManager = {
	get entries() {
		try { return JSON.parse(__r_read_file(ENTRIES) || "[]").__parsed ?? []; } catch { return []; }
	},
};
// entries file is JSONL — parse lazily
Object.defineProperty(sessionManager, "entries", {
	get() {
		try {
			const raw = __r_read_file(ENTRIES);
			if (!raw) return [];
			return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
		} catch { return []; }
	},
});
Object.assign(sessionManager, {
	getBranch: () => sessionManager.entries,
	getEntries: () => sessionManager.entries,
	leafId: null,
	getEntry: (id) => sessionManager.entries.find((e) => e.id === id),
	getPath: () => ENTRIES,
});

const ctx = {
	ui,
	mode: "interactive",
	hasUI: true,
	get cwd() { return session.cwd || __r_cwd(); },
	sessionManager,
	modelRegistry: { getAll: () => [], get: () => undefined },
	model: undefined,
	scopedModels: [],
	get thinkingLevel() { return thinking.level; },
	get signal() { return { aborted: false, addEventListener() {}, removeEventListener() {} }; },
	isIdle: () => true,
	isProjectTrusted: () => true,
	getSignal: () => ctx.signal,
	abort() {}, shutdown() {},
	hasPendingMessages: () => false,
	getContextUsage: () => undefined,
	compact() {},
	getSystemPrompt: () => "",
	getModel: () => undefined,
	getScopedModels: () => [],
};

// ---------------------------------------------------------------- pi api
const pi = {
	on(event, handler) {
		if (!handlers.has(event)) handlers.set(event, []);
		const list = handlers.get(event); list.push(handler);
		return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); };
	},
	registerTool(def) { tools.set(def.name, def); activeTools.add(def.name); },
	registerCommand(name, options = {}) { commands.set(String(name).replace(/^\//, ""), options); },
	registerShortcut() {}, registerFlag(name, o = {}) { flags.set(name, o.default); },
	getFlag: (n) => flags.get(n) ?? flagsStore.get(n),
	registerMessageRenderer: (t, r) => renderers.set(`msg:${t}`, r),
	registerEntryRenderer: (t, r) => renderers.set(`entry:${t}`, r),
	registerToolRenderer: (r) => renderers.set(`tool:${renderers.size}`, r),
	registerMarkdownTransformer: (t) => renderers.set(`md:${renderers.size}`, t),
	sendMessage: (m) => say(m?.content ?? m?.text ?? JSON.stringify(m)),
	sendUserMessage: (m) => say(typeof m === "string" ? m : (m?.content ?? m?.text ?? "")),
	appendEntry(customType, data) {
		__r_mkdir_p(GRAY_HOME_PI);
		__r_append_file(ENTRIES, JSON.stringify({ id: `e${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(), customType, data }) + "\n");
	},
	setSessionName: (n) => { session.name = n; },
	getSessionName: () => session.name,
	setLabel() {},
	exec(command, args = [], options = {}) {
		try {
			return JSON.parse(__r_exec(String(command), JSON.stringify(args), JSON.stringify({
				cwd: options.cwd || ctx.cwd, timeout: options.timeout ?? 120, env: options.env || {},
			})));
		} catch (e) { return { stdout: "", stderr: String(e?.message || e), code: 1, killed: false }; }
	},
	getActiveTools: () => [...activeTools],
	getAllTools: () => [...tools.values()].map((t) => ({ name: t.name, source: "extension" })),
	getSettings: () => ({}),
	setActiveTools(names) { activeTools.clear(); names.forEach((n) => tools.has(n) && activeTools.add(n)); },
	getCommands: () => [...commands.keys()].map((n) => ({ name: `/${n}`, source: "extension" })),
	setModel: async () => false,
	getThinkingLevel: () => thinking.level,
	setThinkingLevel: (l) => { thinking.level = l; },
	registerProvider: (n, c) => providers.set(typeof n === "string" ? n : n?.name, c ?? n),
	unregisterProvider: (n) => providers.delete(n),
	registerVirtualModel: (p, m) => virtualModels.set(`${p}/${m?.id ?? m}`, m),
	unregisterVirtualModel: (p, id) => virtualModels.delete(`${p}/${id}`),
	registerMcpServer: (n, c) => mcpServers.set(n, c),
	unregisterMcpServer: (n) => mcpServers.delete(n),
	getMcpServers: () => [...mcpServers.entries()].map(([name, config]) => ({ name, config })),
	events: bus,
};

// ---------------------------------------------------------------- pi-index
// Bundled port of gray-pi-index: pi_search / pi_info / pi_scaffold tools plus
// /pi search|info|scaffold subcommands. All network goes through curl; scaffold
// shells out to `gray account new`, `npm pack`, and `tar`.
const IDX_DIR = (__r_env("GRAY_HOME") || __r_home() + "/.gray") + "/pi-index";
const PLUGINS_DIR = __r_env("GRAY_PLUGINS_DIR") || __r_home() + "/grayplugins";
const PORTS_FILE = PLUGINS_DIR + "/PORTS.md";

function ixUrlEncode(s) {
	let out = "";
	for (const ch of String(s)) {
		if (/^[A-Za-z0-9\-_.~@/]$/.test(ch)) out += ch;
		else if (ch.charCodeAt(0) < 128) out += "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
		else out += encodeURIComponent(ch);
	}
	return out.replace(/\//g, "%2F");
}

function ixCurl(url, timeout) {
	const r = pi.exec("curl", ["-sS", "-L", "--max-time", String(timeout), url], { timeout: timeout + 5 });
	if (r.code !== 0) {
		const line = String(r.stderr || "").split("\n").find((l) => l.startsWith("curl:")) || "curl failed";
		throw new Error(line);
	}
	return r.stdout;
}

function ixSearchRows(text) {
	const body = ixCurl(`https://registry.npmjs.org/-/v1/search?size=50&text=${text}`, 20);
	let doc;
	try { doc = JSON.parse(body); } catch { throw new Error("bad json from npm"); }
	return ((doc && doc.objects) || []).map((o) => ({
		name: (o && o.package && o.package.name) || "",
		version: (o && o.package && o.package.version) || "",
		description: (o && o.package && o.package.description) || "",
		fetched_at: Math.floor(Date.now() / 1000),
	}));
}

// Merge rows into the cached index (dedup by name, newest row wins).
function ixUpdateIndex(rows) {
	const file = IDX_DIR + "/index.json";
	let index = {};
	try { index = JSON.parse(__r_read_file(file) || "{}"); } catch { index = {}; }
	if (index === null || typeof index !== "object" || Array.isArray(index)) index = {};
	for (const r of rows) if (r.name) index[r.name] = r;
	__r_mkdir_p(IDX_DIR);
	__r_write_file(file, JSON.stringify(index, null, 2));
}

function ixPiSearch(query) {
	const all = [], errs = [];
	for (const kw of ["pi-package", "pi-extension"]) {
		const text = query && query.trim() ? `${ixUrlEncode(query.trim())}+keywords:${kw}` : `keywords:${kw}`;
		try { all.push(...ixSearchRows(text)); } catch (e) { errs.push(String((e && e.message) || e)); }
	}
	if (!all.length && errs.length) throw new Error(`npm search failed: ${errs.join("; ")}`);
	ixUpdateIndex(all);
	all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const rows = all.filter((r, i) => i === 0 || all[i - 1].name !== r.name);
	let out = rows.slice(0, 40)
		.map((r) => `${r.name}@${r.version} — ${String(r.description || "").split("\n")[0]}`)
		.join("\n");
	if (rows.length > 40) out += `\n…and ${rows.length - 40} more (cached in ~/.gray/pi-index/index.json)`;
	return out.trimEnd() || "no pi packages found";
}

// Classify a package against the local availability tracker.
function ixCompatStatus(name, ports) {
	const short = name.split("/").pop();
	let heading = "";
	for (const line of ports.split("\n")) {
		if (line.startsWith("#")) heading = line.replace(/^#+|#+$/g, "").trim().toLowerCase();
		if (!(line.includes(name) || (short.length > 3 && line.includes(short)))) continue;
		const pos = line.indexOf("gray-");
		if (pos >= 0) {
			let tgt = "";
			for (const c of line.slice(pos)) {
				if (!/[A-Za-z0-9-]/.test(c)) break;
				tgt += c;
			}
			if (tgt.length > 5) return `available → ${tgt}`;
		}
		if (heading.includes("not portable") || heading.includes("skip") || heading.includes("deliberately"))
			return `blocked: ${heading.trim()}`;
		if (heading.includes("done") || heading.includes("batch")) return "available (listed in PORTS.md)";
		return "mentioned in PORTS.md (status unclear)";
	}
	return "unavailable";
}

function ixPiInfo(name) {
	if (!name || !name.trim()) throw new Error("missing required argument: name");
	name = name.trim();
	let body;
	try { body = ixCurl(`https://registry.npmjs.org/${ixUrlEncode(name)}`, 20); }
	catch (e) { throw new Error(`registry lookup failed for ${name}: ${(e && e.message) || e}`); }
	let doc;
	try { doc = JSON.parse(body); } catch { throw new Error(`${name}: not found or bad json`); }
	if (doc && "error" in doc) throw new Error(`${name}: ${typeof doc.error === "string" ? doc.error : "not found"}`);
	const latest = (doc && doc["dist-tags"] && doc["dist-tags"].latest) || "?";
	const desc = (doc && doc.description) || (doc && doc.versions && doc.versions[latest] && doc.versions[latest].description) || "";
	const modified = (doc && doc.time && doc.time.modified) || "?";
	const raw = __r_read_file(PORTS_FILE);
	const status = raw === null || raw === undefined ? "unknown (PORTS.md unreadable)" : ixCompatStatus(name, raw);
	return `${name}@${latest}\n${desc}\nmodified: ${modified}\nport status: ${status}`;
}

// `pi-foo` / `@scope/pi-foo` → `gray-foo`; keeps it filesystem- and tool-safe.
function ixGrayishName(name) {
	let base = name.split("/").pop();
	if (base.startsWith("pi-")) base = base.slice(3);
	const safe = [...base].map((c) => (/[A-Za-z0-9-]/.test(c) ? c : "-")).join("");
	return `gray-${safe.replace(/^-+|-+$/g, "")}`;
}

function ixPiScaffold(name) {
	name = String(name || "").trim();
	if (!name) throw new Error("missing required argument: name");
	const dirName = ixGrayishName(name);
	const parent = PLUGINS_DIR;
	const dest = `${parent}/${dirName}`;
	if (__r_exists(dest)) throw new Error(`${dest} already exists`);

	// 1. scaffold the gray account
	const out = pi.exec("gray", ["account", "new", dirName, "--no-repo",
		"--description", `Gray sidecar compatible with npm package ${name}`], { cwd: parent });
	if (out.code !== 0) throw new Error(`gray account new failed: ${String(out.stderr || "").trim()}`);

	// 2. vendor the npm tarball
	const vendor = `${dest}/vendor`;
	let vendored = "npm pack failed";
	if (__r_mkdir_p(vendor)) {
		const pack = pi.exec("npm", ["pack", name, "--pack-destination", vendor], { cwd: vendor });
		if (pack.code === 0) {
			const tgz = String(pack.stdout || "").trim().split("\n").pop().trim();
			const ex = pi.exec("tar", ["xzf", tgz, "--strip-components=1"], { cwd: vendor });
			__r_rm(`${vendor}/${tgz}`);
			vendored = ex.code === 0 ? `vendored ${tgz}` : `packed ${tgz} but extraction failed`;
		} else {
			vendored = `npm pack failed: ${String(pack.stderr || "").trim()}`;
		}
	}

	// 3. SCAFFOLD-SPEC.md stub
	const vendoredSrc = __r_exists(`${vendor}/package.json`)
		? "vendored package lives in vendor/ — read vendor/package.json + entry files."
		: "vendor/ is empty or unextracted — re-run `npm pack` manually.";
	const spec = `# SCAFFOLD-SPEC: ${name} → ${dirName}

Source package: npm \`${name}\` — ${vendoredSrc}

## What the extension registers

TODO — scan vendor/ for \`pi.registerTool(\`, \`pi.registerCommand(\`, \`pi.on(\`.

## Wire methods to map

- pi.registerTool → \`tools\` in manifest + \`tool/call\`
- pi.registerCommand → \`commands\` + \`command/run\`
- pi.on("tool_call"/"tool_result") → \`tool/before\` / \`tool/after\` hooks
- pi.on("before_agent_start"/"context") → \`prompt/context\` hook
- pi.on("turn_end"/session events) → \`event/notify\` notification

## Subagent prompt

Read ~/grayplugins/PORTING.md and ~/grayplugins/gray-notify/src/main.rs. Implement npm \`${name}\` (vendored under ${dirName}/vendor/) as a gray sidecar in ${dirName}/src/main.rs. Steps: cargo test && cargo build --release && gray account check → "check ok", README with wire methods + install line, one commit. Do NOT \`gray plugin install\`.
`;
	__r_write_file(`${dest}/SCAFFOLD-SPEC.md`, spec);
	return `scaffolded ${dirName} in ${dest}\n${vendored}\nwrote SCAFFOLD-SPEC.md\n\nImplementation prompt:\nRead ~/grayplugins/PORTING.md and ~/grayplugins/gray-notify/src/main.rs. Implement npm \`${name}\` (vendored under ${dirName}/vendor/) as a gray sidecar in ${dirName}/src/main.rs; run cargo test && cargo build --release && gray account check; update README; one commit.`;
}

// Wrap an index function as a pi tool execute: Ok → {content}, Err → {content, isError}.
function ixTool(fn) {
	return async (id, args) => {
		try { return { content: await fn(args || {}) }; }
		catch (e) { return { content: String((e && e.message) || e), isError: true }; }
	};
}
pi.registerTool({
	name: "pi_search",
	description: "Search the pi package/extension ecosystem on npm (keywords:pi-package + keywords:pi-extension). Optional `query` narrows results. Results are cached into ~/.gray/pi-index/index.json.",
	parameters: { type: "object", properties: { query: { type: "string", description: "Optional search terms." } } },
	execute: ixTool((a) => ixPiSearch(a.query)),
});
pi.registerTool({
	name: "pi_info",
	description: "Registry details for one npm package plus local availability status (available → gray-X / unavailable / blocked) cross-referenced against ~/grayplugins/PORTS.md.",
	parameters: { type: "object", properties: { name: { type: "string", description: "npm package name, e.g. pi-lens or @scope/pkg." } }, required: ["name"] },
	execute: ixTool((a) => ixPiInfo(a.name || "")),
});
pi.registerTool({
	name: "pi_scaffold",
	description: "Scaffold a compatible sidecar: `gray account new` for the package, vendor its npm tarball into vendor/, and write SCAFFOLD-SPEC.md with a ready-made implementation prompt. Use after pi_search/pi_info finds an unavailable package.",
	parameters: { type: "object", properties: { name: { type: "string", description: "npm package name to scaffold a sidecar for." } }, required: ["name"] },
	execute: ixTool((a) => ixPiScaffold(a.name || "")),
});

// ---------------------------------------------------------------- events
async function emit(event, payload) {
	const results = [];
	for (const h of handlers.get(event) || []) {
		try { results.push(await h(payload, ctx)); }
		catch (e) { extErrors.push(`${event}: ${e?.message || e}`); }
	}
	return results;
}
const last = (rs) => rs.filter((r) => r !== undefined).at(-1);
const textOf = (c) => typeof c === "string" ? c
	: Array.isArray(c) ? c.map((b) => b?.text ?? (typeof b === "string" ? b : "")).join("\n")
	: c?.text ?? "";

// ---------------------------------------------------------------- loading
function basename(p) { return String(p).split("/").pop(); }

async function loadAll(cwd) {
	const files = JSON.parse(__r_extension_files(cwd || session.cwd || __r_cwd()));
	for (const file of files) {
		try {
			const mod = __r_load_module(file);
			const factory = mod?.default ?? mod;
			if (typeof factory === "function") await factory(pi);
		} catch (e) { extErrors.push(`${basename(file)}: ${e?.message || e}`); }
	}
	for (const h of handlers.get("session_start") || []) {
		try { await h({ type: "session_start" }, ctx); } catch {}
	}
	loaded = true;
	return extErrors.slice();
}

// ---------------------------------------------------------------- wire
async function handleTool(name, args) {
	const def = tools.get(name);
	if (!def) throw new Error(`unknown pi tool ${name}`);
	let out = await def.execute(`call-${Date.now()}`, args, ctx.signal, () => {}, ctx);
	if (out?.then) out = await out;
	const content = textOf(out?.content ?? out);
	if (out?.details !== undefined) {
		__r_mkdir_p(GRAY_HOME_PI);
		__r_append_file(ENTRIES, JSON.stringify({
			id: `e${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
			ts: Date.now(), type: "message",
			message: { role: "toolResult", toolName: name, details: out.details },
		}) + "\n");
	}
	return out?.isError ? { content, is_error: true } : { content };
}

async function handleCommand(name, argv, sess) {
	if (sess?.cwd) session.cwd = sess.cwd;
	if (name === "/pi" || name === "pi") {
		const sub = argv[0] || "status";
		if (sub === "list" || sub === "status") {
			const files = JSON.parse(__r_extension_files(sess?.cwd || session.cwd)).map(basename);
			return { text: [
				`extensions: ${files.length ? files.join(", ") : "none"}`,
				`tools: ${[...tools.keys()].join(", ") || "none"}`,
				`commands: ${[...commands.keys()].map((c) => "/" + c).join(", ") || "none"}`,
				`events wired: ${[...handlers.keys()].join(", ") || "none"}`,
				extErrors.length ? `errors:\n${extErrors.map((e) => "  " + e).join("\n")}` : "errors: none",
			].join("\n") };
		}
		if (sub === "entries") {
			const n = Math.min(Number(argv[1]) || 20, 100);
			return { text: sessionManager.entries.slice(-n).map((e) => `${e.customType}: ${JSON.stringify(e.data)?.slice(0, 200)}`).join("\n") || "no entries" };
		}
		if (sub === "reload") { return { __reload: true }; }
		if (sub === "setup") { return { text: "embedded QuickJS engine — nothing to provision" }; }
		if (sub === "search" || sub === "info" || sub === "scaffold") {
			try {
				const text = sub === "search" ? ixPiSearch(argv[1])
					: sub === "info" ? ixPiInfo(argv[1] || "") : ixPiScaffold(argv[1] || "");
				return { text };
			} catch (e) { return { text: String((e && e.message) || e) }; }
		}
		return { text: "usage: /pi status|list|entries [n]|reload|setup|search [q]|info <pkg>|scaffold <pkg>" };
	}
	const cmd = commands.get(String(name).replace(/^\//, ""));
	if (!cmd?.handler) throw new Error(`unknown pi command ${name}`);
	const out = await cmd.handler(argv.join(" "), ctx);
	return { text: textOf(out) || `${name} done` };
}

// Takes the whole frame as a JSON string ({method, params}).
// Returns {ok:true,result} or {ok:false,error} — never throws out.
globalThis.__dispatch = async function dispatch(msgJson) {
	try {
		const { method, params } = JSON.parse(msgJson || "{}");
		const r = await dispatchInner(method, params ?? {});
		return { ok: true, result: r === undefined ? {} : r };
	} catch (e) {
		return { ok: false, error: String(e?.message || e) };
	}
};

async function dispatchInner(method, params) {
	switch (method) {
		case "plugin/manifest":
			if (!loaded) await loadAll(params?.cwd);
			return {
				name: "pi-ext", version: __R_VERSION, protocol: "2.0",
				tools: [...tools.values()].map((t) => ({
					name: t.name, description: t.description || t.name,
					parameters: t.parameters || { type: "object", properties: {} },
				})),
				commands: ["/pi", ...[...commands.keys()].map((c) => "/" + c)],
				hooks: ["tool/before", "tool/after", "input/submit", "prompt/context", "agent/before_start", "context/build"],
				capabilities: ["host.ask", "host.say"],
			};
		case "plugin/shutdown":
			await emit("session_shutdown", { type: "session_shutdown", reason: params?.reason });
			return {};
		case "tool/call":
			return await handleTool(params.name, params.args || {});
		case "command/run":
			return await handleCommand(params.name, params.argv || [], params.session);
		case "input/submit": {
			const r = last(await emit("input", { type: "input", text: params.text }));
			if (r?.action === "transform") return { text: r.text };
			if (r?.action === "handled") return { handled: true };
			return {};
		}
		case "tool/before": {
			const ev = { type: "tool_call", toolCallId: `c${Date.now()}`, toolName: params.name, input: params.args || {} };
			const snap = JSON.stringify(ev.input);
			const r = last(await emit("tool_call", ev));
			if (r?.block) return { decision: "deny", reason: r.reason || "blocked by pi extension" };
			if (JSON.stringify(ev.input) !== snap) return { decision: "modify", args: ev.input };
			return { decision: "allow" };
		}
		case "tool/after": {
			const r = last(await emit("tool_result", { type: "tool_result", toolCallId: "", toolName: params.name, input: params.args || {}, content: [{ type: "text", text: textOf(params.content) }], isError: !!params.is_error }));
			if (r?.content !== undefined) return { content: textOf(r.content), is_error: r.isError };
			return {};
		}
		case "prompt/context": {
			if (params?.session?.cwd) session.cwd = params.session.cwd;
			const rs = await emit("context", { type: "context" });
			const msgs = rs.flatMap((r) => r?.messages || []).map((m) => textOf(m?.content ?? m)).filter(Boolean);
			return { text: msgs.join("\n\n") };
		}
		case "agent/before_start": {
			const r = last(await emit("before_agent_start", { type: "before_agent_start", prompt: params?.prompt }));
			return { text: textOf(r?.message?.content ?? r?.message ?? r?.systemPrompt ?? "") };
		}
		case "context/build": return {};
		case "prompt/context+": return {};
		default: throw new Error(`unsupported method ${method}`);
	}
}

globalThis.__notify = async function notify(msgJson) {
	try {
		const { method, params } = JSON.parse(msgJson || "{}");
		const s = params?.session || {};
		if (s.cwd) session.cwd = s.cwd; if (s.id) session.id = s.id;
		if (method === "event/notify") {
			const t = params.type;
			if (t === "pre_tool") await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "", toolName: params.name, args: params.args });
			else if (t === "post_tool") await emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "", toolName: params.name, content: [{ type: "text", text: textOf(params.content) }], isError: !!params.is_error });
			else if (t === "turn_end") { await emit("turn_end", { type: "turn_end", usage: params.usage }); await emit("agent_settled", { type: "agent_settled" }); paintTitle(); }
		}
	} catch {}
};

globalThis.__loadErrors = () => extErrors.slice();
globalThis.__widgetText = () =>
	["⬢ pi", ...[...widgetLines.values()].flat().map((l) => "│ " + l)].join("\n");
