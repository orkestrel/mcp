// Browser-only test infrastructure — real page globals and the in-page carrier peers the
// duplex proof observes. Loaded by the `src:browser` project only.

import type { JSONRPCMessage } from '@src/core'
import type {
	ModelContextInterface,
	ScopeInterface,
	ScopeTransportInterface,
	WebMCPHandlerOptions,
	WebMCPTool,
} from '@src/browser'
import type { ToolInterface, ToolManagerInterface } from '@orkestrel/tool'
import type { RecorderInterface } from '@orkestrel/test'
import type { ModelContextFixtureInterface } from './fixtures/modelContext.js'
import { decodeEvent } from '@src/core'
import { createModelContext, createScopeTransport } from '@src/browser'
import { isArray, isString } from '@orkestrel/contract'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createRecorder, readProperty, requireValue, waitForAbort } from '@orkestrel/test'
import { installModelContext } from './fixtures/modelContext.js'

// ── Peer observation ─────────────────────────────────────────────────────────
//
// `duplex` is a claim about what reaches the OTHER end, so every one of these returns a
// drain over what a real peer actually received. None of them stands in for the carrier
// under test: the port tap is an added listener on a real `MessagePort`, the scope pair is
// real `createScopeTransport` halves wired to each other, and the fixture drain reads
// frames a real Node peer recorded off a real socket.

/**
 * Taps a live `MessagePort` and returns a drain over the JSON-RPC frames it has received.
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

/** Wires a pair of real `createScopeTransport` halves, plus what the SERVER half received. */
export interface TestScopeCarrierInterface {
	/** The client half — hand it to `createDuplexClientTransport` and `bindClient`. */
	readonly client: ScopeTransportInterface
	/** The server half — hand it to `bindServer`. */
	readonly server: ScopeTransportInterface
	/** Every JSON-RPC frame the server half received, cleared on read. */
	drain(): readonly JSONRPCMessage[]
}

/**
 * Wires real {@link createScopeTransport} halves into one in-page duplex carrier.
 *
 * @remarks
 * Each half is the shipped factory over a minimal {@link ScopeInterface} whose
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
	const clientScope: ScopeInterface = {
		postMessage(message: unknown): void {
			if (!isString(message)) return
			const decoded = decodeEvent(message)
			if (decoded !== undefined) frames.push(decoded)
			server?.deliver(message)
		},
		addEventListener(): void {},
		removeEventListener(): void {},
	}
	const serverScope: ScopeInterface = {
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
 * Reads (and clears) every frame the Node fixture's recording peers received.
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

// ── Network observation ──────────────────────────────────────────────────────
//
// "No byte left the page" is a claim about the network, so it is read from the platform's own
// network log rather than from a substituted `fetch`. Resource Timing records every request
// the page issued, so nothing here replaces or wraps a browser API: the counter watches the
// same entries the browser writes for a page it is not being tested on.

/** Sets the resource-timing buffer each recorder raises the browser's default to. */
export const RESOURCE_TIMING_CAPACITY = 1000

/**
 * Records the page's network activity and returns a drain over the requests since the last call.
 *
 * @remarks
 * Reads `performance.getEntriesByType('resource')`, the browser's own log of every request the
 * page issued. A drain returns the entry names added since the previous drain, so a scenario
 * asserts an empty array for "this issued no request" and a later positive control proves the
 * drain can report one.
 *
 * The browser adds a resource entry when the response COMPLETES, so a request still in flight
 * is not observed. An empty drain therefore reports that nothing finished, and it bounds
 * "nothing was sent" only for a scenario whose own work has already settled — every call made,
 * resolved, and asserted. Where a claim of absence covers work that may still be in flight,
 * read it from the transport instead, through a recorder over the frames the peer received,
 * and leave this drain the network question it can answer.
 *
 * Creation raises the buffer to {@link RESOURCE_TIMING_CAPACITY} and clears it. A drain slices
 * from a remembered length, and a browser silently drops entries once the buffer is full, so a
 * recorder starting against a full buffer would slice past every entry added after it and
 * report an empty drain for a page that did issue a request. Raising and emptying the buffer
 * first is what keeps the empty reading a measurement rather than an artefact.
 *
 * @returns A drain returning every request recorded since the last call
 *
 * @example
 * ```ts
 * const drain = recordRequests()
 * drain() // []
 * ```
 */
