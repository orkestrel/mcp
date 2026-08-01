# MCP

> The [Model Context Protocol](https://modelcontextprotocol.io) layer — a typed
> JSON-RPC 2.0 client/server pair with pluggable HTTP, WebSocket, and stdio
> transports. **Ingress:** `createMCPServer` wraps a live `ToolManagerInterface`
> (`@orkestrel/tool`) as an MCP server any MCP client can drive. **Egress:**
> `createMCPClient` drives a _remote_ MCP server and surfaces its tools as local
> `ToolInterface`s an agent can call as if they were its own. The server dispatches
> each request by structural wire era: modern requests are answered from a
> registrable method seam carrying the built-in `server/discover`, `tools/list`,
> `tools/call`, and `subscriptions/listen`; legacy requests retain a fixed `initialize`, `ping`,
> `tools/list`, and `tools/call` switch.
>
> The split that keeps it lean: **the dispatch core is transport-agnostic and
> provider-agnostic.** `MCPServer` and `MCPClient` live in `src/core` and import
> only siblings (JSON-RPC types + `@orkestrel/tool`'s tool registry +
> `@orkestrel/emitter`'s observable surface + `@orkestrel/contract`'s guards) —
> **no HTTP, no WebSocket, no stdio, no `as`** (all wire input is narrowed via
> total guards). The server is pure logic with two entry points: `dispatch(request)`
> runs an already-parsed `JSONRPCRequest` → a `JSONRPCResponse` (or `undefined`
> for a notification); `handle(message)` is the string boundary — `JSON.parse` →
> narrow → dispatch → `JSON.stringify` (a parse failure → `-32700`, a non-request
> → `-32600`, a notification → `undefined`). The client mirrors it: `connect`
> (modern `server/discover` first, with a validated legacy `initialize` fallback),
> `tools()` (discover the remote tools as local
> `ToolInterface`s), `call` (run one — a remote failure throws locally, so an
> agent's `ToolManager` isolates it exactly like a local throw). A remote
> JSON-RPC error rejects with `MCPError`, preserving its numeric `code` and
> optional `error.data` as `context`.
>
> The wire lives ONE layer out, in `src/server` — three interchangeable server
> transports, each a matched ingress/egress pair, all speaking the SAME
> `MCPServerInterface` / `ClientTransportInterface` (only the framing differs):
>
> - **Streamable HTTP** — `createMCPRoutes` mounts a server as `POST {path}`
>   (JSON or SSE per the client's `Accept`, via `@orkestrel/server`'s
>   `openStream`); the opt-in `createMCPSession` middleware adds native
>   stateful sessions + a resumable server→client SSE channel.
>   `createHTTPClientTransport` is the injectable-`fetch` egress.
> - **WebSocket** — `createWebSocketServer` claims an upgrade on `@orkestrel/server`'s
>   upgrade seam, composing `@orkestrel/websocket`'s RFC 6455 wrapper for a
>   full-duplex alternative over one persistent connection.
>   `createWebSocketClientTransport` is the `node:http(s)`-upgrade egress.
> - **stdio** — `createStdioServer` pumps newline-delimited JSON-RPC over a
>   process's `stdin`/`stdout` (or injected streams); `createStdioClientTransport`
>   spawns a child process and drives the same protocol over its piped stdio.
>
> Every transport is **mechanism, not policy** — auth and rate-limiting compose
> IN FRONT as ordinary `@orkestrel/server` middleware. HTTP ingress supplies only
> the protocol-required origin mechanism: requests without `Origin` pass, while every present
> origin must occur in the shared `origin.origins` list by default. A deployment validating
> upstream explicitly delegates with `origin.enabled: false`. Observable: the `MCPServer` owns an `emitter` firing `request`
> per dispatch; the `MCPClient` owns one firing `connect` / `disconnect` /
> `notification` / `error`; every transport owns one firing `message` / `close`
> / `error`. Source: [`src/core`](../../src/core) (the dispatch core + the
> client, via `@src/core`) + [`src/server`](../../src/server) (the transports +
> session middleware, via `@src/server`).

## Surface

Create a server over a live tool registry, then pump message strings through
`handle` (or call `dispatch` directly with a parsed request):

```ts
import { createMCPServer } from '@orkestrel/mcp'
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))

const server = createMCPServer({ identity: { name: 'calculator', version: '1.0.0' }, tools })
server.emitter.on('request', (method, id, era) => log(method, id, era))

// A transport pumps message strings through `handle`:
const reply = await server.handle('{"jsonrpc":"2.0","method":"tools/list","id":1}')
// reply → '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"add","inputSchema":{"type":"object"}}]}}'

const out = await server.handle(
	'{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"add","arguments":{"x":2,"y":5}}}',
)
// out → '…"result":{"content":[{"type":"text","text":"7"}]}}'
```

`dispatch` is the typed core; `handle` wraps it with the `JSON.parse` ↔
`JSON.stringify` string boundary and the parse / invalid-request error
mapping. A request with NO `id` is a **notification** — handled (the
`request` event still fires) but it yields NO response (`dispatch` resolves
`undefined`, `handle` returns `undefined`), whatever its method. Tool errors
are NOT protocol errors: the `ToolManager` (`@orkestrel/tool`) isolates a
thrown tool into a `success: false` result, which `tools/call` maps to an
`isError: true` tool result carrying its `error` text — so the server wraps
`execute` in NO try/catch.

### Bind an `MCPServer` / `MCPClient` to any duplex transport

`bindServer` / `bindClient` pipe an `MCPServerInterface` / `MCPClientInterface`
over an `MCPTransportInterface` — the environment-agnostic duplex message
channel (`send` / `listen` / `closed` / `close`, ALL string messages; framing
is entirely the transport's concern). Every environment face (Node stdio /
WebSocket, a future browser `MessagePort`) implements this ONE port instead of
duplicating the dispatch/correlation pump per transport:

```ts
import {
	bindClient,
	bindServer,
	createDuplexClientTransport,
	createMCPClient,
	createMCPServer,
} from '@orkestrel/mcp'
import { createTool, createToolManager } from '@orkestrel/tool'

// An in-memory duplex channel — a real MCPTransportInterface, the same shape a
// Node stdio pair or a browser MessagePort would implement.
function createLoopback() {
	let onMessage: ((message: string) => void) | undefined
	let peer: ReturnType<typeof createLoopback> | undefined
	const transport = {
		async send(message: string) {
			peer?.deliver(message)
		},
		listen(handler: (message: string) => void) {
			onMessage = handler
		},
		closed() {},
		async close() {},
		deliver(message: string) {
			onMessage?.(message)
		},
		connect(other: ReturnType<typeof createLoopback>) {
			peer = other
		},
	}
	return transport
}
const serverSide = createLoopback()
const clientSide = createLoopback()
serverSide.connect(clientSide)
clientSide.connect(serverSide)

const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
const server = createMCPServer({ name: 'calculator', version: '1.0.0', tools })
bindServer(server, serverSide)

const client = createMCPClient({ transport: createDuplexClientTransport(clientSide) })
const unbind = bindClient(client, clientSide)
await client.connect()
const value = await client.call('add', { x: 2, y: 5 })
// value → 7
unbind() // detaches without closing either side of the loopback
```

`bindServer`'s unbind stops routing inbound messages through `server.handle`
(a `transport.closed()` signal does the same); `bindClient`'s unbind stops
delivering onto `client.transport.emitter`. Neither closes the underlying
transport — that stays the caller's call. A `send` throw or rejection from
either binder is caught and surfaced (never an unhandled rejection): a
server-side one on `server.emitter`'s `error` event, a client-side one on
`client.transport.emitter`'s `error` event.

### Register a modern method on the seam

The modern branch answers from ONE registry, `server.methods`. The four
built-in methods are registered on it at construction, so a method added
later is not a special case — it is the fifth registration, dispatched by
the same lookup, and a name with no handler still answers `-32601`:

```ts
import { buildJSONRPCResult, createMCPServer } from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const server = createMCPServer({
	identity: { name: 'calculator', version: '1.0.0' },
	tools: createToolManager(),
})

server.methods.method('tools/list') // the built-in handler — already on the seam
server.methods.method('demo/probe') // undefined → the modern branch answers -32601

server.methods.add('demo/probe', async (request) =>
	buildJSONRPCResult(request.id ?? null, { probed: true }),
)
// the SAME method now answers; `add` under an existing name replaces it, which is
// how a consumer overrides a built-in — no precedence rule to remember.
```

A handler receives the request plus an `MCPDispatchOptions` bag whose
`signal` aborts when the caller's request ends (a closed HTTP response
stream, a stdio cancel). Both `dispatch` and `handle` take that bag as an
OPTIONAL second argument, so a caller that cannot abort simply never
supplies one and a handler always receives an object:

```ts
server.methods.add('demo/slow', async (request, options) => {
	options.signal?.addEventListener('abort', () => release())
	return buildJSONRPCResult(request.id ?? null, {})
})

const controller = new AbortController()
await server.dispatch({ jsonrpc: '2.0', method: 'demo/slow', id: 1 }, { signal: controller.signal })
```

A handler that must HOLD the request open returns an `MCPStream` instead of
a response: each `yield` is a notification, and the generator's `return`
value is the terminating response — closure is a result, not an
out-of-band event, so consuming a stream ends exactly where consuming a
unary response ends. `dispatch` surfaces that as a second return arm and
`handle` mirrors it as an `MCPTextStream` (the same sequence, already
serialized), which `bindServer` pumps onto the transport:

```ts
import { sendStream, serializeStream } from '@orkestrel/mcp'

server.methods.add('demo/watch', async (request) => watch(request))

const answer = await server.dispatch({ jsonrpc: '2.0', method: 'demo/watch', id: 2 })
if (answer !== undefined && Symbol.asyncIterator in answer) {
	// the ONE narrowing point — a typed stream, serializable and pumpable:
	await sendStream(serializeStream(answer), transport)
}
```

The legacy branch is untouched by any of this: its method set is frozen by
a shipped revision, so it keeps its own fixed switch and its byte-identical
unstamped responses.

### Configure modern subscriptions

`subscription.notifications` declares what the server can actually honour;
`subscription.listen` opens the event-driven source for the intersected filter.
The built-in owns wire acknowledgement, filtering, id stamping, and graceful
closure. A producer only yields project notifications and ends its iterable when
the source closes; while idle it parks on its own events and may observe the
supplied abort signal.

```ts
import {
	type JSONRPCRequest,
	buildSubscriptionAcknowledgement,
	buildSubscriptionFilter,
	buildSubscriptionResult,
	createMCPServer,
	isSubscriptionFilter,
	matchesSubscriptionNotification,
	stampSubscriptionNotification,
} from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const identity = { name: 'docs', version: '1.0.0' }
const supported = { toolsListChanged: true, resourceSubscriptions: ['resource://guide'] }
const input: unknown = { toolsListChanged: true, promptsListChanged: true }
if (!isSubscriptionFilter(input)) throw new Error('invalid filter')
const honoured = buildSubscriptionFilter(input, supported)
const event: JSONRPCRequest = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }
matchesSubscriptionNotification(event, honoured) // true
stampSubscriptionNotification(event, 'listen-1') // every delivery carries the reserved id
buildSubscriptionAcknowledgement(honoured, 'listen-1') // the first id-carrying message
buildSubscriptionResult('listen-1', identity) // the final complete response

async function* changes() {
	yield event
}

const server = createMCPServer({
	identity,
	tools: createToolManager(),
	subscription: {
		notifications: supported,
		listen: (_notifications, options) => {
			options.signal?.throwIfAborted()
			return changes()
		},
	},
})
server.methods.method('subscriptions/listen') // registered on the same modern seam
```

### Factories

| API                           | Kind     | Summary                                                                                                                                                                                |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMCPServer`             | function | Create an `MCPServerInterface` exposing tools plus an optional event-driven subscription source over JSON-RPC 2.0.                                                                     |
| `createMCPClient`             | function | Create an `MCPClientInterface` that drives a REMOTE server over an injected transport and exposes its tools as local `ToolInterface`s.                                                 |
| `createDuplexClientTransport` | function | Adapt an `MCPTransportInterface` into a `ClientTransportInterface` — the additive bridge letting `createMCPClient` run over the new environment-agnostic port; pair with `bindClient`. |

### Entities

| API                | Kind  | Summary                                                                                                                                 |
| ------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `MCPServer`        | class | The transport-agnostic JSON-RPC dispatch core over a `ToolManagerInterface` — `dispatch` (typed) + `handle` (string).                   |
| `MCPMethodManager` | class | The modern method registry `MCPServer` registers its built-ins on and resolves every modern method from — `add` + `method`.             |
| `MCPClient`        | class | The transport-agnostic dual-era JSON-RPC client over a `ClientTransportInterface` — negotiate once, then `discover` / `tools` / `call`. |
| `MCPError`         | class | A remote JSON-RPC error preserving its numeric `code` and optional `error.data` as `context`.                                           |

### Constants

| Constant                      | Kind  | Value                                                                                |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------ |
| `MCP_PROTOCOL_VERSION`        | const | `'2025-11-25'` — the newest legacy initialize revision.                              |
| `MCP_LEGACY_VERSION`          | const | `'2025-06-18'` — the legacy fallback anchor.                                         |
| `MCP_MODERN_VERSION`          | const | `'2026-07-28'` — the modern discovery revision.                                      |
| `SUPPORTED_PROTOCOL_VERSIONS` | const | Frozen preference order: `2026-07-28`, `2025-11-25`, `2025-06-18`.                   |
| `MCP_META_VERSION`            | const | `'io.modelcontextprotocol/protocolVersion'` — reserved request-version metadata key. |
| `MCP_META_CAPABILITIES`       | const | `'io.modelcontextprotocol/clientCapabilities'` — reserved capability metadata key.   |
| `MCP_META_CLIENT`             | const | `'io.modelcontextprotocol/clientInfo'` — reserved client-identity metadata key.      |
| `MCP_META_SERVER`             | const | `'io.modelcontextprotocol/serverInfo'` — reserved server-identity metadata key.      |
| `MCP_META_SUBSCRIPTION`       | const | `'io.modelcontextprotocol/subscriptionId'` — reserved subscription-id metadata key.  |
| `MCP_HEADER_MISMATCH`         | const | `-32020` — required HTTP metadata does not match the request body.                   |
| `MCP_MISSING_CAPABILITY`      | const | `-32021` — an operation needs an undeclared client capability.                       |
| `MCP_UNSUPPORTED_VERSION`     | const | `-32022` — the request names an unsupported protocol revision.                       |
| `DEFAULT_MCP_CACHE_TTL`       | const | `60000` — default modern cache freshness lifetime in milliseconds.                   |
| `JSONRPC_PARSE_ERROR`         | const | `-32700` — invalid JSON was received (the message did not parse).                    |
| `JSONRPC_INVALID_REQUEST`     | const | `-32600` — the payload was not a valid Request object.                               |
| `JSONRPC_METHOD_NOT_FOUND`    | const | `-32601` — the requested method does not exist.                                      |
| `JSONRPC_INVALID_PARAMS`      | const | `-32602` — the method's parameters were invalid.                                     |
| `JSONRPC_SERVER_ERROR`        | const | `-32000` — an implementation-defined server error.                                   |
| `DEFAULT_MCP_CLIENT_NAME`     | const | `'taverna'` — the default client name reported in the `initialize` handshake.        |
| `DEFAULT_MCP_CLIENT_VERSION`  | const | `'1.0.0'` — the default client version reported in the `initialize` handshake.       |
| `DEFAULT_MCP_REQUEST_TIMEOUT` | const | `30000` — the default per-request deadline (ms) an `MCPClient` applies.              |
| `DEFAULT_MCP_PROBE_TIMEOUT`   | const | `50` — the maximum configured discovery-probe deadline in milliseconds.              |

### Helpers

| API                                | Kind     | Summary                                                                                                                                                    |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isRequestId`                      | function | Total guard: a JSON-RPC REQUEST `id` — a string / number / absent (`null` is valid only on a response).                                                    |
| `isJSONRPCRequest`                 | function | Total guard: a record with `jsonrpc: '2.0'` + a string `method`; an absent `id` ⇒ a notification.                                                          |
| `isJSONRPCResponse`                | function | Total guard: `jsonrpc: '2.0'` + an `id` (string / number / `null`) + EXACTLY ONE of `result` / `error`.                                                    |
| `isJSONRPCMessage`                 | function | Total guard — the union of `isJSONRPCRequest` and `isJSONRPCResponse`.                                                                                     |
| `isInitializeRequest`              | function | Total guard — a `JSONRPCRequest` whose `method` is `'initialize'`.                                                                                         |
| `isMCPVersion`                     | function | Total guard — narrows a string to a supported `MCPVersion`.                                                                                                |
| `isSubscriptionFilter`             | function | Total guard — validates the recognized fields of an open modern subscription filter.                                                                       |
| `isModernRequest`                  | function | Total guard — modern iff `params._meta` carries the reserved protocol-version key.                                                                         |
| `isMCPError`                       | function | Total guard — `true` only for a real `MCPError`.                                                                                                           |
| `parseJSONRPCMessage`              | function | Narrow an already-parsed value to a `JSONRPCMessage`, or `undefined` (total; sound with `isJSONRPCMessage`).                                               |
| `parseRequestContext`              | function | Coerce valid modern metadata to `MCPRequestContext`, or `undefined` for malformed required metadata.                                                       |
| `inferEra`                         | function | Map a supported revision to `modern` or `legacy`; unsupported revisions return `undefined`.                                                                |
| `inferVersion`                     | function | Select the newest locally supported revision present in a peer's offer.                                                                                    |
| `buildJSONRPCResult`               | function | Build a success `JSONRPCResponse` — the `id` echoed, the value as `result`.                                                                                |
| `buildJSONRPCError`                | function | Build an error `JSONRPCResponse` — the `id`, a reserved `code` / `message`, and optional `data`.                                                           |
| `buildToolDescriptors`             | function | Map a `ToolManagerInterface`'s definitions to `tools/list` descriptors, renaming `parameters` → `inputSchema`.                                             |
| `buildCallResult`                  | function | Map a `ToolResult` (`@orkestrel/tool`) to an MCP tool-call result — the value (or error text + `isError: true`) as a text block.                           |
| `buildDiscoverResult`              | function | Build the required modern `server/discover` result with supported revisions and cache stamps.                                                              |
| `buildModernResult`                | function | Stamp a modern result with `resultType`, server metadata, and cache fields only when a TTL is supplied.                                                    |
| `buildSubscriptionFilter`          | function | Intersect requested notification families and resource URIs with the server's declared support.                                                            |
| `matchesSubscriptionNotification`  | function | Test whether a produced notification belongs to an acknowledged subscription filter.                                                                       |
| `stampSubscriptionNotification`    | function | Stamp a delivered notification with its reserved subscription id while preserving other params and metadata.                                               |
| `buildSubscriptionAcknowledgement` | function | Build the first id-carrying acknowledgement with the exact honoured notification subset.                                                                   |
| `buildSubscriptionResult`          | function | Build the graceful complete result carrying the request id as subscription identity.                                                                       |
| `buildInitializeResult`            | function | Build the `initialize` result — the negotiated `protocolVersion`, `capabilities`, and `serverInfo`.                                                        |
| `serializeStream`                  | function | Serialize a held-open `MCPStream` into its `MCPTextStream` mirror — each notification, then the terminating response as the RETURN value.                  |
| `sendStream`                       | function | Pump an `MCPTextStream` onto an `MCPTransportInterface` — every notification in order, then the terminating response last.                                 |
| `bindServer`                       | function | Pipe an `MCPTransportInterface` into an `MCPServerInterface` — inbound `handle`d, a defined reply `send` (a held-open one pumped); returns an unbind.      |
| `bindClient`                       | function | Pipe an `MCPTransportInterface` into an `MCPClientInterface` (built over `createDuplexClientTransport`) — completes the inbound wiring; returns an unbind. |

### Types

| Type                                  | Kind      | Shape                                                                                                                                                                                                                      |
| ------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JSONRPCRequest`                      | interface | `{ jsonrpc: '2.0'; method: string; id?: string \| number; params?: Record<string, unknown> }` — an absent `id` marks a notification.                                                                                       |
| `JSONRPCErrorData`                    | interface | `{ code: number; message: string; data?: unknown }` — the `error` member of a failed response.                                                                                                                             |
| `JSONRPCResponse`                     | interface | `{ jsonrpc: '2.0'; id: string \| number \| null; result?: unknown; error?: JSONRPCErrorData }` — EITHER `result` OR `error`.                                                                                               |
| `JSONRPCMessage`                      | type      | `JSONRPCRequest \| JSONRPCResponse` — a message on the wire.                                                                                                                                                               |
| `MCPVersion`                          | type      | `'2026-07-28' \| '2025-11-25' \| '2025-06-18'` — a supported protocol revision.                                                                                                                                            |
| `MCPEra`                              | type      | `'modern' \| 'legacy'` — the structural wire era.                                                                                                                                                                          |
| `MCPContent`                          | interface | `{ type: 'text'; text: string }` — one content block of a tool-call result.                                                                                                                                                |
| `MCPCallResult`                       | interface | `{ content; isError?; resultType?; _meta? }` — a `tools/call` result with optional modern stamps.                                                                                                                          |
| `MCPListResult`                       | interface | `{ tools; resultType?; ttlMs?; cacheScope?; _meta? }` — a legacy or modern `tools/list` result.                                                                                                                            |
| `MCPToolDescriptor`                   | interface | `{ name: string; description?: string; inputSchema: Record<string, unknown> }` — one `tools/list` entry.                                                                                                                   |
| `MCPIdentity`                         | interface | `{ name: string; version: string }` — the identity echoed in the `initialize` result.                                                                                                                                      |
| `MCPRequestContext`                   | interface | `{ version: string; capabilities: Record<string, unknown>; identity?: MCPIdentity }` — validated modern request metadata.                                                                                                  |
| `MCPDiscoverResult`                   | interface | Required modern discovery fields: supported revisions, capabilities, complete-result and cache stamps, optional instructions and metadata.                                                                                 |
| `SubscriptionFilter`                  | interface | Optional tool, prompt, resource-list, and resource-URI notification families for `subscriptions/listen`.                                                                                                                   |
| `SubscriptionsListenResultMetaObject` | interface | Required graceful-close metadata carrying the reserved subscription id.                                                                                                                                                    |
| `SubscriptionsListenResult`           | interface | `{ resultType: 'complete'; _meta: SubscriptionsListenResultMetaObject }` — a graceful subscription closure.                                                                                                                |
| `MCPDispatchOptions`                  | interface | `{ signal?: AbortSignal }` — the per-request execution options every dispatched handler receives; the signal aborts when the caller's request ends.                                                                        |
| `MCPSubscriptionHandler`              | type      | `(notifications, options) => AsyncIterable<JSONRPCRequest>` (or a promise of one) — an event-driven notification producer.                                                                                                 |
| `MCPSubscriptionOptions`              | interface | `{ notifications; listen }` — the supported filter and producer for the built-in subscription method.                                                                                                                      |
| `MCPStream`                           | type      | `AsyncGenerator<JSONRPCRequest, JSONRPCResponse>` — a held-open result: each `yield` is a notification, the `return` value is the terminating response.                                                                    |
| `MCPTextStream`                       | type      | `AsyncGenerator<string, string>` — the string-boundary mirror of `MCPStream`, the same sequence already serialized.                                                                                                        |
| `MCPMethodHandler`                    | type      | `(request, options) => Promise<JSONRPCResponse \| MCPStream \| undefined>` — one modern method, registered on the seam that dispatches it.                                                                                 |
| `MCPMethodManagerInterface`           | interface | The modern method registry — the `add` / `method` methods, carrying both the built-in methods and any method a consumer adds.                                                                                              |
| `MCPServerEventMap`                   | type      | `{ request: [method, id, era]; error: [unknown] }` — the observation surface (`era` is selected structurally per request; `error` is a bound-transport fault).                                                             |
| `MCPServerOptions`                    | interface | `{ on?; error?; identity; tools; instructions?; cache?; subscription? }` — options for `createMCPServer`.                                                                                                                  |
| `MCPServerInterface`                  | interface | `emitter` / `identity` / `methods` data members + the `dispatch` / `handle` methods.                                                                                                                                       |
| `MCPTransportInterface`               | interface | `{ send(message: string): void \| Promise<void>; listen(handler): void; closed(handler): void; close(): void \| Promise<void> }` — the environment-agnostic duplex message-channel port `bindServer` / `bindClient` drive. |
| `ClientTransportEventMap`             | type      | `{ message: [JSONRPCMessage]; close: []; error: [unknown] }` — the transport events.                                                                                                                                       |
| `ClientTransportInterface`            | interface | `emitter` / `session` data members + the `start` / `send` / `close` methods — the client's transport-agnostic carrier.                                                                                                     |
| `MCPClientEventMap`                   | type      | `{ connect: []; disconnect: []; notification: [JSONRPCMessage]; error: [unknown] }`.                                                                                                                                       |
| `MCPClientOptions`                    | interface | `{ on?; error?; transport; identity?; capabilities?; version?; timeout? }` — options for `createMCPClient`.                                                                                                                |
| `MCPClientInterface`                  | interface | `emitter` / `connected` / `version` / `transport` data members + the `on` / `connect` / `discover` / `disconnect` / `tools` / `call` methods.                                                                              |

The `emitter`, `identity`, and `methods` members of `MCPServerInterface` are
`readonly` data members (Surface rows, above) — its call-signature methods
are documented under [Methods](#methods), and the registry `methods` exposes
has its own method table there. Likewise the `emitter` /
`connected` / `version` / `transport` members of `MCPClientInterface` and
the `emitter` / `session` members of `ClientTransportInterface` are data
members; their methods are under [Methods](#methods). The `id` member of
`MCPSessionInterface` is likewise a data member; its methods (`attach` /
`detach` / `push` / `replay`) are under [Methods](#methods).

### HTTP transport

The **Streamable HTTP transport** (`src/server`, via the `@src/server` barrel)
mounts a transport-agnostic `MCPServerInterface` on the `@orkestrel/router` /
`@orkestrel/server` spine as a route. `createMCPRoutes` returns the
`RouteInput[]` to register; it is **mechanism, not policy** — compose auth /
rate-limiting IN FRONT as ordinary middleware and supply the shared origin policy
through the `origin` option. Request-body size limits
are likewise deliberately NOT enforced by `createMCPRoutes` / `createMCPSession` —
a body-size guard is front-middleware policy the consumer composes, same as auth.

```ts
import { createMCPServer } from '@orkestrel/mcp'
import { createMCPRoutes } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
const routes = createMCPRoutes(mcp) // POST /mcp dispatches JSON-RPC (JSON or SSE per Accept)
```

`createMCPRoutes` is **stateless**: a single `POST {path}` route pumps each
request body through `mcp.dispatch`. A malformed JSON body, or a parsed value
that is not a JSON-RPC request, is an HTTP `400` carrying a JSON-RPC error
body (`-32700` / `-32600`, id `null`). Legacy dispatch results retain uniform
HTTP `200` with in-band errors. Modern responses use `202` for notifications,
`400` for `-32020` / `-32021` / `-32022` / `-32602`, `404` for `-32601`, and
`200` otherwise. A unary reply is framed as one `@orkestrel/server` `openStream`
SSE `data:` event when streaming is enabled and the client accepts event-stream,
then the stream ends with `X-Accel-Buffering: no`; otherwise it is a plain JSON
body. A held-open `MCPStream` always occupies that same SSE seam: every yielded
notification is written in order, the generator's returned response is written
last, and only then does the HTTP stream end. Waiting is on the producer's async
iterator, never polling.

A modern POST requires `MCP-Protocol-Version` equal to its reserved `_meta`
version and `Mcp-Method` equal to its body method. `Mcp-Name` is required only
for `tools/call`, equal to `params.name`; `server/discover` and `tools/list`
carry no name. Any mismatch is HTTP `400` + `-32020` with no `data`. Headerless
legacy `initialize` is accepted; a headerless post-initialize legacy request is
accepted only through a live session, whose pinned negotiated version the session
middleware supplies; every other headerless request is HTTP `400` + `-32020`.
`GET` / `DELETE` to the path fall through to whatever the router does with an
unmatched method (the resumable server→client GET-SSE channel + session-end
live in the session middleware below).

**Sessions are a separate, native, plug-and-play middleware — NO dependency on
`@orkestrel/middleware`.** `createMCPSession` is a `MiddlewareHandler<TState>`
(`@orkestrel/server`); compose it via `router.use(createMCPSession())` IN
FRONT of a session-agnostic `createMCPRoutes(mcp)`. It owns a closure
`Map<string, { session, touched, version }>`, mints a session on an `initialize` POST
(`crypto.randomUUID()`), validates the `mcp-session-id` header on every other
legacy verb, and adds the resumable `GET` SSE stream — all native to this package.
A modern-shaped POST passes straight through without session lookup and ignores
any `mcp-session-id`; the layer otherwise pins the negotiated legacy revision and
supplies it on a headerless live-session request. The same default-on origin validation
applies to session verbs: a present origin requires an exact entry in the shared
`origin.origins` list. A deployment that validates upstream sets `origin.enabled` to `false`
on the one options value passed to both layers. No shared session primitive is composed; the store, mint, and stream are
implemented here. Because the body can only be read ONCE, the middleware
buffers `request.text()` and FORWARDS a freshly built `Request` carrying that
text to `next(...)` so the downstream route can re-read it. Omit the
middleware for the byte-identical stateless default. The WebSocket and stdio
transports are inherently one session per connection, so they carry no
session header — `createMCPSession` is for the HTTP transport only.

**Resumable server→client push.** Each `MCPSession` FOLDS IN a bounded replay
log; `session.push(message)` APPENDS the message to that log with a monotone
event id AND fans it out to every open `GET {path}` SSE stream as one
`id:`-tagged event. An in-request handler addresses the current session via
`context.state.session` (the `createMCPSession` middleware sets it on every
validated request, per `MCPSessionState`). A client opens the `GET` (with
`Accept: text/event-stream` + its `mcp-session-id`) to receive pushes live; on
a dropped connection it RECONNECTS sending the `Last-Event-ID` of the last
event it saw, and the server REPLAYS every logged event strictly after that
id (in order) before resuming live pushes. A `Last-Event-ID` the log no longer
retains (evicted past `capacity` / `ttl`, or never seen) replays NOTHING — the
spec-sane resume that never re-delivers un-lost events. The log is a plain
in-memory `Map` with capacity + lazy-TTL eviction.

#### Factories

| API                         | Kind     | Summary                                                                                                                                                                          |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMCPRoutes`           | function | Mount an `MCPServerInterface` on the router spine — returns the `RouteInput[]` for `router.add(...)` (a single STATELESS `POST` route).                                          |
| `createMCPPostHandler`      | function | Create the stateless Streamable-HTTP POST handler directly for a custom route integration.                                                                                       |
| `createHTTPClientTransport` | function | Create a `ClientTransportInterface` over `fetch` that drives a REMOTE Streamable-HTTP MCP server (the egress mirror).                                                            |
| `createMCPSession`          | function | Create the opt-in native session `MiddlewareHandler` — closure store + mint-on-`initialize` + require-404 + the resumable `GET` SSE stream; mount in front of `createMCPRoutes`. |

#### Entities

| API                   | Kind  | Summary                                                                                                                                                                                                 |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTPClientTransport` | class | The HTTP `ClientTransportInterface` over an injectable `fetch` — POSTs each message, decodes the JSON / SSE reply onto the `message` event.                                                             |
| `MCPSession`          | class | One MCP transport session — its `id` + attached SSE streams + the FOLDED bounded replay log (`Map` + capacity + lazy TTL); `push`/`attach`/`detach`/`replay` drive the resumable server→client channel. |

#### Constants

| Constant                       | Kind  | Value                                                                                                                               |
| ------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_SESSION_HEADER`           | const | `'mcp-session-id'` — the session header `createMCPSession` sets on `initialize` + reads thereafter.                                 |
| `MCP_PROTOCOL_VERSION_HEADER`  | const | `'mcp-protocol-version'` — required by 2025-06-18 on post-initialize requests; the clients send it and the POST route validates it. |
| `MCP_METHOD_HEADER`            | const | `'mcp-method'` — the modern request method, required to equal the JSON-RPC body method.                                             |
| `MCP_NAME_HEADER`              | const | `'mcp-name'` — the modern named target, required only for `tools/call`.                                                             |
| `SSE_BUFFERING_HEADER`         | const | `'x-accel-buffering'` — the reverse-proxy buffering response header used by SSE responses.                                          |
| `SSE_BUFFERING_DISABLED`       | const | `'no'` — the value disabling reverse-proxy buffering for SSE responses.                                                             |
| `DEFAULT_MCP_PATH`             | const | `'/mcp'` — the default path `createMCPRoutes` mounts the `POST` at (and `createMCPSession` owns for `GET` / `DELETE`).              |
| `DEFAULT_MCP_SESSION_CAPACITY` | const | `1024` — the default max retained pushed messages in a session's folded resumable event log (oldest evicted past it).               |
| `DEFAULT_MCP_SESSION_TTL`      | const | `300000` — the default per-event idle lifetime (ms, 5 min) of a session's folded event log; a staler entry is lazily evicted.       |

#### Helpers

| API                      | Kind     | Summary                                                                                                                                                                                                             |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptsEventStream`     | function | Whether the request's `Accept` header contains `text/event-stream`.                                                                                                                                                 |
| `allowsOrigin`           | function | Allow an absent Origin; require every present serialized Origin in the explicit list unless validation is delegated upstream.                                                                                       |
| `matchesModernHeaders`   | function | Validate the modern protocol/method headers and the tools/call-only name header against the body.                                                                                                                   |
| `inferLegacyVersion`     | function | Pin a supported requested legacy revision, otherwise select the newest supported legacy revision.                                                                                                                   |
| `inferStatus`            | function | Map a dispatch outcome to its era-aware HTTP status while preserving legacy in-band `200` errors.                                                                                                                   |
| `readSessionHeader`      | function | Read the request's `mcp-session-id` header for the stateful transport, or `undefined`.                                                                                                                              |
| `readLastEventId`        | function | Read the request's `Last-Event-ID` header — the resumable GET-SSE replay cursor, or `undefined`.                                                                                                                    |
| `rejectUnknownSession`   | function | Build the stateful transport's unknown-session reply — a `404` + a JSON-RPC `-32600` "Session not found" body.                                                                                                      |
| `readEventStream`        | function | Decode a `fetch` Response's SSE body into the `JSONRPCMessage`s it carried (the egress inverse; total).                                                                                                             |
| `decodeEvent`            | function | Decode one SSE event's `data` string into a `JSONRPCMessage`, or `undefined` (total).                                                                                                                               |
| `upgradeRequestPath`     | function | Read a raw `node:http` upgrade request's path (no query) for the `createWebSocketServer` upgrade-path match.                                                                                                        |
| `extractLines`           | function | Fold one more chunk of raw stdio bytes into a newline-framed buffer — complete `lines` + the trailing `remainder`.                                                                                                  |
| `dispatchLines`          | function | Decode and deliver each complete newline-framed line onto a `ClientTransportEventMap` emitter (`message` / `error`).                                                                                                |
| `bridgeMessageTransport` | function | Adapt a message-channel `ClientTransportInterface` (stdio / WebSocket server transports) into the core `MCPTransportInterface` port — what `createStdioServer` / `createWebSocketServer` pipe through `bindServer`. |

#### Types

| Type                         | Kind      | Shape                                                                                                                                                                                                                                    |
| ---------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCPOriginOptions`           | interface | `{ enabled?: boolean; origins?: readonly string[] }` — shared default-on origin validation; `enabled: false` delegates upstream and ignores `origins`.                                                                                   |
| `HTTPTransportOptions`       | interface | `{ path?: string; streaming?: boolean; origin?: MCPOriginOptions }` — mount path, SSE choice, and shared origin options for `createMCPRoutes`.                                                                                           |
| `HTTPClientTransportOptions` | interface | `{ url: string; headers?: Record<string, string>; fetch?: typeof fetch; timeout?: number }` — the remote endpoint, extra headers, an injectable `fetch`, and an optional `AbortSignal.timeout` deadline for `createHTTPClientTransport`. |
| `MCPSessionOptions`          | interface | `{ path?; ttl?; capacity?; clock?; origin? }` — the owned path, session TTL, replay bound, deterministic clock, and the same shared origin options for `createMCPSession`.                                                               |
| `MCPSessionInterface`        | interface | `id` data member + `attach` / `detach` / `push` / `replay` methods — one session + its resumable server→client push channel (the `MCPSession` entity).                                                                                   |
| `MCPSessionState`            | interface | `{ session?: MCPSessionInterface }` — the `context.state` slice a consumer's `TState` extends so `createMCPSession` can thread the resolved session through.                                                                             |
| `EventStoreEntry`            | interface | `{ id: string; message: JSONRPCMessage; timestamp: number }` — one logged pushed message (the unit `MCPSession.replay` returns).                                                                                                         |
| `MCPSessionEntry`            | interface | `{ session: MCPSession; touched: number; version: MCPVersion }` — the closure store entry, including the pinned negotiated legacy revision.                                                                                              |

### WebSocket transport

The **WebSocket transport** (`src/server`, via the `@src/server` barrel) is a
full-duplex alternative to the HTTP transport over a single persistent
connection. `createWebSocketServer` returns an `UpgradeHandler`
(`@orkestrel/server`) to register on the spine's `server.upgrade(...)`
seam; it composes the lean `@orkestrel/websocket` RFC 6455 wrapper and pumps
each inbound JSON-RPC request through `mcp.dispatch`.
`createWebSocketClientTransport` is the egress mirror — a
`ClientTransportInterface` an `MCPClient` drives over a `node:http(s)`
upgrade. Both `WebSocketServerTransport` and `WebSocketClientTransport` REUSE
the same `ClientTransportInterface` the HTTP client transport implements (a
generic bidirectional JSON-RPC channel — `emitter` / `start` / `send` /
`close`, `session` `undefined` for the stateless v1), so the WebSocket and
HTTP transports share ONE transport contract. Like the HTTP transport it is
**mechanism, not policy** — compose an auth guard IN FRONT by registering a
`server.upgrade(...)` handler BEFORE this one (it can decline + destroy an
unauthenticated upgrade).

```ts
import { createMCPClient, createMCPServer } from '@orkestrel/mcp'
import { createWebSocketClientTransport, createWebSocketServer } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
server.upgrade(createWebSocketServer(mcp)) // claims an MCP WebSocket upgrade to /mcp

// An MCP client connects over the SAME MCPClient, a WebSocket transport instead of HTTP:
const client = createMCPClient({
	transport: createWebSocketClientTransport({ url: `ws://127.0.0.1:${port}/mcp` }),
})
await client.connect() // the RFC 6455 handshake, then the MCP initialize over frames
```

#### Factories

| API                              | Kind     | Summary                                                                                                                                                         |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWebSocketServer`          | function | Mount an `MCPServerInterface` over WebSocket — returns an `UpgradeHandler` for `server.upgrade(...)` (claims an MCP WS upgrade, pipes it through `bindServer`). |
| `createWebSocketClientTransport` | function | Create a `ClientTransportInterface` that drives a REMOTE MCP server over a WebSocket (the WS egress mirror).                                                    |

