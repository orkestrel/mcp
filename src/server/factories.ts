import type { ClientTransportInterface, MCPServerInterface } from '@src/core'
import type { RouteInput, UpgradeHandler } from '../http/types.js'
import type {
	HTTPClientTransportOptions,
	HTTPTransportOptions,
	WebSocketClientTransportOptions,
	WebSocketServerOptions,
} from './types.js'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import {
	isJSONRPCRequest,
	isString,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_PARSE_ERROR,
	jsonRPCError,
	parseJSONRPCMessage,
} from '@src/core'
import { openSSEStream } from '../http/helpers.js'
import { createNodeWebSocket } from '../websocket/index.js'
import { WEBSOCKET_VERSION } from '../websocket/constants.js'
import { DEFAULT_MCP_PATH, MCP_WEBSOCKET_SUBPROTOCOL } from './constants.js'
import { acceptsEventStream, upgradeRequestPath } from './helpers.js'
import { HTTPClientTransport } from './transports/HTTPClientTransport.js'
import { WebSocketClientTransport } from './transports/WebSocketClientTransport.js'
import { WebSocketServerTransport } from './transports/WebSocketServerTransport.js'

/**
 * Create the MCP Streamable-HTTP transport routes — mounts a transport-agnostic
 * {@link MCPServerInterface} (the `@src/core` dispatch core) on the HTTP spine, pumping
 * each `POST` body through `mcp.dispatch`. Returns the {@link RouteInput}s to hand to
 * `server.route(...)`.
 *
 * @remarks
 * A SINGLE `POST {path}` route — `createMCPRoutes` is STATELESS. The handler is
 * self-contained (its own JSON parse try/catch), so it works with or without {@link
 * import('../http/middlewares.js').createBodyParser} mounted. It draws a sharp line between
 * TRANSPORT-level and DISPATCH-level outcomes:
 *
 * - A **transport** failure — a malformed JSON body, or a parsed value that is not a
 *   JSON-RPC REQUEST — is an HTTP `400` carrying a JSON-RPC error BODY (`-32700` Parse
 *   error / `-32600` Invalid Request, id `null`).
 * - A **dispatch** result — a success OR an IN-BAND JSON-RPC error from `mcp.dispatch`
 *   (e.g. `-32601` method-not-found) — is an HTTP `200` carrying the JSON-RPC response
 *   envelope (the error is in-band per JSON-RPC, NOT an HTTP error).
 * - A **notification** (a request with no `id`, which `dispatch` resolves to
 *   `undefined`) is a `202 Accepted` with no body.
 *
 * When `streaming` is enabled (the default) and the client `Accept`s `text/event-stream`,
 * the `200` reply is framed as a Streamable-HTTP SSE response (one `data:` event carrying
 * the JSON-RPC envelope, then the stream ends) via the spine's generic {@link
 * openSSEStream} seam; otherwise it is a plain JSON body.
 *
 * **Sessions are a SEPARATE, plug-and-play middleware.** `createMCPRoutes` mints / reads no
 * session id, and `GET` / `DELETE` to `{path}` get the spine's automatic `405`. To make the
 * transport STATEFUL, mount {@link import('./middlewares.js').createMCPSession} IN FRONT
 * (`server.use(createMCPSession())`) — it owns the same `path`, mints + validates the
 * `mcp-session-id`, and serves the resumable
 * `GET {path}` + `DELETE {path}`, leaving this route to dispatch the validated `POST`.
 *
 * This is MECHANISM, not policy: compose auth / CORS / rate-limiting (and the session
 * middleware) IN FRONT as ordinary middleware (`createTokenGuard` / `createCors` /
 * `createRateLimiter` / `createMCPSession`) — the transport route adds none.
 *
 * @param mcp - The transport-agnostic {@link MCPServerInterface} to expose over HTTP
 * @param options - Optional `path` (default {@link DEFAULT_MCP_PATH}) and `streaming`
 *   (default `true`); see {@link HTTPTransportOptions}
 * @returns The {@link RouteInput}s to register with `server.route(...)`
 *
 * @example
 * ```ts
 * import { createMCPServer, createToolManager } from '@src/core'
 * import { createCors, createErrorBoundary, createMCPRoutes, createServer } from '@src/server'
 *
 * const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
 *
 * const server = createServer()
 * server.use(createErrorBoundary())
 * server.use(createCors()) // policy composes IN FRONT — the transport is mechanism
 * server.route(createMCPRoutes(mcp)) // POST /mcp dispatches JSON-RPC (JSON or SSE per Accept)
 * await server.start()
 * ```
 */
