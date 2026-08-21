import type {
	MCPClientTransportInterface,
	MCPContinuationInterface,
	MCPDispatcherInterface,
} from '@src/core'
import type { RouteInput } from '@orkestrel/router'
import type { TokenSecret, UpgradeHandler } from '@orkestrel/server'
import type {
	HTTPClientTransportOptions,
	HTTPTransportOptions,
	StdioClientTransportInterface,
	StdioClientTransportOptions,
	StdioServerOptions,
	WebSocketClientTransportOptions,
	WebSocketServerOptions,
} from './types.js'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { bindServer } from '@src/core'
import { isString } from '@orkestrel/contract'
import { signToken, verifyToken } from '@orkestrel/server'
import { createNodeWebSocket, WEBSOCKET_VERSION } from '@orkestrel/websocket'
import { DEFAULT_MCP_PATH, MCP_WEBSOCKET_SUBPROTOCOL } from './constants.js'
import { createMCPPostHandler } from './handlers.js'
import { bridgeMessageTransport, upgradeRequestPath } from './helpers.js'
import { HTTPClientTransport } from './transports/HTTPClientTransport.js'
import { StdioClientTransport } from './transports/StdioClientTransport.js'
import { StdioServerTransport } from './transports/StdioServerTransport.js'
import { WebSocketClientTransport } from './transports/WebSocketClientTransport.js'
import { WebSocketServerTransport } from './transports/WebSocketServerTransport.js'

/**
 * Adapts the installed server token primitives to the host-neutral MCP continuation port.
 *
 * @param secret - Current signing secret or `[current, ...older]` rotation list
 * @returns A continuation port that seals and opens opaque canonical state strings
 */
export function createMCPContinuation(secret: TokenSecret): MCPContinuationInterface {
	return {
		seal(value) {
			return signToken(value, { secret })
		},
		open(value) {
			return verifyToken(value, secret)
		},
	}
}

/**
 * Creates the MCP Streamable-HTTP transport routes — mounts a transport-agnostic
 * {@link MCPDispatcherInterface} (the `@orkestrel/mcp` dispatch boundary) on the fetch-standard router
 * spine, pumping each `POST` body through `mcp.dispatch`. Returns the {@link RouteInput}s to
 * hand to `router.add(...)`.
 *
 * @remarks
 * A SINGLE `POST {path}` route — `createMCPRoutes` is STATELESS. The handler reads its own
 * request body (its own JSON parse try/catch), so it works with or without a session
 * middleware mounted in front. It draws a sharp line between TRANSPORT-level and
 * DISPATCH-level outcomes:
 *
 * - A **transport** failure — a malformed JSON body, or a parsed value that is not a
 *   JSON-RPC INVOCATION — is an HTTP `400` carrying a JSON-RPC error BODY (`-32700` Parse
 *   error / `-32600` Invalid Request), with the `id` it could not read OMITTED.
 * - Modern protocol/method/name headers are validated against the body; a mismatch is
 *   HTTP `400` + `-32020`. Headerless initialize is accepted, a live legacy session supplies
 *   its pinned revision, and every other headerless request is rejected.
 * - Legacy dispatch errors stay IN-BAND at HTTP `200`; modern errors map to `400` for
 *   `-32020` / `-32021` / `-32022` / `-32602`, `404` for `-32601`, and `200` otherwise.
 * - A **notification** (an invocation with no `id`, which `dispatch` resolves to
 *   `undefined`) is a `202 Accepted` with no body.
 *
 * When `streaming` is enabled (the default) and the client `Accept`s `text/event-stream`,
 * the `200` reply is framed as a Streamable-HTTP SSE response (one `data:` event carrying
 * the JSON-RPC envelope, then the stream ends) through `@orkestrel/server`'s generic
 * {@link import('@orkestrel/server').openStream} seam; otherwise it is a plain JSON body.
 *
 * **Sessions are a SEPARATE, plug-and-play middleware.** `createMCPRoutes` mints / reads no
 * session id. To make the transport STATEFUL, mount {@link
 * import('./middlewares.js').createMCPSession} IN FRONT — it owns the same `path`, mints +
 * validates the `mcp-session-id`, and serves the resumable `GET {path}` + `DELETE {path}`,
 * leaving this route to dispatch the validated `POST`.
 *
 * This is MECHANISM, not policy: compose auth / rate-limiting (and the session middleware)
 * IN FRONT as ordinary middleware; the optional `origin` group carries the deployment's shared
 * allowlist or explicitly delegates validation to an upstream layer.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param mcp - The transport-agnostic {@link MCPDispatcherInterface} to expose over HTTP
 * @param options - Optional `path` (default {@link DEFAULT_MCP_PATH}) and `streaming`
 *   (default `true`), plus shared origin, keepalive, and synchronous caller-extraction options; see
 *   {@link HTTPTransportOptions}
 * @returns The {@link RouteInput}s to register with the router
 *
 * @example
 * ```ts
 * import { createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
 * import { createMCPRoutes } from '@orkestrel/mcp/server'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const mcp = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools: createToolManager() })
 * const routes = createMCPRoutes(createMCPLegacy(mcp)) // answers `initialize` too; pass `mcp` alone for modern-only
 * ```
 */
