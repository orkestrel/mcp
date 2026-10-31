import { isJSONRPCInvocation } from '@orkestrel/jsonrpc'
import type { MCPMessageTransportInterface, MCPTransportInterface } from '@src/core'
import { decodeEvent, parseJSONRPCMessage } from '@src/core'

/** Bridges a message carrier to the server's serialized transport protocol. */
export class DuplexServerTransport implements MCPTransportInterface {
	readonly #transport: MCPMessageTransportInterface
	#message: ((message: string) => void) | undefined
	#closure: (() => void) | undefined

	constructor(transport: MCPMessageTransportInterface) {
		this.#transport = transport
		transport.emitter.on('message', (message) => {
			const snapshot = parseJSONRPCMessage(message)
			if (snapshot === undefined || !isJSONRPCInvocation(snapshot)) return
			const handler = this.#message
			handler?.(JSON.stringify(snapshot))
		})
		transport.emitter.on('close', () => {
			const handler = this.#closure
			handler?.()
		})
	}

	async send(message: string): Promise<void> {
		const decoded = decodeEvent(message)
		if (decoded === undefined) return
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
