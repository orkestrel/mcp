import type { JSONRPCMessage, JSONRPCNotification, JSONRPCResponse, MCPStream } from '@src/core'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MCPStreamController, MCPTextStreamController, sendStream } from '@src/core'
import { StdioServerTransport, createDuplexServerTransport } from '@src/server'
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

async function* responseStream(
	notification: JSONRPCNotification,
	response: JSONRPCResponse,
): MCPStream {
	yield notification
	return response
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

	it('settles deferred high-water-mark sends in call order', async () => {
		const input = new PassThrough()
		const chunks: string[] = []
		const releases: Array<() => void> = []
		const output = new Writable({
			highWaterMark: 1,
			write(chunk, _encoding, callback) {
				chunks.push(chunk.toString())
				releases.push(() => callback())
			},
		})
		const transport = new StdioServerTransport(input, output)
		const settled: string[] = []
		await transport.start()

		const first = transport.send({ jsonrpc: '2.0', id: 1, result: { order: 'first' } })
		const second = transport.send({ jsonrpc: '2.0', id: 2, result: { order: 'second' } })
		void first.then(() => settled.push('first'))
		void second.then(() => settled.push('second'))

		expect(chunks).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"order":"first"}}\n'])
		const releaseFirst = releases.shift()
		if (releaseFirst === undefined) throw new Error('first write was not awaiting completion')
		releaseFirst()
		await first
		await Promise.resolve()
		expect(settled).toEqual(['first'])
		expect(chunks).toEqual([
			'{"jsonrpc":"2.0","id":1,"result":{"order":"first"}}\n',
			'{"jsonrpc":"2.0","id":2,"result":{"order":"second"}}\n',
		])

		const releaseSecond = releases.shift()
		if (releaseSecond === undefined) throw new Error('second write was not awaiting completion')
		releaseSecond()
		await second
		await Promise.resolve()
		expect(settled).toEqual(['first', 'second'])
		await transport.close()
	})

	it('delivers sendStream messages in order through a deferred high-water-mark writable', async () => {
		const input = new PassThrough()
		const chunks: string[] = []
		const releases: Array<() => void> = []
		const output = new Writable({
			highWaterMark: 1,
			write(chunk, _encoding, callback) {
				chunks.push(chunk.toString())
				releases.push(() => callback())
			},
		})
		const transport = new StdioServerTransport(input, output)
		const notification: JSONRPCNotification = {
			jsonrpc: '2.0',
			method: 'notifications/progress',
		}
		const response: JSONRPCResponse = { jsonrpc: '2.0', id: 1, result: { done: true } }
		const closure = new AbortController()
		const stream = new MCPTextStreamController(
			new MCPStreamController(responseStream(notification, response), closure.signal, closure),
		)
		await transport.start()

		const pump = sendStream(stream, createDuplexServerTransport(transport))
		await waitForDelay()
		expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([notification])
		const releaseNotification = releases.shift()
		if (releaseNotification === undefined) {
			throw new Error('stream notification was not awaiting completion')
		}
		releaseNotification()
		await waitForDelay()
		expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([notification, response])

		const releaseResponse = releases.shift()
		if (releaseResponse === undefined)
			throw new Error('stream response was not awaiting completion')
		releaseResponse()
		await pump
		expect(closure.signal.aborted).toBe(true)
		await transport.close()
	})
})

describe('StdioServerTransport — lifecycle', () => {
	it('surfaces an output error on the domain emitter and remains alive', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		const failure = new Error('output failed')
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()

		output.emit('error', failure)

		expect(errors).toEqual([failure])
		await transport.close()
	})

	it('close restores listeners on both caller-owned streams and rejects a pending send', async () => {
		const input = new PassThrough()
		const releases: Array<() => void> = []
		const output = new Writable({
			highWaterMark: 1,
			write(_chunk, _encoding, callback) {
				releases.push(() => callback())
			},
		})
		input.on('error', () => {})
		output.on('error', () => {})
		const inputErrors = input.listenerCount('error')
		const outputErrors = output.listenerCount('error')
		const transport = new StdioServerTransport(input, output)
		await transport.start()
		expect(input.listenerCount('error')).toBe(inputErrors + 1)
		expect(output.listenerCount('error')).toBe(outputErrors + 1)

		const pending = transport.send({ jsonrpc: '2.0', id: 1, result: {} })
		void pending.catch(() => {})
		await Promise.resolve()
		await transport.close()

		await expect(pending).rejects.toThrow('stdio transport is not connected')
		expect(input.listenerCount('error')).toBe(inputErrors)
		expect(output.listenerCount('error')).toBe(outputErrors)
		expect(input.destroyed).toBe(false)
		expect(output.destroyed).toBe(false)
		const release = releases.shift()
		if (release === undefined) throw new Error('pending write was not awaiting completion')
		release()
	})

	it('rejects send after close as not connected', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		await transport.start()
		await transport.close()

		await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow(
			'stdio transport is not connected',
		)
	})

	it('leaves a previously unread input non-flowing after close', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		expect(input.readableFlowing).toBeNull()
		const transport = new StdioServerTransport(input, output)
		await transport.start()

		expect(input.readableFlowing).toBe(true)
		await transport.close()

		// Attaching `data` starts consumption, and Node exposes no public operation that restores
		// `readableFlowing` to `null`. The transport returns the stream to the non-flowing state.
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
