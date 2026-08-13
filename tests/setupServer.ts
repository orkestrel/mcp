// Server-test setup — node-only helpers, loaded after `setup.ts` for the node `guides`
// (and `src:server`) projects. `node:*` imports belong here, never in `setup.ts`
// (AGENTS §16.1).

import type { IncomingMessage, Server } from 'node:http'
import type { MCPClientInterface, MCPClientTransportInterface } from '@src/core'
import type { SourceInterface } from '@orkestrel/guide'
import type { MiddlewareHandler, ServerInterface, StreamInterface } from '@orkestrel/server'
import type { WebSocketFrame } from '@orkestrel/websocket'
import type { ManualClockInterface } from './setup.js'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createServer as createHTTPServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import {
	isAbsolute,
	relative as relativePath,
	resolve as resolveFilesystemPath,
	sep,
} from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { afterEach } from 'vitest'
import { isRecord } from '@orkestrel/contract'
import { extractSourceLines, fenceImports, findMissing } from '@orkestrel/guide'
import { waitForDelay } from './setup.js'
import {
	computeWebSocketAccept,
	encodeWebSocketFrame,
	parseWebSocketFrame,
	WEBSOCKET_OPCODE_TEXT,
} from '@orkestrel/websocket'

/**
 * Read a deterministic text inventory rooted beneath one real workspace directory.
 *
 * @param root - The workspace root URL
 * @param directories - Root-relative directories to traverse without following symbolic links
 * @param extensions - Optional filename suffixes to retain
 * @returns A root-relative path-to-text inventory ordered by path
 *
 * @example
 * ```ts
 * readInventory(new URL('../', import.meta.url), ['src'], ['.ts'])
 * ```
 */
export function readInventory(
	root: URL,
	directories: readonly string[],
	extensions: readonly string[] = [],
): Readonly<Record<string, string>> {
	if (directories.length === 0) return {}
	const supplied = fileURLToPath(root)
	const rootStatus = lstatSync(supplied)
	if (rootStatus.isSymbolicLink()) throw new Error('Root is a symbolic link')
	if (!rootStatus.isDirectory()) throw new Error('Root is not a directory')
	const base = realpathSync.native(supplied)
	const pending: string[] = []
	const queued = new Set<string>()
	const contents = new Map<string, string>()

	for (const directory of directories) {
		const candidate = directory === '.' ? base : resolveFilesystemPath(base, directory)
		const requested = relativePath(base, candidate)
		if (requested === '..' || requested.startsWith(`..${sep}`) || isAbsolute(requested)) {
			throw new Error(`Directory outside root: ${directory}`)
		}
		const status = lstatSync(candidate)
		if (status.isSymbolicLink()) throw new Error(`Directory is a symbolic link: ${directory}`)
		if (!status.isDirectory()) throw new Error(`Not a directory: ${directory}`)
		const physical = realpathSync.native(candidate)
		const resolved = relativePath(base, physical)
		if (resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) {
			throw new Error(`Directory outside root: ${directory}`)
		}
		if (queued.has(physical)) continue
		queued.add(physical)
		pending.push(physical)
	}

	while (pending.length > 0) {
		const directory = pending.pop()
		if (directory === undefined) continue
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = resolveFilesystemPath(directory, entry.name)
			const status = lstatSync(path)
			if (status.isSymbolicLink()) continue
			if (status.isDirectory()) {
				const physical = realpathSync.native(path)
				const resolved = relativePath(base, physical)
				if (
					resolved === '..' ||
					resolved.startsWith(`..${sep}`) ||
					isAbsolute(resolved) ||
					queued.has(physical)
				) {
					continue
				}
				queued.add(physical)
				pending.push(physical)
				continue
			}
			if (
				!status.isFile() ||
				(extensions.length > 0 && !extensions.some((value) => entry.name.endsWith(value)))
			) {
				continue
			}
			const key = relativePath(base, path).split(sep).join('/')
			if (!contents.has(key)) contents.set(key, readFileSync(path, 'utf8'))
		}
	}

	const files: Record<string, string> = {}
	for (const key of Array.from(contents.keys()).sort()) {
		const value = contents.get(key)
		if (value !== undefined) files[key] = value
	}
	return files
}

/**
 * Require one root-relative text entry from an inventory.
 *
 * @param files - The workspace text inventory
 * @param relative - The required root-relative path
 * @returns The file text
 * @throws When the exact inventory key is absent
 *
 * @example
 * ```ts
 * requireText(files, 'guides/README.md')
 * ```
 */
