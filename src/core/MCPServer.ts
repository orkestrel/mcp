import type { EmitterInterface } from '../emitters/types.js'
import type { ToolManagerInterface } from '../agents/types.js'
import type {
	JSONRPCRequest,
	JSONRPCResponse,
	MCPServerEventMap,
	MCPServerInterface,
	MCPServerOptions,
} from './types.js'
import { Emitter } from '../emitters/Emitter.js'
import { isRecord, isString } from '../contracts/index.js'
import {
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
} from './constants.js'
import {
	buildToolDescriptors,
	buildToolResult,
	initializeResult,
	jsonRPCError,
	jsonRPCResult,
} from './helpers.js'
import { parseJSONRPCMessage } from './parsers.js'

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
 * - **The method switch.** `initialize` negotiates the protocol version + advertises
 *   the tools capability; `notifications/initialized` is a notification (no
 *   response); `ping` returns `{}`; `tools/list` lists the registry's tools (its
 *   `parameters` renamed to `inputSchema`); `tools/call` runs a tool by name (the
 *   {@link ToolManagerInterface} isolates a tool throw into the result `error`, which
 *   maps to an `isError: true` tool result — so the server adds NO try/catch). An
 *   unknown method → `-32601`; a `tools/call` with a missing / non-string `name` →
 *   `-32602`.
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
 * const server = new MCPServer({ name: 'demo', version: '1.0.0', tools })
 * await server.handle('{"jsonrpc":"2.0","method":"ping","id":1}') // '{"jsonrpc":"2.0","id":1,"result":{}}'
 * ```
 */
export class MCPServer implements MCPServerInterface {
	readonly #emitter: Emitter<MCPServerEventMap>
	readonly #name: string
	readonly #version: string
	readonly #tools: ToolManagerInterface

	constructor(options: MCPServerOptions) {
		this.#emitter = new Emitter<MCPServerEventMap>({ on: options.on, error: options.error })
		this.#name = options.name
		this.#version = options.version
		this.#tools = options.tools
	}

	get emitter(): EmitterInterface<MCPServerEventMap> {
		return this.#emitter
	}

	get name(): string {
		return this.#name
	}

	get version(): string {
		return this.#version
	}

	async dispatch(request: JSONRPCRequest): Promise<JSONRPCResponse | undefined> {
		const id = request.id ?? null
		this.#emitter.emit('request', request.method, id)
		// JSON-RPC: a request with NO `id` is a NOTIFICATION — it is handled (the
		// `request` event already fired) but NEVER produces a response, whatever its
		// method (`notifications/initialized`, a fire-and-forget `ping`, an unknown
		// method — all silent). So short-circuit here, and the switch below only ever
		// runs for an id-bearing request that expects a reply.
		if (request.id === undefined) {
			return undefined
		}
		switch (request.method) {
			case 'initialize': {
				const requested = request.params?.['protocolVersion']
				return jsonRPCResult(
					id,
					initializeResult(this.#name, this.#version, isString(requested) ? requested : undefined),
				)
			}
			case 'ping':
				return jsonRPCResult(id, {})
			case 'tools/list':
				return jsonRPCResult(id, { tools: buildToolDescriptors(this.#tools) })
			case 'tools/call':
				return this.#call(request, id)
			default:
				return jsonRPCError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${request.method}`)
		}
	}

	async handle(message: string): Promise<string | undefined> {
		let parsed: unknown
		try {
			parsed = JSON.parse(message)
		} catch {
			return JSON.stringify(jsonRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'))
		}
		const decoded = parseJSONRPCMessage(parsed)
		// Only a REQUEST is dispatchable — a response (or any non-message) is invalid input.
		if (decoded === undefined || !('method' in decoded)) {
			return JSON.stringify(jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request'))
		}
		const response = await this.dispatch(decoded)
		return response === undefined ? undefined : JSON.stringify(response)
	}

	// Run a `tools/call`: narrow `params.name` (string) + `params.arguments` (record,
	// default `{}`) with no `as`, execute the tool (the manager isolates a throw into
	// `result.error`), and map the result to an MCP tool-call result.
	async #call(request: JSONRPCRequest, id: string | number | null): Promise<JSONRPCResponse> {
		const params = request.params
		const name = params?.['name']
		if (!isString(name)) {
			return jsonRPCError(id, JSONRPC_INVALID_PARAMS, 'Invalid params: a string `name` is required')
		}
		const rawArguments = params?.['arguments']
		const args = isRecord(rawArguments) ? rawArguments : {}
		const callId = request.id === undefined ? crypto.randomUUID() : String(request.id)
		const result = await this.#tools.execute({ id: callId, name, arguments: args })
		return jsonRPCResult(id, buildToolResult(result))
	}
}