export function recordRequests(): () => readonly string[] {
	performance.setResourceTimingBufferSize(RESOURCE_TIMING_CAPACITY)
	performance.clearResourceTimings()
	let read = performance.getEntriesByType('resource').length
	return () => {
		const entries = performance.getEntriesByType('resource')
		const added = entries.slice(read).map((entry) => entry.name)
		read = entries.length
		return added
	}
}

// ── In-page tool scenarios ───────────────────────────────────────────────────
//
// A scenario that waits does so through `@orkestrel/test`: `waitForCondition` owns the poll,
// `waitForEvent` the deferred on an event, and `waitForAbort` the deferred on a signal. Only
// the `entered` latch is declared here, because no export reports that a handler was reached.

/** Pairs a tool that parks until its context signal aborts with the promise reporting the abort. */
export interface ParkedToolInterface {
	/** The tool to register; its handler resolves only when its own `context.signal` aborts. */
	readonly tool: ToolInterface
	/** Resolves with the handler's own `context.signal` after the handler has been entered. */
	readonly entered: Promise<AbortSignal>
	/** Resolves the first time that same signal aborts; resolution is the whole proof. */
	readonly aborted: Promise<void>
}

/**
 * Builds a real tool whose handler parks until the execution context aborts it.
 *
 * @remarks
 * The whole point is what the SERVER-side handler observes, so the handler parks on its own
 * `context.signal` through `waitForAbort`. Nothing is substituted: this is an ordinary
 * `@orkestrel/tool` tool with a handler that waits, which is what a long-running tool is.
 *
 * `aborted` observes the same signal the handler received, so a caller awaits the report
 * without reaching into the handler. Resolution is the proof; there is no flag to read.
 *
 * @param name - The tool name to register under
 * @returns The tool, the promise reporting its entry, and the promise reporting its abort
 *
 * @example
 * ```ts
 * const parked = createParkedTool('park')
 * tools.add(parked.tool)
 * ```
 */
export function createParkedTool(name: string): ParkedToolInterface {
	const entry = Promise.withResolvers<AbortSignal>()
	return {
		tool: createTool({
			name,
			description: 'Parks until the execution context aborts it',
			execute: (_args, context) => {
				entry.resolve(context.signal)
				return waitForAbort(context.signal)
			},
		}),
		entered: entry.promise,
		aborted: entry.promise.then(waitForAbort),
	}
}

/** Pairs a WebMCP tool dictionary that parks until the registry aborts it with its reports. */
export interface ParkedRegistrationInterface {
	/** The tool dictionary to hand `registerTool`; its callback resolves only on abort. */
	readonly tool: WebMCPTool
	/** Resolves with the registry's own execution signal after the callback has been entered. */
	readonly entered: Promise<AbortSignal>
	/** Resolves the first time that same signal aborts; resolution is the whole proof. */
	readonly aborted: Promise<void>
}

/**
 * Builds a foreign WebMCP tool whose callback parks until the registry's signal aborts it.
 *
 * @remarks
 * The counterpart of {@link createParkedTool} on the other side of the bridge: this is the
 * tool a page other than ours registered, so an adoption scenario can prove that a local
 * `ToolContext.signal` reaches a foreign handler through `executeTool`.
 *
 * @param name - The tool name to register under
 * @returns The tool dictionary, the promise reporting its entry, and the promise reporting its abort
 *
 * @example
 * ```ts
 * const parked = createParkedRegistration('park')
 * await fixture.registry.registerTool(parked.tool)
 * ```
 */
export function createParkedRegistration(name: string): ParkedRegistrationInterface {
	const entry = Promise.withResolvers<AbortSignal>()
	return {
		tool: {
			name,
			description: 'Parks until the registry aborts it',
			execute: async (_input, options) => {
				entry.resolve(options.signal)
				await waitForAbort(options.signal)
			},
		},
		entered: entry.promise,
		aborted: entry.promise.then(waitForAbort),
	}
}

