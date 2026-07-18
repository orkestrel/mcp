import type { JSONRPCMessage } from '@src/core'
import type { SSEEvent } from '@orkestrel/sse'
import type { MiddlewareHandler } from '@orkestrel/server'
import type { MCPSessionState } from '@src/server'
import type { StartedServerInterface } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'
import { createMCPClient } from '@src/core'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import {
	createHTTPClientTransport,
	createMCPRoutes,
	createMCPSession,
	MCP_SESSION_HEADER,
} from '@src/server'
import { createJSONRPCRequest, createManualClock, readSSEStream } from '../../setup.js'
import { createCalculatorServer, createTeardown, postJSON, startServer } from '../../setupServer.js'

// ── createMCPSession — the plug-and-play stateful session middleware ──────────
//
// src/server/middlewares.ts — `createMCPSession` is the NATIVE MCP session layer (NO
// dependency on `@orkestrel/middleware`): a closure `Map` mints a session on `initialize`,
// validates the `mcp-session-id` header on every other `POST`, serves the resumable `GET
// {path}` SSE channel and the `DELETE {path}` session-end, with a lazy idle-TTL sweep.
// Composed via `server.use(createMCPSession())` IN FRONT of a session-AGNOSTIC
// `createMCPRoutes(mcp)` and proven over a REAL `@orkestrel/server` + a REAL `MCPServer` via
// `fetch` (no live model): an `initialize` POST MINTS a session id returned in the
// `mcp-session-id` header; a NON-initialize POST must echo a VALID id (missing / unknown → a
// 404 + a JSON-RPC error body); a `DELETE {path}` → 204 then the session is gone (a later echo
// → 404); and the resumable `GET {path}` SSE channel (a server-side push ARRIVES decoded via
// the core `SSEParser`, a reconnect echoing `Last-Event-ID` REPLAYS). The push is driven the
// REAL way — an in-request app middleware reads `context.state.session` (set by
// `createMCPSession` for a validated request) and `.push`es, so the test exercises push AND
// demonstrates the in-request push pattern. The `MCPClient` round-trip proves the client
// ECHOES the captured session end to end. (The folded replay-log mechanics — append / replay /
// capacity / TTL — are unit-tested on the `MCPSession` entity in MCPSession.test.ts.)

// The consumer TState this suite threads through the spine — extends MCPSessionState so
// createMCPSession can set `context.state.session`.
interface AppState extends MCPSessionState {}

const { track } = createTeardown<StartedServerInterface<AppState>>((handle) => handle.stop())

// The in-request PUSH pattern as a tiny app middleware: on a POST carrying `x-push-now`, read the
// session off `context.state` (set by `createMCPSession` for a validated request) and push the
// supplied message to its resumable GET stream — then short-circuit 202. The real shape of a
// request handler pushing a server-initiated message (no test-only seam).
function pushTrigger(payload: JSONRPCMessage): MiddlewareHandler<AppState> {
	return (request, context, next) => {
		if (context.method === 'POST' && request.headers.get('x-push-now') === '1') {
			const session = context.state.session
			if (session !== undefined) {
				session.push(payload)
				return new Response(null, { status: 202 })
			}
		}
		return next()
	}
}

// Stand up a STATEFUL MCP server: `createMCPSession` in front of a session-agnostic
// `createMCPRoutes`, plus (optionally) the in-request push-trigger app middleware. `ttl` /
// `capacity` / `clock` flow to the session middleware (`clock` is the deterministic manual
// clock the TTL specs advance explicitly — AGENTS §16).
async function startSession(options?: {
	readonly ttl?: number
	readonly capacity?: number
	readonly push?: JSONRPCMessage
	readonly clock?: () => number
}): Promise<StartedServerInterface<AppState>> {
	const dispatcher = createDispatcher<AppState>()
	dispatcher.add(createMCPRoutes<AppState>(createCalculatorServer()))
	const server = createServer<AppState>({ dispatcher, state: () => ({}) })
	server.use(
		createMCPSession<AppState>({
			ttl: options?.ttl,
			capacity: options?.capacity,
			clock: options?.clock,
		}),
	)
	if (options?.push !== undefined) server.use(pushTrigger(options.push))
	return track(await startServer(server))
}

// POST a non-initialize request carrying a session id header — the stateful validation path.
function postSession(
	base: string,
	id: string | undefined,
	body: unknown,
	headers?: Record<string, string>,
): Promise<Response> {
	const merged: Record<string, string> = { ...headers }
	if (id !== undefined) merged[MCP_SESSION_HEADER] = id
	return postJSON(base, body, { headers: merged })
}