export function createMCPRoutes<TState = unknown>(
	mcp: MCPDispatcherInterface,
	options?: HTTPTransportOptions<TState>,
): ReadonlyArray<RouteInput<string, TState>> {
	const path = options?.path ?? DEFAULT_MCP_PATH
	const post: RouteInput<string, TState> = {
		method: 'POST',
		path,
		name: 'mcp',
		handler: createMCPPostHandler<TState>(mcp, options),
	}
	return [post]
}

/**
 * Creates the HTTP CLIENT transport for an {@link import('@orkestrel/mcp').MCPClientInterface}
 * — a {@link MCPClientTransportInterface} that drives a REMOTE Streamable-HTTP MCP server
 * over `fetch`. The egress mirror of {@link createMCPRoutes}.
 *
 * @remarks
 * Hand it to `createMCPClient({ transport })`: each JSON-RPC message the client sends is
 * `POST`ed to `options.url` with `content-type: application/json` and an `Accept` of
 * both `application/json` and `text/event-stream` (the server answers with EITHER — a
 * plain JSON envelope or a Streamable-HTTP SSE `data:` event, decoded with `@orkestrel/sse`),
 * and the reply is surfaced on the transport's `message` event for the client's id
 * correlation. Add `options.headers` (for example, an `Authorization` bearer) to reach a guarded
 * server. `start` / `close` hold no connection; against a STATEFUL server it captures the
 * `mcp-session-id` from `initialize` and echoes it on later requests. It also captures
 * the initialize result's `protocolVersion` and sends `mcp-protocol-version` alone on each
 * subsequent legacy request. Modern requests derive protocol and method headers directly
 * from the message, plus a name header only for `tools/call`.
 *
 * @param options - `url` (the remote endpoint; REQUIRED), optional `headers` merged onto
 *   every request, optional `fetch` (default `globalThis.fetch`), and optional `timeout`
 *   (ms, applied with `AbortSignal.timeout`); see {@link HTTPClientTransportOptions}
 * @returns A working {@link MCPClientTransportInterface} over `fetch`
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@orkestrel/mcp'
 * import { createHTTPClientTransport } from '@orkestrel/mcp/server'
 *
 * const client = createMCPClient({
 * 	transport: createHTTPClientTransport({ url: 'http://localhost:3000/mcp' }),
 * })
 * await client.connect()
 * const tools = await client.tools()
 * ```
 */
export function createHTTPClientTransport(
	options: HTTPClientTransportOptions,
): MCPClientTransportInterface {
	return new HTTPClientTransport(options)
}

