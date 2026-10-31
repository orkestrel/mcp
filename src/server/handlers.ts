import {
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_PARSE_ERROR,
	buildJSONRPCError,
} from '@orkestrel/jsonrpc'
import type { MCPDispatcherInterface } from '@src/core'
import type { RouteContext } from '@orkestrel/router'
import type { HTTPHandlerOptions } from './types.js'
import {
	MCP_HEADER_MISMATCH,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_LEGACY_PROTOCOL_VERSIONS,
	inferRequestEra,
	isMCPLegacyVersion,
	isMCPModernVersion,
	parseRequestContext,
	parseJSONRPCMessage,
} from '@src/core'
import { isObject, isString, parseJSON } from '@orkestrel/contract'
import { createStream } from '@orkestrel/server'
import { SSE_BUFFERING_DISABLED, SSE_BUFFERING_HEADER } from './constants.js'
import {
	acceptsEventStream,
	allowsOrigin,
	readRequestText,
	resolveHeaderParameters,
	sendEventStream,
} from './helpers.js'
import { inferHeaderIssue, inferParameterRefusal, inferStatus } from './inferers.js'
import { HTTPDisconnect } from './HTTPDisconnect.js'

/**
 * Creates the Streamable-HTTP POST handler used by `createMCPRoutes`.
 *
 * @remarks
 * Modern requests require matching protocol/method headers and a matching name header on each
 * method carrying a named target — `tools/call` and `prompts/get` against `params.name`,
 * `resources/read` against `params.uri` — with a Base64-sentinel value decoded before the
 * comparison; a missing, mismatched, or invalidly encoded value returns HTTP `400` + `-32020`.
 * A protocol header naming a modern revision holds the request to that revision whatever shape
 * its body arrived in, so a body with no parsable modern `_meta` returns HTTP `400` + `-32602`.
 * Headerless `initialize` and id-bearing legacy `ping` are accepted; other headerless requests
 * need a live legacy session to supply its pinned version. A legacy-shaped request carrying a protocol header is
 * otherwise admitted only for a legacy revision; a revision this server does not implement
 * returns HTTP `400` + `-32022` whose `supported` names the legacy revisions this door accepts.
 * A present origin must occur in `origin.origins` unless validation is
 * explicitly delegated upstream. Modern dispatch errors use their protocol status map; legacy
 * errors remain in-band at HTTP `200`. A streamed response composes the fetch-standard request
 * signal with response-body cancellation and supplies the result to every dispatched modern
 * handler through `MCPDispatchOptions.signal`. After every transport validation and immediately
 * before dispatch, the optional synchronous `caller` extractor reads front-middleware state; a
 * defined value is added to `MCPDispatchOptions`, while `undefined` is omitted.
 * For legacy `initialize`, the dispatch response is recorded as `initialization` before
 * JSON or SSE framing only when consumer state is an object with `'session' in context.state`.
 *
 * @typeParam TState - The consumer's opaque per-request route state type
 * @param mcp - The transport-agnostic MCP dispatcher to dispatch through
 * @param options - Optional streaming, origin-validation, SSE keepalive, and caller-extraction options
 * @returns A request handler for the stateless MCP POST route
 *
 * @example
 * ```ts
 * import { createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
 * import { createMCPPostHandler } from '@orkestrel/mcp/server'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const mcp = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools: createToolManager() })
 * const handler = createMCPPostHandler(createMCPLegacy(mcp), { stream: true }) // answers `initialize` too; pass `mcp` alone for modern-only
 * await handler(new Request('http://localhost/mcp', {
 * 	method: 'POST',
 * 	body: '{"jsonrpc":"2.0","method":"ping","id":1}',
 * }))
 * ```
 */
