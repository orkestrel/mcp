// This external fixture server is loaded in its own SSR context by tests/setupGlobal.ts.
import type { MiddlewareContext, NextFunction, UpgradeHandler } from '@orkestrel/server'
import type { MCPServerInterface } from '@src/core'
import type { MCPOriginOptions, MCPSessionState } from '@src/server'
import {
	bindServer,
	buildJSONRPCResult,
	isJSONRPCId,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_SESSION_HEADER,
} from '@src/core'
import { createDispatcher } from '@orkestrel/router'
import { createServer, mergeVary, resolveOrigin } from '@orkestrel/server'
import { createNodeWebSocket } from '@orkestrel/websocket'
import {
	MCP_WEBSOCKET_SUBPROTOCOL,
	WebSocketServerTransport,
	createMCPRoutes,
	createMCPSession,
	createMessageTransportBridge,
	createWebSocketServer,
	upgradeRequestPath,
} from '@src/server'
import { isRecord, isString } from '@orkestrel/contract'
import { createCalculatorServer } from '../setup.js'

// Every raw frame a recording peer has received since the last drain. The browser project
// cannot see inside this process, so a claim about what the PEER received has to be read
// back over the wire — that is what `/recorded` is for. Kept module-scope and drained on
// read so each scenario starts from an empty log.
const RECORDED: string[] = []

/** The running Node fixture exposed to the browser project's global setup. */
export interface BrowserFixtureInterface {
	/** The fixture's loopback HTTP origin. */
	readonly base: string
	/** Stop the listener and release all server resources. */
	stop(): Promise<void>
}

/** Create the intentionally malformed JSON response used by the HTTP error-path test. */
export function createBrokenResponse(): Response {
	return new Response('not valid json', {
		status: 500,
		headers: { 'content-type': 'application/json' },
	})
}

/** Let the real browser page reach the external HTTP fixture, including session requests. */
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
 * Record one raw frame a fixture peer received.
 *
 * @param text - The frame exactly as it arrived on the wire
 */
export function recordFrame(text: string): void {
	RECORDED.push(text)
}

/**
 * Answer with every recorded frame and clear the log.
 *
 * @returns The recorded frames as a JSON array, leaving the log empty
 */
export function drainRecorded(): Response {
	return Response.json(RECORDED.splice(0, RECORDED.length))
}

/**
 * Answer a POST with the MCP headers it actually carried across the wire.
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
 * Record every JSON-RPC body POSTed to the fixture before the route handles it.
 *
 * @param request - The inbound request (cloned, so the route still reads its body)
 * @param _context - The unused per-request middleware context
 * @param next - The rest of the chain
 * @returns Whatever the rest of the chain answered
 */
export async function recordInbound(
	request: Request,
	_context: MiddlewareContext<MCPSessionState>,
	next: NextFunction,
): Promise<Response> {
	if (request.method === 'POST') recordFrame(await request.clone().text())
	return next()
}

/**
 * Create the recording WebSocket peer — the REAL server on a REAL socket, with the
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
 * @returns The upgrade handler to register for the `/record` path
 */
export function createRecordingWebSocketHandler(mcp: MCPServerInterface): UpgradeHandler {
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
		webSocket.emitter.on('message', recordFrame)
		const transport = new WebSocketServerTransport(webSocket)
		bindServer(mcp, createMessageTransportBridge(transport))
		void transport.start()
		return true
	}
}

/** Create raw WebSocket endpoints for peer-close and malformed-frame browser tests. */
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
 * Start the real MCP HTTP/session/WebSocket fixture on an ephemeral loopback port.
 *
 * @returns The fixture base URL and its complete teardown
 */
export async function start(): Promise<BrowserFixtureInterface> {
	const mcp = createCalculatorServer()
	// applyBrowserCORS is a permissive test double: it approves every requesting Origin, so
	// this fixture explicitly delegates the built-in enforcement sites to that upstream layer.
	const origin: MCPOriginOptions = { enabled: false }
	const dispatcher = createDispatcher<MCPSessionState>()
	dispatcher.add(createMCPRoutes<MCPSessionState>(mcp, { origin }))
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
		handler: drainRecorded,
	})
	const server = createServer<MCPSessionState>({
		dispatcher,
		state: () => ({}),
		host: '127.0.0.1',
	})
	server.use(applyBrowserCORS)
	server.use(recordInbound)
	server.use(createMCPSession<MCPSessionState>({ origin }))
	server.upgrade(createWebSocketServer(mcp, { emitter: server.emitter }))
	server.upgrade(createRecordingWebSocketHandler(mcp))
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
