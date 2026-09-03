import type { JSONRPCMessage } from '@src/core'
import type { ScopeInterface } from '@src/browser'
import type { ToolManagerInterface } from '@orkestrel/tool'
import { describe, expect, inject, it, vi } from 'vitest'
import {
	bindClient,
	bindServer,
	createDuplexClientTransport,
	createMCPClient,
	createMCPServer,
	DEFAULT_MCP_CACHE_TTL,
	inferRequestVersion,
	MCP_META_SERVER,
	MCP_META_VERSION,
	MCP_METHOD_HEADER,
	MCP_MODERN_VERSION,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_SESSION_HEADER,
	MCP_WEBSOCKET_SUBPROTOCOL,
	parseRequestContext,
} from '@src/core'
import {
	DEFAULT_MCP_SERVER_NAME,
	DEFAULT_MCP_SERVER_VERSION,
	createHTTPClientTransport,
	createMessagePortTransport,
	createScopeMessageListener,
	createScopeServer,
	createScopeTransport,
	createWebSocketClientTransport,
} from '@src/browser'
import { isRecord } from '@orkestrel/contract'
import { createTool, createToolManager } from '@orkestrel/tool'
import { waitForDelay } from '@orkestrel/test'
import {
	createCalculatorServer,
	createJSONRPCRequest,
	createHeaderProjectionRequest,
	HEADER_PROJECTION_CONTEXTS,
	MODERN_METADATA,
	modernRequest,
	postJSON,
	probeDuplex,
	readMethods,
} from '../../setup.js'
import { createScopeCarrier, drainRecorded, recordPort } from '../../setupBrowser.js'

// src/browser/factories.ts + src/browser/transports — the browser-face CLIENT
// transports (`createWebSocketClientTransport` over the native `WebSocket` global,
// `createHTTPClientTransport` over native `fetch`), proven in real Chromium against
// this repo's real Node-face server running outside the browser module graph. Vitest
// global setup injects only its loopback URL; no Node/server implementation reaches
// the page.

const serverURL = inject('server')

// ── WebSocket: the browser client against the Node-face WS server ────────────

describe('createWebSocketClientTransport — the browser client against the Node-face WS server', () => {
	it('connect → tools/list → tools/call(add): a value round-trips over real WebSocket frames', async () => {
		const client = createMCPClient({
			transport: createWebSocketClientTransport({
				url: `${serverURL}/mcp`,
				protocols: MCP_WEBSOCKET_SUBPROTOCOL,
			}),
		})

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		const value = await client.call('add', {})
		expect(value).toEqual({ resultType: 'complete', value: 5 })

		await client.disconnect()
		expect(client.connected).toBe(false)
	})

	it('a remote erroring tool throws locally (isError → throw)', async () => {
		const client = createMCPClient({
			transport: createWebSocketClientTransport({
				url: `${serverURL}/mcp`,
				protocols: MCP_WEBSOCKET_SUBPROTOCOL,
			}),
		})
		await client.connect()
		await expect(client.call('boom', {})).rejects.toThrow(/kaboom/)
		await client.disconnect()
	})

	it('queues sends issued before open and flushes them, in order, once the socket opens', async () => {
		const transport = createWebSocketClientTransport({
			url: `${serverURL}/mcp`,
			protocols: MCP_WEBSOCKET_SUBPROTOCOL,
		})
		const received: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => received.push(message))

		// Issue two requests WITHOUT awaiting `start()` first — both are queued pre-open.
		const starting = transport.start()
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 1 }))
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 2 }))
		await starting

		await waitForDelay(50)
		expect(received.map((message) => message.id)).toEqual([1, 2])

		await transport.close()
	})

	it('a server-initiated close fires the transport close event exactly once', async () => {
		const transport = createWebSocketClientTransport({
			url: `${serverURL}/close`,
			protocols: [],
		})
		let closeCount = 0
		transport.emitter.on('close', () => {
			closeCount += 1
		})
		await transport.start()
		await waitForDelay(50)

		expect(closeCount).toBe(1)
	})

	it('a malformed inbound frame surfaces on error and does not throw', async () => {
		const transport = createWebSocketClientTransport({
			url: `${serverURL}/malformed`,
			protocols: [],
		})
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))

		// Reaching this line without an unhandled throw IS the proof; the assertion below
		// confirms the fault was observed rather than silently dropped.
		await transport.start()
		await waitForDelay(50)

		expect(errors.length).toBeGreaterThan(0)
		await transport.close()
	})

	it('offers the default mcp protocol token that createWebSocketServer selects', async () => {
		// The server selects its configured subprotocol only when the client's offer contains
		// that token. Omitting `protocols` defaults the offer to MCP_WEBSOCKET_SUBPROTOCOL.
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${serverURL}/mcp` }),
		})

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		await client.disconnect()
	})

	it('A3: send() after close() rejects the message — no delivery, no resolve, and no queue', async () => {
		// Pin the post-close semantics: a message sent after close() rejects, is never delivered,
		// and is not HELD for a later connection. The reconnect is what separates the last two. A
		// `send` that pushed the text onto the pre-open queue and only then threw looks identical
		// on a closed socket — `close()` leaves the queue standing and `#flush` splices whatever
		// is in it the moment a socket opens — so this row reopens the transport and reads the
		// live server's own replies for the message it refused.
		const transport = createWebSocketClientTransport({
			url: `${serverURL}/mcp`,
		})
		const received: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => received.push(message))

		await transport.start()
		await transport.close()

		// Send after close — the caller learns the write failed rather than being told it landed.
		await expect(transport.send(createJSONRPCRequest({ method: 'ping', id: 99 }))).rejects.toThrow(
			'WebSocket transport is not connected',
		)
		await waitForDelay(50)

		expect(received).toEqual([])

		// Reconnect, so anything the refused send left behind is flushed onto a live socket. The
		// control rides that same socket: id 98 is really sent and its reply must come back, so an
		// absent 99 is a fact about the queue rather than about a channel carrying nothing.
		await transport.start()
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 98 }))
		await waitForDelay(50)

		expect(received.map((message) => message.id)).toEqual([98])
		await transport.close()
	})
})

