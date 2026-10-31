import type { MiddlewareContext, NextFunction, UpgradeHandler } from '@orkestrel/server'
import type { RecorderInterface } from '@orkestrel/test'
import type { MCPLegacyVersion } from '@src/core'
import type { JSONRPCResponse, MCPStream } from '@src/core'
import type { SSEMessage } from '@orkestrel/server'
import type { JSONRPCNotification, MCPSubscriptionResult } from '@src/core'
import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { HTTPTransportOptions } from '@src/server'
import type { MCPOriginOptions, MCPSessionOptions, MCPSessionState } from '@src/server'
import type { SSEEvent } from '@orkestrel/sse'
import type { ScratchInterface } from '@orkestrel/test/server'
import type { TeardownInterface } from '@orkestrel/test'
import type {
	MCPClientInterface,
	MCPServerInterface,
	MCPDispatcherInterface,
	JSONRPCInvocation,
	JSONRPCMessage,
	JSONRPCId,
	MCPMessageTransportInterface,
	MCPCompletion,
	MCPContent,
	MCPContinuationInterface,
	MCPInputContext,
	MCPInputRequestMap,
	MCPInputResult,
	MCPInputRound,
	MCPPrompt,
	MCPPromptGetParams,
	MCPPromptMessage,
	MCPResource,
	MCPResourceContents,
	MCPServerOptions,
	MCPCallOutcome,
	MCPElicitValue,
	MCPInputRequest,
	MCPInputResponse,
} from '@src/core'
import type { SourceInterface } from '@orkestrel/guide'
import type { MiddlewareHandler, ServerInterface, StreamInterface } from '@orkestrel/server'
import type { WebSocketFrame } from '@orkestrel/websocket'
import type { ManualClockInterface } from './setup.js'
import type { ToolManagerInterface, ToolInterface } from '@orkestrel/tool'
import { createSource } from '@orkestrel/guide'
import { buildJSONRPCResult, isJSONRPCId, MCP_WEBSOCKET_SUBPROTOCOL } from '@src/core'
import { mergeVary, resolveOrigin } from '@orkestrel/server'
import { createNodeWebSocket } from '@orkestrel/websocket'
import {
	WebSocketServerTransport,
	createDuplexServerTransport,
	upgradeRequestPath,
} from '@src/server'
import { createNodeWebSocketClientTransport } from '@src/server'
import { createRecorder } from '@orkestrel/test'
import {
	bindClient,
	bindServer,
	createDuplexClientTransport,
	createMCPLegacyClientTransport,
	isMCPSubscriptionResult,
	MCP_META_SUBSCRIPTION,
} from '@src/core'
import { createStdioClientTransport } from '@src/server'
import {
	createLoopbackTransport,
	createMemoryTransport,
	createSubscriptionServer,
	waitForSettlement,
} from './setup.js'
import { fstatSync } from 'node:fs'
import { createStdioServer } from '@src/server'
import { createMCPPostHandler as createPostHandler } from '@src/server'
import { createAnnotatedServer } from './setup.js'
import {
	MCP_MODERN_VERSION,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_META_VERSION,
	MCP_META_CAPABILITIES,
} from '@src/core'
import { createMCPLegacy, MCP_SESSION_HEADER } from '@src/core'
import { createMCPSession } from '@src/server'
import { postJSON, readSSEStream } from './setup.js'
import { StdioClientTransport } from '@src/server'
import { buildPeerDiscovery, buildClientHandshakeResponse } from './setup.js'
import { createJSONRPCRequest, createCalculatorServer, MCPFixtureCell } from './setup.js'
import { createServer as createHTTPServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import { isRecord, attempt, isFiniteNumber, isString, isArray } from '@orkestrel/contract'
import { extractSourceLines, extractFenceImports, findMissing } from '@orkestrel/guide'
import { waitForDelay, waitForCondition, waitForEvent } from '@orkestrel/test'
import {
	computeWebSocketAccept,
	encodeWebSocketFrame,
	parseWebSocketFrame,
	WEBSOCKET_OPCODE_TEXT,
	WEBSOCKET_OPCODE_CLOSE,
} from '@orkestrel/websocket'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { relative, basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTool, createToolManager } from '@orkestrel/tool'
import {
	createMCPServer,
	createMCPClient,
	parseJSONRPCMessage,
	MCP_HANDSHAKE_VERSION,
	createHTTPClientTransport,
} from '@src/core'
import { createMCPContinuation, createMCPRoutes, createWebSocketServer } from '@src/server'

export function createRemoteServer(): MCPServerInterface {
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

export interface MCPClientFixtureOptions {
	readonly stream?: boolean
	readonly guardSecret?: string
}

export async function connectClient(
	teardown: TeardownInterface,
	options?: MCPClientFixtureOptions,
): Promise<{ readonly client: MCPClientInterface; readonly handle: StartedServerInterface }> {
	const dispatcher = createDispatcher<unknown>()
	dispatcher.add(
		createMCPRoutes(createMCPLegacy(createRemoteServer()), {
			...(options?.stream !== undefined ? { stream: options.stream } : {}),
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

export interface EndlessStreamInterface {
	readonly base: string
	/** How many requests the server saw the client abandon. */
	readonly abandoned: number
	stop(): Promise<void>
}

// A real `node:http` peer that answers every POST with a `text/event-stream` it never ends:
// it writes the SSE headers plus one comment line (so `fetch` resolves its Response) and then
// holds the response open. `abandoned` counts the requests whose client went away, which is
// what an aborted `fetch` looks like from the server's side.
export async function startEndlessStream(): Promise<EndlessStreamInterface> {
	const abandoned = new MCPFixtureCell(0)
	const server = createHTTPServer((request, response) => {
		request.on('close', () => {
			if (!response.writableEnded) abandoned.value += 1
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
			return abandoned.value
		},
		stop(): Promise<void> {
			return new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			})
		},
	}
}

export function createBearerGuard(secret: string): MiddlewareHandler<unknown> {
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
export interface MCPRouteFixtureOptions {
	readonly stream?: boolean
	readonly path?: string
	readonly guardSecret?: string
}

export async function startMCP(
	teardown: TeardownInterface,
	options?: MCPRouteFixtureOptions,
): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	dispatcher.add(
		createMCPRoutes(createMCPLegacy(createCalculatorServer()), {
			...(options?.stream !== undefined ? { stream: options.stream } : {}),
			...(options?.path !== undefined ? { path: options.path } : {}),
		}),
	)
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	if (options?.guardSecret !== undefined) server.use(createBearerGuard(options.guardSecret))
	const handle = await startServer(server)
	teardown.add(() => closeResource(handle))
	return handle
}

export async function startWsMCP(
	teardown: TeardownInterface,
	mcp: MCPDispatcherInterface = createCalculatorServer(),
): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	// Ingress over the spine upgrade seam, following the spine's own lifecycle: `emitter` is
	// what lets `stop()` end the sockets this handler claimed.
	server.upgrade(createWebSocketServer(mcp, { emitter: server.emitter }))
	const handle = await startServer(server)
	teardown.add(() => closeResource(handle))
	return handle
}

export async function driveStdioChild(
	mcp: MCPDispatcherInterface,
	mode: 'legacy' | 'bare',
): Promise<number | null> {
	const child = spawn(
		process.execPath,
		[
			'-e',
			`
const mode = process.argv[1]

function fail(message) {
	process.stderr.write(message + '\\n')
	process.exit(1)
}

function send(message) {
	process.stdout.write(JSON.stringify(message) + '\\n')
}

class StdioPeer {
	#buffer = ''
	#stage = 'initialize'

	receive(message) {
		if (this.#stage === 'initialize') {
			if (mode === 'bare') {
				if (message.error?.code !== -32601) fail('bare raw legacy initialize was not refused -32601')
				if (message.error?.message !== 'Method not found: initialize') {
					fail('bare raw legacy initialize refusal did not name initialize: ' + message.error?.message)
				}
				this.#stage = 'control'
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
			this.#stage = 'call'
			send({ jsonrpc: '2.0', method: 'notifications/initialized' })
			send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add', arguments: {} } })
			return
		}
		if (this.#stage === 'control') {
			if (message.error?.code !== -32601) fail('bare modern-shaped initialize did not answer -32601')
			if (message.error?.message !== 'Method not found: initialize') {
				fail('bare modern-shaped initialize refusal did not name initialize: ' + message.error?.message)
			}
			process.exit(0)
		}
		if (message.result?.content?.[0]?.text !== '5') fail('legacy tools/call failed')
		process.exit(0)
	}
	

	read(chunk) {
		this.#buffer += chunk
		for (;;) {
			const newline = this.#buffer.indexOf('\\n')
			if (newline === -1) return
			const line = this.#buffer.slice(0, newline)
			this.#buffer = this.#buffer.slice(newline + 1)
			if (line.length > 0) this.receive(JSON.parse(line))
		}
	}
}

const peer = new StdioPeer()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => peer.read(chunk))

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

export function createStdioPair(): { readonly input: PassThrough; readonly output: PassThrough } {
	const input = new PassThrough()
	const output = new PassThrough()
	return { input, output }
}

export async function readStdioLine(output: PassThrough): Promise<string> {
	return new Promise((resolve) => {
		const buffer = new MCPFixtureCell('')
		output.on('data', (chunk: Buffer) => {
			buffer.value += chunk.toString()
			const newline = buffer.value.indexOf('\n')
			if (newline !== -1) resolve(buffer.value.slice(0, newline))
		})
	})
}

export function createLegacyPostHandler<TState = unknown>(
	mcp: MCPServerInterface,
	options?: HTTPTransportOptions<TState>,
): ReturnType<typeof createPostHandler<TState>> {
	return createPostHandler(createMCPLegacy(mcp), options)
}

export async function startHTTP(
	teardown: TeardownInterface,
	mcp: MCPServerInterface,
	options?: HTTPTransportOptions,
): Promise<StartedServerInterface<undefined>> {
	const dispatcher = createDispatcher<undefined>()
	dispatcher.add(createMCPRoutes<undefined>(createMCPLegacy(mcp), options))
	const handle = await startServer(createServer({ dispatcher, state: () => undefined }))
	teardown.add(() => handle.stop())
	return handle
}

export function disconnectHTTP(
	url: string,
	options: {
		readonly method: string
		readonly headers: Readonly<Record<string, string>>
		readonly body: string
	},
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const outgoing = httpRequest(url, {
			method: options.method,
			headers: options.headers,
		})
		outgoing.on('response', (response) => {
			response.once('data', () => response.destroy())
			response.once('close', () => setImmediate(resolve))
			response.on('error', (error) => {
				if (!response.destroyed) reject(error)
			})
		})
		outgoing.on('error', (error) => {
			if (!outgoing.destroyed) reject(error)
		})
		outgoing.end(options.body)
	})
}

export async function callAnnotated(
	name: string,
	headers: Readonly<Record<string, string>>,
	args: Readonly<Record<string, unknown>>,
): Promise<Response> {
	return await callTool(createAnnotatedServer(), name, headers, args)
}

export async function callTool(
	server: MCPServerInterface,
	name: string,
	headers: Readonly<Record<string, string>>,
	args: Readonly<Record<string, unknown>>,
): Promise<Response> {
	const handler = createLegacyPostHandler(server, { stream: false })
	return await handler(
		new Request('http://localhost/mcp', {
			method: 'POST',
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'tools/call',
				[MCP_NAME_HEADER]: name,
				...headers,
			},
			body: JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name,
						arguments: args,
						_meta: {
							[MCP_META_VERSION]: MCP_MODERN_VERSION,
							[MCP_META_CAPABILITIES]: {},
						},
					},
				}),
			),
		}),
	)
}

export interface AppState extends MCPSessionState {
	readonly caller?: unknown
}

export function pushTrigger(payload: JSONRPCMessage): MiddlewareHandler<AppState> {
	return (input, context, next) => {
		if (context.method === 'POST' && input.headers.get('x-push-now') === '1') {
			const session = context.state.session
			if (session !== undefined) {
				session.push(payload)
				return new Response(null, { status: 202 })
			}
		}
		return next()
	}
}

export function authenticateCaller(caller: unknown): MiddlewareHandler<AppState> {
	return (_input, context, next) => {
		if (!Reflect.set(context.state, 'caller', caller)) {
			throw new Error('MCP caller state is not writable')
		}
		return next()
	}
}

// Stand up a STATEFUL MCP server: `createMCPSession` in front of a session-agnostic
// `createMCPRoutes`, plus (optionally) the in-request push-trigger app middleware. `ttl`, `clock`,
// and the `session` group flow to the middleware (`clock` is the deterministic manual clock the
// TTL specs advance explicitly).
export interface MCPSessionFixtureOptions {
	readonly ttl?: number
	readonly session?: MCPSessionOptions
	readonly push?: JSONRPCMessage
	readonly clock?: () => number
	readonly origin?: MCPOriginOptions
	readonly elapse?: { readonly clock: ManualClockInterface; readonly ms: number }
	readonly hold?: number
}

export async function startSession(
	teardown: TeardownInterface,
	options?: MCPSessionFixtureOptions,
): Promise<StartedServerInterface<AppState>> {
	const origin = options?.origin
	const dispatcher = createDispatcher<AppState>()
	dispatcher.add(
		createMCPRoutes<AppState>(createMCPLegacy(createCalculatorServer()), {
			...(origin !== undefined ? { origin } : {}),
		}),
	)
	const server = createServer<AppState>({ dispatcher, state: () => ({}) })
	server.use(
		createMCPSession<AppState>({
			...(options?.ttl !== undefined ? { ttl: options.ttl } : {}),
			...(options?.session !== undefined ? { session: options.session } : {}),
			...(options?.clock !== undefined ? { clock: options.clock } : {}),
			...(origin !== undefined ? { origin } : {}),
		}),
	)
	// BEHIND the session middleware, so the clock moves while `createMCPSession` is suspended
	// at `await next(forwarded)` — the only place a "last access" claim can be falsified.
	const elapse = options?.elapse
	if (elapse !== undefined) server.use(createClockMiddleware<AppState>(elapse.clock, elapse.ms))
	if (options?.hold !== undefined) server.use(createDelayMiddleware<AppState>(options.hold))
	if (options?.push !== undefined) server.use(pushTrigger(options.push))
	const handle = await startServer(server)
	teardown.add(() => handle.stop())
	return handle
}

// POST a non-initialize request carrying a session id header — the stateful validation path.
export function postSession(
	base: string,
	id: string | undefined,
	body: unknown,
	headers?: Record<string, string>,
): Promise<Response> {
	const merged: Record<string, string> = { ...headers }
	if (id !== undefined) merged[MCP_SESSION_HEADER] = id
	return postJSON(base, body, { headers: merged })
}

export async function openSessionStream(
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
export async function takeEvents(response: Response, n: number): Promise<readonly SSEEvent[]> {
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
export function triggerPush(base: string, id: string): Promise<Response> {
	return postSession(base, id, createJSONRPCRequest({ method: 'ping', id: 'trigger' }), {
		'x-push-now': '1',
	})
}

export const CHILD_SCRIPT = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
function readMessage(line) {
	try {
		return JSON.parse(line)
	} catch {
		return undefined
	}
}
rl.on('line', (line) => {
	const msg = readMessage(line)
	if (msg === undefined) return
	if (msg.method === 'ping') {
		process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pong: true } }) + '\\n')
	} else if (msg.method === 'boom') {
		process.stdout.write('{ not json\\n')
	}
})
`

// A child that reports its pid, never reads its stdin, and stays alive on a timer. A line larger
// than the host's pipe buffer therefore sits undelivered in the channel for as long as the child
// lives, which makes the delivery bound and the child's liveness observable at the same rejection.
export const DEAF_CHILD_SCRIPT = `
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'ready', result: { pid: process.pid } }) + '\\n')
setInterval(() => {}, 1000)
`

// The child reports a descendant pid and exits. The detached descendant inherits stdout, keeping
// the readline reader open after the child has gone, until the supervisor's drain bound closes it.
export const DESCENDANT_PIPE_SCRIPT = `
const { spawn } = require('node:child_process')
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
	detached: true,
	stdio: ['ignore', 'inherit', 'ignore'],
})
descendant.unref()
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'descendant', result: { pid: descendant.pid } }) + '\\n')
`

/** Names the burst line delivered before a listener can close the transport. */
export const BURST_FIRST = 'first'

/** Names the burst line queued behind the initial delivery. */
export const BURST_SECOND = 'second'

// A child that answers one request with complete lines in one write. A listener calling `close()`
// from the first delivery must prevent the remaining line in that chunk from being delivered.
export const BURST_SCRIPT = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', () => {
	const first = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { burst: ${JSON.stringify(BURST_FIRST)} } })
	const second = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { burst: ${JSON.stringify(BURST_SECOND)} } })
	process.stdout.write(first + '\\n' + second + '\\n')
})
`

// Comfortably above both a Windows stdio pipe buffer and a 64 KiB POSIX one, so the write below
// cannot be swallowed whole by the host and answered before the child has read anything.
export const UNREAD_PAYLOAD = 'x'.repeat(256 * 1024)

/** Bounds the additional wait beyond the supervisor's drain deadline, in milliseconds. */
export const CLOSE_SLACK = 2_000

export function spawnClient(): StdioClientTransport {
	return new StdioClientTransport({ command: process.execPath, args: ['-e', CHILD_SCRIPT] })
}

export function spawnDeafClient(): StdioClientTransport {
	return new StdioClientTransport({
		command: process.execPath,
		args: ['-e', DEAF_CHILD_SCRIPT],
		// This fixture is the unbounded control: teardown, not a delivery window, settles its write.
		delivery: 0,
	})
}

export function spawnDescendantClient(): StdioClientTransport {
	return new StdioClientTransport({
		command: process.execPath,
		args: ['-e', DESCENDANT_PIPE_SCRIPT],
	})
}

export function spawnBurstClient(): StdioClientTransport {
	return new StdioClientTransport({ command: process.execPath, args: ['-e', BURST_SCRIPT] })
}

export const EVIDENCE_SENTINEL = 'evidence-sentinel'

/** Names the stderr marker the overflow byte bound drops. */
export const EVIDENCE_HEAD = 'evidence-head'

/** Names the stderr marker the overflow byte bound keeps. */
export const EVIDENCE_TAIL = 'evidence-tail'

/** Supplies a character whose UTF-8 encoding occupies multiple bytes. */
export const MULTIBYTE = 'é'

/** Measures the UTF-8 width of {@link MULTIBYTE} on the test host. */
export const MULTIBYTE_BYTES = Buffer.byteLength(MULTIBYTE, 'utf8')

/** Supplies a character whose UTF-8 width does not divide the byte bound. */
export const UNEVEN = '€'

/** Measures the UTF-8 width of {@link UNEVEN} on the test host. */
export const UNEVEN_BYTES = Buffer.byteLength(UNEVEN, 'utf8')

/** Names the decoder's replacement for an incomplete byte sequence. */
export const REPLACEMENT = '\uFFFD'

/** Names the bytes written by the child's SIGTERM handler. */
export const HANDLED_SENTINEL = 'handled-sentinel'

/** Names the scratch file that records execution of the signal handler. */
export const HANDLED_FILE = 'handled.txt'

/** Reports whether the host terminates children without a catchable signal. */
export const FORCED = process.platform === 'win32'

/** Names an unavailable command for the spawn-failure scenario. */
export const ABSENT_COMMAND = 'orkestrel-mcp-absent-command'

/** Sets the exit code reported by failing child fixtures. */
export const EVIDENCE_CODE = 3

/** Names the descendant's bytes written before the child ends. */
export const DESCENDANT_EARLY = 'descendant-early'

/** Names the descendant's bytes written after the tail is frozen. */
export const DESCENDANT_LATE = 'descendant-late'

/** Names the scratch file that releases the descendant's late write. */
export const TRIGGER_FILE = 'trigger.txt'

/** Names the scratch file that records completion of the late stderr write. */
export const DONE_FILE = 'done.txt'

/** Names the scratch file that prevents replacement children from spawning descendants. */
export const CLAIM_FILE = 'claim.txt'

/** Names the executable resolved through PATH by the evidence fixture. */
export const EVIDENCE_EXECUTABLE = basename(process.execPath)

/** Names the PATH entry that resolves {@link EVIDENCE_EXECUTABLE}. */
export const EVIDENCE_DIRECTORY = dirname(process.execPath)

/** Bounds the repeated tail observation window, in milliseconds. */
export const STABILITY_WINDOW = 500

// One parameterized child whose entire job is what it puts on its own `stderr`. `MCP_EVIDENCE_WAIT`
// keeps it alive and defers the write until a line arrives, so a test can read a live tail before
// and after the child writes; without it the child writes once and ends, optionally non-zero.
export const EVIDENCE_SCRIPT = `
const payload = process.env.MCP_EVIDENCE_PAYLOAD
const code = process.env.MCP_EVIDENCE_CODE
const write = () => { if (payload !== undefined) process.stderr.write(payload) }
if (process.env.MCP_EVIDENCE_WAIT === 'true') {
	const readline = require('node:readline')
	readline.createInterface({ input: process.stdin }).on('line', write)
	const timer = setInterval(() => {}, 1000)
	process.stdin.on('end', () => clearInterval(timer))
} else {
	write()
	if (code !== undefined) process.exitCode = Number(code)
}
`

// A child that installs a `SIGTERM` handler and writes its startup marker at once. The handler
// records a scratch file as well as stderr bytes, so a reading that finds no handler bytes in the
// tail can still say whether the handler ran and its write was lost or the host never delivered
// the signal at all.
export const HANDLED_SCRIPT = `
const { writeFileSync } = require('node:fs')
process.on('SIGTERM', () => {
	writeFileSync(process.env.MCP_EVIDENCE_HANDLED, 'handled')
	process.stderr.write(${JSON.stringify(HANDLED_SENTINEL)}, () => { process.exit(0) })
})
process.stderr.write(process.env.MCP_EVIDENCE_PAYLOAD)
setInterval(() => {}, 1000)
`

// The detached descendant that outlives the child it was spawned from, holding that child's
// inherited `stderr`. It writes its early marker at once, then parks on the trigger file the test
// creates after the teardown barrier, writes its late marker, and reports that the write flushed.
// The deadline is a self-release, so an abandoned descendant ends rather than parking forever.
export const DESCENDANT_SCRIPT = `
const { existsSync, writeFileSync } = require('node:fs')
process.stderr.write(process.env.MCP_EVIDENCE_EARLY)
const deadline = Date.now() + 30000
const timer = setInterval(() => {
	if (existsSync(process.env.MCP_EVIDENCE_TRIGGER)) {
		clearInterval(timer)
		process.stderr.write(process.env.MCP_EVIDENCE_LATE, () => {
			writeFileSync(process.env.MCP_EVIDENCE_DONE, 'done')
			process.exit(0)
		})
	} else if (Date.now() > deadline) {
		clearInterval(timer)
		process.exit(1)
	}
}, 20)
`

// The FIRST child under this command hands its `stderr` down to a detached descendant, reports that
// descendant's pid, and ends. The descendant inherits no stdout, so the readline reader can close
// on stdout end while the supervisor still drains stderr. Every later child reads the first child's
// claim file and stays alive writing nothing — a replacement lifetime respawns the same command,
// so without that branch the replacement would spawn a second descendant and write the same marker
// into ITS own tail, and a reading meant to report the superseded child would report the live one.
export const DESCENDANT_STDERR_SCRIPT = `
const { existsSync, writeFileSync } = require('node:fs')
const claim = process.env.MCP_EVIDENCE_CLAIM
if (existsSync(claim)) {
	setInterval(() => {}, 1000)
} else {
	writeFileSync(claim, 'claimed')
	const { spawn } = require('node:child_process')
	const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(DESCENDANT_SCRIPT)}], {
		detached: true,
		stdio: ['ignore', 'ignore', 'inherit'],
	})
	descendant.unref()
	process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'descendant', result: { pid: descendant.pid } }) + '\\n')
}
`

/** Configures the evidence child's stderr and exit. */
export interface EvidenceChildOptions {
	/** The exact bytes the child writes to its own `stderr`; it writes nothing when omitted. */
	readonly payload?: string
	/** The non-zero code the child ends with; it ends successfully when omitted. */
	readonly code?: number
	/** Whether the child stays alive and defers its write until a line arrives on its stdin. */
	readonly wait?: boolean
}

export function spawnEvidenceClient(options?: EvidenceChildOptions): StdioClientTransport {
	const environment: Record<string, string> = {}
	if (options?.payload !== undefined) environment['MCP_EVIDENCE_PAYLOAD'] = options.payload
	if (options?.code !== undefined) environment['MCP_EVIDENCE_CODE'] = String(options.code)
	if (options?.wait === true) environment['MCP_EVIDENCE_WAIT'] = 'true'
	return new StdioClientTransport({
		command: process.execPath,
		args: ['-e', EVIDENCE_SCRIPT],
		env: environment,
	})
}

/**
 * Creates the evidence child through a bare command name.
 *
 * `@orkestrel/process` resolves a bare command through the merged environment's `PATH` at each
 * spawn, so removing {@link EVIDENCE_DIRECTORY} from `process.env.PATH` between one lifetime and
 * the next makes that next one a spawn the host refuses. That is the only lifetime that ends
 * without starting a process, and therefore the only one whose end reliably lands INSIDE another
 * lifetime's teardown.
 */
export function spawnResolvedEvidenceClient(): StdioClientTransport {
	return new StdioClientTransport({
		command: EVIDENCE_EXECUTABLE,
		args: ['-e', EVIDENCE_SCRIPT],
		env: { MCP_EVIDENCE_PAYLOAD: EVIDENCE_SENTINEL, MCP_EVIDENCE_WAIT: 'true' },
	})
}

export function spawnHandledEvidenceClient(scratch: ScratchInterface): StdioClientTransport {
	return new StdioClientTransport({
		command: process.execPath,
		args: ['-e', HANDLED_SCRIPT],
		env: {
			MCP_EVIDENCE_PAYLOAD: EVIDENCE_SENTINEL,
			MCP_EVIDENCE_HANDLED: join(scratch.path, HANDLED_FILE),
		},
	})
}

export function spawnDescendantStderrClient(scratch: ScratchInterface): StdioClientTransport {
	return new StdioClientTransport({
		command: process.execPath,
		args: ['-e', DESCENDANT_STDERR_SCRIPT],
		env: {
			MCP_EVIDENCE_EARLY: DESCENDANT_EARLY,
			MCP_EVIDENCE_LATE: DESCENDANT_LATE,
			MCP_EVIDENCE_TRIGGER: join(scratch.path, TRIGGER_FILE),
			MCP_EVIDENCE_DONE: join(scratch.path, DONE_FILE),
			MCP_EVIDENCE_CLAIM: join(scratch.path, CLAIM_FILE),
		},
	})
}

/** Parks until the transport's `close` event has fired, so a tail read after it is complete. */
export function waitForStdioClose(
	transport: StdioClientTransport,
	description: string,
): Promise<readonly []> {
	return waitForEvent<readonly []>(
		(listener) => {
			transport.emitter.on('close', listener)
		},
		description,
		{ budget: 10_000 },
	)
}

/** Parks until the transport's live tail carries `text`, so the write is read rather than raced. */
export function waitForEvidence(transport: StdioClientTransport, text: string): Promise<void> {
	return waitForCondition(
		`the child stderr bytes ${text} reach the transport evidence`,
		() => transport.evidence?.includes(text) === true,
		{ budget: 10_000 },
	)
}

/** Reads the pid the descendant-spawning child reports on its one stdout line. */
export function readDescendantPid(message: JSONRPCMessage): number {
	if (!('result' in message) || !isRecord(message.result)) {
		throw new Error('The descendant report carries no result')
	}
	const value = message.result['pid']
	if (typeof value !== 'number') throw new Error('The descendant report carries no pid')
	return value
}

/**
 * Reads the tail across a bounded window and returns every distinct value.
 *
 * The window opens after the fact that would have moved the tail has already happened, so one
 * member is what a stable reading looks like and a second member names the drift.
 */
export async function collectEvidence(
	transport: StdioClientTransport,
): Promise<ReadonlyArray<string | undefined>> {
	const readings = new Set<string | undefined>()
	const opened = performance.now()
	while (performance.now() - opened < STABILITY_WINDOW) {
		readings.add(transport.evidence)
		await waitForDelay(10)
	}
	return [...readings]
}

export function createDeferredStream(completion: PromiseWithResolvers<void>): StreamInterface {
	const ended = new MCPFixtureCell(false)
	return {
		response: new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					await completion.promise
					controller.close()
				},
			}),
		),
		get closed() {
			return ended.value
		},
		write() {
			return true
		},
		comment() {},
		async drain() {},
		end() {
			ended.value = true
		},
	}
}

export interface ErrorPeerInterface {
	readonly base: string
	readonly requests: readonly JSONRPCInvocation[]
	held(path: string): Promise<void>
	release(path: string): void
	stop(): Promise<void>
}

export interface HeldResponse {
	readonly id: JSONRPCId
	readonly response: ServerResponse
}

export async function readHTTPInvocation(request: IncomingMessage): Promise<JSONRPCInvocation> {
	const chunks: string[] = []
	for await (const chunk of request) chunks.push(String(chunk))
	const parsed: unknown = JSON.parse(chunks.join(''))
	const message = parseJSONRPCMessage(parsed)
	if (message === undefined || !('method' in message)) {
		throw new Error('Expected an HTTP JSON-RPC invocation')
	}
	return message
}

export function sendHTTPResponse(
	response: ServerResponse,
	status: number,
	message?: JSONRPCMessage,
): void {
	response.writeHead(status, message === undefined ? {} : { 'content-type': 'application/json' })
	response.end(message === undefined ? undefined : JSON.stringify(message))
}

export async function startErrorPeer(): Promise<ErrorPeerInterface> {
	const requests: JSONRPCInvocation[] = []
	const responses = new Map<string, HeldResponse>()
	const idless = Promise.withResolvers<void>()
	const correlated = Promise.withResolvers<void>()
	const silent = Promise.withResolvers<void>()
	const server = createHTTPServer(async (request, response) => {
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
			sendHTTPResponse(response, 200, buildPeerDiscovery(message.id))
			return
		}
		if (request.url === '/silent') {
			if (message.method === 'server/discover') {
				responses.set('/silent', { id: message.id, response })
				silent.resolve()
				return
			}
			sendHTTPResponse(
				response,
				200,
				buildClientHandshakeResponse(message.id, MCP_HANDSHAKE_VERSION),
			)
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
			sendHTTPResponse(
				response,
				200,
				buildClientHandshakeResponse(message.id, MCP_HANDSHAKE_VERSION),
			)
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
			sendHTTPResponse(held.response, 200, buildPeerDiscovery(held.id))
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

export async function startWs(
	teardown: TeardownInterface,
	path?: string,
): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	server.upgrade(
		createWebSocketServer(createCalculatorServer(), {
			emitter: server.emitter,
			...(path === undefined ? {} : { path }),
		}),
	)
	const handle = await startServer(server)
	teardown.add(() => handle.stop())
	return handle
}

// Stand up a RAW `node:http` server that ANSWERS the upgrade with a structurally-valid 101
// (right `Upgrade` / `Connection` headers) but a BOGUS `Sec-WebSocket-Accept` — so the client's
// `start()` reaches the accept-validation branch and must reject on the mismatch (the security
// check is otherwise vacuously covered: the happy path never feeds a wrong accept). Returns the
// bound `http://…` base; tracked for `afterEach` close.
export async function startBogusAcceptServer(teardown: TeardownInterface): Promise<string> {
	const sockets: Duplex[] = []
	const server = createHTTPServer()
	teardown.add(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				if (!server.listening) resolve()
				else server.close(() => resolve())
			}),
	)
	server.on('upgrade', (_request, socket) => {
		sockets.push(socket) // captured so teardown can destroy this detached upgrade socket
		// The client `socket.destroy()`s its end on the accept mismatch, so this server end sees an
		// ECONNRESET — swallow it (an expected, non-fatal teardown), never an uncaught 'error'.
		socket.on('error', () => {})
		// A well-formed switching-protocols line + headers, but a deliberately WRONG accept value
		// (never `computeWebSocketAccept(key)`), so the handshake fails the accept check.
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				'Sec-WebSocket-Accept: wrong\r\n' +
				'\r\n',
		)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0
	return `http://127.0.0.1:${port}`
}

