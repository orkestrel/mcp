import type { JSONRPCMessage } from '@src/core'
import { describe, expect, it } from 'vitest'
import { isRecord } from '@orkestrel/contract'
import { createJSONRPCRequest, waitForSettlement } from '../../../setup.js'
import { waitForDelay } from '@orkestrel/test'
import { StdioClientTransport } from '@src/server'

// src/server/transports/StdioClientTransport.ts — the stdio CLIENT transport, driven END TO
// END against a REAL spawned child process (a tiny inline `node -e` script standing in for a
// stdio MCP server, a real process, not a mock). The child reads
// newline-delimited JSON-RPC lines off its stdin and echoes a canned reply per method: `ping`
// → a result envelope, `boom` → a deliberately malformed (non-JSON) line, anything else → no
// reply (a notification-shaped silence). Proves: `start()` spawns the child; a reply line
// becomes the parsed `message` event; a malformed reply line surfaces `error` and is dropped
// (never throws); `send` writes one newline-terminated line per message to the child's stdin and
// settles only on the host's answer, so a line the channel never delivered REJECTS instead of
// resolving; `close()` kills the child and fires `close` (idempotent).

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

// A child that never reads its stdin and stays alive on a timer. A line larger than the host's
// pipe buffer therefore sits undelivered in the channel for as long as the child lives, which is
// what makes "did this write reach the host?" observable rather than a race.
const DEAF_CHILD_SCRIPT = `
setInterval(() => {}, 1000)
`

// The child reports a descendant pid and exits. The detached descendant inherits stdout, keeping
// the supervisor's line iterator outstanding after the child has gone.
const DESCENDANT_PIPE_SCRIPT = `
const { spawn } = require('node:child_process')
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
	detached: true,
	stdio: ['ignore', 'inherit', 'ignore'],
})
descendant.unref()
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'descendant', result: { pid: descendant.pid } }) + '\\n')
`

// Comfortably above both a Windows stdio pipe buffer and a 64 KiB POSIX one, so the write below
// cannot be swallowed whole by the host and answered before the child has read anything.
const UNREAD_PAYLOAD = 'x'.repeat(256 * 1024)

function spawnClient(): StdioClientTransport {
	return new StdioClientTransport({ command: process.execPath, args: ['-e', CHILD_SCRIPT] })
}

function spawnDeafClient(): StdioClientTransport {
	return new StdioClientTransport({ command: process.execPath, args: ['-e', DEAF_CHILD_SCRIPT] })
}

function spawnDescendantClient(): StdioClientTransport {
	return new StdioClientTransport({
		command: process.execPath,
		args: ['-e', DESCENDANT_PIPE_SCRIPT],
	})
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

	it('send() stays pending until the line reaches the host, and rejects when it never does', async () => {
		const transport = spawnDeafClient()
		await transport.start()

		// The child reads nothing, so this line cannot reach it. `send` must not resolve on a write
		// it only queued — the supervisor answers whether the host took the line, and that answer is
		// this promise's outcome.
		const write = transport.send(
			createJSONRPCRequest({ method: 'ping', id: 1, params: { payload: UNREAD_PAYLOAD } }),
		)
		let settled = false
		const outcome = write.then(
			() => (settled = true),
			() => (settled = true),
		)
		await waitForDelay(300)
		expect(settled).toBe(false)

		// Closing destroys the channel with the line still undelivered — a dead channel surfaces at
		// the caller instead of resolving as a delivered write.
		await transport.close()
		await outcome
		await expect(write).rejects.toThrow(/not connected/)
	})

	it('close() kills the child and fires the close event (idempotent)', async () => {
		const transport = spawnClient()
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		await waitForDelay(60)
		expect(closed).toBe(1)
		await transport.close()
		expect(closed).toBe(1)
	})

	it('close() settles while a descendant retains the child stdout pipe', async () => {
		const transport = spawnDescendantClient()
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		let pid: number | undefined
		try {
			await transport.start()
			const message = await waitForSettlement(
				arrived,
				5_000,
				'Timed out waiting for the descendant report',
			)
			if (!('result' in message) || !isRecord(message.result)) {
				throw new Error('The descendant report carries no result')
			}
			const value = message.result['pid']
			if (typeof value !== 'number') throw new Error('The descendant report carries no pid')
			pid = value

			await expect(
				waitForSettlement(
					transport.close(),
					1_000,
					'Timed out closing while the descendant retained stdout',
				),
			).resolves.toBeUndefined()
		} finally {
			await transport.close()
			if (pid !== undefined) {
				try {
					process.kill(pid)
				} catch {}
			}
		}
	})

	it('ignores the old child close after a new child has replaced it', async () => {
		const transport = spawnClient()
		const messages: JSONRPCMessage[] = []
		let closed = 0
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		await transport.start()
		await waitForDelay(60)

		expect(closed).toBe(1)
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 2 }))
		await waitForDelay(300)
		expect(messages).toEqual([{ jsonrpc: '2.0', id: 2, result: { pong: true } }])
		await transport.close()
	})

	it('the session is undefined for the stateless v1', async () => {
		const transport = spawnClient()
		expect(transport.session).toBeUndefined()
		await transport.start()
		await transport.close()
	})

	it('sequential sends write one line per message, each replied to independently', async () => {
		const transport = spawnClient()
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()

		await transport.send(createJSONRPCRequest({ method: 'ping', id: 1 }))
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 2 }))
		await waitForDelay(300)

		expect(messages).toEqual([
			{ jsonrpc: '2.0', id: 1, result: { pong: true } },
			{ jsonrpc: '2.0', id: 2, result: { pong: true } },
		])
		await transport.close()
	})
})
