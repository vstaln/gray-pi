# gray-pi

Runs pi extensions **unmodified** under gray — a native Rust binary, no
Node. `.ts` extension factories are transpiled in-process with **oxc**
(`oxc_parser` → `oxc_semantic` → `oxc_transformer` → `oxc_codegen`, TS→ESM)
and evaluated in an embedded **QuickJS** runtime (`rquickjs`). Async
factories and handlers are driven to completion inside each hook call via
`Promise::finish` — host round-trips are synchronous Rust primitives, so
`await` resolves on the job queue, never on a timer.

The pi `ExtensionAPI`/`ExtensionContext` surface lives in `src/prelude.js`
(a faithful port of `reference/gray-pi.mjs`); Rust provides the NDJSON
transport, the module resolver/loader, and `__r_*` host primitives.
`reference/gray-pi.mjs` is kept as the behavioral reference.

## Loading

Extensions load from the same dirs pi uses:

    <cwd>/.pi/extensions/*.ts        (project)
    ~/.pi/agent/extensions/*.ts      (pi's own dir — true 1:1)
    ~/.gray/pi/extensions/*.ts       (gray-only extras; honors $GRAY_HOME)

Drop a `.ts` file in any of them and it loads on the next session (or
`/pi reload`). `import` of bare specifiers (`typebox`, `@earendil-works/*`,
node builtins `fs`/`path`/`os`/`child_process`/`url`/`util`/`events`) resolves
to embedded shim modules — curated implementations where the wire needs real
behavior (`Type.*` JSON schemas, `StringEnum`, `Text`, `truncateToWidth`,
`matchesKey`, fs/exec shims), deep-inert stubs for everything else (callable,
constructible, property access never throws).

## Emulated 1:1

| pi API | bridge |
|---|---|
| `pi.on("tool_call"/"tool_result")` | `tool/before` (deny/modify) / `tool/after` |
| `pi.on("input")` | `input/submit` (transform/handled) |
| `pi.on("before_agent_start")` | `agent/before_start` |
| `pi.on("context")` | `prompt/context` |
| `turn_end`/`agent_settled`/`tool_execution_*`/`session_*` | `event/notify` |
| `registerTool` / `registerCommand` | manifest `tools`/`commands` |
| `pi.exec` | `std::process` (cwd/timeout/env) |
| `pi.events` | JS `EventEmitter` |
| `appendEntry` / `sessionManager` | `~/.gray/pi/entries.jsonl` |
| `sendUserMessage`/`sendMessage` | `host/say` |
| `ui.select`/`confirm`/`input`/`editor` | `host/ask` / `$EDITOR` on `/dev/tty` |
| `ui.notify`/`setStatus`/`setWorkingMessage` | OSC 777 + title via `/dev/tty` |

## Inert (no wire equivalent)

provider/model registration, virtual models, renderers (`registerToolRenderer`,
message/entry renderers), shortcuts, `setModel`/`thinking` switch,
`ui.custom`/`setEditorComponent`/`setHeader`/`setFooter`/`setTheme`,
`compact`, MCP server registration. Registration calls are stored and
reportable via `/pi status`; everything else is a safe no-op.

Broken extensions never take down the wire: transpile/eval/handler errors
are collected and shown by `/pi status`; the sidecar keeps serving.

## Wire

`plugin/manifest` (aggregates loaded tools/commands), `plugin/shutdown`
(replies then exits), `tool/call`, `command/run` (`/pi status|entries|reload|setup`
plus extension commands), `tool/before`, `tool/after`, `input/submit`,
`prompt/context`, `agent/before_start`, `context/build`, `event/notify`
(`pre_tool`/`post_tool`/`turn_end`). Protocol `2.0`, capabilities
`["host.ask","host.say"]`. Unknown methods get an error frame. A stdin
reader thread feeds a channel — the reader is never joined, `host/*` waits
queue unrelated lines instead of dropping them.

Manifest name is `pi-ext` (`pi` is a reserved registry name — the one
deliberate divergence from the .mjs, whose manifest reported `pi`).

## CLI

`gray-pi` (NDJSON loop), `gray-pi manifest`, `gray-pi widget`,
`gray-pi setup` (no-op — nothing to provision).

## Verify

    cargo test && cargo build --release
    python3 ../.port-tasks/qa/drive.py target/release/gray-pi   # PASS

    # goal.ts + todo.ts unmodified:
    echo '{"id":1,"method":"plugin/manifest","params":{}}' | target/release/gray-pi
    echo '{"id":2,"method":"tool/call","params":{"name":"todo","args":{"action":"add","text":"x"}}}' | ...