/**
 * Creates the MCP WebSocket transport INGRESS — an {@link UpgradeHandler} that exposes a
 * transport-agnostic {@link MCPDispatcherInterface} over a WebSocket, the WebSocket mirror of
 * {@link createMCPRoutes}. Register it on the spine's upgrade seam.
 *
 * @remarks
 * It composes the lean RFC 6455 `@orkestrel/websocket` wrapper over `@orkestrel/server`'s
 * generic upgrade seam — the spine speaks no WebSocket, this handler does.
 *
 * - **Declines (returns `false`)** when the upgrade is not for it, so the spine fans the
 *   socket to the next handler (or destroys an unclaimed one): the `Upgrade` header is not
 *   `websocket`, the request path is not `options.path` (default {@link DEFAULT_MCP_PATH},
 *   `'/mcp'`), the `Sec-WebSocket-Key` is absent, or the `Sec-WebSocket-Version` is not `13`.
 *   A decline NEVER writes to the socket (it is not yet ours) — the spine owns the unclaimed
 *   outcome.
 * - **Claims (returns `true`)** otherwise: it builds `createNodeWebSocket({ socket, key, head,
 *   protocol })` (SERVER mode → writes the `101` handshake, selects the configured subprotocol
 *   only when the client's offer contains it, and sends UNMASKED frames), wraps it in a
 *   {@link WebSocketServerTransport}, and pipes it through the core {@link
 *   import('@orkestrel/mcp').MCPTransportInterface} port through {@link
 *   import('./helpers.js').bridgeMessageTransport} + {@link import('@orkestrel/mcp').bindServer}:
 *   each inbound REQUEST runs through `mcp.dispatch`, and a defined response is written back
 *   as a frame — a NOTIFICATION sends nothing, and a non-request message (a stray response) is
 *   ignored. A `dispatch` / `send` fault surfaces on `mcp.emitter`'s `error` event rather than
 *   escaping the (async) message pump.
 * - **Closes on the spine's `stop`.** It holds every socket it claimed and, on `options.emitter`'s
 *   `stop` event, closes each one with the RFC 6455 close handshake, so the spine's drain settles
 *   at once and each client reads a clean goodbye. Node detaches an upgraded socket from the
 *   connection set the spine's own close walks, so the claimant is the only thing that can end
 *   it: an ingress that held its sockets open would cost `stop()` the whole `drain` budget and
 *   then have the connection cut mid-protocol. A socket the peer already dropped is gone from
 *   the set (its transport's `close` removes it), and closing a dead one is a no-op either way.
 *
 * It is MECHANISM, not policy: compose an auth guard IN FRONT by registering an upgrade
 * handler BEFORE this one — that handler can claim (decline + destroy) an unauthenticated
 * upgrade so it never reaches this pump.
 *
 * @param mcp - The transport-agnostic {@link MCPDispatcherInterface} to expose over WebSocket
 * @param options - The spine's `emitter` (REQUIRED — the `stop` event this ingress closes its
 *   sockets on), plus optional `path` (default {@link DEFAULT_MCP_PATH}) and `subprotocol`
 *   (default {@link MCP_WEBSOCKET_SUBPROTOCOL}); see {@link WebSocketServerOptions}
 * @returns An {@link UpgradeHandler} to register with the spine's `upgrade` seam
 *
 * @example
 * ```ts
 * import { createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
 * import { createWebSocketServer } from '@orkestrel/mcp/server'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const mcp = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools: createToolManager() })
 * // Claims the MCP upgrade at ws://…/mcp:
 * server.upgrade(createWebSocketServer(createMCPLegacy(mcp), { emitter: server.emitter })) // answers `initialize` too; pass `mcp` alone for modern-only
 * ```
 */
