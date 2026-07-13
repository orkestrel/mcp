# MCP

> The [Model Context Protocol](https://modelcontextprotocol.io) layer — the bridge between this library's [`ToolManager`](agents.md) and the wider MCP ecosystem, in both directions. **Ingress:** `createMCPServer` wraps a live `ToolManager` as an MCP server any MCP client can drive. **Egress:** `createMCPClient` drives a _remote_ MCP server and surfaces its tools as local [`Tool`](agents.md)s an agent can call as if they were its own. Four methods carry both directions — `initialize` (version handshake + capability advertise), `ping` (liveness), `tools/list` (discovery), `tools/call` (execution).
>
> The split that keeps it lean: **the dispatch core is transport-agnostic and provider-agnostic.** `MCPServer` and `MCPClient` live in `src/core/mcp` and import only core siblings (JSON-RPC + the tool registry + the timeout primitive) — **no HTTP, no model, no `as`** (all wire input is narrowed via the [contracts](contracts.md) guards, §14). The server is pure logic with two entry points: `dispatch(request)` runs an already-parsed `JSONRPCRequest` → a `JSONRPCResponse` (or `undefined` for a notification); `handle(message)` is the string boundary — `JSON.parse` → narrow → dispatch → `JSON.stringify` (a parse failure → `-32700`, a non-request → `-32600`, a notification → `undefined`). The client mirrors it: `connect` (the `initialize` handshake), `tools()` (discover the remote tools as local `Tool`s), `call` (run one — a remote failure throws locally, so an agent's `ToolManager` isolates it exactly like a local throw).
>
> The wire lives ONE layer out, in `src/server/mcp` — two interchangeable server transports over the [HTTP spine](http.md), each a matched ingress/egress pair, both speaking the SAME `MCPServerInterface` / `ClientTransportInterface` (only the framing differs):
>
> - **Streamable HTTP** — `createMCPRoutes` mounts a server as `POST {path}` (JSON or SSE per the client's `Accept`); the opt-in `createMCPSession` middleware adds stateful sessions + a resumable server→client SSE channel. `createHTTPClientTransport` is the `fetch` egress.
> - **WebSocket** — `createWebSocketServer` claims an upgrade on the spine's [upgrade seam](http.md), composing the lean [`NodeWebSocket`](websocket.md) RFC 6455 wrapper for a full-duplex alternative over one persistent connection. `createWebSocketClientTransport` is the `node:http(s)`-upgrade egress.
>
> Every transport is **mechanism, not policy** — auth / CORS / rate-limiting compose IN FRONT as ordinary middleware; the transport bakes in none. Observable (§13): the `MCPServer` owns an `emitter` firing `request` per dispatch; the `MCPClient` owns one firing `connect` / `disconnect` / `notification`. Source: [`src/core/mcp`](../../src/core/mcp) (the dispatch core + the client, via `@src/core`) + [`src/server/mcp`](../../src/server/mcp) (the HTTP transports, via `@src/server`).

## Surface

Create a server over a live tool registry, then pump message strings through `handle` (or call `dispatch` directly with a parsed request):

```ts
import { createMCPServer, createTool, createToolManager } from '@src/core'

const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))

const server = createMCPServer({ name: 'calculator', version: '1.0.0', tools })
server.emitter.on('request', (method, id) => log(method, id)) // §13 tracing

// A transport pumps message strings through `handle`:
const reply = await server.handle('{"jsonrpc":"2.0","method":"tools/list","id":1}')
// reply → '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"add","inputSchema":{"type":"object"}}]}}'

const out = await server.handle(
	'{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"add","arguments":{"x":2,"y":5}}}',
)
// out → '…"result":{"content":[{"type":"text","text":"7"}]}}'
```

`dispatch` is the typed core; `handle` wraps it with the `JSON.parse` ↔ `JSON.stringify` string boundary and the parse / invalid-request error mapping. A request with NO `id` is a **notification** — handled (the `request` event still fires) but it yields NO response (`dispatch` resolves `undefined`, `handle` returns `undefined`), whatever its method. Tool errors are NOT protocol errors: the [`ToolManager`](agents.md) isolates a thrown tool into a result `error`, which `tools/call` maps to an `isError: true` tool result the model can react to — so the server wraps `execute` in NO try/catch.

### Factories

| API               | Kind     | Summary                                                                                                                               |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `createMCPServer` | function | Create an `MCPServerInterface` exposing a live `ToolManager` over JSON-RPC 2.0 (`initialize` / `ping` / `tools/list` / `tools/call`). |
| `createMCPClient` | function | Create an `MCPClientInterface` that drives a REMOTE server over an injected transport and exposes its tools as local `Tool`s.         |

### Entities

| API         | Kind  | Summary                                                                                                      |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `MCPServer` | class | The transport-agnostic JSON-RPC dispatch core over a `ToolManager` — `dispatch` (typed) + `handle` (string). |
| `MCPClient` | class | The transport-agnostic JSON-RPC client over a `ClientTransportInterface` — `connect` / `tools` / `call`.     |

### Constants

| Constant                      | Kind  | Value                                                                                   |
| ----------------------------- | ----- | --------------------------------------------------------------------------------------- |
| `MCP_PROTOCOL_VERSION`        | const | `'2025-06-18'` — the protocol revision this server implements (the default negotiated). |
| `SUPPORTED_PROTOCOL_VERSIONS` | const | A frozen list of negotiable revisions (the current + a prior, `'2025-03-26'`).          |
| `JSONRPC_PARSE_ERROR`         | const | `-32700` — invalid JSON was received (the message did not parse).                       |
| `JSONRPC_INVALID_REQUEST`     | const | `-32600` — the payload was not a valid Request object.                                  |
| `JSONRPC_METHOD_NOT_FOUND`    | const | `-32601` — the requested method does not exist.                                         |
| `JSONRPC_INVALID_PARAMS`      | const | `-32602` — the method's parameters were invalid.                                        |
| `JSONRPC_SERVER_ERROR`        | const | `-32000` — an implementation-defined server error.                                      |
| `DEFAULT_MCP_CLIENT_NAME`     | const | `'taverna'` — the default client name reported in the `initialize` handshake.           |
| `DEFAULT_MCP_CLIENT_VERSION`  | const | `'1.0.0'` — the default client version reported in the `initialize` handshake.          |
| `DEFAULT_MCP_REQUEST_TIMEOUT` | const | `30000` — the default per-request deadline (ms) an `MCPClient` applies.                 |

### Helpers

| API                    | Kind     | Summary                                                                                                       |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `isRequestId`          | function | Total guard (§14): a JSON-RPC REQUEST `id` — a string / number / absent (`null` is valid only on a response). |
| `isJSONRPCRequest`     | function | Total guard (§14): a record with `jsonrpc: '2.0'` + a string `method`; an absent `id` ⇒ a notification.       |
| `isJSONRPCResponse`    | function | Total guard: `jsonrpc: '2.0'` + an `id` (string / number / `null`) + EXACTLY ONE of `result` / `error`.       |
| `isJSONRPCMessage`     | function | Total guard — the union of `isJSONRPCRequest` and `isJSONRPCResponse`.                                        |
| `isInitializeRequest`  | function | Total guard — a `JSONRPCRequest` whose `method` is `'initialize'`.                                            |
| `parseJSONRPCMessage`  | function | Narrow an already-parsed value to a `JSONRPCMessage`, or `undefined` (total; sound with `isJSONRPCMessage`).  |
| `jsonRPCResult`        | function | Build a success `JSONRPCResponse` — the `id` echoed, the value as `result`.                                   |
| `jsonRPCError`         | function | Build an error `JSONRPCResponse` — the `id`, a reserved `code` / `message`, and optional `data`.              |
| `buildToolDescriptors` | function | Map a `ToolManager`'s definitions to `tools/list` descriptors, renaming `parameters` → `inputSchema`.         |
| `buildToolResult`      | function | Map a `ToolResult` to an MCP tool-call result — the value (or error text + `isError: true`) as a text block.  |
| `initializeResult`     | function | Build the `initialize` result — the negotiated `protocolVersion`, `capabilities`, and `serverInfo`.           |

### Types

| Type                       | Kind      | Shape                                                                                                                                |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `JSONRPCRequest`           | interface | `{ jsonrpc: '2.0'; method: string; id?: string \| number; params?: Record<string, unknown> }` — an absent `id` marks a notification. |
| `JSONRPCErrorData`         | interface | `{ code: number; message: string; data?: unknown }` — the `error` member of a failed response.                                       |
| `JSONRPCResponse`          | interface | `{ jsonrpc: '2.0'; id: string \| number \| null; result?: unknown; error?: JSONRPCErrorData }` — EITHER `result` OR `error`.         |
| `JSONRPCMessage`           | type      | `JSONRPCRequest \| JSONRPCResponse` — a message on the wire.                                                                         |
| `MCPContent`               | interface | `{ type: 'text'; text: string }` — one content block of a tool-call result.                                                          |
| `MCPToolResult`            | interface | `{ content: readonly MCPContent[]; isError?: boolean }` — the `tools/call` result (`isError` flags a tool failure).                  |
| `MCPToolDescriptor`        | interface | `{ name: string; description?: string; inputSchema: Record<string, unknown> }` — one `tools/list` entry.                             |
| `MCPServerInfo`            | interface | `{ name: string; version: string }` — the identity echoed in the `initialize` result.                                                |
| `MCPServerEventMap`        | type      | `{ request: [method, id] }` — the §13 observation surface.                                                                           |
| `MCPServerOptions`         | interface | `{ on?; error?; name: string; version: string; tools: ToolManagerInterface; description? }` — options for `createMCPServer`.         |
| `MCPServerInterface`       | interface | `emitter` / `name` / `version` data members + the `dispatch` / `handle` methods.                                                     |
| `ClientTransportEventMap`  | type      | `{ message: [JSONRPCMessage]; close: []; error: [unknown] }` — the §13 transport events.                                             |
| `ClientTransportInterface` | interface | `emitter` / `session` data members + the `start` / `send` / `close` methods — the client's transport-agnostic carrier.               |
| `MCPClientEventMap`        | type      | `{ connect: []; disconnect: []; notification: [JSONRPCMessage]; error: [unknown] }` (§13).                                           |
| `MCPClientOptions`         | interface | `{ on?; error?; transport: ClientTransportInterface; name?; version?; timeout? }` — options for `createMCPClient`.                   |
| `MCPClientInterface`       | interface | `emitter` / `connected` / `transport` data members + the `on` / `connect` / `disconnect` / `tools` / `call` methods.                 |

The `emitter`, `name`, and `version` members of `MCPServerInterface` are `readonly` data members (Surface rows, above) — its call-signature methods are documented under [Methods](#methods). Likewise the `emitter` / `connected` / `transport` members of `MCPClientInterface` and the `emitter` / `session` members of `ClientTransportInterface` are data members; their methods are under [Methods](#methods). The `id` member of `MCPSessionInterface` is likewise a data member; its methods (`attach` / `detach` / `push` / `replay`) are under [Methods](#methods).

### HTTP transport

The **Streamable HTTP transport** (`src/server/mcp`, via the `@src/server` barrel) mounts a transport-agnostic `MCPServerInterface` on the [HTTP spine](http.md) as route handlers. `createMCPRoutes` returns the routes to register; it is **mechanism, not policy** — compose auth / CORS / rate-limiting (`createTokenGuard` / `createCors` / `createRateLimiter`) IN FRONT as ordinary middleware.

```ts
import { createMCPServer, createToolManager } from '@src/core'
import { createCors, createErrorBoundary, createMCPRoutes, createServer } from '@src/server'

const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })

const server = createServer()
server.use(createErrorBoundary())
server.use(createCors()) // policy composes IN FRONT — the transport adds none
server.route(createMCPRoutes(mcp)) // POST /mcp dispatches JSON-RPC (JSON or SSE per Accept)
await server.start()
```

`createMCPRoutes` is **stateless**: a single `POST {path}` route pumps each request body through `mcp.dispatch`. A client that `Accept`s `text/event-stream` gets the JSON-RPC reply framed as a Streamable-HTTP SSE response (one `data:` event, then the stream ends) over the [generic SSE seam](http.md); otherwise a plain JSON body — the JSON-RPC envelope is identical. `GET` / `DELETE` to the path are answered by the spine's automatic `405` (the resumable server→client GET-SSE channel + session-end live in the session middleware below).

**Sessions are a separate, plug-and-play middleware that BUILDS ON the spine's generic [`createSession`](http.md).** `createMCPSession` is a `Middleware` (the `createRateLimiter` / `createTokenGuard` / `createCors` style); compose it via `server.use(createMCPSession())` IN FRONT of a session-agnostic `createMCPRoutes(mcp)`. The generic resolve / mint / validate-or-404 / `DELETE`-end / idle-TTL machinery (the closure session `Map`, the lazy eviction, the `mcp-session-id` header round-trip) all come from `createSession` — sessions are a first-class, reusable HTTP primitive, and MCP is its first consumer. `createMCPSession` only CONFIGURES it for the MCP wire (the `mcp-session-id` header via `MCP_SESSION_HEADER`, an `MCPSession` per id via `create`, `mint` returning true only for an `initialize` POST, `require` with `onMissing` = `rejectUnknownSession`) and adds the ONE MCP-specific piece on top — the resumable server→client `GET` SSE stream. It OWNS the same `path` and makes the transport STATEFUL: an `initialize` POST MINTS a session id returned in the `mcp-session-id` response header; every subsequent POST must echo a VALID id (a missing / unknown one → a transport-level `404` with a JSON-RPC error body); a resumable `GET {path}` opens a long-lived server→client SSE stream for the session; and a `DELETE {path}` ends the session (`204`). Omit the middleware for the byte-identical stateless default — `createMCPRoutes` mints / reads nothing, and `GET` / `DELETE` get the spine's automatic `405` (the minimal-interface contract, AGENTS §21). The WebSocket transport is inherently ONE session per connection, so it carries no session header — `createMCPSession` is for the HTTP transport.

**Resumable server→client push.** Each `MCPSession` FOLDS IN a bounded replay log; `session.push(message)` APPENDS the message to that log with a monotone event id AND fans it out to every open `GET {path}` SSE stream as one `id:`-tagged event. An in-request handler addresses the current session via `context.state.get(MCP_SESSION_STATE)` (the `createMCPSession` middleware sets it on every validated request). A client opens the `GET` (with `Accept: text/event-stream` + its `mcp-session-id`) to receive pushes live; on a dropped connection it RECONNECTS sending the `Last-Event-ID` of the last event it saw, and the server REPLAYS every logged event strictly after that id (in order) before resuming live pushes. A `Last-Event-ID` the log no longer retains (evicted past `capacity` / `ttl`, or never seen) replays NOTHING — the spec-sane resume that never re-delivers un-lost events. The log is a plain in-memory `Map` with capacity + lazy-TTL eviction (§21 — NO database mirror).

#### Factories

| API                         | Kind     | Summary                                                                                                                                                                                                                                                                 |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMCPRoutes`           | function | Mount an `MCPServerInterface` on the HTTP spine — returns the `RouteInput[]` for `server.route(...)` (a single STATELESS `POST` route).                                                                                                                                 |
| `createHTTPClientTransport` | function | Create a `ClientTransportInterface` over `fetch` that drives a REMOTE Streamable-HTTP MCP server (the egress mirror).                                                                                                                                                   |
| `createMCPSession`          | function | Create the opt-in session `Middleware` — builds on the spine's generic `createSession` (configured for the `mcp-session-id` header + an `MCPSession` + mint-on-`initialize` + require-404), adding the resumable `GET` SSE stream; mount in front of `createMCPRoutes`. |

#### Entities

| API                   | Kind  | Summary                                                                                                                                                                                                 |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTPClientTransport` | class | The HTTP `ClientTransportInterface` over `fetch` — POSTs each message, decodes the JSON / SSE reply onto the `message` event.                                                                           |
| `MCPSession`          | class | One MCP transport session — its `id` + attached SSE streams + the FOLDED bounded replay log (`Map` + capacity + lazy TTL); `push`/`attach`/`detach`/`replay` drive the resumable server→client channel. |

#### Constants

| Constant                       | Kind  | Value                                                                                                                            |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_SESSION_HEADER`           | const | `'mcp-session-id'` — the session header `createMCPSession` sets on `initialize` + reads thereafter.                              |
| `MCP_PROTOCOL_VERSION_HEADER`  | const | `'mcp-protocol-version'` — the transport protocol-version header (the result body remains the source).                           |
| `MCP_SESSION_STATE`            | const | `'mcp:session'` — the `context.state` key `createMCPSession` stashes the resolved `MCPSession` under (the in-request push hook). |
| `DEFAULT_MCP_PATH`             | const | `'/mcp'` — the default path `createMCPRoutes` mounts the `POST` at (and `createMCPSession` owns for `GET` / `DELETE`).           |
| `DEFAULT_MCP_SESSION_CAPACITY` | const | `1024` — the default max retained pushed messages in a session's folded resumable event log (oldest evicted past it).            |
| `DEFAULT_MCP_SESSION_TTL`      | const | `300000` — the default per-event idle lifetime (ms, 5 min) of a session's folded event log; a staler entry is lazily evicted.    |

#### Helpers

| API                    | Kind     | Summary                                                                                                          |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `acceptsEventStream`   | function | Whether the request's `Accept` header contains `text/event-stream` (narrowed with `typeof`, §14).                |
| `readSessionHeader`    | function | Read the request's `mcp-session-id` header for the stateful transport, or `undefined` (narrowed, §14).           |
| `readLastEventId`      | function | Read the request's `Last-Event-ID` header — the resumable GET-SSE replay cursor, or `undefined` (narrowed, §14). |
| `rejectUnknownSession` | function | Send the stateful transport's unknown-session reply — a `404` + a JSON-RPC `-32600` "Session not found" body.    |
| `readEventStream`      | function | Decode a `fetch` Response's SSE body into the `JSONRPCMessage`s it carried (the egress inverse; total, §14).     |
| `decodeEvent`          | function | Decode one SSE event's `data` string into a `JSONRPCMessage`, or `undefined` (total, §14).                       |

#### Types

| Type                         | Kind      | Shape                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTPTransportOptions`       | interface | `{ path?: string; streaming?: boolean }` — the mount path (default `/mcp`) + whether an SSE response is allowed (default `true`) for `createMCPRoutes`.                                                                                                                |
| `HTTPClientTransportOptions` | interface | `{ url: string; headers?: Record<string, string> }` — the remote endpoint + extra request headers for `createHTTPClientTransport`.                                                                                                                                     |
| `MCPSessionOptions`          | interface | `{ path?: string; ttl?: number; capacity?: number; clock?: () => number }` — the owned path (default `/mcp`), session idle TTL (ms), folded replay-log bound, + the deterministic clock seam (threaded to `createSession`; default `Date.now`) for `createMCPSession`. |
| `MCPSessionInterface`        | interface | `id` data member + `attach` / `detach` / `push` / `replay` methods — one session + its resumable server→client push channel (the `MCPSession` entity).                                                                                                                 |
| `EventStoreEntry`            | interface | `{ id: string; message: JSONRPCMessage; timestamp: number }` — one logged pushed message (the unit `MCPSession.replay` returns).                                                                                                                                       |

### WebSocket transport

The **WebSocket transport** (`src/server/mcp`, via the `@src/server` barrel) is the second server transport — a full-duplex alternative to the HTTP transport over a single persistent connection. `createWebSocketServer` returns an `UpgradeHandler` to register on the [HTTP spine](http.md)'s `server.upgrade(...)` seam; it composes the lean [`NodeWebSocket`](websocket.md) RFC 6455 wrapper and pumps each inbound JSON-RPC request through `mcp.dispatch`. `createWebSocketClientTransport` is the egress mirror — a `ClientTransportInterface` an `MCPClient` drives over a `node:http(s)` upgrade. Both `WebSocketServerTransport` and `WebSocketClientTransport` REUSE the same `ClientTransportInterface` the HTTP client transport implements (a generic bidirectional JSON-RPC channel — `emitter` / `start` / `send` / `close`, `session` `undefined` for the stateless v1), so the WebSocket and HTTP transports share ONE transport contract. Like the HTTP transport it is **mechanism, not policy** — compose an auth guard IN FRONT by registering a `server.upgrade(...)` handler BEFORE this one (it can decline + destroy an unauthenticated upgrade).

```ts
import { createMCPClient, createMCPServer, createToolManager } from '@src/core'
import { createServer, createWebSocketClientTransport, createWebSocketServer } from '@src/server'

const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
const server = createServer()
server.upgrade(createWebSocketServer(mcp)) // claims an MCP WebSocket upgrade to /mcp
await server.start()

// An MCP client connects over the SAME MCPClient, a WebSocket transport instead of HTTP:
const client = createMCPClient({
	transport: createWebSocketClientTransport({ url: `ws://127.0.0.1:${server.port}/mcp` }),
})
await client.connect() // the RFC 6455 handshake, then the MCP initialize over frames
```

A claimed WebSocket upgrade socket is OWNED by the upgrade handler — it is no longer in `node:http`'s tracked connection set — so a graceful `server.stop()` does NOT proactively close live WS sockets: it waits for them and then force-closes at the drain deadline. To tear live WebSocket connections down immediately, use `server.destroy()` (force-close-all). Proactive WS-socket tracking on the stop signal (so `stop()` closes them up front rather than at the deadline) is a deferred follow-up whose natural home is the sessions tier, which will own per-connection lifecycle.

#### Factories

| API                              | Kind     | Summary                                                                                                                                            |
| -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWebSocketServer`          | function | Mount an `MCPServerInterface` over WebSocket — returns an `UpgradeHandler` for `server.upgrade(...)` (claims an MCP WS upgrade, pumps `dispatch`). |
| `createWebSocketClientTransport` | function | Create a `ClientTransportInterface` that drives a REMOTE MCP server over a WebSocket (the WS egress mirror).                                       |

#### Entities

| API                        | Kind  | Summary                                                                                                                           |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketServerTransport` | class | The per-connection JSON-RPC-over-WebSocket SERVER bridge over a `NodeWebSocket` — a `ClientTransportInterface` the ingress pumps. |
| `WebSocketClientTransport` | class | The WebSocket `ClientTransportInterface` — handshakes, then bridges the upgraded socket's frames as the client's message channel. |

#### Constants

| Constant                    | Kind  | Value                                                                                                                            |
| --------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_WEBSOCKET_SUBPROTOCOL` | const | `'mcp'` — the WebSocket subprotocol the transports negotiate (`Sec-WebSocket-Protocol`); the default path is `DEFAULT_MCP_PATH`. |

#### Helpers

| API                  | Kind     | Summary                                                                                                            |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `upgradeRequestPath` | function | Read a raw `node:http` upgrade request's path (no query) for the `createWebSocketServer` upgrade-path match (§14). |

#### Types

| Type                              | Kind      | Shape                                                                                                                                |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `WebSocketServerOptions`          | interface | `{ path?: string; subprotocol?: string }` — the upgrade path (default `/mcp`) + the negotiated subprotocol (default `'mcp'`).        |
| `WebSocketClientTransportOptions` | interface | `{ url: string; headers?: Record<string, string> }` — the remote WS endpoint (`ws(s)://` or `http(s)://`) + extra handshake headers. |

## Methods

The public methods of the layer's behavioral interfaces — every call-signature member listed (their `readonly` data members stay Surface rows). Each implementing class exposes EXACTLY its interface's methods (AGENTS §22): `MCPServer` ↔ `MCPServerInterface`, `MCPClient` ↔ `MCPClientInterface`, the THREE transports `HTTPClientTransport` / `WebSocketServerTransport` / `WebSocketClientTransport` ↔ `ClientTransportInterface` (all three share the one generic bidirectional JSON-RPC carrier — only the wire framing differs, so they add no new behavioral interface), and the session entity `MCPSession` ↔ `MCPSessionInterface` (the folded replay log is private to it).

#### `MCPServerInterface`

`dispatch` is the typed JSON-RPC core (runs a parsed request, resolves the response or `undefined` for a notification); `handle` is the string boundary that wraps it with parse / serialize and the parse / invalid-request error mapping.

| Method     | Returns                                 | Behavior                                                                                                                                                                              |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch` | `Promise<JSONRPCResponse \| undefined>` | Emit `request`, then run the method (`initialize` / `ping` / `tools/list` / `tools/call`); resolve the response, or `undefined` for a notification or an unknown-method notification. |
| `handle`   | `Promise<string \| undefined>`          | `JSON.parse` → narrow to a request → `dispatch` → `JSON.stringify`. A parse failure → a `-32700` string; a non-request → a `-32600` string; a notification → `undefined`.             |

#### `MCPClientInterface`

The egress mirror: `connect` handshakes, `tools` discovers + wraps the remote tools as local `Tool`s, `call` runs a remote `tools/call`, `disconnect` rejects pending + closes; `on` is the §13 convenience forward to `emitter.on`.

| Method       | Returns                             | Behavior                                                                                                                              |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `on`         | `void`                              | Subscribe a listener to a `MCPClientEventMap` event (`connect` / `disconnect` / `notification` / `error`) — forwards to `emitter.on`. |
| `connect`    | `Promise<void>`                     | Open the transport, run the `initialize` handshake, send `notifications/initialized`, set `connected`, fire `connect`. Idempotent.    |
| `disconnect` | `Promise<void>`                     | Reject every pending request, close the transport, fire `disconnect`. Idempotent.                                                     |
| `tools`      | `Promise<readonly ToolInterface[]>` | Run `tools/list` and wrap each descriptor as a local `Tool` (`inputSchema` → `parameters`; `execute` calls back via `call`).          |
| `call`       | `Promise<unknown>`                  | Run a remote `tools/call`, concat the result's text blocks, throw on `isError`, else parse the JSON value (raw-string fallback).      |

#### `ClientTransportInterface`

The client's transport-agnostic carrier — `start` opens, `send` writes a message / batch (its replies surface on `emitter`'s `message`), `close` tears down.

| Method  | Returns         | Behavior                                                                                                            |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `start` | `Promise<void>` | Open the transport and arm any reply reader (a no-op for a request/response transport).                             |
| `send`  | `Promise<void>` | Write one JSON-RPC message (or a batch) to the remote server; each decoded reply is emitted on the `message` event. |
| `close` | `Promise<void>` | Close the transport and release resources (fires `close`).                                                          |

#### `MCPSessionInterface`

One MCP transport session (the `MCPSession` entity) — its `id` is a data member (Surface row); the methods below drive the resumable server→client push channel, with the bounded replay log FOLDED IN (private). `createMCPSession` mints + stores it; an in-request handler reads it off `context.state` and `push`es.

| Method   | Returns                      | Behavior                                                                                                                                       |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `attach` | `void`                       | Register an OPEN server→client SSE stream (a resumable `GET {path}`) so future `push`es reach it.                                              |
| `detach` | `void`                       | Unregister a stream — called when the client disconnects (the `bindStreamingAbort` binding).                                                   |
| `push`   | `string`                     | Append `message` to the folded log under a fresh MONOTONE id (returned) AND fan it out to every attached stream as one `id:`-tagged SSE event. |
| `replay` | `readonly EventStoreEntry[]` | Every retained log entry STRICTLY AFTER `afterId`, in order; an unknown / evicted cursor replays nothing (the spec-sane resume).               |

## Contract

These invariants hold across the MCP layer (`src/core/mcp` + `src/server/mcp`) ↔ `mcp.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `const` / `interface` / `type` row in the `## Surface` tables (the core dispatch tables AND the `### HTTP transport` + `### WebSocket transport` tables) is a real export of the mcp layer (`src/core/mcp` or `src/server/mcp`), and every export of either appears as a Surface row — exhaustive, both directions (AGENTS §22).
2. **JSON-RPC 2.0 envelope.** A `dispatch` response is always `{ jsonrpc: '2.0', id, … }` with EXACTLY ONE of `result` / `error`; the `id` echoes the request's id (or `null` only on a `handle` parse / invalid-request error). `handle` serializes that envelope with `JSON.stringify` and returns the string.
3. **Notifications yield no response.** A request with NO `id` is a notification: `dispatch` emits `request` (with a `null` id) and then resolves `undefined` WHATEVER the method (`ping`, `notifications/initialized`, an unknown method — all silent); `handle` returns `undefined`. The method switch only ever runs for an id-bearing request.
4. **The four methods.** `initialize` → `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version } }`, the version NEGOTIATED (echo the client's `params.protocolVersion` when it is one of `SUPPORTED_PROTOCOL_VERSIONS`, else `MCP_PROTOCOL_VERSION`; a non-string requested version falls back). `ping` → `{}`. `tools/list` → `{ tools }`, each tool a `MCPToolDescriptor` (its `parameters` renamed to `inputSchema`, defaulting to `{ type: 'object' }`). `tools/call` → the executed tool's `MCPToolResult`.
5. **Tool errors are tool results, not protocol errors.** `tools/call` reads `params.name` (a string) + `params.arguments` (a record, default `{}`), narrowed via the contracts guards (no `as`); a missing / non-string `name` → a `-32602` invalid-params error. Otherwise it runs `tools.execute({ id, name, arguments })` — and because the [`ToolManager`](agents.md) ALREADY isolates a thrown tool (and an unknown name) into a result `error`, the server adds NO try/catch: a result `error` maps to `{ content: [{ type: 'text', text: <error> }], isError: true }`, a result `value` to `{ content: [{ type: 'text', text: JSON.stringify(value) }] }`.
6. **Unknown method → `-32601`.** An id-bearing request for any other method resolves a `JSONRPC_METHOD_NOT_FOUND` error whose message names the method.
7. **`handle` maps the boundary failures.** A `JSON.parse` throw (malformed JSON) → a serialized `-32700` (Parse error) response with a `null` id; a parsed value that is not a valid REQUEST (a response, or any non-message) → a serialized `-32600` (Invalid Request) response with a `null` id. The raw-string parse is the ONLY `try`/`catch`; the guards (`parseJSONRPCMessage` over `isJSONRPCMessage`) are total and never throw.
8. **Total wire guards (§14).** `isJSONRPCRequest` / `isJSONRPCResponse` / `isJSONRPCMessage` / `isInitializeRequest` are total functions over an already-parsed `unknown` — adversarial input returns `false`, never throws. A request accepts an absent `id` (a notification) but rejects a `null` id (valid only on a response); a response requires an `id` (string / number / `null`) and exactly one of `result` / `error`. `parseJSONRPCMessage` is sound with `isJSONRPCMessage` (a guard-valid input returned unchanged; every non-`undefined` output satisfies the guard).
9. **The CORE is provider-agnostic, no HTTP.** `src/core/mcp` imports ONLY core siblings (`../agents/*`, `../emitters/*`, `../contracts/*`, and — for the client's per-request deadline — `AbortSignal.timeout`) via relative imports — never `@src/core` (a barrel cycle) — and carries no transport, no HTTP, and no model. Both the dispatch core (the server) AND the client live here, transport-abstract; HTTP lives ONE layer out in `src/server/mcp` (clauses 12–15): the ingress transport pumps message bodies through `dispatch`, the egress transport drives a remote server over `fetch`, and the session / version HEADER names are reserved there, not in the core.
10. **Observable (§13).** The `MCPServer` owns an `emitter` (`MCPServerEventMap`) and fires `request` (method, id-or-`null`) at the TOP of every `dispatch`, BEFORE the method runs; the emitter isolates a listener throw, routing it to its OWN `error` handler (the `error` option, surfaced as `(error, event)`, NOT a domain event) — so a buggy observer can never corrupt a dispatch, and a throwing `error` handler neither escapes nor recurses.
11. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly the public methods of each behavioral interface — `MCPServerInterface`, `MCPClientInterface`, `ClientTransportInterface`, and `MCPSessionInterface` — exhaustive, both directions, and each implementing class (`MCPServer` / `MCPClient`; the THREE transports `HTTPClientTransport` / `WebSocketServerTransport` / `WebSocketClientTransport`, all three implementing the one `ClientTransportInterface`; and `MCPSession`) exposes the same public methods, no more (AGENTS §22). The remaining exports add no behavioral interface with methods (`createMCPRoutes` / `createHTTPClientTransport` / `createMCPSession` / `createWebSocketServer` / `createWebSocketClientTransport` / `acceptsEventStream` / `readSessionHeader` / `readLastEventId` / `rejectUnknownSession` / `readEventStream` / `decodeEvent` / `upgradeRequestPath` are functions; `HTTPTransportOptions` / `HTTPClientTransportOptions` / `MCPSessionOptions` / `WebSocketServerOptions` / `WebSocketClientTransportOptions` / `EventStoreEntry` / the event maps are bags), so they contribute no `## Methods` row.
12. **The HTTP transport route is stateless mechanism (`src/server/mcp`).** `createMCPRoutes(mcp, options?)` returns a SINGLE `POST {path}` route (`path` default `DEFAULT_MCP_PATH`) that mounts an `MCPServerInterface` on the [HTTP spine](http.md). The handler is self-contained (its OWN JSON-parse `try`/`catch`, so it works with or without `createBodyParser`) and draws a sharp line: a TRANSPORT-level failure — malformed JSON (`-32700`) or a parsed value that is not a JSON-RPC REQUEST (`-32600`, narrowed via `parseJSONRPCMessage` + `'method' in request`, no `as`) — is HTTP **400** with a JSON-RPC error BODY (id `null`); a DISPATCH result — a success OR an IN-BAND JSON-RPC error from `mcp.dispatch` (e.g. `-32601` method-not-found) — is HTTP **200** with the envelope (the error is in-band, not an HTTP error); a notification (no `id`, `dispatch` → `undefined`) is **202** with no body. When `streaming` is enabled (default `true`) and the client `Accept`s `text/event-stream` (`acceptsEventStream`), the 200 reply is one SSE `data:` event over the spine's generic `openSSEStream` seam, then the stream ends; else a plain JSON body — the JSON-RPC envelope is identical. `createMCPRoutes` mints / reads NO session id; `GET` / `DELETE` to `{path}` get the spine's automatic **405** unless a `createMCPSession` middleware (clauses 18–19) is mounted IN FRONT to serve them. It is MECHANISM, not policy: auth / CORS / rate-limiting / sessions (`createTokenGuard` / `createCors` / `createRateLimiter` / `createMCPSession`) compose IN FRONT as ordinary middleware — the route adds none.
13. **The CLIENT is the egress mirror (`src/core/mcp`).** `createMCPClient({ transport, name?, version?, timeout?, on? })` drives a REMOTE server over an injected `ClientTransportInterface` (transport-abstract, like the server). `connect()` opens the transport, ISSUES `initialize` (`{ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name, version } }`), marks `connected`, sends the `notifications/initialized` notification, and fires `connect` (idempotent). `tools()` runs `tools/list` and wraps each descriptor as a local [`Tool`](agents.md) — `name` narrowed (`isString`), `inputSchema` mapped back to `parameters` (the inverse of clause 4's rename, no `as`), `execute` bound to `call(name, …)`. `call(name, args)` runs `tools/call`, concatenates the result's `text` content blocks, and — the inverse of clause 5's `buildToolResult` — THROWS an `Error` carrying the text when `isError === true`, else `JSON.parse`s the text (raw-string fallback; empty → `undefined`); so a remote tool failure throws locally and an agent's `ToolManager` isolates it into a result `error` exactly like a local throw. `disconnect()` rejects every pending request, closes the transport, and fires `disconnect` (idempotent).
14. **Client correlation + deadline + notifications.** Each request is tagged with a monotonic numeric `id`; a SINGLE transport `message` subscription resolves / rejects the matching pending request by `id` (an `error` response rejects `MCP error <code>: <message>`, a `result` resolves) — concurrent requests each route to their own pending. A message that is NOT a correlated response is a server NOTIFICATION, re-surfaced on the `notification` event. Every request races `AbortSignal.timeout(timeout)` (the taverna idiom — never a raw `setTimeout`; default `DEFAULT_MCP_REQUEST_TIMEOUT`): a server that never replies REJECTS the pending request (`timed out`) rather than hanging. A `send` write failure rejects its own pending request. Observable (§13): the client owns an `emitter` (`MCPClientEventMap`) firing `connect` / `disconnect` / `notification` / `error`; the emitter isolates a listener throw, routing it to its `error` handler (the `error` option, NOT a domain event); `on(...)` is the convenience forward to `emitter.on`.
15. **The HTTP CLIENT transport drives a remote server over `fetch` (`src/server/mcp`).** `createHTTPClientTransport({ url, headers? })` returns a `ClientTransportInterface` whose `send` POSTs the JSON-serialized message (or batch) to `url` with `content-type: application/json` and an `Accept` of BOTH `application/json` and `text/event-stream` (plus any `headers`, e.g. an `Authorization` bearer), then decodes the reply and emits each carried `JSONRPCMessage` on the `message` event: an `application/json` body is narrowed via `parseJSONRPCMessage`; a `text/event-stream` body is decoded via the core `SSEParser` (`readEventStream`, the inverse of clause 12's `openSSEStream` framing, so the wire round-trips); a `202` (a notification accepted) carries no body and emits nothing. It is TOTAL at the boundary (§14): a non-message reply is dropped, never asserted; a `fetch` / decode failure surfaces on the `error` event rather than escaping `send`. `start` / `close` hold no long-lived connection (the request/response transport `fetch`es per `send`). It ECHOES the session (clause 18): an `mcp-session-id` response header, when a STATEFUL server sends one (on `initialize`), is captured into `session` and then sent as the `mcp-session-id` REQUEST header on every SUBSEQUENT request — so an `MCPClient` passes a stateful server's validation with NO caller wiring; before `initialize` returns an id, `session` is `undefined` and no header is sent (safe against a stateless server). It is the EGRESS mirror of clause 12: mechanism, not policy — the bearer is supplied by the caller via `headers`.
16. **The WebSocket transport is the full-duplex ingress over the spine upgrade seam (`src/server/mcp`).** `createWebSocketServer(mcp, options?)` returns an [`UpgradeHandler`](http.md) to register with `server.upgrade(...)`; it composes the lean [`NodeWebSocket`](websocket.md) RFC 6455 wrapper over the spine's generic upgrade seam (the spine speaks NO WebSocket). It DECLINES (returns `false`, so the spine fans the socket onward or destroys it, and NEVER touches the not-yet-owned socket) when the `Upgrade` header is not `websocket`, the request path (`upgradeRequestPath`) is not `options.path` (default `DEFAULT_MCP_PATH`), the `Sec-WebSocket-Key` is absent, or the `Sec-WebSocket-Version` is not `13`. Otherwise it CLAIMS (returns `true`): `createNodeWebSocket({ socket, key, head, protocol })` (SERVER mode → writes the `101` handshake echoing the `subprotocol`, default `MCP_WEBSOCKET_SUBPROTOCOL` `'mcp'`, and sends UNMASKED frames), wraps it in a `WebSocketServerTransport`, and PUMPS — each inbound `JSONRPCMessage` that `isJSONRPCRequest` runs through `mcp.dispatch`, a defined response written back as a frame (a notification → `dispatch` `undefined` → nothing sent); a non-request message is ignored; a `dispatch` / `send` fault surfaces on the transport's `error` event rather than escaping the async listener. `WebSocketServerTransport` REUSES `ClientTransportInterface` (the generic bidirectional carrier — `session` `undefined`, `start` arms the socket subscriptions, `send` writes ONE text frame per message, `close` closes the socket): inbound text frames are `JSON.parse`d (guarded) + narrowed via `parseJSONRPCMessage` onto `message`, a malformed / non-message frame surfaces on `error` and is DROPPED (§14, never throws), and the socket's `close` bridges to the transport's `close`. It is MECHANISM, not policy: an auth guard composes IN FRONT as a `server.upgrade(...)` handler registered BEFORE this one (it can decline + destroy an unauthenticated upgrade). Observable (§13): the emitter isolates a listener throw (`error` is a DOMAIN event — a transport-level fault; the transport sets no listener-error handler, so an observer's throw is swallowed silently).
17. **The WebSocket CLIENT transport drives a remote server over an upgrade (`src/server/mcp`).** `createWebSocketClientTransport({ url, headers? })` returns a `ClientTransportInterface` — the WebSocket egress mirror of clause 16 and the sibling of clause 15. `start()` (run by `client.connect()`) performs the RFC 6455 client handshake: a `node:http`(`s`) `GET` carrying `Connection: Upgrade` / `Upgrade: websocket` / a random `Sec-WebSocket-Key` / `Sec-WebSocket-Version: 13` / `Sec-WebSocket-Protocol: mcp` (plus any `headers`), awaiting the client `'upgrade'` event and VALIDATING `Sec-WebSocket-Accept === computeWebSocketAccept(key)` (the [websocket](websocket.md) helper) — a mismatch / a non-`101` response / a request error REJECTS `start()` (the socket destroyed). On success it wraps the upgraded socket in `createNodeWebSocket({ socket, head })` (CLIENT mode — no key → frames MASKED, §5.3) and bridges its frames as the client's `message` channel (decoded + narrowed via `parseJSONRPCMessage`, §14). `send` writes ONE masked text frame per message; `close()` closes the socket + fires `close` (idempotent). `url` accepts `ws://` / `wss://` OR `http://` / `https://` (a `ws(s)` scheme is converted to `http(s)` for the underlying request; `wss` → TLS via `node:https`). It is the persistent-connection counterpart to the request/response HTTP client transport — the SAME `MCPClient` correlation, deadline, and tool-mapping ride over it unchanged. Observable (§13): the emitter isolates a listener throw (`error` is a DOMAIN event — a transport-level fault; the transport sets no listener-error handler, so an observer's throw is swallowed silently).
18. **Sessions are an opt-in plug-and-play middleware on the HTTP transport (`src/server/mcp`).** `createMCPSession({ path?, ttl?, capacity? })` returns a `Middleware` that BUILDS ON the generic `createSession` (the reusable HTTP session middleware, [http.md](http.md)) configured for MCP — `createSession` owns the per-id state in a CLOSURE (a `Map<id, { session, last-seen }>`, the `createRateLimiter` / `createTokenGuard` / `createCors` style, §21 — NO Database-backed mirror; sessions are process-local transport mechanics), and `createMCPSession` adds only the MCP header config, mint-on-`initialize`, and the resumable `GET` stream. Compose it via `server.use(createMCPSession())` IN FRONT of a session-agnostic `createMCPRoutes(mcp)`; it OWNS its `path` (default `DEFAULT_MCP_PATH`, MUST match the route's) — a request to any other path passes straight through (`await next()`). With a `ttl` a session idle longer than `ttl` ms is treated as ABSENT and lazily evicted on the next access (no background timer — the rate-limiter's lazy-window idiom); a resolved access TOUCHES the session so an active one never ages out. For its `path` it makes the transport STATEFUL across the three verbs: a `POST` reads the body (`await context.body()`, CACHED so the downstream route re-reads it) — a malformed body or a non-request is NOT pre-empted (it `await next()`s, so the route returns the canonical `-32700` / `-32600`); an `initialize` POST mints a `crypto.randomUUID()`, stores a fresh `MCPSession`, SETS the minted id on the `mcp-session-id` response header BEFORE the dispatch result (a `node:http` `response.setHeader` that `writeHead` then merges), and attaches the session to `context.state` under `MCP_SESSION_STATE`; every NON-`initialize` POST reads the request's `mcp-session-id` (`readSessionHeader`, narrowed via `isString` — a missing / repeated header reads as absent) and, if it is missing / unknown / TTL-evicted, answers a transport-level **404** with a JSON-RPC error body (mirroring clause 12's 400 transport-failure shape — `-32600` "Session not found", id `null`), else attaches the resolved session to `context.state` and continues; a resumable `GET {path}` opens the server→client SSE channel (clause 19); a `DELETE {path}` reads the id, 404s an unknown / missing one, else drops it from the store and answers **204** empty. An in-request handler reads the resolved session via `context.state.get(MCP_SESSION_STATE)` to `push` (clause 19). The client side echoes the session automatically (clause 15), so an `MCPClient` over `createHTTPClientTransport` clears the validation gate end to end. OMIT the middleware for the stateless default — `createMCPRoutes` mints / reads nothing and the spine auto-405s `GET` / `DELETE` (the minimal-interface contract, §21). The WebSocket transport is inherently ONE session per connection (the socket IS the session), so it carries no session header and the middleware does not apply to it.
19. **Resumable server→client push is the GET-SSE channel, folded into `MCPSession` (`src/server/mcp`).** Each `MCPSession` FOLDS IN its own bounded replay log — a plain in-memory `Map` + capacity + lazy-TTL eviction, PRIVATE to the entity (§21 — NO database mirror, NO separate `EventStore`), built with `createMCPSession`'s `capacity` (default `DEFAULT_MCP_SESSION_CAPACITY`) and a per-event `DEFAULT_MCP_SESSION_TTL`. `session.push(message)` APPENDS the message to the log under a MONOTONE base36 event id (RETURNED), evicting the OLDEST past `capacity` + any entry older than the per-event TTL (a lazy sweep on each access), AND fans the message out to every `attach`ed open stream as `stream.write({ id, data: JSON.stringify(message) })` — a push with no attached stream is still logged, so a later-connecting / reconnecting client replays it. `session.replay(afterId)` returns every retained log entry STRICTLY AFTER `afterId` in append order (the unit is an `EventStoreEntry`) — an UNKNOWN / evicted cursor replays NOTHING (the spec-sane resume: never re-deliver un-lost events). The `createMCPSession` middleware serves the resumable `GET {path}`: it validates the `mcp-session-id` (`readSessionHeader` → the closure store, which TOUCHES so an open stream keeps the session alive; a missing / unknown id → the same **404** as clause 18), opens `openSSEStream(context)`, reads `Last-Event-ID` (`readLastEventId`, narrowed via `isString` — absent / repeated reads as no-resume) and REPLAYS `session.replay(lastEventId)` onto the stream FIRST (each as an `id:`-tagged event), THEN `session.attach(stream)` (so future `push`es reach it), THEN `bindStreamingAbort(context, () => session.detach(stream))` (a client disconnect detaches it). The stream is long-lived — it is NEVER `end()`ed by the middleware; it lives until the client drops. The SSE seam needs NO change — `openSSEStream`'s `write({ id, data })` ALREADY serializes the `id:` line the core `SSEParser` round-trips, so resumability is pure mechanics over the existing seam. The WebSocket transport (one session per connection, full-duplex) needs no replay log — this is the HTTP transport's push channel.

## Patterns

### Expose a tool registry over MCP

The headline use: turn a live [`ToolManager`](agents.md) into a server an MCP client drives over a transport.

```ts
import { createMCPServer, createTool, createToolManager } from '@src/core'

const tools = createToolManager()
tools.add(
	createTool({
		name: 'search',
		description: 'Search the docs',
		execute: (a) => find(String(a.query)),
	}),
)

const server = createMCPServer({ name: 'docs', version: '1.0.0', tools })

// A transport reads a framed message string and writes the reply (NO HTTP here — a later chunk):
for await (const message of transport) {
	const reply = await server.handle(message)
	if (reply !== undefined) await transport.send(reply) // a notification has no reply
}
```

### Drive the typed core directly

When the request is already parsed (a test, an in-process bridge), call `dispatch` and skip the string boundary.

```ts
const response = await server.dispatch({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
response?.result // { tools: [ … ] }

const notification = await server.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })
notification // undefined — a notification yields no response
```

### Exposing an agent's tools over MCP

An [`Agent`](agents.md)'s `ToolManager` is `agent.context.tools` — pass it straight to `createMCPServer` and an external MCP client drives the agent's tools over the [HTTP spine](http.md). Because a tool's `execute` is arbitrary, a tool may be **model-backed**: a `tools/call` then drives the live model and its reply round-trips through the MCP wire.

```ts
import { createAgent, createMCPServer, createTool, isString } from '@src/core'
import { createErrorBoundary, createMCPRoutes, createServer } from '@src/server'
import { createOllama } from '@src/ollama'

const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
const agent = createAgent(provider)
// A MODEL-BACKED tool: its execute drives the live model (narrow `args` — §14, no `as`).
agent.context.tools.add(
	createTool({
		name: 'ask',
		description: 'Ask the underlying model a question',
		parameters: {
			type: 'object',
			properties: { prompt: { type: 'string' } },
			required: ['prompt'],
		},
		execute: async (args) =>
			(
				await provider.generate(
					[{ id: 'ask', role: 'user', content: isString(args.prompt) ? args.prompt : '' }],
					AbortSignal.timeout(30_000),
				)
			).content,
	}),
)

// Expose the agent's live ToolManager over MCP, mounted on the HTTP spine.
const mcp = createMCPServer({ name: 'agent-tools', version: '1.0.0', tools: agent.context.tools })
const server = createServer()
server.use(createErrorBoundary())
server.route(createMCPRoutes(mcp)) // POST /mcp
await server.start()

// An external MCP client now `initialize`s, lists the tools (`add` / `ask`, each with an
// `inputSchema`), and `tools/call`s `ask` — driving the live model and getting its reply back.
```

### Use a remote MCP server's tools in an agent

The egress mirror: point an `MCPClient` at a REMOTE MCP server, `connect`, discover its tools as local `Tool`s, and add them to an agent's `ToolManager` — the agent now calls the remote tools as if they were its own. A remote tool failure throws locally, so the agent's `ToolManager` isolates it into a result `error` exactly like a local throw.

```ts
import { createAgent, createMCPClient } from '@src/core'
import { createHTTPClientTransport } from '@src/server'
import { createOllama } from '@src/ollama'

const client = createMCPClient({
	transport: createHTTPClientTransport({ url: 'http://localhost:3000/mcp' }),
})
await client.connect() // the initialize handshake
client.on('notification', (message) => log(message)) // §13 — server-initiated notifications

const agent = createAgent(createOllama({ model: 'qwen3.5:2b-q4_K_M' }))
agent.context.tools.add(await client.tools()) // the remote tools are now the agent's

// Or call a remote tool directly — the value is parsed back from its content blocks:
const value = await client.call('search', { query: 'mcp' })
```

The `transport` is injected — `createHTTPClientTransport` (over `fetch`) reaches a remote Streamable-HTTP server; the same `MCPClient` drives any `ClientTransportInterface` (an in-process loopback, the WebSocket transport below). Add `headers` (e.g. an `Authorization` bearer) to reach a guarded server — the client is mechanism, policy composes at the transport.

### Expose an MCP server over WebSocket

The full-duplex alternative to the HTTP transport: register `createWebSocketServer(mcp)` on the [HTTP spine](http.md)'s `server.upgrade(...)` seam, and an MCP client reaches the same `ToolManager` over a single persistent WebSocket instead of a `POST` per call. It composes the lean [`NodeWebSocket`](websocket.md) RFC 6455 wrapper — the spine itself stays WebSocket-agnostic.

```ts
import { createMCPServer, createToolManager } from '@src/core'
import { createServer, createWebSocketServer } from '@src/server'

const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })

const server = createServer()
server.upgrade(createWebSocketServer(mcp)) // claims an MCP WebSocket upgrade to /mcp
await server.start()

// Compose an auth guard IN FRONT by registering an upgrade handler BEFORE this one — it can
// decline (return false) + destroy an unauthenticated upgrade so it never reaches the pump.
```

### Connect an MCP client over WebSocket

The egress mirror: inject `createWebSocketClientTransport` instead of `createHTTPClientTransport` — the SAME `MCPClient` drives the remote server, now over a persistent WebSocket whose handshake accept it validates on `connect()`.

```ts
import { createAgent, createMCPClient } from '@src/core'
import { createWebSocketClientTransport } from '@src/server'
import { createOllama } from '@src/ollama'

const client = createMCPClient({
	transport: createWebSocketClientTransport({ url: 'ws://localhost:3000/mcp' }),
})
await client.connect() // the RFC 6455 handshake, then the MCP initialize over frames

const agent = createAgent(createOllama({ model: 'qwen3.5:2b-q4_K_M' }))
agent.context.tools.add(await client.tools()) // the remote tools, fetched over WS frames
const value = await client.call('search', { query: 'mcp' }) // a tools/call over frames
```

The `url` accepts a `ws://` / `wss://` URL or an `http://` / `https://` one (a `ws(s)` scheme is converted internally). Everything above the transport — the `initialize` handshake, the id correlation, the per-request deadline, the tool mapping — is unchanged from the HTTP path; only the wire differs.

### Run a stateful MCP server

Mount `createMCPSession()` IN FRONT of a session-agnostic `createMCPRoutes` (the `server.use` onion — just like `createRateLimiter` / `createCors`) and the HTTP transport becomes STATEFUL: `initialize` mints a session id (returned in the `mcp-session-id` header), every later request must echo it, and `DELETE /mcp` ends it. The `MCPClient` over `createHTTPClientTransport` echoes the captured session for you — no caller wiring. Under the hood `createMCPSession` BUILDS ON the spine's generic [`createSession`](http.md): the mint / validate / `DELETE`-end / idle-TTL machinery is the reusable HTTP primitive (configured here for the `mcp-session-id` header, an `MCPSession` per id, mint-only-on-`initialize`, and require-or-404), and `createMCPSession` adds only the resumable `GET` SSE stream below.

```ts
import { createMCPClient, createMCPServer, createToolManager } from '@src/core'
import {
	createHTTPClientTransport,
	createMCPRoutes,
	createMCPSession,
	createServer,
} from '@src/server'

const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })

const server = createServer()
// Opt in to sessions — a 60s idle TTL lazily evicts an abandoned session. The middleware mints +
// validates + serves the resumable GET / DELETE; the route stays session-agnostic.
server.use(createMCPSession({ ttl: 60_000 }))
server.route(createMCPRoutes(mcp))
await server.start()

// The SAME MCPClient works against the stateful server — its HTTP transport captures the
// `mcp-session-id` from initialize and echoes it on every subsequent request.
const client = createMCPClient({
	transport: createHTTPClientTransport({ url: `http://127.0.0.1:${server.port}/mcp` }),
})
await client.connect() // mints + captures the session
await client.tools() // echoes it → passes validation
```

Omit `createMCPSession` entirely for the stateless default — `createMCPRoutes` mints / reads nothing and `GET` / `DELETE` get the spine's automatic `405`. The WebSocket transport is already one session per connection, so it needs no session header.

### Push a server-initiated message via `context.state`

With `createMCPSession` mounted, the stateful HTTP transport adds a resumable `GET {path}` SSE channel: the server PUSHes session-scoped messages and a reconnecting client replays what it missed via `Last-Event-ID`. Open the stream with `Accept: text/event-stream` + the `mcp-session-id`. To push from inside a request handler, read the resolved session off `context.state.get(MCP_SESSION_STATE)` and call `session.push(message)` — the in-request push pattern (the middleware set the session there for every validated request).

```ts
import { createMCPServer, createToolManager } from '@src/core'
import {
	createMCPRoutes,
	createMCPSession,
	createServer,
	MCPSession,
	MCP_SESSION_STATE,
} from '@src/server'

const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })

const server = createServer()
server.use(createMCPSession({ capacity: 256 })) // bound the folded replay log
// An app middleware AFTER the session layer pushes to the current session's GET stream. The
// session is on `context.state` for every validated request; `instanceof` narrows it (no `as`).
server.use((context, next) => {
	const session = context.state.get(MCP_SESSION_STATE)
	if (session instanceof MCPSession) {
		session.push({ jsonrpc: '2.0', method: 'notifications/message', params: { text: 'hi' } })
	}
	return next()
})
server.route(createMCPRoutes(mcp))
await server.start()

// `initialize` (a POST) mints the session id; the client then opens the resumable stream:
//   GET /mcp   Accept: text/event-stream   mcp-session-id: <id>
// A subsequent POST carrying the id resolves the session → the middleware above pushes to its
// open stream (the message is logged AND fanned out). On a dropped connection the client
// reconnects with the last id it saw and the server replays the events strictly after it:
//   GET /mcp   Accept: text/event-stream   mcp-session-id: <id>   Last-Event-ID: <last id>
```

Each `MCPSession` folds in its own bounded replay log (a plain `Map` + capacity + lazy TTL); a `Last-Event-ID` the log no longer retains replays nothing (the spec-sane resume that never re-delivers un-lost events). The WebSocket transport is full-duplex over one connection, so it needs no replay log — this is the HTTP transport's push channel.

### Practices

- **Pump strings through `handle`** — let the transport hand `handle` each raw message and write back the returned string; a `undefined` return is a notification with no reply.
- **Tool failures are results, not errors** — a thrown tool surfaces as an `isError: true` tool-call result (the `ToolManager` isolates it), so don't wrap `execute` — the model reacts to the failure as a tool result.
- **Negotiate, don't assume** — `initialize` echoes a supported requested `protocolVersion` and otherwise falls back to `MCP_PROTOCOL_VERSION`; advertise only the `tools` capability for now.
- **Observe via the emitter** — subscribe to `request` for tracing; never reach into dispatch internals.
- **Expose over HTTP with `createMCPRoutes`** — mount the server on the [HTTP spine](http.md) (`server.route(createMCPRoutes(mcp))`); it dispatches each `POST` (JSON or SSE per the client's `Accept`) without you touching `handle`. Transport-level failures are HTTP `400` + a JSON-RPC body, dispatch results (incl. in-band errors) are `200`, a notification is `202`.
- **Compose policy in front** — the HTTP transport is mechanism: add `createTokenGuard` / `createCors` / `createRateLimiter` as middleware BEFORE the route; the transport bakes in no auth.
- **Opt in to sessions when you need them** — mount `createMCPSession()` via `server.use(...)` IN FRONT of a session-agnostic `createMCPRoutes` to make the HTTP transport stateful (mint-on-`initialize` → `mcp-session-id` header, validate-or-`404`, resumable `GET` SSE, `DELETE` → `204`); it BUILDS ON the spine's generic [`createSession`](http.md) (the mint / validate / `DELETE`-end / idle-TTL machinery is the reusable HTTP primitive, configured for the MCP wire + the resumable `GET` stream), composes like `createRateLimiter`, and the `MCPClient` echoes the session for you. Omit it for the byte-identical stateless default — sessions are mechanics, not a requirement.
- **Push to a client over the resumable GET-SSE channel** — read the current session off `context.state.get(MCP_SESSION_STATE)` inside a request handler (`instanceof MCPSession` narrows it, no `as`) and call `session.push(message)`: it logs the message in the session's folded replay log AND fans it out to the open `GET {path}` stream; a reconnecting client replays what it missed via `Last-Event-ID`. Bound the log with `createMCPSession({ capacity })`. A `Last-Event-ID` older than the retained window replays nothing — never re-delivering un-lost events.
- **Drive a remote server with `createMCPClient`** — inject a `ClientTransportInterface` (`createHTTPClientTransport` over `fetch`, or `createWebSocketClientTransport` over a WebSocket), `connect()`, then `tools()` to fold the remote tools into an agent's `ToolManager`, or `call(name, args)` directly. A remote tool failure throws locally so the manager isolates it.
- **Reach a guarded remote server via `headers`** — the client carries an `Authorization` bearer (or any header) through `createHTTPClientTransport({ url, headers })` (or `createWebSocketClientTransport({ url, headers })`); the client itself adds no auth.
- **Expose over WebSocket with `createWebSocketServer`** — register it on the spine's `server.upgrade(...)` seam for a full-duplex alternative to `createMCPRoutes` over one persistent connection; it composes the [`NodeWebSocket`](websocket.md) wrapper, the spine stays WebSocket-agnostic. Like the HTTP transport it is mechanism — compose an auth guard as an `upgrade` handler registered BEFORE it (declines + destroys an unauthenticated upgrade).
- **Connect over WebSocket with `createWebSocketClientTransport`** — the WebSocket egress mirror; the SAME `MCPClient` drives the remote server over frames. `connect()` validates the handshake accept; `url` accepts `ws(s)://` or `http(s)://`.

## Tests

- [`tests/guides/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔ MCP-layer bijection over BOTH dirs (`readTree('src/core/mcp')` + `readTree('src/server/mcp')` — value + type exports) and the `## Methods` ↔ source bijection for the behavioral interfaces (`MCPServerInterface` ↔ `MCPServer`, `MCPClientInterface` ↔ `MCPClient`, and `ClientTransportInterface` ↔ each of `HTTPClientTransport` / `WebSocketServerTransport` / `WebSocketClientTransport`).
- [`tests/src/core/mcp/MCPServer.test.ts`](../../tests/src/core/mcp/MCPServer.test.ts) — `dispatch` + `handle` over a REAL `ToolManager` (real `Tool`s, no mocks): `initialize` (default version, a negotiated supported version, fallback for an unsupported / non-string version, capabilities + serverInfo), `ping` → `{}`, `tools/list` (the registry's tools with `parameters` mapped to `inputSchema`, an empty registry → `[]`), `tools/call` (a value round-trips through a text block, a structured value as JSON, default `{}` arguments, an erroring tool → `isError: true` with the error text, an unknown tool name → the manager's not-found `isError` result, a missing / non-string `name` → `-32602`), notifications (a no-id request → no response, `notifications/initialized` → no response, an unknown-method notification → no response), an unknown id-bearing method → `-32601`, `handle` (round-trips a request / a `tools/call`, malformed JSON → a `-32700` string, a non-request payload → a `-32600` string, a non-message → `-32600`, a notification string → `undefined`), and the §13 `request` event (fired with method + id at the top of `dispatch` and through `handle`, a `null` id for a notification) plus observer-throw safety (a throwing `request` listener can't corrupt the dispatch and routes to the emitter's `error` handler; a throwing `error` handler neither escapes nor recurses).
- [`tests/src/core/mcp/validators.test.ts`](../../tests/src/core/mcp/validators.test.ts) — `isJSONRPCRequest` (numeric / string id, a notification, a params record; rejects a wrong version / missing or non-string method / a `null` id / a non-record params; total on adversarial input), `isJSONRPCResponse` (a result / null-result / error response; rejects both / neither / a bad error object / a request; total), `isJSONRPCMessage` (the union), and `isInitializeRequest`.
- [`tests/src/core/mcp/parsers.test.ts`](../../tests/src/core/mcp/parsers.test.ts) — `parseJSONRPCMessage` returns a request / response unchanged, `undefined` for a non-message and adversarial input, and is sound with `isJSONRPCMessage`.
- [`tests/src/core/mcp/helpers.test.ts`](../../tests/src/core/mcp/helpers.test.ts) — `jsonRPCResult` / `jsonRPCError` (with + without `data`) envelopes, `buildToolDescriptors` (the `parameters` → `inputSchema` rename, the empty-schema default, an empty registry), `buildToolResult` (a value / structured value / error → `isError`), and `initializeResult` (default / negotiated / fallback version).
- [`tests/src/core/mcp/factories.test.ts`](../../tests/src/core/mcp/factories.test.ts) — `createMCPServer` wires the identity, dispatches over the supplied registry, and binds the `on` hooks to the emitter.
- [`tests/src/core/mcp/MCPClient.test.ts`](../../tests/src/core/mcp/MCPClient.test.ts) — `MCPClient` over an in-process LOOPBACK transport against a REAL `MCPServer` + `ToolManager` (no mocks): `connect` (the `initialize` handshake + `notifications/initialized`, the `connect` event, idempotence), `tools()` (the remote tools as local `Tool`s with `inputSchema` → `parameters`; the wrapped `execute` calls back; a remote-erroring wrapped tool added to a `ToolManager` is isolated into a result error), `call` (a structured + a string value round-trip, a remote `isError` → a local throw, an unknown remote tool → a not-found throw), id correlation across concurrent calls + a server-initiated notification surfaced on `notification`, a per-request timeout (a gated transport → `call` rejects `timed out`), disconnect (pending rejected + transport closed + the `disconnect` event, idempotence), and §13 observer-throw safety.
- [`tests/src/server/mcp/transports/HTTPClientTransport.test.ts`](../../tests/src/server/mcp/transports/HTTPClientTransport.test.ts) — `HTTPClientTransport` END-TO-END against the shipped `createMCPRoutes` over a REAL `node:http` server + a REAL `MCPServer` (no live model): an `MCPClient` over `createHTTPClientTransport` connects + discovers + calls the remote tools over BOTH reply framings — the plain JSON body (`streaming: false`) and the Streamable-HTTP SSE `data:` event (`streaming: true`, decoded via the core `SSEParser` inside the transport); a remote tool failure → a local throw on each path; a bearer carried through `headers` reaches a `createTokenGuard`ed server (and a missing bearer → `connect` rejects on its deadline); `session` undefined for the stateless v1 + a clean `disconnect`.
- [`tests/src/server/mcp/factories.test.ts`](../../tests/src/server/mcp/factories.test.ts) — `createMCPRoutes` (STATELESS) over a REAL `node:http` server + a REAL `MCPServer` over a real `ToolManager` (stub tools, NO live model), driven with `fetch`. STATELESS `createMCPRoutes`: `POST initialize` → 200 + the negotiated handshake, `tools/list` → the tools with `inputSchema`, `tools/call` → the stub's content round-trips (and an erroring tool → `isError: true` in the body at 200), a notification (no `id`) → 202 + empty, malformed JSON → 400 + `-32700`, a non-request → 400 + `-32600`, an unknown method → 200 + an in-band `-32601`, `Accept: text/event-stream` → the reply as an SSE `data:` event (decoded with the core `SSEParser` via `collectSSE`; `streaming: false` falls back to JSON), `GET {path}` → the spine's automatic 405, a custom `path`, behind a `createTokenGuard` an unauthenticated `POST` → 401 (proving policy composes in front), and the **stateless default** (no `mcp-session-id` header, a non-initialize POST accepted with no id, `DELETE` → the spine's automatic 405 — `createMCPRoutes` alone mints / reads nothing). PLUS the WebSocket transport both halves against each other — a real `Server` with `server.upgrade(createWebSocketServer(mcp))` driven by an `MCPClient` over `createWebSocketClientTransport` through the REAL spine upgrade: `connect()` → `tools()` → `call('add')` round-trips a value over real frames, a remote erroring tool → a local throw, and the upgrade-decline path (a non-WS request to `/mcp` → 404; a WS upgrade to the wrong path, or one missing `Sec-WebSocket-Version: 13`, → declined/destroyed).
- [`tests/src/server/mcp/middlewares.test.ts`](../../tests/src/server/mcp/middlewares.test.ts) — **`createMCPSession`** (the plug-and-play session `Middleware`, which BUILDS ON the spine's generic `createSession`) over a REAL `node:http` server + a REAL `MCPServer` over a real `ToolManager` (stub tools, NO live model), mounted IN FRONT of a session-agnostic `createMCPRoutes(mcp)`: `initialize` mints a UUID id returned in the `mcp-session-id` header, a `tools/list` echoing it succeeds, a missing / unknown id → 404 + a JSON-RPC error body, `initialize` itself needs no id, a malformed body on a VALID session still gets the route `-32700` (the resolved-session branch wins before the mint predicate reads the body, so transport parse failures stay the route's job), `DELETE {path}` with the id → 204 then the session is gone (a later echo → 404), `DELETE` unknown/missing → 404, and a request to ANOTHER path passes straight through; the **resumable GET-SSE push channel** driven the REAL way — an in-request app middleware reads `context.state.get(MCP_SESSION_STATE)` and `.push`es: the pushed message ARRIVES on the open `GET {path}` stream decoded via the core `SSEParser` (`readSSEStream`, a BOUNDED reader that takes N events then aborts the `fetch` so it never hangs) carrying a monotone `id`, a reconnect echoing `Last-Event-ID` REPLAYS the missed events in order (keeping their original ids), a `GET` with a missing / unknown session → 404; lazy SESSION TTL eviction over the wire (an idle session past a tiny `ttl` → a later echo 404; an actively-used session stays alive past the original window via touch-on-access); and an `MCPClient` + `createHTTPClientTransport` round-trip against the stateful server (`connect` → `tools` → `call` all pass validation, proving the client echoes the captured session).
- [`tests/src/server/mcp/MCPSession.test.ts`](../../tests/src/server/mcp/MCPSession.test.ts) — `MCPSession` as a pure entity (no server, no live model), the folded replay log driven directly: it exposes its constructed `id`; `push` returns monotone (base36) ids AND fans the message out to every `attach`ed recording stream as an `id:`-tagged SSE event (the same id reaching multiple streams, the returned id matching the event), a `detach`ed stream stops receiving pushes while the message is STILL logged, and a push with NO attached stream is still logged; `replay(afterId)` returns the entries STRICTLY AFTER it in order (nothing when none follows, nothing for an UNKNOWN / evicted cursor — the spec-sane resume); capacity eviction drops the OLDEST past the bound (an evicted-cursor replay yields nothing even with newer entries retained); lazy TTL eviction driven by an explicit `now` (a stale entry swept on the next `push` / `replay`, a within-window entry retained, `ttl: 0` never ages out); and each replayed `EventStoreEntry` carries its `id` / `message` / `timestamp`.
- [`tests/src/server/mcp/transports/WebSocketClientTransport.test.ts`](../../tests/src/server/mcp/transports/WebSocketClientTransport.test.ts) — `WebSocketClientTransport` END TO END against the shipped `createWebSocketServer` over a REAL `node:http` server + a REAL `MCPServer` over a real `ToolManager` (stub tools, NO live model): an `MCPClient` over `createWebSocketClientTransport` `connect()`s (the RFC 6455 handshake) → `tools()` → `call('add')` round-trips a value over real WS frames (a `ws://` AND an `http://` url both reach the endpoint), a remote erroring tool → a local throw, a custom upgrade path, and `session` undefined for the stateless v1 + a clean `disconnect()`. The decline / reject paths are PINNED both ends: the server declining the upgrade (a wrong path → the socket destroyed) → `connect()` rejects, and a server that returns a 101 with a BOGUS `Sec-WebSocket-Accept` → `start()` rejects on the accept mismatch (the handshake-accept security check, otherwise vacuously covered).
- [`tests/src/server/mcp/transports/WebSocketServerTransport.test.ts`](../../tests/src/server/mcp/transports/WebSocketServerTransport.test.ts) — `WebSocketServerTransport` driven END TO END over the shared in-memory `node:stream` Duplex PAIR (`duplexPair` / `flushSocket` / `readClientFrames`, the same harness the `NodeWebSocket` test uses; a REAL bidirectional socket, no mock): a client JSON-RPC text frame → the transport emits the parsed `JSONRPCMessage`; a malformed (non-JSON) and a well-formed-but-non-JSON-RPC frame each surface on `error` and are DROPPED (no throw); `send` round-trips a response (and a batch, one frame each) the client decodes; `close()` (idempotent) and a peer close frame each fire the transport's `close`; `session` undefined; §13 observer-throw isolation.
- [`tests/src/server/mcp/helpers.test.ts`](../../tests/src/server/mcp/helpers.test.ts) — `acceptsEventStream` (true for `text/event-stream`, true among several accepted types, case-insensitive; false for plain JSON / a `*/*` wildcard / an absent header), `readSessionHeader` (the single-valued `mcp-session-id`, `undefined` for an absent or repeated-array header — narrowed, never asserted), and `upgradeRequestPath` (the path without query, an absent target → `'/'`).

## See also

- [`agents.md`](agents.md) — the `ToolManager` this server exposes (per-call error-isolated `execute`, the `ToolDefinition` schema).
- [`contracts.md`](contracts.md) — the `isRecord` / `isString` guards the wire input is narrowed through (§14, no `as`).
- [`http.md`](http.md) — the HTTP server spine the `src/server/mcp` transport mounts on; its generic `openSSEStream` SSE seam frames the Streamable-HTTP SSE response, and its `createTokenGuard` / `createCors` / `createRateLimiter` middleware compose in front.
- [`AGENTS.md`](../../AGENTS.md) — the rules; §13 emitter, §14 narrow-don't-assert, §22 documentation-as-contracts.
- [`README.md`](README.md) — the guides index.
