// The package's own features, composed and driven together.
//
// An integration test is an end-to-end test: it puts the features of this package together
// through the public API and drives them, replacing no part of the system under test. This one
// is the TOP-LEVEL proof, so every case crosses an environment boundary — a server built from
// the core face, mounted through the server face, carried by the browser face, and driven back
// through the core face's client. What one face does alone is proven in `tests/src/**`; what is
// proven here is that they compose.
//
// Nothing here packs, installs, or compiles anything. What the published tarball contains is a
// different question from whether the features work together.
//
// The composition costs real sockets and real handshakes, so it is its own `integration`
// project with its own timeout, kept out of `npm test` and required by `prepublishOnly`.

import type { MCPClientInterface, MCPVersion } from '@src/core'
import type { MCPSessionState } from '@src/server'
import type { ToolManagerInterface } from '@orkestrel/tool'
import type { StartedServerInterface } from './setupServer.js'
import { describe, expect, it } from 'vitest'
import {
	bindClient,
	bindServer,
	createDuplexClientTransport,
	createMCPClient,
	createMCPLegacy,
	createMCPServer,
	MCP_LEGACY_VERSION,
	MCP_MODERN_VERSION,
} from '@src/core'
import { createMessagePortTransport } from '@src/browser'
import {
	createHTTPClientTransport,
	createMCPRoutes,
	createMCPSession,
	createWebSocketClientTransport,
	createWebSocketServer,
} from '@src/server'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createJSONRPCRequest, postJSON } from './setup.js'
import { createTeardown, startServer } from './setupServer.js'

/** The JSON Schema `sum` advertises, renamed to `inputSchema` on the wire and back again. */
const SUM_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
	type: 'object',
	properties: Object.freeze({
		left: Object.freeze({ type: 'number' }),
		right: Object.freeze({ type: 'number' }),
	}),
})

/** What the failing tool throws, verbatim, so every face can be checked for the same text. */
const FAULT_MESSAGE = 'the tool refused the call'

/** The composed deployment one case drives. */
interface TestStackInterface {
	/** The live registry every face serves — a tool added here reaches all of them. */
	readonly tools: ToolManagerInterface
	/** The listener's bound base URL, carrying both Node-face transports. */
	readonly base: string
	/**
	 * Open a core client over the server face's Streamable-HTTP carrier.
	 *
	 * @param version - The revision to pin, for a client that must handshake; omit for modern
	 * @returns An unconnected client, tracked for teardown
	 */
	http(version?: MCPVersion): MCPClientInterface
	/**
	 * Open a core client over the server face's WebSocket carrier.
	 *
	 * @returns An unconnected client, tracked for teardown
	 */
	socket(): MCPClientInterface
	/**
	 * Open a core client over the browser face's `MessagePort` carrier, bound to the SAME server.
	 *
	 * @returns An unconnected client whose carrier is one half of a real `MessageChannel`
	 */
	channel(): MCPClientInterface
	/** Disconnect every client this stack opened, then close its carriers and its listener. */
	stop(): Promise<void>
}

/** How one {@link startStack} deployment is mounted. */
interface TestStackOptions {
	/**
	 * Mount the legacy decorator and the stateful session middleware.
	 *
	 * @remarks
	 * The decorator serves BOTH eras, and the session layer acts on legacy traffic only, so a
	 * stack built this way is the deployment a consumer ships when it must answer dated
	 * `initialize` clients as well as modern ones.
	 */
	readonly legacy?: boolean
}

/**
 * Add two numeric arguments, refusing anything else.
 *
 * @param args - The caller-supplied arguments record, exactly as it came off the wire
 * @returns The sum
 * @throws When either argument is missing or not a number
 */
function sumArguments(args: Readonly<Record<string, unknown>>): number {
	const left = args['left']
	const right = args['right']
	if (typeof left !== 'number' || typeof right !== 'number') {
		throw new Error('sum takes two numbers')
	}
	return left + right
}

/**
 * Fail the call the way a misbehaving tool does.
 *
 * @returns Never
 * @throws Always, carrying {@link FAULT_MESSAGE}
 */
function raiseFault(): never {
	throw new Error(FAULT_MESSAGE)
}

