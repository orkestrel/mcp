import type { JSONRPCMessage } from '@src/core'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { StdioServerTransport } from '@src/server'
import { waitForDelay } from '@orkestrel/test'
import { createJSONRPCRequest } from '../../../setup.js'

// src/server/transports/StdioServerTransport.ts — the stdio SERVER bridge, driven END TO END
// over a REAL pair of injectable `node:stream` PassThroughs standing in for
// `process.stdin`/`process.stdout` (real stream I/O, no mock). The test plays the
// PEER: it writes newline-delimited JSON-RPC lines to the `input` stream (the transport reads)
// and reads the lines the transport writes to `output`. Proves: a complete input line becomes
// the parsed `message` event; a partial line buffers across chunks; a malformed line surfaces
// `error` and is dropped (never throws); `send` writes one newline-terminated line per message;
// `close` fires the transport's `close` event (idempotent).

// Collect every newline-terminated line written to `output`, split as they arrive.
function collectLines(output: PassThrough): { readonly lines: () => readonly string[] } {
	let buffer = ''
	const lines: string[] = []
	output.on('data', (chunk: Buffer | string) => {
		buffer += chunk.toString()
		const parts = buffer.split('\n')
		buffer = parts[parts.length - 1] ?? ''
		for (const line of parts.slice(0, -1)) lines.push(line)
	})
	return { lines: () => lines }
}

describe('StdioServerTransport — inbound lines become transport messages', () => {
	it('emits the parsed JSONRPCMessage for one complete newline-terminated input line', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()

		const request = createJSONRPCRequest({ method: 'tools/list', id: 7 })
		input.write(`${JSON.stringify(request)}\n`)
		await waitForDelay()

		expect(messages).toEqual([request])
		await transport.close()
	})

	it('buffers a partial line across chunks and delivers it once complete', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()

		const request = createJSONRPCRequest({ method: 'ping', id: 1 })
		const line = `${JSON.stringify(request)}\n`
		const mid = Math.floor(line.length / 2)
		input.write(line.slice(0, mid))
		await waitForDelay()
		expect(messages).toEqual([]) // no complete line yet
		input.write(line.slice(mid))
		await waitForDelay()

		expect(messages).toEqual([request])
		await transport.close()
	})

	it('surfaces a malformed (non-JSON) line on error and drops it — never throws', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()

		input.write('{ not json\n')
		await waitForDelay()

		expect(messages).toEqual([])
		expect(errors).toHaveLength(1)
		// The bridge is still alive — a well-formed line after the bad one still parses.
		const good = createJSONRPCRequest({ method: 'ping', id: 2 })
		input.write(`${JSON.stringify(good)}\n`)
		await waitForDelay()
		expect(messages).toEqual([good])
		await transport.close()
	})

	it('surfaces a well-formed-JSON-but-non-JSON-RPC line on error and drops it', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()

		input.write(`${JSON.stringify({ hello: 'world' })}\n`)
		await waitForDelay()

		expect(messages).toEqual([])
		expect(errors).toHaveLength(1)
		await transport.close()
	})

	it('skips a stray blank line without emitting message or error', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()

		input.write('\n')
		await waitForDelay()

		expect(messages).toEqual([])
		expect(errors).toEqual([])
		await transport.close()
	})
})

describe('StdioServerTransport — send writes response lines the peer decodes', () => {
	it('writes one newline-terminated JSON line per send', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const { lines } = collectLines(output)
		const transport = new StdioServerTransport(input, output)
		await transport.start()

		const response: JSONRPCMessage = { jsonrpc: '2.0', id: 7, result: { tools: [] } }
		await transport.send(response)
		await waitForDelay()

		expect(lines().map((line) => JSON.parse(line))).toEqual([response])
		await transport.close()
	})

	it('writes one line per sequential send', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const { lines } = collectLines(output)
		const transport = new StdioServerTransport(input, output)
		await transport.start()

		const first: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { a: 1 } }
		const second: JSONRPCMessage = { jsonrpc: '2.0', id: 2, result: { b: 2 } }
		await transport.send(first)
		await transport.send(second)
		await waitForDelay()

		expect(lines().map((line) => JSON.parse(line))).toEqual([first, second])
		await transport.close()
	})
})

