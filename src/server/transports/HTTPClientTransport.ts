import type {
	MCPClientTransportEventMap,
	MCPClientTransportInterface,
	JSONRPCMessage,
} from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { HTTPClientTransportOptions } from '../types.js'
import {
	inferRequestVersion,
	isJSONRPCResponse,
	isMCPVersion,
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
 * {@link MCPClientTransportInterface} that drives a REMOTE Streamable-HTTP MCP server over
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
 *   `parseJSONRPCMessage`; a `200` with a `text/event-stream` body is decoded with the
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
 * - **`close()` releases what is in flight.** Every `fetch` this transport still has open is
 *   ABORTED, which cancels the response body a `send` is reading — an SSE reply the server
 *   never ends would otherwise outlive the transport, with nothing left able to reach it. The
 *   aborted read surfaces on `error` and the `send` reporting it resolves. `close()` is
 *   idempotent (one `close` event per connected lifetime), and `start()` opens the next one.
 * - **Total at the boundary.** Every reply is narrowed (`parseJSONRPCMessage`,
 *   the SSE decoder) — a non-message reply is dropped, never asserted; a `fetch` /
 *   decode failure surfaces on the `error` event rather than escaping `send`.
 * - **Observable.** Owns the `emitter` ({@link MCPClientTransportEventMap}); fires
 *   `message` per decoded reply, `error` on a fault, and `close` on `close()`.
 *
 * @example
 * ```ts
 * const transport = new HTTPClientTransport({ url: 'http://localhost:3000/mcp' })
 * const client = new MCPClient({ transport })
 * await client.connect()
 * ```
 */
export class HTTPClientTransport implements MCPClientTransportInterface {
	readonly #emitter: Emitter<MCPClientTransportEventMap>
	readonly #url: string
	readonly #headers: Readonly<Record<string, string>>
	readonly #fetch: typeof fetch
	readonly #timeout: number | undefined
	// The requests on the wire, one controller each. `close` is the only thing that can
	// reach them: a `send` parked on a reply that never ends holds both the request and its
	// response reader, and no other seam this transport exposes leads back to either.
	readonly #pending = new Set<AbortController>()
	#session: string | undefined = undefined
	#protocol: string | undefined = undefined
	#closed = false

	constructor(options: HTTPClientTransportOptions) {
		this.#emitter = new Emitter<MCPClientTransportEventMap>()
		this.#url = options.url
		this.#headers = options.headers ?? {}
		this.#fetch = options.fetch ?? globalThis.fetch
		this.#timeout = options.timeout
	}

	get emitter(): EmitterInterface<MCPClientTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		return this.#session
	}

	get duplex(): boolean {
		// Streamable HTTP carries no client-initiated notification: the dated revision defines
		// none over it, and closing the response stream is the cancellation signal instead.
		return false
	}

	async start(): Promise<void> {
		// A request/response transport opens no long-lived connection — `send` issues each
		// `fetch` on demand. There is nothing to arm; opening the next connected lifetime is all
		// this does, so a transport an earlier `close` ended sends again from here.
		this.#closed = false
	}

	async send(message: JSONRPCMessage): Promise<void> {
		const request = new AbortController()
		this.#pending.add(request)
		try {
			await this.#exchange(message, request.signal)
		} finally {
			this.#pending.delete(request)
		}
	}

	// One request/response exchange under `signal`: `close` aborts it, and a `timeout` option
	// composes with it so whichever fires first ends the same fetch and the same body read.
	async #exchange(message: JSONRPCMessage, signal: AbortSignal): Promise<void> {
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
				signal:
					this.#timeout === undefined
						? signal
						: AbortSignal.any([signal, AbortSignal.timeout(this.#timeout)]),
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

	// Abort every request still on the wire, then clear the captured protocol before emitting
	// `close`, so a reconnect's `initialize` POST carries no `mcp-protocol-version` header (the
	// captured `session` is untouched). Idempotent: a second `close` on a transport this one
	// already ended releases nothing and emits nothing.
	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		for (const request of this.#pending) request.abort()
		this.#pending.clear()
		this.#protocol = undefined
		this.#emitter.emit('close')
	}

	// Modern requests announce their own protocol version, so the header is projected from the
	// message through the SHARED `inferRequestVersion` — the same read the server's own
	// expectation performs, and the same read the browser face performs. Legacy requests carry
	// the version captured from the `initialize` handshake instead.
	#buildHeaders(message: JSONRPCMessage): Readonly<Record<string, string>> {
		if (isModernRequest(message)) {
			const version = inferRequestVersion(message)
			const name = message.params?.['name']
			return {
				...(version === undefined ? {} : { [MCP_PROTOCOL_VERSION_HEADER]: version }),
				[MCP_METHOD_HEADER]: message.method,
				...(message.method === 'tools/call' && isString(name) ? { [MCP_NAME_HEADER]: name } : {}),
			}
		}
		return this.#protocol === undefined ? {} : { [MCP_PROTOCOL_VERSION_HEADER]: this.#protocol }
	}

	// Decode a reply and emit each carried message. A 202 (notification accepted) has no
	// body — emit nothing. An `application/json` body is one envelope; a `text/event-stream`
	// body is decoded with the core SSEParser (one or more `data:` events). A decode failure
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
			isMCPVersion(message.result['protocolVersion'])
		) {
			this.#protocol = message.result['protocolVersion']
		}
		this.#emitter.emit('message', message)
	}
}
