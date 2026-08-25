import type { JSONRPCNotification, JSONRPCMessage, JSONRPCResponse, MCPStream } from '@src/core'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
	JSONRPC_INVALID_REQUEST,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	MCP_PROTOCOL_VERSION,
	buildJSONRPCError,
	MCPStreamController,
	parseJSONRPCMessage,
} from '@src/core'
import {
	acceptsEventStream,
	allowsOrigin,
	decodeEvent,
	inferHeaderIssue,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_SESSION_HEADER,
	readEventStream,
	readLastEventId,
	readSessionHeader,
	rejectUnknownSession,
	sendEventStream,
	upgradeRequestPath,
	writeLine,
} from '@src/server'
import { createJSONRPCRequest, probeOwnership } from '../../setup.js'
import { createRequestStub, createStreamStub } from '../../setupServer.js'

// The held-open fixtures these pump tests replay: one notification then a terminal, and a
// producer that fails before it ever reaches one.
const STREAM_NOTIFICATION: JSONRPCNotification = Object.freeze({
	jsonrpc: '2.0',
	method: 'notifications/progress',
})
const STREAM_TERMINAL: JSONRPCResponse = Object.freeze({
	jsonrpc: '2.0',
	id: 1,
	result: { done: true },
})

async function* replayStream(): MCPStream {
	yield STREAM_NOTIFICATION
	return STREAM_TERMINAL
}

async function* failingStream(): MCPStream {
	yield STREAM_NOTIFICATION
	throw new Error('producer boom')
}

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
// `readLastEventId`) takes directly, no stub crossing needed (`Request` IS the
// boundary type now).
function requestWithHeaders(headers?: Record<string, string>): Request {
	return new Request('http://localhost/mcp', headers !== undefined ? { headers } : {})
}

describe('writeLine — one callback-confirmed writable write', () => {
	it('rejects with the completion callback error', async () => {
		const failure = new Error('write callback failed')
		const errors: unknown[] = []
		const output = new Writable({
			write(_chunk, _encoding, callback) {
				callback(failure)
			},
		})
		output.on('error', (error) => errors.push(error))
		const emitted = new Promise<void>((resolve) => output.once('error', () => resolve()))

		await expect(writeLine(output, 'line\n')).rejects.toBe(failure)
		await emitted

		expect(errors).toEqual([failure])
	})

	it('converts a synchronous write throw into a rejection', async () => {
		const failure = new Error('write threw')
		const output = new Writable({
			write() {
				throw failure
			},
		})

		await expect(writeLine(output, 'line\n')).rejects.toBe(failure)
	})
})

// src/server/helpers.ts — `acceptsEventStream`, the pure `Accept`-header reader the MCP
// transport uses to pick a Streamable-HTTP SSE response over a plain JSON body. It reads
// only `request.headers.get('accept')` and narrows with a `null` check (the live
// over-the-wire SSE path is proven through a real server in factories.test.ts).

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

describe('allowsOrigin — loopback default, explicit validation, and upstream delegation', () => {
	it('allows an absent Origin but requires every non-loopback origin to be allowlisted', () => {
		expect(allowsOrigin(new Request('https://server.example/mcp'))).toBe(true)
		const request = new Request('https://server.example/mcp', {
			headers: { origin: 'https://client.example' },
		})
		expect(allowsOrigin(request)).toBe(false)
		expect(allowsOrigin(request, { origins: ['https://client.example'] })).toBe(true)
	})

	it('allows canonical loopback literals on any port and parsed scheme without an allowlist', () => {
		const origins = [
			'http://127.0.0.1:37757',
			'ftp://127.255.255.254:37757',
			'http://localhost:37757',
			'https://[::1]:37757',
		]
		for (const origin of origins) {
			const request = new Request('https://server.example/mcp', { headers: { origin } })
			expect(allowsOrigin(request)).toBe(true)
		}
	})

	it('does not trust a present origin merely because it matches the request URL', () => {
		const request = new Request('https://server.example/mcp', {
			headers: { origin: 'https://server.example' },
		})
		expect(allowsOrigin(request)).toBe(false)
		expect(allowsOrigin(request, { origins: ['https://server.example'] })).toBe(true)
	})

	it('does not mistake a hostname beginning with 127 for an IPv4 loopback literal', () => {
		const request = new Request('https://server.example/mcp', {
			headers: { origin: 'http://127.evil.example.test:37757' },
		})
		expect(allowsOrigin(request)).toBe(false)
	})

	it('allows a present unlisted origin when validation is delegated upstream', () => {
		const request = new Request('https://server.example/mcp', {
			headers: { origin: 'https://client.example' },
		})
		expect(allowsOrigin(request, { enabled: false })).toBe(true)
	})

	it('rejects invalid and opaque origins', () => {
		expect(
			allowsOrigin(
				new Request('https://server.example/mcp', { headers: { origin: 'not an origin' } }),
			),
		).toBe(false)
		expect(
			allowsOrigin(new Request('https://server.example/mcp', { headers: { origin: 'null' } })),
		).toBe(false)
		expect(
			allowsOrigin(
				new Request('https://server.example/mcp', {
					headers: { origin: 'https://client.example/path' },
				}),
				{ origins: ['https://client.example'] },
			),
		).toBe(false)
		expect(
			allowsOrigin(
				new Request('https://server.example/mcp', {
					headers: { origin: 'http://127.1:37757' },
				}),
			),
		).toBe(false)
	})
})

