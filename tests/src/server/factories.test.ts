import type { StartedServerInterface } from '../../../setupServer.js'
import { describe, expect, it } from 'vitest'
import { createMCPClient } from '@src/core'
import {
	createErrorBoundary,
	createMCPRoutes,
	createServer,
	createTokenGuard,
	createWebSocketClientTransport,
	createWebSocketServer,
	MCP_SESSION_HEADER,
	signToken,
} from '@src/server'
import { collectSSE, createJSONRPCRequest } from '../../../setup.js'
import {
	createCalculatorServer,
	createTeardown,
	postJSON,
	startServer,
	upgradeRequest,
} from '../../../setupServer.js'

// src/server/mcp/factories.ts — createMCPRoutes, the stateless Streamable-HTTP MCP
// transport, proven over a REAL server + a REAL MCPServer over a REAL ToolManager (stub
// tools, NO live model) driven with `fetch` (AGENTS §16). The contract the assertions
// pin down: POST dispatches JSON-RPC; a TRANSPORT failure (malformed JSON / a non-
// request) is HTTP 400 + a JSON-RPC error body; a DISPATCH result (success OR an in-band
// JSON-RPC error like method-not-found) is HTTP 200 + the envelope; a notification (no
// `id`) is 202 + empty; `Accept: text/event-stream` frames the 200 as an SSE `data:`
// event (decoded with the core SSEParser via collectSSE); GET to the path is the spine's
// automatic 405; and a token guard mounted IN FRONT 401s an unauthenticated POST
// (proving the transport is mechanism — policy composes ahead of it). The STATEFUL session
// layer (`createMCPSession`) is a separate plug-and-play middleware, proven in
// middlewares.test.ts; here `createMCPRoutes` is stateless-only.

const { track } = createTeardown((handle: StartedServerInterface) => handle.stop())

// Stand up a server with the stateless MCP transport mounted (optionally with extra
// middleware / route options), started on an ephemeral port.
async function startMCP(options?: {
	readonly streaming?: boolean
	readonly path?: string
	readonly guardSecret?: string
}): Promise<StartedServerInterface> {
	const server = createServer()
	server.use(createErrorBoundary()) // renders a guard 401, never reached by the transport itself
	if (options?.guardSecret !== undefined) {
		server.use(createTokenGuard({ secret: options.guardSecret }))
	}
	server.route(
		createMCPRoutes(createCalculatorServer(), {
			streaming: options?.streaming,
			path: options?.path,
		}),
	)
	return track(await startServer(server))
}

describe('createMCPRoutes — dispatch the four MCP methods', () => {
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
		)
		expect(response.status).toBe(200)
		const body = await response.json()
		// The `add` stub returns 5 → one text content block carrying `JSON.stringify(5)`.
		expect(body.result).toEqual({ content: [{ type: 'text', text: '5' }] })
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
		)
		// A tool throw is an in-band tool RESULT, not a transport/protocol error — HTTP 200.
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.result.isError).toBe(true)
		expect(body.result.content[0].text).toContain('kaboom')
	})
})

describe('createMCPRoutes — transport vs in-band outcomes', () => {
	it('POST a notification (no id) → 202 with an empty body', async () => {
		const handle = await startMCP()
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'notifications/initialized', id: undefined }),
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
			id: null,
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
			id: null,
			error: { code: -32600, message: 'Invalid Request' },
		})
	})

	it('POST an unknown method (id-bearing) → 200 + an IN-BAND -32601 error', async () => {
		const handle = await startMCP()
		// method-not-found is a DISPATCH result — the JSON-RPC error rides in the body at HTTP 200.
		const response = await postJSON(handle.base, createJSONRPCRequest({ method: 'no/such', id: 5 }))
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
			{ headers: { accept: 'text/event-stream' } },
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
			headers: { accept: 'text/event-stream' },
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
		})
		expect(response.status).toBe(200)
		expect((await response.json()).result).toEqual({})
	})
})

describe('createMCPRoutes — mechanism, not policy', () => {
	it('behind a token guard, a POST without a token → 401 (auth composes IN FRONT)', async () => {
		const secret = 'mcp-guard-secret'
		const handle = await startMCP({ guardSecret: secret })
		// No Authorization header — the guard short-circuits BEFORE the transport handler.
		const denied = await postJSON(handle.base, createJSONRPCRequest({ method: 'ping', id: 10 }))
		expect(denied.status).toBe(401)
		// A valid token reaches the transport, which dispatches normally.
		const allowed = await postJSON(handle.base, createJSONRPCRequest({ method: 'ping', id: 11 }), {
			headers: { authorization: `Bearer ${signToken('client', { secret })}` },
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

	it('a non-initialize POST is accepted WITHOUT any session id (no validation)', async () => {
		// Statelessly, a `tools/list` with no session header dispatches normally — there is no
		// session gate to fail. (With `createMCPSession` in front, the same request would 404.)
		const handle = await startMCP()
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'tools/list', id: 2 }),
		)
		expect(response.status).toBe(200)
		expect((await response.json()).result.tools).toHaveLength(2)
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
// src/server/mcp/{WebSocketServerTransport,WebSocketClientTransport}.ts + createWebSocketServer
// / createWebSocketClientTransport — the DETERMINISTIC both-transports WS e2e (no live model):
// a REAL `Server` with `server.upgrade(createWebSocketServer(mcp))` over the same stub-tool
// MCPServer, started with `startServer`; an `MCPClient` over
// `createWebSocketClientTransport({ url: <ws>/mcp })` drives `connect()` → `tools()` →
// `call('add'/'boom')` over REAL WebSocket frames through the REAL spine upgrade seam. Proves
// the ingress↔egress loop end to end: the handshake, the tool list, a tool-call value
// round-trip, an erroring tool → `isError` → a local throw, and the upgrade-decline path (a
// non-WS request to the path, and a WS upgrade to a wrong path, are both declined → destroyed).

// Stand up a server exposing the stub-tool MCPServer over WebSocket on an ephemeral port. The
// WS client transport accepts the `http://` base directly (it converts `ws(s)`→`http(s)`
// internally; an `http://` URL passes through to the same upgrade endpoint).
async function startWsMCP(): Promise<StartedServerInterface> {
	const server = createServer()
	server.use(createErrorBoundary())
	server.upgrade(createWebSocketServer(createCalculatorServer())) // ingress over the spine upgrade seam
	return track(await startServer(server))
}

describe('createWebSocketServer ↔ createWebSocketClientTransport — the both-transports WS e2e', () => {
	it('connect → tools/list → tools/call(add): a value round-trips over real WebSocket frames', async () => {
		const handle = await startWsMCP()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/mcp` }),
		})

		// connect() handshakes over WS (the 101 upgrade + the MCP initialize over frames).
		await client.connect()
		expect(client.connected).toBe(true)

		// tools/list — the stub registry's tools as local Tools, each with its parameters.
		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		// tools/call(add) — the stub returns 5, round-tripped back across the wire.
		const value = await client.call('add', {})
		expect(value).toBe(5)

		await client.disconnect()
		expect(client.connected).toBe(false)
	})

	it('a remote erroring tool throws locally (isError → throw)', async () => {
		const handle = await startWsMCP()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/mcp` }),
		})
		await client.connect()

		// `boom` throws server-side → an in-band `isError` tool result → the client throws.
		await expect(client.call('boom', {})).rejects.toThrow(/kaboom/)

		await client.disconnect()
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
})
