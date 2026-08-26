import type {
	MCPClientTransportEventMap,
	MCPClientTransportInterface,
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCMessage,
	JSONRPCResponse,
	MCPDispatcherInterface,
} from '@src/core'
import type { ToolManagerInterface } from '@orkestrel/tool'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
	createMCPClient,
	createMCPLegacy,
	createMCPServer,
	isMCPError,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_UNSUPPORTED_VERSION,
	parseJSONRPCMessage,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@src/core'
import { createHTTPClientTransport } from '@src/server'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createEmitter } from '@orkestrel/emitter'
import { createServer } from 'node:http'
import { createSignal, waitForDelay } from '@orkestrel/test'
import { isRecord } from '@orkestrel/contract'
import { createInputServer } from '../../setup.js'

const NATIVE_ABORT_TIMEOUT = AbortSignal.timeout
const RECORDED_ABORT_DEADLINES: number[] = []

function recordAbortTimeout(deadline: number): AbortSignal {
	RECORDED_ABORT_DEADLINES.push(deadline)
	return NATIVE_ABORT_TIMEOUT(deadline)
}

// MCPClient ↔ a REAL MCPServer over an in-process LOOPBACK transport (a
// real server + real ToolManager, no mocks of the unit under test). The loopback's
// `send` dispatches each message through the server's `dispatch` and emits the response
// back on its `message` event, so the full `initialize` / `tools/list` / `tools/call`
// path runs in-process and deterministically. The OVER-FETCH JSON/SSE wire path is
// pinned in tests/src/server/mcp/HTTPClientTransport.test.ts; the LIVE model round-trip
// in tests/src/ollama/mcp.test.ts. Here: the handshake, tool discovery + local-tool
// wrapping (the wrapped `execute` calls back over the loopback), the content round-trip
// + a remote-error → local throw, id correlation, the per-request timeout, and
// disconnect rejecting pending requests.

// An in-process loopback ClientTransport over a real MCPServer: each sent message is
// dispatched through the server and its response (if any) emitted on `message` — a real
// transport, not a mock. `gate` optionally WITHHOLDS the response for a chosen method
// (so a request stays pending), to drive the timeout / disconnect paths. `sent` records
// every method sent, for the correlation / handshake assertions.
interface LoopbackInterface extends MCPClientTransportInterface {
	readonly sent: readonly string[]
	readonly requests: readonly JSONRPCInvocation[]
	readonly started: number
	readonly closed: number
	// The ORDERED transport lifecycle, recording each `start` / `close` at the moment the step
	// hands control back — including a `close` that then FAULTS, because the client did perform
	// it. Counts alone cannot see an interleaving: `{started: 2, closed: 1}` is the same tally
	// whether the second start ran before or after the close finished.
	readonly lifecycle: readonly string[]
}

// A fixture peer additionally exposes `release()`, which drains every suspended lifecycle step
// the peer is currently parking — a `close.hold`-suspended `close()`, a `send.park`-suspended
// `send()`, a `start.hold`-suspended `start()`, or any of them — and `live`: how many connections
// it currently has OPEN. `live` is the instrument the attempt counters cannot be. `closed` counts
// close ATTEMPTS, so `{ started: 2, closed: 2 }` reads identically whether both connections closed
// or one close FAILED and left its connection open with no path back to it; `lifecycle` records the
// same attempts in order and cannot separate them either. `live` rises when a `start()` completes
// and falls only when a `close()` SUCCEEDS, so it is the one reading that answers "is anything
// still open".
//
// Recorded gap: `release()` drains ONE shared list, so "release the held close while the held start
// stays held" is inexpressible. No scenario here needs it — every test holding two steps at once
// releases them in the order the client reaches them — but a test that must free one kind of
// suspension while another stays parked needs the list split by step first.
interface FixturePeerInterface extends LoopbackInterface {
	readonly live: number
	release(): void
}

function createLoopback(
	server: MCPDispatcherInterface,
	gate?: (method: string) => boolean,
): LoopbackInterface {
	const emitter = createEmitter<MCPClientTransportEventMap>()
	const requests: JSONRPCInvocation[] = []
	const lifecycle: string[] = []
	let started = 0
	let closed = 0
	return {
		emitter,
		session: undefined,
		duplex: true,
		get sent() {
			return requests.map((request) => request.method)
		},
		get requests() {
			return requests
		},
		get started() {
			return started
		},
		get closed() {
			return closed
		},
		get lifecycle() {
			return lifecycle
		},
		async start() {
			started += 1
			lifecycle.push('start')
		},
		async send(message: JSONRPCMessage) {
			if (!('method' in message)) return
			requests.push(message)
			const answer = await server.dispatch(message)
			// This scripted peer drives only unary methods, so a held-open stream never
			// arrives here; narrow it off rather than pretending it is a message.
			if (answer === undefined || Symbol.asyncIterator in answer) return
			// `gate(method)` true → withhold the response (the request stays pending), to
			// drive the timeout / disconnect tests; otherwise emit it for id correlation.
			if (gate === undefined || !gate(message.method)) emitter.emit('message', answer)
		},
		async close() {
			closed += 1
			lifecycle.push('close')
		},
	}
}

// The peer's seams, grouped under the transport method each one shapes. Every leaf answers for ONE
// call, keyed by that call's 1-based count, because a boolean seam cannot express "the first close
// fails, the second succeeds" — which is exactly what the client documents about a faulted close,
// and what no instrument in this file could previously produce.
interface FixturePeerOptions {
	// The scripted answer to one request: a correlated response, a transport failure, or nothing.
	readonly reply: (request: JSONRPCInvocation, count: number) => JSONRPCResponse | Error | undefined
	// The OPENING step's seams. `hold` suspends the chosen `start()` through the shared
	// held-resolver list — a transport whose socket or session is still coming up — until
	// `release()` drains it; `enter` runs at `start()`'s first statement, before any await, so an
	// injected transport can re-enter the client at the one position that observes what the client
	// published before it handed control away. `fault` makes the chosen `start()` FAIL after it has
	// already opened its connection — the acquire-then-reject class, which the client cannot see and
	// therefore cannot clean up.
	readonly start?: {
		readonly hold?: (count: number) => boolean
		readonly enter?: () => void
		readonly fault?: (count: number) => boolean
	}
	// `park` suspends the write of the chosen method through that same list, for a slow write of a
	// handshake step, so a test can observe what the client does WHILE the write is still in flight.
	// Keyed by the same 1-based request count `reply` receives, so "the FIRST notification, not the
	// one a reconnect sends" is a predicate rather than a counter smuggled into the test.
	readonly send?: { readonly park?: (method: string, count: number) => boolean }
	// `hold` suspends the chosen `close()` — a real transport whose shutdown takes time, a socket
	// draining, an HTTP session ending — so a test can observe what the client does WHILE a close is
	// still in flight; a held close the test never releases is a shutdown that never returns at all.
	// `fault` makes the chosen `close()` FAIL: a socket that refuses to drain, a peer that rejects
	// the shutdown.
	readonly close?: {
		readonly hold?: (count: number) => boolean
		readonly fault?: (count: number) => boolean
	}
	// What the carrier declares about client-initiated notifications. Defaults to a duplex
	// channel; `false` is the CONTROL for every claim about a cancellation frame, because it
	// is the carrier class the frame structurally cannot reach — a request/response transport
	// with no client→server notification channel at all, not a duplex one behaving badly.
	readonly duplex?: boolean
}

// A minimal protocol-faithful peer for negotiation paths a conforming local MCPServer cannot
// produce. The script returns a correlated response, no response, or a transport failure; the peer
// records every real JSON-RPC request, preserves the lifecycle counts, and counts its own live
// connections. No fake clock, no mock: each suspension is a real unresolved promise the test itself
// settles, and each fault is a real rejection out of the real interface.
function createFixturePeer(options: FixturePeerOptions): FixturePeerInterface {
	const emitter = createEmitter<MCPClientTransportEventMap>()
	const requests: JSONRPCInvocation[] = []
	const lifecycle: string[] = []
	const held: Array<() => void> = []
	let started = 0
	let closed = 0
	let live = 0
	return {
		emitter,
		session: undefined,
		duplex: options.duplex ?? true,
		get sent() {
			return requests.map((request) => request.method)
		},
		get requests() {
			return requests
		},
		get started() {
			return started
		},
		get closed() {
			return closed
		},
		get lifecycle() {
			return lifecycle
		},
		get live() {
			return live
		},
		async start() {
			options.start?.enter?.()
			// Indexed off the count this call WILL take: `started` moves once the open completes, so
			// a test can still read `started === 0` while the opening step is suspended.
			if (options.start?.hold?.(started + 1) === true) {
				await new Promise<void>((resolve) => {
					held.push(resolve)
				})
			}
			started += 1
			live += 1
			lifecycle.push('start')
			// Opened, then refused: the connection exists and the caller is told the open failed, so
			// nothing on the client side ever has a claim on it. Recorded AFTER `live` rises, because
			// that strand is the whole point of the seam.
			if (options.start?.fault?.(started) === true) throw new Error('transport start failed')
		},
		async send(message) {
			if (!('method' in message)) return
			requests.push(message)
			const count = requests.length
			// A parked write has left the client but not yet reached the peer, so the peer
			// answers only once `release()` lets the write land.
			if (options.send?.park?.(message.method, count) === true) {
				await new Promise<void>((resolve) => {
					held.push(resolve)
				})
			}
			const response = options.reply(message, count)
			if (response instanceof Error) throw response
			if (response !== undefined) emitter.emit('message', response)
		},
		async close() {
			// Counted on ENTRY, so a suspended close still has a stable index and the seams can name
			// it; `lifecycle` still records the attempt only once the step hands control back.
			closed += 1
			const count = closed
			if (options.close?.hold?.(count) === true) {
				await new Promise<void>((resolve) => {
					held.push(resolve)
				})
			}
			// Recorded BEFORE the fault: a close that failed is still a close this client
			// performed, and the count of attempts is what a retry has to move. What it did NOT do
			// is close anything — so only a close that reaches the end lowers `live`.
			lifecycle.push('close')
			if (options.close?.fault?.(count) === true) throw new Error('transport close failed')
			// `live` refuses to go negative and says so instead. A close reaching here ends a
			// connection, so finding none open means this peer was asked to shut down something that
			// was not there — a second close over one connection, or a close landing after a later
			// attempt already closed it. A counter that silently reaches -1 cannot report the defect
			// it exists to detect, and a raced-away rejection nobody is waiting for is invisible, so
			// the lifecycle carries the marker too.
			if (live === 0) {
				lifecycle.push('overclose')
				throw new Error('transport closed a connection that was not open')
			}
			live -= 1
		},
		release() {
			for (const resolve of held.splice(0)) resolve()
		},
	}
}

function initializeResponse(id: string | number, protocol: unknown): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			protocolVersion: protocol,
			capabilities: {},
			serverInfo: { name: 'fixture', version: '1.0.0' },
		},
	}
}

function discoverResponse(
	id: string | number,
	versions: readonly unknown[] = ['2026-07-28', '2025-11-25'],
	fields: Readonly<Record<string, unknown>> = {},
): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			supportedVersions: versions,
			capabilities: { tools: {} },
			resultType: 'complete',
			ttlMs: 60_000,
			cacheScope: 'private',
			...fields,
		},
	}
}

// One scripted `tools/call` answer, carrying whatever result the test needs — the arms a
// conforming local MCPServer never produces (a deferred task, an input request, a
// `resultType` no revision defines) all arrive this way.
function callResponse(
	id: string | number,
	result: Readonly<Record<string, unknown>>,
): JSONRPCResponse {
	return { jsonrpc: '2.0', id, result }
}

