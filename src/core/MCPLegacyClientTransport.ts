import type { EmitterInterface } from '@orkestrel/emitter'
import type {
	JSONRPCId,
	JSONRPCMessage,
	JSONRPCResponse,
	MCPClientCapabilities,
	MCPClientTransportEventMap,
	MCPClientTransportInterface,
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
	JSONRPC_INVALID_PARAMS,
	MCP_META_SERVER,
	MCP_MODERN_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_UNSUPPORTED_VERSION,
} from './constants.js'
import { MCPError } from './errors.js'
import { legacyResultToModern, modernInvocationToLegacy } from './helpers.js'
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
 * and restores legacy results to modern complete-result shapes before delivery.
 */
export class MCPLegacyClientTransport implements MCPClientTransportInterface {
	readonly #emitter = new Emitter<MCPClientTransportEventMap>()
	readonly #transport: MCPClientTransportInterface
	readonly #client: MCPIdentity
	readonly #capabilities: MCPClientCapabilities
	readonly #pin: MCPLegacyVersion | undefined
	readonly #timeout: number
	readonly #methods = new Map<JSONRPCId, string>()
	#handshake: PromiseWithResolvers<JSONRPCResponse> | undefined = undefined
	#server: MCPIdentity | undefined = undefined
	#supported: MCPServerCapabilities | undefined = undefined

	/**
	 * Creates a legacy client transport adapter.
	 *
	 * @param transport - The legacy peer transport
	 * @param options - The legacy handshake identity, capabilities, revision, and deadline
	 */
	constructor(
		transport: MCPClientTransportInterface,
		options?: MCPLegacyClientTransportOptions,
	) {
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

	get emitter(): EmitterInterface<MCPClientTransportEventMap> {
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
		if (message.id !== undefined) this.#methods.set(message.id, message.method)
		await this.#transport.send(modernInvocationToLegacy(message))
	}

	async close(): Promise<void> {
		this.#server = undefined
		this.#supported = undefined
		this.#methods.clear()
		await this.#transport.close()
	}

	async #initialize(): Promise<void> {
		const handshake = Promise.withResolvers<JSONRPCResponse>()
		this.#handshake = handshake
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
		try {
			await this.#transport.send({
				jsonrpc: '2.0',
				id: 0,
				method: 'initialize',
				params: {
					protocolVersion: this.#pin ?? MCP_PROTOCOL_VERSION,
					capabilities: this.#capabilities,
					clientInfo: this.#client,
				},
			})
			const response = await handshake.promise
			this.#accept(response)
			await this.#transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
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
			throw new MCPError(
				'Legacy MCP handshake returned a malformed result',
				JSONRPC_INVALID_PARAMS,
			)
		}
		const result = owned.value
		const protocol = result['protocolVersion']
		const capabilities = result['capabilities']
		const identity = result['serverInfo']
		if (
			!isString(protocol) ||
			!isMCPLegacyVersion(protocol) ||
			!isMCPServerCapabilities(capabilities) ||
			!isMCPIdentity(identity)
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
		this.#server = identity
		this.#supported = capabilities
	}

	#discover(id: JSONRPCId): void {
		const identity = this.#server
		const capabilities = this.#supported
		if (identity === undefined || capabilities === undefined) {
			this.#emitter.emit('error', new Error('Legacy MCP transport has not completed its handshake'))
			return
		}
		this.#emitter.emit('message', {
			jsonrpc: '2.0',
			id,
			result: {
				supportedVersions: [MCP_MODERN_VERSION],
				capabilities,
				resultType: 'complete',
				ttlMs: 0,
				cacheScope: 'private',
				_meta: { [MCP_META_SERVER]: identity },
			},
		})
	}

	#receive(message: JSONRPCMessage): void {
		const owned = parseJSONRPCMessage(message)
		if (owned === undefined) {
			this.#emitter.emit('error', new MCPError('Legacy MCP peer returned a malformed message', JSONRPC_INVALID_PARAMS))
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
		const method = this.#methods.get(owned.id)
		if (method === undefined) {
			this.#emitter.emit('message', owned)
			return
		}
		this.#methods.delete(owned.id)
		if (owned.error !== undefined) {
			this.#emitter.emit('message', owned)
			return
		}
		const identity = this.#server
		if (identity === undefined || !isMCPLegacyResult(owned.result)) {
			this.#emitter.emit(
				'error',
				new MCPError('Legacy MCP peer returned a malformed result', JSONRPC_INVALID_PARAMS),
			)
			return
		}
		this.#emitter.emit('message', {
			jsonrpc: '2.0',
			id: owned.id,
			result: legacyResultToModern(owned.result, method, identity),
		})
	}
}
