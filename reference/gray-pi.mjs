#!/usr/bin/env node
/**
 * gray-pi — run pi extensions (.ts factories) under gray's NDJSON sidecar wire.
 *
 * 1:1 where the wire reaches: registerTool, registerCommand, on(tool_call /
 * tool_result / input / before_agent_start / context / turn_* / session_* /
 * tool_execution_*), pi.events, pi.exec, appendEntry (file store),
 * sendUserMessage/sendMessage (host.say), ctx.ui.select/confirm/input (host.ask),
 * ctx.ui.notify/setStatus/setWorkingMessage (OSC to /dev/tty), setWidget
 * (string[] rendered when this plugin owns the gray widget slot).
 * Inert by design (no wire): provider registration, virtual models, renderers,
 * shortcuts, model/thinking switching, sessionManager mutation, ui.custom /
 * setEditorComponent / setHeader / setFooter / setTheme.
 *
 * Extensions load via jiti (the same loader pi uses) from:
 *   <cwd>/.pi/extensions/*.ts          (project)
 *   ~/.pi/agent/extensions/*.ts        (pi's own dir — true 1:1)
 *   ~/.gray/pi/extensions/*.ts         (gray-only extras)
 * Runtime imports (typebox, @earendil-works/*) resolve through
 * ~/.gray/pi/node_modules — a symlink farm seeded by `gray-pi setup` into the
 * global pi-coding-agent install when present.
 */
