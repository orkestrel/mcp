import type { MCPServerInterface } from '@src/core'
import {
	JSONRPC_INVALID_REQUEST,
	JSONRPC_PARSE_ERROR,
	jsonRPCError,
	parseJSONRPCMessage,
} from '@src/core'
import { openStream } from '@orkestrel/server'
import { acceptsEventStream } from './helpers.js'

/**
 * Create the Streamable-HTTP POST handler used by `createMCPRoutes`.
 *
 * @param mcp - The transport-agnostic MCP server to dispatch through
 * @param streaming - Whether an event-stream response may be negotiated
 * @returns A request handler for the stateless MCP POST route
 *
 * @example
 * ```ts
 * import { createMCPServer } from '@orkestrel/mcp'
 * import { createMCPPostHandler } from '@orkestrel/mcp/server'
 * import { createToolManager } from '@orkestrel/agent'
 *
 * const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
 * const handler = createMCPPostHandler(mcp, true)
 * await handler(new Request('http://localhost/mcp', {
 * 	method: 'POST',
 * 	body: '{"jsonrpc":"2.0","method":"ping","id":1}',
 * }))
 * ```
 */
export function createMCPPostHandler(
	mcp: MCPServerInterface,
	streaming: boolean,
): (request: Request) => Promise<Response> {
	return async (request): Promise<Response> => {
		let text: string
		try {
			text = await request.text()
		} catch {
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
			return Response.json(jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request'), {
				status: 400,
			})
		}
		const response = await mcp.dispatch(rpcRequest)
		if (response === undefined) return new Response(null, { status: 202 })
		if (streaming && acceptsEventStream(request)) {
			const stream = openStream()
			stream.write({ data: JSON.stringify(response) })
			stream.end()
			return stream.response
		}
		return Response.json(response)
	}
}
