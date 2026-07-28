import type { MiddlewareContext, NextFunction, UpgradeHandler } from '@orkestrel/server'
import type { MCPSessionState } from '@src/server'
import { createDispatcher } from '@orkestrel/router'
import { createServer, mergeVary, resolveOrigin } from '@orkestrel/server'
import { createNodeWebSocket } from '@orkestrel/websocket'
import {
	createMCPRoutes,
	createMCPSession,
	createWebSocketServer,
	MCP_SESSION_HEADER,
	upgradeRequestPath,
} from '@src/server'
import { isString } from '@orkestrel/contract'
import { createCalculatorServer } from '../setup.js'

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
	const dispatcher = createDispatcher<MCPSessionState>()
	dispatcher.add(createMCPRoutes<MCPSessionState>(mcp))
	dispatcher.add({
		method: 'POST',
		path: '/broken',
		name: 'broken',
		handler: createBrokenResponse,
	})
	const server = createServer<MCPSessionState>({
		dispatcher,
		state: () => ({}),
		host: '127.0.0.1',
	})
	server.use(applyBrowserCORS)
	server.use(createMCPSession<MCPSessionState>())
	server.upgrade(createWebSocketServer(mcp))
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
