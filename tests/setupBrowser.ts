// Browser-only test infrastructure — real page globals and the in-page carrier peers the
// duplex proof observes. Loaded by the `src:browser` project only.

import type { JSONRPCMessage, JSONRPCResponse } from '@src/core'
import type {
	ModelContextInterface,
	ScopeTransportInterface,
	ScopeInterface,
	WebMCPHandlerOptions,
	WebMCPTool,
	WebMCPRegisteredTool,
	WebMCPRegisterOptions,
	WebMCPRegistryInterface,
	WebMCPExecuteOptions,
	WebMCPToolEvent,
	WebMCPToolsOptions,
} from '@src/browser'
import type { ToolInterface, ToolManagerInterface } from '@orkestrel/tool'
import type { RecorderInterface } from '@orkestrel/test'
import { decodeEvent, DEFAULT_MCP_CACHE_TTL, MCP_MODERN_VERSION, MCP_META_SERVER } from '@src/core'
import {
	createModelContext,
	createScopeTransport,
	DEFAULT_MCP_SERVER_NAME,
	DEFAULT_MCP_SERVER_VERSION,
} from '@src/browser'
import { isArray, isString } from '@orkestrel/contract'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createRecorder, readProperty, requireValue, waitForAbort } from '@orkestrel/test'
import { MCPFixtureCell } from './setup.js'

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
	const client = new MCPFixtureCell<ScopeTransportInterface | undefined>(undefined)
	const server = new MCPFixtureCell<ScopeTransportInterface | undefined>(undefined)
	client.value = createScopeTransport({
		postMessage(message: unknown): void {
			if (!isString(message)) return
			const decoded = decodeEvent(message)
			if (decoded !== undefined) frames.push(decoded)
			server.value?.deliver(message)
		},
		addEventListener(): void {},
		removeEventListener(): void {},
	})
	server.value = createScopeTransport({
		postMessage(message: unknown): void {
			if (isString(message)) client.value?.deliver(message)
		},
		addEventListener(): void {},
		removeEventListener(): void {},
	})
	return {
		client: client.value,
		server: server.value,
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
	return payload.flatMap((frame: unknown) => {
		const message = isString(frame) ? decodeEvent(frame) : undefined
		return message === undefined ? [] : [message]
	})
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
	const read = new MCPFixtureCell(performance.getEntriesByType('resource').length)
	return () => {
		const entries = performance.getEntriesByType('resource')
		const added = entries.slice(read.value).map((entry) => entry.name)
		read.value = entries.length
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
	return Object.fromEntries(
		REGISTRY_MEMBERS.filter((member) => member !== omitted).map((member) => [
			member,
			readProperty<unknown>(registry, member),
		]),
	)
}

// The WebMCP registry double — an in-memory implementation of the WebIDL published at
// https://webmachinelearning.github.io/webmcp, member for member and nothing beyond it.
//
// It is a protocol-faithful boundary stub of a FOREIGN surface, which is the one substitution
// the test contract permits: no browser exposes `document.modelContext` (the chromestatus
// record, read 2026-09-15 and last updated 2026-08-12, reports `Proposed` with `"flag": false`
// and `"origintrial": false`), so the platform object this bridge translates does not exist to
// drive. It never stands in for any part of
// `@orkestrel/mcp` — the bridge under test is the real `ModelContext`, driven through the real
// `createModelContext`, and what this file supplies is only the thing the browser does not.
//
// `ModelContextRegistry` therefore declares exactly the IDL's own operations, its
// event-handler attributes, and inherits `EventTarget` for the 2026-09-29 draft's events. The
// recorders a test reads registrations and live subscriptions through are NOT registry
// members: they sit on the fixture handle beside the registry, over the same state, so the
// object installed on the document stays the shape a user agent would install.

/** Supplies the default origin the registry reports for every tool registered through it. */
export const MODEL_CONTEXT_ORIGIN = 'https://page.example'

/** Holds one live registration exactly as `registerTool` received it. */
export interface ModelContextRegistration {
	/** The tool dictionary the caller handed `registerTool`. */
	readonly tool: WebMCPTool
	/** The registration options the caller handed `registerTool`, `undefined` when omitted. */
	readonly options: WebMCPRegisterOptions | undefined
}

/** Names the shape WebMCP's `EventHandler` attribute holds: a handler function, or nothing. */
export type ModelContextEventHandler = ((event: Event) => unknown) | null

/**
 * Holds the live state the fixture handle reads a registry back through.
 *
 * @remarks
 * Injected rather than owned, exactly as the registration map already was, so the registry
 * needs no reader of its own: the IDL publishes none, and adding one would put a member on the
 * object installed as `document.modelContext` that a user agent's registry does not have.
 */
export interface ModelContextState {
	/** Every live registration, keyed by the tool name the registry keys registration on. */
	readonly tools: Map<string, ModelContextRegistration>
	/** Every registry listener subscribed and not yet removed, in subscription order. */
	readonly listeners: EventListenerOrEventListenerObject[]
	/** Holds `registerTool` before it records anything, while a scenario is suspending it. */
	readonly gate: MCPFixtureCell<Promise<void> | undefined>
	/** Counts the `registerTool` calls waiting at that gate. */
	readonly held: MCPFixtureCell<number>
	/** Every tool name `registerTool` rejects instead of registering. */
	readonly refused: Set<string>
}

/** Pairs the installed registry double with the recorders over its live state. */
export interface ModelContextFixtureInterface {
	/** The IDL-faithful registry installed as the document's `modelContext`. */
	readonly registry: ModelContextRegistry
	/** The origin the registry reports for tools registered through it. */
	readonly origin: string
	/** Every registration the registry holds, in registration order. */
	registrations(): readonly ModelContextRegistration[]
	/** Every registry listener subscribed and not yet removed, in subscription order. */
	listeners(): readonly EventListenerOrEventListenerObject[]
	/**
	 * Holds every later `registerTool` at its entry and returns the release that lets them run.
	 *
	 * @remarks
	 * A user agent's registration is asynchronous, and a scenario about what happens WHILE one
	 * is in flight needs the suspension to last longer than a microtask. The gate is the
	 * registry's own, so the bridge under test keeps calling the real `registerTool` and
	 * nothing about the call it makes changes.
	 *
	 * @returns The release that lets the held calls proceed; calling it twice is inert
	 */
	suspend(): () => void
	/** Reports how many `registerTool` calls are waiting at the suspension right now. */
	holding(): number
	/**
	 * Makes every later `registerTool` for one name reject, and returns the release that clears it.
	 *
	 * @remarks
	 * A user agent refuses a registration it will not make — a name its own policy reserves, a
	 * quota the page has spent — and a scenario about what the bridge does with that refusal needs
	 * one. The rejection is the registry's own, so the bridge keeps calling the real `registerTool`
	 * and nothing about the call it makes changes.
	 *
	 * @param name - The tool name the registry rejects
	 * @returns The release that lets that name register again; calling it twice is inert
	 */
	refuse(name: string): () => void
}

/** Transliterates the 2026-09-29 WebMCP draft's execution event initialization dictionaries. */
export interface ModelContextToolEventInit extends EventInit {
	readonly toolName?: string
}

/** Implements the 2026-09-29 WebMCP draft's activation event interface. */
export class ToolActivatedEvent extends Event implements WebMCPToolEvent {
	readonly toolName: string

	constructor(type: string, options: ModelContextToolEventInit = {}) {
		super(type, options)
		this.toolName = options.toolName ?? ''
	}
}

/** Implements the 2026-09-29 WebMCP draft's cancellation event interface. */
export class ToolCancelEvent extends Event implements WebMCPToolEvent {
	readonly toolName: string

	constructor(type: string, options: ModelContextToolEventInit = {}) {
		super(type, options)
		this.toolName = options.toolName ?? ''
	}
}

/** Implements the WebMCP `ModelContext` interface over an injected state record. */
export class ModelContextRegistry extends EventTarget implements WebMCPRegistryInterface {
	readonly #state: ModelContextState
	readonly #window: Window
	readonly #origin: string
	#handler: ModelContextEventHandler = null
	#activated: ModelContextEventHandler = null
	#aborted: ModelContextEventHandler = null

	constructor(state: ModelContextState, host: Window, origin: string) {
		super()
		this.#state = state
		this.#window = host
		this.#origin = origin
	}

	/**
	 * Holds the WebMCP `EventHandler` attribute, assigned, replaced, and cleared as the IDL
	 * declares: a later assignment releases the handler the earlier one installed, and `null`
	 * releases it outright.
	 */
	get ontoolchange(): ModelContextEventHandler {
		return this.#handler
	}

	set ontoolchange(handler: ModelContextEventHandler) {
		this.#replaceHandler('toolchange', this.#handler, handler)
		this.#handler = handler
	}

	/** Holds the draft's replaceable `ontoolactivated` event-handler attribute. */
	get ontoolactivated(): ModelContextEventHandler {
		return this.#activated
	}

	set ontoolactivated(handler: ModelContextEventHandler) {
		this.#replaceHandler('toolactivated', this.#activated, handler)
		this.#activated = handler
	}

	/** Holds the draft's replaceable `ontoolcancel` event-handler attribute. */
	get ontoolcancel(): ModelContextEventHandler {
		return this.#aborted
	}

	set ontoolcancel(handler: ModelContextEventHandler) {
		this.#replaceHandler('toolcancel', this.#aborted, handler)
		this.#aborted = handler
	}

	// The subscription pair records into the injected state before delegating, because an
	// `EventTarget` publishes no way to read back what was subscribed and the release a bridge
	// performs at teardown is exactly what a scenario has to observe.
	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: AddEventListenerOptions | boolean,
	): void {
		const callback = listener
		if (callback !== null) this.#state.listeners.push(callback)
		super.addEventListener(type, callback, options)
	}

	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: EventListenerOptions | boolean,
	): void {
		const callback = listener
		const index = callback === null ? -1 : this.#state.listeners.indexOf(callback)
		if (index !== -1) this.#state.listeners.splice(index, 1)
		super.removeEventListener(type, callback, options)
	}

	async registerTool(tool: WebMCPTool, options?: WebMCPRegisterOptions): Promise<void> {
		// The suspension sits before the registration records anything, which is where a real
		// user agent's own asynchrony sits: the caller has asked, and the registry has not yet
		// answered.
		const gate = this.#state.gate.value
		if (gate !== undefined) {
			this.#state.held.value += 1
			await gate
			this.#state.held.value -= 1
		}
		// The refusal is the registry's answer, so it lands after the suspension and before
		// anything is recorded: the caller has asked, and the registry has declined.
		if (this.#state.refused.has(tool.name)) {
			throw new Error(`The registry refused to register '${tool.name}'`)
		}
		this.#state.tools.set(tool.name, { tool, options })
		this.dispatchEvent(new Event('toolchange'))
		const signal = options?.signal
		if (signal === undefined) return
		// The specification's own sample unregisters by aborting the registration signal, so
		// that is the whole of the removal path here. An already-aborted signal never fires the
		// listener, so it is answered directly.
		if (signal.aborted) this.#unregister(tool.name)
		else signal.addEventListener('abort', this.#unregister.bind(this, tool.name))
	}

	async getTools(options?: WebMCPToolsOptions): Promise<readonly WebMCPRegisteredTool[]> {
		const origins = options?.fromOrigins
		if (origins !== undefined && !origins.includes(this.#origin)) return []
		return [...this.#state.tools.values()].map((registration) => this.#describe(registration.tool))
	}

	async executeTool(
		tool: WebMCPRegisteredTool,
		input?: Readonly<Record<string, unknown>>,
		options?: WebMCPExecuteOptions,
	): Promise<unknown> {
		const registration = this.#state.tools.get(tool.name)
		if (registration === undefined) throw new Error(`No registered tool named '${tool.name}'`)
		const caller = options?.signal
		if (caller?.aborted === true) throw caller.reason
		this.dispatchEvent(new ToolActivatedEvent('toolactivated', { toolName: tool.name }))
		// The registry mints the signal the callback receives, which is what
		// `ToolExecuteCallbackOptions` declaring a REQUIRED signal means. A caller abort runs
		// the tool's abort steps first, then dispatches `toolcancel`, then rejects the call.
		const controller = new AbortController()
		const cancel =
			caller === undefined ? undefined : this.#cancel.bind(this, controller, tool.name, caller)
		if (cancel !== undefined) caller?.addEventListener('abort', cancel, { once: true })
		try {
			const result = registration.tool.execute(input ?? {}, { signal: controller.signal })
			if (caller === undefined) return await result
			return await Promise.race([
				result,
				new Promise<never>((_, reject) => {
					if (caller.aborted) reject(caller.reason)
					else caller.addEventListener('abort', () => reject(caller.reason), { once: true })
				}),
			])
		} finally {
			if (cancel !== undefined) caller?.removeEventListener('abort', cancel)
		}
	}

	#replaceHandler(
		type: string,
		previous: ModelContextEventHandler,
		handler: ModelContextEventHandler,
	): void {
		if (previous !== null) this.removeEventListener(type, previous)
		if (handler !== null) this.addEventListener(type, handler)
	}

	#cancel(controller: AbortController, name: string, caller: AbortSignal): void {
		controller.abort(caller.reason)
		this.dispatchEvent(new ToolCancelEvent('toolcancel', { toolName: name }))
	}

	// Projects one registered dictionary onto the `RegisteredTool` the IDL reports back: the
	// shared descriptor members plus the registering window and its origin.
	#describe(tool: WebMCPTool): WebMCPRegisteredTool {
		return {
			name: tool.name,
			description: tool.description,
			window: this.#window,
			origin: this.#origin,
			...(tool.title === undefined ? {} : { title: tool.title }),
			...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
			...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
		}
	}

	#unregister(name: string): void {
		if (!this.#state.tools.delete(name)) return
		this.dispatchEvent(new Event('toolchange'))
	}
}

