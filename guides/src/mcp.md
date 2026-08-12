# MCP

> The [Model Context Protocol](https://modelcontextprotocol.io) layer — a typed
> JSON-RPC 2.0 client/server pair with pluggable HTTP, WebSocket, stdio, and
> browser transports.
>
> **Ingress:** `createMCPServer` wraps a live `ToolManagerInterface`
> (`@orkestrel/tool`) as an MCP server any MCP client can drive, and projects two
> further host-owned registries — `resources` and `prompts` — plus a `completion`
> provider, each over a port this package defines and does not implement. **Egress:**
> `createMCPClient` drives a _remote_ MCP server and surfaces its tools as local
> `ToolInterface`s an agent can call as if they were its own. Requests are
> dispatched by structural wire era — a modern request resolves from a registrable
> method seam carrying the built-in `server/discover`, `tools/list`, `tools/call`,
> and `subscriptions/listen`, plus `resources/*`, `prompts/*`, and
> `completion/complete` for each port a consumer configured. The two dated revisions
> are an OPTIONAL decorator over that one engine — `createMCPLegacy(mcp)` translates a
> fixed `initialize` / `ping` / `tools/list` / `tools/call` set onto it and the server
> itself holds no era branch. See [Protocol](#protocol),
> [Compose or remove the legacy protocol layer](#compose-or-remove-the-legacy-protocol-layer), and
> [Project a host-owned resource, prompt, and completion registry](#project-a-host-owned-resource-prompt-and-completion-registry).
>
> **The dispatch core is transport-agnostic and provider-agnostic.** `MCPServer`
> and `MCPClient` live in [`src/core`](../../src/core) and import only siblings —
> JSON-RPC types, `@orkestrel/tool`'s tool registry, `@orkestrel/emitter`'s
> observable surface, `@orkestrel/contract`'s guards. No HTTP, no WebSocket, no
> stdio, and no `as`: every value off the wire is narrowed by a total guard. The
> server has two entry points — `dispatch` runs an already-parsed
> `JSONRPCInvocation`, resolving a `JSONRPCResponse` for a `JSONRPCRequest` and
> `undefined` for a `JSONRPCNotification` (its overloads say exactly that, so
> neither caller handles the other's answer), and `handle(message)` is the string
> boundary that wraps it with `JSON.parse` / `JSON.stringify` plus the parse
> (`-32700`) and invalid-request (`-32600`) mapping, each of whose envelopes OMITS
> the `id` it could not read. The client mirrors it: `connect` negotiates the era once, `tools()`
> exposes the remote tools as local `ToolInterface`s, and `call` runs one — a
> remote failure throws locally, so an agent's `ToolManager` isolates it exactly
> like a local throw. A remote JSON-RPC error rejects with `MCPError`, preserving
> its numeric `code` and optional `error.data` as `context`.
>
> **The wire lives ONE layer out.** [`src/server`](../../src/server) carries the
> three Node transports and [`src/browser`](../../src/browser) the browser face.
> Each is a matched ingress/egress pair speaking the same `MCPServerInterface` /
> `MCPClientTransportInterface`; only the framing differs:
>
> - **Streamable HTTP** — `createMCPRoutes` mounts a server as `POST {path}` (JSON
>   or SSE per the client's `Accept`, via `@orkestrel/server`'s `openStream`); the
>   opt-in `createMCPSession` middleware adds native stateful sessions and a
>   resumable server→client SSE channel. `createHTTPClientTransport` is the
>   injectable-`fetch` egress.
> - **WebSocket** — `createWebSocketServer` claims an upgrade on
>   `@orkestrel/server`'s upgrade seam, composing `@orkestrel/websocket`'s RFC 6455
>   wrapper for full duplex over one persistent connection.
>   `createWebSocketClientTransport` is the `node:http(s)`-upgrade egress.
> - **stdio** — `createStdioServer` pumps newline-delimited JSON-RPC over a
>   process's `stdin`/`stdout` (or injected streams); `createStdioClientTransport`
>   spawns a child process and drives the same protocol over its piped stdio.
> - **browser** — the page / Web Worker / Service Worker face: the same two client
>   transports over the native `WebSocket` and `fetch` globals, plus the symmetric
>   `MessagePort` carrier and the `serveMCP` worker bootstrap.
>
> **Every transport is mechanism, not policy.** Auth, invocation rate limiting, and
> body-size guards compose IN FRONT as ordinary `@orkestrel/server` middleware.
> HTTP ingress supplies only the protocol-required origin gate, on by default: a
> request without `Origin` passes; a canonical `localhost`, `[::1]`, or `127.0.0.0/8`
> literal origin passes; every other present origin must occur in the shared
> `origin.origins` list; and a deployment that validates upstream delegates with
> `origin.enabled: false`. What this package deliberately does not build is listed
> under [Declared non-goals](#declared-non-goals); the obligations it does not meet
> are under [Declared conformance gaps](#declared-conformance-gaps).
>
> **Observable.** The `MCPServer` owns an `emitter` firing `request` per dispatch;
> the `MCPClient` owns one firing `connect` / `disconnect` / `notification` /
> `error`; every transport owns one firing `message` / `close` / `error`.

## Protocol

The layer speaks three revisions across two wire **eras**, on one endpoint, with no
era flag anywhere in the API. Era is the shape of the wire; version is the revision
it names.

| Revision     | Era    | How a request announces it                                                                |
| ------------ | ------ | ----------------------------------------------------------------------------------------- |
| `2026-07-28` | modern | Per-request `_meta` carrying the reserved protocol-version key. No handshake, no session. |
| `2025-11-25` | legacy | The `initialize` handshake. `MCP_PROTOCOL_VERSION` — the revision this server offers.     |
| `2025-06-18` | legacy | The `initialize` handshake. `MCP_LEGACY_VERSION` — the older anchor a client may pin.     |

`SUPPORTED_PROTOCOL_VERSIONS` is exactly that list, frozen and newest-first: it is
both the client's preference order and the `server/discover` advertisement. Two
older revisions are deliberately absent, and their absence is this package's
decision rather than the ecosystem's — see [Declared non-goals](#declared-non-goals).

**The era discriminator is KEY PRESENCE.** A request is modern **iff** the key
`params._meta['io.modelcontextprotocol/protocolVersion']` (`MCP_META_VERSION`) is
present — the key itself, not its value and not its type. **Presence routes;
validity answers.** The two steps are separate on purpose. A legacy `2025-06-18`
request may legally carry `_meta.progressToken`, so keying on "`_meta` exists" would
misclassify it; and requiring a _string_ value would send a modern request holding a
malformed version down the legacy branch, to be answered as a handshake, when what it
is owed is `-32602`. So `isModernRequest` fixes the era irrevocably, and
`parseRequestContext` then decides whether the modern metadata is well formed. A
request cannot escape the modern branch by carrying a bad version — only by carrying
no version key at all.

That validity step checks the whole metadata object as finite JSON and applies the dated
key grammar, then validates the required client-capability declaration and optional complete
client identity. Capability sets stay open, but every top-level capability value is a JSON
object; known nested fields retain their dated shapes, extension identifiers require a prefix,
and a nonempty `elicitation` declaration must name `form` or `url`. The deprecated canonical
`io.modelcontextprotocol/logLevel` accepts only the eight dated logging literals, and
`progressToken` is a string or finite integer. Identity is optional, self-asserted context—not
authentication input.

**Wire names are the wire's, verbatim.** A type that models a message on the wire
carries the protocol's own field names: `jsonrpc`, `_meta`, `resultType`, `ttlMs`,
`cacheScope`, `supportedVersions`, `inputSchema`, `isError`, `structuredContent`,
`inputRequests`, `requestState`. Everywhere the library speaks for itself the naming
laws bind normally: `identity`, `instructions`, `cache.ttl`, `limit.message`,
`version`, `discover()`, `era`. One rule, stated once, so neither half has to be
argued field by field.

**HTTP headers are scoped by method.** A modern POST carries `MCP-Protocol-Version`
equal to its `_meta` version and `Mcp-Method` equal to its body method. `Mcp-Name` is
required on `tools/call` alone, where it must equal `params.name`, and MUST NOT be
required on `server/discover` or `tools/list` — neither carries anything to derive a
name from. The first missing or mismatched field is named in the refusal, together with
the server-derived expected value; the client-supplied header value is never echoed. The
result remains HTTP `400` + `-32020`, with no `data`.

Use the client and HTTP transport together and none of that wire anatomy reaches the
call site — the transport derives all reserved metadata and headers:

```ts
import { createMCPClient } from '@orkestrel/mcp'
import { createHTTPClientTransport } from '@orkestrel/mcp/server'

const transport = createHTTPClientTransport({ url: 'https://mcp.example/rpc' })
const client = createMCPClient({ transport })
```

The equivalent raw modern `tools/call` carries all three reserved request metadata keys
and their three HTTP projections side by side:

```ts
const body = {
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: {
		name: 'search',
		arguments: { query: 'header anatomy' },
		_meta: {
			'io.modelcontextprotocol/protocolVersion': '2026-07-28',
			'io.modelcontextprotocol/clientCapabilities': {},
			'io.modelcontextprotocol/clientInfo': { name: 'raw-client', version: '1.0.0' },
		},
	},
}

await fetch('https://mcp.example/rpc', {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
		'MCP-Protocol-Version': '2026-07-28',
		'Mcp-Method': 'tools/call',
		'Mcp-Name': 'search',
	},
	body: JSON.stringify(body),
})
```

`Mcp-Name` applies only to `tools/call`; omit it for `server/discover` and
`tools/list`. The reserved client capability and identity metadata remain in `_meta` and
have no separate standard headers.

**A headerless legacy POST has exactly three cases.** The library infers no revision
from an absent header. Defaulting one is licensed only for a server that still serves
pre-`2025-06-18` clients, and this package does not:

- `initialize` — legitimately headerless; nothing is negotiated yet. Accepted.
- A post-`initialize` legacy request on a **live session** — accepted, under the
  revision pinned at that session's `initialize`. That is a negotiated fact, not a
  default.
- Anything else — nothing identifies the revision, so HTTP `400` + `-32020`.

A header naming an unsupported revision is a separate failure: HTTP `400` + `-32022`,
carrying `{ supported, requested }`.

**Status is per era.** A legacy dispatch result keeps a uniform HTTP `200` and reports
its errors in band, byte-identically to what a `2025-06-18` client already expects. A
modern result maps to real statuses: `202` for a notification, `400` for `-32020` /
`-32021` / `-32022` / `-32602`, `404` for `-32601`, and `200` otherwise. A
transport-level failure — malformed JSON or a body that is not a JSON-RPC request — is
`400` under both eras, since no era was ever established. See
[Route a request by era and build a modern result](#route-a-request-by-era-and-build-a-modern-result)
for the two inferers this rides on.

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
// out → '…"result":{"content":[{"type":"text","text":"7"}],"structuredContent":7}}'
```

`dispatch` is the typed core; `handle` wraps it with the `JSON.parse` ↔
`JSON.stringify` string boundary and the parse / invalid-request error
mapping. The configured message-byte limit is checked before `JSON.parse`, so
an oversized valid document receives `-32700` without first allocating its parsed
graph. A call with NO `id` is a **notification** — a type of its own, handled
(the `request` event still fires) but yielding NO response (`dispatch` resolves
`undefined`, `handle` returns `undefined`), whatever its method. Both error
envelopes OMIT the `id` they could not read; a `null` `id` never reaches the
wire. Tool errors
are NOT protocol errors: the `ToolManager` (`@orkestrel/tool`) isolates a
thrown tool into a `success: false` result, which `tools/call` maps to an
`isError: true` tool result carrying its `error` text — so the server wraps
no tool-domain failure as a protocol error. A rejected execution provider or
malformed runtime result instead becomes a detail-free `-32603` response, and the
value that was caught is reported on the server's `error` event — the one place it
is legible, and never the wire.

That is the whole of the common case. The sections below add one capability at a
time — the envelope arms, the method seam, the resource / prompt / completion
ports and the adapters that fit an existing registry behind one, subscriptions,
elicitation, input bounds, the duplex port, and the removable legacy layer — then
the reference tables for the core, then one section per transport.

### Narrow a message to its JSON-RPC arm

A JSON-RPC message is two exclusive splits, and the types make both of them
unrepresentable to get wrong. An INVOCATION is a **request** — a `method` call
carrying the `id` that correlates it with its answer — or a **notification**, the
same call with NO `id`, answered by nothing. A RESPONSE is a **result** arm or an
**error** arm, never both. Each guard is total over an already-parsed `unknown`,
and each pair is mutually exclusive on every input, so a positive answer names
exactly one arm.

**An `id` is present or it is not there at all.** `null` is not an id anywhere in
this layer — not on a request, not on a response, not on the wire. The error arm
is the ONE place an `id` may be absent, and absence there means OMITTED: MCP
overrides JSON-RPC 2.0 §5, so a peer that could not read the failed request's id
receives an envelope with no `id` member. `isJSONRPCId` rejects `null` for the
same reason.

```ts
import {
	buildJSONRPCError,
	buildMethodOptions,
	isJSONRPCErrorResponse,
	isJSONRPCId,
	isJSONRPCInvocation,
	isJSONRPCNotification,
	isJSONRPCRequest,
	isJSONRPCResultResponse,
	isMCPLegacyResult,
	isMCPResult,
} from '@orkestrel/mcp'

isJSONRPCId(1) // true
isJSONRPCId('') // true — an empty string is a legal id
isJSONRPCId(null) // false — MCP omits an unreadable id rather than nulling it

const call = { jsonrpc: '2.0', method: 'ping', id: 1 }
const signal = { jsonrpc: '2.0', method: 'notifications/initialized' }
isJSONRPCRequest(call) // true
isJSONRPCNotification(call) // false — it carries an id
isJSONRPCNotification(signal) // true
isJSONRPCInvocation(signal) // true — the union of the two arms

const answer = { jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } }
isJSONRPCResultResponse(answer) // true
isJSONRPCResultResponse({ jsonrpc: '2.0', id: 1, result: 5 }) // false — a result is an object
isMCPResult(answer.result) // true — a modern result always carries `resultType`
isMCPLegacyResult({ protocolVersion: '2025-11-25' }) // true — the legacy arm never does

const anonymous = buildJSONRPCError(undefined, -32700, 'Parse error')
Object.hasOwn(anonymous, 'id') // false — the member is ABSENT, not null
isJSONRPCErrorResponse(anonymous) // true

// The resolved options every dispatched method receives. The signal is the request's
// LIFETIME: dispatch composes the caller's signal, when there is one, with the one it
// aborts as soon as the answer is finished.
const lifetime = new AbortController()
buildMethodOptions({}, lifetime.signal).signal.aborted // false — until the answer ends
```

`MCPResult` is OPEN — it requires a string `resultType` and leaves the rest of
the object alone, because the dated schema keeps issuing new discriminators
(`task` beside `complete` and `input_required`). The concrete results stay
CLOSED and keep their literal, so a caller that knows which method it called
still narrows through that result's own guard. `MCPLegacyResult` is the disjoint
arm: the legacy revision has no discriminator concept, so `resultType` is
FORBIDDEN there, and the two are unassignable in both directions.

### Register a modern method on the seam

The modern branch answers from ONE registry, `server.methods`. The four
built-in methods are registered on it at construction — plus the three
`tasks/*` methods when the draft Tasks extension is configured — so a method
added later is not a special case. It is simply the next registration,
dispatched by the same lookup, and a name with no handler still answers
`-32601`:

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
	buildJSONRPCResult(request.id, { probed: true }),
)
// the SAME method now answers; `add` under an existing name replaces it, which is
// how a consumer overrides a built-in — no precedence rule to remember.
```

The seam carries the **request arm alone**, so a handler narrows nothing:
`request.id` is always a real correlation value — never `null`, never absent —
and a handler is never invoked for a notification, because dispatch
short-circuits every notification BEFORE the registry is read. Nothing answers a
notification, and now nothing has to say so.

Answering is not optional either. `MCPMethodHandler` returns a
`JSONRPCResponse` or an `MCPStream` and nothing else, because a handler that
resolved `undefined` for a request would contradict `dispatch`'s own overloads
and leave the caller waiting to its deadline. The registry is open, so a handler
that was never typechecked against the seam can still arrive; dispatch CONTAINS
that as `-32603` plus one `error` event rather than passing the absence on.

A handler also receives an `MCPMethodOptions` bag — the RESOLVED mirror of the
`MCPDispatchOptions` a caller passes. Its `signal` aborts when the bound
transport can observe that the caller's request has ended, and it is REQUIRED
here even though a caller may supply none: dispatch resolves one at the single
ingress, so no handler has to case on absence. Its optional `caller` is
consumer-asserted context carried opaquely from the dispatch site. Both
`dispatch` and `handle` take the caller-facing bag as an OPTIONAL second
argument:

```ts
server.methods.add('demo/slow', async (request, options) => {
	options.signal.addEventListener('abort', () => release())
	return buildJSONRPCResult(request.id, {})
})

const controller = new AbortController()
await server.dispatch({ jsonrpc: '2.0', method: 'demo/slow', id: 1 }, { signal: controller.signal })
```

`caller` is **ASSERTED, NEVER VERIFIED**. Sessions mint transport identity, not
caller identity; nothing in MCP authenticates this value, and this package never
inspects, validates, or serializes it. Narrow it with your own total guard and
treat absence as unauthenticated. It remains `unknown`, rather than a threaded
generic that would falsely promise protocol verification.

A handler that must HOLD the request open returns an `MCPStream` instead of
a response: each `yield` is a `JSONRPCNotification`, and the generator's
`return` value is the terminating response — closure is a result, not an
out-of-band event, so consuming a stream ends exactly where consuming a
unary response ends. The yield type FORBIDS an `id`, so a producer cannot put
a call the peer is expected to answer onto a stream that has no way to carry
the answer back — that is a type error at the `yield`, not a runtime rule.
`dispatch` surfaces the stream as a second return arm and `handle` mirrors it
as its serialized form, which `bindServer` pumps onto the transport.

**What leaves `dispatch` is always CONTROLLED.** A producer publishes a plain
`MCPStream`; dispatch is the one wrapping seam, so the caller receives an
`MCPStreamControllerInterface` and `handle` an `MCPTextStreamControllerInterface`. The
difference is who decides when the exchange ends. A native async generator QUEUES
`return()` and `throw()` behind a `next()` the producer has not answered, so a consumer
walking away from a source parked on an event that never arrives waits forever for its
own cancellation. A controller settles the consumer's read itself, aborts the request's
signal before it delegates cleanup — which is what wakes a cooperating producer — and
contains whatever that producer settles late. `stop()` is the operation the protocol has
no member for: end the exchange with NO terminal, from an owner that is not the consumer.

```ts
import { MCPTextStreamController, sendStream } from '@orkestrel/mcp'

server.methods.add('demo/watch', async (request) => watch(request))

const answer = await server.dispatch({ jsonrpc: '2.0', method: 'demo/watch', id: 2 })
if (answer !== undefined && Symbol.asyncIterator in answer) {
	// the ONE narrowing point — a controlled stream, serializable and pumpable:
	const text = new MCPTextStreamController(answer)
	try {
		await sendStream(text, transport)
	} catch {
		text.stop() // ends the TYPED exchange, not just the serialized adapter
	}
}
```

A producer's own resource cleanup stays the producer's: JavaScript cannot settle work a
generator is suspended inside, so a producer that ignores its signal keeps whatever it
is holding. What the controller guarantees is that its CONSUMER never waits for one.

**Ending a controlled exchange is the obligation of whoever is handed it, on EVERY exit —
including the exits where nothing was cancelled.** One holds a producer, a request lifetime,
and (for `subscriptions/listen`) one of a finite number of live server slots, and a consumer
that walks away releases none of them, because no signal fires when nobody aborts anything.
So both shipped pumps — `sendStream` and `sendEventStream` — release from a `finally` that
covers the normal return, a mid-loop throw, and a carrier that closed underneath them, and
`bindServer` releases a held-open answer it has decided not to write. There is deliberately no
owner of last resort: a finalizer or a timeout would end exchanges nobody released and turn a
reproducible missing obligation into a nondeterministic one, and GC timing is not a lifecycle.

The obligation runs the other way too, and it is stated on both controller interfaces: a
conforming `[Symbol.asyncDispose]` **releases the producer, the request lifetime, and the live
slot BEFORE it may reject**. Disposal that throws first would let a cleanup fault mask the
pump's original failure while still leaking the exchange, so a disposal failure may REPORT
cleanup and never prevent it.

The obligation is spelled `try { … } finally { await stream[Symbol.asyncDispose]() }` rather
than `await using`, and that is a measurement rather than a preference. `tsconfig` targets
`ESNext`, so TypeScript emits a `using` declaration verbatim instead of downlevelling it, and
this package's declared floor — `node >= 22.12.0` — rejects the emitted module at PARSE time
with `SyntaxError: Unexpected identifier`, taking every unrelated export in the file with it.
The same file written with the explicit `finally` runs on that floor and discharges the
identical obligation.

A legacy request never reaches a held-open answer: its method set is frozen by a
shipped revision, and `MCPLegacy` ends any stream the modern engine hands back
before answering `-32000`, because the dated revision has no shape for one. See
[Compose or remove the legacy protocol layer](#compose-or-remove-the-legacy-protocol-layer).

### Project a host-owned resource, prompt, and completion registry

Three optional ports sit beside `tools`, and each obeys the rule the tool registry
already obeys: **MCP owns no storage.** The host builds and owns the registry; this
package projects it onto the wire, bounds and validates what comes back, and stamps
the result.

| Option       | Port                            | Methods it registers                                           | Capability advertised |
| ------------ | ------------------------------- | -------------------------------------------------------------- | --------------------- |
| `resources`  | `MCPResourceManagerInterface`   | `resources/list`, `resources/read`, `resources/templates/list` | `resources`           |
| `prompts`    | `MCPPromptManagerInterface`     | `prompts/list`, `prompts/get`                                  | `prompts`             |
| `completion` | `MCPCompletionManagerInterface` | `completion/complete`                                          | `completions`         |

**A capability registers only when its port is configured**, which is the `tasks/*`
precedent applied twice more. A server built without `resources` registers no
`resources/*` method, advertises no `resources` capability, and answers `-32601`
through the same unregistered-method path any unknown method takes — the honest reply
from a server that does not implement an optional capability, and the reason an
existing tools-only server's discovery answer is byte-for-byte what it was.

**`completions` is a top-level capability, not a sub-flag of the other two.** It is
configured, advertised, and registered independently: a server may complete prompt
arguments without publishing prompts, or publish prompts without offering completion.
The three gates read three options and never each other.

**One pagination shape covers all three paginated methods.** `MCPPaginationParams`
(`{ cursor? }`) goes in and `MCPPaginationResult` (`{ nextCursor? }`) comes back, for
`resources/list`, `resources/templates/list`, and `prompts/list` alike. `tools/list` is
not among them — it reads no cursor and answers no `nextCursor`. The cursor is
OPAQUE and the manager mints it: this package neither interprets one nor invents one,
and a page that omits `nextCursor` is the final page. There is no second cursor shape
anywhere in the package, so a host that implements paging once implements it for all
of them.

**The port accessors are named for their domain, and the wire is not.** The resource port
reads `resource(params)` / `resources(pagination)` / `templates(pagination)`, and the prompt
port reads `prompt(params)` / `prompts(pagination)` — singular and plural nouns of the same
domain, the shape `MCPTaskManagerInterface.task(id)` already set. **The wire method names are
unchanged**: a client still sends `resources/read` and `prompts/get`, because those are the
protocol's own spellings and this package never renames a wire name.

**Not found is the manager's `undefined`, and it reaches the wire as `-32602`.** Both
`resource` and `prompt` answer `undefined` for a URI or a name they do not resolve, which
becomes `-32602` with the unresolved value named. That is the dated revision's
spelling: `resources/subscribe` and `resources/unsubscribe` were removed at
`2026-07-28` and so was the dedicated `-32002` resource-not-found code, which a client
SHOULD still accept from an older peer. Resource subscription lives on
[`subscriptions/listen`](#configure-modern-subscriptions)'s `resourceSubscriptions`
filter instead.

**A `resource` or a `prompt` call may answer `input_required`.** `resource` and `prompt` may return an
`MCPInputResult` rather than contents or messages, so the multi-round mechanism
[form elicitation](#produce-a-form-elicitation-for-the-call-in-hand) uses is reachable
from a resource or a prompt and not only from a `tools/call`. The `inputResponses` and
`requestState` carriers arrive on the params for exactly that continuation, and their
SEMANTICS belong to the manager: core owns the carrier's shape, bounds, and ownership,
and refuses to decide what a consumer's own continuation means.

**`resources/list` / `resources/templates/list` / `prompts/list` are cacheable and
carry `ttlMs` + `cacheScope`; `prompts/get` is not and carries neither.** The stamps
come from the same `cache` option `tools/list` already uses, so one setting governs
every cacheable modern result.

**MCP expands no URI templates.** This is the load-bearing sentence of the whole
resource surface, so it is stated plainly rather than implied. `templates()` publishes
`uriTemplate` strings as DESCRIPTORS, and `resource` takes a **concrete URI** — the one the
client actually sent. Matching a URI to a template and substituting its variables both
happen inside the manager, behind the port. **There is no RFC 6570 implementation and
no template parser anywhere in this package**, at any feature level, and none is
planned: the question "which RFC 6570 level does this support?" has no answer here
because the package never reaches the point of needing one. The conformance runner
agrees this is the intended division — its `resources-templates-read` scenario sends
the already-substituted `test://template/123/data` and asserts only that the returned
content reflects it.

The same ruling decides `completion/complete`'s harder arm. A `ref/resource`
reference's `uri` may itself be a template, and completing its arguments implies
knowing that template's variables — so the reference is forwarded **verbatim** to the
completion port and the host answers it. The party that owns expansion owns knowing
its own variables; parsing templates inside MCP to answer a completion would
reintroduce the engine this ruling removes. `ref/prompt` is forwarded the same way.

Completion candidates are capped at the protocol's **100** values. A manager that
returns more has its list projected down to the first 100 with `hasMore: true`
stamped, whatever it reported itself — so 105 candidates leave as 100 plus the honest
flag rather than as an over-long list a client must defend against.

```ts
import {
	type MCPCompletionManagerInterface,
	type MCPPromptManagerInterface,
	type MCPResourceManagerInterface,
	createMCPServer,
} from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const documents = new Map([['docs://readme', 'The readme body.']])

const resources: MCPResourceManagerInterface = {
	// This registry fits in one page, so it never mints a cursor and never reads one —
	// which is the ONLY correct answer for a final page. A `nextCursor` a following page
	// cannot honour is worse than none, and MCP will forward whatever it is told.
	resources: () => ({
		resources: [{ uri: 'docs://readme', name: 'readme', mimeType: 'text/plain' }],
	}),
	// A CONCRETE uri arrives here. Matching `docs://page/{slug}` against it, and reading
	// `slug` back out, is this function's job — MCP substituted nothing on the way in.
	resource: (params) => {
		const text = documents.get(params.uri)
		if (text !== undefined) return [{ uri: params.uri, mimeType: 'text/plain', text }]
		const slug = params.uri.startsWith('docs://page/') ? params.uri.slice(12) : undefined
		if (slug === undefined) return undefined // → -32602, naming the uri
		return [{ uri: params.uri, mimeType: 'text/plain', text: `Page ${slug}` }]
	},
	// The template is published as a descriptor. Nothing in this package parses it.
	templates: () => ({
		resourceTemplates: [{ uriTemplate: 'docs://page/{slug}', name: 'page' }],
	}),
}

const prompts: MCPPromptManagerInterface = {
	prompts: () => ({
		prompts: [
			{
				name: 'review',
				description: 'Review one document.',
				arguments: [{ name: 'topic', required: true }],
			},
		],
	}),
	prompt: (params) =>
		params.name === 'review'
			? {
					resultType: 'complete',
					messages: [
						{
							role: 'user',
							content: { type: 'text', text: `Review ${params.arguments?.topic ?? 'it'}.` },
						},
					],
				}
			: undefined, // → -32602, naming the prompt
}

const completion: MCPCompletionManagerInterface = {
	// Both reference arms land here; `ref/resource` arrives verbatim, template and all.
	complete: (params) =>
		params.ref.type === 'ref/prompt'
			? { values: ['performance', 'security'].filter((v) => v.startsWith(params.argument.value)) }
			: { values: ['readme'], total: 1 },
}

const server = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
	resources,
	prompts,
	completion,
})
server.methods.method('resources/read') // registered, because `resources` was supplied
server.methods.method('logging/setLevel') // undefined → -32601, like any unconfigured capability
```

The guards behind those projections are exported, so a host can validate its own
registry with the same totals the server validates it with:

```ts
import {
	isMCPCompletion,
	isMCPCompletionParams,
	isMCPCompletionReference,
	isMCPCompletionResult,
	isMCPPaginationParams,
	isMCPPrompt,
	isMCPPromptArgument,
	isMCPPromptGetResult,
	isMCPPromptMessage,
	isMCPPromptPage,
	isMCPResource,
	isMCPResourceContents,
	isMCPResourcePage,
	isMCPResourceTemplate,
	isMCPResourceTemplatePage,
	isMCPStringArguments,
} from '@orkestrel/mcp'

isMCPPaginationParams({ cursor: 'page-2' })
isMCPResource({ uri: 'docs://readme', name: 'readme' })
isMCPResourceTemplate({ uriTemplate: 'docs://page/{slug}', name: 'page' })
isMCPResourceContents({ uri: 'docs://readme', text: 'body' }) // one of `text` / `blob`, never both
isMCPResourcePage({ resources: [{ uri: 'docs://readme', name: 'readme' }] })
isMCPResourceTemplatePage({ resourceTemplates: [] })
isMCPStringArguments({ topic: 'security' }) // every argument value is a string
isMCPPromptArgument({ name: 'topic', required: true })
isMCPPrompt({ name: 'review', arguments: [{ name: 'topic' }] })
isMCPPromptMessage({ role: 'user', content: { type: 'text', text: 'Review it.' } })
isMCPPromptPage({ prompts: [{ name: 'review' }], nextCursor: 'page-2' })
isMCPPromptGetResult({ resultType: 'complete', messages: [] })
isMCPCompletionReference({ type: 'ref/resource', uri: 'docs://page/{slug}' })
isMCPCompletionParams({
	ref: { type: 'ref/prompt', name: 'review' },
	argument: { name: 'topic', value: 'sec' },
})
isMCPCompletion({ values: ['security'], total: 1, hasMore: false })
isMCPCompletionResult({ resultType: 'complete', completion: { values: ['security'] } })
```

`isMCPResourceContents` is structurally discriminated: the wire has no tag field, so
the presence of `text` XOR `blob` is the discriminator and a value carrying both or
neither is refused. `isMCPCompletionResult` additionally enforces the 100-value cap,
so it recognizes only a result this server would actually produce.

### Adapt an existing registry behind a port

The ports take an interface, not a package, so anything can sit behind them — and
`@orkestrel/workspace` and `@orkestrel/template` are two obvious candidates. **Neither
is a dependency of this package and adopting one is entirely the host's decision**;
what follows is what an adapter has to bridge, because in both cases the shapes do not
line up and pretending otherwise would cost a reader an afternoon.

**Workspace → `resources`: four seams, and the first one is not small.**

1. **A workspace addresses by PATH, and MCP addresses by URI.** That package says
   outright that a workspace is not a filesystem, and with several workspaces
   registered a bare path is ambiguous — two workspaces can both hold `readme.md`.
   Neither package defines a URI scheme, so **the adapter must mint one** and own it in
   both directions: path → URI on the way out, URI → workspace + path on the way back.
   Everything else here is mapping; this is design.
2. **The binary MIME set is closed** — `image/png`, `image/jpeg`, `image/gif`, and
   `image/webp`, and nothing else. There is no PDF and no CSV. An adapter must decide
   per file whether the content is text or a blob, and a file the workspace will not
   classify as one of those four is text or it is nothing.
3. **A workspace has no pagination.** Its file listing returns everything, so the
   adapter slices the list and mints its own cursor — which is why the cursor is opaque
   in the first place. A first page and an unbounded workspace are the same call.
4. **Templates stay the adapter's.** If the adapter publishes `docs://page/{slug}`, it
   is the one that matches the concrete URI back to a workspace path, exactly as the
   ruling above requires.

**Template → `prompts`: one near-perfect match and one real mismatch.**
`TemplatePlaceholder` (`{ name, description?, required?, path?, fallback? }`) maps onto
`MCPPromptArgument` (`{ name, title?, description?, required? }`) almost field for
field, so `prompts/list` is nearly free. The output is not:
**`Template.fill()` returns a plain `string`, and `prompts/get` must return
`MCPPromptMessage[]`.** The adapter wraps the filled string in a single user message —
a real decision, not a formality, because a one-message array is the adapter's choice
about what a filled template MEANS, and a template that was written as a dialogue has
its structure flattened by it. MCP argument values are strings by contract, so the
`TemplateFillValues` handoff needs no coercion in that direction.

```ts
import { type MCPPromptManagerInterface, createMCPServer } from '@orkestrel/mcp'
import { createTemplate, createTemplateManager } from '@orkestrel/template'
import { createToolManager } from '@orkestrel/tool'

const templates = createTemplateManager({
	templates: [
		createTemplate({
			name: 'review',
			content: 'Review {{topic}} in {{depth}} detail.',
			description: 'Review one topic.',
			placeholders: [
				{ name: 'topic', description: 'What to review.', required: true },
				{ name: 'depth', description: 'How deeply.', fallback: 'moderate' },
			],
		}),
	],
})

const prompts: MCPPromptManagerInterface = {
	// `templates()` returns EVERY template — the adapter owns the slice and the cursor.
	prompts: (pagination) => {
		const all = templates.templates()
		const start = pagination.cursor === undefined ? 0 : Number(pagination.cursor)
		const page = all.slice(start, start + 50)
		return {
			prompts: page.map((template) => ({
				name: template.name,
				description: template.description ?? template.summary ?? template.name,
				arguments: template.placeholders.map((placeholder) => ({
					name: placeholder.name,
					...(placeholder.description === undefined
						? {}
						: { description: placeholder.description }),
					...(placeholder.required === undefined ? {} : { required: placeholder.required }),
				})),
			})),
			...(start + 50 < all.length ? { nextCursor: String(start + 50) } : {}),
		}
	},
	// The mismatch, in one line: a string comes back and an array of messages goes out.
	prompt: (params) => {
		const found = templates.find({ name: params.name })[0]
		if (found === undefined) return undefined // → -32602
		return {
			resultType: 'complete',
			...(found.description === undefined ? {} : { description: found.description }),
			messages: [
				{ role: 'user', content: { type: 'text', text: found.fill(params.arguments ?? {}) } },
			],
		}
	},
}

const server = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
	prompts,
})
```

One more seam that fence does not hide: `fill` defaults to the `'error'` missing
policy, so a required placeholder the client did not supply THROWS out of `prompt`. That
becomes a contained `-32603` with the caught value reported on the server's `error`
event, which is a defensible answer but not the informative one — an adapter that
cares should call `validate` first and return an
[`input_required` result](#produce-a-form-elicitation-for-the-call-in-hand) asking for
the missing argument, or seed `missing: 'empty'` and accept the gaps.

**The control that proves these are ports rather than shaped holes** is that neither
adapter is privileged. `tests/setupConformance.ts` backs the same three ports with plain
in-memory objects — no workspace, no template engine, no `@orkestrel/*` registry at
all — and the foreign conformance client cannot tell the difference, because there is
nothing on the wire that could. The compiler now agrees with the wire: that fixture is
TypeScript, annotated with the same exported manager interfaces this section documents,
so a plain object is a checked implementation of the port rather than a duck-typed
resemblance to one.

### Configure modern subscriptions

`subscription.notifications` declares what the server can actually honour;
`subscription.listen` opens the event-driven source for the intersected filter.
The built-in owns wire acknowledgement, filtering, id stamping, and graceful
closure. A producer only yields project notifications and ends its iterable when
the source closes; while idle it parks on its own events and may observe the
supplied abort signal.

**Every produced notification is OWNED before it is judged.** The built-in snapshots each
one into bounded exact JSON before it matches the filter or stamps the id, so the values
that admitted a notification are the values that reach the wire — a producer answering
differently on a second read cannot have one URI pass the filter and another ride out.
A notification that is not bounded exact JSON is DROPPED and the stream continues; a
producer that THROWS ends the subscription with one detail-free `-32603` terminal, its
caught value reported on the server's `error` event. Ending the source normally closes
with the complete result; an abort closes with NO terminal at all, because a cancelled
request is not an answered one.

The four filter keys — `toolsListChanged`, `promptsListChanged`,
`resourcesListChanged`, `resourceSubscriptions` — and the `params.notifications`
object holding them are WIRE SPELLINGS carried verbatim from the dated schema.
They are the one place the compound-key rule does not apply, because these
strings are not this package's to choose. The TYPE name is
`MCPSubscriptionFilter`, which is the library's own.

```ts
import {
	type JSONRPCNotification,
	buildSubscriptionAcknowledgement,
	buildSubscriptionFilter,
	buildSubscriptionResult,
	createMCPServer,
	isMCPSubscriptionFilter,
	matchesSubscriptionNotification,
	stampSubscriptionNotification,
} from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const identity = { name: 'docs', version: '1.0.0' }
const supported = { toolsListChanged: true, resourceSubscriptions: ['resource://guide'] }
const input: unknown = { toolsListChanged: true, promptsListChanged: true }
if (!isMCPSubscriptionFilter(input)) throw new Error('invalid filter')
const honoured = buildSubscriptionFilter(input, supported)
const event: JSONRPCNotification = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }
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
			options.signal.throwIfAborted()
			return changes()
		},
	},
})
server.methods.method('subscriptions/listen') // registered on the same modern seam
```

### Execute rich results and request-scoped progress

`MCPServerOptions.execution` is the explicit modern execution port above the live
`ToolManagerInterface`. Its input contains the original `request`, canonical `call`,
real `tools` manager, effective `signal`, and an optional `progress` reporter. Returning
a `ToolResult` uses the normal text/structured normalization; returning a validated
`MCPCallResult` preserves exact text, image, audio, resource-link, and embedded-resource
content without guessing from an ordinary domain value.

Modern `tools/call` treats an omitted `arguments` field as the shared frozen
`EMPTY_MCP_ARGUMENTS` record. A present value must be an object; `null`, arrays, primitives,
and a direct-call own `undefined` receive `-32602` before input policy, continuation access,
digesting, or execution. Whichever it is, ONE reference then reaches the argument digest,
the input selector, the canonical `ToolCall`, and the executor — no step re-snapshots, so no
two of them can be looking at different values.

That record is shared and frozen, which is worth knowing before it surprises you: a tool
that WRITES to its own `arguments` now throws, and since the registry isolates a thrown tool
into a `success: false` result, the client sees an ordinary `isError: true` tool result with
no protocol change to point at. Refusing a mutation of server-owned input is a tool-domain
failure rather than a protocol fault, so that is where it is reported. A tool that needs a
mutable bag copies first: `const working = { ...args }`.

The reporter exists only when `_meta.progressToken` is a string or integer.
`report` requires a bounded payload with finite, strictly increasing values and awaits
consumption by the original `tools/call` response stream. The source holds one item,
stops on completion, abort, or generator return, rejects late reports, and never enters
replay or durable state.
A server without `execution` still calls `ToolManagerInterface.execute` exactly once and
may answer unary even when a token was supplied.

**Three endings, and only one of them reaches the wire.** Running the source to completion
produces exactly ONE terminal — the response the stream returns, and every later read
resolves that same response. A consumer that calls `return(value)` is saying it already has
the answer, so the exchange closes on the value IT supplied: that read and every later one
resolve `{ done: true, value }`, and nothing is sent, because the peer is not owed a terminal
the server never produced. An owner that calls `stop()` and an external abort produce no
terminal at all — those reads settle by raising the reason, because a cancelled request has
no answer to correlate. Cancellation is prompt in every case — the consumer's read settles even while
the producer is parked — and the request's signal goes down BEFORE cleanup is delegated,
so an executor observing it stops, the reporter stops with it, and a late `report`
rejects. A request whose caller has ALREADY gone never starts its producer at all: the
first read is refused, so no execution runs for a peer that will not receive it.

```ts
import {
	createMCPServer,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
} from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const server = createMCPServer({
	identity: { name: 'media', version: '1.0.0' },
	tools: createToolManager(),
	execution: async ({ progress }) => {
		await progress?.report({ progress: 1, total: 2, message: 'Rendering' })
		return {
			resultType: 'complete',
			content: [
				{ type: 'text', text: 'Preview' },
				{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
			],
			structuredContent: ['preview', 1],
		}
	},
})

const response = await server.dispatch({
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: {
		name: 'render',
		arguments: {},
		_meta: {
			[MCP_META_VERSION]: MCP_MODERN_VERSION,
			[MCP_META_CAPABILITIES]: {},
			progressToken: 'render-1',
		},
	},
})

if (response !== undefined && Symbol.asyncIterator in response) await response.next()
```

The exported boundary helpers validate the same wire model and derive stable argument
bindings without a second JSON implementation:

```ts
import {
	buildProgressNotification,
	buildToolCall,
	digestJSON,
	isJSONObject,
	isMCPAnnotations,
	isMCPBlobResource,
	isMCPCallResult,
	isMCPClientCapabilities,
	isMCPContent,
	isMCPIcon,
	isMCPIdentity,
	isMCPLoggingLevel,
	isMCPMetaKey,
	isMCPMetaObject,
	isMCPProgress,
	isMCPResultMetaObject,
	isMCPServerCapabilities,
	isMCPTextResource,
	isStandardBase64,
	isAbsoluteURI,
	isRFC3339Date,
	isRFC3339DateTime,
	serializeJSON,
} from '@orkestrel/mcp'

const limits = { bytes: 4096, keys: 64, depth: 16 }
const parameters = { prompt: 'owl' }
const call = buildToolCall({
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name: 'render', arguments: parameters },
})
const canonical = serializeJSON(parameters, limits)
const digest = await digestJSON(parameters, limits)
const notification = buildProgressNotification('render-1', { progress: 1, total: 2 })

isJSONObject({ prompt: 'owl', attempts: [1, 2] })
isMCPMetaKey('vendor.example/trace')
isMCPLoggingLevel('notice')
isMCPAnnotations({ audience: ['assistant'], priority: 1 })
isMCPIcon({ src: 'data:image/png;base64,aWNvbg==' })
isMCPTextResource({ uri: 'resource://text', text: 'body' })
isMCPBlobResource({ uri: 'resource://blob', blob: 'YmxvYg==' })
isMCPContent({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' })
isMCPCallResult({ resultType: 'complete', content: [{ type: 'text', text: 'done' }] })
isMCPProgress({ progress: 1, total: 2, message: 'Rendering' })
isMCPMetaObject({ 'vendor.example/trace': { id: 'trace-1' } })
isMCPResultMetaObject({
	'io.modelcontextprotocol/serverInfo': { name: 'worker', version: '1.0.0' },
})
isMCPIdentity({ name: 'worker', version: '1.0.0', websiteUrl: 'https://example.test' })
isMCPClientCapabilities({ elicitation: {}, custom: { enabled: true } })
isMCPServerCapabilities({ tools: { listChanged: true }, custom: { enabled: true } })
isStandardBase64('aW1hZ2U=')
isAbsoluteURI('urn:example:images:preview')
isRFC3339Date('2024-02-29') // true — a leap day that exists
isRFC3339DateTime('2026-02-30T00:00:00Z') // false — February never has 30 days
```

`isAbsoluteURI` implements host-neutral RFC 3986 syntax rather than delegating to WHATWG
`URL`: non-hierarchical schemes, IPv6/IPvFuture literals, percent escapes, and permitted empty
components validate without normalization or scheme policy. Relative references, raw whitespace
or controls, malformed escapes, ports, authorities, and malformed bracketed IP literals do not.
An unbracketed digit-and-dot host that is not an RFC IPv4 address remains a legal `reg-name`, and
an authority may have an empty host.

`isRFC3339Date` and `isRFC3339DateTime` are the `date` / `date-time` elicitation formats, and
they check the CALENDAR, not just the shape: RFC 3339 §5.6 defines `date-mday` by the month and
year, so `2026-02-30`, `2026-04-31`, and `2025-02-29` are refused even though every field is in
range. Neither guard constructs a `Date` — `Date` is what rolls `2026-02-30` silently onto 2
March, which is the acceptance they exist to prevent — so a non-RFC-3339 spelling of a real
instant (`2026-01-31 10:00:00Z`, or an offset-less `2026-01-31T10:00:00`) stays refused too.

Rich-content guards
require exact finite JSON metadata, standard padded base64, nonnegative integer resource sizes,
and accept an embedded resource that satisfies both the text and blob alternatives.

`serializeJSON` is the exact JSON boundary: it snapshots enumerable data descriptors once,
rejects accessors, symbols, hidden or extra properties, sparse arrays, cycles, and non-finite
numbers, counts array indices as keys, and enforces actual UTF-8 wire bytes before producing the
canonical string. Shared acyclic subgraphs remain valid. `isBoundedJSON` delegates to that same
engine, so validation and serialization cannot disagree. `parseJSONRPCMessage` builds one frozen,
bounded owned graph from that canonical text before routing, settlement, or notification delivery;
`parseRequestContext` projects frozen capabilities and identity from the owned request.

### Produce a form elicitation for the call in hand

Configure `input` only when a `tools/call` may need operator input. The
consumer owns the decision, authenticated principal, host-neutral continuation
port, and TTL; MCP owns the protocol mechanism. It assigns an unpredictable map key,
returns one form-mode `MCPElicitRequest`, seals the opaque `requestState`, and on
retry opens and verifies that state before giving the matching top-level
`inputResponses` value back to the hook. Returning `undefined` from the hook
continues into the ordinary live tool registry.

The order the server runs those steps in is itself a contract, because each step is a
provider call somebody pays for. On a FIRST round: the selector runs, its elicitation and
schema are owned and frozen immediately, the client's form capability is checked, and only
then is the principal resolved and the state sealed — so a client that never declared
elicitation costs no principal lookup and no audit record. On a RETRY: the capability is
checked before the continuation port is opened or the principal is resolved, and every
structural binding — changed id, expiry, version, method, tool name, argument digest, the
issued key, and the accepted content against the issued schema — is verified before the
principal resolver runs at all.

```ts
import {
	createMCPServer,
	isElicitContent,
	isFormElicitationSupported,
	isMCPElicitFieldSchema,
	isMCPElicitForm,
	isMCPElicitRequest,
	isMCPElicitResult,
	isMCPElicitSchema,
	isMCPElicitURL,
	isMCPInputRequest,
	isMCPInputRequestMap,
	isMCPInputResult,
} from '@orkestrel/mcp'
import { createMCPContinuation } from '@orkestrel/mcp/server'
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(createTool({ name: 'reply', execute: (input) => input }))

const server = createMCPServer({
	identity: { name: 'supervisor', version: '1.0.0' },
	tools,
	input: {
		continuation: createMCPContinuation(['current-secret', 'older-secret']),
		ttl: 60_000,
		principal: () => 'authenticated-user-42',
		elicit: ({ response }) =>
			response === undefined
				? {
						request: {
							message: 'Approve this reply?',
							requestedSchema: {
								type: 'object',
								properties: { approved: { type: 'boolean' } },
								required: ['approved'],
							},
						},
						state: { operation: 'run-42' },
					}
				: undefined,
	},
})

isFormElicitationSupported({ elicitation: {} }) // true: empty means form-only
isFormElicitationSupported({ elicitation: { url: {} } }) // false
isMCPElicitFieldSchema({ type: 'string', format: 'email' }) // true: one field's schema
isMCPElicitSchema({ type: 'object', properties: { approved: { type: 'boolean' } } }) // true
isMCPElicitForm({
	message: 'Approve?',
	requestedSchema: { type: 'object', properties: {} },
}) // true
isMCPElicitURL({ mode: 'url', message: 'Authenticate', url: 'https://example.test' })
isMCPElicitRequest({
	method: 'elicitation/create',
	params: { message: 'Approve?', requestedSchema: { type: 'object', properties: {} } },
}) // true
isMCPInputRequest({ method: 'roots/list' }) // true: legal, deprecated, never produced here
isMCPInputRequestMap({ confirm: { method: 'roots/list' } }) // true: a keyed map, not an array
isMCPElicitResult({ action: 'accept', content: { approved: true } }) // true
isElicitContent(
	{ approved: true },
	{ type: 'object', properties: { approved: { type: 'boolean' } } },
) // true
isElicitContent(
	{ approved: 'yes' },
	{ type: 'object', properties: { approved: { type: 'boolean' } } },
) // false
isMCPInputResult({ resultType: 'input_required', requestState: 'opaque' }) // true

server.methods.method('tools/call') // the MRTR-aware built-in remains on the one method seam
```

Numeric elicitation bounds and defaults are finite; a dated `integer` schema still permits a
fractional numeric default because that is its declared TypeScript shape. Length and item-count
bounds are nonnegative integers and inverted annotations are not rejected. String `enum`,
`enumNames`, and `oneOf` selectors, and array `enum` / `anyOf` selectors, validate independently
when present and may coexist with extension fields; selector ordering, membership, and parallel
array lengths are not application policy at this protocol boundary. An accepted response may omit
content by SHAPE — `isMCPElicitResult` allows it — while the server additionally enforces the
issued schema through `isElicitContent`, so an accepted response omitting a `required` field is
refused on the retry even though its shape is legal. Decline and cancel responses must omit
content and are never checked against the schema. Accepted response numbers may be fractional
but never non-finite, and response arrays contain strings only. URL-mode requests use the same
RFC 3986 URI guard.

The retry uses a new JSON-RPC id and preserves the original `name` /
`arguments`; `inputResponses` and the byte-exact `requestState` are top-level
`params` siblings. Extra `inputResponses` keys are IGNORED — the server assigned exactly one
key and reads exactly that one — while omitting the issued key is still a refusal. A missing
or URL-only elicitation declaration receives
`-32021` with `{ requiredCapabilities: { elicitation: {} } }`. A malformed,
mutated, expired, same-id, cross-principal, cross-version, cross-method,
cross-tool, changed-argument, wrong-key, or schema-violating state receives `-32602` before
tool execution. A continuation or policy provider rejection is infrastructure failure and
receives detail-free `-32603`, with the caught value on the server's `error` event — as does
a port that opens SUCCESSFULLY onto a payload this server never authored, or onto one
outside the state bound, because the client wrote neither and cannot act on being told it
was at fault. A carrier the port simply cannot recover, and an invalid resolved principal,
elicitation, or carrier, remain `-32602`. Recovered state is bounded before parsing.

**What the protected state binds, and for how long.** The carrier is OPAQUE to the client:
it carries an authenticated principal, an absolute expiry, the ORIGINAL first-round request
id, the protocol revision, the method, the server-minted key, the tool name, a canonical
SHA-256 argument digest, the EXACT schema that was issued with that round, and any
application state the selector attached. Expiry is a short absolute deadline set from the
consumer's `ttl`, and it is rechecked around every provider await rather than admitted once:
after the selector answers, and around the seal that a further round performs. The issued
schema is not merely carried — `isElicitContent` enforces the accepted response against it,
so a client answering a question other than the one it was asked is refused before the tool
runs. Across rounds, `principal`, the original id, version, method, tool name, and digest
stay bound while key, expiry, and schema are re-minted; the original id stays bound however
many rounds follow, so a three-round exchange is still one correlated call.

**What it deliberately does not do.** There is no consume-once rule, no session binding, no
timer, and no replay store: the same protected state answers again under a fresh id, and it
is exhausted by its expiry alone. Single use is APPLICATION policy — a continuation port that
should be redeemable once enforces that itself, which is exactly why the port is a consumer
interface. Nothing about the mechanism is session-bound either: the carrier travels in
`params` and works across connections, processes, and transports. JSON-RPC ids are
correlation only, so an application operation that must not run twice still needs its own
idempotency key; a retried call whose bindings all match runs the tool again.

The continuation port may be a self-contained token adapter or a consumer-supplied durable
server-side handle. The server produces `input_required` from its built-in modern
`tools/call` and from nothing else, and the legacy branch is unchanged. Core does NOT refuse
a continuation carrier on another method: it owns the carrier's shape, bounds, and ownership
for every invocation — a malformed one never reaches a handler — and the continuation
SEMANTICS belong to whoever registered that method. Register `prompts/get` or
`resources/read` on `server.methods` and the handler receives its owned frozen carrier and
decides what it means; leave them unregistered, as this package ships them, and they still
answer `-32601`.

### Defer a call to a durable task

> **This surface is DRAFT.** The Tasks extension lives in the specification's
> `specification/draft/` tree under the id `io.modelcontextprotocol/tasks` and carries no
> stability guarantee. Every type, wire field, and error code below can change or disappear
> with it, and this package will follow the extension rather than freeze a private dialect
> of it. Configure `task` only where a breaking change between releases is acceptable.

A **task** is a durable operation that OUTLIVES the request that created it. The server
answers a modern `tools/call` immediately with `resultType: 'task'` and a `taskId`, and the
client comes back later for the outcome. Everything between those two moments belongs to the
consumer: supply an `MCPTaskOptions` with a durable `tasks` store and a `defer` policy, and
this package supplies the protocol and nothing else. It holds **no task state, no timer, and
no status logic**, because a durable operation outlives the process that answered the request
and MCP has no durable place to keep one.

**Deferral is the SERVER's decision.** The extension gives a client no flag and no parameter
to ask for a task — a client only declares, per request, that it can cope with one. So
`defer` is where the policy lives (long-running tool, queue depth, caller tier), it is
consulted only for a client that declared the capability on the request in hand, and it
returns the **stable operation key** the store deduplicates on, or `undefined` to run the
call inline. The decision sits between the input mechanism and progress: **MRTR first**,
because a call still asking its operator a question has not been decided yet and must not be
durably stored with unsettled arguments; **task before progress**, because a deferred request
ends the moment the handle is written and has no stream left to report progress on.

`MCPTaskContext` carries **no cancellation signal**, and that absence is the sharpest hazard
in this surface. The `signal` on the accompanying `MCPMethodOptions` is the
REQUEST's lifetime, and a transport aborts it as soon as the response body is flushed. A
manager that plumbs `options.signal` into the task's work therefore loses every task it
creates, milliseconds after creating it, and the loss looks exactly like a client that
disconnected. Spend `options.signal` on work that must finish before the ANSWER is written,
and give the task's own work a lifetime the manager owns.

```ts
import {
	createMCPServer,
	DEFAULT_MCP_LIMITS,
	digestJSON,
	isJSONRPCError,
	isMCPTaskDetail,
	isMCPTaskResult,
	isMCPTaskStatus,
	isTaskSupported,
	MCP_EXTENSION_TASKS,
} from '@orkestrel/mcp'
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(createTool({ name: 'render', execute: (input) => input }))

const server = createMCPServer({
	identity: { name: 'supervisor', version: '1.0.0' },
	tools,
	task: {
		// The consumer's durable store: create/return, read, answer, ask to stop.
		tasks: {
			start: (key, context, options) => store.start(key, context, options),
			task: (id, options) => store.task(id, options),
			update: (id, responses, options) => store.update(id, responses, options),
			abort: (id, options) => store.abort(id, options),
		},
		// The stable operation key, or `undefined` to run this call inline. Minted from the
		// PRINCIPAL and the canonical arguments — never from `call.id`.
		defer: async ({ call }, { caller }) =>
			call.name === 'render'
				? `render:${String(caller)}:${String(await digestJSON(call.arguments, DEFAULT_MCP_LIMITS))}`
				: undefined,
	},
})

isTaskSupported({ extensions: { [MCP_EXTENSION_TASKS]: {} } }) // true: presence is the declaration
isMCPTaskStatus('working') // true; 'done' is not a state the extension defines
isMCPTaskResult({
	resultType: 'task',
	taskId: 'a',
	status: 'working',
	createdAt: '',
	lastUpdatedAt: '',
	ttlMs: null,
}) // true: the CREATION answer
isMCPTaskDetail({
	taskId: 'a',
	status: 'completed',
	createdAt: '',
	lastUpdatedAt: '',
	ttlMs: null,
	result: { resultType: 'complete' },
}) // true: the SNAPSHOT, whose status selects what else it owes
isJSONRPCError({ code: -32603, message: 'the deferred call could not run' }) // a failed task's error

server.methods.method('tasks/get') // registered only because `task` was configured
```

**Never mint the key from `call.id`.** It is the client's own JSON-RPC request id, so it fails
both key obligations at once: a client that retries one logical call sends a fresh id and mints
a second durable task, which is dedup never firing; and two principals whose clients both start
counting at `1` produce the SAME key, which is one principal handed a `taskId` over the other's
work. Mint from the caller and the canonical arguments, as above. `defer` returning `undefined`
is the only way to say "run this inline"; an empty string cannot identify an operation and is
refused as `-32603` rather than quietly taking the inline path.

**The three lifecycle methods register only when `task` is configured.** An unconfigured
server advertises nothing, defers nothing, and answers `tasks/get` / `tasks/update` /
`tasks/cancel` with `-32601` through the same unregistered-method path any unknown method
takes — the honest reply from a server that does not implement an optional extension.
Configured, it advertises `capabilities.extensions['io.modelcontextprotocol/tasks']` on
`server/discover` and answers all three.

| Method         | Params                       | Answers                                                                            |
| -------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `tasks/get`    | `{ taskId }`                 | `resultType: 'complete'` carrying the flat `MCPTaskDetail` and the server identity |
| `tasks/update` | `{ taskId, inputResponses }` | `resultType: 'complete'` and nothing else                                          |
| `tasks/cancel` | `{ taskId }`                 | `resultType: 'complete'` and nothing else                                          |

Only the CREATION answer carries `resultType: 'task'`. Reading, answering, and cancelling a
task are ordinary completed method calls, and `tasks/get`'s payload merely happens to be a
task — so a client narrows on `status`, never on a second discriminator.

**The refusal taxonomy is short and deliberate.** A client that never declared the extension
on the request in hand gets `-32021` with
`{ requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } } }` before its
parameters are read at all, because the extension binds that refusal to the METHOD. This is
the **same generic missing-required-client-capability code** the elicitation path answers, and
the two are told apart by `data.requiredCapabilities` alone — they are two instances of one
condition, not two conditions, and there is no second numeral. (The extension's own draft prose
still shows `-32003` in examples; the dated core schema fixes `-32021`, and a peer implements
the dated schema.) An absent, non-string, empty, or over-bound `taskId` gets `-32602`. A
`taskId` the store does not resolve gets `-32602` too — **byte-identically for a task that
never existed, one whose TTL purged it, and one this caller is not entitled to see**, because
the port answers `undefined` for all three and this package cannot tell them apart even in
principle. That is what makes a `taskId` unprobeable; a second code, or a second message,
would turn the store into an enumeration oracle.

**`-32603` covers two different failures, and only one of them reaches `error`.** A store that
THROWS is contained as `-32603` with the caught value on the server's `error` event. A store
that RETURNS badly — a snapshot outside the content bound, or one off the published contract —
is refused as `-32603` too, but **silently**: nothing was thrown, so there is no caught value
to report and nothing reaches `error`. A consumer watching `error` to detect a faulty store
therefore sees its exceptions and is **blind to its contract violations**; watch the `-32603`
rate on the wire for that second class. A `defer` that returns a key which is neither
`undefined` nor a non-empty string is the third `-32603`, and it is silent for the same reason.
Do not generalize from the elicitation path, which discloses the opposite way: a continuation
port that opens SUCCESSFULLY onto an off-contract payload is reported on `error` there, because
that seam synthesizes the fault it never caught. The tasks port does not.

`tasks/update` and `tasks/cancel` both read the named task first, because both answer `void`
and neither has a way to report an unknown task or to decide authorization — a read they accept
is a write they authorized. That read is **proven with the same guard `tasks/get` proves its
answer with**, not merely compared against `undefined`: `undefined` is one of several ways an
implementation of this port can say "no such task" — `null` is the ordinary JavaScript spelling
— and a value that is not a well-formed `MCPTaskDetail` earns the same byte-identical `-32602`
an unknown `taskId` does, with neither `update` nor `abort` invoked. Expect one `task(...)`
read before every update and every cancellation. **Cancellation is advisory**:
this server ASKS, and the acknowledgement says the request was accepted, never that the task
stopped — a store whose work cannot be interrupted may legally reach `completed` afterwards,
and this package asserts nothing about which happened. **Input responses are forwarded
verbatim**: a key the task never published, and one it has already answered, are the store's
to IGNORE rather than this server's to refuse, because which keys a task recognizes is
knowledge only the task holds. `ttlMs` and `pollIntervalMs` pass through exactly as the store
produced them and are never invented; `ttlMs` is `null` — not absent — when a task does not
expire.

**Two spellings of `input_required`, and they are different mechanisms.** Both are on the
wire, so neither can be renamed, and a reader who conflates them will reach for the wrong
recovery.

|                       | MRTR `resultType: 'input_required'`                           | `MCPTaskStatus` `'input_required'`                  |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| Who owns it           | MCP, through `MCPServerOptions.input`                         | the consumer's store                                |
| What is suspended     | one LIVE request                                              | one DURABLE task                                    |
| Where the state lives | the sealed opaque `requestState` MCP mints                    | wherever the store keeps it                         |
| How it resumes        | a new `tools/call` carrying `requestState` + `inputResponses` | `tasks/update` carrying `taskId` + `inputResponses` |
| Guard                 | `isMCPInputResult`                                            | `isMCPTaskStatus` / `isMCPTaskDetail`               |

**And the second one is the weaker mechanism.** `tasks/update` is a multi-round-trip exchange
with **none** of the protections the elicitation path carries: no sealed `requestState`, no
canonical argument digest, no absolute expiry, no principal binding, no schema enforcement on
the answer. Consumers who have read the elicitation section will reasonably expect parity.
**They cannot have it from this package**, because MCP neither issued the task's question nor
owns the channel it is answered on — the store did both. Anything equivalent has to live in
the store: bind each published key to the principal entitled to answer it, expire unanswered
keys, and treat a response arriving after the task moved on as stale. Stating that is the only
protection this package can offer, and a consumer who skips it is running an unauthenticated
input channel beside an authenticated one.

**Six obligations this package cannot enforce, and what each costs.** Every one of them is
reachable only through a store this package never sees, so each is stated here and on the
port's own TSDoc rather than defended with coordination machinery — and each is proved by a
fixture that violates it and demonstrates exactly this consequence.

| Obligation                               | The consequence of violating it                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Durability before return**             | `start` must resolve only once the task is retrievable by `task`. This package awaits `start` before it builds the answer, which is its whole half; a store that resolves first hands the client a `taskId` a prompt `tasks/get` answers `-32602` for, and the window is silent.     |
| **`taskId` entropy**                     | It is a bearer handle over a durable operation. Mint it from a cryptographic source; a handle derived from the key, a counter, or anything else predictable is a handle a stranger can guess.                                                                                        |
| **Key uniqueness and non-reuse**         | The same logical call must produce the same key and two different calls must not. This package forwards whatever `defer` returned, unchanged, however many times it sees it.                                                                                                         |
| **Dedup keys scoped to their principal** | Returning the existing task for a repeated key is what makes a retried call idempotent — but an unscoped key means two principals submitting the same key receive the SAME task, one reading the other's work. This package has no principal to scope by; the store or `defer` must. |
| **Terminal immutability**                | `completed`, `failed`, and `cancelled` never move again. This package holds no cache, so a store that mutates a terminal task has both snapshots reported faithfully and its clients see a task travel backwards.                                                                    |
| **TTL purge**                            | A task with a finite `ttlMs` is the store's to expire; `ttlMs: null` means no expiry and must never be swept. After a purge the handle answers the same `-32602` an unknown one does, which is intended — and indistinguishable.                                                     |

**Task notifications are not implemented, and that is a recorded gap rather than a decision** —
see [Declared conformance gaps](#declared-conformance-gaps).

### Bound hostile input and live resources

Every server uses the frozen `DEFAULT_MCP_LIMITS`: one MiB for a raw message,
16 KiB and 64 total object keys for `_meta`, 16 KiB for `requestState`, four MiB
for produced tool content, 128 live built-in subscriptions, and depth 32 for
bounded JSON. Those defaults are sized respectively for substantial ordinary
JSON-RPC arguments, extension-rich request context, a signed state carrying a
short deployment value, substantial JSON tool output, a busy
long-lived host, and ordinary documents well beyond typical application nesting.

A deployment changes only the policy values it needs through the single `limit`
group. Every malformed numeric leaf (`NaN`, infinity, a negative, or a fraction)
falls back to its secure default. Message overflow maps to `-32700`; invalid or
oversized `_meta` and `requestState` map to `-32602`; oversized produced content
and exhausted subscription capacity map to `-32603` — under BOTH eras, because a legacy
call runs on the modern engine and inherits its bounds. None uses MCP's reserved
`-32020` / `-32021` / `-32022` range. `-32000` survives in `MCPLegacy` alone, and only
for a modern result the dated revision has no shape for.

```ts
import { createMCPServer, DEFAULT_MCP_LIMITS, isBoundedJSON, isBoundedString } from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const server = createMCPServer({
	identity: { name: 'bounded', version: '1.0.0' },
	tools: createToolManager(),
	limit: {
		message: 512 * 1024,
		metadata: 8 * 1024,
		keys: 32,
		state: 8 * 1024,
		content: 2 * 1024 * 1024,
		subscriptions: 64,
		depth: 24,
	},
})

DEFAULT_MCP_LIMITS.message // 1_048_576
isBoundedString('€', 2) // false
isBoundedJSON({ ok: true }, { bytes: 16, keys: 1, depth: 1 }) // true
await server.handle('{"jsonrpc":"2.0","method":"ping","id":1}')
```

`isBoundedJSON` walks iteratively and tracks active ancestors. Cycles, values
deeper than the configured depth, accessors/hostile proxies, `Map`/`Set`, and
non-finite values return `false`; no adversarial shape throws from the guard. Own
`__proto__`, `constructor`, and `prototype` keys are ordinary exact-JSON data and are
accepted within the same byte/key/depth bounds. There is no second, laxer JSON policy
for legacy any more: the dedicated legacy normalizer is gone, and a legacy `tools/call`
is bounded and serialized by the engine it now runs on.

### Bind an `MCPServer` / `MCPClient` to any duplex transport

`bindServer` / `bindClient` pipe an `MCPServerInterface` / `MCPClientInterface`
over an `MCPTransportInterface` — the environment-agnostic duplex message
channel (`send` / `listen` / `closed` / `close`, ALL string messages; framing
is entirely the transport's concern). Every environment face — Node stdio and
WebSocket, the browser's `MessagePort` and worker scope — implements this ONE port
instead of duplicating the dispatch/correlation pump per transport:

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
const server = createMCPServer({ identity: { name: 'calculator', version: '1.0.0' }, tools })
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

### Compose or remove the legacy protocol layer

The two dated revisions are not a branch inside the server. They are a **decorator over it**.
`MCPLegacy` wraps one `MCPDispatcherInterface` — the minimal `emitter` / `limit` / `dispatch` /
`handle` surface a transport actually needs, and the one `MCPServerInterface` extends — and translates the
fixed legacy method set onto the modern engine underneath. A modern-shaped invocation passes
through untouched. `initialize` is answered locally and `notifications/initialized` is swallowed
there, because both are handshake acts with no modern counterpart. `ping`, `tools/list`, and
`tools/call`
acquire modern request metadata, run through the SAME dispatcher a modern request runs through,
and have the answer projected back into the unstamped legacy shape. Every other method is
refused with `-32601` at the door.

**Composition is the consumer's, and it is one call:**

```ts
import { createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
import { createMCPRoutes } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})

createMCPRoutes(createMCPLegacy(mcp)) // 2026-07-28 AND the two legacy revisions
createMCPRoutes(mcp) // modern only — a legacy request falls off the modern seam as -32601
```

That pair is the removability proof a developer can feel: the layer is a value you pass or do
not pass, so a server built without it has no legacy code path to reach at all. **It composes at
every door**, not only over HTTP: `createMCPRoutes`, `createMCPPostHandler`,
`createWebSocketServer`, `createStdioServer`, and `bindServer` all take the narrow
`MCPDispatcherInterface`, so the decorator drops in front of any of them. A stdio deployment
speaking the `initialize` handshake — the most common shape an MCP server ships in — wires as
`createStdioServer(createMCPLegacy(mcp))`, and each door is proven end to end against a real
transport: a real socket pair, a spawned child process, and a cross-wired duplex pair.

`MCPDispatcherInterface` carries `emitter` for the same reason it carries `limit` and `handle`: a
transport-facing dispatcher must be able to report a contained fault, and a binder that owns a
pump has only an event to report it through. `MCPLegacy` **forwards** the dispatcher it wraps
rather than minting its own, so one server has one error feed — subscribe to `mcp.emitter` and
you see faults from both eras, including the ones that arrived through the legacy door.

**What removing legacy SERVER INGRESS costs, exactly.** The claim is bounded to ingress on
purpose: what comes out is a server that no longer ANSWERS a dated revision, not a package that
no longer speaks one. It is **eight published modules**. Two are whole files that go —
`src/core/MCPLegacy.ts` and the HTTP session entity `src/server/MCPSession.ts`. The other six
survive and give up one declared row each: `createMCPLegacy` in `src/core/factories.ts`, its
barrel row in `src/core/index.ts`, `MCPLegacyOptions` in `src/core/types.ts`, the session
middleware in `src/server/middlewares.ts`, the four `MCPSession*` contracts in
`src/server/types.ts`, and the session barrel rows in `src/server/index.ts`.

**`src/core/types.ts` is a DECLARED ROW, never a file to delete.** It is the shared contract
carrier the modern dispatcher imports, so deleting the file deletes the modern engine with it. A
remover takes out the `MCPLegacyOptions` declaration and leaves everything else in that module
standing. The same distinction governs the other five row entries: the file stays, one
declaration leaves.

**The documentation goes with them, and this section is not all of it.** The rule is every guide
row naming `MCPLegacy` or `createMCPLegacy` — this section, the `createMCPLegacy` Factories row,
the `MCPLegacy` Entities row, the `MCPDispatcherInterface` and `MCPLegacyOptions` Surface rows,
the `#### MCPDispatcherInterface` Methods block, and the cross-references that point here.
Removing the code and keeping a row that names a deleted export fails this package's own parity
gate, which requires every backticked API in this guide to resolve to a real public export.

`MCPServer` is not on that list and holds nothing that would put it there: no era branch, no
import of a legacy module, and no literal spelling a legacy method or header name — which is
precisely why the modern engine still compiles once the layer is deleted. `isModernRequest`,
`inferEra`, `isInitializeRequest`, `MCPLegacyResult`, and the two legacy version constants
**survive**, because the modern engine reads them to decide what a request IS, not to serve a
legacy one.

**`MCPClient` is outside this claim, and naming that is the honest form of it.** The client is a
working dual-era engine that none of the eight items touches: it sends `initialize` and
`notifications/initialized`, negotiates the two dated revisions, and accepts unstamped legacy
results. Delete all eight and that egress path is still there, which is exactly why the claim
reads "server ingress" rather than "legacy support".

**Client legacy egress is a separate open question, and nothing here answers it.** Two mechanisms
carry that egress and neither is on the eight-module list. The first is the client's private
`initialize` handshake: it sends the dated request, refuses a negotiated version whose era is not
legacy, sends `notifications/initialized`, and records the legacy era before emitting `connect`.
The second is the era flag that handshake sets. It selects the handshake outright for a client
already in the legacy era or pinned to a legacy revision, and it gates the fallback a modern
`connect` takes when discovery fails for any reason other than an unsupported version. Removing
either one changes what `MCPClient` can talk to, which is a different decision from what
`MCPServer` will answer. It is a design question and not a defect: no clause is unsatisfied, both
paths are tested, and no unit is scheduled against them.

That eight-module list is a membership rule rather than a reassurance, so it is executed instead
of asserted: [the repository law suite](../../tests/policy.test.ts) computes the legacy-owning
module set from the tree and requires it to EQUAL that list **in both directions**, so a new
participant and a stale entry fail the same way. The same suite checks the `MCPServer` clause as
three separate facts. What neither check can reach is recorded beside them, in the suite and in
`tests/setupPolicy.ts`: legacy participation that never spells the entity name or the method
name — a handler table, a computed concatenation, a branch on a version VALUE — is invisible to
a structural rule, and [the dispatch tests](../../tests/src/core/MCPLegacy.test.ts) are the guard
for that class.

**Three things a legacy client sees differently than it did before this collapse**, because
legacy now inherits the modern engine's validation instead of running beside it:

| A legacy `tools/call` whose …      | Answered before                                    | Answers now                                            |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| tool result contains `NaN`         | `null`, via `JSON.stringify`'s non-finite coercion | `-32603` — the produced result is not valid JSON       |
| `params.arguments` is `null`       | accepted, and the tool ran                         | `-32602` — arguments must be an object                 |
| tool value exceeds `limit.content` | `-32000`                                           | `-32603`, the same code a modern call already received |

The shared cause is worth stating once, plainly: **legacy inherits the modern engine's validation
because it now runs on it.** `NaN` is not JSON, the modern path always refused it, and a server
that refused one caller while silently nulling the other was answering the same question two
ways. Uniform refusal is the coherent answer, and it is the intended consequence of the collapse
rather than a side effect of it. `-32000` survives, but only where it carries a meaning no modern
code does: a modern result the dated revision has no shape for — a held-open stream, a `task`, an
`input_required`, or a capability refusal — which is the one thing the older revision genuinely
cannot represent.

### Factories

| API                           | Kind     | Summary                                                                                                                                                                             |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMCPServer`             | function | Create an `MCPServerInterface` exposing tools plus optional signed MRTR input and event-driven subscription mechanisms over JSON-RPC 2.0.                                           |
| `createMCPLegacy`             | function | Decorate one `MCPServerInterface` with the legacy method translation — the ONE call that adds `2025-11-25` / `2025-06-18` support, and the one deleting it removes.                 |
| `createMCPClient`             | function | Create an `MCPClientInterface` that drives a REMOTE server over an injected transport and exposes its tools as local `ToolInterface`s.                                              |
| `createDuplexClientTransport` | function | Adapt an `MCPTransportInterface` into a `MCPClientTransportInterface` — the bridge letting `createMCPClient` run over the environment-agnostic duplex port; pair with `bindClient`. |

### Entities

| API                       | Kind  | Summary                                                                                                                                          |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MCPServer`               | class | The transport-agnostic JSON-RPC dispatch core over a `ToolManagerInterface` — `dispatch` (typed) + `handle` (string).                            |
| `MCPLegacy`               | class | The removable legacy decorator over ONE `MCPDispatcherInterface` — translates the two dated revisions onto the modern engine and owns none.      |
| `MCPMethodManager`        | class | The modern method registry `MCPServer` registers its built-ins on and resolves every modern method from — `add` + `method`.                      |
| `MCPProgressReporter`     | class | One request-scoped, single-slot progress handoff with backpressure between one producer and one serial consumer.                                 |
| `MCPStreamController`     | class | The one cancellation engine every held-open answer leaves `dispatch` through — one pending source read, prompt closure, contained late promises. |
| `MCPTextStreamController` | class | The serialized mirror of a controlled stream — translation only, delegating every lifecycle decision into the typed exchange beneath it.         |
| `MCPClient`               | class | The transport-agnostic dual-era JSON-RPC client over a `MCPClientTransportInterface` — negotiate once, then `discover` / `tools` / `call`.       |
| `MCPTaskClient`           | class | The draft Tasks extension's client half over one correlated-request door — `task` / `update` / `abort`, no plural accessor and no schedule.      |
| `MCPError`                | class | A remote JSON-RPC error preserving its numeric `code` and optional `error.data` as `context`.                                                    |

### Constants

| Constant                      | Kind  | Value                                                                                                                |
| ----------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| `MCP_PROTOCOL_VERSION`        | const | `'2025-11-25'` — the newest legacy initialize revision.                                                              |
| `MCP_LEGACY_VERSION`          | const | `'2025-06-18'` — the legacy fallback anchor.                                                                         |
| `MCP_MODERN_VERSION`          | const | `'2026-07-28'` — the modern discovery revision.                                                                      |
| `SUPPORTED_PROTOCOL_VERSIONS` | const | Frozen preference order: `2026-07-28`, `2025-11-25`, `2025-06-18`.                                                   |
| `MCP_META_VERSION`            | const | `'io.modelcontextprotocol/protocolVersion'` — reserved request-version metadata key.                                 |
| `MCP_META_CAPABILITIES`       | const | `'io.modelcontextprotocol/clientCapabilities'` — reserved capability metadata key.                                   |
| `MCP_META_CLIENT`             | const | `'io.modelcontextprotocol/clientInfo'` — reserved client-identity metadata key.                                      |
| `MCP_META_SERVER`             | const | `'io.modelcontextprotocol/serverInfo'` — reserved server-identity metadata key.                                      |
| `MCP_META_SUBSCRIPTION`       | const | `'io.modelcontextprotocol/subscriptionId'` — reserved subscription-id metadata key.                                  |
| `MCP_EXTENSION_TASKS`         | const | `'io.modelcontextprotocol/tasks'` — the draft Tasks extension id, declared and advertised by presence.               |
| `MCP_HEADER_MISMATCH`         | const | `-32020` — required HTTP metadata does not match the request body.                                                   |
| `MCP_MISSING_CAPABILITY`      | const | `-32021` — the GENERIC undeclared-client-capability code; `data.requiredCapabilities` names which one.               |
| `MCP_UNSUPPORTED_VERSION`     | const | `-32022` — the request names an unsupported protocol revision.                                                       |
| `DEFAULT_MCP_CACHE_TTL`       | const | `60000` — default modern cache freshness lifetime in milliseconds.                                                   |
| `DEFAULT_MCP_LIMITS`          | const | Frozen secure defaults for message, metadata, keys, state, content, subscriptions, and depth.                        |
| `EMPTY_MCP_ARGUMENTS`         | const | The one frozen null-prototype record every argument-less modern `tools/call` runs with.                              |
| `JSONRPC_PARSE_ERROR`         | const | `-32700` — invalid JSON was received (the message did not parse).                                                    |
| `JSONRPC_INVALID_REQUEST`     | const | `-32600` — the payload was not a valid Request object.                                                               |
| `JSONRPC_METHOD_NOT_FOUND`    | const | `-32601` — the requested method does not exist.                                                                      |
| `JSONRPC_INVALID_PARAMS`      | const | `-32602` — the method's parameters were invalid.                                                                     |
| `JSONRPC_INTERNAL_ERROR`      | const | `-32603` — every contained MODERN fault: provider, handler, continuation, capacity, stream source, or serialization. |
| `JSONRPC_SERVER_ERROR`        | const | `-32000` — the code `MCPLegacy` alone uses, for a modern result the dated revision cannot represent.                 |
| `DEFAULT_MCP_CLIENT_NAME`     | const | `'taverna'` — the default client name reported in the `initialize` handshake.                                        |
| `DEFAULT_MCP_CLIENT_VERSION`  | const | `'1.0.0'` — the default client version reported in the `initialize` handshake.                                       |
| `DEFAULT_MCP_REQUEST_TIMEOUT` | const | `30000` — the default per-request deadline (ms) an `MCPClient` applies.                                              |
| `DEFAULT_MCP_PROBE_TIMEOUT`   | const | `50` — the maximum configured discovery-probe deadline in milliseconds.                                              |

### Helpers

| API                                | Kind     | Summary                                                                                                                                                                                                                       |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isJSONRPCId`                      | function | Total guard: a JSON-RPC correlation id — a string or a finite integer; `undefined` and `null` are both refused.                                                                                                               |
| `isBoundedString`                  | function | Total guard for a string within a UTF-8 byte bound.                                                                                                                                                                           |
| `isBoundedJSON`                    | function | Total iterative exact-JSON guard within byte/key/depth bounds; hostile-looking own keys remain data.                                                                                                                          |
| `isJSONObject`                     | function | Total guard for an exact finite JSON object.                                                                                                                                                                                  |
| `isMCPMetaKey`                     | function | Total guard for the dated optional-prefix MCP metadata-key grammar.                                                                                                                                                           |
| `isMCPMetaObject`                  | function | Total guard for exact finite MCP metadata with valid keys.                                                                                                                                                                    |
| `isMCPResultMetaObject`            | function | Total result-metadata guard enforcing the reserved server identity while retaining open valid keys.                                                                                                                           |
| `isMCPLoggingLevel`                | function | Total guard for the eight dated logging-level literals.                                                                                                                                                                       |
| `isMCPIdentity`                    | function | Total guard for a complete dated implementation identity.                                                                                                                                                                     |
| `isMCPClientCapabilities`          | function | Total guard for exact open dated client capabilities and prefixed extensions.                                                                                                                                                 |
| `isMCPServerCapabilities`          | function | Total guard for exact open dated server capabilities and prefixed extensions.                                                                                                                                                 |
| `isMCPAnnotations`                 | function | Total guard for dated-schema audience, priority, and last-modified content annotations.                                                                                                                                       |
| `isMCPIcon`                        | function | Total guard for one dated-schema sized and themed icon.                                                                                                                                                                       |
| `isMCPTextResource`                | function | Total guard for embedded textual resource contents.                                                                                                                                                                           |
| `isMCPBlobResource`                | function | Total guard for embedded base64 blob resource contents.                                                                                                                                                                       |
| `isMCPContent`                     | function | Total guard for the complete dated-schema rich-content union.                                                                                                                                                                 |
| `isMCPPaginationParams`            | function | Total guard for the shared cursor parameters: a present `cursor` is a string.                                                                                                                                                 |
| `isMCPResource`                    | function | Total guard for one `resources/list` descriptor, `uri` checked as an absolute URI.                                                                                                                                            |
| `isMCPResourceTemplate`            | function | Total guard for one resource-template descriptor. It validates the descriptor SHAPE only — the `uriTemplate` is never parsed, and no RFC 6570 level is implied.                                                               |
| `isMCPResourceContents`            | function | Total guard for structurally discriminated read contents: exactly one of `text` and `blob`, never both and never neither.                                                                                                     |
| `isMCPResourcePage`                | function | Total guard for one consumer-owned resource page and its optional cursor.                                                                                                                                                     |
| `isMCPResourceTemplatePage`        | function | Total guard for one consumer-owned resource-template page and its optional cursor.                                                                                                                                            |
| `isMCPStringArguments`             | function | Total guard: every own value of an argument record is a string, which is what the prompt and completion wire shapes require.                                                                                                  |
| `isMCPPromptArgument`              | function | Total guard for one prompt-argument descriptor.                                                                                                                                                                               |
| `isMCPPrompt`                      | function | Total guard for one `prompts/list` descriptor and its declared arguments.                                                                                                                                                     |
| `isMCPPromptMessage`               | function | Total guard for one prompt message — a `user` / `assistant` role over the existing rich-content union.                                                                                                                        |
| `isMCPPromptPage`                  | function | Total guard for one consumer-owned prompt page and its optional cursor.                                                                                                                                                       |
| `isMCPPromptGetResult`             | function | Total guard for a complete `prompts/get` result and every message in it.                                                                                                                                                      |
| `isMCPCompletionReference`         | function | Total guard for the two-armed completion reference, discriminated by the wire's `type`.                                                                                                                                       |
| `isMCPCompletionParams`            | function | Total guard for one `completion/complete` parameter object, including its optional string-valued context.                                                                                                                     |
| `isMCPCompletion`                  | function | Total guard for one host-produced candidate set — string values, a nonnegative integer `total`, a boolean `hasMore`.                                                                                                          |
| `isMCPCompletionResult`            | function | Total guard for the stamped completion result, ENFORCING the 100-value cap, so it recognizes only a result this server would produce.                                                                                         |
| `isMCPCallResult`                  | function | Total guard for a required complete modern tool result and exact JSON structured content.                                                                                                                                     |
| `isMCPProgress`                    | function | Total guard for the finite dated-schema progress payload.                                                                                                                                                                     |
| `isStandardBase64`                 | function | Total guard for standard padded JSON Schema `byte` values.                                                                                                                                                                    |
| `isAbsoluteURI`                    | function | Total host-neutral RFC 3986 URI syntax guard; it does not normalize, resolve, fetch, or decode.                                                                                                                               |
| `isRFC3339Date`                    | function | Total guard for an RFC 3339 `full-date` naming a day that exists, month lengths and the Gregorian leap rule included.                                                                                                         |
| `isRFC3339DateTime`                | function | Total guard for an RFC 3339 `date-time` — the same calendar check, the `T` separator, and a mandatory `Z` or `±HH:MM` offset.                                                                                                 |
| `isJSONRPCRequest`                 | function | Total guard: `jsonrpc: '2.0'` + a string `method` + an `id` — an id-less call is a notification, not a request.                                                                                                               |
| `isJSONRPCNotification`            | function | Total guard: the same call owning NO `id` member; mutually exclusive with `isJSONRPCRequest` on every input.                                                                                                                  |
| `isJSONRPCInvocation`              | function | Total guard — the union of `isJSONRPCRequest` and `isJSONRPCNotification`, so a positive answer names one arm.                                                                                                                |
| `isJSONRPCResultResponse`          | function | Total guard: the success arm — a required `id`, an OBJECT `result`, and no `error` member.                                                                                                                                    |
| `isJSONRPCError`                   | function | Total structural guard for the `error` MEMBER — an integer `code` and a string `message`; `data` stays `unknown`.                                                                                                             |
| `isJSONRPCErrorResponse`           | function | Total guard: the failure arm — an OPTIONAL `id` (absent, never `null`), an `error` with integer `code` and string `message`, and no `result`.                                                                                 |
| `isJSONRPCResponse`                | function | Total guard — the union of the two mutually exclusive response arms.                                                                                                                                                          |
| `isJSONRPCMessage`                 | function | Total guard — the union of `isJSONRPCInvocation` and `isJSONRPCResponse`.                                                                                                                                                     |
| `isMCPResult`                      | function | Total guard for the open modern result contract: a record with a string `resultType` and, when present, exact result metadata.                                                                                                |
| `isMCPLegacyResult`                | function | Total guard for the legacy arm: a record with NO `resultType`; mutually exclusive with `isMCPResult`.                                                                                                                         |
| `isInitializeRequest`              | function | Total guard — a `JSONRPCInvocation` whose `method` is `'initialize'`.                                                                                                                                                         |
| `isMCPVersion`                     | function | Total guard — narrows a string to a supported `MCPVersion`.                                                                                                                                                                   |
| `isMCPSubscriptionFilter`          | function | Total guard — validates the recognized wire fields of an open modern subscription filter.                                                                                                                                     |
| `isFormElicitationSupported`       | function | Test whether client capabilities authorize form elicitation; an empty `elicitation` object means form-only.                                                                                                                   |
| `isMCPElicitFieldSchema`           | function | Total guard for one restricted single-field form-elicitation schema.                                                                                                                                                          |
| `isMCPElicitSchema`                | function | Total guard for the restricted issued object schema, open to unrecognized annotations.                                                                                                                                        |
| `isMCPElicitForm`                  | function | Total guard for restricted form-mode elicitation parameters.                                                                                                                                                                  |
| `isMCPElicitURL`                   | function | Total guard for URL-mode elicitation parameters.                                                                                                                                                                              |
| `isMCPElicitRequest`               | function | Total guard for an embedded `elicitation/create` request.                                                                                                                                                                     |
| `isMCPInputRequest`                | function | Total guard for one legal elicitation, deprecated sampling, or deprecated roots input request.                                                                                                                                |
| `isMCPInputRequestMap`             | function | Total guard for the server-keyed input-request map.                                                                                                                                                                           |
| `isMCPElicitResult`                | function | Total guard for an elicitation action and its optional primitive form content.                                                                                                                                                |
| `isElicitContent`                  | function | Total guard checking accepted content against the EXACT issued schema; undeclared properties stay valid, an unenforceable schema admits nothing.                                                                              |
| `isMCPInputResult`                 | function | Total guard for `input_required`, including the runtime at-least-one-of rule.                                                                                                                                                 |
| `isTaskSupported`                  | function | Test whether client capabilities declare the draft Tasks extension; presence under `extensions` is the whole declaration.                                                                                                     |
| `isMCPTaskStatus`                  | function | Total guard for the extension's five task lifecycle states.                                                                                                                                                                   |
| `isMCPTaskResult`                  | function | Total guard for the flat `resultType: 'task'` creation answer, `ttlMs: null` included.                                                                                                                                        |
| `isMCPTaskDetail`                  | function | Total guard for one task snapshot, enforcing the payload its `status` owes; unrecognized draft members stay valid.                                                                                                            |
| `isModernRequest`                  | function | Total guard — modern iff `params._meta` carries the reserved protocol-version key.                                                                                                                                            |
| `isMCPError`                       | function | Total guard — `true` only for a real `MCPError`.                                                                                                                                                                              |
| `parseJSONRPCMessage`              | function | Return a bounded frozen owned `JSONRPCMessage`, or `undefined`; optional limits override the content-byte/default-depth boundary.                                                                                             |
| `parseRequestContext`              | function | Return a frozen owned modern request projection, or `undefined` for malformed required metadata.                                                                                                                              |
| `parseMCPInputState`               | function | Parse opened request state into its principal/expiry/original-id/version/method/tool/digest/key/schema/application bindings.                                                                                                  |
| `inferEra`                         | function | Map a supported revision to `modern` or `legacy`; unsupported revisions return `undefined`.                                                                                                                                   |
| `inferVersion`                     | function | Select the newest locally supported revision present in a peer's offer.                                                                                                                                                       |
| `inferRequestVersion`              | function | Project the protocol version a modern request announces itself with — the ONE derivation both HTTP client transports stamp `mcp-protocol-version` from, and the same read the server's own header expectation performs.       |
| `buildJSONRPCResult`               | function | Build a success `JSONRPCResultResponse` — the required `id` echoed, the value as `result`.                                                                                                                                    |
| `buildJSONRPCError`                | function | Build a `JSONRPCErrorResponse` — a reserved `code` / `message`, optional `data`, and the `id` OMITTED entirely when none could be read.                                                                                       |
| `buildMethodOptions`               | function | Resolve caller-facing dispatch options into the method options every handler receives, composing the caller's signal with the request lifetime.                                                                               |
| `buildToolDescriptors`             | function | Map a `ToolManagerInterface`'s definitions to `tools/list` descriptors, renaming `parameters` → `inputSchema`.                                                                                                                |
| `buildToolCall`                    | function | Build the canonical `ToolCall` supplied to the default manager or explicit executor.                                                                                                                                          |
| `buildProgressNotification`        | function | Build the official `notifications/progress` message with its original opaque token.                                                                                                                                           |
| `buildCancelledNotification`       | function | Build the official `notifications/cancelled` message naming one already-sent request; fire-and-forget, and only for a carrier declaring `duplex`.                                                                             |
| `buildCallOutcome`                 | function | Narrow one `tools/call` answer to the arm the peer chose, preferring `structuredContent` by presence and throwing a remote `isError: true`.                                                                                   |
| `extractContentText`               | function | Concatenate a result's text content blocks into one string; TOTAL, so an off-shape result contributes nothing rather than throwing.                                                                                           |
| `matchesResultType`                | function | Whitelist test of whether one method may legally answer with a given modern `resultType`; only `tools/call` may answer `task` or `input_required`.                                                                            |
| `snapshotJSON`                     | function | Own one bounded exact JSON value as a deeply frozen graph paired with its canonical wire text.                                                                                                                                |
| `snapshotToolResult`               | function | Own one exact four-property Tool result, bounding and serializing only a defined successful value.                                                                                                                            |
| `serializeJSON`                    | function | Canonically serialize exact JSON within explicit byte/key/depth bounds.                                                                                                                                                       |
| `digestJSON`                       | function | Compute the lowercase host-neutral SHA-256 digest of bounded canonical JSON.                                                                                                                                                  |
| `buildDiscoverResult`              | function | Build the required modern `server/discover` result with supported revisions and cache stamps.                                                                                                                                 |
| `buildModernResult`                | function | Stamp a modern result with `resultType`, server metadata, and cache fields only when a TTL is supplied.                                                                                                                       |
| `buildSubscriptionFilter`          | function | Intersect requested notification families and resource URIs with the server's declared support.                                                                                                                               |
| `matchesSubscriptionNotification`  | function | Test whether a produced notification belongs to an acknowledged subscription filter.                                                                                                                                          |
| `stampSubscriptionNotification`    | function | Stamp a delivered notification with its reserved subscription id while preserving other params and metadata.                                                                                                                  |
| `buildSubscriptionAcknowledgement` | function | Build the first id-carrying acknowledgement with the exact honoured notification subset.                                                                                                                                      |
| `buildSubscriptionResult`          | function | Build the graceful complete result carrying the request id as subscription identity.                                                                                                                                          |
| `buildInitializeResult`            | function | Build the `initialize` result — the negotiated `protocolVersion`, `capabilities`, and `serverInfo`.                                                                                                                           |
| `decodeBoundedMessage`             | function | Decode one raw inbound message within an explicit bound, measuring the string BEFORE parsing it; total.                                                                                                                       |
| `readCancelledId`                  | function | Read the request id an inbound `notifications/cancelled` names — the inverse of `buildCancelledNotification`; total.                                                                                                          |
| `sendStream`                       | function | Pump a controlled serialized exchange onto an `MCPTransportInterface` — every notification, the terminal last, and the exchange ENDED on every exit.                                                                          |
| `bindServer`                       | function | Pipe an `MCPTransportInterface` into an `MCPDispatcherInterface` — inbound decoded within the server's own bound and `handle`d under a per-request signal, a defined reply `send`, a held-open one pumped; returns an unbind. |
| `bindClient`                       | function | Pipe an `MCPTransportInterface` into an `MCPClientInterface` (built over `createDuplexClientTransport`) — completes the inbound wiring; returns an unbind.                                                                    |

### Types

| Type                                  | Kind      | Shape                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JSONRPCId`                           | type      | `string \| number` — the correlation value a request and its response share. `null` is not an id.                                                                                                                                                                                                                                                                                                     |
| `JSONRPCRequest`                      | interface | `{ jsonrpc: '2.0'; method: string; id: JSONRPCId; params?: Record<string, unknown> }` — `id` is REQUIRED; an id-less call is a `JSONRPCNotification` instead.                                                                                                                                                                                                                                         |
| `JSONRPCNotification`                 | interface | `{ jsonrpc: '2.0'; method: string; id?: never; params?: Record<string, unknown> }` — `id` is declared `never`, so a request is not assignable here.                                                                                                                                                                                                                                                   |
| `JSONRPCInvocation`                   | type      | `JSONRPCRequest \| JSONRPCNotification` — one inbound call; narrow the arms with `invocation.id === undefined`.                                                                                                                                                                                                                                                                                       |
| `JSONRPCError`                        | interface | `{ code: number; message: string; data?: unknown }` — the `error` member of a failed response.                                                                                                                                                                                                                                                                                                        |
| `JSONRPCResultResponse`               | interface | `{ jsonrpc: '2.0'; id: JSONRPCId; result: MCPResult \| MCPLegacyResult; error?: never }` — the success arm; `id` is required and `error` forbidden.                                                                                                                                                                                                                                                   |
| `JSONRPCErrorResponse`                | interface | `{ jsonrpc: '2.0'; id?: JSONRPCId; error: JSONRPCError; result?: never }` — the failure arm, and the ONE place `id` may be ABSENT (omitted, never `null`).                                                                                                                                                                                                                                            |
| `JSONRPCResponse`                     | type      | `JSONRPCResultResponse \| JSONRPCErrorResponse` — narrow the arms with `response.error === undefined`.                                                                                                                                                                                                                                                                                                |
| `JSONRPCMessage`                      | type      | `JSONRPCInvocation \| JSONRPCResponse` — a message on the wire; `'method' in message` narrows to the invocation half.                                                                                                                                                                                                                                                                                 |
| `MCPResult`                           | interface | `{ resultType: string; _meta?: MCPResultMetaObject; [key: string]: unknown }` — the OPEN modern contract every dated-revision result satisfies.                                                                                                                                                                                                                                                       |
| `MCPLegacyResult`                     | interface | `{ resultType?: never; [key: string]: unknown }` — the legacy arm, disjoint from `MCPResult` in both directions because the legacy revision has no discriminator.                                                                                                                                                                                                                                     |
| `MCPVersion`                          | type      | `'2026-07-28' \| '2025-11-25' \| '2025-06-18'` — a supported protocol revision.                                                                                                                                                                                                                                                                                                                       |
| `MCPMetaObject`                       | type      | Open readonly MCP metadata map whose values are exact finite `JSONValue`; runtime keys follow the dated metadata grammar. The `Object` suffix names the JSON-object SHAPE rather than a role.                                                                                                                                                                                                         |
| `MCPResultMetaObject`                 | type      | Open result metadata with an optional exact reserved `io.modelcontextprotocol/serverInfo` identity.                                                                                                                                                                                                                                                                                                   |
| `MCPLoggingLevel`                     | type      | The eight dated debug-through-emergency logging-level literals.                                                                                                                                                                                                                                                                                                                                       |
| `MCPClientCapabilities`               | type      | Open client capability map with JSON-object values and exact dated known fields.                                                                                                                                                                                                                                                                                                                      |
| `MCPServerCapabilities`               | type      | Open server capability map with JSON-object values and exact dated known fields.                                                                                                                                                                                                                                                                                                                      |
| `MCPEra`                              | type      | `'modern' \| 'legacy'` — the structural wire era, and a genuine protocol discriminant rather than a boolean switch: it names which published wire shape a request took and is published on the `request` event.                                                                                                                                                                                       |
| `MCPRole`                             | type      | `'user' \| 'assistant'` — the intended audience of annotated content.                                                                                                                                                                                                                                                                                                                                 |
| `MCPAnnotations`                      | interface | Optional audience, priority, and last-modified hints.                                                                                                                                                                                                                                                                                                                                                 |
| `MCPIcon`                             | type      | Open metadata intersection with `{ src; mimeType?; sizes?; theme? }` for one resource-link icon.                                                                                                                                                                                                                                                                                                      |
| `MCPTextContent`                      | interface | Exact text content block with optional annotations and metadata.                                                                                                                                                                                                                                                                                                                                      |
| `MCPImageContent`                     | interface | Exact base64 image content block with MIME type, annotations, and metadata.                                                                                                                                                                                                                                                                                                                           |
| `MCPAudioContent`                     | interface | Exact base64 audio content block with MIME type, annotations, and metadata.                                                                                                                                                                                                                                                                                                                           |
| `MCPResourceLink`                     | interface | Exact named resource link, including title, icons, URI, MIME, size, annotations, and metadata.                                                                                                                                                                                                                                                                                                        |
| `MCPTextResource`                     | interface | Embedded textual resource contents.                                                                                                                                                                                                                                                                                                                                                                   |
| `MCPBlobResource`                     | interface | Embedded base64 blob resource contents.                                                                                                                                                                                                                                                                                                                                                               |
| `MCPEmbeddedResource`                 | interface | Embedded text/blob resource content block.                                                                                                                                                                                                                                                                                                                                                            |
| `MCPContent`                          | type      | Dated-schema union of text, image, audio, resource-link, and embedded-resource content.                                                                                                                                                                                                                                                                                                               |
| `MCPUnstampedCallResult`              | type      | `{ content; structuredContent?; isError?; _meta? }` — a `tools/call` result BEFORE the modern stamp, which is the only shape the legacy revision has for one.                                                                                                                                                                                                                                         |
| `MCPCallResult`                       | type      | Required modern complete tool result: `MCPUnstampedCallResult & { resultType: 'complete' }`.                                                                                                                                                                                                                                                                                                          |
| `MCPPaginationParams`                 | interface | `{ cursor? }` — the ONE cursor-in shape every paginated modern list method takes. The cursor is opaque and the manager mints it.                                                                                                                                                                                                                                                                      |
| `MCPPaginationResult`                 | interface | `{ nextCursor? }` — the ONE cursor-out shape they answer with; an absent `nextCursor` means this was the final page.                                                                                                                                                                                                                                                                                  |
| `MCPResource`                         | interface | One `resources/list` descriptor — `{ uri; name; title?; description?; mimeType?; annotations?; size?; icons?; _meta? }`.                                                                                                                                                                                                                                                                              |
| `MCPResourceTemplate`                 | interface | One `resources/templates/list` descriptor — `{ uriTemplate; name; … }`. The `uriTemplate` is published as a STRING; this package never parses or expands it.                                                                                                                                                                                                                                          |
| `MCPResourceContents`                 | type      | `resources/read` contents, structurally discriminated: exactly one of `text` and `blob` (base64), with the other member forbidden, because the wire carries no tag field.                                                                                                                                                                                                                             |
| `MCPResourcePage`                     | interface | `MCPPaginationResult & { resources }` — one consumer-owned page, before MCP stamps it.                                                                                                                                                                                                                                                                                                                |
| `MCPResourceTemplatePage`             | interface | `MCPPaginationResult & { resourceTemplates }` — the template equivalent.                                                                                                                                                                                                                                                                                                                              |
| `MCPResourceReadParams`               | interface | `{ uri; inputResponses?; requestState? }` — a CONCRETE uri plus the optional multi-round continuation carriers.                                                                                                                                                                                                                                                                                       |
| `MCPResourceListResult`               | type      | The stamped cacheable `resources/list` answer: the page plus `resultType: 'complete'`, `ttlMs`, and `cacheScope`.                                                                                                                                                                                                                                                                                     |
| `MCPResourceReadResult`               | type      | The stamped cacheable `resources/read` answer: `{ contents }` plus the same three stamps.                                                                                                                                                                                                                                                                                                             |
| `MCPResourceTemplateListResult`       | type      | The stamped cacheable `resources/templates/list` answer.                                                                                                                                                                                                                                                                                                                                              |
| `MCPResourceManagerInterface`         | interface | The consumer-supplied resource registry port — the `resources` / `resource` / `templates` methods. MCP owns no storage and no template engine.                                                                                                                                                                                                                                                        |
| `MCPPromptArgument`                   | interface | `{ name; title?; description?; required? }` — one argument a prompt declares.                                                                                                                                                                                                                                                                                                                         |
| `MCPPrompt`                           | interface | One `prompts/list` descriptor — `{ name; title?; description?; arguments?; icons?; _meta? }`.                                                                                                                                                                                                                                                                                                         |
| `MCPPromptMessage`                    | interface | `{ role: 'user' \| 'assistant'; content: MCPContent }` — one message, reusing the existing five-member content union rather than a second one.                                                                                                                                                                                                                                                        |
| `MCPPromptPage`                       | interface | `MCPPaginationResult & { prompts }` — one consumer-owned prompt page.                                                                                                                                                                                                                                                                                                                                 |
| `MCPPromptGetParams`                  | interface | `{ name; arguments?; inputResponses?; requestState? }` — argument VALUES are strings by contract.                                                                                                                                                                                                                                                                                                     |
| `MCPPromptListResult`                 | type      | The stamped cacheable `prompts/list` answer.                                                                                                                                                                                                                                                                                                                                                          |
| `MCPPromptGetResult`                  | interface | `{ resultType: 'complete'; description?; messages; _meta? }` — the complete `prompts/get` answer, and the one result in this family that is NOT cacheable, so it carries no `ttlMs` / `cacheScope`.                                                                                                                                                                                                   |
| `MCPPromptManagerInterface`           | interface | The consumer-supplied prompt registry port — the `prompts` / `prompt` methods, mirroring the resource port's singular/plural pair.                                                                                                                                                                                                                                                                    |
| `MCPPromptReference`                  | interface | `{ type: 'ref/prompt'; name }` — a completion reference to one named prompt.                                                                                                                                                                                                                                                                                                                          |
| `MCPResourceTemplateReference`        | interface | `{ type: 'ref/resource'; uri }` — a completion reference whose `uri` may itself be a template, forwarded VERBATIM to the host.                                                                                                                                                                                                                                                                        |
| `MCPCompletionReference`              | type      | `MCPPromptReference \| MCPResourceTemplateReference` — the two arms `completion/complete` accepts, discriminated by the wire's own `type`.                                                                                                                                                                                                                                                            |
| `MCPCompletionArgument`               | interface | `{ name; value }` — the argument fragment being completed.                                                                                                                                                                                                                                                                                                                                            |
| `MCPCompletionContext`                | interface | `{ arguments? }` — previously resolved string arguments supplied as completion context.                                                                                                                                                                                                                                                                                                               |
| `MCPCompletionParams`                 | interface | `{ ref; argument; context? }` — the parameters of one `completion/complete` request.                                                                                                                                                                                                                                                                                                                  |
| `MCPCompletion`                       | interface | `{ values; total?; hasMore? }` — the host's candidate set, BEFORE the protocol's 100-value projection.                                                                                                                                                                                                                                                                                                |
| `MCPCompletionResult`                 | interface | `{ resultType: 'complete'; completion; _meta? }` — the stamped answer, capped at 100 values with `hasMore: true` when the cap truncated.                                                                                                                                                                                                                                                              |
| `MCPCompletionManagerInterface`       | interface | The consumer-supplied completion port — the single `complete` method. Independent of the other two ports, because `completions` is a top-level capability.                                                                                                                                                                                                                                            |
| `MCPElicitValue`                      | type      | Primitive form-response value: string, number, boolean, or a readonly string list.                                                                                                                                                                                                                                                                                                                    |
| `MCPElicitChoice`                     | interface | `{ const; title }` — one titled value in a form single- or multi-select schema.                                                                                                                                                                                                                                                                                                                       |
| `MCPElicitFieldSchema`                | type      | Restricted boolean, numeric, string, single-select, or multi-select schema for ONE form field.                                                                                                                                                                                                                                                                                                        |
| `MCPElicitSchema`                     | interface | Restricted top-level object schema for form elicitation, whose `properties` are `MCPElicitFieldSchema`s.                                                                                                                                                                                                                                                                                              |
| `MCPElicitForm`                       | interface | `{ mode?: 'form'; message; requestedSchema }` — form-mode elicitation parameters.                                                                                                                                                                                                                                                                                                                     |
| `MCPElicitURL`                        | interface | `{ mode: 'url'; message; url }` — URL-mode elicitation parameters retained by the protocol shape but not produced here.                                                                                                                                                                                                                                                                               |
| `MCPElicitParams`                     | type      | `MCPElicitForm \| MCPElicitURL` — the mode-discriminated parameters of an `elicitation/create` request.                                                                                                                                                                                                                                                                                               |
| `MCPElicitRequest`                    | interface | `{ method: 'elicitation/create'; params: MCPElicitParams }` — one embedded elicitation request.                                                                                                                                                                                                                                                                                                       |
| `MCPElicitResult`                     | interface | `{ action: 'accept' \| 'decline' \| 'cancel'; content? }` — the client response to elicitation.                                                                                                                                                                                                                                                                                                       |
| `MCPInputRequest`                     | type      | Legal embedded request union; MCP produces only `MCPElicitRequest`, while deprecated sampling/roots shapes remain legal.                                                                                                                                                                                                                                                                              |
| `MCPInputRequestMap`                  | type      | Readonly server-keyed map of `MCPInputRequest` values.                                                                                                                                                                                                                                                                                                                                                |
| `MCPInputResult`                      | type      | Two-arm `input_required` union enforcing at least one of `inputRequests` / `requestState`.                                                                                                                                                                                                                                                                                                            |
| `MCPInputState`                       | interface | Protected principal, absolute `expiry`, original request `id`, version, method, tool, argument digest, response key, the exact issued `schema`, and optional JSON application state.                                                                                                                                                                                                                  |
| `MCPInputContext`                     | interface | Call-in-hand context given to the input hook, including a verified elicitation response/state on retry.                                                                                                                                                                                                                                                                                               |
| `MCPElicitation`                      | interface | Consumer-requested form params plus optional opaque consumer state, before MCP assigns a key and signs it.                                                                                                                                                                                                                                                                                            |
| `MCPInputHandler`                     | type      | `(context, options) => MCPElicitation \| undefined` (or a promise) — request operator input or continue to tool execution.                                                                                                                                                                                                                                                                            |
| `MCPPrincipalHandler`                 | type      | `(request, options: MCPDispatchOptions) => string` (or a promise) — derives the authenticated principal bound into protected state.                                                                                                                                                                                                                                                                   |
| `MCPContinuationInterface`            | interface | Host-neutral `seal` / `open` integrity or durable-handle port for canonical continuation state.                                                                                                                                                                                                                                                                                                       |
| `MCPInputOptions`                     | interface | `{ continuation; ttl; principal; elicit }` — consumer policy for MRTR production and verification.                                                                                                                                                                                                                                                                                                    |
| `MCPTaskStatus`                       | type      | `'working' \| 'input_required' \| 'completed' \| 'failed' \| 'cancelled'` — one durable task's lifecycle state; the last three are terminal. Its `input_required` is a DIFFERENT mechanism from `MCPInputResult`'s identically spelled `resultType`.                                                                                                                                                  |
| `MCPTask`                             | type      | `{ taskId; status; statusMessage?; createdAt; lastUpdatedAt; ttlMs: number \| null; pollIntervalMs? }` — one task's wire snapshot; every field name is a verbatim draft-schema spelling and `ttlMs: null` means no expiry.                                                                                                                                                                            |
| `MCPTaskDetail`                       | type      | `MCPTask` narrowed by `status`: `input_required` adds `inputRequests`, `completed` adds `result`, `failed` adds `error`, `working` / `cancelled` add nothing — the shape `tasks/get` answers with.                                                                                                                                                                                                    |
| `MCPTaskResult`                       | type      | `MCPTask & { resultType: 'task'; _meta? }` — the FLAT creation answer, and the only result in this package whose `resultType` is `'task'`.                                                                                                                                                                                                                                                            |
| `MCPTaskContext`                      | interface | `{ request; call; tools }` — the call in hand given to `defer` and to `start`. It carries NO cancellation signal, deliberately: `options.signal` is the request's lifetime, which ends when the handle is written.                                                                                                                                                                                    |
| `MCPTaskManagerInterface`             | interface | The consumer-owned durable store — the `start` / `task` / `update` / `abort` methods. There is deliberately no plural accessor, because the extension defines no `tasks/list`.                                                                                                                                                                                                                        |
| `MCPTaskHandler`                      | type      | `(context, options) => string \| undefined` (or a promise) — the server-decided deferral policy, answering the stable operation key or `undefined` to run the call inline.                                                                                                                                                                                                                            |
| `MCPTaskOptions`                      | interface | `{ tasks; defer }` — consumer policy for the DRAFT Tasks extension; supplying it is what registers `tasks/get` / `tasks/update` / `tasks/cancel`.                                                                                                                                                                                                                                                     |
| `MCPProgress`                         | interface | Official `{ progress; total?; message? }` request progress payload.                                                                                                                                                                                                                                                                                                                                   |
| `MCPProgressInterface`                | interface | Backpressured reporter exposing `report(progress)`.                                                                                                                                                                                                                                                                                                                                                   |
| `MCPExecutionContext`                 | interface | Explicit execution context containing `request`, canonical `call`, real `tools`, effective `signal`, and optional `progress`.                                                                                                                                                                                                                                                                         |
| `MCPExecutionHandler`                 | type      | Host-neutral handler returning `ToolResult \| MCPCallResult`, synchronously or asynchronously.                                                                                                                                                                                                                                                                                                        |
| `MCPListResult`                       | type      | `{ tools; resultType: 'complete'; ttlMs; cacheScope; _meta? }` — the modern cacheable `tools/list` result; the unstamped legacy answer is an `MCPLegacyResult` instead, so no stamp here is optional.                                                                                                                                                                                                 |
| `MCPToolDescriptor`                   | interface | `{ name: string; description?: string; inputSchema: Record<string, unknown> }` — one `tools/list` entry.                                                                                                                                                                                                                                                                                              |
| `MCPIdentity`                         | type      | Open metadata intersection with the dated `{ name; version; title?; description?; websiteUrl?; icons? }` identity fields.                                                                                                                                                                                                                                                                             |
| `MCPRequestContext`                   | interface | `{ version; capabilities: MCPClientCapabilities; identity? }` — validated modern request metadata.                                                                                                                                                                                                                                                                                                    |
| `MCPDiscoverResult`                   | type      | Required modern discovery fields with exact `MCPServerCapabilities`, complete/cache stamps, optional instructions, and exact metadata.                                                                                                                                                                                                                                                                |
| `MCPSubscriptionFilter`               | interface | Optional tool, prompt, resource-list, and resource-URI notification families for `subscriptions/listen`; its four keys are verbatim wire spellings.                                                                                                                                                                                                                                                   |
| `SubscriptionsListenResultMetaObject` | type      | Result-metadata intersection requiring the reserved subscription id.                                                                                                                                                                                                                                                                                                                                  |
| `SubscriptionsListenResult`           | type      | `{ resultType: 'complete'; _meta: SubscriptionsListenResultMetaObject }` — a graceful subscription closure.                                                                                                                                                                                                                                                                                           |
| `MCPDispatchOptions`                  | interface | `{ signal?: AbortSignal; caller?: unknown }` — the CALLER-facing per-request options; `caller` is consumer-asserted and never protocol-verified, inspected, validated, or serialized by this package.                                                                                                                                                                                                 |
| `MCPMethodOptions`                    | interface | `{ signal: AbortSignal; caller?: unknown }` — the RESOLVED mirror a dispatched method receives; `signal` is required because dispatch resolves one at the single ingress.                                                                                                                                                                                                                             |
| `MCPSubscriptionHandler`              | type      | `(notifications, options) => AsyncIterable<JSONRPCNotification>` (or a promise of one) — an event-driven notification producer.                                                                                                                                                                                                                                                                       |
| `MCPSubscriptionOptions`              | interface | `{ notifications; listen }` — the supported filter and producer for the built-in subscription method.                                                                                                                                                                                                                                                                                                 |
| `MCPStream`                           | type      | `AsyncGenerator<JSONRPCNotification, JSONRPCResponse, unknown>` — a held-open result: each `yield` is a notification (the yield type forbids an `id`), the `return` value is the terminating response.                                                                                                                                                                                                |
| `MCPTextStream`                       | type      | `AsyncGenerator<string, string, unknown>` — the string-boundary mirror of `MCPStream`, the same sequence already serialized.                                                                                                                                                                                                                                                                          |
| `MCPStreamControllerInterface`        | interface | `MCPStream` plus `stop()` and `[Symbol.asyncDispose]` — a held-open answer whose cancellation ONE owner arbitrates, settling its consumer without waiting on the producer; what every stream leaving `dispatch` is. Ending it is the obligation of whoever is handed it, on EVERY exit, and there is no owner of last resort.                                                                         |
| `MCPTextStreamControllerInterface`    | interface | `MCPTextStream` plus `stop()` and `[Symbol.asyncDispose]` — the serialized mirror, delegating every lifecycle decision (disposal included) into the typed exchange rather than owning a second queue; what every stream leaving `handle` is.                                                                                                                                                          |
| `MCPMethodHandler`                    | type      | `(request, options) => Promise<JSONRPCResponse \| MCPStream>` — one modern method. It receives the REQUEST arm alone, because dispatch short-circuits every notification before the registry is read, and answering is not optional: dispatch contains an absent answer as `-32603` plus one `error` event.                                                                                           |
| `MCPMethodManagerInterface`           | interface | The modern method registry — the `add` / `method` methods, carrying both the built-in methods and any method a consumer adds.                                                                                                                                                                                                                                                                         |
| `MCPServerEventMap`                   | type      | `{ request: [method: string, id: JSONRPCId \| undefined, era: MCPEra]; error: [unknown] }` — the observation surface; `id` is `undefined` for a notification, `era` is selected structurally per request, and `error` carries the caught value of every fault the server contained, exactly once, plus bound-transport faults.                                                                        |
| `MCPLimitOptions`                     | interface | `{ message?; metadata?; keys?; state?; content?; subscriptions?; depth? }` — configurable server bounds; malformed/absent leaves use secure defaults.                                                                                                                                                                                                                                                 |
| `MCPJSONLimitOptions`                 | interface | `{ bytes; keys?; depth }` — byte/key/depth bounds consumed by `isBoundedJSON`.                                                                                                                                                                                                                                                                                                                        |
| `MCPServerOptions`                    | interface | `{ on?; error?; identity; tools; resources?; prompts?; completion?; execution?; instructions?; cache?; input?; subscription?; task?; limit? }` — options for `createMCPServer`; each of `resources` / `prompts` / `completion` registers its own method family, and `task` opts into the DRAFT Tasks extension.                                                                                       |
| `MCPDispatcherInterface`              | interface | `emitter` / `limit` data members + the `dispatch` / `handle` methods — the MINIMAL surface a transport needs, and the one `MCPServerInterface` extends. All five doors take THIS — `createMCPRoutes`, `createMCPPostHandler`, `createWebSocketServer`, `createStdioServer`, and `bindServer` — which is what lets `MCPLegacy` sit between any of them and the server without either knowing.          |
| `MCPServerInterface`                  | interface | `emitter` / `identity` / `methods` / `limit` data members + the `dispatch` / `handle` methods, extending `MCPDispatcherInterface`. `limit` is the resolved `Required<MCPLimitOptions>` the server actually enforces, frozen and derived from `MCPServerOptions.limit`, so code in front of the server refuses at the same byte it does.                                                               |
| `MCPLegacyOptions`                    | interface | `{ dispatcher; identity }` — the sole modern dispatcher `MCPLegacy` translates onto and the identity its `initialize` handshake reports. It holds no engine, no store, and no era flag, because the decorator owns none of the three.                                                                                                                                                                 |
| `MCPTransportInterface`               | interface | `{ send(message: string): void \| Promise<void>; listen(handler): void; closed(handler): void; close(): void \| Promise<void> }` — the environment-agnostic duplex message-channel port `bindServer` / `bindClient` drive. `listen` and `closed` are single-handler REGISTRARS (a second call replaces the first), which is why the terminal one reads as an adjective beside the imperative `close`. |
| `MCPClientTransportEventMap`          | type      | `{ message: [JSONRPCMessage]; close: []; error: [unknown] }` — the transport events.                                                                                                                                                                                                                                                                                                                  |
| `MCPClientTransportInterface`         | interface | `emitter` / `session` data members + the `start` / `send` / `close` methods — the client's transport-agnostic carrier.                                                                                                                                                                                                                                                                                |
| `MCPClientEventMap`                   | type      | `{ connect: []; disconnect: []; notification: [JSONRPCMessage]; error: [unknown] }`.                                                                                                                                                                                                                                                                                                                  |
| `MCPClientOptions`                    | interface | `{ on?; error?; transport; identity?; capabilities?; version?; timeout? }` — options for `createMCPClient`.                                                                                                                                                                                                                                                                                           |
| `MCPProgressHandler`                  | type      | `(progress: MCPProgress) => void` — the caller's per-request progress consumer; supplying one is what stamps the request's progress token, so a peer reports only where someone is listening.                                                                                                                                                                                                         |
| `MCPCallOptions`                      | interface | `{ signal?; progress? }` — per-call policy for one remote `tools/call`. Neither leaf survives the call: `signal` cancels THAT request and never the connection or a durable task, and an already-aborted one refuses it unsent.                                                                                                                                                                       |
| `MCPCallOutcome`                      | type      | `{ resultType: 'complete'; value } \| MCPTaskResult \| MCPInputResult` — the three arms the dated protocol lets a `tools/call` answer with. Narrow on `resultType`; a fourth is refused rather than surfaced.                                                                                                                                                                                         |
| `MCPRequestFunction`                  | type      | `(method, params, deadline) => Promise<unknown>` — the correlated-request door an `MCPTaskClientInterface` issues through. It resolves the peer's `result` UNVALIDATED and rejects with an `MCPError` for an error response.                                                                                                                                                                          |
| `MCPTaskClientOptions`                | interface | `{ request; timeout? }` — construction options for `MCPTaskClient`; an omitted `timeout` leaves every task request unbounded.                                                                                                                                                                                                                                                                         |
| `MCPTaskClientInterface`              | interface | The extension's client half — the `task` / `update` / `abort` methods. `MCPTaskManagerInterface` minus `start`, because creation is never the client's decision, and with the same missing plural accessor.                                                                                                                                                                                           |
| `MCPClientInterface`                  | interface | `emitter` / `connected` / `version` / `transport` / `tasks` data members + the `on` / `connect` / `discover` / `disconnect` / `tools` / `call` methods.                                                                                                                                                                                                                                               |

The `emitter`, `identity`, `methods`, and `limit` members of `MCPServerInterface` are
`readonly` data members (Surface rows, above) — its call-signature methods
are documented under [Methods](#methods), and the registry `methods` exposes
has its own method table there. Likewise the `emitter` /
`connected` / `version` / `transport` / `tasks` members of `MCPClientInterface` and
the `emitter` / `session` members of `MCPClientTransportInterface` are data
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
a compressed/body-size guard is front-middleware policy the consumer composes, same as auth.
The core `limit.message` bound applies specifically where a transport supplies a raw string to
`MCPServer.handle`; the HTTP route owns and parses its Fetch `Request` body before typed dispatch.

```ts
import { createMCPServer } from '@orkestrel/mcp'
import { createMCPRoutes } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
const routes = createMCPRoutes(mcp) // POST /mcp dispatches JSON-RPC (JSON or SSE per Accept)
```

#### Carry asserted caller context from HTTP middleware

`HTTPHandlerOptions<TState>` names the POST handler's `streaming`, `origin`,
`keepalive`, and `caller` options; `HTTPTransportOptions<TState>` extends that
shape with `path`. The caller extractor is the synchronous
`MCPCallerHandler<TState>`:

```ts
type MCPCallerHandler<TState> = (
	request: Request,
	context: RouteContext<string, TState> | undefined,
) => unknown
```

Authentication belongs to ordinary middleware composed in front. The extractor
only reads identity or policy state that middleware already resolved; direct
`createMCPPostHandler` invocation may supply no route context. Returning
`undefined` supplies no caller, while a throw propagates exactly like a route
handler throw.

Extraction runs only after origin, body, JSON-RPC, modern metadata-shape, and
HTTP header validation have all passed, immediately before `mcp.dispatch`. With no
extractor, or when it returns `undefined`, `caller` is omitted through the
package's conditional-spread idiom, preserving the former dispatch-options shape
exactly. A present value flows through both modern and legacy `tools/call` onto
`ToolCall.caller`; the tool manager then supplies it to the real tool body's
caller parameter.

This remains an asserted seam, never protocol authentication. A session id names
an HTTP transport session, not a caller, and the session middleware preserves
front-middleware state across its rebuilt `Request`. WebSocket and stdio ingress
use `bindServer`, which supplies `handle` a per-request abort signal of its own —
the one an inbound `notifications/cancelled` raises — but no caller context: those
transports carry no equivalent of the front-middleware state an HTTP route resolves,
so `caller` stays an HTTP-face seam.

`createMCPRoutes` is **stateless**: a single `POST {path}` route pumps each
request body through `mcp.dispatch`. For a streamed response,
`MCPDispatchOptions.signal` composes the fetch-standard request signal with
response-stream cancellation; the optional session middleware preserves the request
signal when it rebuilds a buffered POST. A malformed JSON body, or a parsed value
that is not a JSON-RPC request, is an HTTP `400` carrying a JSON-RPC error
body (`-32700` / `-32600`, with no `id` member at all). Legacy dispatch results retain uniform
HTTP `200` with in-band errors. Modern responses use `202` for notifications,
`400` for `-32020` / `-32021` / `-32022` / `-32602`, `404` for `-32601`, and
`200` otherwise. A unary reply is framed as one `@orkestrel/server` `openStream`
SSE `data:` event when streaming is enabled and the client accepts event-stream,
then the stream ends with `X-Accel-Buffering: no`; otherwise it is a plain JSON
body. A held-open `MCPStream` always occupies that same SSE seam: every yielded
notification is written in order, the generator's returned response is written
last, and only then does the HTTP stream end. Waiting is on the producer's async
iterator, never polling.

An idle held-open stream writes SSE keepalive comments and notices a disconnect within one
configured keepalive interval, which is how a streamed handler learns its caller left. A
unary response has no such moment — see
[Declared conformance gaps](#declared-conformance-gaps).

A modern POST requires `MCP-Protocol-Version` equal to its reserved `_meta`
version and `Mcp-Method` equal to its body method. `Mcp-Name` is required only
for `tools/call`, equal to `params.name`; `server/discover` and `tools/list`
carry no name. A refusal names the first missing or mismatched field and the expected
value without echoing the supplied value; it is HTTP `400` + `-32020` with no `data`. Headerless
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
applies to session verbs: a canonical loopback-literal origin passes, while every other
present origin requires an exact entry in the shared `origin.origins` list. A deployment
that validates upstream sets `origin.enabled` to `false` on the one options value passed to
both layers. No shared session primitive is composed; the store, mint, and stream are
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

| API                         | Kind     | Summary                                                                                                                                                                                     |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMCPContinuation`     | function | Adapt installed signed-token primitives and secret rotation to the host-neutral core continuation port.                                                                                     |
| `createMCPRoutes`           | function | Mount an `MCPDispatcherInterface` on the router spine — returns the `RouteInput[]` for `router.add(...)`, passing the named transport options through to its single stateless POST handler. |
| `createMCPPostHandler`      | function | Create the stateless Streamable-HTTP POST handler directly, optionally extracting asserted caller context after validation.                                                                 |
| `createHTTPClientTransport` | function | Create a `MCPClientTransportInterface` over `fetch` that drives a REMOTE Streamable-HTTP MCP server (the egress mirror).                                                                    |
| `createMCPSession`          | function | Create the opt-in native session `MiddlewareHandler` — closure store + mint-on-`initialize` + require-404 + the resumable `GET` SSE stream; mount in front of `createMCPRoutes`.            |

#### Entities

| API                   | Kind  | Summary                                                                                                                                                                                                 |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTPClientTransport` | class | The HTTP `MCPClientTransportInterface` over an injectable `fetch` — POSTs each message, decodes the JSON / SSE reply onto the `message` event.                                                          |
| `HTTPDisconnect`      | class | The one-response HTTP lifecycle bridge that composes request abort with response cancellation, forwards SSE bytes, and owns keepalive cleanup.                                                          |
| `MCPSession`          | class | One MCP transport session — its `id` + attached SSE streams + the FOLDED bounded replay log (`Map` + capacity + lazy TTL); `push`/`attach`/`detach`/`replay` drive the resumable server→client channel. |

#### Constants

| Constant                         | Kind  | Value                                                                                                                               |
| -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_SESSION_HEADER`             | const | `'mcp-session-id'` — the session header `createMCPSession` sets on `initialize` + reads thereafter.                                 |
| `MCP_PROTOCOL_VERSION_HEADER`    | const | `'mcp-protocol-version'` — required by 2025-06-18 on post-initialize requests; the clients send it and the POST route validates it. |
| `MCP_METHOD_HEADER`              | const | `'mcp-method'` — the modern request method, required to equal the JSON-RPC body method.                                             |
| `MCP_NAME_HEADER`                | const | `'mcp-name'` — the modern named target, required only for `tools/call`.                                                             |
| `SSE_BUFFERING_HEADER`           | const | `'x-accel-buffering'` — the reverse-proxy buffering response header used by SSE responses.                                          |
| `SSE_BUFFERING_DISABLED`         | const | `'no'` — the value disabling reverse-proxy buffering for SSE responses.                                                             |
| `DEFAULT_MCP_PATH`               | const | `'/mcp'` — the default path `createMCPRoutes` mounts the `POST` at (and `createMCPSession` owns for `GET` / `DELETE`).              |
| `DEFAULT_MCP_KEEPALIVE_INTERVAL` | const | `15000` — the default interval (ms) between keepalive comments on a held-open SSE response.                                         |
| `SSE_KEEPALIVE_COMMENT`          | const | `'keepalive'` — the SSE comment text written at each keepalive interval.                                                            |
| `DEFAULT_MCP_SESSION_CAPACITY`   | const | `1024` — the default max retained pushed messages in a session's folded resumable event log (oldest evicted past it).               |
| `DEFAULT_MCP_SESSION_TTL`        | const | `300000` — the default per-event idle lifetime (ms, 5 min) of a session's folded event log; a staler entry is lazily evicted.       |

#### Helpers

| API                      | Kind     | Summary                                                                                                                                                                                                                |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptsEventStream`     | function | Whether the request's `Accept` header contains `text/event-stream`.                                                                                                                                                    |
| `createReadableStream`   | function | Build a `ReadableStream` from its `pull` and `cancel` behaviours, supplied as arguments rather than an inline source object.                                                                                           |
| `allowsOrigin`           | function | Allow an absent or canonical loopback-literal Origin; require every other present serialized Origin in the explicit list unless validation is delegated upstream.                                                      |
| `inferHeaderIssue`       | function | Derive the first missing or mismatched modern, stateless-legacy, or active-session header issue; `undefined` when the applicable fields agree.                                                                         |
| `inferLegacyVersion`     | function | Pin a supported requested legacy revision, otherwise select the newest supported legacy revision.                                                                                                                      |
| `inferStatus`            | function | Map a dispatch outcome to its era-aware HTTP status while preserving legacy in-band `200` errors.                                                                                                                      |
| `readSessionHeader`      | function | Read the request's `mcp-session-id` header for the stateful transport, or `undefined`.                                                                                                                                 |
| `readLastEventId`        | function | Read the request's `Last-Event-ID` header — the resumable GET-SSE replay cursor, or `undefined`.                                                                                                                       |
| `rejectUnknownSession`   | function | Build the stateful transport's unknown-session reply — a `404` + a JSON-RPC `-32600` "Session not found" body.                                                                                                         |
| `sendEventStream`        | function | Pump a controlled held-open exchange onto an open SSE stream, ending the exchange and the body on every exit; total.                                                                                                   |
| `readEventStream`        | function | Decode a `fetch` Response's SSE body into the `JSONRPCMessage`s it carried (the egress inverse; total).                                                                                                                |
| `decodeEvent`            | function | Decode one SSE event's `data` string into a `JSONRPCMessage`, or `undefined` (total).                                                                                                                                  |
| `upgradeRequestPath`     | function | Read a raw `node:http` upgrade request's path (no query) for the `createWebSocketServer` upgrade-path match.                                                                                                           |
| `extractLines`           | function | Fold one more chunk of raw stdio bytes into a newline-framed buffer — complete `lines` + the trailing `remainder`.                                                                                                     |
| `dispatchLines`          | function | Decode and deliver each complete newline-framed line onto a `MCPClientTransportEventMap` emitter (`message` / `error`).                                                                                                |
| `bridgeMessageTransport` | function | Adapt a message-channel `MCPClientTransportInterface` (stdio / WebSocket server transports) into the core `MCPTransportInterface` port — what `createStdioServer` / `createWebSocketServer` pipe through `bindServer`. |

#### Types

| Type                         | Kind      | Shape                                                                                                                                                                                                                                    |
| ---------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCPHeaderIssue`             | interface | `{ header; reason; message }` — a safely-worded `missing` or `mismatched` required-header diagnosis that never echoes the client-supplied value.                                                                                         |
| `MCPOriginOptions`           | interface | `{ enabled?: boolean; origins?: readonly string[] }` — shared default-on validation with a loopback-literal default; `enabled: false` delegates upstream and ignores `origins`.                                                          |
| `MCPKeepaliveOptions`        | interface | `{ interval?: number }` — the held-open SSE comment interval; any value that is not a positive integer falls back to `DEFAULT_MCP_KEEPALIVE_INTERVAL`.                                                                                   |
| `MCPCallerHandler`           | type      | Synchronous `(request, context?) => unknown` extractor for front-middleware-resolved caller context; `undefined` omits it and a throw propagates.                                                                                        |
| `HTTPHandlerOptions`         | interface | `{ streaming?; origin?; keepalive?; caller? }` — the named options shared by `createMCPPostHandler` and `createMCPRoutes`.                                                                                                               |
| `HTTPTransportOptions`       | interface | `HTTPHandlerOptions<TState> & { path? }` — the shared handler options plus the route mount path for `createMCPRoutes`.                                                                                                                   |
| `HTTPClientTransportOptions` | interface | `{ url: string; headers?: Record<string, string>; fetch?: typeof fetch; timeout?: number }` — the remote endpoint, extra headers, an injectable `fetch`, and an optional `AbortSignal.timeout` deadline for `createHTTPClientTransport`. |
| `MCPSessionOptions`          | interface | `{ path?; ttl?; capacity?; clock?; origin?; keepalive? }` — the owned path, session TTL, replay bound, deterministic clock, shared origin options, and held-open keepalive options for `createMCPSession`.                               |
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
`MCPClientTransportInterface` an `MCPClient` drives over a `node:http(s)`
upgrade. Both `WebSocketServerTransport` and `WebSocketClientTransport` REUSE
the same `MCPClientTransportInterface` the HTTP client transport implements (a
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

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
server.upgrade(createWebSocketServer(mcp)) // claims an MCP WebSocket upgrade to /mcp

// An MCP client connects over the SAME MCPClient, a WebSocket transport instead of HTTP:
const client = createMCPClient({
	transport: createWebSocketClientTransport({ url: `ws://127.0.0.1:${port}/mcp` }),
})
await client.connect() // the RFC 6455 handshake, then the MCP initialize over frames
```

#### Factories

| API                              | Kind     | Summary                                                                                                                                                             |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWebSocketServer`          | function | Mount an `MCPDispatcherInterface` over WebSocket — returns an `UpgradeHandler` for `server.upgrade(...)` (claims an MCP WS upgrade, pipes it through `bindServer`). |
| `createWebSocketClientTransport` | function | Create a `MCPClientTransportInterface` that drives a REMOTE MCP server over a WebSocket (the WS egress mirror).                                                     |

#### Entities

| API                        | Kind  | Summary                                                                                                                                       |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketServerTransport` | class | The per-connection JSON-RPC-over-WebSocket SERVER bridge over a `NodeWebSocketInterface` — a `MCPClientTransportInterface` the ingress pumps. |
| `WebSocketClientTransport` | class | The WebSocket `MCPClientTransportInterface` — handshakes, then bridges the upgraded socket's frames as the client's message channel.          |

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
`MCPClientTransportInterface`, bridges it to the core `MCPTransportInterface` port
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

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
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

| API                          | Kind     | Summary                                                                                                                                                |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createStdioClientTransport` | function | Create a `MCPClientTransportInterface` that spawns a CHILD PROCESS MCP server and drives it over its piped stdio.                                      |
| `createStdioServer`          | function | Pipe an `MCPDispatcherInterface` (via `bindServer`) over newline-delimited JSON-RPC on `stdin`/`stdout` (or injected streams) — `{ start(); stop() }`. |

#### Entities

| API                    | Kind  | Summary                                                                                                                   |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `StdioClientTransport` | class | The `MCPClientTransportInterface` that spawns and drives a child process's stdio as a newline-delimited JSON-RPC channel. |
| `StdioServerTransport` | class | The `MCPClientTransportInterface` wrapping a readable/writable stream pair (default `process.stdin` / `process.stdout`).  |

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
over the SAME `MCPClientTransportInterface` the Node face's transports
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

A browser deployment served from a non-loopback origin must list the page origin in the shared
`origin.origins` value passed to both server enforcement sites, or delegate validation with
`origin.enabled: false`; a page served from a canonical loopback literal needs neither. See
[Mount the HTTP transport with sessions](#mount-the-http-transport-with-sessions).

**One protocol-version derivation, two faces.** Both HTTP client transports stamp
`mcp-protocol-version` through the single exported `inferRequestVersion`, which reads the
reserved `_meta` version off the message being sent. That is deliberately the SAME read the
server's own expectation performs, so a request the server demands a header for is a request
this client sends one for, on either face. It is NOT `parseRequestContext`: that parser
answers a different question — whether the modern metadata is well formed — and a request it
refuses is still modern (era is fixed by key presence) and still owes the header. Routing the
header through it, which the browser face used to do, withheld a header the peer required.

**The two WebSocket client option shapes differ on purpose.** The browser face takes
`{ url, protocols }` and the Node face takes `{ url, headers }`, because the host performs the
WebSocket handshake: the native constructor accepts a URL and subprotocols and nothing else,
so a page has no seam through which to set an upgrade request header. Reach a guarded server
from a page with a credential the platform does carry — a cookie the browser attaches to the
upgrade, a subprotocol token, or a signed value in the URL. The Node face owns its own
`node:http(s)` upgrade request and therefore can offer `headers`. The divergence runs the other
way too, and on purpose: the Node face offers **no `protocols` key at all** — it writes
`Sec-WebSocket-Protocol: mcp` itself, and since `options.headers` spreads LAST over the
handshake headers, a caller needing a different subprotocol sets that header directly rather
than being given a second way to say the same thing.

**`duplex` is a claim about the carrier, and it is proven by driving it.** The WebSocket,
`MessagePort`, and scope carriers declare `true` and really do deliver a client-initiated
`notifications/cancelled` to the peer; Streamable HTTP declares `false` and writes no such
frame, because the dated revision defines none over it. The declaration is per-carrier and
therefore cannot express a carrier that stops being duplex: close the far half of a
`MessageChannel` and the transport still declares `true` while carrying nothing. That is a
property of the model, not a defect in a transport — `duplex` says what the carrier IS, and a
peer that has gone away is what the request's own settlement handles.

`createMessagePortTransport` is the genuinely NEW capability: MCP over
`postMessage`. A `MessagePort` is SYMMETRIC, so `MessagePortTransport` is the
ONE class both a server AND a client bind — it implements `@src/core`'s
`MCPTransportInterface` directly (not `MCPClientTransportInterface`), and
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
| `createWebSocketClientTransport` | function | Create a `MCPClientTransportInterface` over the native `WebSocket` global that drives a REMOTE MCP server (browser face).                                        |
| `createHTTPClientTransport`      | function | Create a `MCPClientTransportInterface` over the native `fetch` that drives a REMOTE Streamable-HTTP MCP server (browser face).                                   |
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

| API                        | Kind  | Summary                                                                                                                                                   |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketClientTransport` | class | The browser-face `MCPClientTransportInterface` over the native `WebSocket` — queues sends until `open`, flushed in order.                                 |
| `HTTPClientTransport`      | class | The browser-face `MCPClientTransportInterface` over native `fetch` — POSTs each message, decodes JSON/SSE, echoes sessions, and stamps era-aware headers. |
| `MessagePortTransport`     | class | The SYMMETRIC `MCPTransportInterface` over a native `MessagePort` — `start()`s at construction, string payloads only, `close()` idempotent.               |

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
`MCPServerInterface`, the removable decorator `MCPLegacy` ↔ the base
`MCPDispatcherInterface` (it adds no member of its own — a decorator that widened
its subject's surface would not be substitutable for it),
`MCPMethodManager` ↔ `MCPMethodManagerInterface`,
`MCPClient` ↔ `MCPClientInterface`, the SEVEN transports
`HTTPClientTransport` / `WebSocketServerTransport` / `WebSocketClientTransport`
/ `StdioClientTransport` / `StdioServerTransport` (`src/server`) PLUS the
browser face's own `HTTPClientTransport` / `WebSocketClientTransport`
(`src/browser`, same names, a different host underneath) ↔
`MCPClientTransportInterface` (all seven share the one generic bidirectional
JSON-RPC carrier — only the wire framing / host differs, so they add no new
behavioral interface), and the session entity `MCPSession` ↔
`MCPSessionInterface` (the folded replay log is private to it), and the two stream
entities `MCPStreamController` ↔ `MCPStreamControllerInterface` /
`MCPTextStreamController` ↔ `MCPTextStreamControllerInterface` (each is its own async
iterator, so `[Symbol.asyncIterator]` and `[Symbol.asyncDispose]` are protocol members
rather than named behavior). The `HTTPDisconnect` lifecycle entity exposes only
`bridge`; its `signal` is a readonly data member.

#### `MCPDispatcherInterface`

The minimal dispatch surface, and the reason legacy support is a value rather than
a branch. A transport needs four things and no more: the resolved message bound, the two
doors, and one `emitter` to report a contained fault through — not the server's identity
and not its method registry — so every door takes THIS:
`createMCPRoutes`, `createMCPPostHandler`, `createWebSocketServer`, `createStdioServer`,
and `bindServer`. `MCPServerInterface` extends it and `MCPLegacy` implements it, which is
what lets the decorator sit between any face and the server without either one knowing
the other's shape changed. `createStdioServer(createMCPLegacy(mcp))` composes exactly as
`createMCPRoutes(createMCPLegacy(mcp))` does.

| Method     | Returns                                                                 | Behavior                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch` | `Promise<JSONRPCResponse \| MCPStreamControllerInterface \| undefined>` | Run one already-parsed invocation and resolve its answer, or `undefined` for a notification. The same three overloads `MCPServerInterface` restates, so a caller narrows once and never re-narrows at the decorator. |
| `handle`   | `Promise<string \| MCPTextStreamControllerInterface \| undefined>`      | The string boundary over `dispatch` — parse, narrow, dispatch, serialize — including the `-32700` / `-32600` mapping, each with its unreadable `id` OMITTED.                                                         |

#### `MCPServerInterface`

`dispatch` is the typed JSON-RPC core; `handle` is the string boundary that
wraps it with parse / serialize and the parse / invalid-request error mapping.
Both take an optional `MCPDispatchOptions` bag carrying `signal` and asserted
`caller`, so every existing caller compiles unchanged.

`dispatch` carries THREE overloads rather than one union, so the answer's type
follows the argument's arm: a `JSONRPCRequest` resolves a response or a held-open
controlled stream and never `undefined`; a `JSONRPCNotification` resolves `undefined`
and never a response; and the union arm — for a transport that narrowed no
further than `JSONRPCInvocation` — admits all three. The Returns column below
states that widest arm.

| Method     | Returns                                                                 | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch` | `Promise<JSONRPCResponse \| MCPStreamControllerInterface \| undefined>` | Select the structural era, emit `request` with the method, the id (`undefined` for a notification), and the era; then resolve the method from `methods`; resolve its answer, or `undefined` for any notification. There is no era branch here — a legacy request reaches this same seam already translated, or not at all. A held-open answer is WRAPPED here, so cancellation is arbitrated at one seam whatever produced it. A contained fault answers `-32603` and reports its caught value on `error`. |
| `handle`   | `Promise<string \| MCPTextStreamControllerInterface \| undefined>`      | Pre-parse UTF-8 byte bound → `JSON.parse` → narrow → `dispatch` → serialize. Overflow/parse failure → `-32700`; non-invocation → `-32600`, each with its unreadable `id` OMITTED; notification → `undefined`; held-open answer → its serialized mirror.                                                                                                                                                                                                                                                    |

Both doors demand modern request metadata, and a bare `MCPServer` has no other era to fall
back on. A version-less `{ jsonrpc, method, id }` is refused `-32602` with
`Invalid params: malformed modern request metadata`, and so is one carrying
`MCP_META_VERSION` alone — `MCP_META_CAPABILITIES` is required beside it. The alternative to
stamping the metadata yourself is wrapping the server in `createMCPLegacy`, which answers the
handshake and translates the dated method set on the way in.

```ts
import {
	createMCPServer,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
} from '@orkestrel/mcp'
import { createToolManager } from '@orkestrel/tool'

const server = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
const controller = new AbortController()
const authenticatedPrincipal = { subject: 'user-42' }

const response = await server.dispatch({
	jsonrpc: '2.0',
	method: 'tools/list',
	id: 1,
	params: { _meta: { [MCP_META_VERSION]: MCP_MODERN_VERSION, [MCP_META_CAPABILITIES]: {} } },
})
// response → {"jsonrpc":"2.0","id":1,"result":{"tools":[],"resultType":"complete","ttlMs":60000,
//   "cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"docs","version":"1.0.0"}}}}

const reply = await server.handle(
	`{"jsonrpc":"2.0","method":"ping","id":2,"params":{"_meta":{"${MCP_META_VERSION}":"${MCP_MODERN_VERSION}","${MCP_META_CAPABILITIES}":{}}}}`,
	{ signal: controller.signal, caller: authenticatedPrincipal },
)
// reply → {"jsonrpc":"2.0","id":2,"result":{"resultType":"complete",
//   "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"docs","version":"1.0.0"}}}}
```

#### `MCPProgressInterface`

| Method   | Returns         | Behavior                                                                  |
| -------- | --------------- | ------------------------------------------------------------------------- |
| `report` | `Promise<void>` | Validate, enqueue, and await consumption of one increasing progress item. |

#### `MCPProgressReporter`

The class exposes MORE than `MCPProgressInterface` deliberately: the interface is the narrow
PRODUCER port handed to `MCPExecutionContext.progress`, so an executor can publish progress and
nothing else, while the class is the entity that also owns the consuming and stopping the
MCP-owned response stream performs — a second interface naming `take`/`stop` would describe
one entity twice. It holds one slot, provides no replay or durable queue, and rejects
concurrent consumers rather than coordinating them.

| Method   | Returns                        | Behavior                                                                                          |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `report` | `Promise<void>`                | Own one bounded increasing item and wait until the serial consumer takes it.                      |
| `take`   | `Promise<JSONRPCNotification>` | Wait for and consume the one slot as an official progress notification; reject a concurrent take. |
| `stop`   | `void`                         | Idempotently stop, discard the slot, reject pending work, and detach the request abort listener.  |

#### `MCPStreamControllerInterface`

The held-open answer's lifecycle, owned by ONE arbitrator. Beyond the async-generator
protocol it adds exactly one member, because the protocol has no way to say "there will be
no answer" — `return(value)` is the consumer declaring it already has one, and only a
consumer can call it. `MCPStreamController` is the concrete engine; `MCPTextStreamController`
is the serialized mirror that delegates every one of these decisions downward.

The protocol members are restated on the contract rather than inherited silently, because
what they GUARANTEE here is narrower than the protocol requires: every closure aborts the
request's lifetime before delegating cleanup, and none of them waits for the producer to
agree.

| Method   | Returns                                                         | Behavior                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next`   | `Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>>` | Read one notification, or the terminal as the iteration's `return`. At most ONE read is outstanding against the producer and a rival read is refused rather than queued; a parked read settles the moment the exchange closes, however long the producer takes. |
| `return` | `Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>>` | End the exchange because the consumer already has its answer: the request lifetime aborts, cleanup is delegated without being waited on, and no terminal reaches the wire.                                                                                      |
| `throw`  | `Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>>` | End the exchange with a failure the consumer raises, and reject with it.                                                                                                                                                                                        |
| `stop`   | `void`                                                          | End the exchange permanently with NO terminal, from an owner that is not the consumer — a closed transport, a failed pump. Idempotent; every later read raises the abort reason.                                                                                |

```ts
import { MCPStreamController, MCPTextStreamController } from '@orkestrel/mcp'

const closure = new AbortController()
const stream = new MCPStreamController(source, closure.signal, closure)
const text = new MCPTextStreamController(stream)
text.stop() // ends the TYPED exchange; `closure.signal` is aborted for the producer
```

#### `MCPTextStreamControllerInterface`

The same exchange, already serialized. Every member translates, and each one ends the typed
exchange rather than this face — with one narrowing that is inherent rather than chosen.
`return` is handed a STRING, so it has no typed terminal to close on and never parses one
back out of its argument; it ends the typed exchange with `stop()` and answers its own
consumer with the supplied text. A cooperating producer therefore runs its cancellation path
through this face where the typed `return` would have run its normal return. Making the text
face reconstruct a response would move the decision about what the exchange ended with into
the adapter, which is the one thing it exists not to do.

| Method   | Returns                                   | Behavior                                                                                                                                      |
| -------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `next`   | `Promise<IteratorResult<string, string>>` | Read the typed stream and `JSON.stringify` the message. Whatever ended the typed exchange is raised UNSERIALIZED — an abort is not a message. |
| `return` | `Promise<IteratorResult<string, string>>` | End the typed exchange with NO terminal (a string cannot be one) and answer this consumer with the serialized value it supplied.              |
| `throw`  | `Promise<IteratorResult<string, string>>` | Stop the typed exchange and reject with the supplied failure.                                                                                 |
| `stop`   | `void`                                    | End the TYPED exchange permanently, with no terminal, so a transport holding only the serialized arm can still end what it is writing.        |

#### `MCPMethodManagerInterface`

The modern method seam `server.methods` exposes — `add` registers (or
replaces) one method, `method` resolves one. The server registers
`server/discover`, `tools/list`, `tools/call`, and `subscriptions/listen` here at construction,
plus `tasks/get`, `tasks/update`, and `tasks/cancel` when `task` is configured, and
resolves EVERY modern method from here, so there is no second dispatch path
and no precedence puzzle. An extension that is not opted into registers nothing, which is
why its methods answer `-32601` rather than a bespoke refusal.

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
	buildJSONRPCResult(request.id, { probed: true }),
)
server.methods.method('demo/probe') // the handler just registered
server.methods.method('demo/absent') // undefined → -32601
```

#### `MCPTaskManagerInterface`

The DRAFT Tasks extension's consumer half — the durable store this package creates tasks
through and reads them back from. It is a port, not a class this package ships: the extension
puts the whole lifecycle on the consumer's side, and a store, a worker, and a terminal status
are what a manager IS. There is deliberately **no plural accessor**; the extension defines no
`tasks/list`, and a port that could enumerate tasks would invite one.

Every method receives the resolved per-request `MCPMethodOptions` and is expected to
**authorize the call itself** — the extension requires authorization on each task request, and
this package has no principal of its own to check one against. See
[Defer a call to a durable task](#defer-a-call-to-a-durable-task) for the six obligations this
contract states and cannot enforce.

| Method   | Returns                               | Behavior                                                                                                                                                                                                                        |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`  | `Promise<MCPTask>`                    | Create — or return the existing — durable task for one stable operation key, ALREADY retrievable by `task` when it resolves. The key arrives unchanged from `MCPTaskHandler` and must be scoped to its principal here or there. |
| `task`   | `Promise<MCPTaskDetail \| undefined>` | Read one task's current snapshot. `undefined` covers unknown, purged, AND not-this-caller's, indistinguishably — all three become the same `-32602`. Every `tasks/*` method reads through here first.                           |
| `update` | `Promise<void>`                       | Answer the input requests an `input_required` task published. Responses arrive verbatim; a key the task never published or has already answered is IGNORED here, not refused.                                                   |
| `abort`  | `Promise<void>`                       | Ask one task to stop. Cooperative: a task that already finished, or whose work cannot be interrupted, may legally reach `completed` afterwards, and resolving says only that the ask was accepted.                              |

#### `MCPResourceManagerInterface`

The consumer-supplied resource registry, and a port rather than a class this package
ships — the same division `MCPTaskManagerInterface` makes. Supplying it is what
registers `resources/list`, `resources/read`, and `resources/templates/list` and what
puts `resources` in the advertised capabilities; omitting it leaves all three
answering `-32601`. Every method receives the resolved per-request `MCPMethodOptions`
and is expected to **authorize the call itself**, exactly as the task port is.

| Method      | Returns                                                                        | Behavior                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources` | `MCPResourcePage` (or a promise of one)                                        | Answer ONE page for the supplied opaque cursor. The cursor is the manager's own value, minted and interpreted here and nowhere else; omitting `nextCursor` declares this the final page.                                                                                                                  |
| `resource`  | `readonly MCPResourceContents[] \| MCPInputResult \| undefined` (or a promise) | Resolve one **concrete** URI. Template matching and variable substitution happen HERE — the URI arrives exactly as the client sent it and MCP expanded nothing. `undefined` means not found and becomes `-32602` naming the URI; an `MCPInputResult` asks the caller for more input instead of answering. |
| `templates` | `MCPResourceTemplatePage` (or a promise of one)                                | Answer one page of `uriTemplate` DESCRIPTORS. The strings are published verbatim; this package neither parses them nor implements any RFC 6570 level, so whatever grammar the manager can match is the grammar the server supports.                                                                       |

#### `MCPPromptManagerInterface`

The prompt mirror of the port above, with the same gating: supplying it registers
`prompts/list` and `prompts/get` and advertises `prompts`, and omitting it leaves both
answering `-32601`. The mirror is exact in naming — `prompt(params)` / `prompts(pagination)`
against `resource(params)` / `resources(pagination)`, under the same shared cursor contract —
and stops at two places. There is no prompt equivalent of `templates`, because prompts are
addressed by name and need no URI descriptor; and `prompts/get` is the one result in this
family that is not cacheable, so it carries no `ttlMs` / `cacheScope` where
`resources/read` does.

| Method    | Returns                                                            | Behavior                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompts` | `MCPPromptPage` (or a promise of one)                              | Answer ONE page under the same shared cursor contract the resource port uses — there is no second cursor shape to learn.                                                                                                                              |
| `prompt`  | `MCPPromptGetResult \| MCPInputResult \| undefined` (or a promise) | Resolve one named prompt to its messages. Argument VALUES are strings by contract and arrive validated; filling the prompt with them is the manager's own substitution. `undefined` is not found → `-32602`; an `MCPInputResult` asks for more input. |

#### `MCPCompletionManagerInterface`

The completion port, configured independently of the other two because `completions`
is a top-level capability rather than a sub-flag of either.

| Method     | Returns                                     | Behavior                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete` | `MCPCompletion \| undefined` (or a promise) | Complete one argument fragment against a reference forwarded VERBATIM — including a `ref/resource` whose `uri` is a template, because the party that expands a template is the party that knows its variables. `undefined` means the reference does not exist → `-32602`. More than 100 values are projected to 100 with `hasMore: true`. |

#### `MCPClientInterface`

The egress mirror: `connect` negotiates the era once and stores the selected
`version`, `discover` exposes the modern server description, `tools` wraps the
remote tools as local `ToolInterface`s, `call` runs a remote `tools/call`,
`disconnect` rejects pending requests, clears the negotiated revision, and
closes the connection it owns; `on` is the convenience forward to `emitter.on`.
The `tasks` data member is the draft Tasks extension's client half — see
[`MCPTaskClientInterface`](#mcptaskclientinterface) below.

| Method       | Returns                             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `on`         | `void`                              | Subscribe a listener to a `MCPClientEventMap` event (`connect` / `disconnect` / `notification` / `error`) — forwards to `emitter.on`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `connect`    | `Promise<void>`                     | Open and negotiate once: pinned legacy initializes directly; otherwise discover modern first, retry one `-32022`, or fall back for a legacy peer. A second `connect` while connected is a no-op; one issued while the current attempt is in flight joins it, and one issued while an attempt a `disconnect` superseded is still unwinding outwaits it before opening the next connection; one issued while a close is still owed settles that connection first — joining a close still running rather than issuing a second one — and rejects with the fault if it fails or goes unanswered again. Whichever side owns the open connection closes it when the attempt rejects, and a close that fails, or that the client stops waiting for, returns it to the client's ownership until the transport's own answer settles it.                                                                                                                                                                                                                                                                                                                                               |
| `discover`   | `Promise<MCPDiscoverResult>`        | Send a stamped modern `server/discover` request and return its validated result, filtered to revisions this client supports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `disconnect` | `Promise<void>`                     | Reject every pending request, clear `version`, close the connection the client opened on the transport — an attempt still inside the transport's `start` owns none yet and closes what it opens itself — and fire `disconnect` only where the client had announced `connect`. Awaited during an in-flight `connect` it supersedes that attempt rather than waiting for it: the superseded `connect` rejects rather than resolving, and every wait it can be parked in once the transport has opened is bounded, so it settles — an attempt still suspended inside `start` settles only when that `start` does. `connected` is cleared before the teardown suspends, so it is never true once `disconnect` returns. The client's wait on the transport's `close` carries the per-request deadline, so a shutdown that never returns rejects instead of wedging the client, while that close keeps running. A `close` that faults or goes unanswered rejects the caller and leaves the connection owned, so a later `disconnect` or `connect` settles it again — joining the running close, or issuing a fresh one after a rejection. The era cache remains for this instance. |
| `tools`      | `Promise<readonly ToolInterface[]>` | Run `tools/list` and wrap each descriptor as a local `ToolInterface` (`inputSchema` → `parameters`; `execute` calls back via `call`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `call`       | `Promise<MCPCallOutcome>`           | Run a remote `tools/call` and report the arm the peer chose: `'complete'` carries the tool's value (`structuredContent` preferred by presence, else the text blocks parsed as JSON), `'task'` carries the durable handle, and `'input_required'` is SURFACED but cannot be continued from this client — the arm is reported faithfully and there is no supported way to answer it, which is [a declared gap](#declared-conformance-gaps). `isError: true` THROWS, and a fourth `resultType` is refused. `options.signal` cancels THIS request only; `options.progress` receives its progress frames.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Discovery is cloned as one exact owned snapshot before semantic validation. `ttlMs` is a
nonnegative integer, every advertised revision entry is a string, unknown revision strings are
ignored when forming the supported intersection, and the returned result and retained revision
list are frozen. Hostile snapshot failures surface as `MCPError` `-32602`, never as a contract
implementation error.

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

#### `MCPTaskClientInterface`

The DRAFT Tasks extension's CLIENT half, reached as `client.tasks`. It mirrors
`MCPTaskManagerInterface` **minus `start`**, because creating a task is never the
client's decision: the extension gives a client no flag and no parameter to ask
for one, so a task exists only because the server DEFERRED a `tools/call` it
received. It keeps the same **missing plural accessor**, for the same reason —
MCP defines no `tasks/list`, and the absence is how the shape says so.

| Method   | Returns                  | Behavior                                                                                                                                                                                                                                                                |
| -------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`   | `Promise<MCPTaskDetail>` | Run `tasks/get` and prove the answer with the same guard the server proves its own with. It REJECTS rather than answering `undefined`: the peer's `-32602` is byte-identical for a task that never existed, one purged by TTL, and one belonging to another caller.     |
| `update` | `Promise<void>`          | Run `tasks/update`, carrying the caller's answers verbatim as `inputResponses`. Which keys a task recognizes is the task's own knowledge, so an unrecognized or already-answered key is the manager's to ignore, and a partial set of answers is legal.                 |
| `abort`  | `Promise<void>`          | Run `tasks/cancel` — the protocol's spelling of this package's `abort`. ADVISORY: resolving says the ask was accepted, never that the task stopped, so a task whose work cannot be interrupted may still reach `completed`. Read the task again to learn what happened. |

```ts
import { createMCPClient, MCP_EXTENSION_TASKS } from '@orkestrel/mcp'

const client = createMCPClient({
	transport,
	// The extension is checked BEFORE any parameter is read, so a client that does not
	// declare it is refused on every `tasks/*` method.
	capabilities: { extensions: { [MCP_EXTENSION_TASKS]: {} } },
})
await client.connect()

const outcome = await client.call('render', { page: 3 })
if (outcome.resultType === 'task') {
	outcome.pollIntervalMs // the peer's HINT, carried untouched — the schedule is yours
	const detail = await client.tasks.task(outcome.taskId) // ONE request, no timer
	if (detail.status === 'input_required') {
		await client.tasks.update(outcome.taskId, { approval: { action: 'accept' } })
	} else if (detail.status === 'working') {
		await client.tasks.abort(outcome.taskId)
	}
}
```

**`pollIntervalMs` is a datum this package carries, not a loop it runs.** MCP
supplies the hint, the one-shot read above, and the `notification` event a peer's
inbound task notification already arrives on. It supplies **no timer, no
scheduler, no terminal-await helper, and no cache** — a connected client that
nobody asks writes nothing at all after a `resultType: 'task'` answer, however
long you watch it. That is a position, not an omission: this package has no
durable place to keep a task, no way to know when your application still cares,
and no lifetime to hang a timer on that outlives the request the task was born
from. Write the schedule where those three facts are known, which is your code.

Cancellation does not reach here either. `call`'s `options.signal` withdraws one
caller from one in-flight request; a call that already answered
`resultType: 'task'` is a request that is **over**, so aborting it afterwards
sends nothing at all — not `tasks/cancel`, and not `notifications/cancelled`,
because there is no longer a pending request to name. `client.tasks.abort` is the
only thing that reaches the work the request left behind.

#### `MCPClientTransportInterface`

The client's transport-agnostic carrier — `start` opens, `send` writes one
message (its reply surfaces on `emitter`'s `message`), `close` tears down.

| Method  | Returns         | Behavior                                                                                                                                                                             |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start` | `Promise<void>` | Open the transport and arm any reply reader (a no-op for a request/response transport). A `start` that rejects must first release whatever it had already acquired.                  |
| `send`  | `Promise<void>` | Write one JSON-RPC message to the remote server; its decoded reply is emitted on the `message` event. A write that fails REJECTS; it never throws synchronously.                     |
| `close` | `Promise<void>` | Close the transport and release resources (fires `close`). It must SETTLE: resolving says the connection ended, rejecting says it did not, and the client believes only that answer. |

Four obligations an implementation carries, because `MCPClient` depends on them
and cannot enforce them from its side. A `start` that acquires and then rejects
strands what it opened: the client claims a connection only once `start`
RESOLVES, so a rejection leaves it holding an error and no claim, and nothing it
can call reaches the socket, session, or reader the transport opened. A `close`
must settle, because the client's only other bound is a deadline that reports an
unanswered shutdown rather than a failed one — a close that never settles leaves
the connection owed for the client's life. And `close` is never called twice
concurrently for one connection (a caller that gave up waiting joins the close
still running), but it IS called again after an earlier `close` rejected, since
a rejected close ended nothing.

The fourth is about `send`, and it is one keyword wide. A failing write must
REJECT, never throw synchronously. `MCPClient` issues the write inside the same
promise executor that records the request's pending entry, so a synchronous
throw leaves no promise for the failure handler to attach to: the executor
throws, the caller's promise rejects, and the pending entry set one statement
earlier is never settled. The request then looks in-flight to a client that has
already given up on it, and a later `options.signal` abort writes
`notifications/cancelled` naming a request the write never delivered. Every
transport this package ships declares `async send`, which satisfies the
obligation by construction; a non-`async` implementation returns a rejected
promise rather than throwing. The client cannot tell the two apart, which is
why the obligation lives here rather than in a guard it could not write.

```ts
import { createHTTPClientTransport } from '@orkestrel/mcp/server'

const transport = createHTTPClientTransport({ url: 'http://localhost:3000/mcp' })
transport.emitter.on('message', (message) => log(message))
await transport.start()
await transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 })
await transport.close()
```

#### `HTTPDisconnect`

The HTTP lifecycle entity composes the incoming request signal with an
MCP-owned response cancellation signal. Its readonly `signal` data member is
supplied to dispatch or observed by session cleanup; `bridge` wraps the matching
SSE response body, writes `: keepalive` comments at `keepalive.interval` (default
15 seconds; any value that is not a positive integer — `0`, a negative, a fractional
value, `NaN`, `Infinity` — falls back to that default rather than becoming a tick at the
host's timer floor), and makes every end of the response that is NOT its graceful completion abort
that signal, without inventing a protocol result or error: consumer cancellation, a failure
while forwarding upstream bytes, and a keepalive tick that finds the SSE stream already
closed. That is what a vanished client actually looks like from here — nothing aborts by
itself — so the handler, the controlled stream, and the producer behind them learn the
response is over. Ordinary upstream completion is the one terminal that only releases the
bridge's own timer and listener. The timer stops on every terminal path.

| Method   | Returns    | Behavior                                                                                                                                                                                                                                                                 |
| -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bridge` | `Response` | Forward an open SSE stream through a keepalive-writing response body; consumer cancellation, a forwarding failure, and a keepalive-detected closed stream each abort the entity's composed signal, while graceful completion does not; stop its timer on every terminal. |

```ts
import { HTTPDisconnect } from '@orkestrel/mcp/server'

const disconnect = new HTTPDisconnect(request.signal)
const answer = await mcp.dispatch(rpcRequest, { signal: disconnect.signal })
// after narrowing `answer` to a held-open stream and opening its SSE carrier:
return disconnect.bridge(stream)
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
| `detach` | `void`                       | Unregister a stream — called when the composed HTTP request / response-stream `AbortSignal` fires.                                             |
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

const server = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools })

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
const answer = await server.dispatch({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
// a request answers a response or a held-open stream, never `undefined`:
if (!(Symbol.asyncIterator in answer)) answer.result // { tools: [ … ] }

const notification = await server.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })
notification // undefined — the notification overload resolves nothing else
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

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
const origin: MCPOriginOptions = { origins: ['https://app.example'] }
router.use(createMCPSession({ ttl: 60_000, origin })) // stateful: mint + validate + resumable GET / DELETE
router.add(createMCPRoutes(mcp, { origin })) // both enforcement sites consume the same policy
```

### Drive a remote server over HTTP, WebSocket, or stdio

The SAME `MCPClient` correlation, deadline, and tool-mapping ride over any of
the three transports unchanged — only the injected `MCPClientTransportInterface`
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
	type MCPListResult,
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
	params: {
		_meta: {
			'io.modelcontextprotocol/protocolVersion': '2026-07-28',
			'io.modelcontextprotocol/clientCapabilities': {},
		},
	},
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

// Supplying a TTL adds both cache stamps, so `tools/list` carries `ttlMs` and
// `cacheScope`; omitting it adds neither, which is how `tools/call` stays uncacheable.
const identity = { name: 'docs', version: '1.0.0' }
const listed: MCPListResult = buildModernResult({ tools: [] }, identity, 60_000, 'public')
const called = buildModernResult({ content: [] }, identity) // no TTL → no cache stamps
const discovered = buildDiscoverResult({ identity, tools: createToolManager() })
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
	createReadableStream,
	decodeEvent,
	inferHeaderIssue,
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

// The stream's behaviours are arguments rather than an inline source object, which is
// what keeps them out of a nested function assignment. The HTTP disconnect bridge builds
// its SSE body this way.
const ticks = createReadableStream<Uint8Array>(
	(controller) => controller.enqueue(new TextEncoder().encode(': keepalive\n\n')),
	() => {},
) // a ReadableStream whose pull writes one SSE comment frame

const posted = new Request('http://localhost/mcp', {
	method: 'POST',
	headers: {
		origin: 'https://app.example',
		'mcp-protocol-version': '2026-07-28',
		'mcp-method': 'tools/call',
		'mcp-name': 'search',
	},
})

// The gate reads Origin only: canonical loopback literals pass by default; every other
// present origin needs the allowlist. It never reads the request URL or Host header.
const policy = { origins: ['https://app.example'] }
allowsOrigin(request, policy) // true — no Origin header, so there is nothing to match
allowsOrigin(posted, policy) // true — the exact serialized origin is listed
allowsOrigin(posted) // false — non-loopback and not allowlisted
allowsOrigin(
	new Request('https://server.example/mcp', { headers: { origin: 'http://127.0.0.1:37757' } }),
) // true — a canonical loopback literal is trusted without configuration
allowsOrigin(posted, { enabled: false }) // true — an upstream layer owns the check

const call = {
	jsonrpc: '2.0' as const,
	id: 1,
	method: 'tools/call',
	params: { name: 'search', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
}
inferHeaderIssue(posted, call) // undefined — every tools/call header agrees
inferHeaderIssue(posted, { ...call, method: 'tools/list' })?.message
// "Mcp-Method header does not match the request body method 'tools/list'."

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

### Own bounded execution values and one streamed HTTP response

The cloners own hostile execution-boundary values without promising a general object clone. The
progress reporter is one non-durable request slot with one serial consumer. `HTTPDisconnect`
composes exactly one incoming request and one SSE response, preserving response bytes and owning
keepalive/cancellation cleanup rather than handler or session policy.

```ts
import { MCPProgressReporter, snapshotJSON, snapshotToolResult } from '@orkestrel/mcp'
import { HTTPDisconnect } from '@orkestrel/mcp/server'
import { openStream } from '@orkestrel/server'

const limits = { bytes: 256, keys: 4, depth: 2 }
const json = snapshotJSON({ beta: 2, alpha: 1 }, limits)
const result = snapshotToolResult(
	{ id: 'call-1', name: 'search', success: true, value: { count: 1 } },
	limits,
)

const request = new AbortController()
const reporter = new MCPProgressReporter('call-1', limits, request.signal)
const reporting = reporter.report({ progress: 1, total: 2, message: 'halfway' })
const notification = await reporter.take()
await reporting
reporter.stop()

const stream = openStream({ headers: { 'x-operation': 'call-1' } })
const disconnect = new HTTPDisconnect(request.signal, { interval: 15_000 })
const response = disconnect.bridge(stream)
stream.write({ event: 'progress', data: JSON.stringify(notification) })
stream.end()
await response.text()
```

`json` and a defined successful `result` contain owned deeply frozen JSON plus canonical text;
malformed or out-of-bound inputs instead return `undefined`. Value-less successes and failures
carry `undefined` text. Stopping the reporter rejects later reports and takes; it does not save
progress for replay. Cancelling `response.body` aborts `disconnect.signal` and cancels upstream — as do a
failure while forwarding upstream bytes and a keepalive tick that finds the SSE stream already
closed — while ordinary upstream completion closes the response without inventing an abort.

## Tests

- [Exact JSON and Tool-result ownership](../../tests/src/core/cloners.test.ts)
- [Request-scoped progress backpressure](../../tests/src/core/MCPProgressReporter.test.ts)
- [Held-open stream cancellation](../../tests/src/core/MCPStreamController.test.ts)
- [Serialized stream translation](../../tests/src/core/MCPTextStreamController.test.ts)
- [Core dispatch integration](../../tests/src/core/MCPServer.test.ts)
- [Legacy translation onto the modern engine](../../tests/src/core/MCPLegacy.test.ts)
- [Resource and prompt port projection, pagination, and completion](../../tests/src/core/MCPServer.test.ts)
- [Resource, prompt, and error guards](../../tests/src/core/validators.test.ts)
- [Client-side durable tasks and the absent poll loop](../../tests/src/core/MCPTaskClient.test.ts)
- [HTTP response lifecycle composition](../../tests/src/server/transports/HTTPDisconnect.test.ts)
- [HTTP handler integration](../../tests/src/server/handlers.test.ts)
- [Session middleware integration](../../tests/src/server/middlewares.test.ts)
- [Guide/source/public-barrel parity](../../tests/guides.test.ts)
- [Repository law, including the legacy-removability boundary](../../tests/policy.test.ts)

## Declared non-goals

Everything below is intentionally absent, with its reason. A capability named here is
not a defect and not a roadmap entry: it is a decision, and the guide states it so a
consumer can plan around it instead of discovering it.

**Protocol surfaces this package does not implement.**

| Not built                                                      | Why                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roots, Sampling, Logging                                       | All three are deprecated in 2026-07-28 and none has a registry or a consumer here. The local `emitter`s are observability, not an MCP logging capability. Resources and Prompts are NOT on this list any more — see [Project a host-owned resource, prompt, and completion registry](#project-a-host-owned-resource-prompt-and-completion-registry). |
| A built-in resource or prompt STORE                            | The `resources` / `prompts` / `completion` capabilities ship as PORTS, exactly as tools and durable tasks do. What backs one — a workspace, a database, a template registry, a plain object — is the host's decision, and a default store here would be product policy wearing a framework's clothes.                                                |
| Server-initiated `elicitation/create` requests                 | 2026-07-28 removes server-initiated requests entirely. Form elicitation survives only inside a modern `tools/call` `input_required` result — see [Produce a form elicitation for the call in hand](#produce-a-form-elicitation-for-the-call-in-hand).                                                                                                |
| Sampling and roots as input-request carriers                   | Both remain legal members of `MCPInputRequest` and both are deprecated; this server produces `MCPElicitRequest` and nothing else.                                                                                                                                                                                                                    |
| Durable task or session STORAGE                                | Task state outlives the request that created it and this package owns no persistence. The store arrives injected as `MCPTaskOptions.tasks`, exactly as `ToolManagerInterface` does — the extension's protocol ships here, its durability does not.                                                                                                   |
| `outputSchema` on tool descriptors                             | `ToolResult.value` (`@orkestrel/tool`) is `unknown`; the contract that owns the value owns its schema. `structuredContent` is produced without one, which no clause gates.                                                                                                                                                                           |
| Icons (2025-11-25)                                             | Installed `@orkestrel/tool` definitions carry no icon field, so an MCP-only wrapper would have no originating consumer.                                                                                                                                                                                                                              |
| `x-mcp-header` server-side annotation and definition filtering | The MUST to keep invalidly annotated definitions out of `tools/list` binds a server that accepts the annotation. No installed definition carries one, so none can be invalid.                                                                                                                                                                        |
| `_meta['io.modelcontextprotocol/logLevel']`                    | The deprecated canonical value is validated as request metadata, but no consumer opts a request into server log emission.                                                                                                                                                                                                                            |
| W3C `traceparent` / `tracestate` / `baggage`                   | Tracing is application policy. The `request` event is the observation seam; a consumer stamps its own spans there.                                                                                                                                                                                                                                   |
| Reading `extensions` for anything but Tasks                    | Capabilities are an open record, so a consumer can already declare any extension id without a library change. This package reads exactly one key of that map — `io.modelcontextprotocol/tasks`, and only when `task` is configured — and advertises the same one; every other id travels through untouched.                                          |
| JSON-RPC batching                                              | Removed by deletion: only individual messages are accepted, and the types enforce it.                                                                                                                                                                                                                                                                |
| The optional 2025-11-25 SSE polling protocol                   | No consumer. Resumability exists only as the legacy session middleware's `GET` channel, and a modern request must not use it.                                                                                                                                                                                                                        |

**Revisions this package does not speak.** `2025-03-26` is dropped because its
mandatory JSON-RPC batching is unimplemented here, and `2024-11-05` because it
requires the two-endpoint HTTP+SSE transport this package never implemented and
2026-07-28 deprecates. Both revisions are still live upstream: removing them is this
library's decision, not the ecosystem retiring them. Advertising a version whose
transport or framing is absent would be a false handshake, which is the one thing a
handshake may not be.

**Era-scoped surfaces, stated as limits rather than gaps.**

- `initialize`, `ping`, sessions, and the resumable `GET` stream are **legacy-only**.
  A modern request naming one gets `-32601`, and the session middleware passes every
  modern-shaped POST straight through.
- `subscriptions/listen` is **modern-only**, by design: it is a 2026-07-28 method. A
  legacy-era client asking for it gets `-32601` and keeps the strictly weaker
  unsubscribed channel — the session stream's `notifications/message`. Nothing
  degrades into polling either way, because a call's own result stays authoritative
  and notifications are hints.

**Policy this package will not decide.** Framework code supplies mechanism and stops
before the deployment's decisions. Auth, tool-invocation rate limiting (see
[Declared conformance gaps](#declared-conformance-gaps)), and request-body size guards
are all composed IN FRONT as ordinary `@orkestrel/server` middleware; `limit.message`
bounds only the raw string a transport hands to `MCPServer.handle`, which is a
different boundary from an HTTP body.

**The origin split is the shape of that rule.** The 2025-11-25 origin clause binds the
server component this package ships, so the **mechanism** ships here and is on by
default: a request without `Origin` is allowed; a canonical origin whose host is the
`localhost` or `[::1]` literal, or in the IPv4 `127.0.0.0/8` literal range, is allowed
without configuration; and every other present origin is allowed only when its exact
serialized origin occurs in the list. This decision reads the `Origin` value alone — never
the request URL, `Host`, or another request header — so an attacker origin such as
`http://evil.example.com` cannot become trusted when DNS resolves that hostname to loopback.
The remaining **policy** — which non-loopback origins a deployment trusts — is the consumer's,
supplied once as `origin.origins` and consumed by both enforcement sites (the POST handler and
the session middleware). A deployment that already validates origin upstream says so explicitly with
`origin: { enabled: false }` rather than by passing an empty list, because delegation
is a different decision from an empty allowlist and deserves its own word.

## Declared conformance gaps

A reproducible run is `npm run test:conformance`: it starts the real Streamable HTTP
server from this package's source and runs
`@modelcontextprotocol/conformance@0.2.0-alpha.10` against specification revision
`2026-07-28`. That is a genuine foreign MCP client driving this surface end to end, and
the current recorded result is **23 passed / 0 failed**, the
`dns-rebinding-protection` security regression guard (2 passed) included. There is no
remaining failing scenario in that run.

It is a live-service project of its own — `tests/conformance.test.ts` over the fixture in
`tests/setupConformance.ts` — and it stays outside `npm test`, which is hermetic and
offline while this run fetches the runner from the npm registry. Its baseline is recorded
scenario by scenario rather than as one total, so a scenario that silently stops running
fails the run instead of disappearing into a matching sum.

**That number has been wrong twice, in the same way, and both times the fixture was the
cause — so read the fixture before quoting the number.** It was first recorded as
**8 passed / 15 failed**, measuring a fixture built without
`MCPServerOptions.execution` — the shipped, documented port
[above](#execute-rich-results-and-request-scoped-progress) — so four rich-content
scenarios received a normalized text result instead of the image, audio,
embedded-resource, and mixed content they asked for, and a fifth counted two progress
frames where the scenario specifies three. Wiring that port moved it to **13/10**. It
was then quoted as 13/10 against a fixture built without the `resources`, `prompts`,
and `completion` ports, so ten more scenarios measured an unconfigured harness rather
than the library; wiring those three moved it to **23/0**. Neither correction changed
one byte of `src/` or `dist/`. The lesson is the number's, not the library's: a
recorded baseline must measure the product, not the harness, and a fixture that omits
a shipped port understates the package by exactly the scenarios that port serves.

The ten scenarios the last correction closed are the Resources four
(`resources-list`, `resources-read-text`, `resources-read-binary`,
`resources-templates-read`), the Prompts five (`prompts-list`, `prompts-get-simple`,
`prompts-get-with-args`, `prompts-get-embedded-resource`, `prompts-get-with-image`),
and `completion-complete`. `resources-templates-read` is worth singling out, because it
is the scenario that would have forced a template engine if one were needed: it sends
the already-substituted `test://template/123/data`, and the fixture's own manager
matches it. **Nothing in this package expanded that template** — see
[the port section](#project-a-host-owned-resource-prompt-and-completion-registry).

The fixture backs all three ports with plain in-memory objects, which is also the
control on the claim that they are real ports: no workspace, no template engine, and
no `@orkestrel/*` registry is involved, and the foreign client cannot tell.

**Read that number for exactly what it measured, and no further** — and a run with no
failures invites over-reading in a way a run with ten did not. Six bounds fix its scope:

- It drives **Streamable HTTP `POST` only**. It says nothing about the WebSocket, stdio,
  `MessagePort`, or worker-scope carriers — which is precisely where this package's
  cancellation and duplex behaviour lives.
- It mounts `createMCPRoutes` alone, so **`createMCPSession` is never exercised**: no
  session mint, no TTL sweep, no `mcp-session-id` round trip is covered by this number.
- It says nothing about **this package's own client consuming a held-open exchange**. The
  runner's client consumes one and reports it (`server-sse-multiple-streams`, 2 passed / 0
  failed), so the server half is exactly what that scenario proves; the unproven half is
  `MCPClient`'s — see the entry below.
- It is a **protocol conformance runner, not an IDE integration**. Passing it is evidence
  about the wire, not evidence that any particular host application can drive this server.
- It proves **nothing about the browser face**. Not one byte of `@orkestrel/mcp/browser`
  is loaded by that run.
- **A green run is bounded by the runner's own scenario list, and that list has real
  holes.** It carries no cursor-pagination scenario and no capability-gating scenario,
  so neither `nextCursor` nor the `-32601` an unconfigured port answers with is
  evidenced by this number at all — both are proven by this package's own tests
  instead. Its `resources-subscribe` / `resources-unsubscribe` scenarios are declared
  removed at `2026-07-28` and never run here, which corroborates the removal but proves
  nothing about `subscriptions/listen`, the mechanism that replaced them.

**The browser face's honest proof is a real host, not a foreign client.** There is no cheap
foreign browser MCP client to point at it, and inventing one would be a worse instrument
than naming the limit — a fixture we wrote agreeing with code we wrote is not independent
evidence. So the browser claims are proven by Playwright driving real Chromium: a real
`WebSocket`, a real `fetch`, and a real `MessageChannel`, against a real Node server running
outside the page's module graph. That is a real **host** exercising the real platform APIs,
and it is a different kind of evidence from a foreign **client** — strong about the carrier
and the platform, silent about interoperability with somebody else's implementation.

A non-goal is a capability this package chose not to build. A **gap** is different: an
obligation or a protocol capability it does not satisfy. Declining is not available for
those, so they are stated here rather than left for a consumer to discover on the wire.
Each entry names the clause, what it costs, and who could close it — including where
the honest answer is that nothing inside this package will.

**Client-side consumption of a held-open Streamable HTTP exchange — unreachable, not
unfixed.** The server half is complete: a registered method returns a held-open stream, the
route pumps it as SSE, and a foreign client that opens `subscriptions/listen` consumes it
incrementally. This package's own client cannot open that exchange at all. `MCPClient`
contains no `subscriptions/listen` initiator and no stream API of any kind, so there is no
shipped caller for whom a held-open reply could be consumed as it arrives; both HTTP client
transports therefore buffer a `text/event-stream` reply to completion and deliver its events
together. **What it costs:** nothing to any exchange this client can currently start — every
one of them is a single request with a single reply. It costs the day a subscription API is
added, because that API and this consumption are the same feature. **Closer:** a client-side
subscription API, which does not exist and is not scheduled.

**A per-request abort on the HTTP client transport — unreachable for the same reason.**
`MCPClientTransportInterface.send` takes a message and no per-request options, so a caller
cannot hand one request its own cancellation; the transports carry only a construction-time
`timeout`, applied uniformly through `AbortSignal.timeout`. This is downstream of the entry
above rather than independent of it: with no incrementally consumed stream, there is no
in-flight exchange to close, and a unary POST is over before a caller could reach it. **What
it costs:** a caller cannot abandon one outstanding request without abandoning the transport.
**Closer:** a per-request options bag on `send` — the same seam the two entries around it
need, which is why they would return as ONE unit and never as three.

**`-32020` refresh-and-retry-once — not implemented, and a retry could not fix it.** A
client that receives `-32020` (a protocol-version header the peer refuses) might be expected
to refresh its version and retry once. It is not implemented, and the reason is stronger than
scheduling: both HTTP client transports DERIVE every header from the message being sent —
the method header, the `tools/call` name header, and the protocol version read out of the
message's own `_meta` through the one shared `inferRequestVersion` — so a retry of the same
message re-derives byte-identical headers and earns byte-identical refusal. (That claim was
only half true until the browser face stopped projecting its version through
`parseRequestContext`; the two faces now share one derivation, which is what makes "the same
message re-derives the same headers" a statement about both of them.)
The code is also unreachable ahead of validation: every
malformed-context path answers `-32602` first. Only a header-rewriting intermediary between
client and server produces a `-32020` this client did not cause, and a retry reproduces that
intermediary exactly. **What it costs:** nothing against a peer this client talks to
directly. **Closer:** none needed unless a reachable path is exhibited where a refresh
changes the derived headers; that would make the retry meaningful and this entry wrong.

**`Mcp-Param-*` / `x-mcp-header` client projection — not satisfied.** An HTTP client
MUST project tool arguments annotated with `x-mcp-header` in a tool's `inputSchema`
into `Mcp-Param-*` request headers. Neither HTTP client transport does: the projection
needs the tool's schema — knowledge the client holds and the transport does not — inside
the HTTP transport, which means widening the transport-agnostic `MCPClientTransportInterface.send`
into an HTTP-shaped contract that every other transport would then carry. **What it
costs:** against a foreign 2026-07-28 server whose tool schemas use the annotation,
this client sends those parameters in the request body only. A server that also accepts
body parameters is unaffected; a server that requires the header projection has tools
this client cannot call. The exposure is bounded to foreign modern servers using an
optional annotation, and to nothing this package's own server produces. **Closer:** one
isolated unit, deliberately sequenced last so nothing depends on the widened contract; it
is not scheduled, and it is the SAME per-request seam on `send` the two entries above need,
so all three land together or not at all.

**Tool-invocation rate limiting — not satisfied, and no unit will close it.**
2025-11-25's `server/tools` § Security Considerations binds a server to validate tool
inputs, implement access controls, **rate limit tool invocations**, and sanitize tool
outputs. The first, third, and fourth are already true here or belong to the tool
contract that owns the values. The rate limit is neither, and will not become either: a
limit is a judgement about how much traffic one caller may spend against one
deployment's capacity, and both numbers belong to the deployment. A framework that
picked one would be picking product policy, and a framework that picked an unlimited
one would be pretending to satisfy the clause. **The consumer's obligation:** a
deployment exposing this server beyond a trusted process boundary must impose its own
per-caller invocation limit in the layer fronting it — ordinary `@orkestrel/server`
middleware in front of `createMCPRoutes`, composed exactly like auth. **Closer:** none
inside this package; it is the deployment's.

**A unary HTTP request cannot be cancelled mid-flight.** The HTTP face can propagate
cancellation only after a streamed response has begun. An idle held-open stream writes
SSE keepalive comments and notices a disconnected client within one configured
keepalive interval, aborting the caller signal that dispatch composed into the lifetime
its handler observes. A
unary response is produced in full before anything is written, so nothing observes the
disconnect while it runs: a long-running unary `tools/call` runs to completion even
after its caller has gone. **The consumer's options:** bound the tool itself, or return
a held-open `MCPStream` from a registered method so the keepalive seam applies.
**Closer:** none named; the limit is structural to a unary HTTP response.

**A tool run through the default registry cannot observe cancellation.** Dispatch resolves
one signal per request and hands it to every method, selector, principal resolver, and
subscription producer the request reaches — but the default execution path calls
`ToolManagerInterface.execute(call)`, whose signature takes a call and nothing else. There is
no seam to hand a signal through, so a server configured WITHOUT `execution` runs its tool to
completion after the request that asked for it has ended, and abandons the result. **What it
costs:** a long or expensive tool keeps spending after its caller is gone. **The consumer's
options:** supply `MCPServerOptions.execution`, whose `MCPExecutionContext` carries `signal`
and can stop the work; or bound the tool itself. **Closer:** none inside this package — the
limit is in the `execute` signature, which `@orkestrel/tool` owns.

**A producer that ignores its signal cannot be forced to finish.** A controlled stream
settles its CONSUMER promptly whatever the producer is doing, and aborts the request's
signal before delegating cleanup — but JavaScript cannot settle work a generator is
suspended inside, so a producer parked on a promise that never resolves keeps whatever it
holds. **The consumer's obligation:** observe `options.signal` in any registered stream
producer, which is the only wakeup this package can offer one. **Closer:** none possible;
the limit is the language's.

**An inbound `notifications/cancelled` is honoured only where the carrier has one to
deliver.** 2026-07-28 removes client→server notifications over Streamable HTTP, leaving the
frame as the message-based cancellation path for the transports that still have one — stdio,
WebSocket, and `MessagePort`. `bindServer` holds one `AbortController` per live request, keyed
by request id and retired whenever that request leaves, and supplies its signal to `handle`,
so an inbound cancellation aborts the named request and the cancelled request writes no
response. A tool observes that abort only through `MCPServerOptions.execution`, whose
`MCPExecutionContext` carries `signal`; the default `ToolManagerInterface.execute` path has no
seam to hand one through, which is a separate declared limit above. **What remains:** on
Streamable HTTP there is no such frame at all — there, closing the response stream IS the
cancellation signal, and only a streamed response has one to close. **Closer:** none possible
for the HTTP face; the limit is the dated revision's.

This package's own CLIENT does write the frame — `call`'s `options.signal` sends
`notifications/cancelled` on a carrier declaring `duplex`, and writes nothing on one that
does not. That is the correct read of the dated revision, which defines no client-to-server
notifications over Streamable HTTP: there, **closing the SSE response stream is itself the
cancellation signal**, so a duplex-declaring transport is exactly the population the frame
belongs to. Cancellation is ADVISORY in both directions — every receiver obligation is
`SHOULD` or `MAY` — so a peer may finish anyway, and a response arriving after the abort is
discarded rather than raised as a fault.

**Two pages of the dated revision disagree about how a server ends a subscription, and this
package implements the one that owns the mechanism.** The cancellation page says a server MUST
send `notifications/cancelled` referencing a `subscriptions/listen` request id when it tears
that stream down, and MUST NOT send the notification for any other purpose. The subscriptions
page it cites as its authority describes three end conditions with three mechanisms, and none
of them is a server-sent `notifications/cancelled`: for unilateral server teardown it says the
server SHOULD send the EMPTY `subscriptions/listen` result to signal a graceful end, and it
attributes the notification to the CLIENT alone. The schema carries only the generic
`CancelledNotification` with `requestId` and an optional `reason` — no subscription-specific
field or variant — so it corroborates neither page. This server sends the empty result,
correlated by the original request id through `buildSubscriptionResult`, on every transport.
**What it costs:** a client written against the cancellation page, watching for a notification
it believes is required, sees the result instead. **Do not "fix" this toward the cancellation
page** — emitting the notification as well would send a frame the governing page does not
sanction alongside the result that page does require. **Closer:** upstream's, not this
package's; the contradiction is theirs to resolve.

**A consumer's own registered method cannot be called with this client.** `MCPServer.methods`
is an OPEN registry, so a consumer may register `prompts/get` — or any other name — and this
package's server will dispatch it. `MCPClient` publishes no matching general capability: its
correlated-request door is private, and the public surface is `discover` / `tools` / `call`
plus the three `tasks/*` methods `client.tasks` covers. The asymmetry is deliberate rather than
overlooked — a public arbitrary-request method is a capability with no consumer today, and the
creation gate refuses one — but it IS an asymmetry, and a consumer planning a custom method on
both ends should know it before writing the server half. **The consumer's options:** build the
client half on `MCPTaskClient`'s own pattern, since `MCPRequestFunction` is published and an
`MCPTaskClient` is constructible with any implementation of it. **Closer:** one unit publishing
the door, whenever a real consumer needs it.

**Do not reach for the client's own transport as a second door.** Writing a raw frame through
`client.transport.send` puts it in the id space `MCPClient` correlates on, and the client's
counter is private and unpublished — so there is no id a consumer can be sure is free. Reusing
one that is live is not a collision the client detects: the peer's answer arrives on the same
`message` subscription, correlates to the pending entry that id already names, and SETTLES
somebody else's `call` with the wrong result. That has been run — a raw `prompts/get` written
under a live `call`'s id resolved the `call` with the prompt — so it is a hazard rather than a
workaround, and the `MCPRequestFunction` route above is the supported one precisely because it
mints its ids through the same door everything else does.

**`call` surfaces the `input_required` arm and this client cannot continue it.** Two of the
three `MCPCallOutcome` arms are actionable from here: `'complete'` carries the value, and
`'task'` hands `client.tasks` a handle it can read, answer, and stop. The third has no
client-side continuation at all. The dated revision's route out of an inline
`resultType: 'input_required'` is another `tools/call` carrying the caller's answers, and this
client publishes no way to write one — `call` takes a name and arguments, and the door that
would carry an arbitrary correlated request is the private one the asymmetry above describes.
`client.tasks.update` is not that route: it answers the input requests a durable TASK
published, which is a different arm reached through a different method. **What it costs:** a
consumer whose peer asks for more input inline reads the arm, and stops there — the outcome is
honest about what the peer said and there is nothing supported to do with it. This is the
larger of the two gaps on this seam, because it is reachable through the client's own public
type rather than only by a consumer who wanted a method nobody has asked for. **The consumer's
options:** none inside this package; a peer that defers to a durable task instead of asking
inline is fully served. **Closer:** the same unit that publishes the correlated-request door,
which is what the continuation would be written on.

**Task notifications are not implemented, and the reason is that the wire shape could not be
established (2026-08-08).** The draft Tasks extension defines `notifications/tasks`, and a
client subscribes to it the way it subscribes to everything else — through
`subscriptions/listen`'s `params.notifications` filter. This package implements the three
unary `tasks/*` methods and no notification path, so a consumer schedules its own
`tasks/get` reads — on the `pollIntervalMs` the store suggests, which this package carries and
never acts on — instead of being pushed to. **Why it is excluded rather
than deferred:** two research passes could not establish the LISTEN-side envelope. The
extension's schema declares `TaskSubscriptionNotifications { taskIds?: string[] }` and then
never references it; its JSDoc implies nesting under a `tasksStatus` key at a composition
point that lives outside the extension entirely, and that composing type was not found.
Guessing the nesting key would be inventing wire shape, and a filter no peer speaks is worse
than an absent one. **What IS settled, for whenever the envelope lands:**
`TaskStatusNotificationParams` is `NotificationParams & DetailedTask`, so a consumer reads
`params.status` directly, never `params.task.status`. **What it costs:** a client learns a
task reached a terminal status on its next poll rather than immediately, which is the
extension's own fallback and not a degradation this package invented. **Closer:** one unit,
once the composing subscription type is published upstream; it is not scheduled.

The modern-only scope of `subscriptions/listen` is a stated limit rather than a gap —
it is recorded under [Declared non-goals](#declared-non-goals) with the other era-scoped
surfaces.

## Declared packaging limits

Four facts about the published artifact. Each is a decision carrying its number, not an
omission, and a consumer meets all four at install time rather than in a build log.

**IDE integration is not claimed.** A real foreign protocol client drives the Streamable
HTTP surface end to end — `@modelcontextprotocol/conformance@0.2.0-alpha.10` against
revision `2026-07-28`, recorded at 23 passed / 0 failed — and that is a claim about the
wire. No IDE, editor, or agent host has driven this server. The rule is this repository's
own: a claim about an external client stays unproven until one representative real client
of that class drives it end to end, and no client of the IDE class has. **What it costs:**
a consumer adopting this package to back an IDE integration is doing something nobody here
has tested, and the conformance number does not transfer to it. **Closer:** one
representative IDE driving this server, recorded exactly the way the conformance run is.

**There is no top-level `types` field, so a consumer on legacy `moduleResolution: node`
sees an untyped package.** The `exports` map carries a `types` condition on every subpath
and every condition inside it: `.` under both `import` and `require`, `./browser` under
`import`, `./server` under both. Every resolver that reads `exports` therefore finds
declarations, which is `node16`, `nodenext`, and `bundler`. Legacy `node` resolution does
not read `exports`; it looks for a top-level `types` field, finds none, and treats the
package as having no declarations at all. **Who it affects:** a consumer whose
`moduleResolution` is `node`, and nobody else. **Closer:** a top-level `types` entry in
the manifest, which this package has not added.

**API Extractor bundles TypeScript 5.9.3 while this project compiles with 6.0.3, so
`build` prints a version notice once per built face — three times.** The exact line is:

```text
*** The target project appears to use TypeScript 6.0.3 which is newer than the bundled compiler engine; consider upgrading API Extractor.
```

It is informational and not an error. `build` exits 0, every declaration is emitted, and a
generated consumer type-checks against the shipped declarations: `dist/src/browser/index.d.ts`
and `dist/src/server/index.d.ts` import core through the published `@orkestrel/mcp`
specifier and carry no source-path specifier. The pin is transitive — the lockfile pins
`@microsoft/api-extractor`'s own nested TypeScript at 5.9.3 — so no direct dependency of
this package selects it. **What it costs:** three lines of build noise, plus the risk that
a TypeScript 6 construct the bundled 5.9.3 engine cannot parse would surface as a
declaration defect rather than a compile error. Nothing in this package has reached that.
**Closer:** an API Extractor release bundling TypeScript 6.

**Source maps ship, and they are 1,130 kB of the 2.5 MB unpacked — about 45 percent.**
Five `.map` files carry it, one per built output: core ESM and CJS, server ESM and CJS,
and browser ESM. They are kept on purpose. A consumer debugging a protocol library steps
into real source rather than a bundle, and the frames that matter when a wire fault
reaches a consumer are inside this code. The tarball is 623.4 kB packed across 18 files,
which is not burdensome. **What it costs:** roughly half the unpacked footprint on disk.
**Closer:** none wanted — dropping them is a size decision this package has declined.

## Contract

The normative reference, last because it is the least narrative thing here. These
invariants hold across the MCP layer (`src/core` + `src/server` + `src/browser`) ↔
`mcp.md`; where a sentence earlier in this guide summarizes one, the clause below is
the exact statement:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `const` /
   `interface` / `type` row in the `## Surface` tables (the core dispatch
   tables AND the `### HTTP transport` + `### WebSocket transport` + `### stdio
transport` tables) is a real export of the mcp layer (`src/core` or
   `src/server`), and every export of either appears as a Surface row —
   exhaustive, both directions.
2. **JSON-RPC 2.0 envelope.** A `dispatch` response is always `{ jsonrpc:
'2.0', … }` with EXACTLY ONE of `result` / `error`. The success arm ALWAYS
   carries an `id`, echoing the request's, because a result answers a request and
   a request always has one. The error arm is the only arm whose `id` may be
   missing, and it is then OMITTED — the member is absent from the envelope, never
   present as `null` — which is what a `handle` parse or invalid-request failure
   produces, since neither could read an id to echo. MCP overrides JSON-RPC 2.0 §5
   here, and `JSONRPCErrorResponse` states it: `id?: JSONRPCId`, where `JSONRPCId`
   admits no `null`.
   `handle` serializes that envelope with `JSON.stringify` and returns the
   string. A HELD-OPEN answer is the other arm of the same return: `dispatch`
   resolves an `MCPStream` and `handle` its serialized `MCPTextStream` mirror,
   narrowed apart at ONE point (`Symbol.asyncIterator in result`). The stream's
   `return` value is the terminating response and obeys this same envelope, and its
   `yield` type is `JSONRPCNotification`, so no stream can carry a call the peer is
   expected to answer.
3. **Notifications yield no response.** A call with NO `id` is a
   `JSONRPCNotification`, a type distinct from `JSONRPCRequest` and unassignable to
   it: `dispatch` emits `request` (whose id argument is `undefined`, beside the
   structural era) and then
   resolves `undefined` WHATEVER the method (`ping`, `notifications/initialized`,
   an unknown method — all silent); `handle` returns `undefined`. Neither era
   branch ever runs for a call without an `id`.
4. **The four legacy methods, and they live in `MCPLegacy`.** The decorator owns the
   whole fixed set; `MCPServer` holds no era branch, imports no legacy module, and
   spells no legacy method or header name, all three checked structurally by
   [the repository law suite](../../tests/policy.test.ts). `ping`, `tools/list`, and
   `tools/call` are TRANSLATED onto the modern engine — they acquire modern request
   metadata, run through the same dispatcher, and are projected back unstamped — so
   they inherit the modern engine's execution port, cancellation, bounds, and
   validation rather than running beside them. `initialize` → `{ protocolVersion,
capabilities: { tools: {} }, serverInfo: { name, version } }`, the version NEGOTIATED over the
   LEGACY subset only: the client's `params.protocolVersion` is echoed when it is a
   supported LEGACY revision, and every other request — the modern `'2026-07-28'`,
   an unsupported revision, a non-string, or an absent one — falls back to the
   newest supported legacy revision (`MCP_PROTOCOL_VERSION`, `'2025-11-25'`). A
   handshake is a legacy act, so it can only ever settle on a legacy revision; a
   client asking to `initialize` at `'2026-07-28'` is asking to negotiate a
   revision that defines no negotiation, and the client decides what to do with
   the legacy answer it gets. `ping` → `{}`. `tools/list` → `{ tools }`, each tool a
   `MCPToolDescriptor` (its `parameters` renamed to `inputSchema`,
   defaulting to `{ type: 'object' }`). `tools/call` → the executed
   tool's `MCPCallResult`.
5. **Tool errors are tool results, not protocol errors.** `tools/call` reads
   `params.name` (a string) + `params.arguments` (a record; the modern path defaults an
   absent one to the shared frozen `EMPTY_MCP_ARGUMENTS`),
   narrowed via `@orkestrel/contract`'s guards (no `as`); a missing /
   non-string `name` → a `-32602` invalid-params error. Otherwise it runs
   `tools.execute({ id, name, arguments, ...(options.caller === undefined ? {} : { caller: options.caller }) })`
   under both wire eras, so a present asserted caller reaches the real tool body while
   absence preserves the former `ToolCall` shape exactly. Because the `ToolManager`
   (`@orkestrel/tool`) ALREADY isolates a thrown tool (and an unknown name)
   into a `success: false` result, the server adds NO try/catch: that branch's
   `error` maps to `{ content: [{ type: 'text', text: <error> }], isError: true }`;
   a valued `success: true` branch maps to `{ content: [{ type: 'text', text:
JSON.stringify(value) }], structuredContent: value }`, carrying the value unchanged
   alongside the backwards-compatible text. A value-less success retains the required
   empty text block and omits `structuredContent`.
6. **One modern seam, subscriptions included, and `-32601` for anything off it.**
   `server/discover`, `tools/list`, `tools/call`, and `subscriptions/listen` are registered on `server.methods` at
   construction — unconditionally, because they need no consumer port — and
   `resources/list` / `resources/read` / `resources/templates/list`,
   `prompts/list` / `prompts/get`, and `completion/complete` are registered THERE TOO,
   each only when its own `resources` / `prompts` / `completion` option was supplied,
   and each advertising its capability (`resources`, `prompts`, `completions`) on the
   same condition. `completions` is independent of the other two. An omitted port
   registers nothing and advertises nothing, so its methods answer `-32601` through the
   ordinary unregistered path, and a server configured with none of the three has a
   byte-identical discovery answer to one built before they existed.
   EVERY modern method is resolved from there — `add` under an
   existing name replaces it, so a consumer's override wins by ordinary
   registration rather than by a precedence rule, and there is no second
   dispatch path. An id-bearing request whose method resolves to `undefined`
   (modern) or falls off `MCPLegacy`'s fixed set resolves a
   `JSONRPC_METHOD_NOT_FOUND` error whose message names the method. The modern
   metadata checks (`-32602`, `-32022`) run BEFORE the seam is consulted, and a
   legacy method never reaches it — the decorator answers or refuses at its own
   door, and only its three translated methods travel on. The seam carries the REQUEST arm:
   dispatch short-circuits every notification before the registry is read, so no
   registered handler is ever invoked for one, and a handler that nevertheless
   resolves nothing for a request is CONTAINED as `-32603` plus exactly one
   `error` event rather than resolving `dispatch` as `undefined` against an
   overload that promises a response. A modern `subscriptions/listen`
   requires `params.notifications`; the server acknowledges the exact intersection
   with its configured support, and that acknowledgement is the first message
   carrying this request's reserved subscription id. Every delivered notification
   carries the same stamp. Ending the event-driven producer closes gracefully with
   `{ resultType: 'complete', _meta: { 'io.modelcontextprotocol/subscriptionId': id,
… } }`. The request id is only stream identity: a later request does not supersede
   an earlier one. The legacy method remains absent and answers `-32601`.
7. **`handle` maps the boundary failures.** A `JSON.parse` throw (malformed
   JSON) → a serialized `-32700` (Parse error) response with NO `id` member; a
   message above `limit.message` reaches that same response BEFORE `JSON.parse`;
   `_meta` is then bounded by serialized bytes, total object keys, and depth
   before modern context parsing; `requestState` is bounded before HMAC verification
   and before/after signing; the complete produced modern tool-call result—including stamps,
   metadata, and duplicated text/structured representations—is bounded before serialization; and
   built-in subscription admission is capped until each stream's `finally` releases it.
   Metadata/state failures use `-32602`; content/capacity failures use `-32603`. A
   parsed value that is not a valid INVOCATION (a response, or any non-message)
   → a serialized `-32600` (Invalid Request) response with NO `id` member. The
   raw-string parse is the ONLY `try`/`catch`; the guards (`parseJSONRPCMessage`
   over `isJSONRPCMessage`) are total and never throw.
8. **Total wire guards.** `isBoundedString` / `isBoundedJSON` / `isJSONRPCId` /
   `isJSONRPCRequest` / `isJSONRPCNotification` / `isJSONRPCInvocation` /
   `isJSONRPCResultResponse` / `isJSONRPCErrorResponse` / `isJSONRPCResponse` /
   `isJSONRPCMessage` / `isMCPResult` / `isMCPLegacyResult` /
   `isInitializeRequest` / `isMCPSubscriptionFilter` are total functions over an
   already-parsed `unknown` — adversarial input returns `false`, never
   throws. `isBoundedJSON` is iterative and rejects excessive depth, cycles,
   accessors/hostile proxies, `Map`/`Set`, and non-JSON values while accepting
   hostile-looking own data keys. Each pair of arms is MUTUALLY EXCLUSIVE on every
   input, so a positive answer names exactly one arm: `isJSONRPCRequest` requires
   a valid `id` and `isJSONRPCNotification` requires no own `id` member; a result
   response requires an `id` and an OBJECT `result` with no `error`, while an error
   response permits an ABSENT `id` and requires an `error` with no `result`;
   `isMCPResult` requires a string `resultType` and `isMCPLegacyResult` requires
   its absence. `null` is refused as an `id` everywhere — `isJSONRPCId` accepts a
   string or a finite integer and nothing else — and numeric ids and error codes are
   finite integers. `parseJSONRPCMessage` returns a frozen owned snapshot;
   every non-`undefined` output satisfies `isJSONRPCMessage` and shares no caller-owned graph.
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
    and fires `request` (method, the id or `undefined` for a notification, era) at the TOP of every `dispatch`,
    BEFORE the method runs, and `error` exactly ONCE for every operational fault it
    contains — a throwing execution provider, registered handler, subscription source,
    continuation, or principal — carrying the caught value the wire never sees; the
    emitter isolates a listener throw, routing it
    to its OWN `error` handler (the `error` option, surfaced as `(error,
event)`, NOT a domain event) — so a buggy observer can never corrupt a
    dispatch, and a throwing `error` handler neither escapes nor recurses.
11. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly
    the public methods of each behavioral interface — `MCPServerInterface`,
    `MCPMethodManagerInterface`, `MCPClientInterface`,
    `MCPClientTransportInterface`, and `MCPSessionInterface`, plus the four
    consumer-supplied PORTS this package defines and does not implement
    (`MCPTaskManagerInterface`, `MCPResourceManagerInterface`,
    `MCPPromptManagerInterface`, `MCPCompletionManagerInterface`, which have tables
    but no implementing class here, exactly because the host writes the class) —
    exhaustive, both
    directions, so the client's table carries `discover` alongside `connect` /
    `disconnect` / `tools` / `call` / `on`, and each implementing class (`MCPServer` /
    `MCPClient`; the SEVEN transports `HTTPClientTransport` /
    `WebSocketServerTransport` / `WebSocketClientTransport` /
    `StdioClientTransport` / `StdioServerTransport` (`src/server`) plus the
    browser face's own `HTTPClientTransport` / `WebSocketClientTransport`
    (`src/browser`), all seven implementing the one `MCPClientTransportInterface`;
    and `MCPSession`) exposes the same public methods, no more. The
    `HTTPDisconnect` entity exposes only `bridge` (its `signal` is data). The remaining
    exports add no behavioral interface with methods (the factories,
    `acceptsEventStream` / `readSessionHeader` /
    `readLastEventId` / `rejectUnknownSession` / `readEventStream` /
    `decodeEvent` / `upgradeRequestPath` / `extractLines` / `dispatchLines` /
    `createScopeMessageListener` are functions; the options interfaces / event
    maps / `EventStoreEntry` / `LineExtraction` are bags), so they contribute
    no `## Methods` row. `MessagePortTransport` (`src/browser`) is likewise
    excluded: it implements `MCPTransportInterface`, not
    `MCPClientTransportInterface`, and `MCPTransportInterface` itself is
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
in request`, no `as`) — is HTTP **400** with a JSON-RPC error BODY carrying no
    `id` member. A legacy DISPATCH result — success or in-band JSON-RPC error — is
    HTTP **200**. A modern result is **400** for `-32020` / `-32021` / `-32022`
    / `-32602`, **404** for `-32601`, and **200** otherwise; every notification
    is **202** with no body. Modern `MCP_PROTOCOL_VERSION_HEADER` and
    `MCP_METHOD_HEADER` values must equal the body; `MCP_NAME_HEADER` is required
    only for `tools/call`. The first missing or mismatched field is named with its
    derived expectation, never its client-supplied value; the result is **400** +
    `-32020` with no `data`.
    Headerless `initialize` is accepted; a live-session legacy request uses its
    pinned negotiated revision; every other headerless request is **400** +
    `-32020`. A request without `Origin` is allowed; a canonical `localhost`, `[::1]`,
    or `127.0.0.0/8` literal origin is allowed by default; every other present
    serialized origin requires an exact consumer-supplied `origin.origins` entry or
    receives **403**. The predicate reads only `Origin`, never the request URL, `Host`,
    or another request header. `origin.enabled: false` explicitly delegates validation
    to an upstream layer. When `streaming` is enabled (default `true`) and the client
    `Accept`s `text/event-stream` (`acceptsEventStream`), the 200 reply is one
    SSE `data:` event over `@orkestrel/server`'s `openStream` seam, then the
    stream ends, carrying `X-Accel-Buffering: no`; else a plain JSON body. A
    held-open dispatch result always uses that SSE seam: yields are written in
    order, the generator's returned response is written last, and the response
    ends after it. The route supplies a signal composed from `request.signal` and
    response-stream cancellation to `mcp.dispatch`. After origin/body/JSON-RPC/modern-metadata-shape/header
    validation, and only for a request that will dispatch, it synchronously calls the optional
    `MCPCallerHandler` immediately before dispatch; a defined result is added as asserted
    `caller`, while absence is omitted. The session middleware preserves the incoming signal,
    headers, and route state across each forwarded `Request`; the pump awaits
    the async iterator and never polls. An SSE comment is written every configured
    `keepalive.interval` (default `DEFAULT_MCP_KEEPALIVE_INTERVAL`), so an idle
    streamed response notices a dead client within one interval; this is transport
    liveness, not polling for producer work. Unary dispatch completes before response
    streaming begins and receives no keepalive, so the HTTP face cannot cancel a
    long-running unary request mid-flight.
    `createMCPRoutes` mints / reads NO
    session id. It is MECHANISM, not policy: auth / rate-limiting / sessions
    compose IN FRONT as ordinary middleware; origin policy is only the
    consumer-provided list.
13. **The CLIENT is the dual-era egress mirror (`src/core`).**
    `createMCPClient({ transport, identity?, capabilities?, version?, timeout?,
on? })` drives a REMOTE server over an injected `MCPClientTransportInterface`
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
    `protocolVersion` rejects; a rejecting `connect()` closes the connection that
    attempt opened, unless the `disconnect` that superseded it closed that
    connection first. A valid legacy revision and the connected
    state are installed only after `notifications/initialized` is written, so a
    failed notification leaves the client disconnected. Modern connect sends
    NO notification. The readonly `version` surface exposes the negotiated
    revision while connected and is `undefined` while disconnected. A parseable discovery
    response other than the two legacy fallback errors settles the modern era before result
    validation, so a malformed or unsupported result type surfaces instead of degrading.
    `discover()` exposes a validated modern discovery result,
    filtering unknown advertised revisions from its `MCPVersion` collection. It validates the
    exact open server-capability shapes and exact metadata before returning, rejects malformed
    known fields or extension identifiers/values, and snapshots accepted capability/metadata
    records with the installed exact JSON clone primitive so transport-owned objects cannot drift.
    `tools()` runs `tools/list` and wraps each descriptor as a
    local `ToolInterface` — `name` narrowed (`isString`), `inputSchema` mapped
    back to `parameters` (the inverse of clause 4's rename, no `as`),
    `execute` bound to `call(name, …)`. `call(name, args)` runs `tools/call`,
    concatenates the result's `text` content blocks and THROWS an `Error` carrying the text when
    `isError === true`, else `JSON.parse`s the text (raw-string fallback;
    empty → `undefined`); so a remote tool failure throws locally and an
    agent's `ToolManager` isolates it into a `success: false` result exactly
    like a local throw. `disconnect()` rejects every pending request, clears
    negotiated revision, closes the connection the client opened on the
    transport — an attempt it supersedes inside `start()` owns none yet and
    closes what it opens itself — and fires `disconnect` only where the client
    had announced `connect`, without clearing the lifetime era cache. The WAIT
    on that `close` carries the per-request deadline, the only bound that
    reaches it: a shutdown the transport accepts and never answers rejects its
    caller instead of holding `disconnect` and every later `connect()` for the
    process's life. The deadline ends the wait, never the close — a fault says
    the shutdown did not happen, a deadline says only that this client stopped
    waiting to hear whether it did — so the still-running close is RETAINED and
    the next caller that owes it joins it under a fresh deadline instead of
    sending a second `close` over one connection. Its eventual answer settles
    the debt: resolving discharges the connection's ownership, rejecting leaves
    it owed and closable again. A `close` that faults or goes unanswered rejects
    the caller and leaves that connection owned, so a later `disconnect` settles
    it again rather than stranding a connection no path can reach. It is
    idempotent: one issued while another is closing joins it and returns that
    outcome, and one issued with nothing connected, no attempt in flight, and no
    connection left open by a failed close does nothing. A `connect()` issued
    while an attempt a `disconnect` superseded is still unwinding outwaits it,
    and one issued while a close is still OWED settles that connection first —
    rejecting with the fault if it fails or goes unanswered again — so `start()`
    is never called beside a connection an earlier close did not close.
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
    hanging. The discovery probe is the exception: it is
    unbounded when `timeout` is omitted because the transport cannot distinguish
    an unbound channel from a silent peer; an explicitly supplied `timeout`
    enables its short probe bound. That applies to a public `discover()` call as
    well as to the probe `connect()` issues, so `discover()` on a default client
    waits on a silent peer indefinitely. A `send` write failure rejects
    its own pending request. The same `timeout` bounds the client's WAIT on the
    transport's `close`: that await holds no pending entry, so neither the drain
    nor a request deadline reaches it, and a shutdown accepted and never answered
    would otherwise wedge the client. Because it bounds the wait and not the
    close, a short `timeout` set for fast request-failure detection is also a
    short shutdown grace.
    Observable: the client owns an `emitter` (`MCPClientEventMap`) firing
    `connect` / `disconnect` / `notification` / `error`; the emitter
    isolates a listener throw, routing it to its `error` handler (the
    `error` option, NOT a domain event); `on(...)` is the convenience
    forward to `emitter.on`.
15. **The HTTP CLIENT transport drives a remote server over `fetch`
    (`src/server`).** `createHTTPClientTransport({ url, headers?, fetch?,
timeout? })` returns a `MCPClientTransportInterface` whose `send` POSTs one
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
    `WebSocketServerTransport` REUSES `MCPClientTransportInterface` (`session`
    `undefined`, `start` arms the socket subscriptions, `send` writes ONE
    text frame per message, `close` closes the socket): inbound text frames
    are `JSON.parse`d (guarded) + narrowed via `parseJSONRPCMessage` onto
    `message`, a malformed / non-message frame surfaces on `error` and is
    DROPPED, and the socket's `close` bridges to the transport's `close`.
17. **The WebSocket CLIENT transport drives a remote server over an upgrade
    (`src/server`).** `createWebSocketClientTransport({ url, headers? })`
    returns a `MCPClientTransportInterface` — the WebSocket egress mirror of
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
    (`src/server`).** `createMCPSession({ path?, ttl?, capacity?, clock?, origin?, keepalive? })`
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
    re-reads the same body, retains front-middleware state for caller extraction,
    injects that pinned revision when a live-session POST
    is headerless, and stamps the response with `MCP_SESSION_HEADER`. A
    live-session POST whose `MCP-Protocol-Version` header names a DIFFERENT
    revision than the session pinned is `400` + `-32020` — a session negotiates its
    revision once, and a later request may not renegotiate it.
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
    stream FIRST, THEN `session.attach(stream)`, THEN detaches on the composed
    request / response-stream `AbortSignal` firing (or immediately if already
    aborted). Its configured keepalive bounds idle disconnect detection to one
    interval. The stream is long-lived — it is NEVER `end()`ed by the middleware.
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
21. **The browser transport carries the SAME `MCPClientTransportInterface`
    contract over native host APIs (`src/browser`).**
    `createWebSocketClientTransport({ url, protocols? })` returns a
    `MCPClientTransportInterface` whose `start()` opens `new WebSocket(url,
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
    `MCPClientTransportInterface` whose `send` POSTs to `url` over the injectable
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
    (not a `MCPClientTransportInterface` — the SAME class works as either a
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
23. **Wire names stay verbatim; library names obey the naming laws.** A type that
    models a protocol message carries the wire's own field names unchanged, including
    `jsonrpc`, `_meta`, `resultType`, `ttlMs`, `cacheScope`, `supportedVersions`,
    `inputSchema`, `isError`, `structuredContent`, `inputRequests`, and `requestState`.
    Everywhere the library speaks for itself, the repository naming laws bind fully,
    including `identity`, `instructions`, `cache.ttl`, `version`, `discover()`, and
    `era`.
24. **`tools/list` order is deterministic.** Each response lists tool descriptors in
    the live `ToolManagerInterface` definition order; repeated requests against the
    same registry state return the same order.
25. **MCP expands no URI templates, at any RFC 6570 level.** `resources/templates/list`
    publishes each `uriTemplate` as an opaque descriptor STRING and validates only that
    it is a nonempty string; `MCPResourceManagerInterface.resource` and
    `MCPResourceReadParams.uri` take the CONCRETE URI the client sent. Matching a URI
    to a template, and substituting its variables, happen entirely inside the
    consumer-supplied manager. There is no template parser and no RFC 6570
    implementation anywhere in `src/`, so the package has no feature level to state and
    the question of which level to support does not arise. The same division governs
    `completion/complete`: an `MCPResourceTemplateReference` is forwarded to
    `MCPCompletionManagerInterface.complete` verbatim, template and all, because
    completing a template's arguments requires knowing that template's variables and
    the party that owns expansion is the party that knows them.
26. **One pagination shape, and every cursor is the manager's.** `resources/list`,
    `resources/templates/list`, and `prompts/list` take `MCPPaginationParams`
    (`{ cursor? }`) and answer `MCPPaginationResult` (`{ nextCursor? }`); no second
    cursor shape exists in the package. The cursor is OPAQUE: this package validates
    that a present one is a string, forwards it unread, and copies a returned
    `nextCursor` through without interpretation, so paging strategy, cursor encoding,
    and stability across pages all belong to the manager. An omitted `nextCursor` is
    the final page, and there is no sentinel spelling of "no more pages".
27. **Not found is `undefined` at the port and `-32602` on the wire.**
    `MCPResourceManagerInterface.resource`, `MCPPromptManagerInterface.prompt`, and
    `MCPCompletionManagerInterface.complete` each answer `undefined` for something they
    do not resolve, and the server maps that to `JSONRPC_INVALID_PARAMS` naming the
    unresolved URI or prompt. `-32002` is the pre-`2026-07-28` spelling a client SHOULD
    still accept from an older peer and this server never produces. `resource` and
    `prompt` may instead answer an `MCPInputResult`, which is stamped and returned as the
    `input_required` arm; a manager answer that is neither a valid result nor
    `undefined` is contained as `-32603`. Completion candidates are projected to at
    most 100 values, stamping `hasMore: true` when the projection truncated.
