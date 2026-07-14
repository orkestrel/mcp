import type { JSONRPCMessage } from '@src/core'
import { describe, expect, it } from 'vitest'
import { JSONRPC_INVALID_REQUEST, jsonRPCError, parseJSONRPCMessage } from '@src/core'
import {
	acceptsEventStream,
	decodeEvent,
	MCP_SESSION_HEADER,
	readEventStream,
	readLastEventId,
	readSessionHeader,
	rejectUnknownSession,
	upgradeRequestPath,
} from '@src/server'
import { createJSONRPCRequest } from '../../setup.js'
import { createRequestStub } from '../../setupServer.js'

// One SSE `data:` event carrying `payload` as its JSON-serialized data, terminated by the
// blank line that dispatches it — the exact wire framing the server's `openStream` seam
// writes (`s.write({ data: JSON.stringify(response) })`), so a body of these round-trips
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

// A fetch-standard Request carrying (or omitting) the given headers — the shape every
// pure fetch-standard reader below (`acceptsEventStream` / `readSessionHeader` /
// `readLastEventId`) takes directly, no stub crossing needed (§14 — `Request` IS the
// boundary type now).
function requestWithHeaders(headers?: Record<string, string>): Request {
	return new Request('http://localhost/mcp', { headers })
}

// src/server/helpers.ts — `acceptsEventStream`, the pure `Accept`-header reader the MCP
// transport uses to pick a Streamable-HTTP SSE response over a plain JSON body. It reads
// only `request.headers.get('accept')` and narrows with a `null` check (the live
// over-the-wire SSE path is proven through a real server in factories.test.ts, AGENTS §16).

describe('acceptsEventStream — does the client opt into SSE?', () => {
	it('is true when Accept contains text/event-stream', () => {
		expect(acceptsEventStream(requestWithHeaders({ accept: 'text/event-stream' }))).toBe(true)
	})

	it('is true when text/event-stream is one of several accepted types', () => {
		expect(
			acceptsEventStream(
				requestWithHeaders({ accept: 'application/json, text/event-stream;q=0.9' }),
			),
		).toBe(true)
	})

	it('matches case-insensitively', () => {
		expect(acceptsEventStream(requestWithHeaders({ accept: 'Text/Event-Stream' }))).toBe(true)
	})

	it('is false for a plain JSON Accept', () => {
		expect(acceptsEventStream(requestWithHeaders({ accept: 'application/json' }))).toBe(false)
	})

	it('is false for a wildcard Accept (no explicit event-stream)', () => {
		// A `*/*` does NOT opt in — the transport only streams when the client names the type.
		expect(acceptsEventStream(requestWithHeaders({ accept: '*/*' }))).toBe(false)
	})

	it('is false for an absent Accept header', () => {
		expect(acceptsEventStream(requestWithHeaders())).toBe(false)
	})
})

// src/server/helpers.ts — `readSessionHeader`, the pure reader the STATEFUL transport
// uses to look up a request's `mcp-session-id`. Total — a missing header reads as
// `undefined` (the over-the-wire mint/validate path is proven through a real server in
// middlewares.test.ts, §16).

describe('readSessionHeader — the request mcp-session-id, or undefined', () => {
	it('returns the session id when present', () => {
		const request = requestWithHeaders({ [MCP_SESSION_HEADER]: 'sess-123' })
		expect(readSessionHeader(request)).toBe('sess-123')
	})

	it('is undefined when the header is absent', () => {
		expect(readSessionHeader(requestWithHeaders())).toBeUndefined()
	})
})

// src/server/helpers.ts — `readLastEventId`, the pure reader the resumable GET-SSE stream
// uses to find a reconnecting client's resume cursor. Total — a missing header reads as
// `undefined` (no resume).

describe('readLastEventId — the resume cursor, or undefined', () => {
	it('returns the last-event-id when present', () => {
		const request = requestWithHeaders({ 'last-event-id': '7' })
		expect(readLastEventId(request)).toBe('7')
	})

	it('is undefined when the header is absent', () => {
		expect(readLastEventId(requestWithHeaders())).toBeUndefined()
	})
})

// src/server/helpers.ts — `rejectUnknownSession`, the stateful transport's shared "unknown
// session" reply (the POST validation AND the GET / DELETE routes all call it). Total —
// never throws; the exact envelope is pinned here, the over-the-wire 404 is proven through
// a real server in middlewares.test.ts (§16).

describe('rejectUnknownSession — the 404 + JSON-RPC "Session not found" body', () => {
	it('sends a 404 carrying the JSON-RPC invalid-request error body', async () => {
		const response = rejectUnknownSession()
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual(
			jsonRPCError(null, JSONRPC_INVALID_REQUEST, 'Session not found'),
		)
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

// src/server/helpers.ts — `upgradeRequestPath`, the pure reader the WebSocket transport's
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
