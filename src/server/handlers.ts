import type { MCPServerInterface } from '@src/core'
import type { RouteContext } from '@orkestrel/router'
import type { HTTPHandlerOptions } from './types.js'
import {
	JSONRPC_INVALID_REQUEST,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_PARSE_ERROR,
	MCP_HEADER_MISMATCH,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	buildJSONRPCError,
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
import { acceptsEventStream, allowsOrigin } from './helpers.js'
import { inferHeaderIssue, inferStatus } from './inferers.js'
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
 * handler through `MCPDispatchOptions.signal`. After every transport validation and immediately
 * before dispatch, the optional synchronous `caller` extractor reads front-middleware state; a
 * defined value is added to `MCPDispatchOptions`, while `undefined` is omitted.
 *
 * @typeParam TState - The consumer's opaque per-request route state type
 * @param mcp - The transport-agnostic MCP server to dispatch through
 * @param options - Optional streaming, origin-validation, SSE keepalive, and caller-extraction options
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
export function createMCPPostHandler<TState = unknown>(
	mcp: MCPServerInterface,
	options?: HTTPHandlerOptions<TState>,
): (request: Request, context?: RouteContext<string, TState>) => Promise<Response> {
	const streaming = options?.streaming ?? true
	const origin = options?.origin
	return async (request, context): Promise<Response> => {
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
		}
		const issue = inferHeaderIssue(request, rpcRequest)
		if (issue !== undefined) {
			return Response.json(buildJSONRPCError(id, MCP_HEADER_MISMATCH, issue.message), {
				status: 400,
			})
		}
		if (era === 'legacy') {
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
		const caller = options?.caller?.(request, context)
		const response = await mcp.dispatch(rpcRequest, {
			signal: disconnect.signal,
			...(caller === undefined ? {} : { caller }),
		})
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
