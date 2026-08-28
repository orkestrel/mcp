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
	MCPLimitOptions,
	MCPStreamControllerInterface,
	MCPTextStreamControllerInterface,
} from './types.js'
import { isRecord, isString, parseJSON } from '@orkestrel/contract'
import {
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_SERVER_ERROR,
	MCP_EXTENSION_TASKS,
	MCP_MISSING_CAPABILITY,
	MCP_HANDSHAKE_VERSION,
} from './constants.js'
import {
	buildInitializeResult,
	buildJSONRPCError,
	buildJSONRPCResult,
	legacyInvocationToModern,
	modernResultToLegacy,
} from './helpers.js'
import { parseJSONRPCMessage } from './parsers.js'
import { isBoundedString, isJSONRPCInvocation, isModernRequest } from './validators.js'

/**
 * Translates the fixed legacy method set onto one modern dispatcher.
 *
 * @remarks
 * This decorator answers `initialize` and `ping` itself, under the limits the configured
 * dispatcher advertises through {@link MCPLegacy.limit}: an invocation outside the message
 * bound earns the same id-less `-32600` refusal the dispatcher produces, whether this
 * decorator would have answered it or forwarded it. It owns no result normalizer. Modern
 * invocations pass through untouched. Legacy tool methods acquire modern request metadata,
 * run through the configured dispatcher, and lose only fields their dated result shape
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
		// The bound the dispatcher advertises is applied BEFORE this door parses: an oversized
		// message is refused rather than decoded, and it is refused the way the dispatcher
		// refuses one.
		if (!isBoundedString(message, this.limit.message)) {
			return JSON.stringify(
				buildJSONRPCError(undefined, JSONRPC_INVALID_REQUEST, 'Invalid Request'),
			)
		}
		// `parseJSON` is the declared JSON boundary: unparsable text answers `undefined`, which
		// the invocation check below forwards along with every other shape this layer does not
		// translate — so the boundary needs no branch of its own.
		const parsed = parseJSON(message)
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
		// The same bound on the typed door, applied before the switch so a locally answered
		// method and a forwarded one give one answer for an oversized invocation.
		if (
			parseJSONRPCMessage(invocation, { bytes: this.limit.message, depth: this.limit.depth }) ===
			undefined
		) {
			return buildJSONRPCError(undefined, JSONRPC_INVALID_REQUEST, 'Invalid Request')
		}
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
		const translated = legacyInvocationToModern(request)
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
		const projected = modernResultToLegacy(answer.result)
		if (projected === undefined) {
			return this.#unsupported(id, answer.result.resultType ?? 'unstamped')
		}
		return buildJSONRPCResult(id, projected)
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
			`Legacy protocol ${MCP_HANDSHAKE_VERSION} cannot represent ${article} ${result} result`,
		)
	}
}