export interface HoldingPeerInterface {
	readonly base: string
	send(text: string): void
	stop(): Promise<void>
}

export async function startHoldingPeer(teardown: TeardownInterface): Promise<HoldingPeerInterface> {
	const sockets: Duplex[] = []
	const server = createHTTPServer()
	teardown.add(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				if (!server.listening) resolve()
				else server.close(() => resolve())
			}),
	)
	server.on('upgrade', (request, socket) => {
		const key = request.headers['sec-websocket-key']
		if (typeof key !== 'string') {
			socket.destroy()
			return
		}
		sockets.push(socket)
		// The client destroys its half on close, so this end reads an ECONNRESET — an expected
		// outcome of the path under test, never an uncaught 'error'.
		socket.on('error', () => {})
		socket.resume()
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				`Sec-WebSocket-Accept: ${computeWebSocketAccept(key)}\r\n\r\n`,
		)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0
	return {
		base: `http://127.0.0.1:${port}`,
		send(text: string): void {
			for (const socket of sockets) {
				socket.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, text))
			}
		},
		stop(): Promise<void> {
			return new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
			})
		},
	}
}

// A raw peer that answers the upgrade with a real `101` and an unmasked close frame in ONE
// write, so the close arrives in the handshake `head` the client hands `createNodeWebSocket`.
// The wrapper decodes that head inside its own constructor — before the transport has bound a
// single listener — so the socket the transport installs is already past OPEN and its `close`
// has already fired at nobody. That is the state where the transport's own flag knows nothing
// and the socket's `readyState` is the only source that does.
export async function startClosingPeer(teardown: TeardownInterface): Promise<string> {
	const sockets: Duplex[] = []
	const server = createHTTPServer()
	teardown.add(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				if (!server.listening) resolve()
				else server.close(() => resolve())
			}),
	)
	server.on('upgrade', (request, socket) => {
		const key = request.headers['sec-websocket-key']
		if (typeof key !== 'string') {
			socket.destroy()
			return
		}
		sockets.push(socket)
		// The client half-closes when it processes the close frame, so this end reads an end /
		// reset that is the expected outcome of the path under test, never an uncaught 'error'.
		socket.on('error', () => {})
		socket.resume()
		socket.write(
			Buffer.concat([
				Buffer.from(
					'HTTP/1.1 101 Switching Protocols\r\n' +
						'Upgrade: websocket\r\n' +
						'Connection: Upgrade\r\n' +
						`Sec-WebSocket-Accept: ${computeWebSocketAccept(key)}\r\n\r\n`,
				),
				encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, Buffer.alloc(0)),
			]),
		)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0
	return `http://127.0.0.1:${port}`
}

export const MCP_WEBSOCKET_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

// A masked client text frame carrying `value` as its JSON payload — the wire a real MCP
// WebSocket client writes (client→server frames MUST be masked, RFC 6455 §5.3).
export function encodeFixtureFrame(value: unknown): Buffer {
	return encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, JSON.stringify(value), { masked: true })
}

// Decode the JSON payloads of the server's text response frames the client read.
export function decodeFixtureFrames(
	frames: ReadonlyArray<{ readonly opcode: number; readonly payload: Buffer }>,
): readonly unknown[] {
	return frames
		.filter((frame) => frame.opcode === WEBSOCKET_OPCODE_TEXT)
		.map((frame) => JSON.parse(frame.payload.toString('utf-8')))
}

export function collectFixtureLines(output: PassThrough): {
	readonly lines: () => readonly string[]
} {
	const buffer = new MCPFixtureCell('')
	const lines: string[] = []
	output.on('data', (chunk: Buffer | string) => {
		buffer.value += chunk.toString()
		const parts = buffer.value.split('\n')
		buffer.value = parts[parts.length - 1] ?? ''
		for (const line of parts.slice(0, -1)) lines.push(line)
	})
	return { lines: () => lines }
}

// Server-test setup — node-only helpers, loaded after `setup.ts` for the node `guides`
// (and `src:server`) projects. `node:*` imports belong here, never in `setup.ts`.

/** Runs a legacy stdio peer that records EOF and either exits or keeps its timer alive. */
export const STDIO_CLOSE_SCRIPT = `
const { writeFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
const timer = setInterval(() => {}, 1000)
writeFileSync(process.env.MCP_CLOSE_PID, String(process.pid))
process.stdin.on('end', () => {
	writeFileSync(process.env.MCP_CLOSE_MARKER, 'ended')
	if (process.env.MCP_CLOSE_IGNORE !== 'true') setTimeout(() => {
		writeFileSync(process.env.MCP_CLOSE_MARKER, 'completed')
		clearInterval(timer)
	}, 100)
})
createInterface({ input: process.stdin }).on('line', (line) => {
	const message = JSON.parse(line)
	if (message.id === undefined) return
	const response = message.method === 'initialize'
		? { jsonrpc: '2.0', id: message.id, result: {
			protocolVersion: '2025-11-25', capabilities: {},
			serverInfo: { name: 'stdio-close-peer', version: '1.0.0' },
		} }
		: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
	process.stdout.write(JSON.stringify(response) + '\\n')
})
`

/** Emits split UTF-8, CRLF framing, and a final unterminated JSON-RPC response. */
export const STDIO_FRAME_SCRIPT = `
const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: '雪' } }) + '\\r\\n')
const boundary = bytes.indexOf(Buffer.from('雪')) + 1
process.stdout.write(bytes.subarray(0, boundary), () => {
	setTimeout(() => {
		process.stdout.write(bytes.subarray(boundary))
		process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { value: 'final' } }))
	}, 20)
})
`

/**
 * Finds the imports Guide surfaces from a projected fence that are absent from their exact public
 * face.
 *
 * The fence is read through Guide's own comment-aware source projection — `extractSourceLines`
 * replaces every comment and template span with aligned spaces and keeps quoted text verbatim —
 * and the projected text is then handed to `extractFenceImports`. What this helper owns is a boundary,
 * not a grammar: every statement `extractFenceImports` surfaces is checked, and nothing else is. A
 * mapped specifier's named bindings compare against that Source's barrel surface; an unmapped
 * true subpath of `root` and a repository alias (`@src/*`, `@app/*`) are refused, the latter
 * because a public guide example must import through a published specifier; a similarly
 * prefixed sibling package stays external.
 *
 * The membership rule is therefore `extractFenceImports`'s own grammar rather than "named-brace
 * imports", and that grammar is one sentence, read literally rather than paraphrased: the letters
 * `import`, at least one whitespace character, optionally `type` followed by at least one further
 * whitespace character, then `{`, a body containing no `}`, a closing `}`, optional whitespace,
 * `from`, optional whitespace again, and a quoted specifier. That sentence is the rule. Every list
 * of forms below is an illustration of it and never a closed catalogue — the sentence, not the
 * list, decides a form nobody thought to enumerate.
 *
 * The set the sentence matches therefore *overlaps* the braces a reader would call named imports
 * rather than sitting inside them. It misses some, among them a mixed default-and-named import
 * (`import MCPServer, { createMCPRoutes } from …`), a `type` import whose `type` carries no
 * trailing whitespace (`import type{X}from'…'`), a brace with no whitespace after `import`, a
 * dynamic `import()`, and the namespace, default, side-effect, and `export … from` statements
 * that carry no brace at all; each of those is checked against no face and refused by nothing.
 * And because `import` carries no word boundary, the sentence also admits text that is no import
 * at all: an ordinary string whose payload reads `…reimport { X } from '@src/core'` satisfies
 * every clause, so it is checked like any other statement and its alias specifier throws.
 *
 * The mixed form is an upstream limit and not a choice made here: those named bindings are
 * exactly what `extractFenceImports` exists to surface, and it does not surface them, so a guide example
 * written that way against `@src/*` passes unremarked. No fence in `guides/` uses it, so the gap
 * is recorded rather than closed — closing it here would mean a second import reader beside
 * Guide's, which the roadmap forbids. The parity suite's `records example import forms no refusal
 * reaches` row pins examples of the forms named above; it is not the whole of what the sentence
 * leaves out.
 *
 * @remarks
 * Projecting first moves that boundary in both directions relative to reading the fence
 * verbatim, and which exact trivia positions move it is Guide's business rather than this
 * helper's. The parity suite pins them in fences rather than asserting them as universals here:
 * the raw-versus-projected comparison lives in one row, and the projected-side single-line,
 * multiline, and alias controls live in their own rows, so a Guide upgrade surfaces in whichever
 * of them it touches instead of quietly changing what this check covers. In outline: comment
 * trivia around a named binding no longer costs the binding, while aliases still reduce to the
 * original exported name and `type` prefixes still strip. An `import` written inside a comment or
 * a template literal is masked to spaces and is checked against no face, so a commented-out or
 * backtick-quoted example is exempt; one written inside an ordinary `'…'` or `"…"` string is kept
 * verbatim and still enters the check. The projection is lexical rather than a TypeScript parse,
 * and inherits Guide's documented limit that a slash after a bare `}` reads as division: a fence
 * whose slash-leading statement follows a semicolonless declaration needs an explicit `;`, or the
 * rest of that fence — real imports included — is read as comment payload and disappears from
 * this check.
 *
 * @param fence - The TypeScript fence body
 * @param sources - Exact public package specifiers mapped to their Source projections
 * @param root - The true self-package root specifier
 * @returns A frozen list of missing named imports
 * @throws When a statement `extractFenceImports` surfaces from the projected fence uses an unmapped root
 *   or true self-package subpath, or a repository alias specifier. Nothing outside the grammar
 *   sentence above reaches either refusal; a statement satisfying it enters the check — including
 *   text that is not an import — where a mapped specifier is compared against its face and an
 *   unmapped foreign one against none, and it reaches a refusal only when its specifier is an
 *   unmapped self specifier or a repository alias.
 *
 * @example
 * ```ts
 * findMissingNamedImports("import { X } from '@scope/pkg'", sources, '@scope/pkg')
 * ```
 */
export function findMissingNamedImports(
	fence: string,
	sources: ReadonlyMap<string, SourceInterface>,
	root: string,
): readonly string[] {
	const missing: string[] = []
	const projected = extractSourceLines(fence)
		.map((line) => line.code)
		.join('\n')
	for (const { specifier, names } of extractFenceImports(projected)) {
		const source = sources.get(specifier)
		if (source === undefined) {
			if (specifier === root || specifier.startsWith(`${root}/`)) {
				throw new Error(`Unmapped self specifier: ${specifier}`)
			}
			if (specifier.startsWith('@src/') || specifier.startsWith('@app/')) {
				throw new Error(`Repository alias specifier: ${specifier}`)
			}
			continue
		}
		missing.push(
			...findMissing(
				names,
				source.surface().map((symbol) => symbol.name),
			),
		)
	}
	return Object.freeze(missing)
}

// ── HTTP request stub (the boundary-narrowing pattern) ───────────────────────
//
// the minimal `IncomingMessage` stub the pure node-only http readers build
// on — only the fields a reader touches (`url` / `method` / `headers` / `socket`),
// crossed into the parameter through a structural guard (never an `as`).

/**
 * Narrows an `unknown` stub structurally to {@link
 * import('node:http').IncomingMessage} — the readers only read `url` / `method` /
 * `headers` (and, for the peer IP, `socket`), so a partial shape carrying `headers`
 * crosses the boundary through this guard with no assertion.
 *
 * @param value - The candidate stub
 * @returns Whether `value` is shaped enough to stand in for an `IncomingMessage`
 */
export function isIncomingMessage(value: unknown): value is IncomingMessage {
	return typeof value === 'object' && value !== null && 'headers' in value
}

/**
 * Builds a minimal `node:http`-shaped request stub for the pure request readers — only the
 * fields each reader touches, defaulting `headers` / `socket` to empty
 * so `upgradeRequestPath` and a peer-IP read both have something to read. Crosses into
 * the `IncomingMessage` parameter through {@link isIncomingMessage} (no `as`).
 *
 * @param fields - The request fields to set (`url` / `method` / `headers` / `socket`);
 *   each omitted field falls back to a sensible empty default
 * @returns The narrowed `IncomingMessage` stub
 */
