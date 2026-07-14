import type { JSONRPCMessage } from '@src/core'
import type { StreamInterface } from '@orkestrel/server'
import type { EventStoreEntry, MCPSessionInterface, MCPSessionOptions } from './types.js'
import { DEFAULT_MCP_SESSION_CAPACITY, DEFAULT_MCP_SESSION_TTL } from './constants.js'

/**
 * One MCP transport session — the per-session entity a {@link
 * import('./middlewares.js').createMCPSession} middleware owns, keyed by its `id`, carrying the
 * resumable server→client push channel with its bounded replay log FOLDED IN.
 *
 * @remarks
 * The single session entity (the old `SessionState` + `EventStore` merged): it holds the
 * session `id`, its OWN bounded, replayable log of pushed server→client messages (the
 * resumable GET-SSE channel — a private `#events` `Map` + a monotone `#counter`, with
 * `capacity` / `ttl` eviction, NOT a separate store), and the set of currently OPEN
 * server→client SSE streams (a resumable `GET {path}` registers via `attach`, unregisters via
 * `detach` on disconnect). Still a small entity (not a record), built minimal + extensible.
 *
 * - **`push` is the server-initiated primitive.** It APPENDS the message to the log (assigning
 *   a monotone base36 event id) and FANS it out to every attached stream as one `id:`-tagged
 *   SSE event (`stream.write({ id, data })`). A push with NO attached stream is still logged,
 *   so a client that connects (or reconnects with a `Last-Event-ID`) LATER replays it from the
 *   log. A `write` to a closed stream is a safe no-op (the {@link
 *   `@orkestrel/server`'s `openStream` contract), so a just-disconnected stream that
 *   has not yet been `detach`ed never throws. A replayed event and the live one carry the
 *   IDENTICAL id (the log assigns it once).
 *
 * - **`replay(afterId)` is strictly-after.** It returns every retained log entry whose id sorts
 *   AFTER `afterId` in append order — the missed-events list the `GET {path}` handler writes
 *   before attaching the stream for live pushes. The decision for an UNKNOWN / already-evicted
 *   `afterId` (the client's cursor fell off the back of the capacity window, or never existed):
 *   replay NOTHING. Replaying the whole retained log would re-deliver events the client never
 *   lost (its cursor is OLDER than everything retained); returning `[]` lets the handler then
 *   stream only the fresh pushes that follow `attach` — the spec-sane resume.
 *
 * - **Bounded, append-ordered, plain `Map` (§21).** The log lives in ONE insertion-ordered
 *   `Map<id, entry>` — insertion order IS append order IS id order, so `replay` and capacity
 *   eviction both walk the map directly. NO database mirror — the log is process-local
 *   transport mechanics, not durable state. `push` first drops every entry older than `ttl`
 *   (lazy TTL — no background timer, the middleware's lazy-window idiom), appends, then evicts
 *   the OLDEST entries until at most `capacity` remain; `replay` also runs the lazy TTL sweep
 *   first, so a stale entry is never replayed.
 *
 * - **No transport coupling beyond the SSE seam.** It holds session state + the generic {@link
 *   StreamInterface} handles `attach` was handed — never a raw socket, request, or response.
 *   The middleware opens the stream (the spine seam) and registers it here; this class only
 *   serializes a message onto the already-open streams.
 *
 * - **Injected clock.** `push` / `replay` accept an optional `now` (epoch ms), defaulting to
 *   `Date.now()` — so a test drives TTL eviction with an elapsed clock rather than a real timer
 *   (AGENTS §16).
 *
 * @example
 * ```ts
 * const session = new MCPSession(crypto.randomUUID())
 * session.attach(stream) // an open resumable GET-SSE stream
 * session.push({ jsonrpc: '2.0', method: 'notifications/message', params: { text: 'hi' } })
 * // → logged AND written to `stream` as an `id:`-tagged event; a reconnect replays it
 * ```
 */
export class MCPSession implements MCPSessionInterface {
	readonly #id: string
	readonly #events = new Map<string, EventStoreEntry>()
	readonly #streams = new Set<StreamInterface>()
	readonly #capacity: number
	readonly #ttl: number
	#counter = 0

	constructor(id: string, options?: MCPSessionOptions) {
		this.#id = id
		this.#capacity = options?.capacity ?? DEFAULT_MCP_SESSION_CAPACITY
		this.#ttl = options?.ttl ?? DEFAULT_MCP_SESSION_TTL
	}

	get id(): string {
		return this.#id
	}

	attach(stream: StreamInterface): void {
		this.#streams.add(stream)
	}

	detach(stream: StreamInterface): void {
		this.#streams.delete(stream)
	}

	push(message: JSONRPCMessage, now = Date.now()): string {
		// Append to the log first (assigning the monotone event id), then fan the SAME id out to
		// every open stream — so a replayed event and a live one carry the identical id.
		const id = this.#append(message, now)
		const data = JSON.stringify(message)
		for (const stream of this.#streams) stream.write({ id, data })
		return id
	}

	replay(afterId: string, now = Date.now()): readonly EventStoreEntry[] {
		this.#evict(now)
		const out: EventStoreEntry[] = []
		let found = false
		for (const entry of this.#events.values()) {
			// Collect every entry STRICTLY AFTER `afterId`, in append order.
			if (found) out.push(entry)
			else if (entry.id === afterId) found = true
		}
		// An unknown / evicted `afterId` was never matched → `found` stays false → replay nothing
		// (the documented spec-sane choice; never re-deliver un-lost events).
		return found ? out : []
	}

	// Append a message to the bounded replay log under a fresh monotone id, evicting stale +
	// over-capacity entries — the folded EventStore.append, now private to the session.
	#append(message: JSONRPCMessage, now: number): string {
		// Lazy TTL sweep BEFORE appending so an idle log shrinks as it is written.
		this.#evict(now)
		this.#counter += 1
		const id = this.#counter.toString(36)
		this.#events.set(id, { id, message, timestamp: now })
		// Capacity bound: drop the OLDEST entries (front of the insertion-ordered map) until at
		// most `capacity` remain — so the log is the most-recent `capacity` pushes.
		while (this.#events.size > this.#capacity) {
			const oldest = this.#events.keys().next().value
			if (oldest === undefined) break
			this.#events.delete(oldest)
		}
		return id
	}

	// Drop every entry older than the TTL. Entries are append-ordered (oldest first) and the
	// timestamp is monotone with insertion, so the stale run is a PREFIX — stop at the first live
	// entry. A non-positive ttl is treated as no expiry (nothing ever ages out by time).
	#evict(now: number): void {
		if (this.#ttl <= 0) return
		const cutoff = now - this.#ttl
		for (const [id, entry] of this.#events) {
			if (entry.timestamp <= cutoff) this.#events.delete(id)
			else break
		}
	}
}
