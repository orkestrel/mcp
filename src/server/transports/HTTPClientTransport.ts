import type { ClientTransportEventMap, ClientTransportInterface, JSONRPCMessage } from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { HTTPClientTransportOptions } from '../types.js'
import {
	MCP_META_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	isJSONRPCRequest,
	isJSONRPCResponse,
	isModernRequest,
	parseJSONRPCMessage,
} from '@src/core'
import { isRecord, isString } from '@orkestrel/contract'
import { Emitter } from '@orkestrel/emitter'
import {
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_SESSION_HEADER,
} from '../constants.js'
import { readEventStream } from '../helpers.js'

/**
 * The HTTP CLIENT transport for the Model Context Protocol — a
 * {@link ClientTransportInterface} that drives a REMOTE Streamable-HTTP MCP server over
 * `fetch`, the egress mirror of the server's `createMCPRoutes`.
 *
 * @remarks
 * - **Request/response over `fetch`.** `send(message)` POSTs the JSON-serialized
 *   message to `options.url` with `content-type: application/json` and an
 *   `Accept` of BOTH `application/json` and `text/event-stream` (so the server may
 *   answer with either framing) — plus any `options.headers` (e.g. an `Authorization`
 *   bearer). It then decodes the reply and emits each decoded {@link JSONRPCMessage} on
 *   the `message` event the {@link import('@src/core').MCPClientInterface} subscribes
 *   to.
 * - **Both reply framings.** A `200` with an `application/json` body is parsed with
 *   `parseJSONRPCMessage`; a `200` with a `text/event-stream` body is decoded via the
 *   `@orkestrel/sse` {@link import('@orkestrel/sse').SSEParserInterface} ({@link
 *   readEventStream}) — the inverse of the server's `openStream` seam, so the wire
 *   round-trips. A `202`
 *   Accepted (a notification) carries no body and emits nothing.
 * - **Session and protocol headers.** `start()` is a no-op (a
 *   request/response transport opens no long-lived connection). The
 *   `mcp-session-id` response header, when a STATEFUL server sends one (on
 *   `initialize`), is captured into `session` and then ECHOED as the
 *   `mcp-session-id` request header on every SUBSEQUENT request — so an
 *   `MCPClient` passes a stateful server's session validation. The
 *   initialize result's `protocolVersion` is likewise captured, but only
 *   when it is a SUPPORTED value, and echoed as `mcp-protocol-version` alone on
 *   subsequent legacy requests. Modern requests instead derive protocol and method
 *   headers from the message, plus the name header only for `tools/call`.
 *   Before initialize returns, neither captured legacy header is sent.
 *   `close()` clears the captured protocol so a reconnect's `initialize`
 *   POST is headerless; the captured `session` persists across `close()`.
 * - **Total at the boundary (§14).** Every reply is narrowed (`parseJSONRPCMessage`,
 *   the SSE decoder) — a non-message reply is dropped, never asserted; a `fetch` /
 *   decode failure surfaces on the `error` event rather than escaping `send`.
 * - **Observable (§13).** Owns the `emitter` ({@link ClientTransportEventMap}); fires
 *   `message` per decoded reply, `error` on a fault, and `close` on `close()`.
 *
 * @example
 * ```ts
 * const transport = new HTTPClientTransport({ url: 'http://localhost:3000/mcp' })
 * const client = new MCPClient({ transport })
 * await client.connect()
 * ```
 */
export class HTTPClientTransport implements ClientTransportInterface {
	readonly #emitter: Emitter<ClientTransportEventMap>
	readonly #url: string
	readonly #headers: Readonly<Record<string, string>>
	readonly #fetch: typeof fetch
	readonly #timeout: number | undefined
	#session: string | undefined = undefined
	#protocol: string | undefined = undefined

	constructor(options: HTTPClientTransportOptions) {
		this.#emitter = new Emitter<ClientTransportEventMap>()
		this.#url = options.url
		this.#headers = options.headers ?? {}
		this.#fetch = options.fetch ?? globalThis.fetch
		this.#timeout = options.timeout
	}