describe('createMCPSession — mint / validate / DELETE', () => {
	it('initialize mints a session id, returned in the mcp-session-id response header', async () => {
		const handle = await startSession()
		const response = await postJSON(
			handle.base,
			createJSONRPCRequest({ params: { protocolVersion: '2025-06-18' } }),
		)
		expect(response.status).toBe(200)
		const id = response.headers.get(MCP_SESSION_HEADER)
		expect(id).not.toBeNull()
		// A v4 UUID — proves it is `crypto.randomUUID`, not a counter.
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
		// The body is the normal negotiated handshake — the session adds the header, not a new shape.
		expect((await response.json()).result.protocolVersion).toBe('2025-06-18')
	})

	it('a tools/list echoing the minted id succeeds', async () => {
		const handle = await startSession()
		const init = await postJSON(handle.base, createJSONRPCRequest())
		const id = init.headers.get(MCP_SESSION_HEADER)
		expect(id).not.toBeNull()
		const listed = await postSession(
			handle.base,
			id ?? undefined,
			createJSONRPCRequest({ method: 'tools/list', id: 2 }),
		)
		expect(listed.status).toBe(200)
		const body = await listed.json()
		expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['add', 'boom'])
	})

	it('a non-initialize POST with NO session id → 404 + a JSON-RPC error body', async () => {
		const handle = await startSession()
		const response = await postSession(
			handle.base,
			undefined,
			createJSONRPCRequest({ method: 'tools/list', id: 3 }),
		)
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: 'Session not found' },
		})
	})

	it('a non-initialize POST with an UNKNOWN session id → 404 + a JSON-RPC error body', async () => {
		const handle = await startSession()
		const response = await postSession(
			handle.base,
			'00000000-0000-4000-8000-000000000000', // well-formed but never minted
			createJSONRPCRequest({ method: 'ping', id: 4 }),
		)
		expect(response.status).toBe(404)
		expect((await response.json()).error.message).toBe('Session not found')
	})

	it('an initialize POST does NOT require a session header (it mints, never validates)', async () => {
		// Even with the session middleware on, the FIRST request (initialize) carries no id and must
		// succeed — otherwise a client could never bootstrap. It mints, returning the new id.
		const handle = await startSession()
		const response = await postSession(handle.base, undefined, createJSONRPCRequest())
		expect(response.status).toBe(200)
		expect(response.headers.get(MCP_SESSION_HEADER)).not.toBeNull()
	})

	it('a malformed body on a VALID session still gets the route -32700 (not pre-empted)', async () => {
		const handle = await startSession()
		// Mint a session first; a malformed body carrying that VALID id resolves the session (the
		// generic valid-session branch wins BEFORE the mint predicate awaits the body), so the
		// session layer passes it through and `createMCPRoutes` returns the canonical parse error —
		// transport-level parse failures stay the route's job, not the session gate's.
		const init = await postJSON(handle.base, createJSONRPCRequest())
		const id = init.headers.get(MCP_SESSION_HEADER)
		expect(id).not.toBeNull()
		const response = await fetch(`${handle.base}/mcp`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(id === null ? {} : { [MCP_SESSION_HEADER]: id }),
			},
			body: '{ not valid json',
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32700, message: 'Parse error' },
		})
	})

	it('DELETE {path} with the id → 204, and the session is then gone (a later echo → 404)', async () => {
		const handle = await startSession()
		const init = await postJSON(handle.base, createJSONRPCRequest())
		const id = init.headers.get(MCP_SESSION_HEADER)
		expect(id).not.toBeNull()

		const deleted = await fetch(`${handle.base}/mcp`, {
			method: 'DELETE',
			headers: id === null ? {} : { [MCP_SESSION_HEADER]: id },
		})
		expect(deleted.status).toBe(204)
		expect(await deleted.text()).toBe('')

		// The session no longer validates — a subsequent echo is rejected as unknown.
		const after = await postSession(
			handle.base,
			id ?? undefined,
			createJSONRPCRequest({ method: 'ping', id: 5 }),
		)
		expect(after.status).toBe(404)
	})

	it('DELETE with an unknown / missing id → 404 (no session to end)', async () => {
		const handle = await startSession()
		const missing = await fetch(`${handle.base}/mcp`, { method: 'DELETE' })
		expect(missing.status).toBe(404)
		const unknown = await fetch(`${handle.base}/mcp`, {
			method: 'DELETE',
			headers: { [MCP_SESSION_HEADER]: 'never-minted' },
		})
		expect(unknown.status).toBe(404)
	})

	it('a request to ANOTHER path passes straight through (the middleware owns only its path)', async () => {
		// The session middleware owns `/mcp`; a POST to a different path is not session-gated. With no
		// route registered there, the spine 404s it — proving the middleware did not short-circuit /
		// 404 it as an unknown session.
		const handle = await startSession()
		const response = await fetch(`${handle.base}/other`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(createJSONRPCRequest({ method: 'tools/list', id: 6 })),
		})
		expect(response.status).toBe(404)
		// And it is the spine's plain-text route-miss 404, not the session's JSON-RPC
		// "Session not found" error body — proving the middleware did not intercept it.
		expect(await response.text()).toBe('Not Found')
	})
})

