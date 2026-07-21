import type {
	ClientTransportEventMap,
	ClientTransportInterface,
	JSONRPCMessage,
	MCPTransportInterface,
} from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { SSEParserInterface } from '@orkestrel/sse'
import type { IncomingMessage } from 'node:http'
import type { LineExtraction } from './types.js'
import { createSSEParser } from '@orkestrel/sse'
import {
	isJSONRPCRequest,
	JSONRPC_INVALID_REQUEST,
	jsonRPCError,
	parseJSONRPCMessage,
} from '@src/core'
import { isString } from '@orkestrel/contract'
import { MCP_SESSION_HEADER } from './constants.js'

// The MCP server-transport helpers (AGENTS §4.3 module-scope names — no entity context).
// The server-side reader `acceptsEventStream` reads the request's `Accept` header to
// decide whether a Streamable-HTTP SSE response is allowed; `readSessionHeader` reads the
// request's `mcp-session-id` header (the stateful transport's session validation);
// `readLastEventId` reads the request's `Last-Event-ID` header (the resumable GET-SSE
// replay cursor); the CLIENT-side reader `readEventStream` decodes a `fetch` Response's SSE
// body back into JSON-RPC messages (the egress mirror, reusing `@orkestrel/sse`'s
// `SSEParser`); `upgradeRequestPath` reads a raw `node:http` upgrade request's path (the
// WebSocket transport's upgrade-path match). All are total and narrow at the boundary,
// never `as` (AGENTS §14) — a missing / non-string Accept reads as "no", a missing session /
// last-event header reads as `undefined`, a non-message SSE `data:` event is dropped, an
// absent `url` reads as `'/'`.

/**
 * Whether the request's `Accept` header opts into a Server-Sent-Events response.
 *
 * @remarks
 * Reads the fetch-standard `Request.headers.get('accept')` and returns `true` when it
 * contains `text/event-stream` (case-insensitive). The MCP `POST` handler uses it
 * (together with the `streaming` option) to pick the Streamable-HTTP SSE response
 * framing over a plain JSON body; the JSON-RPC envelope is identical either way. Total
 * — an absent / unmatched header returns `false`.
 *
 * @param request - The fetch-standard `Request`
 * @returns `true` when the client `Accept`s `text/event-stream`, else `false`
 */
export function acceptsEventStream(request: Request): boolean {
	const accept = request.headers.get('accept')
	if (accept === null) return false
	return accept.toLowerCase().includes('text/event-stream')
}

/**
 * Read the request's `mcp-session-id` header — the session id a stateful transport
 * validates, or `undefined` when absent.
 *
 * @remarks
 * Reads `request.headers.get(MCP_SESSION_HEADER)` — a fetch-standard `Headers` lookup
 * (single-valued by construction, never an array) — so a missing header reads as
 * `undefined` (no session). {@link import('./middlewares.js').createMCPSession} uses it on
 * every `POST` / `GET` / `DELETE` to look the session up in its closure store; an
 * `undefined` id is treated exactly like an unknown one (a `404`). Total — never throws.
 *
 * @param request - The fetch-standard `Request`
 * @returns The session id, or `undefined` when the header is absent
 */
export function readSessionHeader(request: Request): string | undefined {
	const id = request.headers.get(MCP_SESSION_HEADER)
	return id === null ? undefined : id
}

/**
 * Read the request's `Last-Event-ID` header — the SSE resume cursor a client sends when it
 * reconnects to the resumable `GET {path}` stream, or `undefined` when absent.
 *
 * @remarks
 * Reads `request.headers.get('last-event-id')` — a fetch-standard `Headers` lookup — so a
 * missing header reads as `undefined` (no resume, the stream starts fresh). The resumable
 * `GET` handler in {@link import('./middlewares.js').createMCPSession} passes a present value
 * to the session's {@link import('./types.js').MCPSessionInterface.replay} to re-deliver the
 * missed events before attaching the stream for live pushes. Total — never throws.
 *
 * @param request - The fetch-standard `Request`
 * @returns The last-event-id, or `undefined` when the header is absent
 */
export function readLastEventId(request: Request): string | undefined {
	const id = request.headers.get('last-event-id')
	return id === null ? undefined : id
}

/**
 * Build the stateful transport's "unknown session" rejection — an HTTP `404` carrying a
 * JSON-RPC error body.
 *
 * @remarks
 * Returns `Response.json(jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Session not found'),
 * { status: 404 })`, mirroring `createMCPRoutes`'s `400` transport-failure shape (a
 * JSON-RPC error BODY with a `null` id) but at the session-not-found status. Shared by
 * every {@link import('./middlewares.js').createMCPSession} validation site — the
 * non-`initialize` `POST` path, the resumable `GET {path}` open, and the `DELETE {path}`
 * session-end (each a missing / unknown / TTL-evicted id) — so the single `404` envelope
 * is defined once. Total — never throws.
 *
 * @returns The `404` JSON-RPC error `Response`
 */
