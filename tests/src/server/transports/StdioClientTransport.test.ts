import type { JSONRPCMessage } from '@orkestrel/jsonrpc'
import { describe, expect, it } from 'vitest'
import { delimiter, join } from 'node:path'
import { PROCESS_DRAIN, PROCESS_EVIDENCE } from '@orkestrel/process'
import { MCPFixtureCell, createJSONRPCRequest, waitForSettlement } from '../../../setup.js'
import { requireValue, TIMER_LEAD, waitForCondition, waitForDelay } from '@orkestrel/test'
import { createScratch, destroyScratch, isRunning } from '@orkestrel/test/server'
import {
	createMCPClient,
	createMCPLegacyClientTransport,
	DEFAULT_MCP_REQUEST_TIMEOUT,
} from '@src/core'
import { DEFAULT_MCP_DELIVERY, MCP_STDIO_GRACE, StdioClientTransport } from '@src/server'
import {
	STDIO_CLOSE_SCRIPT,
	STDIO_FRAME_SCRIPT,
	DEAF_CHILD_SCRIPT,
	BURST_FIRST,
	BURST_SECOND,
	UNREAD_PAYLOAD,
	CLOSE_SLACK,
	spawnClient,
	spawnDeafClient,
	spawnDescendantClient,
	spawnBurstClient,
	EVIDENCE_SENTINEL,
	EVIDENCE_HEAD,
	EVIDENCE_TAIL,
	MULTIBYTE,
	MULTIBYTE_BYTES,
	UNEVEN,
	UNEVEN_BYTES,
	REPLACEMENT,
	HANDLED_SENTINEL,
	HANDLED_FILE,
	FORCED,
	ABSENT_COMMAND,
	EVIDENCE_CODE,
	DESCENDANT_EARLY,
	DESCENDANT_LATE,
	TRIGGER_FILE,
	DONE_FILE,
	EVIDENCE_DIRECTORY,
	spawnEvidenceClient,
	spawnResolvedEvidenceClient,
	spawnHandledEvidenceClient,
	spawnDescendantStderrClient,
	waitForStdioClose,
	waitForEvidence,
	readDescendantPid,
	collectEvidence,
} from '../../../setupServer.js'

describe('StdioClientTransport — EOF shutdown', () => {
	it('disconnect lets the server record input end and exit without termination', async () => {
		const scratch = createScratch()
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: ['-e', STDIO_CLOSE_SCRIPT],
			env: {
				MCP_CLOSE_PID: join(scratch.path, 'pid'),
				MCP_CLOSE_MARKER: join(scratch.path, 'ended'),
			},
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(transport) })
		try {
			await client.connect()
			const pid = Number(requireValue(scratch.read('pid')))
			expect(isRunning(pid)).toBe(true)
			expect(scratch.has('ended')).toBe(false)
			const opened = performance.now()
			await client.disconnect()
			expect(performance.now() - opened).toBeLessThan(MCP_STDIO_GRACE / 2)
			expect(scratch.read('ended')).toBe('completed')
			expect(isRunning(pid)).toBe(false)
			expect(client.connected).toBe(false)
		} finally {
			await client.disconnect()
			await transport.close()
			await destroyScratch(scratch)
		}
	})

	it('disconnect bounds a server that records input end but refuses to exit', async () => {
		const scratch = createScratch()
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: ['-e', STDIO_CLOSE_SCRIPT],
			env: {
				MCP_CLOSE_PID: join(scratch.path, 'pid'),
				MCP_CLOSE_MARKER: join(scratch.path, 'ended'),
				MCP_CLOSE_IGNORE: 'true',
			},
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(transport) })
		try {
			await client.connect()
			const pid = Number(requireValue(scratch.read('pid')))
			expect(isRunning(pid)).toBe(true)
			const opened = performance.now()
			await waitForSettlement(client.disconnect(), MCP_STDIO_GRACE * 1.5, 'EOF shutdown hung')
			expect(performance.now() - opened).toBeLessThan(MCP_STDIO_GRACE * 1.5)
			expect(performance.now() - opened).toBeGreaterThanOrEqual(MCP_STDIO_GRACE - TIMER_LEAD)
			expect(scratch.read('ended')).toBe('ended')
			expect(isRunning(pid)).toBe(false)
			expect(client.connected).toBe(false)
		} finally {
			await client.disconnect()
			await transport.close()
			await destroyScratch(scratch)
		}
	}, 15_000)
})

// src/server/transports/StdioClientTransport.ts — the stdio CLIENT transport, driven END TO
// END against a REAL spawned child process (a tiny inline `node -e` script standing in for a
// stdio MCP server, a real process, not a mock). The child reads
// newline-delimited JSON-RPC lines off its stdin and echoes a canned reply per method: `ping`
// → a result envelope, `boom` → a deliberately malformed (non-JSON) line, anything else → no
// reply (a notification-shaped silence). Proves: `start()` spawns the child; a reply line
// becomes the parsed `message` event; a malformed reply line surfaces `error` and is dropped
// (never throws); `send` writes one newline-terminated line per message to the child's stdin and
// settles only on the host's answer, so a line the channel never delivered REJECTS instead of
// resolving; `close()` ends the child and fires `close` (idempotent).

