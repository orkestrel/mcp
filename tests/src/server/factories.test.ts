import type { JSONRPCMessage, MCPDispatcherInterface } from '@src/core'
import type { MiddlewareHandler } from '@orkestrel/server'
import type { ClientSocketInterface, StartedServerInterface } from '../../setupServer.js'
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
	buildCancelledNotification,
	createMCPClient,
	createMCPLegacy,
	createMCPServer,
	MCP_META_SERVER,
	MCP_MODERN_VERSION,
} from '@src/core'
import { createDispatcher } from '@orkestrel/router'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createServer } from '@orkestrel/server'
import {
	createMCPContinuation,
	createMCPRoutes,
	createStdioServer,
	createWebSocketClientTransport,
	createWebSocketServer,
	DEFAULT_MCP_PATH,
	MCP_METHOD_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_SESSION_HEADER,
} from '@src/server'
import { WEBSOCKET_CLOSE_NORMAL, WEBSOCKET_OPCODE_CLOSE } from '@orkestrel/websocket'
import { waitForDelay } from '@orkestrel/test'
import {
	collectSSE,
	createCalculatorServer,
	createJSONRPCNotification,
	createJSONRPCRequest,
	MODERN_METADATA,
	postJSON,
	waitForAbort,
} from '../../setup.js'
import {
	closeResource,
	createTeardown,
	openClientSocket,
	startServer,
	upgradeRequest,
} from '../../setupServer.js'

// src/server/factories.ts — createMCPRoutes, the stateless Streamable-HTTP MCP
// transport, proven over a REAL @orkestrel/server + a REAL MCPServer over a REAL
// ToolManager (stub tools, NO live model) driven with `fetch`. The
// contract the assertions pin down: POST dispatches JSON-RPC; a TRANSPORT failure
// (malformed JSON / a non-request) is HTTP 400 + a JSON-RPC error body; a DISPATCH
// result (success OR an in-band JSON-RPC error like method-not-found) is HTTP 200 +
// the envelope; a notification (no `id`) is 202 + empty; `Accept: text/event-stream`
// frames the 200 as an SSE `data:` event (decoded with the core SSEParser via
// collectSSE); GET to the path is the spine's automatic 405; and a token-check
// middleware mounted IN FRONT 401s an unauthenticated POST (proving the transport is
// mechanism — policy composes ahead of it, via the spine's OWN `use`, no
// @orkestrel/middleware dependency). The STATEFUL session layer (`createMCPSession`)
// is a separate plug-and-play middleware, proven in middlewares.test.ts; here
// `createMCPRoutes` is stateless-only.

// Servers AND the clients driven against them, released newest first: a client the teardown
// closes is one a FAILING assertion cannot leave attached to the server it then has to stop.
const { track } = createTeardown(closeResource)

describe('createMCPContinuation', () => {
	it('adapts the installed token primitives into the host-neutral seal/open port', async () => {
		const continuation = createMCPContinuation(['current-secret', 'older-secret'])
		const value = '{"bound":true}'
		const carrier = await continuation.seal(value)

		expect(carrier).not.toBe(value)
		expect(await continuation.open(carrier)).toBe(value)
		expect(await continuation.open(`${carrier}x`)).toBeUndefined()
	})
})

// A minimal bearer-token check middleware, hand-rolled locally (no @orkestrel/middleware
// dependency) — just enough to prove the transport composes auth IN FRONT rather than
// baking it in.
function createBearerGuard(secret: string): MiddlewareHandler<unknown> {
	return (request, _context, next) => {
		const header = request.headers.get('authorization')
		if (header !== `Bearer ${secret}`) {
			return Response.json({ error: 'unauthorized' }, { status: 401 })
		}
		return next()
	}
}