// ── Resumable server→client SSE stream (the GET-SSE push tier) ────────────────
//
// `createMCPSession` registers the resumable `GET {path}` SSE channel: a server-side push ARRIVES
// on the open stream decoded via the core `SSEParser` (`readSSEStream`) carrying a monotone id, and
// a reconnect echoing `Last-Event-ID` REPLAYS the missed events in order. The push is driven the
// REAL way — the in-request `pushTrigger` app middleware reads `context.state.session` and
// `.push`es. The long-lived stream is read with a BOUNDED reader (take N then abort, so the test
// never hangs).

// Open the resumable GET-SSE stream for `id` and return the live `Response` + abort `controller`.
// Sends the session header + optional resume cursor.
async function openStream(
	base: string,
	id: string,
	lastEventId?: string,
): Promise<{ readonly response: Response; readonly controller: AbortController }> {
	const controller = new AbortController()
	const headers: Record<string, string> = { accept: 'text/event-stream', [MCP_SESSION_HEADER]: id }
	if (lastEventId !== undefined) headers['last-event-id'] = lastEventId
	const response = await fetch(`${base}/mcp`, { headers, signal: controller.signal })
	return { response, controller }
}

// Read EXACTLY `n` decoded SSE events off the long-lived stream, then stop — a bounded reader so a
// never-ending GET stream can't hang the test.
async function takeEvents(response: Response, n: number): Promise<readonly SSEEvent[]> {
	const events: SSEEvent[] = []
	if (n === 0) return events
	for await (const event of readSSEStream(response)) {
		events.push(event)
		if (events.length >= n) break
	}
	return events
}

// Fire the in-request push: a POST carrying the session id + `x-push-now: 1`, which the trigger
// middleware turns into a `session.push` (→ 202). The session header makes the middleware resolve +
// attach the session to `context.state`, so the handler can push to its GET stream.
function triggerPush(base: string, id: string): Promise<Response> {
	return postSession(base, id, createJSONRPCRequest({ method: 'ping', id: 'trigger' }), {
		'x-push-now': '1',
	})
}

describe('createMCPSession — resumable GET-SSE push channel', () => {
	it('an in-request push ARRIVES on the open stream, decoded + carrying an id', async () => {
		const pushed = createJSONRPCRequest({ method: 'notifications/message', id: 'srv-1' })
		const handle = await startSession({ push: pushed })
		const init = await postJSON(handle.base, createJSONRPCRequest())
		const id = init.headers.get(MCP_SESSION_HEADER)
		expect(id).not.toBeNull()
		if (id === null) return

		// Open the GET stream (the middleware attaches it synchronously before the head flushes).
		const { response, controller } = await openStream(handle.base, id)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/event-stream')

		// Drive the push the REAL way: an in-request handler reads the session off context.state and
		// pushes — the message fans out to the attached stream.
		const triggered = await triggerPush(handle.base, id)
		expect(triggered.status).toBe(202)

		const events = await takeEvents(response, 1)
		controller.abort()
		expect(events).toHaveLength(1)
		expect(JSON.parse(events[0]?.data ?? '')).toEqual(pushed)
		expect(events[0]?.id).toBeDefined()
	})

	it('a reconnect with Last-Event-ID REPLAYS the missed events in order', async () => {
		const pushed = createJSONRPCRequest({ method: 'notifications/message', id: 'srv' })
		const handle = await startSession({ push: pushed })
		const init = await postJSON(handle.base, createJSONRPCRequest())
		const id = init.headers.get(MCP_SESSION_HEADER)
		expect(id).not.toBeNull()
		if (id === null) return

		// First connection: trigger THREE pushes and read all three (capturing their ids).
		const first = await openStream(handle.base, id)
		await triggerPush(handle.base, id)
		await triggerPush(handle.base, id)
		await triggerPush(handle.base, id)
		const seen = await takeEvents(first.response, 3)
		first.controller.abort() // disconnect → the server detaches the stream
		expect(seen.map((event) => JSON.parse(event.data))).toEqual([pushed, pushed, pushed])

		// Reconnect echoing the FIRST event's id — the server replays every event STRICTLY AFTER it
		// (#2, #3) in order, ahead of any future live push.
		const cursor = seen[0]?.id
		expect(cursor).toBeDefined()
		const second = await openStream(handle.base, id, cursor)
		const replayed = await takeEvents(second.response, 2)
		second.controller.abort()
		expect(replayed.map((event) => JSON.parse(event.data))).toEqual([pushed, pushed])
		// The replayed events keep their original ids (so the client can re-resume from them).
		expect(replayed.map((event) => event.id)).toEqual([seen[1]?.id, seen[2]?.id])
	})

	it('GET with a MISSING session id → 404 + a JSON-RPC error body', async () => {
		const handle = await startSession()
		const response = await fetch(`${handle.base}/mcp`, { headers: { accept: 'text/event-stream' } })
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: 'Session not found' },
		})
	})

	it('GET with an UNKNOWN session id → 404', async () => {
		const handle = await startSession()
		const response = await fetch(`${handle.base}/mcp`, {
			headers: { accept: 'text/event-stream', [MCP_SESSION_HEADER]: 'never-minted' },
		})
		expect(response.status).toBe(404)
		expect((await response.json()).error.message).toBe('Session not found')
	})
})