// A modern peer that always completes discovery and hands every other request to `answer`.
// `duplex` is the carrier's own declaration, so a test can put the SAME scenario on a
// carrier that cannot take a client notification at all.
function callPeer(
	answer: (request: JSONRPCInvocation, count: number) => JSONRPCResponse | Error | undefined,
	duplex = true,
): FixturePeerInterface {
	return createFixturePeer({
		duplex,
		reply: (request, count) => {
			if (request.id === undefined) return undefined
			if (request.method === 'server/discover') return discoverResponse(request.id)
			return answer(request, count)
		},
	})
}

// The id the peer saw on its `count`-th request (1-based) — the correlation a test needs to
// address a specific in-flight request, rather than assuming the client's counter.
function requestId(peer: LoopbackInterface, count: number): string | number {
	const id = peer.requests[count - 1]?.id
	if (id === undefined) throw new Error(`Expected request ${count} to carry an id`)
	return id
}

// A carrier whose `tools/call` write FAILS, in one of the shapes a failing write can
// take — and they are one keyword apart. `throws` picks it: `true` is a non-`async` `send`
// that throws SYNCHRONOUSLY, which `MCPClientTransportInterface` forbids; `false` is the same
// non-`async` `send` returning a REJECTED promise, which is what the contract requires. The
// carrier is `duplex` either way, so a cancellation frame CAN reach it and its absence means
// the client did not write one rather than that nothing could have carried it.
//
// Deliberately NOT built on `createFixturePeer`: every peer in this file declares `async send`,
// and an `async` function converts a synchronous throw into a rejection — which is the whole
// difference under test. This is the one carrier that has to be written the other way.
function createWritePeer(throws: boolean): LoopbackInterface {
	const emitter = createEmitter<MCPClientTransportEventMap>()
	const requests: JSONRPCInvocation[] = []
	const lifecycle: string[] = []
	let started = 0
	let closed = 0
	return {
		emitter,
		session: undefined,
		duplex: true,
		get sent() {
			return requests.map((request) => request.method)
		},
		get requests() {
			return requests
		},
		get started() {
			return started
		},
		get closed() {
			return closed
		},
		get lifecycle() {
			return lifecycle
		},
		async start() {
			started += 1
			lifecycle.push('start')
		},
		send(message: JSONRPCMessage): Promise<void> {
			if (!('method' in message)) return Promise.resolve()
			requests.push(message)
			if (message.method === 'server/discover' && message.id !== undefined) {
				emitter.emit('message', discoverResponse(message.id))
				return Promise.resolve()
			}
			if (message.method !== 'tools/call') return Promise.resolve()
			const failure = new Error('write failed')
			if (throws) throw failure
			return Promise.reject(failure)
		},
		async close() {
			closed += 1
			lifecycle.push('close')
		},
	}
}

// One inbound progress frame naming a request by its progress token.
function progressNotification(token: string | number, progress: number): JSONRPCMessage {
	return {
		jsonrpc: '2.0',
		method: 'notifications/progress',
		params: { progressToken: token, progress },
	}
}

function errorResponse(id: string | number, code: number, data?: unknown): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		error: {
			code,
			message: code === MCP_UNSUPPORTED_VERSION ? 'Unsupported protocol version' : 'Legacy peer',
			...(data === undefined ? {} : { data }),
		},
	}
}

interface ErrorPeerInterface {
	readonly base: string
	readonly requests: readonly JSONRPCInvocation[]
	held(path: string): Promise<void>
	release(path: string): void
	stop(): Promise<void>
}

interface HeldResponse {
	readonly id: JSONRPCId
	readonly response: ServerResponse
}

async function readHTTPInvocation(request: IncomingMessage): Promise<JSONRPCInvocation> {
	let body = ''
	for await (const chunk of request) body += String(chunk)
	const parsed: unknown = JSON.parse(body)
	const message = parseJSONRPCMessage(parsed)
	if (message === undefined || !('method' in message)) {
		throw new Error('Expected an HTTP JSON-RPC invocation')
	}
	return message
}

function sendHTTPResponse(
	response: ServerResponse,
	status: number,
	message?: JSONRPCMessage,
): void {
	response.writeHead(status, message === undefined ? {} : { 'content-type': 'application/json' })
	response.end(message === undefined ? undefined : JSON.stringify(message))
}

async function startErrorPeer(): Promise<ErrorPeerInterface> {
	const requests: JSONRPCInvocation[] = []
	const responses = new Map<string, HeldResponse>()
	const idless = Promise.withResolvers<void>()
	const correlated = Promise.withResolvers<void>()
	const silent = Promise.withResolvers<void>()
	const server = createServer(async (request, response) => {
		const message = await readHTTPInvocation(request)
		requests.push(message)
		if (message.method === 'notifications/initialized') {
			sendHTTPResponse(response, 202)
			return
		}
		if (message.id === undefined) {
			sendHTTPResponse(response, 400)
			return
		}
		if (request.url === '/modern') {
			sendHTTPResponse(response, 200, discoverResponse(message.id))
			return
		}
		if (request.url === '/silent') {
			if (message.method === 'server/discover') {
				responses.set('/silent', { id: message.id, response })
				silent.resolve()
				return
			}
			sendHTTPResponse(response, 200, initializeResponse(message.id, MCP_PROTOCOL_VERSION))
			return
		}
		if (request.url === '/connect') {
			if (message.method === 'server/discover') {
				sendHTTPResponse(response, 400, {
					jsonrpc: '2.0',
					error: { code: -32000, message: 'Bad Request: Server not initialized' },
				})
				return
			}
			sendHTTPResponse(response, 200, initializeResponse(message.id, MCP_PROTOCOL_VERSION))
			return
		}
		const path = request.url ?? ''
		if (!responses.has(path)) {
			responses.set(path, { id: message.id, response })
			if (path === '/idless') idless.resolve()
			if (path === '/correlated') correlated.resolve()
			return
		}
		if (path === '/idless') {
			sendHTTPResponse(response, 400, {
				jsonrpc: '2.0',
				error: { code: -32000, message: 'Bad Request: Server not initialized' },
			})
			return
		}
		sendHTTPResponse(response, 400, {
			jsonrpc: '2.0',
			id: message.id,
			error: { code: -32041, message: 'Correlated failure' },
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (address === null || typeof address === 'string') {
		server.close()
		throw new Error('Expected an ephemeral HTTP port')
	}
	return {
		base: `http://127.0.0.1:${address.port}`,
		get requests() {
			return requests
		},
		held(path) {
			if (path === '/idless') return idless.promise
			if (path === '/correlated') return correlated.promise
			if (path === '/silent') return silent.promise
			return Promise.reject(new Error(`Unknown held path '${path}'`))
		},
		release(path) {
			const held = responses.get(path)
			if (held === undefined) return
			responses.delete(path)
			sendHTTPResponse(held.response, 200, discoverResponse(held.id))
		},
		stop() {
			for (const held of responses.values()) held.response.destroy()
			responses.clear()
			return new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error === undefined) resolve()
					else reject(error)
				})
				server.closeAllConnections()
			})
		},
	}
}

// A real ToolManager carrying a deterministic `echo` (returns a structured value),
// a `greet` (a plain string), and a `boom` (throws — the manager isolates it into a
// result error, which the server maps to an `isError` tool result).
function toolRegistry(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'echo',
			description: 'Echo the arguments back',
			parameters: { type: 'object', properties: { value: { type: 'string' } } },
			execute: (args) => ({ echoed: args['value'] }),
		}),
	)
	tools.add(createTool({ name: 'greet', execute: () => 'hello' }))
	tools.add(
		createTool({
			name: 'boom',
			execute: () => {
				throw new Error('tool exploded')
			},
		}),
	)
	return tools
}

function serverWithTools(): MCPDispatcherInterface {
	return createMCPLegacy(
		createMCPServer({
			identity: { name: 'loopback', version: '1.2.3' },
			tools: toolRegistry(),
		}),
	)
}

describe('MCPClient — connect (modern negotiation)', () => {
	it('rejects an invalid runtime pin synchronously during construction', () => {
		const peer = createFixturePeer({ reply: () => undefined })
		const options: unknown = { transport: peer, version: '2020-01-01' }
		let failure: unknown

		try {
			Reflect.apply(createMCPClient, undefined, [options])
		} catch (error) {
			failure = error
		}

		expect(isMCPError(failure)).toBe(true)
		expect(failure).toMatchObject({
			code: MCP_UNSUPPORTED_VERSION,
			context: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: '2020-01-01' },
		})
		expect(peer.started).toBe(0)
		expect(peer.sent).toEqual([])
	})

	it('opens the transport, discovers modern support, and reports the newest common version', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({
			transport: loopback,
			identity: { name: 'tester', version: '9.9.9' },
		})

		expect(client.connected).toBe(false)
		await client.connect()

		expect(client.connected).toBe(true)
		expect(client.version).toBe('2026-07-28')
		expect(loopback.started).toBe(1)
		expect(loopback.sent).toEqual(['server/discover'])
	})

	it('fires the connect event and is idempotent', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		let connects = 0
		client.emitter.on('connect', () => {
			connects += 1
		})

		await client.connect()
		await client.connect() // second connect is a no-op

		expect(connects).toBe(1)
		expect(loopback.started).toBe(1)
		expect(client.connected).toBe(true)
	})

	it('exposes the injected transport', () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		expect(client.transport).toBe(loopback)
	})
})

