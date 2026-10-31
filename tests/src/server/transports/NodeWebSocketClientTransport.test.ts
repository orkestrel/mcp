import type { JSONRPCMessage } from '@src/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createMCPClient,
	DEFAULT_MCP_CACHE_TTL,
	MCP_META_SERVER,
	MCP_MODERN_VERSION,
} from '@src/core'
import { createNodeWebSocketClientTransport } from '@src/server'
import { createTeardown, waitForDelay } from '@orkestrel/test'
import { MCPFixtureCell, MODERN_METADATA } from '../../../setup.js'
import {
	startWs,
	startBogusAcceptServer,
	startHoldingPeer,
	startClosingPeer,
	startUpgradeServer,
} from '../../../setupServer.js'

// src/server/mcp/NodeWebSocketClientTransport.ts — the WebSocket CLIENT transport (the egress
// mirror of createWebSocketServer), proven END TO END against the shipped createWebSocketServer
// over a REAL `node:http` server + a REAL MCPServer over a real ToolManager (stub tools, NO live
// model). The contract the assertions pin down: `start()` performs the RFC 6455
// handshake (validating the Sec-WebSocket-Accept) and opens a persistent frame channel; an
// MCPClient over it connects + discovers + calls the remote tools over real WS frames; a remote
// tool failure → a local throw; a `ws://` and an `http://` url both reach the endpoint; an
// upgrade declined by the server → `connect()` rejects; `session` is undefined for the stateless
// v1; and `disconnect()` closes cleanly. The per-connection bridge + frame decode/drop are pinned
// at the unit level in WebSocketServerTransport.test.ts (the same MCPMessageTransportInterface).

const teardown = createTeardown()
afterEach(() => teardown.destroy())

// Teardown runs newest-first because a client is acquired after the server it connects to and must
// close before that server stops. An upgraded WebSocket is detached from the connection set that
// `closeIdleConnections()` and `closeAllConnections()` walk, so neither call reaches it. The owner
// must close the socket before the raw server can finish closing.

