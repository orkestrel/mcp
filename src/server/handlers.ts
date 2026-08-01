import type { MCPServerInterface } from '@src/core'
import type { MCPKeepaliveOptions, MCPOriginOptions } from './types.js'
import {
	JSONRPC_INVALID_REQUEST,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_PARSE_ERROR,
	MCP_HEADER_MISMATCH,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	buildJSONRPCError,
	isInitializeRequest,
	isMCPVersion,
	isModernRequest,
	parseRequestContext,
	parseJSONRPCMessage,
} from '@src/core'
import { openStream } from '@orkestrel/server'
import {
	MCP_PROTOCOL_VERSION_HEADER,
	SSE_BUFFERING_DISABLED,
	SSE_BUFFERING_HEADER,
} from './constants.js'
import { acceptsEventStream, allowsOrigin, matchesModernHeaders } from './helpers.js'
import { inferStatus } from './inferers.js'
import { HTTPDisconnect } from './transports/HTTPDisconnect.js'

/**
 * Create the Streamable-HTTP POST handler used by `createMCPRoutes`.
 *
 * @remarks
 * Modern requests require matching protocol/method headers and a matching name header only
 * for `tools/call`; mismatch returns HTTP `400` + `-32020`. Headerless `initialize` is
 * accepted, while every other headerless request needs a live legacy session to supply its
 * pinned version. A present origin must occur in `origin.origins` unless validation is
 * explicitly delegated upstream. Modern dispatch errors use their protocol status map; legacy
 * errors remain in-band at HTTP `200`. A streamed response composes the fetch-standard request
 * signal with response-body cancellation and supplies the result to every dispatched modern
 * handler through `MCPDispatchOptions.signal`.
 *
 * @param mcp - The transport-agnostic MCP server to dispatch through
 * @param options - Optional streaming, origin-validation, and SSE keepalive options
 * @returns A request handler for the stateless MCP POST route
 *
 * @example
 * ```ts
 * import { createMCPServer } from '@orkestrel/mcp'
 * import { createMCPPostHandler } from '@orkestrel/mcp/server'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const mcp = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools: createToolManager() })
 * const handler = createMCPPostHandler(mcp, { streaming: true })
 * await handler(new Request('http://localhost/mcp', {
 * 	method: 'POST',
 * 	body: '{"jsonrpc":"2.0","method":"ping","id":1}',
 * }))
 * ```
 */
export function createMCPPostHandler(
	mcp: MCPServerInterface,
	options?: {
		readonly streaming?: boolean
		readonly origin?: MCPOriginOptions
		readonly keepalive?: MCPKeepaliveOptions
	},
): (request: Request) => Promise<Response> {
	const streaming = options?.streaming ?? true
	const origin = options?.origin
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
		const id = rpcRequest.id ?? null
		const protocol = request.headers.get(MCP_PROTOCOL_VERSION_HEADER)
		if (era === 'modern') {
			if (parseRequestContext(rpcRequest) === undefined) {
				return Response.json(
					buildJSONRPCError(
						id,
						JSONRPC_INVALID_PARAMS,
						'Invalid params: malformed modern request metadata',
					),
					{ status: 400 },
				)
			}
			if (!matchesModernHeaders(request, rpcRequest)) {
				return Response.json(
					buildJSONRPCError(
						id,
						MCP_HEADER_MISMATCH,
						'MCP request headers do not match the request body',
					),
					{ status: 400 },
				)
			}
		} else {
			if (protocol === null && !isInitializeRequest(rpcRequest)) {
				return Response.json(
					buildJSONRPCError(
						id,
						MCP_HEADER_MISMATCH,
						'MCP request headers do not match the request body',
					),
					{ status: 400 },
				)
			}
			if (protocol !== null && !isMCPVersion(protocol)) {
				return Response.json(
					buildJSONRPCError(
						id,
						MCP_UNSUPPORTED_VERSION,
						`Unsupported MCP protocol version '${protocol}'`,
						{ supported: SUPPORTED_PROTOCOL_VERSIONS, requested: protocol },
					),
					{ status: 400 },
				)
			}
		}
		const disconnect = new HTTPDisconnect(request.signal, options?.keepalive)
		const response = await mcp.dispatch(rpcRequest, { signal: disconnect.signal })
		if (response !== undefined && Symbol.asyncIterator in response) {
			const stream = openStream()
			stream.response.headers.set(SSE_BUFFERING_HEADER, SSE_BUFFERING_DISABLED)
			queueMicrotask(async () => {
				try {
					let next = await response.next()
					while (!next.done) {
						stream.write({ data: JSON.stringify(next.value) })
						next = await response.next()
					}
					stream.write({ data: JSON.stringify(next.value) })
				} catch {
					// A producer failure ends this response; the transport cannot replace a partial stream.
				} finally {
					stream.end()
				}
			})
			return disconnect.bridge(stream)
		}
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
