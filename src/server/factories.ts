import type { ClientTransportInterface, MCPServerInterface } from '@src/core'
import type { RouteInput } from '@orkestrel/router'
import type { UpgradeHandler } from '@orkestrel/server'
import type {
	HTTPClientTransportOptions,
	HTTPTransportOptions,
	StdioClientTransportOptions,
	StdioServerOptions,
	WebSocketClientTransportOptions,
	WebSocketServerOptions,
} from './types.js'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import {
	bindServer,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_PARSE_ERROR,
	jsonRPCError,
	parseJSONRPCMessage,
} from '@src/core'
import { isString } from '@orkestrel/contract'
import { openStream } from '@orkestrel/server'
import { createNodeWebSocket, WEBSOCKET_VERSION } from '@orkestrel/websocket'
import { DEFAULT_MCP_PATH, MCP_WEBSOCKET_SUBPROTOCOL } from './constants.js'
import { acceptsEventStream, bridgeMessageTransport, upgradeRequestPath } from './helpers.js'
import { HTTPClientTransport } from './transports/HTTPClientTransport.js'
import { StdioClientTransport } from './transports/StdioClientTransport.js'
import { StdioServerTransport } from './transports/StdioServerTransport.js'
import { WebSocketClientTransport } from './transports/WebSocketClientTransport.js'
import { WebSocketServerTransport } from './transports/WebSocketServerTransport.js'

/**
 * Create the MCP Streamable-HTTP transport routes — mounts a transport-agnostic
 * {@link MCPServerInterface} (the `@src/core` dispatch core) on the fetch-standard router
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
 * the JSON-RPC envelope, then the stream ends) via `@orkestrel/server`'s generic
 * {@link import('@orkestrel/server').openStream} seam; otherwise it is a plain JSON body.
 *
 * **Sessions are a SEPARATE, plug-and-play middleware.** `createMCPRoutes` mints / reads no
 * session id. To make the transport STATEFUL, mount {@link
 * import('./middlewares.js').createMCPSession} IN FRONT — it owns the same `path`, mints +
 * validates the `mcp-session-id`, and serves the resumable `GET {path}` + `DELETE {path}`,
 * leaving this route to dispatch the validated `POST`.
 *
 * This is MECHANISM, not policy: compose auth / CORS / rate-limiting (and the session
 * middleware) IN FRONT as ordinary middleware — the transport route adds none.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param mcp - The transport-agnostic {@link MCPServerInterface} to expose over HTTP
 * @param options - Optional `path` (default {@link DEFAULT_MCP_PATH}) and `streaming`
 *   (default `true`); see {@link HTTPTransportOptions}
 * @returns The {@link RouteInput}s to register with the router
 *
 * @example
 * ```ts
 * import { createMCPServer, createToolManager } from '@src/core'
 * import { createMCPRoutes } from '@src/server'
 *
 * const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
 * const routes = createMCPRoutes(mcp) // POST /mcp dispatches JSON-RPC (JSON or SSE per Accept)
 * ```
 */
export function createMCPRoutes<TState = unknown>(
	mcp: MCPServerInterface,
	options?: HTTPTransportOptions,
): readonly RouteInput<string, TState>[] {
	const path = options?.path ?? DEFAULT_MCP_PATH
	const streaming = options?.streaming ?? true
	const post: RouteInput<string, TState> = {
		method: 'POST',
		path,
		name: 'mcp',
		handler: async (request) => {
			let text: string
			try {
				text = await request.text()
			} catch {
				// A malformed JSON body is a TRANSPORT failure — HTTP 400 + a JSON-RPC -32700.
				return Response.json(jsonRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'), {
					status: 400,
				})
			}
			let parsed: unknown
			try {
				parsed = JSON.parse(text)
			} catch {
				return Response.json(jsonRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'), {
					status: 400,
				})
			}
			const rpcRequest = parseJSONRPCMessage(parsed)
			if (rpcRequest === undefined || !('method' in rpcRequest)) {
				// Not a JSON-RPC request (a response, or any non-message) — HTTP 400 + -32600.
				// `'method' in rpcRequest` narrows the message union to `JSONRPCRequest` (no `as`).
				return Response.json(jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request'), {
					status: 400,
				})
			}
			const response = await mcp.dispatch(rpcRequest)
			if (response === undefined) {
				// A notification (no `id`) yields no response — 202 Accepted, no body.
				return new Response(null, { status: 202 })
			}
			if (streaming && acceptsEventStream(request)) {
				// Streamable-HTTP SSE response: one `data:` event with the JSON-RPC envelope, then end.
				const s = openStream()
				s.write({ data: JSON.stringify(response) })
				s.end()
				return s.response
			}
			// A dispatch result — success OR an in-band JSON-RPC error — is HTTP 200 + the envelope.
			return Response.json(response)
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
 * plain JSON envelope or a Streamable-HTTP SSE `data:` event, decoded via `@orkestrel/sse`),
 * and the reply is surfaced on the transport's `message` event for the client's id
 * correlation. Add `options.headers` (e.g. an `Authorization` bearer) to reach a guarded
 * server. `start` / `close` hold no connection; against a STATEFUL server it captures the
 * `mcp-session-id` from `initialize` and echoes it on later requests, so the same
 * `MCPClient` passes session validation (a stateless server sends none).
 *
 * @param options - `url` (the remote endpoint; REQUIRED), optional `headers` merged onto
 *   every request, optional `fetch` (default `globalThis.fetch`), and optional `timeout`
 *   (ms, applied via `AbortSignal.timeout`); see {@link HTTPClientTransportOptions}
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
 *   protocol })` (SERVER mode → writes the `101` handshake, echoing the `subprotocol`, default
 *   {@link MCP_WEBSOCKET_SUBPROTOCOL} `'mcp'`, and sends UNMASKED frames), wraps it in a
 *   {@link WebSocketServerTransport}, and pipes it through the core {@link
 *   import('@src/core').MCPTransportInterface} port via {@link
 *   import('./helpers.js').bridgeMessageTransport} + {@link import('@src/core').bindServer}:
 *   each inbound REQUEST runs through `mcp.dispatch`, and a defined response is written back
 *   as a frame — a NOTIFICATION sends nothing, and a non-request message (a stray response) is
 *   ignored. A `dispatch` / `send` fault surfaces on `mcp.emitter`'s `error` event rather than
 *   escaping the (async) message pump.
 *
 * It is MECHANISM, not policy: compose an auth guard IN FRONT by registering an upgrade
 * handler BEFORE this one — that handler can claim (decline + destroy) an unauthenticated
 * upgrade so it never reaches this pump.
 *
 * @param mcp - The transport-agnostic {@link MCPServerInterface} to expose over WebSocket
 * @param options - Optional `path` (default {@link DEFAULT_MCP_PATH}) and `subprotocol`
 *   (default {@link MCP_WEBSOCKET_SUBPROTOCOL}); see {@link WebSocketServerOptions}
 * @returns An {@link UpgradeHandler} to register with the spine's `upgrade` seam
 *
 * @example
 * ```ts
 * import { createMCPServer, createToolManager } from '@src/core'
 * import { createWebSocketServer } from '@src/server'
 *
 * const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
 * server.upgrade(createWebSocketServer(mcp)) // an MCP client now connects over ws://…/mcp
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

		// CLAIM: the wrapper writes the `101` handshake (server mode) and the transport pipes
		// through the core port: bindServer dispatches each inbound request and writes back a
		// defined response (a notification sends nothing); a dispatch / send fault surfaces on
		// `mcp.emitter`'s `error` event.
		const ws = createNodeWebSocket({ socket, key, head, protocol: subprotocol })
		const transport = new WebSocketServerTransport(ws)
		bindServer(mcp, bridgeMessageTransport(transport))
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
 * upgrade request), validates the `Sec-WebSocket-Accept` (via `@orkestrel/websocket`'s
 * `computeWebSocketAccept`), and opens a persistent bidirectional frame channel; each JSON-RPC
 * message the client `send`s is written as one masked text frame, and each decoded reply is
 * surfaced on the transport's `message` event for the client's id correlation. Add
 * `options.headers` (e.g. an `Authorization` bearer) to reach a guarded server.
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