// Stand up a server with the stateless MCP transport mounted (optionally with extra
// middleware / route options), started on an ephemeral port.
async function startMCP(options?: {
	readonly streaming?: boolean
	readonly path?: string
	readonly guardSecret?: string
}): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	dispatcher.add(
		createMCPRoutes(createMCPLegacy(createCalculatorServer()), {
			...(options?.streaming !== undefined ? { streaming: options.streaming } : {}),
			...(options?.path !== undefined ? { path: options.path } : {}),
		}),
	)
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	if (options?.guardSecret !== undefined) server.use(createBearerGuard(options.guardSecret))
	return track(await startServer(server))
}

describe('createMCPRoutes — dispatch the MCP methods', () => {
	it('exposes a raw server as modern-only and a decorated server as both eras', async () => {
		const dispatcher = createDispatcher<unknown>()
		dispatcher.add(createMCPRoutes(createCalculatorServer(), { streaming: false }))
		const server = createServer<unknown>({ dispatcher, state: () => undefined })
		const handle = track(await startServer(server))
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'ping', params: { _meta: MODERN_METADATA } }),
			{
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
					[MCP_METHOD_HEADER]: 'ping',
				},
			},
		)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(body.result.resultType).toBe('complete')
		expect(body.result['_meta'][MCP_META_SERVER]).toEqual({
			name: 'calculator',
			version: '1.0.0',
		})
	})

	it('POST initialize → 200 + the negotiated handshake result', async () => {
		const handle = await startMCP()
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ params: { protocolVersion: '2025-06-18' } }),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: {
				protocolVersion: '2025-06-18',
				capabilities: { tools: {} },
				serverInfo: { name: 'calculator', version: '1.0.0' },
			},
		})
	})

	it('POST tools/list → the registry tools, each with an inputSchema', async () => {
		const handle = await startMCP()
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'tools/list', id: 2 }),
			{ headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' } },
		)
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.id).toBe(2)
		const names = body.result.tools.map((tool: { name: string }) => tool.name)
		expect(names).toEqual(['add', 'boom'])
		// Every descriptor carries an `inputSchema` (the wire rename of `parameters`).
		for (const tool of body.result.tools) expect(tool.inputSchema).toBeDefined()
	})

	it('POST tools/call → executes a stub tool, the content round-trips at 200', async () => {
		const handle = await startMCP()
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'tools/call', id: 3, params: { name: 'add', arguments: {} } }),
			{ headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' } },
		)
		expect(response.status).toBe(200)
		const body = await response.json()
		// The `add` stub returns 5 → the text block carrying `JSON.stringify(5)` for a
		// client that only reads content, AND `structuredContent` carrying the value in its
		// original shape, so a caller never has to parse a handle back out of a string.
		// Both travel a real HTTP round trip here, which the core-level test cannot prove.
		expect(body.result).toEqual({ content: [{ type: 'text', text: '5' }], structuredContent: 5 })
	})

	it('POST tools/call on an erroring tool → isError:true in the body at 200', async () => {
		const handle = await startMCP()
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({
				method: 'tools/call',
				id: 4,
				params: { name: 'boom', arguments: {} },
			}),
			{ headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' } },
		)
		// A tool throw is an in-band tool RESULT, not a transport/protocol error — HTTP 200.
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.result.isError).toBe(true)
		expect(body.result.content[0].text).toContain('kaboom')
	})
})