export function createMCPRoutes(
	mcp: MCPServerInterface,
	options?: HTTPTransportOptions,
): readonly RouteInput[] {
	const path = options?.path ?? DEFAULT_MCP_PATH
	const streaming = options?.streaming ?? true
	const post: RouteInput = {
		method: 'POST',
		path,
		name: 'mcp',
		handler: async (context) => {
			let message: unknown
			try {
				message = await context.body()
			} catch {
				// A malformed JSON body is a TRANSPORT failure — HTTP 400 + a JSON-RPC -32700.
				context.json(jsonRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'), 400)
				return
			}
			const request = parseJSONRPCMessage(message)
			if (request === undefined || !('method' in request)) {
				// Not a JSON-RPC request (a response, or any non-message) — HTTP 400 + -32600.
				// `'method' in request` narrows the message union to `JSONRPCRequest` (no `as`).
				context.json(jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request'), 400)
				return
			}
			const response = await mcp.dispatch(request)
			if (response === undefined) {
				// A notification (no `id`) yields no response — 202 Accepted, no body.
				context.empty(202)
				return
			}
			if (streaming && acceptsEventStream(context)) {
				// Streamable-HTTP SSE response: one `data:` event with the JSON-RPC envelope, then end.
				const sse = openSSEStream(context)
				sse.write({ data: JSON.stringify(response) })
				sse.end()
				return
			}
			// A dispatch result — success OR an in-band JSON-RPC error — is HTTP 200 + the envelope.
			context.json(response)
		},
	}
	return [post]
}

/**
 * Create the HTTP CLIENT transport for an {@link import('@src/core').MCPClientInterface}
 * — a {@link ClientTransportInterface} that drives a REMOTE Streamable-HTTP MCP server
 * over `fetch`. The egress mirror of {@link createMCPRoutes}.
 *
 * @remarks
 * Hand it to `createMCPClient({ transport })`: each JSON-RPC message the client sends is
 * `POST`ed to `options.url` with `content-type: application/json` and an `Accept` of
 * both `application/json` and `text/event-stream` (the server answers with EITHER — a
 * plain JSON envelope or a Streamable-HTTP SSE `data:` event, decoded via the core
 * `SSEParser`), and the reply is surfaced on the transport's `message` event for the
 * client's id correlation. Add `options.headers` (e.g. an `Authorization` bearer) to
 * reach a guarded server. `start` / `close` hold no connection; against a STATEFUL server
 * it captures the `mcp-session-id` from `initialize` and echoes it on later requests, so
 * the same `MCPClient` passes session validation (a stateless server sends none).
 *
 * @param options - `url` (the remote endpoint; REQUIRED) and optional `headers` merged
 *   onto every request; see {@link HTTPClientTransportOptions}
 * @returns A working {@link ClientTransportInterface} over `fetch`
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@src/core'
 * import { createHTTPClientTransport } from '@src/server'
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
): ClientTransportInterface {
	return new HTTPClientTransport(options)
}

/**
 * Create the MCP WebSocket transport INGRESS — an {@link UpgradeHandler} that exposes a
 * transport-agnostic {@link MCPServerInterface} over a WebSocket, the WebSocket mirror of
 * {@link createMCPRoutes}. Register it on the spine's upgrade seam: `server.upgrade(
 * createWebSocketServer(mcp))`.
 *
 * @remarks
 * It composes the lean RFC 6455 {@link createNodeWebSocket} wrapper (D2) over the spine's
 * generic upgrade seam (D3) — the spine speaks no WebSocket, this handler does.
 *
 * - **Declines (returns `false`)** when the upgrade is not for it, so the spine fans the
 *   socket to the next handler (or destroys an unclaimed one): the `Upgrade` header is not
 *   `websocket`, the request path is not `options.path` (default {@link DEFAULT_MCP_PATH},
 *   `'/mcp'`), the `Sec-WebSocket-Key` is absent, or the `Sec-WebSocket-Version` is not `13`.
 *   A decline NEVER writes to the socket (it is not yet ours) — the spine owns the unclaimed
 *   outcome.
 * - **Claims (returns `true`)** otherwise: it builds `createNodeWebSocket({ socket, key, head,
 *   protocol })` (SERVER mode → writes the `101` handshake, echoing the `subprotocol`, default
 *   {@link MCP_WEBSOCKET_SUBPROTOCOL} `'mcp'`, and sends UNMASKED frames), wraps it in a
 *   {@link WebSocketServerTransport}, and PUMPS: each inbound {@link
 *   import('@src/core').JSONRPCMessage} that is a REQUEST runs through `mcp.dispatch`, and a
 *   defined response is written back as a frame — a NOTIFICATION (`dispatch` → `undefined`)
 *   sends nothing. A non-request message (a stray response) is ignored. The dispatch is
 *   guarded so a `dispatch` / `send` fault surfaces on the transport's `error` event rather
 *   than escaping the (async) message listener.
 *
 * It is MECHANISM, not policy: compose an auth guard IN FRONT by registering a
 * `Server.upgrade` handler BEFORE this one — that handler can claim (decline + destroy) an
 * unauthenticated upgrade so it never reaches this pump.
 *
 * @param mcp - The transport-agnostic {@link MCPServerInterface} to expose over WebSocket
 * @param options - Optional `path` (default {@link DEFAULT_MCP_PATH}) and `subprotocol`
 *   (default {@link MCP_WEBSOCKET_SUBPROTOCOL}); see {@link WebSocketServerOptions}
 * @returns An {@link UpgradeHandler} to register with `server.upgrade(...)`
 *
 * @example
 * ```ts
 * import { createMCPServer, createToolManager } from '@src/core'
 * import { createServer, createWebSocketServer } from '@src/server'
 *
 * const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
 * const server = createServer()
 * server.upgrade(createWebSocketServer(mcp)) // an MCP client now connects over ws://…/mcp
 * await server.start()
 * ```
 */
export function createWebSocketServer(
	mcp: MCPServerInterface,
	options?: WebSocketServerOptions,
): UpgradeHandler {
	const path = options?.path ?? DEFAULT_MCP_PATH
	const subprotocol = options?.subprotocol ?? MCP_WEBSOCKET_SUBPROTOCOL
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

		// CLAIM: the wrapper writes the `101` handshake (server mode) and the transport pumps
		// each request through `mcp.dispatch`, writing back a defined response (a notification
		// sends nothing). A dispatch / send fault surfaces on the transport `error` event.
		const ws = createNodeWebSocket({ socket, key, head, protocol: subprotocol })
		const transport = new WebSocketServerTransport(ws)
		transport.emitter.on('message', (message) => {
			if (!isJSONRPCRequest(message)) return
			void (async () => {
				try {
					const response = await mcp.dispatch(message)
					if (response !== undefined) await transport.send(response)
				} catch (error) {
					// Surface a dispatch / send fault on the transport's `error` event — but a
					// user `'error'` listener that itself throws would (Emitter.emit rethrows the
					// first listener throw) escape this `void` async listener as an UNHANDLED
					// rejection and, on Node ≥15, can terminate the process. Swallow that here:
					// a buggy observer must never crash the server (§13).
					try {
						transport.emitter.emit('error', error)
					} catch {
						// A throwing `error` listener is the caller's own bug — the end of the line.
					}
				}
			})()
		})
		void transport.start()
		return true
	}
}

/**
 * Create the WebSocket CLIENT transport for an {@link import('@src/core').MCPClientInterface}
 * — a {@link ClientTransportInterface} that drives a REMOTE MCP server over a WebSocket. The
 * egress mirror of {@link createWebSocketServer} and the WebSocket sibling of {@link
 * createHTTPClientTransport}.
 *
 * @remarks
 * Hand it to `createMCPClient({ transport })`: `start()` (run by `client.connect()`) performs
 * the RFC 6455 client handshake against `options.url` (accepting a `ws://` / `wss://` or an
 * `http://` / `https://` URL — a `ws(s)` scheme is converted to `http(s)` for the underlying
 * upgrade request), validates the `Sec-WebSocket-Accept` (via the D2 `computeWebSocketAccept`),
 * and opens a persistent bidirectional frame channel; each JSON-RPC message the client `send`s
 * is written as one masked text frame, and each decoded reply is surfaced on the transport's
 * `message` event for the client's id correlation. Add `options.headers` (e.g. an
 * `Authorization` bearer) to reach a guarded server.
 *
 * @param options - `url` (the remote WebSocket endpoint; REQUIRED) and optional `headers`
 *   merged onto the upgrade request; see {@link WebSocketClientTransportOptions}
 * @returns A working {@link ClientTransportInterface} over a WebSocket
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@src/core'
 * import { createWebSocketClientTransport } from '@src/server'
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
): ClientTransportInterface {
	return new WebSocketClientTransport(options)
}