describe('MCPClient — modern discovery', () => {
	it('exposes discover() and stamps its request with version, capabilities, and client identity', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({
			transport: loopback,
			identity: { name: 'inspector', version: '2.0.0' },
			capabilities: { elicitation: {} },
		})

		const result = await client.discover()

		expect(result.supportedVersions).toEqual(['2026-07-28'])
		expect(result.resultType).toBe('complete')
		const request = loopback.requests[0]
		expect(request?.method).toBe('server/discover')
		expect(request?.params?.['_meta']).toEqual({
			[MCP_META_VERSION]: '2026-07-28',
			[MCP_META_CAPABILITIES]: { elicitation: {} },
			[MCP_META_CLIENT]: { name: 'inspector', version: '2.0.0' },
		})
	})

	it('does not retry a modern request with a legacy-only offer', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return errorResponse(request.id, MCP_UNSUPPORTED_VERSION, {
					supported: ['2025-11-25', '2025-06-18'],
				})
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
		expect(peer.requests.map((request) => request.id)).toEqual([1])
	})

	it('surfaces -32022 without changing a pinned modern revision', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return errorResponse(request.id, MCP_UNSUPPORTED_VERSION, {
					supported: ['2025-11-25', '2025-06-18'],
				})
			},
		})
		const client = createMCPClient({ transport: peer, version: '2026-07-28' })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('rejects a discovery result that does not advertise the pinned modern revision', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, [MCP_PROTOCOL_VERSION])
			},
		})
		const client = createMCPClient({ transport: peer, version: '2026-07-28' })

		await expect(client.connect()).rejects.toMatchObject({
			code: MCP_UNSUPPORTED_VERSION,
			context: { supported: [], requested: '2026-07-28' },
		})

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(peer.closed).toBe(1)
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('makes no further discovery attempt when the one retry also returns -32022', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return errorResponse(request.id, MCP_UNSUPPORTED_VERSION, {
					supported: ['2025-11-25'],
				})
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(peer.sent).toEqual(['server/discover'])
		expect(peer.requests.map((request) => request.id)).toEqual([1])
	})

	it('surfaces a server-state discovery error without era guidance', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return {
					jsonrpc: '2.0',
					id: request.id,
					error: { code: -32000, message: 'Bad Request: Server not initialized' },
				}
			},
		})
		const client = createMCPClient({ transport: peer })
		let caught: unknown

		try {
			await client.connect()
		} catch (error) {
			caught = error
		}

		expect(isMCPError(caught)).toBe(true)
		if (!isMCPError(caught)) throw new Error('Expected an MCPError')
		expect(caught.name).toBe('MCPError')
		expect(caught.code).toBe(-32000)
		expect(caught.message).toBe('Bad Request: Server not initialized')
		expect(caught.context).toBeUndefined()
		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('names the legacy adapter only for discovery method-not-found', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return errorResponse(request.id, JSONRPC_METHOD_NOT_FOUND)
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({
			code: JSONRPC_METHOD_NOT_FOUND,
			message: expect.stringContaining('createMCPLegacyClientTransport'),
		})

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it.each([
		['an auth-shaped HTTP refusal', 'HTTP 401 Unauthorized: bearer required'],
		['an unrecognized HTTP 400', 'HTTP 400 response did not contain a recognized modern error'],
		['an unrecognized HTTP 404', 'HTTP 404 response did not contain a recognized modern error'],
		['a transport send failure', 'Transport closed while sending'],
	])('surfaces %s without era guidance', async (_scenario, message) => {
		const cause = new Error('Transport refused the discovery request')
		const failure = new Error(message, { cause })
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method === 'server/discover') return failure
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toBe(failure)
		expect(failure.cause).toBe(cause)

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('surfaces a malformed result after a parseable discovery response settles the modern era', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') {
					return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
				}
				if (request.method === 'initialize') {
					return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
				}
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it.each([
		['a mistyped known capability', { capabilities: { tools: { listChanged: 'yes' } } }],
		['an unprefixed extension key', { capabilities: { extensions: { feature: {} } } }],
		[
			'a non-object extension value',
			{ capabilities: { extensions: { 'vendor.example/feature': true } } },
		],
		['non-JSON metadata', { _meta: { value: undefined } }],
		['a malformed metadata key', { _meta: { 'vendor.example/bad/key': true } }],
		[
			'a malformed reserved server identity',
			{ _meta: { 'io.modelcontextprotocol/serverInfo': 7 } },
		],
	])('rejects discovery carrying %s', async (_scenario, fields) => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, ['2026-07-28'], fields)
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.discover()).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })
	})

	it('owns an inbound response before routing and rejects a forged post-validation arm', async () => {
		const emitter = createEmitter<MCPClientTransportEventMap>()
		const transport: MCPClientTransportInterface = {
			emitter,
			session: undefined,
			duplex: true,
			async start() {},
			async send(message) {
				if (!('method' in message) || message.id === undefined) return
				const target = discoverResponse(message.id)
				const response = new Proxy(target, {
					get(source, property) {
						if (property === 'error') {
							return { code: -32_000, message: 'forged after validation' }
						}
						return Reflect.get(source, property)
					},
				})
				emitter.emit('message', response)
			},
			async close() {},
		}
		const client = createMCPClient({ transport })

		await expect(client.discover()).resolves.toMatchObject({
			supportedVersions: ['2026-07-28'],
		})
	})

	it.each([
		['a non-string advertised version', ['2026-07-28', 7], 60_000],
		['a fractional TTL', ['2026-07-28'], 1.5],
		['a negative TTL', ['2026-07-28'], -1],
		['a non-finite TTL', ['2026-07-28'], Number.POSITIVE_INFINITY],
	])('rejects discovery carrying %s', async (_scenario, versions, ttl) => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, versions, { ttlMs: ttl })
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.discover()).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })
	})

	it('filters unknown string revisions and freezes the retained discovery snapshot', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, ['2099-01-01', '2026-07-28'])
			},
		})
		const client = createMCPClient({ transport: peer })

		const result = await client.discover()

		expect(result.supportedVersions).toEqual(['2026-07-28'])
		expect(Object.isFrozen(result.supportedVersions)).toBe(true)
		expect(Object.isFrozen(result.capabilities)).toBe(true)
		expect(Object.isFrozen(result)).toBe(true)
	})

	it('accepts a zero TTL and owns frozen metadata independently of later mutation', async () => {
		const metadata = { 'vendor.example/trace': { id: 'trace-1' } }
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, ['2026-07-28'], { _meta: metadata, ttlMs: 0 })
			},
		})
		const client = createMCPClient({ transport: peer })

		const result = await client.discover()
		metadata['vendor.example/trace'].id = 'mutated'

		expect(result.ttlMs).toBe(0)
		expect(result['_meta']).toEqual({ 'vendor.example/trace': { id: 'trace-1' } })
		expect(Object.isFrozen(result['_meta'])).toBe(true)
	})

	it('owns an inbound discovery response once before later validation', async () => {
		let snapshots = 0
		const result = new Proxy(
			{
				supportedVersions: ['2026-07-28'],
				capabilities: {},
				resultType: 'complete',
				ttlMs: 60_000,
				cacheScope: 'private',
			},
			{
				ownKeys(target) {
					snapshots += 1
					if (snapshots > 1) throw new Error('hostile snapshot')
					return Reflect.ownKeys(target)
				},
			},
		)
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return { jsonrpc: '2.0', id: request.id, result }
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.discover()).resolves.toMatchObject({
			supportedVersions: ['2026-07-28'],
		})
		expect(snapshots).toBe(1)
	})

	it('accepts and returns an exact open custom server capability', async () => {
		const custom = { enabled: true }
		const capabilities = {
			custom,
			tools: { listChanged: true },
			extensions: { 'vendor.example/feature': { enabled: true } },
		}
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, ['2026-07-28'], { capabilities })
			},
		})
		const client = createMCPClient({ transport: peer })

		const result = await client.discover()
		custom.enabled = false

		expect(result.capabilities).toMatchObject({
			custom: { enabled: true },
			tools: { listChanged: true },
			extensions: { 'vendor.example/feature': { enabled: true } },
		})
	})

	it('surfaces an unsupported result type from a parseable discovery response without fallback', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') {
					return {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							supportedVersions: ['2026-07-28'],
							capabilities: {},
							resultType: 'input_required',
							ttlMs: 60_000,
							cacheScope: 'private',
						},
					}
				}
				if (request.method === 'initialize') {
					return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
				}
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: "MCP result type 'input_required' is not supported",
		})

		expect(client.connected).toBe(false)
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('bounds a silent discovery probe and surfaces its timeout', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method === 'initialize' && request.id !== undefined) {
					return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
				}
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })

		await expect(client.connect()).rejects.toThrow(
			"MCP request 'server/discover' timed out after 30ms",
		)

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('always gives discovery a deadline without delaying a modern HTTP peer', async () => {
		const peer = await startErrorPeer()
		const unconfigured = createMCPClient({
			transport: createHTTPClientTransport({ url: `${peer.base}/silent` }),
		})
		const modern = createMCPClient({
			transport: createHTTPClientTransport({ url: `${peer.base}/modern` }),
		})
		const configured = createMCPClient({
			transport: createHTTPClientTransport({ url: `${peer.base}/silent` }),
			timeout: 30,
		})
		try {
			const hanging = unconfigured.connect().then(
				() => 'connected',
				() => 'rejected',
			)
			await peer.held('/silent')
			const observed = await Promise.race([hanging, waitForDelay(20).then(() => 'pending')])
			expect(observed).toBe('pending')
			await unconfigured.disconnect()
			await expect(hanging).resolves.toBe('rejected')
			peer.release('/silent')

			await modern.connect()
			expect(modern.version).toBe('2026-07-28')

			await expect(configured.connect()).rejects.toThrow(
				"MCP request 'server/discover' timed out after 30ms",
			)
			expect(peer.requests.map((request) => request.method)).toEqual([
				'server/discover',
				'server/discover',
				'server/discover',
			])
		} finally {
			peer.release('/silent')
			await Promise.allSettled([
				unconfigured.disconnect(),
				modern.disconnect(),
				configured.disconnect(),
			])
			await peer.stop()
		}
	})

	it('applies the configured 15_000ms deadline to the negotiation probe', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, ['2026-07-28'])
			},
		})
		const client = createMCPClient({ transport: peer, timeout: 15_000 })
		// Scope the recorder to negotiation and forward every call to the real host primitive. The
		// 14,999ms control proves the recorder distinguishes the deadline the client supplies.
		RECORDED_ABORT_DEADLINES.splice(0)
		AbortSignal.timeout = recordAbortTimeout
		try {
			void AbortSignal.timeout(14_999)
			await client.connect()
			expect(RECORDED_ABORT_DEADLINES).toEqual([14_999, 15_000])
		} finally {
			AbortSignal.timeout = NATIVE_ABORT_TIMEOUT
			await client.disconnect()
		}
	})

	it('does not fall back when the modern revision is pinned', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return errorResponse(request.id, JSONRPC_METHOD_NOT_FOUND)
			},
		})
		const client = createMCPClient({ transport: peer, version: '2026-07-28' })

		await expect(client.connect()).rejects.toMatchObject({ code: JSONRPC_METHOD_NOT_FOUND })
		expect(peer.sent).toEqual(['server/discover'])
		expect(client.connected).toBe(false)
	})

	it('surfaces a transport failure after the modern era has been settled', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') return discoverResponse(request.id)
				if (request.method === 'tools/list') return new Error('Settled modern transport failed')
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.tools()).rejects.toThrow('Settled modern transport failed')

		expect(peer.sent).toEqual(['server/discover', 'tools/list'])
		expect(client.version).toBe('2026-07-28')
	})

	it('stamps every modern request and sends no client notification', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })

		await client.connect()
		await client.tools()
		await client.call('greet', {})

		expect(loopback.sent).toEqual(['server/discover', 'tools/list', 'tools/call'])
		for (const request of loopback.requests) {
			expect(request.id).toBeDefined()
			expect(request.params?.['_meta']).toEqual({
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: {},
				[MCP_META_CLIENT]: { name: 'taverna', version: '1.0.0' },
			})
		}
	})
})

describe('MCPClient — tools() (discovery + local-tool wrapping)', () => {
	it('lists the remote tools as local Tools, mapping inputSchema → parameters', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		const tools = await client.tools()

		expect(tools.map((tool) => tool.name)).toEqual(['echo', 'greet', 'boom'])
		const echo = tools.find((tool) => tool.name === 'echo')
		expect(echo?.description).toBe('Echo the arguments back')
		// The server renamed `parameters` → `inputSchema`; the client maps it back.
		expect(echo?.parameters).toEqual({ type: 'object', properties: { value: { type: 'string' } } })
		// `greet` declared no parameters → the server defaulted `{ type: 'object' }`.
		const greet = tools.find((tool) => tool.name === 'greet')
		expect(greet?.parameters).toEqual({ type: 'object' })
	})

	it("the wrapped tool's execute calls back over the transport and returns the remote value", async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()
		const tools = await client.tools()
		const echo = tools.find((tool) => tool.name === 'echo')

		// Running the LOCAL tool drives a remote `tools/call` round-trip.
		const value = await echo?.execute({ value: 'pong' })

		expect(value).toEqual({ echoed: 'pong' })
	})

	it('a wrapped remote-erroring tool, added to a ToolManager, is isolated into a failure result', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()
		const remote = createToolManager()
		remote.add(await client.tools())

		// The remote `boom` throws server-side (`isError`); the wrapped local tool re-throws,
		// and the local ToolManager isolates THAT into a failure result — exactly like a local
		// throw. The agent loop stays driveable.
		const result = await remote.execute({ id: 'c1', name: 'boom', arguments: {} })

		expect(result).toEqual({
			id: 'c1',
			name: 'boom',
			success: false,
			error: 'tool exploded',
		})
	})
})

