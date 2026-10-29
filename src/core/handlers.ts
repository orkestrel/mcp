import type { MCPClientInterface, MCPDispatcherInterface, MCPTransportInterface } from './types.js'
import { parseJSON } from '@orkestrel/contract'
import { parseJSONRPCMessage } from './parsers.js'
import { MCPServerBinding } from './MCPServerBinding.js'

/**
 * Pipes an {@link MCPTransportInterface} into an {@link MCPDispatcherInterface} — every
 * inbound message runs through `server.handle`, and a defined reply is written back
 * through `transport.send`.
 *
 * @remarks
 * `server.handle` already turns a malformed message into a serialized `-32700` /
 * `-32600` reply and a notification into `undefined` (no reply), so this binder parses
 * nothing the server would parse differently: it decodes each inbound message through
 * {@link decodeBoundedMessage} under `server.limit`, the server's own bound, so a message
 * the server would refuse is never parsed here either and still receives its `-32700` from
 * the one place that words it. A held-open reply arrives as an
 * {@link import('./types.js').MCPTextStreamControllerInterface} instead of a string: this is
 * the one place that pumps it, writing each notification in order and then the generator's
 * returned terminating response ({@link sendStream}). A `transport.send` throw or rejection —
 * mid-stream included — is caught and routed
 * to `server.emitter`'s `error` event (never rethrown, never an unhandled rejection);
 * a listener on that event that itself throws is swallowed (the end of the line —
 * the caller's own bug, never this binder's). A fault raised after its own request was
 * cancelled reports nothing, because a cancellation is not a fault.
 *
 * **This binder owns every exchange it starts, and ends each one on every exit.** It holds one
 * `AbortController` per live request, keyed by the request's id and deleted whenever that
 * request leaves — normally, by a throw, or by cancellation — and it supplies that signal to
 * `handle` as {@link import('./types.js').MCPDispatchOptions}. These consequences follow.
 * An inbound `notifications/cancelled` aborts the request it names, which is how the message-
 * based cancellation path reaches a tool on the carriers that have one (stdio, WebSocket,
 * `MessagePort`); a cancelled request writes no response, because a peer that asked for a call
 * to stop is not answered by it; and the transport's `closed` signal aborts every request
 * still in flight, so an exchange being pumped when the carrier dies ends with it instead of
 * writing into a socket nobody is holding.
 *
 * `listen`/`closed` are replace semantics (§ port contract): the returned unbind
 * detaches by replacing this binder's own handlers with no-ops, so a subsequent
 * `bindServer` call on the same transport is never double-dispatched by a stale
 * subscription left behind — an unbind→rebind cycle yields exactly one reply per
 * request. Unbinding is itself an owner exit: it aborts and retires every request still in
 * flight before detaching, so `unbind()` then `close()` and `close()` then `unbind()` end the
 * same exchanges. It does not close the transport; that remains the caller's decision.
 *
 * @param server - The transport-agnostic server to dispatch inbound messages over
 * @param transport - The duplex channel to pipe the server over
 * @returns Detach this binder from the transport (does not close it)
 *
 * @example
 * ```ts
 * const unbind = bindServer(server, transport)
 * // ... later, detach without closing:
 * unbind()
 * ```
 */
export function bindServer(
	server: MCPDispatcherInterface,
	transport: MCPTransportInterface,
): () => void {
	const binding = new MCPServerBinding(server, transport)
	return binding.stop.bind(binding)
}

/**
 * Pipes an {@link MCPTransportInterface} into an {@link MCPClientInterface} — every
 * inbound message is decoded and delivered onto the client's own transport
 * (`client.transport.emitter`'s `message` / `close` events), resolving/rejecting the
 * client's correlated pending requests exactly as a direct reply would.
 *
 * @remarks
 * The client's outbound writes flow through `client.transport.send` — its existing,
 * unmodified request/response correlation — so `client` must have been constructed
 * with a {@link import('./types.js').MCPMessageTransportInterface} that itself carries
 * the same `transport` (see {@link import('./factories.js').createDuplexClientTransport},
 * the additive factory that adapts an {@link MCPTransportInterface} into that shape);
 * this binder then completes the inbound half by decoding each message and pushing it
 * onto `client.transport.emitter` (an {@link import('@orkestrel/emitter').EmitterInterface}
 * exposes `emit`, so no client modification is needed). A malformed / non-JSON-RPC
 * inbound message is dropped (total — never throws); a delivery fault is routed to
 * `client.transport.emitter`'s `error` event (never rethrown). The returned unbind
 * detaches this binder (further inbound messages and the transport's `closed` signal are
 * ignored) without closing the transport.
 *
 * `listen`/`closed` are replace semantics (§ port contract): the returned unbind
 * detaches by replacing this binder's own handlers with no-ops, so a subsequent
 * `bindClient` call on the same transport is never double-dispatched by a stale
 * subscription left behind — an unbind→rebind cycle delivers exactly one `message`
 * emit per inbound reply.
 *
 * **This binder needs no live-request registry, and the asymmetry with {@link bindServer} is
 * real rather than an omission.** A server binder holds the lifetime of work it started, so an
 * inbound `notifications/cancelled` has something to reach; a client binder starts no work —
 * `MCPClient` already owns its pending entries and already writes the cancellation frame
 * itself when a caller's `signal` aborts, on a carrier declaring `duplex`. Adding a registry
 * here would be a second correlation table for ids the client is already correlating, and a
 * pair of tables for one fact drift. The one obligation this binder does carry is delivery: a
 * malformed / non-JSON-RPC inbound message is dropped (total — never throws).
 *
 * @param client - The transport-agnostic client whose transport to deliver messages onto
 * @param transport - The duplex channel to pipe the client over
 * @returns Detach this binder from the transport (does not close it)
 *
 * @example
 * ```ts
 * const client = createMCPClient({ transport: createDuplexClientTransport(transport) })
 * const unbind = bindClient(client, transport)
 * await client.connect()
 * // ... later, detach without closing:
 * unbind()
 * ```
 */
export function bindClient(
	client: MCPClientInterface,
	transport: MCPTransportInterface,
): () => void {
	const lifetime = new AbortController()
	transport.listen((message) => {
		if (lifetime.signal.aborted) return
		const decoded = parseJSONRPCMessage(parseJSON(message))
		if (decoded === undefined) return
		try {
			client.transport.emitter.emit('message', decoded)
		} catch (error) {
			try {
				client.transport.emitter.emit('error', error)
			} catch {
				// A throwing `error` listener is the caller's own bug — the end of the line.
			}
		}
	})
	transport.closed(() => {
		if (lifetime.signal.aborted) return
		lifetime.abort()
		try {
			client.transport.emitter.emit('close')
		} catch {
			// A throwing `close` listener is the caller's own bug — the end of the line.
		}
	})
	return () => {
		lifetime.abort()
		transport.listen(() => {})
		transport.closed(() => {})
	}
}