/**
 * Build the live tool registry every composed face serves.
 *
 * @remarks
 * `sum` computes from its arguments, so a value that arrives was really carried both ways
 * rather than fabricated at either end; `explode` throws, so every face also carries the
 * failure path.
 *
 * @returns A registry holding `sum` and `explode`, in that order
 */
function createRegistry(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'sum',
			description: 'Add two numbers',
			parameters: SUM_SCHEMA,
			execute: sumArguments,
		}),
	)
	tools.add(createTool({ name: 'explode', execute: raiseFault }))
	return tools
}

/**
 * Mount one core MCP server on every face this package ships.
 *
 * @remarks
 * One `createMCPServer` over one registry, reached three ways: `createMCPRoutes` as
 * `POST /mcp` and `createWebSocketServer` on the upgrade seam of one real
 * `@orkestrel/server` listener, plus the browser face's `MessagePort` carrier. Each opener
 * tracks the client it returns, so `stop()` disconnects every carrier before the listener is
 * stopped — a graceful stop waits for open connections to drain, so a socket left behind by a
 * failing assertion would otherwise hold teardown open until the hook times out.
 *
 * @param options - Whether to mount the legacy decorator and session layer; see
 *   {@link TestStackOptions}
 * @returns The running deployment plus its teardown
 */
async function startStack(options?: TestStackOptions): Promise<TestStackInterface> {
	const tools = createRegistry()
	const mcp = createMCPServer({ identity: { name: 'integration', version: '1.0.0' }, tools })
	// The one dispatch face every carrier below is mounted on, so a case cannot reach one era
	// on one carrier and another era on the next.
	const face = options?.legacy === true ? createMCPLegacy(mcp) : mcp
	const dispatcher = createDispatcher<MCPSessionState>()
	dispatcher.add(createMCPRoutes<MCPSessionState>(face))
	const server = createServer<MCPSessionState>({
		dispatcher,
		state: () => ({}),
		host: '127.0.0.1',
	})
	if (options?.legacy === true) server.use(createMCPSession<MCPSessionState>())
	server.upgrade(createWebSocketServer(face, { emitter: server.emitter }))
	const handle: StartedServerInterface<MCPSessionState> = await startServer(server)
	const channels: MessageChannel[] = []
	const clients: MCPClientInterface[] = []
	const base = handle.base
	return {
		tools,
		base,
		http(version) {
			const transport = createHTTPClientTransport({ url: `${base}/mcp` })
			const client = createMCPClient({
				transport,
				...(version === undefined ? {} : { version }),
			})
			clients.push(client)
			return client
		},
		socket() {
			const client = createMCPClient({
				transport: createWebSocketClientTransport({ url: `${base}/mcp` }),
			})
			clients.push(client)
			return client
		},
		channel() {
			const channel = new MessageChannel()
			channels.push(channel)
			// Both halves bind synchronously after construction — a `MessagePort` transport
			// starts its port at construction, so an await in the gap would drop queued frames.
			bindServer(face, createMessagePortTransport({ port: channel.port1 }))
			const carrier = createMessagePortTransport({ port: channel.port2 })
			const client = createMCPClient({ transport: createDuplexClientTransport(carrier) })
			bindClient(client, carrier)
			clients.push(client)
			return client
		},
		async stop() {
			for (const client of clients) await client.disconnect()
			for (const channel of channels) {
				channel.port1.close()
				channel.port2.close()
			}
			await handle.stop()
		},
	}
}

const { track } = createTeardown((stack: TestStackInterface) => stack.stop())

describe('a core server mounted on the server face and driven by a core client', () => {
	it('carries a list, a computed call, and a tool failure over a real HTTP socket', async () => {
		const stack = track(await startStack())
		const client = stack.http()

		await client.connect()
		expect(client.connected).toBe(true)

		// The registry's own tools, as local `ToolInterface`s: the server renamed `parameters`
		// to `inputSchema` on the way out and the client renamed it back on the way in, so the
		// schema surviving the round trip is a fact about the pair rather than about either half.
		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['sum', 'explode'])
		expect(tools.find((tool) => tool.name === 'sum')?.parameters).toEqual(SUM_SCHEMA)

		// 5 is computed by the registry's tool from arguments that crossed the wire, so neither
		// end could have produced this answer alone.
		expect(await client.call('sum', { left: 2, right: 3 })).toEqual({
			resultType: 'complete',
			value: 5,
		})

		// A tool throw is an in-band `isError` result on the wire and a local throw here.
		await expect(client.call('explode', {})).rejects.toThrow(FAULT_MESSAGE)

		await client.disconnect()
		expect(client.connected).toBe(false)
	})
})