export function createRequestStub(fields?: {
	url?: string
	method?: string
	headers?: Record<string, string | string[] | undefined>
	socket?: { remoteAddress?: string; encrypted?: boolean }
}): IncomingMessage {
	const stub: unknown = {
		url: fields?.url,
		method: fields?.method,
		headers: fields?.headers ?? {},
		socket: fields?.socket ?? {},
	}
	if (!isIncomingMessage(stub)) throw new Error('unreachable: request stub shape')
	return stub
}

// ── Fault-injectable SSE stream (a REAL StreamInterface, not a mock) ─────────
//
// `createStream` is the real seam and is used wherever the happy path is the claim. The
// terminals it cannot be driven into from outside are exactly the ones the ownership and
// disconnect rows are about: a `write` that throws mid-stream, and a response body that
// raises while it is being forwarded. This is a minimal real implementation of the same
// interface with those faults as data (an inert, customizable stub).

/** Selects which fault a {@link createStreamStub} stream raises, if any. */
export interface TestStreamOptions {
	/** Thrown by `write` on every event. */
	readonly write?: Error
	/** Raised by the response body on its first read. */
	readonly body?: Error
	/**
	 * A response body that never settles — a held-open exchange nobody has completed.
	 *
	 * @remarks
	 * The default body closes on its first read, which releases any bridge reading it. Set this
	 * to keep a consumer parked indefinitely, so what the bridge does WHILE it waits — its
	 * keepalive timer above all — is observable instead of already torn down.
	 */
	readonly pending?: boolean
}

/** Reports what was written to a real {@link StreamInterface} and whether it ended. */
export interface TestStreamInterface extends StreamInterface {
	/** Each event's `data`, in write order. */
	readonly events: readonly string[]
	/** Each comment's text, in write order (the keepalive record). */
	readonly comments: readonly string[]
	/** Whether `end()` has been called. */
	readonly ended: boolean
}

/**
 * Builds a real SSE {@link StreamInterface} whose write or body fault is supplied as data.
 *
 * @param options - The fault to raise or the `pending` body; omit for an inert recording stream
 * @returns The stream, plus the events and comments it accepted and whether it ended
 *
 * @example
 * ```ts
 * const sse = createStreamStub({ write: new Error('socket gone') })
 * await sendEventStream(stream, sse) // total: the fault never escapes
 * ```
 */
export function createStreamStub(options?: TestStreamOptions): TestStreamInterface {
	const events: string[] = []
	const comments: string[] = []
	const failure = options?.body
	const ended = new MCPFixtureCell(false)
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (failure !== undefined) controller.error(failure)
			else if (options?.pending !== true) controller.close()
			// A `pending` body returns without settling the controller, so the reader parks.
		},
	})
	const response = new Response(body, { status: 200 })
	return {
		response,
		get closed() {
			return ended.value
		},
		get events() {
			return events
		},
		get comments() {
			return comments
		},
		get ended() {
			return ended.value
		},
		write(message) {
			if (options?.write !== undefined) throw options.write
			events.push(message.data)
			return true
		},
		comment(text) {
			comments.push(text)
		},
		async drain() {},
		end() {
			ended.value = true
		},
	}
}

// ── In-memory WebSocket Duplex pair (the RFC 6455 wire + transport tests) ────
//
// the cross-wired in-memory `node:stream` Duplex PAIR the WebSocket
// transport tests drive — a REAL bidirectional socket (two PassThroughs, one per
// direction), NOT a mock. `duplexPair` makes a `[server, client]`; `flushSocket`
// waits for synchronous frame writes to propagate across the pair; `readClientFrames`
// is the inverse of what a server writes (strip the 101 handshake, then decode every
// complete frame off the running buffer).

// One endpoint of a cross-wired in-memory socket pair: a real `Duplex` whose writes
// forward into the partner's inbound `PassThrough` and whose reads drain its OWN
// inbound one. Two of these, sharing each other's channel, form a genuine bidirectional
// stream — bytes written to one arrive as `data` on the other — exercising real Node
// stream I/O without a socket or a mock. Module-private (the runtime-
// self-contained analogue: a test-only stream shim with no standalone reuse beyond
// `duplexPair`); the pair factory is the surface.
export class DuplexEnd extends Duplex {
	readonly #inbound: PassThrough
	readonly #outbound: PassThrough

	constructor(inbound: PassThrough, outbound: PassThrough) {
		super()
		this.#inbound = inbound
		this.#outbound = outbound
		this.#inbound.on('data', (chunk: Buffer) => {
			this.push(chunk)
		})
		this.#inbound.on('end', () => {
			this.push(null)
		})
	}

	override _read(): void {
		// Flow is push-driven by the inbound 'data' listener above; nothing to pull.
	}

	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error) => void,
	): void {
		this.#outbound.write(chunk)
		callback()
	}
}

/**
 * Creates a cross-wired in-memory `node:stream` Duplex PAIR — a real bidirectional
 * socket for the WebSocket transport tests. The server end gets `[0]`,
 * the client end `[1]`, sharing two `PassThrough` channels (one per direction); bytes
 * written to one arrive as `data` on the other. No socket, no mock — genuine Node
 * stream I/O.
 *
 * @returns The `[server, client]` Duplex pair
 */
export function duplexPair(): readonly [Duplex, Duplex] {
	const toServer = new PassThrough()
	const toClient = new PassThrough()
	const server = new DuplexEnd(toServer, toClient)
	const peer = new DuplexEnd(toClient, toServer)
	server.on('error', () => {})
	peer.on('error', () => {})
	return [server, peer]
}

/**
 * Resolves on the socket pair's next tick or two — long enough for synchronous frame
 * writes to propagate through the {@link duplexPair} PassThroughs.
 * Deterministic (no real timer dependence on load), so a WebSocket test awaits it after
 * a `send` rather than polling.
 *
 * @returns A promise resolving after two `setImmediate` ticks
 */
export function flushSocket(): Promise<void> {
	return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

/**
 * Collects a {@link duplexPair} client end's incoming frames — FIRST stripping the
 * server's HTTP `101` handshake response (the leading text up to `\r\n\r\n`), THEN
 * decoding every complete frame off the running buffer with `@orkestrel/websocket`'s
 * `parseWebSocketFrame`. The real client reader: the inverse of what a
 * server-mode wrapper writes (handshake then frames). The returned `frames` array grows
 * as the server sends.
 *
 * @param peer - The client end of a {@link duplexPair}
 * @returns A handle whose `frames` accumulates each decoded {@link WebSocketFrame}
 */
export function readClientFrames(peer: Duplex): { readonly frames: readonly WebSocketFrame[] } {
	const frames: WebSocketFrame[] = []
	const buffer = new MCPFixtureCell<Buffer>(Buffer.alloc(0))
	const handshook = new MCPFixtureCell(false)
	const end = Buffer.from('\r\n\r\n')
	peer.on('data', (chunk: Buffer) => {
		buffer.value = Buffer.concat([buffer.value, chunk])
		if (!handshook.value) {
			const index = buffer.value.indexOf(end)
			if (index === -1) return // handshake not fully arrived yet
			buffer.value = buffer.value.subarray(index + end.length)
			handshook.value = true
		}
		for (;;) {
			const frame = parseWebSocketFrame(buffer.value)
			if (frame === undefined) break
			buffer.value = buffer.value.subarray(frame.consumed)
			frames.push(frame)
		}
	})
	return { frames }
}

/** Holds a raw client socket open against a real server's WebSocket endpoint. */
export interface ClientSocketInterface {
	/** Every frame the server has sent since the `101`, decoded as it arrives. */
	readonly frames: readonly WebSocketFrame[]
	/** Resolves when the client end is fully closed (after its last `data` event). */
	readonly closed: Promise<void>
	/** Destroy the client end — the peer that goes away without a close frame. */
	close(): void
}

/**
 * Opens a raw RFC 6455 client socket against a real server and decodes what it sends back —
 * a genuine TCP peer, no wrapper and no mock.
 *
 * @remarks
 * Connects to `base`, writes a valid upgrade `GET` for `path`, and resolves once the
 * server's handshake response arrives, so the caller knows the socket is CLAIMED before it
 * acts. {@link readClientFrames} strips that handshake and decodes every later frame, which
 * is what makes a server-side protocol close (an opcode-`8` frame) distinguishable from a
 * socket destroy (no frame at all). `closed` resolves on the socket's `close` event, after
 * node has dispatched every `data` event, so an assertion over `frames` never races the wire.
 *
 * @param base - The server's bound base URL (for example `http://127.0.0.1:<port>`)
 * @param path - The endpoint path to upgrade (for example `/mcp`)
 * @returns The connected {@link ClientSocketInterface}
 */
export async function openClientSocket(base: string, path: string): Promise<ClientSocketInterface> {
	const url = new URL(base)
	const socket = connect(Number(url.port), url.hostname)
	socket.on('error', () => {}) // a server-side destroy is an expected end here, never fatal
	await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
	const reader = readClientFrames(socket)
	const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
	const handshake = new Promise<void>((resolve) => socket.once('data', () => resolve()))
	socket.write(
		`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
			`Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
			`Sec-WebSocket-Protocol: mcp\r\n\r\n`,
	)
	await handshake
	return {
		get frames() {
			return reader.frames
		},
		closed,
		close: () => socket.destroy(),
	}
}

// ── HTTP spine test harness (node-only, real `@orkestrel/server`) ────────────
//
// the started-server fixture the MCP HTTP tests share lives here, not
// duplicated per file. Each test starts a REAL server on an ephemeral port and drives
// it with the global `fetch` over a real socket — no mocking. The returned handle
// carries the bound base URL plus a `stop` thunk every test calls in `afterEach` so no
// listener leaks across files.

/** Pairs a started test server's bound `base` URL with its `ServerInterface`. */
export interface StartedServerInterface<TState = unknown> {
	readonly server: ServerInterface<TState>
	readonly port: number
	readonly base: string
	stop(): Promise<void>
}

/**
 * Starts a `ServerInterface` on an ephemeral port and resolves its bound base URL — the
 * shared harness for the real-`@orkestrel/server` MCP spine tests.
 *
 * @remarks
 * Awaits `server.start()` (binding `127.0.0.1:<ephemeral>`) and returns the handle. Call
 * `stop()` in `afterEach` (it gracefully stops then `destroy`s, so a wedged drain still
 * tears the socket down — no leaked listener hangs the runner).
 *
 * @param server - The server to start (already configured with routes / middleware)
 * @returns The started-server handle (`base` URL + `stop`)
 */
export async function startServer<TState>(
	server: ServerInterface<TState>,
): Promise<StartedServerInterface<TState>> {
	const port = await server.start()
	return {
		server,
		port,
		base: `http://127.0.0.1:${port}`,
		async stop() {
			await server.stop()
			await server.destroy()
		},
	}
}

/**
 * Names a test resource released through {@link closeResource}: a started server, an MCP client, or a
 * bare client transport driven without one.
 */
export type TestResource =
	| StartedServerInterface
	| MCPClientInterface
	| MCPMessageTransportInterface

/**
 * Releases one {@link TestResource} from a suite that opens clients as well as servers.
 *
 * @remarks
 * Each member is identified by the one release method it declares (`stop` / `disconnect` /
 * `close`), so the check is a structural narrowing rather than an assertion. Every
 * one of them is idempotent, so a test that already released its client inline — the
 * disconnect being the CLAIM there rather than cleanup — tears down exactly once and the
 * second call returns immediately.
 *
 * @param resource - The started server, MCP client, or client transport to release
 * @returns Resolves once the resource is released
 *
 * @example
 * ```ts
 * const transport = createNodeWebSocketClientTransport(options)
 * const client = createMCPClient({ transport })
 * await closeResource(client)
 * ```
 */
export function closeResource(resource: TestResource): Promise<void> {
	if ('stop' in resource) return resource.stop()
	if ('disconnect' in resource) return resource.disconnect()
	return resource.close()
}

// ── Raw HTTP upgrade driver (the WebSocket transport's upgrade seam) ─────────
//
// the `Server.upgrade(...)` seam tests drive a REAL `node:http` protocol
// upgrade — a client request with `Connection: Upgrade` + `Upgrade: websocket` headers
// — and observe whether the server CLAIMED the socket (it answered `101` and the
// client's `'upgrade'` event fired) or DECLINED it. A real socket exchange, no mock.

/** Reports the outcome of an {@link upgradeRequest} — whether the server claimed the upgrade. */
export interface UpgradeOutcome {
	/** `true` when the server answered `101 Switching Protocols` (a handler claimed the socket). */
	readonly claimed: boolean
	/** The `101` status when claimed, else `undefined` (the socket was destroyed un-upgraded). */
	readonly status: number | undefined
	/** The subprotocol the server selected, or `undefined` when it selected none. */
	readonly protocol: string | undefined
}

/**
 * Drives a real `node:http` protocol upgrade against `base` + `path` and resolves the
 * {@link UpgradeOutcome} — the shared upgrade-seam driver.
 *
 * @remarks
 * Sends `Connection: Upgrade` + `Upgrade: websocket` (plus any extra `headers`) and
 * waits for the exchange to settle. If a registered handler CLAIMS the socket and
 * answers `101`, the client's `'upgrade'` event fires → `{ claimed: true, status: 101
 * }` (the client socket is destroyed to free it). If NO handler claims it, the spine
 * destroys the un-upgraded connection, so the client request emits `'error'` (or the
 * socket closes) → `{ claimed: false }`. It is TOTAL — the declined path is an expected
 * outcome, never a rejection.
 *
 * @param base - The server's bound base URL (for example `http://127.0.0.1:<port>`)
 * @param path - The request path to upgrade (defaults to `'/'`)
 * @param headers - Extra request headers merged over the upgrade headers
 * @returns The {@link UpgradeOutcome}
 */
export function upgradeRequest(
	base: string,
	path = '/',
	headers?: Record<string, string>,
): Promise<UpgradeOutcome> {
	return new Promise<UpgradeOutcome>((resolve) => {
		const request = httpRequest(`${base}${path}`, {
			headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
		})
		// The server claimed it: it sent `101` and the socket is now the handler's. Read
		// nothing — free the client end and report the claim.
		request.on('upgrade', (response, socket) => {
			socket.destroy()
			const protocol = response.headers['sec-websocket-protocol']
			resolve({
				claimed: true,
				status: response.statusCode,
				protocol: typeof protocol === 'string' ? protocol : undefined,
			})
		})
		// The server declined: it destroyed the un-upgraded socket, so the request errors
		// (a socket hang-up) — an expected, non-fatal outcome of the decline path.
		request.on('error', () => resolve({ claimed: false, status: undefined, protocol: undefined }))
		// A plain (non-101) response would also mean no upgrade happened.
		request.on('response', (response) => {
			response.resume()
			resolve({ claimed: false, status: response.statusCode, protocol: undefined })
		})
		request.end()
	})
}

// ── Clock time that passes INSIDE a live request ─────────────────────────────
//
// A claim that a timestamp is "the instant of the LAST access" is only falsifiable when
// clock time passes WHILE a request is in flight: a fixture whose handlers are all
// instantaneous cannot tell "re-read after the await" from "read at request start". This
// middleware is that seam. Composed BEHIND the middleware under test, it advances the
// INJECTED manual clock before delegating, so the layer in front really does suspend
// across a measurable span. The host clock is never replaced.

/**
 * Creates a middleware that advances a manual clock before delegating downstream.
 *
 * @typeParam TState - The consumer's route state type
 * @param clock - The manual clock this request consumes time from
 * @param ms - The milliseconds of clock time every handled request consumes
 * @returns A `MiddlewareHandler` that elapses `ms` inside each request it handles
 *
 * @example
 * ```ts
 * server.use(createMCPSession({ ttl: 50, clock: clock.now }))
 * server.use(createClockMiddleware(clock, 60)) // every request outlasts the ttl
 * ```
 */
export function createClockMiddleware<TState>(
	clock: ManualClockInterface,
	ms: number,
): MiddlewareHandler<TState> {
	return (_request, _context, next) => {
		clock.advance(ms)
		return next()
	}
}

/**
 * Creates a middleware that holds every request open for `ms` of REAL time before delegating.
 *
 * @remarks
 * The seam for interleaving: while one request is parked here, the middleware in front of it
 * is genuinely suspended, so a second request can reach the same state and the test can pin
 * which of the two wins. A short real delay, never a replaced clock.
 *
 * @typeParam TState - The consumer's route state type
 * @param ms - How long each request is held before it continues downstream
 * @returns A `MiddlewareHandler` that parks each request it handles
 */
export function createDelayMiddleware<TState>(ms: number): MiddlewareHandler<TState> {
	return async (_request, _context, next) => {
		await waitForDelay(ms)
		return next()
	}
}

// ── Raw WebSocket handshake recorder (the client transport's D2 seam) ────────
//
// The WebSocket CLIENT transport suspends `start()` across a real TCP connect and HTTP
// upgrade, so every claim about what it does with an ARRIVING socket needs a peer that
// can hold the handshake open and then report what became of each socket it upgraded.
// `createWebSocketServer` is a whole MCP server and reports neither, so this is a
// protocol-faithful fixture instead: it writes a REAL RFC 6455 `101` with a
// correctly computed `Sec-WebSocket-Accept`, optionally after a delay and optionally with
// one unmasked text frame appended, and it counts the sockets it upgraded against the
// sockets that are still open.

/** Counts a raw upgrade peer's sockets — how many it accepted, and how many are still open. */
export interface TestUpgradeInterface {
	/** The bound `http://…` base URL. */
	readonly base: string
	/** How many upgrades this peer answered with a `101`. */
	readonly count: number
	/** How many of those sockets are still open (an orphan never reaches zero). */
	readonly open: number
	stop(): Promise<void>
}

/** Decides how a {@link startUpgradeServer} peer answers each upgrade. */
export interface TestUpgradeOptions {
	/** Milliseconds the handshake is held open before the `101` is written. */
	readonly delay?: number
	/** A text frame written together with the handshake, so a bound socket re-emits it. */
	readonly frame?: string
}

/**
 * Starts a raw `node:http` peer that completes real WebSocket handshakes and records them.
 *
 * @remarks
 * Each upgrade is answered with a structurally valid `101` whose `Sec-WebSocket-Accept` is
 * the real {@link computeWebSocketAccept} of the client's key, so the client's own accept
 * validation passes and the socket becomes a live WebSocket. `delay` holds the handshake
 * open long enough for a caller to act while `start()` is still suspended; `frame` appends
 * one unmasked text frame to the same write, so a socket the client BOUND re-emits it and a
 * socket the client destroyed does not. `count` and `open` are read after the fact: an
 * upgraded socket the client never closes keeps `open` above zero forever, which is exactly
 * what an orphan is.
 *
 * @param options - Optional handshake `delay` and trailing `frame`; see {@link TestUpgradeOptions}
 * @returns The bound peer plus its upgrade tallies
 *
 * @example
 * ```ts
 * const peer = await startUpgradeServer({ delay: 30 })
 * const transport = createNodeWebSocketClientTransport({ url: `${peer.base}/mcp` })
 * ```
 */
export async function startUpgradeServer(
	options?: TestUpgradeOptions,
): Promise<TestUpgradeInterface> {
	const server: Server = createHTTPServer()
	const sockets: Duplex[] = []
	const count = new MCPFixtureCell(0)
	const closed = new MCPFixtureCell(0)
	server.on('upgrade', (request, socket) => {
		const key = request.headers['sec-websocket-key']
		if (typeof key !== 'string') {
			socket.destroy()
			return
		}
		sockets.push(socket)
		count.value += 1
		// A client that destroys its half leaves this end reading an ECONNRESET — an expected
		// outcome of the very path under test, never an uncaught 'error'.
		socket.on('error', () => {})
		socket.on('close', () => {
			closed.value += 1
		})
		// An upgraded socket nobody reads stays PAUSED, and a paused socket never emits 'end', so
		// the peer would never observe a client that closed or destroyed its half. Reading (and
		// discarding) is what makes "still open" a fact about the connection rather than about
		// this fixture's back pressure. A peer that half-closes gets its connection torn down,
		// the way a real WebSocket server answers a close — so a socket that stays open is one
		// NOBODY closed, which is the only thing an orphan can be.
		socket.resume()
		socket.on('end', () => socket.destroy())
		const handshake = Buffer.from(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				`Sec-WebSocket-Accept: ${computeWebSocketAccept(key)}\r\n\r\n`,
		)
		const frame = options?.frame
		// One write, so the handshake and the frame reach the client together: whether the
		// bytes land in the upgrade `head` or in a later 'data' event is the kernel's choice,
		// and a bound socket must re-emit the frame either way.
		const payload =
			frame === undefined
				? handshake
				: Buffer.concat([handshake, encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, frame)])
		if (options?.delay === undefined) socket.write(payload)
		else setTimeout(() => socket.write(payload), options.delay)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0
	return {
		base: `http://127.0.0.1:${port}`,
		get count() {
			return count.value
		},
		get open() {
			return count.value - closed.value
		},
		stop() {
			return new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
			})
		},
	}
}

// The live-service harness for `@modelcontextprotocol/conformance` — the real foreign
// client that drives this package's server over a real socket (live services).
//
// This file exists as TYPESCRIPT for one reason. The fixture below is the host half of
// every port `MCPServerOptions` publishes, so it is typed against the real exported
// interfaces: rename a port accessor and `npm run check` fails at compile time instead of
// twenty minutes later inside a foreign runner's summary. The same fixture as untyped
// JavaScript enforced nothing, and a public rename once took the suite 23/0 → 16/7 with
// every gate green.
//
// The ports are backed by PLAIN OBJECTS and no `@orkestrel/workspace`. That is the claim:
// no adapter is privileged, and what backs a port is the host's decision.

// ── The pinned runner ────────────────────────────────────────────────────────

/** Names the conformance runner package, pinned as a development dependency and resolved from disk. */
export const CONFORMANCE_PACKAGE = '@modelcontextprotocol/conformance'

/** Names the runner's entry module inside its installed package. */
export const CONFORMANCE_ENTRY = `${CONFORMANCE_PACKAGE}/dist/index.js`

/** Names the dated protocol revision the runner drives the server at. */
export const CONFORMANCE_SPEC = '2026-07-28'

/** Supplies the identity the fixture server answers `initialize` with. */
export const CONFORMANCE_IDENTITY = Object.freeze({
	name: 'orkestrel-conformance',
	version: '0.0.9',
})

/** Matches one `✓ <scenario>: N passed, M failed` line in the runner's summary block. */
export const CONFORMANCE_TALLY = /^\S+ ([a-z0-9-]+): (\d+) passed, (\d+) failed$/

