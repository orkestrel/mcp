// Server-test setup — node-only helpers, loaded after `setup.ts` for the node `guides`
// (and `src:server`) projects. `node:*` imports belong here, never in `setup.ts`
// (AGENTS §16.1).

import type { IncomingMessage } from 'node:http'
import type { ServerInterface } from '@orkestrel/server'
import type { WebSocketFrame } from '@orkestrel/websocket'
import type { MCPServerInterface } from '@src/core'
import { request as httpRequest } from 'node:http'
import { Duplex, PassThrough } from 'node:stream'
import { afterEach } from 'vitest'
import { createMCPServer } from '@src/core'
import { createTool, createToolManager } from '@orkestrel/agent'
import { parseWebSocketFrame } from '@orkestrel/websocket'

// ── HTTP request stub (the §14 boundary-narrowing pattern) ───────────────────
//
// AGENTS §16.1: the minimal `IncomingMessage` stub the pure node-only http readers build
// on — only the fields a reader touches (`url` / `method` / `headers` / `socket`),
// crossed into the parameter through a structural guard (never an `as`, §14).

/**
 * A structural guard narrowing an `unknown` stub to {@link
 * import('node:http').IncomingMessage} — the readers only read `url` / `method` /
 * `headers` (and, for the peer IP, `socket`), so a partial shape carrying `headers`
 * crosses the boundary through this guard with no assertion (AGENTS §14).
 *
 * @param value - The candidate stub
 * @returns Whether `value` is shaped enough to stand in for an `IncomingMessage`
 */
export function isIncomingMessage(value: unknown): value is IncomingMessage {
	return typeof value === 'object' && value !== null && 'headers' in value
}

/**
 * Build a minimal `node:http`-shaped request stub for the pure request readers (AGENTS
 * §16.1) — only the fields each reader touches, defaulting `headers` / `socket` to empty
 * so `upgradeRequestPath` and a peer-IP read both have something to read. Crosses into
 * the `IncomingMessage` parameter through {@link isIncomingMessage} (no `as`, §14).
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

// ── In-memory WebSocket Duplex pair (the RFC 6455 wire + transport tests) ────
//
// AGENTS §16.1: the cross-wired in-memory `node:stream` Duplex PAIR the WebSocket
// transport tests drive — a REAL bidirectional socket (two PassThroughs, one per
// direction), NOT a mock (§16). `duplexPair` makes a `[server, client]`; `flushSocket`
// waits for synchronous frame writes to propagate across the pair; `readClientFrames`
// is the inverse of what a server writes (strip the 101 handshake, then decode every
// complete frame off the running buffer).

// One endpoint of a cross-wired in-memory socket pair: a real `Duplex` whose writes
// forward into the partner's inbound `PassThrough` and whose reads drain its OWN
// inbound one. Two of these, sharing each other's channel, form a genuine bidirectional
// stream — bytes written to one arrive as `data` on the other — exercising real Node
// stream I/O without a socket or a mock (AGENTS §16). Module-private (the runtime-
// self-contained §5 analogue: a test-only stream shim with no standalone reuse beyond
// `duplexPair`); the pair factory is the surface.
class DuplexEnd extends Duplex {
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
 * Create a cross-wired in-memory `node:stream` Duplex PAIR — a real bidirectional
 * socket for the WebSocket transport tests (AGENTS §16.1). The server end gets `[0]`,
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
	const client = new DuplexEnd(toClient, toServer)
	server.on('error', () => {})
	client.on('error', () => {})
	return [server, client]
}

/**
 * Resolve on the socket pair's next tick or two — long enough for synchronous frame
 * writes to propagate through the {@link duplexPair} PassThroughs (AGENTS §16.1).
 * Deterministic (no real timer dependence on load), so a WebSocket test awaits it after
 * a `send` rather than polling.
 *
 * @returns A promise resolving after two `setImmediate` ticks
 */
