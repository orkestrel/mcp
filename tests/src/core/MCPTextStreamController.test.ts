import type {
	JSONRPCNotification,
	JSONRPCResponse,
	MCPStream,
	MCPTextStream,
	MCPTextStreamControllerInterface,
} from '@src/core'
import { MCPStreamController, MCPTextStreamController } from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { waitForDelay } from '@orkestrel/test'

// MCPTextStreamController is a TRANSLATION boundary and nothing else: it serializes each
// message and delegates every lifecycle decision into the controlled typed stream beneath
// it. The claim worth attacking is that it adds no SECOND queue — so every cancellation
// test below drives a typed source that never settles and asserts the text face settles
// anyway, and that the cancellation arrived at the typed producer rather than stopping at
// the adapter.

const PROGRESS: JSONRPCNotification = Object.freeze({
	jsonrpc: '2.0',
	method: 'notifications/progress',
})
const TERMINAL: JSONRPCResponse = Object.freeze({ jsonrpc: '2.0', id: 1, result: { done: true } })

async function* replaying(messages: readonly JSONRPCNotification[]): MCPStream {
	for (const message of messages) yield message
	return TERMINAL
}

// A producer that never settles on its own: JavaScript cannot force work a generator is
// suspended inside, so its `finally` is unreachable and the CONSUMER settling anyway is
// the whole claim.
async function* parking(): MCPStream {
	await new Promise<void>(() => undefined)
	yield PROGRESS
	return TERMINAL
}

// A producer that observes the request signal, which is how a real one gets cleaned up.
async function* cooperating(signal: AbortSignal, closed: string[]): MCPStream {
	try {
		await new Promise<void>((resolve) =>
			signal.addEventListener('abort', () => resolve(), { once: true }),
		)
		if (!signal.aborted) yield PROGRESS
		return TERMINAL
	} finally {
		closed.push('cooperating')
	}
}

// A producer that records WHICH ending it observed — suspended at a `yield`, so a consumer's
// closure actually reaches it. The typed face's `return(terminal)` returns the source
// normally; ending the exchange with no terminal throws into it instead. That difference is
// the whole subject of the asymmetry test below.
async function* recording(endings: string[]): MCPStream {
	try {
		yield PROGRESS
		yield PROGRESS
		return TERMINAL
	} catch {
		endings.push('catch')
		return TERMINAL
	} finally {
		endings.push('finally')
	}
}

function controlled(source: MCPStream, closure = new AbortController()): MCPStreamController {
	return new MCPStreamController(source, closure.signal, closure)
}

describe('MCPTextStreamController — translation', () => {
	it('serializes every notification and the terminal, keeping the terminal a return', async () => {
		const text = new MCPTextStreamController(controlled(replaying([PROGRESS])))

		expect(await text.next()).toEqual({ done: false, value: JSON.stringify(PROGRESS) })
		expect(await text.next()).toEqual({ done: true, value: JSON.stringify(TERMINAL) })
	})

	it('returns the serialized terminal alone for a stream that yields nothing', async () => {
		const text = new MCPTextStreamController(controlled(replaying([])))

		expect(await text.next()).toEqual({ done: true, value: JSON.stringify(TERMINAL) })
	})
})

describe('MCPTextStreamController — delegated lifecycle', () => {
	it('settles return() through the text face while a typed read is parked', async () => {
		const text = new MCPTextStreamController(controlled(parking()))
		const parked = text.next().catch((error: unknown) => error)
		await waitForDelay()

		const returned = await text.return('closed')

		expect(returned).toEqual({ done: true, value: 'closed' })
		expect(await parked).toBeInstanceOf(DOMException)
	})

	it('reaches the typed producer’s cleanup rather than stopping at the adapter', async () => {
		const closed: string[] = []
		const closure = new AbortController()
		const text = new MCPTextStreamController(
			controlled(cooperating(closure.signal, closed), closure),
		)
		const parked = text.next().catch((error: unknown) => error)
		await waitForDelay()

		text.stop()
		await waitForDelay()

		expect(await parked).toBeInstanceOf(DOMException)
		expect(closure.signal.aborted).toBe(true)
		expect(closed).toEqual(['cooperating'])
	})

	it('propagates an external abort as a rejection, never as a serialized terminal', async () => {
		const closure = new AbortController()
		const text = new MCPTextStreamController(controlled(parking(), closure))
		const parked = text.next()
		await waitForDelay()

		closure.abort(new Error('caller went away'))

		await expect(parked).rejects.toThrow('caller went away')
	})

	it('settles throw() through the text face and ends the typed exchange', async () => {
		const failure = new Error('pump failed')
		const closure = new AbortController()
		const text = new MCPTextStreamController(controlled(parking(), closure))

		await expect(text.throw(failure)).rejects.toBe(failure)
		expect(closure.signal.aborted).toBe(true)
	})

	it('ends the exchange when disposed', async () => {
		const closure = new AbortController()
		const text = new MCPTextStreamController(controlled(parking(), closure))

		await text[Symbol.asyncDispose]()

		expect(closure.signal.aborted).toBe(true)
		await expect(text.next()).rejects.toBeInstanceOf(DOMException)
	})

	// Disposal is the member every pump discharges its ownership through, so it has to end
	// the TYPED exchange rather than this adapter: a pump holding only the serialized arm is
	// still the owner of the producer and the request lifetime behind it.
	it('disposing the serialized face ends the TYPED exchange, not just the adapter', async () => {
		const closure = new AbortController()
		const typed = controlled(parking(), closure)
		const text = new MCPTextStreamController(typed)

		await text[Symbol.asyncDispose]()

		await expect(typed.next()).rejects.toBeInstanceOf(DOMException)
		expect(closure.signal.aborted).toBe(true)
	})

	// The one member that is a narrowing rather than a pass-through, pinned so the prose that
	// describes it cannot drift back to claiming pure delegation. A string is not a
	// `JSONRPCResponse`, so this face has no typed terminal to close on: the typed exchange
	// ends with none, and a cooperating producer sees its cancellation path. The consumer
	// still gets exactly the text it supplied.
	it('ends the typed exchange with no terminal, because a string cannot be one', async () => {
		const viaText: string[] = []
		const viaTyped: string[] = []
		const text = new MCPTextStreamController(controlled(recording(viaText)))
		const typed = controlled(recording(viaTyped))
		await text.next()
		await typed.next()

		const returned = await text.return('{"jsonrpc":"2.0","id":1,"result":{}}')
		await typed.return(TERMINAL)
		await waitForDelay()

		expect(returned).toEqual({ done: true, value: '{"jsonrpc":"2.0","id":1,"result":{}}' })
		expect(viaText).toEqual(['catch', 'finally'])
		// The negative control: the SAME consumer action on the typed face runs the producer's
		// normal return, so the recorder is proved able to tell the two endings apart.
		expect(viaTyped).toEqual(['finally'])
	})

	it('is iterable as the async generator it claims to be', async () => {
		const seen: string[] = []
		for await (const message of new MCPTextStreamController(controlled(replaying([PROGRESS])))) {
			seen.push(message)
		}

		expect(seen).toEqual([JSON.stringify(PROGRESS)])
	})

	it('extends the text stream with the closure the protocol has no member for', () => {
		expectTypeOf<MCPTextStreamControllerInterface>().toExtend<MCPTextStream>()
		expectTypeOf<MCPTextStreamControllerInterface['stop']>().toEqualTypeOf<() => void>()
	})
})
