// Browser-only test infrastructure — DOM, real page globals, and the in-page carrier
// peers the duplex proof observes. Loaded by the `src:browser` project only.

import type { JSONRPCMessage } from '@src/core'
import type { ScopeTransportInterface, ServeMCPScopeInterface } from '@src/browser'
import { createScopeTransport, decodeEvent } from '@src/browser'
import { isArray, isString } from '@orkestrel/contract'

/** Append a real element to the browser document for one test. */
export function buildElement(tag = 'div'): HTMLElement {
	const element = document.createElement(tag)
	document.body.append(element)
	return element
}

// ── Peer observation ─────────────────────────────────────────────────────────
//
// `duplex` is a claim about what reaches the OTHER end, so every one of these returns a
// drain over what a real peer actually received. None of them stands in for the carrier
// under test: the port tap is a SECOND listener on a real `MessagePort`, the scope pair is
// real `createScopeTransport` halves wired to each other, and the fixture drain reads
// frames a real Node peer recorded off a real socket.

/**
 * Tap a live `MessagePort` and return a drain over the JSON-RPC frames it has received.
 *
 * @remarks
 * A `MessagePort` is a real `EventTarget`, so this adds a second listener beside the
 * transport's own rather than displacing it — the transport under test keeps working
 * exactly as it does in production and the tap merely watches the same real events.
 *
 * @param port - The peer-side port half to observe
 * @returns A drain returning every frame received since the last call, then clearing
 *
 * @example
 * ```ts
 * const drain = recordPort(port1)
 * expect(drain()).toEqual([])
 * ```
 */
export function recordPort(port: MessagePort): () => readonly JSONRPCMessage[] {
	const frames: JSONRPCMessage[] = []
	port.addEventListener('message', (event: MessageEvent) => {
		const message = isString(event.data) ? decodeEvent(event.data) : undefined
		if (message !== undefined) frames.push(message)
	})
	return () => frames.splice(0, frames.length)
}

/** A wired pair of real `createScopeTransport` halves, plus what the SERVER half received. */
export interface TestScopeCarrierInterface {
	/** The client half — hand it to `createDuplexClientTransport` and `bindClient`. */
	readonly client: ScopeTransportInterface
	/** The server half — hand it to `bindServer`. */
	readonly server: ScopeTransportInterface
	/** Every JSON-RPC frame the server half received, cleared on read. */
	drain(): readonly JSONRPCMessage[]
}

/**
 * Wire real {@link createScopeTransport} halves into one in-page duplex carrier.
 *
 * @remarks
 * Each half is the shipped factory over a minimal {@link ServeMCPScopeInterface} whose
 * `postMessage` hands the string to the OTHER half's `deliver` — which is precisely how a
 * dedicated worker's implicit channel behaves, with the structured-clone hop removed. No
 * project-owned behaviour is reimplemented: both transports are the real ones.
 *
 * @returns The wired halves and the server half's frame drain
 *
 * @example
 * ```ts
 * const carrier = createScopeCarrier()
 * bindServer(createCalculatorServer(), carrier.server)
 * ```
 */
export function createScopeCarrier(): TestScopeCarrierInterface {
	const frames: JSONRPCMessage[] = []
	let client: ScopeTransportInterface | undefined = undefined
	let server: ScopeTransportInterface | undefined = undefined
	const clientScope: ServeMCPScopeInterface = {
		postMessage(message: unknown): void {
			if (!isString(message)) return
			const decoded = decodeEvent(message)
			if (decoded !== undefined) frames.push(decoded)
			server?.deliver(message)
		},
		addEventListener(): void {},
		removeEventListener(): void {},
	}
	const serverScope: ServeMCPScopeInterface = {
		postMessage(message: unknown): void {
			if (isString(message)) client?.deliver(message)
		},
		addEventListener(): void {},
		removeEventListener(): void {},
	}
	client = createScopeTransport(clientScope)
	server = createScopeTransport(serverScope)
	return {
		client,
		server,
		drain(): readonly JSONRPCMessage[] {
			return frames.splice(0, frames.length)
		},
	}
}

/**
 * Read (and clear) every frame the Node fixture's recording peers received.
 *
 * @remarks
 * The browser project cannot see inside the fixture process, so what the PEER received is
 * read back over the wire from the fixture's `/recorded` endpoint. Both recording peers
 * write into the same log: the tapped `/record` WebSocket and the POST recorder in front of
 * the HTTP routes.
 *
 * @param base - The fixture's loopback origin
 * @returns Every JSON-RPC frame recorded since the last drain
 *
 * @example
 * ```ts
 * await drainRecorded(serverURL) // clear, then drive the scenario
 * ```
 */
export async function drainRecorded(base: string): Promise<readonly JSONRPCMessage[]> {
	const payload: unknown = await (await fetch(`${base}/recorded`)).json()
	if (!isArray(payload)) return []
	const messages: JSONRPCMessage[] = []
	for (const frame of payload) {
		const message = isString(frame) ? decodeEvent(frame) : undefined
		if (message !== undefined) messages.push(message)
	}
	return messages
}
