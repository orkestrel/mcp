import { describe, expect, it } from 'vitest'
import type { JSONRPCMessage } from '@src/core'
import { JSONRPC_INVALID_REQUEST, jsonRPCError, parseJSONRPCMessage } from '@src/core'
import {
	acceptsEventStream,
	decodeEvent,
	MCP_SESSION_HEADER,
	readEventStream,
	readSessionHeader,
	rejectUnknownSession,
	upgradeRequestPath,
} from '@src/server'
import { createJSONRPCRequest } from '../../../setup.js'
import { createContextStub, createRequestStub } from '../../../setupServer.js'

// One SSE `data:` event carrying `payload` as its JSON-serialized data, terminated by the
// blank line that dispatches it — the exact wire framing the server's `openSSEStream` seam
// writes (`sse.write({ data: JSON.stringify(response) })`), so a body of these round-trips
// back through `readEventStream`. A non-string `payload` (a raw token) frames an event whose
// `data` is that literal, for the malformed-drop path.
function dataEvent(payload: unknown): string {
	return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
}

// A `fetch`-style Response over an SSE `text/event-stream` body — the reply shape
// `readEventStream` decodes. Its `body` is a real `ReadableStream`, so the helper reads it
// to completion exactly as it would a live server's response.
function sseResponse(body: string): Response {
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

// The well-formed JSON-RPC envelope (a `parseJSONRPCMessage`-valid message) used as the
// expected value in the round-trip assertions — narrowed through the real parser so the
// expectation is itself proven a message, never an `as`.
function rpcMessage(overrides?: Parameters<typeof createJSONRPCRequest>[0]): JSONRPCMessage {
	const message = parseJSONRPCMessage(createJSONRPCRequest(overrides))
	if (message === undefined) throw new Error('unreachable: createJSONRPCRequest is a message')
	return message
}

// src/server/mcp/helpers.ts — `acceptsEventStream`, the pure `Accept`-header reader the
// MCP transport uses to pick a Streamable-HTTP SSE response over a plain JSON body. It
// reads only `context.request.headers.accept` and narrows with `typeof`, so the shared
// `createContextStub` carrying a `request` with the `Accept` header exercises every
// branch (the live over-the-wire SSE path is proven through a real server in
// factories.test.ts, AGENTS §16). The stub crosses into the parameter via a structural
// guard, never an assertion (§14).

// A context whose request carries (or omits) the `Accept` header `acceptsEventStream`
// reads — built from the shared stubs so the one full default shape serves every branch.
function contextStub(accept?: string): ReturnType<typeof createContextStub> {
	return createContextStub({
		request: createRequestStub({ headers: accept === undefined ? {} : { accept } }),
	})
}

describe('acceptsEventStream — does the client opt into SSE?', () => {
	it('is true when Accept contains text/event-stream', () => {
		expect(acceptsEventStream(contextStub('text/event-stream'))).toBe(true)
	})

	it('is true when text/event-stream is one of several accepted types', () => {
		expect(acceptsEventStream(contextStub('application/json, text/event-stream;q=0.9'))).toBe(true)
	})

	it('matches case-insensitively', () => {
		expect(acceptsEventStream(contextStub('Text/Event-Stream'))).toBe(true)
	})

	it('is false for a plain JSON Accept', () => {
		expect(acceptsEventStream(contextStub('application/json'))).toBe(false)
	})

	it('is false for a wildcard Accept (no explicit event-stream)', () => {
		// A `*/*` does NOT opt in — the transport only streams when the client names the type.
		expect(acceptsEventStream(contextStub('*/*'))).toBe(false)
	})

	it('is false for an absent Accept header', () => {
		expect(acceptsEventStream(contextStub())).toBe(false)
	})
})

// src/server/mcp/helpers.ts — `readSessionHeader`, the pure reader the STATEFUL transport
// uses to look up a request's `mcp-session-id`. It reads only that header and narrows with
// `isString`, so the shared `createContextStub` carrying a `request` with the header exercises
// every branch (the over-the-wire mint/validate path is proven through a real server in
// factories.test.ts, §16). Total — a missing / repeated header reads as `undefined`.

describe('readSessionHeader — the request mcp-session-id, or undefined', () => {
	it('returns the single-valued session id when present', () => {
		const context = createContextStub({
			request: createRequestStub({ headers: { [MCP_SESSION_HEADER]: 'sess-123' } }),
		})
		expect(readSessionHeader(context)).toBe('sess-123')
	})

	it('is undefined when the header is absent', () => {
		const context = createContextStub({ request: createRequestStub({ headers: {} }) })
		expect(readSessionHeader(context)).toBeUndefined()
	})

	it('is undefined for the (illegal) repeated-header array form — narrowed, never asserted', () => {
		// A repeated header arrives as a `string[]`; `isString` rejects it → `undefined` (no session),
		// so a malformed duplicate id is treated exactly like an absent one (§14).
		const context = createContextStub({
			request: createRequestStub({ headers: { [MCP_SESSION_HEADER]: ['a', 'b'] } }),
		})
		expect(readSessionHeader(context)).toBeUndefined()
	})
})

// src/server/mcp/helpers.ts — `rejectUnknownSession`, the stateful transport's shared
// "unknown session" reply (the POST validation AND the DELETE route both call it). It only
// writes a response, so a context stub whose inert `json` is OVERRIDDEN with a capture
// records the exact (body, status) pair it sent — the over-the-wire 404 is proven through a
// real server in factories.test.ts (§16); this pins the envelope it builds.

describe('rejectUnknownSession — the 404 + JSON-RPC "Session not found" body', () => {
	it('sends a 404 carrying the JSON-RPC invalid-request error body', () => {
		// Capture what the helper writes via `context.json(body, status)` (the default stub's
		// `json` is an inert no-op — override it with a recorder, no `as`, §14).
		const sent: { body?: unknown; status?: number } = {}
		const context = createContextStub({
			json: (body, status) => {
				sent.body = body
				sent.status = status
			},
		})
		rejectUnknownSession(context)
		// The exact envelope: a `-32600` "Session not found" error with a `null` id, at HTTP 404
		// (mirroring the transport-failure 400 shape but at the session-not-found status).
		expect(sent.status).toBe(404)
		expect(sent.body).toEqual(jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Session not found'))
	})
})

describe('decodeEvent — one SSE data payload → its JSON-RPC message', () => {
	it('decodes a well-formed JSON-RPC envelope to the parsed message', () => {
		const message = rpcMessage({ method: 'ping', id: 7 })
		expect(decodeEvent(JSON.stringify(message))).toEqual(message)
	})

	it('is undefined for malformed JSON (a JSON.parse throw, caught not raised)', () => {
		expect(decodeEvent('{ not json')).toBeUndefined()
	})

	it('is undefined for valid JSON that is not a JSON-RPC message', () => {
		// Parses fine, but `parseJSONRPCMessage` rejects it (no `jsonrpc`) → dropped.
		expect(decodeEvent(JSON.stringify({ method: 'ping', id: 1 }))).toBeUndefined()
	})
})

describe('readEventStream — decode a Response SSE body into JSON-RPC messages', () => {
	it('decodes two data events into both messages, in order', async () => {
		const first = rpcMessage({ method: 'a', id: 1 })
		const second = rpcMessage({ method: 'b', id: 2 })
		const body = dataEvent(first) + dataEvent(second)
		expect(await readEventStream(sseResponse(body))).toEqual([first, second])
	})

	it('reassembles across the parser: a fully-terminated event emits, an unterminated trailing event does not', async () => {
		// The first event ends at its blank line (dispatched); the second `data:` line has NO
		// terminating blank line, so the SSEParser holds it buffered (never flushed on stream
		// end) — proving the parser-backed line/event reassembly, not a naive split.
		const delivered = rpcMessage({ method: 'delivered', id: 1 })
		const pending = rpcMessage({ method: 'pending', id: 2 })
		const body = dataEvent(delivered) + `data: ${JSON.stringify(pending)}`
		expect(await readEventStream(sseResponse(body))).toEqual([delivered])
	})

	it('drops a data event whose payload is not a JSON-RPC message, keeping the valid ones', async () => {
		// A malformed-JSON event and a valid-JSON-but-not-a-message event are both dropped
		// (no throw); the surrounding well-formed messages still decode.
		const first = rpcMessage({ method: 'a', id: 1 })
		const second = rpcMessage({ method: 'b', id: 2 })
		const body =
			dataEvent(first) + dataEvent('{ broken') + dataEvent({ method: 'x' }) + dataEvent(second)
		expect(await readEventStream(sseResponse(body))).toEqual([first, second])
	})

	it('is [] for an empty body', async () => {
		// An empty string is a real (empty) stream — read to completion, no events dispatched.
		expect(await readEventStream(sseResponse(''))).toEqual([])
	})

	it('is [] for a null-body Response (no stream)', async () => {
		// A 204 has a `null` body — `readEventStream` short-circuits to no messages.
		expect(await readEventStream(new Response(null, { status: 204 }))).toEqual([])
	})

	it('is [] for a non-event-stream JSON body (no data: events to dispatch)', async () => {
		// The helper reads the body through the SSEParser regardless of content-type; a plain
		// JSON body carries no `data:` lines, so nothing dispatches.
		const response = new Response(JSON.stringify(rpcMessage()), {
			headers: { 'content-type': 'application/json' },
		})
		expect(await readEventStream(response)).toEqual([])
	})
})

// src/server/mcp/helpers.ts — `upgradeRequestPath`, the pure reader the WebSocket transport's
// `createWebSocketServer` uses to match a raw `node:http` upgrade request's path against its
// configured mount path. It reads only `request.url` and narrows with `isString`, so the
// shared `createRequestStub` carrying a `url` exercises every branch (the live over-the-wire
// upgrade path is proven through a real spine in factories.test.ts, §16). Total — an absent
// target reads as `'/'`, a query string is stripped.

describe('upgradeRequestPath — the upgrade request path (no query)', () => {
	it('returns the path of a plain target', () => {
		expect(upgradeRequestPath(createRequestStub({ url: '/mcp' }))).toBe('/mcp')
	})

	it('strips the query string', () => {
		expect(upgradeRequestPath(createRequestStub({ url: '/mcp?session=abc&x=1' }))).toBe('/mcp')
	})

	it('returns / for the root target', () => {
		expect(upgradeRequestPath(createRequestStub({ url: '/' }))).toBe('/')
	})

	it('is / for an absent target (no url) — total, never throws', () => {
		// A `node:http` request with no `url` reads as `'/'` rather than throwing.
		expect(upgradeRequestPath(createRequestStub())).toBe('/')
	})
})