/**
 * Installs an IDL-faithful WebMCP registry on a document and returns it with its recorder.
 *
 * @remarks
 * Pass a document nothing else uses — `document.implementation.createHTMLDocument()` returns a
 * real, isolated one — so each scenario owns its registry and no test mutates the page the
 * suite runs in.
 *
 * @param host - The document to install `modelContext` on
 * @param origin - The origin the registry reports for its tools; defaults to
 *   {@link MODEL_CONTEXT_ORIGIN}
 * @returns The installed registry, its origin, and the recorders over its live registrations
 *   and subscriptions
 *
 * @example
 * ```ts
 * const fixture = installModelContext(document.implementation.createHTMLDocument())
 * fixture.registrations() // []
 * ```
 */
export function installModelContext(
	host: Document,
	origin: string = MODEL_CONTEXT_ORIGIN,
): ModelContextFixtureInterface {
	const state: ModelContextState = {
		tools: new Map(),
		listeners: [],
		gate: new MCPFixtureCell<Promise<void> | undefined>(undefined),
		held: new MCPFixtureCell(0),
		refused: new Set(),
	}
	const registry = new ModelContextRegistry(state, globalThis.window, origin)
	Object.defineProperty(host, 'modelContext', { value: registry, configurable: true })
	return {
		registry,
		origin,
		registrations(): readonly ModelContextRegistration[] {
			return [...state.tools.values()]
		},
		listeners(): readonly EventListenerOrEventListenerObject[] {
			return [...state.listeners]
		},
		suspend(): () => void {
			const waiting = Promise.withResolvers<void>()
			state.gate.value = waiting.promise
			return () => {
				state.gate.value = undefined
				waiting.resolve()
			}
		},
		holding(): number {
			return state.held.value
		},
		refuse(name: string): () => void {
			state.refused.add(name)
			return () => {
				state.refused.delete(name)
			}
		},
	}
}