describe('MCPClient — call() (the content round-trip)', () => {
	it('places input continuation state and responses as top-level tools/call params', async () => {
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: 'done' }],
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const args = { operation: 'release', nested: { approved: false } }
		const responses = { confirmation: { action: 'accept', content: { approved: true } } }

		await client.call('NAME', args, { input: { state: 'protected-state', responses } })
		await client.call('NAME', args)

		const calls = peer.requests.filter((request) => request.method === 'tools/call')
		const continued = calls[0]
		const plain = calls[1]
		if (continued === undefined || plain === undefined) {
			throw new Error('Expected the peer to receive the continued and plain calls')
		}
		const sent = continued.params
		const bare = plain.params
		if (sent === undefined || bare === undefined) {
			throw new Error('Expected both tools/call requests to carry params')
		}
		const carried = sent['arguments']
		const reserved = sent['_meta']
		if (!isRecord(carried) || !isRecord(reserved)) {
			throw new Error('Expected the recorded arguments and reserved metadata to be records')
		}

		expect(carried).toBe(args)
		expect(sent['name']).toBe('NAME')
		expect(sent['requestState']).toBe('protected-state')
		expect(sent['inputResponses']).toBe(responses)
		// The pair rides at the TOP level and nowhere else. A subset match over `params` admits
		// an implementation that ALSO buries the pair under `arguments` or under the reserved
		// `_meta`, and either one changes what a peer reads while the top-level keys still look
		// right, so each wrong home is refused by name.
		expect(Object.hasOwn(carried, 'requestState')).toBe(false)
		expect(Object.hasOwn(carried, 'inputResponses')).toBe(false)
		expect(Object.hasOwn(reserved, 'requestState')).toBe(false)
		expect(Object.hasOwn(reserved, 'inputResponses')).toBe(false)
		// The caller's own object is read, never written: identity alone cannot see an
		// implementation that placed the pair by mutating `args` in place, because the recorded
		// arguments and the caller's object are then the same object carrying the same keys.
		expect(Object.hasOwn(args, 'requestState')).toBe(false)
		expect(Object.hasOwn(args, 'inputResponses')).toBe(false)
		expect(args).toEqual({ operation: 'release', nested: { approved: false } })
		expect(Object.hasOwn(bare, 'requestState')).toBe(false)
		expect(Object.hasOwn(bare, 'inputResponses')).toBe(false)
	})

	it('continues an input-required call with protected state and responses', async () => {
		const client = createMCPClient({
			transport: createLoopback(createInputServer(toolRegistry())),
			capabilities: { elicitation: {} },
		})
		await client.connect()
		const args = { value: 'unchanged' }

		const first = await client.call('echo', args)

		expect(first.resultType).toBe('input_required')
		if (
			first.resultType !== 'input_required' ||
			first.requestState === undefined ||
			first.inputRequests === undefined
		) {
			throw new Error('Expected input requests and protected state')
		}
		const key = Object.keys(first.inputRequests)[0]
		if (key === undefined) throw new Error('Expected an input request key')
		const second = await client.call('echo', args, {
			input: {
				state: first.requestState,
				responses: { [key]: { action: 'accept', content: { approved: true } } },
			},
		})

		expect(second).toEqual({ resultType: 'complete', value: { echoed: 'unchanged' } })
	})

	it('keeps changed retry arguments under the server digest refusal', async () => {
		const client = createMCPClient({
			transport: createLoopback(createInputServer(toolRegistry())),
			capabilities: { elicitation: {} },
		})
		await client.connect()
		const first = await client.call('echo', { value: 'original' })
		if (
			first.resultType !== 'input_required' ||
			first.requestState === undefined ||
			first.inputRequests === undefined
		) {
			throw new Error('Expected input requests and protected state')
		}
		const key = Object.keys(first.inputRequests)[0]
		if (key === undefined) throw new Error('Expected an input request key')
		const answers = { [key]: { action: 'accept', content: { approved: true } } }

		// The refusal is read by its MESSAGE, not by `-32602` alone: the required-together gate
		// earlier in the same retry ingress answers that identical code, so the code on its own
		// cannot say which gate ran.
		await expect(
			client.call(
				'echo',
				{ value: 'altered' },
				{ input: { state: first.requestState, responses: answers } },
			),
		).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: request state could not be verified for this retry',
		})

		// The same protected state, replayed with the ORIGINAL arguments, still completes. That
		// is what makes the refusal above the digest binding rather than a state the failed
		// retry had spent or a carrier the server could not recover at all.
		expect(
			await client.call(
				'echo',
				{ value: 'original' },
				{ input: { state: first.requestState, responses: answers } },
			),
		).toEqual({ resultType: 'complete', value: { echoed: 'original' } })
	})

	it('returns a structured value on the complete arm', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		expect(await client.call('echo', { value: 'x' })).toEqual({
			resultType: 'complete',
			value: { echoed: 'x' },
		})
	})

	it('returns a plain string value', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		// `greet` returns the string 'hello'; the server carries it verbatim as
		// `structuredContent` beside its serialized text block.
		expect(await client.call('greet', {})).toEqual({ resultType: 'complete', value: 'hello' })
	})

	it('throws when the remote tool fails (isError), carrying the error text', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		await expect(client.call('boom', {})).rejects.toThrow('tool exploded')
	})

	it('rejects a tools/call for an unknown remote tool (the manager not-found error)', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		// The remote ToolManager resolves an unknown name to an `isError` not-found result,
		// so the client throws.
		await expect(client.call('absent', {})).rejects.toThrow(/not found/)
	})
})

describe('MCPClient — result-type safety', () => {
	it.each(['input_required', 'task', 'future'])(
		'rejects resultType %s with an MCPError that names it',
		async (resultType) => {
			const peer = createFixturePeer({
				reply: (request) => {
					if (request.id === undefined) return undefined
					if (request.method === 'server/discover') return discoverResponse(request.id)
					if (request.method === 'tools/list') {
						return { jsonrpc: '2.0', id: request.id, result: { tools: [], resultType } }
					}
					return undefined
				},
			})
			const client = createMCPClient({ transport: peer })
			await client.connect()

			let caught: unknown
			try {
				await client.tools()
			} catch (error) {
				caught = error
			}

			expect(isMCPError(caught)).toBe(true)
			if (!isMCPError(caught)) throw new Error('Expected an MCPError')
			expect(caught.code).toBe(JSONRPC_INVALID_PARAMS)
			expect(caught.message).toBe(`MCP result type '${resultType}' is not supported`)
		},
	)
})

describe('MCPClient — id correlation', () => {
	it('routes each response to its own pending request across concurrent calls', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		// Three concurrent calls; each must resolve to ITS OWN result, proving the id-keyed
		// correlation routes responses correctly (not first-come-first-served).
		const [a, b, c] = await Promise.all([
			client.call('echo', { value: 'a' }),
			client.call('echo', { value: 'b' }),
			client.call('greet', {}),
		])

		expect(a).toEqual({ resultType: 'complete', value: { echoed: 'a' } })
		expect(b).toEqual({ resultType: 'complete', value: { echoed: 'b' } })
		expect(c).toEqual({ resultType: 'complete', value: 'hello' })
	})

	it('surfaces a server-initiated notification on the notification event', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		await client.connect()
		const seen: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => seen.push(message))

		// A message that is NOT a response to a pending request (here a server-pushed
		// notification injected straight onto the transport) is surfaced, not dropped.
		loopback.emitter.emit('message', { jsonrpc: '2.0', method: 'notifications/progress' })

		expect(seen).toHaveLength(1)
		expect(seen[0]).toEqual({ jsonrpc: '2.0', method: 'notifications/progress' })
	})

	it('preserves a remote JSON-RPC error code and data as an MCPError', async () => {
		const loopback = createLoopback(serverWithTools(), (method) => method === 'tools/list')
		const client = createMCPClient({ transport: loopback })
		await client.connect()
		const pending = client.tools()
		loopback.emitter.emit('message', {
			jsonrpc: '2.0',
			id: 2,
			error: {
				code: -32042,
				message: 'Remote failure',
				data: { retry: false },
			},
		})

		let caught: unknown
		try {
			await pending
		} catch (error) {
			caught = error
		}
		expect(isMCPError(caught)).toBe(true)
		if (!isMCPError(caught)) throw new Error('Expected an MCPError')
		expect(caught.message).toBe('Remote failure')
		expect(caught.code).toBe(-32042)
		expect(caught.context).toEqual({ retry: false })
	})

	it('settles id-less errors over real HTTP without weakening correlated isolation', async () => {
		const peer = await startErrorPeer()
		const connectingClient = createMCPClient({
			transport: createHTTPClientTransport({ url: `${peer.base}/connect` }),
		})
		const connecting = connectingClient.connect().then(
			() => 'connected',
			(error: unknown) => error,
		)
		try {
			const outcome = await Promise.race([connecting, waitForDelay(200).then(() => 'pending')])
			expect(isMCPError(outcome)).toBe(true)
			if (!isMCPError(outcome)) throw new Error('Expected an MCPError')
			expect(outcome.code).toBe(-32000)
			expect(outcome.message).toBe(
				'MCP server returned an error without a request id: Bad Request: Server not initialized',
			)
			expect(peer.requests.map((request) => request.method)).toEqual(['server/discover'])

			const idlessClient = createMCPClient({
				transport: createHTTPClientTransport({ url: `${peer.base}/idless` }),
			})
			const firstIdless = idlessClient.discover()
			await peer.held('/idless')
			const secondIdless = idlessClient.discover()
			const failures = await Promise.all([
				firstIdless.then(
					() => undefined,
					(error: unknown) => error,
				),
				secondIdless.then(
					() => undefined,
					(error: unknown) => error,
				),
			])
			for (const failure of failures) {
				expect(isMCPError(failure)).toBe(true)
				if (!isMCPError(failure)) throw new Error('Expected an MCPError')
				expect(failure.code).toBe(-32000)
				expect(failure.message).toContain('without a request id')
				expect(failure.message).toContain('Bad Request: Server not initialized')
			}
			peer.release('/idless')

			const correlatedClient = createMCPClient({
				transport: createHTTPClientTransport({ url: `${peer.base}/correlated` }),
			})
			const retained = correlatedClient.discover()
			await peer.held('/correlated')
			let correlatedFailure: unknown
			try {
				await correlatedClient.discover()
			} catch (error) {
				correlatedFailure = error
			}
			expect(isMCPError(correlatedFailure)).toBe(true)
			if (!isMCPError(correlatedFailure)) throw new Error('Expected an MCPError')
			expect(correlatedFailure.code).toBe(-32041)
			expect(correlatedFailure.message).toBe('Correlated failure')
			peer.release('/correlated')
			await expect(retained).resolves.toMatchObject({ resultType: 'complete' })
		} finally {
			peer.release('/idless')
			peer.release('/correlated')
			await connectingClient.disconnect()
			await connecting
			await peer.stop()
		}
	})
})

describe('MCPClient — per-request timeout', () => {
	it('rejects a request the server never answers, after the deadline', async () => {
		// Gate `tools/list` so its response is withheld — the request stays pending until the
		// tiny per-request deadline fires (short timers).
		const loopback = createLoopback(serverWithTools(), (method) => method === 'tools/list')
		const client = createMCPClient({ transport: loopback, timeout: 30 })
		await client.connect() // `initialize` is NOT gated, so connect succeeds

		await expect(client.tools()).rejects.toThrow(/timed out/)
	})

	it('keeps the probe deadline scoped to discovery while another request is pending', async () => {
		const peer = createFixturePeer({
			reply: () => undefined,
		})
		const client = createMCPClient({ transport: peer, timeout: 200 })
		const connecting = client.connect()
		await waitForDelay()
		const listing = client.tools()

		await waitForDelay(75)
		peer.emitter.emit('message', { jsonrpc: '2.0', id: 2, result: { tools: [] } })

		await expect(listing).resolves.toEqual([])
		await expect(connecting).rejects.toThrow("MCP request 'server/discover' timed out after 200ms")
		expect(peer.sent).toEqual(['server/discover', 'tools/list'])
	})
})