export function rejectUnknownSession(): Response {
	return Response.json(jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Session not found'), {
		status: 404,
	})
}

/**
 * Decode a `fetch` Response's Server-Sent-Events body into the JSON-RPC messages it
 * carried — the CLIENT-side inverse of the server's Streamable-HTTP SSE response.
 *
 * @remarks
 * Reads the whole `response.body` stream chunk-by-chunk through a `TextDecoder({
 * stream: true })` (handling a multi-byte char split across reads) and `@orkestrel/sse`'s
 * {@link SSEParserInterface} (handling a partial line / in-progress event split across
 * reads), then narrows each dispatched event's `data` to a {@link JSONRPCMessage} via
 * `parseJSONRPCMessage` (so a non-message / non-JSON `data:` event is DROPPED, never
 * thrown — total, §14). It reuses the SAME `SSEParser` the server's `openStream` seam
 * serializes against, so the wire round-trips. A `null` body (no stream) yields no
 * messages; the {@link import('./transports/HTTPClientTransport.js').HTTPClientTransport}
 * reads a request/response SSE reply (the server sends one `data:` event then ends), so
 * this drains to completion.
 *
 * @param response - The SSE `fetch` Response to decode (its `body` is read to completion)
 * @returns Every {@link JSONRPCMessage} the stream carried, in order
 */
export async function readEventStream(response: Response): Promise<readonly JSONRPCMessage[]> {
	const body = response.body
	if (body === null) return []
	const reader = body.getReader()
	const decoder = new TextDecoder()
	const parser: SSEParserInterface = createSSEParser()
	const messages: JSONRPCMessage[] = []
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			for (const event of parser.parse(decoder.decode(value, { stream: true }))) {
				// JSON-parse the event's `data` (the JSON-RPC envelope the server wrote), then
				// narrow it — a malformed / non-message payload is dropped, never thrown (§14).
				const message = decodeEvent(event.data)
				if (message !== undefined) messages.push(message)
			}
		}
	} finally {
		reader.releaseLock()
	}
	return messages
}

/**
 * Decode one SSE event's `data` string into a {@link JSONRPCMessage}, or `undefined`
 * when it is not one — the per-event step {@link readEventStream} folds over.
 *
 * @remarks
 * `JSON.parse`s the `data` (the server serializes the JSON-RPC envelope as the event's
 * `data`) inside a try/catch and narrows the parsed value with `parseJSONRPCMessage`.
 * Total (§14): malformed JSON or a non-message value yields `undefined`, never throws.
 *
 * @param data - One SSE event's `data` payload
 * @returns The decoded {@link JSONRPCMessage}, or `undefined`
 */
export function decodeEvent(data: string): JSONRPCMessage | undefined {
	try {
		return parseJSONRPCMessage(JSON.parse(data))
	} catch {
		return undefined
	}
}

/**
 * Read the path (without the query string) of a raw `node:http` protocol-upgrade request —
 * the `createWebSocketServer` upgrade-path match.
 *
 * @remarks
 * A `node:http` {@link import('node:http').IncomingMessage}'s `url` is the request TARGET
 * (`'/mcp?x=1'`), narrowed with `isString` (§14, never `as`) and defaulting to `'/'` for an
 * absent target; it is parsed against a dummy base (only the pathname matters for the upgrade
 * decision) and the `pathname` returned. The upgrade handler compares this against its
 * configured `path` to decide whether to claim the socket. Total — never throws on an
 * adversarial / absent target.
 *
 * @param request - The raw upgrade {@link import('node:http').IncomingMessage}
 * @returns The request's path (the `pathname`, no query), or `'/'` when the target is absent
 */
export function upgradeRequestPath(request: IncomingMessage): string {
	const target = isString(request.url) ? request.url : '/'
	return new URL(target, 'http://localhost').pathname
}

/**
 * Fold one more chunk of raw stdio bytes into a newline-framed buffer — the shared
 * line-framing step both stdio transports (client and server) read their inbound
 * newline-delimited JSON-RPC messages through.
 *
 * @remarks
 * Concatenates `buffer` (the carried-forward partial line from the previous call)
 * with `chunk`, splits on `'\n'`, and returns every COMPLETE line (a `'\r'` trailing
 * a line, from a CRLF-framed peer, is trimmed) plus the final, possibly-empty
 * fragment as the new `remainder` — the caller threads it back in as the next call's
 * `buffer`. A chunk containing no `'\n'` yields no lines and the whole (buffer +
 * chunk) as `remainder`. Pure — no I/O, no instance state.
 *
 * @param buffer - The partial line carried forward from the previous chunk (`''` initially)
 * @param chunk - The newly-read raw bytes (already decoded to a string)
 * @returns The complete `lines` extracted (in order) and the trailing `remainder`
 */
