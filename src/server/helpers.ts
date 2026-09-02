import type { MCPMessageTransportEventMap, MCPStreamControllerInterface } from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { StreamInterface } from '@orkestrel/server'
import type { IncomingMessage } from 'node:http'
import type { LineExtraction, MCPOriginOptions } from './types.js'
import {
	deliverMessage,
	JSONRPC_INVALID_REQUEST,
	buildJSONRPCError,
	MCP_SESSION_HEADER,
} from '@src/core'
import { isString } from '@orkestrel/contract'

/**
 * Pumps a controlled held-open exchange onto an open SSE stream — one `data:` event per
 * notification in order, then the terminating response — and END the exchange however the
 * pump leaves.
 *
 * @remarks
 * The Streamable-HTTP twin of {@link import('@orkestrel/mcp').sendStream}, and it owns exactly what
 * that owns. The `finally` releases the exchange on EVERY exit — the normal terminal, a
 * producer that threw, a `write` that threw, and an abort alike — because nothing else will:
 * a request whose client vanished cancels nothing by itself, so an exchange this pump walks
 * away from keeps its producer, its request lifetime, and its live subscription slot forever.
 * The exchange is released BEFORE the body ends, so the slot is already back when the response
 * completes.
 *
 * Total — never throws and never rejects. A held-open SSE response has already sent its
 * headers and part of its body, so there is no failure the transport could still convert into
 * a different answer; the honest end of a broken stream is a closed one, and the fault itself
 * is already legible on `server.emitter`'s `error` event, which is where a contained fault
 * belongs.
 *
 * @param stream - The controlled held-open answer to write out and then end
 * @param sse - The open SSE stream to write each serialized message onto
 * @returns Resolves once the exchange has ended and the SSE body has been closed
 *
 * @example
 * ```ts
 * const answer = await mcp.dispatch(invocation, { signal: disconnect.signal })
 * if (answer !== undefined && Symbol.asyncIterator in answer) {
 * 	const sse = createStream()
 * 	queueMicrotask(() => void sendEventStream(answer, sse))
 * }
 * ```
 */
export async function sendEventStream(
	stream: MCPStreamControllerInterface,
	sse: StreamInterface,
): Promise<void> {
	try {
		// The inner `finally` is what makes the totality claim above true of the RELEASE too:
		// a dispose that threw would otherwise escape past the outer catch that swallows the
		// pump's own faults.
		try {
			let next = await stream.next()
			while (next.done !== true) {
				sse.write({ data: JSON.stringify(next.value) })
				next = await stream.next()
			}
			sse.write({ data: JSON.stringify(next.value) })
		} finally {
			await stream[Symbol.asyncDispose]()
		}
	} catch {
		// A producer failure, a write fault, or an abort ends this response — see @remarks.
	} finally {
		sse.end()
	}
}

// The MCP server-transport helpers — module-scope names, so they carry no entity context.
// `acceptsEventStream` reads the request's `Accept` header to decide whether a
// Streamable-HTTP SSE response is allowed; `readSessionHeader` reads the request's
// `mcp-session-id` header (the stateful transport's session validation); `readLastEventId`
// reads the request's `Last-Event-ID` header (the resumable GET-SSE replay cursor);
// `upgradeRequestPath` reads a raw `node:http` upgrade request's path (the WebSocket
// transport's upgrade-path match). The CLIENT-side SSE decode is `readEventStream` in
// `@src/core`, beside the transport that reads it. All are total and narrow at the boundary,
// never `as` — a missing / non-string Accept reads as "no", a missing session /
// last-event header reads as `undefined`, an absent `url` reads as `'/'`.

/**
 * Checks whether the request's `Accept` header opts into a Server-Sent-Events response.
 *
 * @remarks
 * Reads the fetch-standard `Request.headers.get('accept')` and returns `true` when it
 * contains `text/event-stream` (case-insensitive). The MCP `POST` handler uses it
 * (together with the `streaming` option) to pick the Streamable-HTTP SSE response
 * framing over a plain JSON body; the JSON-RPC envelope is identical either way. Total
 * — an absent / unmatched header returns `false`.
 *
 * @param request - The fetch-standard `Request`
 * @returns True if the client `Accept`s `text/event-stream`; false otherwise
 */
export function acceptsEventStream(request: Request): boolean {
	const accept = request.headers.get('accept')
	if (accept === null) return false
	return accept.toLowerCase().includes('text/event-stream')
}

/**
 * Checks whether an HTTP request satisfies the endpoint's origin gate.
 *
 * @remarks
 * Validation is enabled by default. A request without `Origin` is allowed. A canonical origin
 * whose host is the `localhost` or `[::1]` literal, or belongs to the `127.0.0.0/8` literal
 * range, is allowed without configuration; every other present origin must occur exactly in
 * the caller-supplied list. Invalid and opaque (`null`) origins are denied. `enabled: false`
 * delegates validation to an upstream layer and allows the request through this gate.
 *
 * @param request - The fetch-standard request to validate
 * @param options - Shared origin validation and delegation options
 * @returns True if the request may reach MCP dispatch; false otherwise
 */
