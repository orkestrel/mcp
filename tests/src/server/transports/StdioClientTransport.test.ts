import type { JSONRPCMessage } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createJSONRPCRequest, waitForDelay } from '../../../setup.js'
import { StdioClientTransport } from '@src/server'

// src/server/transports/StdioClientTransport.ts — the stdio CLIENT transport, driven END TO
// END against a REAL spawned child process (a tiny inline `node -e` script standing in for a
// stdio MCP server — AGENTS §16, a real process, not a mock). The child reads
// newline-delimited JSON-RPC lines off its stdin and echoes a canned reply per method: `ping`
// → a result envelope, `boom` → a deliberately malformed (non-JSON) line, anything else → no
// reply (a notification-shaped silence). Proves: `start()` spawns the child; a reply line
// becomes the parsed `message` event; a malformed reply line surfaces `error` and is dropped
// (never throws); `send` writes one newline-terminated line per message to the child's stdin;
// `close()` kills the child and fires `close` (idempotent).

// A tiny newline-delimited JSON-RPC child: for each line, `ping` replies with a fixed result,
// `boom` replies with a deliberately malformed (non-JSON) line, anything else replies nothing.
const CHILD_SCRIPT = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
	let msg
	try {
		msg = JSON.parse(line)
	} catch {
		return
	}
	if (msg.method === 'ping') {
		process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pong: true } }) + '\\n')
	} else if (msg.method === 'boom') {
		process.stdout.write('{ not json\\n')
	}
})
`

function spawnClient(): StdioClientTransport {
	return new StdioClientTransport({ command: process.execPath, args: ['-e', CHILD_SCRIPT] })
}

describe('StdioClientTransport — drives a real child process over stdio', () => {
	it('start() spawns the child; a reply line becomes the parsed message event', async () => {
		const transport = spawnClient()
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()

		const request = createJSONRPCRequest({ method: 'ping', id: 1 })
		await transport.send(request)
		await waitForDelay(300)

		expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: { pong: true } }])
		await transport.close()
	})

	it('start() is idempotent (a second call does not respawn)', async () => {
		const transport = spawnClient()
		await transport.start()
		await transport.start()

		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 1 }))
		await waitForDelay(300)

		expect(messages).toHaveLength(1)
		await transport.close()
	})

	it('surfaces a malformed reply line on error and drops it — never throws', async () => {
		const transport = spawnClient()
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()

		await transport.send(createJSONRPCRequest({ method: 'boom', id: 1 }))
		await waitForDelay(300)

		expect(messages).toEqual([])
		expect(errors).toHaveLength(1)

		// The bridge is still alive — a well-formed exchange after the bad one still works.
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 2 }))
		await waitForDelay(300)
		expect(messages).toEqual([{ jsonrpc: '2.0', id: 2, result: { pong: true } }])
		await transport.close()
	})

	it('send() throws when the transport has not been started', async () => {
		const transport = spawnClient()
		await expect(transport.send(createJSONRPCRequest())).rejects.toThrow(/not connected/)
	})

	it('close() kills the child and fires the close event (idempotent)', async () => {
		const transport = spawnClient()
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		expect(closed).toBe(1)
		await transport.close()
		expect(closed).toBe(1)
	})

	it('the session is undefined for the stateless v1', async () => {
		const transport = spawnClient()
		expect(transport.session).toBeUndefined()
		await transport.start()
		await transport.close()
	})

	it('a batch send writes one line per message, each replied to independently', async () => {
		const transport = spawnClient()
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()

		await transport.send([
			createJSONRPCRequest({ method: 'ping', id: 1 }),
			createJSONRPCRequest({ method: 'ping', id: 2 }),
		])
		await waitForDelay(300)

		expect(messages).toEqual([
			{ jsonrpc: '2.0', id: 1, result: { pong: true } },
			{ jsonrpc: '2.0', id: 2, result: { pong: true } },
		])
		await transport.close()
	})
})