// ── ONE header mechanism, proven on the browser face ─────────────────────────
//
// The Node face read `_meta[MCP_META_VERSION]` raw; this face routed the same read through
// `parseRequestContext`, which ALSO requires a valid client-capability declaration and a
// valid optional logging level. The server's own expectation (`inferHeaderIssue`) reads
// raw, so on every context that is modern-by-key-presence but not fully well formed this
// face withheld a header the server demanded — and earned `-32602` for it.
//
// The table is shared with the Node suite (`HEADER_PROJECTION_CONTEXTS`), so one face
// cannot answer it differently from the other, and some of its rows are contexts
// that parse on ONLY ONE path. A table where every row agreed would prove nothing.

describe('createHTTPClientTransport — one protocol-version projection, shared with the Node face', () => {
	it.each(HEADER_PROJECTION_CONTEXTS.map((context) => [context.label, context] as const))(
		'projects %s exactly as the Node face does',
		async (_label, context) => {
			const headers: Headers[] = []
			const transport = createHTTPClientTransport({
				url: `${serverURL}/mcp`,
				fetch: (_input, init) => {
					headers.push(new Headers(init?.headers))
					return Promise.resolve(new Response(null, { status: 202 }))
				},
			})

			await transport.send(createHeaderProjectionRequest(context.metadata))

			expect([context.label, headers[0]?.get(MCP_PROTOCOL_VERSION_HEADER) ?? undefined]).toEqual([
				context.label,
				context.version,
			])
			expect(headers[0]?.get(MCP_METHOD_HEADER)).toBe('tools/list')
		},
	)

	// The table is only evidence about the divergence if it CONTAINS the divergence. Some
	// rows are modern by key presence and refused by `parseRequestContext`: those are exactly
	// the rows the old browser path answered with no header at all.
	it('carries contexts that parse on only ONE of the paths', () => {
		const divergent = HEADER_PROJECTION_CONTEXTS.filter(
			(context) => !context.parsed && context.version !== undefined,
		)

		expect(divergent.length).toBeGreaterThan(2)
		for (const context of divergent) {
			expect([
				context.label,
				parseRequestContext(createHeaderProjectionRequest(context.metadata)),
			]).toEqual([context.label, undefined])
			expect(inferRequestVersion(createHeaderProjectionRequest(context.metadata))).toBe(
				context.version,
			)
		}
	})

	// Over a REAL cross-origin round trip to a REAL Node peer, rather than through an
	// injected `fetch`: the peer reports the header it actually received. Every divergent
	// row arrived here carrying NO `mcp-protocol-version` at all before this repair.
	it('a real peer receives the projected header for every context in the table', async () => {
		const received: unknown[] = []
		const transport = createHTTPClientTransport({ url: `${serverURL}/headers` })
		transport.emitter.on('message', (message) => {
			received.push(
				'result' in message && isRecord(message.result) ? message.result['protocol'] : undefined,
			)
		})

		for (const context of HEADER_PROJECTION_CONTEXTS) {
			await transport.send(createHeaderProjectionRequest(context.metadata))
		}

		expect(received).toEqual(HEADER_PROJECTION_CONTEXTS.map((row) => row.version))
	})
})