export function flushSocket(): Promise<void> {
	return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

/**
 * Collect a {@link duplexPair} client end's incoming frames — FIRST stripping the
 * server's HTTP `101` handshake response (the leading text up to `\r\n\r\n`), THEN
 * decoding every complete frame off the running buffer with `@orkestrel/websocket`'s
 * `parseWebSocketFrame` (AGENTS §16.1). The real client reader: the inverse of what a
 * server-mode wrapper writes (handshake then frames). The returned `frames` array grows
 * as the server sends.
 *
 * @param client - The client end of a {@link duplexPair}
 * @returns A handle whose `frames` accumulates each decoded {@link WebSocketFrame}
 */
export function readClientFrames(client: Duplex): { readonly frames: readonly WebSocketFrame[] } {
	const frames: WebSocketFrame[] = []
	let buffer = Buffer.alloc(0)
	let handshook = false
	const end = Buffer.from('\r\n\r\n')
	client.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk])
		if (!handshook) {
			const index = buffer.indexOf(end)
			if (index === -1) return // handshake not fully arrived yet
			buffer = buffer.subarray(index + end.length)
			handshook = true
		}
		for (;;) {
			const frame = parseWebSocketFrame(buffer)
			if (frame === undefined) break
			buffer = buffer.subarray(frame.consumed)
			frames.push(frame)
		}
	})
	return { frames }
}

// ── Teardown registrar (tracked-resource cleanup) ─────────────────────────────
//
// AGENTS §16.1: the duplicated `const tracked = []` + `afterEach(dispose-all)` +
// `track(item)` trio every node-resource suite hand-rolls — folded into one registrar.
// The caller supplies the disposer (`h => h.stop()`); the registrar holds the tracked
// list AND wires its OWN `afterEach` to dispose every tracked item (awaiting async
// disposers), so no socket leaks across a suite. A real cleanup wiring, not a mock.

/** A tracked-resource teardown registrar — see {@link createTeardown}. */
export interface TeardownInterface<T> {
	/** Register `item` for disposal at `afterEach`, returning it for inline use. */
	track<U extends T>(item: U): U
}

/**
 * Create a {@link TeardownInterface} that disposes every tracked item after each test —
 * the one general form of the `tracked[]` + `afterEach` + `track` pattern the server
 * suites repeat (AGENTS §16.1). Call it at a suite's top level: it registers its OWN
 * `afterEach` immediately, draining the tracked list and running `dispose` on each item
 * (awaiting a returned promise), so a started server is `stop()`ed even when an
 * assertion throws mid-test. The disposer is the caller's (`(handle) => handle.stop()`),
 * so the registrar stays agnostic to what it tears down.
 *
 * @typeParam T - The kind of item tracked (the disposer's parameter type)
 * @param dispose - How to dispose one tracked item (may be async)
 * @returns A registrar whose `track` enrolls an item and returns it
 */
export function createTeardown<T>(
	dispose: (item: T) => void | Promise<void>,
): TeardownInterface<T> {
	const tracked: T[] = []
	afterEach(async () => {
		for (const item of tracked.splice(0)) await dispose(item)
	})
	return {
		track(item) {
			tracked.push(item)
			return item
		},
	}
}

// ── HTTP spine test harness (node-only, real `@orkestrel/server`) ────────────
//
// AGENTS §16.1: the started-server fixture the MCP HTTP tests share lives here, not
// duplicated per file. Each test starts a REAL server on an ephemeral port and drives
// it with the global `fetch` over a real socket — no mocking (§16). The returned handle
// carries the bound base URL plus a `stop` thunk every test calls in `afterEach` so no
// listener leaks across files.

/** A started test server — its bound `base` URL plus the `ServerInterface`. */
export interface StartedServerInterface<TState = unknown> {
	readonly server: ServerInterface<TState>
	readonly port: number
	readonly base: string
	stop(): Promise<void>
}

/**
 * Start a `ServerInterface` on an ephemeral port and resolve its bound base URL — the
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
 * POST `body` as a JSON request to `base` + `path` and resolve the `fetch` Response —
 * the shared MCP-transport driver (AGENTS §16.1). Sets `content-type:
 * application/json` (the caller's `headers` merge on top, so a test can add an
 * `Accept`), `JSON.stringify`s the body, and defaults `path` to `'/mcp'`.
 *
 * @param base - The server's bound base URL (e.g. `http://127.0.0.1:<port>`)
 * @param body - The JSON-RPC message (or any value) to send as the request body
 * @param options - Optional `headers` (merged over the JSON content type) and `path`
 *   (defaults to `'/mcp'`)
 * @returns The `fetch` Response
 */