	get emitter(): EmitterInterface<ClientTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		return this.#session
	}

	async start(): Promise<void> {
		// A request/response transport opens no long-lived connection — `send` issues each
		// `fetch` on demand. Nothing to arm.
	}

	async send(message: JSONRPCMessage): Promise<void> {
		let response: Response
		try {
			response = await this.#fetch(this.#url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					// Echo a captured session id so a STATEFUL server validates the request; before
					// `initialize` returns one `#session` is undefined → no header (safe for a
					// stateless server). A caller `headers` key still wins (merged last).
					...(this.#session === undefined ? {} : { [MCP_SESSION_HEADER]: this.#session }),
					...this.#buildHeaders(message),
					...this.#headers,
				},
				body: JSON.stringify(message),
				...(this.#timeout === undefined ? {} : { signal: AbortSignal.timeout(this.#timeout) }),
			})
		} catch (error) {
			// A network-level failure (connection refused, DNS) — surface it for observation;
			// the client's per-request deadline still rejects the pending request.
			this.#emitter.emit('error', error)
			return
		}
		// Capture a server-assigned session id (a stateless server sends none) so it is echoed
		// on subsequent requests; a missing header leaves `session` unchanged.
		const session = response.headers.get(MCP_SESSION_HEADER)
		if (session !== null) this.#session = session
		await this.#deliver(response)
	}

	// Clear the captured protocol before emitting `close`, so a reconnect's `initialize`
	// POST carries no `mcp-protocol-version` header (the captured `session` is untouched).
	async close(): Promise<void> {
		this.#protocol = undefined
		this.#emitter.emit('close')
	}

	#buildHeaders(message: JSONRPCMessage): Readonly<Record<string, string>> {
		if (isJSONRPCRequest(message) && isModernRequest(message)) {
			const metadata = isRecord(message.params?.['_meta']) ? message.params['_meta'] : undefined
			const version = metadata?.[MCP_META_VERSION]
			const name = message.params?.['name']
			return {
				...(isString(version) ? { [MCP_PROTOCOL_VERSION_HEADER]: version } : {}),
				[MCP_METHOD_HEADER]: message.method,
				...(message.method === 'tools/call' && isString(name) ? { [MCP_NAME_HEADER]: name } : {}),
			}
		}
		return this.#protocol === undefined ? {} : { [MCP_PROTOCOL_VERSION_HEADER]: this.#protocol }
	}

	// Decode a reply and emit each carried message. A 202 (notification accepted) has no
	// body — emit nothing. An `application/json` body is one envelope; a `text/event-stream`
	// body is decoded via the core SSEParser (one or more `data:` events). A decode failure
	// surfaces on `error` rather than escaping.
	async #deliver(response: Response): Promise<void> {
		if (response.status === 202) return
		const type = response.headers.get('content-type') ?? ''
		try {
			if (type.includes('text/event-stream')) {
				for (const message of await readEventStream(response)) this.#capture(message)
				return
			}
			if (type.includes('application/json')) {
				const message = parseJSONRPCMessage(await response.json())
				if (message !== undefined) this.#capture(message)
			}
		} catch (error) {
			this.#emitter.emit('error', error)
		}
	}

	// Capture the negotiated SUPPORTED protocol from the initialize result before emitting
	// the message, so the next request carries its required protocol-version header; any
	// other value (missing or unsupported) is ignored and leaves `#protocol` unchanged.
	#capture(message: JSONRPCMessage): void {
		if (
			isJSONRPCResponse(message) &&
			isRecord(message.result) &&
			isString(message.result['protocolVersion']) &&
			SUPPORTED_PROTOCOL_VERSIONS.includes(message.result['protocolVersion'])
		) {
			this.#protocol = message.result['protocolVersion']
		}
		this.#emitter.emit('message', message)
	}
}