describe('inferHeaderIssue — one diagnosis across modern and legacy headers', () => {
	it('is undefined for legacy initialize and a header-bearing legacy request', () => {
		expect(inferHeaderIssue(requestWithHeaders(), createJSONRPCRequest())).toBeUndefined()
		expect(
			inferHeaderIssue(
				requestWithHeaders({ [MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION }),
				createJSONRPCRequest({ method: 'tools/list' }),
			),
		).toBeUndefined()
	})

	it('diagnoses a missing protocol header on a stateless legacy request', () => {
		expect(
			inferHeaderIssue(requestWithHeaders(), createJSONRPCRequest({ method: 'tools/list' })),
		).toEqual({
			header: 'MCP-Protocol-Version',
			reason: 'missing',
			message: "Required MCP-Protocol-Version header is missing; this server offers '2025-11-25'.",
		})
	})

	it('is undefined when the modern protocol and method headers match tools/list', () => {
		const message = createJSONRPCRequest({
			method: 'tools/list',
			params: {
				_meta: {
					[MCP_META_VERSION]: MCP_MODERN_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		})
		const request = requestWithHeaders({
			[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
			[MCP_METHOD_HEADER]: 'tools/list',
		})

		expect(inferHeaderIssue(request, message)).toBeUndefined()
	})

	it('diagnoses a missing modern protocol header', () => {
		const message = createJSONRPCRequest({
			method: 'tools/list',
			params: {
				_meta: {
					[MCP_META_VERSION]: MCP_MODERN_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		})

		expect(
			inferHeaderIssue(requestWithHeaders({ [MCP_METHOD_HEADER]: 'tools/list' }), message),
		).toEqual({
			header: 'MCP-Protocol-Version',
			reason: 'missing',
			message:
				"Required MCP-Protocol-Version header is missing; the request body version is '2026-07-28'.",
		})
	})

	it('diagnoses a mismatched modern protocol header without echoing its value', () => {
		const message = createJSONRPCRequest({
			method: 'tools/list',
			params: {
				_meta: {
					[MCP_META_VERSION]: MCP_MODERN_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		})
		const issue = inferHeaderIssue(
			requestWithHeaders({
				[MCP_PROTOCOL_VERSION_HEADER]: 'client-supplied-version',
				[MCP_METHOD_HEADER]: 'tools/list',
			}),
			message,
		)

		expect(issue).toEqual({
			header: 'MCP-Protocol-Version',
			reason: 'mismatched',
			message: "MCP-Protocol-Version header does not match the request body version '2026-07-28'.",
		})
		expect(issue?.message).not.toContain('client-supplied-version')
	})

	it('diagnoses a missing modern method header', () => {
		const message = createJSONRPCRequest({
			method: 'tools/list',
			params: {
				_meta: {
					[MCP_META_VERSION]: MCP_MODERN_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		})

		expect(
			inferHeaderIssue(
				requestWithHeaders({ [MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION }),
				message,
			),
		).toEqual({
			header: 'Mcp-Method',
			reason: 'missing',
			message: "Required Mcp-Method header is missing; the request body method is 'tools/list'.",
		})
	})

	it('diagnoses a mismatched modern method header without echoing its value', () => {
		const message = createJSONRPCRequest({
			method: 'tools/list',
			params: {
				_meta: {
					[MCP_META_VERSION]: MCP_MODERN_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		})
		const issue = inferHeaderIssue(
			requestWithHeaders({
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'client-supplied-method',
			}),
			message,
		)

		expect(issue).toEqual({
			header: 'Mcp-Method',
			reason: 'mismatched',
			message: "Mcp-Method header does not match the request body method 'tools/list'.",
		})
		expect(issue?.message).not.toContain('client-supplied-method')
	})

	it('diagnoses a missing modern tools/call name header', () => {
		const message = createJSONRPCRequest({
			method: 'tools/call',
			params: {
				name: 'add',
				_meta: {
					[MCP_META_VERSION]: MCP_MODERN_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		})

		expect(
			inferHeaderIssue(
				requestWithHeaders({
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
					[MCP_METHOD_HEADER]: 'tools/call',
				}),
				message,
			),
		).toEqual({
			header: 'Mcp-Name',
			reason: 'missing',
			message: "Required Mcp-Name header is missing; the request body tool name is 'add'.",
		})
	})

	it('diagnoses a mismatched modern tools/call name header without echoing its value', () => {
		const message = createJSONRPCRequest({
			method: 'tools/call',
			params: {
				name: 'add',
				_meta: {
					[MCP_META_VERSION]: MCP_MODERN_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		})
		const issue = inferHeaderIssue(
			requestWithHeaders({
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'tools/call',
				[MCP_NAME_HEADER]: 'client-supplied-name',
			}),
			message,
		)

		expect(issue).toEqual({
			header: 'Mcp-Name',
			reason: 'mismatched',
			message: "Mcp-Name header does not match the request body tool name 'add'.",
		})
		expect(issue?.message).not.toContain('client-supplied-name')
	})

	it('diagnoses a mismatched legacy session protocol header', () => {
		expect(
			inferHeaderIssue(
				requestWithHeaders({ [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' }),
				MCP_PROTOCOL_VERSION,
			),
		).toEqual({
			header: 'MCP-Protocol-Version',
			reason: 'mismatched',
			message:
				"MCP-Protocol-Version header does not match the active session version '2025-11-25'.",
		})
	})
})

// src/server/helpers.ts — `readSessionHeader`, the pure reader the STATEFUL transport
// uses to look up a request's `mcp-session-id`. Total — a missing header reads as
// `undefined` (the over-the-wire mint/validate path is proven through a real server in
// middlewares.test.ts).

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
// a real server in middlewares.test.ts.

describe('rejectUnknownSession — the 404 + JSON-RPC "Session not found" body', () => {
	it('sends a 404 carrying the JSON-RPC invalid-request error body', async () => {
		const response = rejectUnknownSession()
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual(
			buildJSONRPCError(undefined, JSONRPC_INVALID_REQUEST, 'Session not found'),
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
// upgrade path is proven through a real spine in factories.test.ts). Total — an absent
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

// ── sendEventStream — the Streamable-HTTP pump, now a named leaf ─────────────
//
// It used to be an anonymous `queueMicrotask` body inside `createMCPPostHandler`, reachable
// only by driving a whole `Request` through the route. As a leaf it is driven directly, and
// the ownership claim it shares with `sendStream` is measured by the SAME instrument the core
// pump is measured by — including the outside-population control, a hand-written consumer
// that reads one message and walks away, which that instrument must report as leaking.

describe('sendEventStream — writes the exchange out and always ends it', () => {
	it('writes every notification in order, the terminal last, and ends the SSE body', async () => {
		const sse = createStreamStub()
		const closure = new AbortController()
		const stream = new MCPStreamController(replayStream(), closure.signal, closure)

		await sendEventStream(stream, sse)

		expect(sse.events).toEqual([
			JSON.stringify(STREAM_NOTIFICATION),
			JSON.stringify(STREAM_TERMINAL),
		])
		expect(sse.ended).toBe(true)
		expect(closure.signal.aborted).toBe(true)
	})

	it('releases the exchange when a write throws mid-stream, and never rejects', async () => {
		const failure = new Error('socket gone')
		const outcome = await probeOwnership(async (stream) => {
			await sendEventStream(stream, createStreamStub({ write: failure }))
		})

		// Total: the write fault is contained, so the consumer sees no failure at all —
		// which is exactly why the released slot is the only evidence that it ended.
		expect(outcome.failure).toBeUndefined()
		expect(outcome.released).toBe(true)
	})

	it('releases a parked producer when the request signal aborts underneath the pump', async () => {
		const sse = createStreamStub()
		const outcome = await probeOwnership(async (stream) => {
			const pump = sendEventStream(stream, sse)
			stream.stop()
			await pump
		})

		expect(outcome.released).toBe(true)
		expect(sse.ended).toBe(true)
	})

	it('ends the SSE body even when the producer itself fails', async () => {
		const sse = createStreamStub()
		const closure = new AbortController()
		const stream = new MCPStreamController(failingStream(), closure.signal, closure)

		await sendEventStream(stream, sse)

		expect(sse.ended).toBe(true)
		expect(closure.signal.aborted).toBe(true)
	})
})
