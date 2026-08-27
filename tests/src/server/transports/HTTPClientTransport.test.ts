import type { JSONRPCMessage, MCPClientInterface, MCPServerInterface } from '@src/core'
import type { MiddlewareHandler } from '@orkestrel/server'
import type { StartedServerInterface } from '../../../setupServer.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	buildJSONRPCResult,
	inferRequestVersion,
	isJSONRPCId,
	MCP_FALLBACK_VERSION,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_HANDSHAKE_VERSION,
	createMCPClient,
	createMCPLegacy,
	createMCPLegacyClientTransport,
	createMCPServer,
} from '@src/core'
import { isRecord } from '@orkestrel/contract'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import {
	createHTTPClientTransport,
	createMCPRoutes,
	inferHeaderIssue,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
} from '@src/server'
import { createServer as createHTTPServer } from 'node:http'
import { createTeardown, waitForDelay } from '@orkestrel/test'
import { HTTPClientTransport } from '@src/server'
import { createHeaderProjectionRequest, HEADER_PROJECTION_CONTEXTS } from '../../../setup.js'
import { startServer } from '../../../setupServer.js'

// src/server/mcp/HTTPClientTransport.ts — the HTTP CLIENT transport, proven END-TO-END
// against the SHIPPED server transport (`createMCPRoutes`) over a REAL `node:http` server
// + a REAL MCPServer over a REAL ToolManager (no mocks, no live model). An
// `MCPClient` driving `createHTTPClientTransport` connects, discovers, and calls the
// remote tools over `fetch`, exercising BOTH reply framings the server can choose: the
// plain JSON body (`streaming: false`) and the Streamable-HTTP SSE `data:` event
// (`streaming: true`, decoded via the core SSEParser inside the transport). Also: a
// remote tool error → a local throw, and a token guard mounted IN FRONT (the transport's
// `headers` carry the bearer). The in-process correlation / timeout / disconnect contract
// is pinned in tests/src/core/mcp/MCPClient.test.ts; the LIVE model round-trip in
// tests/src/ollama/mcp.test.ts.

const teardown = createTeardown()
afterEach(() => teardown.destroy())

// A real MCPServer over a real ToolManager: an `add` tool (a fixed structured value),
// a `greet` tool (a plain string), and a `boom` tool that throws (→ an `isError` result).
function mcpServer(): MCPServerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'add',
			description: 'Add two numbers',
			parameters: {
				type: 'object',
				properties: { a: { type: 'number' }, b: { type: 'number' } },
			},
			execute: (args) => Number(args['a']) + Number(args['b']),
		}),
	)
	tools.add(createTool({ name: 'greet', execute: () => 'hi' }))
	tools.add(
		createTool({
			name: 'boom',
			execute: () => {
				throw new Error('remote kaboom')
			},
		}),
	)
	return createMCPServer({ identity: { name: 'remote', version: '4.5.6' }, tools })
}

// Stand up the shipped MCP HTTP transport over a real server, then build an MCPClient
// pointed at it via the HTTP client transport. `streaming` picks the server's reply
// framing (SSE vs JSON); `guardSecret` mounts a token guard in front (the client sends
// the bearer through the transport's `headers`).
// A minimal bearer-token check middleware, hand-rolled locally (no @orkestrel/middleware
// dependency) — just enough to prove the transport composes auth IN FRONT rather than
// baking it in.
function createBearerGuard(secret: string): MiddlewareHandler<unknown> {
	return (request, _context, next) => {
		if (request.headers.get('authorization') !== `Bearer ${secret}`) {
			return Response.json({ error: 'unauthorized' }, { status: 401 })
		}
		return next()
	}
}

async function connectClient(options?: {
	readonly streaming?: boolean
	readonly guardSecret?: string
}): Promise<{ readonly client: MCPClientInterface; readonly handle: StartedServerInterface }> {
	const dispatcher = createDispatcher<unknown>()
	dispatcher.add(
		createMCPRoutes(createMCPLegacy(mcpServer()), {
			...(options?.streaming !== undefined ? { streaming: options.streaming } : {}),
		}),
	)
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	if (options?.guardSecret !== undefined) server.use(createBearerGuard(options.guardSecret))
	const handle = await startServer(server)
	teardown.add(() => handle.stop())
	const headers =
		options?.guardSecret !== undefined
			? { authorization: `Bearer ${options.guardSecret}` }
			: undefined
	const client = createMCPClient({
		transport: createHTTPClientTransport({
			url: `${handle.base}/mcp`,
			...(headers !== undefined ? { headers } : {}),
		}),
	})
	await client.connect()
	return { client, handle }
}