// ── HTTP: the browser client against the Node-face streamable-HTTP session server ─

describe('createHTTPClientTransport — the browser client against the Node-face streamable-HTTP session server', () => {
	it('connect → tools/list → tools/call(add): a value round-trips over fetch + SSE', async () => {
		const client = createMCPClient({
			transport: createHTTPClientTransport({ url: `${serverURL}/mcp` }),
		})

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		const value = await client.call('add', {})
		expect(value).toEqual({ resultType: 'complete', value: 5 })

		await client.disconnect()
	})

	it('stamps modern protocol and method headers from each body and names only tools/call', async () => {
		const protocols: Array<string | null> = []
		const methods: Array<string | null> = []
		const names: Array<string | null> = []
		const versions: unknown[] = []
		const transport = createHTTPClientTransport({
			url: `${serverURL}/mcp`,
			fetch: (input, init) => {
				const headers = new Headers(init?.headers)
				protocols.push(headers.get(MCP_PROTOCOL_VERSION_HEADER))
				methods.push(headers.get(MCP_METHOD_HEADER))
				names.push(headers.get(MCP_NAME_HEADER))
				const body = init?.body
				if (typeof body === 'string') {
					const message: unknown = JSON.parse(body)
					const params = isRecord(message) ? message['params'] : undefined
					const metadata = isRecord(params) ? params['_meta'] : undefined
					versions.push(isRecord(metadata) ? metadata[MCP_META_VERSION] : undefined)
				}
				return fetch(input, init)
			},
		})
		const client = createMCPClient({ transport })

		await client.connect()
		await client.tools()
		await client.call('add', {})

		expect(protocols).toEqual([MCP_MODERN_VERSION, MCP_MODERN_VERSION, MCP_MODERN_VERSION])
		expect(protocols).toEqual(versions)
		expect(methods).toEqual(['server/discover', 'tools/list', 'tools/call'])
		expect(names).toEqual([null, null, 'add'])
		await client.disconnect()
	})

	it('captures the mcp-session-id on initialize and reuses it across two sequential requests', async () => {
		const transport = createHTTPClientTransport({ url: `${serverURL}/mcp` })
		expect(transport.session).toBeUndefined()

		await transport.send(createJSONRPCRequest())
		const session = transport.session
		expect(session).toBeDefined()

		// Verify directly with the server: a second request WITHOUT the header would 404
		// (createMCPSession validates it) — the transport threads it automatically.
		const responses: unknown[] = []
		transport.emitter.on('message', (message) => responses.push(message))
		await transport.send(createJSONRPCRequest({ method: 'tools/list', id: 2 }))
		expect(transport.session).toBe(session)
		expect(responses).toHaveLength(1)

		// A raw request confirms the id genuinely gates access — without it the same
		// non-initialize call is rejected.
		const denied = await postJSON(serverURL, createJSONRPCRequest({ method: 'tools/list', id: 3 }))
		expect(denied.status).toBe(404)

		const allowed = await postJSON(
			serverURL,
			createJSONRPCRequest({ method: 'tools/list', id: 4 }),
			{ headers: { [MCP_SESSION_HEADER]: session ?? '' } },
		)
		expect(allowed.status).toBe(200)
	})

	it('captures the negotiated protocol and sends it on the subsequent real fetch request', async () => {
		const protocols: Array<string | null> = []
		const methods: Array<string | null> = []
		const names: Array<string | null> = []
		const transport = createHTTPClientTransport({
			url: `${serverURL}/mcp`,
			fetch: (input, init) => {
				const headers = new Headers(init?.headers)
				protocols.push(headers.get(MCP_PROTOCOL_VERSION_HEADER))
				methods.push(headers.get(MCP_METHOD_HEADER))
				names.push(headers.get(MCP_NAME_HEADER))
				return fetch(input, init)
			},
		})
		const client = createMCPClient({ transport, version: MCP_MODERN_VERSION })

		await client.connect()

		// Modern connect probes discovery once, with its version and method projected to headers.
		expect(protocols).toEqual([MCP_MODERN_VERSION])
		expect(methods).toEqual(['server/discover'])
		expect(names).toEqual([null])
		await client.disconnect()
	})

	it('rejects an unsupported negotiated protocol (F4) and never captures its header', async () => {
		// Force the JSON reply framing (already a supported server response shape) and
		// rewrite the initialize result's `protocolVersion` to an UNSUPPORTED value in
		// flight — the real network round-trip stays real; only the injected `fetch`
		// mutates the decoded body, so `MCPClient` must reject the handshake (F4) and the
		// transport must never have captured the unsupported value.
		const protocols: Array<string | null> = []
		const transport = createHTTPClientTransport({
			url: `${serverURL}/mcp`,
			fetch: async (input, init) => {
				protocols.push(new Headers(init?.headers).get(MCP_PROTOCOL_VERSION_HEADER))
				const headers = new Headers(init?.headers)
				headers.set('accept', 'application/json')
				const response = await fetch(input, { ...init, headers })
				const body: unknown = await response.json()
				if (isRecord(body) && isRecord(body['result'])) {
					body['result']['supportedVersions'] = ['2099-01-01']
				}
				return new Response(JSON.stringify(body), {
					status: response.status,
					headers: response.headers,
				})
			},
		})
		const client = createMCPClient({ transport, version: MCP_MODERN_VERSION })

		await expect(client.connect()).rejects.toThrow(
			'MCP server does not support the pinned protocol version',
		)

		// The capture gate: a further request through the SAME transport instance still
		// carries no `mcp-protocol-version` header — the unsupported value was never
		// captured, and `MCPClient.connect`'s `transport.close()` on the failed handshake
		// left nothing to clear.
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 99 }))
		expect(protocols).toEqual([MCP_MODERN_VERSION, null])
	})

	it('decodes the Streamable-HTTP SSE reply leg (the default framing this client requests)', async () => {
		const transport = createHTTPClientTransport({ url: `${serverURL}/mcp` })
		const messages: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))

		await transport.send(createJSONRPCRequest({ params: { _meta: MODERN_METADATA } }))
		// `server/discover` carries the second leg because 2026-07-28 removes `ping`: a modern
		// request for it comes back -32601 and would frame an error rather than a result.
		await transport.send(
			createJSONRPCRequest({
				method: 'server/discover',
				id: 2,
				params: { _meta: MODERN_METADATA },
			}),
		)

		expect(messages).toHaveLength(2)
		expect(messages[1]).toMatchObject({
			jsonrpc: '2.0',
			id: 2,
			result: { resultType: 'complete', supportedVersions: [MCP_MODERN_VERSION] },
		})
	})

	// The non-success contract is the core class's, so it reads the same from a page as it does
	// from Node: a peer that answered with a body carrying no JSON-RPC message REJECTS the send
	// rather than resolving and leaving the caller's correlated request to its own deadline.
	it('rejects a server error response carrying no JSON-RPC message', async () => {
		const transport = createHTTPClientTransport({ url: `${serverURL}/broken` })
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))

		await expect(transport.send(createJSONRPCRequest())).rejects.toThrow(
			'HTTP 500 response contained an application/json body that was not a JSON-RPC message',
		)
		expect(errors).toEqual([])
	})
})