describe('MCPClient — disconnect', () => {
	it('rejects every pending request and closes the transport', async () => {
		// Gate `tools/call` so the call stays pending; disconnect must reject it.
		const loopback = createLoopback(serverWithTools(), (method) => method === 'tools/call')
		const client = createMCPClient({ transport: loopback, timeout: 5_000 })
		await client.connect()

		const pending = client.call('greet', {})
		await client.disconnect()

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(loopback.closed).toBe(1)
		await expect(pending).rejects.toThrow(/disconnected/)
	})

	it('fires the disconnect event and is idempotent', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		let disconnects = 0
		client.emitter.on('disconnect', () => {
			disconnects += 1
		})
		await client.connect()

		await client.disconnect()
		await client.disconnect() // second disconnect is a no-op

		expect(disconnects).toBe(1)
		expect(loopback.closed).toBe(1)
	})
})

// The ORDERING seam: `connect` / `disconnect` install their state only AFTER an await, so
// every interleaving that reaches the gap sees a client that is neither connected nor
// connecting. These drive the gap directly, including the two-attempts-alive interleavings
// where a session's owner and the client's own openness are no longer the same fact.
//
// The membership rule is now "a site that reads or writes which attempt owns the open
// session", and the boundary controls are drawn from outside THAT: `discover()` (no entry
// guard, installs nothing, decides no ownership) and the failing-close `tools()` round trip
// (the same adverse peer the ownership instruments use, on a path that claims nothing). A
// green control proves the driver reports the ABSENCE of joining and of close activity rather
// than only their presence. `closes nothing when disconnect is called before any connect` is
// no longer a control: its early return now READS the owner, which puts it inside the
// population it would have to bound. It stays as a behavioral test.
describe('MCPClient — connect/disconnect ordering', () => {
	it('joins a concurrent connect into one handshake and one connect event', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		let connects = 0
		client.emitter.on('connect', () => {
			connects += 1
		})

		await Promise.all([client.connect(), client.connect()])

		expect(loopback.started).toBe(1)
		expect(loopback.sent).toEqual(['server/discover'])
		expect(connects).toBe(1)
		expect(client.connected).toBe(true)
		expect(client.version).toBe('2026-07-28')
	})

	it('aborts an in-flight connect when disconnect is awaited, closing the transport once', async () => {
		// The peer answers nothing, and the default 30-second deadline has not fired when
		// `disconnect` settles the pending discovery request.
		const peer = createFixturePeer({ reply: () => undefined })
		const client = createMCPClient({ transport: peer })

		const connecting = client.connect()
		await waitForDelay()
		await client.disconnect()

		expect(peer.closed).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close'])
		await expect(connecting).rejects.toThrow('MCP client disconnected')
		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
	})

	it('closes the transport when a modern negotiation rejects', async () => {
		// The peer advertises only a revision this client does not know, so discovery parses
		// but negotiation finds no common version — a modern-path failure exit.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, ['1999-01-01'])
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(peer.closed).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
	})

	it('waits for an in-flight disconnect before starting a reconnect', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id)
			},
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		// Neither is awaited: the reconnect is issued while the close is still suspended.
		const disconnecting = client.disconnect()
		const reconnecting = client.connect()
		await waitForDelay()

		// The transport has not closed yet, so it must not have been started again either.
		expect(peer.lifecycle).toEqual(['start'])

		peer.release()
		await disconnecting
		await reconnecting

		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
		expect(client.connected).toBe(true)
	})

	it('runs two concurrent discover() calls as two independent requests', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id)
			},
		})
		const client = createMCPClient({ transport: peer })

		const [first, second] = await Promise.all([client.discover(), client.discover()])

		expect(peer.sent).toEqual(['server/discover', 'server/discover'])
		expect(peer.requests.map((request) => request.id)).toEqual([1, 2])
		expect(first).toEqual(second)
	})

	it("closes the transport once when a disconnect lands during a failing attempt's own close", async () => {
		// The narrowest window in the whole seam: the failing attempt is ALREADY inside its own
		// `close()` when the disconnect arrives. Nothing the client publishes can be re-read
		// across that suspension — the attempt must have claimed the transport before it
		// suspended, or the teardown closes a transport that is already closing.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, ['1999-01-01'])
			},
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })

		const connecting = client.connect()
		await waitForDelay(20)
		const disconnecting = client.disconnect()
		await waitForDelay(20)
		peer.release()
		await disconnecting
		await expect(connecting).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(peer.started).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(peer.closed).toBe(1)
	})

	it('settles a superseded connect that was retrying discovery after an unsupported version', async () => {
		// `-32022` sends the negotiation back for ONE retry, and the disconnect lands inside
		// that rejection. The retry is a fresh wire write and a fresh pending entry created
		// AFTER the teardown drained `#pending`, so an unbounded client would have nothing left
		// to settle it: the bound below turns a hang into a failure rather than a stalled suite.
		const peer = createFixturePeer({
			reply: (request, count) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				if (count > 1) return undefined
				void client.disconnect()
				return errorResponse(request.id, MCP_UNSUPPORTED_VERSION, { supported: ['2025-11-25'] })
			},
		})
		const client = createMCPClient({ transport: peer })
		const connecting = client.connect()
		const settled: string[] = []
		void connecting.then(
			() => settled.push('resolved'),
			(error: unknown) => settled.push(error instanceof Error ? error.message : String(error)),
		)

		await waitForDelay(50)

		expect(settled).toEqual(['MCP client disconnected'])
		expect(peer.sent).toEqual(['server/discover'])
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(client.connected).toBe(false)
	}, 2_000)

	it('fires no disconnect event for a client that was never connected', async () => {
		// The same interleaving as the double close, read through the PUBLIC events instead of
		// the transport: `disconnect` is the counterpart of `connect`, so an attempt that never
		// announced a connection must not announce losing one.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id, ['1999-01-01'])
			},
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const events: string[] = []
		client.emitter.on('connect', () => events.push('connect'))
		client.emitter.on('disconnect', () => events.push('disconnect'))

		const connecting = client.connect()
		await waitForDelay(20)
		const disconnecting = client.disconnect()
		await waitForDelay(20)
		peer.release()
		await disconnecting
		await connecting.catch(() => undefined)

		expect(events).toEqual([])
	})

	it('installs nothing when a modern negotiation is superseded after a successful discovery', async () => {
		// The MODERN install window: discovery SUCCEEDS, and the disconnect lands between that
		// answer and the resumption that would write `version` / `connected` / `connect`. Only
		// the re-ask immediately above the install stands between a closed transport and a
		// client reporting itself connected over it.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				void client.disconnect()
				return discoverResponse(request.id)
			},
		})
		const client = createMCPClient({ transport: peer })
		const events: string[] = []
		client.emitter.on('connect', () => events.push('connect'))
		client.emitter.on('disconnect', () => events.push('disconnect'))

		await expect(client.connect()).rejects.toThrow('MCP client disconnected')

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(events).toEqual([])
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(peer.closed).toBe(1)
	})

	it('closes a negotiation superseded while the transport was still opening, once and after it opened', async () => {
		// The disconnect arrives while `start()` is still suspended, so the teardown finds
		// NOTHING open and closes nothing. The attempt therefore still owns the transport its
		// own `start()` is about to hand it, and closes it the moment that open completes —
		// one close, after the open, with no wire write in between.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id)
			},
			start: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })

		const connecting = client.connect()
		await waitForDelay()
		await client.disconnect()
		peer.release()

		await expect(connecting).rejects.toThrow('MCP client disconnected')
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(peer.closed).toBe(1)
		expect(peer.sent).toEqual([])
		expect(client.connected).toBe(false)
	})

	it('opens one transport when the transport re-enters connect synchronously from start', async () => {
		// The single-flight gate is published through a resolved-promise hop precisely so it is
		// in place before the injected `start()` runs. A transport re-entering at `start()`'s
		// FIRST statement is the only observer that can tell a published gate from one assigned
		// after the call: it must join the attempt already in flight, not open a second one.
		let depth = 0
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return discoverResponse(request.id)
			},
			start: {
				enter: () => {
					if (depth >= 3) return
					depth += 1
					void client.connect()
				},
			},
		})
		const client = createMCPClient({ transport: peer })

		await client.connect()

		expect(peer.started).toBe(1)
		expect(peer.lifecycle).toEqual(['start'])
		expect(peer.sent).toEqual(['server/discover'])
		expect(client.connected).toBe(true)
		expect(client.version).toBe('2026-07-28')
	})

	it('closes nothing when disconnect is called before any connect', async () => {
		const peer = createFixturePeer({ reply: () => undefined })
		const client = createMCPClient({ transport: peer })

		await client.disconnect()

		expect(peer.lifecycle).toEqual([])
		expect(peer.closed).toBe(0)
		expect(peer.started).toBe(0)
		expect(client.connected).toBe(false)
	})

	it('makes a second disconnect await the close already in flight', async () => {
		// `hold` suspends the teardown's `close()`, so the second caller arrives while the first
		// teardown owns the shutdown and has ALREADY cleared every claim it held. Nothing left in
		// the client's own state can tell that caller a close is still running — only the
		// published teardown can — so it has to be handed THAT promise rather than a resolved
		// one, or `await client.disconnect()` returns while the transport is still closing.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		let joined = false
		const first = client.disconnect()
		const second = client.disconnect().then(() => {
			joined = true
		})
		await waitForDelay(20)

		expect(joined).toBe(false)
		expect(peer.lifecycle).toEqual(['start'])

		peer.release()
		await Promise.all([first, second])

		expect(joined).toBe(true)
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(peer.closed).toBe(1)
	}, 2_000)

	it('publishes the teardown before running it, so a caller sees one coherent transition', async () => {
		// `disconnect()` hands back a promise for work that has not started yet: the teardown is
		// published FIRST and runs a hop later, exactly as `connect()` publishes its attempt ahead
		// of `#negotiate`. A teardown running inside the caller's own synchronous stretch would
		// have closed the transport and unpublished `connected` before the caller could observe
		// either the promise it was given or the state it still had.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const closing = client.disconnect()

		expect(client.connected).toBe(true)
		expect(peer.lifecycle).toEqual(['start'])

		await closing

		expect(client.connected).toBe(false)
		expect(peer.lifecycle).toEqual(['start', 'close'])
	})

	it("surfaces a failing close from an attempt's own unwind and keeps that session reachable", async () => {
		// The attempt-side twin of the teardown's close fault, and distinct failures owed to
		// distinct audiences: the caller gets the negotiation's error (why the connection did not
		// happen), the `error` event gets the transport fault (a session that is still open).
		// Ownership survives the fault, so `disconnect` can still reach that session.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id, ['1999-01-01'])
					: undefined,
			close: { fault: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const faults: string[] = []
		client.emitter.on('error', (error: unknown) =>
			faults.push(error instanceof Error ? error.message : String(error)),
		)

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(faults).toEqual(['transport close failed'])
		expect(peer.closed).toBe(1)
		expect(client.connected).toBe(false)

		await expect(client.disconnect()).rejects.toThrow('transport close failed')

		expect(peer.closed).toBe(2)
	}, 2_000)

	it('joins two reconnects issued while a superseded attempt is still opening', async () => {
		// Two callers outwaiting the SAME superseded attempt resume together. The first to resume
		// opens the next session; the second has to find that session and join it. Both opening is
		// exactly how two sessions end up with one owner, and only one of them is ever closed.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			start: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const settled: string[] = []
		void client.connect().then(
			() => settled.push('resolved'),
			(error: unknown) => settled.push(error instanceof Error ? error.message : String(error)),
		)

		await waitForDelay()
		await client.disconnect()
		const first = client.connect()
		const second = client.connect()
		await waitForDelay()

		// The superseded attempt's own `start()` completes, so it closes what it opened.
		peer.release()
		await waitForDelay()
		// Exactly one new attempt is opening, and the second caller is waiting on it.
		peer.release()
		await Promise.all([first, second])

		expect(settled).toEqual(['MCP client disconnected'])
		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
		expect(peer.started).toBe(2)
		expect(client.connected).toBe(true)
	}, 2_000)

	it('waits for a superseded attempt to settle before opening the next session', async () => {
		// The admission rule that keeps one session to one owner. A teardown does NOT wait for the
		// attempt it supersedes, so the only thing between that attempt and a second live one is
		// the next `connect()` outwaiting it. Here the superseded attempt is still inside
		// `start()`: nothing was open when the teardown ran, so it closed nothing and the attempt
		// still owes that close. An attempt opening beside it would leave two sessions with one
		// owner, and exactly one of them would ever be closed.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			start: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const settled: string[] = []
		void client.connect().then(
			() => settled.push('resolved'),
			(error: unknown) => settled.push(error instanceof Error ? error.message : String(error)),
		)

		await waitForDelay()
		await client.disconnect()
		const reconnecting = client.connect()
		await waitForDelay()

		expect(peer.lifecycle).toEqual([])
		expect(peer.started).toBe(0)

		// The superseded attempt's own `start()` completes, so it closes what it opened.
		peer.release()
		await waitForDelay()

		expect(settled).toEqual(['MCP client disconnected'])
		expect(peer.lifecycle).toEqual(['start', 'close'])

		// Only now does the next attempt open anything.
		peer.release()
		await reconnecting

		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
		expect(client.connected).toBe(true)
	}, 2_000)

	it('lists remote tools over a peer whose close fails, deciding no ownership at all', async () => {
		// The boundary control for the ownership instruments in this block. Their membership rule
		// is "a site that reads or writes which attempt owns the open session"; `tools()` — the
		// request, the descriptor mapping, the content round trip — is drawn from OUTSIDE it, and
		// runs here on the same failing-close peer those instruments use. Green proves that peer
		// does not by itself manufacture an ownership signal, and that this driver can report the
		// ABSENCE of close activity rather than only its presence.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') return discoverResponse(request.id)
				if (request.method === 'tools/list') {
					return {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							tools: [
								{ name: 'search', description: 'Find things', inputSchema: { type: 'object' } },
							],
						},
					}
				}
				return undefined
			},
			close: { fault: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const events: string[] = []
		client.emitter.on('error', () => events.push('error'))
		client.emitter.on('disconnect', () => events.push('disconnect'))
		await client.connect()

		const tools = await client.tools()

		expect(tools.map((tool) => tool.name)).toEqual(['search'])
		expect(tools[0]?.description).toBe('Find things')
		expect(tools[0]?.parameters).toEqual({ type: 'object' })
		expect(events).toEqual([])
		expect(peer.closed).toBe(0)
		expect(client.connected).toBe(true)
	})

	it('reports a failing teardown close, still announces the loss, and closes again on a retry', async () => {
		// A transport whose shutdown FAILS. The close did NOT happen, so the client's ownership of
		// that session has to survive the fault: `disconnect` is the only path that can try
		// again, and a client that discarded its claim leaves a real session open for the
		// process's life with no public way left to reach it.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			close: { fault: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const events: string[] = []
		client.emitter.on('disconnect', () => events.push('disconnect'))
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('transport close failed')

		// The announcement is owed and the fault does not swallow it.
		expect(events).toEqual(['disconnect'])
		expect(peer.closed).toBe(1)
		expect(client.connected).toBe(false)

		await expect(client.disconnect()).rejects.toThrow('transport close failed')

		expect(peer.closed).toBe(2)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close'])
		// Still exactly one announcement: `disconnect` answers the `connect` this client fired.
		expect(events).toEqual(['disconnect'])
	}, 2_000)

	it('closes a connection a faulted teardown still owes before the next connect opens', async () => {
		// The OTHER door onto the retry rule. `disconnect` reads the claim a faulted close restored
		// and closes again; `connect` is the entry point that reaches the same rule and never asked.
		// A caller that opens here leaves the un-closed connection with no token and no public path,
		// which is precisely what the retained claim exists to prevent — so the reading that decides
		// this is `live`, not the attempt counts, which cannot tell one closed connection from two
		// close attempts over an open one.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			close: { fault: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(peer.live).toBe(1)

		await expect(client.disconnect()).rejects.toThrow('transport close failed')

		expect(peer.live).toBe(1)

		// The debt is settled through the same slot `disconnect` publishes, and only then does this
		// caller open: one close for the owed connection, then one start for the new one.
		await client.connect()

		expect(client.connected).toBe(true)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start'])

		await client.disconnect()

		expect(peer.live).toBe(0)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start', 'close'])
	}, 2_000)

	it('closes a connection a faulted attempt-side close still owes before the next connect opens', async () => {
		// The attempt-side twin: the failing close belongs to a negotiation's own unwind rather than
		// to a teardown, and the claim it restores is owed just the same. Same rule, second door.
		const peer = createFixturePeer({
			reply: (request, count) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return count === 1
					? discoverResponse(request.id, ['1999-01-01'])
					: discoverResponse(request.id)
			},
			close: { fault: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer })
		const faults: string[] = []
		client.emitter.on('error', (error: unknown) =>
			faults.push(error instanceof Error ? error.message : String(error)),
		)

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(faults).toEqual(['transport close failed'])
		expect(peer.live).toBe(1)

		await client.connect()

		expect(client.connected).toBe(true)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start'])

		await client.disconnect()

		expect(peer.live).toBe(0)
	}, 2_000)

	it('closes an owed connection for a caller that arrived during the faulting teardown', async () => {
		// The narrow arrival: the caller is already waiting on the teardown when its close faults, so
		// it resumes into a client that owes a close it never saw fail. Re-reading the claim after
		// the wait is what keeps it from opening beside that connection.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			close: { fault: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const closing = client.disconnect()
		const reconnecting = client.connect()

		await expect(closing).rejects.toThrow('transport close failed')
		await reconnecting

		expect(client.connected).toBe(true)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start'])
	}, 2_000)

	it('rejects a teardown whose close never returns instead of wedging every later caller', async () => {
		// A socket that accepts the shutdown and never drains — no fault, no resolution. Neither the
		// drain, nor a request deadline, nor the supersession signal can reach that await, and the
		// teardown stays published while it hangs, so an unbounded client holds `disconnect` AND
		// every later `connect` for the process's life. The bound below turns that hang into a
		// failure rather than a stalled suite. The connection is still open and still owed, so the
		// next `connect` tries the close again and reports the same fault instead of opening beside
		// it.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		expect(client.connected).toBe(false)
		expect(peer.live).toBe(1)

		await expect(client.connect()).rejects.toThrow('MCP transport close timed out after 30ms')

		expect(client.connected).toBe(false)
		expect(peer.started).toBe(1)
		expect(peer.live).toBe(1)
	}, 2_000)

	it('settles an attempt whose own close never returns, on a path no injected start can reach', async () => {
		// The remaining transport await, and the one the supersession signal does not cover: a modern
		// negotiation that finds no common revision unwinds into its own `close()`, and that close
		// never returns. No `start()` seam is involved — a peer that answers discovery and then
		// never drains reaches it — so the attempt is left unsettled on a path the opening step does
		// not own. The caller is owed the negotiation's error and the observer is owed the transport
		// fault; the connection stays owned, so `disconnect` can still try it.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id, ['1999-01-01'])
					: undefined,
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		const faults: string[] = []
		client.emitter.on('error', (error: unknown) =>
			faults.push(error instanceof Error ? error.message : String(error)),
		)

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(faults).toEqual(['MCP transport close timed out after 30ms'])
		expect(client.connected).toBe(false)
		expect(peer.live).toBe(1)

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		expect(peer.live).toBe(1)
	}, 2_000)

	it('joins a close that outran its deadline instead of shutting one connection down twice', async () => {
		// A deadline says the shutdown did not ANSWER. It never says the shutdown did not HAPPEN —
		// only the close itself can say that, by rejecting. Here close #1 is still running when the
		// client stops waiting for it and every later close is prompt, so a client that reads the
		// deadline as a fault issues a SECOND close over the same connection, watches that one
		// succeed, and opens a new connection while the first close is still in flight. `closed`
		// counts the calls the transport actually received and `started` says whether anything
		// opened beside them; the peer's `overclose` marker is what the first close's late landing
		// would then produce, because it would be decrementing a connection already in use.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			close: { hold: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		// The retry waits on the close already running rather than starting a second one, so it
		// reports the same unanswered shutdown and opens nothing.
		await expect(client.connect()).rejects.toThrow('MCP transport close timed out after 30ms')

		expect(peer.closed).toBe(1)
		expect(peer.started).toBe(1)
		expect(peer.live).toBe(1)

		// And when that one close finally lands, it ends the connection it was given.
		peer.release()
		await waitForDelay()

		expect(peer.live).toBe(0)
		expect(peer.lifecycle).toEqual(['start', 'close'])
	}, 2_000)

	it('recovers when a close that outran its deadline finally succeeds', async () => {
		// The same deadline, the opposite answer: close #1 resolves — successfully — after the
		// client stopped waiting for it, so the connection IS closed and nothing is owed. A second
		// close over an ended connection is what a real transport rejects, which this peer does; a
		// client that issues one is then permanently bricked, because the debt it records can never
		// be cleared and every later `connect` and `disconnect` rejects on it.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			close: { hold: (count) => count === 1, fault: (count) => count > 1 },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		peer.release()
		await waitForDelay()

		expect(peer.live).toBe(0)

		await client.connect()

		expect(client.connected).toBe(true)
		expect(peer.closed).toBe(1)
		expect(peer.started).toBe(2)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
	}, 2_000)

	it('issues a fresh close when the one it stopped waiting for finally rejects', async () => {
		// The remaining answer a retained close can give, and the one that keeps the debt: it rejects,
		// long after the deadline. A rejection is the only report that the connection did NOT end, so
		// the claim must survive it AND the dead close must stop being joinable — a client that
		// discharged the claim here would open beside a connection nothing ever closed, and one that
		// kept joining the settled close would rethrow that same fault at every later caller.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? discoverResponse(request.id)
					: undefined,
			close: { hold: (count) => count === 1, fault: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		peer.release()
		await waitForDelay()

		// The close answered: it failed, so the connection is still open and still owed.
		expect(peer.live).toBe(1)

		await client.connect()

		expect(client.connected).toBe(true)
		expect(peer.closed).toBe(2)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start'])
	}, 2_000)

	it('closes nothing for a transport whose start opened and then rejected', async () => {
		// The obligation the client cannot enforce, recorded where a reader meets it. A `start()`
		// that acquires and then rejects hands back an error and no connection: the claim is made
		// only when the open COMPLETES, so nothing is owned, nothing is closed, and no client-side
		// mechanism can reach what only the transport knows it opened. `MCPClientTransportInterface`
		// therefore obliges an implementation to release what it acquired before it rejects; this
		// peer deliberately does not, so the strand it leaves shows up as a live connection the
		// client never owned. This is a CONTRACT test, not a defect proof — it passes before and
		// after the fix, because the remedy is documentation on the transport, not code here.
		const peer = createFixturePeer({
			reply: () => undefined,
			start: { fault: () => true },
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toThrow('transport start failed')

		expect(client.connected).toBe(false)
		expect(peer.closed).toBe(0)
		expect(peer.sent).toEqual([])
		// Only the transport can undo what only the transport did.
		expect(peer.live).toBe(1)

		// The client is not wedged by it either: it owes nothing, so the next attempt opens again.
		await expect(client.connect()).rejects.toThrow('transport start failed')

		expect(peer.started).toBe(2)
		expect(peer.closed).toBe(0)
	}, 2_000)
})

// The `send` obligation `MCPClientTransportInterface` states and `MCPClient` cannot enforce:
// a failing `send` REJECTS, it never throws synchronously. Both tests here are CONTRACT tests
// like the `start` one above — they pass before and after the documentation, because the remedy
// is a sentence on the transport, not machinery in `#request`. Every transport this package
// ships declares `async send`, so no shipped path reaches the violating shape and building
// coordination against it would be defending a requirement nobody had written down.
//
// The pair is the instrument: the conforming half asserts silence, and silence is only evidence
// once the same scenario one keyword away has been shown to break it.
describe('MCPClientTransportInterface — a failing send rejects, never throws', () => {
	it('strands nothing when a non-async send REJECTS, so a later abort writes nothing', async () => {
		const peer = createWritePeer(false)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const caller = new AbortController()

		const pending = client.call('slow', {}, { signal: caller.signal })
		await expect(pending).rejects.toThrow('write failed')
		// The rejection reached `#settle`, so the entry is gone and the caller's listener with
		// it: the abort finds nothing in flight and there is nothing to tell the peer about.
		caller.abort()
		await waitForDelay()

		expect(peer.sent).toEqual(['server/discover', 'tools/call'])
	})

	it('records what a synchronously throwing send costs: a frame naming an undelivered request', async () => {
		const peer = createWritePeer(true)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const caller = new AbortController()

		const pending = client.call('slow', {}, { signal: caller.signal })
		// The caller is told, because the executor's throw rejects the promise it was building.
		await expect(pending).rejects.toThrow('write failed')
		// But the throw produced no promise for the write's failure handler to attach to, so the
		// pending entry set one statement earlier never passed through `#settle`. The request
		// still looks in flight to a client that has already given up on it.
		caller.abort()
		await waitForDelay()

		expect(peer.sent).toEqual(['server/discover', 'tools/call', 'notifications/cancelled'])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([requestId(peer, 2)])
	})
})

describe('MCPClient — observer safety', () => {
	it('a throwing connect listener cannot corrupt connect, and routes to the error handler', async () => {
		const loopback = createLoopback(serverWithTools())
		const errors: Array<readonly [unknown, string]> = []
		// The emitter's `error` handler receives (error, event) — never a domain event.
		const client = createMCPClient({
			transport: loopback,
			error: (error, event) => errors.push([error, event]),
		})
		client.emitter.on('connect', () => {
			throw new Error('observer boom')
		})

		// The throwing observer must not prevent connect from completing.
		await client.connect()

		expect(client.connected).toBe(true)
		expect(errors).toHaveLength(1)
		const error = errors[0]
		if (error === undefined) throw new Error('Expected the connect listener error')
		expect(error[1]).toBe('connect')
	})
})

describe('MCPClient — discovery requires resultType', () => {
	it('refuses a modern discovery result that carries no resultType', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				// Well formed in every other respect — only the mandatory modern discriminator
				// is missing, which is the whole of the claim.
				return {
					jsonrpc: '2.0',
					id: request.id,
					result: {
						supportedVersions: ['2026-07-28'],
						capabilities: { tools: {} },
						ttlMs: 60_000,
						cacheScope: 'private',
					},
				}
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.discover()).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: 'MCP server returned a malformed discovery result',
		})
	})

	it('fails CLOSED on connect rather than degrading a bad modern peer to legacy', async () => {
		// This peer would answer `initialize` perfectly well, so a client that read the
		// refusal as "not a modern peer" would negotiate legacy and report success. The era
		// is already settled to modern by the time discovery is validated, so it cannot.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') {
					return {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							supportedVersions: ['2026-07-28'],
							capabilities: {},
							ttlMs: 60_000,
							cacheScope: 'private',
						},
					}
				}
				return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('CONTROL — a different method omitting resultType is not refused', async () => {
		// `tools/list` answering without the discriminator is a legacy-shaped result the
		// response path still admits; the discovery rule must not fire for it.
		const peer = callPeer((request) =>
			request.method === 'tools/list' && request.id !== undefined
				? { jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo' }] } }
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const tools = await client.tools()

		expect(tools.map((tool) => tool.name)).toEqual(['echo'])
	})
})