describe('HTTPClientTransport — JSON reply path (streaming: false)', () => {
	it('connect → tools() → call() round-trips over a plain JSON body', async () => {
		const { client } = await connectClient({ streaming: false })

		expect(client.connected).toBe(true)
		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'greet', 'boom'])
		// The server renamed `parameters` → `inputSchema`; the client maps it back.
		const add = tools.find((tool) => tool.name === 'add')
		expect(add?.parameters).toEqual({
			type: 'object',
			properties: { a: { type: 'number' }, b: { type: 'number' } },
		})

		expect(await client.call('add', { a: 2, b: 5 })).toEqual({ resultType: 'complete', value: 7 })
		expect(await client.call('greet', {})).toEqual({ resultType: 'complete', value: 'hi' })
	})

	it('a remote tool failure throws locally', async () => {
		const { client } = await connectClient({ streaming: false })
		await expect(client.call('boom', {})).rejects.toThrow('remote kaboom')
	})
})

describe('HTTPClientTransport — SSE reply path (streaming: true)', () => {
	it('connect → tools() → call() round-trips over a decoded SSE data: event', async () => {
		// The server `Accept`s the transport's `text/event-stream` and frames each reply as a
		// Streamable-HTTP SSE event; the transport decodes it via the core SSEParser. The
		// JSON-RPC envelope — and thus the client's behavior — is identical to the JSON path.
		const { client } = await connectClient({ streaming: true })

		expect(client.connected).toBe(true)
		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'greet', 'boom'])

		expect(await client.call('add', { a: 10, b: 1 })).toEqual({ resultType: 'complete', value: 11 })
	})

	it('a remote tool failure throws locally over the SSE path too', async () => {
		const { client } = await connectClient({ streaming: true })
		await expect(client.call('boom', {})).rejects.toThrow('remote kaboom')
	})
})

describe('HTTPClientTransport — policy composes in front', () => {
	it('carries a bearer through headers to reach a guarded server', async () => {
		// The transport's `headers` thread an Authorization bearer; the guard mounted IN FRONT
		// of the MCP route passes it, so the whole handshake + call round-trips.
		const { client } = await connectClient({ guardSecret: 'topsecret', streaming: false })

		expect(client.connected).toBe(true)
		expect(await client.call('add', { a: 3, b: 4 })).toEqual({ resultType: 'complete', value: 7 })
	})

	it('rejects (no connect) when the bearer is missing against a guarded server', async () => {
		const dispatcher = createDispatcher<unknown>()
		dispatcher.add(createMCPRoutes(createMCPLegacy(mcpServer())))
		const server = createServer<unknown>({ dispatcher, state: () => undefined })
		server.use(createBearerGuard('topsecret'))
		const handle = await startServer(server)
		teardown.add(() => handle.stop())
		// No `headers` → the guard 401s the POST and the transport rejects the exchange from
		// the invalid JSON-RPC body.
		const client = createMCPClient({
			transport: createHTTPClientTransport({ url: `${handle.base}/mcp` }),
			timeout: 200,
		})

		await expect(client.connect()).rejects.toThrow(
			'HTTP 401 response contained an application/json body that was not a JSON-RPC message',
		)
		expect(client.connected).toBe(false)
	})
})

