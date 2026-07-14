import type { EmitterInterface } from '@orkestrel/emitter'
import type { ToolInterface } from '@orkestrel/agent'
import type {
	ClientTransportInterface,
	JSONRPCMessage,
	JSONRPCRequest,
	MCPClientEventMap,
	MCPClientInterface,
	MCPClientOptions,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import { Tool } from '@orkestrel/agent'
import { isArray, isRecord, isString } from '@orkestrel/contract'
import {
	DEFAULT_MCP_CLIENT_NAME,
	DEFAULT_MCP_CLIENT_VERSION,
	DEFAULT_MCP_REQUEST_TIMEOUT,
	MCP_PROTOCOL_VERSION,
} from './constants.js'
import { isJSONRPCResponse, isRequestId } from './validators.js'

/**
 * A transport-agnostic Model Context Protocol CLIENT — connects to a REMOTE MCP server
 * over an injected {@link ClientTransportInterface}, runs the `initialize` handshake,
 * and exposes the server's tools as local {@link ToolInterface}s an agent can run.
 *
 * @remarks
 * - **The mirror of `MCPServer`.** The server DISPATCHES requests over a tool registry;
 *   this client ISSUES them over a transport. `connect` runs `initialize` then sends
 *   `notifications/initialized`; `tools()` lists the remote tools and wraps each as a
 *   local {@link ToolInterface} whose `execute` calls back through `call`; `call` runs a
 *   remote `tools/call` and returns the tool's value (a remote `isError: true` throws
 *   locally, so an agent's {@link import('@orkestrel/agent').ToolManagerInterface}
 *   isolates it into a result `error` just like a local throw).
 * - **Request↔response correlation.** Each request is tagged with a monotonic numeric
 *   `id` ({@link #nextId}); a single transport `message` subscription resolves / rejects
 *   the matching {@link #pending} entry by `id`. A message that is NOT a response to a
 *   pending request is a server NOTIFICATION — re-surfaced on the `notification` event.
 * - **Per-request deadline.** `#request` races `AbortSignal.timeout(this.#timeout)` (the
 *   taverna idiom — never a raw `setTimeout`): a server that never replies REJECTS the
 *   pending request once the deadline fires, never hanging.
 * - **Transport-agnostic.** Imports only core siblings (JSON-RPC + the tool vocabulary);
 *   the concrete transport is injected. Wire fields are narrowed via the contracts
 *   guards (no `as`).
 * - **Observable (§13).** The owned `emitter` fires `connect` / `disconnect` /
 *   `notification` / `error`; the emitter isolates a listener throw and routes it to its
 *   `error` handler (the `error` option), so a listener throw can never escape.
 *
 * @example
 * ```ts
 * const client = new MCPClient({ transport, name: 'agent', version: '1.0.0' })
 * await client.connect()
 * const tools = await client.tools()
 * agent.context.tools.add(tools) // the remote tools are now the agent's
 * const value = await client.call('search', { query: 'mcp' })
 * ```
 */
export class MCPClient implements MCPClientInterface {
	readonly #emitter: Emitter<MCPClientEventMap>
	readonly #transport: ClientTransportInterface
	readonly #name: string
	readonly #version: string
	readonly #timeout: number
	// The in-flight requests, keyed by JSON-RPC id, each holding its promise settlers —
	// resolved on the matching response, rejected on an error response, the deadline, or
	// `disconnect`. Genuinely private glue (§5): the settler shape lives inline here.
	readonly #pending = new Map<
		string | number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>()
	#nextId = 0
	#connected = false

	constructor(options: MCPClientOptions) {
		this.#emitter = new Emitter<MCPClientEventMap>({ on: options.on, error: options.error })
		this.#transport = options.transport
		this.#name = options.name ?? DEFAULT_MCP_CLIENT_NAME
		this.#version = options.version ?? DEFAULT_MCP_CLIENT_VERSION
		this.#timeout = options.timeout ?? DEFAULT_MCP_REQUEST_TIMEOUT
		// One message subscription for the client's whole life: a response settles its
		// pending request by id; anything else is a server notification.
		this.#transport.emitter.on('message', (message) => this.#receive(message))
	}

	get emitter(): EmitterInterface<MCPClientEventMap> {
		return this.#emitter
	}

	get connected(): boolean {
		return this.#connected
	}

	get transport(): ClientTransportInterface {
		return this.#transport
	}

	on<K extends keyof MCPClientEventMap>(
		event: K,
		handler: (...args: MCPClientEventMap[K]) => void,
	): void {
		this.#emitter.on(event, handler)
	}

	async connect(): Promise<void> {
		if (this.#connected) return
		await this.#transport.start()
		// The MCP handshake: negotiate the protocol version + advertise (empty) client
		// capabilities + identify ourselves, then mark connected and fire the no-args
		// `notifications/initialized` (a notification — no id, no response).
		await this.#request('initialize', {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: this.#name, version: this.#version },
		})
		this.#connected = true
		await this.#transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
		this.#emitter.emit('connect')
	}

	async disconnect(): Promise<void> {
		if (!this.#connected) return
		this.#connected = false
		// Reject every still-pending request so no caller hangs past a disconnect, then
		// clear the map and tear the transport down.
		for (const pending of this.#pending.values()) {
			pending.reject(new Error('MCP client disconnected'))
		}
		this.#pending.clear()
		await this.#transport.close()
		this.#emitter.emit('disconnect')
	}

	async tools(): Promise<readonly ToolInterface[]> {
		const result = await this.#request('tools/list')
		// The wire shape is `{ tools: MCPToolDescriptor[] }` — narrow it (§14): a
		// non-record / non-array `tools` yields no tools rather than throwing.
		if (!isRecord(result) || !isArray(result['tools'])) return []
		const tools: ToolInterface[] = []
		for (const descriptor of result['tools']) {
			if (!isRecord(descriptor) || !isString(descriptor['name'])) continue
			const name = descriptor['name']
			tools.push(this.#tool(name, descriptor))
		}
		return tools
	}

	async call(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
		const result = await this.#request('tools/call', { name, arguments: args })
		// The inverse of the server's `buildToolResult`: concat the result's text blocks,
		// then either throw (a remote `isError`) or parse the JSON value.
		const text = this.#text(result)
		if (isRecord(result) && result['isError'] === true) {
			throw new Error(text.length > 0 ? text : `MCP tool '${name}' failed`)
		}
		// A success carries the value JSON-serialized into the text block(s); parse it,
		// falling back to the raw string when it is not JSON (the inverse of the server's
		// `JSON.stringify`, whose value-less result is an empty text block).
		if (text.length === 0) return undefined
		try {
			return JSON.parse(text)
		} catch {
			return text
		}
	}

	// Issue a request and await its correlated response, bounded by the per-request
	// deadline. A monotonic numeric id keys the pending settlers; `AbortSignal.timeout`
	// (the taverna idiom — never a raw setTimeout) rejects the pending request if the
	// server never answers. The transport `send` is awaited so a write failure rejects
	// here rather than leaving a pending request to time out.
	#request(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown> {
		this.#nextId += 1
		const id = this.#nextId
		const request: JSONRPCRequest = {
			jsonrpc: '2.0',
			id,
			method,
			...(params === undefined ? {} : { params }),
		}
		return new Promise<unknown>((resolve, reject) => {
			const deadline = AbortSignal.timeout(this.#timeout)
			// Settle once: clear the pending entry + detach the deadline listener, whichever
			// of (response | deadline | send-failure) fires first.
			const settle = (): void => {
				this.#pending.delete(id)
				deadline.removeEventListener('abort', onDeadline)
			}
			const onDeadline = (): void => {
				settle()
				reject(new Error(`MCP request '${method}' timed out after ${this.#timeout}ms`))
			}
			deadline.addEventListener('abort', onDeadline, { once: true })
			this.#pending.set(id, {
				resolve: (value) => {
					settle()
					resolve(value)
				},
				reject: (error) => {
					settle()
					reject(error)
				},
			})
			this.#transport.send(request).catch((error: unknown) => {
				const pending = this.#pending.get(id)
				if (pending === undefined) return
				pending.reject(error instanceof Error ? error : new Error(String(error)))
			})
		})
	}

	// Handle one inbound transport message: a response settles its pending request by
	// id (an error response rejects, a result resolves); anything else (a message with
	// no matching pending id) is a server-initiated notification, re-surfaced on the
	// `notification` event.
	#receive(message: JSONRPCMessage): void {
		if (isJSONRPCResponse(message) && isRequestId(message.id)) {
			const pending = this.#pending.get(message.id)
			if (pending !== undefined) {
				if (message.error !== undefined) {
					pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`))
				} else {
					pending.resolve(message.result)
				}
				return
			}
		}
		// Not a correlated response — a server notification (or an unsolicited response).
		this.#emitter.emit('notification', message)
	}

	// Wrap one remote tool descriptor as a local tool: map `inputSchema` → `parameters`
	// (the inverse of the server's rename, no `as`), carry `description` when present,
	// and bind `execute` to a remote `tools/call` via `call`.
	#tool(name: string, descriptor: Readonly<Record<string, unknown>>): ToolInterface {
		const inputSchema = descriptor['inputSchema']
		const description = descriptor['description']
		const options: {
			name: string
			description?: string
			parameters?: Readonly<Record<string, unknown>>
			execute: (args: Readonly<Record<string, unknown>>) => Promise<unknown>
		} = {
			name,
			execute: (args) => this.call(name, args),
		}
		if (isString(description)) options.description = description
		if (isRecord(inputSchema)) options.parameters = inputSchema
		return new Tool(options)
	}

	// Concatenate an MCP tool-call result's text content blocks into one string — the
	// inverse of the server splitting a value into text block(s). Total (§14): a
	// non-record result, a non-array `content`, or a non-string `text` contributes
	// nothing rather than throwing.
	#text(result: unknown): string {
		if (!isRecord(result) || !isArray(result['content'])) return ''
		const parts: string[] = []
		for (const block of result['content']) {
			if (isRecord(block) && isString(block['text'])) parts.push(block['text'])
		}
		return parts.join('\n')
	}
}
