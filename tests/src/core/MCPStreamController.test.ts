import type { JSONRPCNotification, MCPStream, MCPStreamControllerInterface } from '@src/core'
import { LAST_RESORT_CONTROLLER, OWNERSHIP_SOURCES } from '../../setupServer.js'
import {
	createParkedStream,
	createSuspendedStream,
	createCooperativeStream,
	createReplayStream,
	createFaultedStream,
	createControlledStream,
	MCP_STREAM_PROGRESS,
	MCP_STREAM_TERMINAL,
	MCP_STREAM_FAILURE,
} from '../../setup.js'
import { readProjectSource } from '../../setupServer.js'
import { buildJSONRPCResult } from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { waitForDelay } from '@orkestrel/test'
import { inspectOwnerOfLastResort, OWNER_OF_LAST_RESORT_SPELLINGS } from '../../setup.js'

// MCPStreamController is the one cancellation engine every modern stream leaves dispatch
// through. What it exists to fix is a property of NATIVE async generators, not of this
// package: `return()` and `throw()` queue behind a `next()` the producer has not answered,
// so a consumer that walks away from a source parked on an event that will never arrive
// waits forever for its own cancellation. Every test below therefore drives a source that
// NEVER settles on its own — a source that completes would prove nothing about queueing.

// A real async generator that parks before it can produce anything and never resumes: the
// interleaving every queueing defect hides behind. Its own cleanup is deliberately
// UNREACHABLE — JavaScript cannot force work a generator is suspended inside — so what these
// tests prove is that the consumer settles regardless, never that an uncooperative producer
// was made to finish.
// A source that parks only AFTER yielding, so a test can settle one read and then cancel
// while the second is outstanding.
// A source that observes the request signal for its own cleanup — the cooperating producer
// the controller's abort-before-cleanup ordering exists to wake.
// Fails MID-stream, which is the failure a wrapper can actually get wrong: one message has
// already reached the consumer when the producer gives up.
// The owner of last resort the standing ruling forbids, spelled the way somebody would
// actually add one: a finalizer that ends an exchange nobody released, plus the timeout that
// is the same mistake with a clock. This is the control the sweep below is certified against
// — an inspector that never reports a violation cannot tell a clean file from a blind rule.

describe('controlled exchange ownership', () => {
	// Retained, and retained with evidence rather than by inspection.
	it('gives the controllers no owner of last resort', () => {
		for (const path of OWNERSHIP_SOURCES) {
			expect([path, inspectOwnerOfLastResort(readProjectSource(path))]).toEqual([path, []])
		}
	})

	it('reports a synthetic controller that adds one', () => {
		expect(inspectOwnerOfLastResort(LAST_RESORT_CONTROLLER)).toEqual([
			'FinalizationRegistry',
			'setTimeout',
		])
		expect(OWNER_OF_LAST_RESORT_SPELLINGS.length).toBeGreaterThan(2)
	})
})

describe('MCPStreamController — normal completion', () => {
	it('passes each notification through and returns the source terminal once', async () => {
		const stream = createControlledStream(
			createReplayStream([MCP_STREAM_PROGRESS, MCP_STREAM_PROGRESS]),
		)

		expect(await stream.next()).toEqual({ done: false, value: MCP_STREAM_PROGRESS })
		expect(await stream.next()).toEqual({ done: false, value: MCP_STREAM_PROGRESS })
		expect(await stream.next()).toEqual({ done: true, value: MCP_STREAM_TERMINAL })
		expect(await stream.next()).toEqual({ done: true, value: MCP_STREAM_TERMINAL })
	})

	it('aborts the request lifetime once the terminal has been delivered', async () => {
		const closure = new AbortController()
		const stream = createControlledStream(createReplayStream([]), closure)

		expect(closure.signal.aborted).toBe(false)
		await stream.next()

		expect(closure.signal.aborted).toBe(true)
	})

	it('is iterable as the async generator it claims to be', async () => {
		const seen: JSONRPCNotification[] = []
		for await (const message of createControlledStream(createReplayStream([MCP_STREAM_PROGRESS])))
			seen.push(message)

		expect(seen).toEqual([MCP_STREAM_PROGRESS])
	})

	it('extends the stream with the closure the protocol has no member for', () => {
		expectTypeOf<MCPStreamControllerInterface>().toExtend<MCPStream>()
		expectTypeOf<MCPStreamControllerInterface['stop']>().toEqualTypeOf<() => void>()
	})
})

