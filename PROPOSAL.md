# PROPOSAL — Environment-agnostic MCP: one pure core, environment faces at the edges

Status: accepted for implementation.
Scope: `@orkestrel/mcp` (this repo), with a follow-up guide recipe in `@orkestrel/tool`.
Protocol scope: deliberately unchanged — `initialize` / `ping` / `tools/list` / `tools/call` only.
Compatibility: strictly additive. No breaking changes; next release is a normal patch bump.

## 1. Motivation and principle

`MCPServer` and `MCPClient` must run anywhere ECMAScript runs — Node processes, browser
pages, Web Workers, Service Workers — while every environment requirement (sockets,
streams, host globals) lives at the edges. The core owns the protocol; an environment
face owns nothing but transports plus one bootstrap.

The bootstrap pattern is borrowed from `@orkestrel/worker`'s `src/server/serve.ts`
(`serveWorker(options): void` — a self-contained entry that wires the environment's
native channel to the pure engine). This proposal generalizes that shape: each face
ships transports that satisfy a core-owned transport port, and, where the environment
is itself a hostable context (Web Worker, Service Worker), a `serve*` bootstrap.

## 2. Verified current state

- `src/core` is already pure ECMAScript: `MCPServer.ts`, `MCPClient.ts`, `parsers.ts`,
  `validators.ts`, `helpers.ts`, `constants.ts`, `factories.ts`, `types.ts` import only
  `@orkestrel/emitter`, `@orkestrel/agent` (types), `@orkestrel/contract`, and local
  modules. Zero `node:` imports, zero host globals. The `types: []` core gate enforces
  this.
- All environment coupling already sits in `src/server`: `@orkestrel/server`
  (`StreamInterface`, `openStream`, `UpgradeHandler`), `node:http`/`node:stream`/
  `node:child_process`/`node:crypto`/`node:https`, `@orkestrel/websocket`
  (`createNodeWebSocket`), `@orkestrel/sse`, `@orkestrel/router`.
- Dependency purity (gate U0, verified against published dists):
  `@orkestrel/agent@0.0.7` core — pure (its only `process.` occurrence is inside a
  TSDoc example comment); `@orkestrel/sse@0.0.3` — pure parser, browser-usable.
- House precedent for a three-face package: `@orkestrel/database` (also `router`,
  `indexeddb`, `console`, `workflow`) ships exports `.` / `./browser` / `./server`,
  with the browser face ESM-only (no `require` condition) and per-face
  `tsconfig`/`vite` configs and `check:src:*` scripts. That scaffold shape is the
  template this repo adopts.
- Runtime facts that shape testing: Node ≥ 22 provides global `WebSocket`, `fetch`,
  and `MessageChannel`/`MessagePort`, so every browser-face transport is testable in
  plain Vitest under the existing runner — no browser harness required for unit and
  integration coverage.

## 3. Architecture

```
                       ┌────────────────────────────────────────┐
                       │              src/core (pure)           │
                       │  MCPServer · MCPClient · parsers ·     │
                       │  validators · MCPTransportInterface ·  │
                       │  bindServer / bindClient               │
                       └───────┬───────────────┬────────────────┘
                               │               │
               ┌───────────────┴──┐         ┌──┴──────────────────────┐
               │   src/server     │         │      src/browser        │
               │   (Node face)    │         │  (page / worker face)   │
               │ stdio · node WS  │         │ native WebSocket client │
               │ streamable HTTP  │         │ fetch + SSE client      │
               │ sessions · MW    │         │ MessagePort srv/cli     │
               │                  │         │ serveMCP bootstrap      │
               └──────────────────┘         └─────────────────────────┘
```

### 3.1 Core additions (the keystone)

One new port interface plus two pure binders, in `src/core`:

```ts
/** A duplex message channel an environment face provides to the pure engine. */
export interface MCPTransportInterface {
	/** Deliver one outbound JSON-RPC message (already serialized). */
	readonly send: (message: string) => void | Promise<void>
	/** Register the single inbound-message handler. */
	readonly listen: (handler: (message: string) => void) => void
	/** Register the single closed handler (transport gone; binder tears down). */
	readonly closed: (handler: () => void) => void
	/** Close the underlying channel. */
	readonly close: () => void | Promise<void>
}

/** Pipe a transport into a server: inbound → dispatch, outbound reply → send. */
export function bindServer(server: MCPServerInterface, transport: MCPTransportInterface): () => void

/** Pipe a transport into a client: outbound request → send, inbound → resolve. */
export function bindClient(client: MCPClientInterface, transport: MCPTransportInterface): () => void
```

