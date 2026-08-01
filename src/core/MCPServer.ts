import type { EmitterInterface } from '@orkestrel/emitter'
import type {
	JSONRPCRequest,
	JSONRPCResponse,
	MCPCallResult,
	MCPIdentity,
	MCPServerEventMap,
	MCPServerInterface,
	MCPServerOptions,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import { isRecord, isString } from '@orkestrel/contract'
import {
	DEFAULT_MCP_CACHE_TTL,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from './constants.js'
import {
	buildCallResult,
	buildDiscoverResult,
	buildInitializeResult,
	buildJSONRPCError,
	buildJSONRPCResult,
	buildModernResult,
	buildToolDescriptors,
} from './helpers.js'
import { inferEra } from './inferers.js'
import { parseJSONRPCMessage, parseRequestContext } from './parsers.js'
import { isModernRequest } from './validators.js'

/**
 * A transport-agnostic Model Context Protocol server — dispatches JSON-RPC 2.0
 * requests over a live {@link ToolManagerInterface}, with NO transport coupling.
 *
 * @remarks
 * - **Two entry points.** `dispatch(request)` runs an already-parsed request and
 *   resolves a {@link JSONRPCResponse} — or `undefined` for a NOTIFICATION (a
 *   request with no `id`). `handle(message)` is the string boundary: it
 *   `JSON.parse`s the raw message (a failure → a `-32700` response), narrows it to
 *   a request (a non-request → a `-32600` response), dispatches, and serializes the
 *   response back to a string (`undefined` for a notification).
 * - **Dual-era dispatch.** A request carrying the reserved modern version key uses
 *   modern metadata validation and the `server/discover` / `tools/list` /
 *   `tools/call` method set. Every other request uses the legacy `initialize` /
 *   `ping` / `tools/list` / `tools/call` switch. The wire era is selected per
 *   request and never stored.
 * - **Provider-agnostic.** Imports only core siblings — JSON-RPC + the tool registry,
 *   no HTTP, no model. Wire fields are narrowed via the contracts guards (no `as`).
 * - **Observable (§13).** The owned `emitter` fires `request` at the top of every
 *   dispatch; the emitter isolates a listener throw and routes it to its `error` handler
 *   (the `error` option), so a listener throw can never escape the dispatch.
 *
 * @example
 * ```ts
 * const tools = createToolManager()
 * tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
 * const server = new MCPServer({ identity: { name: 'demo', version: '1.0.0' }, tools })
 * await server.handle('{"jsonrpc":"2.0","method":"ping","id":1}') // '{"jsonrpc":"2.0","id":1,"result":{}}'
 * ```
 */
export class MCPServer implements MCPServerInterface {
	readonly #emitter: Emitter<MCPServerEventMap>
	readonly #options: MCPServerOptions

	constructor(options: MCPServerOptions) {
		this.#emitter = new Emitter<MCPServerEventMap>({
			...(options.on !== undefined ? { on: options.on } : {}),
			...(options.error !== undefined ? { error: options.error } : {}),
		})
		this.#options = options
	}

	get emitter(): EmitterInterface<MCPServerEventMap> {
		return this.#emitter
	}

	get identity(): MCPIdentity {
		return this.#options.identity
	}

	async dispatch(request: JSONRPCRequest): Promise<JSONRPCResponse | undefined> {
		const id = request.id ?? null
		const modern = isModernRequest(request)
		const era = modern ? 'modern' : 'legacy'
		this.#emitter.emit('request', request.method, id, era)
		// JSON-RPC: a request with NO `id` is a NOTIFICATION — it is handled (the
		// `request` event already fired) but NEVER produces a response, whatever its
		// method (`notifications/initialized`, a fire-and-forget `ping`, an unknown
		// method — all silent). So short-circuit here, and the switch below only ever
		// runs for an id-bearing request that expects a reply.
		if (request.id === undefined) {
			return undefined
		}
		return modern ? this.#modern(request, id) : this.#legacy(request, id)
	}

	async handle(message: string): Promise<string | undefined> {
		let parsed: unknown
		try {
			parsed = JSON.parse(message)
		} catch {
			return JSON.stringify(buildJSONRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'))
		}
		const decoded = parseJSONRPCMessage(parsed)
		// Only a REQUEST is dispatchable — a response (or any non-message) is invalid input.
		if (decoded === undefined || !('method' in decoded)) {
			return JSON.stringify(buildJSONRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request'))
		}
		const response = await this.dispatch(decoded)
		return response === undefined ? undefined : JSON.stringify(response)
	}

	async #legacy(request: JSONRPCRequest, id: string | number | null): Promise<JSONRPCResponse> {
		switch (request.method) {
			case 'initialize': {
				const requested = request.params?.['protocolVersion']
				return buildJSONRPCResult(
					id,
					buildInitializeResult(
						this.#options.identity.name,
						this.#options.identity.version,
						isString(requested) ? requested : undefined,
					),
				)
			}
			case 'ping':
				return buildJSONRPCResult(id, {})
			case 'tools/list':
				return buildJSONRPCResult(id, {
					tools: buildToolDescriptors(this.#options.tools),
				})
			case 'tools/call': {
				const result = await this.#call(request, id)
				return 'jsonrpc' in result ? result : buildJSONRPCResult(id, result)
			}
			default:
				return buildJSONRPCError(
					id,
					JSONRPC_METHOD_NOT_FOUND,
					`Method not found: ${request.method}`,
				)
		}
	}

	async #modern(request: JSONRPCRequest, id: string | number | null): Promise<JSONRPCResponse> {
		const context = parseRequestContext(request)
		if (context === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: malformed modern request metadata',
			)
		}
		if (inferEra(context.version) === undefined) {
			return buildJSONRPCError(
				id,
				MCP_UNSUPPORTED_VERSION,
				`Unsupported protocol version: ${context.version}`,
				{ supported: SUPPORTED_PROTOCOL_VERSIONS, requested: context.version },
			)
		}
		switch (request.method) {
			case 'server/discover':
				return buildJSONRPCResult(id, buildDiscoverResult(this.#options))
			case 'tools/list':
				return buildJSONRPCResult(
					id,
					buildModernResult(
						{ tools: buildToolDescriptors(this.#options.tools) },
						this.#options.identity,
						this.#options.cache?.ttl ?? DEFAULT_MCP_CACHE_TTL,
						this.#options.cache?.scope,
					),
				)
			case 'tools/call': {
				const result = await this.#call(request, id)
				return 'jsonrpc' in result
					? result
					: buildJSONRPCResult(id, buildModernResult(result, this.#options.identity))
			}
			default:
				return buildJSONRPCError(
					id,
					JSONRPC_METHOD_NOT_FOUND,
					`Method not found: ${request.method}`,
				)
		}
	}

	// Run a `tools/call`: narrow `params.name` (string) + `params.arguments` (record,
	// default `{}`) with no `as`, execute the tool (the manager isolates a throw into
	// `success: false`), and map the result to an MCP tool-call result.
	async #call(
		request: JSONRPCRequest,
		id: string | number | null,
	): Promise<MCPCallResult | JSONRPCResponse> {
		const params = request.params
		const name = params?.['name']
		if (!isString(name)) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: a string `name` is required',
			)
		}
		const rawArguments = params?.['arguments']
		const args = isRecord(rawArguments) ? rawArguments : {}
		const callId = request.id === undefined ? crypto.randomUUID() : String(request.id)
		const result = await this.#options.tools.execute({ id: callId, name, arguments: args })
		return buildCallResult(result)
	}
}
