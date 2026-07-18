import type { StartedServerInterface } from '../../../setupServer.js'
import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { createServer as createHTTPServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createMCPClient } from '@src/core'
import { isRecord } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createWebSocketClientTransport, createWebSocketServer } from '@src/server'
import { createCalculatorServer, createTeardown, startServer } from '../../../setupServer.js'

// src/server/mcp/WebSocketClientTransport.ts — the WebSocket CLIENT transport (the egress
// mirror of createWebSocketServer), proven END TO END against the shipped createWebSocketServer
// over a REAL `node:http` server + a REAL MCPServer over a real ToolManager (stub tools, NO live
// model — AGENTS §16). The contract the assertions pin down: `start()` performs the RFC 6455
// handshake (validating the Sec-WebSocket-Accept) and opens a persistent frame channel; an
// MCPClient over it connects + discovers + calls the remote tools over real WS frames; a remote
// tool failure → a local throw; a `ws://` and an `http://` url both reach the endpoint; an
// upgrade declined by the server → `connect()` rejects; `session` is undefined for the stateless
// v1; and `disconnect()` closes cleanly. The per-connection bridge + frame decode/drop are pinned
// at the unit level in WebSocketServerTransport.test.ts (the same ClientTransportInterface).

const teardown = createTeardown<StartedServerInterface>((handle) => handle.stop())

// A raw `node:http` server plus the upgraded sockets it claimed — tracked together so teardown
// can DESTROY each lingering upgrade socket before closing the server.
interface RawServerHandle {
	readonly server: Server
	readonly sockets: Duplex[]
}

// A second registrar for the RAW `node:http` server the bogus-handshake test stands up (it
// writes a malformed 101 by hand, so it cannot be a spine `Server`). Closed in `afterEach` —
// an UPGRADED socket is detached from the server's tracked-connection set, so neither `close`'s
// drain nor `closeAllConnections()` reaches it; destroy each captured socket FIRST, then `close`
// (whose callback now fires promptly, since no connection remains).
const rawTeardown = createTeardown<RawServerHandle>(
	({ server, sockets }) =>
		new Promise<void>((resolve) => {
			for (const socket of sockets) socket.destroy()
			server.close(() => resolve())
		}),
)

// Stand up a server exposing the stub-tool MCPServer over WebSocket (the spine upgrade seam) on
// an ephemeral port. `path` defaults to /mcp; pass a custom one to exercise the path option.
async function startWs(path?: string): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	server.upgrade(
		createWebSocketServer(createCalculatorServer(), path === undefined ? undefined : { path }),
	)
	return teardown.track(await startServer(server))
}

// Stand up a RAW `node:http` server that ANSWERS the upgrade with a structurally-valid 101
// (right `Upgrade` / `Connection` headers) but a BOGUS `Sec-WebSocket-Accept` — so the client's
// `start()` reaches the accept-validation branch and must reject on the mismatch (the security
// check is otherwise vacuously covered: the happy path never feeds a wrong accept). Returns the
// bound `http://…` base; tracked for `afterEach` close.
async function startBogusAcceptServer(): Promise<string> {
	const server = createHTTPServer()
	const sockets: Duplex[] = []
	server.on('upgrade', (_request, socket) => {
		sockets.push(socket) // captured so teardown can destroy this detached upgrade socket
		// The client `socket.destroy()`s its end on the accept mismatch, so this server end sees an
		// ECONNRESET — swallow it (an expected, non-fatal teardown), never an uncaught 'error'.
		socket.on('error', () => {})
		// A well-formed switching-protocols line + headers, but a deliberately WRONG accept value
		// (never `computeWebSocketAccept(key)`), so the handshake fails the accept check.
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				'Sec-WebSocket-Accept: wrong\r\n' +
				'\r\n',
		)
	})
	rawTeardown.track({ server, sockets })
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0
	return `http://127.0.0.1:${port}`
}

describe('WebSocketClientTransport — drive a remote MCP server over WebSocket frames', () => {
	it('connect → tools() → call(add): a value round-trips over real frames (ws:// url)', async () => {
		const handle = await startWs()
		// `handle.base` is http://… — use a ws:// url to prove the scheme conversion path.
		const url = `${handle.base.replace('http://', 'ws://')}/mcp`
		const client = createMCPClient({ transport: createWebSocketClientTransport({ url }) })

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		expect(await client.call('add', {})).toBe(5)

		await client.disconnect()
		expect(client.connected).toBe(false)
	})

	it('accepts an http:// url too (no scheme conversion needed)', async () => {
		const handle = await startWs()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/mcp` }),
		})
		await client.connect()
		expect(client.connected).toBe(true)
		expect(await client.call('add', {})).toBe(5)
		await client.disconnect()
	})

	it('a remote erroring tool throws locally (isError → throw)', async () => {
		const handle = await startWs()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/mcp` }),
		})
		await client.connect()
		await expect(client.call('boom', {})).rejects.toThrow(/kaboom/)
		await client.disconnect()
	})

	it('connect() rejects when the server declines the upgrade (wrong path)', async () => {
		// The server claims only /mcp; a transport pointed at /nope gets its upgrade declined +
		// the socket destroyed, so the client handshake (start, run by connect) rejects.
		const handle = await startWs()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/nope` }),
		})
		// The declined upgrade rejects start() — the underlying socket is destroyed, so the
		// failure is a connection-level Error (a socket hang-up), surfaced by the handshake.
		await expect(client.connect()).rejects.toThrow(Error)
		expect(client.connected).toBe(false)
	})

	it('reaches a custom upgrade path when configured on both ends', async () => {
		const handle = await startWs('/rpc')
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/rpc` }),
		})
		await client.connect()
		expect(await client.call('add', {})).toBe(5)
		await client.disconnect()
	})

	it('the transport session is undefined for the stateless v1', async () => {
		const handle = await startWs()
		const transport = createWebSocketClientTransport({ url: `${handle.base}/mcp` })
		const client = createMCPClient({ transport })
		await client.connect()
		expect(transport.session).toBeUndefined()
		await client.disconnect()
	})

	it('rejects start() when the server returns a 101 with a bogus Sec-WebSocket-Accept', async () => {
		// The server answers a structurally-valid 101 but with `Sec-WebSocket-Accept: wrong` — the
		// handshake-accept check (accept === computeWebSocketAccept(key)) must FAIL, so start()
		// rejects and the socket is destroyed. This PINS that security check: without it (or with a
		// broken compare) the bogus accept would be silently accepted and this would hang/pass-green.
		const base = await startBogusAcceptServer()
		const transport = createWebSocketClientTransport({ url: `${base}/mcp` })
		await expect(transport.start()).rejects.toThrow(/Sec-WebSocket-Accept mismatch/)
		// The happy-path connect (a CORRECT accept → start() resolves) is the control, already
		// proven by the round-trip tests above against the real createWebSocketServer.
	})
})