/** Matches the runner's closing `Total: N passed, M failed` line. */
export const CONFORMANCE_TOTAL = /^Total: (\d+) passed, (\d+) failed$/

/** Names the scenario-name prefix marking the runner's OAuth family. */
export const CONFORMANCE_AUTH = 'auth/'

/** Matches the `list` heading that opens the runner's client-scenario section. */
export const CONFORMANCE_CLIENTS = /^Client scenarios/

/** Matches one `  - <scenario> [<revisions>]` entry inside a `list` section. */
export const CONFORMANCE_LISTED = /^ {2}- (\S+) \[/

/**
 * Lists every client scenario the runner's own `list` reports as applicable at
 * {@link CONFORMANCE_SPEC}, except the {@link CONFORMANCE_AUTH} family.
 *
 * @remarks
 * The `auth/*` scenarios are EXCLUDED on purpose: each one drives an OAuth 2.1 client
 * through discovery, dynamic registration, and a token grant, and this package ships no
 * OAuth client at all. `createHTTPClientTransport` takes a `headers` record, so a consumer
 * supplies its own bearer; the authorization flow that mints one is outside this package.
 * Running those scenarios would measure a client this package does not publish.
 *
 * The set is written down rather than derived so the exclusion is a decision on the record.
 * `tests/conformance.test.ts` compares it against what {@link parseConformanceClients} reads
 * back from the runner, so a scenario the runner adds fails that comparison instead of
 * disappearing from the run.
 */
export const CONFORMANCE_CLIENT_SCENARIOS: readonly string[] = Object.freeze([
	'tools_call',
	'request-metadata',
	'sep-2322-client-request-state',
	'http-standard-headers',
	'http-custom-headers',
	'http-invalid-tool-headers',
	'json-schema-ref-no-deref',
	'json-schema-2020-12-preservation',
])

/** Matches the runner's per-scenario `Passed: N/D, M failed, W warnings` result line in client mode. */
export const CONFORMANCE_OUTCOME = /^Passed: (\d+)\/\d+, (\d+) failed, (\d+) warnings$/

// ── The runner's reported shape ──────────────────────────────────────────────

/** Describes one conformance scenario's tally, exactly as the runner's summary reports it. */
export interface ConformanceScenario {
	/** The scenario identifier, such as `dns-rebinding-protection`. */
	readonly name: string
	/** Checks the scenario passed. */
	readonly passed: number
	/** Checks the scenario failed. */
	readonly failed: number
}

/**
 * Describes one client scenario's outcome, exactly as the runner's per-scenario result block reports it.
 *
 * @remarks
 * `warnings` has no counterpart in {@link ConformanceScenario} because the two modes report
 * differently. The server-mode summary collapses each scenario to passed and failed, so a
 * `SHOULD`-level check that reported WARNING is invisible there and shows up only as a row
 * tallying neither. Client mode prints the warning count beside them, so this shape keeps it:
 * the runner treats a warning as an overall failure, and a baseline that dropped the count
 * would hide a check moving between WARNING and SUCCESS.
 */
export interface ConformanceOutcome {
	/** The scenario identifier, such as `http-standard-headers`. */
	readonly name: string
	/** Checks the scenario passed. */
	readonly passed: number
	/** Checks the scenario failed. */
	readonly failed: number
	/** Checks the scenario reported at `SHOULD` level. */
	readonly warnings: number
}

/** Describes the parsed outcome of one whole conformance run. */
export interface ConformanceResult {
	/** Every scenario tally in the order the runner reported it. */
	readonly scenarios: readonly ConformanceScenario[]
	/** The runner's own total of passed checks. */
	readonly passed: number
	/** The runner's own total of failed checks. */
	readonly failed: number
}

/** Describes one direct comparison with the vendored Tasks extension schema. */
export interface TaskSchemaRow {
	/** The schema coordinate the row proves. */
	readonly symbol: string
	/** The package's pinned projection of the coordinate. */
	readonly expected: string
	/** The projection read from the vendored schema. */
	readonly model: string
}

/** Pins the raw Tasks extension schema bytes used by this suite. */
export const TASK_SCHEMA_DIGEST = 'bf30afb7ac251e3e22c037b7a685f60ef6603031b5484c0d08b1fa0bbe86d460'

/** Pins the identifier declared by the Tasks extension schema. */
export const TASK_SCHEMA_ID = 'https://modelcontextprotocol.io/ext-tasks/2026-07-28/schema.json'

/** Resolves the vendored Tasks extension schema mirror. */
export const TASK_SCHEMA_PATH = fileURLToPath(
	new URL('./mirrors/ext-tasks-2026-07-28-schema.json', import.meta.url),
)

/** Supplies the JSON Schema spelling of an integer millisecond value in the Tasks extension. */
export const TASK_INTEGER_SCHEMA = Object.freeze({
	type: 'integer',
	minimum: -9007199254740991,
	maximum: 9007199254740991,
})

/** Lists the properties every task variant shares. */
export const TASK_PROPERTIES: readonly string[] = [
	'taskId',
	'status',
	'statusMessage',
	'createdAt',
	'lastUpdatedAt',
	'ttlMs',
	'pollIntervalMs',
]

/** Lists the properties every task owes. */
export const TASK_REQUIRED: readonly string[] = [
	'taskId',
	'status',
	'createdAt',
	'lastUpdatedAt',
	'ttlMs',
]

/** Formats an authority value for a direct conformance comparison. */
export function formatConformanceValue(value: unknown): string {
	if (value === undefined) return 'undefined'
	if (typeof value === 'string') return value
	const outcome = attempt(() => JSON.stringify(value))
	const serialized = outcome.success ? outcome.value : undefined
	return serialized === undefined ? String(value) : serialized
}

/** Formats a direct schema-drift message. */
export function formatConformanceDrift(symbol: string, authority: string, value: unknown): string {
	return `${symbol} drifted; ${authority}=${formatConformanceValue(value)}`
}

/** Reports a drift message when a direct comparison differs. */
export function readConformanceDrift(
	symbol: string,
	local: unknown,
	authority: string,
	value: unknown,
): string | undefined {
	return Object.is(local, value) ? undefined : formatConformanceDrift(symbol, authority, value)
}

/** Computes the SHA-256 digest of a file's raw bytes. */
export function readFileDigest(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Reads one nested schema value without assuming its shape. */
export function readSchemaPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
	return path.reduce<unknown>((value, segment) => {
		if (Array.isArray(value)) return typeof segment === 'number' ? value[segment] : undefined
		return isRecord(value) && typeof segment === 'string' ? Reflect.get(value, segment) : undefined
	}, root)
}

/** Loads the digest-pinned Tasks extension schema. */
export function readTaskSchema(path: string, digest: string = TASK_SCHEMA_DIGEST): unknown {
	const actual = readFileDigest(path)
	if (actual !== digest) {
		throw new Error(formatConformanceDrift('Tasks schema bytes', 'SHA-256', digest))
	}
	const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
	if (!isRecord(parsed)) throw new Error('The Tasks extension schema root is not a record')
	return parsed
}

/** Holds the parsed Tasks extension schema used to construct each comparison row. */
export const TASK_SCHEMA = readTaskSchema(TASK_SCHEMA_PATH)

/** Builds one row from a direct schema path. */
export function createTaskSchemaRow(
	symbol: string,
	expected: unknown,
	path: ReadonlyArray<string | number>,
): TaskSchemaRow {
	return {
		symbol,
		expected: formatConformanceValue(expected),
		model: formatConformanceValue(readSchemaPath(TASK_SCHEMA, path)),
	}
}

/** Builds one row from a projected schema value. */
export function createTaskProjectionRow(
	symbol: string,
	expected: unknown,
	model: unknown,
): TaskSchemaRow {
	return {
		symbol,
		expected: formatConformanceValue(expected),
		model: formatConformanceValue(model),
	}
}

/** Reads whether the Tasks schema requires one `Task` property. */
export function readTaskRequiredness(member: string): boolean {
	const required = readSchemaPath(TASK_SCHEMA, ['$defs', 'Task', 'required'])
	return Array.isArray(required) && required.includes(member)
}

/** Projects one `DetailedTask` variant onto its status and owed payload. */
export function readTaskVariant(index: number): unknown {
	const variant = readSchemaPath(TASK_SCHEMA, ['$defs', 'DetailedTask', 'anyOf', index])
	if (!isRecord(variant)) return undefined
	const properties = Reflect.get(variant, 'properties')
	const required = Reflect.get(variant, 'required')
	if (!isRecord(properties) || !Array.isArray(required)) return undefined
	const status = readSchemaPath(properties, ['status', 'const'])
	if (status === 'input_required') {
		return {
			status,
			required,
			payload: {
				inputRequests: Reflect.get(properties, 'inputRequests'),
			},
		}
	}
	if (status === 'completed') {
		return {
			status,
			required,
			payload: { result: Reflect.get(properties, 'result') },
		}
	}
	if (status === 'failed') {
		return {
			status,
			required,
			payload: { error: Reflect.get(properties, 'error') },
		}
	}
	return { status, required, payload: {} }
}

/** Projects the flat `CreateTaskResult` composition. */
export function readCreateTaskResult(): unknown {
	const properties = readSchemaPath(TASK_SCHEMA, [
		'$defs',
		'CreateTaskResult',
		'allOf',
		1,
		'properties',
	])
	if (!isRecord(properties)) return undefined
	return {
		base: readSchemaPath(TASK_SCHEMA, ['$defs', 'CreateTaskResult', 'allOf', 0, '$ref']),
		properties: Object.keys(properties),
		required: readSchemaPath(TASK_SCHEMA, ['$defs', 'CreateTaskResult', 'allOf', 1, 'required']),
		nested: Reflect.has(properties, 'task'),
		resultType: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			'CreateTaskResult',
			'allOf',
			2,
			'properties',
			'resultType',
			'const',
		]),
	}
}

/** Projects one completed task-result composition. */
export function readCompleteTaskResult(definition: string): unknown {
	const detail = readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'allOf', 1, 'anyOf'])
	const result = Array.isArray(detail) ? 2 : 1
	return {
		base: readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'allOf', 0, '$ref']),
		detail: Array.isArray(detail),
		resultType: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			definition,
			'allOf',
			result,
			'properties',
			'resultType',
			'const',
		]),
	}
}

/** Projects the flat task-status notification parameters. */
export function readTaskNotificationShape(): unknown {
	const variants = readSchemaPath(TASK_SCHEMA, [
		'$defs',
		'TaskStatusNotificationParams',
		'allOf',
		1,
		'anyOf',
	])
	if (!Array.isArray(variants)) return undefined
	const statuses = Array.from(variants.keys(), (index) =>
		readSchemaPath(TASK_SCHEMA, [
			'$defs',
			'TaskStatusNotificationParams',
			'allOf',
			1,
			'anyOf',
			index,
			'properties',
			'status',
			'const',
		]),
	)
	return {
		base: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			'TaskStatusNotificationParams',
			'allOf',
			0,
			'$ref',
		]),
		statuses,
		nested:
			readSchemaPath(TASK_SCHEMA, [
				'$defs',
				'TaskStatusNotificationParams',
				'allOf',
				1,
				'properties',
				'task',
			]) !== undefined,
	}
}

/** Projects the metadata inherited by task-status notification parameters. */
export function readTaskNotificationMetadata(): unknown {
	return {
		params: readSchemaPath(TASK_SCHEMA, ['$defs', 'NotificationParams', 'properties', '_meta']),
		metadata: {
			type: readSchemaPath(TASK_SCHEMA, ['$defs', 'NotificationMetaObject', 'type']),
			subscription: readSchemaPath(TASK_SCHEMA, [
				'$defs',
				'NotificationMetaObject',
				'properties',
				'io.modelcontextprotocol/subscriptionId',
				'$ref',
			]),
		},
	}
}

/** Projects one task-subscription fragment. */
export function readTaskSubscription(definition: string): unknown {
	return {
		type: readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'type']),
		properties: readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'properties']),
		required: readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'required']),
	}
}

/** Projects the Tasks extension capability's exactly-empty object schema. */
export function readTaskCapability(): unknown {
	return {
		type: readSchemaPath(TASK_SCHEMA, ['$defs', 'TasksExtensionCapability', 'type']),
		propertyNames: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			'TasksExtensionCapability',
			'propertyNames',
		]),
		additionalProperties: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			'TasksExtensionCapability',
			'additionalProperties',
		]),
	}
}

/** Covers `Task` requiredness, `ttlMs` nullability, and integer spellings. */
export const TASK_SCHEMA_TASK_ROWS: readonly TaskSchemaRow[] = [
	...TASK_PROPERTIES.map((member) =>
		createTaskProjectionRow(
			`Task.${member} required`,
			TASK_REQUIRED.includes(member),
			readTaskRequiredness(member),
		),
	),
	createTaskSchemaRow('Task.ttlMs nullable', 'null', [
		'$defs',
		'Task',
		'properties',
		'ttlMs',
		'anyOf',
		1,
		'type',
	]),
	createTaskSchemaRow('Task.ttlMs integer schema', TASK_INTEGER_SCHEMA, [
		'$defs',
		'Task',
		'properties',
		'ttlMs',
		'anyOf',
		0,
	]),
	createTaskSchemaRow('Task.pollIntervalMs integer schema', TASK_INTEGER_SCHEMA, [
		'$defs',
		'Task',
		'properties',
		'pollIntervalMs',
	]),
]

/** Covers each `TaskStatus` member. */
export const TASK_SCHEMA_STATUS_ROWS: readonly TaskSchemaRow[] = [
	createTaskSchemaRow('TaskStatus.working', 'working', [
		'$defs',
		'TaskStatus',
		'anyOf',
		0,
		'const',
	]),
	createTaskSchemaRow('TaskStatus.input_required', 'input_required', [
		'$defs',
		'TaskStatus',
		'anyOf',
		1,
		'const',
	]),
	createTaskSchemaRow('TaskStatus.completed', 'completed', [
		'$defs',
		'TaskStatus',
		'anyOf',
		2,
		'const',
	]),
	createTaskSchemaRow('TaskStatus.failed', 'failed', ['$defs', 'TaskStatus', 'anyOf', 3, 'const']),
	createTaskSchemaRow('TaskStatus.cancelled', 'cancelled', [
		'$defs',
		'TaskStatus',
		'anyOf',
		4,
		'const',
	]),
]

/** Covers each `DetailedTask` variant and the payload it owes. */
export const TASK_SCHEMA_DETAIL_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'DetailedTask.working',
		{ status: 'working', required: TASK_REQUIRED, payload: {} },
		readTaskVariant(0),
	),
	createTaskProjectionRow(
		'DetailedTask.input_required',
		{
			status: 'input_required',
			required: [...TASK_REQUIRED, 'inputRequests'],
			payload: { inputRequests: { $ref: '#/$defs/InputRequests' } },
		},
		readTaskVariant(1),
	),
	createTaskProjectionRow(
		'DetailedTask.completed',
		{
			status: 'completed',
			required: [...TASK_REQUIRED, 'result'],
			payload: {
				result: {
					type: 'object',
					propertyNames: { type: 'string' },
					additionalProperties: {},
				},
			},
		},
		readTaskVariant(2),
	),
	createTaskProjectionRow(
		'DetailedTask.failed',
		{
			status: 'failed',
			required: [...TASK_REQUIRED, 'error'],
			payload: { error: { $ref: '#/$defs/Error' } },
		},
		readTaskVariant(3),
	),
	createTaskProjectionRow(
		'DetailedTask.cancelled',
		{ status: 'cancelled', required: TASK_REQUIRED, payload: {} },
		readTaskVariant(4),
	),
]

/** Covers the flat creation result. */
export const TASK_SCHEMA_CREATE_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'CreateTaskResult',
		{
			base: '#/$defs/Result',
			properties: TASK_PROPERTIES,
			required: TASK_REQUIRED,
			nested: false,
			resultType: 'task',
		},
		readCreateTaskResult(),
	),
]

/** Covers the completed get, update, and cancel result shapes. */
export const TASK_SCHEMA_RESULT_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'GetTaskResult',
		{ base: '#/$defs/Result', detail: true, resultType: 'complete' },
		readCompleteTaskResult('GetTaskResult'),
	),
	createTaskProjectionRow(
		'UpdateTaskResult',
		{ base: '#/$defs/Result', detail: false, resultType: 'complete' },
		readCompleteTaskResult('UpdateTaskResult'),
	),
	createTaskProjectionRow(
		'CancelTaskResult',
		{ base: '#/$defs/Result', detail: false, resultType: 'complete' },
		readCompleteTaskResult('CancelTaskResult'),
	),
]

/** Covers task-status notification flatness and metadata. */
export const TASK_SCHEMA_NOTIFICATION_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'TaskStatusNotificationParams flatness',
		{
			base: '#/$defs/NotificationParams',
			statuses: ['working', 'input_required', 'completed', 'failed', 'cancelled'],
			nested: false,
		},
		readTaskNotificationShape(),
	),
	createTaskProjectionRow(
		'TaskStatusNotificationParams metadata',
		{
			params: { $ref: '#/$defs/NotificationMetaObject' },
			metadata: { type: 'object', subscription: '#/$defs/RequestId' },
		},
		readTaskNotificationMetadata(),
	),
]

/** Covers the request-side and acknowledged-side `taskIds` fragments. */
export const TASK_SCHEMA_SUBSCRIPTION_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'TaskSubscriptionNotifications.taskIds',
		{
			type: 'object',
			properties: {
				taskIds: { type: 'array', items: { type: 'string' } },
			},
		},
		readTaskSubscription('TaskSubscriptionNotifications'),
	),
	createTaskProjectionRow(
		'TaskSubscriptionAcknowledgedNotifications.taskIds',
		{
			type: 'object',
			properties: {
				taskIds: { type: 'array', items: { type: 'string' } },
			},
		},
		readTaskSubscription('TaskSubscriptionAcknowledgedNotifications'),
	),
]

/** Covers the exactly-empty Tasks extension capability. */
export const TASK_SCHEMA_CAPABILITY_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'TasksExtensionCapability',
		{
			type: 'object',
			propertyNames: { type: 'string' },
			additionalProperties: { not: {} },
		},
		readTaskCapability(),
	),
]

