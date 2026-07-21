import type { JSONRPCMessage } from '@src/core'
import type { SSEParserInterface } from '@orkestrel/sse'
import { parseJSONRPCMessage } from '@src/core'
import { createSSEParser } from '@orkestrel/sse'

// The MCP browser-transport helpers (AGENTS §4.3 module-scope names — no entity
// context). `decodeEvent` and `readEventStream` are the browser face's copies of the
// Node face's SAME-NAMED helpers (`src/server/helpers.ts`) — peer environment faces
// (AGENTS §2) share no import, so the CLIENT-side SSE decode step (reused by
// `transports/HTTPClientTransport.ts`) is declared once here too. Both are total and
// narrow at the boundary, never `as` (AGENTS §14): a malformed / non-message SSE
// `data:` event is dropped, never thrown.

/**
 * Decode one SSE event's `data` string into a {@link JSONRPCMessage}, or `undefined`
 * when it is not one — the per-event step {@link readEventStream} folds over.
 *
 * @remarks
 * `JSON.parse`s the `data` (the server serializes the JSON-RPC envelope as the
 * event's `data`) inside a try/catch and narrows the parsed value with
 * `parseJSONRPCMessage`. Total (§14): malformed JSON or a non-message value yields
 * `undefined`, never throws.
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
 * Decode a `fetch` Response's Server-Sent-Events body into the JSON-RPC messages it
 * carried — the CLIENT-side inverse of the server's Streamable-HTTP SSE response.
 *
 * @remarks
 * Reads the whole `response.body` stream chunk-by-chunk through a `TextDecoder({
 * stream: true })` (handling a multi-byte char split across reads) and
 * `@orkestrel/sse`'s {@link SSEParserInterface} (handling a partial line / in-progress
 * event split across reads), then narrows each dispatched event's `data` to a
 * {@link JSONRPCMessage} via {@link decodeEvent} (so a non-message / non-JSON `data:`
 * event is DROPPED, never thrown — total, §14). A `null` body (no stream) yields no
 * messages; {@link import('./transports/HTTPClientTransport.js').HTTPClientTransport}
 * reads a request/response SSE reply (the server sends one `data:` event then ends),
 * so this drains to completion.
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
				const message = decodeEvent(event.data)
				if (message !== undefined) messages.push(message)
			}
		}
	} finally {
		reader.releaseLock()
	}
	return messages
}