export function postJSON(
	base: string,
	body: unknown,
	options?: { headers?: Record<string, string>; path?: string },
): Promise<Response> {
	return fetch(`${base}${options?.path ?? '/mcp'}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...options?.headers },
		body: JSON.stringify(body),
	})
}

// ── Raw HTTP upgrade driver (the WebSocket transport's upgrade seam) ─────────
//
// AGENTS §16.1: the `Server.upgrade(...)` seam tests drive a REAL `node:http` protocol
// upgrade — a client request with `Connection: Upgrade` + `Upgrade: websocket` headers
// — and observe whether the server CLAIMED the socket (it answered `101` and the
// client's `'upgrade'` event fired) or DECLINED it. A real socket exchange, no mock
// (§16).

/** The outcome of an {@link upgradeRequest} — whether the server claimed the upgrade. */
export interface UpgradeOutcome {
	/** `true` when the server answered `101 Switching Protocols` (a handler claimed the socket). */
	readonly claimed: boolean
	/** The `101` status when claimed, else `undefined` (the socket was destroyed un-upgraded). */
	readonly status: number | undefined
}

/**
 * Drive a real `node:http` protocol upgrade against `base` + `path` and resolve the
 * {@link UpgradeOutcome} — the shared upgrade-seam driver (AGENTS §16.1).
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
 * @param base - The server's bound base URL (e.g. `http://127.0.0.1:<port>`)
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
		let settled = false
		const finish = (outcome: UpgradeOutcome): void => {
			if (settled) return
			settled = true
			resolve(outcome)
		}
		const request = httpRequest(`${base}${path}`, {
			headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
		})
		// The server claimed it: it sent `101` and the socket is now the handler's. Read
		// nothing — just free the client end and report the claim.
		request.on('upgrade', (response, socket) => {
			socket.destroy()
			finish({ claimed: true, status: response.statusCode })
		})
		// The server declined: it destroyed the un-upgraded socket, so the request errors
		// (a socket hang-up) — an expected, non-fatal outcome of the decline path.
		request.on('error', () => finish({ claimed: false, status: undefined }))
		// A plain (non-101) response would also mean no upgrade happened.
		request.on('response', (response) => {
			response.resume()
			finish({ claimed: false, status: response.statusCode })
		})
		request.end()
	})
}

// ── Canonical MCP server fixture (the calculator over a ToolManager) ─────────
//
// AGENTS §16.1: the `createCalculatorServer()` factory the MCP transport / middleware
// tests share — a REAL {@link MCPServerInterface} over a REAL `ToolManager` carrying
// the canonical `add` stub (returns 5) plus a `boom` tool that throws `'kaboom'` (→ an
// `isError: true` in-band result), so every transport e2e proves BOTH a value
// round-trip and the tool-error path WITHOUT a live model (§16).

/**
 * Build the canonical calculator {@link MCPServerInterface} the MCP transport tests
 * share — a REAL server (`name: 'calculator'`, `version: '1.0.0'`) over a REAL
 * `ToolManager` carrying the canonical `add` stub (returns 5) plus a `boom` tool that
 * throws `'kaboom'`, so a `tools/call` proves both a value round-trip and the
 * tool-error → `isError: true` in-band result (AGENTS §16.1). No mocks, no live model.
 *
 * @returns The running {@link MCPServerInterface} over the `add` + `boom` registry
 */
export function createCalculatorServer(): MCPServerInterface {
	const tools = createToolManager()
	tools.add(createTool({ name: 'add', execute: () => 5 }))
	tools.add(
		createTool({
			name: 'boom',
			execute: () => {
				throw new Error('kaboom')
			},
		}),
	)
	return createMCPServer({ name: 'calculator', version: '1.0.0', tools })
}
