import type { JSONRPCMessage } from '@src/core'
import type { SSEMessage, StreamInterface } from '@orkestrel/server'
import { describe, expect, it } from 'vitest'
import { MCPSession } from '@src/server'
import { createJSONRPCRequest, createRecorder } from '../../setup.js'

// src/server/MCPSession.ts — one MCP transport session, the per-session entity a
// `createMCPSession` middleware owns, with its bounded resumable replay log FOLDED IN (the old
// SessionState + EventStore merged into one class). Pure mechanics (NO server, NO live model):
// `push` appends to the folded log under a MONOTONE base36 id (returned) AND fans the message out
// to every `attach`ed (and not-yet-`detach`ed) SSE stream; `replay(afterId)` returns the entries
// STRICTLY AFTER `afterId` in order (and NOTHING for an unknown / evicted cursor — the spec-sane
// resume); capacity evicts the OLDEST past the bound; and the OPTIONAL per-event TTL evicts a
// stale entry lazily. The time-reading methods accept an explicit `now` (default `Date.now()`),
// so the TTL path is driven with an elapsed clock deterministically (AGENTS §16). The over-the-
// wire mint / validate / push / replay flow is proven through a real server in middlewares.test.ts.

// A distinct JSON-RPC message per ordinal, so a replayed sequence is identifiable by content.
function message(n: number): JSONRPCMessage {
	return createJSONRPCRequest({ method: 'notifications/message', id: n })
}

// A REAL recording StreamInterface (single-use to this file, so local — AGENTS §16.1): its
// `write` records each SSEMessage into a recorder; the other methods are inert. NOT a mock of
// behaviour — a genuine sink standing in for an open GET-SSE stream so `push`'s fan-out is
// observable without a socket. `writes()` is a function (not a getter), so a caller reads the LIVE
// recorded list after each push rather than a stale snapshot.
function recordingStream(): {
	readonly stream: StreamInterface
	readonly writes: () => readonly SSEMessage[]
} {
	const recorder = createRecorder<readonly [SSEMessage]>()
	const stream: StreamInterface = {
		response: new Response(null),
		closed: false,
		write: (event) => recorder.handler(event),
		comment: () => {},
		end: () => {},
	}
	return { stream, writes: () => recorder.calls.map(([event]) => event) }
}

describe('MCPSession — id', () => {
	it('exposes the id it was constructed with', () => {
		expect(new MCPSession('sess-abc').id).toBe('sess-abc')
	})
})

describe('MCPSession — push appends to the folded log with monotone ids', () => {
	it('push returns a fresh base36 id each call (strictly increasing)', () => {
		const session = new MCPSession('s')
		const ids = [message(1), message(2), message(3)].map((m) => session.push(m))
		// base36 of 1,2,3 → '1','2','3' — monotone, never reused, never out of order.
		expect(ids).toEqual(['1', '2', '3'])
	})

	it('a push with NO attached stream is still logged (replayable later)', () => {
		const session = new MCPSession('s')
		const first = session.push(message(1))
		session.push(message(2))
		// No stream attached — the pushes are logged so a client that connects LATER replays them.
		expect(session.replay(first).map((entry) => entry.message)).toEqual([message(2)])
	})
})

describe('MCPSession — push fans out to attached streams', () => {
	it('push writes the message to an attached stream as an id-tagged SSE event', () => {
		const session = new MCPSession('s')
		const { stream, writes } = recordingStream()
		session.attach(stream)
		const sent = message(1)
		const id = session.push(sent)
		expect(writes()).toHaveLength(1)
		const event = writes()[0]
		// The fanned-out event carries the SAME id `push` returned, and the message as `data`.
		expect(event?.data).toBe(JSON.stringify(sent))
		expect(event?.id).toBe(id)
	})

	it('push fans out to EVERY attached stream (the same id reaches both)', () => {
		const session = new MCPSession('s')
		const a = recordingStream()
		const b = recordingStream()
		session.attach(a.stream)
		session.attach(b.stream)
		session.push(message(1))
		expect(a.writes()).toHaveLength(1)
		expect(b.writes()).toHaveLength(1)
		expect(a.writes()[0]?.id).toBe(b.writes()[0]?.id)
	})

	it('a detached stream stops receiving pushes (but the message is still logged)', () => {
		const session = new MCPSession('s')
		const { stream, writes } = recordingStream()
		session.attach(stream)
		const first = session.push(message(1))
		session.detach(stream)
		session.push(message(2)) // not delivered to the detached stream
		expect(writes()).toHaveLength(1) // only the pre-detach push reached the stream
		// BOTH are logged — a later reconnect can replay #2.
		expect(session.replay(first).map((entry) => entry.message)).toEqual([message(2)])
	})
})