Contract points (binding, not cosmetic):

- Transport messages are serialized JSON-RPC strings; framing (WS frames, SSE events,
  stdio lines, `postMessage` payloads) is entirely the transport's concern; parsing
  and validation remain entirely the core's.
- The exact member names and option shapes must follow AGENTS §4 and the existing
  `types.ts` idiom (readonly members, `{Noun}Interface` naming); the sketch above
  fixes semantics, not spelling. Integration with `MCPClient`'s existing
  request/response correlation must reuse whatever send-hook the class already
  exposes — if the current client shape cannot accept an external transport without
  modification, the modification is additive (a new constructor option or factory),
  never a break.
- Both binders return an unbind function that detaches handlers and severs the pipe
  without closing the transport (closing is the caller's decision).
- `bindServer`/`bindClient` are total: a `send` rejection or throw surfaces through
  the engine's existing error reporting, never as an unhandled rejection.

### 3.2 Node face (`src/server`) — refactor onto the port, zero behavior change

Each existing transport (`StdioClientTransport`, `StdioServerTransport`,
`HTTPClientTransport`, `WebSocketClientTransport`, `WebSocketServerTransport`)
implements or adapts to `MCPTransportInterface`, and any private engine-wiring
duplicated per transport collapses into `bindServer`/`bindClient`. Public exports,
signatures, and behavior are unchanged — the existing server test suite passing
unmodified is the acceptance proof. Where a transport's current shape is not
literally a duplex message channel (e.g. streamable HTTP's request/response +
session-SSE model), it keeps its bespoke wiring and is NOT force-fitted — the port
is for message-channel transports; HTTP's session machinery stays as is.

### 3.3 Browser face (`src/browser`) — new

Scaffold: `configs/src/tsconfig.browser.json`, `vite.browser.config.ts`,
`build:src:browser`, `check:src:browser`, exports entry `./browser` (ESM-only,
mirroring `@orkestrel/database`). Type-check `lib: ["ESNext", "WebWorker"]` — every
API this face needs (`WebSocket`, `fetch`, `ReadableStream`, `MessagePort`,
`crypto.randomUUID`, `queueMicrotask`) exists in `WorkerGlobalScope`, so checking
against the worker lib guarantees the face runs identically in pages, Web Workers,
and Service Workers, and makes DOM leakage a compile error. If the shared scaffold's
browser blueprint pins a different lib, the stricter of the two wins and the
deviation is recorded in the PR.

Modules (final names per AGENTS §4; anatomy mirrors `src/server`):

1. `transports/WebSocketClientTransport.ts` — `MCPTransportInterface` over the native
   `WebSocket` global. The host performs the handshake, so none of the Node client's
   `node:crypto`/`node:http(s)` machinery exists here. Options: `url`, optional
   `protocols`. Queues sends until `open`; maps `close`/`error` to `closed`.
2. `transports/HTTPClientTransport.ts` — streamable-HTTP client over native `fetch`
   with `ReadableStream` + `@orkestrel/sse` for the event-stream leg, honoring the
   same `mcp-session-id` semantics as the Node face's client so it interoperates
   with `MCPSession`-based servers unchanged.
3. `transports/MessagePortTransport.ts` — the genuinely new capability: MCP over
   `postMessage`. One transport class both sides use (a `MessagePort` is symmetric);
   client and server roles come from which binder it is handed to. `start()`s the
   port, serializes messages as plain strings, maps `messageerror`/close to `closed`.
4. `serve.ts` — the `serveWorker` analog:

   ```ts
   export interface ServeMCPOptions {
   	readonly tools: ToolManagerInterface
   	readonly name?: string
   	readonly version?: string
   }
   /** Boot an MCPServer inside a Web Worker or Service Worker and wire self's
    *  message events to it. Dedicated worker: binds the implicit self channel.
    *  Service worker: accepts a MessagePort per connecting client (multi-client),
    *  detected via the global scope's shape — no user flag needed. */
   export function serveMCP(options: ServeMCPOptions): () => void
   ```

   Differences from worker's `serve.ts`, stated deliberately: browser workers load
   bundled code, so `serveMCP` imports project code freely — the inlined-guards
   AGENTS §5 exception that `node:worker_threads` type-stripping forces does NOT
   apply and must not be copied. Returns a dispose function (unbinds, closes ports).

5. `helpers.ts` / `factories.ts` / `constants.ts` / `types.ts` / `index.ts` — per
   scaffold anatomy; host-global helpers (`generateId` via `crypto.randomUUID`) live
   here, never in core, per the purity law.

### 3.4 What this face does NOT do (recorded so nobody infers it)

- A page cannot listen on a raw TCP/WebSocket server; hosting a page's `MCPServer`
  for an EXTERNAL agent requires a relay/bridge process (the WebMCP daemon shape).
  The MessagePort face is the in-browser foundation such a bridge would build on;
  the bridge itself is out of scope for this upgrade.
- No protocol expansion: resources/prompts/sampling remain a separate proposal.
- No pairing/token ceremony: auth stays composed in front as middleware on the Node
  face; browser-face auth is the embedding application's concern.

## 4. Test plan

All in the existing Vitest setup (Node ≥ 22 globals), mirror-path under `tests/src/`:

- **Core port** (`tests/src/core/…`): binder round trips over an in-memory transport
  (a 20-line test double); unbind detaches without closing; send-throw surfaces
  through engine error reporting, never unhandled; double-listen/closed idempotence.
- **Node-face regression**: the existing server suite passes UNCHANGED — the proof
  the refactor moved wiring without moving behavior.
- **Browser face** (`tests/src/browser/…`):
  - MessagePort: `new MessageChannel()`; `serveMCP`-style server on port1 (via the
    same code path exercised with an injected scope double for `self`), client bound
    to port2; full `initialize → tools/list → tools/call` round trip; multi-client
    (two channels) isolation; teardown via the returned dispose.
  - WebSocket: browser-face client (global `WebSocket`) against this repo's own
    Node-face `WebSocketServerTransport` in-process — full round trip; queued-send
    before open; server-initiated close maps to `closed`.
  - HTTP: browser-face client (global `fetch`) against the Node face's
    streamable-HTTP session server — round trip incl. session id reuse and SSE leg.
  - Hostile coverage at the same bar as the rest of the ecosystem: malformed inbound
    frames (non-JSON, oversized, wrong-type payload objects on `postMessage`),
    transport failure mid-request, close-during-flight, and — for `serveMCP` — a
    Service-Worker-shaped scope double whose event objects carry no ports.
- **Guides parity**: every new export gets its `guides/src/mcp.md` row + fence, with
  fence outputs verified by scratch-running equivalents.

## 5. Unit breakdown (delivery order)

| Unit | Content                                                                                                       | Acceptance                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| U0   | Dependency purity gate                                                                                        | DONE (recorded in §2)                                                                       |
| U1   | Core: `MCPTransportInterface` + `bindServer`/`bindClient` (+ any additive engine hook they need) + core tests | pure (`check:src:core` with `types: []`), binder tests green, no public-surface breaks      |
| U2   | Node face refactored onto the port                                                                            | existing server tests pass unchanged; no export/signature diffs                             |
| U3   | Browser face scaffold + `WebSocketClientTransport` + `HTTPClientTransport` + tests                            | `check:src:browser` (WebWorker lib) green; WS + HTTP round trips against the Node face pass |
| U4   | `MessagePortTransport` + `serveMCP` + tests                                                                   | MessageChannel round trips, multi-client, dispose, hostile frames all green                 |
| U5   | Guides parity + release                                                                                       | all gates green tree-wide; `guides` parity green; version bump + publish (owner)            |

U1+U2 ship as one commit (the port is only provable against the refactored face);
U3+U4 as a second; U5 rides with the final audit. Each lands through the standard
build → checker + reviewer + verifier cycle before commit.

## 6. Follow-up (separate, in `@orkestrel/tool`)

One guide recipe, no code: infer a schema from live data in the page
(`samplesToSchema`) → `createEndpointTool` (advertised + enforced via
`schemaToShape`) → `serveMCP` in a Service Worker → an in-page agent client over a
`MessageChannel`. That is the full "website exposes validated tools to an agent"
loop, assembled from shipped parts.

## 7. Risks and mitigations

- **Client engine may not accept an external transport cleanly** — mitigation:
  additive hook only (option/factory), U1 acceptance forbids signature breaks; if the
  engine genuinely cannot host the hook additively, the unit stops with a deviation
  report rather than forcing it.
- **WebWorker lib vs shared scaffold drift** — mitigation: adopt the stricter lib;
  record the decision in the PR; keep the face DOM-free either way.
- **HTTP session interop subtleties** (browser fetch vs Node client differences,
  e.g. header casing, stream cancellation) — mitigation: the U3 integration test runs
  against this repo's real session server, not a mock.
- **Service Worker realism** — unit tests use scope doubles; a true SW end-to-end run
  needs a browser harness (Playwright is available in this environment) and is noted
  as optional follow-up, not a gate for this release.
