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
// `ontoolchange` event-handler attribute, and inherits `EventTarget` for `toolchange`. The
// recorders a test reads registrations and live subscriptions through are NOT registry
// members: they sit on the fixture handle beside the registry, over the same state, so the
// object installed on the document stays the shape a user agent would install.

import type {
	WebMCPRegisteredTool,
	WebMCPRegisterOptions,
	WebMCPRegistryInterface,
	WebMCPExecuteOptions,
	WebMCPTool,
	WebMCPToolsOptions,
} from '@src/browser'

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
	/** Every `toolchange` listener subscribed and not yet removed, in subscription order. */
	readonly listeners: EventListenerOrEventListenerObject[]
	/** Holds `registerTool` before it records anything, while a scenario is suspending it. */
	gate: Promise<void> | undefined
	/** Counts the `registerTool` calls waiting at that gate. */
	held: number
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
	/** Every `toolchange` listener subscribed and not yet removed, in subscription order. */
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

/** Implements the WebMCP `ModelContext` interface over an injected state record. */
export class ModelContextRegistry extends EventTarget implements WebMCPRegistryInterface {
	readonly #state: ModelContextState
	readonly #window: Window
	readonly #origin: string
	#handler: ModelContextEventHandler = null

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
		const previous = this.#handler
		if (previous !== null) this.removeEventListener('toolchange', previous)
		this.#handler = handler
		if (handler !== null) this.addEventListener('toolchange', handler)
	}

	// The subscription pair records into the injected state before delegating, because an
	// `EventTarget` publishes no way to read back what was subscribed and the release a bridge
	// performs at teardown is exactly what a scenario has to observe.
	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: AddEventListenerOptions | boolean,
	): void {
		if (listener !== null) this.#state.listeners.push(listener)
		super.addEventListener(type, listener, options)
	}

	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: EventListenerOptions | boolean,
	): void {
		const index = listener === null ? -1 : this.#state.listeners.indexOf(listener)
		if (index !== -1) this.#state.listeners.splice(index, 1)
		super.removeEventListener(type, listener, options)
	}

	async registerTool(tool: WebMCPTool, options?: WebMCPRegisterOptions): Promise<void> {
		// The suspension sits before the registration records anything, which is where a real
		// user agent's own asynchrony sits: the caller has asked, and the registry has not yet
		// answered.
		const gate = this.#state.gate
		if (gate !== undefined) {
			this.#state.held += 1
			await gate
			this.#state.held -= 1
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
		// The registry mints the signal the callback receives and follows the caller's own,
		// which is what `ToolExecuteCallbackOptions` declaring a REQUIRED signal means.
		// `AbortSignal.any` is the platform's own composition, so an already-aborted caller and
		// a later abort take the same path, and an omitted caller yields a signal that never
		// fires.
		const caller = options?.signal
		const signal = AbortSignal.any(caller === undefined ? [] : [caller])
		return registration.tool.execute(input ?? {}, { signal })
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
		gate: undefined,
		held: 0,
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
			state.gate = waiting.promise
			return () => {
				state.gate = undefined
				waiting.resolve()
			}
		},
		holding(): number {
			return state.held
		},
		refuse(name: string): () => void {
			state.refused.add(name)
			return () => {
				state.refused.delete(name)
			}
		},
	}
}