/** Describes the foreign scope fixture and its observations. */
export interface ScopeDoubleInterface {
	readonly scope: ScopeInterface
	readonly sent: readonly unknown[]
	readonly listenerCount: number
	dispatch(init: { data?: unknown; ports?: readonly MessagePort[] }): void
}

/** Creates a foreign scope fixture with observable registrations. */
export function createScopeDouble(): ScopeDoubleInterface {
	const sent: unknown[] = []
	const listeners = new Set<(event: MessageEvent) => void>()
	return {
		scope: {
			postMessage(message: unknown): void {
				sent.push(message)
			},
			addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
				listeners.add(listener)
			},
			removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
				listeners.delete(listener)
			},
		},
		get sent() {
			return sent
		},
		get listenerCount() {
			return listeners.size
		},
		dispatch(init) {
			const ports = init.ports === undefined ? [] : [...init.ports]
			const event = new MessageEvent('message', { data: init.data, ports })
			for (const listener of listeners) listener(event)
		},
	}
}

/** Creates the scope fixture's arithmetic tool registry. */
export function createCalculatorTools(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
	return tools
}

// The scope double hosts a bare modern server. Use `modernRequest` because a version-less
// `createJSONRPCRequest` is correctly rejected by that server with JSON-RPC -32602, and drive
// `server/discover` because it is the modern era's own required RPC — 2026-07-28 removes
// `ping`, so a bare server answers that one -32601 and it cannot carry a transport canary.
// That bare server still advertises `tools: { listChanged: true }`, because it owns the tools
// family and produces it from its own registry whatever the host configured.
/** Builds the complete modern discovery response expected from the scope fixture. */
export function buildScopeDiscoveryReply(id: number): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			resultType: 'complete',
			supportedVersions: [MCP_MODERN_VERSION],
			capabilities: { tools: { listChanged: true } },
			ttlMs: DEFAULT_MCP_CACHE_TTL,
			cacheScope: 'private',
			_meta: {
				[MCP_META_SERVER]: {
					name: DEFAULT_MCP_SERVER_NAME,
					version: DEFAULT_MCP_SERVER_VERSION,
				},
			},
		},
	}
}
