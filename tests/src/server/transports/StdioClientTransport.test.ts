import type { JSONRPCMessage } from '@src/core'
import type { ScratchInterface } from '@orkestrel/test/server'
import { describe, expect, it } from 'vitest'
import { basename, delimiter, dirname, join } from 'node:path'
import { isRecord } from '@orkestrel/contract'
import { PROCESS_DRAIN, PROCESS_EVIDENCE } from '@orkestrel/process'
import { createJSONRPCRequest, waitForSettlement } from '../../../setup.js'
import { requireValue, waitForCondition, waitForDelay, waitForEvent } from '@orkestrel/test'
import { createScratch, destroyScratch, isRunning } from '@orkestrel/test/server'
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

/** The first of the two lines the burst child writes in one write. */
const BURST_FIRST = 'first'

/** The second of those lines — the one already framed and queued behind the first. */
const BURST_SECOND = 'second'

// A child that answers one request with TWO complete lines in ONE write, so the supervisor frames
// both out of one chunk: the first resolves the pump's outstanding read and the second is left in
// the supervisor's own queue. That queued line is what a listener calling `close()` from the first
// line's delivery races, because the supervisor answers the next read out of the queue at once.
const BURST_SCRIPT = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', () => {
	const first = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { burst: ${JSON.stringify(BURST_FIRST)} } })
	const second = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { burst: ${JSON.stringify(BURST_SECOND)} } })
	process.stdout.write(first + '\\n' + second + '\\n')
})
`

// Comfortably above both a Windows stdio pipe buffer and a 64 KiB POSIX one, so the write below
// cannot be swallowed whole by the host and answered before the child has read anything.
const UNREAD_PAYLOAD = 'x'.repeat(256 * 1024)

/** How long past the supervisor's `drain` bound a bounded `close()` is waited for, in milliseconds. */
const CLOSE_SLACK = 2_000

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

function spawnBurstClient(): StdioClientTransport {
	return new StdioClientTransport({ command: process.execPath, args: ['-e', BURST_SCRIPT] })
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

	it('close() settles inside the supervisor drain bound while a descendant retains the child stdout pipe', async () => {
		const transport = spawnDescendantClient()
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		let pid: number | undefined
		try {
			await transport.start()
			pid = readDescendantPid(
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

	it('emits nothing more after a message listener closed the transport', async () => {
		const transport = spawnBurstClient()
		const messages: JSONRPCMessage[] = []
		let closing: Promise<void> | undefined
		transport.emitter.on('message', (message) => {
			messages.push(message)
			closing ??= transport.close()
		})
		await transport.start()
		await transport.send(createJSONRPCRequest({ method: 'burst', id: 1 }))
		await waitForCondition(
			'the first of the two framed lines reaches the message listener',
			() => closing !== undefined,
			{ budget: 10_000 },
		)

		// The teardown began INSIDE the first line's delivery, and the second line was already sitting
		// in the supervisor's queue by then. The supervisor delivers a queued line before it ends the
		// stream, so the stream's own end does not stop that second delivery — the transport's closed
		// state is what drops it.
		await requireValue(closing)
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

	it('holds a stale start() behind the newer teardown a close() opened while it was parked', async () => {
		const transport = spawnDeafClient()
		let closes = 0
		transport.emitter.on('close', () => (closes += 1))
		try {
			// An explicit `close()` over a LIVE child runs a REAL teardown, and the barrier that
			// teardown ran under stays assigned once it settles: `close()` clears no barrier, and the
			// exit bridge clears only the one it installed itself. That settled barrier is what both
			// `start()` calls below capture, so each parks on it rather than opening a child here.
			await transport.start()
			await transport.close()
			expect(closes).toBe(1)

			// The interleaving. Both `start()` calls capture that barrier in this one turn, and each
			// queued microtask lands between their two resumptions: the first closes the replacement
			// the earlier `start()` installed, which opens a real teardown over a LIVE child, and the
			// second asks for a teardown while the later `start()` is parked on that newer barrier.
			const opening = transport.start()
			let tearing: Promise<void> | undefined
			queueMicrotask(() => {
				tearing = transport.close()
			})
			const stale = transport.start()
			let joining: Promise<void> | undefined
			queueMicrotask(() => {
				joining = transport.close()
			})
			await Promise.all([opening, stale])

			// The stale continuation resumed against a NEWER barrier than the one it awaited, and it
			// waited that one out before installing its own child, so that teardown had reported its
			// `close` by the time this resolved. A `start()` that waited once and cleared whatever it
			// found would have discarded the newer barrier and spawned over a teardown still running.
			expect(closes).toBe(2)

			// The joining `close()` reports THAT teardown's completion rather than resolving through a
			// no-op, so this lifetime's `close` has already fired when it resolves rather than firing
			// after it. The teardown call itself reads the same, and neither adds a second report.
			await requireValue(joining)
			expect(closes).toBe(2)
			await requireValue(tearing)
			expect(closes).toBe(2)

			// The child the stale `start()` installed is live and untorn, so closing it runs a real
			// teardown and reports it: the barrier walk left the replacement closable rather than
			// stranding it behind a barrier a later `close()` resolves through.
			await transport.close()
			expect(closes).toBe(3)
		} finally {
			await transport.close()
		}
	}, 30_000)

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
// - `Process` reaches ONE terminal moment, where `evidence` freezes, `lines` ends, and `exit`
//   settles together. It arrives when the child's stdio streams close, or when the `drain` bound
//   armed by the native exit or by an initiated termination elapses first; `ProcessExit.drained`
//   reports which. Node delivers each `data` event before a stream closes, so a tail read after
//   this transport's `close` event is complete rather than raced.
// - `Process.destroy()` resolves past that moment, so the tail this transport reports off the held
//   child is already frozen when `close()` returns. A descendant holding the inherited `stderr`
//   cannot hold that barrier open beyond `drain`, and a tail cut off there is the reading
//   `drained: false` names.
// - Windows ends a child tree with `taskkill /F /T`, which no `SIGTERM` handler can intercept, so
//   the close path there carries only what the child had already written. A POSIX host signals
//   `SIGTERM` and waits out the grace window instead, and that window is unmeasured here.
// - A live read is asynchronous with the child's write, so a test that needs written bytes waits
//   for the named condition inside a `performance.now()` budget rather than for a fixed delay.

/** The bytes an evidence child writes to its own `stderr`. */
const EVIDENCE_SENTINEL = 'evidence-sentinel'

/** The first marker in the overflow child's stderr run — the half the byte bound drops. */
const EVIDENCE_HEAD = 'evidence-head'

/** The last marker in the overflow child's stderr run — the half the byte bound keeps. */
const EVIDENCE_TAIL = 'evidence-tail'

/** One character whose UTF-8 encoding occupies more than one byte. */
const MULTIBYTE = 'é'

/** How many bytes one {@link MULTIBYTE} character occupies, read on the host running the test. */
const MULTIBYTE_BYTES = Buffer.byteLength(MULTIBYTE, 'utf8')

/** One character whose UTF-8 width does NOT divide the byte bound evenly. */
const UNEVEN = '€'

/** How many bytes one {@link UNEVEN} character occupies, read on the host running the test. */
const UNEVEN_BYTES = Buffer.byteLength(UNEVEN, 'utf8')

/** The character a decoder substitutes for bytes it cannot read as a complete sequence. */
const REPLACEMENT = '�'

/** The bytes the handled child writes from inside its own `SIGTERM` handler. */
const HANDLED_SENTINEL = 'handled-sentinel'

/** The scratch file that same handler writes, so a reading can tell whether the handler ran. */
const HANDLED_FILE = 'handled.txt'

/** Whether this host ends a child by force, leaving the child no signal it can handle. */
const FORCED = process.platform === 'win32'

/** A command name no host resolves, so the spawn faults instead of producing a child. */
const ABSENT_COMMAND = 'orkestrel-mcp-absent-command'

/** The exit code the failing children report, so their end is a fault rather than a success. */
const EVIDENCE_CODE = 3

/** The bytes the detached descendant writes before the child's terminal moment. */
const DESCENDANT_EARLY = 'descendant-early'

/** The bytes the detached descendant writes after that moment, once the tail is frozen. */
const DESCENDANT_LATE = 'descendant-late'

/** The scratch file whose appearance releases the descendant's late write. */
const TRIGGER_FILE = 'trigger.txt'

/** The scratch file the descendant writes after its late stderr write has flushed. */
const DONE_FILE = 'done.txt'

/** The scratch file the first child under one command writes, so a later child spawns nothing. */
const CLAIM_FILE = 'claim.txt'

/** The executable name a BARE command resolves to, so a stripped `PATH` refuses the next spawn. */
const EVIDENCE_EXECUTABLE = basename(process.execPath)

/** The one `PATH` entry that resolves {@link EVIDENCE_EXECUTABLE}. */
const EVIDENCE_DIRECTORY = dirname(process.execPath)

/** How long a post-condition tail reading is repeated before it counts as stable, in milliseconds. */
const STABILITY_WINDOW = 500

// One parameterized child whose entire job is what it puts on its own `stderr`. `MCP_EVIDENCE_WAIT`
// keeps it alive and defers the write until a line arrives, so a test can read a live tail before
// and after the child writes; without it the child writes once and ends, optionally non-zero.
const EVIDENCE_SCRIPT = `
const payload = process.env.MCP_EVIDENCE_PAYLOAD
const code = process.env.MCP_EVIDENCE_CODE
const write = () => { if (payload !== undefined) process.stderr.write(payload) }
if (process.env.MCP_EVIDENCE_WAIT === 'true') {
	const readline = require('node:readline')
	readline.createInterface({ input: process.stdin }).on('line', write)
	setInterval(() => {}, 1000)
} else {
	write()
	if (code !== undefined) process.exitCode = Number(code)
}
`

// A child that installs a `SIGTERM` handler and writes its startup marker at once. The handler
// records a scratch file as well as stderr bytes, so a reading that finds no handler bytes in the
// tail can still say whether the handler ran and its write was lost or the host never delivered
// the signal at all.
const HANDLED_SCRIPT = `
const { writeFileSync } = require('node:fs')
process.on('SIGTERM', () => {
	writeFileSync(process.env.MCP_EVIDENCE_HANDLED, 'handled')
	process.stderr.write(${JSON.stringify(HANDLED_SENTINEL)}, () => { process.exit(0) })
})
process.stderr.write(process.env.MCP_EVIDENCE_PAYLOAD)
setInterval(() => {}, 1000)
`

// The detached descendant that outlives the child it was spawned from, holding that child's
// inherited `stderr`. It writes its early marker at once, then parks on the trigger file the test
// creates after the teardown barrier, writes its late marker, and reports that the write flushed.
// The deadline is a self-release, so an abandoned descendant ends rather than parking forever.
const DESCENDANT_SCRIPT = `
const { existsSync, writeFileSync } = require('node:fs')
process.stderr.write(process.env.MCP_EVIDENCE_EARLY)
const deadline = Date.now() + 30000
const timer = setInterval(() => {
	if (existsSync(process.env.MCP_EVIDENCE_TRIGGER)) {
		clearInterval(timer)
		process.stderr.write(process.env.MCP_EVIDENCE_LATE, () => {
			writeFileSync(process.env.MCP_EVIDENCE_DONE, 'done')
			process.exit(0)
		})
	} else if (Date.now() > deadline) {
		clearInterval(timer)
		process.exit(1)
	}
}, 20)
`

// The FIRST child under this command hands its `stderr` down to a detached descendant, reports that
// descendant's pid, and ends. Its own `stdout` is left to the supervisor, so the line pump still
// ends with the child. Every later child under the same command reads the claim file the first one
// wrote and instead stays alive writing nothing — a replacement lifetime respawns the same command,
// so without that branch the replacement would spawn a second descendant and write the same marker
// into ITS own tail, and a reading meant to report the superseded child would report the live one.
const DESCENDANT_STDERR_SCRIPT = `
const { existsSync, writeFileSync } = require('node:fs')
const claim = process.env.MCP_EVIDENCE_CLAIM
if (existsSync(claim)) {
	setInterval(() => {}, 1000)
} else {
	writeFileSync(claim, 'claimed')
	const { spawn } = require('node:child_process')
	const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(DESCENDANT_SCRIPT)}], {
		detached: true,
		stdio: ['ignore', 'ignore', 'inherit'],
	})
	descendant.unref()
	process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'descendant', result: { pid: descendant.pid } }) + '\\n')
}
`

/** What one {@link EVIDENCE_SCRIPT} child does with its `stderr` and with its exit. */
interface EvidenceChildOptions {
	/** The exact bytes the child writes to its own `stderr`; it writes nothing when omitted. */
	readonly payload?: string
	/** The non-zero code the child ends with; it ends successfully when omitted. */
	readonly code?: number
	/** Whether the child stays alive and defers its write until a line arrives on its stdin. */
	readonly wait?: boolean
}

function spawnEvidenceClient(options?: EvidenceChildOptions): StdioClientTransport {
	const environment: Record<string, string> = {}
	if (options?.payload !== undefined) environment['MCP_EVIDENCE_PAYLOAD'] = options.payload
	if (options?.code !== undefined) environment['MCP_EVIDENCE_CODE'] = String(options.code)
	if (options?.wait === true) environment['MCP_EVIDENCE_WAIT'] = 'true'
	return new StdioClientTransport({
		command: process.execPath,
		args: ['-e', EVIDENCE_SCRIPT],
		env: environment,
	})
}

/**
 * The same evidence child, reached through a BARE command name instead of an absolute path.
 *
 * `@orkestrel/process` resolves a bare command through the merged environment's `PATH` at each
 * spawn, so removing {@link EVIDENCE_DIRECTORY} from `process.env.PATH` between one lifetime and
 * the next makes that next one a spawn the host refuses. That is the only lifetime that ends
 * without starting a process, and therefore the only one whose end reliably lands INSIDE another
 * lifetime's teardown.
 */
function spawnResolvedEvidenceClient(): StdioClientTransport {
	return new StdioClientTransport({
		command: EVIDENCE_EXECUTABLE,
		args: ['-e', EVIDENCE_SCRIPT],
		env: { MCP_EVIDENCE_PAYLOAD: EVIDENCE_SENTINEL, MCP_EVIDENCE_WAIT: 'true' },
	})
}

function spawnHandledEvidenceClient(scratch: ScratchInterface): StdioClientTransport {
	return new StdioClientTransport({
		command: process.execPath,
		args: ['-e', HANDLED_SCRIPT],
		env: {
			MCP_EVIDENCE_PAYLOAD: EVIDENCE_SENTINEL,
			MCP_EVIDENCE_HANDLED: join(scratch.path, HANDLED_FILE),
		},
	})
}

function spawnDescendantStderrClient(scratch: ScratchInterface): StdioClientTransport {
	return new StdioClientTransport({
		command: process.execPath,
		args: ['-e', DESCENDANT_STDERR_SCRIPT],
		env: {
			MCP_EVIDENCE_EARLY: DESCENDANT_EARLY,
			MCP_EVIDENCE_LATE: DESCENDANT_LATE,
			MCP_EVIDENCE_TRIGGER: join(scratch.path, TRIGGER_FILE),
			MCP_EVIDENCE_DONE: join(scratch.path, DONE_FILE),
			MCP_EVIDENCE_CLAIM: join(scratch.path, CLAIM_FILE),
		},
	})
}

/** Park until the transport's `close` event has fired, so a tail read after it is complete. */
function waitForClose(transport: StdioClientTransport, description: string): Promise<readonly []> {
	return waitForEvent<readonly []>(
		(listener) => {
			transport.emitter.on('close', listener)
		},
		description,
		{ budget: 10_000 },
	)
}

/** Park until the transport's live tail carries `text`, so the write is read rather than raced. */
function waitForEvidence(transport: StdioClientTransport, text: string): Promise<void> {
	return waitForCondition(
		`the child stderr bytes ${text} reach the transport evidence`,
		() => transport.evidence?.includes(text) === true,
		{ budget: 10_000 },
	)
}

/** Read the pid the descendant-spawning child reports on its one stdout line. */
function readDescendantPid(message: JSONRPCMessage): number {
	if (!('result' in message) || !isRecord(message.result)) {
		throw new Error('The descendant report carries no result')
	}
	const value = message.result['pid']
	if (typeof value !== 'number') throw new Error('The descendant report carries no pid')
	return value
}

/**
 * Read the tail repeatedly across a bounded window and answer every distinct reading.
 *
 * The window opens after the fact that would have moved the tail has already happened, so one
 * member is what a stable reading looks like and a second member names the drift.
 */
async function collectEvidence(
	transport: StdioClientTransport,
): Promise<ReadonlyArray<string | undefined>> {
	const readings = new Set<string | undefined>()
	const opened = performance.now()
	while (performance.now() - opened < STABILITY_WINDOW) {
		readings.add(transport.evidence)
		await waitForDelay(10)
	}
	return [...readings]
}

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
		const closed = waitForClose(transport, 'the failing child close event')
		await transport.start()
		await closed

		expect(transport.evidence).toBe(EVIDENCE_SENTINEL)
		await transport.close()
	})

	it('CONTROL — a failing child that wrote nothing reads an empty tail, not the sentinel', async () => {
		const transport = spawnEvidenceClient({ code: EVIDENCE_CODE })
		const closed = waitForClose(transport, 'the silent failing child close event')
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

		// The child is alive and the tail is live here. `close()` terminates it, and the reading
		// afterwards is the value the supervisor froze at that child's terminal moment.
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
		let seen: string | undefined
		let fired = false
		transport.emitter.on('close', () => {
			seen = transport.evidence
			fired = true
		})
		await transport.start()

		// CONTROL — the same read taken before the child writes carries no sentinel at all, so the
		// readings below report the write rather than the getter's constant.
		expect(transport.evidence).toBe('')

		await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
		await waitForEvidence(transport, EVIDENCE_SENTINEL)
		await transport.close()

		expect(fired).toBe(true)
		expect(seen).toBe(EVIDENCE_SENTINEL)
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
		let early: string | undefined
		let late: string | undefined
		let read = false
		let restarting: Promise<void> | undefined
		transport.emitter.on('close', () => {
			if (!read) early = transport.evidence
		})
		transport.emitter.on('close', () => {
			// An explicit teardown still holds its barrier while these listeners run, so this
			// `start()` parks behind it instead of opening the next lifetime inside the emit.
			restarting ??= transport.start()
		})
		transport.emitter.on('close', () => {
			if (read) return
			late = transport.evidence
			read = true
		})
		try {
			await transport.start()
			await transport.send(createJSONRPCRequest({ method: 'write', id: 1 }))
			await waitForEvidence(transport, EVIDENCE_SENTINEL)

			await transport.close()

			// The listener AFTER the one that restarted reads what the listener before it read: the
			// replacement cannot open until every listener has returned.
			expect(early).toBe(EVIDENCE_SENTINEL)
			expect(late).toBe(EVIDENCE_SENTINEL)
		} finally {
			await requireValue(restarting)
			await transport.close()
		}
	}, 30_000)

	it('CONTROL — a natural exit lets a listener clear that tail before the later listeners read', async () => {
		const transport = spawnEvidenceClient({ payload: EVIDENCE_SENTINEL, code: EVIDENCE_CODE })
		let early: string | undefined
		let late: string | undefined
		let read = false
		let restarting: Promise<void> | undefined
		transport.emitter.on('close', () => {
			if (!read) early = transport.evidence
		})
		transport.emitter.on('close', () => {
			// The exit bridge holds no barrier, so this `start()` runs to its spawn INSIDE the emit
			// and the tail it clears is already gone when the listener after it reads.
			restarting ??= transport.start()
		})
		transport.emitter.on('close', () => {
			if (read) return
			late = transport.evidence
			read = true
		})
		try {
			await transport.start()
			await waitForCondition('the failing child ends and its close listeners run', () => read, {
				budget: 10_000,
			})

			// The tail the earlier listener read is the ended child's own, and the later listener reads
			// the replacement's empty live tail instead.
			expect(early).toBe(EVIDENCE_SENTINEL)
			expect(late).toBe('')
		} finally {
			await requireValue(restarting)
			await transport.close()
		}
	}, 30_000)

	it('delivers an ended lifetime close before a restart its own error listener began', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		let restarting: Promise<void> | undefined
		let captured: string | undefined
		let ended = false
		transport.emitter.on('error', () => {
			// The drain-bound notice is emitted from INSIDE the natural exit's own report, BEFORE
			// that exit has fired `close`. A restart begun here must not open the next lifetime over
			// the tail the `close` listeners are about to read.
			restarting ??= transport.start()
		})
		transport.emitter.on('close', () => {
			captured ??= transport.evidence
			ended = true
		})
		let pid: number | undefined
		try {
			await transport.start()
			pid = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			// CONTROL — the ended child's own tail is present before its exit reports, so the reading
			// below excludes a replacement rather than a value this lifetime never carried.
			await waitForEvidence(transport, DESCENDANT_EARLY)

			await waitForCondition('the ended child fires its close', () => ended, { budget: 10_000 })

			// The `close` for the ended lifetime reached its listener while that lifetime's child was
			// still the held one. A replacement installed inside the report would have read its own
			// empty live tail here instead.
			expect(captured).toContain(DESCENDANT_EARLY)
		} finally {
			if (restarting !== undefined) await restarting
			await transport.close()
			if (pid !== undefined && isRunning(pid)) process.kill(pid)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('CONTROL — a restart the same exit close listener began still opens inside that emit', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		let early: string | undefined
		let late: string | undefined
		let read = false
		let restarting: Promise<void> | undefined
		transport.emitter.on('close', () => {
			if (!read) early = transport.evidence
		})
		transport.emitter.on('close', () => {
			// The barrier the report held is released before this emit, so this `start()` runs to its
			// spawn INSIDE the emit rather than parking behind the ended lifetime.
			restarting ??= transport.start()
		})
		transport.emitter.on('close', () => {
			if (read) return
			late = transport.evidence
			read = true
		})
		let pid: number | undefined
		try {
			await transport.start()
			pid = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			await waitForEvidence(transport, DESCENDANT_EARLY)

			await waitForCondition('the ended child fires its close', () => read, { budget: 10_000 })

			// The same exit that defers an error listener's restart still lets a `close` listener's
			// restart replace the tail every listener after it reads.
			expect(early).toContain(DESCENDANT_EARLY)
			expect(late).toBe('')
		} finally {
			if (restarting !== undefined) await restarting
			await transport.close()
			if (pid !== undefined && isRunning(pid)) process.kill(pid)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('opens that restart inside the emit though an earlier close listener called close()', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		let joining: Promise<void> | undefined
		let restarting: Promise<void> | undefined
		let late: string | undefined
		let read = false
		transport.emitter.on('close', () => {
			// The ended lifetime reached its terminal moment before this emit, so this `close()` has
			// nothing to tear down and must leave NO barrier behind. A resolved no-op barrier parks
			// the `start()` below on the microtask queue, and the replacement then opens after this
			// emit rather than inside it.
			joining ??= transport.close()
		})
		transport.emitter.on('close', () => {
			restarting ??= transport.start()
		})
		transport.emitter.on('close', () => {
			if (read) return
			late = transport.evidence
			read = true
		})
		let pid: number | undefined
		try {
			await transport.start()
			pid = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			// CONTROL — the ended child's own tail is present before its exit reports, so the reading
			// below excludes a replacement rather than a value this lifetime never carried.
			await waitForEvidence(transport, DESCENDANT_EARLY)

			await waitForCondition('the ended child fires its close', () => read, { budget: 10_000 })

			// The replacement opened INSIDE the emit despite the earlier `close()`, so the listener
			// after it reads the replacement's own empty live tail rather than the ended child's.
			expect(late).toBe('')
		} finally {
			await requireValue(joining)
			await requireValue(restarting)
			await transport.close()
			if (pid !== undefined && isRunning(pid)) process.kill(pid)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('leaves the replacement an error listener began closable behind a close listener close()', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		let restarting: Promise<void> | undefined
		let joining: Promise<void> | undefined
		let ends = 0
		transport.emitter.on('error', () => {
			restarting ??= transport.start()
		})
		transport.emitter.on('close', () => {
			ends += 1
			// This `close()` lands in the gap between the report's barrier and the replacement the
			// parked `start()` above has not installed yet. The lifetime is closed and no barrier is
			// assigned, so it returns directly and leaves nothing behind — a barrier left here would
			// become the answer a LATER `close()` resolves through, over a live replacement it then
			// never tears down.
			joining ??= transport.close()
		})
		let pid: number | undefined
		try {
			await transport.start()
			pid = readDescendantPid(
				await waitForSettlement(arrived, 10_000, 'Timed out waiting for the descendant report'),
			)
			await waitForEvidence(transport, DESCENDANT_EARLY)

			await waitForCondition('the ended child fires its close', () => ends >= 1, {
				budget: 10_000,
			})
			await requireValue(restarting)
			await requireValue(joining)

			// The replacement is a live child, so this close runs a real teardown and reports it.
			await transport.close()
			expect(ends).toBe(2)
		} finally {
			await transport.close()
			if (pid !== undefined && isRunning(pid)) process.kill(pid)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it("never reports a closing lifetime's tail after the replacement lifetime ended", async () => {
		const scratch = createScratch()
		const inherited = requireValue(process.env['PATH'])
		const transport = spawnResolvedEvidenceClient()
		const errors: unknown[] = []
		let ends = 0
		transport.emitter.on('error', (error) => errors.push(error))
		transport.emitter.on('close', () => (ends += 1))
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
			await waitForCondition('the closing and replacement lifetimes end', () => ends >= 2, {
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
		let ends = 0
		transport.emitter.on('error', (error) => errors.push(error))
		transport.emitter.on('close', () => (ends += 1))
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
			await waitForCondition('the replacement lifetime ends', () => ends >= 2, { budget: 10_000 })
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
		const closed = waitForClose(transport, 'the overflowing child close event')
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
		const closed = waitForClose(transport, 'the multibyte child close event')
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
		const closed = waitForClose(transport, 'the uneven multibyte child close event')
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
		const closed = waitForClose(transport, 'the resolvable child close event')
		await transport.start()
		await closed

		expect(transport.evidence).not.toBe('')
		expect(transport.evidence).toBe(EVIDENCE_SENTINEL)
		await transport.close()
	})

	it("leaves the live lifetime's tail alone when a superseded child exits late", async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		let closes = 0
		transport.emitter.on('close', () => (closes += 1))
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		let pid: number | undefined
		try {
			await transport.start()
			pid = readDescendantPid(
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
				() => !isRunning(requireValue(pid)),
				{ budget: 15_000 },
			)

			// Every reading taken after that exit landed is the live lifetime's empty tail, and the
			// superseded child's own end fired no second close.
			expect(await collectEvidence(transport)).toEqual([''])
			expect(closes).toBe(1)
		} finally {
			await transport.close()
			if (pid !== undefined && isRunning(pid)) process.kill(pid)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('CONTROL — the same late exit with no replacement leaves the captured tail in place', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		let pid: number | undefined
		try {
			await transport.start()
			pid = readDescendantPid(
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
				() => !isRunning(requireValue(pid)),
				{ budget: 15_000 },
			)

			expect(captured).toContain(DESCENDANT_EARLY)
			expect(await collectEvidence(transport)).toEqual([captured])
		} finally {
			await transport.close()
			if (pid !== undefined && isRunning(pid)) process.kill(pid)
			await destroyScratch(scratch)
		}
	}, 30_000)

	it('never grows the captured tail with the bytes a descendant writes after close()', async () => {
		const scratch = createScratch()
		const transport = spawnDescendantStderrClient(scratch)
		const arrived = new Promise<JSONRPCMessage>((resolve) => {
			transport.emitter.on('message', resolve)
		})
		let pid: number | undefined
		try {
			await transport.start()
			pid = readDescendantPid(
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
				() => !isRunning(requireValue(pid)),
				{ budget: 15_000 },
			)

			expect(await collectEvidence(transport)).toEqual([captured])
			expect(transport.evidence).not.toContain(DESCENDANT_LATE)
		} finally {
			await transport.close()
			if (pid !== undefined && isRunning(pid)) process.kill(pid)
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
		let pid: number | undefined
		try {
			await transport.start()
			pid = readDescendantPid(
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
			if (pid !== undefined && isRunning(pid)) process.kill(pid)
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
			// termination, the terminal moment arrives drained, and the tail is complete. So the
			// notice above reports the cutoff rather than every close this transport runs.
			await transport.close()

			expect(errors).toEqual([])
			expect(transport.evidence).toBe(EVIDENCE_SENTINEL)
		} finally {
			await transport.close()
		}
	})
})
