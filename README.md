# gray-pi

Runs pi extensions **unmodified** under gray — jiti loads the same `.ts`
factories pi does, an `ExtensionAPI`/`ExtensionContext` shim bridges them
onto gray's NDJSON sidecar wire. One plugin = the whole pi ecosystem.

## What runs 1:1

| pi API | bridge |
|---|---|
| `pi.on("tool_call"/"tool_result")` | `tool/before` (deny/modify) / `tool/after` |
| `pi.on("input")` | `input/submit` (transform/handled) |
| `pi.on("before_agent_start")` | `agent/before_start` (message → injected text) |
| `pi.on("context")` | `prompt/context` (messages → context text) |
| `pi.on("turn_end" …)`, `tool_execution_start/end`, `session_start/shutdown`, `agent_settled` | `event/notify` |
| `registerTool` | manifest `tools`, `tool/call` → `execute()` |
| `registerCommand` | manifest `commands`, `command/run` → `handler()` |
| `pi.events` | real `EventEmitter` — full 1:1 |
| `pi.exec` | `execFile` |
| `appendEntry` | `~/.gray/pi/entries.jsonl` (`/pi entries`) |
| `sendUserMessage`/`sendMessage` | `host.say` |
| `ctx.ui.select/confirm/input` | `host.ask` |
| `ctx.ui.editor` | `$EDITOR` on `/dev/tty` |
| `ctx.ui.notify` | OSC 777 to `/dev/tty` (fallback `host.say`) |
| `ctx.ui.setStatus`/`setWorkingMessage` | OSC 2 title `⬡ a · b` |
| `ctx.ui.setWidget` | string[] → widget snapshot when this plugin owns the slot |

## Inert (accepted, no wire)

Providers/virtual models, MCP registration, renderers, markdown
transformers, shortcuts, flags (stored), model/thinking switching,
sessionManager mutation, `ui.custom`/`setEditorComponent`/`setHeader`/
`setFooter`/`setTheme`, `ctx.abort`/`compact`/`shutdown`.

## Extension dirs (searched in order)

```
<cwd>/.pi/extensions/*.ts     project-local
~/.pi/agent/extensions/*.ts   pi's own dir — extensions shared 1:1
~/.gray/pi/extensions/*.ts    gray-only extras
```

Runtime imports (`typebox`, `@earendil-works/*`) resolve via symlink
farms at `~/.gray/pi/node_modules` and `~/.pi/agent/node_modules`,
created by setup against the global pi install.

## Setup / install

```sh
./gray-pi.mjs setup                    # jiti + symlink farms
gray plugin install "$PWD/gray-pi.mjs" # or copy into a scaffold
```

Deps: node ≥ 22.18 (for jiti TS) — v24 verified; `npm i jiti` in this
dir (or `setup` does it).

## Commands / state

`/pi status|list` — loaded extensions, tools, commands, errors ·
`/pi entries [n]` — appendEntry store · `/pi reload` — re-run factories ·
`/pi setup` — provision deps. Wire: manifest · tool/call · command/run ·
tool/before|after · input/submit · prompt/context · agent/before_start ·
context/build (passthrough) · event/notify · host.ask/host.say outbound.

Verified against the stock pi `goal.ts`: tool calls, /goal command,
before_agent_start injection, agent_settled nag, ui.notify — all live.

## Rust entry point

`src/main.rs` compiles to a real binary that embeds `gray-pi.mjs`,
materializes it to `~/.gray/pi/runtime-<ver>.mjs` (re-written when the
embedded copy differs), then `exec`s `node` — the process *becomes* the
bridge, zero proxy hop. Install the binary for the normal plugin shape:

```sh
cargo build --release
gray plugin install "$PWD/target/release/gray-pi"
```

Node ≥ 22.18 stays a runtime dep — pi extensions are TypeScript and need
real Node stdlib semantics; embedding a JS engine would break the 1:1
guarantee (same trade-off as gray-subagents' embedded Python).