describe('MCPSession — replay returns the strictly-after entries in order', () => {
	it('replay(afterId) returns every entry after it, in append order', () => {
		const session = new MCPSession('s')
		const first = session.push(message(1))
		session.push(message(2))
		session.push(message(3))
		const replayed = session.replay(first)
		expect(replayed.map((entry) => entry.message)).toEqual([message(2), message(3)])
		// The ids ride on each replayed entry (the value the client re-resumes from).
		expect(replayed.every((entry) => typeof entry.id === 'string')).toBe(true)
	})

	it('replay(lastId) returns nothing when no entry follows the last id', () => {
		const session = new MCPSession('s')
		session.push(message(1))
		const last = session.push(message(2))
		expect(session.replay(last)).toEqual([])
	})

	it('replay of an UNKNOWN / never-seen id returns nothing (the spec-sane resume)', () => {
		// A cursor that names no retained entry → replay nothing (never re-deliver un-lost events).
		const session = new MCPSession('s')
		session.push(message(1))
		session.push(message(2))
		expect(session.replay('does-not-exist')).toEqual([])
	})
})

describe('MCPSession — capacity eviction (oldest dropped past the bound)', () => {
	it('retains at most capacity entries, evicting the oldest', () => {
		const session = new MCPSession('s', { capacity: 2 })
		const first = session.push(message(1))
		session.push(message(2))
		session.push(message(3)) // pushes the count to 3 → the oldest (first) is evicted
		// The first entry fell off the back — an evicted cursor replays nothing.
		expect(session.replay(first)).toEqual([])
		// The surviving tail (#2, #3) is intact — a cursor at #2 still replays #3.
		const survivors = session.replay('2') // base36 id of the 2nd push
		expect(survivors.map((entry) => entry.message)).toEqual([message(3)])
	})

	it('an evicted-cursor replay yields nothing even though newer entries are retained', () => {
		// capacity 2: push 4 → only #3,#4 survive. Resuming from the EVICTED #1 must replay NOTHING
		// (the cursor fell off the back), not the surviving tail — else a far-behind client would be
		// handed events out of its own sequence context.
		const session = new MCPSession('s', { capacity: 2 })
		const first = session.push(message(1))
		session.push(message(2))
		session.push(message(3))
		session.push(message(4))
		expect(session.replay(first)).toEqual([])
	})
})

describe('MCPSession — lazy TTL eviction (injected clock)', () => {
	it('an entry older than the ttl is evicted on the next push', () => {
		// ttl = 1000ms. Push at t=0; at t=1000 (>= ttl idle) the first is stale and is swept on the
		// next push, leaving only the fresh one — so replay from the stale id finds nothing.
		const session = new MCPSession('s', { ttl: 1_000 })
		const stale = session.push(message(1), 0)
		session.push(message(2), 1_000) // the push's sweep drops the t=0 entry
		expect(session.replay(stale, 1_000)).toEqual([])
	})

	it('replay sweeps stale entries first, so an expired entry is never replayed', () => {
		const session = new MCPSession('s', { ttl: 1_000 })
		const first = session.push(message(1), 0)
		session.push(message(2), 0)
		// Read at t=2000: both t=0 entries are stale and swept → replay finds neither.
		expect(session.replay(first, 2_000)).toEqual([])
	})

	it('an entry within the ttl window is retained', () => {
		const session = new MCPSession('s', { ttl: 1_000 })
		const first = session.push(message(1), 0)
		session.push(message(2), 999) // within the window — both retained
		// At t=999 (< ttl) the first is still live, so the cursor at it replays the second.
		expect(session.replay(first, 999).map((entry) => entry.message)).toEqual([message(2)])
	})

	it('with ttl disabled (0) an entry never ages out, however far the clock advances', () => {
		const session = new MCPSession('s', { ttl: 0 })
		const first = session.push(message(1), 0)
		session.push(message(2), Number.MAX_SAFE_INTEGER)
		expect(session.replay(first, Number.MAX_SAFE_INTEGER).map((entry) => entry.message)).toEqual([
			message(2),
		])
	})
})

describe('MCPSession — push return id round-trips with the fanned-out event', () => {
	it('the id push returns equals the attached stream event id and is replayable', () => {
		const session = new MCPSession('s')
		const { stream, writes } = recordingStream()
		session.attach(stream)
		session.push(message(1))
		const id = session.push(message(2))
		// The 2nd push's returned id matches the 2nd fanned-out event, and replaying strictly after
		// the FIRST event's id surfaces exactly the 2nd message (proving the log + fan-out agree).
		const events: readonly SSEMessage[] = writes()
		expect(events[1]?.id).toBe(id)
		const firstId = events[0]?.id ?? ''
		expect(session.replay(firstId).map((entry) => entry.message)).toEqual([message(2)])
	})
})

// A tiny compile-time guard that `EventStoreEntry` is the unit `replay` yields (the kept type).
describe('MCPSession — replay entries carry id + message + timestamp', () => {
	it('each replayed entry exposes its id, message, and timestamp', () => {
		const session = new MCPSession('s')
		const first = session.push(message(1), 1_000)
		session.push(message(2), 2_000)
		// Read at t=2000 (within the per-event TTL of both timestamps) so neither is TTL-swept; the
		// strictly-after entry carries its id / message / appended timestamp.
		const [entry] = session.replay(first, 2_000)
		expect(entry?.id).toBeDefined()
		expect(entry?.message).toEqual(message(2))
		expect(entry?.timestamp).toBe(2_000)
	})
})