#### Entities

| API                        | Kind  | Summary                                                                                                                                    |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `WebSocketServerTransport` | class | The per-connection JSON-RPC-over-WebSocket SERVER bridge over a `NodeWebSocketInterface` — a `ClientTransportInterface` the ingress pumps. |
| `WebSocketClientTransport` | class | The WebSocket `ClientTransportInterface` — handshakes, then bridges the upgraded socket's frames as the client's message channel.          |

#### Constants

| Constant                    | Kind  | Value                                                                                                                            |
| --------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_WEBSOCKET_SUBPROTOCOL` | const | `'mcp'` — the WebSocket subprotocol the transports negotiate (`Sec-WebSocket-Protocol`); the default path is `DEFAULT_MCP_PATH`. |

#### Helpers

_`upgradeRequestPath` (used by `createWebSocketServer`) and `bridgeMessageTransport` (which `createWebSocketServer` pipes its transport through `bindServer` with) are documented under [HTTP transport § Helpers](#helpers-1)._

#### Types

| Type                              | Kind      | Shape                                                                                                                                |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `WebSocketServerOptions`          | interface | `{ path?: string; subprotocol?: string }` — the upgrade path (default `/mcp`) + the negotiated subprotocol (default `'mcp'`).        |
| `WebSocketClientTransportOptions` | interface | `{ url: string; headers?: Record<string, string> }` — the remote WS endpoint (`ws(s)://` or `http(s)://`) + extra handshake headers. |

