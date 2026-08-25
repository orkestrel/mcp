import type {
	JSONRPCErrorResponse,
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPDispatchOptions,
	MCPDispatcherInterface,
	MCPLegacyOptions,
	MCPLegacyResult,
	MCPLimitOptions,
	MCPStreamControllerInterface,
	MCPTextStreamControllerInterface,
} from './types.js'
import { isRecord, isString } from '@orkestrel/contract'
import {
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_SERVER_ERROR,
	MCP_EXTENSION_TASKS,
	MCP_META_CAPABILITIES,
	MCP_META_SERVER,
	MCP_META_VERSION,
	MCP_MISSING_CAPABILITY,
	MCP_MODERN_VERSION,
	MCP_PROTOCOL_VERSION,
} from './constants.js'
import { buildInitializeResult, buildJSONRPCError, buildJSONRPCResult } from './helpers.js'
import { isJSONRPCInvocation, isModernRequest } from './validators.js'

/**
 * Translates the fixed legacy method set onto one modern dispatcher.
 *
 * @remarks
 * This decorator owns no execution engine or result normalizer. Modern invocations
 * pass through untouched. Legacy tool methods acquire modern request metadata, run
 * through the configured dispatcher, and lose only fields their dated result shape
 * cannot represent.
 */
export class MCPLegacy implements MCPDispatcherInterface {
	readonly #options: MCPLegacyOptions

	/**
	 * Creates a legacy decorator.
	 *
	 * @param options - The sole dispatcher and legacy handshake identity
	 */
	constructor(options: MCPLegacyOptions) {
		this.#options = options
	}

	get emitter(): MCPDispatcherInterface['emitter'] {
		return this.#options.dispatcher.emitter
	}

	get limit(): Required<MCPLimitOptions> {
		return this.#options.dispatcher.limit
	}

	dispatch(
		request: JSONRPCRequest,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface>
	dispatch(notification: JSONRPCNotification, options?: MCPDispatchOptions): Promise<undefined>
	dispatch(
		invocation: JSONRPCInvocation,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface | undefined>
	async dispatch(
		invocation: JSONRPCInvocation,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface | undefined> {
		if (isModernRequest(invocation)) {
			return this.#options.dispatcher.dispatch(invocation, options)
		}
		if (!isJSONRPCInvocation(invocation)) {
			return this.#options.dispatcher.dispatch(invocation, options)
		}
		return this.#legacy(invocation, options)
	}

	async handle(
		message: string,
		options?: MCPDispatchOptions,
	): Promise<string | MCPTextStreamControllerInterface | undefined> {
		let parsed: unknown
		try {
			parsed = JSON.parse(message)
		} catch {
			return this.#options.dispatcher.handle(message, options)
		}
		if (isModernRequest(parsed) || !isJSONRPCInvocation(parsed)) {
			return this.#options.dispatcher.handle(message, options)
		}
		const answer = await this.#legacy(parsed, options)
		return answer === undefined ? undefined : JSON.stringify(answer)
	}

	async #legacy(
		invocation: JSONRPCInvocation,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | undefined> {
		if (invocation.id === undefined) return undefined
		const id = invocation.id
		switch (invocation.method) {
			case 'initialize': {
				const requested = invocation.params?.['protocolVersion']
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
				return this.#forward(invocation, options)
			case 'tools/call':
				// `-32602` is honest here: these parameters belong to MRTR, which the dated
				// protocol could not have produced and therefore cannot continue.
				if (
					invocation.params !== undefined &&
					(Object.hasOwn(invocation.params, 'requestState') ||
						Object.hasOwn(invocation.params, 'inputResponses'))
				) {
					return buildJSONRPCError(
						id,
						JSONRPC_INVALID_PARAMS,
						'Invalid params: legacy requests cannot continue an input-required result',
					)
				}
				return this.#forward(invocation, options)
			default:
				return buildJSONRPCError(
					id,
					JSONRPC_METHOD_NOT_FOUND,
					`Method not found: ${invocation.method}`,
				)
		}
	}

	async #forward(request: JSONRPCRequest, options?: MCPDispatchOptions): Promise<JSONRPCResponse> {
		const params = request.params ?? {}
		const metadata = isRecord(params['_meta']) ? params['_meta'] : {}
		const translated: JSONRPCRequest = {
			...request,
			params: {
				...params,
				_meta: {
					...metadata,
					[MCP_META_VERSION]: MCP_MODERN_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		}
		const answer = await this.#options.dispatcher.dispatch(translated, options)
		if (Symbol.asyncIterator in answer) {
			answer.stop()
			await answer[Symbol.asyncDispose]()
			return this.#unsupported(request.id, 'stream')
		}
		return this.#project(answer, request.id)
	}

	#project(answer: JSONRPCResponse, id: JSONRPCId): JSONRPCResponse {
		if (answer.error !== undefined) {
			return answer.error.code === MCP_MISSING_CAPABILITY
				? this.#unsupported(id, this.#capability(answer))
				: answer
		}
		if (answer.result.resultType !== 'complete') {
			return this.#unsupported(id, answer.result.resultType ?? 'unstamped')
		}
		const projected: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(answer.result)) {
			if (key === 'resultType' || key === 'ttlMs' || key === 'cacheScope') continue
			if (key === 'content' && Array.isArray(value)) {
				projected[key] = value.map((entry) =>
					isRecord(entry) && entry['type'] === 'text' && isString(entry['text'])
						? { type: 'text', text: entry['text'] }
						: entry,
				)
				continue
			}
			if (key !== '_meta' || !isRecord(value)) {
				projected[key] = value
				continue
			}
			const metadata: Record<string, unknown> = {}
			for (const [name, entry] of Object.entries(value)) {
				if (name !== MCP_META_SERVER) metadata[name] = entry
			}
			if (Object.keys(metadata).length > 0) projected['_meta'] = metadata
		}
		const result: MCPLegacyResult = projected
		return buildJSONRPCResult(id, result)
	}

	#capability(answer: JSONRPCErrorResponse): string {
		const data = answer.error.data
		if (!isRecord(data)) return 'capability-dependent'
		const required = data['requiredCapabilities']
		if (!isRecord(required)) return 'capability-dependent'
		const extensions = required['extensions']
		return isRecord(extensions) && Object.hasOwn(extensions, MCP_EXTENSION_TASKS)
			? 'task'
			: 'input-required'
	}

	#unsupported(id: JSONRPCId, result: string): JSONRPCErrorResponse {
		const article = result === 'input-required' ? 'an' : 'a'
		return buildJSONRPCError(
			id,
			JSONRPC_SERVER_ERROR,
			`Legacy protocol ${MCP_PROTOCOL_VERSION} cannot represent ${article} ${result} result`,
		)
	}
}