describe('createMCPSession — lazy session TTL eviction', () => {
	it('a session idle past the ttl reads as absent (a later echo → 404)', async () => {
		// A 50ms TTL driven by the INJECTED manual clock (`MCPSessionOptions.clock`): mint at t=0,
		// advance PAST the ttl without touching the session, and a subsequent echo finds it evicted
		// (dropped lazily on the next access — no background timer). Manual time — no real wait, no
		// wall-clock race under suite load.
		const clock = createManualClock()
		const handle = await startSession({ ttl: 50, clock: clock.now })
		const init = await postJSON(handle.base, createJSONRPCRequest())
		const id = init.headers.get(MCP_SESSION_HEADER)
		expect(id).not.toBeNull()
		clock.advance(80) // > the 50ms ttl, no touch → evicted lazily on the next access
		const after = await postSession(
			handle.base,
			id ?? undefined,
			createJSONRPCRequest({ method: 'ping', id: 2 }),
		)
		expect(after.status).toBe(404)
	})

	it('an actively-used session stays alive past the original idle window (touch on access)', async () => {
		// TTL 80ms on the manual clock. Mint at t=0, echo at t=50 (touches → the idle window
		// restarts), echo again at t=100 (only 50ms since the touch) → still live. Touch-on-access
		// keeps an active session young — explicit instants, zero real waits.
		const clock = createManualClock()
		const handle = await startSession({ ttl: 80, clock: clock.now })
		const init = await postJSON(handle.base, createJSONRPCRequest())
		const id = init.headers.get(MCP_SESSION_HEADER)
		expect(id).not.toBeNull()
		clock.advance(50)
		const mid = await postSession(
			handle.base,
			id ?? undefined,
			createJSONRPCRequest({ method: 'ping', id: 2 }),
		)
		expect(mid.status).toBe(200) // touched at t=50 — restarts the window
		clock.advance(50)
		const after = await postSession(
			handle.base,
			id ?? undefined,
			createJSONRPCRequest({ method: 'ping', id: 3 }),
		)
		expect(after.status).toBe(200) // 50ms since the touch < 80ms → still alive
	})
})

describe('MCPClient over a server with createMCPSession — the client echoes the session', () => {
	it('connect → tools/list → tools/call all pass session validation end to end', async () => {
		// A real stateful server (createMCPSession + createMCPRoutes); the HTTP client transport
		// captures the `mcp-session-id` from the initialize response and ECHOES it on every later
		// request — so the client clears the 404 session gate without any caller wiring. If the echo
		// were missing, `tools()` (the first post-initialize request) would 404.
		const handle = await startSession()
		const client = createMCPClient({
			transport: createHTTPClientTransport({ url: `${handle.base}/mcp` }),
		})

		await client.connect() // initialize mints the session; the transport captures it
		expect(client.connected).toBe(true)

		const tools = await client.tools() // echoes the session → passes validation
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		const value = await client.call('add', {}) // a tools/call, still echoing the session
		expect(value).toBe(5)

		await client.disconnect()
	})
})