/** Pairs a foreign WebMCP tool that answers with a fixed value with the recorder over its calls. */
export interface RecordedRegistrationInterface {
	/** The tool dictionary to hand `registerTool`. */
	readonly tool: WebMCPTool
	/** Records the input and the options the registry handed the callback, one entry per call. */
	readonly recorder: RecorderInterface<
		readonly [Readonly<Record<string, unknown>>, WebMCPHandlerOptions]
	>
}

/**
 * Builds a foreign WebMCP tool that records what the registry handed it and answers a value.
 *
 * @remarks
 * The arrangement an adoption scenario needs to read the OTHER side of the bridge: what
 * arrived at the foreign callback, rather than what the local caller believes it sent.
 *
 * @param name - The tool name to register under
 * @param value - The value the callback resolves, unchanged
 * @returns The tool dictionary and the recorder over its calls
 *
 * @example
 * ```ts
 * const recorded = recordRegistration('remote', 'done')
 * await fixture.registry.registerTool(recorded.tool)
 * ```
 */
export function recordRegistration(name: string, value: unknown): RecordedRegistrationInterface {
	const recorder =
		createRecorder<readonly [Readonly<Record<string, unknown>>, WebMCPHandlerOptions]>()
	return {
		tool: {
			name,
			description: 'Records the input and options the registry handed it',
			execute: async (input, options) => {
				recorder.handler(input, options)
				return value
			},
		},
		recorder,
	}
}

// ── WebMCP bridge scenarios ──────────────────────────────────────────────────
//
// The bridge's scenarios all start from the same arrangement: an isolated document carrying
// the IDL-faithful registry double, and a live bridge over it. That arrangement is fixture
// assembly rather than an assertion, so it lives here and a test file imports it.

/** Pairs an isolated document's installed registry double with the bridge built over it. */
export interface BridgedDocumentInterface {
	/** The registry double installed as that document's `modelContext`. */
	readonly fixture: ModelContextFixtureInterface
	/** The live bridge `createModelContext` returned for that document. */
	readonly bridge: ModelContextInterface
}

/**
 * Builds an isolated document carrying the WebMCP registry double, plus the bridge over it.
 *
 * @remarks
 * Each call owns a fresh `document.implementation.createHTMLDocument()`, so no scenario
 * mutates the page the suite runs in and none can see another's registrations. The bridge is
 * the real `createModelContext` over the real `ModelContext`; only the registry is a double,
 * because no browser exposes one.
 *
 * @returns The installed fixture and the live bridge
 * @throws Thrown when the installed registry is not detected, which means the guard and the
 * double have drifted apart
 *
 * @example
 * ```ts
 * const { fixture, bridge } = createBridge()
 * await bridge.publish(createDescribedTools(5))
 * ```
 */
export function createBridge(): BridgedDocumentInterface {
	const host = document.implementation.createHTMLDocument()
	const fixture = installModelContext(host)
	const bridge = requireValue(
		createModelContext({ document: host }),
		'The installed registry was not detected',
	)
	return { fixture, bridge }
}

/**
 * Records the registry's contents at every `toolchange` it dispatches.
 *
 * @remarks
 * A registration that is made and then released leaves the same end state as one that was
 * never made, so a scenario about WHICH of those happened reads the registry's own change
 * dispatches rather than its final contents. The listener is an ordinary subscriber on the
 * real registry, beside whatever the bridge subscribed.
 *
 * @param fixture - The installed registry double to observe
 * @returns A recorder whose calls carry the registered names at each dispatch, in order
 *
 * @example
 * ```ts
 * const trace = traceRegistrations(fixture)
 * trace.calls.map(([names]) => names) // []
 * ```
 */
export function traceRegistrations(
	fixture: ModelContextFixtureInterface,
): RecorderInterface<readonly [readonly string[]]> {
	const recorder = createRecorder<readonly [readonly string[]]>()
	fixture.registry.addEventListener('toolchange', () =>
		recorder.handler(fixture.registrations().map((registration) => registration.tool.name)),
	)
	return recorder
}

