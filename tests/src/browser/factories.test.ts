import type { JSONRPCMessage } from '@src/core'
import { describe, expect, inject, it, vi } from 'vitest'
import {
	bindClient,
	bindServer,
	createDuplexClientTransport,
	createMCPClient,
	inferRequestVersion,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	parseRequestContext,
} from '@src/core'
import {
	createHTTPClientTransport,
	createMessagePortTransport,
	createWebSocketClientTransport,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_SESSION_HEADER,
	MCP_WEBSOCKET_SUBPROTOCOL,
} from '@src/browser'
import { isRecord } from '@orkestrel/contract'
import { waitForDelay } from '@orkestrel/test'
import {
	createCalculatorServer,
	createJSONRPCRequest,
	createHeaderProjectionRequest,
	HEADER_PROJECTION_CONTEXTS,
	MODERN_METADATA,
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

	it('A3: send() after close() silently drops the message — no throw, no delivery', async () => {
		// Pin the post-close semantics: a message sent after close() is dropped, not queued.
		// This test uses a live server so any wrongly-queued message would surface on reconnect.
		const transport = createWebSocketClientTransport({
			url: `${serverURL}/mcp`,
		})
		const received: unknown[] = []
		transport.emitter.on('message', (message) => received.push(message))

		await transport.start()
		await transport.close()

		// Send after close — must not throw and the message must never arrive.
		await expect(
			transport.send(createJSONRPCRequest({ method: 'ping', id: 99 })),
		).resolves.toBeUndefined()
		await waitForDelay(50)

		expect(received).toEqual([])
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
		await transport.send(
			createJSONRPCRequest({ method: 'ping', id: 2, params: { _meta: MODERN_METADATA } }),
		)

		expect(messages).toHaveLength(2)
		expect(messages[1]).toMatchObject({
			jsonrpc: '2.0',
			id: 2,
			result: { resultType: 'complete' },
		})
	})

	it('a server error response surfaces on the error event rather than hanging', async () => {
		const transport = createHTTPClientTransport({ url: `${serverURL}/broken` })
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))

		await transport.send(createJSONRPCRequest())

		expect(errors).toHaveLength(1)
	})
})

// ── MessagePort: a genuinely SYMMETRIC MCPTransportInterface, both sides driven by
// the SAME class over one REAL native `new MessageChannel()` (no mocks) — port1
// bound to a REAL server (`bindServer`), port2 driving a REAL
// client (`bindClient` + `createDuplexClientTransport`) ───────────────────────

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

	it('a non-string postMessage payload is ignored — no crash, no reply', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		port2.postMessage({ not: 'a string' })
		port2.postMessage('sentinel')
		await vi.waitFor(() => expect(received).toEqual(['sentinel']))
	})

	it('a string postMessage payload IS delivered to the registered listen handler', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		port2.postMessage('a plain string message')
		await vi.waitFor(() => expect(received).toEqual(['a plain string message']))
	})

	it('close() closes the port — a subsequent postMessage from the peer is undelivered', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		await transport.close()
		port2.postMessage('after close')
		await waitForDelay(50)

		expect(received).toEqual([])
	})

	it('close detaches its port listeners and clears registered callbacks', async () => {
		const { port1 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		await transport.close()
		port1.dispatchEvent(new MessageEvent('message', { data: 'after close' }))

		expect(received).toEqual([])
	})

	it('close() fires the registered closed handler exactly once, even called twice', async () => {
		const { port1 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		let closedCalls = 0
		transport.closed(() => {
			closedCalls += 1
		})

		await transport.close()
		await transport.close()

		expect(closedCalls).toBe(1)
	})

	it('listen/closed are single-handler-replace — a second registration replaces, never adds', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const first: string[] = []
		const second: string[] = []
		transport.listen((message) => first.push(message))
		transport.listen((message) => second.push(message))

		port2.postMessage('one')
		await vi.waitFor(() => expect(second).toEqual(['one']))
		expect(first).toEqual([])
	})

	it('a messageerror event does not close the transport — later well-formed messages still arrive', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const received: string[] = []
		let closedCalls = 0
		transport.listen((message) => received.push(message))
		transport.closed(() => {
			closedCalls += 1
		})

		// Dispatch a genuine `messageerror` event directly on port1 — the real native
		// event this transport's listener is registered for (a `MessagePort` is a real
		// `EventTarget`, so this is a real event dispatch, not a mock of the transport).
		port1.dispatchEvent(new MessageEvent('messageerror', { data: null }))
		port2.postMessage('still works')
		await vi.waitFor(() => expect(received).toEqual(['still works']))

		expect(closedCalls).toBe(0)
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