/** Covers every method literal declared by the schema. */
export const TASK_SCHEMA_METHOD_ROWS: readonly TaskSchemaRow[] = [
	createTaskSchemaRow('CancelTaskRequest.method', 'tasks/cancel', [
		'$defs',
		'CancelTaskRequest',
		'allOf',
		1,
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('GetTaskRequest.method', 'tasks/get', [
		'$defs',
		'GetTaskRequest',
		'allOf',
		1,
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('TaskStatusNotification.method', 'notifications/tasks', [
		'$defs',
		'TaskStatusNotification',
		'allOf',
		1,
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('UpdateTaskRequest.method', 'tasks/update', [
		'$defs',
		'UpdateTaskRequest',
		'allOf',
		1,
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('CreateMessageRequest.method', 'sampling/createMessage', [
		'$defs',
		'CreateMessageRequest',
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('ElicitRequest.method', 'elicitation/create', [
		'$defs',
		'ElicitRequest',
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('ListRootsRequest.method', 'roots/list', [
		'$defs',
		'ListRootsRequest',
		'properties',
		'method',
		'const',
	]),
]

/** Covers the schema identifier. */
export const TASK_SCHEMA_ID_ROWS: readonly TaskSchemaRow[] = [
	createTaskSchemaRow('Tasks schema $id', TASK_SCHEMA_ID, ['$id']),
]

// ── The tool fixture ─────────────────────────────────────────────────────────

/**
 * Supplies the rich content the content-block scenarios ask for VERBATIM.
 *
 * @remarks
 * A plain `execute` return is an ordinary domain value, and the server normalizes one
 * into text plus `structuredContent` exactly as its contract states — so a fixture with no
 * `execution` port cannot answer an image, an audio clip, an embedded resource, or a
 * mixed sequence, and its failures would measure the fixture rather than the library.
 * `MCPServerOptions.execution` is the shipped, documented port for precisely this.
 */
export const CONFORMANCE_CONTENT: Readonly<Record<string, readonly MCPContent[]>> = Object.freeze({
	test_image_content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
	test_audio_content: [{ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }],
	test_embedded_resource: [
		{
			type: 'resource',
			resource: {
				uri: 'test://embedded-resource',
				mimeType: 'text/plain',
				text: 'This is an embedded resource content.',
			},
		},
	],
	test_multiple_content_types: [
		{ type: 'text', text: 'Multiple content types test:' },
		{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
		{
			type: 'resource',
			resource: {
				uri: 'test://mixed-content-resource',
				mimeType: 'application/json',
				text: '{"test":"data","value":123}',
			},
		},
	],
})

/**
 * Supplies the JSON Schema 2020-12 document `json-schema-2020-12` reads back out of `tools/list`.
 *
 * @remarks
 * The scenario checks PRESERVATION, so this is the schema verbatim as the runner declares it:
 * `$schema`, `$defs`, and `additionalProperties` for SEP-1613, and the `$anchor`, composition
 * (`allOf`/`anyOf`), and conditional (`if`/`then`/`else`) keywords for SEP-2106. A tool's
 * `parameters` becomes the advertised `inputSchema` unchanged, so anything the listing drops is
 * the library dropping it.
 */
export const CONFORMANCE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	$defs: {
		address: {
			$anchor: 'addressDef',
			type: 'object',
			properties: {
				street: { type: 'string' },
				city: { type: 'string' },
			},
		},
	},
	properties: {
		name: { type: 'string' },
		address: { $ref: '#/$defs/address' },
		contactMethod: { type: 'string', enum: ['phone', 'email'] },
		phone: { type: 'string' },
		email: { type: 'string' },
	},
	allOf: [{ anyOf: [{ required: ['phone'] }, { required: ['email'] }] }],
	if: {
		properties: { contactMethod: { const: 'phone' } },
		required: ['contactMethod'],
	},
	then: { required: ['phone'] },
	else: { required: ['email'] },
	additionalProperties: false,
})

/**
 * Supplies the text each input-driven tool answers with after its rounds are answered.
 *
 * @remarks
 * The keys are also the REGISTRATION list for that tool family, so a scenario's tool name
 * exists in exactly one place. The text is static on purpose: the built-in input mechanism
 * verifies each response and then continues into the registry, and
 * `ToolManagerInterface.execute` takes a call and nothing else, so a tool never receives the
 * answer its own round asked for. A fixture that re-read the raw request to interpolate one
 * would be reporting on itself rather than on the library.
 *
 * `test_missing_capability` is the exception that proves the gate: SEP-2575 requires the
 * server to REFUSE it, so its text is a sentence no passing run ever sees. A gate that failed
 * open would put that sentence in the runner's own failure detail.
 */
export const CONFORMANCE_ANSWERS: Readonly<Record<string, string>> = Object.freeze({
	test_input_required_result_elicitation: 'Elicitation answered; the call is complete.',
	test_input_required_result_sampling: 'Sampling answered; the call is complete.',
	test_input_required_result_list_roots: 'Roots answered; the call is complete.',
	test_input_required_result_request_state: 'state-ok: the echoed request state verified.',
	test_input_required_result_multiple_inputs: 'Every input answered; the call is complete.',
	test_input_required_result_multi_round: 'Both rounds answered; the call is complete.',
	test_input_required_result_tampered_state: 'Request state verified; the call is complete.',
	test_input_required_result_capabilities: 'Declared-capability input answered.',
	test_missing_capability: 'This tool ran without the sampling capability the round needs.',
})

/**
 * Builds the live tool registry the conformance scenarios call.
 *
 * @returns A fresh `ToolManagerInterface` holding every `test_*` tool
 */
export function buildConformanceTools(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'test_simple_text',
			description: 'Return the conformance suite simple-text fixture.',
			execute: () => 'This is a simple text response for testing.',
		}),
	)
	tools.add(
		createTool({
			name: 'test_image_content',
			description: 'Exercise the declared image-content conformance gap.',
			execute: () => ({
				type: 'image',
				data: 'iVBORw0KGgo=',
				mimeType: 'image/png',
			}),
		}),
	)
	tools.add(
		createTool({
			name: 'test_multiple_content_types',
			description: 'Exercise the declared mixed-content conformance gap.',
			execute: () => CONFORMANCE_CONTENT.test_multiple_content_types,
		}),
	)
	tools.add(
		createTool({
			name: 'test_audio_content',
			description: 'Exercise the declared audio-content conformance gap.',
			execute: () => ({
				type: 'audio',
				data: 'UklGRg==',
				mimeType: 'audio/wav',
			}),
		}),
	)
	tools.add(
		createTool({
			name: 'test_embedded_resource',
			description: 'Exercise the declared embedded-resource conformance gap.',
			execute: () => ({
				type: 'resource',
				resource: {
					uri: 'test://embedded-resource',
					mimeType: 'text/plain',
					text: 'This is an embedded resource content.',
				},
			}),
		}),
	)
	tools.add(
		createTool({
			name: 'test_error_handling',
			description: 'Return the conformance suite isolated tool-error fixture.',
			execute: () => {
				throw new Error('This tool intentionally returns an error for testing')
			},
		}),
	)
	tools.add(
		createTool({
			name: 'test_tool_with_progress',
			description: 'Exercise the declared tool-progress conformance gap.',
			execute: () => 'Tool execution completed.',
		}),
	)
	tools.add(
		createTool({
			name: 'test_header_parameter',
			description: 'Exercise the declared Mcp-Param header conformance gap.',
			parameters: {
				type: 'object',
				properties: {
					value: { type: 'string', 'x-mcp-header': 'value' },
				},
				required: ['value'],
			},
			execute: (values) => values,
		}),
	)
	tools.add(
		createTool({
			name: 'json_schema_2020_12_tool',
			description: 'Tool with JSON Schema 2020-12 features',
			parameters: CONFORMANCE_INPUT_SCHEMA,
			execute: (values) => values,
		}),
	)
	for (const [name, answer] of Object.entries(CONFORMANCE_ANSWERS)) {
		tools.add(
			createTool({
				name,
				description: `Exercise the input-required round the ${name} scenario drives.`,
				execute: () => answer,
			}),
		)
	}
	return tools
}

// ── The multi-round-trip fixture ─────────────────────────────────────────────
//
// SEP-2322 is a SERVER mechanism, and `MCPServerOptions.input` is where the library owns it:
// the consumer composes each round and supplies principal, continuation, and TTL policy, while
// MCP gates the round against the client's declared capabilities, seals the state, and checks
// every answer against the question it answers. So this half is policy only. Nothing here
// produces an `input_required` result, because a fixture that produced one would be answering
// the conformance run on the library's behalf.
//
// The continuation port is the shipped `createMCPContinuation`, whose `seal` / `open` are
// `@orkestrel/server`'s HMAC token primitives. That is what makes `input-required-result-
// tampered-state` a real proof: the rejection comes from a signature that does not verify.

/** Supplies the signing secret the fixture's continuation port protects its request state with. */
export const CONFORMANCE_SECRET = 'orkestrel-conformance-continuation-secret'

/** Names the principal the fixture binds into protected state; this host authenticates nobody. */
export const CONFORMANCE_PRINCIPAL = 'conformance-client'

/** Bounds how long one protected continuation round stays valid, in milliseconds. */
export const CONFORMANCE_TTL = 60_000

/** Supplies the integrity-protected continuation port both the tool and prompt rounds seal state with. */
export const CONFORMANCE_CONTINUATION: MCPContinuationInterface =
	createMCPContinuation(CONFORMANCE_SECRET)

/**
 * Lists the rounds each input-driven tool asks for, in the order the scenario drives them.
 *
 * @remarks
 * A tool absent from this table needs no input, so its call runs straight into the registry.
 * The KEYS are the consumer's, and the scenarios read them: `-basic-elicitation` demands the
 * literal `user_name`, and `-multiple-input-requests` demands three keys of three different
 * kinds in one round. `test_input_required_result_multi_round` is the only two-round entry, and
 * the round the selector is on is carried in the continuation's consumer state rather than
 * stored here.
 *
 * `test_input_required_result_capabilities` and `test_missing_capability` ask for sampling
 * ALONE. That is the whole difference between them: the first call declares `sampling`, so the
 * round is issued; the second declares no capabilities at all, so the library refuses it with
 * -32021 before the tool runs.
 */
export const CONFORMANCE_ROUNDS: Readonly<Record<string, readonly MCPInputRequestMap[]>> =
	Object.freeze({
		test_input_required_result_elicitation: [
			{
				user_name: {
					method: 'elicitation/create',
					params: {
						message: 'What is your name?',
						requestedSchema: {
							type: 'object',
							properties: { name: { type: 'string' } },
							required: ['name'],
						},
					},
				},
			},
		],
		test_input_required_result_sampling: [
			{
				capital_question: {
					method: 'sampling/createMessage',
					params: {
						messages: [
							{ role: 'user', content: { type: 'text', text: 'What is the capital of France?' } },
						],
						maxTokens: 100,
					},
				},
			},
		],
		test_input_required_result_list_roots: [{ client_roots: { method: 'roots/list', params: {} } }],
		test_input_required_result_request_state: [
			{
				confirmation: {
					method: 'elicitation/create',
					params: {
						message: 'Please confirm',
						requestedSchema: {
							type: 'object',
							properties: { ok: { type: 'boolean' } },
							required: ['ok'],
						},
					},
				},
			},
		],
		test_input_required_result_multiple_inputs: [
			{
				user_name: {
					method: 'elicitation/create',
					params: {
						message: 'What is your name?',
						requestedSchema: {
							type: 'object',
							properties: { name: { type: 'string' } },
							required: ['name'],
						},
					},
				},
				greeting: {
					method: 'sampling/createMessage',
					params: {
						messages: [{ role: 'user', content: { type: 'text', text: 'Generate a greeting' } }],
						maxTokens: 50,
					},
				},
				client_roots: { method: 'roots/list', params: {} },
			},
		],
		test_input_required_result_multi_round: [
			{
				step1: {
					method: 'elicitation/create',
					params: {
						message: 'Step 1: What is your name?',
						requestedSchema: {
							type: 'object',
							properties: { name: { type: 'string' } },
							required: ['name'],
						},
					},
				},
			},
			{
				step2: {
					method: 'elicitation/create',
					params: {
						message: 'Step 2: What is your favorite color?',
						requestedSchema: {
							type: 'object',
							properties: { color: { type: 'string' } },
							required: ['color'],
						},
					},
				},
			},
		],
		test_input_required_result_tampered_state: [
			{
				confirmation: {
					method: 'elicitation/create',
					params: {
						message: 'Please confirm',
						requestedSchema: {
							type: 'object',
							properties: { ok: { type: 'boolean' } },
							required: ['ok'],
						},
					},
				},
			},
		],
		test_input_required_result_capabilities: [
			{
				capability_probe: {
					method: 'sampling/createMessage',
					params: {
						messages: [{ role: 'user', content: { type: 'text', text: 'What is your name?' } }],
						maxTokens: 50,
					},
				},
			},
		],
		test_missing_capability: [
			{
				capability_probe: {
					method: 'sampling/createMessage',
					params: {
						messages: [{ role: 'user', content: { type: 'text', text: 'Sample something' } }],
						maxTokens: 50,
					},
				},
			},
		],
	})

/**
 * Decides whether the call in hand still owes this host an answer.
 *
 * @remarks
 * The selector is the WHOLE of the consumer's half of a round trip. It sees every verified
 * answer on a retry and the state it carried into the round, and it answers with the next
 * round or with `undefined` — MCP owns the capability gate, the seal, the expiry, and the
 * per-answer check. The round index rides in the continuation's consumer state, so nothing
 * here is stored between requests and two concurrent exchanges cannot collide.
 *
 * @param context - The call in hand, plus every verified answer and the state on a retry
 * @returns The next round, or `undefined` when the tool may run
 */
export function buildConformanceInput(context: MCPInputContext): MCPInputRound | undefined {
	const rounds = CONFORMANCE_ROUNDS[context.name]
	if (rounds === undefined) return undefined
	const round = isFiniteNumber(context.state) ? context.state + 1 : 0
	const requests = rounds[round]
	return requests === undefined ? undefined : { requests, state: round }
}

/**
 * Projects the accepted string answers a verified retry carried.
 *
 * @remarks
 * The server has already verified the response against the schema it issued by the time this
 * reads it, so this is a projection rather than a second validation. A declined or cancelled
 * round contributes nothing.
 *
 * @param responses - The retry's `inputResponses` map, keyed by the server-minted request key
 * @returns Every accepted string field, flattened across the map's rounds
 */
export function readConformanceAnswers(
	responses: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> {
	const answers: Record<string, string> = {}
	for (const response of Object.values(responses ?? {})) {
		if (!isRecord(response) || response['action'] !== 'accept') continue
		const content = response['content']
		if (!isRecord(content)) continue
		for (const [field, value] of Object.entries(content)) {
			if (isString(value)) answers[field] = value
		}
	}
	return answers
}

// ── The resource fixture ─────────────────────────────────────────────────────
//
// The host-owned registries the resource, prompt, and completion ports project.
// Each is an ordinary in-memory object — deliberately NOT a workspace and not a template
// engine — because the ports are ports: what backs them is the host's decision and this
// file is one host's answer.

/** Lists the static resources the fixture advertises over `resources/list`. */
export const CONFORMANCE_RESOURCES: readonly MCPResource[] = Object.freeze([
	{
		uri: 'test://static-text',
		name: 'static-text',
		description: 'The conformance suite static text resource.',
		mimeType: 'text/plain',
	},
	{
		uri: 'test://static-binary',
		name: 'static-binary',
		description: 'The conformance suite static binary resource.',
		mimeType: 'image/png',
	},
])

/** Maps each static resource URI to the contents it resolves to. */
export const CONFORMANCE_CONTENTS: Readonly<Record<string, readonly MCPResourceContents[]>> =
	Object.freeze({
		'test://static-text': [
			{
				uri: 'test://static-text',
				mimeType: 'text/plain',
				text: 'This is the content of the static text resource.',
			},
		],
		'test://static-binary': [
			{
				uri: 'test://static-binary',
				mimeType: 'image/png',
				blob: 'iVBORw0KGgo=',
			},
		],
	})

/**
 * Matches the already-substituted form of the fixture's one resource template.
 *
 * @remarks
 * The template is published as a DESCRIPTOR and matched HERE. MCP expands nothing: it
 * forwards the already-concrete `test://template/123/data` the client sent, and the party
 * that owns the template owns knowing its variables. `scenario resources-templates-read`
 * sends the substituted URI for exactly this reason, so a template engine inside MCP
 * would have nothing to do.
 */
export const CONFORMANCE_TEMPLATE = /^test:\/\/template\/([^/]+)\/data$/

/** Supplies the descriptor form of {@link CONFORMANCE_TEMPLATE}, as `resources/templates/list` advertises it. */
export const CONFORMANCE_DESCRIPTOR = 'test://template/{id}/data'

/**
 * Resolves one already-substituted template URI to its JSON document.
 *
 * @param uri - The concrete URI the client sent
 * @returns The document contents, or `undefined` when the URI is not this template's
 */
export function readConformanceTemplate(uri: string): readonly MCPResourceContents[] | undefined {
	const matched = CONFORMANCE_TEMPLATE.exec(uri)
	if (matched === null) return undefined
	const id = matched[1]
	if (id === undefined) return undefined
	return [
		{
			uri,
			mimeType: 'application/json',
			text: JSON.stringify({
				id,
				templateTest: true,
				data: `Data for ID: ${id}`,
			}),
		},
	]
}

// ── The prompt fixture ───────────────────────────────────────────────────────

/** Lists the prompts the fixture advertises over `prompts/list`. */
export const CONFORMANCE_PROMPTS: readonly MCPPrompt[] = Object.freeze([
	{
		name: 'test_simple_prompt',
		description: 'The conformance suite simple-prompt fixture.',
	},
	{
		name: 'test_prompt_with_arguments',
		description: 'The conformance suite parameterized-prompt fixture.',
		arguments: [
			{
				name: 'arg1',
				description: 'First test argument.',
				required: true,
			},
			{
				name: 'arg2',
				description: 'Second test argument.',
				required: true,
			},
		],
	},
	{
		name: 'test_prompt_with_embedded_resource',
		description: 'The conformance suite embedded-resource prompt fixture.',
		arguments: [
			{
				name: 'resourceUri',
				description: 'The resource to embed.',
				required: true,
			},
		],
	},
	{
		name: 'test_prompt_with_image',
		description: 'The conformance suite image-prompt fixture.',
	},
	{
		name: 'test_input_required_result_prompt',
		description: 'The conformance suite multi-round-trip prompt fixture.',
	},
])

/**
 * Supplies the input request the multi-round prompt asks for before it can be filled.
 *
 * @remarks
 * `prompts/get` is the arm of SEP-2322 the library places on the HOST: the prompt port may
 * answer an {@link MCPInputResult} of its own, so the key, the request, and the round are this
 * fixture's to choose. That is the opposite division from `tools/call`, where the library owns
 * the round and the consumer supplies only policy.
 */
export const CONFORMANCE_REQUESTS: MCPInputRequestMap = Object.freeze({
	user_context: {
		method: 'elicitation/create',
		params: {
			mode: 'form',
			message: 'What context should the prompt use?',
			requestedSchema: {
				type: 'object',
				properties: { context: { type: 'string' } },
				required: ['context'],
			},
		},
	},
})

/** Supplies the canonical state the multi-round prompt seals into its opaque `requestState`. */
export const CONFORMANCE_STATE = 'test_input_required_result_prompt/user_context'

/**
 * Issues the multi-round prompt's round, or lets a verified retry through.
 *
 * @remarks
 * The carrier is protected by the same shipped continuation port the tool rounds use, so a
 * `requestState` this host did not seal opens to `undefined` and the round is re-issued rather
 * than honoured.
 *
 * @param params - The `prompts/get` parameters, including the retry carrier
 * @returns The round to answer, or `undefined` when this prompt may be filled
 */
export async function buildConformanceRound(
	params: MCPPromptGetParams,
): Promise<MCPInputResult | undefined> {
	if (params.name !== 'test_input_required_result_prompt') return undefined
	const carrier = params.requestState
	const opened = carrier === undefined ? undefined : await CONFORMANCE_CONTINUATION.open(carrier)
	if (opened === CONFORMANCE_STATE) return undefined
	return {
		resultType: 'input_required',
		inputRequests: CONFORMANCE_REQUESTS,
		requestState: await CONFORMANCE_CONTINUATION.seal(CONFORMANCE_STATE),
	}
}

/**
 * Fills one named prompt with the caller's arguments.
 *
 * @remarks
 * `arguments` are strings by contract, so filling a prompt is the host's own
 * substitution — the same division as the resource template above. MCP validates the
 * argument record and forwards it.
 *
 * @param name - The prompt name the client asked for
 * @param values - The string arguments the client supplied
 * @returns The prompt's messages, or `undefined` when this host owns no such prompt
 */
export function buildConformanceMessages(
	name: string,
	values: Readonly<Record<string, string>>,
): readonly MCPPromptMessage[] | undefined {
	if (name === 'test_simple_prompt') {
		return [
			{
				role: 'user',
				content: {
					type: 'text',
					text: 'This is a simple prompt for testing.',
				},
			},
		]
	}
	if (name === 'test_prompt_with_arguments') {
		return [
			{
				role: 'user',
				content: {
					type: 'text',
					text: `Prompt with arguments: arg1='${values.arg1 ?? ''}', arg2='${values.arg2 ?? ''}'`,
				},
			},
		]
	}
	if (name === 'test_prompt_with_embedded_resource') {
		return [
			{
				role: 'user',
				content: {
					type: 'resource',
					resource: {
						uri: values.resourceUri ?? 'test://example-resource',
						mimeType: 'text/plain',
						text: 'Embedded resource content for testing.',
					},
				},
			},
			{
				role: 'user',
				content: {
					type: 'text',
					text: 'Please process the embedded resource above.',
				},
			},
		]
	}
	if (name === 'test_prompt_with_image') {
		return [
			{
				role: 'user',
				content: {
					type: 'image',
					data: 'iVBORw0KGgo=',
					mimeType: 'image/png',
				},
			},
			{
				role: 'user',
				content: {
					type: 'text',
					text: 'Please analyze the image above.',
				},
			},
		]
	}
	if (name === 'test_input_required_result_prompt') {
		return [
			{
				role: 'user',
				content: {
					type: 'text',
					text: `Prompt with elicited context: '${values.context ?? ''}'`,
				},
			},
		]
	}
	return undefined
}

// ── The completion fixture ───────────────────────────────────────────────────
//
// Completion is a top-level capability, independent of the resource and prompt ports: the host owns
// reference lookup for BOTH arms, because the party that expands a template is the party
// that knows its variables. A reference this host does not recognize answers `undefined`,
// which MCP maps to `-32602` rather than inventing an empty candidate list.

/** Lists the candidate values each prompt argument completes to. */
export const CONFORMANCE_CANDIDATES: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = Object.freeze({
	test_prompt_with_arguments: {
		arg1: ['testValue1', 'testAlpha', 'production'],
		arg2: ['testValue2', 'testBeta', 'staging'],
	},
	test_prompt_with_embedded_resource: {
		resourceUri: CONFORMANCE_RESOURCES.map((entry) => entry.uri),
	},
})

/** Lists the candidate identifiers the fixture's resource template completes to. */
export const CONFORMANCE_IDENTIFIERS: readonly string[] = Object.freeze(['123', '456', '789'])

/**
 * Projects one candidate list onto the fragment the client has typed so far.
 *
 * @param candidates - Every value the reference could complete to
 * @param value - The fragment already typed
 * @returns The matching candidates plus the unprojected total
 */
export function buildConformanceCompletion(
	candidates: readonly string[],
	value: string,
): MCPCompletion {
	return {
		values: candidates.filter((candidate) => candidate.startsWith(value)),
		total: candidates.length,
	}
}

// ── The assembled host ───────────────────────────────────────────────────────

/**
 * Builds the whole conformance host — every port `MCPServerOptions` publishes, backed by
 * the plain objects above.
 *
 * @returns The server options one `createMCPServer` call away from a live fixture
 */
export function buildConformanceOptions(): MCPServerOptions {
	return {
		identity: CONFORMANCE_IDENTITY,
		tools: buildConformanceTools(),
		resources: {
			resources: () => ({ resources: CONFORMANCE_RESOURCES }),
			resource: (params) => CONFORMANCE_CONTENTS[params.uri] ?? readConformanceTemplate(params.uri),
			templates: () => ({
				resourceTemplates: [
					{
						uriTemplate: CONFORMANCE_DESCRIPTOR,
						name: 'template-data',
						description: 'One JSON document per identifier.',
						mimeType: 'application/json',
					},
				],
			}),
		},
		prompts: {
			prompts: () => ({ prompts: CONFORMANCE_PROMPTS }),
			prompt: async (params) => {
				const round = await buildConformanceRound(params)
				if (round !== undefined) return round
				// Declared arguments and elicited answers fill the same substitution, because the
				// host that owns a prompt's variables owns them whichever round supplied one.
				const values = {
					...(params.arguments ?? {}),
					...readConformanceAnswers(params.inputResponses),
				}
				const messages = buildConformanceMessages(params.name, values)
				if (messages === undefined) return undefined
				const prompt = CONFORMANCE_PROMPTS.find((entry) => entry.name === params.name)
				if (prompt === undefined) return undefined
				return {
					resultType: 'complete',
					...(prompt.description === undefined ? {} : { description: prompt.description }),
					messages,
				}
			},
		},
		completion: {
			complete: (params) => {
				const ref = params.ref
				if (ref.type === 'ref/prompt') {
					const prompt = CONFORMANCE_PROMPTS.find((entry) => entry.name === ref.name)
					if (prompt === undefined) return undefined
					const candidates = CONFORMANCE_CANDIDATES[ref.name]?.[params.argument.name] ?? []
					return buildConformanceCompletion(candidates, params.argument.value)
				}
				const known = CONFORMANCE_TEMPLATE.test(ref.uri) || ref.uri === CONFORMANCE_DESCRIPTOR
				if (!known) return undefined
				return buildConformanceCompletion(CONFORMANCE_IDENTIFIERS, params.argument.value)
			},
		},
		input: {
			continuation: CONFORMANCE_CONTINUATION,
			ttl: CONFORMANCE_TTL,
			principal: () => CONFORMANCE_PRINCIPAL,
			selector: buildConformanceInput,
		},
		execution: async (context) => {
			// The request-scoped reporter exists only when the caller sent a `progressToken`, and
			// reporting is the executor's job rather than the server's — the port hands the reporter
			// over and the work decides what a step is. `tools-call-with-progress` specifies the
			// steps below exactly (0/100, 50/100, 100/100) and counts them, so the fixture reports
			// what the scenario asks for rather than a shape of its own.
			if (context.progress !== undefined) {
				await context.progress.report({ progress: 0, total: 100 })
				await context.progress.report({ progress: 50, total: 100 })
				await context.progress.report({ progress: 100, total: 100 })
			}
			const content = CONFORMANCE_CONTENT[context.call.name]
			if (content !== undefined) return { resultType: 'complete', content }
			return await context.tools.execute(context.call)
		},
	}
}

/** Builds the input selector context for one conformance tool. */
export function buildInputContext(name: string, state?: number): MCPInputContext {
	return {
		request: createJSONRPCRequest({ method: 'tools/call', params: { name: 'ignored' } }),
		name,
		arguments: {},
		...(state === undefined ? {} : { state }),
	}
}

/** Answers a fixture HTTP route with its success body. */
export function respondFixtureOK(): Response {
	return new Response('ok')
}

/**
 * Starts the conformance fixture on an ephemeral loopback port.
 *
 * @remarks
 * The whole spine is real: `createMCPServer` behind `createMCPRoutes` behind a real
 * `@orkestrel/server` listener, reachable over a real socket by any foreign client.
 * Call `stop()` in `afterAll`.
 *
 * @returns The started-server handle (`base` URL + `stop`)
 */
export async function startConformance(): Promise<StartedServerInterface<undefined>> {
	const mcp = createMCPServer(buildConformanceOptions())
	const dispatcher = createDispatcher<undefined>()
	dispatcher.add(createMCPRoutes<undefined>(mcp))
	return await startServer(createServer<undefined>({ dispatcher, state: () => undefined }))
}

// ── The foreign runner ───────────────────────────────────────────────────────

/**
 * Reads the runner build the package manifest pins.
 *
 * @remarks
 * The manifest is the SINGLE authority for the version. It is what `npm install` puts on
 * disk and what the lockfile records, so a constant copied beside it is a second copy that
 * can disagree with the build actually running. The recorded scenario baseline is a
 * baseline of exactly this build, so the suite asserts the runner reports it.
 *
 * @returns The exact version `devDependencies` pins the runner to
 * @throws When the manifest pins no such development dependency
 */
export function readConformanceRelease(): string {
	const parsed: unknown = JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
	)
	if (!isRecord(parsed) || !isRecord(parsed['devDependencies'])) {
		throw new Error('Package manifest must declare object devDependencies')
	}
	const release = parsed['devDependencies'][CONFORMANCE_PACKAGE]
	if (typeof release !== 'string') {
		throw new Error(`Package manifest must pin ${CONFORMANCE_PACKAGE} in devDependencies`)
	}
	return release
}

/**
 * Resolves the installed runner's entry module.
 *
 * @remarks
 * The runner is a development dependency, so its entry is already on disk when the suite
 * starts and no invocation fetches anything. Resolution is anchored on this module, which
 * is what makes the answer the tree's own install rather than whatever a cache holds.
 *
 * @returns The absolute path to the runner's entry module
 * @throws When the development dependency is not installed, naming what to do about it
 */
export function resolveConformanceRunner(): string {
	try {
		return createRequire(import.meta.url).resolve(CONFORMANCE_ENTRY)
	} catch {
		throw new Error(
			`The conformance project needs the ${CONFORMANCE_PACKAGE} development dependency, ` +
				`which is not installed. Run \`npm install\`, then rerun \`npm run test:conformance\`.`,
		)
	}
}

/**
 * Invokes the installed conformance runner and collects everything it wrote.
 *
 * @remarks
 * Node runs the runner's entry file directly. A file path needs no shell on any host, so
 * none is enabled and nothing the caller passes is ever handed to one.
 *
 * @param command - The runner subcommand and its options
 * @returns The runner's combined standard output and standard error
 */
export async function executeRunner(command: readonly string[]): Promise<string> {
	const runner = spawn(process.execPath, [resolveConformanceRunner(), ...command], {
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const chunks: string[] = []
	runner.stdout.setEncoding('utf8')
	runner.stderr.setEncoding('utf8')
	runner.stdout.on('data', (chunk: string) => chunks.push(chunk))
	runner.stderr.on('data', (chunk: string) => chunks.push(chunk))
	await once(runner, 'close')
	return chunks.join('')
}

/**
 * Parses the runner's `=== SUMMARY ===` block.
 *
 * @param output - Everything the runner wrote
 * @returns The scenario tallies and totals, or `undefined` when it printed no summary
 */
export function parseConformance(output: string): ConformanceResult | undefined {
	const scenarios: ConformanceScenario[] = []
	for (const line of output.split(/\r?\n/)) {
		const totalled = CONFORMANCE_TOTAL.exec(line)
		if (totalled !== null) {
			const passed = totalled[1]
			const failed = totalled[2]
			if (passed === undefined || failed === undefined) return undefined
			return {
				scenarios,
				passed: Number.parseInt(passed, 10),
				failed: Number.parseInt(failed, 10),
			}
		}
		const tallied = CONFORMANCE_TALLY.exec(line)
		if (tallied === null) continue
		const name = tallied[1]
		const passed = tallied[2]
		const failed = tallied[3]
		if (name === undefined || passed === undefined || failed === undefined) continue
		scenarios.push({
			name,
			passed: Number.parseInt(passed, 10),
			failed: Number.parseInt(failed, 10),
		})
	}
	return undefined
}

/**
 * Drives the pinned runner's whole `server` scenario set at {@link CONFORMANCE_SPEC} against
 * a live MCP endpoint.
 *
 * @remarks
 * `--suite all` widens the run past the runner's own `active` default, which excludes its
 * `draft` and `pending` scenarios. This project pins one spec version, so the widened run
 * still names every scenario the runner's own `list --spec-version 2026-07-28` reports for
 * it, and the recorded baseline in `tests/conformance.test.ts` covers scenarios this server
 * does not answer yet.
 *
 * @param url - The fixture's absolute MCP endpoint
 * @returns The parsed run outcome
 * @throws When the runner produced no summary block, carrying everything it wrote
 */
export async function executeConformance(url: string): Promise<ConformanceResult> {
	const output = await executeRunner([
		'server',
		'--url',
		url,
		'--spec-version',
		CONFORMANCE_SPEC,
		'--suite',
		'all',
	])
	const result = parseConformance(output)
	if (result === undefined) {
		throw new Error(
			`${CONFORMANCE_PACKAGE} printed no summary for ${url}. Its output was:\n${output}`,
		)
	}
	return result
}

// ── The client under test ────────────────────────────────────────────────────

/**
 * Composes the command the runner spawns as the client under test.
 *
 * @remarks
 * The runner splits `--command` on spaces and appends the scenario URL, so every token here
 * must be space-free. That rules out `process.execPath`, whose usual Windows value sits
 * under `Program Files`, and leaves the bare `node` the host resolves from `PATH`.
 * `--experimental-strip-types` is passed because the driver is TypeScript: Node enables
 * stripping by default from 22.18, and the manifest's `engines` floor is 22.12, so the flag
 * covers the whole supported range and is accepted as a no-op above it.
 *
 * The driver imports the BUILT surface, which is the only client face a spawned `node`
 * process can resolve. `dist/` must therefore exist before this runs. The gate chain builds
 * before it tests, so `npm test` is satisfied; a standalone `npm run test:conformance` during
 * development needs `npm run build:src` first.
 *
 * @returns The spawn command, driver path included
 * @throws When the driver's path relative to the working directory contains a space, which
 * the runner's own splitting cannot carry
 */
export function resolveConformanceDriver(): string {
	const driver = fileURLToPath(new URL('./fixtures/conformanceClient.ts', import.meta.url))
	const command = relative(process.cwd(), driver).replaceAll('\\', '/')
	if (command.includes(' ')) {
		throw new Error(
			`${CONFORMANCE_PACKAGE} splits its --command on spaces, and the driver resolves to ` +
				`'${command}'. Run the conformance project from a directory whose path to ` +
				`tests/fixtures/conformanceClient.ts carries no space.`,
		)
	}
	return `node --experimental-strip-types ${command}`
}

/**
 * Reads every client scenario name out of the runner's own `list` output.
 *
 * @remarks
 * `list` prints one section per scenario family, each opening with its own heading and
 * closing at the first line that is not an entry. This reads the client section alone, so a
 * server or authorization-server scenario sharing a name never enters the answer.
 *
 * @param output - Everything `list` wrote
 * @returns The client scenario names in the order the runner printed them, empty when it
 * printed no client section
 */
export function parseConformanceClients(output: string): readonly string[] {
	const lines = output.split(/\r\n|\n/)
	const start = lines.findIndex((line) => CONFORMANCE_CLIENTS.test(line))
	if (start === -1) return []
	const entries = lines.slice(start + 1)
	const end = entries.findIndex((line) => !CONFORMANCE_LISTED.test(line))
	return entries.slice(0, end === -1 ? undefined : end).flatMap((line) => {
		const name = CONFORMANCE_LISTED.exec(line)?.[1]
		return name === undefined ? [] : [name]
	})
}

/**
 * Parses the runner's per-scenario result block from one client-mode run.
 *
 * @remarks
 * Client mode prints no `=== SUMMARY ===` block for a single scenario. Its verdict is the
 * one `Passed: N/D, M failed, W warnings` line, whose denominator is the passed-plus-failed
 * total and carries nothing the three counts do not.
 *
 * @param name - The scenario the run drove
 * @param output - Everything the runner wrote
 * @returns The scenario's outcome, or `undefined` when it printed no result line
 */
export function parseConformanceOutcome(
	name: string,
	output: string,
): ConformanceOutcome | undefined {
	for (const line of output.split(/\r?\n/)) {
		const matched = CONFORMANCE_OUTCOME.exec(line)
		if (matched === null) continue
		const passed = matched[1]
		const failed = matched[2]
		const warnings = matched[3]
		if (passed === undefined || failed === undefined || warnings === undefined) continue
		return {
			name,
			passed: Number.parseInt(passed, 10),
			failed: Number.parseInt(failed, 10),
			warnings: Number.parseInt(warnings, 10),
		}
	}
	return undefined
}

/**
 * Drives this package's own client through every scenario in
 * {@link CONFORMANCE_CLIENT_SCENARIOS}.
 *
 * @remarks
 * Each scenario runs as its own invocation rather than through `--suite`, for two reasons.
 * The runner's suites are `all`, `core`, `extensions`, `backcompat`, `auth`, `metadata`,
 * `draft`, and `sep-835`, and every one of them that reaches this package's scenarios also
 * drags in the `auth/*` family this package excludes. And `--suite` runs its scenarios in
 * parallel, so a hang reports as the whole suite rather than as the scenario that hung.
 * Serial invocation costs a process launch per scenario and buys a per-scenario reading.
 *
 * The runner starts and stops each scenario's own server, so nothing here binds a port.
 *
 * @returns Every scenario's outcome, in {@link CONFORMANCE_CLIENT_SCENARIOS} order
 * @throws When the runner produced no result line for a scenario, carrying everything it wrote
 */
export async function executeConformanceClient(): Promise<readonly ConformanceOutcome[]> {
	const command = resolveConformanceDriver()
	const outcomes: ConformanceOutcome[] = []
	for (const scenario of CONFORMANCE_CLIENT_SCENARIOS) {
		const output = await executeRunner([
			'client',
			'--command',
			command,
			'--scenario',
			scenario,
			'--spec-version',
			CONFORMANCE_SPEC,
		])
		const outcome = parseConformanceOutcome(scenario, output)
		if (outcome === undefined) {
			throw new Error(
				`${CONFORMANCE_PACKAGE} printed no result for client scenario ${scenario}. ` +
					`Its output was:\n${output}`,
			)
		}
		outcomes.push(outcome)
	}
	return outcomes
}

/** Describes one tool call, either scripted by the runner or derived from a listed tool. */
export interface ConformanceCall {
	readonly name: string
	readonly arguments: Readonly<Record<string, unknown>>
}

/** Names the identity this driver reports as its `clientInfo`. */
export const DRIVER_IDENTITY = Object.freeze({
	name: 'orkestrel-conformance-client',
	version: '0.0.9',
})

/**
 * Reads one JSON Schema leaf as a value an elicitation answer and a tool argument both accept.
 *
 * @param schema - The leaf schema to read
 * @returns A value of the declared type, or `undefined` when the leaf declares none this
 * driver can supply
 */
export function readSchemaValue(schema: unknown): MCPElicitValue | undefined {
	if (!isRecord(schema)) return undefined
	const type = schema['type']
	if (type === 'string') return 'conformance'
	if (type === 'integer') return 1
	if (type === 'number') return 1.5
	if (type === 'boolean') return true
	if (type === 'array') return []
	return undefined
}

/**
 * Builds one argument record from an advertised object schema.
 *
 * @remarks
 * Every property the schema declares a supplyable type for is filled; a `$ref`, a nested
 * object, and any other leaf this driver cannot supply is omitted rather than guessed.
 *
 * @param schema - The object schema whose `properties` describe the record
 * @returns The filled record, empty when the schema declares no usable property
 */
export function buildSchemaRecord(schema: unknown): Record<string, MCPElicitValue> {
	const properties = isRecord(schema) ? schema['properties'] : undefined
	if (!isRecord(properties)) return {}
	return Object.fromEntries(
		Object.entries(properties).flatMap(([key, leaf]) => {
			const value = readSchemaValue(leaf)
			return value === undefined ? [] : [[key, value]]
		}),
	)
}

/**
 * Reads the schema this driver received for a listed tool other than the one being called.
 *
 * @remarks
 * A free-form object argument declares no shape the driver could compose, so the only object
 * it can supply without inventing one is an object the peer itself delivered: another listed
 * tool's `inputSchema`. The tool being called is skipped, because handing a peer back the
 * schema it sent under that same name reports nothing about what the client preserved.
 *
 * @param tools - Every tool the client listed
 * @param name - The tool being called
 * @returns The other tool's received schema, or `undefined` when the listing holds no other
 * tool
 */
export function readReceivedSchema(
	tools: readonly ToolInterface[],
	name: string,
): Readonly<Record<string, unknown>> | undefined {
	return tools.find((tool) => tool.name !== name)?.parameters
}

/**
 * Builds one tool call's arguments from that tool's own advertised schema.
 *
 * @remarks
 * Every leaf {@link buildSchemaRecord} can supply is supplied exactly as an elicitation
 * answer supplies it. A property typed `object` that declares no `properties` of its own is
 * the one leaf this adds: that is a free-form object slot, and `received` fills it verbatim.
 * An object leaf that DOES declare its own properties stays omitted, because a record the
 * driver did not compose from that leaf would contradict the shape the leaf declares.
 *
 * @param schema - The tool's advertised `inputSchema`
 * @param received - The schema to place in a free-form object slot, absent when the listing
 * offered none
 * @returns The filled argument record
 */
export function buildCallArguments(schema: unknown, received: unknown): Record<string, unknown> {
	const record: Record<string, unknown> = buildSchemaRecord(schema)
	const properties = isRecord(schema) ? schema['properties'] : undefined
	if (received === undefined || !isRecord(properties)) return record
	return {
		...record,
		...Object.fromEntries(
			Object.entries(properties)
				.filter(
					([, leaf]) =>
						isRecord(leaf) && leaf['type'] === 'object' && !isRecord(leaf['properties']),
				)
				.map(([key]) => [key, received]),
		),
	}
}

/**
 * Answers one embedded input request with the arm its method names.
 *
 * @param request - The request the peer issued under one round key
 * @returns The matching client answer
 */
export function buildInputResponse(request: MCPInputRequest): MCPInputResponse {
	if (request.method === 'roots/list') return { roots: [] }
	if (request.method === 'sampling/createMessage') {
		return {
			role: 'assistant',
			content: { type: 'text', text: 'conformance' },
			model: DRIVER_IDENTITY.name,
		}
	}
	const params = request.params
	if (params.mode === 'url') return { action: 'accept' }
	return { action: 'accept', content: buildSchemaRecord(params.requestedSchema) }
}

/**
 * Answers every key of one issued round.
 *
 * @param requests - The round the peer issued
 * @returns The answer map keyed exactly as the round was
 */
export function buildInputResponses(
	requests: MCPInputRequestMap,
): Record<string, MCPInputResponse> {
	return Object.fromEntries(
		Object.entries(requests).map(([key, request]) => [key, buildInputResponse(request)]),
	)
}

/**
 * Reads the exact calls the runner scripted for this scenario.
 *
 * @param context - The raw `MCP_CONFORMANCE_CONTEXT` value, absent for an unscripted scenario
 * @returns The scripted calls, or `undefined` when the scenario scripted none
 */
export function readScriptedCalls(
	context: string | undefined,
): readonly ConformanceCall[] | undefined {
	if (context === undefined) return undefined
	const parsed: unknown = JSON.parse(context)
	const scripted = isRecord(parsed) ? parsed['toolCalls'] : undefined
	if (!isArray(scripted)) return undefined
	return scripted.flatMap((entry) => {
		if (!isRecord(entry) || !isString(entry['name'])) return []
		const args = entry['arguments']
		return [{ name: entry['name'], arguments: isRecord(args) ? args : {} }]
	})
}

/**
 * Reports one fault to the runner without ending the run.
 *
 * @remarks
 * The exit code separates the two kinds of fault, because the runner reads a nonzero exit as
 * the client under test having failed. A peer that refuses ONE call — an unknown tool, a
 * method the scenario server never handles — has answered correctly, so that fault is
 * reported and the exit code is left alone. A fault opening, listing, or closing means the
 * client could not be driven at all, and the entry sets the nonzero exit for it.
 *
 * @param label - What was being driven when the fault surfaced
 * @param error - The fault itself
 */
export function reportFault(label: string, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error)
	process.stderr.write(`${label}: ${detail}\n`)
}

/**
 * Drives one call and, when the peer asks for another round, answer it once.
 *
 * @remarks
 * The retry maps the peer's round onto `MCPCallOptions.input`, whose `state` leaf is
 * OPTIONAL: SEP-2322 lets a peer issue a round with no `requestState`, and the retry answering
 * that round omits the parameter rather than inventing a carrier. A result carrying a carrier
 * and no requests asks nothing, so there is nothing to answer.
 *
 * @param client - The client under test
 * @param call - The call to drive
 * @returns The peer's answer to the last round issued
 */
export async function driveCall(
	client: MCPClientInterface,
	call: ConformanceCall,
): Promise<MCPCallOutcome> {
	const outcome = await client.call(call.name, call.arguments)
	if (outcome.resultType !== 'input_required') return outcome
	const state = outcome.requestState
	const requests = outcome.inputRequests
	if (requests === undefined) {
		reportFault(`retry ${call.name}`, 'the round carries no inputRequests to answer')
		return outcome
	}
	const responses = buildInputResponses(requests)
	return await client.call(call.name, call.arguments, {
		input: state === undefined ? { responses } : { state, responses },
	})
}

/** Drives the conformance runner's source-loaded client against its scenario endpoint. */
export async function executeConformanceDriver(url: string | undefined): Promise<void> {
	if (url === undefined) throw new Error('The conformance runner appends the scenario URL')

	const client = createMCPClient({
		transport: createHTTPClientTransport({ url }),
		identity: DRIVER_IDENTITY,
		capabilities: { elicitation: {}, roots: {}, sampling: {} },
	})

	try {
		await client.connect()
		const tools = await client.tools()
		const scripted = readScriptedCalls(process.env['MCP_CONFORMANCE_CONTEXT'])
		const calls =
			scripted ??
			tools.map((tool) => ({
				name: tool.name,
				arguments: buildCallArguments(tool.parameters, readReceivedSchema(tools, tool.name)),
			}))
		for (const call of calls) {
			try {
				await driveCall(client, call)
			} catch (error) {
				reportFault(`call ${call.name}`, error)
			}
		}
	} catch (error) {
		process.exitCode = 1
		reportFault('drive', error)
	}

	try {
		await client.disconnect()
	} catch (error) {
		process.exitCode = 1
		reportFault('disconnect', error)
	}
}

/** Records the server scenarios the pinned conformance runner must pass. */
export const MCP_CONFORMANCE_SERVER: readonly ConformanceScenario[] = [
	// Green since a protocol header naming a MODERN revision began holding the request to that
	// revision's own rule: a body with no parsable modern `_meta` answers -32602 rather than
	// falling through the legacy door's -32022. The two SEP-2575 checks that moved are the
	// omitted `_meta` and the `_meta` omitting `protocolVersion`. The undeclared-capability pair
	// was already green: the fixture declares a `test_missing_capability` tool whose round asks
	// for `sampling/createMessage`, and the server refuses that round -32021 over HTTP 400
	// because the call declared no capabilities.
	{ name: 'server-stateless', passed: 28, failed: 0 },
	{ name: 'completion-complete', passed: 2, failed: 0 },
	{ name: 'tools-list', passed: 3, failed: 0 },
	{ name: 'tools-call-simple-text', passed: 2, failed: 0 },
	{ name: 'tools-call-image', passed: 2, failed: 0 },
	{ name: 'tools-call-audio', passed: 2, failed: 0 },
	{ name: 'tools-call-embedded-resource', passed: 2, failed: 0 },
	{ name: 'tools-call-mixed-content', passed: 2, failed: 0 },
	{ name: 'tools-call-error', passed: 2, failed: 0 },
	{ name: 'tools-call-with-progress', passed: 2, failed: 0 },
	{ name: 'json-schema-2020-12', passed: 8, failed: 0 },
	{ name: 'server-sse-multiple-streams', passed: 2, failed: 0 },
	{ name: 'resources-list', passed: 2, failed: 0 },
	{ name: 'resources-read-text', passed: 2, failed: 0 },
	{ name: 'resources-read-binary', passed: 2, failed: 0 },
	{ name: 'resources-templates-read', passed: 2, failed: 0 },
	{ name: 'sep-2164-resource-not-found', passed: 3, failed: 0 },
	{ name: 'prompts-list', passed: 2, failed: 0 },
	{ name: 'prompts-get-simple', passed: 2, failed: 0 },
	{ name: 'prompts-get-with-args', passed: 2, failed: 0 },
	{ name: 'prompts-get-embedded-resource', passed: 2, failed: 0 },
	{ name: 'prompts-get-with-image', passed: 2, failed: 0 },
	{ name: 'dns-rebinding-protection', passed: 2, failed: 0 },
	{ name: 'caching', passed: 8, failed: 0 },
	{ name: 'http-header-validation', passed: 14, failed: 0 },
	// Green since the POST handler began validating every `Mcp-Param-*` header its OWN tool
	// definitions annotate against the call's body. The checks that moved are three refusals,
	// each counted twice — once for the HTTP 400 and once for the -32020 error code: a Base64
	// sentinel with invalid padding, one with a non-alphabet character, and an omitted header
	// for a value the body supplies. The three that were already green are the accepts — a
	// well-formed sentinel decoded and matched, and a value missing either marker read as a
	// literal.
	{ name: 'http-custom-header-server-validation', passed: 10, failed: 0 },
	// The SEP-2322 rows below all drive `MCPServerOptions.input`, whose answer is the round the
	// consumer composed: its own keys, and any mixture of the elicitation, sampling, and roots
	// kinds the client declared. The prompt arm reaches the same wire the other way — the
	// prompt port returns its own `MCPInputResult` — which is what `-non-tool-request` proves.
	{ name: 'input-required-result-basic-elicitation', passed: 3, failed: 0 },
	{ name: 'input-required-result-basic-sampling', passed: 3, failed: 0 },
	{ name: 'input-required-result-basic-list-roots', passed: 3, failed: 0 },
	{ name: 'input-required-result-request-state', passed: 3, failed: 0 },
	{ name: 'input-required-result-multiple-input-requests', passed: 3, failed: 0 },
	{ name: 'input-required-result-multi-round', passed: 4, failed: 0 },
	// Passes at 1/0: the scenario's own check is a `SHOULD`, so a retry carrying `inputResponses`
	// without a `requestState` — which this server refuses with -32602 — reports WARNING and
	// the runner tallies neither a pass nor a fail. The recorded pass is the wire-schema check.
	{ name: 'input-required-result-missing-input-response', passed: 1, failed: 0 },
	{ name: 'input-required-result-non-tool-request', passed: 3, failed: 0 },
	{ name: 'input-required-result-result-type', passed: 2, failed: 0 },
	{ name: 'input-required-result-unsupported-methods', passed: 2, failed: 0 },
	{ name: 'input-required-result-tampered-state', passed: 2, failed: 0 },
	{ name: 'input-required-result-capability-check', passed: 2, failed: 0 },
	// Passes at 1/0 for the same `SHOULD` reason as `-missing-input-response`.
	{ name: 'input-required-result-ignore-extra-params', passed: 1, failed: 0 },
	{ name: 'input-required-result-validate-input', passed: 3, failed: 0 },
]

/** Lists the server scenarios carrying a nonzero red baseline. */
export const MCP_CONFORMANCE_SERVER_RED = MCP_CONFORMANCE_SERVER.filter(
	(scenario) => scenario.failed > 0,
).map((scenario) => scenario.name)

// The recorded baseline for the runner's own CLIENT mode, driving this package's
// `createMCPClient` over `createHTTPClientTransport` through every non-auth 2026-07-28
// client scenario. `CONFORMANCE_CLIENT_SCENARIOS` names the set and records why the
// `auth/*` family is out. The reading is per scenario for the same reason the server
// baseline is: a scenario that stopped running is invisible in a total.
//
// Every row with `failed: 0` is a check the shipped client passes. Each row with a nonzero
// `failed` is a named LIBRARY gap this suite carries on purpose, and the comment above it
// is the gap. A check the runner reports at `SHOULD` level tallies as a warning instead, so
// `warnings` is recorded beside the counts rather than folded into them.
//
// A SKIPPED check tallies as neither. `http-standard-headers` declares its Mcp-Method and
// Mcp-Name checks for `initialize`, `notifications/initialized`, `resources/list`,
// `resources/read`, `prompts/list`, and `prompts/get`; `MCPClientInterface` publishes no
// method that issues any of those, so the runner reports each SKIPPED rather than failed
// and the row tallies only the `tools/list` and `tools/call` checks the client does reach.
//
// The runner also emits its own `wire-schema-valid` check, which reads every JSON-RPC message
// this client sent against the spec's JSON schema for the negotiated revision. It emits that
// check only for a scenario whose server it instruments, so `tools_call` and
// `json-schema-2020-12-preservation` carry it and every row driving raw HTTP carries none.
export const MCP_CONFORMANCE_CLIENT: readonly ConformanceOutcome[] = [
	// The row tallies the scenario's own `tool-add-numbers` check beside `wire-schema-valid`.
	// At runner 0.2.0-alpha.10 it tallied `tool-add-numbers` alone: that build emitted no
	// wire-schema check here, and the driver's own behavior on this scenario did not change.
	{ name: 'tools_call', passed: 2, failed: 0, warnings: 0 },
	{ name: 'request-metadata', passed: 8, failed: 0, warnings: 0 },
	// Green since `MCPCallOptions.input.state` became optional. The peer answers
	// `test_mrtr_no_state` with an `input_required` result carrying `inputRequests` and NO
	// `requestState`, and SEP-2322 requires the retry to answer it while omitting
	// `requestState`. While `state` was a required leaf that retry was unreachable through
	// the client's public surface, and the runner reported "Tool was not called by client or
	// MRTR flow not completed". The checks are the stateless round, the exact echo, the
	// distinct JSON-RPC id, the isolation of one call's round from another's, and the missing
	// `resultType` defaulting to complete.
	{ name: 'sep-2322-client-request-state', passed: 5, failed: 0, warnings: 0 },
	{ name: 'http-standard-headers', passed: 3, failed: 0, warnings: 0 },
	// Green since the HTTP client transports began caching each listed tool's `x-mcp-header`
	// annotations and projecting a call's own arguments onto `Mcp-Param-*` headers. The checks
	// that moved are the one asserting any header at all plus the per-parameter conversion and
	// encoding rows: a plain string literal, a decimal integer, both booleans, an empty value,
	// a name that must not collide with `Mcp-Method`, and the non-ASCII, whitespace-edged,
	// control-character, CRLF, and tab values that travel as the Base64 sentinel.
	{ name: 'http-custom-headers', passed: 18, failed: 0, warnings: 0 },
	// Green since the same transports began dropping an invalidly annotated definition from
	// the `tools/list` result they deliver: the driver calls exactly the tools the client
	// listed, so a definition the transport excluded is one the driver cannot call. The checks
	// that moved are the ten malformed definitions — an empty name, three non-primitive types,
	// two duplicate names, and four names outside the RFC 9110 token set.
	{ name: 'http-invalid-tool-headers', passed: 11, failed: 0, warnings: 0 },
	{ name: 'json-schema-ref-no-deref', passed: 1, failed: 0, warnings: 0 },
	// Green since the driver began filling a free-form object argument with another listed
	// tool's received schema. That arms the scenario's echo: the client hands `json_schema_echo`
	// the `inputSchema` it received for the focal tool, and the runner compares that against its
	// own fixture. While the echo went unanswered the preservation checks reported SKIPPED, so
	// what the client preserved was unmeasured rather than proven. The checks are the
	// `tools/list` observation, the completed echo, the `$schema`, `$defs`, and
	// `additionalProperties` rows SEP-1613 requires, the SEP-2106 composition, conditional, and
	// `$anchor` rows — which this revision reports at MUST level rather than SKIPPED — and
	// `wire-schema-valid`.
	{ name: 'json-schema-2020-12-preservation', passed: 9, failed: 0, warnings: 0 },
]

/** Lists the client scenarios carrying a nonzero red baseline. */
export const MCP_CONFORMANCE_CLIENT_RED = MCP_CONFORMANCE_CLIENT.filter(
	(outcome) => outcome.failed > 0,
).map((outcome) => outcome.name)

/** Reads executable source lines for the controller ownership proof. */
export function readProjectSource(path: string): string {
	return extractSourceLines(readFileSync(path, 'utf8'))
		.map((line) => line.code)
		.join('\n')
}

/** Describes every fence language this package's guides are allowed to use. */
export const FENCE_LANGUAGES = Object.freeze(['text', 'ts'])
/** Describes the fence language whose blocks count as worked examples. */
export const EXAMPLE_LANGUAGE = 'ts'
/** Describes the package identity that binds its manifest, module map, and README pitch. */
export const PACKAGE_NAME = '@orkestrel/mcp'
/** Describes the one guide this package sources, whose tagline the README pitch equals. */
export const GUIDE_SPEC = 'guides/mcp.md'
/** Describes each import specifier this package's own guides may resolve against. */
export const MODULES = Object.freeze({
	'@orkestrel/mcp': 'src/core',
	'@orkestrel/mcp/browser': 'src/browser',
	'@orkestrel/mcp/server': 'src/server',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
export const INTERNAL: readonly string[] = Object.freeze([
	'class HTTPLifetime',
	'class MCPConnection',
	'class MCPLegacySession',
	'class StdioLifetime',
])

/** Describes source modules that own removable legacy server ingress. */
export const LEGACY_OWNERS = Object.freeze([
	'src/core/MCPLegacy.ts',
	'src/core/factories.ts',
	'src/core/index.ts',
	'src/core/types.ts',
	'src/server/MCPSession.ts',
	'src/server/index.ts',
	'src/server/middlewares.ts',
	'src/server/types.ts',
])

/**
 * Declarations, named imports from any specifier, and barrel exports that make a module own
 * removable legacy ingress.
 */
export const LEGACY_OWNER_PATTERN =
	/\b(?:export\s+class\s+(?:MCPLegacy|MCPSession)\b|export\s+function\s+(?:createMCPLegacy|createMCPSession)\b|export\s+interface\s+(?:MCPLegacyOptions|MCPSession(?:MiddlewareOptions|Options|Interface|State|Entry|Event))\b|import(?:\s+type)?\s*\{[^}]*\b(?:MCPLegacy|MCPSession)\b[^}]*\}\s*from\s*['"][^'"]+['"]|export\s+\*\s+from\s*['"]\.\/(?:MCPLegacy|MCPSession)\.js['"])/u

/** Returns the source modules carrying a removable legacy-ingress declaration or dependency. */
export function findLegacyOwners(population: Readonly<Record<string, string>>): readonly string[] {
	return Object.entries(population)
		.filter(([path, source]) => path.startsWith('src/') && LEGACY_OWNER_PATTERN.test(source))
		.map(([path]) => path)
		.sort()
}

// ── The stdio client transport's spawn contract, executed ────────────────────
//
// A parity assertion proves a documented name resolves. It can never reach a sentence about
// behaviour, which is how `guides/mcp.md` § stdio transport carried false ones through a
// green gate: that `createStdioClientTransport` spawns through `node:child_process.spawn` with
// a provided `env` REPLACING `process.env`, and that the child's `stderr` INHERITS the parent's.
// Both are now stated the other way round in the guide, so both are executed here.
//
// One child reports what it actually received. Each transport reading is contrasted with the same
// reading taken from a raw `node:child_process.spawn` configured the way the old sentences
// described this transport — `env` replacing and `stderr` inheriting. Those controls sit outside
// this package entirely, which is what makes these assertions evidence rather than a restatement
// of the source.
//
// The host facts below decide what each control can compare:
//
// - Windows injects a host set — `PATH`, `SYSTEMROOT`, `TEMP`, `USERPROFILE`, and more — into any
//   explicit environment, so a child of a REPLACING spawn there reads its parent's own `PATH`
//   unchanged. `PATH` separates a merge from a replacement on a POSIX host alone.
//   `guides/process.md` § The child environment owns that law. What separates them on every host
//   is a key this test names itself, outside the injected set.
// - `fstat` gives a Windows anonymous pipe no file id and reports a per-process handle value as
//   `ino` instead, so two processes holding the SAME pipe read different identities and one
//   process reads a different identity for every child it hands that pipe down to. A `dev:ino`
//   comparison across a process boundary carries meaning only for a descriptor that has a file
//   id. The inherit control therefore hands its child a scratch FILE, not this process's own
//   `stderr`, which under this runner is exactly such a pipe.

/** Describes the bytes the reporting child writes to its own `stderr` before it answers. */
export const STDERR_SENTINEL = 'stderr-sentinel'

/** Describes the scratch file the inherit control hands down as its relay's `stderr`. */
export const STDERR_FILE = 'stderr.log'

/**
 * Describes one request, one JSON-RPC reply carrying what the spawned child's environment and `stderr` are.
 *
 * The kind reading masks the mode bits itself: `Stats.isFIFO()` answers `false` for a Windows
 * anonymous pipe whose mode carries `S_IFIFO`, so the derived answer is the one that travels.
 */
export const REPORT_SCRIPT = `
const readline = require('node:readline')
const { constants, fstatSync } = require('node:fs')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
	const message = JSON.parse(line)
	if (message.method !== 'report') return
	process.stderr.write(${JSON.stringify(STDERR_SENTINEL)})
	const stderr = fstatSync(2)
	process.stdout.write(JSON.stringify({
		jsonrpc: '2.0',
		id: message.id,
		result: {
			path: process.env.PATH,
			supplied: process.env.MCP_GUIDE_SUPPLIED,
			inherited: process.env.MCP_GUIDE_INHERITED,
			absent: process.env.MCP_GUIDE_ABSENT,
			stderr: String(stderr.dev) + ':' + String(stderr.ino),
			// A stdio pipe is a FIFO on some hosts and a socketpair on others: this host reports
			// S_IFSOCK for the very descriptor Node created as 'pipe'. Read the property the
			// assertion needs — a channel the supervisor made — rather than one host's spelling of
			// it. The inherit control hands down a regular file, which is neither, so the reading
			// still separates the two.
			pipe:
				(stderr.mode & constants.S_IFMT) === constants.S_IFIFO
				|| (stderr.mode & constants.S_IFMT) === constants.S_IFSOCK,
		},
	}) + '\\n')
})
`

/**
 * Describes a raw spawn whose `stdio` slot 2 is `'inherit'`, run one level down from this test.
 *
 * The relay is what makes `'inherit'` measurable. This process cannot name its own `stderr` across
 * a process boundary on every host, so it hands the relay a scratch file instead and reads that
 * file's identity back out of the grandchild `'inherit'` passes it down to.
 */
export const RELAY_SCRIPT = `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', ${JSON.stringify(REPORT_SCRIPT)}], {
	stdio: ['pipe', 'pipe', 'inherit'],
})
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
`

/** Describes the `env` this guide's claim is about: one key the parent does not carry. */
export const SUPPLIED_ENVIRONMENT = Object.freeze({ MCP_GUIDE_SUPPLIED: 'supplied' })

/** Describes the key this process carries and never supplies, so only a merge can put it in a child. */
export const INHERITED = Object.freeze({ key: 'MCP_GUIDE_INHERITED', value: 'inherited' })

export function readReport(value: unknown): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) throw new Error('The child returned no JSON-RPC envelope')
	const result = value['result']
	if (!isRecord(result)) throw new Error('The child returned no result record')
	return result
}

/** Describes the identity `fstat` reports for one descriptor, in the shape the reporting child reports it. */
export function readDescriptorIdentity(descriptor: number): string {
	const stat = fstatSync(descriptor)
	return `${String(stat.dev)}:${String(stat.ino)}`
}

export async function reportThroughTransport(): Promise<GuideChildReport> {
	const transport = createStdioClientTransport({
		command: process.execPath,
		args: ['-e', REPORT_SCRIPT],
		env: SUPPLIED_ENVIRONMENT,
	})
	const arrived = new Promise<JSONRPCMessage>((resolve) => {
		transport.emitter.on('message', resolve)
	})
	try {
		await transport.start()
		await transport.send({ jsonrpc: '2.0', id: 1, method: 'report' })
		const message = await waitForSettlement(
			arrived,
			10_000,
			'Timed out waiting for the spawned child report',
		)
		return readReport(message)
	} finally {
		await transport.close()
	}
}

/**
 * Drives the reporting child and answer the tail its transport retained, read after `close()`.
 *
 * The child writes {@link STDERR_SENTINEL} to its own `stderr` before it answers, so the reading is
 * taken after the sentinel has arrived rather than at whatever moment the reply happened to land.
 */
export async function readEvidenceThroughTransport(): Promise<string | undefined> {
	const transport = createStdioClientTransport({
		command: process.execPath,
		args: ['-e', REPORT_SCRIPT],
		env: SUPPLIED_ENVIRONMENT,
	})
	const arrived = new Promise<JSONRPCMessage>((resolve) => {
		transport.emitter.on('message', resolve)
	})
	try {
		await transport.start()
		await transport.send({ jsonrpc: '2.0', id: 1, method: 'report' })
		await waitForSettlement(arrived, 10_000, 'Timed out waiting for the spawned child report')
		await waitForCondition(
			'the reporting child stderr sentinel reaches the transport evidence',
			() => transport.evidence?.includes(STDERR_SENTINEL) === true,
			{ budget: 10_000 },
		)
	} finally {
		await transport.close()
	}
	return transport.evidence
}

/** Returns the tail retained for the same child left unasked, so it writes no `stderr` at all. */
export async function readSilentEvidenceThroughTransport(): Promise<string | undefined> {
	const transport = createStdioClientTransport({
		command: process.execPath,
		args: ['-e', REPORT_SCRIPT],
		env: SUPPLIED_ENVIRONMENT,
	})
	try {
		await transport.start()
	} finally {
		await transport.close()
	}
	return transport.evidence
}

/** Drives one raw-spawn control through its stdout pipe and read back the one report line. */
export type GuideChildReport = Readonly<Record<string, unknown>>

export async function readSpawnReport(child: ChildProcess): Promise<GuideChildReport> {
	const stdout = child.stdout
	const stdin = child.stdin
	if (stdout === null || stdin === null) throw new Error('The control child has no stdio pipes')
	try {
		const buffer = new MCPFixtureCell('')
		const line = new Promise<string>((resolve) => {
			stdout.setEncoding('utf8')
			stdout.on('data', (chunk: string) => {
				buffer.value += chunk
				const newline = buffer.value.indexOf('\n')
				if (newline !== -1) resolve(buffer.value.slice(0, newline))
			})
		})
		stdin.write('{"jsonrpc":"2.0","id":1,"method":"report"}\n')
		const text = await waitForSettlement(
			line,
			10_000,
			'Timed out waiting for the control child report',
		)
		return readReport(JSON.parse(text))
	} finally {
		child.kill()
	}
}

/**
 * Describes the environment control: a raw spawn whose `env` REPLACES `process.env`.
 *
 * Its `stderr` is dropped because the reporting child writes a sentinel there and this control
 * makes no claim about that descriptor. The inherit control owns that claim.
 */
export async function reportThroughReplacingSpawn(): Promise<GuideChildReport> {
	return await readSpawnReport(
		spawn(process.execPath, ['-e', REPORT_SCRIPT], {
			env: { ...SUPPLIED_ENVIRONMENT },
			stdio: ['pipe', 'pipe', 'ignore'],
		}),
	)
}

/** Describes the `stderr` control: a raw spawn that INHERITS the descriptor this test handed its relay. */
export async function reportThroughInheritingSpawn(descriptor: number): Promise<GuideChildReport> {
	return await readSpawnReport(
		spawn(process.execPath, ['-e', RELAY_SCRIPT], { stdio: ['pipe', 'pipe', descriptor] }),
	)
}

// ── The flagship stdio composition, executed ─────────────────────────────────
//
// `guides/mcp.md` § stdio transport wires `createStdioServer(createMCPLegacy(mcp)).start()` and
// its trailing comment claims two things: that the composition answers `initialize`, and that
// passing `mcp` alone subtracts exactly that. Parity proves both names resolve and neither
// sentence. So the fence's composition is transcribed here and driven over the injectable stream
// pair the same factory documents — the same dispatcher value, reached through the same call.
//
// The bare dispatcher is the control, and it is the comment's own subtraction: it sits outside
// the decorated population, and it answers the refusal the modern seam owes an unregistered
// method instead of a handshake.

/** Describes the dated handshake a legacy MCP client opens with, framed as the transport frames it. */
export const LEGACY_INITIALIZE =
	'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"guide","version":"1.0.0"}}}'

/** Describes a legacy-only stdio peer that answers the adapter handshake and refuses other requests. */
export const LEGACY_PEER_SCRIPT = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
	const message = JSON.parse(line)
	if (message.id === undefined) return
	const response = message.method === 'initialize'
		? {
				jsonrpc: '2.0',
				id: message.id,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: { tools: {} },
					serverInfo: { name: 'legacy-peer', version: '1.0.0' },
				},
			}
		: {
				jsonrpc: '2.0',
				id: message.id,
				error: { code: -32601, message: 'Method not found: ' + message.method },
			}
	process.stdout.write(JSON.stringify(response) + '\\n')
})
`

/** Reads one newline-framed reply off a stdio server's injected output stream. */
export async function readStdioReply(output: PassThrough): Promise<unknown> {
	const buffer = new MCPFixtureCell('')
	const line = new Promise<string>((resolve) => {
		output.setEncoding('utf8')
		output.on('data', (chunk: string) => {
			buffer.value += chunk
			const newline = buffer.value.indexOf('\n')
			if (newline !== -1) resolve(buffer.value.slice(0, newline))
		})
	})
	const text = await waitForSettlement(line, 10_000, 'Timed out waiting for the stdio server reply')
	return JSON.parse(text)
}

/** Drives one framed request through a `createStdioServer` pump over injected streams. */
export async function driveStdioServer(
	mcp: MCPDispatcherInterface,
	request: string,
): Promise<unknown> {
	const input = new PassThrough()
	const output = new PassThrough()
	const stdio = createStdioServer(mcp, { input, output })
	stdio.start()
	try {
		const reply = readStdioReply(output)
		input.write(`${request}\n`)
		return await reply
	} finally {
		stdio.stop()
	}
}

/** Describes the fence's own server: the docs identity over an empty tool registry. */
export function createGuideServer(): ReturnType<typeof createMCPServer> {
	return createMCPServer({
		identity: { name: 'docs', version: '1.0.0' },
		tools: createToolManager(),
	})
}

/** Drives the fence's consumer-side adapter over a spawned legacy stdio peer. */
export async function readGuideClientVersion(): Promise<string | undefined> {
	const carrier = createStdioClientTransport({
		command: process.execPath,
		args: ['-e', LEGACY_PEER_SCRIPT],
	})
	const client = createMCPClient({
		transport: createMCPLegacyClientTransport(carrier, { timeout: 10_000 }),
		timeout: 10_000,
	})
	try {
		await client.connect()
		return client.version
	} finally {
		await client.disconnect()
	}
}

// ── The client subscription fence, executed ──────────────────────────────────
//
// `guides/mcp.md` § Consume a subscription from a client claims an ORDER and a SHAPE: the
// acknowledgement is the first YIELD, every stamped frame follows it in wire order, and the
// graceful terminal is the generator's RETURN value rather than a yield. Parity proves that
// `listen` exists and proves no sentence about what it delivers. So the fence's reads are
// transcribed here and driven against a real in-process `MCPServer` over the duplex loopback —
// the carrier the same section names as the one that delivers incrementally.
//
// Membership rule of the instrument: a notification carrying this subscription's reserved id
// enters the stream, and one carrying no id does not. Both are injected through the SAME
// transport door while the subscription is live, so the negative reading reports on the
// stamping rather than on a delivery path that was dead. A route that claimed every inbound
// notification would satisfy every ordering assertion here and fail the membership row.

/** Describes the honoured families the fence's filter names, as its own fence spells them. */
export const GUIDE_SUBSCRIPTION_FILTER = Object.freeze({
	promptsListChanged: true,
	resourceSubscriptions: Object.freeze(['resource://guide']),
})

/** Describes the unstamped server notification that must stay outside the subscription stream. */
export const GUIDE_UNSTAMPED_NOTIFICATION: JSONRPCNotification = {
	jsonrpc: '2.0',
	method: 'notifications/message',
	params: { level: 'info', data: 'outside every subscription' },
}

/** Describes what one run of the fence's reads observed, in the order the fence reads them. */
export interface GuideSubscriptionReading {
	readonly opened: IteratorResult<JSONRPCNotification, MCPSubscriptionResult>
	/** Describes the method the fence reads behind its `opened.done === false` guard. */
	readonly acknowledged: string | undefined
	readonly frames: readonly string[]
	readonly closure: MCPSubscriptionResult | undefined
	readonly proven: boolean
	readonly unstamped: readonly string[]
}

/** Reports the id the client minted for its `subscriptions/listen` request. */
export function findListenId(messages: readonly JSONRPCMessage[]): JSONRPCId | undefined {
	for (const message of messages) {
		if (!('method' in message) || message.method !== 'subscriptions/listen') continue
		if ('id' in message) return message.id
	}
	return undefined
}

/** Drives the fence's `listen` reads against a real subscription server over the loopback. */
export async function readGuideSubscription(): Promise<GuideSubscriptionReading> {
	const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
	const transport = createLoopbackTransport(
		createSubscriptionServer(() => source.readable, GUIDE_SUBSCRIPTION_FILTER),
	)
	const client = createMCPClient({ transport })
	const unstamped: string[] = []
	client.emitter.on('notification', (message) => {
		if ('method' in message) unstamped.push(message.method)
	})
	await client.connect()

	const subscription = new AbortController()
	const stream = client.listen(GUIDE_SUBSCRIPTION_FILTER, {
		signal: subscription.signal,
		capacity: 16,
	})
	const opened = await stream.next()
	// The fence's own narrowing, transcribed: the member read sits behind `opened.done === false`,
	// so a run where the first read is not a yield reports no method rather than reading one.
	const acknowledged = opened.done === false ? opened.value.method : undefined

	// Both injections ride the same transport door, while the subscription is live: the stamped
	// one must enter the stream and the unstamped one must not.
	transport.receive({
		jsonrpc: '2.0',
		method: 'notifications/prompts/list_changed',
		params: { _meta: { [MCP_META_SUBSCRIPTION]: findListenId(transport.messages) } },
	})
	transport.receive(GUIDE_UNSTAMPED_NOTIFICATION)
	const frames: string[] = []
	const injected = await stream.next()
	if (injected.done === false) frames.push(injected.value.method)

	// The fence's own shape: one read per frame, so the consumer is parked when each arrives.
	const writer = source.writable.getWriter()
	await writer.write({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' })
	const prompts = await stream.next()
	if (prompts.done === false) frames.push(prompts.value.method)
	await writer.write({
		jsonrpc: '2.0',
		method: 'notifications/resources/updated',
		params: { uri: 'resource://guide' },
	})
	const resources = await stream.next()
	if (resources.done === false) frames.push(resources.value.method)
	await writer.close()

	const terminal = await stream.next()
	const closure = terminal.done === true ? terminal.value : undefined
	subscription.abort()
	await client.disconnect()
	return {
		opened,
		acknowledged,
		frames,
		closure,
		proven: isMCPSubscriptionResult(closure),
		unstamped,
	}
}

/** Describes what the method row's progress-before-discard sentence observed. */
export interface GuideProgressReading {
	readonly progress: readonly unknown[]
	readonly notifications: readonly string[]
}

/** Drives active progress and unclaimed stale stamps through the same client transport door. */
export async function readGuideProgressClaim(): Promise<GuideProgressReading> {
	const release = Promise.withResolvers<void>()
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'slow',
			execute: async () => {
				await release.promise
				return 'done'
			},
		}),
	)
	const transport = createLoopbackTransport(
		createMCPServer({ identity: { name: 'progress-server', version: '1.0.0' }, tools }),
	)
	const client = createMCPClient({ transport })
	const progress: unknown[] = []
	const notifications: string[] = []
	client.emitter.on('notification', (message) => {
		if ('method' in message) notifications.push(message.method)
	})
	await client.connect()

	const call = client.call('slow', {}, { progress: (report) => progress.push(report) })
	const id = transport.messages.find((message) => message.method === 'tools/call')?.id
	if (id === undefined) throw new Error('Expected the guide call to carry an id')
	transport.receive({
		jsonrpc: '2.0',
		method: 'notifications/progress',
		params: {
			progressToken: id,
			progress: 1,
			_meta: { [MCP_META_SUBSCRIPTION]: 9_999 },
		},
	})
	transport.receive({
		jsonrpc: '2.0',
		method: 'notifications/custom',
		params: { _meta: { [MCP_META_SUBSCRIPTION]: 9_999 } },
	})
	transport.receive({
		jsonrpc: '2.0',
		method: 'notifications/progress',
		params: {
			progressToken: 8_888,
			progress: 2,
			_meta: { [MCP_META_SUBSCRIPTION]: 9_999 },
		},
	})
	await Promise.resolve()
	release.resolve()
	await call
	await client.disconnect()
	return { progress, notifications }
}

/** Describes what one run of the section's bad-`capacity` clause observed. */
export interface GuideCapacityReading {
	/** Describes the reason the first read rejected with, or `undefined` when that read resolved. */
	readonly refusal: unknown
	/** Describes every method the transport carried up to and including that read. */
	readonly methods: readonly string[]
}

/** Drives the capacity clause: a `capacity` below one fails the first read, before any write. */
export async function readGuideCapacityRefusal(): Promise<GuideCapacityReading> {
	const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
	const transport = createLoopbackTransport(
		createSubscriptionServer(() => source.readable, GUIDE_SUBSCRIPTION_FILTER),
	)
	const client = createMCPClient({ transport })
	await client.connect()

	const stream = client.listen(GUIDE_SUBSCRIPTION_FILTER, {
		signal: new AbortController().signal,
		capacity: 0,
	})
	// The read is settled rather than awaited: the clause's subject is WHICH way it settles.
	const [read] = await Promise.allSettled([stream.next()])
	const methods = transport.messages.map((message) => message.method)
	await client.disconnect()
	return { refusal: read.status === 'rejected' ? read.reason : undefined, methods }
}

/** Describes the families the burst reading asks for and the server honours, so every write matches. */
export const BURST_SUBSCRIPTION_FILTER = Object.freeze({
	promptsListChanged: true,
	resourcesListChanged: true,
})

/** Describes the frames the burst reading writes before it reads anything, in wire order. */
export const BURST_METHODS = Object.freeze([
	'notifications/prompts/list_changed',
	'notifications/prompts/list_changed',
	'notifications/resources/list_changed',
])

/** Writes every frame before the first read — the burst the bounded queue exists to retain. */
export async function readBurstSubscription(): Promise<readonly string[]> {
	const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
	const transport = createLoopbackTransport(
		createSubscriptionServer(() => source.readable, BURST_SUBSCRIPTION_FILTER),
	)
	const client = createMCPClient({ transport })
	await client.connect()
	const subscription = new AbortController()
	const stream = client.listen(BURST_SUBSCRIPTION_FILTER, { signal: subscription.signal })
	await stream.next()

	const writer = source.writable.getWriter()
	for (const method of BURST_METHODS) await writer.write({ jsonrpc: '2.0', method })
	await writer.close()

	const frames: string[] = []
	for (;;) {
		const frame = await stream.next()
		if (frame.done === true) break
		frames.push(frame.value.method)
	}
	subscription.abort()
	await client.disconnect()
	return frames
}

/** Drives the fence verbatim: bind both halves, connect, and read what `call` resolves to. */
export async function readGuideBoundCall(): Promise<MCPCallOutcome> {
	const serverSide = createMemoryTransport()
	const clientSide = createMemoryTransport()
	serverSide.connect(clientSide)
	clientSide.connect(serverSide)

	const tools = createToolManager()
	tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
	const server = createMCPServer({ identity: { name: 'calculator', version: '1.0.0' }, tools })
	bindServer(server, serverSide)

	const client = createMCPClient({ transport: createDuplexClientTransport(clientSide) })
	const unbind = bindClient(client, clientSide)
	await client.connect()
	const outcome = await client.call('add', { x: 2, y: 5 })
	unbind()
	return outcome
}

// The fence names the value its binding holds, and `call` resolves an MCPCallOutcome rather than
// the bare result — so the comment is executed here instead of read, and it reddens the moment
// the documented shape and the resolved shape disagree.

/** Drives the refresh fence against a real subscription and serialized duplex pair. */

export function createHeaderRequest(headers: Readonly<Record<string, string>>): Request {
	return new Request('http://localhost/mcp', { method: 'POST', headers })
}

export function buildSessionMessage(n: number): JSONRPCMessage {
	return createJSONRPCRequest({ method: 'notifications/message', id: n })
}

export class SessionStreamRecorder implements StreamInterface {
	readonly response = new Response(null)
	readonly #recorder = createRecorder<readonly [SSEMessage]>()
	#closed = false

	get closed(): boolean {
		return this.#closed
	}

	get writes(): readonly SSEMessage[] {
		return this.#recorder.calls.map(([event]) => event)
	}

	write(event: SSEMessage): boolean {
		if (this.#closed) return false
		this.#recorder.handler(event)
		return true
	}

	comment(): void {}

	drain(): Promise<void> {
		return Promise.resolve()
	}

	end(): void {
		this.#closed = true
	}
}

export async function* createServerReplyStream(): MCPStream {
	yield STREAM_NOTIFICATION
	return STREAM_TERMINAL
}

export async function* createServerFaultStream(): MCPStream {
	yield STREAM_NOTIFICATION
	throw new Error('producer boom')
}

export function createHeaderCarrier(headers?: Record<string, string>): Request {
	return new Request('http://localhost/mcp', headers !== undefined ? { headers } : {})
}

export const STREAM_NOTIFICATION: JSONRPCNotification = Object.freeze({
	jsonrpc: '2.0',
	method: 'notifications/progress',
})

export const STREAM_TERMINAL: JSONRPCResponse = Object.freeze({
	jsonrpc: '2.0',
	id: 1,
	result: { done: true },
})

export interface TestStackInterface {
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
	http(version?: MCPLegacyVersion): MCPClientInterface
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

export interface TestStackOptions {
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

export function sumArguments(args: Readonly<Record<string, unknown>>): number {
	const left = args['left']
	const right = args['right']
	if (typeof left !== 'number' || typeof right !== 'number') {
		throw new Error('sum takes two numbers')
	}
	return left + right
}

export function raiseFault(): never {
	throw new Error(FAULT_MESSAGE)
}

export function createRegistry(): ToolManagerInterface {
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

export async function startStack(options?: TestStackOptions): Promise<TestStackInterface> {
	const { createMessagePortTransport } = await import('@src/browser')
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
				transport:
					version === undefined
						? transport
						: createMCPLegacyClientTransport(transport, { version }),
			})
			clients.push(client)
			return client
		},
		socket() {
			const client = createMCPClient({
				transport: createNodeWebSocketClientTransport({ url: `${base}/mcp` }),
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

export const SUM_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
	type: 'object',
	properties: Object.freeze({
		left: Object.freeze({ type: 'number' }),
		right: Object.freeze({ type: 'number' }),
	}),
})

export const FAULT_MESSAGE = 'the tool refused the call'

/** Describes the running Node fixture exposed to the browser project's global setup. */
export interface BrowserFixtureInterface {
	/** The fixture's loopback HTTP origin. */
	readonly base: string
	/** Stop the listener and release all server resources. */
	stop(): Promise<void>
}

/** Creates the intentionally malformed JSON response used by the HTTP error-path test. */
export function createBrokenResponse(): Response {
	return new Response('not valid json', {
		status: 500,
		headers: { 'content-type': 'application/json' },
	})
}

/** Lets the real browser page reach the external HTTP fixture, including session requests. */
export async function applyBrowserCORS(
	request: Request,
	_context: MiddlewareContext<MCPSessionState>,
	next: NextFunction,
): Promise<Response> {
	const requestOrigin = request.headers.get('origin')
	const origin = requestOrigin === null ? '*' : resolveOrigin([requestOrigin], requestOrigin)
	if (origin === undefined) return new Response(null, { status: 403 })
	if (request.method === 'OPTIONS') {
		const headers = new Headers({
			'access-control-allow-origin': origin,
			'access-control-allow-methods': 'POST, OPTIONS',
			vary: 'Origin',
		})
		const requestedHeaders = request.headers.get('access-control-request-headers')
		if (requestedHeaders !== null) {
			headers.set('access-control-allow-headers', requestedHeaders)
		}
		if (request.headers.get('access-control-request-private-network') === 'true') {
			headers.set('access-control-allow-private-network', 'true')
		}
		return new Response(null, {
			status: 204,
			headers,
		})
	}
	const response = await next()
	response.headers.set('access-control-allow-origin', origin)
	response.headers.set('access-control-expose-headers', MCP_SESSION_HEADER)
	response.headers.set('vary', mergeVary(response.headers.get('vary') ?? undefined, 'Origin'))
	return response
}

/**
 * Answers with every frame a fixture's recorder holds and clears the log.
 *
 * @remarks
 * The drain is what this fixture adds over the recorder: it builds the HTTP response the
 * browser project reads the frames back through, and leaves the log empty behind it.
 *
 * @param recorder - The frame log of the fixture that serves `/recorded`
 * @returns The recorded frames as a JSON array, leaving the log empty
 */
export function drainRecorded(recorder: RecorderInterface<readonly [string]>): Response {
	const frames = recorder.calls.map(([text]) => text)
	recorder.clear()
	return Response.json(frames)
}

/**
 * Answers a POST with the MCP headers it actually carried across the wire.
 *
 * @remarks
 * A protocol-faithful peer for ONE claim: what the far end received. The answer is a real
 * `JSONRPCResultResponse` correlated by the request's own id, so the client transport under
 * test decodes and emits it exactly as it decodes any other reply — the observation travels
 * the same path the claim is about. An absent header is OMITTED rather than sent as `null`,
 * so the assertion reads the same shape the projector produces.
 *
 * @param request - The POST whose headers a browser-side scenario is asserting about
 * @returns The derived MCP headers as a JSON-RPC result
 */
export async function echoHeaders(request: Request): Promise<Response> {
	const body: unknown = await request.json()
	const id = isRecord(body) && isJSONRPCId(body['id']) ? body['id'] : 0
	const protocol = request.headers.get(MCP_PROTOCOL_VERSION_HEADER)
	const name = request.headers.get(MCP_NAME_HEADER)
	return Response.json(
		buildJSONRPCResult(id, {
			...(protocol === null ? {} : { protocol }),
			method: request.headers.get(MCP_METHOD_HEADER) ?? '',
			...(name === null ? {} : { name }),
		}),
	)
}

/**
 * Creates the middleware that records every JSON-RPC body POSTed to the fixture before the
 * route handles it.
 *
 * @remarks
 * The middleware reads a clone of the request, so the route still reads its body.
 *
 * @param recorder - The frame log of the fixture that registers the middleware
 * @returns The middleware that records each POST body, then answers with the rest of the chain
 */
export function createInboundRecorder(
	recorder: RecorderInterface<readonly [string]>,
): MiddlewareHandler<MCPSessionState> {
	return async (request, _context, next) => {
		if (request.method === 'POST') recorder.handler(await request.clone().text())
		return next()
	}
}

/**
 * Creates the recording WebSocket peer — the REAL server on a REAL socket, with the
 * inbound wire tapped.
 *
 * @remarks
 * `/mcp` is the untapped endpoint every other scenario uses. This one binds the SAME
 * `MCPServer` through the SAME `bindServer` over the SAME `WebSocketServerTransport`, and
 * additionally subscribes a recorder to the socket's own `message` event — a second
 * listener on a real `EventTarget`, not a substitute for one. A browser-side claim that
 * the peer received a client-initiated notification is then readable from `/recorded`.
 *
 * @param mcp - The MCP server every accepted connection is bound to
 * @param recorder - The frame log of the fixture that registers the handler
 * @returns The upgrade handler to register for the `/record` path
 */
export function createRecordingWebSocketHandler(
	mcp: MCPServerInterface,
	recorder: RecorderInterface<readonly [string]>,
): UpgradeHandler {
	return (request, socket, head) => {
		if (upgradeRequestPath(request) !== '/record') return false
		const upgrade = request.headers['upgrade']
		const key = request.headers['sec-websocket-key']
		if (!isString(upgrade) || upgrade.toLowerCase() !== 'websocket' || !isString(key)) {
			return false
		}
		const webSocket = createNodeWebSocket({
			socket,
			key,
			head,
			protocol: MCP_WEBSOCKET_SUBPROTOCOL,
		})
		webSocket.emitter.on('message', recorder.handler)
		const transport = new WebSocketServerTransport(webSocket)
		bindServer(mcp, createDuplexServerTransport(transport))
		void transport.start()
		return true
	}
}

/** Creates raw WebSocket endpoints for peer-close and malformed-frame browser tests. */
export function createRawWebSocketHandler(): UpgradeHandler {
	return (request, socket, head) => {
		const path = upgradeRequestPath(request)
		if (path !== '/close' && path !== '/malformed') return false
		const upgrade = request.headers['upgrade']
		const key = request.headers['sec-websocket-key']
		if (!isString(upgrade) || upgrade.toLowerCase() !== 'websocket' || !isString(key)) {
			return false
		}
		const webSocket = createNodeWebSocket({ socket, key, head })
		if (path === '/close') {
			setTimeout(() => webSocket.close(), 20)
		} else {
			setTimeout(() => webSocket.send('not valid json-rpc'), 20)
		}
		return true
	}
}

/**
 * Starts the real MCP HTTP/session/WebSocket fixture on an ephemeral loopback port.
 *
 * @returns The fixture base URL and its complete teardown
 */
export async function startBrowserFixture(): Promise<BrowserFixtureInterface> {
	const mcp = createCalculatorServer()
	// The browser project cannot see inside this process, so a claim about what the peer
	// received is read back over the wire from `/recorded`. Each fixture owns its log, because
	// the Node `setup` project shares one module graph across the files a worker runs.
	const recorder = createRecorder<readonly [string]>()
	// applyBrowserCORS is a permissive test double: it approves every requesting Origin, so
	// this fixture explicitly delegates the built-in enforcement sites to that upstream layer.
	const origin: MCPOriginOptions = { enabled: false }
	const dispatcher = createDispatcher<MCPSessionState>()
	// A legacy client's `initialize` succeeds only through the legacy dispatcher, and the session
	// middleware mints a session only for a successful `initialize`.
	dispatcher.add(createMCPRoutes<MCPSessionState>(createMCPLegacy(mcp), { origin }))
	dispatcher.add({
		method: 'POST',
		path: '/broken',
		name: 'broken',
		handler: createBrokenResponse,
	})
	dispatcher.add({
		method: 'POST',
		path: '/headers',
		name: 'headers',
		handler: echoHeaders,
	})
	dispatcher.add({
		method: 'GET',
		path: '/recorded',
		name: 'recorded',
		handler: () => drainRecorded(recorder),
	})
	const server = createServer<MCPSessionState>({
		dispatcher,
		state: () => ({}),
		host: '127.0.0.1',
	})
	server.use(applyBrowserCORS)
	server.use(createInboundRecorder(recorder))
	server.use(createMCPSession<MCPSessionState>({ origin }))
	server.upgrade(createWebSocketServer(mcp, { emitter: server.emitter }))
	server.upgrade(createRecordingWebSocketHandler(mcp, recorder))
	server.upgrade(createRawWebSocketHandler())
	const port = await server.start()
	return {
		base: `http://127.0.0.1:${port}`,
		async stop() {
			await server.stop()
			await server.destroy()
		},
	}
}

export const FACE: SourceInterface = createSource({
	files: {
		'lib/index.ts': "export * from './parsers.js'\n",
		'lib/parsers.ts': 'export function parse(text: string): string {\n\treturn text\n}\n',
		'lib/hidden.ts': 'export function hidden(): void {}\n',
	},
	module: 'lib',
})

export const SOURCES: ReadonlyMap<string, SourceInterface> = new Map([['@scope/lib', FACE]])

export const LAST_RESORT_CONTROLLER = [
	"import type { MCPStream } from './types.js'",
	'export class MCPStreamController {',
	'\treadonly #graves = new FinalizationRegistry((stop: () => void) => stop())',
	'\t#arm(source: MCPStream): void {',
	'\t\tthis.#graves.register(source, () => this.stop())',
	'\t\tsetTimeout(() => this.stop(), 60_000)',
	'\t}',
	'\tstop(): void {}',
	'}',
].join('\n')

export const OWNERSHIP_SOURCES: readonly string[] = Object.freeze([
	'src/core/MCPStreamController.ts',
	'src/core/MCPTextStreamController.ts',
])