// Stand up a server exposing the stub-tool MCPServer over WebSocket (the spine upgrade seam) on
// an ephemeral port. `path` defaults to /mcp; pass a custom one to exercise the path option.
describe('NodeWebSocketClientTransport — drive a remote MCP server over WebSocket frames', () => {
	it('connect → tools() → call(add): a value round-trips over real frames (ws:// url)', async () => {
		const handle = await startWs(teardown)
		// `handle.base` is http://… — use a ws:// url to prove the scheme conversion path.
		const url = `${handle.base.replace('http://', 'ws://')}/mcp`
		const client = createMCPClient({ transport: createNodeWebSocketClientTransport({ url }) })

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		expect(await client.call('add', {})).toEqual({ resultType: 'complete', value: 5 })

		await client.disconnect()
		expect(client.connected).toBe(false)
	})

	it('accepts an http:// url too (no scheme conversion needed)', async () => {
		const handle = await startWs(teardown)
		const client = createMCPClient({
			transport: createNodeWebSocketClientTransport({ url: `${handle.base}/mcp` }),
		})
		await client.connect()
		expect(client.connected).toBe(true)
		expect(await client.call('add', {})).toEqual({ resultType: 'complete', value: 5 })
		await client.disconnect()
	})

	it('a remote erroring tool throws locally (isError → throw)', async () => {
		const handle = await startWs(teardown)
		const client = createMCPClient({
			transport: createNodeWebSocketClientTransport({ url: `${handle.base}/mcp` }),
		})
		await client.connect()
		await expect(client.call('boom', {})).rejects.toThrow(/kaboom/)
		await client.disconnect()
	})

	it('connect() rejects when the server declines the upgrade (wrong path)', async () => {
		// The server claims only /mcp; a transport pointed at /nope gets its upgrade declined +
		// the socket destroyed, so the client handshake (start, run by connect) rejects.
		const handle = await startWs(teardown)
		const client = createMCPClient({
			transport: createNodeWebSocketClientTransport({ url: `${handle.base}/nope` }),
		})
		// The declined upgrade rejects start() — the underlying socket is destroyed, so the
		// failure is a connection-level Error (a socket hang-up), surfaced by the handshake.
		await expect(client.connect()).rejects.toThrow(Error)
		expect(client.connected).toBe(false)
	})

	it('reaches a custom upgrade path when configured on both ends', async () => {
		const handle = await startWs(teardown, '/rpc')
		const client = createMCPClient({
			transport: createNodeWebSocketClientTransport({ url: `${handle.base}/rpc` }),
		})
		await client.connect()
		expect(await client.call('add', {})).toEqual({ resultType: 'complete', value: 5 })
		await client.disconnect()
	})

	it('the transport session is undefined for the stateless v1', async () => {
		const handle = await startWs(teardown)
		const transport = createNodeWebSocketClientTransport({ url: `${handle.base}/mcp` })
		const client = createMCPClient({ transport })
		await client.connect()
		expect(transport.session).toBeUndefined()
		await client.disconnect()
	})

	// ── D2: `start()` re-asks after the suspension ───────────────────────────
	//
	// `start()` guards on `#socket === undefined`, then SUSPENDS across a real TCP connect and
	// HTTP upgrade before installing the socket it built. Every state it checked is stale by the
	// time the upgrade arrives: a second `start()` has run the same guard, or `close()` has ended
	// the transport. The observable is the peer's own tally — an upgraded socket nobody owns is
	// never closed by anyone, so it stays open forever, and that is exactly what an orphan is.

	it('two concurrent start()s bind one socket and orphan none', async () => {
		// The handshake is held open, so both upgrades are genuinely in flight at the same time
		// and both `start()` calls have already passed the `#socket === undefined` guard.
		const peer = await startUpgradeServer({ delay: 25 })
		teardown.add(() => peer.stop())
		const transport = createNodeWebSocketClientTransport({ url: `${peer.base}/mcp` })

		await Promise.all([transport.start(), transport.start()])
		expect(peer.count).toBe(2) // the peer really did upgrade twice — the race happened

		await transport.close()
		await waitForDelay(60)
		// `close()` can only close the socket the transport HOLDS. Zero still open means the
		// loser was destroyed the moment it arrived; one means it is bound, live, and unreachable.
		expect(peer.open).toBe(0)
	})

	// The control, from OUTSIDE the population the row above covers: a SINGLE `start()`, which
	// must still install exactly one live socket. An instrument that only ever races two starts
	// cannot tell "re-asked correctly" from "never installs anything".
	it('a single start() still installs one live socket', async () => {
		const peer = await startUpgradeServer()
		teardown.add(() => peer.stop())
		const transport = createNodeWebSocketClientTransport({ url: `${peer.base}/mcp` })

		await transport.start()
		await waitForDelay(20)
		expect(peer.count).toBe(1)
		expect(peer.open).toBe(1) // BOUND and live — not destroyed by an over-eager re-ask

		await transport.close()
		await waitForDelay(60)
		expect(peer.open).toBe(0)
	})

	it('ignores the old socket close after a new socket has replaced it', async () => {
		const handle = await startWs(teardown)
		const transport = createNodeWebSocketClientTransport({ url: `${handle.base}/mcp` })
		const messages: JSONRPCMessage[] = []
		const closed = new MCPFixtureCell(0)
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('close', () => (closed.value += 1))
		await transport.start()

		await transport.close()
		await transport.start()
		await waitForDelay(60)

		expect(closed.value).toBe(1)
		// `server/discover` is the canary because it is the modern era's own required RPC.
		// 2026-07-28 removes `ping`, so the reply that proves the replacement socket carries
		// traffic has to be one the bare server still answers.
		await transport.send({
			jsonrpc: '2.0',
			method: 'server/discover',
			id: 2,
			params: { _meta: MODERN_METADATA },
		})
		await waitForDelay(60)
		expect(messages).toEqual([
			{
				jsonrpc: '2.0',
				id: 2,
				result: {
					resultType: 'complete',
					supportedVersions: [MCP_MODERN_VERSION],
					capabilities: { tools: { listChanged: true } },
					ttlMs: DEFAULT_MCP_CACHE_TTL,
					cacheScope: 'private',
					_meta: {
						[MCP_META_SERVER]: { name: 'calculator', version: '1.0.0' },
					},
				},
			},
		])
		await transport.close()
	})

	it('a socket that is never restarted still fires close exactly once', async () => {
		const handle = await startWs(teardown)
		const transport = createNodeWebSocketClientTransport({ url: `${handle.base}/mcp` })
		const closed = new MCPFixtureCell(0)
		transport.emitter.on('close', () => (closed.value += 1))
		await transport.start()

		await transport.close()
		await waitForDelay(60)

		expect(closed.value).toBe(1)
	})

	it('close() during a suspended start() leaves no bound socket and re-emits nothing', async () => {
		// The peer appends one well-formed JSON-RPC text frame to the handshake, so a socket the
		// transport BOUND re-emits it on `message`; one it never bound cannot.
		const peer = await startUpgradeServer({
			delay: 60,
			frame: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
		})
		teardown.add(() => peer.stop())
		const transport = createNodeWebSocketClientTransport({ url: `${peer.base}/mcp` })
		const received: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => received.push(message))

		const starting = transport.start()
		// Wait for the upgrade to REACH the peer, so the close lands on a handshake in progress
		// rather than on a connection that was never made.
		await waitForDelay(20)
		await transport.close() // while the upgrade is still on the wire
		await starting
		await waitForDelay(120)

		expect(peer.count).toBe(1) // the upgrade DID reach the peer — the vector reached the code
		expect(peer.open).toBe(0) // and nothing was left holding that connection open
		expect(received).toEqual([]) // a socket that was never bound re-emits nothing
		await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' })).rejects.toThrow(
			/not connected/,
		)
	})

	it('binds exactly one socket when two start() calls race, destroying the loser', async () => {
		// Both handshakes complete; the second socket to arrive finds one already installed and
		// is destroyed rather than bound, so no orphan is left re-emitting frames at nobody.
		const peer = await startUpgradeServer()
		teardown.add(() => peer.stop())
		const transport = createNodeWebSocketClientTransport({ url: `${peer.base}/mcp` })

		await Promise.all([transport.start(), transport.start()])
		await waitForDelay(60)

		expect(peer.count).toBe(2) // two upgrades were answered
		expect(peer.open).toBe(1) // exactly one socket survives — the bound one
		await transport.close()
		await waitForDelay(60)
		expect(peer.open).toBe(0)
	})

	it('rejects start() when the server returns a 101 with a bogus Sec-WebSocket-Accept', async () => {
		// The server answers a structurally-valid 101 but with `Sec-WebSocket-Accept: wrong` — the
		// handshake-accept check (accept === computeWebSocketAccept(key)) must FAIL, so start()
		// rejects and the socket is destroyed. This PINS that security check: without it (or with a
		// broken compare) the bogus accept would be silently accepted and this would hang/pass-green.
		const base = await startBogusAcceptServer(teardown)
		const transport = createNodeWebSocketClientTransport({ url: `${base}/mcp` })
		await expect(transport.start()).rejects.toThrow(/Sec-WebSocket-Accept mismatch/)
		// The happy-path connect (a CORRECT accept → start() resolves) is the control, already
		// proven by the round-trip tests above against the real createWebSocketServer.
	})
})

