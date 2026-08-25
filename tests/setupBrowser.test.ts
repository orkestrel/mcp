// Proof of `tests/setupBrowser.ts` — the peer-observation helpers the duplex claims are read
// through.
//
// The `setup` project runs in Node with the browser disabled, and the module divides cleanly
// along that line. Everything asserted here is host-independent: `createScopeCarrier` wires two
// real `createScopeTransport` halves and never touches a document, `recordPort` taps a real
// `MessagePort` (Node's is the same `EventTarget` contract the page's is), and `drainRecorded`
// reads frames back over a real socket from the real Node fixture. The DOM-driving side is
// `buildElement`, which appends to a live `document` that no Node project has; it is proven by
// no suite at all, because nothing imports it — a proof of it belongs in the `src:browser`
// project, where a document exists.
//
// The carrier and the tap are also driven end to end by `tests/src/browser/factories.test.ts`
// inside Chromium. That suite proves what they carry for a real page; this one proves what they
// promise as instruments — what enters a drain, what a drain clears, and what a decode drops.

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { BrowserFixtureInterface } from './fixtures/browserServer.js'
import { buildJSONRPCResult } from '@src/core'
import { createMessagePortTransport } from '@src/browser'
import { createRecorder } from '@orkestrel/test'
import { createScopeCarrier, drainRecorded, recordPort } from './setupBrowser.js'
import { createJSONRPCRequest, postJSON, waitForSettlement } from './setup.js'
import { start } from './fixtures/browserServer.js'

describe('createScopeCarrier', () => {
	it('carries a frame each way and drains only what the server half received', () => {
		const carrier = createScopeCarrier()
		const inbound = createRecorder<[string]>()
		const outbound = createRecorder<[string]>()
		carrier.server.listen(inbound.handler)
		carrier.client.listen(outbound.handler)
		const request = createJSONRPCRequest({ method: 'tools/list', id: 7 })
		const reply = buildJSONRPCResult(7, { tools: [] })

		carrier.client.send(JSON.stringify(request))

		// The server half received the exact wire text, and the drain reports the decode of it.
		expect(inbound.calls).toEqual([[JSON.stringify(request)]])
		expect(carrier.drain()).toEqual([request])
		// Cleared on read, so a scenario that drains before it drives starts from nothing.
		expect(carrier.drain()).toEqual([])

		carrier.server.send(JSON.stringify(reply))

		// The reverse direction reaches the client half and is NOT part of the drain: the drain
		// is the SERVER half's inbox, which is what makes "the peer received it" falsifiable.
		expect(outbound.calls).toEqual([[JSON.stringify(reply)]])
		expect(carrier.drain()).toEqual([])
	})

	it('drops a payload that is not a JSON-RPC message instead of draining it', () => {
		const carrier = createScopeCarrier()
		const inbound = createRecorder<[string]>()
		carrier.server.listen(inbound.handler)

		carrier.client.send('not json-rpc at all')
		carrier.client.send(JSON.stringify({ hello: 'world' }))

		// Both reached the far end, so the drain saw them and refused them rather than missing them.
		expect(inbound.calls.length).toBe(2)
		expect(carrier.drain()).toEqual([])
	})
})

describe('recordPort', () => {
	it('taps a live port beside the transport already listening on it', async () => {
		const channel = new MessageChannel()
		const drain = recordPort(channel.port1)
		const tapped = createMessagePortTransport({ port: channel.port1 })
		const peer = createMessagePortTransport({ port: channel.port2 })
		const request = createJSONRPCRequest({ method: 'ping', id: 'tap' })
		const arrived = new Promise<string>((resolve) => tapped.listen(resolve))
		try {
			await peer.send(JSON.stringify(request))

			// The transport's own handler still fires: the tap is a second listener on a real
			// `EventTarget`, not a replacement for the one under test.
			expect(await waitForSettlement(arrived)).toBe(JSON.stringify(request))
			expect(drain()).toEqual([request])
			expect(drain()).toEqual([])

			const refused = new Promise<string>((resolve) => tapped.listen(resolve))
			await peer.send('not json-rpc at all')

			// A payload the decode refuses is dropped by the tap and still delivered by the port.
			expect(await waitForSettlement(refused)).toBe('not json-rpc at all')
			expect(drain()).toEqual([])
		} finally {
			await tapped.close()
			await peer.close()
		}
	})
})

describe('drainRecorded', () => {
	let fixture: BrowserFixtureInterface

	beforeAll(async () => {
		fixture = await start()
	})

	afterAll(async () => {
		await fixture.stop()
	})

	it('reads the peer-recorded frames back over the wire and clears them', async () => {
		await drainRecorded(fixture.base)
		const request = createJSONRPCRequest({ method: 'tools/list', id: 11 })

		await postJSON(fixture.base, request)
		await postJSON(fixture.base, { hello: 'world' })

		// Every POST body reaches the fixture's recorder, so the second one is a frame the
		// decode refuses rather than a frame that never arrived.
		expect(await drainRecorded(fixture.base)).toEqual([request])
		expect(await drainRecorded(fixture.base)).toEqual([])
	})
})