describe('HTTPClientTransport — lifecycle', () => {
	it('rejects a non-success JSON body that is not a JSON-RPC message', async () => {
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: () => Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 })),
		})

		await expect(
			transport.send({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
		).rejects.toThrow(
			'HTTP 401 response contained an application/json body that was not a JSON-RPC message',
		)
	})

	it('emits a valid JSON-RPC error body from a non-success response', async () => {
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: () =>
				Promise.resolve(
					Response.json(
						{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Missing' } },
						{ status: 401 },
					),
				),
		})
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))

		await transport.send({ jsonrpc: '2.0', id: 1, method: 'server/discover' })

		expect(messages).toEqual([
			{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Missing' } },
		])
	})

	it('stamps modern POSTs from the message and scopes Mcp-Name to tools/call', async () => {
		const headers: Headers[] = []
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})
		const metadata = {
			[MCP_META_VERSION]: MCP_HANDSHAKE_VERSION,
			[MCP_META_CAPABILITIES]: {},
		}

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'server/discover',
			params: { _meta: metadata },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { _meta: metadata },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'add', arguments: {}, _meta: metadata },
		})

		expect(
			headers.map((header) => [
				header.get(MCP_PROTOCOL_VERSION_HEADER),
				header.get(MCP_METHOD_HEADER),
				header.get(MCP_NAME_HEADER),
			]),
		).toEqual([
			[MCP_HANDSHAKE_VERSION, 'server/discover', null],
			[MCP_HANDSHAKE_VERSION, 'tools/list', null],
			[MCP_HANDSHAKE_VERSION, 'tools/call', 'add'],
		])
	})

	// A tool name a header cannot carry as plain ASCII travels in the protocol's sentinel form.
	// The wire form is written out literally rather than re-derived through `encodeSentinel`, so
	// this row cannot agree with a broken encoder, and the server's own expectation reads the
	// same headers back to prove the encoding is one the receiver accepts.
	it('carries a tool name needing encoding as the sentinel the server decodes', async () => {
		const headers: Headers[] = []
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})
		const message: JSONRPCMessage = {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'café',
				arguments: {},
				_meta: {
					[MCP_META_VERSION]: MCP_HANDSHAKE_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		}

		await transport.send(message)
		const sent = headers[0]
		if (sent === undefined) throw new Error('the transport issued no request')

		expect(sent.get(MCP_NAME_HEADER)).toBe('=?base64?Y2Fmw6k=?=')
		expect(
			inferHeaderIssue(
				new Request('http://localhost/mcp', { method: 'POST', headers: sent }),
				message,
			),
		).toBeUndefined()
	})

	// The Node half of the SHARED projection table. The browser face used to
	// route the same read through `parseRequestContext` and withheld the header on every
	// context that is modern-by-key-presence but not fully well formed; both faces now
	// project through `inferRequestVersion`, so this table has one answer per row on both.
	it.each(HEADER_PROJECTION_CONTEXTS.map((context) => [context.label, context] as const))(
		'projects %s exactly as the browser face does',
		async (_label, context) => {
			const headers: Headers[] = []
			const transport = createHTTPClientTransport({
				url: 'http://localhost/mcp',
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

	// The server's expectation is another site that reads the same fact, and it is the
	// reason the raw read is the correct one: `inferHeaderIssue` demands a header for every
	// context this projection yields a version for, so agreement here IS the absence of a
	// refusal. A context the projector answers `undefined` for is one the server does not ask
	// about, so neither face sending a header is equally correct.
	it('agrees with the server-side expectation on every row of the table', () => {
		for (const context of HEADER_PROJECTION_CONTEXTS) {
			const message = createHeaderProjectionRequest(context.metadata)
			const request = new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_METHOD_HEADER]: 'tools/list',
					...(context.version === undefined
						? {}
						: { [MCP_PROTOCOL_VERSION_HEADER]: context.version }),
				},
			})

			expect([context.label, inferRequestVersion(message)]).toEqual([
				context.label,
				context.version,
			])
			expect([context.label, inferHeaderIssue(request, message)?.header]).toEqual([
				context.label,
				undefined,
			])
		}
	})

	it('captures the initialize result and sends its protocol on the subsequent request', async () => {
		const dispatcher = createDispatcher<unknown>()
		dispatcher.add(createMCPRoutes(createMCPLegacy(mcpServer()), { streaming: false }))
		const server = createServer<unknown>({ dispatcher, state: () => undefined })
		const handle = await startServer(server)
		teardown.add(() => handle.stop())
		const protocols: Array<string | null> = []
		const methods: Array<string | null> = []
		const names: Array<string | null> = []
		const transport = createHTTPClientTransport({
			url: `${handle.base}/mcp`,
			fetch: (input, init) => {
				const headers = new Headers(init?.headers)
				protocols.push(headers.get(MCP_PROTOCOL_VERSION_HEADER))
				methods.push(headers.get(MCP_METHOD_HEADER))
				names.push(headers.get(MCP_NAME_HEADER))
				return fetch(input, init)
			},
		})
		const client = createMCPClient({
			transport: createMCPLegacyClientTransport(transport, { version: MCP_FALLBACK_VERSION }),
		})

		await client.connect()

		expect(protocols).toEqual([null, MCP_FALLBACK_VERSION])
		expect(methods).toEqual([null, null])
		expect(names).toEqual([null, null])
		await client.disconnect()
	})

	it('exposes session undefined for the stateless v1 server and closes cleanly', async () => {
		const { client } = await connectClient({ streaming: false })

		// The stateless v1 server sends no `mcp-session-id`, so the transport's session stays
		// undefined (reserved for the later sessions tier).
		expect(client.transport.session).toBeUndefined()
		await client.disconnect()
		expect(client.connected).toBe(false)
	})

	it('ignores an unsupported negotiated protocol — no header on the next request', async () => {
		// A fixture route that replies to `initialize` with an UNSUPPORTED `protocolVersion`
		// (never sent by the shipped server) — the transport must not capture it.
		const dispatcher = createDispatcher<unknown>()
		dispatcher.add({
			method: 'POST',
			path: '/mcp',
			handler: async (request) => {
				const body: unknown = await request.json()
				const id = isRecord(body) && isJSONRPCId(body['id']) ? body['id'] : 0
				return Response.json(buildJSONRPCResult(id, { protocolVersion: '2099-01-01' }))
			},
		})
		const server = createServer<unknown>({ dispatcher, state: () => undefined })
		const handle = await startServer(server)
		teardown.add(() => handle.stop())
		const protocols: Array<string | null> = []
		const transport = createHTTPClientTransport({
			url: `${handle.base}/mcp`,
			fetch: (input, init) => {
				protocols.push(new Headers(init?.headers).get(MCP_PROTOCOL_VERSION_HEADER))
				return fetch(input, init)
			},
		})

		await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
		await transport.send({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} })

		expect(protocols).toEqual([null, null])
	})

	it('close() clears the captured protocol — a new request carries no header', async () => {
		const dispatcher = createDispatcher<unknown>()
		dispatcher.add(createMCPRoutes(createMCPLegacy(mcpServer()), { streaming: false }))
		const server = createServer<unknown>({ dispatcher, state: () => undefined })
		const handle = await startServer(server)
		teardown.add(() => handle.stop())
		const protocols: Array<string | null> = []
		const transport = createHTTPClientTransport({
			url: `${handle.base}/mcp`,
			fetch: (input, init) => {
				protocols.push(new Headers(init?.headers).get(MCP_PROTOCOL_VERSION_HEADER))
				return fetch(input, init)
			},
		})
		const client = createMCPClient({
			transport: createMCPLegacyClientTransport(transport, { version: MCP_FALLBACK_VERSION }),
		})

		await client.connect()
		expect(protocols).toEqual([null, MCP_FALLBACK_VERSION])

		await client.disconnect()
		await transport.send({ jsonrpc: '2.0', id: 99, method: 'ping', params: {} })

		expect(protocols).toEqual([null, MCP_FALLBACK_VERSION, null])
	})
})