export function requireText(files: Readonly<Record<string, string>>, relative: string): string {
	if (Object.hasOwn(files, relative)) {
		const text = files[relative]
		if (text !== undefined) return text
	}
	throw new Error(`Missing file: ${relative}`)
}

/**
 * Find the imports Guide surfaces from a projected fence that are absent from their exact public
 * face.
 *
 * The fence is read through Guide's own comment-aware source projection — `extractSourceLines`
 * replaces every comment and template span with aligned spaces and keeps quoted text verbatim —
 * and the projected text is then handed to `fenceImports`. What this helper owns is a boundary,
 * not a grammar: every statement `fenceImports` surfaces is checked, and nothing else is. A
 * mapped specifier's named bindings compare against that Source's barrel surface; an unmapped
 * true subpath of `root` and a repository alias (`@src/*`, `@app/*`) are refused, the latter
 * because a public guide example must import through a published specifier; a similarly
 * prefixed sibling package stays external.
 *
 * The membership rule is therefore `fenceImports`'s own grammar rather than "named-brace
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
 * exactly what `fenceImports` exists to surface, and it does not surface them, so a guide example
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
 * @throws When a statement `fenceImports` surfaces from the projected fence uses an unmapped root
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
	for (const { specifier, names } of fenceImports(projected)) {
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

// ── Fault-injectable SSE stream (a REAL StreamInterface, not a mock) ─────────
//
// `openStream` is the real seam and is used wherever the happy path is the claim. Two
// terminals it cannot be driven into from outside are exactly the ones the ownership and
// disconnect rows are about: a `write` that throws mid-stream, and a response body that
// raises while it is being forwarded. This is a minimal real implementation of the same
// interface with those two faults as data (AGENTS §16.1 — an inert, customizable stub).

/** Which fault a {@link createStreamStub} stream raises, if any. */
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

/** A real {@link StreamInterface} that also reports what was written and whether it ended. */
export interface TestStreamInterface extends StreamInterface {
	/** Each event's `data`, in write order. */
	readonly events: readonly string[]
	/** Each comment's text, in write order (the keepalive record). */
	readonly comments: readonly string[]
	/** Whether `end()` has been called. */
	readonly ended: boolean
}

/**
 * Build a real SSE {@link StreamInterface} whose write or body fault is supplied as data.
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
	let ended = false
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
			return ended
		},
		get events() {
			return events
		},
		get comments() {
			return comments
		},
		get ended() {
			return ended
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
			ended = true
		},
	}
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

/** A raw client socket held open against a real server's WebSocket endpoint. */
export interface ClientSocketInterface {
	/** Every frame the server has sent since the `101`, decoded as it arrives. */
	readonly frames: readonly WebSocketFrame[]
	/** Resolves when the client end is fully closed (after its last `data` event). */
	readonly closed: Promise<void>
	/** Destroy the client end — the peer that goes away without a close frame. */
	close(): void
}

/**
 * Open a raw RFC 6455 client socket against a real server and decode what it sends back
 * (AGENTS §16.1) — a genuine TCP peer, no wrapper and no mock.
 *
 * @remarks
 * Connects to `base`, writes a valid upgrade `GET` for `path`, and resolves once the
 * server's handshake response arrives, so the caller knows the socket is CLAIMED before it
 * acts. {@link readClientFrames} strips that handshake and decodes every later frame, which
 * is what makes a server-side protocol close (an opcode-`8` frame) distinguishable from a
 * socket destroy (no frame at all). `closed` resolves on the socket's `close` event, after
 * node has dispatched every `data` event, so an assertion over `frames` never races the wire.
 *
 * @param base - The server's bound base URL (e.g. `http://127.0.0.1:<port>`)
 * @param path - The endpoint path to upgrade (e.g. `/mcp`)
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
 * @remarks
 * Disposal runs in REVERSE registration order, because a resource is built on the ones
 * registered before it: a client is opened against a server that is already listening, so
 * the client is closed first and the server stops with nothing still attached. The order
 * matters rather than merely reading well — an UPGRADED WebSocket is detached from the
 * connection set both `closeIdleConnections()` and `closeAllConnections()` walk, so neither
 * `stop()` nor `destroy()` can reach it: a socket nothing on this side closes parks teardown
 * on `stop()` until Vitest's hook timeout fires (10s), and `destroy()` would have hung in
 * exactly the same place. What frees it is the owner closing it — which is what the WebSocket
 * ingress now does on the spine's `stop` event.
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
		for (const item of tracked.splice(0).reverse()) await dispose(item)
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
 * Everything a server suite hands to {@link createTeardown} — a started server, an MCP
 * client, or a bare client transport driven without one.
 */