describe('one core server, one live registry, three carriers', () => {
	it('serves a tool registered after every client connected, over HTTP, WebSocket, and a MessagePort', async () => {
		const stack = track(await startStack())
		const http = stack.http()
		const socket = stack.socket()
		// The browser face inside a Node project: a real `MessageChannel`, the same transport
		// class the page and worker builds use, binding the same server to the same core client.
		const channel = stack.channel()

		await http.connect()
		await socket.connect()
		await channel.connect()

		// Registered AFTER all three handshakes: a carrier holding a snapshot of the registry
		// would answer the two rows below with the pre-connect list and the wrong value.
		stack.tools.add(createTool({ name: 'late', execute: () => 'registered late' }))

		expect([
			(await http.tools()).map((tool) => tool.name),
			(await socket.tools()).map((tool) => tool.name),
			(await channel.tools()).map((tool) => tool.name),
		]).toEqual([
			['sum', 'explode', 'late'],
			['sum', 'explode', 'late'],
			['sum', 'explode', 'late'],
		])

		const answer = { resultType: 'complete', value: 'registered late' }
		expect([
			await http.call('late', {}),
			await socket.call('late', {}),
			await channel.call('late', {}),
		]).toEqual([answer, answer, answer])

		await http.disconnect()
		await socket.disconnect()
		await channel.disconnect()
	})
})

describe('the remote tools of a composed server, run by a local tool manager', () => {
	it('executes a remote tool through a local ToolManager and isolates its failure', async () => {
		const stack = track(await startStack())
		const client = stack.http()
		await client.connect()

		// The agent loop the package exists for: the remote registry's tools, added to a LOCAL
		// manager, run through that manager as if they were local — across a real socket.
		const agent = createToolManager()
		agent.add(await client.tools())
		expect(agent.tools().map((tool) => tool.name)).toEqual(['sum', 'explode'])

		expect(
			await agent.execute({ id: 'call-1', name: 'sum', arguments: { left: 20, right: 22 } }),
		).toEqual({ id: 'call-1', name: 'sum', success: true, value: 42 })

		// The remote throw travels the wire as `isError`, becomes a local throw in the wrapped
		// tool, and the local manager isolates THAT exactly as it isolates a local one.
		expect(await agent.execute({ id: 'call-2', name: 'explode', arguments: {} })).toEqual({
			id: 'call-2',
			name: 'explode',
			success: false,
			error: FAULT_MESSAGE,
		})

		await client.disconnect()
	})
})

describe('one deployment, one registry, both wire eras', () => {
	it('answers a dated handshake statefully and a modern client on the same endpoint', async () => {
		const stack = track(await startStack({ legacy: true }))
		const legacy = stack.http(MCP_LEGACY_VERSION)
		const modern = stack.http()

		await legacy.connect()
		await modern.connect()

		// Era is the shape of the wire and one endpoint answers both: the dated client
		// handshook, the modern one announced its revision on the request itself.
		expect([legacy.version, modern.version]).toEqual([MCP_LEGACY_VERSION, MCP_MODERN_VERSION])

		// One registry underneath both eras.
		expect([
			await legacy.call('sum', { left: 1, right: 1 }),
			await modern.call('sum', { left: 1, right: 1 }),
		]).toEqual([
			{ resultType: 'complete', value: 2 },
			{ resultType: 'complete', value: 2 },
		])

		// The session layer really is in front of both calls above, and only the dated era is
		// subject to it: the same dated request posted raw — without the minted id the legacy
		// transport captured and echoes back — is refused.
		const refused = await postJSON(
			stack.base,
			createJSONRPCRequest({ method: 'tools/list', id: 7 }),
		)
		expect(refused.status).toBe(404)

		await legacy.disconnect()
		await modern.disconnect()
	})
})