// A raw peer that answers the upgrade with a real `101` and then HOLDS the socket, so the
// test decides when a frame reaches the client. `send` writes one unmasked text frame (the
// server-to-client direction, RFC 6455 §5.3), which is how a frame still on the wire when a
// client closes is reproduced deterministically.
describe('NodeWebSocketClientTransport — close releases what the connect acquired', () => {
	it('close() during a pending upgrade cancels the request instead of waiting for the peer', async () => {
		// The peer holds the handshake for 400ms, so an upgrade this transport cannot cancel
		// leaves `start()` suspended for the peer's whole delay.
		const peer = await startUpgradeServer({ delay: 400 })
		teardown.add(() => peer.stop())
		const transport = createNodeWebSocketClientTransport({ url: `${peer.base}/mcp` })
		const starting = transport.start()
		await waitForDelay(30)

		await transport.close()

		// A cancelled upgrade settles `start()` well before the peer answers; an uncancellable
		// one settles only when the 101 finally arrives.
		await expect(
			Promise.race([
				starting.then(() => 'settled').catch(() => 'settled'),
				waitForDelay(120).then(() => 'pending'),
			]),
		).resolves.toBe('settled')
		expect(peer.count).toBe(1) // the upgrade reached the peer
		expect(peer.open).toBe(0) // and the socket carrying it is gone
	})

	it('rejects a send issued after close() as not connected', async () => {
		const handle = await startWs(teardown)
		const transport = createNodeWebSocketClientTransport({ url: `${handle.base}/mcp` })
		await transport.start()

		// The control, from the state this assertion is NOT about: while the socket is bound the
		// same call resolves against the real shipped server, so the rejection below reports the
		// closed state rather than a `send` that never worked.
		await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).resolves.toBeUndefined()

		await transport.close()

		// `MCPMessageTransportInterface.send` has a channel that cannot confirm a write answer a
		// closed channel from its own state. This transport's state is the released socket and its
		// answer is a REJECTION — not the browser face's silent drop, and not a queue that would
		// hold the message for a connection this transport can no longer open.
		await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' })).rejects.toThrow(
			'WebSocket transport is not connected',
		)
	})

	it('rejects a send on a bound socket the peer already closed, and writes no frame', async () => {
		// `#socket === undefined` cannot answer this state: the socket IS bound. The peer's close
		// was decoded inside `createNodeWebSocket`, so this transport's `close` never fired and its
		// own flag is clear — the wrapper's `readyState` is the SECOND source that knows the
		// channel is gone, the same reading the server-side carrier makes. Without it the wrapper
		// drops the write, reports nothing, and this `send` resolves on a frame nobody wrote.
		const base = await startClosingPeer(teardown)
		const transport = createNodeWebSocketClientTransport({ url: `${base}/mcp` })
		const closed = new MCPFixtureCell(0)
		transport.emitter.on('close', () => (closed.value += 1))

		await transport.start()

		expect(closed.value).toBe(0) // the transport learned nothing — the state is the socket's alone
		await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(
			'WebSocket transport is not connected',
		)
		// The control from the state this row is NOT about — a bound, OPEN socket resolving the
		// same call — is the first assertion of the preceding row, against the real shipped server.
	})

	it('rejects a send issued before start(), where the browser face queues one', async () => {
		// The faces diverge here, and the guide says so: the browser face holds a pre-open send
		// and flushes it when its socket opens, while this one holds no connection to flush a
		// message onto and refuses rather than promising a write it cannot schedule.
		const handle = await startWs(teardown)
		const transport = createNodeWebSocketClientTransport({ url: `${handle.base}/mcp` })

		await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(
			'WebSocket transport is not connected',
		)

		// The control: the same call on the same transport resolves once `start()` has bound a
		// socket, so the refusal reports the missing connection rather than a `send` that never
		// works, and nothing the refusal held is flushed onto the socket that follows.
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()
		await expect(
			transport.send({
				jsonrpc: '2.0',
				method: 'server/discover',
				id: 2,
				params: { _meta: MODERN_METADATA },
			}),
		).resolves.toBeUndefined()
		await waitForDelay(60)

		expect(messages.map((message) => message.id)).toEqual([2])
		await transport.close()
	})

	it('close() releases the socket subscriptions — a later frame emits nothing', async () => {
		const peer = await startHoldingPeer(teardown)
		const transport = createNodeWebSocketClientTransport({ url: `${peer.base}/mcp` })
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()

		// Control: while the transport is open the peer's frame reaches it.
		peer.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
		await waitForDelay(40)
		expect(messages).toHaveLength(1)

		await transport.close()
		// The peer has not answered the close frame, so this one is still decodable wire.
		peer.send(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }))
		await waitForDelay(40)

		expect(messages).toHaveLength(1)
		expect(errors).toEqual([])
	})
})