export function createMCPPostHandler<TState = unknown>(
	mcp: MCPDispatcherInterface,
	options?: HTTPHandlerOptions<TState>,
): (request: Request, context?: RouteContext<string, TState>) => Promise<Response> {
	const enabled = options?.stream ?? true
	const origin = options?.origin
	return async (request, context): Promise<Response> => {
		if (!allowsOrigin(request, origin)) return new Response(null, { status: 403 })
		const text = await readRequestText(request)
		if (text === undefined) {
			return Response.json(buildJSONRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'), {
				status: 400,
			})
		}
		const parsed = parseJSON(text)
		if (parsed === undefined) {
			return Response.json(buildJSONRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'), {
				status: 400,
			})
		}
		const invocation = parseJSONRPCMessage(parsed)
		if (invocation === undefined || !('method' in invocation)) {
			return Response.json(buildJSONRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request'), {
				status: 400,
			})
		}
		const era = inferRequestEra(invocation)
		const id = invocation.id ?? null
		const protocol = request.headers.get(MCP_PROTOCOL_VERSION_HEADER)
		// A protocol header naming a MODERN revision is the client declaring the revision this
		// server implements, so the request is held to that revision's own rule whatever shape
		// its body arrived in: SEP-2575 requires a parsable `_meta`, and a body without one is
		// `-32602`. Routing such a body through the legacy door instead would answer `-32022`,
		// which claims this server does not implement the revision it answered `_meta` for.
		if (era === 'modern' || isMCPModernVersion(protocol)) {
			if (parseRequestContext(invocation) === undefined) {
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
		const issue = inferHeaderIssue(request, invocation)
		if (issue !== undefined) {
			return Response.json(buildJSONRPCError(id, MCP_HEADER_MISMATCH, issue.message), {
				status: 400,
			})
		}
		// The custom-header half of the same seam. SEP-2243 scopes `Mcp-Param-*` validation to
		// the names THIS server's own tool definitions annotate, and the served definitions are
		// reachable through exactly one door the transport-agnostic dispatcher publishes: a
		// `tools/list` dispatch. It is taken fresh on each modern `tools/call` rather than
		// cached, because a table a client happened to fetch earlier is the table a header forger
		// would rather the server used, and because a registry a consumer mutates would leave a
		// cached table silently wrong. A held-open answer is released and read as no definition,
		// so a consumer that replaced `tools/list` with a stream refuses nothing.
		const called = invocation.params?.['name']
		if (era === 'modern' && invocation.method === 'tools/call' && isString(called)) {
			const parameters = await resolveHeaderParameters(mcp, invocation, called)
			const refusal = inferParameterRefusal(request, parameters, invocation.params?.['arguments'])
			if (refusal !== undefined) {
				return Response.json(buildJSONRPCError(id, MCP_HEADER_MISMATCH, refusal), {
					status: 400,
				})
			}
		}
		if (era === 'legacy') {
			if (protocol !== null && !isMCPLegacyVersion(protocol)) {
				return Response.json(
					buildJSONRPCError(
						id,
						MCP_UNSUPPORTED_VERSION,
						`Unsupported MCP protocol version '${protocol}'`,
						{ supported: SUPPORTED_LEGACY_PROTOCOL_VERSIONS, requested: protocol },
					),
					{ status: 400 },
				)
			}
		}
		const disconnect = new HTTPDisconnect(request.signal, options?.keepalive)
		const caller = options?.caller?.(request, context)
		const response = await mcp.dispatch(invocation, {
			signal: disconnect.signal,
			...(caller === undefined ? {} : { caller }),
		})
		if (response !== undefined && Symbol.asyncIterator in response) {
			const stream = createStream()
			stream.response.headers.set(SSE_BUFFERING_HEADER, SSE_BUFFERING_DISABLED)
			queueMicrotask(() => void sendEventStream(response, stream))
			return disconnect.bridge(stream)
		}
		if (
			era === 'legacy' &&
			invocation.method === 'initialize' &&
			isObject(context?.state) &&
			'session' in context.state
		) {
			if (!Reflect.set(context.state, 'initialization', response)) {
				throw new Error('MCP initialization state is not writable')
			}
		}
		const status = inferStatus(response, era)
		if (response === undefined) return new Response(null, { status })
		if (status === 200 && enabled && acceptsEventStream(request)) {
			const stream = createStream()
			stream.response.headers.set(SSE_BUFFERING_HEADER, SSE_BUFFERING_DISABLED)
			stream.write({ data: JSON.stringify(response) })
			stream.end()
			return stream.response
		}
		return Response.json(response, { status })
	}
}