export function createWebSocketServer(
	mcp: MCPDispatcherInterface,
	options: WebSocketServerOptions,
): UpgradeHandler {
	const path = options.path ?? DEFAULT_MCP_PATH
	const subprotocol = options.subprotocol ?? MCP_WEBSOCKET_SUBPROTOCOL
	// The connections this handler owns, each with the detachment its binding returned
	// — a closure store, like the session middleware's. A transport leaves on its own `close`,
	// so the map holds exactly the LIVE connections and exactly the bindings still attached.
	const live = new Map<WebSocketServerTransport, () => void>()
	// The spine is stopping: detach each binding, then say the RFC 6455 goodbye on every socket
	// still open. Nothing else can close them — node detaches an upgraded socket from the
	// connection set the spine's close walks — so without this the drain runs to its deadline and
	// the connection is cut mid-protocol.
	options.emitter.on('stop', () => {
		for (const [transport, unbind] of live) {
			unbind()
			void transport.close()
		}
	})
	return (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
		// DECLINE anything that is not our MCP WebSocket upgrade — the spine fans it onward or
		// destroys it. Never touch the socket on a decline (it is not ours yet).
		const upgrade = request.headers['upgrade']
		if (!isString(upgrade) || upgrade.toLowerCase() !== 'websocket') return false
		if (upgradeRequestPath(request) !== path) return false
		const key = request.headers['sec-websocket-key']
		if (!isString(key)) return false
		const version = request.headers['sec-websocket-version']
		if (!isString(version) || version !== WEBSOCKET_VERSION) return false

		// CLAIM: the wrapper writes the `101` handshake (server mode) and the transport pipes
		// through the core port: bindServer dispatches each inbound request and writes back a
		// defined response (a notification sends nothing); a dispatch / send fault surfaces on
		// `mcp.emitter`'s `error` event.
		const offer = request.headers['sec-websocket-protocol']
		const protocol =
			isString(offer) && offer.split(',').some((candidate) => candidate.trim() === subprotocol)
				? subprotocol
				: undefined
		const ws = createNodeWebSocket({
			socket,
			key,
			head,
			...(protocol === undefined ? {} : { protocol }),
		})
		const transport = new WebSocketServerTransport(ws)
		// The binder's detachment is this handler's to hold: the connection it belongs to is one
		// this factory minted and nothing outside can reach, so a discarded `unbind` leaves the
		// binding attached to a transport that has ended with no way left to detach it.
		const unbind = bindServer(mcp, bridgeMessageTransport(transport))
		live.set(transport, unbind)
		transport.emitter.on('close', () => {
			live.delete(transport)
			unbind()
		})
		void transport.start()
		return true
	}
}

/**
 * Creates the WebSocket CLIENT transport for an {@link import('@orkestrel/mcp').MCPClientInterface}
 * — a {@link MCPClientTransportInterface} that drives a REMOTE MCP server over a WebSocket. The
 * egress mirror of {@link createWebSocketServer} and the WebSocket sibling of {@link
 * createHTTPClientTransport}.
 *
 * @remarks
 * Hand it to `createMCPClient({ transport })`: `start()` (run by `client.connect()`) performs
 * the RFC 6455 client handshake against `options.url` (accepting a `ws://` / `wss://` or an
 * `http://` / `https://` URL — a `ws(s)` scheme is converted to `http(s)` for the underlying
 * upgrade request), validates the `Sec-WebSocket-Accept` (with `@orkestrel/websocket`'s
 * `computeWebSocketAccept`), and opens a persistent bidirectional frame channel; each JSON-RPC
 * message the client `send`s is written as one masked text frame, and each decoded reply is
 * surfaced on the transport's `message` event for the client's id correlation. Add
 * `options.headers` (for example, an `Authorization` bearer) to reach a guarded server.
 *
 * @param options - `url` (the remote WebSocket endpoint; REQUIRED) and optional `headers`
 *   merged onto the upgrade request; see {@link WebSocketClientTransportOptions}
 * @returns A working {@link MCPClientTransportInterface} over a WebSocket
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@orkestrel/mcp'
 * import { createWebSocketClientTransport } from '@orkestrel/mcp/server'
 *
 * const client = createMCPClient({
 * 	transport: createWebSocketClientTransport({ url: 'ws://localhost:3000/mcp' }),
 * })
 * await client.connect()
 * const tools = await client.tools()
 * ```
 */
export function createWebSocketClientTransport(
	options: WebSocketClientTransportOptions,
): MCPClientTransportInterface {
	return new WebSocketClientTransport(options)
}