describe('createMessagePortTransport — a symmetric MCPTransportInterface over a real MessageChannel', () => {
	it('connect → tools/list → tools/call(add): a value round-trips over port1/port2', async () => {
		const { port1, port2 } = new MessageChannel()
		const server = createCalculatorServer()
		bindServer(server, createMessagePortTransport({ port: port1 }))

		const clientTransport = createMessagePortTransport({ port: port2 })
		const client = createMCPClient({ transport: createDuplexClientTransport(clientTransport) })
		bindClient(client, clientTransport)

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		const value = await client.call('add', {})
		expect(value).toEqual({ resultType: 'complete', value: 5 })

		await client.disconnect()
	})

	it('a remote erroring tool throws locally (isError → throw)', async () => {
		const { port1, port2 } = new MessageChannel()
		const server = createCalculatorServer()
		bindServer(server, createMessagePortTransport({ port: port1 }))

		const clientTransport = createMessagePortTransport({ port: port2 })
		const client = createMCPClient({ transport: createDuplexClientTransport(clientTransport) })
		bindClient(client, clientTransport)
		await client.connect()

		await expect(client.call('boom', {})).rejects.toThrow(/kaboom/)
		await client.disconnect()
	})
})

// ── `duplex` is a property of the CARRIER, not a literal it returns ──────────
//
// Every transport declares `duplex`, and `MCPClient` writes a client-initiated
// `notifications/cancelled` only where the declaration is `true`. Reading the getter back
// proves nothing about the wire: `send` accepts any message, so a carrier with no
// client→server channel writes the frame and drops it in silence. So each carrier below is
// DRIVEN — a real request aborted mid-flight — and the claim is settled by what the PEER
// received, over a real socket, a real `MessageChannel`, or a real scope pair.
//
// The control is drawn from OUTSIDE the population of honestly-declaring transports: a real
// one-way carrier that LIES. Certifying the instrument only against our own transports would
// test it exactly where it has never been wrong.

