import type { JSONRPCMessage } from '@src/core'
import type { RouteHandlerContextInterface } from '../http/types.js'
import type { IncomingMessage } from 'node:http'
import {
	createSSEParser,
	isString,
	JSONRPC_INVALID_REQUEST,
	jsonRPCError,
	parseJSONRPCMessage,
} from '@src/core'
import { MCP_SESSION_HEADER } from './constants.js'

// The MCP server-transport helpers (AGENTS §4.3 module-scope names — no entity context).
// The server-side reader `acceptsEventStream` reads the request's `Accept` header to
// decide whether a Streamable-HTTP SSE response is allowed; `readSessionHeader` reads the
// request's `mcp-session-id` header (the stateful transport's session validation);
// `readLastEventId` reads the request's `Last-Event-ID` header (the resumable GET-SSE
// replay cursor); the CLIENT-side reader `readEventStream` decodes a `fetch` Response's SSE
// body back into JSON-RPC messages (the egress mirror, reusing the core `SSEParser`);
// `upgradeRequestPath` reads a raw `node:http` upgrade request's path (the WebSocket
// transport's upgrade-path match). All are total and narrow at the boundary, never `as`
// (AGENTS §14) — a missing / non-string Accept reads as "no", a missing session / last-event
// header reads as `undefined`, a non-message SSE `data:` event is dropped, an absent `url`
// reads as `'/'`.

/**
 * Whether the request's `Accept` header opts into a Server-Sent-Events response.
 *
 * @remarks
 * Reads `context.request.headers.accept` — a `node:http` header value (`string |
 * undefined` for this single-valued field) narrowed with `typeof`, never `as` (AGENTS
 * §14) — and returns `true` when it contains `text/event-stream` (case-insensitive). The
 * MCP `POST` handler uses it (together with the `streaming` option) to pick the
 * Streamable-HTTP SSE response framing over a plain JSON body; the JSON-RPC envelope is
 * identical either way. Total — an absent / unmatched header returns `false`.
 *
 * @param context - The route's {@link RouteHandlerContextInterface}
 * @returns `true` when the client `Accept`s `text/event-stream`, else `false`
 */
export function acceptsEventStream(context: RouteHandlerContextInterface): boolean {
	// `Accept` is a `node:http` header — `string | undefined` for this single-valued field;
	// narrow with `typeof`, never `as` (§14, mirroring `http`'s `contentType`). A missing /
	// non-string header reads as "no".
	const accept = context.request.headers.accept
	if (typeof accept !== 'string') return false
	return accept.toLowerCase().includes('text/event-stream')
}

/**
 * Read the request's `mcp-session-id` header — the session id a stateful transport
 * validates, or `undefined` when absent.
 *
 * @remarks
 * Reads `context.request.headers[MCP_SESSION_HEADER]` — a `node:http` header value
 * (`string | string[] | undefined`) narrowed with `isString`, never `as` (AGENTS §14) — so
 * a missing header, OR the (illegal) repeated-header array form, both read as `undefined`
 * (no session). The {@link import('./middlewares.js').createMCPSession} middleware uses it on a
 * non-`initialize` request (and on the resumable `GET` / `DELETE`) to look the session up in
 * its closure store; an `undefined` id is treated exactly like an unknown one (a `404`).
 * Total — never throws.
 *
 * @param context - The route's {@link RouteHandlerContextInterface}
 * @returns The single-valued session id, or `undefined` when the header is absent / repeated
 */
export function readSessionHeader(context: RouteHandlerContextInterface): string | undefined {
	const id = context.request.headers[MCP_SESSION_HEADER]
	return isString(id) ? id : undefined
}

/**
 * Read the request's `Last-Event-ID` header — the SSE resume cursor a client sends when it
 * reconnects to the resumable `GET {path}` stream, or `undefined` when absent.
 *
 * @remarks
 * Reads `context.request.headers['last-event-id']` — a `node:http` header value (`string |
 * string[] | undefined`; node lower-cases the name) narrowed with `isString`, never `as`
 * (AGENTS §14) — so a missing header, OR the (illegal) repeated-header array form, both read
 * as `undefined` (no resume, the stream starts fresh). The resumable GET handler in {@link
 * import('./middlewares.js').createMCPSession} passes a present value to the session's {@link
 * import('./types.js').MCPSessionInterface.replay} to re-deliver the missed events before
 * attaching the stream for live pushes. Total — never throws.
 *
 * @param context - The route's {@link RouteHandlerContextInterface}
 * @returns The single-valued last-event-id, or `undefined` when the header is absent / repeated
 */
export function readLastEventId(context: RouteHandlerContextInterface): string | undefined {
	const id = context.request.headers['last-event-id']
	return isString(id) ? id : undefined
}

/**
 * Send the stateful transport's "unknown session" rejection — an HTTP `404` carrying a
 * JSON-RPC error body.
 *
 * @remarks
 * Writes `jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Session not found')` at HTTP status
 * `404`, mirroring the `createMCPRoutes` `400` transport-failure shape (a JSON-RPC error
 * BODY with a `null` id) but at the session-not-found status. Shared by every {@link
 * import('./middlewares.js').createMCPSession} validation site — the non-`initialize` POST path,
 * the resumable `GET {path}` open, and the `DELETE {path}` session-end (each a missing /
 * unknown / TTL-evicted id) — so the single 404 envelope is defined once. Total — it only
 * writes the response, never throws.
 *
 * @param context - The route's {@link RouteHandlerContextInterface}
 */
export function rejectUnknownSession(context: RouteHandlerContextInterface): void {
	context.json(jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Session not found'), 404)
}

/**
 * Decode a `fetch` Response's Server-Sent-Events body into the JSON-RPC messages it
 * carried — the CLIENT-side inverse of the server's Streamable-HTTP SSE response.
 *
 * @remarks
 * Reads the whole `response.body` stream chunk-by-chunk through a `TextDecoder({
 * stream: true })` (handling a multi-byte char split across reads) and the core
 * {@link import('@src/core').SSEParserInterface} (handling a partial line / in-progress
 * event split across reads), then narrows each dispatched event's `data` to a
 * {@link JSONRPCMessage} via `parseJSONRPCMessage` (so a non-message / non-JSON `data:`
 * event is DROPPED, never thrown — total, §14). It reuses the SAME `SSEParser` the
 * server's `openSSEStream` seam serializes against, so the wire round-trips. A `null`
 * body (no stream) yields no messages; the {@link HTTPClientTransport} reads a
 * request/response SSE reply (the server sends one `data:` event then ends), so this
 * drains to completion.
 *
 * @param response - The SSE `fetch` Response to decode (its `body` is read to completion)
 * @returns Every {@link JSONRPCMessage} the stream carried, in order
 */
export async function readEventStream(response: Response): Promise<readonly JSONRPCMessage[]> {
	const body = response.body
	if (body === null) return []
	const reader = body.getReader()
	const decoder = new TextDecoder()
	const parser = createSSEParser()
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
