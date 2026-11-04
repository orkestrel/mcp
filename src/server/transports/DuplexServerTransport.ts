import {
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_INVALID_REQUEST,
	buildJSONRPCError,
	isJSONRPCId,
	isJSONRPCInvocation,
} from '@orkestrel/jsonrpc'
import type { MCPMessageTransportInterface, MCPTransportInterface } from '@src/core'
import {
	MCPError,
	buildInboundFault,
	decodeEvent,
	isMCPError,
	parseJSONRPCMessage,
} from '@src/core'
import { isRecord } from '@orkestrel/contract'

/**
 * Bridges a message carrier to the server's serialized transport protocol.
 *
 * @remarks
 * Only an invocation crosses inbound. Anything else emits `error` on the carrier and is not
 * answered, because JSON-RPC gives no response to a response, with one exception: a malformed
 * request carrying a readable id receives `-32600`, because its sender is waiting on that id. The
 * carrier's own decode reports such a frame the same way, so one listener answers both. An
 * outbound message that cannot be decoded rejects `send` rather than vanishing.
 */
export class DuplexServerTransport implements MCPTransportInterface {
	readonly #transport: MCPMessageTransportInterface
	#message: ((message: string) => void) | undefined
	#closure: (() => void) | undefined

	constructor(transport: MCPMessageTransportInterface) {
		this.#transport = transport
		transport.emitter.on('message', (message) => {
			const snapshot = parseJSONRPCMessage(message)
			if (snapshot === undefined || !isJSONRPCInvocation(snapshot)) {
				transport.emitter.emit(
					'error',
					buildInboundFault(
						message,
						'MCP server transport received a message that is not a JSON-RPC request or notification',
					),
				)
				return
			}
			const handler = this.#message
			handler?.(JSON.stringify(snapshot))
		})
		transport.emitter.on('error', (error) => {
			const context = isMCPError(error) ? error.context : undefined
			const id = isRecord(context) ? context['id'] : undefined
			if (!isMCPError(error) || error.code !== JSONRPC_INVALID_REQUEST || !isJSONRPCId(id)) return
			transport
				.send(buildJSONRPCError(id, JSONRPC_INVALID_REQUEST, 'Invalid Request'))
				.catch((failure: unknown) => transport.emitter.emit('error', failure))
		})
		transport.emitter.on('close', () => {
			const handler = this.#closure
			handler?.()
		})
	}

	async send(message: string): Promise<void> {
		const decoded = decodeEvent(message)
		if (decoded === undefined) {
			throw new MCPError(
				'MCP server transport refused an outbound message that does not decode as JSON-RPC within the default content and depth limits',
				JSONRPC_INTERNAL_ERROR,
			)
		}
		await this.#transport.send(decoded)
	}

	listen(handler: (message: string) => void): void {
		this.#message = handler
	}

	closed(handler: () => void): void {
		this.#closure = handler
	}

	async close(): Promise<void> {
		await this.#transport.close()
	}
}
