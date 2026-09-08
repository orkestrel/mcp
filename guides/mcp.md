# MCP

> The Model Context Protocol layer: a typed JSON-RPC 2.0 client/server pair with pluggable
> HTTP, WebSocket, stdio, and browser transports.

**Ingress:** `createMCPServer` wraps a live `ToolManagerInterface`
(`@orkestrel/tool`) as an MCP server any MCP client can drive, and projects
further host-owned registries — `resources` and `prompts` — plus a `completion`
provider, each over a port this package defines and does not implement. **Egress:**
`createMCPClient` drives a _remote_ MCP server and surfaces its tools as local
`ToolInterface`s an agent can call as if they were its own. Requests are
dispatched by structural wire era — a modern request resolves from a registrable
method seam carrying the built-in `server/discover`, `tools/list`, `tools/call`,
and `subscriptions/listen`, plus `resources/*`, `prompts/*`, and
`completion/complete` for each port a consumer configured. The dated revisions
are an optional decorator over that one engine — `createMCPLegacy(mcp)` translates a
fixed `initialize` / `ping` / `tools/list` / `tools/call` set onto it and the server
itself holds no era branch. See [Protocol](#protocol),
[Compose or remove the legacy protocol layer](#compose-or-remove-the-legacy-protocol-layer), and
[Project a host-owned resource, prompt, and completion registry](#project-a-host-owned-resource-prompt-and-completion-registry).

**The dispatch core is transport-agnostic and provider-agnostic.** `MCPServer`
and `MCPClient` live in [`src/core`](../src/core) and import only siblings —
JSON-RPC types, `@orkestrel/tool`'s tool registry, `@orkestrel/emitter`'s
observable surface, `@orkestrel/contract`'s guards, `@orkestrel/codec`'s Base64
coding. No HTTP, no WebSocket, no stdio, and no `as`: every value off the wire is
narrowed by a total guard. The
server's entry points are `dispatch` and `handle` — `dispatch` runs an already-parsed
`JSONRPCInvocation`, resolving a `JSONRPCResponse` for a `JSONRPCRequest` and
`undefined` for a `JSONRPCNotification` (its overloads say exactly that, so
neither caller handles the other's answer), and `handle(message)` is the string
boundary that wraps it with `JSON.parse` / `JSON.stringify` plus the parse
(`-32700`) and invalid-request (`-32600`) mapping, each of whose envelopes omits
the `id` it could not read. The client mirrors it: `connect` negotiates the modern revision, `tools()`
exposes the remote tools as local `ToolInterface`s, and `call` runs one — a
remote failure throws locally, so an agent's `ToolManager` isolates it exactly
like a local throw. A remote JSON-RPC error rejects with `MCPError`, preserving
its numeric `code` and optional `error.data` as `context`.

**The wire lives one layer out.** [`src/server`](../src/server) carries the
Node transports and [`src/browser`](../src/browser) the browser face.
Each is a matched ingress/egress pair speaking the same `MCPServerInterface` /
`MCPMessageTransportInterface`; only the framing differs:

- **Streamable HTTP** — `createMCPRoutes` mounts a server as `POST {path}` (JSON
  or SSE per the client's `Accept`, using `@orkestrel/server`'s `createStream`); the
  opt-in `createMCPSession` middleware adds native stateful sessions and a
  resumable server→client SSE channel. `createHTTPClientTransport` is the
  injectable-`fetch` egress.
- **WebSocket** — `createWebSocketServer` claims an upgrade on
  `@orkestrel/server`'s upgrade seam, composing `@orkestrel/websocket`'s RFC 6455
  wrapper for full duplex over one persistent connection, and closes every socket
  it claimed when that spine stops. `createWebSocketClientTransport` is the
  `node:http(s)`-upgrade egress.
- **stdio** — `createStdioServer` pumps newline-delimited JSON-RPC over a
  process's `stdin`/`stdout` (or injected streams); `createStdioClientTransport`
  spawns a child process and drives the same protocol over its piped stdio.
- **browser** — the page / Web Worker / Service Worker face: its own
  `WebSocket` client transport over the native global, the same core HTTP client
  transport the Node face returns, plus the symmetric
  `MessagePort` carrier and the `createScopeServer` worker bootstrap.

**Every transport is mechanism, not policy.** Auth, invocation rate limiting, and
body-size guards compose in front as ordinary `@orkestrel/server` middleware.
HTTP ingress supplies only the protocol-required origin gate, on by default: a
request without `Origin` passes; a canonical `localhost`, `[::1]`, or `127.0.0.0/8`
literal origin passes; every other present origin must occur in the shared
`origin.origins` list; and a deployment that validates upstream delegates with
`origin.enabled: false`. What this package deliberately does not build is listed
under [Declared non-goals](#declared-non-goals); the obligations it does not meet
are under [Declared conformance gaps](#declared-conformance-gaps).

**Observable.** The `MCPServer` owns an `emitter` firing `request` per dispatch;
the `MCPClient` owns one firing `connect` / `disconnect` / `notification` /
`error`; every transport owns one firing `message` / `close` / `error`.

## Protocol

The layer speaks its dated revisions across the modern and legacy wire **eras**, on one
endpoint, with no era flag anywhere in the API. Era is the shape of the wire; version is the revision
it names.

| Revision     | Era    | How a request announces it                                                                |
| ------------ | ------ | ----------------------------------------------------------------------------------------- |
| `2026-07-28` | modern | Per-request `_meta` carrying the reserved protocol-version key. No handshake, no session. |
| `2025-11-25` | legacy | The `initialize` handshake. `MCP_HANDSHAKE_VERSION` — the revision this server offers.    |
| `2025-06-18` | legacy | The `initialize` handshake. `MCP_FALLBACK_VERSION` — the older anchor an adapter may pin. |

`SUPPORTED_MODERN_PROTOCOL_VERSIONS` is the bare server's frozen modern set and the exact
`server/discover` advertisement: `2026-07-28`. `SUPPORTED_LEGACY_PROTOCOL_VERSIONS`
contains the initialize revisions that `createMCPLegacy` alone accepts.
`SUPPORTED_MCP_VERSIONS` combines those era-scoped sets for the version guards and
the explicit client adapter; it never becomes a bare-client or server advertisement. Older revisions are deliberately absent,
and their absence is this package's decision rather than the ecosystem's — see
[Declared non-goals](#declared-non-goals).

**The era discriminator is key presence.** A request is modern **iff** the key
`params._meta['io.modelcontextprotocol/protocolVersion']` (`MCP_META_VERSION`) is
present — the key itself, not its value and not its type. **Presence routes;
validity answers.** The steps are separate on purpose. A legacy `2025-06-18`
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
`io.modelcontextprotocol/logLevel` accepts only the dated logging literals, and
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
required on each method whose body carries a named target — `tools/call` and
`prompts/get` against `params.name`, and `resources/read` against `params.uri` — and MUST
not be required on `server/discover`, `tools/list`, `resources/list`, or `prompts/list`,
none of which carries anything to derive a target from. The first missing or mismatched
field is named in the refusal, together with the server-derived expected value; the
client-supplied header value is never echoed. The result remains HTTP `400` + `-32020`,
with no `data`.

**A value a header cannot carry travels in the Base64 sentinel.** A target that is not
plain printable ASCII, that carries leading or trailing whitespace, or that already wears
the sentinel markers cannot survive as a literal field value, so it travels as
`=?base64?{Base64OfUTF8}?=` — markers lowercase and exact. `encodeSentinel` builds that
form and leaves every other value literal; `decodeSentinel` reads it back, excluding
optional whitespace first per RFC 9110 § 5.5. The server decodes before comparing, so an
encoded header still matches its body. A value wearing the markers whose payload is not
canonical Base64 over well-formed UTF-8 is refused rather than read as a literal, and the
refusal is the same HTTP `400` + `-32020`. `@orkestrel/codec`'s `decodeBase64` owns that
grammar, so the payload is held to the RFC 4648 § 4 canonical spelling: a payload leaving a
non-zero bit in the sextet its padding discards is a second spelling of a byte and refuses,
which makes `=?base64?QR==?=` invalid where `=?base64?QQ==?=` carries the byte it reached
for. The same package's `decodeUTF8` owns the text step behind it — strict RFC 3629, so an
overlong, an encoded surrogate, a code point past U+10FFFF, and a truncated sequence each
refuse, and total, so the refusal arrives as `undefined` rather than as a throw. It keeps a
leading U+FEFF as a character of the value where the platform decoder consumes it as a byte
order mark, so a target leading with U+FEFF survives `encodeSentinel` and comes back whole.
The encode side stays on the platform `TextEncoder`: it is total, spelling ill-formed text
with the replacement character, where `encodeUTF8` would refuse it and widen
`encodeSentinel` to answer `undefined`. `isStandardBase64` is a wider and separate rule that
names JSON Schema `byte` membership for the blob, image, and audio content a peer sends; it
does not govern this payload.

Use the client and HTTP transport together and none of that wire anatomy reaches the
call site — the transport derives all reserved metadata and headers:

```ts
import { createMCPClient } from '@orkestrel/mcp'
import { createHTTPClientTransport } from '@orkestrel/mcp/server'

const transport = createHTTPClientTransport({ url: 'https://mcp.example/rpc' })
const client = createMCPClient({ transport })
```

The equivalent raw modern `tools/call` carries the reserved request metadata keys
and their HTTP projections side by side:

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

`Mcp-Name` applies to `tools/call`, `prompts/get`, and `resources/read`; omit it for
`server/discover`, `tools/list`, `resources/list`, and `prompts/list`. The reserved client
capability and identity metadata remain in `_meta` and have no separate standard headers.

**The client stamps `Mcp-Name` for `tools/call` alone**, because that is the one named
method `MCPClientInterface` publishes: it exposes no `prompts/get` and no `resources/read`
call, so no request needing a prompt or a resource target can leave through it. A consumer
issuing either method over its own transport stamps the header itself, through
`encodeSentinel`. The server validates `tools/call`, `prompts/get`, and `resources/read`
alike.

**A tool parameter can name its own header.** A property schema inside a tool's
`inputSchema` carries `x-mcp-header: 'Region'`, and a `tools/call` supplying that argument
carries it again as the `Mcp-Param-Region` request header. The annotation lets a gateway
route or authorize on the value without parsing the body, which is why the server must
check that the header and the body agree. `buildHeaderParameters` reads the annotations one
`inputSchema`
declares, `buildHeaderProjection` turns them plus a call's `arguments` into the headers,
and both sides of the protocol run the same pair.

The annotation is valid only under all of these:

- its value is a non-empty RFC 9110 token — `isFieldToken` — so no space, colon, control
  character, or non-ASCII code point;
- its values are unique case-insensitively within the one `inputSchema`, because HTTP
  field names are case-insensitive;
- it sits on a `string`, `integer`, or `boolean` leaf. `number` is refused, because a JSON
  number has no interoperable decimal text form to compare against;
- that leaf is statically reachable from the `inputSchema` root through `properties` keys
  alone — never through `items`, a composition or conditional keyword, or a `$ref` target.

An annotation breaking any of them makes the whole tool definition invalid, and the client
and the server answer that differently. An HTTP **client** excludes the tool from the `tools/list`
result it delivers and reports the exclusion on its transport `error` event naming the
tool; a valid sibling in the same listing survives. A **server** recognizes no
`Mcp-Param-*` name from an invalid definition, so it validates nothing for it.

The value's text is fixed: a string travels as itself, an integer in decimal, a boolean as
lowercase `true` or `false`, and the result then rides through the same `encodeSentinel`
sentinel a standard header uses. An argument the call omits or supplies as `null` carries
no header at all — that is the protocol's distinction between "not supplied" and "supplied
empty", and an empty string still travels as an empty header value.

The server refuses HTTP `400` + `-32020` when a recognized `Mcp-Param-*` header is absent
while the body supplies its value, when its payload is not a valid Base64 sentinel, when
the decoded value disagrees with the body, or when it asserts a value the body omits. An
`integer` parameter compares numerically, so a peer that padded its decimal still matches.
A `Mcp-Param-*` name no served definition annotates is another party's header and travels
through untouched.

**A headerless legacy POST has exactly these cases.** The library infers no revision
from an absent header. Defaulting one is licensed only for a server that still serves
pre-`2025-06-18` clients, and this package does not:

- `initialize` — legitimately headerless; nothing is negotiated yet. Accepted.
- A post-`initialize` legacy request on a **live session** — accepted, under the
  revision pinned at that session's `initialize`. That is a negotiated fact, not a
  default.
- Anything else — nothing identifies the revision, so HTTP `400` + `-32020`.

A header naming an unsupported revision is a separate failure: HTTP `400` + `-32022`,
carrying `{ supported, requested }`.

**A modern protocol header holds the request to the modern revision.** A POST whose
`MCP-Protocol-Version` names a revision in `SUPPORTED_MODERN_PROTOCOL_VERSIONS` is a client
declaring the revision this server implements, so its body owes that revision's reserved
`_meta`. A body with no parsable modern `_meta` — none at all, or one omitting
`io.modelcontextprotocol/protocolVersion` or `io.modelcontextprotocol/clientCapabilities` —
is HTTP `400` + `-32602`, not the legacy door's `-32022`. Answering `-32022` there would
claim this server does not implement the revision it does implement.

**Status is per era.** A legacy dispatch result keeps a uniform HTTP `200` and reports
its errors in band, byte-identically to what a `2025-06-18` client already expects. A
modern result maps to real statuses: `202` for a notification, `400` for `-32020` /
`-32021` / `-32022` / `-32602`, `404` for `-32601`, and `200` otherwise. A
transport-level failure — malformed JSON or a body that is not a JSON-RPC request — is
`400` under both eras, because no era was ever established. See
[Route a request by era and build a modern result](#route-a-request-by-era-and-build-a-modern-result)
for the inferers this rides on.

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
const reply = await server.handle(
	'{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}',
)
// reply → '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"add","inputSchema":{"type":"object"}}]}}'

const out = await server.handle(
	'{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"add","arguments":{"x":2,"y":5},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}',
)
// out → '…"result":{"content":[{"type":"text","text":"7"}],"structuredContent":7}}'
```

`dispatch` is the typed core; `handle` wraps it with the `JSON.parse` ↔
`JSON.stringify` string boundary and the parse / invalid-request error
mapping. The configured message-byte limit is checked before `JSON.parse`, so
an oversized valid document receives `-32700` without first allocating its parsed
graph. A call with no `id` is a **notification** — a type of its own, handled
(the `request` event still fires) but yielding no response (`dispatch` resolves
`undefined`, `handle` returns `undefined`), whatever its method. The error
envelopes omit the `id` they could not read; a `null` `id` never reaches the
wire. Tool errors
are not protocol errors: the `ToolManager` (`@orkestrel/tool`) isolates a
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

A JSON-RPC message splits on invocation and on response, and the types make each
split unrepresentable to get wrong. An invocation is a **request** — a `method` call
carrying the `id` that correlates it with its answer — or a **notification**, the
same call with no `id`, answered by nothing. A response is a **result** arm or an
**error** arm, never both. Each guard is total over an already-parsed `unknown`,
and each pair is mutually exclusive on every input, so a positive answer names
exactly one arm.

**An `id` is present or it is not there at all.** `null` is not an id anywhere in
this layer — not on a request, not on a response, not on the wire. The error arm
is the one place an `id` may be absent, and absence there means omitted: MCP
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

`MCPResult` is open — it requires a string `resultType` and leaves the rest of
the object alone, because the dated schema keeps issuing new discriminators
(`task` beside `complete` and `input_required`). The concrete results stay
closed and keep their literal, so a caller that knows which method it called
still narrows through that result's own guard. `MCPLegacyResult` is the disjoint
arm: the legacy revision has no discriminator concept, so `resultType` is
forbidden there, and `MCPResult` and `MCPLegacyResult` are unassignable in both
directions.

### Register a modern method on the seam

The modern branch answers from one registry, `server.methods`. The built-in
methods are registered on it at construction — plus the `tasks/*` methods
when the stable Tasks extension is configured — so a method
added later is not a special case. It is the next registration,
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
short-circuits every notification before the registry is read. Nothing answers a
notification, and now nothing has to say so.

Answering is not optional either. `MCPMethodHandler` returns a
`JSONRPCResponse` or an `MCPStream` and nothing else, because a handler that
resolved `undefined` for a request would contradict `dispatch`'s own overloads
and leave the caller waiting to its deadline. The registry is open, so a handler
that was never typechecked against the seam can still arrive; dispatch contains
that as `-32603` plus one `error` event rather than passing the absence on.

A handler also receives an `MCPMethodOptions` bag — the resolved mirror of the
`MCPDispatchOptions` a caller passes. Its `signal` aborts when the bound
transport can observe that the caller's request has ended, and it is required
here even though a caller may supply none: dispatch resolves one at the single
ingress, so no handler has to case on absence. Its optional `caller` is
consumer-asserted context carried opaquely from the dispatch site. Both
`dispatch` and `handle` take the caller-facing bag as an optional second
argument:

```ts
server.methods.add('demo/slow', async (request, options) => {
	options.signal.addEventListener('abort', () => release())
	return buildJSONRPCResult(request.id, {})
})

const controller = new AbortController()
await server.dispatch(
	{
		jsonrpc: '2.0',
		method: 'demo/slow',
		id: 1,
		params: {
			_meta: {
				'io.modelcontextprotocol/protocolVersion': '2026-07-28',
				'io.modelcontextprotocol/clientCapabilities': {},
			},
		},
	},
	{ signal: controller.signal },
)
```

`caller` is **asserted, never verified**. Sessions mint transport identity, not
caller identity; nothing in MCP authenticates this value, and this package never
inspects, validates, or serializes it. Narrow it with your own total guard and
treat absence as unauthenticated. It remains `unknown`, rather than a threaded
generic that would falsely promise protocol verification.

A handler that must hold the request open returns an `MCPStream` instead of
a response: each `yield` is a `JSONRPCNotification`, and the generator's
`return` value is the terminating response — closure is a result, not an
out-of-band event, so consuming a stream ends exactly where consuming a
unary response ends. The yield type forbids an `id`, so a producer cannot put
a call the peer is expected to answer onto a stream that has no way to carry
the answer back — that is a type error at the `yield`, not a runtime rule.
`dispatch` surfaces the stream as a second return arm and `handle` mirrors it
as its serialized form, which `bindServer` pumps onto the transport.

**What leaves `dispatch` is always controlled.** A producer publishes a plain
`MCPStream`; dispatch is the one wrapping seam, so the caller receives an
`MCPStreamControllerInterface` and `handle` an `MCPTextStreamControllerInterface`. The
difference is who decides when the exchange ends. A native async generator queues
`return()` and `throw()` behind a `next()` the producer has not answered, so a consumer
walking away from a source parked on an event that never arrives waits forever for its
own cancellation. A controller settles the consumer's read itself, aborts the request's
signal before it delegates cleanup — which is what wakes a cooperating producer — and
contains whatever that producer settles late. `stop()` is the operation the protocol has
no member for: end the exchange with no terminal, from an owner that is not the consumer.

```ts
import { MCPTextStreamController, sendStream } from '@orkestrel/mcp'

server.methods.add('demo/watch', async (request) => watch(request))

const answer = await server.dispatch({
	jsonrpc: '2.0',
	method: 'demo/watch',
	id: 2,
	params: {
		_meta: {
			'io.modelcontextprotocol/protocolVersion': '2026-07-28',
			'io.modelcontextprotocol/clientCapabilities': {},
		},
	},
})
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
is holding. What the controller guarantees is that its consumer never waits for one.

**Ending a controlled exchange is the obligation of whoever is handed it, on every exit —
including the exits where nothing was cancelled.** One holds a producer, a request lifetime,
and (for `subscriptions/listen`) one of a finite number of live server slots, and a consumer
that walks away releases none of them, because no signal fires when nobody aborts anything.
So both shipped pumps — `sendStream` and `sendEventStream` — release from a `finally` that
covers the normal return, a mid-loop throw, and a carrier that closed underneath them, and
`bindServer` releases a held-open answer it has decided not to write. There is deliberately no
owner of last resort: a finalizer or a timeout would end exchanges nobody released and turn a
reproducible missing obligation into a nondeterministic one, and GC timing is not a lifecycle.

The obligation runs the other way too, and it is stated on the controller interfaces: a
conforming `[Symbol.asyncDispose]` **releases the producer, the request lifetime, and the live
slot before it may reject**. Disposal that throws first would let a cleanup fault mask the
pump's original failure while still leaking the exchange, so a disposal failure may report
cleanup and never prevent it.

The obligation is spelled `try { … } finally { await stream[Symbol.asyncDispose]() }` rather
than `await using`, and that is a measurement rather than a preference. `tsconfig` targets
`ESNext`, so TypeScript emits a `using` declaration verbatim instead of downlevelling it, and
this package's declared floor — `node >= 22.12.0` — rejects the emitted module at parse time
with `SyntaxError: Unexpected identifier`, taking every unrelated export in the file with it.
The same file written with the explicit `finally` runs on that floor and discharges the
identical obligation.

A legacy `tools/call` carrying a string or integer progress token receives a controlled
stream when the modern execution policy reports progress. `MCPLegacy` forwards only
`notifications/progress` frames carrying that request's token, then projects the terminal
complete or error response onto the legacy wire. A call whose executor reports no progress
still returns its projected terminal through the stream. Stopping the typed or text face
aborts the modern request lifetime and releases its controlled source.

The fixed legacy method set still refuses every other held-open answer. A `tools/list`
override stream, a `tools/call` stream without a legal token, and a stream yielding another
notification or another request's token end with `-32000`, because the dated revision has no
result shape for them. See
[Compose or remove the legacy protocol layer](#compose-or-remove-the-legacy-protocol-layer).

### Project a host-owned resource, prompt, and completion registry

Optional ports sit beside `tools`, and each obeys the rule the tool registry
already obeys: **MCP owns no storage.** The host builds and owns the registry; this
package projects it onto the wire, bounds and validates what comes back, and stamps
the result.

| Option       | Port                          | Methods it registers                                           | Capability advertised |
| ------------ | ----------------------------- | -------------------------------------------------------------- | --------------------- |
| `resources`  | `MCPResourceManagerInterface` | `resources/list`, `resources/read`, `resources/templates/list` | `resources`           |
| `prompts`    | `MCPPromptManagerInterface`   | `prompts/list`, `prompts/get`                                  | `prompts`             |
| `completion` | `MCPCompletionInterface`      | `completion/complete`                                          | `completions`         |

**A capability registers only when its port is configured**, which is the `tasks/*`
precedent applied to `resources`, `prompts`, and `completion` too. A server built without `resources` registers no
`resources/*` method, advertises no `resources` capability, and answers `-32601`
through the same unregistered-method path any unknown method takes — the honest reply
from a server that does not implement an optional capability, and the reason an
existing tools-only server's discovery answer is byte-for-byte what it was.

**`completions` is a top-level capability, not a sub-flag of `resources` or `prompts`.** It is
configured, advertised, and registered independently: a server may complete prompt
arguments without publishing prompts, or publish prompts without offering completion.
The gates read their own options and never each other.

**One pagination shape covers every paginated method.** `MCPPaginationParams`
(`{ cursor? }`) goes in and `MCPPaginationResult` (`{ nextCursor? }`) comes back, for
`resources/list`, `resources/templates/list`, and `prompts/list` alike. `tools/list` is
not among them — it reads no cursor and answers no `nextCursor`. The cursor is
opaque and the manager mints it: this package neither interprets one nor invents one,
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
`SHOULD` still accept from an older peer. Resource subscription lives on
[`subscriptions/listen`](#configure-modern-subscriptions)'s `resourceSubscriptions`
filter instead.

**A `resource` or a `prompt` call may answer `input_required`.** `resource` and `prompt` may
return an `MCPInputResult` rather than contents or messages, so the multi-round mechanism is
reachable from a resource or a prompt and not only from a `tools/call` — see
[Ask the client for input during the call in hand](#ask-the-client-for-input-during-the-call-in-hand).
A round the manager authored meets the server's capability gate before it is stamped and sent,
exactly as a `tools/call` round does, so a kind the client did not declare is refused `-32021`
here too. The `inputResponses` and `requestState` carriers arrive on the params for exactly
that continuation, and their semantics belong to the manager: core owns the carrier's shape,
bounds, and ownership, and refuses to decide what a consumer's own continuation means.

**`resources/list` / `resources/templates/list` / `prompts/list` are cacheable and
carry `ttlMs` + `cacheScope`; `prompts/get` is not and carries neither.** The stamps
come from the same `cache` option `tools/list` already uses, so one setting governs
every cacheable modern result.

**MCP expands no URI templates.** This is the load-bearing sentence of the whole
resource surface, so it is stated plainly rather than implied. `templates()` publishes
`uriTemplate` strings as descriptors, and `resource` takes a **concrete URI** — the one the
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
	type MCPCompletionInterface,
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

const completion: MCPCompletionInterface = {
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
`@orkestrel/workspace` and `@orkestrel/template` are obvious candidates. **Neither
is a dependency of this package and adopting one is entirely the host's decision**;
what follows is what an adapter has to bridge, because in both cases the shapes do not
line up and pretending otherwise would cost a reader an afternoon.

**Workspace → `resources`: the seams, and the addressing seam is not small.**

1. **A workspace addresses by path, and MCP addresses by URI.** That package says
   outright that a workspace is not a filesystem, and with several workspaces
   registered a bare path is ambiguous — two workspaces can both hold `readme.md`.
   Neither package defines a URI scheme, so **the adapter must mint one** and own it in
   both directions: path → URI on the way out, URI → workspace + path on the way back.
   Everything else here is mapping; this is design.
2. **The binary MIME set is closed** — `image/png`, `image/jpeg`, `image/gif`, and
   `image/webp`, and nothing else. There is no PDF and no CSV. An adapter must decide
   per file whether the content is text or a blob, and a file the workspace will not
   classify as one of those is text or it is nothing.
3. **A workspace has no pagination.** Its file listing returns everything, so the
   adapter slices the list and mints its own cursor — which is why the cursor is opaque
   in the first place. A first page and an unbounded workspace are the same call.
4. **Templates stay the adapter's.** If the adapter publishes `docs://page/{slug}`, it
   is the one that matches the concrete URI back to a workspace path, exactly as the
   ruling above requires.

**Template → `prompts`: a near-perfect match and a real mismatch.**
`TemplatePlaceholder` (`{ name, description?, required?, path?, fallback? }`) maps onto
`MCPPromptArgument` (`{ name, title?, description?, required? }`) almost field for
field, so `prompts/list` is nearly free. The output is not:
**`Template.fill()` returns a plain `string`, and `prompts/get` must return
`MCPPromptMessage[]`.** The adapter wraps the filled string in a single user message —
a real decision, not a formality, because a one-message array is the adapter's choice
about what a filled template means, and a template that was written as a dialogue has
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

Another seam that fence does not hide: `fill` defaults to the `'error'` missing
policy, so a required placeholder the client did not supply throws out of `prompt`. That
becomes a contained `-32603` with the caught value reported on the server's `error`
event, which is a defensible answer but not the informative one — an adapter that
cares must call `validate` first and return an
[`input_required` result](#ask-the-client-for-input-during-the-call-in-hand) asking for
the missing argument, or seed `missing: 'empty'` and accept the gaps.

**The control that proves these are ports rather than shaped holes** is that neither
adapter is privileged. `tests/setupConformance.ts` backs the same ports with plain
in-memory objects — no workspace, no template engine, no `@orkestrel/*` registry at
all — and the foreign conformance client cannot tell the difference, because there is
nothing on the wire that could. The compiler now agrees with the wire: that fixture is
TypeScript, annotated with the same exported manager interfaces this section documents,
so a plain object is a checked implementation of the port rather than a duck-typed
resemblance to one.

### Configure modern subscriptions

`subscription.notifications` declares what the server can actually honour;
`subscription.producer` opens the event-driven source for the intersected filter.
The built-in owns wire acknowledgement, filtering, id stamping, and graceful
closure. A producer only yields project notifications and ends its iterable when
the source closes; while idle it parks on its own events and may observe the
supplied abort signal.

**Every produced notification is owned before it is judged.** The built-in snapshots each
one into bounded exact JSON before it matches the filter or stamps the id, so the values
that admitted a notification are the values that reach the wire — a producer answering
differently on a second read cannot have one URI pass the filter and another ride out.
A notification that is not bounded exact JSON is dropped and the stream continues; a
producer that throws ends the subscription with one detail-free `-32603` terminal, its
caught value reported on the server's `error` event. Ending the source normally closes
with the complete result; an abort closes with no terminal at all, because a cancelled
request is not an answered one.

The filter keys — `toolsListChanged`, `promptsListChanged`,
`resourcesListChanged`, `resourceSubscriptions`, `taskIds` — and the `params.notifications`
object holding them are wire spellings carried verbatim from the dated schema.
They are the one place the compound-key rule does not apply, because these
strings are not this package's to choose. The type name is
`MCPSubscriptionFilter`, which is the library's own. Where `taskIds` sits inside that object
is this package's reading of an under-specified extension point rather than settled wire —
[Declared conformance gaps](#declared-conformance-gaps) records the search that ended there.

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
		producer: (_notifications, options) => {
			options.signal.throwIfAborted()
			return changes()
		},
	},
})
server.methods.method('subscriptions/listen') // registered on the same modern seam
```

**`taskIds` carries the stable Tasks extension's transitions down this same stream.** A
`notifications/tasks` frame reaches the built-in through the ordinary `subscription.producer`
every other family travels through, and the built-in admits it, filters it against
the agreed identifiers, and stamps it with the subscription id. The server honours the member
only when a consumer configured both `task` and `subscription`: the manager is what resolves
an identifier and the producer is what a transition arrives through, so either one missing
leaves nothing to deliver and the acknowledgement omits the member. That fact is derived from
`task` and `subscription` at the moment the listen request is answered; no stored flag records
it, so it cannot drift from them.

**Each requested identifier is authorized before the acknowledgement agrees to it.** The
server resolves every one through `MCPTaskManagerInterface.task(id, options)`, carrying the
same per-request options the rest of the dispatch carries, and acknowledges the identifiers
that resolved — in request order, duplicates intact, nothing normalized. An identifier the
read does not resolve is omitted with no distinguishing signal: unknown, purged, and
not-this-caller's produce byte-identical acknowledgements, because the port collapses each of
them into one `undefined` and an acknowledgement that separated them would publish a
difference the port refused to publish. When nothing resolves, the member is omitted entirely
rather than acknowledged as an empty array. A `taskIds` that is not an array of strings never
reaches the read at all — the filter guard refuses the request with `-32602` first.

**The agreed set is fixed for the subscription's lifetime.** Those reads happen once, at
acknowledgement, and delivery performs none: a per-frame read would put the consumer's durable
store on the hot path of every transition and re-decide, at delivery time, what the
acknowledgement already decided. Revoking access mid-stream is therefore the producer's to
enforce, because the producer holds the caller context and the store. A frame naming an
identifier outside the agreed set is dropped, and so is one whose params do not hold together
as a task snapshot — `isMCPTaskNotification` gates the branch before the agreed set is read.

**Delivery is claimed from the producer onward, and no replay is claimed.** The extension
calls task notifications optional, so this package states what it delivers and what it does
not: every frame the producer yields that passes the filter is stamped and written to this
stream, in producer order. A transition emitted before this subscription existed is not
resent, so a client that needs the state it missed reads it with `tasks/get`.

The helpers behind that path are `buildSubscriptionFilter` and
`matchesSubscriptionNotification`, the ones the other families use, with `enabled` supplied:

```ts
import {
	type JSONRPCNotification,
	buildSubscriptionFilter,
	isMCPTaskNotification,
	matchesSubscriptionNotification,
} from '@orkestrel/mcp'

const asked = { taskIds: ['task-alpha', 'task-beta', 'task-alpha'] }
// The `enabled` parameter is the derived support fact. `false` drops the member before the
// acknowledgement can name it; `true` carries the request through unresolved.
buildSubscriptionFilter(asked, {}, false) // {}
const agreed = buildSubscriptionFilter(asked, {}, true)
agreed.taskIds // ['task-alpha', 'task-beta', 'task-alpha'] — request order, duplicates intact

const frame: JSONRPCNotification = {
	jsonrpc: '2.0',
	method: 'notifications/tasks',
	params: {
		taskId: 'task-alpha',
		status: 'working',
		createdAt: '2026-07-28T09:00:00Z',
		lastUpdatedAt: '2026-07-28T09:00:01Z',
		ttlMs: null,
	},
}
isMCPTaskNotification(frame) // true
matchesSubscriptionNotification(frame, agreed) // true

const other = { ...frame, params: { ...frame.params, taskId: 'task-gamma' } }
matchesSubscriptionNotification(other, agreed) // false — outside the agreed set
const partial = { ...frame, params: { taskId: 'task-alpha' } }
matchesSubscriptionNotification(partial, agreed) // false — not a whole snapshot
```

### Consume a subscription from a client

`client.listen(notifications, options)` opens one `subscriptions/listen` stream and returns an
`MCPSubscriptionStream` — an `AsyncGenerator` whose yields are notifications and whose return
value is the graceful `MCPSubscriptionResult`. Pass `undefined` for the filter to ask for the
server's whole honoured set; the client sends `params.notifications: {}`, which is the member the
server requires and the empty object the filter guard accepts. The generator writes nothing until
the first read, so a signal already aborted rejects that read without sending a request at all.

**The acknowledgement is the first yield, and the terminal is the return value.** Every frame the
server stamps with this subscription's id arrives as an owned snapshot, in wire order, starting
with `notifications/subscriptions/acknowledged`. The graceful close is a correlated JSON-RPC
result rather than a notification, so it reaches you as the generator's return value and never as
a yield. A `for await` loop discards that value by construction — drive `next()` and read `done`
where the closure result matters.

**`options.signal` is required because the subscription is yours to end.** A subscription has no
request timeout: the only closures are an abort, an iterator `return()`, the peer completing, and
the connection failing. A consumer that drops the stream without either handle remains its owner —
the registration stays live, and no timer reclaims it, because this package has no lifetime to
hang one on. `disconnect()` and transport loss reject every active subscription, which is the
other end of the same obligation.

**`options.capacity` bounds what the client retains while nobody reads.** It defaults to
`DEFAULT_MCP_SUBSCRIPTION_CAPACITY` (`64`), and a frame arriving at a full queue fails the
subscription loudly with `MCPError` `-32603` rather than dropping the frame or growing without
bound. That is a client-side bound, not transport backpressure — see
[Declared conformance gaps](#declared-conformance-gaps) for what a duplex carrier delivers
incrementally and what an HTTP one does not.

A `capacity` that is not a positive integer is refused: the client throws `MCPError` `-32602`.
The refusal lands on the first read, because the body is a generator and nothing in it runs
until then, and it lands before the request is built or written — so the transport carries no
`subscriptions/listen` frame for a subscription refused this way.

**Ask for task transitions by naming them in `taskIds`.** The client sends the identifiers you
pass, and the acknowledgement's `params.notifications` reports the set the server agreed to:
the identifiers its store resolved, in the order you asked, with a duplicate kept and a refused
identifier absent. Read that set rather than the one you sent — an identifier missing from it
is one this stream will never deliver, and the acknowledgement says nothing about why.
Every delivered frame carries the reserved subscription stamp under `_meta`, so a
`notifications/tasks` frame the server stamped for this subscription arrives on this stream
rather than on the client's `notification` event.

The following example opens a subscription, drives it to its graceful terminal, and closes it:

```ts
import {
	type MCPSubscriptionResult,
	createMCPClient,
	isMCPSubscriptionResult,
} from '@orkestrel/mcp'

const client = createMCPClient({ transport })
await client.connect()

const subscription = new AbortController()
const stream = client.listen(
	{ toolsListChanged: true, resourceSubscriptions: ['resource://guide'] },
	{ signal: subscription.signal, capacity: 16 },
)

const opened = await stream.next()
opened.done // false — the acknowledgement is a yield
// The yield arm carries the notification; narrow on `done` before reading its member.
if (opened.done === false) opened.value.method // 'notifications/subscriptions/acknowledged'

let closure: MCPSubscriptionResult | undefined
for (;;) {
	const frame = await stream.next()
	if (frame.done === true) {
		closure = frame.value // the validated graceful terminal
		break
	}
	frame.value.method // one owned notification, stamped with this subscription's id
}
closure?.resultType // 'complete'
// The total guard the client proves the terminal with, re-applicable to any value you hold —
// `stream.return(value)` takes one of these, so build it and prove it the same way.
isMCPSubscriptionResult(closure) // true

// Either handle closes the subscription and writes `notifications/cancelled` on a duplex
// carrier. Abandoning the stream with neither leaves the registration live.
subscription.abort()
```

### Execute rich results and request-scoped progress

`MCPServerOptions.execution` is the explicit modern execution port above the live
`ToolManagerInterface`. Its input contains the original `request`, canonical `call`,
real `tools` manager, effective `signal`, and an optional `progress` reporter. Returning
a `ToolResult` uses the normal text/structured normalization; returning a validated
`MCPCallResult` preserves exact text, image, audio, resource-link, and embedded-resource
content without guessing from an ordinary domain value.

**A returned `MCPCallResult` reaches the wire unstamped, and that is a declared departure.**
The normalization path builds its answer through `buildModernResult`, which stamps the
`io.modelcontextprotocol/serverInfo` identity into `_meta`. A handler that returns a complete
`MCPCallResult` instead is taken at its word: the server bounds it, re-proves its shape, and
sends what the handler composed, so nothing adds the identity the other path adds. The dated
revision says a server `SHOULD` carry its identity in a result's `_meta`, and this is the one
result shape that does not. **What it costs:** a peer reading `serverInfo` off a `tools/call`
result finds it on every normalized result and on no custom-execution one, so a consumer using
`execution` for rich content stamps the key itself — through `buildModernResult`, which is
exported for exactly this — wherever that peer matters. **Why it is not fixed here:** stamping
the key onto a handler's own result would edit a result the handler declared complete, and the
`_meta` it composed is the handler's. **Closer:** a consumer's own
`buildModernResult(result, identity)` call inside the handler.

Modern `tools/call` treats an omitted `arguments` field as the shared frozen
`EMPTY_MCP_ARGUMENTS` record. A present value must be an object; `null`, arrays, primitives,
and a direct-call own `undefined` receive `-32602` before input policy, continuation access,
digesting, or execution. Whichever it is, one reference then reaches the argument digest,
the input selector, the canonical `ToolCall`, and the executor — no step re-snapshots, so no
step can be looking at a different value from another.

That record is shared and frozen, which is worth knowing before it surprises you: a tool
that writes to its own `arguments` now throws, and because the registry isolates a thrown tool
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

**Completion, a consumer `return(value)`, and `stop()` or an abort all end the exchange, and
only completion reaches the wire.** Running the source to completion
produces exactly one terminal — the response the stream returns, and every later read
resolves that same response. A consumer that calls `return(value)` is saying it already has
the answer, so the exchange closes on the value it supplied: that read and every later one
resolve `{ done: true, value }`, and nothing is sent, because the peer is not owed a terminal
the server never produced. An owner that calls `stop()` and an external abort produce no
terminal at all — those reads settle by raising the reason, because a cancelled request has
no answer to correlate. Cancellation is prompt in every case — the consumer's read settles even while
the producer is parked — and the request's signal goes down before cleanup is delegated,
so an executor observing it stops, the reporter stops with it, and a late `report`
rejects. A request whose caller has already gone never starts its producer at all: the
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
they check the calendar, not the shape alone: RFC 3339 §5.6 defines `date-mday` by the month and
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

### Ask the client for input during the call in hand

Configure `input` only when a `tools/call` may need something from the client before it can
finish. The consumer composes each round — its own keys, and any mixture of the
`elicitation/create`, `sampling/createMessage`, and `roots/list` kinds — and supplies the
authenticated principal, the host-neutral continuation port, and the TTL. MCP owns the
protective half: it refuses a round the client's declared capabilities exclude, seals the
opaque `requestState`, and on retry opens and verifies that state and checks every answer
against the question filed under its own key before handing the round's answers back to the
hook. Returning `undefined` from the hook continues into the ordinary live tool registry.

The keys are yours because they are how your own policy correlates each answer. A round asking
nothing is refused, because it would seal state no retry could ever satisfy.

**`createMCPContinuation` is what protects the `requestState` echo, and it is required.**
`MCPInputOptions.continuation` has no default: the carrier travels through a client that may
have rewritten it, so the integrity of every binding inside it — principal, expiry, original id,
revision, method, tool name, argument digest, and the issued round — rests entirely on that
port. `createMCPContinuation(secret)` is the shipped implementation, adapting `@orkestrel/server`'s
`signToken` / `verifyToken` to the port: `seal` signs the canonical state string and `open`
verifies it, returning `undefined` for anything it cannot verify, which is what turns a tampered
carrier into `-32602`. Pass `[current, ...older]` to rotate a secret without invalidating state
already in flight — a carrier sealed under a listed older secret still opens, while a new one
seals under the current. Core supplies no signer of its own, and a consumer substituting its own
port takes that integrity property with it: a port whose `open` returns whatever it was given
makes every binding a client-supplied claim.

The order the server runs those steps in is itself a contract, because each step is a
provider call somebody pays for. On a first round: the selector runs, its round is owned and
frozen immediately, the round is measured against the client's declared capabilities, and only
then is the principal resolved and the state sealed — so a client whose round this server may
not send costs no principal lookup and no audit record. On a retry: every structural binding —
changed id, expiry, version, method, tool name, argument digest, every issued key, and each
answer against the request that asked for it — is verified before the principal resolver runs
at all. The capability gate does not stand at the retry's ingress, because a retry answers a
round this server already gated; what it measures there is the next round, so it runs after the
selector answers and before that round is sealed.

```ts
import {
	computeMissingCapabilities,
	createMCPServer,
	isElicitContent,
	isMCPElicitFieldSchema,
	isMCPElicitForm,
	isMCPElicitRequest,
	isMCPElicitResult,
	isMCPElicitSchema,
	isMCPElicitURL,
	isMCPInputRequest,
	isMCPInputRequestMap,
	isMCPInputResponse,
	isMCPInputResult,
	isMCPRoot,
	isMCPRootResult,
	isMCPSampleContent,
	isMCPSampleResult,
	supportsFormElicitation,
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
		selector: ({ responses }) =>
			responses === undefined
				? {
						requests: {
							approval: {
								method: 'elicitation/create',
								params: {
									message: 'Approve this reply?',
									requestedSchema: {
										type: 'object',
										properties: { approved: { type: 'boolean' } },
										required: ['approved'],
									},
								},
							},
							workspace: { method: 'roots/list', params: {} },
						},
						state: { operation: 'run-42' },
					}
				: undefined,
	},
})

supportsFormElicitation({ elicitation: {} }) // true: empty means form-only
supportsFormElicitation({ elicitation: { url: {} } }) // false
computeMissingCapabilities({ workspace: { method: 'roots/list' } }, {}) // { roots: {} }
computeMissingCapabilities({ workspace: { method: 'roots/list' } }, { roots: {} }) // undefined
computeMissingCapabilities(
	{
		login: {
			method: 'elicitation/create',
			params: { mode: 'url', message: 'Sign in', url: 'https://example.test' },
		},
	},
	{ elicitation: {} },
) // { elicitation: { url: {} } }: the arm the round needs, not the one already declared
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
isMCPInputRequest({ method: 'roots/list' }) // true: a roots request composes into a round
isMCPInputRequestMap({ confirm: { method: 'roots/list' } }) // true: a keyed map, not an array
isMCPElicitResult({ action: 'accept', content: { approved: true } }) // true
isMCPRoot({ uri: 'file:///workspace', name: 'workspace' }) // true
isMCPRootResult({ roots: [{ uri: 'file:///workspace' }] }) // true
isMCPSampleContent({ type: 'text', text: 'Paris' }) // true
isMCPSampleContent({ type: 'tool_use', id: 'c1', name: 'lookup', input: {} }) // true
isMCPSampleResult({
	role: 'assistant',
	content: { type: 'text', text: 'Paris' },
	model: 'a-model',
}) // true
isMCPSampleResult({
	role: 'assistant',
	content: [{ type: 'text', text: 'Paris' }],
	model: 'a-model',
}) // true: the schema's `content` is one block OR an array of them
isMCPInputResponse({ roots: [] }, { method: 'roots/list' }) // true
isMCPInputResponse({ action: 'accept' }, { method: 'roots/list' }) // false: wrong kind
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
content by shape — `isMCPElicitResult` allows it — while the server additionally enforces the
issued schema through `isElicitContent`, so an accepted response omitting a `required` field is
refused on the retry even though its shape is legal. Decline and cancel responses must omit
content and are never checked against the schema. Accepted response numbers may be fractional
but never non-finite, and response arrays contain strings only. URL-mode requests use the same
RFC 3986 URI guard.

**URL-mode elicitation is a composable arm, and it needs its own declaration.** A round may
carry `{ mode: 'url', message, url }` under one of its keys, beside a form request, a sampling
request, or a roots request under the others. The client must declare `elicitation.url` as a
record to receive one: this package reads the bare `elicitation: {}` spelling as form-only, so
a URL round against that declaration is refused `-32021` with
`{ elicitation: { url: {} } }` naming the arm to declare. `url` carries the schema's
`format: uri` and must be absolute. The URL arm issues no schema, so an answer to it is
checked for its response shape alone and never against a `requestedSchema` — which is the one
place a URL request and a form request are enforced differently on the retry.

The retry uses a new JSON-RPC id and preserves the original `name` /
`arguments`; `inputResponses` and the `requestState` the server issued, returned unchanged,
are top-level `params` siblings. Extra `inputResponses` keys are ignored — the server reads
exactly the keys it issued — while omitting any issued key is still a refusal. A round asking
for a kind the client did not declare receives `-32021` with a `requiredCapabilities` record
naming each missing capability: `sampling` for `sampling/createMessage`, `roots` for
`roots/list`, and `elicitation` for an elicitation the declaration does not authorize. That
`elicitation` value names the arm the round needs, so the client can act on it: a missing URL
arm answers `{ url: {} }`, a missing form arm answers the empty record this package reads as
form-only, and a round needing both answers `{ form: {}, url: {} }`. A request whose modern
`_meta` cannot be parsed at all is a different failure and receives `-32602` with
`malformed modern request metadata` — the answer `MCPServer` gives it at the ingress, before
any handler runs, and the same answer both MRTR doors give it. An empty capability
declaration is not that case: it parses, it excludes every kind, and it is gated `-32021`. A
malformed, mutated, expired, same-id, cross-principal, cross-version, cross-method,
cross-tool, changed-argument, unanswered-key, or kind-violating state receives `-32602` before
tool execution. A continuation or policy provider rejection is infrastructure failure and
receives detail-free `-32603`, with the caught value on the server's `error` event — as does
a port that opens successfully onto a payload this server never authored, or onto one
outside the state bound, because the client wrote neither and cannot act on being told it
was at fault. A carrier the port cannot recover, and an invalid resolved principal, round, or
carrier, remain `-32602`. Recovered state is bounded before parsing.

Place the retry through the `input` group on `MCPCallOptions`. `responses` is required and
`state` is optional: a peer may issue a round with no `requestState` to return, and SEP-2322
requires the retry to answer that round while omitting the parameter, so the client sends
`requestState` exactly when a caller supplies one. `MCPServer` itself seals a carrier on
every round it issues, so a retry reaching this server without one is refused `-32602`. Pass
the same tool name and byte-identical `arguments` that the first call used; changing the
arguments invalidates the protected state. The following client-side exchange reuses the
same `callArguments` value and answers every key the round published:

```ts
import type { MCPClientInterface } from '@orkestrel/mcp'

declare const client: MCPClientInterface

const callArguments = { value: 'unchanged' }
const pending = await client.call('reply', callArguments)

if (
	pending.resultType !== 'input_required' ||
	pending.requestState === undefined ||
	pending.inputRequests === undefined
) {
	throw new Error('Expected input requests and protected state')
}
// The server publishes its own keys, so answer each one by the kind its request names.
await client.call('reply', callArguments, {
	input: {
		state: pending.requestState,
		responses: {
			approval: { action: 'accept', content: { approved: true } },
			workspace: { roots: [{ uri: 'file:///workspace', name: 'workspace' }] },
		},
	},
})
```

`client.tasks.update` is a different route and does not reach this arm. It answers the input
requests a durable task published — the `'task'` arm of `MCPCallOutcome`, reached through the
`tasks/*` methods — while the retry here answers an inline `resultType: 'input_required'` and
travels as another `tools/call`.

**What the protected state binds, and for how long.** The carrier is opaque to the client:
it carries an authenticated principal, an absolute expiry, the original first-round request
id, the protocol revision, the method, the exact round that was issued, the tool name, a
canonical SHA-256 argument digest, and any application state the selector attached. The
round travels inside that payload, so its size is spent from `limit.state` (16384 bytes by
default) along with every other binding: a large mixed round, or a large form schema, is
refused at the seal with `-32602` rather than truncated, so size a round deliberately or
raise `limit.state`. Expiry is a short absolute deadline set from the consumer's `ttl`, and
it is rechecked around every
provider await rather than admitted once: after the selector answers, and around the seal that
a further round performs. The issued round is not merely carried — `isMCPInputResponse`
enforces each answer against the request filed under its own key, and a form request's schema
through `isElicitContent`, so a client answering a question other than the one it was asked is
refused before the tool runs. Across rounds, `principal`, the original id, version, method,
tool name, and digest stay bound while the round and its expiry are re-minted; the original id
stays bound however many rounds follow, so a three-round exchange is still one correlated call.

**What it deliberately does not do.** There is no consume-once rule, no session binding, no
timer, and no replay store: the same protected state answers again under a fresh id, and it
is exhausted by its expiry alone. Single use is application policy — a continuation port that
must be redeemable once enforces that itself, which is exactly why the port is a consumer
interface. Nothing about the mechanism is session-bound either: the carrier travels in
`params` and works across connections, processes, and transports. JSON-RPC ids are
correlation only, so an application operation that must not run twice still needs its own
idempotency key; a retried call whose bindings all match runs the tool again.

The continuation port may be a self-contained token adapter or a consumer-supplied durable
server-side handle. The built-in modern `tools/call` is the only handler that produces
`input_required` from this policy; `prompts/get` and `resources/read` forward one their own
manager authored, and the legacy branch is unchanged. A forwarded round is this server's
wire too, so it meets the same capability gate before it is stamped and sent: the rule binds
every issuer, not one method. Core does not refuse
a continuation carrier on another method: it owns the carrier's shape, bounds, and ownership
for every invocation — a malformed one never reaches a handler — and the continuation
semantics belong to whoever registered that method. Register `prompts/get` or
`resources/read` on `server.methods` and the handler receives its owned frozen carrier and
decides what it means; leave them unregistered, as this package ships them, and they still
answer `-32601`.

### Defer a call to a durable task

The Tasks extension is the stable, immutable snapshot dated 2026-07-28, extension id
`io.modelcontextprotocol/tasks`, generated schema id
`https://modelcontextprotocol.io/ext-tasks/2026-07-28/schema.json`. That snapshot is fixed,
so every type, wire field, and error code in this section is written against it, and a later
revision arrives as its own dated snapshot rather than as a change to this one.

A **task** is a durable operation that outlives the request that created it. The server
answers a modern `tools/call` immediately with `resultType: 'task'` and a `taskId`, and the
client comes back later for the outcome. Everything between the answer and the outcome belongs
to the
consumer: supply an `MCPTaskOptions` with a durable `tasks` store and a `deferral` policy, and
this package supplies the protocol and nothing else. It holds **no task state, no timer, and
no status logic**, because a durable operation outlives the process that answered the request
and MCP has no durable place to keep one.

**Deferral is the server's decision.** The extension gives a client no flag and no parameter
to ask for a task — a client only declares, per request, that it can cope with one. So
`deferral` is where the policy lives (long-running tool, queue depth, caller tier), it is
consulted only for a client that declared the capability on the request in hand, and it
returns the **stable operation key** the store deduplicates on, or `undefined` to run the
call inline. The decision sits between the input mechanism and progress: **MRTR first**,
because a call still asking its operator a question has not been decided yet and must not be
durably stored with unsettled arguments; **task before progress**, because a deferred request
ends the moment the handle is written and has no stream left to report progress on.

`MCPTaskContext` carries **no cancellation signal**, and that absence is the sharpest hazard
in this surface. The `signal` on the accompanying `MCPMethodOptions` is the
request's lifetime, and a transport aborts it as soon as the response body is flushed. A
manager that plumbs `options.signal` into the task's work therefore loses every task it
creates, milliseconds after creating it, and the loss looks exactly like a client that
disconnected. Spend `options.signal` on work that must finish before the answer is written,
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
	MCP_EXTENSION_TASKS,
	supportsTask,
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
		deferral: async ({ call }, { caller }) =>
			call.name === 'render'
				? `render:${String(caller)}:${String(await digestJSON(call.arguments, DEFAULT_MCP_LIMITS))}`
				: undefined,
	},
})

supportsTask({ extensions: { [MCP_EXTENSION_TASKS]: {} } }) // true: presence is the declaration
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
counting at `1` produce the same key, which is one principal handed a `taskId` over the other's
work. Mint from the caller and the canonical arguments, as above. `deferral` returning `undefined`
is the only way to say "run this inline"; an empty string cannot identify an operation and is
refused as `-32603` rather than quietly taking the inline path.

**The lifecycle methods register only when `task` is configured.** An unconfigured
server advertises nothing, defers nothing, and answers `tasks/get` / `tasks/update` /
`tasks/cancel` with `-32601` through the same unregistered-method path any unknown method
takes — the honest reply from a server that does not implement an optional extension.
Configured, it advertises `capabilities.extensions['io.modelcontextprotocol/tasks']` on
`server/discover` and answers each of them.

| Method         | Params                       | Answers                                                                                                |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tasks/get`    | `{ taskId }`                 | The flat `MCPTaskDetailResult` — the snapshot under `resultType: 'complete'`, plus the server identity |
| `tasks/update` | `{ taskId, inputResponses }` | `resultType: 'complete'` and nothing else                                                              |
| `tasks/cancel` | `{ taskId }`                 | `resultType: 'complete'` and nothing else                                                              |

Only the creation answer carries `resultType: 'task'`. Reading, answering, and cancelling a
task are ordinary completed method calls, and `tasks/get`'s payload merely happens to be a
task — so a client narrows on `status`, never on a second discriminator.

**The refusal taxonomy is short and deliberate.** A client that never declared the extension
on the request in hand gets `-32021` with
`{ requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } } }` before its
parameters are read at all, because the extension binds that refusal to the method. This is
the **same generic missing-required-client-capability code** the elicitation path answers, and
the tasks and elicitation refusals are told apart by `data.requiredCapabilities` alone — they
are instances of the same condition rather than distinct conditions, and there is no separate
numeral. (The extension's own prose examples show
`-32003`; the dated core schema fixes `-32021`, and a peer implements
the dated schema.) An absent, non-string, empty, or over-bound `taskId` gets `-32602`. A
`taskId` the store does not resolve gets `-32602` too — **byte-identically for a task that
never existed, one whose TTL purged it, and one this caller is not entitled to see**, because
the port answers `undefined` for each of them and this package cannot tell them apart even in
principle. That is what makes a `taskId` unprobeable; a second code, or a second message,
would turn the store into an enumeration oracle.

**`-32603` covers distinct failures, and only one of them reaches `error`.** A store that
throws is contained as `-32603` with the caught value on the server's `error` event. A store
that returns badly — a snapshot outside the content bound, or one off the published contract —
is refused as `-32603` too, but **silently**: nothing was thrown, so there is no caught value
to report and nothing reaches `error`. A consumer watching `error` to detect a faulty store
therefore sees its exceptions and is **blind to its contract violations**; watch the `-32603`
rate on the wire for the contract-violation class. A `deferral` that returns a key which is
neither `undefined` nor a non-empty string is another `-32603`, and it is silent for the same
reason.
Do not generalize from the elicitation path, which discloses the opposite way: a continuation
port that opens successfully onto an off-contract payload is reported on `error` there, because
that seam synthesizes the fault it never caught. The tasks port does not.

`tasks/update` and `tasks/cancel` both read the named task first, because both answer `void`
and neither has a way to report an unknown task or to decide authorization — a read they accept
is a write they authorized. That read is **proven with the same guard `tasks/get` proves its
answer with**, not merely compared against `undefined`: `undefined` is one of several ways an
implementation of this port can say "no such task" — `null` is the ordinary JavaScript spelling
— and a value that is not a well-formed `MCPTaskDetail` earns the same byte-identical `-32602`
an unknown `taskId` does, with neither `update` nor `abort` invoked. Expect one `task(...)`
read before every update and every cancellation. **Cancellation is advisory**:
this server asks, and the acknowledgement says the request was accepted, never that the task
stopped — a store whose work cannot be interrupted may legally reach `completed` afterwards,
and this package asserts nothing about which happened. **Input responses are forwarded
verbatim**: a key the task never published, and one it has already answered, are the store's
to ignore rather than this server's to refuse, because which keys a task recognizes is
knowledge only the task holds. `ttlMs` and `pollIntervalMs` pass through exactly as the store
produced them and are never invented; `ttlMs` is `null` — not absent — when a task does not
expire.

**`resultType: 'input_required'` and `MCPTaskStatus` `'input_required'` are different
mechanisms.** Both are on the wire, so neither can be renamed, and a reader who conflates them will reach for the wrong
recovery.

|                       | MRTR `resultType: 'input_required'`                           | `MCPTaskStatus` `'input_required'`                  |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| Who owns it           | MCP, through `MCPServerOptions.input`                         | the consumer's store                                |
| What is suspended     | one live request                                              | one durable task                                    |
| Where the state lives | the sealed opaque `requestState` MCP mints                    | wherever the store keeps it                         |
| How it resumes        | a new `tools/call` carrying `requestState` + `inputResponses` | `tasks/update` carrying `taskId` + `inputResponses` |
| Guard                 | `isMCPInputResult`                                            | `isMCPTaskStatus` / `isMCPTaskDetail`               |

**And `tasks/update` is the weaker mechanism.** It is a multi-round-trip exchange
with **none** of the protections the elicitation path carries: no sealed `requestState`, no
canonical argument digest, no absolute expiry, no principal binding, no schema enforcement on
the answer. Consumers who have read the elicitation section will reasonably expect parity.
**They cannot have it from this package**, because MCP neither issued the task's question nor
owns the channel it is answered on — the store did both. Anything equivalent has to live in
the store: bind each published key to the principal entitled to answer it, expire unanswered
keys, and treat a response arriving after the task moved on as stale. Stating that is the only
protection this package can offer, and a consumer who skips it is running an unauthenticated
input channel beside an authenticated one.

**The obligations this package cannot enforce, and what each costs.** Every one of them is
reachable only through a store this package never sees, so each is stated here and on the
port's own TSDoc rather than defended with coordination machinery — and each is proved by a
fixture that violates it and demonstrates exactly this consequence.

| Obligation                               | The consequence of violating it                                                                                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Durability before return**             | `start` must resolve only once the task is retrievable by `task`. This package awaits `start` before it builds the answer, which is its whole half; a store that resolves first hands the client a `taskId` a prompt `tasks/get` answers `-32602` for, and the window is silent.        |
| **`taskId` entropy**                     | It is a bearer handle over a durable operation. Mint it from a cryptographic source; a handle derived from the key, a counter, or anything else predictable is a handle a stranger can guess.                                                                                           |
| **Key uniqueness and non-reuse**         | The same logical call must produce the same key and two different calls must not. This package forwards whatever `deferral` returned, unchanged, however many times it sees it.                                                                                                         |
| **Dedup keys scoped to their principal** | Returning the existing task for a repeated key is what makes a retried call idempotent — but an unscoped key means two principals submitting the same key receive the same task, one reading the other's work. This package has no principal to scope by; the store or `deferral` must. |
| **Terminal immutability**                | `completed`, `failed`, and `cancelled` never move again. This package holds no cache, so a store that mutates a terminal task has both snapshots reported faithfully and its clients see a task travel backwards.                                                                       |
| **TTL purge**                            | A task with a finite `ttlMs` is the store's to expire; `ttlMs: null` means no expiry and must never be swept. After a purge the handle answers the same `-32602` an unknown one does, which is intended — and indistinguishable.                                                        |

**A task transition reaches a subscribed client through `subscriptions/listen`.** The
extension's `notifications/tasks` frame is produced by the same `subscription.producer`
every other family travels through, and the built-in filters it against the `taskIds` the
acknowledgement agreed to and stamps it with the subscription id — see
[Configure modern subscriptions](#configure-modern-subscriptions) for the server half and
[Consume a subscription from a client](#consume-a-subscription-from-a-client) for the client
half. Where the `taskIds` member sits on the wire is this package's reading of an
under-specified extension point, recorded under
[Declared conformance gaps](#declared-conformance-gaps).

### Bound hostile input and live resources

Every server uses the frozen `DEFAULT_MCP_LIMITS`: one MiB for a raw message,
16 KiB for `_meta`, 64 total object keys, 16 KiB for `requestState`, four MiB
for produced tool content, 128 live built-in subscriptions, and depth 32 for
bounded JSON. `keys` is the breadth bound for both bounded values, not a `_meta`
leaf: `metadata` and `content` cap the bytes of their own value, while `keys` and
`depth` cap the shape of each. A result whose breadth exceeds `keys` is refused
the way oversized content is, an `_meta` value exceeding it the way invalid
metadata is, and raising the key budget for extension-rich metadata raises it for
tool output too. Those defaults are sized respectively for substantial ordinary
JSON-RPC arguments, extension-rich request context, a signed state carrying a
short deployment value, substantial JSON tool output, a busy
long-lived host, and ordinary documents well beyond typical application nesting.

A deployment changes only the policy values it needs through the single `limit`
group. Every malformed numeric leaf (`NaN`, infinity, a negative, or a fraction)
falls back to its secure default. Message overflow maps to `-32700`; invalid or
oversized `_meta` and `requestState` map to `-32602`; oversized produced content
and exhausted subscription capacity map to `-32603` — under both eras, because a legacy
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
await server.handle(
	'{"jsonrpc":"2.0","method":"server/discover","id":1,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}',
)
```

`isBoundedJSON` walks iteratively and tracks active ancestors. Cycles, values
deeper than the configured depth, accessors/hostile proxies, `Map`/`Set`, and
non-finite values return `false`; no adversarial shape throws from the guard. Own
`__proto__`, `constructor`, and `prototype` keys are ordinary exact-JSON data and are
accepted within the same byte/key/depth bounds. There is no second, laxer JSON policy
for legacy any more: the dedicated legacy normalizer is gone, and a legacy `tools/call`
is bounded and serialized by the engine it now runs on.

### Bind a server or a client to any duplex transport

`bindServer` / `bindClient` pipe an `MCPServerInterface` / `MCPClientInterface`
over an `MCPTransportInterface` — the environment-agnostic duplex message
channel (`send` / `listen` / `closed` / `close`, all string messages; framing
is entirely the transport's concern). Every environment face — Node stdio and
WebSocket, the browser's `MessagePort` and worker scope — implements this one port
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
const outcome = await client.call('add', { x: 2, y: 5 })
// outcome → { resultType: 'complete', value: 7 }
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

The dated revisions are not a branch inside the server. They are a **decorator over it**.
`MCPLegacy` wraps one `MCPDispatcherInterface` — the minimal `emitter` / `limit` / `dispatch` /
`handle` surface a transport actually needs, and the one `MCPServerInterface` extends — and translates the
fixed legacy method set onto the modern engine underneath. A modern-shaped invocation passes
through untouched. `initialize` and `ping` are answered by the decorator itself and
`notifications/initialized` is swallowed there, because the handshake acts have no modern
counterpart and the modern seam registers no `ping`. `tools/list` and `tools/call`
acquire modern request metadata, run through the same dispatcher a modern request runs through,
and have the answer projected back into the unstamped legacy shape. Every arm answers under the
message bound the wrapped dispatcher advertises: an invocation outside it earns that
dispatcher's own id-less `-32600`, locally answered and forwarded alike. Every other method is
refused with `-32601` at the door.

**That fixed set is the whole legacy era, so the modern-only surfaces do not exist for a legacy
client.** `server/discover` and `subscriptions/listen` are 2026-07-28 methods with no legacy
spelling, so a legacy-era client naming either gets `-32601` at the decorator's door — the same
refusal every other unlisted method earns there. The multi-round input mechanism is refused one step further
in — a legacy `tools/call` carrying `requestState` or `inputResponses` gets `-32602`, because
those parameters belong to a round the dated protocol could not have produced — and a modern
result the dated revision has no shape for is projected as `-32000`. So a legacy client
discovers the server through `initialize`, lists and calls tools, and has no path to modern
discovery, subscriptions, or an input round at all. The way to reach one is to speak modern:
the decorator passes a modern-shaped invocation through untouched, so composing the layer costs
a modern client nothing.

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
createMCPRoutes(mcp) // modern only — a legacy `initialize` falls off the modern seam as -32601
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

**What removing legacy server ingress costs, exactly.** The claim is bounded to ingress on
purpose: what comes out is a server that no longer answers a dated revision, not a package that
no longer speaks one. It reaches these **published modules**. `src/core/MCPLegacy.ts` and the
HTTP session entity `src/server/MCPSession.ts` go as whole files. The rest survive and give up
one declared row each: `createMCPLegacy` in `src/core/factories.ts`, its
barrel row in `src/core/index.ts`, `MCPLegacyOptions` in `src/core/types.ts`, the session
middleware in `src/server/middlewares.ts`, the `MCPSession*` contracts in
`src/server/types.ts`, and the session barrel rows in `src/server/index.ts`.

**`src/core/types.ts` is a declared row, never a file to delete.** It is the shared contract
carrier the modern dispatcher imports, so deleting the file deletes the modern engine with it. A
remover takes out the `MCPLegacyOptions` declaration and leaves everything else in that module
standing. The same distinction governs every other row entry: the file stays, one
declaration leaves.

**The documentation goes with them, and this section is not all of it.** The rule is every guide
row naming `MCPLegacy` or `createMCPLegacy` — this section, the `createMCPLegacy` Factories row,
the `MCPLegacy` Classes row, the `MCPDispatcherInterface` and `MCPLegacyOptions` Surface rows,
the `#### MCPDispatcherInterface` Methods block, and the cross-references that point here.
Removing the code and keeping a row that names a deleted export fails this package's own parity
gate. It checks every Surface row against the public barrels in both directions and checks every
named import in a TypeScript fence against its published package face.

`MCPServer` is not on that list: it imports no `MCPLegacy` module and carries no standalone
`MCPLegacy` or `legacy` word, which is the property the parity gate checks. Its TSDoc names the
`createMCPLegacy` factory inside a composition example, and its modern dispatcher still spells
protocol methods shared with the decorator; neither a factory name inside an example nor method
text is legacy ownership. The modern engine therefore still compiles once the layer is deleted.
`isModernRequest` survives because the modern engine reads structural key presence. Each
remaining survivor has its own consumer, and they are not the same one:

| Survivor                | What consumes it after the layer is deleted                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inferEra`              | Nothing inside `src`. It is the published era helper, and it reads `isMCPModernVersion` then `isMCPLegacyVersion` rather than restating either set.                                           |
| `inferRequestEra`       | `MCPServer`'s `request` event and the HTTP ingress in `src/server/handlers.ts` — both report or route on the era a request's own structure selects, and neither reads a revision set.         |
| `isInitializeRequest`   | Legacy server ingress: `src/server/middlewares.ts` mints and validates a session from it, and `src/server/inferers.ts` exempts a headerless `initialize` from the header demand.              |
| `MCPLegacyResult`       | The unstamped result arm of `JSONRPCResponse` in `src/core/types.ts`, its guard `isMCPLegacyResult`, and the decorator's projection.                                                          |
| `MCP_HANDSHAKE_VERSION` | Client-adapter egress in `src/core/MCPLegacyClientTransport.ts`, the legacy handshake anchor in `src/core/helpers.ts` and `src/server/inferers.ts`, and `SUPPORTED_LEGACY_PROTOCOL_VERSIONS`. |
| `MCP_FALLBACK_VERSION`  | `SUPPORTED_LEGACY_PROTOCOL_VERSIONS` plus an explicit `MCPLegacyClientTransportOptions.version` pin.                                                                                          |

The bare server imports no legacy revision set and no legacy guard.

`MCPClient` remains outside the server-ingress removal list because it contains no legacy
handshake. The bare client sends `server/discover` only and accepts only `MCPModernVersion` as an
optional pin. Legacy egress belongs to the separate client transport decorator described next.

That module list is a membership rule rather than a reassurance. The executed list lives in
[the package guide suite](../tests/guides.test.ts), which computes the legacy-owning module set
from the tree and requires it to equal its list in both directions. An added participant and a
stale suite entry therefore fail the same way; update this guide's descriptive list and the
suite's executed list together. The same suite requires `MCPServer.ts` to carry no `MCPLegacy`
or `legacy` spelling. What these structural checks cannot reach is legacy participation that does
not bind either entity name — a handler table, a computed concatenation, or a branch on a version
value. [The dispatch tests](../tests/src/core/MCPLegacy.test.ts) guard that class.

**What a legacy client sees differently than it did before this collapse**, because
legacy now inherits the modern engine's validation instead of running beside it:

| A legacy `tools/call` whose …      | Answered before                                     | Answers now                                            |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| tool result contains `NaN`         | `null`, from `JSON.stringify`'s non-finite coercion | `-32603` — the produced result is not valid JSON       |
| `params.arguments` is `null`       | accepted, and the tool ran                          | `-32602` — arguments must be an object                 |
| tool value exceeds `limit.content` | `-32000`                                            | `-32603`, the same code a modern call already received |

The shared cause is worth stating once, plainly: **legacy inherits the modern engine's validation
because it now runs on it.** `NaN` is not JSON, the modern path always refused it, and a server
that refused one caller while silently nulling the other was answering the same question in
contradictory ways. Uniform refusal is the coherent answer, and it is the intended consequence of the collapse
rather than a side effect of it. `-32000` survives where it carries a meaning no modern code does:
a `task`, an `input_required`, a capability refusal, or an unsupported stream the dated revision
cannot represent. A legal `tools/call` progress stream is the narrow exception: matching progress
notifications remain progress notifications, and its final complete or error response becomes the
legacy answer.

### Adapt a legacy peer at the client transport boundary

The dated client handshake is not a branch inside `MCPClient`. It is a **decorator over its
transport**. `MCPLegacyClientTransport` wraps one `MCPMessageTransportInterface`, performs
`initialize` during `start`, sends `notifications/initialized`, and answers the bare client's
`server/discover` locally from the accepted handshake. The consumer-visible client therefore
stays on `2026-07-28` while the wrapped transport speaks `2025-11-25` or `2025-06-18` to the peer.

The decorator translates at the message boundary. A modern invocation loses the reserved
protocol-version, client-capability, and client-identity metadata before it reaches the legacy
peer. A legacy result gains the modern `resultType`, server identity, and cache fields before it
reaches `MCPClient`. The shared projections live in the core helpers and are the same projections
the server decorator uses in the opposite direction.

The projections are also public when another explicit boundary needs the same wire conversion:

```ts
import {
	legacyInvocationToModern,
	legacyResultToModern,
	modernInvocationToLegacy,
	modernResultToLegacy,
} from '@orkestrel/mcp'

const request = legacyInvocationToModern({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
const legacyRequest = modernInvocationToLegacy(request)
const result = legacyResultToModern({}, 'tools/list', { name: 'legacy', version: '1.0.0' })
const legacyResult = modernResultToLegacy(result)
```

Wrap the transport explicitly when the peer exposes only the legacy handshake:

```ts
import { createMCPClient, createMCPLegacyClientTransport } from '@orkestrel/mcp'
import { createHTTPClientTransport } from '@orkestrel/mcp/server'

const carrier = createHTTPClientTransport({ url: 'https://legacy.example/mcp' })
const transport = createMCPLegacyClientTransport(carrier, { version: '2025-06-18' })
const client = createMCPClient({ transport })

await client.connect()
client.version // '2026-07-28' — the adapter keeps the dated revision on the peer side
```

Omit `version` to offer `2025-11-25`; supply it to require one supported legacy revision exactly.
The adapter rejects an absent, malformed, unsupported, or pin-mismatched handshake result before
the client connects. Its request deadline bounds the handshake response, each handshake write, and
each forwarded correlated request. The adapter reserves wire id `0` while that handshake window is
open; do not send unrelated id-`0` traffic through the wrapped carrier until `start()` settles.
Before an accepted handshake, local `server/discover` answers with a correlated `-32603`. A
forwarded request also answers with a correlated `-32603` when its deadline expires or the peer
returns a malformed result that cannot be translated. A peer-originated JSON-RPC error passes
through with its code unchanged.

The bare client never attempts this handshake. When `server/discover` returns `-32601`, `connect`
rejects with an `MCPError` whose message names `createMCPLegacyClientTransport`. A legacy peer that
refuses the method with any other code surfaces that code unchanged. Reference servers differ here:
the TypeScript SDK v1.x server answers an unknown method with `-32601`, while the Python SDK v1.29.0
server answers it with `-32602`, as read from their released sources on 2026-08-20 (see the
[TypeScript SDK shared protocol](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/shared/protocol.ts)
and the
[Python SDK server session](https://github.com/modelcontextprotocol/python-sdk/blob/v1.29.0/src/mcp/server/session.py)).
Passing a legacy revision to
`createMCPClient` is rejected before the transport starts; production types do not admit that pin.

### Factories

| API                              | Kind     | Summary                                                                                                                                                                                                                                                                            |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMCPServer`                | function | Creates a transport-agnostic Model Context Protocol server — exposes a live `ToolManagerInterface` and an optional `MCPResourceManagerInterface`, `MCPPromptManagerInterface`, and `MCPCompletionInterface` over JSON-RPC 2.0.                                                     |
| `createMCPLegacy`                | function | Decorates one MCP server with the fixed legacy method translation.                                                                                                                                                                                                                 |
| `createMCPClient`                | function | Creates a transport-agnostic Model Context Protocol client — connects to a remote MCP server over an injected `MCPMessageTransportInterface`, negotiates the modern revision through `server/discover`, and exposes the server's tools as local `ToolInterface`s an agent can run. |
| `createMCPLegacyClientTransport` | function | Decorates one client transport with explicit legacy handshake and era translation.                                                                                                                                                                                                 |
| `createDuplexClientTransport`    | function | Adapts an `MCPTransportInterface` (the environment-agnostic duplex message channel) into a `MCPMessageTransportInterface` — the additive bridge that lets `createMCPClient` run over the new port without any change to `MCPClient`'s existing shape.                              |

### Classes

| API                        | Kind  | Summary                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCPServer`                | class | Dispatches JSON-RPC 2.0 requests over a live `ToolManagerInterface`, with no transport coupling.                                                                                                                                                                                                                                                                                   |
| `MCPLegacy`                | class | Translates the fixed legacy method set onto one modern dispatcher.                                                                                                                                                                                                                                                                                                                 |
| `MCPLegacyClientTransport` | class | Adapts a legacy MCP peer to the modern client transport boundary.                                                                                                                                                                                                                                                                                                                  |
| `MCPMethodManager`         | class | Holds the modern methods an `MCPServerInterface` dispatches through — a name-keyed store of `MCPMethodHandler`s that owns its map rather than exposing one.                                                                                                                                                                                                                        |
| `MCPProgressReporter`      | class | Hands bounded, request-scoped progress from one producer to one serial consumer. The reporter holds at most one owned progress item. `report` applies backpressure until `take` consumes that slot. It has no replay, queue, concurrent-consumer coordination, task state, or durable-work semantics; stopping or aborting the request discards the slot and rejects pending work. |
| `MCPStreamController`      | class | Provides the one cancellation engine every modern held-open result leaves `MCPServer` through.                                                                                                                                                                                                                                                                                     |
| `MCPTextStreamController`  | class | Mirrors a controlled held-open result at the string boundary — the same exchange, already serialized.                                                                                                                                                                                                                                                                              |
| `MCPClient`                | class | Connects to a remote MCP server over any injected `MCPMessageTransportInterface`, negotiates the modern revision, and exposes the server's tools as local `ToolInterface`s an agent can run.                                                                                                                                                                                       |
| `MCPTaskClient`            | class | Issues the `tasks/*` methods over one correlated-request door — the client half of the stable Tasks extension, exposed as an `MCPClientInterface`'s `tasks`.                                                                                                                                                                                                                       |
| `HTTPClientTransport`      | class | Drives a remote Streamable-HTTP MCP server over `fetch` — a client `MCPMessageTransportInterface` for the Model Context Protocol, the egress mirror of the server's `createMCPRoutes`.                                                                                                                                                                                             |
| `MCPError`                 | class | Preserves a Model Context Protocol error's machine-readable numeric code and optional structured context.                                                                                                                                                                                                                                                                          |

### Constants

A `Shape` cell holds the constant's declared type.

| Constant                             | Kind  | Shape                                                                         | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ----- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_HANDSHAKE_VERSION`              | const | `MCPLegacyVersion`                                                            | Names the revision offered and defaulted to in the legacy `initialize` handshake, `'2025-11-25'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MCP_FALLBACK_VERSION`               | const | `MCPLegacyVersion`                                                            | Names the older legacy revision the optional legacy decorator accepts and an adapter can pin, `'2025-06-18'`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MCP_MODERN_VERSION`                 | const | `MCPModernVersion`                                                            | Names the modern revision offered by an unpinned client during discovery, `'2026-07-28'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SUPPORTED_MODERN_PROTOCOL_VERSIONS` | const | `readonly MCPModernVersion[]`                                                 | Lists the modern MCP protocol revisions a bare server accepts and advertises, `2026-07-28`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SUPPORTED_LEGACY_PROTOCOL_VERSIONS` | const | `readonly MCPLegacyVersion[]`                                                 | Lists the protocol revisions accepted by the optional legacy decorator, `2025-11-25` and `2025-06-18`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SUPPORTED_MCP_VERSIONS`             | const | `readonly MCPVersion[]`                                                       | Lists the protocol revisions the `isMCPVersion` guard admits, spanning the modern and legacy eras.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MCP_META_VERSION`                   | const | `'io.modelcontextprotocol/protocolVersion'`                                   | Names the reserved modern `_meta` key carrying the request's protocol revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MCP_META_CAPABILITIES`              | const | `'io.modelcontextprotocol/clientCapabilities'`                                | Names the reserved modern `_meta` key carrying the client's open capability record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MCP_META_CLIENT`                    | const | `'io.modelcontextprotocol/clientInfo'`                                        | Names the reserved modern `_meta` key carrying the optional client identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MCP_META_SERVER`                    | const | `'io.modelcontextprotocol/serverInfo'`                                        | Names the reserved modern `_meta` key carrying the server identity on results.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MCP_META_SUBSCRIPTION`              | const | `'io.modelcontextprotocol/subscriptionId'`                                    | Names the reserved modern `_meta` key carrying a `subscriptions/listen` request id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MCP_EXTENSION_TASKS`                | const | `'io.modelcontextprotocol/tasks'`                                             | Names the reserved extension key identifying the stable Tasks extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MCP_SENTINEL_PREFIX`                | const | `'=?base64?'`                                                                 | Names the opening marker of the Base64 sentinel a standard MCP header value travels in.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MCP_SENTINEL_SUFFIX`                | const | `'?='`                                                                        | Names the closing marker of the Base64 sentinel a standard MCP header value travels in.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MCP_PARAM_PREFIX`                   | const | `'Mcp-Param-'`                                                                | Names the request-header prefix an `x-mcp-header` annotation projects a tool argument onto.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MCP_HEADER_ANNOTATION`              | const | `'x-mcp-header'`                                                              | Identifies the tool-schema annotation key naming the header one parameter projects into.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MCP_LOOKUP_PAGES`                   | const | `8`                                                                           | Bounds the `tools/list` pages one modern `tools/call` walks to reach its own annotations.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MCP_HEADER_MISMATCH`                | const | `-32020`                                                                      | Names the MCP reserved error for required HTTP metadata that does not match the request body.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MCP_MISSING_CAPABILITY`             | const | `-32021`                                                                      | Names the MCP reserved error for an operation needing a client capability that was not declared.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MCP_UNSUPPORTED_VERSION`            | const | `-32022`                                                                      | Names the MCP reserved error for a request naming an unsupported protocol revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DEFAULT_MCP_CACHE_TTL`              | const | `60000`                                                                       | Sets the default modern result freshness lifetime in milliseconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DEFAULT_MCP_LIMITS`                 | const | `Readonly<{ message, metadata, keys, state, content, subscriptions, depth }>` | Sets the secure server bounds used when the matching `limit` option leaf is absent or malformed.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EMPTY_MCP_ARGUMENTS`                | const | `Readonly<Record<string, unknown>>`                                           | Holds the one empty argument record every argument-less modern `tools/call` runs with.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `JSONRPC_PARSE_ERROR`                | const | `-32700`                                                                      | Names the JSON-RPC 2.0 reserved error for invalid JSON received (the message did not parse).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JSONRPC_INVALID_REQUEST`            | const | `-32600`                                                                      | Names the JSON-RPC 2.0 reserved error for a payload that was not a valid Request object.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `JSONRPC_METHOD_NOT_FOUND`           | const | `-32601`                                                                      | Names the JSON-RPC 2.0 reserved error for a requested method that does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `JSONRPC_INVALID_PARAMS`             | const | `-32602`                                                                      | Names the JSON-RPC 2.0 reserved error for a method's invalid parameters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `JSONRPC_INTERNAL_ERROR`             | const | `-32603`                                                                      | Names the JSON-RPC 2.0 reserved error for a server that failed while handling an otherwise valid request.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `JSONRPC_SERVER_ERROR`               | const | `-32000`                                                                      | Names the JSON-RPC 2.0 implementation-defined server error (the `-32000` to `-32099` range).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DEFAULT_MCP_CLIENT_NAME`            | const | `'@orkestrel/mcp'`                                                            | Supplies the default client name reported in the MCP `initialize` handshake (`clientInfo.name`).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DEFAULT_MCP_CLIENT_VERSION`         | const | `'1.0.0'`                                                                     | Supplies the default client version reported in the MCP `initialize` handshake (`clientInfo.version`).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DEFAULT_MCP_REQUEST_TIMEOUT`        | const | `30000`                                                                       | Sets the default per-request deadline (ms) an `MCPClient` applies when `options.timeout` is unset — a request the remote server does not answer within it rejects.                                                                                                                                                                                                                                                                                                                                                                                    |
| `DEFAULT_MCP_SUBSCRIPTION_CAPACITY`  | const | `64`                                                                          | Sets the default number of subscription frames retained while no client read is parked.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MCP_SESSION_HEADER`                 | const | `'mcp-session-id'`                                                            | Names the Streamable-HTTP transport header that carries the MCP session id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MCP_PROTOCOL_VERSION_HEADER`        | const | `'mcp-protocol-version'`                                                      | Names the Streamable-HTTP transport header carrying the MCP protocol version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MCP_METHOD_HEADER`                  | const | `'mcp-method'`                                                                | Names the modern Streamable-HTTP request header carrying the JSON-RPC method.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MCP_NAME_HEADER`                    | const | `'mcp-name'`                                                                  | Names the modern Streamable-HTTP request header carrying a named target.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MCP_WEBSOCKET_SUBPROTOCOL`          | const | `'mcp'`                                                                       | Names the WebSocket subprotocol `createWebSocketClientTransport` requests by default — `'mcp'`, which `createWebSocketServer` selects when the client offers it. Per RFC 6455 §4.1 a client MUST fail the connection if the server returns a subprotocol it did not request; Node ≥ 22 (undici) enforces this strictly, so the default bakes the correct value in. Override `WebSocketClientTransportOptions.protocols` only when connecting to a foreign server that speaks a different subprotocol (or `[]` for no subprotocol negotiation at all). |

### Helpers

| API                                | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isJSONRPCId`                      | function | Determines whether a value is a valid JSON-RPC correlation id — a string or a finite integer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isBoundedString`                  | function | Determines whether a value is a string within a UTF-8 byte bound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `isBoundedJSON`                    | function | Determines whether a value is bounded, cycle-free exact JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isJSONObject`                     | function | Determines whether a value is an exact finite JSON object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `isMCPMetaKey`                     | function | Determines whether a string follows the dated MCP `_meta` key grammar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `isMCPMetaObject`                  | function | Determines whether a value is exact finite MCP metadata with valid keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `isMCPResultMetaObject`            | function | Determines whether a value is exact result metadata with a valid reserved server identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `isMCPNotificationMetaObject`      | function | Determines whether a value is exact notification metadata with a valid reserved subscription id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `isMCPLoggingLevel`                | function | Determines whether a value is one dated MCP logging level.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `isMCPIdentity`                    | function | Determines whether a value is one complete dated MCP implementation identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isMCPClientCapabilities`          | function | Determines whether a value is one exact open dated client-capability declaration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `isMCPServerCapabilities`          | function | Determines whether a value is one exact open dated server-capability declaration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `isMCPAnnotations`                 | function | Determines whether a value carries valid dated-schema MCP content annotations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `isMCPIcon`                        | function | Determines whether a value is one exact dated-schema MCP icon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `isMCPTextResource`                | function | Determines whether a value is embedded textual MCP resource contents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `isMCPBlobResource`                | function | Determines whether a value is embedded blob MCP resource contents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `isMCPContent`                     | function | Determines whether a value is one exact dated-schema MCP tool content block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `isMCPPaginationParams`            | function | Determines whether a value carries the shared optional pagination cursor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `isMCPResource`                    | function | Determines whether a value is one `resources/list` descriptor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `isMCPResourceTemplate`            | function | Determines whether a value is one resource-template descriptor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isMCPResourceContents`            | function | Determines whether a value is structurally discriminated resource contents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `isMCPResourcePage`                | function | Determines whether a value is one consumer-owned resource page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isMCPResourceTemplatePage`        | function | Determines whether a value is one consumer-owned resource-template page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `isMCPStringArguments`             | function | Determines whether a value is a string-valued MCP argument record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `isMCPPromptArgument`              | function | Determines whether a value is one prompt argument descriptor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isMCPPrompt`                      | function | Determines whether a value is one `prompts/list` descriptor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `isMCPPromptMessage`               | function | Determines whether a value is one prompt message with existing rich content.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `isMCPPromptPage`                  | function | Determines whether a value is one consumer-owned prompt page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isMCPPromptGetResult`             | function | Determines whether a value is one complete `prompts/get` result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `isMCPCompletionReference`         | function | Determines whether a value is a prompt or resource-template completion reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `isMCPCompletionParams`            | function | Determines whether a value is one `completion/complete` parameter object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `isMCPCompletion`                  | function | Determines whether a value is one host-produced completion candidate set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `isMCPCompletionResult`            | function | Determines whether a value is one complete, capped `completion/complete` result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `isMCPCallResult`                  | function | Determines whether a value is a complete modern MCP tool result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `isMCPProgress`                    | function | Determines whether a value is one exact finite MCP progress payload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `isStandardBase64`                 | function | Determines whether a value is standard padded base64 as required by JSON Schema `byte` format.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `isAbsoluteURI`                    | function | Determines whether a value is one absolute URI under RFC 3986 syntax.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `isRFC3339Date`                    | function | Determines whether a value is one RFC 3339 `full-date` naming a real calendar day.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `isRFC3339DateTime`                | function | Determines whether a value is one RFC 3339 `date-time` naming a real calendar day.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `isJSONRPCRequest`                 | function | Determines whether a parsed value is a `JSONRPCRequest`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `isJSONRPCNotification`            | function | Determines whether a parsed value is a `JSONRPCNotification`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isJSONRPCInvocation`              | function | Determines whether a parsed value is a `JSONRPCInvocation` — a request or a notification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `isJSONRPCResultResponse`          | function | Determines whether a parsed value is a `JSONRPCResultResponse` — the success arm of a response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isJSONRPCError`                   | function | Determines whether a value is one JSON-RPC `error` member.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `isJSONRPCErrorResponse`           | function | Determines whether a parsed value is a `JSONRPCErrorResponse` — the failure arm of a response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `isJSONRPCResponse`                | function | Determines whether a parsed value is a `JSONRPCResponse`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `isJSONRPCMessage`                 | function | Determines whether a parsed value is a `JSONRPCMessage` — an invocation or a response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `isMCPResult`                      | function | Determines whether a value is one modern MCP result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `isMCPLegacyResult`                | function | Determines whether a value is one legacy-era MCP result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `isInitializeRequest`              | function | Determines whether a parsed value is an MCP `initialize` invocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `isMCPVersion`                     | function | Determines whether a value is a supported `MCPVersion`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isMCPSubscriptionFilter`          | function | Determines whether a value is an MCP `MCPSubscriptionFilter`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isMCPSubscriptionResult`          | function | Determines whether a value is a graceful `subscriptions/listen` result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `supportsFormElicitation`          | function | Determines whether a client capability record declares form-mode elicitation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isMCPElicitFieldSchema`           | function | Determines whether a value is one restricted primitive form-elicitation schema.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isMCPElicitSchema`                | function | Determines whether a value is the restricted top-level object schema a form elicitation issues.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isMCPElicitForm`                  | function | Determines whether a value is a form-mode elicitation parameter object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isMCPElicitURL`                   | function | Determines whether a value is a URL-mode elicitation parameter object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `isMCPElicitRequest`               | function | Determines whether a value is an embedded `elicitation/create` request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isMCPInputRequest`                | function | Determines whether a value is one legal embedded multi-round-trip request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `isMCPInputRequestMap`             | function | Determines whether a value is a consumer-keyed map of embedded input requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `isMCPRoot`                        | function | Determines whether a value is one filesystem root a client exposes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `isMCPRootResult`                  | function | Determines whether a value is one client answer to an embedded `roots/list` request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `isMCPSampleContent`               | function | Determines whether a value is one block a sampling completion may carry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `isMCPSampleResult`                | function | Determines whether a value is one client answer to an embedded sampling request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `isMCPElicitResult`                | function | Determines whether a value is one elicitation response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isElicitContent`                  | function | Determines whether accepted elicitation content satisfies the exact schema that was issued.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `isMCPInputResponse`               | function | Determines whether a response answers the exact embedded request that was issued.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `isMCPInputResult`                 | function | Determines whether a value is an MCP input-required result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `computeMissingCapabilities`       | function | Computes the capabilities one round of input requests needs and the client did not declare.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `supportsTask`                     | function | Determines whether a client capability record declares the stable Tasks extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `isMCPTaskStatus`                  | function | Determines whether a value is one of the extension's task lifecycle states.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `isMCPTaskResult`                  | function | Determines whether a value is a modern MCP task-creation result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `isMCPTaskDetail`                  | function | Determines whether a value is one durable task's full snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isMCPTaskDetailResult`            | function | Determines whether a value is the wire answer to `tasks/get`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isMCPTaskNotification`            | function | Determines whether a value is a `notifications/tasks` frame carrying a task snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `isModernRequest`                  | function | Determines whether a JSON-RPC invocation uses the modern per-request MCP wire shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `isMCPModernVersion`               | function | Determines whether a value is a modern protocol revision accepted by a bare server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `isMCPLegacyVersion`               | function | Determines whether a value is a revision accepted by the optional legacy decorator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `isMCPError`                       | function | Determines whether an unknown value is an `MCPError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `parseJSONRPCMessage`              | function | Narrows an already-parsed value to a `JSONRPCMessage`, or `undefined` when it is not one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `parseRequestContext`              | function | Parses the reserved modern request metadata into an `MCPRequestContext`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `parseMCPInputState`               | function | Parses the opened value carried by an opaque `requestState` continuation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `inferEra`                         | function | Infers the wire era for an MCP protocol revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `inferVersion`                     | function | Infers the newest supported modern protocol revision present in a peer's offer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `inferRequestEra`                  | function | Infers the wire era one invocation's own structure selects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `inferRequestVersion`              | function | Infers the protocol version an outbound message announces itself with — the one projection every HTTP client transport stamps `mcp-protocol-version` from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `buildJSONRPCResult`               | function | Builds a JSON-RPC success `JSONRPCResultResponse` — the `id` echoed, the method's value as `result`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `buildJSONRPCError`                | function | Builds a JSON-RPC error `JSONRPCErrorResponse` — the `id` echoed, the failure as an `error` object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `buildMethodOptions`               | function | Resolves the caller-facing dispatch options into the options a dispatched method receives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `buildToolDescriptors`             | function | Maps a `ToolManagerInterface`'s definitions to MCP `tools/list` descriptors — renaming `parameters` to the wire's `inputSchema`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `buildToolCall`                    | function | Builds the canonical Tool call for one validated MCP `tools/call` request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `buildProgressNotification`        | function | Builds one official progress notification for the original request stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `buildCancelledNotification`       | function | Builds one official cancellation notification for a request already sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `buildCallOutcome`                 | function | Narrows one `tools/call` answer to the arm the peer chose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `extractContentText`               | function | Concatenates an MCP tool-call result's text content blocks into one string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `matchesResultType`                | function | Determines whether one method may answer with a given modern `resultType`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `snapshotJSON`                     | function | Snapshots one bounded exact JSON value together with its canonical wire serialization. The returned value is an owned, deeply frozen graph reconstructed from the canonical text; the frozen tuple shares no mutable structure with the input. Invalid exact-JSON shapes, hostile reflection, serialization failures, and values outside the byte, key, or depth limits return `undefined`.                                                                                                                                                                                                                                                                                                                                      |
| `snapshotToolResult`               | function | Snapshots one exact Tool result and the canonical wire text of a defined success value. A success must have exactly the own enumerable data properties `id`, `name`, `success: true`, and `value`. A failure must instead have exactly `id`, `name`, `success: false`, and a string `error`. The returned result and tuple are frozen. Only a defined success value crosses the bounded JSON ownership seam; it becomes an owned deeply frozen value and receives canonical text. Value-less successes and failures pair with `undefined` text. Non-records, symbol keys, accessors, hidden or extra properties, malformed discriminants or fields, hostile reflection, and unbounded defined success values return `undefined`. |
| `serializeJSON`                    | function | Serializes one exact JSON value deterministically within explicit bounds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `digestJSON`                       | function | Computes a lowercase host-neutral SHA-256 digest of one bounded canonical JSON value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `buildDiscoverResult`              | function | Builds the mandatory modern `server/discover` result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `buildModernResult`                | function | Stamps a result with the modern complete-result discriminator and server metadata, plus cache fields when the result is cacheable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `modernResultToLegacy`             | function | Projects one complete modern result onto the legacy wire shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `legacyResultToModern`             | function | Restores one legacy result to the modern complete-result shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `legacyInvocationToModern`         | function | Stamps one legacy request for the modern dispatcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `modernInvocationToLegacy`         | function | Removes modern request metadata before an invocation reaches a legacy peer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `buildSubscriptionFilter`          | function | Intersects a requested subscription filter with the notification families a server supports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `matchesSubscriptionNotification`  | function | Determines whether a produced notification belongs to an honoured subscription filter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `stampSubscriptionNotification`    | function | Stamps a subscription notification with the request id reserved for its held-open stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `buildSubscriptionAcknowledgement` | function | Builds the first notification carrying a subscription id for a listen request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `buildSubscriptionResult`          | function | Builds the terminating response for a subscription source that closes gracefully.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `buildInitializeResult`            | function | Builds the MCP `initialize` result — the negotiated protocol version, the advertised capabilities, and the server identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `decodeBoundedMessage`             | function | Decodes one raw inbound message within an explicit bound — the decode a binder performs before it hands the string on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `deliverMessage`                   | function | Decodes one inbound frame and delivers it onto a transport emitter as `message` or `error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `readCancelledId`                  | function | Reads the request id an inbound `notifications/cancelled` names — the inverse of `buildCancelledNotification`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `decodeSentinel`                   | function | Reads the value one standard MCP request header carries, decoding the Base64 sentinel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `encodeSentinel`                   | function | Builds the wire form one standard MCP request header value must travel as.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `isFieldToken`                     | function | Determines whether a value is one RFC 9110 field token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isMCPHeaderPrimitive`             | function | Determines whether a value is a JSON Schema type an `x-mcp-header` annotation may sit on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `countHeaderAnnotations`           | function | Counts every `MCP_HEADER_ANNOTATION` key one JSON value carries, at any position.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `extractHeaderAnnotations`         | function | Reads every `x-mcp-header` annotation reachable from a schema node through `properties`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `buildHeaderParameters`            | function | Builds the `x-mcp-header` projections one tool's `inputSchema` declares.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `renderHeaderValue`                | function | Renders one projected argument as the text its `Mcp-Param-*` header carries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `buildHeaderProjection`            | function | Builds the `Mcp-Param-*` request headers one `tools/call` carries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `extractToolSchema`                | function | Reads one named tool's advertised `inputSchema` out of a `tools/list` answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sendStream`                       | function | Pumps a controlled serialized exchange onto a transport — every notification in order, then the terminating response — and end the exchange however the pump leaves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `bindServer`                       | function | Pipes an `MCPTransportInterface` into an `MCPDispatcherInterface` — every inbound message runs through `server.handle`, and a defined reply is written back through `transport.send`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `bindClient`                       | function | Pipes an `MCPTransportInterface` into an `MCPClientInterface` — every inbound message is decoded and delivered onto the client's own transport (`client.transport.emitter`'s `message` / `close` events), resolving/rejecting the client's correlated pending requests exactly as a direct reply would.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `decodeEvent`                      | function | Decodes one SSE event's `data` string into a `JSONRPCMessage`, or `undefined` when it is not one — the per-event step `readEventStream` folds over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `readEventStream`                  | function | Decodes a `fetch` Response's Server-Sent-Events body into the JSON-RPC messages it carried — the CLIENT-side inverse of a server's Streamable-HTTP SSE response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `buildResponseError`               | function | Builds the error for a non-success HTTP response that carried no JSON-RPC message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an
optional member and `plus` introducing its call-signature members, and a type alias's own type
literal with a union's arms escaped as `\|`.

| Type                               | Kind      | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Summary                                                                                                                                                                                                     |
| ---------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JSONRPCId`                        | type      | `string \| number`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents a JSON-RPC 2.0 correlation id — the value a request and its response share.                                                                                                                      |
| `JSONRPCRequest`                   | interface | `{ jsonrpc: '2.0', method, id, params? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Represents a JSON-RPC 2.0 request — a `method` call with optional `params`, correlated to its response by the `id` it requires.                                                                             |
| `JSONRPCNotification`              | interface | `{ jsonrpc: '2.0', method, id?: never, params? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Represents a JSON-RPC 2.0 notification — a fire-and-forget `method` call that is answered by nothing (for example, `notifications/initialized`).                                                            |
| `JSONRPCInvocation`                | type      | `JSONRPCRequest \| JSONRPCNotification`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Represents one inbound JSON-RPC call — the common dispatch input.                                                                                                                                           |
| `JSONRPCError`                     | interface | `{ code, message, data? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents a JSON-RPC 2.0 error object — the `error` member of a `JSONRPCErrorResponse`.                                                                                                                    |
| `JSONRPCResultResponse`            | interface | `{ jsonrpc: '2.0', id, result, error?: never }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Represents the success arm of a JSON-RPC 2.0 response — the request's `id` echoed with the method's `result`.                                                                                               |
| `JSONRPCErrorResponse`             | interface | `{ jsonrpc: '2.0', id?, error, result?: never }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents the failure arm of a JSON-RPC 2.0 response — the request's `id` echoed with the `JSONRPCError` that ended it.                                                                                    |
| `JSONRPCResponse`                  | type      | `JSONRPCResultResponse \| JSONRPCErrorResponse`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Represents a JSON-RPC 2.0 response — the answer to one `JSONRPCRequest`.                                                                                                                                    |
| `JSONRPCMessage`                   | type      | `JSONRPCInvocation \| JSONRPCResponse`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents a JSON-RPC 2.0 message on the wire — a `JSONRPCInvocation` or a `JSONRPCResponse`.                                                                                                               |
| `MCPResult`                        | interface | `{ resultType, _meta?, [key: string] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Represents one modern MCP result — the open contract every dated-revision result satisfies.                                                                                                                 |
| `MCPLegacyResult`                  | interface | `{ resultType?: never, [key: string] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Represents one legacy-era result — the payload of an answer produced by the fixed legacy method switch.                                                                                                     |
| `MCPVersion`                       | type      | `MCPModernVersion \| MCPLegacyVersion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Names a protocol revision supported by an MCP package surface.                                                                                                                                              |
| `MCPModernVersion`                 | type      | `'2026-07-28'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Names a modern protocol revision supported by the bare MCP server.                                                                                                                                          |
| `MCPLegacyVersion`                 | type      | `'2025-11-25' \| '2025-06-18'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Names a legacy protocol revision supported by the optional legacy decorators.                                                                                                                               |
| `MCPMetaObject`                    | type      | `Readonly<Record<string, JSONValue>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents the exact finite JSON metadata carried by MCP `_meta` envelopes.                                                                                                                                 |
| `MCPResultMetaObject`              | type      | `MCPMetaObject & {}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Carries open result metadata with the dated reserved server identity field.                                                                                                                                 |
| `MCPNotificationMetaObject`        | type      | `MCPMetaObject & {}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Carries open notification metadata with the dated reserved subscription field.                                                                                                                              |
| `MCPLoggingLevel`                  | type      | `'debug' \| 'info' \| 'notice' \| 'warning' \| 'error' \| 'critical' \| 'alert' \| 'emergency'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Names the dated logging levels accepted by MCP request metadata.                                                                                                                                            |
| `MCPClientCapabilities`            | type      | `Readonly<Record<string, MCPMetaObject>> & { experimental?, roots?, sampling?, elicitation?, extensions? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Represents the open dated client-capability declaration carried by modern requests.                                                                                                                         |
| `MCPServerCapabilities`            | type      | `Readonly<Record<string, MCPMetaObject>> & { experimental?, logging?, completions?, prompts?, resources?, tools?, extensions? }`                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents the open dated server-capability declaration returned by discovery.                                                                                                                              |
| `MCPEra`                           | type      | `'modern' \| 'legacy'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Names the wire era selected by an MCP request's structure.                                                                                                                                                  |
| `MCPRole`                          | type      | `'user' \| 'assistant'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Names the intended recipient of annotated MCP content.                                                                                                                                                      |
| `MCPAnnotations`                   | interface | `{ audience?, priority?, lastModified? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Represents the optional audience, importance, and modification hints on MCP content.                                                                                                                        |
| `MCPIcon`                          | type      | `MCPMetaObject & { src, mimeType?, sizes?, theme?: 'light' \| 'dark' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Represents one sized, themed icon associated with an MCP resource link.                                                                                                                                     |
| `MCPTextContent`                   | interface | `{ type: 'text', text, annotations?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Represents a textual MCP content block.                                                                                                                                                                     |
| `MCPImageContent`                  | interface | `{ type: 'image', data, mimeType, annotations?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Represents a base64-encoded image MCP content block.                                                                                                                                                        |
| `MCPAudioContent`                  | interface | `{ type: 'audio', data, mimeType, annotations?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Represents a base64-encoded audio MCP content block.                                                                                                                                                        |
| `MCPResourceLink`                  | interface | `{ type: 'resource_link', name, title?, icons?, uri, description?, mimeType?, annotations?, size?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Represents a link to an MCP resource, including its exact dated-schema metadata.                                                                                                                            |
| `MCPTextResource`                  | interface | `{ uri, mimeType?, _meta?, text }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents embedded textual resource contents.                                                                                                                                                              |
| `MCPBlobResource`                  | interface | `{ uri, mimeType?, _meta?, blob }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents embedded base64-encoded resource contents.                                                                                                                                                       |
| `MCPEmbeddedResource`              | interface | `{ type: 'resource', resource, annotations?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents an MCP content block carrying embedded text or blob resource contents.                                                                                                                           |
| `MCPContent`                       | type      | `MCPTextContent \| MCPImageContent \| MCPAudioContent \| MCPResourceLink \| MCPEmbeddedResource`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents one exact dated-schema tool content block.                                                                                                                                                       |
| `MCPUnstampedCallResult`           | type      | `{ content, structuredContent?, isError?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Represents a `tools/call` result before the modern stamp — the executed tool's output as `content` blocks, with `isError` flagging a tool failure.                                                          |
| `MCPCallResult`                    | type      | `MCPUnstampedCallResult & { resultType: 'complete' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents a required complete modern `tools/call` result.                                                                                                                                                  |
| `MCPPaginationParams`              | interface | `{ cursor? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Represents the cursor parameters shared by every paginated modern list method.                                                                                                                              |
| `MCPPaginationResult`              | interface | `{ nextCursor? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Represents the cursor result fields shared by every paginated modern list method.                                                                                                                           |
| `MCPResource`                      | interface | `{ uri, name, title?, description?, mimeType?, annotations?, size?, icons?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents one resource descriptor advertised by `resources/list`.                                                                                                                                          |
| `MCPResourceTemplate`              | interface | `{ uriTemplate, name, title?, description?, mimeType?, annotations?, icons?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents one RFC 6570 resource-template descriptor advertised by `resources/templates/list`.                                                                                                              |
| `MCPResourceContents`              | type      | `(MCPTextResource & { blob?: never }) \| (MCPBlobResource & { text?: never })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Represents the resource contents returned by `resources/read`.                                                                                                                                              |
| `MCPResourcePage`                  | interface | `{ nextCursor?, resources }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Represents one consumer-owned page projected by `resources/list`.                                                                                                                                           |
| `MCPResourceTemplatePage`          | interface | `{ nextCursor?, resourceTemplates }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Represents one consumer-owned page projected by `resources/templates/list`.                                                                                                                                 |
| `MCPResourceReadParams`            | interface | `{ uri, inputResponses?, requestState? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Represents the parameters `resources/read` accepts — a concrete `uri` plus the optional multi-round continuation carriers.                                                                                  |
| `MCPResourceListResult`            | type      | `MCPResourcePage & { resultType: 'complete', ttlMs, cacheScope: 'public' \| 'private', _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents the complete cacheable `resources/list` result.                                                                                                                                                  |
| `MCPResourceReadResult`            | type      | `{ contents, resultType: 'complete', ttlMs, cacheScope: 'public' \| 'private', _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Represents the complete cacheable `resources/read` result.                                                                                                                                                  |
| `MCPResourceTemplateListResult`    | type      | `MCPResourceTemplatePage & { resultType: 'complete', ttlMs, cacheScope: 'public' \| 'private', _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Represents the complete cacheable `resources/templates/list` result.                                                                                                                                        |
| `MCPResourceManagerInterface`      | interface | `{} plus resources, resource, templates`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Represents the consumer-supplied resource registry port.                                                                                                                                                    |
| `MCPPromptArgument`                | interface | `{ name, title?, description?, required? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Represents one argument descriptor advertised with an MCP prompt.                                                                                                                                           |
| `MCPPrompt`                        | interface | `{ name, title?, description?, arguments?, icons?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Represents one prompt descriptor advertised by `prompts/list`.                                                                                                                                              |
| `MCPPromptMessage`                 | interface | `{ role: 'user' \| 'assistant', content }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents one user or assistant message returned by `prompts/get`.                                                                                                                                         |
| `MCPPromptPage`                    | interface | `{ nextCursor?, prompts }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents one consumer-owned page projected by `prompts/list`.                                                                                                                                             |
| `MCPPromptGetParams`               | interface | `{ name, arguments?, inputResponses?, requestState? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents the parameters `prompts/get` accepts — a prompt name plus the optional argument values and multi-round continuation carriers.                                                                    |
| `MCPPromptListResult`              | type      | `MCPPromptPage & { resultType: 'complete', ttlMs, cacheScope: 'public' \| 'private', _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Represents the complete cacheable `prompts/list` result.                                                                                                                                                    |
| `MCPPromptGetResult`               | interface | `{ resultType: 'complete', description?, messages, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Represents the complete, non-cacheable `prompts/get` result.                                                                                                                                                |
| `MCPPromptManagerInterface`        | interface | `{} plus prompts, prompt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Represents the consumer-supplied prompt registry port.                                                                                                                                                      |
| `MCPPromptReference`               | interface | `{ type: 'ref/prompt', name }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Represents a completion reference to one named prompt.                                                                                                                                                      |
| `MCPResourceTemplateReference`     | interface | `{ type: 'ref/resource', uri }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Represents a completion reference to one resource-template URI descriptor.                                                                                                                                  |
| `MCPCompletionReference`           | type      | `MCPPromptReference \| MCPResourceTemplateReference`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Represents the prompt or resource-template reference accepted by `completion/complete`.                                                                                                                     |
| `MCPCompletionArgument`            | interface | `{ name, value }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Represents the argument fragment being completed.                                                                                                                                                           |
| `MCPCompletionContext`             | interface | `{ arguments? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Holds previously resolved string arguments supplied as completion context.                                                                                                                                  |
| `MCPCompletionParams`              | interface | `{ ref, argument, context? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Represents the parameters `completion/complete` accepts — a reference, the argument fragment being completed, and the optional resolved context.                                                            |
| `MCPCompletion`                    | interface | `{ values, total?, hasMore? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Represents one completion candidate set before the protocol's 100-value projection cap.                                                                                                                     |
| `MCPCompletionResult`              | interface | `{ resultType: 'complete', completion, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents the complete `completion/complete` result.                                                                                                                                                       |
| `MCPCompletionInterface`           | interface | `{} plus complete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents the consumer-supplied completion port for prompt and resource-template arguments.                                                                                                                |
| `MCPElicitValue`                   | type      | `string \| number \| boolean \| readonly string[]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Names the primitive value shapes accepted in an MCP form elicitation response.                                                                                                                              |
| `MCPElicitChoice`                  | interface | `{ const, title }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents one titled value in a form elicitation's single- or multi-select schema.                                                                                                                         |
| `MCPElicitFieldSchema`             | type      | `{ type: 'boolean', title?, description?, default? } \| { type: 'number' \| 'integer', title?, description?, minimum?, maximum?, default? } \| { type: 'string', title?, description?, minLength?, maxLength?, format?: 'uri' \| 'email' \| 'date' \| 'date-time', default? } \| { type: 'string', title?, description?, enum, default? } \| { type: 'string', title?, description?, oneOf, default? } \| { type: 'string', title?, description?, enum, enumNames, default? } \| { type: 'array', title?, description?, minItems?, maxItems?, default?, items }` | Represents one restricted single-field schema accepted by MCP form-mode elicitation.                                                                                                                        |
| `MCPElicitSchema`                  | interface | `{ $schema?, type: 'object', properties, required? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents the restricted top-level object schema in a form-mode elicitation request.                                                                                                                       |
| `MCPElicitForm`                    | interface | `{ mode?: 'form', message, requestedSchema }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Represents the parameters of a form-mode `elicitation/create` request.                                                                                                                                      |
| `MCPElicitURL`                     | interface | `{ mode: 'url', message, url }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Represents the parameters of a URL-mode `elicitation/create` request.                                                                                                                                       |
| `MCPElicitParams`                  | type      | `MCPElicitForm \| MCPElicitURL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Represents the mode-discriminated parameters of an `elicitation/create` request.                                                                                                                            |
| `MCPElicitRequest`                 | interface | `{ method: 'elicitation/create', params }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents an embedded MCP request asking the client to elicit input from its operator.                                                                                                                     |
| `MCPElicitResult`                  | interface | `{ action: 'accept' \| 'decline' \| 'cancel', content? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Represents the result supplied by a client for one embedded `MCPElicitRequest`.                                                                                                                             |
| `MCPInputRequest`                  | type      | `MCPElicitRequest \| { method: 'sampling/createMessage', params } \| { method: 'roots/list', params? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Represents one embedded multi-round-trip request.                                                                                                                                                           |
| `MCPInputRequestMap`               | type      | `Readonly<Record<string, MCPInputRequest>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Represents a consumer-keyed map of embedded requests the client must fulfil.                                                                                                                                |
| `MCPRoot`                          | interface | `{ uri, name?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Represents one filesystem root a client exposes to a server.                                                                                                                                                |
| `MCPRootResult`                    | interface | `{ roots, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Represents the client's answer to one embedded `roots/list` request.                                                                                                                                        |
| `MCPToolUseContent`                | interface | `{ type: 'tool_use', id, name, input, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Represents a model's request to call one tool, carried inside a sampling completion.                                                                                                                        |
| `MCPToolResultContent`             | interface | `{ type: 'tool_result', toolUseId, content, isError?, structuredContent?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Represents one tool's outcome returned to the model, carried in a sampling completion.                                                                                                                      |
| `MCPSampleContent`                 | type      | `MCPTextContent \| MCPImageContent \| MCPAudioContent \| MCPToolUseContent \| MCPToolResultContent`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Represents one block a sampling completion may carry.                                                                                                                                                       |
| `MCPSampleResult`                  | interface | `{ role: 'user' \| 'assistant', content, model, stopReason?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents the client's answer to one embedded `sampling/createMessage` request.                                                                                                                            |
| `MCPInputResponse`                 | type      | `MCPElicitResult \| MCPSampleResult \| MCPRootResult`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents one client answer to one embedded input request.                                                                                                                                                 |
| `MCPInputResponseMap`              | type      | `Readonly<Record<string, MCPInputResponse>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Represents a consumer-keyed map of the client's answers to one issued round.                                                                                                                                |
| `MCPInputResult`                   | type      | `{ resultType: 'input_required', inputRequests, requestState?, _meta? } \| { resultType: 'input_required', inputRequests?, requestState, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                               | Represents an incomplete modern result carrying input requests, protected request state, or both.                                                                                                           |
| `MCPInputState`                    | interface | `{ principal, expiry, id, version, method, requests, name, digest, state? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Represents the integrity-protected payload carried inside an opaque `requestState` token.                                                                                                                   |
| `MCPInputContext`                  | interface | `{ request, name, arguments, responses?, state? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents the call-in-hand context supplied to an `MCPInputHandler`.                                                                                                                                       |
| `MCPInputRound`                    | interface | `{ requests, state? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents one consumer-composed round of embedded requests, before MCP seals its continuation state.                                                                                                       |
| `MCPInputHandler`                  | type      | `(context: MCPInputContext, options: MCPMethodOptions,) => MCPInputRound \| undefined \| Promise<MCPInputRound \| undefined>`                                                                                                                                                                                                                                                                                                                                                                                                                                    | Decides whether the current `tools/call` still needs input from the client.                                                                                                                                 |
| `MCPPrincipalHandler`              | type      | `(request: JSONRPCRequest, options: MCPMethodOptions,) => string \| Promise<string>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Derives the deployment-authenticated principal bound into signed request state.                                                                                                                             |
| `MCPContinuationInterface`         | interface | `{} plus seal, open`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Represents the host-neutral integrity and storage port for opaque MRTR continuation state.                                                                                                                  |
| `MCPInputOptions`                  | interface | `{ continuation, ttl, principal, selector }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Configures the consumer policy for the server's multi-round-trip input mechanism.                                                                                                                           |
| `MCPTaskStatus`                    | type      | `'working' \| 'input_required' \| 'completed' \| 'failed' \| 'cancelled'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Names the lifecycle state of one durable task.                                                                                                                                                              |
| `MCPTask`                          | type      | `{ taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents one durable task's wire snapshot — the payload a deferred `tools/call` answers with.                                                                                                             |
| `MCPTaskDetail`                    | type      | `(MCPTask & { status: 'working' }) \| (MCPTask & { status: 'input_required', inputRequests }) \| (MCPTask & { status: 'completed', result }) \| (MCPTask & { status: 'failed', error }) \| (MCPTask & { status: 'cancelled' })`                                                                                                                                                                                                                                                                                                                                  | Represents one task snapshot together with whatever its status carries — the shape `tasks/get` and a task notification report.                                                                              |
| `MCPTaskDetailResult`              | type      | `MCPTaskDetail & { resultType: 'complete', _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Represents the wire answer to `tasks/get` — one snapshot under the completed-result stamp.                                                                                                                  |
| `MCPTaskNotificationParams`        | type      | `MCPTaskDetail & { _meta?, [key: string] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Represents the parameters of a `notifications/tasks` frame — one snapshot, flat, optionally stamped with the subscription that delivered it.                                                                |
| `MCPTaskNotification`              | type      | `JSONRPCNotification & { method: 'notifications/tasks', params }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Represents one well-formed `notifications/tasks` frame — the notification `isMCPTaskNotification` admits.                                                                                                   |
| `MCPTaskResult`                    | type      | `MCPTask & { resultType: 'task', _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents the modern `tools/call` result announcing that the call became a durable task.                                                                                                                   |
| `MCPTaskContext`                   | interface | `{ request, call, tools }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents the call-in-hand context supplied to an `MCPTaskHandler` and to `MCPTaskManagerInterface.start`.                                                                                                 |
| `MCPTaskManagerInterface`          | interface | `{} plus start, task, update, abort`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Represents the consumer-owned durable store behind the Tasks extension — the port this package creates tasks through and reads them back from.                                                              |
| `MCPTaskHandler`                   | type      | `(context: MCPTaskContext, options: MCPMethodOptions,) => string \| undefined \| Promise<string \| undefined>`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Decides whether the `tools/call` in hand becomes a durable task.                                                                                                                                            |
| `MCPTaskOptions`                   | interface | `{ tasks, deferral }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Configures the consumer policy for the server's stable Tasks extension.                                                                                                                                     |
| `MCPProgress`                      | interface | `{ progress, total?, message? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents one official request-scoped progress payload.                                                                                                                                                    |
| `MCPProgressInterface`             | interface | `{} plus report`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Reports request-scoped progress under backpressure — the reporter supplied to an explicit executor.                                                                                                         |
| `MCPProgressOwnerInterface`        | interface | `{} plus report, take, stop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Represents the owning half of one progress slot — `MCPProgressInterface` plus the consuming and stopping the slot's owner performs.                                                                         |
| `MCPExecutionContext`              | interface | `{ request, call, tools, signal, progress? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Represents the explicit, host-neutral context for one modern tool execution.                                                                                                                                |
| `MCPExecutionHandler`              | type      | `(context: MCPExecutionContext,) => ToolResult \| MCPCallResult \| Promise<ToolResult \| MCPCallResult>`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Executes one canonical tool call or returns a fully formed complete MCP result.                                                                                                                             |
| `MCPListResult`                    | type      | `{ tools, resultType: 'complete', ttlMs, cacheScope: 'public' \| 'private', _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents the MCP `tools/list` result — tool descriptors plus optional modern result stamps.                                                                                                               |
| `MCPToolDescriptor`                | interface | `{ name, description?, inputSchema }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents one entry of the MCP `tools/list` result — a tool's `name`, optional `description`, and its JSON-Schema `inputSchema`.                                                                           |
| `MCPHeaderPrimitive`               | type      | `'boolean' \| 'integer' \| 'string'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Names the JSON Schema types an `x-mcp-header` annotation may sit on.                                                                                                                                        |
| `MCPHeaderParameter`               | interface | `{ name, path, primitive }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Represents one `x-mcp-header` projection a tool's `inputSchema` declares.                                                                                                                                   |
| `MCPIdentity`                      | type      | `MCPMetaObject & { name, version, title?, description?, websiteUrl?, icons? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Represents the complete dated identity of an MCP server or client.                                                                                                                                          |
| `MCPRequestContext`                | interface | `{ version, capabilities, identity? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents the validated per-request context projected from a modern request's reserved `_meta` keys.                                                                                                       |
| `MCPDiscoverResult`                | type      | `{ supportedVersions, capabilities, resultType: 'complete', ttlMs, cacheScope: 'public' \| 'private', instructions?, _meta? }`                                                                                                                                                                                                                                                                                                                                                                                                                                   | Represents the mandatory modern `server/discover` result.                                                                                                                                                   |
| `MCPSubscriptionFilter`            | interface | `{ toolsListChanged?, promptsListChanged?, resourcesListChanged?, resourceSubscriptions?, taskIds? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Names the notification families a client may opt in to on a `subscriptions/listen` stream.                                                                                                                  |
| `MCPSubscriptionResultMetaObject`  | type      | `MCPResultMetaObject & {}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents the required metadata on a graceful `subscriptions/listen` result.                                                                                                                               |
| `MCPSubscriptionResult`            | type      | `{ resultType: 'complete', _meta }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Represents the terminating result returned when a `subscriptions/listen` stream closes gracefully.                                                                                                          |
| `MCPSubscriptionStream`            | type      | `AsyncGenerator< JSONRPCNotification, MCPSubscriptionResult, unknown >`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Represents a client subscription's owned notifications and graceful terminal result.                                                                                                                        |
| `MCPListenOptions`                 | interface | `{ signal, capacity? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Configures the per-subscription cancellation and bounded buffering policy.                                                                                                                                  |
| `MCPDispatchOptions`               | interface | `{ signal?, caller? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents the per-request execution options every dispatched handler receives.                                                                                                                             |
| `MCPMethodOptions`                 | interface | `{ signal, caller? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents the resolved per-request options one dispatched method receives.                                                                                                                                 |
| `MCPSubscriptionHandler`           | type      | `(notifications: MCPSubscriptionFilter, options: MCPMethodOptions,) => AsyncIterable<JSONRPCNotification> \| Promise<AsyncIterable<JSONRPCNotification>>`                                                                                                                                                                                                                                                                                                                                                                                                        | Produces notifications for one honoured `subscriptions/listen` filter.                                                                                                                                      |
| `MCPSubscriptionOptions`           | interface | `{ notifications, producer }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Configures the server's built-in `subscriptions/listen` method.                                                                                                                                             |
| `MCPStream`                        | type      | `AsyncGenerator<JSONRPCNotification, JSONRPCResponse, unknown>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Represents a held-open modern result: each `yield` is a `JSONRPCNotification`; the `return` value is the terminating response.                                                                              |
| `MCPTextStream`                    | type      | `AsyncGenerator<string, string, unknown>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Mirrors `MCPStream` at the string boundary — the same sequence, already serialized.                                                                                                                         |
| `MCPStreamControllerInterface`     | interface | `{} plus next, return, throw, stop, [Symbol.asyncDispose]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents a held-open modern result whose cancellation one owner arbitrates — the arm every stream leaving `MCPServer.dispatch` takes.                                                                     |
| `MCPTextStreamControllerInterface` | interface | `{} plus next, return, throw, stop, [Symbol.asyncDispose]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Mirrors `MCPStreamControllerInterface` at the string boundary — the same exchange, already serialized.                                                                                                      |
| `MCPMethodHandler`                 | type      | `(request: JSONRPCRequest, options: MCPMethodOptions,) => Promise<JSONRPCResponse \| MCPStream>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents one modern method, registered on the seam that dispatches it.                                                                                                                                    |
| `MCPMethodManagerInterface`        | interface | `{} plus add, method`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents the modern method registry an `MCPServerInterface` dispatches through — the one seam carrying both the built-in methods and any method a consumer adds.                                          |
| `MCPServerEventMap`                | type      | `{ request, error }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Represents the push observation surface of an `MCPServerInterface` — the dispatch moments a fire-and-forget observer (logging, tracing) subscribes to through `server.emitter.on`.                          |
| `MCPLimitOptions`                  | interface | `{ message?, metadata?, keys?, state?, content?, subscriptions?, depth? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Configures the hostile-input and live-resource bounds for an MCP server.                                                                                                                                    |
| `MCPJSONLimitOptions`              | interface | `{ bytes, keys?, depth }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Limits applied by `isBoundedJSON` to one JSON value.                                                                                                                                                        |
| `MCPServerOptions`                 | interface | `{ on?, error?, identity, tools, resources?, prompts?, completion?, execution?, instructions?, cache?, input?, subscription?, task?, limit? }`                                                                                                                                                                                                                                                                                                                                                                                                                   | Options for `createMCPServer` — the server `MCPIdentity`, the live `ToolManagerInterface` it exposes, optional `instructions`, and the reserved `on` hooks.                                                 |
| `MCPDispatcherInterface`           | interface | `{ emitter, limit } plus dispatch, handle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents the minimal transport-facing MCP dispatch surface.                                                                                                                                               |
| `MCPServerInterface`               | interface | `{ emitter, limit, identity, methods } plus dispatch, handle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Dispatches JSON-RPC 2.0 modern requests over a live `ToolManagerInterface`, with no transport coupling (a transport layer pumps strings through `handle`).                                                  |
| `MCPLegacyOptions`                 | interface | `{ dispatcher, identity }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents the construction options for the removable legacy protocol decorator.                                                                                                                            |
| `MCPTransportInterface`            | interface | `{} plus send, listen, closed, close`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents a duplex message channel an environment face provides to the pure engine — the one port `bindServer` and `bindClient` (`./helpers.js`) pipe an `MCPServerInterface` / `MCPClientInterface` over. |
| `MCPMessageTransportEventMap`      | type      | `{ message, close, error }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Lists the observable events of a `MCPMessageTransportInterface` — the moments the `MCPClientInterface` (and any tracer) subscribes to through `transport.emitter.on`.                                       |
| `MCPMessageTransportInterface`     | interface | `{ emitter, session, duplex } plus start, send, close`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Pumps JSON-RPC messages to a peer and surfaces received messages on its `emitter`'s `message` event, with no knowledge of the protocol role on either side — a transport-agnostic MCP message carrier.      |
| `HTTPClientTransportOptions`       | interface | `{ url, headers?, fetch?, timeout? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Options for `createHTTPClientTransport` — the remote MCP server's URL and any extra request headers.                                                                                                        |
| `MCPLegacyClientTransportOptions`  | interface | `{ identity?, capabilities?, version?, timeout? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Options for the explicit legacy client transport adapter.                                                                                                                                                   |
| `MCPClientEventMap`                | type      | `{ connect, disconnect, notification, error }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Represents the push observation surface of an `MCPClientInterface` — the moments a fire-and-forget observer (logging, tracing) subscribes to through `client.emitter.on`.                                   |
| `MCPClientOptions`                 | interface | `{ on?, error?, transport, identity?, capabilities?, version?, timeout? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Options for `createMCPClient` — the `MCPMessageTransportInterface` to drive, the optional client `MCPIdentity`, the per-request `timeout`, and the reserved `on` hooks.                                     |
| `MCPProgressHandler`               | type      | `(progress: MCPProgress) => void`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Receives one progress report a peer published for a request this client issued.                                                                                                                             |
| `MCPCallOptions`                   | interface | `{ signal?, progress?, input? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Configures per-call policy and continuation data for one remote `tools/call`.                                                                                                                               |
| `MCPCallOutcome`                   | type      | `{ resultType: 'complete', value } \| MCPTaskResult \| MCPInputResult`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents what one remote `tools/call` answered — the arms the dated protocol permits.                                                                                                                     |
| `MCPRequestFunction`               | type      | `(method: string, params: Readonly<Record<string, unknown>> \| undefined, deadline: number \| undefined,) => Promise<unknown>`                                                                                                                                                                                                                                                                                                                                                                                                                                   | Issues one correlated JSON-RPC request and awaits the peer's result.                                                                                                                                        |
| `MCPTaskClientOptions`             | interface | `{ request, timeout? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Represents the construction options for an `MCPTaskClientInterface`.                                                                                                                                        |
| `MCPTaskClientInterface`           | interface | `{} plus task, update, abort`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Reads, answers, and stops a durable task the peer created — the client half of the stable Tasks extension.                                                                                                  |
| `MCPClientInterface`               | interface | `{ emitter, connected, version, transport, tasks } plus connect, discover, disconnect, tools, listen, call`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Connects to a remote MCP server over any injected `MCPMessageTransportInterface`, negotiates the modern wire revision, and exposes the server's tools as local `ToolInterface`s an agent can run.           |

The `emitter`, `identity`, `methods`, and `limit` members of `MCPServerInterface` are
`readonly` data members (Surface rows, above) — its call-signature methods
are documented under [Methods](#methods), and the registry `methods` exposes
has its own method table there. Likewise the `emitter` /
`connected` / `version` / `transport` / `tasks` members of `MCPClientInterface` and
the `emitter` / `session` / `duplex` members of `MCPMessageTransportInterface` are data
members; their methods are under [Methods](#methods). The `id` member of
`MCPSessionInterface` is likewise a data member; its methods (`attach` /
`detach` / `push` / `replay`) are under [Methods](#methods).

### HTTP transport

The **Streamable HTTP transport** (`src/server`, through the `@src/server` barrel)
mounts a transport-agnostic `MCPServerInterface` on the `@orkestrel/router` /
`@orkestrel/server` spine as a route. `createMCPRoutes` returns the
`RouteInput[]` to register; it is **mechanism, not policy** — compose auth /
rate-limiting in front as ordinary middleware and supply the shared origin policy
through the `origin` option. Request-body size limits
are likewise deliberately not enforced by `createMCPRoutes` / `createMCPSession` —
a compressed/body-size guard is front-middleware policy the consumer composes, same as auth.
The core `limit.message` bound applies specifically where a transport supplies a raw string to
`MCPServer.handle`; the HTTP route owns and parses its Fetch `Request` body before typed dispatch.

The HTTP client transport does not mint or refresh credentials. A guarded server requires the
consumer to supply its bearer through `headers`. Use `ACCESS_TOKEN` for the bearer credential, for
example, `{ authorization: 'Bearer ACCESS_TOKEN' }`. If that bearer is missing and the guard
returns a non-JSON-RPC `401` JSON body, `send()` rejects with an error naming HTTP `401` and the
invalid JSON-RPC body shape. A valid correlated JSON-RPC error body is still emitted at any HTTP
status.

```ts
import { createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
import { createMCPRoutes } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
// POST /mcp dispatches JSON-RPC (JSON or SSE per Accept):
const routes = createMCPRoutes(createMCPLegacy(mcp)) // answers `initialize` too; pass `mcp` alone for modern-only
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
`200` otherwise. A unary reply is framed as one `@orkestrel/server` `createStream`
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
version and `Mcp-Method` equal to its body method. `Mcp-Name` is required on every
method carrying a named target — `tools/call` and `prompts/get` equal to `params.name`,
`resources/read` equal to `params.uri`; `server/discover`, `tools/list`, `resources/list`,
and `prompts/list` carry no target. A sentinel-encoded value is read through
`decodeSentinel` before the comparison, and a sentinel whose payload is invalid is refused
rather than read as a literal. A refusal names the first missing or mismatched field and the expected
value without echoing the supplied value; it is HTTP `400` + `-32020` with no `data`. A
`MCP-Protocol-Version` naming a modern revision over a body with no parsable modern `_meta`
is HTTP `400` + `-32602`.

A modern `tools/call` is additionally held to the `Mcp-Param-*` headers its own served
definition annotates. The handler reads those annotations by dispatching `tools/list`
through the same dispatcher and running `buildHeaderParameters` over the named tool's
`inputSchema`, fresh on each call rather than from a cache, so a registry a consumer
mutates cannot leave the validation reading a table that no longer holds. A recognized
header that is absent while the body supplies its value, one whose payload is not a valid
Base64 sentinel, one whose decoded value disagrees, and one asserting a value the body omits
are each HTTP `400` + `-32020`. An `integer` parameter compares numerically. A
`Mcp-Param-*` name no served definition annotates is forwarded untouched. A held-open
answer is released and read as no definition.

That dispatch follows `nextCursor` until it reaches the named tool or the answer carries no
cursor, bounded by `MCP_LOOKUP_PAGES` pages. The built-in `tools/list` answers the whole
registry on one page and never reaches the second, so the bound binds a consumer that
replaced `tools/list` with a paging handler. **The residual limit:** a definition further in
than that bound reads as no definition, so its `Mcp-Param-*` headers are forwarded
untouched — the answer an unannotated name receives, which is also the answer a client
forging them for such a tool receives. Page a replacement listing coarsely enough to keep
every annotated tool inside the bound. The cost is one in-memory `tools/list` dispatch per
page walked, per `tools/call`; a consumer whose replacement is expensive or held-open pays
for it there.

Each of those dispatches is observable. The synthetic `tools/list` fires the server's
`request` event with the reserved id `0` ahead of the `tools/call`'s own, so an observer
accounting for inbound traffic subtracts a `('tools/list', 0, 'modern')` that precedes a
`tools/call`. The id is reserved by convention rather than enforced: a peer sending its own
`tools/list` under id `0` is not told apart on that event.

Headerless
legacy `initialize` is accepted; a headerless post-initialize legacy request is
accepted only through a live session, whose pinned negotiated version the session
middleware supplies; every other headerless request is HTTP `400` + `-32020`.
`GET` / `DELETE` to the path fall through to whatever the router does with an
unmatched method (the resumable server→client GET-SSE channel + session-end
live in the session middleware below).

**Sessions are a separate, native, plug-and-play middleware — no dependency on
`@orkestrel/middleware`.** `createMCPSession` is a `MiddlewareHandler<TState>`
(`@orkestrel/server`); compose it with `router.use(createMCPSession())` in
front of a session-agnostic `createMCPRoutes(mcp)`. It owns a closure
`Map<string, { session, touched, version }>`, mints a session on an `initialize` POST
(`crypto.randomUUID()`), validates the `mcp-session-id` header on every other
legacy verb, and adds the resumable `GET` SSE stream — all native to this package.
A modern-shaped POST passes straight through without session lookup and ignores
any `mcp-session-id`; the layer otherwise pins the negotiated legacy revision and
supplies it on a headerless live-session request. The same default-on origin validation
applies to session verbs: a canonical loopback-literal origin passes, while every other
present origin requires an exact entry in the shared `origin.origins` list. A deployment
that validates upstream sets `origin.enabled` to `false` on the one options value passed to
the route and the session middleware. No shared session primitive is composed; the store, mint, and stream are
implemented here. Because the body can only be read once, the middleware
buffers `request.text()` and forwards a freshly built `Request` carrying that
text to `next(...)` so the downstream route can re-read it. Omit the
middleware for the byte-identical stateless default. The WebSocket and stdio
transports are inherently one session per connection, so they carry no
session header — `createMCPSession` is for the HTTP transport only.

**Resumable server→client push.** Each `MCPSession` folds in a bounded replay
log; `session.push(message)` appends the message to that log with a monotone
event id and fans it out to every open `GET {path}` SSE stream as one
`id:`-tagged event. An in-request handler addresses the active session through
`context.state.session` (the `createMCPSession` middleware sets it on every
validated request, per `MCPSessionState`). A client opens the `GET` (with
`Accept: text/event-stream` + its `mcp-session-id`) to receive pushes live; on
a dropped connection it reconnects sending the `Last-Event-ID` of the last
event it saw, and the server replays every logged event strictly after that
id (in order) before resuming live pushes. A `Last-Event-ID` the log no longer
retains (evicted past `capacity` / `ttl`, or never seen) replays nothing — the
spec-sane resume that never re-delivers un-lost events. The log is a plain
in-memory `Map` with capacity + lazy-TTL eviction.

#### Factories

| API                           | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMCPContinuation`       | function | Adapts the installed server token primitives to the host-neutral MCP continuation port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `createMCPRoutes`             | function | Creates the MCP Streamable-HTTP transport routes — mounts a transport-agnostic `MCPDispatcherInterface` (the `@orkestrel/mcp` dispatch boundary) on the fetch-standard router spine, pumping each `POST` body through `mcp.dispatch`. Returns the `RouteInput`s to hand to `router.add(...)`.                                                                                                                                                                                                                                                           |
| `createMCPPostHandler`        | function | Creates the Streamable-HTTP POST handler used by `createMCPRoutes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `createHTTPClientTransport`   | function | Creates the HTTP client transport for an `MCPClientInterface` — a `MCPMessageTransportInterface` that drives a remote Streamable-HTTP MCP server over `fetch`. The egress mirror of `createMCPRoutes`.                                                                                                                                                                                                                                                                                                                                                  |
| `createMCPSession`            | function | Creates the native MCP session `MiddlewareHandler` — the plug-and-play stateful layer that fronts a session-agnostic `createMCPRoutes`. Compose it with `router.use(createMCPSession())` (or the equivalent middleware seam), mirroring any other closure-scoped stateful middleware. Has no dependency on `@orkestrel/middleware` — the session store, mint-on-`initialize`, and resumable stream are all native to this package.                                                                                                                      |
| `createDuplexServerTransport` | function | Creates the server-side mirror of `createDuplexClientTransport`: the adapter that bridges a message-channel `MCPMessageTransportInterface` (the shape the stdio and WebSocket server transports already implement) onto the environment-agnostic `MCPTransportInterface` port — what `createStdioServer` and `createWebSocketServer` pipe through `bindServer`, so the request/reply/error pump those factories used to hand-roll identically now lives once in the core binder. `createDuplexClientTransport` adapts the same contracts the other way. |

#### Classes

| API              | Kind  | Summary                                                                                                                                                                                                         |
| ---------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTPDisconnect` | class | Composes one incoming HTTP request lifetime with one MCP-owned SSE response lifetime.                                                                                                                           |
| `MCPSession`     | class | Represents one MCP transport session — the per-session entity a `createMCPSession` middleware owns, keyed by its `id`, carrying the resumable server→client push channel with its bounded replay log folded in. |

_This face declares no `HTTPClientTransport`. It is host-independent and ships from
`@orkestrel/mcp`; see [Core § Classes](#classes)._

#### Constants

A `Shape` cell holds the constant's declared type.

| Constant                         | Kind  | Shape                 | Summary                                                                                                                                                                                                                                |
| -------------------------------- | ----- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SSE_BUFFERING_HEADER`           | const | `'x-accel-buffering'` | Names the reverse-proxy response header controlling buffering of an SSE response.                                                                                                                                                      |
| `SSE_BUFFERING_DISABLED`         | const | `'no'`                | Names the `X-Accel-Buffering` value that disables reverse-proxy buffering.                                                                                                                                                             |
| `DEFAULT_MCP_PATH`               | const | `'/mcp'`              | Names the default request path `createMCPRoutes` mounts the transport's `POST` route at.                                                                                                                                               |
| `DEFAULT_MCP_KEEPALIVE_INTERVAL` | const | `15000`               | Sets the default interval in milliseconds between SSE keepalive comments on held-open MCP responses.                                                                                                                                   |
| `SSE_KEEPALIVE_COMMENT`          | const | `'keepalive'`         | Names the comment text written by the held-open MCP response keepalive.                                                                                                                                                                |
| `DEFAULT_MCP_SESSION_CAPACITY`   | const | `1024`                | Sets the default capacity of a session's folded resumable event log (the per-`MCPSession` replay log) — the maximum number of pushed server→client messages retained for replay before the oldest is evicted.                          |
| `DEFAULT_MCP_SESSION_TTL`        | const | `300000`              | Sets the default per-event idle lifetime (ms) of a session's folded resumable event log — an entry older than this is lazily evicted on the next access (no background timer), bounding how far back a reconnecting client may replay. |

#### Helpers

| API                       | Kind     | Summary                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptsEventStream`      | function | Checks whether the request's `Accept` header opts into a Server-Sent-Events response.                                                                                                                                                                                                                             |
| `allowsOrigin`            | function | Checks whether an HTTP request satisfies the endpoint's origin gate.                                                                                                                                                                                                                                              |
| `inferHeaderIssue`        | function | Infers the first required MCP HTTP header a request's own body contradicts.                                                                                                                                                                                                                                       |
| `inferSessionHeaderIssue` | function | Infers the protocol header issue an active legacy session's pinned revision diagnoses.                                                                                                                                                                                                                            |
| `inferHeaderTarget`       | function | Infers the target one modern request's `Mcp-Name` header must carry.                                                                                                                                                                                                                                              |
| `inferParameterRefusal`   | function | Infers the refusal one `tools/call` earns for a `Mcp-Param-*` header the body contradicts.                                                                                                                                                                                                                        |
| `inferLegacyVersion`      | function | Infers the legacy revision an `initialize` request negotiates.                                                                                                                                                                                                                                                    |
| `inferStatus`             | function | Infers the HTTP status for one MCP dispatch outcome without changing its JSON-RPC body.                                                                                                                                                                                                                           |
| `readSessionHeader`       | function | Reads the request's `mcp-session-id` header — the session id a stateful transport validates, or `undefined` when absent.                                                                                                                                                                                          |
| `readLastEventId`         | function | Reads the request's `Last-Event-ID` header — the SSE resume cursor a client sends when it reconnects to the resumable `GET {path}` stream, or `undefined` when absent.                                                                                                                                            |
| `rejectUnknownSession`    | function | Builds the stateful transport's "unknown session" rejection — an HTTP `404` carrying a JSON-RPC error body.                                                                                                                                                                                                       |
| `sendEventStream`         | function | Pumps a controlled held-open exchange onto an open SSE stream — one `data:` event per notification in order, then the terminating response — and end the exchange however the pump leaves.                                                                                                                        |
| `upgradeRequestPath`      | function | Reads the path (without the query string) of a raw `node:http` protocol-upgrade request — the `createWebSocketServer` upgrade-path match.                                                                                                                                                                         |
| `extractLines`            | function | Folds one more chunk of raw stdio bytes into a newline-framed buffer — the shared line-framing step both stdio transports (client and server) read their inbound newline-delimited JSON-RPC messages through.                                                                                                     |
| `writeLine`               | function | Writes one line to a Node writable stream and waits for its completion callback.                                                                                                                                                                                                                                  |
| `dispatchLines`           | function | Decodes and delivers each complete newline-framed line onto a `MCPMessageTransportEventMap` emitter — the shared per-chunk dispatch step both stdio transports run their framed lines through: the server transport frames with `extractLines`, the client transport takes its lines from the process supervisor. |

_This face declares no `decodeEvent`, `readEventStream`, or `buildResponseError`. Those SSE
decoders and the response-error builder are host-independent and ship from `@orkestrel/mcp`; see
[Core § Helpers](#helpers)._

#### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an
optional member and `plus` introducing its call-signature members, and a type alias's own type
literal with a union's arms escaped as `\|`.

| Type                          | Kind      | Shape                                                                                                          | Summary                                                                                                                                                                                                                                                                                 |
| ----------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCPHeaderIssue`              | interface | `{ header: 'MCP-Protocol-Version' \| 'Mcp-Method' \| 'Mcp-Name', reason: 'missing' \| 'mismatched', message }` | Reports one required MCP HTTP header that is absent or disagrees with its server-derived value.                                                                                                                                                                                         |
| `MCPOriginOptions`            | interface | `{ enabled?, origins? }`                                                                                       | Configures the protocol-required HTTP `Origin` validation shared by the route and session enforcement sites.                                                                                                                                                                            |
| `MCPKeepaliveOptions`         | interface | `{ interval? }`                                                                                                | Configures the shared SSE keepalive for held-open HTTP responses.                                                                                                                                                                                                                       |
| `MCPCallerHandler`            | type      | `unknown> = (request: Request, context: RouteContext<string, TState> \| undefined,) => unknown`                | Extracts consumer-asserted caller context synchronously from an HTTP request after the transport has validated it for dispatch.                                                                                                                                                         |
| `HTTPHandlerOptions`          | interface | `{ streaming?, origin?, keepalive?, caller? }`                                                                 | Options shared by the MCP Streamable-HTTP POST handler and route factory.                                                                                                                                                                                                               |
| `HTTPTransportOptions`        | interface | `{ streaming?, origin?, keepalive?, caller?, path? }`                                                          | Options for `createMCPRoutes` — the mount path plus the shared POST-handler options. `createMCPRoutes` is stateless; sessions are a separate middleware (`createMCPSession`), composed with `server.use`.                                                                               |
| `MCPSessionOptions`           | interface | `{ capacity?, ttl? } plus clock?`                                                                              | Options for the `MCPSession` entity — its folded replay log's capacity and per-event lifetime.                                                                                                                                                                                          |
| `MCPSessionMiddlewareOptions` | interface | `{ path?, ttl?, session?, origin?, keepalive? } plus clock?`                                                   | Options for `createMCPSession` — the path the session middleware owns, the session idle time-to-live, and the per-session resumable event-log bound.                                                                                                                                    |
| `MCPSessionInterface`         | interface | `{ id } plus attach, detach, push, replay`                                                                     | Represents one MCP transport session — the per-session entity a `createMCPSession` middleware owns (the `MCPSession` entity), carrying the resumable server→client push channel with its bounded replay log folded in.                                                                  |
| `MCPSessionState`             | interface | `{ session? }`                                                                                                 | Declares the `context.state` slice a `createMCPSession` middleware sets on a validated / minted request — a consumer's `TState` extends this so the downstream route handler can read `context.state.session` to `push` a server-initiated message onto the session's resumable stream. |
| `MCPSessionEvent`             | interface | `{ id, message, timestamp }`                                                                                   | Represents one entry of an `MCPSessionInterface`'s folded replay log — a single pushed `JSONRPCMessage` tagged with the monotone event `id` the session assigned and the `timestamp` it was appended at (for the lazy-TTL replay window).                                               |
| `MCPSessionEntry`             | interface | `{ session, touched, version }`                                                                                | Represents the closure store entry a `createMCPSession` middleware keeps per minted session — the live `MCPSession` entity plus the epoch-ms instant it was last touched (the lazy-TTL sweep's idle clock, independent of the session's own replay-log TTL).                            |

_This face declares no `HTTPClientTransportOptions`. It is host-independent and ships from
`@orkestrel/mcp`; see [Core § Types](#types)._

### WebSocket transport

The **WebSocket transport** (`src/server`, through the `@src/server` barrel) is a
full-duplex alternative to the HTTP transport over a single persistent
connection. `createWebSocketServer` returns an `UpgradeHandler`
(`@orkestrel/server`) to register on the spine's `server.upgrade(...)`
seam; it composes the lean `@orkestrel/websocket` RFC 6455 wrapper and pumps
each inbound JSON-RPC request through `mcp.dispatch`.
`createWebSocketClientTransport` is the egress mirror — a
`MCPMessageTransportInterface` an `MCPClient` drives over a `node:http(s)`
upgrade. Both `WebSocketServerTransport` and `WebSocketClientTransport` reuse
the same `MCPMessageTransportInterface` the HTTP client transport implements (a
generic bidirectional JSON-RPC channel — `emitter` / `start` / `send` /
`close`, `session` `undefined` for the stateless v1), so the WebSocket and
HTTP transports share one transport contract. Like the HTTP transport it is
**mechanism, not policy** — compose an auth guard in front by registering a
`server.upgrade(...)` handler before this one (it can decline + destroy an
unauthenticated upgrade).

**WebSocket is a custom transport, not a normative one.** The specification defines stdio and
Streamable HTTP, and permits an implementation to add a transport of its own; this is that. A
peer that speaks only the defined transports does not reach it.

**A closed channel rejects, and the pump survives the rejection.** A socket write is
unconfirmed, so `WebSocketServerTransport` answers a closed channel from its own state: a `send`
after `close()`, after the peer's close, or on a socket that is not `OPEN` rejects
`WebSocket transport is not connected` rather than dropping the frame and telling the pump it
landed. `bindServer` owns the consequence at both ends. It aborts every in-flight request the
moment this transport's `close` fires, so a peer whose disconnect reaches that event — a close
frame, a socket the host ends, or a socket fault — is answered by no write at all; and it
catches a rejection that does reach it, routing that fault to `mcp.emitter`'s `error` event
rather than letting it escape the async listener. That bound is the host's report, not the
peer's departure: a peer that vanishes without a close frame or a socket fault leaves
`readyState` at `OPEN`, so `send` frames the response, writes it to nobody, and resolves.
Detecting that departure needs an RFC 6455 ping/pong liveness deadline, which this transport
does not run.

**It follows the spine's lifecycle, which is why `emitter` is required.** Pass the
spine's own `server.emitter`: on its `stop` event the handler closes every socket it
still owns with the RFC 6455 close handshake, so each client reads a clean goodbye and
the spine's drain settles in milliseconds. Node detaches an upgraded socket from the
connection set the spine's own close walks, so the claimant is the only thing that can
end it — an ingress holding its sockets open costs `stop()` the whole `drain` budget
(10s by default) and the connection is then cut mid-protocol. A socket whose peer already
vanished is no longer held, and closing a dead one is a no-op, so a departed client
neither throws nor delays the stop.

```ts
import { createMCPClient, createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
import { createWebSocketClientTransport, createWebSocketServer } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
// Claims an MCP WebSocket upgrade to /mcp, and closes those sockets when the spine stops.
server.upgrade(createWebSocketServer(createMCPLegacy(mcp), { emitter: server.emitter })) // answers `initialize` too; pass `mcp` alone for modern-only

// An MCP client connects over the SAME MCPClient, a WebSocket transport instead of HTTP:
const client = createMCPClient({
	transport: createWebSocketClientTransport({ url: `ws://127.0.0.1:${port}/mcp` }),
})
await client.connect() // the RFC 6455 handshake, then modern `server/discover` over frames
```

#### Factories

| API                              | Kind     | Summary                                                                                                                                                                                                                                                        |
| -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWebSocketServer`          | function | Creates the MCP WebSocket transport ingress — an `UpgradeHandler` that exposes a transport-agnostic `MCPDispatcherInterface` over a WebSocket, the WebSocket mirror of `createMCPRoutes`. Register it on the spine's upgrade seam.                             |
| `createWebSocketClientTransport` | function | Creates the WebSocket client transport for an `MCPClientInterface` — a `MCPMessageTransportInterface` that drives a remote MCP server over a WebSocket. The egress mirror of `createWebSocketServer` and the WebSocket sibling of `createHTTPClientTransport`. |

#### Classes

| API                        | Kind  | Summary                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketServerTransport` | class | Wraps a `NodeWebSocketInterface` (the RFC 6455 wire wrapper) as a `MCPMessageTransportInterface` — the per-connection JSON-RPC-over-WebSocket server bridge, the bidirectional JSON-RPC message channel `createWebSocketServer` pumps `mcp.dispatch` over and the egress mirror's `WebSocketClientTransport` reuses. |
| `WebSocketClientTransport` | class | Drives a remote MCP server over a WebSocket — a client `MCPMessageTransportInterface` for the Model Context Protocol, the egress mirror of `createWebSocketServer` and the WebSocket sibling of `HTTPClientTransport`.                                                                                               |

#### Constants

_This face declares none. `MCP_WEBSOCKET_SUBPROTOCOL` — the token this transport echoes in its
`101` handshake — is one wire value both faces negotiate and ships from `@orkestrel/mcp`; see
[Core § Constants](#constants). The upgrade path defaults to `DEFAULT_MCP_PATH`._

#### Helpers

_`upgradeRequestPath` (used by `createWebSocketServer`) is documented under [HTTP transport § Helpers](#helpers-1), and `createDuplexServerTransport` (which `createWebSocketServer` pipes its transport through `bindServer` with) under that section's Factories._

#### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an
optional member and `plus` introducing its call-signature members, and a type alias's own type
literal with a union's arms escaped as `\|`.

| Type                              | Kind      | Shape                              | Summary                                                                                                                                                     |
| --------------------------------- | --------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketServerOptions`          | interface | `{ emitter, path?, subprotocol? }` | Options for `createWebSocketServer` — the spine lifecycle the ingress follows, plus where the WebSocket upgrade is accepted and the subprotocol negotiated. |
| `WebSocketClientTransportOptions` | interface | `{ url, protocols? }`              | Options for `createWebSocketClientTransport` — the remote MCP WebSocket endpoint and any extra handshake headers.                                           |

### stdio transport

The **stdio transport** (`src/server`, through the `@src/server` barrel) is a
server transport — newline-delimited JSON-RPC over a process's own
`stdin`/`stdout` (the server side) or a spawned child process's piped stdio
(the client side). `createStdioServer` wraps `options.input` / `options.output`
(defaulting to `process.stdin` / `process.stdout`, injectable for tests) as a
`MCPMessageTransportInterface`, bridges it to the core `MCPTransportInterface` port
through `createDuplexServerTransport`, and pipes it through `bindServer` — each inbound
JSON-RPC request runs through `mcp.dispatch`, writing a defined response back
as one newline-terminated line (a notification writes nothing). The server transport awaits
the output stream's completion callback as its backpressure boundary. A callback error or
synchronous write throw rejects `send`, and an out-of-band output `error` reaches the transport's
domain `error` event. That callback is the only confirmation a write has, so an output that
neither confirms nor fails parks it. The transport bounds that for its caller: each `send` races
the write against a per-send entry the transport rejects on close, so closing settles the caller
while the abandoned write stays with the caller-owned stream that still holds its callback.
The handle's `stop()` unbinds that pump and closes the transport: the
listeners `start()` put on `input` and `output` are removed, every pending `send` rejects, and
`input` is paused only when
this transport started a non-flowing stream and no other `data` listener
remains. A stopped server therefore lets the process exit rather than holding
`process.stdin` open, and the injected streams are never destroyed or ended —
they belong to the caller. A `send` after closure rejects `stdio transport is not connected`.

The server preserves the caller's flowing or non-flowing state and every caller-owned listener.
An unread stream starts with `readableFlowing === null`; Node exposes no public operation that
restores that untouched state after `data` consumption, so closing this transport leaves that
case non-flowing with `readableFlowing === false`. Attaching a later `data` listener does not
resume that stream; the caller must call `resume()` before the listener receives data.

`createStdioClientTransport` is the egress mirror — it builds one supervised
`@orkestrel/process` `Process` over `options.command` / `options.args` /
`options.env`, and that supervisor spawns the child with
`stdio: ['pipe', 'pipe', 'pipe']`: `stdin`/`stdout` carry the JSON-RPC channel
and `stderr` is piped and retained as a bounded tail on the supervisor, not
inherited by the parent. The returned `StdioClientTransportInterface` reports
that tail as `evidence`, so a child that dies before it answers anything still
leaves the reason it died. Read `evidence` off the
`createStdioClientTransport` result rather than off `client.transport`, which
is typed as the wide `MCPMessageTransportInterface` and carries no such member.
The tail follows the child that wrote it, so read it before you open a
replacement: the next `start()` installs a replacement child, and the reading
becomes that child's. How far the ended child's tail reaches inside one `close`
emit depends on how the lifetime ended. An explicit `close()` still holds its
teardown barrier while the `close` listeners run, so a listener that calls
`start()` parks behind that barrier and every later listener still reads the
ended child's frozen tail. A natural exit holds its barrier only across the
`error` it reports at that end, and releases it before the emit: a restart
begun from that fault channel parks until the `close` has been delivered,
while a `close` listener's `start()` opens the next lifetime inside the emit
and replaces the value every listener after it would have read. Lifetimes
never overlap — a `start()` issued while a `close()` is still tearing down
waits for that teardown to report `close` first — so an older child's tail
cannot arrive over a replacement's however the calls interleave.
`options.env` merges over `process.env` rather than
replacing it: each named key overrides the inherited value, every unlisted key
is still inherited, and the child therefore receives every secret this process
holds. The server side frames its own input with `extractLines` (fold a
raw chunk into complete lines + a carried remainder); the client side takes its
frames from the supervisor's `readline`-backed `lines` iterable instead. Both
decode through `dispatchLines` (decode + emit each complete line as `message` or
`error`) — documented under [HTTP transport § Helpers](#helpers-1) because it
lives in the shared `helpers.ts`.

`send` writes one newline-terminated line per message and settles on the
supervisor's answer, so a write that failed reaches the caller instead of reading
as a delivered message. The failures are told apart by voice. A call made with no
live child rejects `stdio transport is not connected` — a `send` before the first
`start()` is that case. `send` rejects
`stdio transport could not deliver the message` when a live child's write
settles unconfirmed. The supervisor reports that it refused the line and not why,
so neither message names a cause it cannot read. Separately, an `MCPClient`
request settles when its transport's `send` rejects.

`options.delivery` bounds one unconfirmed write to the child's `stdin`, in
milliseconds. A live child that never reads its `stdin` fills the pipe, the
kernel confirms nothing further, and the write waits — that wait is what this
bound ends. The rejection arrives no earlier than the bound, the child is still
running when it arrives, and the transport fires neither `error` nor `close` for
it: an undeliverable message is that write's own outcome rather than the end of
the lifetime. An omitted `delivery` selects `DEFAULT_MCP_DELIVERY`. An explicit
`0` removes the bound, and the write then stays pending on the channel: `close()`
tears that channel down and settles it as the same undeliverable rejection.

`delivery` and the client's request `timeout` answer different questions, and
neither covers the other. `delivery` answers "the child is not reading my
bytes" — a write the kernel cannot confirm. `timeout` answers "the child never
replied" — a request that was written and drew no response. A message that never
landed draws no reply either. `DEFAULT_MCP_DELIVERY` sits below
`DEFAULT_MCP_REQUEST_TIMEOUT`; that ordering distinguishes a default-bound
undeliverable write from the later deadline for a peer that did not answer.

Closing the client runs the supervisor's bounded process teardown, which reaches the child's
terminal moment: the supervisor freezes `evidence`, ends `lines`, and settles the child's exit
together there. That ladder is signal-first — the supervisor terminates the child, then destroys
its `stdin` — rather than the stdin-close-and-wait the specification asks a stdio client for.
The posture and its cost are stated under
[Declared conformance gaps](#declared-conformance-gaps). The transport's line pump therefore needs no release of its own — the stream ends
under it. The wait for the child's streams is bounded by the supervisor's `drain` window, so a
descendant that inherited the child's stdout pipe cannot keep the transport's `close` call pending
past it. Inbound delivery ends at the call rather than at the stream's end: a line the supervisor
had already framed behind the one being delivered is dropped rather than emitted onto a transport
whose teardown has begun. A `close()` issued while that teardown is running joins it rather than
opening a second one, so it resolves only after the `close` event has fired.

The tail frozen at that moment is what the supervisor had received by then, not the child's
complete output. On Windows the supervisor ends the tree with `taskkill /F /T`, which nothing in
the child can intercept: a `SIGTERM` handler never runs there, so the bytes it would have written
never exist. A child that ends on its own closes its `stderr` first, and that tail is complete.
When the terminal moment arrived at the `drain` bound instead — a detached descendant holding the
inherited `stderr` open is what does that — the tail stops at the cutoff and later diagnostics may
have existed. The transport reports that lifetime on its `error` event, so a partial tail is
readable as partial rather than as the child's whole output.

```ts
import {
	createMCPClient,
	createMCPLegacy,
	createMCPLegacyClientTransport,
	createMCPServer,
} from '@orkestrel/mcp'
import { createStdioClientTransport, createStdioServer } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
// An MCP client now connects over this process's stdio:
createStdioServer(createMCPLegacy(mcp)).start() // answers `initialize` too; pass `mcp` alone for modern-only

// A client spawns a stdio MCP server as a child process and drives it the same way:
const carrier = createStdioClientTransport({ command: 'node', args: ['./server.js'] })
const client = createMCPClient({ transport: createMCPLegacyClientTransport(carrier) })
await client.connect()
client.version // '2026-07-28' — the consumer-visible client stays modern
const tools = await client.tools()
```

#### Factories

| API                          | Kind     | Summary                                                                                                                                                                                                                                                                                          |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createStdioClientTransport` | function | Creates the stdio client transport for an `MCPClientInterface` — a `StdioClientTransportInterface` that spawns and drives a child process MCP server over newline-delimited JSON-RPC on `stdin`/`stdout`, the stdio sibling of `createHTTPClientTransport` and `createWebSocketClientTransport`. |
| `createStdioServer`          | function | Creates the MCP stdio transport ingress — pumps a transport-agnostic `MCPDispatcherInterface` over newline-delimited JSON-RPC on `stdin`/`stdout` (or an injected stream pair), the stdio mirror of `createWebSocketServer`.                                                                     |

#### Classes

| API                    | Kind  | Summary                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `StdioClientTransport` | class | Drives a child process MCP server over newline-delimited JSON-RPC on `stdin`/`stdout` — a `StdioClientTransportInterface`, the stdio sibling of `HTTPClientTransport` and `WebSocketClientTransport`.                                                                                                  |
| `StdioServerTransport` | class | Wraps an injectable readable/writable stream pair (`process.stdin`/`process.stdout` in production, a test double in tests) as a `MCPMessageTransportInterface` — the newline-delimited JSON-RPC channel `createStdioServer` pumps `mcp.dispatch` over, the stdio mirror of `WebSocketServerTransport`. |

#### Constants

A `Shape` cell holds the constant's declared type.

| Constant               | Kind  | Shape   | Summary                                                                                                                                                                                    |
| ---------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEFAULT_MCP_DELIVERY` | const | `10000` | Sets the default bound in milliseconds on one unconfirmed write to a stdio client transport's child `stdin` — the `delivery` a `createStdioClientTransport` caller who supplies none gets. |

#### Helpers

_See `extractLines` / `dispatchLines` under [HTTP transport § Helpers](#helpers-1)._

#### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an
optional member and `plus` introducing its call-signature members, and a type alias's own type
literal with a union's arms escaped as `\|`.

| Type                            | Kind      | Shape                                                            | Summary                                                                                                                                                                                                                                       |
| ------------------------------- | --------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StdioClientTransportInterface` | interface | `{ emitter, session, duplex, evidence } plus start, send, close` | Declares the contract `createStdioClientTransport` returns — a `MCPMessageTransportInterface` that also reports the supervised child's stderr tail, the diagnostic a child that dies at startup leaves behind.                                |
| `StdioClientTransportOptions`   | interface | `{ command, args?, env?, delivery? }`                            | Options for `createStdioClientTransport` — the child process to spawn as a stdio-framed MCP server (newline-delimited JSON-RPC over `stdin`/`stdout`).                                                                                        |
| `StdioServerInterface`          | interface | `{} plus start, stop`                                            | Arms and tears down the newline-delimited JSON-RPC pump over the `StdioServerOptions` stream pair — the stdio ingress handle `createStdioServer` returns.                                                                                     |
| `StdioServerOptions`            | interface | `{ input?, output? }`                                            | Options for `createStdioServer` — the injectable stdin/stdout streams the server transport reads newline-delimited JSON-RPC requests from and writes responses to.                                                                            |
| `LineExtraction`                | interface | `{ lines, remainder }`                                           | Represents the result of folding one more chunk of raw stdio bytes into a newline-framed buffer — every complete line extracted (newline-terminated in the wire bytes) plus the trailing partial line carried forward as the new `remainder`. |

### Browser transport

The **browser transport** (`src/browser`, through the `@src/browser` barrel /
`@orkestrel/mcp/browser`) is the page / Web Worker / Service Worker face.
CLIENT-only transports drive a remote MCP server from the browser,
over the same `MCPMessageTransportInterface` the Node face's transports
implement, so `createMCPClient` consumes either identically.
`createWebSocketClientTransport` drives the native `WebSocket` global (the
host performs the RFC 6455 handshake, so this face carries none of the
Node client's `node:crypto` / `node:http(s)` machinery).
`createHTTPClientTransport` returns the core `HTTPClientTransport` — one class, published
from `@orkestrel/mcp` and returned by this factory and by the Node face's, because it touches
`fetch`, `Response`, `AbortController`, `AbortSignal`, and `WeakMap` alone. Every header rule,
every SEP-2243 `x-mcp-header` decision, and the non-success rejection are therefore literally
the same code on both faces rather than two copies that agree. It honors the
same `mcp-session-id` semantics, so a browser client interoperates with an
`MCPSession`-based server unchanged. The WebSocket transports share their exported names
across the faces — same API shape, a different host underneath
— deliberately, so a consumer swaps `@orkestrel/mcp/server` for
`@orkestrel/mcp/browser` with no call-site change.

A browser deployment served from a non-loopback origin must list the page origin in the shared
`origin.origins` value passed to the server's enforcement sites, or delegate validation with
`origin.enabled: false`; a page served from a canonical loopback literal needs neither. See
[Mount the HTTP transport with sessions](#mount-the-http-transport-with-sessions).

**One protocol-version derivation, because there is one transport.** The HTTP client transport
stamps `mcp-protocol-version` through the single exported `inferRequestVersion`, which reads
the reserved `_meta` version off the message being sent. That is deliberately the same read the
server's own expectation performs, so a request the server demands a header for is a request
this client sends one for. It is not `parseRequestContext`: that parser
answers a different question — whether the modern metadata is well formed — and a request it
refuses is still modern (era is fixed by key presence) and still owes the header.

**The WebSocket client option shapes differ on purpose.** The browser face takes
`{ url, protocols }` and the Node face takes `{ url, headers }`, because the host performs the
WebSocket handshake: the native constructor accepts a URL and subprotocols and nothing else,
so a page has no seam through which to set an upgrade request header. Reach a guarded server
from a page with a credential the platform does carry — a cookie the browser attaches to the
upgrade, a subprotocol token, or a signed value in the URL. The Node face owns its own
`node:http(s)` upgrade request and therefore can offer `headers`. The divergence runs the other
way too, and on purpose: the Node face offers **no `protocols` key at all** — it writes
`Sec-WebSocket-Protocol: mcp` itself, and because `options.headers` spreads last over the
handshake headers, a caller needing a different subprotocol sets that header directly rather
than being given a second way to say the same thing.

**The browser face queues a pre-open `send` and rejects a closed one.** Those are different
states and it answers them differently. A `send` issued before `'open'` fires — before
`start()` is even called — is queued and flushed in order the moment the socket opens, so a
caller need not await `start()`. A `send` after `close()`, or on a socket already reporting
`CLOSING` or `CLOSED`, rejects `WebSocket transport is not connected`: a native socket write is
unconfirmed, so this transport answers a closed channel from its own state rather than
resolving on a frame nobody wrote and leaving the client's correlated request pending to its
deadline. The Node face rejects that same condition with the same words, reading the wrapper's
`readyState` beside its own state the way this face reads the native socket's; it also rejects
the pre-open send this face queues, because it holds no connection to flush one onto. WebSocket
is the custom transport this package adds; the specification defines stdio and Streamable HTTP.

**A queue rides one connection.** `close()` discards whatever is still queued, and so does the
native `close` event, so a frame the caller handed a connection that then ended is dropped
rather than written onto the socket a later `start()` opens. A caller that closes a transport
with a pre-open `send` outstanding therefore delivers nothing at all: the `send` already
resolved, because queuing is what it resolved on, and the message it queued goes with the
connection it was queued for. Re-send anything that must survive a reconnect.

**`duplex` is a claim about the carrier, and it is proven by driving it.** The WebSocket,
`MessagePort`, and scope carriers declare `true` and really do deliver a client-initiated
`notifications/cancelled` to the peer; Streamable HTTP declares `false` and writes no such
frame, because the dated revision defines none over it. The declaration is per-carrier and
therefore cannot express a carrier that stops being duplex: close the far half of a
`MessageChannel` and the transport still declares `true` while carrying nothing. That is a
property of the model, not a defect in a transport — `duplex` says what the carrier is, and a
peer that has gone away is what the request's own settlement handles.

`createMessagePortTransport` is the genuinely new capability: MCP over
`postMessage`. A `MessagePort` is symmetric, so `MessagePortTransport` is the
one class both a server and a client bind — it implements `@src/core`'s
`MCPTransportInterface` directly (not `MCPMessageTransportInterface`), and
whichever binder it is handed to (`bindServer` or `bindClient`) decides its
role. `createScopeServer` is the worker bootstrap: boot an `MCPServer` inside a
Web-Worker-or-Service-Worker scope and wire its message events to it. Its `scope`
parameter defaults to `globalThis`, so a worker boots with
`createScopeServer({ tools })` alone and a test drives the same wiring by passing a scope
double instead of a real worker.

This face is DOM-free by construction (type-checked against `lib: ["ESNext",
"WebWorker"]`, no `"dom"`), so it runs identically in a page, a Web Worker,
and a Service Worker.

```ts
import { createMCPClient } from '@orkestrel/mcp'
import { createHTTPClientTransport, createWebSocketClientTransport } from '@orkestrel/mcp/browser'

const ws = createMCPClient({
	// No `protocols` needed — defaults to MCP_WEBSOCKET_SUBPROTOCOL ('mcp'), which
	// createWebSocketServer selects from the offered list. Override only for foreign servers.
	transport: createWebSocketClientTransport({ url: 'ws://localhost:3000/mcp' }),
})
await ws.connect() // the browser handshakes, then modern `server/discover` runs over WS frames

const http = createMCPClient({
	transport: createHTTPClientTransport({ url: 'http://localhost:3000/mcp' }),
})
await http.connect()
const tools = await http.tools()
```

#### Factories

| API                              | Kind     | Summary                                                                                                                                                                                                                                                       |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWebSocketClientTransport` | function | Create a `MCPMessageTransportInterface` over the native `WebSocket` global that drives a remote MCP server (browser face).                                                                                                                                    |
| `createHTTPClientTransport`      | function | Return the core `HTTPClientTransport` over the native `fetch` that drives a remote Streamable-HTTP MCP server — the same class the Node face's factory returns.                                                                                               |
| `createMessagePortTransport`     | function | Creates the browser-face `MessagePort` transport — a `MCPTransportInterface` over a native `MessagePort`, the symmetric carrier that works as either a server or a client transport depending on which binder (`bindServer` or `bindClient`) it is handed to. |
| `createScopeServer`              | function | Creates an `MCPServer` hosted inside a worker scope and wires that scope's message events to it — the browser face's bootstrap, and the twin of the Node face's `createStdioServer`.                                                                          |
| `createScopeTransport`           | function | Adapts a hostable `ScopeInterface` (`self` in a dedicated Web Worker, or any structurally matching double) into a `ScopeTransportInterface` — the implicit, portless message channel `createScopeServer` binds for the dedicated-worker shape.                |
| `createScopeMessageListener`     | function | Builds `createScopeServer`'s `message`-event listener — the unified dispatcher that routes every inbound event on a hostable scope, portless or port-bearing, to the right binding.                                                                           |

#### Classes

| API                        | Kind  | Summary                                                                                                                                                                                |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketClientTransport` | class | The browser-face `MCPMessageTransportInterface` over the native `WebSocket` — queues sends until `open`, flushed in order and discarded at close; a closed-channel send rejects.       |
| `MessagePortTransport`     | class | Carries the Model Context Protocol over a native `MessagePort` from the browser face — a `MCPTransportInterface`, the genuinely new capability this face adds: MCP over `postMessage`. |

#### Constants

A `Shape` cell holds the constant's declared type.

| Constant                     | Kind  | Shape              | Summary                                                                                                                                  |
| ---------------------------- | ----- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_MCP_SERVER_NAME`    | const | `'@orkestrel/mcp'` | Supplies the default server name `createScopeServer` reports (`initialize`'s `serverInfo.name`) when `options.name` is omitted.          |
| `DEFAULT_MCP_SERVER_VERSION` | const | `'1.0.0'`          | Supplies the default server version `createScopeServer` reports (`initialize`'s `serverInfo.version`) when `options.version` is omitted. |

#### Helpers

_This face declares none. The SSE decoders `decodeEvent` and `readEventStream` are
host-independent and ship from `@orkestrel/mcp`; see [Core § Helpers](#helpers)._

#### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an
optional member and `plus` introducing its call-signature members, and a type alias's own type
literal with a union's arms escaped as `\|`.

| Type                              | Kind      | Shape                                                        | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | --------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketClientTransportOptions` | interface | `{ url, protocols? }`                                        | the remote WS endpoint + optional subprotocol(s) (default `MCP_WEBSOCKET_SUBPROTOCOL`; pass `[]` for no subprotocol).                                                                                                                                                                                                                                                                                                                                                                   |
| `MessagePortTransportOptions`     | interface | `{ port }`                                                   | Options for `createMessagePortTransport` — the native `MessagePort` a `MessagePortTransport` sends and listens on.                                                                                                                                                                                                                                                                                                                                                                      |
| `ScopeInterface`                  | interface | `{} plus postMessage, addEventListener, removeEventListener` | Describes the structural shape `createScopeServer` needs from a hostable scope — `self` in a dedicated Web Worker or a Service Worker (or any double matching this shape).                                                                                                                                                                                                                                                                                                              |
| `ScopeTransportInterface`         | interface | `{} plus send, listen, closed, close, deliver`               | Adapts a message-event-bearing scope (`self` in a dedicated Web Worker, or any object shaped the same way) as a duplex `MCPTransportInterface` — the internal carrier `createScopeServer` binds to route the implicit (portless) message channel, plus the `deliver` entry point the scope's own `message` listener pushes an inbound string through (the scope itself never registers `listen`'s handler for the caller — the scope server's dispatcher does, through this `deliver`). |
| `ScopeServerInterface`            | interface | `{} plus stop`                                               | Represents one MCP server hosted inside a worker scope — what `createScopeServer` returns.                                                                                                                                                                                                                                                                                                                                                                                              |
| `ScopeServerOptions`              | interface | `{ tools, name?, version? } plus accept?`                    | Options for `createScopeServer` — the live `ToolManagerInterface` to expose plus the optional server identity, mirroring `createMCPServer`'s `MCPServerOptions` (`@orkestrel/mcp`) but with `name`/`version` optional (defaulting to `DEFAULT_MCP_SERVER_NAME` / `DEFAULT_MCP_SERVER_VERSION`).                                                                                                                                                                                         |

_This face declares no `HTTPClientTransportOptions`. It is host-independent and ships from
`@orkestrel/mcp`; see [Core § Types](#types)._

## Methods

The public methods of the layer's behavioral interfaces — every call-signature
member listed (their `readonly` data members stay Surface rows). Each
implementing class exposes exactly its interface's methods: `MCPServer` ↔
`MCPServerInterface`, the removable decorator `MCPLegacy` ↔ the base
`MCPDispatcherInterface` (it adds no member of its own — a decorator that widened
its subject's surface would not be substitutable for it),
`MCPMethodManager` ↔ `MCPMethodManagerInterface`,
`MCPClient` ↔ `MCPClientInterface`, the transports
`HTTPClientTransport` (`src/core`, host-independent and returned by both faces'
`createHTTPClientTransport`), `WebSocketServerTransport` / `WebSocketClientTransport`
/ `StdioClientTransport` / `StdioServerTransport` (`src/server`), and the browser face's
own `WebSocketClientTransport` (`src/browser`, the same exported name over a different
host) ↔ `MCPMessageTransportInterface` (they all share the one generic bidirectional
JSON-RPC carrier — only the wire framing / host differs, so they add no new
behavioral interface), and the session entity `MCPSession` ↔
`MCPSessionInterface` (the folded replay log is private to it), and the stream
entities `MCPStreamController` ↔ `MCPStreamControllerInterface` /
`MCPTextStreamController` ↔ `MCPTextStreamControllerInterface` (each is its own async
iterator, so `[Symbol.asyncIterator]` and `[Symbol.asyncDispose]` are protocol members
rather than named behavior). The `HTTPDisconnect` lifecycle entity exposes only
`bridge`; its `signal` is a readonly data member.

#### `MCPDispatcherInterface`

The minimal dispatch surface, and the reason legacy support is a value rather than
a branch. A transport needs no more than the resolved message bound, the `dispatch` and
`handle` doors, and one `emitter` to report a contained fault through — not the server's identity
and not its method registry — so every door takes this:
`createMCPRoutes`, `createMCPPostHandler`, `createWebSocketServer`, `createStdioServer`,
and `bindServer`. `MCPServerInterface` extends it and `MCPLegacy` implements it, which is
what lets the decorator sit between any face and the server without either one knowing
the other's shape changed. `createStdioServer(createMCPLegacy(mcp))` composes exactly as
`createMCPRoutes(createMCPLegacy(mcp))` does.

| Method     | Returns                                                                 | Summary                               |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------- |
| `dispatch` | `Promise<JSONRPCResponse \| MCPStreamControllerInterface \| undefined>` | Dispatches a parsed JSON-RPC request. |
| `handle`   | `Promise<string \| MCPTextStreamControllerInterface \| undefined>`      | Handles a raw JSON-RPC string.        |

#### `MCPServerInterface`

`dispatch` is the typed JSON-RPC core; `handle` is the string boundary that
wraps it with parse / serialize and the parse / invalid-request error mapping.
Both take an optional `MCPDispatchOptions` bag carrying `signal` and asserted
`caller`, so every existing caller compiles unchanged.

`dispatch` carries an overload per argument arm rather than one union, so the answer's type
follows the argument's arm: a `JSONRPCRequest` resolves a response or a held-open
controlled stream and never `undefined`; a `JSONRPCNotification` resolves `undefined`
and never a response; and the union arm — for a transport that narrowed no
further than `JSONRPCInvocation` — admits each of them. The Returns column below
states that widest arm.

| Method     | Returns                                                                 | Summary                                                                             |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `dispatch` | `Promise<JSONRPCResponse \| MCPStreamControllerInterface \| undefined>` | Dispatches an already-parsed request — runs its method and resolves its answer.     |
| `handle`   | `Promise<string \| MCPTextStreamControllerInterface \| undefined>`      | Handles a raw message string — parses it, dispatches it, and serializes the answer. |

Both doors demand modern request metadata, and a bare `MCPServer` has no other era to fall
back on. A version-less `{ jsonrpc, method, id }` naming a registered method is refused
`-32602` with `Invalid params: request declares no protocol version`; one naming a method the
modern seam does not register — legacy `initialize` or `ping` — is refused `-32601`; a stamped
legacy revision is refused with `-32022` and `{ supported: ['2026-07-28'], requested }`; and
one carrying `MCP_META_VERSION` alone is refused `-32602`
with `Invalid params: malformed modern request metadata` — `MCP_META_CAPABILITIES` is required
beside it. The alternative to
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
	`{"jsonrpc":"2.0","method":"server/discover","id":2,"params":{"_meta":{"${MCP_META_VERSION}":"${MCP_MODERN_VERSION}","${MCP_META_CAPABILITIES}":{}}}}`,
	{ signal: controller.signal, caller: authenticatedPrincipal },
)
// reply → {"jsonrpc":"2.0","id":2,"result":{"supportedVersions":["2026-07-28"],
//   "capabilities":{"tools":{}},"resultType":"complete","ttlMs":60000,"cacheScope":"private",
//   "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"docs","version":"1.0.0"}}}}
```

#### `MCPProgressInterface`

| Method   | Returns         | Summary                                                                            |
| -------- | --------------- | ---------------------------------------------------------------------------------- |
| `report` | `Promise<void>` | Reports one finite, strictly increasing progress value and awaits its consumption. |

#### `MCPProgressOwnerInterface`

The owning half of one progress slot: `MCPProgressInterface`'s `report`, plus the `take` and
`stop` its owner needs. A second interface over one entity because the executor and the owner
hold it and are owed different powers — an executor receives the narrow producer port through
`MCPExecutionContext.progress` and can publish and nothing else, while the MCP-owned response
stream that created the slot also drains and shuts it down. The table lists `report` because the
owner holds it too: this interface extends `MCPProgressInterface` rather than replacing it.

| Method   | Returns                        | Summary                                                                                |
| -------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| `report` | `Promise<void>`                | Reports one finite, strictly increasing progress value and awaits its consumption.     |
| `take`   | `Promise<JSONRPCNotification>` | Takes the next progress notification, waiting for the single producer slot when empty. |
| `stop`   | `void`                         | Stops the reporter permanently, rejects pending work, and detaches its abort listener. |

#### `MCPProgressReporter`

The class implements `MCPProgressOwnerInterface`, so its public members are exactly that
interface's: `report` for the executor holding the narrow port, plus `take` and `stop` for the
owner. It holds one slot, provides no replay or durable queue, and rejects concurrent consumers
rather than coordinating them.

| Method   | Returns                        | Summary                                                                                                                                                                         |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report` | `Promise<void>`                | Publishes one bounded, strictly increasing progress value and awaits its consumption.                                                                                           |
| `take`   | `Promise<JSONRPCNotification>` | Takes the next progress notification, waiting for the single producer slot when empty.                                                                                          |
| `stop`   | `void`                         | Stops the reporter permanently, rejects pending work, and detaches its abort listener. Repeated calls are idempotent. No queued or replayable progress survives the first call. |

#### `MCPStreamControllerInterface`

The held-open answer's lifecycle, owned by one arbitrator. Beyond the async-generator
protocol it adds exactly one member, because the protocol has no way to say "there will be
no answer" — `return(value)` is the consumer declaring it already has one, and only a
consumer can call it. `MCPStreamController` is the concrete engine; `MCPTextStreamController`
is the serialized mirror that delegates every one of these decisions downward.

The protocol members are restated on the contract rather than inherited silently, because
what they guarantee here is narrower than the protocol requires: every closure aborts the
request's lifetime before delegating cleanup, and none of them waits for the producer to
agree.

| Method   | Returns                                                         | Summary                                                                          |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `next`   | `Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>>` | Reads the next notification, or the terminating response that ends the exchange. |
| `return` | `Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>>` | Ends the exchange because the consumer already has its answer.                   |
| `throw`  | `Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>>` | Ends the exchange with a failure the consumer is raising.                        |
| `stop`   | `void`                                                          | Ends the exchange permanently, with no terminal response.                        |

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
`return` is handed a string, so it has no typed terminal to close on and never parses one
back out of its argument; it ends the typed exchange with `stop()` and answers its own
consumer with the supplied text. A cooperating producer therefore runs its cancellation path
through this face where the typed `return` would have run its normal return. Making the text
face reconstruct a response would move the decision about what the exchange ended with into
the adapter, which is the one thing it exists not to do.

| Method   | Returns                                   | Summary                                                                             |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `next`   | `Promise<IteratorResult<string, string>>` | Reads the next serialized message, or the serialized terminating response.          |
| `return` | `Promise<IteratorResult<string, string>>` | Ends the exchange because the consumer already has its answer.                      |
| `throw`  | `Promise<IteratorResult<string, string>>` | Ends the exchange with a failure the consumer is raising.                           |
| `stop`   | `void`                                    | Ends the exchange permanently, with no terminal response, through the typed stream. |

#### `MCPMethodManagerInterface`

The modern method seam `server.methods` exposes — `add` registers (or
replaces) one method, `method` resolves one. The server registers
`server/discover`, `tools/list`, `tools/call`, and `subscriptions/listen` here at construction,
plus `tasks/get`, `tasks/update`, and `tasks/cancel` when `task` is configured, and
resolves every modern method from here, so there is no second dispatch path
and no precedence puzzle. An extension that is not opted into registers nothing, which is
why its methods answer `-32601` rather than a bespoke refusal.

| Method   | Returns                         | Summary                                                                      |
| -------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `add`    | `void`                          | Registers one modern method — replacing any handler already under that name. |
| `method` | `MCPMethodHandler \| undefined` | Finds the handler registered for one method name.                            |

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

The stable Tasks extension's consumer half — the durable store this package creates tasks
through and reads them back from. It is a port, not a class this package ships: the extension
puts the whole lifecycle on the consumer's side, and a store, a worker, and a terminal status
are what a manager is. There is deliberately **no plural accessor**; the extension defines no
`tasks/list`, and a port that could enumerate tasks would invite one.

Every method receives the resolved per-request `MCPMethodOptions` and is expected to
**authorize the call itself** — the extension requires authorization on each task request, and
this package has no principal of its own to check one against. See
[Defer a call to a durable task](#defer-a-call-to-a-durable-task) for the obligations this
contract states and cannot enforce.

| Method   | Returns                               | Summary                                                                        |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `start`  | `Promise<MCPTask>`                    | Creates — or returns the existing — durable task for one stable operation key. |
| `task`   | `Promise<MCPTaskDetail \| undefined>` | Reads one task's current snapshot.                                             |
| `update` | `Promise<void>`                       | Answers the input requests an `input_required` task is waiting on.             |
| `abort`  | `Promise<void>`                       | Asks one task to stop.                                                         |

#### `MCPResourceManagerInterface`

The consumer-supplied resource registry, and a port rather than a class this package
ships — the same division `MCPTaskManagerInterface` makes. Supplying it is what
registers `resources/list`, `resources/read`, and `resources/templates/list` and what
puts `resources` in the advertised capabilities; omitting it leaves each of them
answering `-32601`. Every method receives the resolved per-request `MCPMethodOptions`
and is expected to **authorize the call itself**, exactly as the task port is.

| Method      | Returns                                                                        | Summary                           |
| ----------- | ------------------------------------------------------------------------------ | --------------------------------- |
| `resources` | `MCPResourcePage` (or a promise of one)                                        | Reads one resource page.          |
| `resource`  | `readonly MCPResourceContents[] \| MCPInputResult \| undefined` (or a promise) | Reads one concrete resource URI.  |
| `templates` | `MCPResourceTemplatePage` (or a promise of one)                                | Reads one resource-template page. |

#### `MCPPromptManagerInterface`

The prompt mirror of the port above, with the same gating: supplying it registers
`prompts/list` and `prompts/get` and advertises `prompts`, and omitting it leaves both
answering `-32601`. The mirror is exact in naming — `prompt(params)` / `prompts(pagination)`
against `resource(params)` / `resources(pagination)`, under the same shared cursor contract —
and stops where the domains differ. There is no prompt equivalent of `templates`, because prompts are
addressed by name and need no URI descriptor; and `prompts/get` is the one result in this
family that is not cacheable, so it carries no `ttlMs` / `cacheScope` where
`resources/read` does.

| Method    | Returns                                                            | Summary                    |
| --------- | ------------------------------------------------------------------ | -------------------------- |
| `prompts` | `MCPPromptPage` (or a promise of one)                              | Reads one prompt page.     |
| `prompt`  | `MCPPromptGetResult \| MCPInputResult \| undefined` (or a promise) | Resolves one named prompt. |

#### `MCPCompletionInterface`

The completion port, configured independently of the `resources` and `prompts` ports because
`completions` is a top-level capability rather than a sub-flag of either.

| Method     | Returns                                     | Summary                                                  |
| ---------- | ------------------------------------------- | -------------------------------------------------------- |
| `complete` | `MCPCompletion \| undefined` (or a promise) | Completes one argument against its host-owned reference. |

#### `MCPClientInterface`

The egress mirror: `connect` negotiates the modern revision and stores the selected
`version`, `discover` exposes the modern server description, `tools` wraps the
remote tools as local `ToolInterface`s, `call` runs a remote `tools/call`,
`listen` opens one `subscriptions/listen` stream, and
`disconnect` rejects pending requests, clears the negotiated revision, and
closes the connection it owns. Subscribe to client events through `emitter.on`.
The `tasks` data member is the stable Tasks extension's client half — see
[`MCPTaskClientInterface`](#mcptaskclientinterface) below.

| Method       | Returns                             | Summary                                                                                                                               |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`    | `Promise<void>`                     | Connects to the remote server — opens a connection on the transport and negotiates the modern wire revision.                          |
| `discover`   | `Promise<MCPDiscoverResult>`        | Discovers a modern server's supported revisions and capabilities.                                                                     |
| `disconnect` | `Promise<void>`                     | Disconnects from the remote server — rejects every pending request and closes the connection this client opened on its transport.     |
| `tools`      | `Promise<readonly ToolInterface[]>` | Lists the remote server's tools, each wrapped as a local `ToolInterface` whose `execute` runs the remote `tools/call` through `call`. |
| `listen`     | `MCPSubscriptionStream`             | Listens for the remote server's matching subscription notifications.                                                                  |
| `call`       | `Promise<MCPCallOutcome>`           | Calls a remote tool by name — runs `tools/call` and reports which permitted arm the peer answered with.                               |

**`version` is an exact modern pin.** An unpinned `connect` offers `MCP_MODERN_VERSION`; a pinned
client connects only where discovery advertises that same modern revision. A value outside
`SUPPORTED_MODERN_PROTOCOL_VERSIONS` throws `MCPError` `MCP_UNSUPPORTED_VERSION` from `createMCPClient`
before the emitter and transport subscription exist, carrying `{ supported, requested }`. Read
`version` after `connect` to learn the modern revision on the consumer surface. Configure a legacy
pin on `MCPLegacyClientTransportOptions`, not on `MCPClientOptions`.

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
client.emitter.on('notification', (message) => log(message))
await client.connect()
client.version // '2026-07-28' for a modern peer
const discovery = await client.discover()
const tools = await client.tools()
const outcome = await client.call('add', { x: 2, y: 5 })
await client.disconnect()
```

#### `MCPTaskClientInterface`

The stable Tasks extension's client half, reached as `client.tasks`. It mirrors
`MCPTaskManagerInterface` **minus `start`**, because creating a task is never the
client's decision: the extension gives a client no flag and no parameter to ask
for one, so a task exists only because the server deferred a `tools/call` it
received. It keeps the same **missing plural accessor**, for the same reason —
MCP defines no `tasks/list`, and the absence is how the shape says so.

| Method   | Returns                  | Summary                                                            |
| -------- | ------------------------ | ------------------------------------------------------------------ |
| `task`   | `Promise<MCPTaskDetail>` | Reads one durable task's current snapshot.                         |
| `update` | `Promise<void>`          | Answers the input requests an `input_required` task is waiting on. |
| `abort`  | `Promise<void>`          | Asks one durable task to stop.                                     |

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
supplies the hint, the one-shot read, and the doors a peer's inbound
task notification arrives through. It supplies **no timer, no
scheduler, no terminal-await helper, and no cache** — a client that neither asks
nor subscribes writes nothing at all after a `resultType: 'task'` answer, however
long you watch it. That is a position, not an omission: this package has no
durable place to keep a task, no way to know when your application still cares,
and no lifetime to hang a timer on that outlives the request the task was born
from. Write the schedule where those facts are known, which is your code.

**Which door a task notification arrives through is decided by the subscription
stamp.** A frame the server stamped for a subscription is claimed by the `listen`
stream that asked for it and does not re-emit through the `MCPClientEventMap`
`notification` event, so a subscribed consumer reads its transitions from the
stream it opened. An unstamped notification arrives on that event instead, at no
added mechanism.

Cancellation does not reach here either. `call`'s `options.signal` withdraws one
caller from one in-flight request; a call that already answered
`resultType: 'task'` is a request that is **over**, so aborting it afterwards
sends nothing at all — not `tasks/cancel`, and not `notifications/cancelled`,
because there is no longer a pending request to name. `client.tasks.abort` is the
only thing that reaches the work the request left behind.

#### `MCPMessageTransportInterface`

The shared transport-agnostic message carrier used by clients and server bridges —
`start` opens, `send` writes one message, and `close` tears down. Its `duplex: boolean`
data member states whether client-initiated notifications can reach the peer.

| Method  | Returns         | Summary                                                                     |
| ------- | --------------- | --------------------------------------------------------------------------- |
| `start` | `Promise<void>` | Opens the transport — establishes the connection and arms any reply reader. |
| `send`  | `Promise<void>` | Sends one JSON-RPC message to the remote server.                            |
| `close` | `Promise<void>` | Closes the transport — ends the connection and releases resources.          |

The obligations an implementation carries, because `MCPClient` depends on them
and cannot enforce them from its side. A `start` that acquires and then rejects
strands what it opened: the client claims a connection only once `start`
resolves, so a rejection leaves it holding an error and no claim, and nothing it
can call reaches the socket, session, or reader the transport opened. A `close`
must settle, because the client's only other bound is a deadline that reports an
unanswered shutdown rather than a failed one — a close that never settles leaves
the connection owed for the client's life. And `close` is never called twice
concurrently for one connection (a caller that gave up waiting joins the close
still running), but it is called again after an earlier `close` rejected, because
a rejected close ended nothing.

`close` is also idempotent: a call on a transport an earlier `close` already
ended resolves without emitting `close` again and without releasing anything a
second time. Idempotence bounds one closed lifetime rather than the object — a
transport that reopens on `start` arms itself there, and its next `close` ends
that connection and emits once for it.

"Release resources" is a per-transport promise, so here is what each carrier in
this package actually gives up. The `HTTPClientTransport`s abort every
in-flight `fetch` and response reader they still hold, clear that set, and drop
the negotiated protocol version. The `WebSocketClientTransport`s unsubscribe
from the socket before closing it; the browser one also discards its pre-open
queue, so nothing queued against the ended connection rides the next one, and
the Node one also destroys an upgrade request still on the wire.
`WebSocketServerTransport` unsubscribes before it runs the close handshake, so a
frame already in flight cannot re-emit on a
transport that has closed. `StdioClientTransport` stops its own line
dispatch at the call, terminates its child through the supervisor's bounded group
kill, and tears the supervisor down within the `drain` bound that caps a
descendant-held stdout pipe.
`StdioServerTransport` removes the listeners it put on `input` and `output`, rejects pending
sends, preserves the caller's flowing or non-flowing state and listeners, and does not destroy
or end the injected streams. An initially unread stream settles at non-flowing because
Node exposes no public operation that restores `readableFlowing === null` after
consumption. A later `data` listener does not resume that stream; the caller must
call `resume()` before the listener receives data. The transport
`createDuplexClientTransport` adapts forwards its `close` to the wrapped
`MCPTransportInterface` and holds nothing of its own. That range is the shape of
the whole rule: a transport releases what it acquired, never what it was
handed.

The remaining obligation is about `send`, and it is one keyword wide. A failing write must
reject, never throw synchronously. `MCPClient` issues the write inside the same
promise executor that records the request's pending entry, so a synchronous
throw leaves no promise for the failure handler to attach to: the executor
throws, the caller's promise rejects, and the pending entry set one statement
earlier is never settled. The request then looks in-flight to a client that has
already given up on it, and a later `options.signal` abort writes
`notifications/cancelled` naming a request the write never delivered. Every
transport this package ships declares `async send`, which satisfies the
obligation by construction; a non-`async` implementation returns a rejected
promise rather than throwing. The client cannot tell a rejection from a throw, which is
why the obligation lives here rather than in a guard it could not write.

```ts
import { createHTTPClientTransport } from '@orkestrel/mcp/server'

const transport = createHTTPClientTransport({ url: 'http://localhost:3000/mcp' })
transport.emitter.on('message', (message) => log(message))
await transport.start()
await transport.send({
	jsonrpc: '2.0',
	method: 'server/discover',
	id: 1,
	params: {
		_meta: {
			'io.modelcontextprotocol/protocolVersion': '2026-07-28',
			'io.modelcontextprotocol/clientCapabilities': {},
		},
	},
})
await transport.close()
```

#### `HTTPDisconnect`

The HTTP lifecycle entity composes the incoming request signal with an
MCP-owned response cancellation signal. Its readonly `signal` data member is
supplied to dispatch or observed by session cleanup; `bridge` wraps the matching
SSE response body, writes `: keepalive` comments at `keepalive.interval` (default
15 seconds; any value that is not a positive integer — `0`, a negative, a fractional
value, `NaN`, `Infinity` — falls back to that default rather than becoming a tick at the
host's timer floor), and makes every end of the response that is not its graceful completion abort
that signal, without inventing a protocol result or error: consumer cancellation, a failure
while forwarding upstream bytes, and a keepalive tick that finds the SSE stream already
closed. That is what a vanished client actually looks like from here — nothing aborts by
itself — so the handler, the controlled stream, and the producer behind them learn the
response is over. Ordinary upstream completion is the one terminal that only releases the
bridge's own timer and listener. The timer stops on every terminal path.

| Method   | Returns    | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge` | `Response` | Bridges one open SSE response through cancellation-aware byte forwarding and keepalives. Consumer cancellation, a read failure while forwarding, and a keepalive tick that finds the SSE stream already closed each abort `signal`; consumer cancellation also cancels the upstream reader. Upstream completion closes the returned body without inventing an abort. Every terminal path clears the keepalive timer and detaches the bridge-owned abort listener. |

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
push channel, with the bounded replay log folded in (private). `createMCPSession`
mints + stores it; an in-request handler reads it off `context.state.session`
and `push`es.

| Method   | Returns                      | Summary                                                                                                                                                                       |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attach` | `void`                       | Registers an open server→client SSE stream, a resumable `GET {path}`, so a later pushed message reaches it.                                                                   |
| `detach` | `void`                       | Unregisters a stream — the middleware calls it when the client disconnects.                                                                                                   |
| `push`   | `string`                     | Appends a message to the folded replay log under a fresh monotone event id, returns that id, and fans the message out to every attached stream as one `id:`-tagged SSE event. |
| `replay` | `readonly MCPSessionEvent[]` | Returns every retained log entry strictly after a cursor, in append order; an unknown or evicted cursor replays nothing.                                                      |

```ts
import { createMCPSession } from '@orkestrel/mcp/server'

const middleware = createMCPSession({ ttl: 60_000 })
// an in-request handler addresses the resolved session through `context.state.session`:
const session = context.state.session
if (session !== undefined) {
	session.push({ jsonrpc: '2.0', method: 'notifications/progress' }) // fan out to attached streams
	const missed = session.replay(lastSeenId) // events strictly after the client's cursor
	session.attach(stream) // register an open GET-SSE stream for future pushes
	session.detach(stream) // unregister it on disconnect
}
```

#### `StdioServerInterface`

The stdio ingress handle `createStdioServer` returns. No class implements it: the
factory owns the `StdioServerTransport` and the `bindServer` unbind behind it, and
publishes `start` and `stop` over that pair. The handle serves one lifetime — `stop()`
ends it permanently, and serving again takes a fresh `createStdioServer` over a
live stream pair.

| Method  | Returns | Summary                                                                                                                                                                                                                                                                                   |
| ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start` | `void`  | Arms the pump: subscribes to `input` and dispatches every complete line through the bound `MCPDispatcherInterface`, writing each defined response back to `output`. The pump arms once, so a repeated call attaches nothing further and an inbound request still draws exactly one reply. |
| `stop`  | `void`  | Unbinds the pump and closes the transport: removes the listeners the `start` method put on `input` and `output`, rejects every pending write, and releases `input` so the process can exit. A repeated call does nothing.                                                                 |

```ts
import { createMCPServer } from '@orkestrel/mcp'
import { createStdioServer } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
const stdio = createStdioServer(mcp) // over this process's own stdin/stdout
stdio.start() // arm the pump
stdio.start() // a repeat arms nothing further — one reply per request
stdio.stop() // unbind, release stdin, and end this handle
```

#### `ScopeServerInterface`

The worker-scope handle `createScopeServer` returns, and the browser twin of
`StdioServerInterface`. No class implements it: the factory owns the `MCPServer`, the
implicit scope binding, and the per-port bindings behind it, and publishes the one door that
ends them. It arms at construction rather than on a `start`, because an event delivered
between the call and an explicit arm would reach nothing.

| Method | Returns | Summary                                                                                |
| ------ | ------- | -------------------------------------------------------------------------------------- |
| `stop` | `void`  | Ends every binding this scope server owns — idempotent, and permanent for this handle. |

```ts
import { createScopeServer } from '@orkestrel/mcp/browser'
import { createToolManager } from '@orkestrel/tool'

const worker = createScopeServer({ tools: createToolManager() }) // arms on the current scope
worker.stop() // release every binding this call owns
worker.stop() // a repeat releases nothing further
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
tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))

const server = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools })
server.emitter.on('request', (method, id) => log(method, id))

// A transport reads a framed message string and writes the reply:
for await (const message of transport) {
	const reply = await server.handle(message)
	if (reply !== undefined) await transport.send(reply) // a notification has no reply
}

// `handle` also answers one message string on its own:
const listed = await server.handle(
	'{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}',
)
// listed → '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"search","inputSchema":{"type":"object"},"description":"Search the docs"},{"name":"add","inputSchema":{"type":"object"}}],"resultType":"complete","ttlMs":60000,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"docs","version":"1.0.0"}}}}'
```

### Drive the typed core directly

When the request is already parsed (a test, an in-process bridge), call
`dispatch` and skip the string boundary.

```ts
const answer = await server.dispatch({
	jsonrpc: '2.0',
	method: 'tools/list',
	id: 1,
	params: {
		_meta: {
			'io.modelcontextprotocol/protocolVersion': '2026-07-28',
			'io.modelcontextprotocol/clientCapabilities': {},
		},
	},
})
// a request answers a response or a held-open stream, never `undefined`:
if (!(Symbol.asyncIterator in answer)) answer.result // { tools: [ … ] }

const notification = await server.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })
notification // undefined — the notification overload resolves nothing else
```

### Mount the HTTP transport with sessions

Compose the opt-in session middleware in front of the session-agnostic route
for stateful resumable streaming; omit it for the byte-identical stateless
default.

```ts
import { createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
import type { MCPOriginOptions } from '@orkestrel/mcp/server'
import { createMCPRoutes, createMCPSession } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/tool'

const mcp = createMCPServer({
	identity: { name: 'docs', version: '1.0.0' },
	tools: createToolManager(),
})
const origin: MCPOriginOptions = { origins: ['https://app.example'] }
router.use(createMCPSession({ ttl: 60_000, origin })) // stateful: mint + validate + resumable GET / DELETE
// Both enforcement sites consume the same policy, and a session is minted on an `initialize` POST:
router.add(createMCPRoutes(createMCPLegacy(mcp), { origin })) // answers `initialize` too; pass `mcp` alone for modern-only
```

### Drive a remote server over HTTP, WebSocket, or stdio

The same `MCPClient` correlation, deadline, and tool-mapping ride over any of
the transports unchanged — only the injected `MCPMessageTransportInterface`
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
	isMCPLegacyVersion,
	isMCPModernVersion,
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

// The two guards behind that split are disjoint: the modern one covers what a bare server
// accepts and advertises, the legacy one covers what the optional decorator accepts during
// `initialize`, and no revision satisfies both.
isMCPModernVersion('2026-07-28') // true
isMCPModernVersion('2025-11-25') // false — a bare server never accepts a legacy revision
isMCPLegacyVersion('2025-06-18') // true
isMCPLegacyVersion('2026-07-28') // false — the modern revision defines no initialize

// Selection walks the supported revisions newest-first, so the peer's own ordering
// never decides the outcome — this is how `connect` picks a revision from a discovery.
inferVersion(['2025-11-25', '2026-07-28']) // '2026-07-28' — newest in common
inferVersion(['2025-11-25']) // undefined — legacy is not a modern discovery offer

// Supplying a TTL adds both cache stamps, so `tools/list` carries `ttlMs` and
// `cacheScope`; omitting it adds neither, which is how `tools/call` stays uncacheable.
const identity = { name: 'docs', version: '1.0.0' }
const listed: MCPListResult = buildModernResult({ tools: [] }, identity, 60_000, 'public')
const called = buildModernResult({ content: [] }, identity) // no TTL → no cache stamps
const discovered = buildDiscoverResult({ identity, tools: createToolManager() })
discovered.supportedVersions // the revisions this server negotiates
```

The same era decision has consequences on the server face: which legacy revision an
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

The HTTP transport's own building blocks — the header readers, the request
gates, and the SSE decoders — useful in a custom route or test harness. The gates and readers
are the server face's; the SSE decoders are host-independent and ship from the core face, so a
page reaches the same ones.

```ts
import { buildResponseError, decodeEvent, readEventStream } from '@orkestrel/mcp'
import {
	acceptsEventStream,
	allowsOrigin,
	createMCPPostHandler,
	inferHeaderIssue,
	inferSessionHeaderIssue,
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

// The session rule is its own reader: a live legacy session pins its revision at initialize,
// and every later request on that session is held to that one.
inferSessionHeaderIssue(posted, '2026-07-28') // undefined — the header names the pinned revision
inferSessionHeaderIssue(posted, '2025-06-18')?.reason // 'mismatched'

const reply = await fetch('http://localhost:3000/mcp')
const messages = await readEventStream(reply)
decodeEvent('{"jsonrpc":"2.0","id":1,"result":{}}')
buildResponseError(
	new Response('', { status: 503, headers: { 'content-type': 'text/event-stream' } }),
	'text/event-stream',
).message // 'HTTP 503 response contained a text/event-stream body without a JSON-RPC message'
upgradeRequestPath(rawUpgradeRequest) // the incoming upgrade request's pathname
```

### Frame newline-delimited JSON-RPC over stdio directly

The shared line-framing step the stdio transports read their inbound
messages through.

```ts
import { dispatchLines, extractLines } from '@orkestrel/mcp/server'
import { Emitter } from '@orkestrel/emitter'

const emitter = new Emitter()
const { lines, remainder } = extractLines('', '{"jsonrpc":"2.0","method":"ping"}\n{"jsonrpc"')
dispatchLines(emitter, lines) // emits `message` for the complete line above
```

### Serve MCP from a Web Worker

`createScopeServer` is the drop-in entry for a real Web Worker's `main.ts` — boot an
`MCPServer` over the worker's own implicit `postMessage` channel (a dedicated
worker) or over each connecting client's `MessagePort` (a Service Worker),
with no upfront shape flag. Its `scope` parameter defaults to `globalThis`, which inside a
worker is that worker's own scope, so the entry module passes options alone. The registry it
serves is modern only: it answers every modern client, and a legacy `initialize` falls off as
`-32601`. A dual-era worker composes `bindServer(createMCPLegacy(mcp), …)` instead:

```ts
// worker's entry module:
import { createScopeServer } from '@orkestrel/mcp/browser'
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
const worker = createScopeServer({ tools, name: 'worker-mcp', version: '1.0.0' })
// ... on teardown:
worker.stop()
```

> **Trust boundary — mechanism, not policy.** `createScopeServer` exposes the entire
> `tools` registry to every modern client that delivers a port-bearing message, with no
> built-in origin or identity check. In a Service Worker every same-origin
> context the SW controls (any window, worker, or iframe) can
> `controller.postMessage(msg, [port])` and receive a fully-bound server with
> complete tool-call access. Gating is the embedding application's responsibility;
> compose a guard in front using the `accept` option. Prefer a handshake token in
> `event.data` — for same-origin worker/MessagePort messages `event.origin` is
> frequently the empty string, making origin allow-listing unreliable:
>
> ```ts
> createScopeServer({
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
> `createScopeServer` suits bounded, long-lived client sets. Embedders with high client
> churn must manage lifecycle themselves (`stop` and re-serve, or wrap the
> scope in their own reaping layer).

Passing `scope` explicitly is the same wiring over an object you supply — this
runnable fence drives it with a minimal `ScopeInterface` (the exact
shape a real worker's `self` satisfies) plus a real `new MessageChannel()`
standing in for a Service-Worker-shaped client connection, so `tools/list`
genuinely round-trips with no worker harness:

```ts
import { createScopeServer } from '@orkestrel/mcp/browser'
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
const worker = createScopeServer({ tools, name: 'worker-mcp', version: '1.0.0' }, scope)

const { port1, port2 } = new MessageChannel()
const reply = new Promise((resolve) =>
	port2.addEventListener('message', (event) => resolve(event.data)),
)
port2.start()
for (const listener of listeners)
	listener(new MessageEvent('message', { data: null, ports: [port1] }))
port2.postMessage(
	'{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}',
)

log(await reply) // '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"add","inputSchema":{"type":"object"}}]}}'
worker.stop() // unbinds every binding, closes every accepted MessagePort
```

### Own bounded execution values and one streamed HTTP response

The cloners own hostile execution-boundary values without promising a general object clone. The
progress reporter is one non-durable request slot with one serial consumer. `HTTPDisconnect`
composes exactly one incoming request and one SSE response, preserving response bytes and owning
keepalive/cancellation cleanup rather than handler or session policy.

```ts
import { MCPProgressReporter, snapshotJSON, snapshotToolResult } from '@orkestrel/mcp'
import { HTTPDisconnect } from '@orkestrel/mcp/server'
import { createStream } from '@orkestrel/server'

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

const stream = createStream({ headers: { 'x-operation': 'call-1' } })
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

- [Exact JSON and Tool-result ownership](../tests/src/core/cloners.test.ts)
- [Request-scoped progress backpressure](../tests/src/core/MCPProgressReporter.test.ts)
- [Held-open stream cancellation](../tests/src/core/MCPStreamController.test.ts)
- [Serialized stream translation](../tests/src/core/MCPTextStreamController.test.ts)
- [Core dispatch integration](../tests/src/core/MCPServer.test.ts)
- [Modern and decorated-legacy revision boundary](../tests/src/core/integration.test.ts)
- [Legacy translation onto the modern engine](../tests/src/core/MCPLegacy.test.ts)
- [Resource and prompt port projection, pagination, and completion](../tests/src/core/MCPServer.test.ts)
- [Resource, prompt, and error guards](../tests/src/core/validators.test.ts)
- [Client-side durable tasks and the absent poll loop](../tests/src/core/MCPTaskClient.test.ts)
- [A task transition filtered, stamped, and carried to a subscribed client](../tests/src/core/MCPClient.test.ts)
- [What the shared HTTP client transport owes on release, on headers, and on a non-success reply](../tests/src/core/transports/HTTPClientTransport.test.ts)
- [The server face composed end to end over a real `node:http` listener](../tests/src/server/integration.test.ts)
- [HTTP response lifecycle composition](../tests/src/server/HTTPDisconnect.test.ts)
- [HTTP handler integration](../tests/src/server/handlers.test.ts)
- [Session middleware integration](../tests/src/server/middlewares.test.ts)
- [Guide/source/public-barrel parity, what the spawned stdio child actually receives, and how the composed stdio server answers a legacy `initialize`](../tests/guides.test.ts)
- [The equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Expose a tool registry over MCP` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline](../tests/guides.test.ts)
- [The packed artifact a consumer installs, across its faces and its ESM and CommonJS builds](../tests/distribution.test.ts)
- [Package guide law, including the legacy-removability boundary](../tests/guides.test.ts)

## Declared non-goals

Everything below is intentionally absent, with its reason. A capability named here is
not a defect and not a roadmap entry: it is a decision, and the guide states it so a
consumer can plan around it instead of discovering it.

**Protocol surfaces this package does not implement.**

| Not built                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roots, Sampling, Logging                                                | All are deprecated in 2026-07-28 and none has a registry or a consumer here. The local `emitter`s are observability, not an MCP logging capability. Resources and Prompts are not on this list any more — see [Project a host-owned resource, prompt, and completion registry](#project-a-host-owned-resource-prompt-and-completion-registry).                                                                                                                                     |
| A built-in resource or prompt store                                     | The `resources` / `prompts` / `completion` capabilities ship as ports, exactly as tools and durable tasks do. What backs one — a workspace, a database, a template registry, a plain object — is the host's decision, and a default store here would be product policy wearing a framework's clothes.                                                                                                                                                                              |
| Server-initiated `elicitation/create` requests                          | 2026-07-28 removes server-initiated requests entirely. Input requests survive only inside a modern `tools/call` `input_required` result — see [Ask the client for input during the call in hand](#ask-the-client-for-input-during-the-call-in-hand).                                                                                                                                                                                                                               |
| Durable task or session storage                                         | Task state outlives the request that created it and this package owns no persistence. The store arrives injected as `MCPTaskOptions.tasks`, exactly as `ToolManagerInterface` does — the extension's protocol ships here, its durability does not.                                                                                                                                                                                                                                 |
| `outputSchema` on tool descriptors                                      | `ToolResult.value` (`@orkestrel/tool`) is `unknown`; the contract that owns the value owns its schema. `structuredContent` is produced without one, which no clause gates.                                                                                                                                                                                                                                                                                                         |
| Icons (2025-11-25)                                                      | Installed `@orkestrel/tool` definitions carry no icon field, so an MCP-only wrapper would have no originating consumer.                                                                                                                                                                                                                                                                                                                                                            |
| Withholding a consumer's own invalidly annotated tool from `tools/list` | The annotation is read and enforced on both sides; see [Protocol](#protocol) for the rules. The exclusion MUST binds an HTTP client, and this package's client transports honour it. A server that also dropped the definition would hide a consumer's tool from every peer over a mistake in one property, so this one serves it, recognizes no `Mcp-Param-*` name for it, and lets each conformant client exclude it.                                                            |
| `_meta['io.modelcontextprotocol/logLevel']`                             | The deprecated canonical value is validated as request metadata, but no consumer opts a request into server log emission.                                                                                                                                                                                                                                                                                                                                                          |
| W3C `traceparent` / `tracestate` / `baggage`                            | Tracing is application policy. The `request` event is the observation seam; a consumer stamps its own spans there.                                                                                                                                                                                                                                                                                                                                                                 |
| Reading `extensions` for anything but Tasks                             | Capabilities are an open record, so a consumer can already declare any extension id without a library change. This package reads exactly one key of that map — `io.modelcontextprotocol/tasks`, and only when `task` is configured — and advertises the same one; every other id travels through untouched.                                                                                                                                                                        |
| An OAuth 2.1 authorization client                                       | The flow that mints a bearer — discovery, dynamic registration, a token grant — is a client this package does not publish. Every HTTP client transport takes a `headers` record, so a consumer supplies its own bearer, and server-side authorization composes in front as ordinary `@orkestrel/server` middleware. The conformance runner's `auth/*` client scenarios are outside the recorded set for this reason — see [Declared conformance gaps](#declared-conformance-gaps). |
| JSON-RPC batching                                                       | Removed by deletion: only individual messages are accepted, and the types enforce it.                                                                                                                                                                                                                                                                                                                                                                                              |
| The optional 2025-11-25 SSE polling protocol                            | No consumer. Resumability exists only as the legacy session middleware's `GET` channel, and a modern request must not use it.                                                                                                                                                                                                                                                                                                                                                      |

**Revisions this package does not speak.** `2025-03-26` is dropped because its
mandatory JSON-RPC batching is unimplemented here, and `2024-11-05` because it
requires the HTTP+SSE transport this package never implemented and
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
- The HTTP client transports stamp `Mcp-Name` for **`tools/call` alone**, because
  `MCPClientInterface` publishes no `prompts/get` and no `resources/read` call: the prompt and
  resource targets the header is scoped to have no reachable path out of this client. The
  server validates every scoped target, so the asymmetry is the client's method surface rather
  than a split reading of the header rule. A consumer issuing either method over its own
  transport stamps the header itself, through `encodeSentinel`.

**Policy this package will not decide.** Framework code supplies mechanism and stops
before the deployment's decisions. Auth, tool-invocation rate limiting (see
[Declared conformance gaps](#declared-conformance-gaps)), and request-body size guards
are all composed in front as ordinary `@orkestrel/server` middleware; `limit.message`
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

The conformance project is a foreign-runner exchange and a schema-authority comparison,
and each measures something the other cannot.

A reproducible run is `npm run test:conformance`: it starts the real Streamable HTTP
server from this package's source and runs `@modelcontextprotocol/conformance` — the
release `package.json` pins as a development dependency — against specification revision
`2026-07-28`. That is a genuine foreign MCP client driving this surface end to end, and the
recorded server-mode result is **110 passed / 0 failed**, the `dns-rebinding-protection`
security regression guard (2 passed) included. `tests/conformance.test.ts` records that
result scenario by scenario, so a scenario that stops running reddens instead of vanishing
into a total. `http-custom-header-server-validation` is green at 9 passed: SEP-2243 wants a
400 response and a `-32020` `HeaderMismatch` error for a mismatched or invalid `Mcp-Param`
header, and the POST handler now validates every such header its own tool definitions
annotate against the call's body. `server-stateless` is green at 28 passed: its SEP-2575
checks omit the body's `_meta`, or its `protocolVersion`, and the modern protocol header
holds each request to the modern revision, so both answer `-32602` rather than falling
through the legacy door's `-32022`.

The same runner has a client mode, and the same command drives this package's own
`MCPClient` through every non-auth client scenario at that revision over
`createHTTPClientTransport`, against its own per-scenario baseline in the same file. Every
recorded client scenario is green, `http-custom-headers` at 18 passed and
`http-invalid-tool-headers` at 11 passed: the HTTP client transports cache each listed
tool's `x-mcp-header` annotations, project a call's own arguments onto `Mcp-Param-*`
headers, and drop an invalidly annotated definition from the `tools/list` result they
deliver. The `auth/*` family is outside the recorded set, because each of those scenarios
drives an OAuth 2.1 client through discovery, dynamic registration, and a token grant, and
this package publishes no OAuth client.

The comparison starts no server and drives no client. It reads the stable Tasks
extension's published schema from the vendored mirror
`tests/mirrors/ext-tasks-2026-07-28-schema.json`, and the `TASK_SCHEMA_DIGEST` constant in
`tests/setupConformance.ts` pins that file's raw bytes: a changed byte throws at module
load, before a comparison row runs, so no row reads a mirror this package has not pinned.
Each comparison row projects one schema coordinate — a task variant, a result composition,
a notification shape, a subscription fragment — and compares it with the shape this
package ships, so a contract that drifts from the authority reddens the row naming the
coordinate.

They share one project — `tests/conformance.test.ts` over the fixture in
`tests/setupConformance.ts` — and `npm test` gates it. It spawns a foreign process and
drives it over a real socket, but the runner is a pinned development dependency resolved
from `node_modules` and the socket is loopback, so the run is offline and hermetic. The
runner's baseline is recorded scenario by scenario rather than as one total, so a scenario
that silently stops running fails the run instead of disappearing into a matching sum.

**That number has been wrong before, in the same way each time, and the fixture was the
cause — so read the fixture before quoting the number.** It was first recorded as
**8 passed / 15 failed**, measuring a fixture built without
`MCPServerOptions.execution` — the shipped, documented port
[above](#execute-rich-results-and-request-scoped-progress) — so the rich-content
scenarios received a normalized text result instead of the image, audio,
embedded-resource, and mixed content they asked for, and another counted two progress
frames where the scenario specifies three. Wiring that port moved it to **13/10**. It
was then quoted as 13/10 against a fixture built without the `resources`, `prompts`,
and `completion` ports, so the remaining scenarios measured an unconfigured harness
rather than the library; wiring those ports moved it to **23/0** on the scenario set of the
day. Neither correction changed one byte of `src/` or `dist/`. The lesson is the number's, not the library's: a
recorded baseline must measure the product, not the harness, and a fixture that omits
a shipped port understates the package by exactly the scenarios that port serves.

The scenarios that correction closed are the Resources set
(`resources-list`, `resources-read-text`, `resources-read-binary`,
`resources-templates-read`), the Prompts set (`prompts-list`, `prompts-get-simple`,
`prompts-get-with-args`, `prompts-get-embedded-resource`, `prompts-get-with-image`),
and `completion-complete`. `resources-templates-read` is worth singling out, because it
is the scenario that would have forced a template engine if one were needed: it sends
the already-substituted `test://template/123/data`, and the fixture's own manager
matches it. **Nothing in this package expanded that template** — see
[the port section](#project-a-host-owned-resource-prompt-and-completion-registry).

The fixture backs every port with plain in-memory objects, which is also the
control on the claim that they are real ports: no workspace, no template engine, and
no `@orkestrel/*` registry is involved, and the foreign client cannot tell.

**Read that number for exactly what it measured, and no further.** These bounds fix its
scope:

- It drives **Streamable HTTP `POST` only**. It says nothing about the WebSocket, stdio,
  `MessagePort`, or worker-scope carriers — which is precisely where this package's
  cancellation and duplex behaviour lives.
- It mounts `createMCPRoutes` alone, so **`createMCPSession` is never exercised**: no
  session mint, no TTL sweep, no `mcp-session-id` round trip is covered by this number.
- It says nothing about **this package's own client consuming a held-open exchange**. The
  runner's client consumes one and reports it (`server-sse-multiple-streams`, 2 passed / 0
  failed), so the server half is exactly what that scenario proves; `MCPClient.listen` is
  proven by this package's own tests over a duplex carrier instead — see the following entry
  for the carrier limit that survives.
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

**Incremental client-side consumption of a held-open Streamable HTTP exchange — duplex-only.**
`MCPClient.listen` opens `subscriptions/listen` and consumes the reply as it arrives, and over a
duplex carrier that is what happens: each stamped frame is delivered the moment the transport
carries it. The HTTP client transports buffer a `text/event-stream` reply to completion before
they emit anything, so a `listen` over an HTTP client transport yields its acknowledgement,
every frame, and its terminal together when the stream closes. The subscription API is correct
over that carrier and useless for the reason a subscription exists. **What it costs:** a
long-lived HTTP subscription reports nothing until it ends, so an HTTP consumer that wants
frames as they happen has no carrier here — use the WebSocket, stdio, or `MessagePort` face
instead. **Closer:** the transport-ingress backpressure capability — a per-request awaited
delivery handler and `signal` on `send`, with incremental HTTP decoding on the server and
browser faces.

**A per-request abort reaching one in-flight HTTP fetch — partly closed, and the rest needs the
same seam.** `listen` carries a required per-subscription `signal`: aborting it closes that
subscription, releases its registration, and writes `notifications/cancelled` on a duplex
carrier, so a caller can abandon one long-lived exchange without abandoning the transport.
`MCPMessageTransportInterface.send` still takes a message and no per-request options, and the
HTTP transports carry only a construction-time `timeout` applied uniformly through
`AbortSignal.timeout`. So the signal ends the client's interest in the subscription and cannot
cancel the fetch already in flight underneath it. **What it costs:** an aborted HTTP
subscription stops delivering to its consumer while its request runs to completion on the wire.
**Closer:** the same transport-ingress backpressure capability — a per-request options bag on
`send` carrying that `signal`, which is why this entry and the one preceding it would return as
one unit and never separately.

**`-32020` refresh-and-retry-once — not implemented, and a retry could not fix the version
half of it.** A client that receives `-32020` for a protocol-version header the peer refuses
might be expected to refresh its version and retry once. It is not implemented, and for that
header the reason is stronger than scheduling: the HTTP client transports derive every
standard header from the message being sent — the method header, the `tools/call` name
header, and the protocol version read out of the message's own `_meta` through the one
shared `inferRequestVersion` — so a retry of the same message re-derives byte-identical
headers and earns byte-identical refusal. (That claim was only half true until the browser
face stopped projecting its version through `parseRequestContext`; the browser and Node faces
now share one derivation, which is what makes "the same message re-derives the same headers"
a statement about both of them.) The code is also unreachable ahead of validation: every
malformed-context path answers `-32602` first. Only a header-rewriting intermediary between
client and server produces such a `-32020` this client did not cause, and a retry reproduces
that intermediary exactly. **What it costs:** nothing against a peer this client talks to
directly. **Closer:** none needed unless a reachable path is exhibited where a refresh
changes the derived headers; that would make the retry meaningful and this half wrong.

**Re-listing and retrying once after a `Mcp-Param-*` `HeaderMismatch` — a declared `SHOULD`
departure.** The `Mcp-Param-*` half is different, and this is the honest reason it is stated
here rather than built. A `tools/call`'s projected headers come from the annotations the
transport cached from the `tools/list` result it delivered, so a server that changed a tool's
annotations after that listing can refuse a call whose headers a fresh listing would have
made correct. SEP-2243 says a client receiving `HeaderMismatch` `SHOULD` re-list and retry
once. This package does not: retrying inside the transport would re-issue a `tools/call` the
caller has already been told failed, under a table the caller never saw, and the transport
is the wrong layer to decide that a second invocation of somebody's tool is safe. **What it
costs:** against a server that changes tool annotations mid-connection, one call fails with
`-32020` that a retry would have carried. **The consumer's obligation:** call `tools()` again
and retry the call. That listing carries no `cursor`, so the transport replaces its table
with it: the next call projects the current headers for a tool the listing still advertises,
and projects nothing for one it no longer advertises. **Closer:** a retry policy owned by
`MCPClient` rather than by a transport, with the caller able to decline it — not scheduled,
and it needs the per-request options seam the entries above name.

**A retry the server cannot verify is refused, not re-requested — a declared `SHOULD` departure.**
The MRTR page says a server that finds requested information missing on a retry `SHOULD` answer a
new `input_required` round re-requesting it rather than an error. This server answers `-32602`
to every verification failure, an omitted issued key and an absent `requestState` included. It
fails closed on purpose: the round the server would re-issue is the one sealed inside the
carrier it declined to trust, and minting a fresh round from an unverifiable retry hands a
client that failed verification a new sealed state to try again with. The other half of that
clause is satisfied — unrecognized extra `inputResponses` keys are ignored, because the server
reads exactly the keys it issued. **What it costs:** a client that drops the carrier or omits an
issued key starts the call again from its first round instead of receiving the missing question
a second time. The conformance runner records the cost exactly: its
`input-required-result-missing-input-response` and `input-required-result-ignore-extra-params`
scenarios check a `SHOULD`, so a refusal reports WARNING and both scenarios are recorded at
0 passed / 0 failed rather than green. **Closer:** one unit separating the omitted-key case from
the unverifiable-carrier case and re-issuing the round for the first alone; it is not scheduled,
and it needs a reading of how a re-issued round binds to state the client already returned.

**`Mcp-Param-*` / `x-mcp-header` client projection — satisfied, without widening the shared
transport contract.** An HTTP client MUST project tool arguments annotated with
`x-mcp-header` into `Mcp-Param-*` request headers, and MUST exclude a tool whose annotations
violate the constraints. Both faces do, and this entry records how, because the earlier
reading of it was wrong: the projection was thought to need the tool's schema passed into
`send`, which would have meant widening the transport-agnostic
`MCPMessageTransportInterface.send` into an HTTP-shaped contract every other transport would
then carry. It does not. The schema already travels through the transport, in the
`tools/list` result the transport itself delivers, so each HTTP face caches the annotations
from that result and projects a later `tools/call` from the cache plus the call's own
arguments. `MCPMessageTransportInterface` is unchanged, and stdio, WebSocket, and
`MessagePort` are untouched — the annotations bind Streamable HTTP alone. A `tools/call` for
a tool this transport never carried a listing for projects nothing, because inventing a
lookup is how a client sends a header the peer never advertised. The sent request decides
whether a delivered page joins that table or replaces it: a `tools/list` carrying no
`cursor` is a fresh listing and clears the table before caching its page, while a
continuation carrying the cursor the previous page handed back accumulates onto it. So a
tool a fresh listing omits stops projecting, and a tool on an earlier page of one paged
listing keeps projecting. Arrival order cannot merge two listings into one table: a listing
another cursorless `tools/list` supersedes before its answer arrives is still delivered to
the caller, exclusions and all, and caches nothing.

**The stdio client shuts a child down signal-first, not stdin-first — a declared `SHOULD`
departure owned by another package.** The stdio page says a client `SHOULD` close the child's
`stdin`, wait for it to exit, and terminate it only if it does not. `StdioClientTransport.close`
runs `@orkestrel/process`'s bounded teardown, whose ladder is the other way round: the
supervisor signals the child (`SIGTERM`, then `SIGKILL` after the grace window; on Windows a
`taskkill /F /T` over the tree), and destroys `stdin` after that. **What it costs:** a child
that would have exited cleanly on EOF is signalled instead, so its own shutdown work runs
against a deadline and, on Windows, does not run at all — a `SIGTERM` handler never fires there,
and the diagnostics it would have written never exist. **Closer:** `@orkestrel/process`. The
ladder belongs to the supervisor that owns the child, not to a transport reaching around it, so
this package adopts a cooperative stop as soon as `Process` offers one; the improvement is
recorded against that package.

**Tool-invocation rate limiting — not satisfied, and no unit will close it.**
2025-11-25's `server/tools` § Security Considerations binds a server to validate tool
inputs, implement access controls, **rate limit tool invocations**, and sanitize tool
outputs. Input validation, access control, and output sanitization are already true here
or belong to the tool contract that owns the values. The rate limit is neither, and will not become either: a
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
no seam to hand a signal through, so a server configured without `execution` runs its tool to
completion after the request that asked for it has ended, and abandons the result. **What it
costs:** a long or expensive tool keeps spending after its caller is gone. **The consumer's
options:** supply `MCPServerOptions.execution`, whose `MCPExecutionContext` carries `signal`
and can stop the work; or bound the tool itself. **Closer:** none inside this package — the
limit is in the `execute` signature, which `@orkestrel/tool` owns.

**A producer that ignores its signal cannot be forced to finish.** A controlled stream
settles its consumer promptly whatever the producer is doing, and aborts the request's
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
Streamable HTTP there is no such frame at all — there, closing the response stream is the
cancellation signal, and only a streamed response has one to close. **Closer:** none possible
for the HTTP face; the limit is the dated revision's.

This package's own client does write the frame — `call`'s `options.signal` sends
`notifications/cancelled` on a carrier declaring `duplex`, and writes nothing on one that
does not. That is the correct read of the dated revision, which defines no client-to-server
notifications over Streamable HTTP: there, **closing the SSE response stream is itself the
cancellation signal**, so a duplex-declaring transport is exactly the population the frame
belongs to. Cancellation is advisory in both directions — every receiver obligation is
`SHOULD` or `MAY` — so a peer may finish anyway, and a response arriving after the abort is
discarded rather than raised as a fault.

**The cancellation page and the subscriptions page of the dated revision disagree about how a
server ends a subscription, and this package implements the one that owns the mechanism.** The cancellation page says a server MUST
send `notifications/cancelled` referencing a `subscriptions/listen` request id when it tears
that stream down, and MUST NOT send the notification for any other purpose. The subscriptions
page it cites as its authority describes its end conditions and their mechanisms, and none
of them is a server-sent `notifications/cancelled`: for unilateral server teardown it says the
server `SHOULD` send the empty `subscriptions/listen` result to signal a graceful end, and it
attributes the notification to the client alone. The schema carries only the generic
`CancelledNotification` with `requestId` and an optional `reason` — no subscription-specific
field or variant — so it corroborates neither page. This server sends the empty result,
correlated by the original request id through `buildSubscriptionResult`, on every transport.
**What it costs:** a client written against the cancellation page, watching for a notification
it believes is required, sees the result instead. **Do not "fix" this toward the cancellation
page** — emitting the notification as well would send a frame the governing page does not
sanction alongside the result that page does require. **Closer:** upstream's, not this
package's; the contradiction is theirs to resolve.

**A consumer's own registered method cannot be called with this client.** `MCPServer.methods`
is an open registry, so a consumer may register `prompts/get` — or any other name — and this
package's server will dispatch it. `MCPClient` publishes no matching general capability: its
correlated-request door is private, and the public surface is `discover` / `tools` / `call`
plus the `tasks/*` methods `client.tasks` covers. The asymmetry is deliberate rather than
overlooked — a public arbitrary-request method is a capability with no consumer today, and the
creation gate refuses one — but it is an asymmetry, and a consumer planning a custom method on
the client and the server must know it before writing the server half. **The consumer's options:** build the
client half on `MCPTaskClient`'s own pattern, because `MCPRequestFunction` is published and an
`MCPTaskClient` is constructible with any implementation of it. **Closer:** one unit publishing
the door, whenever a real consumer needs it.

**Do not reach for the client's own transport as a second door.** Writing a raw frame through
`client.transport.send` puts it in the id space `MCPClient` correlates on, and the client's
counter is private and unpublished — so there is no id a consumer can be sure is free. Reusing
one that is live is not a collision the client detects: the peer's answer arrives on the same
`message` subscription, correlates to the pending entry that id already names, and settles
somebody else's `call` with the wrong result. That has been run — a raw `prompts/get` written
under a live `call`'s id resolved the `call` with the prompt — so it is a hazard rather than a
workaround, and the `MCPRequestFunction` route above is the supported one precisely because it
mints its ids through the same door everything else does.

**Where the task subscription filter sits on the wire is this package's reading, not settled
protocol.** The extension ships `notifications/tasks` and its doc page says a client opts in
through the `subscriptions/listen` mechanism, but no published source states how the extension
and that mechanism compose. The extension's schema declares the fragment
`TaskSubscriptionNotifications { taskIds?: string[] }` and then never references it; the core
`2026-07-28` schema never mentions the fragment either, and its `SubscriptionFilter` declares
no extension hook. **What this package reads it as:** `taskIds` sits directly under
`params.notifications`, beside the sibling per-identifier member `resourceSubscriptions`,
because the fragment's own JSDoc calls it a field set for the `subscriptions/listen` request.
**What is settled:** `TaskStatusNotificationParams` is the notification envelope intersected
with the detailed task, so the frame is flat — a consumer reads `params.status` directly,
never `params.task.status`. **The authority contradicts itself on the member's name:** that
fragment's JSDoc prose says `tasksStatus` while its declaration and the generated schema both
say `taskIds`, and this package follows the declaration. **What it costs:** a peer that
composes the fragment somewhere else reads a filter this server does not offer and a filter
this client does not send, so the family degrades to the polling fallback the extension
already defines rather than to a protocol error. **Closer:** one unit, after a published
source states the composition; it is not scheduled.

The modern-only scope of `subscriptions/listen` is a stated limit rather than a gap —
it is recorded under [Declared non-goals](#declared-non-goals) with the other era-scoped
surfaces.

**Not every guide fence is executed.** `tests/guides.test.ts` transcribes and drives the
flagship ones: the `tools/list` metadata pair, the stdio child's merged environment, its piped
stderr and the retained evidence tail, the composed stdio server's legacy handshake, the
consumer-visible client's modern version, and the subscription stream's delivery order and
capacity refusal. Every other fence carries named-import, symbol, and link parity alone. **What
it costs:** a fence whose comment claims a value nothing asserts is checked for its names and
not for its answer, so a behaviour that drifts under one of those fences reddens no gate.
**Closer:** a transcription per fence, added with the claim it pins.

## Declared packaging limits

The facts about the published artifact. Each is a decision carrying its number, not an
omission, and a consumer meets each of them at install time rather than in a build log.

**IDE integration is not claimed.** A real foreign protocol client drives the Streamable
HTTP surface end to end — `@modelcontextprotocol/conformance` against revision
`2026-07-28`, recorded at 110 passed / 0 failed — and that is a claim about the
wire. No IDE, editor, or agent host has driven this server. The rule is this repository's
own: a claim about an external client stays unproven until one representative real client
of that class drives it end to end, and no client of the IDE class has. **What it costs:**
a consumer adopting this package to back an IDE integration is doing something nobody here
has tested, and the conformance number does not transfer to it. **Closer:** one
representative IDE driving this server, recorded exactly the way the conformance run is.

**There is no top-level `types` field, and legacy `moduleResolution: node` reaches only the
core face.** The `exports` map carries a `types` condition on every subpath and every
condition inside it: `.` under both `import` and `require`, `./browser` under `import`,
`./server` under both. Every resolver that reads `exports` therefore finds declarations,
which is `node16`, `nodenext`, and `bundler`. Legacy `node` resolution does not read
`exports` at all. It falls back to `main`, finds `dist/src/core/index.d.ts` beside it, and
types `@orkestrel/mcp` — so the root import compiles. It has no such fallback for a
subpath, and no `typesVersions` map redirects one, so `@orkestrel/mcp/browser` and
`@orkestrel/mcp/server` both fail to resolve. A top-level `types` field would not change
that: it names the root's declarations, which legacy resolution already finds.
`tests/distribution.test.ts` compiles a consumer importing every face under each
resolution mode, and that consumer is the executed form of this paragraph — `node16`,
`nodenext`, and `bundler` compile, `node` does not. **Who it affects:** a consumer whose
`moduleResolution` is `node` and who imports either environment face, and nobody else.
**Closer:** a `typesVersions` map naming the `./browser` and `./server` subpaths, which this package has not
added, because the supported floor is `node16`.

**API Extractor bundles TypeScript 5.9.3 while this project compiles with 6.0.3, so
`build` prints a version notice once per built face.** The exact line is:

```text
*** The target project appears to use TypeScript 6.0.3 which is newer than the bundled compiler engine; consider upgrading API Extractor.
```

It is informational and not an error. `build` exits 0, every declaration is emitted, and a
generated consumer type-checks against the shipped declarations: `dist/src/browser/index.d.ts`
and `dist/src/server/index.d.ts` import core through the published `@orkestrel/mcp`
specifier and carry no source-path specifier. The pin is transitive — the lockfile pins
`@microsoft/api-extractor`'s own nested TypeScript at 5.9.3 — so no direct dependency of
this package selects it. **What it costs:** a line of build noise per built face, plus the risk that
a TypeScript 6 construct the bundled 5.9.3 engine cannot parse would surface as a
declaration defect rather than a compile error. Nothing in this package has reached that.
**Closer:** an API Extractor release bundling TypeScript 6.

**Source maps ship.**
The `.map` files carry it, one per built output: core ESM and CJS, server ESM and CJS,
and browser ESM. They are kept on purpose. A consumer debugging a protocol library steps
into real source rather than a bundle, and the frames that matter when a wire fault
reaches a consumer are inside this code. Measured with `npm pack --dry-run --json` on
2026-08-20, the maps are 1,168,764 of 2,543,024 unpacked bytes (46.0 percent).
**What it costs:** those 1,168,764 unpacked bytes on disk.
**Closer:** none wanted — dropping them is a size decision this package has declined.

## Contract

The normative reference, placed here because it is the least narrative thing in this guide. These
invariants hold across the MCP layer (`src/core` + `src/server` + `src/browser`) ↔
`mcp.md`; where a sentence earlier in this guide summarizes one, the clause below is
the exact statement:

1. **doc ↔ source bijection.** Every `function` / `class` / `const` /
   `interface` / `type` row in the `## Surface` tables (the core dispatch
   tables and the `### HTTP transport` + `### WebSocket transport` + `### stdio
transport` tables) is a real export of the mcp layer (`src/core` or
   `src/server`), and every export of either appears as a Surface row —
   exhaustive, both directions.
2. **JSON-RPC 2.0 envelope.** A `dispatch` response is always `{ jsonrpc:
'2.0', … }` with EXACTLY ONE of `result` / `error`. The success arm always
   carries an `id`, echoing the request's, because a result answers a request and
   a request always has one. The error arm is the only arm whose `id` may be
   missing, and it is then omitted — the member is absent from the envelope, never
   present as `null` — which is what a `handle` parse or invalid-request failure
   produces, because neither could read an id to echo. MCP overrides JSON-RPC 2.0 §5
   here, and `JSONRPCErrorResponse` states it: `id?: JSONRPCId`, where `JSONRPCId`
   admits no `null`.
   `handle` serializes that envelope with `JSON.stringify` and returns the
   string. A HELD-OPEN answer is the other arm of the same return: `dispatch`
   resolves an `MCPStream` and `handle` its serialized `MCPTextStream` mirror,
   narrowed apart at one point (`Symbol.asyncIterator in result`). The stream's
   `return` value is the terminating response and obeys this same envelope, and its
   `yield` type is `JSONRPCNotification`, so no stream can carry a call the peer is
   expected to answer.
3. **Notifications yield no response.** A call with no `id` is a
   `JSONRPCNotification`, a type distinct from `JSONRPCRequest` and unassignable to
   it: `dispatch` emits `request` (whose id argument is `undefined`, beside the
   structural era) and then
   resolves `undefined` whatever the method (`ping`, `notifications/initialized`,
   an unknown method — all silent); `handle` returns `undefined`. Neither era
   branch ever runs for a call without an `id`.
4. **The legacy methods, and they live in `MCPLegacy`.** The decorator owns the
   whole fixed set. [The package guide suite](../tests/guides.test.ts) checks every
   declared legacy-ingress owner against the removal membership in both directions
   and requires `MCPServer.ts` to carry no `MCPLegacy` or `legacy` spelling.
   Dispatch tests separately prove that unstamped legacy requests never take a
   server-owned era branch. `ping` is answered locally because the modern registry
   does not contain it. `tools/list` and `tools/call` are translated onto the modern engine — they acquire modern request
   metadata, run through the same dispatcher, and are projected back unstamped — so
   they inherit the modern engine's execution port, cancellation, bounds, and
   validation rather than running beside them. `initialize` → `{ protocolVersion,
capabilities: { tools: {} }, serverInfo: { name, version } }`, the version negotiated over the
   legacy subset only: the client's `params.protocolVersion` is echoed when it is a
   supported legacy revision, and every other request — the modern `'2026-07-28'`,
   an unsupported revision, a non-string, or an absent one — falls back to the
   newest supported legacy revision (`MCP_HANDSHAKE_VERSION`, `'2025-11-25'`). A
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
   narrowed with `@orkestrel/contract`'s guards (no `as`); a missing /
   non-string `name` → a `-32602` invalid-params error. Otherwise it runs
   `tools.execute({ id, name, arguments, ...(options.caller === undefined ? {} : { caller: options.caller }) })`
   under the modern and legacy wire eras, so a present asserted caller reaches the real tool body while
   absence preserves the former `ToolCall` shape exactly. Because the `ToolManager`
   (`@orkestrel/tool`) already isolates a thrown tool (and an unknown name)
   into a `success: false` result, the server adds no try/catch: that branch's
   `error` maps to `{ content: [{ type: 'text', text: <error> }], isError: true }`;
   a valued `success: true` branch maps to `{ content: [{ type: 'text', text:
JSON.stringify(value) }], structuredContent: value }`, carrying the value unchanged
   alongside the backwards-compatible text. A value-less success retains the required
   empty text block and omits `structuredContent`.
6. **One modern seam, subscriptions included, and `-32601` for anything off it.**
   `server/discover`, `tools/list`, `tools/call`, and `subscriptions/listen` are registered on `server.methods` at
   construction — unconditionally, because they need no consumer port — and
   `resources/list` / `resources/read` / `resources/templates/list`,
   `prompts/list` / `prompts/get`, and `completion/complete` are registered there too,
   each only when its own `resources` / `prompts` / `completion` option was supplied,
   and each advertising its capability (`resources`, `prompts`, `completions`) on the
   same condition. `completions` is independent of `resources` and `prompts`. An omitted port
   registers nothing and advertises nothing, so its methods answer `-32601` through the
   ordinary unregistered path, and a server configured with none of them has a
   byte-identical discovery answer to one built before they existed.
   Every modern method is resolved from there — `add` under an
   existing name replaces it, so a consumer's override wins by ordinary
   registration rather than by a precedence rule, and there is no second
   dispatch path. An id-bearing request whose method resolves to `undefined`
   (modern) or falls off `MCPLegacy`'s fixed set resolves a
   `JSONRPC_METHOD_NOT_FOUND` error whose message names the method. The modern
   metadata checks (`-32602`, `-32022`) run before the seam is consulted, and a
   legacy method never reaches it — the decorator answers or refuses at its own
   door, and only its translated methods travel on. The seam carries the request arm:
   dispatch short-circuits every notification before the registry is read, so no
   registered handler is ever invoked for one, and a handler that nevertheless
   resolves nothing for a request is contained as `-32603` plus exactly one
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
   JSON) → a serialized `-32700` (Parse error) response with no `id` member; a
   message above `limit.message` reaches that same response before `JSON.parse`;
   `_meta` is then bounded by serialized bytes, total object keys, and depth
   before modern context parsing; `requestState` is bounded before HMAC verification
   and before/after signing; the complete produced modern tool-call result—including stamps,
   metadata, and duplicated text/structured representations—is bounded before serialization; and
   built-in subscription admission is capped until each stream's `finally` releases it.
   Metadata/state failures use `-32602`; content/capacity failures use `-32603`. A
   parsed value that is not a valid invocation (a response, or any non-message)
   → a serialized `-32600` (Invalid Request) response with no `id` member. The
   raw-string parse is the only `try`/`catch`; the guards (`parseJSONRPCMessage`
   over `isJSONRPCMessage`) are total and never throw.
8. **Total wire guards.** `isBoundedString` / `isBoundedJSON` / `isJSONRPCId` /
   `isJSONRPCRequest` / `isJSONRPCNotification` / `isJSONRPCInvocation` /
   `isJSONRPCResultResponse` / `isJSONRPCErrorResponse` / `isJSONRPCResponse` /
   `isJSONRPCMessage` / `isMCPResult` / `isMCPLegacyResult` /
   `isInitializeRequest` / `isMCPSubscriptionFilter` are total functions over an
   already-parsed `unknown` — adversarial input returns `false`, never
   throws. `isBoundedJSON` is iterative and rejects excessive depth, cycles,
   accessors/hostile proxies, `Map`/`Set`, and non-JSON values while accepting
   hostile-looking own data keys. Each pair of arms is mutually exclusive on every
   input, so a positive answer names exactly one arm: `isJSONRPCRequest` requires
   a valid `id` and `isJSONRPCNotification` requires no own `id` member; a result
   response requires an `id` and an object `result` with no `error`, while an error
   response permits an absent `id` and requires an `error` with no `result`;
   `isMCPResult` requires a string `resultType` and `isMCPLegacyResult` requires
   its absence. `null` is refused as an `id` everywhere — `isJSONRPCId` accepts a
   string or a finite integer and nothing else — and numeric ids and error codes are
   finite integers. `parseJSONRPCMessage` returns a frozen owned snapshot;
   every non-`undefined` output satisfies `isJSONRPCMessage` and shares no caller-owned graph.
9. **The core is provider-agnostic, no transport.** `src/core` imports only
   `@orkestrel/emitter`, `@orkestrel/tool`, `@orkestrel/contract`, and
   `@orkestrel/codec` (plus, for the client's per-request deadline,
   `AbortSignal.timeout`) — never `@orkestrel/server`, `@orkestrel/router`, `@orkestrel/sse`, or
   `@orkestrel/websocket` — and carries no transport, no HTTP, and no model.
   Both the dispatch core (the server) and the client live here,
   transport-abstract; every transport lives one layer out in `src/server`
   (clauses 12–20): the ingress transport pumps message bodies through
   `dispatch`, the egress transport drives a remote server, and the session /
   version header names are reserved there, not in the core.
10. **Observable.** The `MCPServer` owns an `emitter` (`MCPServerEventMap`)
    and fires `request` (method, the id or `undefined` for a notification, era) at the top of every `dispatch`,
    before the method runs, and `error` exactly once for every operational fault it
    contains — a throwing execution provider, registered handler, subscription source,
    continuation, or principal — carrying the caught value the wire never sees; the
    emitter isolates a listener throw, routing it
    to its own `error` handler (the `error` option, surfaced as `(error,
event)`, not a domain event) — so a buggy observer can never corrupt a
    dispatch, and a throwing `error` handler neither escapes nor recurses.
11. **doc ↔ source method bijection.** The `## Methods` tables list exactly
    the public methods of each behavioral interface — `MCPServerInterface`,
    `MCPMethodManagerInterface`, `MCPClientInterface`,
    `MCPMessageTransportInterface`, and `MCPSessionInterface`, plus the
    consumer-supplied ports this package defines and does not implement
    (`MCPTaskManagerInterface`, `MCPResourceManagerInterface`,
    `MCPPromptManagerInterface`, `MCPCompletionInterface`, which have tables
    but no implementing class here, exactly because the host writes the class) —
    exhaustive, both
    directions, so the client's table carries `discover` alongside `connect` /
    `disconnect` / `tools` / `call`, and each implementing class (`MCPServer` /
    `MCPClient`; the adapter `MCPLegacyClientTransport`; the transports `HTTPClientTransport`
    (`src/core`), `WebSocketServerTransport` / `WebSocketClientTransport` /
    `StdioClientTransport` / `StdioServerTransport` (`src/server`), and the browser face's
    own `WebSocketClientTransport`
    (`src/browser`), each implementing the one `MCPMessageTransportInterface` —
    `StdioClientTransport` through the narrower `StdioClientTransportInterface`
    that extends it; and `MCPSession`) exposes the same public methods, no more. The
    `HTTPDisconnect` entity exposes only `bridge` (its `signal` is data). The remaining
    exports add no behavioral interface with methods (the factories,
    `acceptsEventStream` / `readSessionHeader` /
    `readLastEventId` / `rejectUnknownSession` / `readEventStream` /
    `decodeEvent` / `upgradeRequestPath` / `extractLines` / `dispatchLines` /
    `createScopeMessageListener` are functions; the options interfaces / event
    maps / `MCPSessionEvent` / `LineExtraction` are bags;
    `StdioClientTransportInterface` extends `MCPMessageTransportInterface` with
    the readonly `evidence` data member and declares no call signature of its
    own, so that member is a `## Surface` Types row), so they contribute
    no `## Methods` row. `MessagePortTransport` (`src/browser`) is likewise
    excluded: it implements `MCPTransportInterface`, not
    `MCPMessageTransportInterface`, and `MCPTransportInterface` itself is
    documented as a `## Surface` Types bag (its members are arrow-typed
    properties, `readonly send: (message) => …`, not method syntax) rather than
    a `## Methods` group — the same treatment `bindServer`/`bindClient`'s test
    doubles already give it, so `MessagePortTransport` (and
    `createScopeTransport`'s returned `ScopeTransportInterface`) add no new
    `## Methods` row either, consistent with that existing precedent.
12. **The HTTP transport route is stateless mechanism (`src/server`).**
    `createMCPRoutes(mcp, options?)` returns a single `POST {path}` route
    (`path` default `DEFAULT_MCP_PATH`). The handler is self-contained (its
    own JSON-parse `try`/`catch`) and draws a sharp line: a TRANSPORT-level
    failure — malformed JSON (`-32700`) or a parsed value that is not a
    JSON-RPC request (`-32600`, narrowed with `parseJSONRPCMessage` + `'method'
in request`, no `as`) — is HTTP **400** with a JSON-RPC error body carrying no
    `id` member. A legacy dispatch result — success or in-band JSON-RPC error — is
    HTTP **200**. A modern result is **400** for `-32020` / `-32021` / `-32022`
    / `-32602`, **404** for `-32601`, and **200** otherwise; every notification
    is **202** with no body. Modern `MCP_PROTOCOL_VERSION_HEADER` and
    `MCP_METHOD_HEADER` values must equal the body; `MCP_NAME_HEADER` is required
    for `tools/call` and `prompts/get` against `params.name` and for `resources/read`
    against `params.uri`, decoded through `decodeSentinel` before the comparison. The
    first missing or mismatched field is named with its
    derived expectation, never its client-supplied value; the result is **400** +
    `-32020` with no `data`. A modern `MCP_PROTOCOL_VERSION_HEADER` over a body with no
    parsable modern `_meta` is **400** + `-32602` instead of the legacy `-32022`.
    A modern `tools/call` is additionally held to the `MCP_PARAM_PREFIX` headers its own
    served definition annotates: the handler dispatches `tools/list` through the same
    dispatcher, reads the named tool's `inputSchema` with `extractToolSchema`, derives the
    projections with `buildHeaderParameters`, and refuses through `inferParameterRefusal`
    with the same **400** + `-32020` for a recognized header that is absent while the body
    supplies its value, one whose payload is not a valid Base64 sentinel, one whose decoded
    value disagrees, and one asserting a value the body omits. An `integer` parameter
    compares numerically. A `MCP_PARAM_PREFIX` name no served definition annotates is
    forwarded untouched, and a definition whose annotations are invalid recognizes none.
    The lookup follows `nextCursor` through at most `MCP_LOOKUP_PAGES` pages, so a
    replacement `tools/list` that pages the named tool further in than that recognizes
    none either; each page dispatched fires the `request` event under the reserved id `0`.
    Headerless `initialize` is accepted; a live-session legacy request uses its
    pinned negotiated revision; every other headerless request is **400** +
    `-32020`. A request without `Origin` is allowed; a canonical `localhost`, `[::1]`,
    or `127.0.0.0/8` literal origin is allowed by default; every other present
    serialized origin requires an exact consumer-supplied `origin.origins` entry or
    receives **403**. The predicate reads only `Origin`, never the request URL, `Host`,
    or another request header. `origin.enabled: false` explicitly delegates validation
    to an upstream layer. When `streaming` is enabled (default `true`) and the client
    `Accept`s `text/event-stream` (`acceptsEventStream`), the 200 reply is one
    SSE `data:` event over `@orkestrel/server`'s `createStream` seam, then the
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
    `createMCPRoutes` mints / reads no
    session id. It is mechanism, not policy: auth / rate-limiting / sessions
    compose in front as ordinary middleware; origin policy is only the
    consumer-provided list.
13. **The client is the modern-only egress mirror (`src/core`).**
    `createMCPClient({ transport, identity?, capabilities?, version?, timeout?,
on? })` drives a REMOTE server over an injected `MCPMessageTransportInterface`
    (transport-abstract, like the server). `connect()` issues a modern
    `server/discover` carrying `_meta` with the offered revision,
    client capabilities, and client identity. It intersects the peer's
    `supportedVersions` with `SUPPORTED_MODERN_PROTOCOL_VERSIONS` in local preference
    order and stores the newest match. A `-32022` reads `error.context.supported`
    and, when unpinned, retries discovery under a new monotonic id only when that
    set contains a supported modern revision. A legacy-only offer is never stamped
    into modern `_meta`. `-32601` rejects with an `MCPError` whose message names
    `createMCPLegacyClientTransport`; every other discovery failure surfaces as itself. A discovery advertisement
    that omits a pinned modern revision also rejects. A rejecting `connect()` closes the connection that
    attempt opened, unless the `disconnect` that superseded it closed that
    connection first. The bare client sends no initialization notification. The readonly `version` surface exposes the negotiated
    revision while connected and is `undefined` while disconnected. A parseable discovery
    response is validated as modern, so a malformed or unsupported result type surfaces directly.
    `discover()` exposes a validated modern discovery result,
    filtering unknown advertised revisions from its `MCPVersion` collection. It validates the
    exact open server-capability shapes and exact metadata before returning, rejects malformed
    known fields or extension identifiers/values, and snapshots accepted capability/metadata
    records with the installed exact JSON clone primitive so transport-owned objects cannot drift.
    `tools()` runs `tools/list` and wraps each descriptor as a
    local `ToolInterface` — `name` narrowed (`isString`), `inputSchema` mapped
    back to `parameters` (the inverse of the `parameters` → `inputSchema` rename, no `as`),
    `execute` bound to `call(name, …)`. `call(name, args)` runs `tools/call`,
    concatenates the result's `text` content blocks and throws an `Error` carrying the text when
    `isError === true`, else `JSON.parse`s the text (raw-string fallback;
    empty → `undefined`); so a remote tool failure throws locally and an
    agent's `ToolManager` isolates it into a `success: false` result exactly
    like a local throw. `disconnect()` rejects every pending request, clears
    negotiated revision, closes the connection the client opened on the
    transport — an attempt it supersedes inside `start()` owns none yet and
    closes what it opens itself — and fires `disconnect` only where the client
    had announced `connect`, without clearing the selected modern offer. The wait
    on that `close` carries the per-request deadline, the only bound that
    reaches it: a shutdown the transport accepts and never answers rejects its
    caller instead of holding `disconnect` and every later `connect()` for the
    process's life. The deadline ends the wait, never the close — a fault says
    the shutdown did not happen, a deadline says only that this client stopped
    waiting to hear whether it did — so the still-running close is retained and
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
    and one issued while a close is still owed settles that connection first —
    rejecting with the fault if it fails or goes unanswered again — so `start()`
    is never called beside a connection an earlier close did not close.
14. **Client correlation + deadline + notifications.** Each request is
    tagged with a monotonic numeric `id`; a single transport `message`
    subscription resolves / rejects the matching pending request by `id`
    (an `error` response rejects with `MCPError`, a complete `result` resolves) —
    concurrent requests each route to their own pending. `MCPError`
    preserves the peer's human message, numeric `code`, and optional
    `error.data` as `context`; local disconnect and timeout failures
    remain plain `Error`s. An absent `resultType` and `'complete'` both mean a
    complete result; every other value rejects with `MCPError` using the message
    `MCP result type '<value>' is not supported`, so input-required, task, and
    unknown results can never be consumed as fabricated tool output. A message
    that is not a correlated response is
    a server notification, re-surfaced on the `notification` event. Every
    ordinary request races `AbortSignal.timeout(timeout)` (never a raw
    `setTimeout`; default `DEFAULT_MCP_REQUEST_TIMEOUT`): a server that
    never replies rejects the pending request (`timed out`) rather than
    hanging. The discovery probe carries the same request deadline: an omitted
    `timeout` selects `DEFAULT_MCP_REQUEST_TIMEOUT`, and a configured one
    applies to the probe as to every request. A public `discover()` call uses
    the ordinary request deadline. A peer that answers `server/discover` with `-32601` produces
    the adapter-naming error immediately. A peer that accepts the probe and answers
    nothing surfaces the request timeout after the configured deadline. Legacy handshake
    timing belongs to the explicit adapter, whose deadline also bounds its response
    and writes. A `send` write failure rejects
    its own pending request. The same `timeout` bounds the client's wait on the
    transport's `close`: that await holds no pending entry, so neither the drain
    nor a request deadline reaches it, and a shutdown accepted and never answered
    would otherwise wedge the client. Because it bounds the wait and not the
    close, a short `timeout` set for fast request-failure detection is also a
    short shutdown grace.
    Observable: the client owns an `emitter` (`MCPClientEventMap`) firing
    `connect` / `disconnect` / `notification` / `error`; the emitter
    isolates a listener throw, routing it to its `error` handler (the
    `error` option, not a domain event). Consumers subscribe through `emitter.on`.
15. **The HTTP client transport drives a remote server over `fetch`
    (`src/server`).** `createHTTPClientTransport({ url, headers?, fetch?,
timeout? })` returns a `MCPMessageTransportInterface` whose `send` POSTs one
    JSON-serialized message to `url` with `content-type:
application/json` and an `Accept` of BOTH `application/json` and
    `text/event-stream` (plus any `headers`), then decodes the reply and
    emits each carried `JSONRPCMessage` on the `message` event: an
    `application/json` body is narrowed with `parseJSONRPCMessage`; a
    `text/event-stream` body is decoded with `@orkestrel/sse`'s `SSEParser`
    (`readEventStream`); a `202` (a notification accepted) carries no body
    and emits nothing. It is total at the boundary: a non-message success reply is
    dropped, never asserted; a non-success reply with no valid JSON-RPC message rejects
    `send` with its HTTP status and body shape, while a valid JSON-RPC error body is emitted
    at any status. A guarded server requires the consumer to supply its bearer through
    `headers`; the transport does not mint or refresh credentials. A `fetch` / decode failure
    on a success response surfaces on the `error` event rather than escaping `send`. `fetch` defaults to
    `globalThis.fetch` (injectable). Every `fetch` call carries a `signal`,
    with or without a `timeout`: `send` mints one `AbortController` per
    exchange and holds it in a pending set, so `close()` aborts the fetch and
    the body read behind it. With no `timeout` the signal is that controller's
    alone; with one it is
    `AbortSignal.any([close, AbortSignal.timeout(timeout)])`, so whichever
    fires first ends the same fetch and the same read. `start` / `close` hold
    no long-lived connection. It echoes the session, as the sessions clause states: an
    `mcp-session-id` response header, when a stateful server sends one (on
    `initialize`), is captured into `session` and then sent as the
    `mcp-session-id` request header on every subsequent request — so an
    `MCPClient` passes a stateful server's validation with no caller wiring;
    before `initialize` returns an id, `session` is `undefined` and no header
    is sent (safe against a stateless server). It also recognizes a decoded
    result whose `result.protocolVersion` is a supported string, captures that
    negotiated value, and sends `MCP_PROTOCOL_VERSION_HEADER` on every subsequent
    legacy request. The initialize POST itself carries no protocol header, and
    legacy requests never carry `Mcp-Method` or `Mcp-Name`. A modern request derives
    `MCP_PROTOCOL_VERSION_HEADER` and `MCP_METHOD_HEADER` directly from its `_meta`
    version and method, plus `MCP_NAME_HEADER` only for `tools/call`, whose value rides
    through `encodeSentinel`; no widened `send` contract is needed. It also runs SEP-2243's
    `x-mcp-header` contract from the traffic it already carries: a delivered `tools/list`
    result has each tool's projections cached through `buildHeaderParameters` and every
    invalidly annotated definition dropped before the caller sees it, with the exclusion
    reported on `error` naming the tool; a later `tools/call` for a cached tool carries the
    `MCP_PARAM_PREFIX` headers `buildHeaderProjection` derives from that table and the
    call's own `arguments`, and a `tools/call` for a tool no listing carried projects
    nothing. A `tools/list` sent with no `cursor` replaces that table with its own page; one
    sent with a `cursor` accumulates onto it, and a listing another cursorless `tools/list`
    supersedes before its answer arrives is delivered to the caller but never cached. The
    captured headers are merged before `options.headers`, so a caller-supplied key wins.
16. **The WebSocket transport is the full-duplex ingress over the spine
    upgrade seam (`src/server`).** `createWebSocketServer(mcp, options)`
    returns an `UpgradeHandler` (`@orkestrel/server`) to register with
    `server.upgrade(...)`; it composes `@orkestrel/websocket`'s RFC 6455
    wrapper over the spine's generic upgrade seam. It declines (returns
    `false`) when the `Upgrade` header is not `websocket`, the request path
    (`upgradeRequestPath`) is not `options.path` (default `DEFAULT_MCP_PATH`),
    the `Sec-WebSocket-Key` is absent, or the `Sec-WebSocket-Version` is not
    `13`. Otherwise it claims (returns `true`): `createNodeWebSocket({
socket, key, head, protocol })` (SERVER mode → writes the `101` handshake,
    selecting the configured subprotocol only when the client's offer contains it,
    and sends unmasked frames), wraps it in a `WebSocketServerTransport`, and
    pumps — each inbound `JSONRPCMessage` that `isJSONRPCRequest` runs
    through `mcp.dispatch`, a defined response written back as a frame (a
    notification → `dispatch` `undefined` → nothing sent); a non-request
    message is ignored; a `dispatch` / `send` fault surfaces on `mcp.emitter`'s
    `error` event rather than escaping the async listener, and a peer whose
    disconnect fires this transport's `close` is aborted by `bindServer` before
    any response is written, so that disconnect costs no frame and raises no
    unhandled rejection (a peer that vanishes without a close frame or a socket
    fault leaves `readyState` at `OPEN` and is not detected — that needs an
    RFC 6455 ping/pong liveness deadline this transport does not run).
    `WebSocketServerTransport` Reuses `MCPMessageTransportInterface` (`session`
    `undefined`, `start` arms the socket subscriptions, `send` writes one
    text frame per message, `close` closes the socket): inbound text frames
    are `JSON.parse`d (guarded) + narrowed with `parseJSONRPCMessage` onto
    `message`, a malformed / non-message frame surfaces on `error` and is
    dropped, and the socket's `close` bridges to the transport's `close`. A
    socket write is unconfirmed, so a closed channel is answered from the
    transport's own state and the socket's `readyState`: a `send` after
    `close()`, after the peer's close, or on a socket that is not `OPEN`
    rejects with `WebSocket transport is not connected`, writing nothing. It
    also owns what it claimed: the handler holds every live transport and, on
    `options.emitter`'s `stop` event (the spine's own emitter, required),
    `close`s each one — the RFC 6455 close handshake, never a destroy. Node
    detaches an upgraded socket from the connection set the spine's close
    walks, so nothing else can end it: without this the spine's `stop()`
    spends its whole `drain` budget and then cuts the connection
    mid-protocol. A transport drops out of the held set on its own `close`,
    so a peer that already vanished neither throws nor delays the stop.
17. **The WebSocket client transport drives a remote server over an upgrade
    (`src/server`).** `createWebSocketClientTransport({ url, headers? })`
    returns a `MCPMessageTransportInterface` — the WebSocket egress mirror of the
    WebSocket ingress clause. `start()` (run by `client.connect()`) performs the RFC 6455
    client handshake: a `node:http`(`s`) `GET` carrying `Connection: Upgrade`
    / `Upgrade: websocket` / a random `Sec-WebSocket-Key` /
    `Sec-WebSocket-Version: 13` / `Sec-WebSocket-Protocol: mcp` (plus any
    `headers`), awaiting the client `'upgrade'` event and validating
    `Sec-WebSocket-Accept === computeWebSocketAccept(key)`
    (`@orkestrel/websocket`) — a mismatch / a non-`101` response / a request
    error rejects `start()` (the socket destroyed), with one exception: a
    request error raised after this transport's own `close()` resolves
    `start()` instead, because the caller asked for the transport to end and it
    has. A handshake that completes after a `close()` or a second `start()`
    resolves the same way, destroying the socket nobody wants rather than
    binding a second peer. On success it wraps the upgraded socket in
    `createNodeWebSocket({ socket, head })` (client mode — no key → frames
    masked) and bridges its frames as the client's `message` channel (decoded +
    narrowed with `parseJSONRPCMessage`). `send` writes one masked text frame
    per message, and a socket write is unconfirmed, so a closed channel is
    answered from the transport's own state and the wrapper's `readyState`: a
    `send` with no bound socket — before `start()`, after `close()`, or after
    the peer ended the socket — and a `send` on a bound socket that is not
    `OPEN` both reject with `WebSocket transport is not connected`, dropping
    nothing and queueing nothing. The second arm is the one the transport's own
    flag cannot reach: a peer close riding in with the handshake is decoded
    inside `createNodeWebSocket`, before this transport binds a listener, so the
    socket it installs is already past `OPEN` while its own state says nothing
    happened. `close()` destroys an upgrade request still on the wire,
    unsubscribes from the socket, closes it, and fires `close` (idempotent —
    a second call on the same closed lifetime releases nothing and emits
    nothing). `url` accepts `ws://` / `wss://` or `http://` / `https://` (a
    `ws(s)` scheme is converted to `http(s)` for the underlying request;
    `wss` → TLS through `node:https`).
18. **Sessions are an opt-in native middleware on the HTTP transport
    (`src/server`).** `createMCPSession({ path?, ttl?, session?, clock?, origin?, keepalive? })`
    returns a `MiddlewareHandler<TState>` (`TState extends MCPSessionState`)
    that owns its own closure `Map<string, { session: MCPSession; touched:
number; version: MCPVersion }>` — NO dependency on `@orkestrel/middleware` and no shared
    session primitive; the store, mint, and validation are all native to
    this package. Compose it with `router.use(createMCPSession())` in front
    of a session-agnostic `createMCPRoutes(mcp)`; it owns its `path` (default
    `DEFAULT_MCP_PATH`, MUST match the route's) — a request to any other path
    passes straight through (`next()`). With a `ttl`, a session not touched
    within `ttl` ms is lazily evicted on the next access (no background
    timer). Session-owned verbs apply the same origin gate as the route, consuming the same
    `MCPOriginOptions` value; a rejected origin returns **403** before session lookup or minting,
    while `enabled: false` delegates each site to an upstream validator. A
    modern-shaped POST passes straight through with `next()`, ignoring
    `Mcp-Session-Id`. Otherwise, for its `path`, it makes the legacy transport
    stateful across its verbs: a `POST` buffers `await request.text()` — resolves a session through
    `readSessionHeader`; a valid id touches the entry and sets
    `context.state.session`; an absent / unknown id whose (guarded) body
    parses to an `initialize` request (`isInitializeRequest`) mints a fresh
    `MCPSession` (`crypto.randomUUID()`, the `session` knobs), pins the negotiated legacy
    revision, and sets
    `context.state.session`; neither → `rejectUnknownSession()` (`404`). It
    then forwards a fresh `Request` carrying the buffered text
    (`next(forwarded)`) — never the already-consumed original — so the route
    re-reads the same body, retains front-middleware state for caller extraction,
    injects that pinned revision when a live-session POST
    is headerless, and stamps the response with `MCP_SESSION_HEADER`. A
    live-session POST whose `MCP-Protocol-Version` header names a different
    revision than the session pinned is `400` + `-32020` — a session negotiates its
    revision once, and a later request may not renegotiate it.
    A `GET {path}` resolves the session the same way (no mint) and opens the
    resumable stream the resumable-push clause states; an invalid / unknown id is the same `404`.
    A `DELETE {path}` resolves the session, deletes it from the store and
    answers `204`, or the same `404` when invalid / unknown. The WebSocket
    and stdio transports are inherently one session per connection, so this
    middleware does not apply to them.
19. **Resumable server→client push is the GET-SSE channel, folded into
    `MCPSession` (`src/server`).** Each `MCPSession` folds in its own bounded
    replay log — a plain in-memory `Map` + capacity + lazy-TTL eviction,
    private to the entity — built with `createMCPSession`'s `session.capacity`
    (default `DEFAULT_MCP_SESSION_CAPACITY`) and `session.ttl` (default
    `DEFAULT_MCP_SESSION_TTL`). The lazy sweep reads `session.clock`, which
    defaults to the middleware's own `clock`, so one injected clock governs the
    store sweep and the log sweep alike. `session.push(message)` Appends the message to
    the log under a monotone base36 event id (returned), evicting the oldest
    past `capacity` + any entry older than the per-event TTL, and fans the
    message out to every `attach`ed open stream as `stream.write({ id, data:
JSON.stringify(message) })`. `session.replay(afterId)` returns every
    retained log entry strictly after `afterId` in append order — an unknown
    / evicted cursor replays nothing. The `createMCPSession` middleware
    serves the resumable `GET {path}`: it validates the `mcp-session-id`
    (the same **404** the sessions clause states on a missing / unknown id), opens
    `createStream()` (`@orkestrel/server`), reads `Last-Event-ID`
    (`readLastEventId`) and replays `session.replay(lastEventId)` onto the
    stream first, then `session.attach(stream)`, then detaches on the composed
    request / response-stream `AbortSignal` firing (or immediately if already
    aborted). Its configured keepalive bounds idle disconnect detection to one
    interval. The stream is long-lived — it is never `end()`ed by the middleware.
20. **The stdio transport is newline-delimited JSON-RPC over process stdio
    (`src/server`).** `createStdioServer(mcp, options?)` wraps
    `options.input` (default `process.stdin`) / `options.output` (default
    `process.stdout`) in a `StdioServerTransport` and pumps: each inbound
    `JSONRPCMessage` that is a request runs through `mcp.dispatch`, a defined
    response written back as a newline-terminated line after the output completion
    callback confirms it (a notification writes nothing); a non-request message is ignored; a
    `dispatch` / `send` fault
    surfaces on the transport's `error` event. `stop()` unbinds that pump and
    closes the transport, which removes the listeners `start()` put on
    `input` and `output`, rejects every pending send, preserves the caller's flowing or
    non-flowing state and listeners,
    and pauses `input` only when this transport started a non-flowing stream
    and no other `data` listener remains — so a stopped server lets the
    process exit instead of holding `process.stdin` open. It never destroys or
    ends the injected streams; they belong to the caller. A `send` after closure
    rejects `stdio transport is not connected`. An initially unread
    stream closes at `readableFlowing === false`, not `null`, because Node exposes
    no public operation that restores the untouched state after consumption. A
    later `data` listener does not resume that stream; the caller must call
    `resume()` before the listener receives data.
    `createStdioClientTransport(options)` builds one supervised
    `@orkestrel/process` `Process` over `options.command` and `options.args`.
    That supervisor spawns with `stdio: ['pipe', 'pipe', 'pipe']`, so the
    child's `stderr` is piped and retained as a bounded tail rather than
    inherited by the parent. A provided `env` merges over `process.env` rather
    than replacing it: each named key overrides the inherited value and every
    unlisted key is still inherited, so `env: { TOKEN: 'x' }` hands the child
    the parent's whole environment plus `TOKEN`. This transport exposes no way
    to withhold `process.env` from the child — spawn only a child you trust
    with everything this process holds. Scrubbing the parent's own
    environment first is not a substitute on Windows: the host injects its own
    baseline keys into every child regardless of the supplied `env`, and
    deleting `SystemRoot` from `process.env` aborts the next spawned Node
    child at startup with exit 134. `createStdioClientTransport` returns a
    `StdioClientTransportInterface`, whose `evidence` member is the reader for
    that bounded tail. It answers `undefined` before the first `start()` has
    spawned anything; the held child's live tail while that child runs, which
    reads `''` from the spawn until the child writes; and the tail the
    supervisor froze at that child's terminal moment afterwards, whether the
    child exited on its own or `close()` ended it. A child that ran and wrote
    nothing answers `''`, which says a child ran and reported nothing — a
    different fact from the `undefined` that says none ran. The transport keeps
    reading that same child past its end, and the frozen value never moves
    again, so a detached descendant holding the inherited `stderr` can write
    after `close()` resolves and those bytes reach no reading this transport
    reports. What the frozen tail holds is what the supervisor had received by
    that moment, rather than the child's complete output: Windows ends the tree
    with `taskkill /F /T`, which nothing in the child can intercept, so a
    `SIGTERM` handler never runs there and the bytes it would have written never
    exist. A child that exits on its own closes its `stderr` first, so that tail
    is complete. Where the terminal moment arrived at the supervisor's `drain`
    bound rather than at the child's own stream close, the tail stops at that
    cutoff and later diagnostics may have existed; the transport emits an
    `error` naming that lifetime, so a partial tail reads as partial. The next
    `start()` opens a lifetime and replaces the held child, so a respawning
    transport never reports the previous child's stderr as the current child's —
    immediately after that second `start()` the reading is `''`, the replacement
    child's empty live tail. Read a tail you want across a respawn before you
    open the replacement: after a natural exit a `close` listener that calls
    `start()` opens that next lifetime inside the emit and replaces the value
    every listener after it would have read, while after an explicit `close()`
    that listener's `start()` parks behind the teardown barrier and the later
    listeners still read the ended child's frozen tail.
    Lifetimes never overlap — a `start()` issued while a `close()` is still
    tearing down waits for that teardown to report `close` — so an older
    child's tail cannot arrive over a replacement's however the calls interleave.
    The bound is the supervisor's `PROCESS_EVIDENCE` — at most 2048 raw bytes
    under `@orkestrel/process` 0.0.6 — and it keeps the end of the stream, so a
    long-running child's early output is dropped and its last error survives.
    It counts encoded bytes rather than decoded characters: a run of two-byte
    characters fills those 2048 bytes with 1024 characters. The kept bytes never
    begin inside a multibyte sequence, so a run of three-byte characters keeps
    2046 bytes and 682 characters rather than cutting one in half. A spawn the
    host refuses reads `''`, and its cause arrives on the `error` event this
    transport already forwards.
    `send` writes `JSON.stringify(message) + '\n'` per message to the
    child's `stdin` and awaits the supervisor's answer, rejecting when that
    answer refuses the line. The refusals carry different messages: a call made
    with no live child rejects `stdio transport is not connected`, while a live
    child's write that settles unconfirmed rejects
    `stdio transport could not deliver the message`. The supervisor discloses no
    cause behind that answer, so neither message claims one. `options.delivery`
    is the bound in milliseconds on one unconfirmed write: a live child that
    never reads its `stdin` fills the pipe, and the write the kernel cannot
    confirm rejects at that bound with the child still running and with neither
    `error` nor `close` fired for it. An omitted `delivery` selects
    `DEFAULT_MCP_DELIVERY`, which sits below `DEFAULT_MCP_REQUEST_TIMEOUT` to
    distinguish a default-bound undeliverable write from the later request
    deadline for a peer that did not answer; an explicit `0` removes the bound
    and leaves such a write pending on the channel until teardown settles it as
    the same rejection.
    The child's `stdout` is drained through the supervisor's
    `readline`-framed `lines` iterable and every complete line is decoded onto
    `message` through the shared `dispatchLines` helper (a malformed line emits
    `error`); the child's exit bridges to the transport's `close`. `close()`
    runs the supervisor's bounded termination and teardown, which ends that
    `lines` stream at the child's terminal moment rather than throwing at the
    pump, and fires `close` once. A line already framed behind the one being
    delivered is dropped rather than emitted after the teardown began, and the
    wait for a descendant-held stdout pipe is capped by the supervisor's `drain`
    bound; a `close()` issued while that teardown runs joins it and resolves only
    after `close` has fired. The
    termination is the host's — a POSIX host signals the child's own process
    group `SIGTERM`, waits the grace window, then `SIGKILL`s through the same
    route, while Windows ends the tree with `taskkill /F /T`.
    The stdio transports'
    `session` is always
    `undefined` (the process pipe carries no session concept).
21. **The browser transport carries the same `MCPMessageTransportInterface`
    contract over native host APIs (`src/browser`).**
    `createWebSocketClientTransport({ url, protocols? })` returns a
    `MCPMessageTransportInterface` whose `start()` opens `new WebSocket(url,
protocols)` and awaits the native `'open'` event (the RFC 6455 handshake
    is the host's concern; a connection failure — the native `'error'` event
    while not yet `OPEN` — rejects `start()`); `send` writes each message as
    one text frame once `OPEN`, queuing (in order) any message sent before —
    flushed the moment the socket opens — while a `send` after `close()` or on a
    socket already reporting `CLOSING` / `CLOSED` rejects with
    `WebSocket transport is not connected`, because a native socket write is
    unconfirmed and a silent resolve leaves the client's correlated request
    pending to its deadline for a frame nobody wrote; a queue rides one
    connection, so `close()` and the native `close` event each discard what is
    still in it rather than flushing it onto the socket a later `start()` opens;
    inbound text frames are `JSON.parse`d
    (guarded) + narrowed with `parseJSONRPCMessage` onto `message` (a
    non-text / non-JSON / non-message frame surfaces on `error` and is
    dropped, never thrown); `close()` closes the socket and fires `close`
    exactly once — a server-initiated close (the native `close` event) fires
    the same `close` exactly once too, guarded so the transport-initiated and
    server-initiated closes never double-emit. Closing before the socket opens
    resolves the pending `start()` rather than leaving it pending, matching the
    Node face.
    `createHTTPClientTransport({ url, headers?, fetch?, timeout? })` returns the core
    `HTTPClientTransport` — the same class the Node face's factory of that name returns, because
    the class touches `fetch`, `Response`, `AbortController`, `AbortSignal`, and `WeakMap`
    alone. Every rule the HTTP client transport clause states therefore holds here as the same
    code rather than as a second copy that agrees: the header contract, the SEP-2243
    `x-mcp-header` selection, the SSE decode through `readEventStream`, the `202` that emits
    nothing, and the non-success reply that rejects `send` rather than being swallowed. The
    browser face's own transports are type-checked DOM-free (`lib: ["ESNext", "WebWorker"]`,
    proven by `check:src:browser`), and the core class is checked under the same libs, so the
    same code runs in a page, a Web Worker, or a Service Worker.
22. **`MessagePortTransport` is symmetric; `createScopeServer` unifies dedicated-worker
    and Service-Worker wiring with no upfront shape flag (`src/browser`).**
    `createMessagePortTransport({ port })` returns an `MCPTransportInterface`
    (not a `MCPMessageTransportInterface` — the same class works as either a
    server or a client carrier depending on whether it is handed to
    `bindServer` or `bindClient`/`createDuplexClientTransport`). `port.start()`
    runs at construction (there is no separate open step on the port contract
    for the caller to hook one into); inbound is STRING-ONLY — a non-string
    `event.data` is dropped, never forwarded (the port contract carries no
    `error` channel to surface it on); `messageerror` is ignored, not routed
    to `closed` (one bad frame is not a dead channel); `close()` closes the
    port and fires the registered `closed` handler exactly once, idempotently
    — there is no native "peer closed" signal for a `MessagePort`, so `closed`
    fires only from this transport's own `close()`. `listen`/`closed` are
    single-handler-replace, per the `MCPTransportInterface` port contract.
    `createScopeServer(options, scope?)` takes one scope, defaulting to `globalThis`, so a
    worker entry passes options alone and a test passes a double. It creates an `MCPServer`
    (`name`/`version` defaulting to `DEFAULT_MCP_SERVER_NAME`/`DEFAULT_MCP_SERVER_VERSION`
    when omitted), `bindServer`s it eagerly over a `createScopeTransport(scope)`
    (the implicit, portless channel — bound once, for the whole lifetime of
    the returned handle, so a dedicated worker's very first portless message
    needs no first-use setup), and registers one `scope.addEventListener(
'message', …)` listener built by `createScopeMessageListener`. That one
    listener handles every shape uniformly, per event, with no upfront
    detection flag: `event.ports.length > 0` spawns a fresh
    `createMessagePortTransport` + `bindServer` for that port (tracked for
    teardown) — a Service Worker's normal per-client channel, and also a
    dedicated-worker-shaped scope's cross-case if it happens to receive a
    port-bearing event; an event with no ports and a string `data` delivers
    onto the implicit scope channel; any other event is dropped. The handle's
    `stop` is idempotent: it removes the scope listener, unbinds the implicit
    channel, and — for every accepted port — unbinds and closes it. Those
    bindings live in one map keyed by the port each belongs to, which is also
    what the dedup reads, so clearing it releases the bindings and the ports
    together and a scope that outlives its handle retains neither.
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
    publishes each `uriTemplate` as an opaque descriptor string and validates only that
    it is a nonempty string; `MCPResourceManagerInterface.resource` and
    `MCPResourceReadParams.uri` take the concrete URI the client sent. Matching a URI
    to a template, and substituting its variables, happen entirely inside the
    consumer-supplied manager. There is no template parser and no RFC 6570
    implementation anywhere in `src/`, so the package has no feature level to state and
    the question of which level to support does not arise. The same division governs
    `completion/complete`: an `MCPResourceTemplateReference` is forwarded to
    `MCPCompletionInterface.complete` verbatim, template and all, because
    completing a template's arguments requires knowing that template's variables and
    the party that owns expansion is the party that knows them.
26. **One pagination shape, and every cursor is the manager's.** `resources/list`,
    `resources/templates/list`, and `prompts/list` take `MCPPaginationParams`
    (`{ cursor? }`) and answer `MCPPaginationResult` (`{ nextCursor? }`); no second
    cursor shape exists in the package. The cursor is opaque: this package validates
    that a present one is a string, forwards it unread, and copies a returned
    `nextCursor` through without interpretation, so paging strategy, cursor encoding,
    and stability across pages all belong to the manager. An omitted `nextCursor` is
    the final page, and there is no sentinel spelling of "no more pages".
27. **Not found is `undefined` at the port and `-32602` on the wire.**
    `MCPResourceManagerInterface.resource`, `MCPPromptManagerInterface.prompt`, and
    `MCPCompletionInterface.complete` each answer `undefined` for something they
    do not resolve, and the server maps that to `JSONRPC_INVALID_PARAMS` naming the
    unresolved URI or prompt. `-32002` is the pre-`2026-07-28` spelling a client `SHOULD`
    still accept from an older peer and this server never produces. `resource` and
    `prompt` may instead answer an `MCPInputResult`, which is stamped and returned as the
    `input_required` arm; a manager answer that is neither a valid result nor
    `undefined` is contained as `-32603`. Completion candidates are projected to at
    most 100 values, stamping `hasMore: true` when the projection truncated.
