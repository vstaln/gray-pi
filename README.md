<div align="center">
  <img alt="gray-pi" src="assets/icon.svg" width="120" height="120" />
  <h1>gray-pi</h1>
  <p><strong>Run pi-compatible TypeScript extensions natively, with no Node process.</strong></p>
  <p>
    <a href="https://gray.alignment.id">Website</a> ·
    <a href="https://gray.alignment.id/plugins/gray-pi">Store</a> ·
    <a href="https://github.com/vstaln/gray-pi">Source</a> ·
    <a href="https://github.com/vstaln/gray">gray</a>
  </p>
  <p>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-1c1c20?style=flat-square&labelColor=0a0a0b" /></a>
    <a href="https://www.rust-lang.org"><img alt="Built with Rust" src="https://img.shields.io/badge/built%20with-rust-1c1c20?style=flat-square&labelColor=0a0a0b&logo=rust&logoColor=d4a373" /></a>
    <a href="https://gray.alignment.id/plugins/gray-pi"><img alt="gray plugin" src="https://img.shields.io/badge/gray-plugin-1c1c20?style=flat-square&labelColor=0a0a0b&color=7aa2f7" /></a>
  </p>
</div>

<br/>

```bash
gray plugin install gray-pi
```

A native Rust runtime for pi-shaped `.ts` extension factories — no Node
process required. TypeScript is transpiled in-process with **oxc**
(`oxc_parser` → `oxc_semantic` → `oxc_transformer` → `oxc_codegen`, TS→ESM)
and evaluated in an embedded **QuickJS** runtime (`rquickjs`).

Async factories and handlers are driven to completion inside each hook call
with `Promise::finish`. Host round-trips are synchronous Rust primitives, so
`await` resolves on the job queue rather than on a timer.

The pi `ExtensionAPI`/`ExtensionContext` surface lives in `src/prelude.js`;
Rust provides the NDJSON transport, module resolver/loader, and `__r_*` host
primitives for stdio, `/dev/tty`, process execution, and files.

## Loading

Extensions load from these directories:

    <cwd>/.pi/extensions/*.ts        (project)
    ~/.pi/agent/extensions/*.ts      (pi extension directory)
    ~/.gray/pi/extensions/*.ts       (gray-only extras; honors $GRAY_HOME)

Drop a `.ts` file in any of them and it loads on the next session (or after
`/pi reload`). Bare imports such as `typebox`, `@earendil-works/*`, and Node
builtins (`fs`, `path`, `os`, `child_process`, `url`, `util`, `events`)
resolve to embedded shim modules. APIs that need real behavior have curated
implementations; everything else receives a safe inert stub.

## API coverage

| pi API | gray bridge |
|---|---|
| `pi.on("tool_call"/"tool_result")` | `tool/before` (deny/modify) / `tool/after` |
| `pi.on("input")` | `input/submit` (transform/handled) |
| `pi.on("before_agent_start")` | `agent/before_start` |
| `pi.on("context")` | `prompt/context` |
| `turn_end`/`agent_settled`/`tool_execution_*`/`session_*` | `event/notify` |
| `registerTool` / `registerCommand` | manifest `tools`/`commands` |
| `pi.exec` | `std::process` (cwd/timeout/env) |
| `pi.events` | JavaScript `EventEmitter` |
| `appendEntry` / `sessionManager` | `~/.gray/pi/entries.jsonl` |
| `sendUserMessage`/`sendMessage` | `host/say` |
| `ui.select`/`confirm`/`input`/`editor` | `host/ask` / `$EDITOR` on `/dev/tty` |
| `ui.notify`/`setStatus`/`setWorkingMessage` | OSC 777 + title via `/dev/tty` |

## Inert surface

Provider/model registration, virtual models, renderers, shortcuts,
model/thinking switching, `ui.custom`, header/footer/theme setters,
compaction controls, and MCP server registration have no gray wire
equivalent. Registration calls are recorded for `/pi status`; other calls
are safe no-ops.

Broken extensions do not take down the sidecar: transpile, evaluation, and
handler errors are collected and shown by `/pi status` while the wire loop
keeps serving requests.

## Wire

`plugin/manifest` (aggregates loaded tools/commands), `plugin/shutdown`,
`tool/call`, `command/run` (`/pi status|entries|reload|setup` plus extension
commands), `tool/before`, `tool/after`, `input/submit`, `prompt/context`,
`agent/before_start`, `context/build`, and `event/notify`. Protocol `2.0`,
capabilities `["host.ask","host.say"]`.

The manifest name is `pi-ext` because `pi` is reserved in the gray registry.
A stdin reader thread feeds a channel, so `host/*` waits can queue unrelated
lines instead of dropping them.

## CLI

`gray-pi-ext` (NDJSON loop), `gray-pi-ext manifest`, `gray-pi-ext widget`,
and `gray-pi-ext setup` (currently a no-op). Install with
`gray plugin install <path-to-binary>` — manifest name `pi-ext`.

## Bundled pi index

`gray-pi` also ships the pi package index (absorbed from `gray-pi-index`),
so the ecosystem search/scaffold workflow lives in the same sidecar
(the original Rust implementation is preserved at `reference/gray-pi-index.rs`):

- `pi_search` — query npm for `keywords:pi-package` + `keywords:pi-extension`;
  results cache into `~/.gray/pi-index/index.json`.
- `pi_info` — registry details for one package, cross-referenced against
  `~/grayplugins/PORTS.md` for local port status.
- `pi_scaffold` — `gray account new` + `npm pack` vendoring +
  `SCAFFOLD-SPEC.md` with a ready-made port prompt.

All network goes through `curl`; scaffold shells out to `gray`, `npm`, and
`tar`. The `/pi` command covers both surfaces:

    /pi status|list|entries [n]|reload|setup    (runtime)
    /pi search [q]|info <pkg>|scaffold <pkg>    (index)

## Verify

```sh
cargo test
cargo build --release
printf '%s
' '{"id":1,"method":"plugin/manifest","params":{}}' | target/release/gray-pi-ext
```

## Tags

`gray` `plugin` `pi` `rust`

---
Part of the [gray](https://github.com/vstaln/gray) plugin ecosystem —
the open-source AI agent harness. <https://gray.alignment.id>
