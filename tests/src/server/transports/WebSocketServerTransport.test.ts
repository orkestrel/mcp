import type { JSONRPCMessage } from '@src/core'
import { describe, expect, it } from 'vitest'
import { WebSocketServerTransport } from '@src/server'
import {
	createNodeWebSocket,
	encodeWebSocketFrame,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_TEXT,
} from '@orkestrel/websocket'
import { createJSONRPCRequest } from '../../../setup.js'
import { duplexPair, flushSocket, readClientFrames } from '../../../setupServer.js'

// src/server/mcp/WebSocketServerTransport.ts — the per-connection JSON-RPC-over-WebSocket
// SERVER bridge, driven END TO END over an in-memory `node:stream` Duplex PAIR (the shared
// `duplexPair` / `flushSocket` / `readClientFrames` harness, AGENTS §16.1 — the same one the
// NodeWebSocket wrapper test uses; a REAL bidirectional socket, no mock — §16). The setup: a
// server-mode `NodeWebSocket` over the server end, wrapped in a `WebSocketServerTransport`;
// the test plays the CLIENT — it writes MASKED JSON-RPC text frames (the wrapper decodes
// them) and reads the server's UNMASKED response frames (decoding each payload as JSON).
// Proves: a client text frame → the transport emits the parsed `JSONRPCMessage`; `send`
// round-trips a response frame the client decodes; a malformed / non-message frame is
// surfaced on `error` and dropped (no throw); close propagates to the transport's `close`.

// The client's `Sec-WebSocket-Key` (the wrapper needs one to enter server mode + write the
// 101 handshake). The value is irrelevant to the transport — only the framing matters.
const CLIENT_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

// A masked client text frame carrying `value` as its JSON payload — the wire a real MCP
// WebSocket client writes (client→server frames MUST be masked, RFC 6455 §5.3).
function jsonFrame(value: unknown): Buffer {
	return encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, JSON.stringify(value), { masked: true })
}

// Decode the JSON payloads of the server's text response frames the client read.
function decodeResponses(frames: readonly { opcode: number; payload: Buffer }[]): unknown[] {
	return frames
		.filter((frame) => frame.opcode === WEBSOCKET_OPCODE_TEXT)
		.map((frame) => JSON.parse(frame.payload.toString('utf-8')))
}

describe('WebSocketServerTransport — inbound frames become transport messages', () => {
	it('emits the parsed JSONRPCMessage for a client JSON-RPC text frame', async () => {
		const [server, client] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()
		await flushSocket()

		const request = createJSONRPCRequest({ method: 'tools/list', id: 7 })
		client.write(jsonFrame(request))
		await flushSocket()

		// The transport JSON-parsed + narrowed the frame to the JSONRPCMessage it carried.
		expect(messages).toEqual([request])
		await transport.close()
	})

	it('surfaces a malformed (non-JSON) frame on error and drops it — never throws', async () => {
		const [server, client] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()
		await flushSocket()

		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, '{ not json', { masked: true }))
		await flushSocket()

		expect(messages).toEqual([]) // nothing emitted
		expect(errors).toHaveLength(1) // the parse failure surfaced for observation
		// The bridge is still alive — a well-formed frame after the bad one still parses.
		const good = createJSONRPCRequest({ method: 'ping', id: 1 })
		client.write(jsonFrame(good))
		await flushSocket()
		expect(messages).toEqual([good])
		await transport.close()
	})

	it('surfaces a well-formed-JSON-but-non-JSON-RPC frame on error and drops it', async () => {
		const [server, client] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()
		await flushSocket()

		// Valid JSON, but not a JSON-RPC message (no `jsonrpc: '2.0'`) — dropped, not asserted.
		client.write(jsonFrame({ hello: 'world' }))
		await flushSocket()

		expect(messages).toEqual([])
		expect(errors).toHaveLength(1)
		await transport.close()
	})
})

describe('WebSocketServerTransport — send writes response frames the client decodes', () => {
	it('round-trips a JSON-RPC response as a single text frame', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		await transport.start()
		await flushSocket()

		const response: JSONRPCMessage = { jsonrpc: '2.0', id: 7, result: { tools: [] } }
		await transport.send(response)
		await flushSocket()

		expect(decodeResponses(frames)).toEqual([response])
		await transport.close()
	})

	it('writes one frame per message for a batch send', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		await transport.start()
		await flushSocket()

		const batch: readonly JSONRPCMessage[] = [
			{ jsonrpc: '2.0', id: 1, result: { a: 1 } },
			{ jsonrpc: '2.0', id: 2, result: { b: 2 } },
		]
		await transport.send(batch)
		await flushSocket()

		expect(decodeResponses(frames)).toEqual(batch)
		await transport.close()
	})
})

describe('WebSocketServerTransport — close propagation', () => {
	it('close() fires the transport close event', async () => {
		const [server] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()
		await flushSocket()

		await transport.close()
		expect(closed).toBe(1)
		// Idempotent — a second close does not re-emit.
		await transport.close()
		expect(closed).toBe(1)
	})

	it('a peer close frame propagates to the transport close event', async () => {
		const [server, client] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()
		await flushSocket()

		// A masked client close frame ends the socket; the wrapper's `close` bridges to the
		// transport's `close`.
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, Buffer.alloc(0), { masked: true }))
		await flushSocket()

		expect(closed).toBe(1)
	})

	it('the session is undefined for the stateless v1', async () => {
		const [server] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		expect(transport.session).toBeUndefined()
		await transport.start()
		await transport.close()
	})

	it('isolates a throwing message listener — the bridge survives (§13)', async () => {
		const [server, client] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		const seen: unknown[] = []
		// A buggy `message` listener that always throws. The emitter isolates it (the transport
		// has no `error` handler, so the throw is swallowed silently) and never crashes the bridge.
		transport.emitter.on('message', () => {
			throw new Error('listener boom')
		})
		transport.emitter.on('message', (message) => seen.push(message))
		await transport.start()
		await flushSocket()

		client.write(jsonFrame(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await flushSocket()
		client.write(jsonFrame(createJSONRPCRequest({ method: 'ping', id: 2 })))
		await flushSocket()

		// THE LOAD-BEARING ASSERTION: the bridge survived — both messages dispatched to the
		// non-throwing sibling listener despite the throwing one (no crash, no escaped throw).
		expect(seen).toHaveLength(2)
		await transport.close()
	})
})