describe('MCPClient — call() result polymorphism', () => {
	it('answers the task arm when the server deferred the call', async () => {
		const task = {
			resultType: 'task',
			taskId: 'task-1',
			status: 'working',
			createdAt: '2026-07-28T00:00:00Z',
			lastUpdatedAt: '2026-07-28T00:00:00Z',
			ttlMs: null,
			pollIntervalMs: 500,
		}
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, task)
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const outcome = await client.call('slow', {})

		expect(outcome).toEqual(task)
		if (outcome.resultType !== 'task') throw new Error('Expected the task arm')
		expect(outcome.taskId).toBe('task-1')
		expect(outcome.pollIntervalMs).toBe(500)
	})

	it('answers the input_required arm when the call needs another round trip', async () => {
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, {
						resultType: 'input_required',
						requestState: 'opaque-state',
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const outcome = await client.call('secured', {})

		if (outcome.resultType !== 'input_required') throw new Error('Expected the input arm')
		expect(outcome.requestState).toBe('opaque-state')
	})

	it('CONTROL — an unknown resultType is refused even on tools/call', async () => {
		// The class the arm narrowing structurally cannot handle. Carrying it would
		// hand a caller an arm whose meaning this client invented.
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, { resultType: 'future', content: [] })
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.call('echo', {})).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: "MCP result type 'future' is not supported",
		})
	})

	it('refuses a task arm whose payload is malformed', async () => {
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, { resultType: 'task', taskId: 'task-1', status: 'flying' })
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.call('slow', {})).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: 'MCP server returned a malformed task result',
		})
	})

	it('refuses an input arm carrying neither requests nor state', async () => {
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, { resultType: 'input_required' })
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.call('secured', {})).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: 'MCP server returned a malformed input request',
		})
	})

	it('a wrapped tool throws rather than handing an agent a deferred answer', async () => {
		const peer = callPeer((request) => {
			if (request.id === undefined) return undefined
			if (request.method === 'tools/list') {
				return { jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'slow' }] } }
			}
			return callResponse(request.id, {
				resultType: 'task',
				taskId: 'task-1',
				status: 'working',
				createdAt: '2026-07-28T00:00:00Z',
				lastUpdatedAt: '2026-07-28T00:00:00Z',
				ttlMs: null,
			})
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const remote = createToolManager()
		remote.add(await client.tools())

		// An agent's registry isolates the throw into a failure result — where returning
		// `undefined` would have read as a tool that succeeded and produced nothing.
		const result = await remote.execute({ id: 'c1', name: 'slow', arguments: {} })

		expect(result).toEqual({
			id: 'c1',
			name: 'slow',
			success: false,
			error: "MCP tool 'slow' answered 'task' and has no inline value",
		})
	})
})