describe('duplex — driven per carrier, and observed at the peer', () => {
	it('the WebSocket carrier declares duplex and really carries the frame', async () => {
		const transport = createWebSocketClientTransport({
			url: `${serverURL}/record`,
			protocols: MCP_WEBSOCKET_SUBPROTOCOL,
		})
		const client = createMCPClient({ transport })
		await client.connect()
		await drainRecorded(serverURL)

		const frames = await probeDuplex(client, () => drainRecorded(serverURL))

		expect(transport.duplex).toBe(true)
		expect(readMethods(frames)).toEqual(['tools/call', 'notifications/cancelled'])
		await client.disconnect()
	})

	it('the Streamable-HTTP carrier declares no such channel and sends nothing', async () => {
		const transport = createHTTPClientTransport({ url: `${serverURL}/mcp` })
		const client = createMCPClient({ transport })
		await client.connect()
		await drainRecorded(serverURL)

		const frames = await probeDuplex(client, () => drainRecorded(serverURL))

		// The drain is LIVE — the aborted call itself reached the peer — so the missing
		// cancellation is the carrier withholding it, not the instrument seeing nothing.
		expect(transport.duplex).toBe(false)
		expect(readMethods(frames)).toEqual(['tools/call'])
	})

	it('createDuplexClientTransport over a real MessageChannel carries the frame', async () => {
		const { port1, port2 } = new MessageChannel()
		bindServer(createCalculatorServer(), createMessagePortTransport({ port: port1 }))
		const carrier = createMessagePortTransport({ port: port2 })
		const drain = recordPort(port1)
		const transport = createDuplexClientTransport(carrier)
		const client = createMCPClient({ transport })
		bindClient(client, carrier)
		await client.connect()
		drain()

		const frames = await probeDuplex(client, () => Promise.resolve(drain()))

		expect(transport.duplex).toBe(true)
		expect(readMethods(frames)).toEqual(['tools/call', 'notifications/cancelled'])
		await client.disconnect()
	})

	it('createDuplexClientTransport over a real scope pair carries the frame', async () => {
		const carrier = createScopeCarrier()
		bindServer(createCalculatorServer(), carrier.server)
		const transport = createDuplexClientTransport(carrier.client)
		const client = createMCPClient({ transport })
		bindClient(client, carrier.client)
		await client.connect()
		carrier.drain()

		const frames = await probeDuplex(client, () => Promise.resolve(carrier.drain()))

		expect(transport.duplex).toBe(true)
		expect(readMethods(frames)).toEqual(['tools/call', 'notifications/cancelled'])
		await client.disconnect()
	})

	// THE CONTROL, from outside the population: a real one-way carrier that declares
	// `duplex: true` and cannot carry. `createDuplexClientTransport` returns the literal for
	// ANY `MCPTransportInterface`, so closing the peer half after the handshake produces a
	// carrier whose declaration is a lie — and the driven proof the cases above pass
	// must come back FALSE for it. An instrument that reported "carried" here could not tell
	// a duplex carrier from a declaration.
	it('CONTROL: a lying one-way carrier declares duplex and the driven proof fails for it', async () => {
		const { port1, port2 } = new MessageChannel()
		bindServer(createCalculatorServer(), createMessagePortTransport({ port: port1 }))
		const carrier = createMessagePortTransport({ port: port2 })
		const drain = recordPort(port1)
		const transport = createDuplexClientTransport(carrier)
		const client = createMCPClient({ transport })
		bindClient(client, carrier)
		await client.connect()

		// The tap saw the handshake, so it is a working instrument rather than a silent one.
		expect(readMethods(drain()).length).toBeGreaterThan(0)
		// The peer half goes away AFTER the handshake: the declaration stays `true` and the
		// channel is now one-way, which is exactly the failure a declaration cannot express.
		port1.close()

		const frames = await probeDuplex(client, () => Promise.resolve(drain()))

		expect(transport.duplex).toBe(true)
		expect(readMethods(frames)).toEqual([])
		// The proof the honest carriers pass, evaluated here: it is FALSE.
		expect(readMethods(frames).includes('notifications/cancelled')).toBe(false)
	})
})

