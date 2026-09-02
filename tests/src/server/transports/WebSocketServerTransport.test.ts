import type { JSONRPCMessage } from '@src/core'
import { describe, expect, it } from 'vitest'
import { bindServer } from '@src/core'
import { createDuplexServerTransport, WebSocketServerTransport } from '@src/server'
import {
	createNodeWebSocket,
	encodeWebSocketFrame,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_TEXT,
} from '@orkestrel/websocket'
import { createCalculatorServer, createJSONRPCRequest, MODERN_METADATA } from '../../../setup.js'
import { duplexPair, flushSocket, readClientFrames } from '../../../setupServer.js'

// src/server/mcp/WebSocketServerTransport.ts — the per-connection JSON-RPC-over-WebSocket
// SERVER bridge, driven END TO END over an in-memory `node:stream` Duplex PAIR (the shared
// `duplexPair` / `flushSocket` / `readClientFrames` harness — the same one the
// NodeWebSocket wrapper test uses; a REAL bidirectional socket, no mock). The setup: a
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
function decodeResponses(frames: ReadonlyArray<{ opcode: number; payload: Buffer }>): unknown[] {
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

	it('writes one frame per sequential send', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		await transport.start()
		await flushSocket()

		const first: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { a: 1 } }
		const second: JSONRPCMessage = { jsonrpc: '2.0', id: 2, result: { b: 2 } }
		await transport.send(first)
		await transport.send(second)
		await flushSocket()

		expect(decodeResponses(frames)).toEqual([first, second])
		await transport.close()
	})
})

// The `send` contract (`src/core/types.ts`) says a transport whose channel cannot confirm a
// write answers a closed channel FROM ITS OWN STATE. The wrapper drops a write on a non-open
// socket and reports nothing, so a resolve here tells the pump a frame reached a peer that had
// already gone — and the caller's correlated request waits out its deadline for it.
describe('WebSocketServerTransport — a send the channel cannot carry rejects', () => {
	it('rejects a send issued after close rather than reporting a write nobody made', async () => {
		const [server] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		await transport.start()
		await flushSocket()
		await transport.close()

		await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow(
			'WebSocket transport is not connected',
		)
	})

	it('rejects a send issued after the peer closed the socket, and writes no frame', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		await transport.start()
		await flushSocket()

		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, Buffer.alloc(0), { masked: true }))
		await flushSocket()
		const written = decodeResponses(frames).length

		await expect(transport.send({ jsonrpc: '2.0', id: 9, result: {} })).rejects.toThrow(
			'WebSocket transport is not connected',
		)
		await flushSocket()
		// The rejection is the honest answer: nothing more went out on a socket the peer ended.
		expect(decodeResponses(frames)).toHaveLength(written)
	})

	it('rejects a send on a socket that ended before start armed the subscriptions', async () => {
		// The socket's OWN state is the second source: nothing subscribed the transport to this
		// wrapper's `close`, so the transport's own closed flag is still clear and the wrapper's
		// `readyState` is the only thing that knows the channel is gone.
		const [server] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		ws.destroy()

		await expect(transport.send({ jsonrpc: '2.0', id: 2, result: {} })).rejects.toThrow(
			'WebSocket transport is not connected',
		)
	})

	it('carries the rejection across the core message-transport port', async () => {
		// `bindServer` drives the bridged port, not the transport, so a rejection that stopped at
		// the bridge would leave the pump believing every write landed.
		const [server] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		const bridge = createDuplexServerTransport(transport)
		await transport.start()
		await flushSocket()
		await transport.close()

		await expect(
			bridge.send(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} })),
		).rejects.toThrow('WebSocket transport is not connected')
	})
})

