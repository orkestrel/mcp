import type { JSONRPCMessage } from '@src/core'
import { describe, expect, inject, it } from 'vitest'
import { createMCPClient } from '@src/core'
import { WebSocketClientTransport } from '@src/browser'
import { waitForDelay } from '@orkestrel/test'
import { createJSONRPCRequest, MODERN_METADATA, waitForSettlement } from '../../../setup.js'

// src/browser/transports/WebSocketClientTransport.ts — what the browser face owes the socket
// it borrowed. The round trip against the real Node-face WebSocket server is proven in
// tests/src/browser/factories.test.ts; this file pins the RELEASE half. A socket this
// transport closed keeps firing its own native events afterwards, so a close that leaves the
// bridge installed lets a superseded socket end a connection it no longer owns.

const serverURL = inject('server')

describe('WebSocketClientTransport — close releases the socket it bound', () => {
	it('close settles a start whose handshake has not opened', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/mcp` })
		const starting = transport.start()

		await transport.close()

		await expect(
			waitForSettlement(starting, 50, 'Timed out waiting for close to settle the pending start'),
		).resolves.toBeUndefined()
	})

	it('ignores the old socket close after a new socket has replaced it', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/mcp` })
		const messages: JSONRPCMessage[] = []
		let closed = 0
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		await transport.start()
		// The first socket's native `close` lands here, after the second is already live.
		await waitForDelay(60)

		expect(closed).toBe(1)
		await transport.send({
			jsonrpc: '2.0',
			method: 'ping',
			id: 2,
			params: { _meta: MODERN_METADATA },
		})
		await waitForDelay(60)

		// The replacement connection is still the one this transport is talking over.
		expect(messages).toHaveLength(1)
		await transport.close()
	})

	it('emits close once however many times it is called', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/mcp` })
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		await transport.close()
		await waitForDelay(60)

		expect(closed).toBe(1)
	})
})

// The `send` contract (`src/core/types.ts`) says a transport whose channel cannot confirm a
// write answers a closed channel FROM ITS OWN STATE. Silently resolving is what leaves the
// client's correlated request pending to its deadline for a frame that was never written; the
// pre-open queue is a different state entirely and still flushes.
describe('WebSocketClientTransport — a send the channel cannot carry rejects', () => {
	it('rejects a send issued after close rather than reporting a write nobody made', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/mcp` })
		const received: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => received.push(message))
		await transport.start()
		await transport.close()

		await expect(transport.send(createJSONRPCRequest({ method: 'ping', id: 99 }))).rejects.toThrow(
			'WebSocket transport is not connected',
		)
		await waitForDelay(60)
		// The rejection is the honest answer: nothing was written, so nothing came back.
		expect(received).toEqual([])
	})

	it('rejects a send issued after the server closed the socket', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/close`, protocols: [] })
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()
		await waitForDelay(60)
		expect(closed).toBe(1)

		await expect(transport.send(createJSONRPCRequest({ method: 'ping', id: 1 }))).rejects.toThrow(
			'WebSocket transport is not connected',
		)
	})

	it('still queues a send issued before open and flushes it in order once the socket opens', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/mcp` })
		const received: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => received.push(message))

		// Neither send awaits `start()`: both are queued pre-open and flushed on `'open'`.
		const starting = transport.start()
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 1 }))
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 2 }))
		await starting
		await waitForDelay(60)

		expect(received.map((message) => message.id)).toEqual([1, 2])
		await transport.close()
	})

	it('drops a queued send at close so it never rides the next connection', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/mcp` })
		const received: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => received.push(message))

		// Queued against a connection that never opens: `start()` is not called, so this frame
		// belongs to the channel the next line abandons.
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 77 }))
		await transport.close()
		await transport.start()
		// The control. It travels the reconnected socket and comes back, so the delivery path is
		// alive and the abandoned frame's absence is a fact about the queue.
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 78 }))
		await waitForDelay(60)

		expect(received.map((message) => message.id)).toEqual([78])
		await transport.close()
	})

	it('settles the caller pending call on the closed channel instead of leaving it to time out', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/mcp` })
		const client = createMCPClient({ transport, timeout: 200 })
		await client.connect()
		await transport.close()

		// THE CALLER-VISIBLE SYMPTOM. A silent resolve registers the request, writes nothing, and
		// leaves the caller waiting out `timeout` before reporting a deadline for a channel that
		// had already gone. The rejection names the channel instead, at once.
		await expect(client.call('add', { a: 1, b: 2 })).rejects.toThrow(
			'WebSocket transport is not connected',
		)
	})
})