export function allowsOrigin(request: Request, options?: MCPOriginOptions): boolean {
	if (options?.enabled === false) return true
	const origin = request.headers.get('origin')
	if (origin === null) return true
	let parsed: URL
	try {
		parsed = new URL(origin)
	} catch {
		return false
	}
	if (parsed.origin !== origin) return false
	if (
		parsed.hostname === 'localhost' ||
		parsed.hostname === '[::1]' ||
		/^127(?:\.\d{1,3}){3}$/.test(parsed.hostname)
	) {
		return true
	}
	return options?.origins?.includes(parsed.origin) ?? false
}

/**
 * Reads the request's `mcp-session-id` header — the session id a stateful transport
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
 * Reads the request's `Last-Event-ID` header — the SSE resume cursor a client sends when it
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
 * Builds the stateful transport's "unknown session" rejection — an HTTP `404` carrying a
 * JSON-RPC error body.
 *
 * @remarks
 * Returns `Response.json(buildJSONRPCError(undefined, JSONRPC_INVALID_REQUEST, 'Session not
 * found'), { status: 404 })`, mirroring `createMCPRoutes`'s `400` transport-failure shape (a
 * JSON-RPC error BODY with NO id) but at the session-not-found status. Shared by
 * every {@link import('./middlewares.js').createMCPSession} validation site — the
 * non-`initialize` `POST` path, the resumable `GET {path}` open, and the `DELETE {path}`
 * session-end (each a missing / unknown / TTL-evicted id) — so the single `404` envelope
 * is defined once. Total — never throws.
 *
 * @returns The `404` JSON-RPC error `Response`
 */
export function rejectUnknownSession(): Response {
	return Response.json(buildJSONRPCError(undefined, JSONRPC_INVALID_REQUEST, 'Session not found'), {
		status: 404,
	})
}

/**
 * Reads the path (without the query string) of a raw `node:http` protocol-upgrade request —
 * the `createWebSocketServer` upgrade-path match.
 *
 * @remarks
 * A `node:http` {@link import('node:http').IncomingMessage}'s `url` is the request TARGET
 * (`'/mcp?x=1'`), narrowed with `isString` (never `as`) and defaulting to `'/'` for an
 * absent target; it is parsed against a placeholder base (only the pathname matters for the upgrade
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
 * Folds one more chunk of raw stdio bytes into a newline-framed buffer — the shared
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
 * Writes one line to a Node writable stream and waits for its completion callback.
 *
 * @remarks
 * The completion callback is the writable channel's backpressure boundary. A callback error and
 * a synchronous `write` throw reject the returned promise with the original value.
 *
 * That callback is the ONLY thing that settles the promise: this helper holds no timer and no
 * abort, so an output that neither confirms nor fails the write parks the promise for as long as
 * the caller-owned stream holds the callback. A caller wanting a bound races this promise against
 * one it owns — {@link import('./transports/StdioServerTransport.js').StdioServerTransport}
 * registers such a bound per send and rejects it on `close()`, so closing the transport settles
 * the CALLER's `send` while the abandoned write stays with the stream that still holds its
 * callback, reachable from nothing the transport retains.
 *
 * @param output - The writable stream that receives the line
 * @param line - The complete line to write
 * @returns Resolves when the stream confirms the write; rejects when the write fails
 *
 * @example
 * ```ts
 * await writeLine(process.stdout, '{"jsonrpc":"2.0","method":"ping"}\n')
 * ```
 */
export function writeLine(output: NodeJS.WritableStream, line: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		try {
			output.write(line, (error) => {
				if (error === undefined || error === null) resolve()
				else reject(error)
			})
		} catch (error) {
			reject(error)
		}
	})
}

/**
 * Decodes and delivers each complete newline-framed line onto a {@link
 * MCPMessageTransportEventMap} emitter — the shared per-chunk dispatch step both stdio
 * transports run their framed lines through: the server transport frames with {@link
 * extractLines}, the client transport takes its lines from the process supervisor.
 *
 * @remarks
 * A blank line is skipped (a stray trailing newline). Every other line runs through the
 * shared {@link import('@orkestrel/mcp').deliverMessage} fold, the one inbound decode every
 * transport in this package shares: a well-formed {@link JSONRPCMessage} emits `message`,
 * unparsable text emits the caught parse error, and a well-formed non-message line emits
 * `error` naming a non-JSON-RPC stdio line (total, never throws). Pure w.r.t. its own state
 * — the emit is the caller-owned side effect.
 *
 * @param emitter - The transport's {@link EmitterInterface} to emit `message` / `error` onto
 * @param lines - The complete lines to decode and deliver
 */
export function dispatchLines(
	emitter: EmitterInterface<MCPMessageTransportEventMap>,
	lines: readonly string[],
): void {
	for (const line of lines) {
		if (line.length === 0) continue
		deliverMessage(emitter, line, 'non-JSON-RPC stdio line')
	}
}