// A `close()` is a release, not a bookmark: whatever the transport still holds when it is
// called has to be handed back. For a `fetch` transport that is the request in flight and the
// response body it is reading — an SSE reply the server never ends holds both open forever,
// and nothing else in the client can reach them.
interface EndlessStreamInterface {
	readonly base: string
	/** How many requests the server saw the client abandon. */
	readonly abandoned: number
	stop(): Promise<void>
}

// A real `node:http` peer that answers every POST with a `text/event-stream` it never ends:
// it writes the SSE headers plus one comment line (so `fetch` resolves its Response) and then
// holds the response open. `abandoned` counts the requests whose client went away, which is
// what an aborted `fetch` looks like from the server's side.
async function startEndlessStream(): Promise<EndlessStreamInterface> {
	let abandoned = 0
	const server = createHTTPServer((request, response) => {
		request.on('close', () => {
			if (!response.writableEnded) abandoned += 1
		})
		response.writeHead(200, { 'content-type': 'text/event-stream' })
		response.write(': open\n\n')
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0
	return {
		base: `http://127.0.0.1:${port}`,
		get abandoned() {
			return abandoned
		},
		stop(): Promise<void> {
			return new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			})
		},
	}
}

describe('HTTPClientTransport — close releases the request it has in flight', () => {
	it('close() aborts a pending send and the server sees the request abandoned', async () => {
		const peer = await startEndlessStream()
		teardown.add(() => peer.stop())
		const transport = new HTTPClientTransport({ url: `${peer.base}/mcp` })
		const sending = transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
		// Let the request reach the server and its unending SSE body start arriving.
		await waitForDelay(60)

		await transport.close()

		// The read the transport was parked on is cancelled, so the write it was reporting on
		// settles instead of outliving the transport.
		await expect(
			Promise.race([sending.then(() => 'settled'), waitForDelay(200).then(() => 'unsettled')]),
		).resolves.toBe('settled')
		// The cancellation reaches the peer over a real socket, so the server-side reading is
		// polled rather than read on the same tick the local promise settled.
		await vi.waitFor(() => expect(peer.abandoned).toBe(1))
	})

	it('a send issued after a start following close still reaches the server', async () => {
		const dispatcher = createDispatcher<unknown>()
		dispatcher.add(createMCPRoutes(createMCPLegacy(mcpServer()), { streaming: false }))
		const handle = await startServer(createServer<unknown>({ dispatcher, state: () => undefined }))
		teardown.add(() => handle.stop())
		const transport = new HTTPClientTransport({ url: `${handle.base}/mcp` })
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.close()

		await transport.start()
		await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

		expect(messages).toHaveLength(1)
	})
})