// A rejecting `send` is only safe if the thing that calls it survives the rejection. The bound
// pump is that caller, so this pins what a peer disconnecting mid-request does to it.
describe('WebSocketServerTransport — the bound pump survives a peer that disconnects mid-request', () => {
	it('writes no response, reports no fault, and raises no unhandled rejection', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		const mcp = createCalculatorServer()
		const faults: unknown[] = []
		const escaped: unknown[] = []
		const record = (reason: unknown): void => {
			escaped.push(reason)
		}
		mcp.emitter.on('error', (error) => faults.push(error))
		bindServer(mcp, createDuplexServerTransport(transport))
		await transport.start()
		await flushSocket()

		process.on('unhandledRejection', record)
		try {
			// ONE write carrying the request and the peer's close frame: the wrapper decodes both
			// in a single `data` event, so the disconnect lands while the dispatch is suspended.
			client.write(
				Buffer.concat([
					jsonFrame(
						createJSONRPCRequest({
							method: 'tools/call',
							id: 4,
							params: { name: 'add', arguments: {}, _meta: MODERN_METADATA },
						}),
					),
					encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, Buffer.alloc(0), { masked: true }),
				]),
			)
			await flushSocket()
			await flushSocket()
		} finally {
			process.off('unhandledRejection', record)
		}

		expect(decodeResponses(frames)).toEqual([])
		expect(faults).toEqual([])
		expect(escaped).toEqual([])
	})

	it('answers the same request when the peer stays, so the empty reading is the disconnect', async () => {
		// The control for the preceding test: identical wiring and an identical request, minus
		// the close frame. A reader that answers nothing here would make an empty frame log
		// prove the harness rather than the disconnect.
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		const mcp = createCalculatorServer()
		bindServer(mcp, createDuplexServerTransport(transport))
		await transport.start()
		await flushSocket()

		client.write(
			jsonFrame(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 4,
					params: { name: 'add', arguments: {}, _meta: MODERN_METADATA },
				}),
			),
		)
		await flushSocket()
		await flushSocket()

		expect(decodeResponses(frames)).toHaveLength(1)
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

	it('isolates a throwing message listener — the bridge survives', async () => {
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

// Release is what a closed transport owes the socket it borrowed. `start()` subscribes to the
// wrapper's `message` / `close` / `error` events, so a `close()` that leaves them installed
// keeps a dead bridge on the socket's emitter — and a frame that arrives between `close()`
// resolving and the peer's close echo still reaches a transport nobody is listening to.
describe('WebSocketServerTransport — close releases the socket subscriptions', () => {
	it('close() removes every subscription start() installed on the socket', async () => {
		const [server] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const before = [
			ws.emitter.count('message'),
			ws.emitter.count('close'),
			ws.emitter.count('error'),
		]
		const transport = new WebSocketServerTransport(ws)
		await transport.start()
		await flushSocket()

		expect([
			ws.emitter.count('message'),
			ws.emitter.count('close'),
			ws.emitter.count('error'),
		]).toEqual(before.map((count) => count + 1))

		await transport.close()

		expect([
			ws.emitter.count('message'),
			ws.emitter.count('close'),
			ws.emitter.count('error'),
		]).toEqual(before)
	})

	it('a frame arriving after close emits no message on the closed transport', async () => {
		const [server, client] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const transport = new WebSocketServerTransport(ws)
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()
		await flushSocket()

		await transport.close()
		// The peer has not answered the close frame yet, so its next request is still on the
		// wire and still decodes — a closed transport must not re-emit it.
		client.write(jsonFrame(createJSONRPCRequest({ method: 'tools/list', id: 9 })))
		await flushSocket()

		expect(messages).toEqual([])
	})

	it('a peer close frame releases the socket subscriptions too', async () => {
		const [server, client] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		const before = [
			ws.emitter.count('message'),
			ws.emitter.count('close'),
			ws.emitter.count('error'),
		]
		const transport = new WebSocketServerTransport(ws)
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()
		await flushSocket()

		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, Buffer.alloc(0), { masked: true }))
		await flushSocket()

		expect(closed).toBe(1)
		expect([
			ws.emitter.count('message'),
			ws.emitter.count('close'),
			ws.emitter.count('error'),
		]).toEqual(before)
	})
})