// ── The scope server: createScopeServer over a scope double ─────────────────
//
// `createScopeServer` defaults its scope to `globalThis`; it is driven here with SCOPE
// DOUBLES (a real object satisfying `ScopeInterface`'s structural shape, not a mock of this
// package's own code) covering the shapes the unified design serves: a dedicated-worker-shaped
// double (implicit portless channel) and a Service-Worker-shaped double (message events
// carrying a real `MessagePort`, built from a real `new MessageChannel()`). Raw JSON-RPC
// request/response strings prove the wiring without needing a full `MCPClient` for every
// scenario.

interface ScopeDoubleInterface {
	readonly scope: ScopeInterface
	readonly sent: readonly unknown[]
	readonly listenerCount: number
	dispatch(init: { data?: unknown; ports?: readonly MessagePort[] }): void
}

function createScopeDouble(): ScopeDoubleInterface {
	const sent: unknown[] = []
	const listeners = new Set<(event: MessageEvent) => void>()
	const scope: ScopeInterface = {
		postMessage(message: unknown): void {
			sent.push(message)
		},
		addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
			listeners.add(listener)
		},
		removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
			listeners.delete(listener)
		},
	}
	return {
		scope,
		get sent() {
			return sent
		},
		get listenerCount() {
			return listeners.size
		},
		dispatch(init) {
			const ports = init.ports === undefined ? [] : [...init.ports]
			const event = new MessageEvent('message', { data: init.data, ports })
			for (const listener of listeners) listener(event)
		},
	}
}

function createCalculatorTools(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
	return tools
}

// The scope double hosts a bare modern server. Use `modernRequest` because a version-less
// `createJSONRPCRequest` is correctly rejected by that server with JSON-RPC -32602, and drive
// `server/discover` because it is the modern era's own required RPC — 2026-07-28 removes
// `ping`, so a bare server answers that one -32601 and it cannot carry a transport canary.
function expectModernReply(message: unknown, id: number): void {
	expect(JSON.parse(String(message))).toEqual({
		jsonrpc: '2.0',
		id,
		result: {
			resultType: 'complete',
			supportedVersions: [MCP_MODERN_VERSION],
			capabilities: { tools: {} },
			ttlMs: DEFAULT_MCP_CACHE_TTL,
			cacheScope: 'private',
			_meta: {
				[MCP_META_SERVER]: {
					name: DEFAULT_MCP_SERVER_NAME,
					version: DEFAULT_MCP_SERVER_VERSION,
				},
			},
		},
	})
}

describe('createScopeServer — the default scope is the current one', () => {
	it('wires the real global scope when no scope argument is supplied', async () => {
		// Inside a worker this default IS that worker's `self`. The page's own `globalThis`
		// satisfies the same structural shape, so the default path is driven here for real
		// rather than through a double: a port-bearing `MessageEvent` dispatched on `window`
		// reaches the listener the factory registered, and the reply comes back over the port.
		const worker = createScopeServer({ tools: createCalculatorTools() })
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		try {
			globalThis.dispatchEvent(new MessageEvent('message', { data: null, ports: [port1] }))
			port2.postMessage(JSON.stringify(modernRequest('server/discover')))
			await vi.waitFor(() => expect(replies).toHaveLength(1))

			expectModernReply(replies[0], 1)
		} finally {
			worker.stop()
		}
	})

	it('stops listening on the global scope, so a later event binds nothing', async () => {
		const worker = createScopeServer({ tools: createCalculatorTools() })
		worker.stop()
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		globalThis.dispatchEvent(new MessageEvent('message', { data: null, ports: [port1] }))
		port2.postMessage(JSON.stringify(modernRequest('server/discover')))
		await waitForDelay(30)

		expect(replies).toEqual([])
	})
})