/**
 * Create the stdio CLIENT transport for an {@link import('@src/core').MCPClientInterface}
 * — a {@link ClientTransportInterface} that spawns and drives a CHILD PROCESS MCP server
 * over newline-delimited JSON-RPC on `stdin`/`stdout`, the stdio sibling of {@link
 * createHTTPClientTransport} and {@link createWebSocketClientTransport}.
 *
 * @remarks
 * Hand it to `createMCPClient({ transport })`: `start()` (run by `client.connect()`)
 * spawns `options.command` with `options.args` and `options.env`, piping its
 * `stdin`/`stdout` for the JSON-RPC channel (its `stderr` inherits the parent's for
 * diagnostics). Each JSON-RPC message the client `send`s is written as one
 * newline-terminated line to the child's `stdin`; each decoded reply line from the
 * child's `stdout` is surfaced on the transport's `message` event for the client's
 * id correlation.
 *
 * @param options - `command` (the executable to spawn; REQUIRED), optional `args`,
 *   and optional `env`; see {@link StdioClientTransportOptions}
 * @returns A working {@link ClientTransportInterface} over a child process's stdio
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@src/core'
 * import { createStdioClientTransport } from '@src/server'
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
): ClientTransportInterface {
	return new StdioClientTransport(options)
}

/**
 * Create the MCP stdio transport INGRESS — pumps a transport-agnostic {@link
 * MCPServerInterface} over newline-delimited JSON-RPC on `stdin`/`stdout` (or an
 * injected stream pair), the stdio mirror of {@link createWebSocketServer}.
 *
 * @remarks
 * Wraps `options.input` (default `process.stdin`) / `options.output` (default
 * `process.stdout`) in a {@link import('./transports/StdioServerTransport.js').StdioServerTransport}
 * and pipes it through the core {@link import('@src/core').MCPTransportInterface} port
 * via {@link import('./helpers.js').bridgeMessageTransport} + {@link
 * import('@src/core').bindServer}: each inbound REQUEST runs through `mcp.dispatch`, and
 * a defined response is written back as a newline-terminated line — a NOTIFICATION
 * writes nothing, and a non-request message is ignored. A `dispatch` / `send` fault
 * surfaces on `mcp.emitter`'s `error` event rather than escaping the (async) message
 * pump.
 *
 * @param mcp - The transport-agnostic {@link MCPServerInterface} to expose over stdio
 * @param options - Optional injectable `input` / `output` streams; see
 *   {@link StdioServerOptions}
 * @returns A `{ start(): void; stop(): void }` handle to arm / tear down the pump
 *
 * @example
 * ```ts
 * import { createMCPServer, createToolManager } from '@src/core'
 * import { createStdioServer } from '@src/server'
 *
 * const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
 * createStdioServer(mcp).start() // an MCP client now connects over this process's stdio
 * ```
 */
export function createStdioServer(
	mcp: MCPServerInterface,
	options?: StdioServerOptions,
): { start(): void; stop(): void } {
	const input = options?.input ?? process.stdin
	const output = options?.output ?? process.stdout
	const transport = new StdioServerTransport(input, output)
	bindServer(mcp, bridgeMessageTransport(transport))
	return {
		start(): void {
			void transport.start()
		},
		stop(): void {
			void transport.close()
		},
	}
}