describe('createMCPRoutes — transport vs in-band outcomes', () => {
	it('POST with a supported protocol-version header → 200', async () => {
		const handle = await startMCP()
		const response = await postJSON(handle.base, createJSONRPCRequest({ method: 'ping', id: 12 }), {
			headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
		})

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 12, result: {} })
	})

	it('POST with an unsupported protocol-version header → 400 + a JSON-RPC error body', async () => {
		const handle = await startMCP()
		const response = await postJSON(handle.base, createJSONRPCRequest({ method: 'ping', id: 13 }), {
			headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2099-01-01' },
		})

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: 13,
			error: {
				code: -32022,
				message: "Unsupported MCP protocol version '2099-01-01'",
				data: {
					supported: ['2026-07-28', '2025-11-25', '2025-06-18'],
					requested: '2099-01-01',
				},
			},
		})
	})

	it('POST a notification (no id) → 202 with an empty body', async () => {
		const handle = await startMCP()
		const response = await postJSON(
			handle.base,
			createJSONRPCNotification('notifications/initialized'),
			{ headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' } },
		)
		expect(response.status).toBe(202)
		expect(await response.text()).toBe('')
	})

	it('POST malformed JSON → 400 + a JSON-RPC -32700 (Parse error) body', async () => {
		const handle = await startMCP()
		// A malformed body is a TRANSPORT failure: HTTP 400 carrying the JSON-RPC parse error.
		const response = await fetch(`${handle.base}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{ not valid json',
		})
		expect(response.status).toBe(400)
		const body = await response.json()
		expect(body).toEqual({
			jsonrpc: '2.0',
			error: { code: -32700, message: 'Parse error' },
		})
	})

	it('POST a non-request payload (a response) → 400 + a JSON-RPC -32600 body', async () => {
		const handle = await startMCP()
		// A well-formed JSON-RPC RESPONSE is not a request — Invalid Request, HTTP 400 + -32600.
		const response = await postJSON(handle.base, { jsonrpc: '2.0', id: 9, result: { ok: true } })
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			error: { code: -32600, message: 'Invalid Request' },
		})
	})

	it('POST an unknown method (id-bearing) → 200 + an IN-BAND -32601 error', async () => {
		const handle = await startMCP()
		// method-not-found is a DISPATCH result — the JSON-RPC error rides in the body at HTTP 200.
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'no/such', id: 5 }),
			{
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
			},
		)
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.id).toBe(5)
		expect(body.error.code).toBe(-32601)
	})
})

describe('createMCPRoutes — the Streamable-HTTP SSE response', () => {
	it('frames the reply as an SSE data: event when the client Accepts text/event-stream', async () => {
		const handle = await startMCP()
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'tools/list', id: 6 }),
			{
				headers: {
					accept: 'text/event-stream',
					[MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18',
				},
			},
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/event-stream')
		// Decode the body with the core SSEParser — the proof the seam serialized the
		// JSON-RPC envelope as one `data:` event the parser round-trips.
		const events = await collectSSE(response)
		expect(events).toHaveLength(1)
		const envelope = JSON.parse(events[0]?.data ?? '')
		expect(envelope.id).toBe(6)
		expect(envelope.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
			'add',
			'boom',
		])
	})

	it('still answers JSON for an event-stream Accept when streaming is disabled', async () => {
		const handle = await startMCP({ streaming: false })
		const response = await postJSON(handle.base, createJSONRPCRequest({ method: 'ping', id: 7 }), {
			headers: {
				accept: 'text/event-stream',
				[MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18',
			},
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('application/json')
		expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
	})
})

describe('createMCPRoutes — the spine answers other verbs', () => {
	it('GET the transport path → 405 (the spine auto, no GET route registered)', async () => {
		const handle = await startMCP()
		// createMCPRoutes registers only POST; GET/DELETE (the session-push / session tier) get the
		// spine's automatic 405 with an Allow header naming the registered method. A createMCPSession
		// middleware in front is what serves the resumable GET / DELETE.
		const response = await fetch(`${handle.base}/mcp`)
		expect(response.status).toBe(405)
		expect(response.headers.get('allow')).toContain('POST')
	})

	it('mounts at a custom path when one is supplied', async () => {
		const handle = await startMCP({ path: '/rpc' })
		const response = await postJSON(handle.base, createJSONRPCRequest({ method: 'ping', id: 8 }), {
			path: '/rpc',
			headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
		})
		expect(response.status).toBe(200)
		expect((await response.json()).result).toEqual({})
	})
})

describe('createMCPRoutes — mechanism, not policy', () => {
	it('behind a bearer guard, a POST without a token → 401 (auth composes IN FRONT)', async () => {
		const secret = 'mcp-guard-secret'
		const handle = await startMCP({ guardSecret: secret })
		// No Authorization header — the guard short-circuits BEFORE the transport handler.
		const denied = await postJSON(handle.base, createJSONRPCRequest({ method: 'ping', id: 10 }))
		expect(denied.status).toBe(401)
		// A valid token reaches the transport, which dispatches normally.
		const allowed = await postJSON(handle.base, createJSONRPCRequest({ method: 'ping', id: 11 }), {
			headers: {
				authorization: `Bearer ${secret}`,
				[MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18',
			},
		})
		expect(allowed.status).toBe(200)
		expect((await allowed.json()).result).toEqual({})
	})
})

describe('createMCPRoutes — the stateless default (no session middleware)', () => {
	it('initialize sends NO mcp-session-id header (createMCPRoutes mints nothing)', async () => {
		// The regression guard: `createMCPRoutes` alone mints nothing — the response carries no
		// session header. The session header is set ONLY by a `createMCPSession` middleware mounted
		// in front (proven in middlewares.test.ts).
		const handle = await startMCP()
		const response = await postJSON(handle.base, createJSONRPCRequest())
		expect(response.status).toBe(200)
		expect(response.headers.get(MCP_SESSION_HEADER)).toBeNull()
	})

	it('names the missing protocol header on a headerless legacy tools/list round trip', async () => {
		const handle = await startMCP()
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'tools/list', id: 2 }),
		)
		expect(response.status).toBe(400)
		expect((await response.json()).error).toEqual({
			code: -32020,
			message: "Required MCP-Protocol-Version header is missing; this server offers '2025-11-25'.",
		})
	})

	it('DELETE {path} → the spine automatic 405 (no DELETE route registered)', async () => {
		// `createMCPRoutes` registers only POST, so the spine 405s DELETE (Allow names POST). A
		// `createMCPSession` middleware in front is what serves DELETE → 204.
		const handle = await startMCP()
		const response = await fetch(`${handle.base}/mcp`, { method: 'DELETE' })
		expect(response.status).toBe(405)
		expect(response.headers.get('allow')).toContain('POST')
	})
})

// ── The WebSocket transport, both halves against each other ──────────────────
//
// src/server/transports/{WebSocketServerTransport,WebSocketClientTransport}.ts +
// createWebSocketServer / createWebSocketClientTransport — the DETERMINISTIC
// both-transports WS e2e (no live model): a REAL `Server` with
// `server.upgrade(createWebSocketServer(mcp))` over the same stub-tool MCPServer,
// started with `startServer`; an `MCPClient` over
// `createWebSocketClientTransport({ url: <ws>/mcp })` drives `connect()` → `tools()` →
// `call('add'/'boom')` over REAL WebSocket frames through the REAL spine upgrade seam.
// Proves the ingress↔egress loop end to end: the handshake, the tool list, a tool-call
// value round-trip, an erroring tool → `isError` → a local throw, and the
// upgrade-decline path (a non-WS request to the path, and a WS upgrade to a wrong path,
// are both declined → destroyed).

// Stand up a server exposing the stub-tool MCPServer over WebSocket on an ephemeral port. The
// WS client transport accepts the `http://` base directly (it converts `ws(s)`→`http(s)`
// internally; an `http://` URL passes through to the same upgrade endpoint).
async function startWsMCP(
	mcp: MCPDispatcherInterface = createCalculatorServer(),
): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	// Ingress over the spine upgrade seam, following the spine's own lifecycle: `emitter` is
	// what lets `stop()` end the sockets this handler claimed.
	server.upgrade(createWebSocketServer(mcp, { emitter: server.emitter }))
	return track(await startServer(server))
}

describe('createWebSocketServer ↔ createWebSocketClientTransport — the both-transports WS e2e', () => {
	it('serves a legacy initialize and tools/call through the decorator over a real socket', async () => {
		const handle = await startWsMCP(createMCPLegacy(createCalculatorServer()))
		const client = track(
			createMCPClient({
				transport: createWebSocketClientTransport({ url: `${handle.base}/mcp` }),
				version: '2025-06-18',
			}),
		)

		await client.connect()
		expect(client.version).toBe('2025-06-18')
		expect(await client.call('add', {})).toEqual({ resultType: 'complete', value: 5 })
	})

	it('CONTROL — a bare server answers modern-shaped initialize with -32601 over a real socket', async () => {
		const handle = await startWsMCP()
		const transport = track(createWebSocketClientTransport({ url: `${handle.base}/mcp` }))

		await transport.start()
		const legacy = new Promise<unknown>((resolve) => transport.emitter.on('message', resolve))
		await transport.send(
			createJSONRPCRequest({
				method: 'initialize',
				params: { protocolVersion: '2025-06-18' },
			}),
		)
		await expect(legacy).resolves.toMatchObject({ error: { code: -32602 } })

		const modern = new Promise<unknown>((resolve) => transport.emitter.on('message', resolve))
		await transport.send(
			createJSONRPCRequest({
				method: 'initialize',
				params: { _meta: MODERN_METADATA },
			}),
		)
		await expect(modern).resolves.toMatchObject({ error: { code: -32601 } })
	})

	it('connect → tools/list → tools/call(add): a value round-trips over real WebSocket frames', async () => {
		const handle = await startWsMCP()
		const client = track(
			createMCPClient({
				transport: createWebSocketClientTransport({ url: `${handle.base}/mcp` }),
			}),
		)

		// connect() handshakes over WS (the 101 upgrade + the MCP initialize over frames).
		await client.connect()
		expect(client.connected).toBe(true)

		// tools/list — the stub registry's tools as local Tools, each with its parameters.
		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		// tools/call(add) — the stub returns 5, round-tripped back across the wire.
		const value = await client.call('add', {})
		expect(value).toEqual({ resultType: 'complete', value: 5 })

		await client.disconnect()
		expect(client.connected).toBe(false)
	})

	it('a remote erroring tool throws locally (isError → throw)', async () => {
		const handle = await startWsMCP()
		const client = track(
			createMCPClient({
				transport: createWebSocketClientTransport({ url: `${handle.base}/mcp` }),
			}),
		)
		await client.connect()

		// `boom` throws server-side → an in-band `isError` tool result → the client throws.
		await expect(client.call('boom', {})).rejects.toThrow(/kaboom/)
	})

	it('declines a non-WebSocket request to the path (the spine destroys the socket)', async () => {
		const handle = await startWsMCP()
		// A plain HTTP request to /mcp is not a WebSocket upgrade — the upgrade handler is never
		// even consulted (no Upgrade header), so /mcp 404s (no route registered, only an upgrade).
		const response = await fetch(`${handle.base}/mcp`)
		expect(response.status).toBe(404)
	})

	it('declines a WebSocket upgrade to the wrong path (the spine destroys the un-upgraded socket)', async () => {
		const handle = await startWsMCP()
		// A real WS upgrade (Connection: Upgrade + a key + version 13) but to /nope — the handler
		// returns false on the path mismatch, so the spine destroys the un-upgraded socket. (The
		// CLAIM + 101 handshake to the configured /mcp path is proven by the connect() e2e above,
		// which validates the Sec-WebSocket-Accept and then cleanly closes the socket — a bare
		// claim probe would leak an un-closed upgraded socket past the test.)
		const outcome = await upgradeRequest(handle.base, '/nope', {
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'Sec-WebSocket-Version': '13',
		})
		expect(outcome.claimed).toBe(false)
	})

	it('declines a WebSocket upgrade missing the Sec-WebSocket-Version: 13 header', async () => {
		const handle = await startWsMCP()
		// Right path + a key, but no `Sec-WebSocket-Version` — the handler declines (RFC 6455
		// requires version 13), so the spine destroys the un-upgraded socket.
		const outcome = await upgradeRequest(handle.base, '/mcp', {
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
		})
		expect(outcome.claimed).toBe(false)
	})

	it('claims an upgrade without selecting a subprotocol when the client offers none', async () => {
		const handle = await startWsMCP()
		const outcome = await upgradeRequest(handle.base, '/mcp', {
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'Sec-WebSocket-Version': '13',
		})

		expect(outcome).toEqual({ claimed: true, status: 101, protocol: undefined })
	})

	it('claims an upgrade without selecting a subprotocol when the client offers another one', async () => {
		const handle = await startWsMCP()
		const outcome = await upgradeRequest(handle.base, '/mcp', {
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'Sec-WebSocket-Version': '13',
			'Sec-WebSocket-Protocol': 'chat, telemetry',
		})

		expect(outcome).toEqual({ claimed: true, status: 101, protocol: undefined })
	})

	it('selects the configured subprotocol when the client offers it', async () => {
		const handle = await startWsMCP()
		const outcome = await upgradeRequest(handle.base, '/mcp', {
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'Sec-WebSocket-Version': '13',
			'Sec-WebSocket-Protocol': 'chat, mcp, telemetry',
		})

		expect(outcome).toEqual({ claimed: true, status: 101, protocol: 'mcp' })
	})
})

// ── The WebSocket ingress follows the spine's lifecycle ──────────────────────
//
// A claimed upgraded socket is detached from the connection set the spine's own close walks,
// so the claimant is the ONLY thing that can end it: leave it open and `stop()` spends its
// whole `drain` budget and then cuts the connection mid-protocol. `createWebSocketServer`
// therefore closes every socket it still owns on the spine's `stop` event, with the RFC 6455
// close handshake `WebSocketServerTransport.close()` already performs — the clean goodbye the
// drain window exists for. Each row here drives a REAL socket against a REAL spine and reads
// the actual wire: the frame the server sent, not a report that it sent one.
//
// The timing bound is deliberately loose (a second against a 10s drain budget): the claim is
// "the drain settles on the close" versus "the drain runs out", and those are three orders of
// magnitude apart. A tight bound would measure the runner's load instead.

const socketTeardown = createTeardown<ClientSocketInterface>((socket) => socket.close())

describe('createWebSocketServer — the spine stop closes every socket it claimed', () => {
	it('closes a live socket with an RFC 6455 close frame, so stop settles in milliseconds', async () => {
		const handle = await startWsMCP()
		const socket = socketTeardown.track(await openClientSocket(handle.base, DEFAULT_MCP_PATH))

		const started = performance.now()
		await handle.server.stop()
		const elapsed = performance.now() - started
		await socket.closed

		expect(elapsed).toBeLessThan(1000)
		// The goodbye is the PROTOCOL close, not a destroy: a destroyed socket sends no frame
		// at all, so this assertion is exactly what separates the two implementations.
		const close = socket.frames.find((frame) => frame.opcode === WEBSOCKET_OPCODE_CLOSE)
		expect(close?.payload.readUInt16BE(0)).toBe(WEBSOCKET_CLOSE_NORMAL)
	}, 20_000)

	it('CONTROL — a server with no WebSocket at all still stops immediately', async () => {
		const handle = await startWsMCP()

		const started = performance.now()
		await handle.server.stop()

		expect(performance.now() - started).toBeLessThan(1000)
	}, 20_000)

	it('a client that already went away neither throws nor holds the stop path', async () => {
		const handle = await startWsMCP()
		const socket = socketTeardown.track(await openClientSocket(handle.base, DEFAULT_MCP_PATH))
		// The peer vanishes without a close frame — the socket the handler owns is already dead
		// when `stop()` reaches it, so closing it must be a silent no-op.
		socket.close()
		await socket.closed

		const started = performance.now()
		await expect(handle.server.stop()).resolves.toBeUndefined()

		expect(performance.now() - started).toBeLessThan(1000)
	}, 20_000)
})

describe('createWebSocketServer — the spine stop detaches each claimed binding', () => {
	it('aborts the request in flight and writes no reply for the connection it closed', async () => {
		const observed: string[] = []
		const tools = createToolManager()
		tools.add(createTool({ name: 'slow', execute: () => 0 }))
		// The execution handler parks on the request's own signal, so the abort the teardown
		// issues is observable from inside the dispatch it cancels.
		const mcp = createMCPServer({
			identity: { name: 'ws-stop', version: '1.0.0' },
			tools,
			async execution(context) {
				await waitForAbort(context.signal)
				observed.push('aborted')
				return { id: context.call.id, name: context.call.name, success: true, value: 0 }
			},
		})
		const handle = await startWsMCP(mcp)
		const transport = createWebSocketClientTransport({
			url: `${handle.base}${DEFAULT_MCP_PATH}`,
		})
		const replies: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => replies.push(message))
		await transport.start()
		await transport.send(
			createJSONRPCRequest({
				method: 'tools/call',
				id: 'call-1',
				params: { name: 'slow', arguments: {}, _meta: MODERN_METADATA },
			}),
		)
		await waitForDelay(40)
		expect(observed).toEqual([])

		await handle.server.stop()
		await waitForDelay(40)

		// The binding this ingress opened for the socket is detached with the socket: its live
		// request is aborted, and the answer it was holding is released rather than written.
		expect(observed).toEqual(['aborted'])
		expect(replies).toEqual([])
		await transport.close()
	}, 20_000)
})

async function driveStdioChild(
	mcp: MCPDispatcherInterface,
	mode: 'legacy' | 'bare',
): Promise<number | null> {
	const child = spawn(
		process.execPath,
		[
			'-e',
			`
const mode = process.argv[1]
let buffer = ''
let stage = 'initialize'

function fail(message) {
	process.stderr.write(message + '\\n')
	process.exit(1)
}

function send(message) {
	process.stdout.write(JSON.stringify(message) + '\\n')
}

function receive(message) {
	if (stage === 'initialize') {
		if (mode === 'bare') {
			if (message.error?.code !== -32602) fail('bare legacy-shaped initialize was accepted')
			stage = 'control'
			send({
				jsonrpc: '2.0',
				id: 2,
				method: 'initialize',
				params: {
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {},
					},
				},
			})
			return
		}
		if (message.result?.protocolVersion !== '2025-06-18') fail('legacy initialize failed')
		stage = 'call'
		send({ jsonrpc: '2.0', method: 'notifications/initialized' })
		send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add', arguments: {} } })
		return
	}
	if (stage === 'control') {
		if (message.error?.code !== -32601) fail('bare modern-shaped initialize did not answer -32601')
		process.exit(0)
	}
	if (message.result?.content?.[0]?.text !== '5') fail('legacy tools/call failed')
	process.exit(0)
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
	buffer += chunk
	let newline = buffer.indexOf('\\n')
	while (newline !== -1) {
		const line = buffer.slice(0, newline)
		buffer = buffer.slice(newline + 1)
		if (line.length > 0) receive(JSON.parse(line))
		newline = buffer.indexOf('\\n')
	}
})

send({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: { protocolVersion: '2025-06-18' },
})
`,
			mode,
		],
		{ stdio: ['pipe', 'pipe', 'inherit'] },
	)
	const handle = createStdioServer(mcp, { input: child.stdout, output: child.stdin })
	handle.start()
	return new Promise<number | null>((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', (code) => {
			handle.stop()
			resolve(code)
		})
	})
}