describe('HTTPClientTransport — close is idempotent', () => {
	it('emits close once however many times it is called', async () => {
		const transport = new HTTPClientTransport({ url: 'http://127.0.0.1:1/mcp' })
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))

		await transport.close()
		await transport.close()
		await transport.close()

		expect(closed).toBe(1)
	})
})

// SEP-2243's `x-mcp-header` contract on the Node face: what a `tools/list` reply delivers
// after the transport has read it, and what a later `tools/call` carries because of it. The
// peer is a boundary stub for `fetch` alone — it answers with a REAL `Response` carrying the
// exact JSON a foreign 2026-07-28 server sends, and the transport under test is the real one.
// The browser face pins the same rows in tests/src/browser/transports/HTTPClientTransport.test.ts.

const ANNOTATED_TOOLS = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		nextCursor: 'page-2',
		tools: [
			{
				name: 'valid_tool',
				inputSchema: {
					type: 'object',
					properties: {
						region: { type: 'string', 'x-mcp-header': 'Region' },
						priority: { type: 'integer', 'x-mcp-header': 'Priority' },
						verbose: { type: 'boolean', 'x-mcp-header': 'Verbose' },
						query: { type: 'string' },
					},
				},
			},
			{
				name: 'invalid_space_in_name',
				inputSchema: {
					type: 'object',
					properties: { value: { type: 'string', 'x-mcp-header': 'My Region' } },
				},
			},
			{
				name: 'plain_tool',
				inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
			},
		],
	},
}

const CALL_METADATA = { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: {} }

// A listing that advertises one annotated tool, and the fresh listing that no longer carries
// it. A `tools/list` sent with no `cursor` REPLACES what the caller was told, so the second
// of these leaves the transport with nothing to project for `gone`.
const GONE_LISTING = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		tools: [
			{
				name: 'gone',
				inputSchema: {
					type: 'object',
					properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
				},
			},
		],
	},
}

const EMPTY_LISTING = {
	jsonrpc: '2.0',
	id: 2,
	result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [] },
}

// The other half of the same seam: two pages of ONE listing, the second requested with the
// cursor the first handed back. A continuation ACCUMULATES, so both tools stay projectable.
const FIRST_PAGE = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		nextCursor: 'page-2',
		tools: [
			{
				name: 'paged_one',
				inputSchema: {
					type: 'object',
					properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
				},
			},
		],
	},
}

const SECOND_PAGE = {
	jsonrpc: '2.0',
	id: 2,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		tools: [
			{
				name: 'paged_two',
				inputSchema: {
					type: 'object',
					properties: { priority: { type: 'integer', 'x-mcp-header': 'Priority' } },
				},
			},
		],
	},
}