// A tiny newline-delimited JSON-RPC child: for each line, `ping` replies with a fixed result,
// `boom` replies with a deliberately malformed (non-JSON) line, anything else replies nothing.
describe('StdioClientTransport — drives a real child process over stdio', () => {
	it('preserves split UTF-8, CRLF, and a final unterminated reply', async () => {
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: ['-e', STDIO_FRAME_SCRIPT],
		})
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		const closed = waitForStdioClose(transport, 'the framing fixture exits')
		try {
			await transport.start()
			await closed
			expect(messages).toEqual([
				{ jsonrpc: '2.0', id: 1, result: { value: '雪' } },
				{ jsonrpc: '2.0', id: 2, result: { value: 'final' } },
			])
		} finally {
			await transport.close()
		}
	})

	it('keeps the default delivery bound below the request deadline', () => {
		expect(DEFAULT_MCP_DELIVERY).toBeLessThan(DEFAULT_MCP_REQUEST_TIMEOUT)
	})

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
		await expect(transport.send(createJSONRPCRequest())).rejects.toThrow(
			/^stdio transport is not connected$/,
		)
	})

	it('rejects an unconfirmed write at the delivery bound while the child stays alive', async () => {
		// This is far above real pipe-accept latency while remaining short enough for the suite.
		const delivery = 100
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: ['-e', DEAF_CHILD_SCRIPT],
			delivery,
		})
		const ready = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const errors: unknown[] = []
		const closes = new MCPFixtureCell(0)
		transport.emitter.on('error', (error) => errors.push(error))
		transport.emitter.on('close', () => (closes.value += 1))
		try {
			await transport.start()
			const pid = readDescendantPid(
				await waitForSettlement(ready, 5_000, 'Timed out waiting for the deaf child readiness'),
			)
			const opened = performance.now()

			await expect(
				transport.send(
					createJSONRPCRequest({ method: 'ping', id: 1, params: { payload: UNREAD_PAYLOAD } }),
				),
			).rejects.toThrow(/^stdio transport could not deliver the message$/)
			const elapsed = performance.now() - opened

			expect(isRunning(pid)).toBe(true)
			expect(errors).toEqual([])
			expect(closes.value).toBe(0)
			expect(elapsed).toBeGreaterThanOrEqual(delivery - TIMER_LEAD)
		} finally {
			await transport.close()
		}
	}, 10_000)

	it('uses the default delivery bound when delivery is omitted', async () => {
		// This test spends the real 10 s bound; that duration is the price of pinning the default.
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: ['-e', DEAF_CHILD_SCRIPT],
		})
		const ready = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		try {
			await transport.start()
			const pid = readDescendantPid(
				await waitForSettlement(ready, 5_000, 'Timed out waiting for the deaf child readiness'),
			)
			const opened = performance.now()

			await expect(
				transport.send(
					createJSONRPCRequest({ method: 'ping', id: 1, params: { payload: UNREAD_PAYLOAD } }),
				),
			).rejects.toThrow(/^stdio transport could not deliver the message$/)
			const elapsed = performance.now() - opened

			expect(isRunning(pid)).toBe(true)
			expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_MCP_DELIVERY - TIMER_LEAD)
		} finally {
			await transport.close()
		}
	}, 20_000)

	it('send() stays pending until the line reaches the host, and rejects when it never does', async () => {
		const transport = spawnDeafClient()
		await transport.start()

		// The child reads nothing, so this line cannot reach it. `send` must not resolve on a write
		// it only queued — the supervisor answers whether the host took the line, and that answer is
		// this promise's outcome.
		const write = transport.send(
			createJSONRPCRequest({ method: 'ping', id: 1, params: { payload: UNREAD_PAYLOAD } }),
		)
		const settled = new MCPFixtureCell(false)
		const outcome = write.then(
			() => (settled.value = true),
			() => (settled.value = true),
		)
		await waitForDelay(300)
		expect(settled.value).toBe(false)

		// Closing destroys the channel with the line still undelivered — a dead channel surfaces at
		// the caller instead of resolving as a delivered write.
		await transport.close()
		await outcome
		await expect(write).rejects.toThrow(/^stdio transport could not deliver the message$/)
	})

	it('close() ends the child and fires the close event (idempotent)', async () => {
		const transport = spawnClient()
		const closed = new MCPFixtureCell(0)
		transport.emitter.on('close', () => (closed.value += 1))
		await transport.start()

		await transport.close()
		await waitForDelay(60)
		expect(closed.value).toBe(1)
		await transport.close()
		expect(closed.value).toBe(1)
	})

	it('close() settles inside the supervisor drain bound while a descendant retains the child stdout pipe', async () => {
		const transport = spawnDescendantClient()
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const pid = new MCPFixtureCell<number | undefined>(undefined)
		try {
			await transport.start()
			pid.value = readDescendantPid(
				await waitForSettlement(arrived, 5_000, 'Timed out waiting for the descendant report'),
			)

			// The child has exited and the detached descendant holds its inherited stdout open, so
			// those read ends never close on their own and the descendant outlives this whole test.
			// What ends the observation is the supervisor's own `drain` bound, and this `close()`
			// settles inside it rather than on the descendant.
			await expect(
				waitForSettlement(
					transport.close(),
					PROCESS_DRAIN + CLOSE_SLACK,
					'Timed out closing while the descendant retained stdout',
				),
			).resolves.toBeUndefined()
		} finally {
			await transport.close()
			if (pid.value !== undefined) {
				try {
					process.kill(pid.value)
				} catch {}
			}
		}
	})

	it('ignores the old child close after a new child has replaced it', async () => {
		const transport = spawnClient()
		const messages: JSONRPCMessage[] = []
		const closed = new MCPFixtureCell(0)
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('close', () => (closed.value += 1))
		await transport.start()

		await transport.close()
		await transport.start()
		await waitForDelay(60)

		expect(closed.value).toBe(1)
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 2 }))
		await waitForDelay(300)
		expect(messages).toEqual([{ jsonrpc: '2.0', id: 2, result: { pong: true } }])
		await transport.close()
	})

	it('emits nothing more after a message listener closed the transport', async () => {
		const transport = spawnBurstClient()
		const messages: JSONRPCMessage[] = []
		const closing = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		transport.emitter.on('message', (message) => {
			messages.push(message)
			closing.value ??= transport.close()
		})
		await transport.start()
		await transport.send(createJSONRPCRequest({ method: 'burst', id: 1 }))
		await waitForCondition(
			'the first of the two framed lines reaches the message listener',
			() => closing.value !== undefined,
			{ budget: 10_000 },
		)

		// Teardown began inside the first delivery. The reader still holds the remaining line from
		// that chunk, so the transport's closed state must stop its delivery before the stream ends.
		await requireValue(closing.value)
		await waitForDelay(300)

		expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: { burst: BURST_FIRST } }])
	})

	it('CONTROL — both framed lines arrive when no listener closes the transport', async () => {
		const transport = spawnBurstClient()
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()
		await transport.send(createJSONRPCRequest({ method: 'burst', id: 1 }))
		await waitForCondition(
			'both framed lines reach the message listener',
			() => messages.length >= 2,
			{ budget: 10_000 },
		)

		expect(messages).toEqual([
			{ jsonrpc: '2.0', id: 1, result: { burst: BURST_FIRST } },
			{ jsonrpc: '2.0', id: 2, result: { burst: BURST_SECOND } },
		])
		await transport.close()
	})

	it('joins the predecessor teardown while a replacement is waiting to open', async () => {
		const transport = spawnClient()
		const closes = new MCPFixtureCell(0)
		transport.emitter.on('close', () => (closes.value += 1))
		try {
			await transport.start()
			const tearing = transport.close()
			const opening = transport.start()
			const joining = transport.close()

			await opening
			expect(closes.value).toBe(1)
			await joining
			await tearing
			expect(closes.value).toBe(1)

			await transport.close()
			expect(closes.value).toBe(2)
		} finally {
			await transport.close()
		}
	})

	it('joins two starts during teardown into one writable replacement', async () => {
		const transport = spawnClient()
		const closes = new MCPFixtureCell(0)
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('close', () => (closes.value += 1))
		transport.emitter.on('message', (message) => messages.push(message))
		try {
			await transport.start()
			const tearing = transport.close()
			const opening = transport.start()
			const joining = transport.start()
			await Promise.all([tearing, opening, joining])

			expect(closes.value).toBe(1)
			await transport.send(createJSONRPCRequest({ method: 'ping', id: 1 }))
			await waitForCondition('the replacement answers the request', () => messages.length > 0)
			expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: { pong: true } }])

			await transport.close()
			expect(closes.value).toBe(2)
		} finally {
			await transport.close()
		}
	})

	it('emits close once before any start and permits a later start', async () => {
		const transport = spawnClient()
		const closes = new MCPFixtureCell(0)
		transport.emitter.on('close', () => (closes.value += 1))
		try {
			await transport.close()
			await transport.close()

			expect(closes.value).toBe(1)
			expect(transport.evidence).toBeUndefined()
			await expect(transport.send(createJSONRPCRequest())).rejects.toThrow(
				/^stdio transport is not connected$/,
			)

			await transport.start()
			await transport.send(createJSONRPCRequest({ method: 'ping', id: 1 }))
			await transport.close()
			expect(closes.value).toBe(2)
		} finally {
			await transport.close()
		}
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

// ── The retained stderr tail (`evidence`) ────────────────────────────────────
//
// `StdioClientTransportInterface.evidence` reports the supervised child's decoded stderr tail.
// Every reading below comes from a REAL child writing to its own real `stderr`, and every case
// carries the negative control that makes the reading evidence rather than a restatement of the
// getter: an assertion that `evidence` is absent means nothing beside a reading that is present,
// and an assertion that a tail survives means nothing beside a reading where it does not.
//
// The host facts below decide how these tests wait and what they can assert:
//
// - `Supervisor` freezes `evidence` and settles `exit` at its terminal moment, after the child's
//   stdio streams close or the drain bound expires. Its close and teardown callbacks close the
//   readline reader; stdout end can close that reader earlier. `ProcessExit.drained` distinguishes
//   stream close from the cutoff, so a tail read after the transport's `close` event is frozen,
//   but can be incomplete when a descendant keeps a pipe open.
// - `Supervisor.destroy()` resolves past that moment, so the tail this transport reports off the held
//   child is already frozen when `close()` returns. A descendant holding the inherited `stderr`
//   cannot hold that barrier open beyond `drain`, and a tail cut off there is the reading
//   `drained: false` names.
// - Windows ends a child tree with `taskkill /F /T`, which no `SIGTERM` handler can intercept, so
//   the close path there carries only what the child had already written. A POSIX host signals
//   `SIGTERM` and waits out the grace window instead, and that window is unmeasured here.
// - A live read is asynchronous with the child's write, so a test that needs written bytes waits
//   for the named condition inside a `performance.now()` budget rather than for a fixed delay.

/** The bytes an evidence child writes to its own `stderr`. */
describe('StdioClientTransport — the retained stderr tail', () => {
	it('reads undefined before start(), because no child has run', async () => {
		const transport = spawnEvidenceClient({ wait: true })
		expect(transport.evidence).toBeUndefined()
		await transport.close()
	})

	it('CONTROL — a started child that has written nothing reads an empty tail, not undefined', async () => {
		const transport = spawnEvidenceClient({ wait: true })
		try {
			await transport.start()
			expect(transport.evidence).toBe('')
		} finally {
			await transport.close()
		}
	})

	it('reads the stderr a failing child wrote, after that child ends on its own', async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL, code: EVIDENCE_CODE })
		const closed = waitForStdioClose(transport, 'the failing child close event')
		await transport.start()
		await closed

		expect(transport.evidence).toBe(EVIDENCE_SENTINEL)
		await transport.close()
	})

	it('CONTROL — a failing child that wrote nothing reads an empty tail, not the sentinel', async () => {
		const transport = spawnEvidenceClient({ code: EVIDENCE_CODE })
		const closed = waitForStdioClose(transport, 'the silent failing child close event')
		await transport.start()
		await closed

		expect(transport.evidence).toBe('')
		await transport.close()
	})

	it("close() on a live child retains that child's tail", async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL, wait: true })
		await transport.start()
		await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
		await waitForEvidence(transport, EVIDENCE_SENTINEL)

		// The child is alive and the tail is live here. `close()` ends its input, letting it exit;
		// the reading afterwards is the value frozen at the supervisor's terminal moment.
		await transport.close()

		expect(transport.evidence).toBe(EVIDENCE_SENTINEL)
	})

	it('carries what a child wrote before close(), whatever its termination window adds', async () => {
		const scratch = createScratch()
		const transport = spawnHandledEvidenceClient(scratch)
		try {
			await transport.start()
			await waitForEvidence(transport, EVIDENCE_SENTINEL)

			// The child holds a `SIGTERM` handler that would write more, so this reading is what the
			// supervisor had received at the terminal moment rather than everything the child could
			// still have produced. That much holds on every host.
			await transport.close()

			expect(transport.evidence).toContain(EVIDENCE_SENTINEL)
		} finally {
			await transport.close()
			await destroyScratch(scratch)
		}
	}, 30_000)

	// What the termination window itself contributes to the tail is a host fact, so the reading
	// belongs to the host that produces it. Windows ends the tree with `taskkill /F /T`, which the
	// child cannot intercept. A cooperative host signals `SIGTERM` and waits out the grace window
	// instead; nothing here has measured that window, and this suite claims nothing about it.
	it.runIf(FORCED)(
		'runs no child SIGTERM handler at all on a host that ends the tree by force',
		async () => {
			const scratch = createScratch()
			const transport = spawnHandledEvidenceClient(scratch)
			try {
				await transport.start()
				await waitForEvidence(transport, EVIDENCE_SENTINEL)

				await transport.close()

				// The handler never ran, so neither the scratch file it writes nor the bytes it writes
				// to `stderr` exist. The scratch reading is what separates "the handler ran and its
				// bytes were lost" from "the host never delivered the signal".
				expect(scratch.has(HANDLED_FILE)).toBe(false)
				expect(transport.evidence).not.toContain(HANDLED_SENTINEL)
			} finally {
				await transport.close()
				await destroyScratch(scratch)
			}
		},
		30_000,
	)

	it('CONTROL — a transport closed without ever starting reads undefined, not an empty tail', async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL, wait: true })
		await transport.close()

		expect(transport.evidence).toBeUndefined()
	})

	it('gives the close listener and every later read the same tail', async () => {
		const transport = spawnEvidenceClient({
			payload: EVIDENCE_SENTINEL,
			code: EVIDENCE_CODE,
			wait: true,
		})
		const seen = new MCPFixtureCell<string | undefined>(undefined)
		const fired = new MCPFixtureCell(false)
		transport.emitter.on('close', () => {
			seen.value = transport.evidence
			fired.value = true
		})
		await transport.start()

		// CONTROL — the same read taken before the child writes carries no sentinel at all, so the
		// readings below report the write rather than the getter's constant.
		expect(transport.evidence).toBe('')

		await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
		await waitForEvidence(transport, EVIDENCE_SENTINEL)
		await transport.close()

		expect(fired.value).toBe(true)
		expect(seen.value).toBe(EVIDENCE_SENTINEL)
		expect(transport.evidence).toBe(EVIDENCE_SENTINEL)
	})

	it("start() clears the previous child's retained tail", async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL, wait: true })
		try {
			await transport.start()
			await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
			await waitForEvidence(transport, EVIDENCE_SENTINEL)
			await transport.close()
			expect(transport.evidence).toBe(EVIDENCE_SENTINEL)

			// The replacement child has written nothing, so the lifetime it opens reads empty rather
			// than reporting its predecessor's stderr as current.
			await transport.start()
			expect(transport.evidence).toBe('')

			// And the reading after that silent replacement ENDS is still its own empty tail. An
			// implementation that kept the predecessor's tail whenever a replacement captured
			// nothing satisfies the live reading above and reports the predecessor here.
			await transport.close()
			expect(transport.evidence).toBe('')
		} finally {
			await transport.close()
		}
	})

	it('CONTROL — without that second start() the previous tail stays readable', async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL, wait: true })
		await transport.start()
		await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
		await waitForEvidence(transport, EVIDENCE_SENTINEL)
		await transport.close()

		expect(transport.evidence).toBe(EVIDENCE_SENTINEL)
	})

	it('holds every close listener to the captured tail when the close was explicit', async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL, wait: true })
		const early = new MCPFixtureCell<string | undefined>(undefined)
		const late = new MCPFixtureCell<string | undefined>(undefined)
		const read = new MCPFixtureCell(false)
		const restarting = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		transport.emitter.on('close', () => {
			if (!read.value) early.value = transport.evidence
		})
		transport.emitter.on('close', () => {
			// An explicit teardown still holds its barrier while these listeners run, so this
			// `start()` parks behind it instead of opening the next lifetime inside the emit.
			restarting.value ??= transport.start()
		})
		transport.emitter.on('close', () => {
			if (read.value) return
			late.value = transport.evidence
			read.value = true
		})
		try {
			await transport.start()
			await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
			await waitForEvidence(transport, EVIDENCE_SENTINEL)

			await transport.close()

			// The listener AFTER the one that restarted reads what the listener before it read: the
			// replacement cannot open until every listener has returned.
			expect(early.value).toBe(EVIDENCE_SENTINEL)
			expect(late.value).toBe(EVIDENCE_SENTINEL)
		} finally {
			await requireValue(restarting.value)
			await transport.close()
		}
	}, 30_000)

	it('CONTROL — a natural exit lets a listener clear that tail before the later listeners read', async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL, code: EVIDENCE_CODE })
		const early = new MCPFixtureCell<string | undefined>(undefined)
		const late = new MCPFixtureCell<string | undefined>(undefined)
		const read = new MCPFixtureCell(false)
		const restarting = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		transport.emitter.on('close', () => {
			if (!read.value) early.value = transport.evidence
		})
		transport.emitter.on('close', () => {
			// The exit bridge holds no barrier, so this `start()` runs to its spawn INSIDE the emit
			// and the tail it clears is already gone when the listener after it reads.
			restarting.value ??= transport.start()
		})
		transport.emitter.on('close', () => {
			if (read.value) return
			late.value = transport.evidence
			read.value = true
		})
		try {
			await transport.start()
			await waitForCondition(
				'the failing child ends and its close listeners run',
				() => read.value,
				{ budget: 10_000 },
			)

			// The tail the earlier listener read is the ended child's own, and the later listener reads
			// the replacement's empty live tail instead.
			expect(early.value).toBe(EVIDENCE_SENTINEL)
			expect(late.value).toBe('')
		} finally {
			await requireValue(restarting.value)
			await transport.close()
		}
	}, 30_000)

	it('delivers an ended lifetime close before a restart its own error listener began', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const restarting = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		const captured = new MCPFixtureCell<string | undefined>(undefined)
		const ended = new MCPFixtureCell(false)
		transport.emitter.on('error', () => {
			// The drain-bound notice is emitted from INSIDE the natural exit's own report, BEFORE
			// that exit has fired `close`. A restart begun here must not open the next lifetime over
			// the tail the `close` listeners are about to read.
			restarting.value ??= transport.start()
		})
		transport.emitter.on('close', () => {
			captured.value ??= transport.evidence
			ended.value = true
		})
		const pid = new MCPFixtureCell<number | undefined>(undefined)
		try {
			await transport.start()
			pid.value = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			// CONTROL — the ended child's own tail is present before its exit reports, so the reading
			// below excludes a replacement rather than a value this lifetime never carried.
			await waitForEvidence(transport, DESCENDANT_EARLY)

			await waitForCondition('the ended child fires its close', () => ended.value, {
				budget: 10_000,
			})

			// The `close` for the ended lifetime reached its listener while that lifetime's child was
			// still the held one. A replacement installed inside the report would have read its own
			// empty live tail here instead.
			expect(captured.value).toContain(DESCENDANT_EARLY)
		} finally {
			if (restarting.value !== undefined) await restarting.value
			await transport.close()
			if (pid.value !== undefined && isRunning(pid.value)) process.kill(pid.value)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('CONTROL — a restart the same exit close listener began still opens inside that emit', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const early = new MCPFixtureCell<string | undefined>(undefined)
		const late = new MCPFixtureCell<string | undefined>(undefined)
		const read = new MCPFixtureCell(false)
		const restarting = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		transport.emitter.on('close', () => {
			if (!read.value) early.value = transport.evidence
		})
		transport.emitter.on('close', () => {
			// The barrier the report held is released before this emit, so this `start()` runs to its
			// spawn INSIDE the emit rather than parking behind the ended lifetime.
			restarting.value ??= transport.start()
		})
		transport.emitter.on('close', () => {
			if (read.value) return
			late.value = transport.evidence
			read.value = true
		})
		const pid = new MCPFixtureCell<number | undefined>(undefined)
		try {
			await transport.start()
			pid.value = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			await waitForEvidence(transport, DESCENDANT_EARLY)

			await waitForCondition('the ended child fires its close', () => read.value, {
				budget: 10_000,
			})

			// The same exit that defers an error listener's restart still lets a `close` listener's
			// restart replace the tail every listener after it reads.
			expect(early.value).toContain(DESCENDANT_EARLY)
			expect(late.value).toBe('')
		} finally {
			if (restarting.value !== undefined) await restarting.value
			await transport.close()
			if (pid.value !== undefined && isRunning(pid.value)) process.kill(pid.value)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('opens that restart inside the emit though an earlier close listener called close()', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const joining = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		const restarting = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		const late = new MCPFixtureCell<string | undefined>(undefined)
		const read = new MCPFixtureCell(false)
		transport.emitter.on('close', () => {
			// The ended lifetime reached its terminal moment before this emit, so this `close()` has
			// nothing to tear down and must leave NO barrier behind. A resolved no-op barrier parks
			// the `start()` below on the microtask queue, and the replacement then opens after this
			// emit rather than inside it.
			joining.value ??= transport.close()
		})
		transport.emitter.on('close', () => {
			restarting.value ??= transport.start()
		})
		transport.emitter.on('close', () => {
			if (read.value) return
			late.value = transport.evidence
			read.value = true
		})
		const pid = new MCPFixtureCell<number | undefined>(undefined)
		try {
			await transport.start()
			pid.value = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			// CONTROL — the ended child's own tail is present before its exit reports, so the reading
			// below excludes a replacement rather than a value this lifetime never carried.
			await waitForEvidence(transport, DESCENDANT_EARLY)

			await waitForCondition('the ended child fires its close', () => read.value, {
				budget: 10_000,
			})

			// The replacement opened INSIDE the emit despite the earlier `close()`, so the listener
			// after it reads the replacement's own empty live tail rather than the ended child's.
			expect(late.value).toBe('')
		} finally {
			await requireValue(joining.value)
			await requireValue(restarting.value)
			await transport.close()
			if (pid.value !== undefined && isRunning(pid.value)) process.kill(pid.value)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('leaves the replacement an error listener began closable behind a close listener close()', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const restarting = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		const joining = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		const ends = new MCPFixtureCell(0)
		transport.emitter.on('error', () => {
			restarting.value ??= transport.start()
		})
		transport.emitter.on('close', () => {
			ends.value += 1
			// This `close()` lands in the gap between the report's barrier and the replacement the
			// parked `start()` above has not installed yet. The lifetime is closed and no barrier is
			// assigned, so it returns directly and leaves nothing behind — a barrier left here would
			// become the answer a LATER `close()` resolves through, over a live replacement it then
			// never tears down.
			joining.value ??= transport.close()
		})
		const pid = new MCPFixtureCell<number | undefined>(undefined)
		try {
			await transport.start()
			pid.value = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			await waitForEvidence(transport, DESCENDANT_EARLY)

			await waitForCondition('the ended child fires its close', () => ends.value >= 1, {
				budget: 10_000,
			})
			await requireValue(restarting.value)
			await requireValue(joining.value)

			// The replacement is a live child, so this close runs a real teardown and reports it.
			await transport.close()
			expect(ends.value).toBe(2)
		} finally {
			await transport.close()
			if (pid.value !== undefined && isRunning(pid.value)) process.kill(pid.value)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it("never reports a closing lifetime's tail after the replacement lifetime ended", async () => {
		const scratch = createScratch()
		const inherited = requireValue(process.env['PATH'])
		const transport = spawnResolvedEvidenceClient()
		const errors: unknown[] = []
		const ends = new MCPFixtureCell(0)
		transport.emitter.on('error', (error) => errors.push(error))
		transport.emitter.on('close', () => (ends.value += 1))
		try {
			process.env['PATH'] = `${EVIDENCE_DIRECTORY}${delimiter}${inherited}`
			await transport.start()
			await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
			await waitForEvidence(transport, EVIDENCE_SENTINEL)

			// The interleaving. `start()` is called while the first lifetime's teardown is still
			// running, and `PATH` no longer resolves the command, so the replacement is a spawn the
			// host refuses: it ends in about 17ms, well inside the roughly 102ms a Windows teardown
			// spends ending the tree through `taskkill` (both measured on this host, 2026-08-21).
			// The replacement is therefore installed and already ended BEFORE the ended lifetime's
			// teardown resumes, which is the order that lets a stale tail arrive last.
			process.env['PATH'] = scratch.path
			const closing = transport.close()
			const restarting = transport.start()
			await Promise.all([closing, restarting])
			process.env['PATH'] = inherited
			await waitForCondition('the closing and replacement lifetimes end', () => ends.value >= 2, {
				budget: 10_000,
			})

			// The reading belongs to the replacement, which ran and wrote nothing. The superseded
			// lifetime's own tail must not arrive over it.
			expect(errors).toHaveLength(1)
			expect(transport.evidence).toBe('')
		} finally {
			process.env['PATH'] = inherited
			await transport.close()
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('CONTROL — the same replacement opened after that close resolved reads the same empty tail', async () => {
		const scratch = createScratch()
		const inherited = requireValue(process.env['PATH'])
		const transport = spawnResolvedEvidenceClient()
		const errors: unknown[] = []
		const ends = new MCPFixtureCell(0)
		transport.emitter.on('error', (error) => errors.push(error))
		transport.emitter.on('close', () => (ends.value += 1))
		try {
			process.env['PATH'] = `${EVIDENCE_DIRECTORY}${delimiter}${inherited}`
			await transport.start()
			await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
			await waitForEvidence(transport, EVIDENCE_SENTINEL)
			await transport.close()

			// The superseded tail IS readable when nothing replaces it, so its absence after the
			// replacement below is an exclusion rather than a value this sequence never carried.
			expect(transport.evidence).toBe(EVIDENCE_SENTINEL)

			process.env['PATH'] = scratch.path
			await transport.start()
			await waitForCondition('the replacement lifetime ends', () => ends.value >= 2, {
				budget: 10_000,
			})
			process.env['PATH'] = inherited

			expect(errors).toHaveLength(1)
			expect(transport.evidence).toBe('')
		} finally {
			process.env['PATH'] = inherited
			await transport.close()
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('keeps the end of a stderr run longer than the byte bound and drops its start', async () => {
		const transport = spawnEvidenceClient({
			payload: EVIDENCE_HEAD + 'x'.repeat(PROCESS_EVIDENCE) + EVIDENCE_TAIL,
		})
		const closed = waitForStdioClose(transport, 'the overflowing child close event')
		await transport.start()
		await closed

		const tail = requireValue(transport.evidence)
		expect(Buffer.byteLength(tail, 'utf8')).toBe(PROCESS_EVIDENCE)
		expect(tail).toContain(EVIDENCE_TAIL)
		expect(tail).not.toContain(EVIDENCE_HEAD)
		await transport.close()
	})

	it('bounds the tail by raw bytes rather than by characters', async () => {
		expect(MULTIBYTE_BYTES).toBeGreaterThan(1)
		expect(PROCESS_EVIDENCE % MULTIBYTE_BYTES).toBe(0)
		const characters = PROCESS_EVIDENCE / MULTIBYTE_BYTES
		const transport = spawnEvidenceClient({ payload: MULTIBYTE.repeat(PROCESS_EVIDENCE) })
		const closed = waitForStdioClose(transport, 'the multibyte child close event')
		await transport.start()
		await closed

		const tail = requireValue(transport.evidence)
		// The byte window is full while the character count is a fraction of it, so the bound counts
		// the encoded bytes and not the decoded characters.
		expect(Buffer.byteLength(tail, 'utf8')).toBe(PROCESS_EVIDENCE)
		expect(tail).toBe(MULTIBYTE.repeat(characters))
		expect(tail.length).toBe(characters)
		expect(tail.length).not.toBe(PROCESS_EVIDENCE)
		await transport.close()
	})

	it('never begins the tail inside a character whose width the bound does not divide', async () => {
		expect(PROCESS_EVIDENCE % UNEVEN_BYTES).not.toBe(0)
		const characters = (PROCESS_EVIDENCE - (PROCESS_EVIDENCE % UNEVEN_BYTES)) / UNEVEN_BYTES
		const transport = spawnEvidenceClient({ payload: UNEVEN.repeat(PROCESS_EVIDENCE) })
		const closed = waitForStdioClose(transport, 'the uneven multibyte child close event')
		await transport.start()
		await closed

		const tail = requireValue(transport.evidence)
		// A raw byte window would begin on a continuation byte here. Its decoded output would open
		// with a replacement character and encode to MORE bytes than the bound it claims to keep,
		// so the retained tail retreats to the start of the character the cut landed inside.
		expect(tail).toBe(UNEVEN.repeat(characters))
		expect(tail).not.toContain(REPLACEMENT)
		expect(Buffer.byteLength(tail, 'utf8')).toBe(characters * UNEVEN_BYTES)
		expect(Buffer.byteLength(tail, 'utf8')).toBeLessThan(PROCESS_EVIDENCE)
		await transport.close()
	})

	it('reads an empty tail for a spawn the host refuses, and surfaces its cause on error', async () => {
		const transport = new StdioClientTransport({ command: ABSENT_COMMAND })
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))
		try {
			await transport.start()
			await waitForCondition(
				'the refused spawn surfaces its cause on the error event',
				() => errors.length > 0,
				{ budget: 10_000 },
			)

			// The lifetime produced no child and therefore no stderr — an empty tail rather than an
			// absent one, with the reason on the event this transport reserves for a fault.
			expect(transport.evidence).toBe('')
			expect(errors).toHaveLength(1)
		} finally {
			await transport.close()
		}
	})

	it('CONTROL — a resolvable command that writes stderr yields a non-empty tail', async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL })
		const closed = waitForStdioClose(transport, 'the resolvable child close event')
		await transport.start()
		await closed

		expect(transport.evidence).not.toBe('')
		expect(transport.evidence).toBe(EVIDENCE_SENTINEL)
		await transport.close()
	})

	it("leaves the live lifetime's tail alone when a superseded child exits late", async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const closes = new MCPFixtureCell(0)
		transport.emitter.on('close', () => (closes.value += 1))
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const pid = new MCPFixtureCell<number | undefined>(undefined)
		try {
			await transport.start()
			pid.value = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			await waitForEvidence(transport, DESCENDANT_EARLY)

			// The child has ended and its tail is frozen, because the descendant holding that child's
			// `stderr` kept the streams open until the supervisor's `drain` bound cut them off.
			await transport.close()
			expect(transport.evidence).toContain(DESCENDANT_EARLY)

			// A replacement lifetime opens. That child finds the claim file the first one wrote, so it
			// spawns nothing and writes nothing: every marker read from here belongs to the superseded
			// lifetime. Releasing the descendant then closes the superseded child's last pipe, which
			// is what finally settles that child's exit.
			await transport.start()
			expect(transport.evidence).toBe('')
			scratch.write(TRIGGER_FILE, '')
			await waitForCondition(
				'the descendant reports its late stderr write',
				() => scratch.has(DONE_FILE),
				{ budget: 15_000 },
			)
			await waitForCondition(
				'the descendant holding the superseded child stderr has exited',
				() => !isRunning(requireValue(pid.value)),
				{ budget: 15_000 },
			)

			// Every reading taken after that exit landed is the live lifetime's empty tail, and the
			// superseded child's own end fired no second close.
			expect(await collectEvidence(transport)).toEqual([''])
			expect(closes.value).toBe(1)
		} finally {
			await transport.close()
			if (pid.value !== undefined && isRunning(pid.value)) process.kill(pid.value)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('CONTROL — the same late exit with no replacement leaves the captured tail in place', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const pid = new MCPFixtureCell<number | undefined>(undefined)
		try {
			await transport.start()
			pid.value = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			await waitForEvidence(transport, DESCENDANT_EARLY)
			await transport.close()
			const captured = transport.evidence

			scratch.write(TRIGGER_FILE, '')
			await waitForCondition(
				'the descendant reports its late stderr write',
				() => scratch.has(DONE_FILE),
				{ budget: 15_000 },
			)
			await waitForCondition(
				'the descendant holding the closed child stderr has exited',
				() => !isRunning(requireValue(pid.value)),
				{ budget: 15_000 },
			)

			expect(captured).toContain(DESCENDANT_EARLY)
			expect(await collectEvidence(transport)).toEqual([captured])
		} finally {
			await transport.close()
			if (pid.value !== undefined && isRunning(pid.value)) process.kill(pid.value)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('never grows the captured tail with the bytes a descendant writes after close()', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const pid = new MCPFixtureCell<number | undefined>(undefined)
		try {
			await transport.start()
			pid.value = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			// CONTROL — the descendant's write BEFORE the terminal moment reaches the tail, so the
			// exclusion asserted below excludes a channel this reading proves is live.
			await waitForEvidence(transport, DESCENDANT_EARLY)

			await transport.close()
			const captured = transport.evidence
			expect(captured).toContain(DESCENDANT_EARLY)

			scratch.write(TRIGGER_FILE, '')
			await waitForCondition(
				'the descendant reports its late stderr write',
				() => scratch.has(DONE_FILE),
				{ budget: 15_000 },
			)
			await waitForCondition(
				'the descendant that wrote after the barrier has exited',
				() => !isRunning(requireValue(pid.value)),
				{ budget: 15_000 },
			)

			expect(await collectEvidence(transport)).toEqual([captured])
			expect(transport.evidence).not.toContain(DESCENDANT_LATE)
		} finally {
			await transport.close()
			if (pid.value !== undefined && isRunning(pid.value)) process.kill(pid.value)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('reports on error that a tail the drain bound cut off may be incomplete', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		const pid = new MCPFixtureCell<number | undefined>(undefined)
		try {
			await transport.start()
			pid.value = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			await waitForEvidence(transport, DESCENDANT_EARLY)

			// The child has ended and the descendant holds its inherited `stderr`, so the terminal
			// moment arrives at the `drain` bound rather than at the child's own stream close. The
			// tail frozen there is the tail as of that cutoff, and a consumer given no notice reads
			// it as the child's whole output.
			await transport.close()

			const [reported] = errors
			expect(errors).toHaveLength(1)
			expect(reported).toBeInstanceOf(Error)
			expect(String(reported)).toContain('evidence may be incomplete')
			expect(transport.evidence).toContain(DESCENDANT_EARLY)
		} finally {
			await transport.close()
			if (pid.value !== undefined && isRunning(pid.value)) process.kill(pid.value)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('CONTROL — a child whose own streams close reports no such notice', async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL, wait: true })
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))
		try {
			await transport.start()
			await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
			await waitForEvidence(transport, EVIDENCE_SENTINEL)

			// The same `close()` over a child that holds no descendant: its streams close under the
			// input-end path, the terminal moment arrives drained, and the tail is complete. So the
			// notice above reports the cutoff rather than every close this transport runs.
			await transport.close()

			expect(errors).toEqual([])
			expect(transport.evidence).toBe(EVIDENCE_SENTINEL)
		} finally {
			await transport.close()
		}
	})
})
