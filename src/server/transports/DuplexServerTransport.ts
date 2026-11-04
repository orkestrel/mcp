import { JSONRPC_INTERNAL_ERROR, isJSONRPCInvocation } from '@orkestrel/jsonrpc'
import type { MCPMessageTransportInterface, MCPTransportInterface } from '@src/core'
import {
	MCPError,
	buildInboundAnswer,
	buildInboundFault,
	decodeEvent,
	parseJSONRPCMessage,
} from '@src/core'

/**
 * Bridges a message carrier to the server's serialized transport protocol.
 *
 * @remarks
 * Only an invocation crosses inbound. Anything else emits `error` on the carrier. A stray response
 * and a malformed notification are not answered, because JSON-RPC gives no response to a response
 * and a notification waits on nothing. Invalid JSON answers `-32700` and any other invalid request
 * answers `-32600`, under the id it carries or `null`. The carrier's own decode reports such a
 * frame the same way, so one listener answers both. An outbound message that cannot be decoded
 * rejects `send` rather than vanishing.
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
			const answer = buildInboundAnswer(error)
			if (answer === undefined) return
			transport.send(answer).catch((failure: unknown) => transport.emitter.emit('error', failure))
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