import { createRequire } from "node:module";
import { spawnSync, execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAY_HOME = process.env.GRAY_HOME || path.join(os.homedir(), ".gray");
const PI_DIR = path.join(GRAY_HOME, "pi");
const ENTRIES = path.join(PI_DIR, "entries.jsonl");
const PI_AGENT = path.join(os.homedir(), ".pi", "agent");
const req = createRequire(import.meta.url);

// ---------------------------------------------------------------- deps
let createJiti = null;
for (const p of [
	path.join(HERE, "node_modules", "jiti", "lib", "jiti.cjs"),
	path.join(PI_DIR, "node_modules", "jiti", "lib", "jiti.cjs"),
]) {
	try { createJiti = req(p).createJiti; break; } catch {}
}
if (!createJiti) {
	try { createJiti = req("jiti").createJiti; } catch {}
}

// ---------------------------------------------------------------- state
const handlers = new Map();           // event -> [fn]
const tools = new Map();              // name -> ToolDefinition
const commands = new Map();           // name -> {handler, description}
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
const session = { name: undefined, cwd: process.cwd(), id: "" };
const bus = new EventEmitter(); bus.setMaxListeners(0);
const pending = new Map();            // outbound host/* request resolvers
let hostSeq = 0;
const abortCtl = new AbortController();
const extErrors = [];

const send = (obj) => { process.stdout.write(JSON.stringify(obj) + "\n"); };
const reply = (id, result) => send({ id, result });
const replyErr = (id, message) => send({ id, error: { code: -32601, message: String(message) } });

function hostCall(method, params) {
	return new Promise((resolve) => {
		const id = `q${++hostSeq}`;
		pending.set(id, resolve);
		send({ id, method, params });
		setTimeout(() => { if (pending.delete(id)) resolve({ error: "timeout" }); }, 120000);
	});
}
const say = (text) => hostCall("host/say", { text: String(text).slice(0, 8000) });

function tty(str) {
	try { fs.writeFileSync("/dev/tty", str); return true; } catch { return false; }
}
function paintTitle() {
	const parts = [...statusLines.values()].filter(Boolean);
	if (parts.length) tty(`\x1b]2;⬡ ${parts.join(" · ")}\x07`);
}

// ---------------------------------------------------------------- ctx.ui
const ui = {
	async select(title, options) {
		const r = await hostCall("host/ask", { questions: [{
			id: "q", header: title, question: title,
			options: (options || []).map((o) => ({ label: String(o), description: "" })),
		}], blocking: true });
		return r?.answers?.q ?? r?.q;
	},
	async confirm(title, message) {
		const r = await hostCall("host/ask", { questions: [{
			id: "q", header: title, question: message || title,
			options: [{ label: "Yes" }, { label: "No" }],
		}], blocking: true });
		const a = r?.answers?.q ?? r?.q;
		return typeof a === "string" ? /^y/i.test(a) : !!a;
	},
	async input(title, placeholder) {
		const r = await hostCall("host/ask", { questions: [{
			id: "q", header: title, question: placeholder || title, options: [],
		}], blocking: true });
		return r?.answers?.q ?? r?.q;
	},
	async editor(title, prefill = "") {
		const f = path.join(os.tmpdir(), `gray-pi-edit-${process.pid}.md`);
		fs.writeFileSync(f, prefill);
		spawnSync(process.env.EDITOR || "vi", [f], { stdio: [fs.openSync("/dev/tty","r"), fs.openSync("/dev/tty","w"), fs.openSync("/dev/tty","w")] });
		try { return fs.readFileSync(f, "utf8"); } catch { return undefined; }
	},
	notify(message, type = "info") {
		if (!tty(`\x1b]777;notify;gray · ${type};${String(message).replace(/[\x1b\x07]/g, "")}\x07`))
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
		try {
			return fs.readFileSync(ENTRIES, "utf8").split("\n").filter(Boolean)
				.map((l) => JSON.parse(l));
		} catch { return []; }
	},
	getBranch: () => sessionManager.entries,
	getEntries: () => sessionManager.entries,
	leafId: null, getEntry: (id) => sessionManager.entries.find((e) => e.id === id),
	getPath: () => ENTRIES,
};

const ctx = {
	ui,
	mode: "interactive",
	hasUI: true,
	get cwd() { return session.cwd || process.cwd(); },
	sessionManager,
	modelRegistry: { getAll: () => [], get: () => undefined },
	model: undefined,
	scopedModels: [],
	get thinkingLevel() { return thinking.level; },
	get signal() { return abortCtl.signal; },
	isIdle: () => true,
	isProjectTrusted: () => true,
	getSignal: () => abortCtl.signal,
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
	registerCommand(name, options = {}) { commands.set(name.replace(/^\//, ""), options); },
	registerShortcut() {}, registerFlag(name, o = {}) { flags.set(name, o.default); },
	getFlag: (n) => flags.get(n) ?? flagsStore.get(n),
	registerMessageRenderer: (t, r) => renderers.set(`msg:${t}`, r),
	registerEntryRenderer: (t, r) => renderers.set(`entry:${t}`, r),
	registerToolRenderer: (r) => renderers.set(`tool:${renderers.size}`, r),
	registerMarkdownTransformer: (t) => renderers.set(`md:${renderers.size}`, t),
	sendMessage: (m) => say(m?.content ?? m?.text ?? JSON.stringify(m)),
	sendUserMessage: (m) => say(typeof m === "string" ? m : (m?.content ?? m?.text ?? "")),
	appendEntry(customType, data) {
		fs.mkdirSync(PI_DIR, { recursive: true });
		fs.appendFileSync(ENTRIES, JSON.stringify({ id: `e${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(), customType, data }) + "\n");
	},
	setSessionName: (n) => { session.name = n; },
	getSessionName: () => session.name,
	setLabel() {},
	exec(command, args = [], options = {}) {
		return new Promise((resolve) => {
			execFile(command, args, { cwd: options.cwd || ctx.cwd, timeout: (options.timeout ?? 120) * 1000, maxBuffer: 8 << 20, env: { ...process.env, ...(options.env || {}) } },
				(err, stdout, stderr) => resolve({ stdout: stdout ?? "", stderr: stderr ?? (err?.message ?? ""), code: err ? (err.code ?? 1) : 0, killed: !!err?.killed }));
		});
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
function extensionFiles(cwd) {
	const dirs = [
		path.join(cwd || process.cwd(), ".pi", "extensions"),
		path.join(PI_AGENT, "extensions"),
		path.join(PI_DIR, "extensions"),
	];
	const files = [];
	for (const d of dirs) {
		try {
			for (const f of fs.readdirSync(d)) {
				if (/\.(ts|mjs|js)$/.test(f) && !f.endsWith(".d.ts")) files.push(path.join(d, f));
			}
		} catch {}
	}
	return files;
}

async function loadAll(cwd) {
	if (!createJiti) { extErrors.push("jiti not installed — run `gray-pi setup`"); return; }
	const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
	for (const file of extensionFiles(cwd)) {
		try {
			const mod = await jiti.import(file);
			const factory = mod?.default ?? mod;
			if (typeof factory === "function") await factory(pi);
		} catch (e) { extErrors.push(`${path.basename(file)}: ${e?.message || e}`); }
	}
	for (const h of handlers.get("session_start") || []) {
		try { await h({ type: "session_start" }, ctx); } catch {}
	}
}

// ---------------------------------------------------------------- wire
async function handleTool(name, args) {
	const def = tools.get(name);
	if (!def) throw new Error(`unknown pi tool ${name}`);
	let out = await def.execute(`call-${Date.now()}`, args, abortCtl.signal, () => {}, ctx);
	if (out?.then) out = await out;
	const content = textOf(out?.content ?? out);
	// pi persists tool `details` on the session branch — mirror that so
	// extensions that reconstruct state by replaying toolResults (goal.ts)
	// behave the same after a restart.
	if (out?.details !== undefined) {
		fs.mkdirSync(PI_DIR, { recursive: true });
		fs.appendFileSync(ENTRIES, JSON.stringify({
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
			const files = extensionFiles(sess?.cwd).map((f) => path.basename(f));
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
		if (sub === "reload") {
			handlers.clear(); tools.clear(); commands.clear(); extErrors.length = 0;
			await loadAll(sess?.cwd);
			return { text: `reloaded — ${tools.size} tools, ${commands.size} commands${extErrors.length ? `, ${extErrors.length} errors` : ""}` };
		}
		if (sub === "setup") { return { text: setupDeps() }; }
		return { text: "usage: /pi status|list|entries [n]|reload|setup" };
	}
	const cmd = commands.get(name.replace(/^\//, ""));
	if (!cmd?.handler) throw new Error(`unknown pi command ${name}`);
	const out = await cmd.handler(argv.join(" "), ctx);
	return { text: textOf(out) || `${name} done` };
}

function setupDeps() {
	const log = [];
	fs.mkdirSync(path.join(PI_DIR, "node_modules"), { recursive: true });
	fs.mkdirSync(path.join(PI_DIR, "node_modules", "@earendil-works"), { recursive: true });
	const link = (name, target) => {
		const dest = path.join(PI_DIR, "node_modules", name);
		if (fs.existsSync(target) && !fs.existsSync(dest)) { fs.symlinkSync(target, dest, "junction"); log.push(`linked ${name}`); }
	};
	const globalNm = "/home/" + os.userInfo().username + "/.local/opt/nodejs/lib/node_modules";
	const piCore = path.join(globalNm, "@earendil-works", "pi-coding-agent");
	link("typebox", path.join(piCore, "node_modules", "typebox"));
	link("@earendil-works/pi-coding-agent", piCore);
	for (const p of ["pi-tui", "pi-ai", "agent-base"])
		link(`@earendil-works/${p}`, path.join(piCore, "node_modules", "@earendil-works", p));
	// Resolution walks up from each extension file — mirror the farm into
	// ~/.pi/agent/node_modules so pi's own extensions dir resolves too.
	const piFarm = path.join(PI_AGENT, "node_modules");
	fs.mkdirSync(path.join(piFarm, "@earendil-works"), { recursive: true });
	const link2 = (name, target) => {
		const dest = path.join(piFarm, name);
		if (fs.existsSync(target) && !fs.existsSync(dest)) { fs.symlinkSync(target, dest, "junction"); log.push(`linked pi-agent ${name}`); }
	};
	link2("typebox", path.join(piCore, "node_modules", "typebox"));
	link2("@earendil-works/pi-coding-agent", piCore);
	for (const p of ["pi-tui", "pi-ai", "agent-base"])
		link2(`@earendil-works/${p}`, path.join(piCore, "node_modules", "@earendil-works", p));
	if (!createJiti) {
		const r = spawnSync("npm", ["i", "--prefix", PI_DIR, "jiti"], { encoding: "utf8" });
		log.push(r.status === 0 ? "jiti installed" : `npm i jiti failed: ${r.stderr.slice(0, 200)}`);
	}
	return log.join("\n") || "already provisioned";
}

async function dispatch(method, params, id) {
	switch (method) {
		case "plugin/manifest":
			await loadAll(params?.cwd);
			reply(id, {
				name: "pi", version: "0.1.0", protocol: "2.0",
				tools: [...tools.values()].map((t) => ({
					name: t.name, description: t.description || t.name,
					parameters: t.parameters || { type: "object", properties: {} },
				})),
				commands: ["/pi", ...[...commands.keys()].map((c) => "/" + c)],
				hooks: ["tool/before", "tool/after", "input/submit", "prompt/context", "agent/before_start", "context/build"],
				capabilities: ["host.ask", "host.say"],
			});
			return;
		case "plugin/shutdown":
			await emit("session_shutdown", { type: "session_shutdown", reason: params?.reason });
			abortCtl.abort(); reply(id, {}); process.exit(0); return;
		case "tool/call":
			reply(id, await handleTool(params.name, params.args || {})); return;
		case "command/run":
			reply(id, await handleCommand(params.name, params.argv || [], params.session)); return;
		case "input/submit": {
			const r = last(await emit("input", { type: "input", text: params.text }));
			if (r?.action === "transform") reply(id, { text: r.text });
			else if (r?.action === "handled") reply(id, { handled: true });
			else reply(id, {});
			return;
		}
		case "tool/before": {
			const ev = { type: "tool_call", toolCallId: `c${Date.now()}`, toolName: params.name, input: params.args || {} };
			const r = last(await emit("tool_call", ev));
			if (r?.block) reply(id, { decision: "deny", reason: r.reason || "blocked by pi extension" });
			else if (ev.input !== params.args) reply(id, { decision: "modify", args: ev.input });
			else reply(id, { decision: "allow" });
			return;
		}
		case "tool/after": {
			const r = last(await emit("tool_result", { type: "tool_result", toolCallId: "", toolName: params.name, input: params.args || {}, content: [{ type: "text", text: textOf(params.content) }], isError: !!params.is_error }));
			if (r?.content !== undefined) reply(id, { content: textOf(r.content), is_error: r.isError });
			else reply(id, {});
			return;
		}
		case "prompt/context": {
			if (params?.session?.cwd) session.cwd = params.session.cwd;
			const rs = await emit("context", { type: "context" });
			const msgs = rs.flatMap((r) => r?.messages || []).map((m) => textOf(m?.content ?? m)).filter(Boolean);
			reply(id, { text: msgs.join("\n\n") });
			return;
		}
		case "agent/before_start": {
			const r = last(await emit("before_agent_start", { type: "before_agent_start", prompt: params?.prompt }));
			reply(id, { text: textOf(r?.message?.content ?? r?.message ?? r?.systemPrompt ?? "") });
			return;
		}
		case "context/build": reply(id, {}); return;
		case "prompt/context+": reply(id, {}); return;
		default: replyErr(id, `unsupported method ${method}`);
	}
}

// notifications (no id)
async function notify(method, params) {
	const s = params?.session || {};
	if (s.cwd) session.cwd = s.cwd; if (s.id) session.id = s.id;
	if (method === "event/notify") {
		const t = params.type;
		if (t === "pre_tool") await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "", toolName: params.name, args: params.args });
		else if (t === "post_tool") await emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "", toolName: params.name, content: [{ type: "text", text: textOf(params.content) }], isError: !!params.is_error });
		else if (t === "turn_end") { await emit("turn_end", { type: "turn_end", usage: params.usage }); await emit("agent_settled", { type: "agent_settled" }); paintTitle(); }
	}
}

// ---------------------------------------------------------------- main
const arg = process.argv[2];
if (arg === "setup") { console.log(setupDeps()); process.exit(0); }
if (arg === "widget") {
	const lines = [...widgetLines.values()].flat();
	console.log(JSON.stringify({ version: 1, text: ["⬢ pi", ...lines.map((l) => "│ " + l)].join("\n"), shimmer_lines: [] }));
	process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
// Serialized dispatch: extension factories are stateful and a tool/call must
// never interleave with a still-running load or an in-flight handler.
let chain = Promise.resolve();
rl.on("line", (line) => {
	chain = chain.then(() => handleLine(line)).catch(() => {});
});
async function handleLine(line) {
	let msg; try { msg = JSON.parse(line); } catch { return; }
	if (typeof msg !== "object" || msg === null) return;
	if (typeof msg.id === "string" && pending.has(msg.id)) {
		const r = pending.get(msg.id); pending.delete(msg.id); r(msg.result ?? msg);
		return;
	}
	if (msg.id === undefined) { await notify(msg.method, msg.params).catch(() => {}); return; }
	try { await dispatch(msg.method, msg.params || {}, msg.id); }
	catch (e) { replyErr(msg.id, e?.message || e); }
}
rl.on("close", () => process.exit(0));
