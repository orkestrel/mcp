import { describe, expect, it, vi } from 'vitest'
import { MessagePortTransport } from '@src/browser'
import { waitForDelay } from '@orkestrel/test'

// src/browser/transports/MessagePortTransport.ts — the class driven DIRECTLY over one REAL
// native `new MessageChannel()` (no mocks). A `MessagePort` is a genuinely SYMMETRIC
// `MCPTransportInterface`, so the same class carries either role, and what it owes its port is
// the same either way: a non-string frame dropped, a string forwarded once, and a `close` that
// detaches, fires once, and survives a repeat. The composed round trip — port1 bound to a REAL
// server (`bindServer`), port2 driving a REAL client (`bindClient` +
// `createDuplexClientTransport`) — is the factory's subject and is proven in
// tests/src/browser/factories.test.ts.

describe('MessagePortTransport — the port contract over a real MessageChannel', () => {
	it('a non-string postMessage payload is ignored — no crash, no reply', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = new MessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		port2.postMessage({ not: 'a string' })
		port2.postMessage('sentinel')
		await vi.waitFor(() => expect(received).toEqual(['sentinel']))
	})

	it('a string postMessage payload IS delivered to the registered listen handler', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = new MessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		port2.postMessage('a plain string message')
		await vi.waitFor(() => expect(received).toEqual(['a plain string message']))
	})

	it('close() closes the port — a subsequent postMessage from the peer is undelivered', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = new MessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		transport.close()
		port2.postMessage('after close')
		await waitForDelay(50)

		expect(received).toEqual([])
	})

	it('close detaches its port listeners and clears registered callbacks', () => {
		const { port1 } = new MessageChannel()
		const transport = new MessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		transport.close()
		port1.dispatchEvent(new MessageEvent('message', { data: 'after close' }))

		expect(received).toEqual([])
	})

	it('close() fires the registered closed handler exactly once, even called twice', () => {
		const { port1 } = new MessageChannel()
		const transport = new MessagePortTransport({ port: port1 })
		let closedCalls = 0
		transport.closed(() => {
			closedCalls += 1
		})

		transport.close()
		transport.close()

		expect(closedCalls).toBe(1)
	})

	it('listen/closed are single-handler-replace — a second registration replaces, never adds', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = new MessagePortTransport({ port: port1 })
		const first: string[] = []
		const second: string[] = []
		transport.listen((message) => first.push(message))
		transport.listen((message) => second.push(message))

		port2.postMessage('one')
		await vi.waitFor(() => expect(second).toEqual(['one']))
		expect(first).toEqual([])
	})

	it('a messageerror event does not close the transport — later well-formed messages still arrive', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = new MessagePortTransport({ port: port1 })
		const received: string[] = []
		let closedCalls = 0
		transport.listen((message) => received.push(message))
		transport.closed(() => {
			closedCalls += 1
		})

		// Dispatch a genuine `messageerror` event directly on port1 — the real native event
		// this transport registers NO listener for (a `MessagePort` is a real `EventTarget`,
		// so this is a real event dispatch, not a mock of the transport). An unhandled
		// `messageerror` neither throws, closes the port, nor reaches the transport, and that
		// is what this asserts.
		port1.dispatchEvent(new MessageEvent('messageerror', { data: null }))
		port2.postMessage('still works')
		await vi.waitFor(() => expect(received).toEqual(['still works']))

		expect(closedCalls).toBe(0)
	})
})