/**
 * Creates the stdio CLIENT transport for an {@link import('@orkestrel/mcp').MCPClientInterface}
 * — a {@link StdioClientTransportInterface} that spawns and drives a CHILD PROCESS MCP server
 * over newline-delimited JSON-RPC on `stdin`/`stdout`, the stdio sibling of {@link
 * createHTTPClientTransport} and {@link createWebSocketClientTransport}.
 *
 * @remarks
 * Hand it to `createMCPClient({ transport })`: `start()` (run by `client.connect()`)
 * spawns `options.command` with `options.args` and `options.env`, piping its
 * `stdin`/`stdout` for the JSON-RPC channel. The child's `stderr` is piped too, and
 * retained as a bounded tail this transport reports as `evidence` — the parent never
 * inherits it. Each JSON-RPC message the client `send`s is written as one
 * newline-terminated line to the child's `stdin`; each decoded reply line from the
 * child's `stdout` is surfaced on the transport's `message` event for the client's
 * id correlation.
 *
 * @param options - `command` (the executable to spawn; REQUIRED), optional `args`,
 *   and optional `env`; see {@link StdioClientTransportOptions}
 * @returns A working {@link StdioClientTransportInterface} over a child process's stdio,
 *   whose `evidence` carries the supervised child's bounded stderr tail
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@orkestrel/mcp'
 * import { createStdioClientTransport } from '@orkestrel/mcp/server'
 *
 * const client = createMCPClient({
 * 	transport: createStdioClientTransport({ command: 'node', args: ['./server.js'] }),
 * })
 * await client.connect()
 * const tools = await client.tools()
 * ```
 */
export function createStdioClientTransport(
	options: StdioClientTransportOptions,
): StdioClientTransportInterface {
	return new StdioClientTransport(options)
}

/**
 * Creates the MCP stdio transport INGRESS — pumps a transport-agnostic {@link
 * MCPDispatcherInterface} over newline-delimited JSON-RPC on `stdin`/`stdout` (or an
 * injected stream pair), the stdio mirror of {@link createWebSocketServer}.
 *
 * @remarks
 * Wraps `options.input` (default `process.stdin`) / `options.output` (default
 * `process.stdout`) in a {@link import('./transports/StdioServerTransport.js').StdioServerTransport}
 * and pipes it through the core {@link import('@orkestrel/mcp').MCPTransportInterface} port
 * through {@link import('./helpers.js').bridgeMessageTransport} + {@link
 * import('@orkestrel/mcp').bindServer}: each inbound REQUEST runs through `mcp.dispatch`, and
 * a defined response is written back as a newline-terminated line — a NOTIFICATION
 * writes nothing, and a non-request message is ignored. A `dispatch` / `send` fault
 * surfaces on `mcp.emitter`'s `error` event rather than escaping the (async) message
 * pump.
 *
 * @param mcp - The transport-agnostic {@link MCPDispatcherInterface} to expose over stdio
 * @param options - Optional injectable `input` / `output` streams; see
 *   {@link StdioServerOptions}
 * @returns A `{ start(): void; stop(): void }` handle to arm / tear down the pump
 *
 * @example
 * ```ts
 * import { createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
 * import { createStdioServer } from '@orkestrel/mcp/server'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const mcp = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools: createToolManager() })
 * // An MCP client now connects over this process's stdio:
 * createStdioServer(createMCPLegacy(mcp)).start() // answers `initialize` too; pass `mcp` alone for modern-only
 * ```
 */
export function createStdioServer(
	mcp: MCPDispatcherInterface,
	options?: StdioServerOptions,
): { start(): void; stop(): void } {
	const input = options?.input ?? process.stdin
	const output = options?.output ?? process.stdout
	const transport = new StdioServerTransport(input, output)
	const unbind = bindServer(mcp, bridgeMessageTransport(transport))
	return {
		start(): void {
			void transport.start()
		},
		stop(): void {
			unbind()
			void transport.close()
		},
	}
}
