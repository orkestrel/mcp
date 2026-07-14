import type { JSONRPCMessage } from '@src/core'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { StdioServerTransport } from '@src/server'
import { createJSONRPCRequest, waitForDelay } from '../../../setup.js'

// src/server/transports/StdioServerTransport.ts — the stdio SERVER bridge, driven END TO END
// over a REAL pair of injectable `node:stream` PassThroughs standing in for
// `process.stdin`/`process.stdout` (AGENTS §16 — real stream I/O, no mock). The test plays the
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

	it('writes one line per message for a batch send', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const { lines } = collectLines(output)
		const transport = new StdioServerTransport(input, output)
		await transport.start()

		const batch: readonly JSONRPCMessage[] = [
			{ jsonrpc: '2.0', id: 1, result: { a: 1 } },
			{ jsonrpc: '2.0', id: 2, result: { b: 2 } },
		]
		await transport.send(batch)
		await waitForDelay()

		expect(lines().map((line) => JSON.parse(line))).toEqual(batch)
		await transport.close()
	})
})

describe('StdioServerTransport — lifecycle', () => {
	it('close() fires the transport close event and is idempotent', async () => {
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
	})

	it('the input stream ending propagates to the transport close event', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		input.end()
		await waitForDelay()

		expect(closed).toBe(1)
	})

	it('the session is undefined for the stateless v1', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const transport = new StdioServerTransport(input, output)
		expect(transport.session).toBeUndefined()
		await transport.start()
		await transport.close()
	})

	it('isolates a throwing message listener — the bridge survives (§13)', async () => {
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
