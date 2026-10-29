import type { MCPServerInterface } from '@src/core'
import type { ScopeInterface, ScopeServerInterface, ScopeServerOptions } from './types.js'
import { bindServer, createMCPServer } from '@src/core'
import { isString } from '@orkestrel/contract'
import { DEFAULT_MCP_SERVER_NAME, DEFAULT_MCP_SERVER_VERSION } from './constants.js'
import { MessagePortTransport } from './transports/MessagePortTransport.js'
import { ScopeTransport } from './transports/ScopeTransport.js'

/** Owns a scope's implicit binding and every accepted client-port binding. */
export class ScopeServer implements ScopeServerInterface {
	readonly #scope: ScopeInterface
	readonly #server: MCPServerInterface
	readonly #transport: ScopeTransport
	readonly #accept: ScopeServerOptions['accept']
	readonly #listener: (event: MessageEvent) => void
	readonly #unbind: () => void
	readonly #teardowns = new Map<MessagePort, () => void>()
	#stopped = false

	constructor(options: ScopeServerOptions, scope: ScopeInterface = globalThis) {
		this.#scope = scope
		this.#server = createMCPServer({
			tools: options.tools,
			identity: {
				name: options.name ?? DEFAULT_MCP_SERVER_NAME,
				version: options.version ?? DEFAULT_MCP_SERVER_VERSION,
			},
		})
		this.#transport = new ScopeTransport(scope)
		this.#accept = options.accept?.bind(options)
		this.#unbind = bindServer(this.#server, this.#transport)
		this.#listener = this.#receive.bind(this)
		scope.addEventListener('message', this.#listener)
	}

	/** Releases the scope listener and all bindings once. */
	stop(): void {
		if (this.#stopped) return
		this.#stopped = true
		this.#scope.removeEventListener('message', this.#listener)
		this.#unbind()
		for (const teardown of this.#teardowns.values()) teardown()
		this.#teardowns.clear()
	}

	#receive(event: MessageEvent): void {
		const ports = event.ports
		if (ports.length > 0) {
			if (this.#accept !== undefined && !this.#accept(event)) return
			const port = ports[0]
			if (port === undefined || this.#teardowns.has(port)) return
			const transport = new MessagePortTransport({ port })
			const unbind = bindServer(this.#server, transport)
			this.#teardowns.set(port, () => {
				unbind()
				transport.close()
			})
			return
		}
		if (isString(event.data)) this.#transport.deliver(event.data)
	}
}
