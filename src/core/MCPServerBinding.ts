import type { JSONRPCId } from '@orkestrel/jsonrpc'
import { JSONRPC_INVALID_REQUEST } from '@orkestrel/jsonrpc'
import type { MCPBindingInterface, MCPDispatcherInterface, MCPTransportInterface } from './types.js'
import { isString } from '@orkestrel/contract'
import { MCPError } from './errors.js'
import { decodeBoundedMessage, readCancelledId, sendStream } from './helpers.js'

/** Owns the request lifetimes installed on a server's duplex carrier. */
export class MCPServerBinding implements MCPBindingInterface {
	readonly #server: MCPDispatcherInterface
	readonly #transport: MCPTransportInterface
	readonly #live = new Map<JSONRPCId, AbortController>()
	#active = true

	constructor(server: MCPDispatcherInterface, transport: MCPTransportInterface) {
		this.#server = server
		this.#transport = transport
		transport.listen(this.#receive.bind(this))
		transport.closed(this.#close.bind(this))
	}

	/** Aborts live requests and replaces the carrier callbacks without closing it. */
	stop(): void {
		this.#close()
		this.#transport.listen(() => {})
		this.#transport.closed(() => {})
	}

	#close(): void {
		this.#active = false
		for (const pending of this.#live.values()) pending.abort()
		this.#live.clear()
	}

	#report(error: unknown): void {
		try {
			this.#server.emitter.emit('error', error)
		} catch {
			// The caller's error observer has no further reporting channel.
		}
	}

	async #receive(message: string): Promise<void> {
		if (!this.#active) return
		const decoded = decodeBoundedMessage(message, {
			bytes: this.#server.limit.message,
			depth: this.#server.limit.depth,
		})
		if (decoded !== undefined && !('method' in decoded)) {
			this.#report(
				new MCPError(
					'MCP server transport received a response, which JSON-RPC does not answer; a peer sends this server requests and notifications',
					JSONRPC_INVALID_REQUEST,
				),
			)
			return
		}
		const cancelled = decoded === undefined ? undefined : readCancelledId(decoded)
		if (cancelled !== undefined) {
			this.#live.get(cancelled)?.abort()
			return
		}
		const id = decoded === undefined ? undefined : decoded.id
		const request = new AbortController()
		if (id !== undefined) this.#live.set(id, request)
		try {
			const answer = await this.#server.handle(message, { signal: request.signal })
			if (answer === undefined) return
			if (isString(answer)) {
				if (!request.signal.aborted) await this.#transport.send(answer)
			} else if (request.signal.aborted) await answer[Symbol.asyncDispose]()
			else await sendStream(answer, this.#transport)
		} catch (error) {
			if (!request.signal.aborted) this.#report(error)
		} finally {
			if (id !== undefined && this.#live.get(id) === request) this.#live.delete(id)
		}
	}
}