describe('HTTPClientTransport — the x-mcp-header contract', () => {
	it('excludes an invalidly annotated tool from the tools/list result it delivers', async () => {
		const messages: JSONRPCMessage[] = []
		const faults: unknown[] = []
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: () => Promise.resolve(Response.json(ANNOTATED_TOOLS)),
		})
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => faults.push(error))

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})

		const delivered = messages[0]
		if (delivered === undefined || !('result' in delivered) || !isRecord(delivered.result)) {
			throw new Error('the transport delivered no tools/list result')
		}
		const tools = delivered.result['tools']
		if (!Array.isArray(tools)) throw new Error('the delivered result carries no tool array')
		expect(tools.map((tool) => (isRecord(tool) ? tool['name'] : undefined))).toEqual([
			'valid_tool',
			'plain_tool',
		])
		// The rest of the result travels through untouched — the cache stamps a caller reads
		// freshness from, and the cursor it pages with.
		expect(delivered.result['resultType']).toBe('complete')
		expect(delivered.result['cacheScope']).toBe('private')
		expect(delivered.result['ttlMs']).toBe(0)
		expect(delivered.result['nextCursor']).toBe('page-2')
		expect(faults).toHaveLength(1)
		expect(String(faults[0])).toContain('invalid_space_in_name')
	})

	it('projects the annotated arguments of a listed tool into Mcp-Param headers', async () => {
		const headers: Headers[] = []
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				return Promise.resolve(Response.json(ANNOTATED_TOOLS))
			},
		})

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'valid_tool',
				arguments: { region: 'us west 1', priority: 42, verbose: false, query: 'SELECT 1' },
				_meta: CALL_METADATA,
			},
		})

		const listed = headers[0]
		const called = headers[1]
		if (listed === undefined || called === undefined) {
			throw new Error('the transport issued no request')
		}
		// `tools/list` itself projects nothing — the annotations describe a call's arguments.
		expect(listed.get('mcp-param-region')).toBeNull()
		expect(called.get('mcp-param-region')).toBe('us west 1')
		expect(called.get('mcp-param-priority')).toBe('42')
		expect(called.get('mcp-param-verbose')).toBe('false')
		// `query` carries no annotation, so it travels in the body alone.
		expect(called.get('mcp-param-query')).toBeNull()
	})

	it('omits the header of a null argument and encodes one a field cannot carry plainly', async () => {
		const headers: Headers[] = []
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				return Promise.resolve(Response.json(ANNOTATED_TOOLS))
			},
		})

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'valid_tool',
				arguments: { region: 'Hello, 世界', priority: 1, verbose: null },
				_meta: CALL_METADATA,
			},
		})

		const called = headers[1]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-param-region')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=')
		expect(called.get('mcp-param-priority')).toBe('1')
		expect(called.get('mcp-param-verbose')).toBeNull()
	})

	it('projects nothing for a tool it never carried a listing for', async () => {
		const headers: Headers[] = []
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'valid_tool', arguments: { region: 'us-west1' }, _meta: CALL_METADATA },
		})

		const called = headers[0]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-name')).toBe('valid_tool')
		expect(called.get('mcp-param-region')).toBeNull()
	})

	it('projects nothing for a tool a later cursorless listing no longer carries', async () => {
		const headers: Headers[] = []
		let issued = 0
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				issued += 1
				if (issued === 1) return Promise.resolve(Response.json(GONE_LISTING))
				if (issued === 2) return Promise.resolve(Response.json(EMPTY_LISTING))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'gone', arguments: { region: 'us-west1' }, _meta: CALL_METADATA },
		})

		const called = headers[2]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-name')).toBe('gone')
		expect(called.get('mcp-param-region')).toBeNull()
	})

	it('keeps the earlier page projectable when the next listing continues a cursor', async () => {
		const headers: Headers[] = []
		let issued = 0
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				issued += 1
				if (issued === 1) return Promise.resolve(Response.json(FIRST_PAGE))
				if (issued === 2) return Promise.resolve(Response.json(SECOND_PAGE))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { cursor: 'page-2', _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'paged_one', arguments: { region: 'us-west1' }, _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'paged_two', arguments: { priority: 3 }, _meta: CALL_METADATA },
		})

		const first = headers[2]
		const second = headers[3]
		if (first === undefined || second === undefined) {
			throw new Error('the transport issued no call')
		}
		expect(first.get('mcp-param-region')).toBe('us-west1')
		expect(second.get('mcp-param-priority')).toBe('3')
	})

	// Overlapping listings: `send` opens an independent `fetch` per call, so two `tools/list`
	// answers can arrive in the opposite order to their requests. The stub holds the first
	// answer back to script exactly that arrival order — it answers with real `Response`
	// objects and reimplements nothing this package owns.
	it('caches nothing from a listing a fresh one superseded before its answer arrived', async () => {
		const headers: Headers[] = []
		let issued = 0
		let release: ((response: Response) => void) | undefined
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				issued += 1
				if (issued === 1) {
					return new Promise<Response>((resolve) => {
						release = resolve
					})
				}
				if (issued === 2) return Promise.resolve(Response.json(EMPTY_LISTING))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		// A continuation goes out first and its answer is held; the fresh cursorless listing
		// sent behind it lands first and replaces the table.
		const superseded = transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { cursor: 'page-2', _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		if (release === undefined) throw new Error('the transport issued no continuation')
		release(Response.json(SECOND_PAGE))
		await superseded
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'paged_two', arguments: { priority: 3 }, _meta: CALL_METADATA },
		})

		const called = headers[2]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-name')).toBe('paged_two')
		expect(called.get('mcp-param-priority')).toBeNull()
	})

	// Withholding the cache is not withholding the answer. The caller still receives the
	// superseded page with its invalid definition dropped and the exclusion still on `error`;
	// only the projection table is left alone.
	it('excludes and reports an invalid definition on a superseded listing it caches nothing from', async () => {
		const headers: Headers[] = []
		const messages: JSONRPCMessage[] = []
		const faults: unknown[] = []
		let issued = 0
		let release: ((response: Response) => void) | undefined
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				issued += 1
				if (issued === 1) {
					return new Promise<Response>((resolve) => {
						release = resolve
					})
				}
				if (issued === 2) return Promise.resolve(Response.json(EMPTY_LISTING))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => faults.push(error))

		const superseded = transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { cursor: 'page-2', _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		if (release === undefined) throw new Error('the transport issued no continuation')
		release(Response.json(ANNOTATED_TOOLS))
		await superseded
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'valid_tool', arguments: { region: 'us-west1' }, _meta: CALL_METADATA },
		})

		const delivered = messages[1]
		if (delivered === undefined || !('result' in delivered) || !isRecord(delivered.result)) {
			throw new Error('the transport delivered no superseded tools/list result')
		}
		const tools = delivered.result['tools']
		if (!Array.isArray(tools)) throw new Error('the delivered result carries no tool array')
		expect(tools.map((tool) => (isRecord(tool) ? tool['name'] : undefined))).toEqual([
			'valid_tool',
			'plain_tool',
		])
		expect(faults).toHaveLength(1)
		expect(String(faults[0])).toContain('invalid_space_in_name')
		// The page was delivered whole and cached not at all.
		const called = headers[2]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-param-region')).toBeNull()
	})

	it('keeps both pages projectable when a fresh listing and its own continuation overlap', async () => {
		const headers: Headers[] = []
		let issued = 0
		let listing: ((response: Response) => void) | undefined
		let continuation: ((response: Response) => void) | undefined
		const transport = createHTTPClientTransport({
			url: 'http://localhost/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				issued += 1
				if (issued === 1) {
					return new Promise<Response>((resolve) => {
						listing = resolve
					})
				}
				if (issued === 2) {
					return new Promise<Response>((resolve) => {
						continuation = resolve
					})
				}
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		// Both pages of ONE listing are in flight together, and they answer in order.
		const fresh = transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		const paged = transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { cursor: 'page-2', _meta: CALL_METADATA },
		})
		if (listing === undefined || continuation === undefined) {
			throw new Error('the transport issued no listing')
		}
		listing(Response.json(FIRST_PAGE))
		await fresh
		continuation(Response.json(SECOND_PAGE))
		await paged
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'paged_one', arguments: { region: 'us-west1' }, _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'paged_two', arguments: { priority: 3 }, _meta: CALL_METADATA },
		})

		const first = headers[2]
		const second = headers[3]
		if (first === undefined || second === undefined) {
			throw new Error('the transport issued no call')
		}
		expect(first.get('mcp-param-region')).toBe('us-west1')
		expect(second.get('mcp-param-priority')).toBe('3')
	})
})