/**
 * Builds a registry holding one fully described tool that answers with the value it is given.
 *
 * @remarks
 * Every member WebMCP carries is authored — title, description, input schema, and all three
 * annotation hints — so a publication scenario reads one registration and sees the whole
 * projection rather than a partial one.
 *
 * @param value - The value the tool's handler returns, unchanged
 * @returns A registry holding the one described tool
 *
 * @example
 * ```ts
 * const tools = createDescribedTools(5)
 * tools.definitions()[0]?.name // 'add'
 * ```
 */
export function createDescribedTools(value: unknown): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'add',
			title: 'Add',
			description: 'Adds every operand and returns their sum',
			parameters: { type: 'object', properties: { left: { type: 'number' } } },
			annotations: { pure: true, untrusted: true, consequential: false },
			execute: () => value,
		}),
	)
	return tools
}

/**
 * Builds a registry holding one described tool whose schema JSON cannot encode.
 *
 * @remarks
 * The `parameters` record references itself, which is the boundary value every descriptor
 * comparison has to survive: `canonicalStringify` throws on it, so such a descriptor compares
 * equal to no descriptor, its own included. A scenario about what the bridge does with a tool
 * it cannot compare starts here.
 *
 * The tool is otherwise ordinary — a real `@orkestrel/tool` tool carrying a description — so
 * WebMCP can carry it and the registry registers it like any other.
 *
 * @returns A registry holding the one tool, registered under `cyclic`
 *
 * @example
 * ```ts
 * const tools = createCyclicTools()
 * tools.tools()[0]?.name // 'cyclic'
 * ```
 */
export function createCyclicTools(): ToolManagerInterface {
	const schema: Record<string, unknown> = { type: 'object' }
	schema['self'] = schema
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'cyclic',
			description: 'Carries a schema JSON cannot encode',
			parameters: schema,
			execute: () => 1,
		}),
	)
	return tools
}

/**
 * Reads the one member a collection must hold, failing loudly when it holds any other number.
 *
 * @remarks
 * `requireValue` from `@orkestrel/test` covers presence; the surplus check is what this adds,
 * so a scenario that published two tools fails on the arrangement instead of asserting against
 * whichever one came back first.
 *
 * @typeParam T - The member type.
 * @param values - The collection to read
 * @param subject - What one member is, named in the failure message
 * @returns The sole member
 * @throws An `Error` when the collection holds no member or more than one
 *
 * @example
 * ```ts
 * readOne(await fixture.registry.getTools(), 'registered tool').name // 'add'
 * ```
 */
export function readOne<T>(values: readonly T[], subject: string): T {
	if (values.length > 1) throw new Error(`Expected one ${subject}, read ${values.length}`)
	return requireValue(values[0], `Expected one ${subject}, read none`)
}

// ── WebMCP feature-detection cases ───────────────────────────────────────────
//
// The registry operations, spelled from the WebIDL rather than read back from the guard's own
// shape. A list taken from the source would pass for whatever the source happened to require.

/** Names every WebMCP registry operation the feature detection reads, spelled from the WebIDL. */
export const REGISTRY_MEMBERS: readonly string[] = Object.freeze([
	'registerTool',
	'getTools',
	'executeTool',
	'addEventListener',
	'removeEventListener',
])

/**
 * Builds a plain record carrying the registry double's own operations, minus the one named.
 *
 * @remarks
 * The operations are read off a live {@link REGISTRY_MEMBERS} double rather than invented, so
 * a case that omits one differs from a whole registry in exactly that member and the guard's
 * refusal names the omission rather than the arrangement. The result is a plain record, which
 * is what makes it the shape a prototype-carried registry is not.
 *
 * @param omitted - The operation to leave out; omitting it builds the whole shape
 * @returns A record carrying every requested operation
 *
 * @example
 * ```ts
 * Object.keys(buildRegistry('getTools')).includes('getTools') // false
 * ```
 */
export function buildRegistry(omitted?: string): Record<string, unknown> {
	const { registry } = installModelContext(document.implementation.createHTMLDocument())
	const shape: Record<string, unknown> = {}
	for (const member of REGISTRY_MEMBERS) {
		if (member !== omitted) shape[member] = readProperty<unknown>(registry, member)
	}
	return shape
}