describe('createScopeServer — dedicated-worker-shaped scope (implicit, portless channel)', () => {
	it('a portless string-data message round-trips through the implicit scope channel', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)

		double.dispatch({ data: JSON.stringify(modernRequest('tools/list')) })

		await vi.waitFor(() => expect(double.sent).toHaveLength(1))
		const reply: { result: { tools: ReadonlyArray<{ name: string }> } } = JSON.parse(
			String(double.sent[0]),
		)
		expect(reply.result.tools.map((tool) => tool.name)).toEqual(['add'])

		worker.stop()
	})

	it('an event with a port on a dedicated-worker-shaped double STILL spawns a per-port binding (cross-case)', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('server/discover')))

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		expectModernReply(replies[0], 1)
		expect(double.sent).toEqual([])

		worker.stop()
	})
})

describe('createScopeServer — Service-Worker-shaped scope (per-client MessagePort, no implicit postMessage)', () => {
	it('a message event carrying a port spawns a per-port binding; the client round-trips over it', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 1,
					params: { name: 'add', arguments: {}, _meta: MODERN_METADATA },
				}),
			),
		)

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		const reply: { error: { code: number } } = JSON.parse(String(replies[0]))
		expect(reply.error.code).toBe(-32603)

		worker.stop()
	})

	it('two connecting clients (two channels) get ISOLATED sessions — a call on one never replies on the other', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)
		const channelA = new MessageChannel()
		const channelB = new MessageChannel()
		const repliesA: unknown[] = []
		const repliesB: unknown[] = []
		channelA.port2.addEventListener('message', (event: MessageEvent) => repliesA.push(event.data))
		channelB.port2.addEventListener('message', (event: MessageEvent) => repliesB.push(event.data))
		channelA.port2.start()
		channelB.port2.start()

		double.dispatch({ ports: [channelA.port1] })
		double.dispatch({ ports: [channelB.port1] })
		channelA.port2.postMessage(JSON.stringify(modernRequest('server/discover')))

		await vi.waitFor(() => expect(repliesA).toHaveLength(1))
		await waitForDelay(30)
		expect(repliesB).toEqual([])

		worker.stop()
	})
})

describe('createScopeServer — stop', () => {
	it('after stop, a new request on an already-accepted port gets NO reply', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('server/discover')))
		await vi.waitFor(() => expect(replies).toHaveLength(1))

		worker.stop()
		port2.postMessage(JSON.stringify(modernRequest('server/discover', 2)))
		await waitForDelay(30)

		expect(replies).toHaveLength(1)
	})

	it('after stop, the scope listener is removed — a new port-carrying event binds nothing', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)
		expect(double.listenerCount).toBe(1)

		worker.stop()
		expect(double.listenerCount).toBe(0)

		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('server/discover')))
		await waitForDelay(30)

		expect(replies).toEqual([])
	})

	it('a second worker.stop() is a no-op', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)

		worker.stop()
		expect(() => worker.stop()).not.toThrow()
		expect(double.listenerCount).toBe(0)
	})
})

describe('createScopeServer — accept option', () => {
	it('accept returning false drops the event: no binding, no reply', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer(
			{ tools: createCalculatorTools(), accept: () => false },
			double.scope,
		)
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('server/discover')))
		await waitForDelay(30)

		expect(replies).toEqual([])
		worker.stop()
	})

	it('accept filtering by event.data token: only a matching token gets bound', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer(
			{ tools: createCalculatorTools(), accept: (event) => event.data === 'allow' },
			double.scope,
		)
		const allowed = new MessageChannel()
		const denied = new MessageChannel()
		const allowedReplies: unknown[] = []
		const deniedReplies: unknown[] = []
		allowed.port2.addEventListener('message', (event: MessageEvent) =>
			allowedReplies.push(event.data),
		)
		denied.port2.addEventListener('message', (event: MessageEvent) =>
			deniedReplies.push(event.data),
		)
		allowed.port2.start()
		denied.port2.start()

		double.dispatch({ data: 'deny', ports: [denied.port1] })
		double.dispatch({ data: 'allow', ports: [allowed.port1] })
		allowed.port2.postMessage(JSON.stringify(modernRequest('server/discover')))
		await vi.waitFor(() => expect(allowedReplies).toHaveLength(1))

		expectModernReply(allowedReplies[0], 1)
		denied.port2.postMessage(JSON.stringify(modernRequest('server/discover', 2)))
		await waitForDelay(30)
		expect(deniedReplies).toEqual([])

		worker.stop()
	})
})