### stdio transport

The **stdio transport** (`src/server`, via the `@src/server` barrel) is the
third server transport — newline-delimited JSON-RPC over a process's own
`stdin`/`stdout` (the server side) or a spawned child process's piped stdio
(the client side). `createStdioServer` wraps `options.input` / `options.output`
(defaulting to `process.stdin` / `process.stdout`, injectable for tests) as a
`ClientTransportInterface`, bridges it to the core `MCPTransportInterface` port
via `bridgeMessageTransport`, and pipes it through `bindServer` — each inbound
JSON-RPC request runs through `mcp.dispatch`, writing a defined response back
as one newline-terminated line (a notification writes nothing).
`createStdioClientTransport` is the egress mirror — it spawns `options.command`
(`node:child_process.spawn`) with `options.args` / `options.env`, piping the
child's `stdin`/`stdout` for the JSON-RPC channel (`stderr` inherits the
parent's for diagnostics). Both share the newline-framing helpers
`extractLines` (fold a raw chunk into complete lines + a carried remainder)
and `dispatchLines` (decode + emit each complete line as `message` or
`error`) — documented under [HTTP transport § Helpers](#helpers-1) since they
live in the shared `helpers.ts`.

```ts
import { createMCPClient, createMCPServer } from '@orkestrel/mcp'
import { createStdioClientTransport, createStdioServer } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
createStdioServer(mcp).start() // an MCP client now connects over this process's stdio

// A client spawns a stdio MCP server as a child process and drives it the same way:
const client = createMCPClient({
	transport: createStdioClientTransport({ command: 'node', args: ['./server.js'] }),
})
await client.connect()
client.version // the negotiated legacy revision
const tools = await client.tools()
```

#### Factories

| API                          | Kind     | Summary                                                                                                                                            |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createStdioClientTransport` | function | Create a `ClientTransportInterface` that spawns a CHILD PROCESS MCP server and drives it over its piped stdio.                                     |
| `createStdioServer`          | function | Pipe an `MCPServerInterface` (via `bindServer`) over newline-delimited JSON-RPC on `stdin`/`stdout` (or injected streams) — `{ start(); stop() }`. |

#### Entities

| API                    | Kind  | Summary                                                                                                                |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| `StdioClientTransport` | class | The `ClientTransportInterface` that spawns and drives a child process's stdio as a newline-delimited JSON-RPC channel. |
| `StdioServerTransport` | class | The `ClientTransportInterface` wrapping a readable/writable stream pair (default `process.stdin` / `process.stdout`).  |

#### Constants

_None specific to this section._

#### Helpers

_See `extractLines` / `dispatchLines` under [HTTP transport § Helpers](#helpers-1)._

#### Types

| Type                          | Kind      | Shape                                                                                                                                     |
| ----------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `StdioClientTransportOptions` | interface | `{ command: string; args?: readonly string[]; env?: Record<string, string> }` — the child process to spawn.                               |
| `StdioServerOptions`          | interface | `{ input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }` — the injectable stream pair (default `process.stdin`/`stdout`).      |
| `LineExtraction`              | interface | `{ lines: readonly string[]; remainder: string }` — the result of folding one more chunk into the newline-framed buffer (`extractLines`). |

### Browser transport

The **browser transport** (`src/browser`, via the `@src/browser` barrel /
`@orkestrel/mcp/browser`) is the page / Web Worker / Service Worker face.
Two CLIENT-only transports drive a REMOTE MCP server from the browser,
over the SAME `ClientTransportInterface` the Node face's transports
implement, so `createMCPClient` consumes either identically.
`createWebSocketClientTransport` drives the native `WebSocket` global (the
host performs the RFC 6455 handshake, so this face carries none of the
Node client's `node:crypto` / `node:http(s)` machinery);
`createHTTPClientTransport` drives the native `fetch` + `ReadableStream`,
decoding the SSE leg with `@orkestrel/sse` and honoring the SAME era-aware
HTTP headers as the Node face: modern requests derive protocol and method
headers from their body plus the name only for `tools/call`, while legacy
requests echo only their captured negotiated protocol. It also honors the
same `mcp-session-id` semantics, so a browser client interoperates with an
`MCPSession`-based server unchanged. Both share their exported NAMES with
the Node face's transports — same API shape, a different host underneath
— deliberately, so a consumer swaps `@orkestrel/mcp/server` for
`@orkestrel/mcp/browser` with no call-site change.

A browser deployment must list the page origin in the shared `origin.origins` value passed
to both server enforcement sites, or delegate validation with `origin.enabled: false`; see
[Mount the HTTP transport with sessions](#mount-the-http-transport-with-sessions).

`createMessagePortTransport` is the genuinely NEW capability: MCP over
`postMessage`. A `MessagePort` is SYMMETRIC, so `MessagePortTransport` is the
ONE class both a server AND a client bind — it implements `@src/core`'s
`MCPTransportInterface` directly (not `ClientTransportInterface`), and
whichever binder it is handed to (`bindServer` or `bindClient`) decides its
role. `serveMCP` is the `serveWorker` analog: boot an `MCPServer` inside the
CURRENT Web-Worker-or-Service-Worker scope and wire its message events to it
— `serveMCPScope(scope, options)` is the exported, scope-parameterized core
`serveMCP` wraps over `globalThis`, kept separate so a test drives the wiring
with a scope double instead of a real worker.

This face is DOM-free by construction (type-checked against `lib: ["ESNext",
"WebWorker"]`, no `"dom"`), so it runs identically in a page, a Web Worker,
and a Service Worker.

```ts
import { createMCPClient } from '@orkestrel/mcp'
import { createHTTPClientTransport, createWebSocketClientTransport } from '@orkestrel/mcp/browser'

const ws = createMCPClient({
	// No `protocols` needed — defaults to MCP_WEBSOCKET_SUBPROTOCOL ('mcp'), matching
	// createWebSocketServer's unconditional echo. Override only for foreign servers.
	transport: createWebSocketClientTransport({ url: 'ws://localhost:3000/mcp' }),
})
await ws.connect() // the browser handshakes, then the MCP initialize runs over WS frames

const http = createMCPClient({
	transport: createHTTPClientTransport({ url: 'http://localhost:3000/mcp' }),
})
await http.connect()
const tools = await http.tools()
```

#### Factories

| API                              | Kind     | Summary                                                                                                                                                          |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWebSocketClientTransport` | function | Create a `ClientTransportInterface` over the native `WebSocket` global that drives a REMOTE MCP server (browser face).                                           |
| `createHTTPClientTransport`      | function | Create a `ClientTransportInterface` over the native `fetch` that drives a REMOTE Streamable-HTTP MCP server (browser face).                                      |
| `createMessagePortTransport`     | function | Create an `MCPTransportInterface` over a native `MessagePort` — SYMMETRIC, works as either a server or a client carrier depending on the binder it is handed to. |
| `createScopeTransport`           | function | Adapt a `ServeMCPScopeInterface` (`self`) into a `ScopeTransportInterface` — the implicit, portless channel `serveMCPScope` binds.                               |

#### Bootstrap

The `serveWorker` analog (the bootstrap factories in `src/browser/factories.ts`) — boot an `MCPServer`
inside a hostable scope and wire its message events to it.

| API             | Kind     | Summary                                                                                                                        |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `serveMCP`      | function | Boot an `MCPServer` inside the CURRENT scope (`globalThis`) — exactly `serveMCPScope(globalThis, options)`. Returns a dispose. |
| `serveMCPScope` | function | The scope-parameterized core `serveMCP` wraps — testable directly with a scope double. Returns an idempotent dispose.          |

#### Entities

| API                        | Kind  | Summary                                                                                                                                                |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WebSocketClientTransport` | class | The browser-face `ClientTransportInterface` over the native `WebSocket` — queues sends until `open`, flushed in order.                                 |
| `HTTPClientTransport`      | class | The browser-face `ClientTransportInterface` over native `fetch` — POSTs each message, decodes JSON/SSE, echoes sessions, and stamps era-aware headers. |
| `MessagePortTransport`     | class | The SYMMETRIC `MCPTransportInterface` over a native `MessagePort` — `start()`s at construction, string payloads only, `close()` idempotent.            |

#### Constants

| Constant                      | Kind  | Value                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_SESSION_HEADER`          | const | `'mcp-session-id'` — the SAME header name as the Node face's `MCP_SESSION_HEADER`, echoed identically.                                                                                                                                                                                                  |
| `MCP_PROTOCOL_VERSION_HEADER` | const | `'mcp-protocol-version'` — the SAME header name as the Node face; derived per modern request or echoed from legacy negotiation.                                                                                                                                                                         |
| `MCP_METHOD_HEADER`           | const | `'mcp-method'` — the SAME browser-local literal as the Node face; carries every modern request's body method.                                                                                                                                                                                           |
| `MCP_NAME_HEADER`             | const | `'mcp-name'` — the SAME browser-local literal as the Node face; carries `params.name` only for modern `tools/call`.                                                                                                                                                                                     |
| `MCP_WEBSOCKET_SUBPROTOCOL`   | const | `'mcp'` — the WebSocket subprotocol `createWebSocketClientTransport` requests by default, matching `createWebSocketServer`'s unconditional echo. Per RFC 6455 §4.1 a client must fail the connection if the server returns a subprotocol it did not request; Node ≥ 22 (undici) enforces this strictly. |
| `DEFAULT_MCP_SERVER_NAME`     | const | `'taverna'` — `serveMCPScope`'s default `serverInfo.name` when `options.name` is omitted.                                                                                                                                                                                                               |
| `DEFAULT_MCP_SERVER_VERSION`  | const | `'1.0.0'` — `serveMCPScope`'s default `serverInfo.version` when `options.version` is omitted.                                                                                                                                                                                                           |

#### Helpers

| API                          | Kind     | Summary                                                                                                                                                                                                                            |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decodeEvent`                | function | Decode one SSE event's `data` string into a `JSONRPCMessage`, or `undefined` (total).                                                                                                                                              |
| `readEventStream`            | function | Decode a `fetch` Response's SSE body into the `JSONRPCMessage`s it carried (the egress inverse; total).                                                                                                                            |
| `createScopeMessageListener` | function | Build `serveMCPScope`'s unified `message`-event listener — a port-bearing event is gated by `accept`, deduped by seen port, then spawns a per-port binding; a portless string-data event delivers onto the implicit scope channel. |

#### Types

| Type                              | Kind      | Shape                                                                                                                                                                                                                            |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketClientTransportOptions` | interface | `{ url: string; protocols?: string \| readonly string[] }` — the remote WS endpoint + optional subprotocol(s) (default `MCP_WEBSOCKET_SUBPROTOCOL`; pass `[]` for no subprotocol).                                               |
| `HTTPClientTransportOptions`      | interface | `{ url: string; headers?: Record<string, string>; fetch?: typeof fetch; timeout?: number }` — the remote endpoint, extra headers, an injectable `fetch`, and an optional `AbortSignal.timeout` deadline.                         |
| `MessagePortTransportOptions`     | interface | `{ port: MessagePort }` — the port half `MessagePortTransport` sends/listens on.                                                                                                                                                 |
| `ServeMCPScopeInterface`          | interface | `{ postMessage(message): void; addEventListener('message', listener): void; removeEventListener('message', listener): void }` — the structural shape `serveMCPScope` needs from a hostable scope.                                |
| `ScopeTransportInterface`         | interface | `MCPTransportInterface & { deliver(message: string): void }` — the implicit scope channel `serveMCPScope` binds, plus the internal push entry point `serveMCPScope`'s dispatcher drives it through.                              |
| `ServeMCPOptions`                 | interface | `{ tools: ToolManagerInterface; name?: string; version?: string; accept?: (event: MessageEvent) => boolean }` — the registry to expose, optional server identity, and optional port-event gate for `serveMCP` / `serveMCPScope`. |

## Methods

The public methods of the layer's behavioral interfaces — every call-signature
member listed (their `readonly` data members stay Surface rows). Each
implementing class exposes EXACTLY its interface's methods: `MCPServer` ↔
`MCPServerInterface`, `MCPMethodManager` ↔ `MCPMethodManagerInterface`,
`MCPClient` ↔ `MCPClientInterface`, the SEVEN transports
`HTTPClientTransport` / `WebSocketServerTransport` / `WebSocketClientTransport`
/ `StdioClientTransport` / `StdioServerTransport` (`src/server`) PLUS the
browser face's own `HTTPClientTransport` / `WebSocketClientTransport`
(`src/browser`, same names, a different host underneath) ↔
`ClientTransportInterface` (all seven share the one generic bidirectional
JSON-RPC carrier — only the wire framing / host differs, so they add no new
behavioral interface), and the session entity `MCPSession` ↔
`MCPSessionInterface` (the folded replay log is private to it).

#### `MCPServerInterface`

`dispatch` is the typed JSON-RPC core (runs a parsed request, resolves the
response, a held-open `MCPStream`, or `undefined` for a notification);
`handle` is the string boundary that wraps it with parse / serialize and the
parse / invalid-request error mapping. Both take an optional
`MCPDispatchOptions` bag, so every existing caller compiles unchanged.

| Method     | Returns                                              | Behavior                                                                                                                                                                                            |
| ---------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch` | `Promise<JSONRPCResponse \| MCPStream \| undefined>` | Select the structural era, emit `request(method, id, era)`, then run the legacy switch or resolve the modern method from `methods`; resolve its answer, or `undefined` for any notification.        |
| `handle`   | `Promise<string \| MCPTextStream \| undefined>`      | `JSON.parse` → narrow to a request → `dispatch` → serialize. A parse failure → a `-32700` string; a non-request → a `-32600` string; a notification → `undefined`; a held-open answer → its mirror. |

```ts
import { createMCPServer } from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const server = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
const response = await server.dispatch({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
const reply = await server.handle('{"jsonrpc":"2.0","method":"ping","id":2}', {
	signal: controller.signal,
})
```

#### `MCPMethodManagerInterface`

The modern method seam `server.methods` exposes — `add` registers (or
replaces) one method, `method` resolves one. The server registers
`server/discover`, `tools/list`, `tools/call`, and `subscriptions/listen` here at construction and
resolves EVERY modern method from here, so there is no second dispatch path
and no precedence puzzle.

| Method   | Returns                         | Behavior                                                                                                                            |
| -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `add`    | `void`                          | Register one modern method under a JSON-RPC method name, REPLACING any handler already registered under it.                         |
| `method` | `MCPMethodHandler \| undefined` | Resolve the handler registered for a method name; `undefined` for an unregistered one, which the modern branch turns into `-32601`. |

```ts
import { buildJSONRPCResult, createMCPServer } from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const server = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
server.methods.add('demo/probe', async (request) =>
	buildJSONRPCResult(request.id ?? null, { probed: true }),
)
server.methods.method('demo/probe') // the handler just registered
server.methods.method('demo/absent') // undefined → -32601
```

#### `MCPClientInterface`

The egress mirror: `connect` negotiates the era once and stores the selected
`version`, `discover` exposes the modern server description, `tools` wraps the
remote tools as local `ToolInterface`s, `call` runs a remote `tools/call`,
`disconnect` rejects pending requests, clears the negotiated revision, and
closes; `on` is the convenience forward to `emitter.on`.

| Method       | Returns                             | Behavior                                                                                                                                                                      |
| ------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `on`         | `void`                              | Subscribe a listener to a `MCPClientEventMap` event (`connect` / `disconnect` / `notification` / `error`) — forwards to `emitter.on`.                                         |
| `connect`    | `Promise<void>`                     | Open and negotiate once: pinned legacy initializes directly; otherwise discover modern first, retry one `-32022`, or fall back for a legacy peer. Idempotent while connected. |
| `discover`   | `Promise<MCPDiscoverResult>`        | Send a stamped modern `server/discover` request and return its validated result, filtered to revisions this client supports.                                                  |
| `disconnect` | `Promise<void>`                     | Reject every pending request, clear `version`, close the transport, and fire `disconnect`. The era cache remains for this instance.                                           |
| `tools`      | `Promise<readonly ToolInterface[]>` | Run `tools/list` and wrap each descriptor as a local `ToolInterface` (`inputSchema` → `parameters`; `execute` calls back via `call`).                                         |
| `call`       | `Promise<unknown>`                  | Run a remote `tools/call`, reject a non-complete result, concat text blocks, throw on `isError`, else parse the JSON value (raw-string fallback).                             |

```ts
import { createMCPClient } from '@orkestrel/mcp'
import { createHTTPClientTransport } from '@orkestrel/mcp/server'

const client = createMCPClient({
	transport: createHTTPClientTransport({ url: 'http://localhost:3000/mcp' }),
})
client.on('notification', (message) => log(message))
await client.connect()
client.version // '2026-07-28' for a modern peer
const discovery = await client.discover()
const tools = await client.tools()
const value = await client.call('add', { x: 2, y: 5 })
await client.disconnect()
```

#### `ClientTransportInterface`

The client's transport-agnostic carrier — `start` opens, `send` writes one
message (its reply surfaces on `emitter`'s `message`), `close` tears down.

| Method  | Returns         | Behavior                                                                                              |
| ------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `start` | `Promise<void>` | Open the transport and arm any reply reader (a no-op for a request/response transport).               |
| `send`  | `Promise<void>` | Write one JSON-RPC message to the remote server; its decoded reply is emitted on the `message` event. |
| `close` | `Promise<void>` | Close the transport and release resources (fires `close`).                                            |

```ts
import { createHTTPClientTransport } from '@orkestrel/mcp/server'

const transport = createHTTPClientTransport({ url: 'http://localhost:3000/mcp' })
transport.emitter.on('message', (message) => log(message))
await transport.start()
await transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 })
await transport.close()
```

#### `MCPSessionInterface`

One MCP transport session (the `MCPSession` entity) — its `id` is a data
member (Surface row); the methods below drive the resumable server→client
push channel, with the bounded replay log FOLDED IN (private). `createMCPSession`
mints + stores it; an in-request handler reads it off `context.state.session`
and `push`es.

| Method   | Returns                      | Behavior                                                                                                                                       |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `attach` | `void`                       | Register an OPEN server→client SSE stream (a resumable `GET {path}`) so future `push`es reach it.                                              |
| `detach` | `void`                       | Unregister a stream — called when the client disconnects (via the request's `AbortSignal`).                                                    |
| `push`   | `string`                     | Append `message` to the folded log under a fresh MONOTONE id (returned) AND fan it out to every attached stream as one `id:`-tagged SSE event. |
| `replay` | `readonly EventStoreEntry[]` | Every retained log entry STRICTLY AFTER `afterId`, in order; an unknown / evicted cursor replays nothing (the spec-sane resume).               |

```ts
import { createMCPSession } from '@orkestrel/mcp/server'

const middleware = createMCPSession({ ttl: 60_000 })
// an in-request handler addresses the resolved session via `context.state.session`:
const session = context.state.session
if (session !== undefined) {
	session.push({ jsonrpc: '2.0', method: 'notifications/progress' }) // fan out to attached streams
	const missed = session.replay(lastSeenId) // events strictly after the client's cursor
	session.attach(stream) // register an open GET-SSE stream for future pushes
	session.detach(stream) // unregister it on disconnect
}
```

## Contract

These invariants hold across the MCP layer (`src/core` + `src/server`) ↔ `mcp.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `const` /
   `interface` / `type` row in the `## Surface` tables (the core dispatch
   tables AND the `### HTTP transport` + `### WebSocket transport` + `### stdio
transport` tables) is a real export of the mcp layer (`src/core` or
   `src/server`), and every export of either appears as a Surface row —
   exhaustive, both directions.
2. **JSON-RPC 2.0 envelope.** A `dispatch` response is always `{ jsonrpc:
'2.0', id, … }` with EXACTLY ONE of `result` / `error`; the `id` echoes the
   request's id (or `null` only on a `handle` parse / invalid-request error).
   `handle` serializes that envelope with `JSON.stringify` and returns the
   string. A HELD-OPEN answer is the other arm of the same return: `dispatch`
   resolves an `MCPStream` and `handle` its serialized `MCPTextStream` mirror,
   narrowed apart at ONE point (`Symbol.asyncIterator in result`). The stream's
   `return` value is the terminating response and obeys this same envelope.
3. **Notifications yield no response.** A request with NO `id` is a
   notification: `dispatch` emits `request` (with a `null` id and the structural era) and then
   resolves `undefined` WHATEVER the method (`ping`, `notifications/initialized`,
   an unknown method — all silent); `handle` returns `undefined`. Neither era
   branch ever runs for a request without an `id`.
4. **The four methods.** `initialize` → `{ protocolVersion, capabilities: {
tools: {} }, serverInfo: { name, version } }`, the version NEGOTIATED
   (echo the client's `params.protocolVersion` when it is one of
   `SUPPORTED_PROTOCOL_VERSIONS`, else `MCP_PROTOCOL_VERSION`; a non-string
   requested version falls back). The list currently contains only
   `'2025-06-18'`: the package does not advertise `'2025-03-26'`, whose
   mandatory JSON-RPC batching this single-message implementation does not
   support. `ping` → `{}`. `tools/list` → `{ tools }`, each tool a
   `MCPToolDescriptor` (its `parameters` renamed to `inputSchema`,
   defaulting to `{ type: 'object' }`). `tools/call` → the executed
   tool's `MCPCallResult`.
5. **Tool errors are tool results, not protocol errors.** `tools/call` reads
   `params.name` (a string) + `params.arguments` (a record, default `{}`),
   narrowed via `@orkestrel/contract`'s guards (no `as`); a missing /
   non-string `name` → a `-32602` invalid-params error. Otherwise it runs
   `tools.execute({ id, name, arguments })` — and because the `ToolManager`
   (`@orkestrel/tool`) ALREADY isolates a thrown tool (and an unknown name)
   into a `success: false` result, the server adds NO try/catch: that branch's
   `error` maps to `{ content: [{ type: 'text', text: <error> }], isError: true }`;
   the `success: true` branch's `value` maps to
   `{ content: [{ type: 'text', text: JSON.stringify(value) }] }`.
6. **One modern seam, subscriptions included, and `-32601` for anything off it.**
   `server/discover`, `tools/list`, `tools/call`, and `subscriptions/listen` are registered on `server.methods` at
   construction and EVERY modern method is resolved from there — `add` under an
   existing name replaces it, so a consumer's override wins by ordinary
   registration rather than by a precedence rule, and there is no second
   dispatch path. An id-bearing request whose method resolves to `undefined`
   (modern) or falls off the fixed legacy switch resolves a
   `JSONRPC_METHOD_NOT_FOUND` error whose message names the method. The modern
   metadata checks (`-32602`, `-32022`) run BEFORE the seam is consulted, and
   the legacy branch never consults it at all. A modern `subscriptions/listen`
   requires `params.notifications`; the server acknowledges the exact intersection
   with its configured support, and that acknowledgement is the first message
   carrying this request's reserved subscription id. Every delivered notification
   carries the same stamp. Ending the event-driven producer closes gracefully with
   `{ resultType: 'complete', _meta: { 'io.modelcontextprotocol/subscriptionId': id,
… } }`. The request id is only stream identity: a later request does not supersede
   an earlier one. The legacy method remains absent and answers `-32601`.
7. **`handle` maps the boundary failures.** A `JSON.parse` throw (malformed
   JSON) → a serialized `-32700` (Parse error) response with a `null` id; a
   parsed value that is not a valid REQUEST (a response, or any non-message)
   → a serialized `-32600` (Invalid Request) response with a `null` id. The
   raw-string parse is the ONLY `try`/`catch`; the guards (`parseJSONRPCMessage`
   over `isJSONRPCMessage`) are total and never throw.
8. **Total wire guards.** `isJSONRPCRequest` / `isJSONRPCResponse` /
   `isJSONRPCMessage` / `isInitializeRequest` / `isSubscriptionFilter` are total functions over an
   already-parsed `unknown` — adversarial input returns `false`, never
   throws. A request accepts an absent `id` (a notification) but rejects a
   `null` id (valid only on a response); a response requires an `id` (string /
   number / `null`) and exactly one of `result` / `error`. `parseJSONRPCMessage`
   is sound with `isJSONRPCMessage` (a guard-valid input returned unchanged;
   every non-`undefined` output satisfies the guard).
9. **The CORE is provider-agnostic, no transport.** `src/core` imports ONLY
   `@orkestrel/emitter`, `@orkestrel/tool`, and `@orkestrel/contract` (plus,
   for the client's per-request deadline, `AbortSignal.timeout`) — never
   `@orkestrel/server`, `@orkestrel/router`, `@orkestrel/sse`, or
   `@orkestrel/websocket` — and carries no transport, no HTTP, and no model.
   Both the dispatch core (the server) AND the client live here,
   transport-abstract; every transport lives ONE layer out in `src/server`
   (clauses 12–20): the ingress transport pumps message bodies through
   `dispatch`, the egress transport drives a remote server, and the session /
   version HEADER names are reserved there, not in the core.
10. **Observable.** The `MCPServer` owns an `emitter` (`MCPServerEventMap`)
    and fires `request` (method, id-or-`null`, era) at the TOP of every `dispatch`,
    BEFORE the method runs; the emitter isolates a listener throw, routing it
    to its OWN `error` handler (the `error` option, surfaced as `(error,
event)`, NOT a domain event) — so a buggy observer can never corrupt a
    dispatch, and a throwing `error` handler neither escapes nor recurses.
11. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly
    the public methods of each behavioral interface — `MCPServerInterface`,
    `MCPClientInterface`, `ClientTransportInterface`, and `MCPSessionInterface`
    — exhaustive, both directions, and each implementing class (`MCPServer` /
    `MCPClient`; the SEVEN transports `HTTPClientTransport` /
    `WebSocketServerTransport` / `WebSocketClientTransport` /
    `StdioClientTransport` / `StdioServerTransport` (`src/server`) plus the
    browser face's own `HTTPClientTransport` / `WebSocketClientTransport`
    (`src/browser`), all seven implementing the one `ClientTransportInterface`;
    and `MCPSession`) exposes the same public methods, no more. The remaining
    exports add no behavioral interface with methods (the factories,
    `acceptsEventStream` / `readSessionHeader` /
    `readLastEventId` / `rejectUnknownSession` / `readEventStream` /
    `decodeEvent` / `upgradeRequestPath` / `extractLines` / `dispatchLines` /
    `createScopeMessageListener` are functions; the options interfaces / event
    maps / `EventStoreEntry` / `LineExtraction` are bags), so they contribute
    no `## Methods` row. `MessagePortTransport` (`src/browser`) is likewise
    excluded: it implements `MCPTransportInterface`, not
    `ClientTransportInterface`, and `MCPTransportInterface` itself is
    documented as a `## Surface` Types bag (its members are arrow-typed
    properties, `readonly send: (message) => …`, not method syntax) rather than
    a `## Methods` group — the SAME treatment `bindServer`/`bindClient`'s test
    doubles already give it, so `MessagePortTransport` (and
    `createScopeTransport`'s returned `ScopeTransportInterface`) add no new
    `## Methods` row either, consistent with that existing precedent.
12. **The HTTP transport route is stateless mechanism (`src/server`).**
    `createMCPRoutes(mcp, options?)` returns a SINGLE `POST {path}` route
    (`path` default `DEFAULT_MCP_PATH`). The handler is self-contained (its
    OWN JSON-parse `try`/`catch`) and draws a sharp line: a TRANSPORT-level
    failure — malformed JSON (`-32700`) or a parsed value that is not a
    JSON-RPC REQUEST (`-32600`, narrowed via `parseJSONRPCMessage` + `'method'
in request`, no `as`) — is HTTP **400** with a JSON-RPC error BODY (id
    `null`). A legacy DISPATCH result — success or in-band JSON-RPC error — is
    HTTP **200**. A modern result is **400** for `-32020` / `-32021` / `-32022`
    / `-32602`, **404** for `-32601`, and **200** otherwise; every notification
    is **202** with no body. Modern `MCP_PROTOCOL_VERSION_HEADER` and
    `MCP_METHOD_HEADER` values must equal the body; `MCP_NAME_HEADER` is required
    only for `tools/call`. A mismatch is **400** + `-32020` with no `data`.
    Headerless `initialize` is accepted; a live-session legacy request uses its
    pinned negotiated revision; every other headerless request is **400** +
    `-32020`. A request without `Origin` is allowed; every present serialized
    origin requires an exact consumer-supplied `origin.origins` entry or receives
    **403**. `origin.enabled: false` explicitly delegates validation to an upstream
    layer. When `streaming` is enabled (default `true`) and the client
    `Accept`s `text/event-stream` (`acceptsEventStream`), the 200 reply is one
    SSE `data:` event over `@orkestrel/server`'s `openStream` seam, then the
    stream ends, carrying `X-Accel-Buffering: no`; else a plain JSON body. A
    held-open dispatch result always uses that SSE seam: yields are written in
    order, the generator's returned response is written last, and the response
    ends after it. The pump awaits the async iterator and never polls.
    `createMCPRoutes` mints / reads NO
    session id. It is MECHANISM, not policy: auth / rate-limiting / sessions
    compose IN FRONT as ordinary middleware; origin policy is only the
    consumer-provided list.
13. **The CLIENT is the dual-era egress mirror (`src/core`).**
    `createMCPClient({ transport, identity?, capabilities?, version?, timeout?,
on? })` drives a REMOTE server over an injected `ClientTransportInterface`
    (transport-abstract, like the server). A pinned legacy `version` runs the
    legacy `initialize` handshake directly. Otherwise `connect()` first issues
    a modern `server/discover` carrying `_meta` with the offered revision,
    client capabilities, and client identity. It intersects the peer's
    `supportedVersions` with `SUPPORTED_PROTOCOL_VERSIONS` in local preference
    order and stores the newest match. A `-32022` reads `error.context.supported`
    and, when unpinned, retries discovery exactly once under a NEW monotonic id;
    the second failure is never retried. `-32601`, `-32600`, or an unrecognized HTTP 400
    send failure falls back to legacy `initialize`, except when modern
    `'2026-07-28'` is pinned. The selected era is cached for the instance's
    lifetime. A legacy result's absent, malformed, modern, or unsupported
    `protocolVersion` closes the transport and rejects; a valid legacy revision
    is stored before `notifications/initialized` is sent. Modern connect sends
    NO notification. The readonly `version` surface exposes the negotiated
    revision while connected and is `undefined` while disconnected. A parseable discovery
    response other than the two legacy fallback errors settles the modern era before result
    validation, so a malformed or unsupported result type surfaces instead of degrading.
    `discover()` exposes a validated modern discovery result,
    filtering unknown advertised revisions from its `MCPVersion` collection.
    `tools()` runs `tools/list` and wraps each descriptor as a
    local `ToolInterface` — `name` narrowed (`isString`), `inputSchema` mapped
    back to `parameters` (the inverse of clause 4's rename, no `as`),
    `execute` bound to `call(name, …)`. `call(name, args)` runs `tools/call`,
    concatenates the result's `text` content blocks, and — the inverse of
    clause 5's `buildCallResult` — THROWS an `Error` carrying the text when
    `isError === true`, else `JSON.parse`s the text (raw-string fallback;
    empty → `undefined`); so a remote tool failure throws locally and an
    agent's `ToolManager` isolates it into a `success: false` result exactly
    like a local throw. `disconnect()` rejects every pending request, clears
    negotiated revision, closes the transport, and fires `disconnect`
    (idempotent) without clearing the lifetime era cache.
14. **Client correlation + deadline + notifications.** Each request is
    tagged with a monotonic numeric `id`; a SINGLE transport `message`
    subscription resolves / rejects the matching pending request by `id`
    (an `error` response rejects with `MCPError`, a complete `result` resolves) —
    concurrent requests each route to their own pending. `MCPError`
    preserves the peer's human message, numeric `code`, and optional
    `error.data` as `context`; local disconnect and timeout failures
    remain plain `Error`s. An absent `resultType` and `'complete'` both mean a
    complete result; every other value rejects with `MCPError` using the message
    `MCP result type '<value>' is not supported`, so input-required, task, and
    unknown results can never be consumed as fabricated tool output. A message
    that is NOT a correlated response is
    a server NOTIFICATION, re-surfaced on the `notification` event. Every
    ordinary request races `AbortSignal.timeout(timeout)` (never a raw
    `setTimeout`; default `DEFAULT_MCP_REQUEST_TIMEOUT`): a server that
    never replies REJECTS the pending request (`timed out`) rather than
    hanging. The unresolved initial discovery probe is the exception: it is
    unbounded when `timeout` is omitted because the transport cannot distinguish
    an unbound channel from a silent peer; an explicitly supplied `timeout`
    enables its short legacy-fallback probe bound. A `send` write failure rejects
    its own pending request.
    Observable: the client owns an `emitter` (`MCPClientEventMap`) firing
    `connect` / `disconnect` / `notification` / `error`; the emitter
    isolates a listener throw, routing it to its `error` handler (the
    `error` option, NOT a domain event); `on(...)` is the convenience
    forward to `emitter.on`.
15. **The HTTP CLIENT transport drives a remote server over `fetch`
    (`src/server`).** `createHTTPClientTransport({ url, headers?, fetch?,
timeout? })` returns a `ClientTransportInterface` whose `send` POSTs one
    JSON-serialized message to `url` with `content-type:
application/json` and an `Accept` of BOTH `application/json` and
    `text/event-stream` (plus any `headers`), then decodes the reply and
    emits each carried `JSONRPCMessage` on the `message` event: an
    `application/json` body is narrowed via `parseJSONRPCMessage`; a
    `text/event-stream` body is decoded via `@orkestrel/sse`'s `SSEParser`
    (`readEventStream`); a `202` (a notification accepted) carries no body
    and emits nothing. It is TOTAL at the boundary: a non-message reply is
    dropped, never asserted; a `fetch` / decode failure surfaces on the
    `error` event rather than escaping `send`. `fetch` defaults to
    `globalThis.fetch` (injectable); when `timeout` is set, each `fetch` call
    passes `signal: AbortSignal.timeout(timeout)`. `start` / `close` hold no
    long-lived connection. It ECHOES the session (clause 18): an
    `mcp-session-id` response header, when a STATEFUL server sends one (on
    `initialize`), is captured into `session` and then sent as the
    `mcp-session-id` REQUEST header on every SUBSEQUENT request — so an
    `MCPClient` passes a stateful server's validation with NO caller wiring;
    before `initialize` returns an id, `session` is `undefined` and no header
    is sent (safe against a stateless server). It also recognizes a decoded
    result whose `result.protocolVersion` is a supported string, captures that
    negotiated value, and sends `MCP_PROTOCOL_VERSION_HEADER` on every SUBSEQUENT
    legacy request. The initialize POST itself carries no protocol header, and
    legacy requests never carry `Mcp-Method` or `Mcp-Name`. A modern request derives
    `MCP_PROTOCOL_VERSION_HEADER` and `MCP_METHOD_HEADER` directly from its `_meta`
    version and method, plus `MCP_NAME_HEADER` only for `tools/call`; no transport
    state or widened `send` contract is needed. Both captured
    headers are merged before `options.headers`, so a caller-supplied key wins.
16. **The WebSocket transport is the full-duplex ingress over the spine
    upgrade seam (`src/server`).** `createWebSocketServer(mcp, options?)`
    returns an `UpgradeHandler` (`@orkestrel/server`) to register with
    `server.upgrade(...)`; it composes `@orkestrel/websocket`'s RFC 6455
    wrapper over the spine's generic upgrade seam. It DECLINES (returns
    `false`) when the `Upgrade` header is not `websocket`, the request path
    (`upgradeRequestPath`) is not `options.path` (default `DEFAULT_MCP_PATH`),
    the `Sec-WebSocket-Key` is absent, or the `Sec-WebSocket-Version` is not
    `13`. Otherwise it CLAIMS (returns `true`): `createNodeWebSocket({
socket, key, head, protocol })` (SERVER mode → writes the `101` handshake
    echoing the `subprotocol`, default `MCP_WEBSOCKET_SUBPROTOCOL` `'mcp'`,
    and sends UNMASKED frames), wraps it in a `WebSocketServerTransport`, and
    PUMPS — each inbound `JSONRPCMessage` that `isJSONRPCRequest` runs
    through `mcp.dispatch`, a defined response written back as a frame (a
    notification → `dispatch` `undefined` → nothing sent); a non-request
    message is ignored; a `dispatch` / `send` fault surfaces on the
    transport's `error` event rather than escaping the async listener.
    `WebSocketServerTransport` REUSES `ClientTransportInterface` (`session`
    `undefined`, `start` arms the socket subscriptions, `send` writes ONE
    text frame per message, `close` closes the socket): inbound text frames
    are `JSON.parse`d (guarded) + narrowed via `parseJSONRPCMessage` onto
    `message`, a malformed / non-message frame surfaces on `error` and is
    DROPPED, and the socket's `close` bridges to the transport's `close`.
17. **The WebSocket CLIENT transport drives a remote server over an upgrade
    (`src/server`).** `createWebSocketClientTransport({ url, headers? })`
    returns a `ClientTransportInterface` — the WebSocket egress mirror of
    clause 16. `start()` (run by `client.connect()`) performs the RFC 6455
    client handshake: a `node:http`(`s`) `GET` carrying `Connection: Upgrade`
    / `Upgrade: websocket` / a random `Sec-WebSocket-Key` /
    `Sec-WebSocket-Version: 13` / `Sec-WebSocket-Protocol: mcp` (plus any
    `headers`), awaiting the client `'upgrade'` event and VALIDATING
    `Sec-WebSocket-Accept === computeWebSocketAccept(key)`
    (`@orkestrel/websocket`) — a mismatch / a non-`101` response / a request
    error REJECTS `start()` (the socket destroyed). On success it wraps the
    upgraded socket in `createNodeWebSocket({ socket, head })` (CLIENT mode —
    no key → frames MASKED) and bridges its frames as the client's `message`
    channel (decoded + narrowed via `parseJSONRPCMessage`). `send` writes ONE
    masked text frame per message; `close()` closes the socket + fires
    `close` (idempotent). `url` accepts `ws://` / `wss://` OR `http://` /
    `https://` (a `ws(s)` scheme is converted to `http(s)` for the underlying
    request; `wss` → TLS via `node:https`).
18. **Sessions are an opt-in native middleware on the HTTP transport
    (`src/server`).** `createMCPSession({ path?, ttl?, capacity?, clock?, origin? })`
    returns a `MiddlewareHandler<TState>` (`TState extends MCPSessionState`)
    that owns its own closure `Map<string, { session: MCPSession; touched:
number; version: MCPVersion }>` — NO dependency on `@orkestrel/middleware` and no shared
    session primitive; the store, mint, and validation are all native to
    this package. Compose it via `router.use(createMCPSession())` IN FRONT
    of a session-agnostic `createMCPRoutes(mcp)`; it OWNS its `path` (default
    `DEFAULT_MCP_PATH`, MUST match the route's) — a request to any other path
    passes straight through (`next()`). With a `ttl`, a session not touched
    within `ttl` ms is lazily evicted on the next access (no background
    timer). Session-owned verbs apply the same origin gate as the route, consuming the same
    `MCPOriginOptions` value; a rejected origin returns **403** before session lookup or minting,
    while `enabled: false` delegates both sites to an upstream validator. A
    modern-shaped POST passes straight through via `next()`, ignoring
    `Mcp-Session-Id`. Otherwise, for its `path`, it makes the legacy transport
    STATEFUL across the three verbs: a `POST` buffers `await request.text()` — resolves a session via
    `readSessionHeader`; a VALID id touches the entry and sets
    `context.state.session`; an ABSENT / unknown id whose (guarded) body
    parses to an `initialize` request (`isInitializeRequest`) MINTS a fresh
    `MCPSession` (`crypto.randomUUID()`, `capacity`), pins the negotiated legacy
    revision, and sets
    `context.state.session`; neither → `rejectUnknownSession()` (`404`). It
    then FORWARDS a fresh `Request` carrying the buffered text
    (`next(forwarded)`) — never the already-consumed original — so the route
    re-reads the same body, injects that pinned revision when a live-session POST
    is headerless, and stamps the response with `MCP_SESSION_HEADER`.
    A `GET {path}` resolves the session the same way (no mint) and opens the
    resumable stream (clause 19); an invalid / unknown id is the same `404`.
    A `DELETE {path}` resolves the session, deletes it from the store and
    answers `204`, or the same `404` when invalid / unknown. The WebSocket
    and stdio transports are inherently one session per connection, so this
    middleware does not apply to them.
19. **Resumable server→client push is the GET-SSE channel, folded into
    `MCPSession` (`src/server`).** Each `MCPSession` FOLDS IN its own bounded
    replay log — a plain in-memory `Map` + capacity + lazy-TTL eviction,
    PRIVATE to the entity — built with `createMCPSession`'s `capacity`
    (default `DEFAULT_MCP_SESSION_CAPACITY`) and a per-event
    `DEFAULT_MCP_SESSION_TTL`. `session.push(message)` APPENDS the message to
    the log under a MONOTONE base36 event id (RETURNED), evicting the OLDEST
    past `capacity` + any entry older than the per-event TTL, AND fans the
    message out to every `attach`ed open stream as `stream.write({ id, data:
JSON.stringify(message) })`. `session.replay(afterId)` returns every
    retained log entry STRICTLY AFTER `afterId` in append order — an UNKNOWN
    / evicted cursor replays NOTHING. The `createMCPSession` middleware
    serves the resumable `GET {path}`: it validates the `mcp-session-id`
    (the same **404** as clause 18 on a missing / unknown id), opens
    `openStream()` (`@orkestrel/server`), reads `Last-Event-ID`
    (`readLastEventId`) and REPLAYS `session.replay(lastEventId)` onto the
    stream FIRST, THEN `session.attach(stream)`, THEN detaches on the
    request's `AbortSignal` firing (or immediately if already aborted). The
    stream is long-lived — it is NEVER `end()`ed by the middleware.
20. **The stdio transport is newline-delimited JSON-RPC over process stdio
    (`src/server`).** `createStdioServer(mcp, options?)` wraps
    `options.input` (default `process.stdin`) / `options.output` (default
    `process.stdout`) in a `StdioServerTransport` and PUMPS: each inbound
    `JSONRPCMessage` that is a REQUEST runs through `mcp.dispatch`, a defined
    response written back as a newline-terminated line (a notification writes
    nothing); a non-request message is ignored; a `dispatch` / `send` fault
    surfaces on the transport's `error` event. `createStdioClientTransport(options)`
    spawns `options.command` via `node:child_process.spawn(command, args, {
env, stdio: ['pipe', 'pipe', 'inherit'] })` (an omitted `env` inherits
    `process.env`; a provided one REPLACES it entirely, `spawn` semantics);
    `send` writes `JSON.stringify(message) + '\n'` per message to the
    child's `stdin`; the child's `stdout` is read through the shared
    `extractLines` / `dispatchLines` helpers (also used by
    `StdioServerTransport`) to decode complete lines onto `message` (a
    malformed line emits `error`); the child's exit bridges to the
    transport's `close`. `close()` kills the child. Both stdio transports'
    `session` is always `undefined` (the process pipe carries no session
    concept).
21. **The browser transport carries the SAME `ClientTransportInterface`
    contract over native host APIs (`src/browser`).**
    `createWebSocketClientTransport({ url, protocols? })` returns a
    `ClientTransportInterface` whose `start()` opens `new WebSocket(url,
protocols)` and awaits the native `'open'` event (the RFC 6455 handshake
    is the host's concern; a connection failure — the native `'error'` event
    while not yet `OPEN` — REJECTS `start()`); `send` writes each message as
    ONE text frame once `OPEN`, QUEUING (in order) any message sent before —
    flushed the moment the socket opens; inbound text frames are `JSON.parse`d
    (guarded) + narrowed via `parseJSONRPCMessage` onto `message` (a
    non-text / non-JSON / non-message frame surfaces on `error` and is
    DROPPED, never thrown); `close()` closes the socket and fires `close`
    exactly once — a server-initiated close (the native `close` event) fires
    the SAME `close` exactly once too, guarded so the two never double-emit.
    `createHTTPClientTransport({ url, headers?, fetch?, timeout? })` returns a
    `ClientTransportInterface` whose `send` POSTs to `url` over the injectable
    `fetch` (default `globalThis.fetch`) with the SAME `content-type` /
    `Accept` / session and era-aware header contract as the Node face's HTTP
    client (clause 15): modern requests carry `MCP_PROTOCOL_VERSION_HEADER`
    and `MCP_METHOD_HEADER` from the body, plus `MCP_NAME_HEADER` only for
    `tools/call`; legacy requests carry only the captured negotiated protocol.
    An `application/json` reply is narrowed via `parseJSONRPCMessage`, a
    `text/event-stream` reply is decoded via the browser face's OWN
    `readEventStream` (`@orkestrel/sse`, the same decode shape as
    `src/server`'s), a `202` emits nothing, and any `fetch` / decode failure
    surfaces on `error` rather than escaping `send` or hanging. Both browser
    transports are type-checked DOM-free (`lib: ["ESNext", "WebWorker"]`,
    proven by `check:src:browser`), so the same code runs in a page, a Web
    Worker, or a Service Worker.
22. **`MessagePortTransport` is SYMMETRIC; `serveMCP` unifies dedicated-worker
    and Service-Worker wiring with no upfront shape flag (`src/browser`).**
    `createMessagePortTransport({ port })` returns an `MCPTransportInterface`
    (not a `ClientTransportInterface` — the SAME class works as either a
    server or a client carrier depending on whether it is handed to
    `bindServer` or `bindClient`/`createDuplexClientTransport`). `port.start()`
    runs at CONSTRUCTION (there is no separate open step on the port contract
    for the caller to hook one into); inbound is STRING-ONLY — a non-string
    `event.data` is dropped, never forwarded (the port contract carries no
    `error` channel to surface it on); `messageerror` is IGNORED, not routed
    to `closed` (one bad frame is not a dead channel); `close()` closes the
    port and fires the registered `closed` handler EXACTLY ONCE, idempotently
    — there is no native "peer closed" signal for a `MessagePort`, so `closed`
    fires ONLY from this transport's own `close()`. `listen`/`closed` are
    single-handler-replace, per the port contract (clause 1's sketch).
    `serveMCP(options)` is `serveMCPScope(globalThis, options)`; `serveMCPScope`
    (the exported, scope-parameterized core) creates an `MCPServer` (`name`/
    `version` defaulting to `DEFAULT_MCP_SERVER_NAME`/`DEFAULT_MCP_SERVER_VERSION`
    when omitted), `bindServer`s it EAGERLY over a `createScopeTransport(scope)`
    (the implicit, portless channel — bound once, for the whole lifetime of
    the returned dispose, so a dedicated worker's very first portless message
    needs no first-use setup), and registers ONE `scope.addEventListener(
'message', …)` listener built by `createScopeMessageListener`. That ONE
    listener handles BOTH shapes uniformly, per event, with no upfront
    detection flag: `event.ports.length > 0` spawns a FRESH
    `createMessagePortTransport` + `bindServer` for THAT port (tracked for
    teardown) — a Service Worker's normal per-client channel, and ALSO a
    dedicated-worker-shaped scope's cross-case if it happens to receive a
    port-bearing event; an event with NO ports and a STRING `data` delivers
    onto the implicit scope channel; any other event is dropped. The returned
    dispose is IDEMPOTENT: it removes the scope listener, unbinds the implicit
    channel, and — for every accepted port — unbinds AND closes it.

## Patterns

### Expose a tool registry over MCP

The headline use: turn a live `ToolManagerInterface` (`@orkestrel/tool`) into
a server an MCP client drives over a transport.

```ts
import { createMCPServer } from '@orkestrel/mcp'
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(
	createTool({
		name: 'search',
		description: 'Search the docs',
		execute: (a) => find(String(a.query)),
	}),
)

const server = createMCPServer({ name: 'docs', version: '1.0.0', tools })

// A transport reads a framed message string and writes the reply:
for await (const message of transport) {
	const reply = await server.handle(message)
	if (reply !== undefined) await transport.send(reply) // a notification has no reply
}
```

### Drive the typed core directly

When the request is already parsed (a test, an in-process bridge), call
`dispatch` and skip the string boundary.

```ts
const response = await server.dispatch({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
response?.result // { tools: [ … ] }

const notification = await server.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })
notification // undefined — a notification yields no response
```

### Mount the HTTP transport with sessions

Compose the opt-in session middleware IN FRONT of the session-agnostic route
for stateful resumable streaming; omit it for the byte-identical stateless
default.

```ts
import { createMCPServer } from '@orkestrel/mcp'
import type { MCPOriginOptions } from '@orkestrel/mcp/server'
import { createMCPRoutes, createMCPSession } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
const origin: MCPOriginOptions = { origins: ['https://app.example'] }
router.use(createMCPSession({ ttl: 60_000, origin })) // stateful: mint + validate + resumable GET / DELETE
router.add(createMCPRoutes(mcp, { origin })) // both enforcement sites consume the same policy
```

### Drive a remote server over HTTP, WebSocket, or stdio

The SAME `MCPClient` correlation, deadline, and tool-mapping ride over any of
the three transports unchanged — only the injected `ClientTransportInterface`
differs.

```ts
import { createMCPClient } from '@orkestrel/mcp'
import {
	createHTTPClientTransport,
	createWebSocketClientTransport,
	createStdioClientTransport,
} from '@orkestrel/mcp/server'

const http = createMCPClient({
	transport: createHTTPClientTransport({ url: 'http://localhost:3000/mcp' }),
})
const ws = createMCPClient({
	transport: createWebSocketClientTransport({ url: 'ws://localhost:3000/mcp' }),
})
const stdio = createMCPClient({
	transport: createStdioClientTransport({ command: 'node', args: ['./server.js'] }),
})

await http.connect()
await ws.connect()
await stdio.connect()
```

### Build response envelopes and validate wire messages directly

The lower-level building blocks `dispatch` / `handle` compose internally —
useful directly in a test or a custom transport.

```ts
import {
	buildCallResult,
	buildInitializeResult,
	buildJSONRPCError,
	buildJSONRPCResult,
	buildToolDescriptors,
	isJSONRPCMessage,
	isJSONRPCResponse,
	isMCPError,
	MCPError,
} from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
const descriptors = buildToolDescriptors(tools) // tools/list payload
const result = buildCallResult({ id: '1', name: 'example', success: true, value: 7 })
// { content: [{ type: 'text', text: '7' }] }
const init = buildInitializeResult('docs', '1.0.0', '2025-06-18')

const ok = buildJSONRPCResult(1, { tools: descriptors })
const failed = buildJSONRPCError(1, -32601, 'Method not found')
isJSONRPCMessage(ok) // true
isJSONRPCResponse(failed) // true

const remote = new MCPError('Method not found', -32601, { method: 'missing' })
isMCPError(remote) // true
remote.code // -32601
remote.context // { method: 'missing' }
```

### Route a request by era and build a modern result

The 2026-07-28 era is selected structurally, per request, and never stored. A request is
modern exactly when its `params._meta` carries the reserved protocol-version **key** — presence
routes, the value's validity is a separate question answered afterwards, so a malformed version
still reaches the modern branch and earns its `-32602` there instead of being mistaken for a
legacy handshake.

```ts
import {
	buildDiscoverResult,
	buildModernResult,
	inferEra,
	inferVersion,
	isMCPVersion,
	isModernRequest,
	parseRequestContext,
} from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const request = {
	jsonrpc: '2.0' as const,
	id: 1,
	method: 'tools/list',
	params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', capabilities: {} } },
}

isModernRequest(request) // true — the key is present
const context = parseRequestContext(request) // { version, capabilities, identity? }
context?.version // '2026-07-28'

isMCPVersion('2026-07-28') // true
isMCPVersion('2024-11-05') // false — not a supported revision
inferEra('2026-07-28') // 'modern'
inferEra('2025-11-25') // 'legacy'

// Selection walks the supported revisions newest-first, so the peer's own ordering
// never decides the outcome — this is how `connect` picks a revision from a discovery.
inferVersion(['2025-11-25', '2026-07-28']) // '2026-07-28' — newest in common
inferVersion(['2024-11-05']) // undefined — nothing in common

// `tools/list` is a cacheable result and carries both `ttlMs` and `cacheScope`;
// `tools/call` carries neither, because only the former is a `CacheableResult`.
const listed = buildModernResult({ tools: [] }, { cache: true })
const discovered = buildDiscoverResult({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
discovered.supportedVersions // the revisions this server negotiates
```

The same era decision has two consequences on the server face: which legacy revision an
`initialize` handshake negotiates, and which HTTP status the dispatch outcome leaves on. A
legacy envelope keeps a uniform `200` and reports in-band; a modern one maps to a real status.

```ts
import { inferLegacyVersion, inferStatus } from '@orkestrel/mcp/server'

const handshake = {
	jsonrpc: '2.0' as const,
	id: 2,
	method: 'initialize',
	params: { protocolVersion: '2025-06-18' },
}
inferLegacyVersion(handshake) // '2025-06-18' — a supported requested revision is pinned exactly
inferLegacyVersion({ ...handshake, params: {} }) // '2025-11-25' — the newest legacy revision

const missing = {
	jsonrpc: '2.0' as const,
	id: 1,
	error: { code: -32601, message: 'Method not found' },
}
inferStatus(undefined, 'modern') // 202 — a notification has no response to carry
inferStatus(missing, 'legacy') // 200 — the legacy envelope carries the error in-band
inferStatus(missing, 'modern') // 404
inferStatus({ ...missing, error: { code: -32602, message: 'Invalid params' } }, 'modern') // 400
inferStatus({ jsonrpc: '2.0', id: 1, result: { tools: [] } }, 'modern') // 200
```

### Read HTTP request headers and decode SSE bodies directly

The HTTP transport's own building blocks — the header readers, the two request
gates, and the SSE decoders — useful in a custom route or test harness.

```ts
import {
	acceptsEventStream,
	allowsOrigin,
	createMCPPostHandler,
	decodeEvent,
	matchesModernHeaders,
	readEventStream,
	readLastEventId,
	readSessionHeader,
	rejectUnknownSession,
	upgradeRequestPath,
} from '@orkestrel/mcp/server'

const request = new Request('http://localhost/mcp', { headers: { accept: 'text/event-stream' } })
acceptsEventStream(request) // true
createMCPPostHandler(mcp, { streaming: true }) // the same stateless POST handler createMCPRoutes mounts
readSessionHeader(request) // undefined — no mcp-session-id header
readLastEventId(request) // undefined — no Last-Event-ID header
rejectUnknownSession() // a 404 JSON-RPC error Response

const posted = new Request('http://localhost/mcp', {
	method: 'POST',
	headers: {
		origin: 'https://app.example',
		'mcp-protocol-version': '2026-07-28',
		'mcp-method': 'tools/call',
		'mcp-name': 'search',
	},
})

// The gate matches the allowlist only, never the request's own URL, whose origin
// derives from the caller-controlled Host header.
const policy = { origins: ['https://app.example'] }
allowsOrigin(request, policy) // true — no Origin header, so there is nothing to match
allowsOrigin(posted, policy) // true — the exact serialized origin is listed
allowsOrigin(posted) // false — with no allowlist a present origin is never trusted
allowsOrigin(posted, { enabled: false }) // true — an upstream layer owns the check

const call = {
	jsonrpc: '2.0' as const,
	id: 1,
	method: 'tools/call',
	params: { name: 'search', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
}
matchesModernHeaders(posted, call) // true — protocol, method, and the tools/call name agree
matchesModernHeaders(posted, { ...call, method: 'tools/list' }) // false — Mcp-Method disagrees

const reply = await fetch('http://localhost:3000/mcp')
const messages = await readEventStream(reply)
decodeEvent('{"jsonrpc":"2.0","id":1,"result":{}}')
upgradeRequestPath(rawUpgradeRequest) // the incoming upgrade request's pathname
```

### Frame newline-delimited JSON-RPC over stdio directly

The shared line-framing step both stdio transports read their inbound
messages through.

```ts
import { dispatchLines, extractLines } from '@orkestrel/mcp/server'
import { Emitter } from '@orkestrel/emitter'

const emitter = new Emitter()
const { lines, remainder } = extractLines('', '{"jsonrpc":"2.0","method":"ping"}\n{"jsonrpc"')
dispatchLines(emitter, lines) // emits `message` for the complete line above
```

### Serve MCP from a Web Worker

`serveMCP` is the drop-in entry for a REAL Web Worker's `main.ts` — boot an
`MCPServer` over the worker's own implicit `postMessage` channel (a dedicated
worker) or over each connecting client's `MessagePort` (a Service Worker),
with no upfront shape flag:

```ts
// worker's entry module:
import { serveMCP } from '@orkestrel/mcp/browser'
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
const dispose = serveMCP({ tools, name: 'worker-mcp', version: '1.0.0' })
// ... on teardown:
dispose()
```

> **Trust boundary — mechanism, not policy.** `serveMCP` exposes the ENTIRE
> `tools` registry to every client that delivers a port-bearing message, with NO
> built-in origin or identity check. In a Service Worker every same-origin
> context the SW controls (any window, worker, or iframe) can
> `controller.postMessage(msg, [port])` and receive a fully-bound server with
> complete tool-call access. Gating is the embedding application's responsibility;
> compose a guard in front using the `accept` option. Prefer a handshake token in
> `event.data` — for same-origin worker/MessagePort messages `event.origin` is
> frequently the empty string, making origin allow-listing unreliable:
>
> ```ts
> serveMCP({
> 	tools,
> 	// Prefer token-in-data — event.origin is empty for same-origin worker messages.
> 	accept: (event) => event.data === 'my-secret-token',
> })
> ```
>
> ⚠️ **`accept` gates only port-bearing events.** A portless
> `controller.postMessage('<json-rpc>')` delivers its string to the implicit
> scope channel — **the tool executes** (blind side-effecting ingress) and the
> reply is silently dropped (`ServiceWorkerGlobalScope` has no `self.postMessage`).
> If `accept` is your sole guard in a Service Worker, ensure all clients connect
> through transferred ports, or restrict the exposed registry to side-effect-free
> tools, or validate a token inside the tools themselves.

> **Lifetime / per-client binding accumulation.** Each accepted port-bearing
> event creates a fresh binding that lives for the scope's lifetime — there is
> no per-client reaping, because `MessagePort` gives no "peer closed" signal.
> `serveMCP` suits bounded, long-lived client sets. Embedders with high client
> churn must manage lifecycle themselves (dispose and re-serve, or wrap the
> scope in their own reaping layer).

`serveMCPScope` is the SAME wiring parameterized over an explicit scope — this
runnable fence drives it with a minimal `ServeMCPScopeInterface` (the exact
shape a real worker's `self` satisfies) plus a real `new MessageChannel()`
standing in for a Service-Worker-shaped client connection, so `tools/list`
genuinely round-trips with no worker harness:

```ts
import { serveMCPScope } from '@orkestrel/mcp/browser'
import { createTool, createToolManager } from '@orkestrel/tool'

const listeners = new Set<(event: MessageEvent) => void>()
const scope = {
	postMessage() {},
	addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
		listeners.add(listener),
	removeEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
		listeners.delete(listener),
}

const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
const dispose = serveMCPScope(scope, { tools, name: 'worker-mcp', version: '1.0.0' })

const { port1, port2 } = new MessageChannel()
const reply = new Promise((resolve) =>
	port2.addEventListener('message', (event) => resolve(event.data)),
)
port2.start()
for (const listener of listeners)
	listener(new MessageEvent('message', { data: null, ports: [port1] }))
port2.postMessage('{"jsonrpc":"2.0","method":"tools/list","id":1}')

log(await reply) // '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"add","inputSchema":{"type":"object"}}]}}'
dispose() // unbinds every binding, closes every accepted MessagePort
```