export type TestResource = StartedServerInterface | MCPClientInterface | MCPClientTransportInterface

/**
 * Release one tracked {@link TestResource} — the disposer a suite that opens CLIENTS as
 * well as servers passes to {@link createTeardown}.
 *
 * @remarks
 * Each member is identified by the one release method it declares (`stop` / `disconnect` /
 * `close`), so the check is a structural narrowing rather than an assertion (§14). Every
 * one of the three is idempotent, so a test that already released its client inline — the
 * disconnect being the CLAIM there rather than cleanup — tears down exactly once and the
 * second call returns immediately.
 *
 * @param resource - The started server, MCP client, or client transport to release
 * @returns Resolves once the resource is released
 *
 * @example
 * ```ts
 * const { track } = createTeardown(closeResource)
 * const client = track(createMCPClient({ transport: track(createWebSocketClientTransport(options)) }))
 * ```
 */
export function closeResource(resource: TestResource): Promise<void> {
	if ('stop' in resource) return resource.stop()
	if ('disconnect' in resource) return resource.disconnect()
	return resource.close()
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

// ── Clock time that passes INSIDE a live request ─────────────────────────────
//
// A claim that a timestamp is "the instant of the LAST access" is only falsifiable when
// clock time passes WHILE a request is in flight: a fixture whose handlers are all
// instantaneous cannot tell "re-read after the await" from "read at request start". This
// middleware is that seam. Composed BEHIND the middleware under test, it advances the
// INJECTED manual clock before delegating, so the layer in front really does suspend
// across a measurable span. The host clock is never replaced (AGENTS §16).

/**
 * Create a middleware that advances a manual clock before delegating downstream.
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
 * Create a middleware that holds every request open for `ms` of REAL time before delegating.
 *
 * @remarks
 * The seam for interleaving: while one request is parked here, the middleware in front of it
 * is genuinely suspended, so a second request can reach the same state and the test can pin
 * which of the two wins. A short real delay, never a replaced clock (AGENTS §16).
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
// protocol-faithful fixture instead (AGENTS §16): it writes a REAL RFC 6455 `101` with a
// correctly computed `Sec-WebSocket-Accept`, optionally after a delay and optionally with
// one unmasked text frame appended, and it counts the sockets it upgraded against the
// sockets that are still open.

/** A raw upgrade peer — how many sockets it accepted, and how many are still open. */
export interface TestUpgradeInterface {
	/** The bound `http://…` base URL. */
	readonly base: string
	/** How many upgrades this peer answered with a `101`. */
	readonly count: number
	/** How many of those sockets are still open (an orphan never reaches zero). */
	readonly open: number
	stop(): Promise<void>
}

/** How a {@link startUpgradeServer} peer answers each upgrade. */
export interface TestUpgradeOptions {
	/** Milliseconds the handshake is held open before the `101` is written. */
	readonly delay?: number
	/** A text frame written together with the handshake, so a bound socket re-emits it. */
	readonly frame?: string
}

/**
 * Start a raw `node:http` peer that completes real WebSocket handshakes and records them.
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
 * const transport = createWebSocketClientTransport({ url: `${peer.base}/mcp` })
 * ```
 */
export async function startUpgradeServer(
	options?: TestUpgradeOptions,
): Promise<TestUpgradeInterface> {
	const server: Server = createHTTPServer()
	const sockets: Duplex[] = []
	let count = 0
	let closed = 0
	server.on('upgrade', (request, socket) => {
		const key = request.headers['sec-websocket-key']
		if (typeof key !== 'string') {
			socket.destroy()
			return
		}
		sockets.push(socket)
		count += 1
		// A client that destroys its half leaves this end reading an ECONNRESET — an expected
		// outcome of the very path under test, never an uncaught 'error'.
		socket.on('error', () => {})
		socket.on('close', () => {
			closed += 1
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
			return count
		},
		get open() {
			return count - closed
		},
		stop() {
			return new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
			})
		},
	}
}