describe('createScopeServer — stop mid-flight', () => {
	it('stop while a request is in flight: no unhandled rejection; no reply after stop', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('tools/call')))
		worker.stop()
		await waitForDelay(50)

		const replyCount = replies.length
		port2.postMessage(JSON.stringify(modernRequest('server/discover', 2)))
		await waitForDelay(30)

		expect(replies.length).toBe(replyCount)
	})
})

describe('createScopeServer — double-port-delivery dedup', () => {
	it('the same port delivered twice is deduped: only one binding, only one reply per request', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('server/discover')))
		await vi.waitFor(() => expect(replies).toHaveLength(1))

		expect(replies).toHaveLength(1)
		expectModernReply(replies[0], 1)
		worker.stop()
	})
})

describe('createScopeServer — hostile inbound', () => {
	it('malformed JSON string on a bound port produces no unhandled throw (a -32700 reply)', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage('not valid json{{{')

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		const reply: { error: { code: number } } = JSON.parse(String(replies[0]))
		expect(reply.error.code).toBe(-32700)

		worker.stop()
	})

	it('an oversized string on a bound port is handled without crashing', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		const oversized = 'x'.repeat(1_000_000)
		port2.postMessage(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 1,
					params: { name: 'add', arguments: { x: oversized }, _meta: MODERN_METADATA },
				}),
			),
		)

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		const reply: { error: { code: number } } = JSON.parse(String(replies[0]))
		expect(reply.error.code).toBe(-32603)

		worker.stop()
	})

	it('an object payload on a portless event is ignored — no reply, no crash', async () => {
		const double = createScopeDouble()
		const worker = createScopeServer({ tools: createCalculatorTools() }, double.scope)

		double.dispatch({ data: { not: 'a string' } })
		double.dispatch({ data: JSON.stringify(modernRequest('server/discover')) })

		await vi.waitFor(() => expect(double.sent).toHaveLength(1))
		expectModernReply(double.sent[0], 1)

		worker.stop()
	})
})

// ── createScopeMessageListener — the dedup state and the teardown state are ONE ────
//
// The dedup was right and its bookkeeping was not. The listener kept accepted ports in a `seen`
// set private to its own closure, while the teardown callbacks went into the caller's
// `teardowns`. `createScopeServer`'s `stop` could reach only the second one, so a Service Worker —
// the shape the doc names, whose closure lives as long as the worker — retained every
// `MessagePort` it had ever accepted, including ports already closed and unbound, for the
// worker's life. Separate collections over one lifetime is what let one of them be forgotten.
//
// There is now one collection: the teardown map is KEYED by the port it tears down, so
// membership answers "already bound?" and clearing the map drops both facts at once. The
// rows below drive the exported listener with a caller-owned map, which is the only seam from
// which either fact is observable at all.

describe('createScopeMessageListener — one collection carries both the teardown and the dedup', () => {
	it('keys each accepted port binding by the port, so no dedup state sits outside the caller-owned map', () => {
		const double = createScopeDouble()
		const server = createMCPServer({
			tools: createCalculatorTools(),
			identity: { name: DEFAULT_MCP_SERVER_NAME, version: DEFAULT_MCP_SERVER_VERSION },
		})
		const scopeTransport = createScopeTransport(double.scope)
		const teardowns = new Map<MessagePort, () => void>()
		const onMessage = createScopeMessageListener(server, scopeTransport, teardowns, {
			tools: createCalculatorTools(),
		})
		const { port1 } = new MessageChannel()

		onMessage(new MessageEvent('message', { ports: [port1] }))
		expect([...teardowns.keys()]).toEqual([port1])

		// The dedup reads that same map, so a repeat delivery adds nothing.
		onMessage(new MessageEvent('message', { ports: [port1] }))
		expect(teardowns.size).toBe(1)

		// Clearing the map the way `stop` does drops the dedup state with it: the SAME port
		// is accepted again afterwards. A private `seen` set would have refused this forever.
		for (const teardown of teardowns.values()) teardown()
		teardowns.clear()
		onMessage(new MessageEvent('message', { ports: [port1] }))
		expect([...teardowns.keys()]).toEqual([port1])

		for (const teardown of teardowns.values()) teardown()
	})
})