// createStdioServer — the new seam: it now pipes its transport through the core
// bindServer port (via bridgeMessageTransport) rather than a hand-rolled pump. Proven
// over REAL PassThrough streams + a REAL MCPServer — the request → reply
// line round trip, a notification writing nothing, and a dispatch fault (an unknown
// method reply, the in-band case; the transport-fault case is pinned at the core
// binder level in tests/src/core/helpers.test.ts) all behave exactly as before.
describe('createStdioServer — pipes stdio through the core bindServer port', () => {
	it('serves a legacy initialize and tools/call through the decorator over a spawned child', async () => {
		expect(await driveStdioChild(createMCPLegacy(createCalculatorServer()), 'legacy')).toBe(0)
	})

	it('CONTROL — a bare server answers modern-shaped initialize with -32601 over a spawned child', async () => {
		expect(await driveStdioChild(createCalculatorServer(), 'bare')).toBe(0)
	})

	it('stop() returns synchronously and releases only the factory-owned input listeners', () => {
		const input = new PassThrough()
		const output = new PassThrough()
		input.on('data', () => {})
		input.on('close', () => {})
		input.on('error', () => {})
		const before = [
			input.listenerCount('data'),
			input.listenerCount('close'),
			input.listenerCount('error'),
		]
		const handle = createStdioServer(createCalculatorServer(), { input, output })
		handle.start()

		expect(handle.stop()).toBeUndefined()
		expect(handle.stop()).toBeUndefined()
		expect([
			input.listenerCount('data'),
			input.listenerCount('close'),
			input.listenerCount('error'),
		]).toEqual(before)
		expect(input.destroyed).toBe(false)
		expect(input.writableEnded).toBe(false)
	})

	function stdio() {
		const input = new PassThrough()
		const output = new PassThrough()
		return { input, output }
	}

	async function readLine(output: PassThrough): Promise<string> {
		return new Promise((resolve) => {
			let buffer = ''
			output.on('data', (chunk: Buffer) => {
				buffer += chunk.toString()
				const newline = buffer.indexOf('\n')
				if (newline !== -1) resolve(buffer.slice(0, newline))
			})
		})
	}

	it('dispatches an inbound request line and writes the reply line back', async () => {
		const { input, output } = stdio()
		const handle = createStdioServer(createCalculatorServer(), { input, output })
		handle.start()

		const reply = readLine(output)
		input.write(
			`${JSON.stringify(
				createJSONRPCRequest({ method: 'ping', id: 1, params: { _meta: MODERN_METADATA } }),
			)}\n`,
		)
		const response = JSON.parse(await reply)

		expect(response.id).toBe(1)
		expect(response.result.resultType).toBe('complete')
		expect(response.result['_meta'][MCP_META_SERVER]).toEqual({
			name: 'calculator',
			version: '1.0.0',
		})
		handle.stop()
	})

	it('writes nothing for a notification (no id → no reply)', async () => {
		const { input, output } = stdio()
		const handle = createStdioServer(createCalculatorServer(), { input, output })
		handle.start()

		const chunks: string[] = []
		output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
		input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
		await waitForDelay(20)

		expect(chunks).toEqual([])
		handle.stop()
	})

	// Over a REAL carrier: an inbound `notifications/cancelled` on a transport that
	// has one (stdio) aborts the named request, the TOOL observes it through the execution
	// handler's own signal, and the cancelled request writes no line back.
	it('honours an inbound cancellation: the tool sees the abort and no reply line is written', async () => {
		const { input, output } = stdio()
		const observed: string[] = []
		const tools = createToolManager()
		tools.add(createTool({ name: 'slow', execute: () => 0 }))
		const mcp = createMCPServer({
			identity: { name: 'stdio-cancel', version: '1.0.0' },
			tools,
			async execution(context) {
				await waitForAbort(context.signal)
				observed.push('aborted')
				return { id: context.call.id, name: context.call.name, success: true, value: 0 }
			},
		})
		const handle = createStdioServer(mcp, { input, output })
		handle.start()
		const lines: string[] = []
		output.on('data', (chunk: Buffer) => lines.push(chunk.toString()))

		input.write(
			`${JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 'call-1',
					params: { name: 'slow', arguments: {}, _meta: MODERN_METADATA },
				}),
			)}\n`,
		)
		await waitForDelay(20)
		expect(observed).toEqual([])

		input.write(`${JSON.stringify(buildCancelledNotification('call-1'))}\n`)
		await waitForDelay(20)

		expect(observed).toEqual(['aborted'])
		expect(lines).toEqual([])
		handle.stop()
	})

	it('ignores a stray response line (not a request) rather than dispatching it', async () => {
		const { input, output } = stdio()
		const handle = createStdioServer(createCalculatorServer(), { input, output })
		handle.start()

		const chunks: string[] = []
		output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`)
		await waitForDelay(20)

		expect(chunks).toEqual([])
		handle.stop()
	})
})