describe('MCPStreamController — cancellation against a never-settling source', () => {
	it('settles return() while a read is parked on the producer', async () => {
		const stream = createControlledStream(createParkedStream())
		const parked = stream.next()
		await waitForDelay()

		const returned = await stream.return(MCP_STREAM_TERMINAL)

		expect(returned).toEqual({ done: true, value: MCP_STREAM_TERMINAL })
		expect(await parked).toEqual({ done: true, value: MCP_STREAM_TERMINAL })
	})

	it('settles return() when nothing is parked and no read ever happened', async () => {
		const stream = createControlledStream(createParkedStream())

		expect(await stream.return(MCP_STREAM_TERMINAL)).toEqual({
			done: true,
			value: MCP_STREAM_TERMINAL,
		})
	})

	it('settles stop() while a read is parked, with no terminal for the consumer', async () => {
		const stream = createControlledStream(createParkedStream())
		const parked = stream.next()
		await waitForDelay()

		stream.stop()

		// The abort reason, not a terminal: `stop` says there will be no answer.
		await expect(parked).rejects.toBeInstanceOf(DOMException)
		await expect(stream.next()).rejects.toBeInstanceOf(DOMException)
	})

	it('settles throw() while a read is parked and reports the same reason to both', async () => {
		const failure = new Error('consumer gave up')
		const stream = createControlledStream(createParkedStream())
		const parked = stream.next()
		await waitForDelay()

		await expect(stream.throw(failure)).rejects.toBe(failure)
		await expect(parked).rejects.toBe(failure)
	})

	it('settles a parked read on external abort, with the abort reason', async () => {
		const closure = new AbortController()
		const stream = createControlledStream(createParkedStream(), closure)
		const parked = stream.next()
		await waitForDelay()

		closure.abort(new Error('caller went away'))

		await expect(parked).rejects.toThrow('caller went away')
	})

	it('refuses a read on an already-aborted request without touching the producer', async () => {
		const closure = new AbortController()
		closure.abort(new Error('already gone'))

		await expect(createControlledStream(createParkedStream(), closure).next()).rejects.toThrow(
			'already gone',
		)
	})

	it('aborts the request signal BEFORE it delegates cleanup, waking a parked producer', async () => {
		const closure = new AbortController()
		const woken: string[] = []
		const stream = createControlledStream(createCooperativeStream(closure.signal, woken), closure)
		const parked = stream.next().catch((error: unknown) => error)
		await waitForDelay()

		stream.stop()
		await waitForDelay()

		expect(await parked).toBeInstanceOf(DOMException)
		// `aborted` before `closed`: the producer saw the signal already down when it woke.
		expect(woken).toEqual(['aborted', 'closed'])
	})

	it('reaches the producer’s own cleanup after a consumer return', async () => {
		const closed: string[] = []
		const stream = createControlledStream(createSuspendedStream(closed))
		expect(await stream.next()).toEqual({ done: false, value: MCP_STREAM_PROGRESS })

		await stream.return(MCP_STREAM_TERMINAL)
		await waitForDelay()

		expect(closed).toEqual(['yielding'])
	})
})

describe('MCPStreamController — idempotence and containment', () => {
	// A later closure answers its own caller, as a native generator does, but it never
	// REOPENS the exchange: the terminal a read sees stays the one the exchange ended on.
	it('keeps the exchange closed however many later closures arrive', async () => {
		const later = buildJSONRPCResult(2, { resultType: 'complete' })
		const stream = createControlledStream(createParkedStream())

		expect(await stream.return(MCP_STREAM_TERMINAL)).toEqual({
			done: true,
			value: MCP_STREAM_TERMINAL,
		})
		expect(await stream.return(later)).toEqual({ done: true, value: later })
		stream.stop()
		expect(await stream.next()).toEqual({ done: true, value: MCP_STREAM_TERMINAL })
	})

	// The producer settles LATE — after the consumer has gone — and the promises it settles
	// are the controller's to contain. An uncontained one is an unhandled rejection, which
	// fails this file's run rather than passing quietly, so the wait below is the assertion.
	it('contains a source promise that settles long after the consumer left', async () => {
		const closure = new AbortController()
		const woken: string[] = []
		const stream = createControlledStream(createCooperativeStream(closure.signal, woken), closure)
		const parked = stream.next().catch((error: unknown) => error)
		await waitForDelay()

		stream.stop()
		await waitForDelay()

		expect(await parked).toBeInstanceOf(DOMException)
		expect(woken).toEqual(['aborted', 'closed'])
	})

	it('refuses a second read while one is already pending', async () => {
		const stream = createControlledStream(createParkedStream())
		const parked = stream.next()

		await expect(stream.next()).rejects.toThrow('already pending')

		stream.stop()
		await expect(parked).rejects.toBeInstanceOf(DOMException)
	})

	it('ends the exchange when disposed and leaves a finished one alone', async () => {
		const stream = createControlledStream(createParkedStream())
		await stream[Symbol.asyncDispose]()

		await expect(stream.next()).rejects.toBeInstanceOf(DOMException)

		const finished = createControlledStream(createReplayStream([]))
		expect(await finished.next()).toEqual({ done: true, value: MCP_STREAM_TERMINAL })
		await finished[Symbol.asyncDispose]()
		expect(await finished.next()).toEqual({ done: true, value: MCP_STREAM_TERMINAL })
	})

	it('rejects the consumer with the source failure and answers the same way again', async () => {
		const stream = createControlledStream(createFaultedStream())

		expect(await stream.next()).toEqual({ done: false, value: MCP_STREAM_PROGRESS })
		await expect(stream.next()).rejects.toBe(MCP_STREAM_FAILURE)
		await expect(stream.next()).rejects.toBe(MCP_STREAM_FAILURE)
	})
})