describe('MCPClient — call() prefers structuredContent', () => {
	it('returns the structured value rather than re-parsing the rendered text', async () => {
		// The real MCP idiom: `content` is a rendering for a model to read and
		// `structuredContent` is the value. Re-deriving one from the other is a guess that
		// is right only while the server serialized exactly the value and nothing else.
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: 'Found 3 results' }],
						structuredContent: { count: 3 },
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('search', {})).toEqual({
			resultType: 'complete',
			value: { count: 3 },
		})
	})

	it('prefers an explicit null structured value over the text blocks', async () => {
		// `null` is a value the tool returned, not an absence — the distinction a presence
		// check keeps and an `undefined` check would lose.
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: '"ignored"' }],
						structuredContent: null,
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('nothing', {})).toEqual({ resultType: 'complete', value: null })
	})

	it('falls back to the parsed text when the peer sent no structured value', async () => {
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: '{"echoed":"x"}' }],
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('echo', {})).toEqual({
			resultType: 'complete',
			value: { echoed: 'x' },
		})
	})

	it('falls back to the raw text when it is not JSON', async () => {
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: 'plain words' }],
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('echo', {})).toEqual({
			resultType: 'complete',
			value: 'plain words',
		})
	})

	it('carries a value-less success as an undefined value', async () => {
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, { resultType: 'complete', content: [] })
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('quiet', {})).toEqual({ resultType: 'complete', value: undefined })
	})

	it('still throws a remote isError before reading any structured value', async () => {
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: 'tool exploded' }],
						structuredContent: { swallowed: true },
						isError: true,
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.call('boom', {})).rejects.toThrow('tool exploded')
	})
})