export function extractLines(buffer: string, chunk: string): LineExtraction {
	const combined = buffer + chunk
	const parts = combined.split('\n')
	const remainder = parts[parts.length - 1] ?? ''
	const lines = parts.slice(0, -1).map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
	return { lines, remainder }
}

/**
 * Decode and deliver each complete newline-framed line onto a {@link
 * ClientTransportEventMap} emitter — the shared per-chunk dispatch step both stdio
 * transports (client and server) run their {@link extractLines} output through.
 *
 * @remarks
 * A blank line is skipped (a stray trailing newline). Every other line is decoded
 * with {@link decodeEvent} (`JSON.parse` + `parseJSONRPCMessage`, guarded); a
 * well-formed {@link JSONRPCMessage} emits `message`, a malformed / non-message line
 * emits `error` (§14 — total, never throws). Pure w.r.t. its own state — the emit is
 * the caller-owned side effect.
 *
 * @param emitter - The transport's {@link EmitterInterface} to emit `message` / `error` onto
 * @param lines - The complete lines (from {@link extractLines}) to decode and deliver
 */
export function dispatchLines(
	emitter: EmitterInterface<ClientTransportEventMap>,
	lines: readonly string[],
): void {
	for (const line of lines) {
		if (line.length === 0) continue
		const message = decodeEvent(line)
		if (message === undefined) {
			emitter.emit('error', new Error('non-JSON-RPC stdio line'))
			continue
		}
		emitter.emit('message', message)
	}
}

/**
 * Bridge a message-channel {@link ClientTransportInterface} (the shape the stdio and
 * WebSocket SERVER transports already implement) into the environment-agnostic
 * {@link import('@src/core').MCPTransportInterface} port — the adapter
 * {@link import('./factories.js').createStdioServer} and {@link
 * import('./factories.js').createWebSocketServer} pipe through `bindServer`, so the
 * request/reply/error pump those two factories used to hand-roll identically now
 * lives ONCE in the core binder.
 *
 * @remarks
 * `send` decodes the already-serialized reply string back to a {@link JSONRPCMessage}
 * and writes it via `transport.send` (the SAME `JSON.stringify` the underlying
 * transport already performs, so the wire bytes are unchanged). `listen` filters
 * `transport`'s `message` event to REQUESTS ONLY — a stray response is ignored,
 * exactly as the prior hand-rolled pumps did — and re-serializes each one back to a
 * string for `bindServer`. `closed` bridges `transport`'s `close` event. `close`
 * closes the underlying `transport`.
 *
 * @remarks Per {@link import('@src/core').MCPTransportInterface}, `listen`/`closed`
 * each hold THE SINGLE current handler (a second call REPLACES the first, never adds).
 * Since the underlying `transport.emitter` is ADD-based (`on` subscribes, never
 * replaces), this bridge installs ONE stable emitter listener per event on first use
 * and re-routes it to whichever handler is CURRENTLY registered (`undefined` while
 * none is), so rebinding never double-dispatches.
 *
 * @remarks A response whose `result` serializes away (e.g. `undefined`) is dropped by
 * the message validators on the wire's decode side — an asymmetry the stdio/WS carrier
 * shares with the streamable-HTTP face, since both round-trip through `JSON.stringify`
 * / `JSON.parse` before re-validation.
 *
 * @param transport - The message-channel transport to bridge (stdio or WebSocket)
 * @returns An {@link import('@src/core').MCPTransportInterface} `bindServer` can drive
 *
 * @example
 * ```ts
 * import { bindServer } from '@src/core'
 *
 * const transport = new StdioServerTransport(process.stdin, process.stdout)
 * bindServer(mcp, bridgeMessageTransport(transport))
 * ```
 */
export function bridgeMessageTransport(transport: ClientTransportInterface): MCPTransportInterface {
	let onMessage: ((message: string) => void) | undefined
	let onClosed: (() => void) | undefined
	let subscribed = false
	function subscribe(): void {
		if (subscribed) return
		subscribed = true
		transport.emitter.on('message', (message) => {
			if (!isJSONRPCRequest(message)) return
			onMessage?.(JSON.stringify(message))
		})
		transport.emitter.on('close', () => {
			onClosed?.()
		})
	}
	return {
		async send(message) {
			const decoded = decodeEvent(message)
			if (decoded === undefined) return
			await transport.send(decoded)
		},
		listen(handler) {
			subscribe()
			onMessage = handler
		},
		closed(handler) {
			subscribe()
			onClosed = handler
		},
		async close() {
			await transport.close()
		},
	}
}
