import type {
	JSONRPCMessage,
	JSONRPCResponse,
	MCPServerInterface,
	MCPTransportInterface,
} from '@src/core'
import { bindServer, parseJSONRPCMessage } from '@src/core'

/** A minimal protocol peer that exchanges serialized JSON-RPC over the real duplex port. */
export interface HostilePeerInterface {
	/** Every serialized message the server sent back over the port. */
	readonly messages: readonly string[]
	/** Send one raw wire message and allow the bound server pump to answer. */
	send(message: string): Promise<void>
	/** Decode every server message as a JSON-RPC message. */
	responses(): readonly JSONRPCMessage[]
	/** Return the newest server response, ignoring streamed notifications. */
	response(): JSONRPCResponse | undefined
	/** Clear recorded server messages without disconnecting. */
	clear(): void
	/** Detach the peer from the server. */
	close(): void
}

/**
 * Bind an MCP server to a minimal serialized-message peer.
 *
 * @remarks
 * The fixture owns only the real {@link MCPTransportInterface} framing seam: it sends raw
 * strings into {@link bindServer} and records raw strings sent back. Parsing, validation,
 * dispatch, limits, streaming, and error construction all remain project-owned behavior.
 *
 * @param server - The real MCP server under test
 * @returns A protocol peer for sending hostile wire messages and reading protocol answers
 */
export function createHostilePeer(server: MCPServerInterface): HostilePeerInterface {
	let listener: ((message: string) => void) | undefined
	let closed: (() => void) | undefined
	let waiting: (() => void) | undefined
	const messages: string[] = []
	const transport: MCPTransportInterface = {
		send(message) {
			messages.push(message)
			waiting?.()
			waiting = undefined
		},
		listen(handler) {
			listener = handler
		},
		closed(handler) {
			closed = handler
		},
		close() {
			closed?.()
		},
	}
	const unbind = bindServer(server, transport)
	return {
		get messages() {
			return messages
		},
		async send(message) {
			if (listener === undefined) throw new Error('hostile peer is not bound')
			await new Promise<void>((resolve) => {
				waiting = resolve
				listener?.(message)
			})
		},
		responses() {
			const decoded: JSONRPCMessage[] = []
			for (const message of messages) {
				const value: unknown = JSON.parse(message)
				const response = parseJSONRPCMessage(value)
				if (response === undefined) throw new Error('server sent a non-JSON-RPC fixture message')
				decoded.push(response)
			}
			return decoded
		},
		response() {
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				const message = messages[index]
				if (message === undefined) continue
				const value: unknown = JSON.parse(message)
				const response = parseJSONRPCMessage(value)
				if (response !== undefined && !('method' in response)) return response
			}
			return undefined
		},
		clear() {
			messages.length = 0
		},
		close() {
			unbind()
		},
	}
}
