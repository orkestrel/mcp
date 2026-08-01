import type { MCPServerInterface } from '@src/core'
import type { MCPOriginOptions } from './types.js'
import {
	JSONRPC_INVALID_REQUEST,
	JSONRPC_PARSE_ERROR,
	MCP_HEADER_MISMATCH,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	buildJSONRPCError,
	isInitializeRequest,
	isMCPVersion,
	isModernRequest,
	parseJSONRPCMessage,
} from '@src/core'
import { openStream } from '@orkestrel/server'
import {
	MCP_PROTOCOL_VERSION_HEADER,
	SSE_BUFFERING_DISABLED,
	SSE_BUFFERING_HEADER,
} from './constants.js'
import { acceptsEventStream, allowsOrigin, matchesRequestHeaders } from './helpers.js'
import { inferStatus } from './inferers.js'

/**
 * Create the Streamable-HTTP POST handler used by `createMCPRoutes`.
 *
 * @remarks
 * Modern requests require matching protocol/method headers and a matching name header only
 * for `tools/call`; mismatch returns HTTP `400` + `-32020`. Headerless `initialize` is
 * accepted, while every other headerless request needs a live legacy session to supply its
 * pinned version. A present origin must occur in `origin.origins` unless validation is
 * explicitly delegated upstream. Modern dispatch errors use their protocol status map; legacy
 * errors remain in-band at HTTP `200`.
 *
 * @param mcp - The transport-agnostic MCP server to dispatch through
 * @param streaming - Whether an event-stream response may be negotiated
 * @param origin - Shared origin validation and delegation options
 * @returns A request handler for the stateless MCP POST route
 *
 * @example
 * ```ts
 * import { createMCPServer } from '@orkestrel/mcp'
 * import { createMCPPostHandler } from '@orkestrel/mcp/server'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const mcp = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools: createToolManager() })
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
	origin?: MCPOriginOptions,
): (request: Request) => Promise<Response> {
	return async (request): Promise<Response> => {
		if (!allowsOrigin(request, origin)) return new Response(null, { status: 403 })
		let text: string
		try {
			text = await request.text()
		} catch {
			return Response.json(buildJSONRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'), {
				status: 400,
			})
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			return Response.json(buildJSONRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'), {
				status: 400,
			})
		}
		const rpcRequest = parseJSONRPCMessage(parsed)
		if (rpcRequest === undefined || !('method' in rpcRequest)) {
			return Response.json(buildJSONRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request'), {
				status: 400,
			})
		}
		const era = isModernRequest(rpcRequest) ? 'modern' : 'legacy'
		const protocol = request.headers.get(MCP_PROTOCOL_VERSION_HEADER)
		if (
			(era === 'modern' && !matchesRequestHeaders(request, rpcRequest)) ||
			(era === 'legacy' && protocol === null && !isInitializeRequest(rpcRequest))
		) {
			return Response.json(
				buildJSONRPCError(
					rpcRequest.id ?? null,
					MCP_HEADER_MISMATCH,
					'MCP request headers do not match the request body',
				),
				{ status: 400 },
			)
		}
		if (era === 'legacy' && protocol !== null && !isMCPVersion(protocol)) {
			return Response.json(
				buildJSONRPCError(
					rpcRequest.id ?? null,
					MCP_UNSUPPORTED_VERSION,
					`Unsupported MCP protocol version '${protocol}'`,
					{ supported: SUPPORTED_PROTOCOL_VERSIONS, requested: protocol },
				),
				{ status: 400 },
			)
		}
		const response = await mcp.dispatch(rpcRequest)
		const status = inferStatus(response, era)
		if (response === undefined) return new Response(null, { status })
		if (status === 200 && streaming && acceptsEventStream(request)) {
			const stream = openStream()
			stream.response.headers.set(SSE_BUFFERING_HEADER, SSE_BUFFERING_DISABLED)
			stream.write({ data: JSON.stringify(response) })
			stream.end()
			return stream.response
		}
		return Response.json(response, { status })
	}
}