describe('MCPClient — per-request cancellation', () => {
	it('rejects the caller and tells a duplex peer which request was cancelled', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const pending = client.call('slow', {}, { signal: controller.signal })
		const id = requestId(peer, 2)
		controller.abort()

		await expect(pending).rejects.toThrow("MCP request 'tools/call' was aborted")
		const cancelled = peer.requests.find((request) => request.method === 'notifications/cancelled')
		expect(cancelled?.params).toEqual({ requestId: id })
		// It carries no id, so nothing will ever answer it.
		expect(cancelled?.id).toBeUndefined()
	})

	it('carries a string abort reason on the wire and omits a non-string one', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const spoken = new AbortController()
		const silent = new AbortController()

		const first = client.call('slow', {}, { signal: spoken.signal })
		const second = client.call('slow', {}, { signal: silent.signal })
		const ids = [requestId(peer, 2), requestId(peer, 3)]
		spoken.abort('operator stopped')
		silent.abort(new Error('not a wire string'))

		await expect(first).rejects.toThrow(/was aborted/)
		await expect(second).rejects.toThrow(/was aborted/)
		const frames = peer.requests.filter((request) => request.method === 'notifications/cancelled')
		expect(frames[0]?.params).toEqual({ requestId: ids[0], reason: 'operator stopped' })
		expect(frames[1]?.params).toEqual({ requestId: ids[1] })
	})

	it('CONTROL — a duplex:false carrier settles the caller and sends ZERO frames', async () => {
		// Drawn from outside the frame's population: a carrier with no client-to-server
		// notification channel at all. The dated revision defines none over Streamable HTTP,
		// where closing the response stream is itself the cancellation signal.
		const peer = callPeer(() => undefined, false)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const pending = client.call('slow', {}, { signal: controller.signal })
		controller.abort()

		await expect(pending).rejects.toThrow("MCP request 'tools/call' was aborted")
		expect(peer.sent).toEqual(['server/discover', 'tools/call'])
	})

	it('refuses an already-aborted caller before anything is written', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()
		controller.abort()

		await expect(client.call('slow', {}, { signal: controller.signal })).rejects.toThrow(
			"MCP request 'tools/call' was aborted",
		)

		// Nothing went out, so there is no id the peer could be told about.
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('sends nothing when the request is already over — a task is not the request', async () => {
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, {
						resultType: 'task',
						taskId: 'task-1',
						status: 'working',
						createdAt: '2026-07-28T00:00:00Z',
						lastUpdatedAt: '2026-07-28T00:00:00Z',
						ttlMs: null,
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const outcome = await client.call('slow', {}, { signal: controller.signal })
		controller.abort()
		await waitForDelay()

		expect(outcome.resultType).toBe('task')
		// The request ended when the task handle was written; the task itself is untouched,
		// and no cancellation of any kind reaches the wire.
		expect(peer.sent).toEqual(['server/discover', 'tools/call'])
	})

	it('discards a response that arrives after the abort, silently', async () => {
		// Cancellation is ADVISORY: every receiver obligation is SHOULD/MAY and the spec says
		// to IGNORE a late answer. It is not a fault, and it is not a notification either.
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const notifications: JSONRPCMessage[] = []
		const errors: unknown[] = []
		client.emitter.on('notification', (message) => notifications.push(message))
		client.emitter.on('error', (error) => errors.push(error))
		const controller = new AbortController()

		const pending = client.call('slow', {}, { signal: controller.signal })
		const id = requestId(peer, 2)
		controller.abort()
		await expect(pending).rejects.toThrow(/was aborted/)

		peer.emitter.emit('message', callResponse(id, { resultType: 'complete', content: [] }))
		await waitForDelay()

		expect(notifications).toEqual([])
		expect(errors).toEqual([])
	})

	it('cancels one request and leaves the connection and its siblings alone', async () => {
		const peer = callPeer((request, count) => {
			if (request.method !== 'tools/call' || request.id === undefined) return undefined
			// The FIRST call is left hanging for the abort; the next answers normally.
			return count === 2
				? undefined
				: callResponse(request.id, { resultType: 'complete', structuredContent: 'second' })
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const cancelled = client.call('slow', {}, { signal: controller.signal })
		controller.abort()
		await expect(cancelled).rejects.toThrow(/was aborted/)

		expect(client.connected).toBe(true)
		expect(await client.call('quick', {})).toEqual({ resultType: 'complete', value: 'second' })
	})

	it('cancels every request one controller is driving', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const first = client.call('a', {}, { signal: controller.signal })
		const second = client.call('b', {}, { signal: controller.signal })
		const ids = [requestId(peer, 2), requestId(peer, 3)]
		controller.abort()

		await expect(first).rejects.toThrow(/was aborted/)
		await expect(second).rejects.toThrow(/was aborted/)
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual(ids)
	})
})

describe('MCPClient — request-scoped progress', () => {
	it('stamps the progress token only where a caller is listening, and routes the frames', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const seen: unknown[] = []
		const notifications: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => notifications.push(message))

		const pending = client.call('slow', {}, { progress: (progress) => seen.push(progress) })
		const id = requestId(peer, 2)
		expect(peer.requests[1]?.params?.['_meta']).toEqual({
			[MCP_META_VERSION]: '2026-07-28',
			[MCP_META_CAPABILITIES]: {},
			[MCP_META_CLIENT]: { name: 'taverna', version: '1.0.0' },
			progressToken: id,
		})

		peer.emitter.emit('message', progressNotification(id, 1))
		peer.emitter.emit('message', progressNotification(id, 2))
		peer.emitter.emit(
			'message',
			callResponse(id, { resultType: 'complete', structuredContent: 'done' }),
		)

		await expect(pending).resolves.toEqual({ resultType: 'complete', value: 'done' })
		expect(seen).toEqual([
			{ progressToken: id, progress: 1 },
			{ progressToken: id, progress: 2 },
		])
		// A claimed frame is NOT also published as a notification.
		expect(notifications).toEqual([])
	})

	it('stamps the token on the watched request and not on its unwatched sibling', async () => {
		// One assertion over BOTH shapes, so the claim cannot be satisfied by a client that
		// stamps nothing at all: the watched request must carry the token AND the unwatched
		// one must not.
		const peer = callPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? callResponse(request.id, { resultType: 'complete', structuredContent: 1 })
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const stamp = {
			[MCP_META_VERSION]: '2026-07-28',
			[MCP_META_CAPABILITIES]: {},
			[MCP_META_CLIENT]: { name: 'taverna', version: '1.0.0' },
		}

		await client.call('watched', {}, { progress: () => undefined })
		await client.call('unwatched', {})

		expect(peer.requests[1]?.params?.['_meta']).toEqual({
			...stamp,
			progressToken: requestId(peer, 2),
		})
		expect(peer.requests[2]?.params?.['_meta']).toEqual(stamp)
	})

	it('claims a frame naming an in-flight request and leaves one naming nothing', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const notifications: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => notifications.push(message))

		const pending = client.call('slow', {}, { progress: (progress) => seen.push(progress) })
		const id = requestId(peer, 2)
		// The instrument first: a frame naming THIS request is claimed.
		peer.emitter.emit('message', progressNotification(id, 1))
		// The control: a token this client never minted names no request, so it stays an
		// ordinary server notification.
		peer.emitter.emit('message', progressNotification(9_999, 2))
		await waitForDelay()

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(notifications).toHaveLength(1)
		await client.disconnect()
		await expect(pending).rejects.toThrow(/disconnected/)
	})

	it('claims a well-formed frame and leaves a malformed one', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const notifications: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => notifications.push(message))

		const pending = client.call('slow', {}, { progress: (progress) => seen.push(progress) })
		const id = requestId(peer, 2)
		peer.emitter.emit('message', progressNotification(id, 1))
		// The same token, the same in-flight request — only the payload is not a progress
		// payload, so the handler must not be handed it.
		peer.emitter.emit('message', {
			jsonrpc: '2.0',
			method: 'notifications/progress',
			params: { progressToken: id, progress: 'soon' },
		})
		await waitForDelay()

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(notifications).toHaveLength(1)
		await client.disconnect()
		await expect(pending).rejects.toThrow(/disconnected/)
	})

	it('contains a throwing progress handler on the client error channel', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const errors: unknown[] = []
		client.emitter.on('error', (error) => errors.push(error))

		const pending = client.call(
			'slow',
			{},
			{
				progress: () => {
					throw new Error('handler boom')
				},
			},
		)
		const id = requestId(peer, 2)
		peer.emitter.emit('message', progressNotification(id, 1))
		peer.emitter.emit(
			'message',
			callResponse(id, { resultType: 'complete', structuredContent: 'done' }),
		)

		await expect(pending).resolves.toEqual({ resultType: 'complete', value: 'done' })
		expect(errors).toHaveLength(1)
		expect(errors[0]).toBeInstanceOf(Error)
	})
})

// Every test here proves the instrument BEFORE it proves the release, in the same run and on
// the same request: a progress frame must reach the handler, an abort must reach the wire, and
// the caller's signal must show its listener, WHILE the request is live. Without that half
// these read identically against a client that registered nothing in the first place — which is
// the failure mode a release test is most likely to have and least likely to show.
//
// The abort listener needs its OWN instrument, and for a while it had none. The wire reading —
// "did aborting after the exit write a cancellation frame" — cannot see it: `#abortRequest`
// checks `#pending` before writing anything, so a released listener and an unreleased one
// produce the same silence, and deleting the release from `#settle` left this whole suite
// green. What the release actually buys is on the CALLER's signal, which outlives the request
// and may be driving several calls: without it a long-lived `AbortController` accumulates one
// bound listener per `call` for the client's life. `createSignal` counts them.
describe('MCPClient — every registration is released on every exit', () => {
	it('releases both on the exit nobody enumerates: a rejecting transport.send', async () => {
		const peer = createFixturePeer({
			// The subject's write is PARKED, so its pending entry exists and can be observed
			// live; releasing the park lets the scripted failure land and take the exit.
			send: { park: (method, count) => method === 'tools/call' && count === 2 },
			reply: (request, count) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') return discoverResponse(request.id)
				if (request.method !== 'tools/call') return undefined
				return count === 2 ? new Error('write failed') : undefined
			},
		})
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const subject = createSignal()
		const sibling = new AbortController()

		const pending = client.call(
			'slow',
			{},
			{ signal: subject.signal, progress: (progress) => seen.push(progress) },
		)
		const id = requestId(peer, 2)
		const live = client.call('other', {}, { signal: sibling.signal })
		// LIVE: every registration is real while the write is still in flight.
		peer.emitter.emit('message', progressNotification(id, 1))
		await waitForDelay()
		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(subject.count).toBe(1)

		peer.release()
		await expect(pending).rejects.toThrow('write failed')

		// RELEASED: the entry is gone, so neither registration answers any more — and the
		// caller's own signal is as clean as the client found it. Read BEFORE anything aborts,
		// because a `once` listener that fires removes itself and would hide the difference.
		expect(subject.count).toBe(0)
		peer.emitter.emit('message', progressNotification(id, 2))
		await waitForDelay()
		subject.controller.abort()
		await waitForDelay()
		// The wire instrument still works after the exit — the sibling's abort proves it.
		sibling.abort()
		await expect(live).rejects.toThrow(/was aborted/)

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([requestId(peer, 3)])
	})

	it('releases both on the other exit nobody enumerates: disconnect mid-flight', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const subject = createSignal()
		const probe = new AbortController()

		const pending = client.call(
			'slow',
			{},
			{ signal: subject.signal, progress: (progress) => seen.push(progress) },
		)
		const id = requestId(peer, 2)
		const probed = client.call('other', {}, { signal: probe.signal })
		// LIVE, every instrument: the frame reaches the handler, an abort reaches the wire, and
		// the caller's signal carries the listener this request registered on it.
		peer.emitter.emit('message', progressNotification(id, 1))
		await waitForDelay()
		probe.abort()
		await expect(probed).rejects.toThrow(/was aborted/)
		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(subject.count).toBe(1)

		await client.disconnect()
		await expect(pending).rejects.toThrow(/disconnected/)

		// RELEASED by the drain, which knows nothing about any of the registrations.
		expect(subject.count).toBe(0)
		peer.emitter.emit('message', progressNotification(id, 2))
		await waitForDelay()
		subject.controller.abort()
		await waitForDelay()

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([requestId(peer, 3)])
	})

	it('releases both when the request simply answers', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const subject = createSignal()
		const sibling = new AbortController()

		const pending = client.call(
			'quick',
			{},
			{ signal: subject.signal, progress: (progress) => seen.push(progress) },
		)
		const id = requestId(peer, 2)
		const live = client.call('other', {}, { signal: sibling.signal })
		peer.emitter.emit('message', progressNotification(id, 1))
		await waitForDelay()
		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(subject.count).toBe(1)

		peer.emitter.emit(
			'message',
			callResponse(id, { resultType: 'complete', structuredContent: 'done' }),
		)
		await expect(pending).resolves.toEqual({ resultType: 'complete', value: 'done' })

		expect(subject.count).toBe(0)
		peer.emitter.emit('message', progressNotification(id, 2))
		await waitForDelay()
		subject.controller.abort()
		await waitForDelay()
		sibling.abort()
		await expect(live).rejects.toThrow(/was aborted/)

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([requestId(peer, 3)])
	})

	it('releases both on the request deadline', async () => {
		const peer = callPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 50 })
		await client.connect()
		const seen: unknown[] = []
		const subject = createSignal()
		const probe = new AbortController()

		const pending = client.call(
			'slow',
			{},
			{ signal: subject.signal, progress: (progress) => seen.push(progress) },
		)
		const id = requestId(peer, 2)
		const probed = client.call('other', {}, { signal: probe.signal })
		peer.emitter.emit('message', progressNotification(id, 1))
		await waitForDelay()
		probe.abort()
		await expect(probed).rejects.toThrow(/was aborted/)
		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(subject.count).toBe(1)

		await expect(pending).rejects.toThrow(/timed out/)

		expect(subject.count).toBe(0)
		peer.emitter.emit('message', progressNotification(id, 2))
		await waitForDelay()
		subject.controller.abort()
		await waitForDelay()

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([requestId(peer, 3)])
	})
})

describe('MCPClient — an uncorrelated response is discarded', () => {
	it('never publishes a response nobody is waiting for as a notification', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		await client.connect()
		const seen: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => seen.push(message))

		// A response is an ANSWER to a request this client issued. With nothing pending it
		// answers a request that already settled — by its deadline, an abort, or a drain —
		// and the protocol says to ignore it, not to announce it as a server message.
		loopback.emitter.emit('message', { jsonrpc: '2.0', id: 4_242, result: { ok: true } })
		loopback.emitter.emit('message', {
			jsonrpc: '2.0',
			id: 4_243,
			error: { code: -32_000, message: 'late' },
		})

		expect(seen).toEqual([])
	})
})

describe('the client transport event map', () => {
	it('surfaces a parsed JSON-RPC message on the client carrier', () => {
		expectTypeOf<MCPClientTransportEventMap['message']>().toEqualTypeOf<
			readonly [message: JSONRPCMessage]
		>()
		expectTypeOf<MCPClientTransportEventMap['close']>().toEqualTypeOf<readonly []>()
	})
})
