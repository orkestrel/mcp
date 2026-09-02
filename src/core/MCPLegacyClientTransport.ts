import type { EmitterInterface } from '@orkestrel/emitter'
import type {
	JSONRPCId,
	JSONRPCMessage,
	JSONRPCResponse,
	MCPClientCapabilities,
	MCPMessageTransportEventMap,
	MCPMessageTransportInterface,
	MCPIdentity,
	MCPLegacyClientTransportOptions,
	MCPLegacyVersion,
	MCPServerCapabilities,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import { attempt, cloneJSONRecord, isString } from '@orkestrel/contract'
import {
	DEFAULT_MCP_CLIENT_NAME,
	DEFAULT_MCP_CLIENT_VERSION,
	DEFAULT_MCP_REQUEST_TIMEOUT,
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_INVALID_PARAMS,
	MCP_MODERN_VERSION,
	MCP_HANDSHAKE_VERSION,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_LEGACY_PROTOCOL_VERSIONS,
} from './constants.js'
import { MCPError } from './errors.js'
import {
	buildJSONRPCError,
	buildModernResult,
	legacyResultToModern,
	modernInvocationToLegacy,
} from './helpers.js'
import { parseJSONRPCMessage } from './parsers.js'
import {
	isJSONRPCResponse,
	isMCPLegacyResult,
	isMCPLegacyVersion,
	isMCPIdentity,
	isMCPServerCapabilities,
} from './validators.js'

/**
 * Adapts a legacy MCP peer to the modern client transport boundary.
 *
 * @remarks
 * `start` performs the legacy `initialize` handshake. The adapter answers
 * `server/discover` locally from that handshake, removes modern request metadata before writes,
 * restores legacy results to modern complete-result shapes before delivery, and bounds retained
 * request correlations with the configured deadline.
 */
export class MCPLegacyClientTransport implements MCPMessageTransportInterface {
	readonly #emitter = new Emitter<MCPMessageTransportEventMap>()
	readonly #transport: MCPMessageTransportInterface
	readonly #client: MCPIdentity
	readonly #capabilities: MCPClientCapabilities
	readonly #pin: MCPLegacyVersion | undefined
	readonly #timeout: number
	readonly #correlations = new Map<JSONRPCId, { readonly method: string }>()
	#handshake: PromiseWithResolvers<JSONRPCResponse> | undefined = undefined
	#instructions: string | undefined = undefined
	#server: MCPIdentity | undefined = undefined
	#supported: MCPServerCapabilities | undefined = undefined

	/**
	 * Creates a legacy client transport adapter.
	 *
	 * @param transport - The legacy peer transport
	 * @param options - The legacy handshake identity, capabilities, revision, and deadline
	 */
	constructor(transport: MCPMessageTransportInterface, options?: MCPLegacyClientTransportOptions) {
		const requested: unknown = options?.version
		if (requested !== undefined && !isMCPLegacyVersion(requested)) {
			throw new MCPError('Unsupported legacy protocol version', MCP_UNSUPPORTED_VERSION, {
				requested,
			})
		}
		this.#transport = transport
		this.#client = options?.identity ?? {
			name: DEFAULT_MCP_CLIENT_NAME,
			version: DEFAULT_MCP_CLIENT_VERSION,
		}
		this.#capabilities = options?.capabilities ?? {}
		this.#pin = requested
		this.#timeout = options?.timeout ?? DEFAULT_MCP_REQUEST_TIMEOUT
		transport.emitter.on('message', (message) => this.#receive(message))
		transport.emitter.on('close', () => this.#emitter.emit('close'))
		transport.emitter.on('error', (error) => this.#emitter.emit('error', error))
	}

	get emitter(): EmitterInterface<MCPMessageTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		return this.#transport.session
	}

	get duplex(): boolean {
		return this.#transport.duplex
	}

	async start(): Promise<void> {
		await this.#transport.start()
		try {
			await this.#initialize()
		} catch (error) {
			try {
				await this.#transport.close()
			} catch (fault) {
				this.#emitter.emit('error', fault)
			}
			throw error
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!('method' in message)) {
			await this.#transport.send(message)
			return
		}
		if (message.method === 'server/discover' && message.id !== undefined) {
			this.#discover(message.id)
			return
		}
		const id = message.id
		let correlation: { readonly method: string } | undefined
		if (id !== undefined) {
			correlation = { method: message.method }
			this.#correlations.set(id, correlation)
			const deadline = AbortSignal.timeout(this.#timeout)
			deadline.addEventListener(
				'abort',
				() => {
					if (this.#correlations.get(id) !== correlation) return
					this.#reject(
						id,
						new MCPError(
							`Legacy MCP request timed out after ${this.#timeout}ms`,
							JSONRPC_INTERNAL_ERROR,
						),
					)
				},
				{ once: true },
			)
		}
		try {
			await this.#transport.send(modernInvocationToLegacy(message))
		} catch (error) {
			if (id !== undefined && this.#correlations.get(id) === correlation) {
				this.#correlations.delete(id)
			}
			throw error
		}
	}

	/**
	 * Closes the wrapped transport and clears retained adapter state.
	 *
	 * @remarks
	 * The cleared handshake state — the server identity, the supported reading, and the retained
	 * `instructions` value — is unobservable between `close()` and the next accepted handshake.
	 * Discovery answers the pre-handshake refusal in that window, and the accepted handshake
	 * reassigns the state unconditionally.
	 *
	 * @returns Resolves after the wrapped transport closes
	 */
	async close(): Promise<void> {
		this.#instructions = undefined
		this.#server = undefined
		this.#supported = undefined
		this.#correlations.clear()
		await this.#transport.close()
	}

	async #initialize(): Promise<void> {
		const handshake = Promise.withResolvers<JSONRPCResponse>()
		this.#handshake = handshake
		try {
			await this.#write({
				jsonrpc: '2.0',
				id: 0,
				method: 'initialize',
				params: {
					protocolVersion: this.#pin ?? MCP_HANDSHAKE_VERSION,
					capabilities: this.#capabilities,
					clientInfo: this.#client,
				},
			})
			const deadline = AbortSignal.timeout(this.#timeout)
			deadline.addEventListener(
				'abort',
				() =>
					handshake.reject(
						new MCPError(
							`Legacy MCP handshake timed out after ${this.#timeout}ms`,
							MCP_UNSUPPORTED_VERSION,
						),
					),
				{ once: true },
			)
			const response = await handshake.promise
			this.#accept(response)
			await this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' })
		} finally {
			if (this.#handshake === handshake) this.#handshake = undefined
		}
	}

	#accept(response: JSONRPCResponse): void {
		if (response.error !== undefined) {
			throw new MCPError(response.error.message, response.error.code, response.error.data)
		}
		const owned = attempt(() => cloneJSONRecord(response.result))
		if (!owned.success || !isMCPLegacyResult(owned.value)) {
			throw new MCPError('Legacy MCP handshake returned a malformed result', JSONRPC_INVALID_PARAMS)
		}
		const result = owned.value
		const protocol = result['protocolVersion']
		const capabilities = result['capabilities']
		const identity = result['serverInfo']
		const instructions = result['instructions']
		if (protocol === undefined) {
			throw new MCPError(
				'Legacy MCP handshake returned no protocol version',
				JSONRPC_INVALID_PARAMS,
				result,
			)
		}
		if (!isString(protocol)) {
			throw new MCPError(
				'Legacy MCP handshake returned a malformed protocol version',
				JSONRPC_INVALID_PARAMS,
				result,
			)
		}
		if (!isMCPLegacyVersion(protocol)) {
			throw new MCPError(
				`Legacy MCP peer negotiated unsupported protocol version '${protocol}'`,
				MCP_UNSUPPORTED_VERSION,
				{ supported: SUPPORTED_LEGACY_PROTOCOL_VERSIONS, negotiated: protocol },
			)
		}
		if (
			!isMCPServerCapabilities(capabilities) ||
			!isMCPIdentity(identity) ||
			(instructions !== undefined && !isString(instructions))
		) {
			throw new MCPError(
				'Legacy MCP handshake returned a malformed result',
				JSONRPC_INVALID_PARAMS,
				result,
			)
		}
		if (this.#pin !== undefined && protocol !== this.#pin) {
			throw new MCPError(
				'Legacy MCP peer negotiated a different protocol version than the adapter requested',
				MCP_UNSUPPORTED_VERSION,
				{ requested: this.#pin, negotiated: protocol },
			)
		}
		this.#instructions = instructions
		this.#server = identity
		this.#supported = capabilities
	}

	async #write(message: JSONRPCMessage): Promise<void> {
		const deadline = AbortSignal.timeout(this.#timeout)
		await Promise.race([
			this.#transport.send(message),
			new Promise<never>((_resolve, reject) =>
				deadline.addEventListener(
					'abort',
					() =>
						reject(
							new MCPError(
								`Legacy MCP handshake write timed out after ${this.#timeout}ms`,
								MCP_UNSUPPORTED_VERSION,
							),
						),
					{ once: true },
				),
			),
		])
	}

	#discover(id: JSONRPCId): void {
		const identity = this.#server
		const capabilities = this.#supported
		if (identity === undefined || capabilities === undefined) {
			this.#reject(
				id,
				new MCPError(
					'Legacy MCP transport has not completed its handshake',
					JSONRPC_INTERNAL_ERROR,
				),
			)
			return
		}
		this.#emitter.emit('message', {
			jsonrpc: '2.0',
			id,
			result: buildModernResult(
				{
					supportedVersions: [MCP_MODERN_VERSION],
					capabilities,
					...(this.#instructions === undefined ? {} : { instructions: this.#instructions }),
				},
				identity,
				0,
			),
		})
	}

	#receive(message: JSONRPCMessage): void {
		const owned = parseJSONRPCMessage(message)
		if (owned === undefined) {
			this.#emitter.emit(
				'error',
				new MCPError('Legacy MCP peer returned a malformed message', JSONRPC_INVALID_PARAMS),
			)
			return
		}
		const handshake = this.#handshake
		if (handshake !== undefined && isJSONRPCResponse(owned) && owned.id === 0) {
			handshake.resolve(owned)
			return
		}
		if (!isJSONRPCResponse(owned) || owned.id === undefined) {
			this.#emitter.emit('message', owned)
			return
		}
		const correlation = this.#correlations.get(owned.id)
		if (correlation === undefined) {
			this.#emitter.emit('message', owned)
			return
		}
		this.#correlations.delete(owned.id)
		const method = correlation.method
		if (owned.error !== undefined) {
			this.#emitter.emit('message', owned)
			return
		}
		const identity = this.#server
		if (identity === undefined || !isMCPLegacyResult(owned.result)) {
			this.#reject(
				owned.id,
				new MCPError('Legacy MCP peer returned a malformed result', JSONRPC_INTERNAL_ERROR),
			)
			return
		}
		this.#emitter.emit('message', {
			jsonrpc: '2.0',
			id: owned.id,
			result: legacyResultToModern(owned.result, method, identity),
		})
	}

	#reject(id: JSONRPCId, error: MCPError): void {
		this.#correlations.delete(id)
		this.#emitter.emit('error', error)
		this.#emitter.emit('message', buildJSONRPCError(id, error.code, error.message))
	}
}