describe('StdioServerTransport — lifecycle', () => {
	it('pauses the input after close when the transport started the flow', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		await transport.start()

		expect(input.readableFlowing).toBe(true)
		await transport.close()

		expect(input.readableFlowing).toBe(false)
	})

	it('restores the caller-owned input listener counts when close() releases the transport', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		input.on('data', () => {})
		input.on('close', () => {})
		input.on('error', () => {})
		expect(input.readableFlowing).toBe(true)
		const before = [
			input.listenerCount('data'),
			input.listenerCount('close'),
			input.listenerCount('error'),
		]
		const transport = new StdioServerTransport(input, output)
		await transport.start()

		expect([
			input.listenerCount('data'),
			input.listenerCount('close'),
			input.listenerCount('error'),
		]).toEqual(before.map((count) => count + 1))

		await transport.close()

		expect([
			input.listenerCount('data'),
			input.listenerCount('close'),
			input.listenerCount('error'),
		]).toEqual(before)
		expect(input.readableFlowing).toBe(true)
		expect(input.destroyed).toBe(false)
		expect(input.writableEnded).toBe(false)
	})

	it('close() twice is a no-op and start() after close stays refused', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		expect(closed).toBe(1)
		await transport.close()
		expect(closed).toBe(1)
		await transport.start()
		expect([
			input.listenerCount('data'),
			input.listenerCount('close'),
			input.listenerCount('error'),
		]).toEqual([0, 0, 0])
	})

	it('the input stream close event releases the executing listener and its siblings', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		input.end()
		await waitForDelay()

		expect(closed).toBe(1)
		expect([
			input.listenerCount('data'),
			input.listenerCount('close'),
			input.listenerCount('error'),
		]).toEqual([0, 0, 0])
	})

	it('the session is undefined for the stateless v1', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		expect(transport.session).toBeUndefined()
		await transport.start()
		await transport.close()
	})

	it('isolates a throwing message listener — the bridge survives', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		const seen: unknown[] = []
		transport.emitter.on('message', () => {
			throw new Error('listener boom')
		})
		transport.emitter.on('message', (message) => seen.push(message))
		await transport.start()

		input.write(`${JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 }))}\n`)
		await waitForDelay()
		input.write(`${JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 2 }))}\n`)
		await waitForDelay()

		expect(seen).toHaveLength(2)
		await transport.close()
	})
})

// The flow-ownership cases the release rule has to separate. Ownership is read at
// `start`, before anything is attached (`readableFlowing !== true` means the caller was not
// already reading), and spent at `close`, after this transport's own `data` listener is gone
// (a listener still there means a caller reader remains). Each case below fixes one row: a
// caller flow this transport never started stays flowing, and a reader that arrived after
// `start` keeps the flow alive too.
describe('StdioServerTransport — input flow ownership', () => {
	it('leaves an input the caller had already resumed flowing after close', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		// A bare `resume()` starts the flow with NO `data` listener, so a listener count read at
		// `start` reports "nobody is reading" for a stream the caller is already draining.
		input.resume()
		expect(input.readableFlowing).toBe(true)
		const transport = new StdioServerTransport(input, output)
		await transport.start()

		await transport.close()

		expect(input.readableFlowing).toBe(true)
	})

	it('leaves an input flowing when the caller attached and detached a reader before start', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const reader = (): void => {}
		input.on('data', reader)
		input.removeListener('data', reader)
		// Removing the listener does not stop the flow the attach started.
		expect(input.readableFlowing).toBe(true)
		const transport = new StdioServerTransport(input, output)
		await transport.start()

		await transport.close()

		expect(input.readableFlowing).toBe(true)
	})

	it('leaves the flow alone when a second reader attached after start', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		await transport.start()
		// A caller reader that arrives AFTER `start` is invisible to any reading taken at `start`.
		const chunks: string[] = []
		input.on('data', (chunk: Buffer | string) => chunks.push(chunk.toString()))

		await transport.close()

		expect(input.readableFlowing).toBe(true)
		// The surviving reader still receives data — the release did not starve it.
		input.write('after close\n')
		await waitForDelay()
		expect(chunks).toEqual(['after close\n'])
	})

	it('pauses an input the caller had explicitly paused before start', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		input.pause()
		expect(input.readableFlowing).toBe(false)
		const transport = new StdioServerTransport(input, output)
		// Attaching a `data` listener does not restart a stream the caller explicitly paused —
		// only `resume()` does — so the input is still non-flowing here.
		await transport.start()
		expect(input.readableFlowing).toBe(false)

		await transport.close()

		// The caller was not reading and left no reader behind, so this transport hands the
		// stream back non-flowing — the state that lets a process holding `process.stdin` exit.
		expect(input.readableFlowing).toBe(false)
	})
})
