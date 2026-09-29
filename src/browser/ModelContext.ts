import type { EmitterInterface } from '@orkestrel/emitter'
import type { ToolContext, ToolInterface, ToolManagerInterface } from '@orkestrel/tool'
import type {
	ModelContextAdoptOptions,
	ModelContextEventMap,
	ModelContextInterface,
	ModelContextOptions,
	ModelContextPublishOptions,
	WebMCPDescriptor,
	WebMCPDocument,
	WebMCPHandlerOptions,
	WebMCPProjection,
	WebMCPRegisteredTool,
	WebMCPRegistryInterface,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import { createTool } from '@orkestrel/tool'
import { attempt } from '@orkestrel/contract'
import { WEBMCP_ABORT_EVENT, WEBMCP_ACTIVATED_EVENT, WEBMCP_CHANGE_EVENT } from './constants.js'
import {
	buildWebMCPProjections,
	collectWebMCPProjections,
	matchesDescriptor,
	webMCPToTool,
} from './helpers.js'
import { isWebMCPToolEvent } from './validators.js'

/**
 * Bridges a `ToolManagerInterface` and a document's WebMCP tool registry — the
 * {@link ModelContextInterface} {@link import('./factories.js').createModelContext} returns.
 *
 * @remarks
 * - **It borrows the registry, it does not own it.** The handle registers tools, retains one
 *   `AbortController` per registration, and aborts exactly those on `destroy`. WebMCP's own
 *   unregistration path is that abort. Registration identity is the tool name, per document,
 *   so releasing a name releases whatever now stands under it — including a same-name
 *   registration another handle made later.
 * - **`publish` snapshots at the call, then follows the manager.** The manager is projected
 *   when `publish` is called, before the work queues behind an earlier publication, so a
 *   registry mutated while this call waits its turn does not decide what this call registers.
 *   The same call subscribes to the manager's own `emitter`, so a later `add`, `remove`, or
 *   `clear` reaches the document registry without a second `publish`.
 * - **One manager is followed at a time.** A `publish` naming another manager releases the
 *   subscription and takes up the new one, and `destroy` releases it outright. An event from a
 *   manager this handle no longer follows is ignored, which is what a listener republishing
 *   another manager from inside a dispatch produces. A followed change has no caller to refuse
 *   to, so a tool advertising neither a `description` nor a `summary` is left unregistered
 *   rather than refusing anything; `publish` still refuses such a batch whole. Under a name
 *   this handle never registered that skip emits no `change`, because nothing reached the
 *   document registry. A synchronisation registers only what it can carry, so such a tool
 *   standing under a name this handle already registered releases that registration rather
 *   than leaving it advertising a descriptor the manager no longer stands behind, and that
 *   release emits the registry's `change` like any other.
 * - **A followed change is a trigger, not a fact.** Each `add`, `remove`, or `clear` queues one
 *   synchronisation of this handle's registrations for that manager against what the manager
 *   holds when that queued work runs. The event cannot decide the outcome: `remove` and
 *   `clear` name tools the manager no longer holds, an earlier listener in the same dispatch
 *   may already have put another tool under one of those names, and the manager's `destroy`
 *   empties its map after the `clear` it publishes. Reading the manager converges on its state
 *   however the change was reached, so a synchronisation queued and not yet started already
 *   covers every change that arrives before it runs and a second one is not queued. A
 *   publication queued behind that synchronisation ends its cover, because the publication
 *   prunes what the synchronisation registered: a change arriving after that call queues a
 *   synchronisation of its own, which runs after the publication.
 * - **A later `publish` reconciles, and so does every synchronisation.** Each name is compared
 *   with what this handle already registered for it: the same manager holding the same tool
 *   leaves the registration alone, another tool of that same manager advertising an equal
 *   descriptor leaves it registered and records the tool it now stands for, and anything else
 *   releases it and registers the new descriptor bound to the new manager. A name the snapshot
 *   dropped, or a name the manager no longer holds, is released — after the batch has
 *   reconciled, never before, so no name is withdrawn while the tools replacing it are still
 *   being registered. A failed batch releases them too, and still withdraws nothing it
 *   carries. Nothing has to be removed from the manager to make the registry agree with it.
 * - **Work serializes.** Registration is asynchronous and `destroy` is not, so overlapping
 *   calls would interleave registrations with the aborts meant to end them. Each publication
 *   and each synchronisation queues behind the previous one, and every step re-reads the
 *   destroyed flag, so a `destroy` issued mid-publish stops the registrations that have not
 *   happened yet instead of racing them.
 * - **Nothing is polyfilled.** A document exposing no registry never reaches this class:
 *   {@link import('./factories.js').createModelContext} returns `undefined` instead, so feature
 *   absence stays absence rather than becoming a local implementation a caller mistakes for
 *   the platform.
 * - **The result shape is the registry's.** An adopted tool resolves whatever `executeTool`
 *   resolved, unchanged. WebMCP's IDL types that `Promise<DOMString>` while the
 *   specification's README sample returns `{ content: [...] }`; the primary source disagrees
 *   with itself, and normalizing either way would encode a guess as a contract.
 *
 * @example
 * ```ts
 * import { isWebMCPDocument, ModelContext } from '@orkestrel/mcp/browser'
 *
 * if (isWebMCPDocument(document)) {
 * 	const bridge = new ModelContext(document)
 * 	await bridge.publish(tools)
 * }
 * ```
 */
export class ModelContext implements ModelContextInterface {
	readonly #registry: WebMCPRegistryInterface
	readonly #emitter: Emitter<ModelContextEventMap>
	// What this handle registered, per name: the signal that releases it, the descriptor the
	// registry is advertising for it, the manager's own tool the registration was made for
	// (`tool`), and the manager its execution is bound to (`tools`). Genuinely private glue —
	// the controller alone cannot answer whether the manager still holds the tool this
	// registration serves, and answering that is the whole of the reconciliation.
	readonly #registrations = new Map<
		string,
		{
			readonly controller: AbortController
			readonly descriptor: WebMCPDescriptor
			readonly tool: ToolInterface
			readonly tools: ToolManagerInterface
		}
	>()
	readonly #listener: () => void
	readonly #activated: (event: Event) => void
	readonly #aborted: (event: Event) => void
	// The manager this handle is following, with the exact handler reference `off` needs to
	// release it. Genuinely private glue: the subscription is an implementation of `publish`'s
	// contract rather than a member a consumer reads, and one handler serves all three events
	// because each of them asks for the same thing — read the manager and agree with it.
	#followed: { readonly tools: ToolManagerInterface; readonly changed: () => void } | undefined =
		undefined
	// The manager whose synchronisation is queued, has not started, and has nothing queued
	// behind it. A second event for that manager before the work runs would read the same
	// state twice, so it is coalesced into the first; a `publish` queued behind it clears the
	// mark, because the publication that follows the synchronisation prunes what it registers.
	#pendingManager: ToolManagerInterface | undefined = undefined
	#queue: Promise<void> = Promise.resolve()
	#destroyed = false

	/**
	 * Binds a narrowed document's registry and arms its change and execution subscriptions.
	 *
	 * @param document - The document whose `modelContext` this handle bridges
	 * @param options - The emitter's initial hooks and listener-error handler; see
	 *   {@link ModelContextOptions}
	 */
	constructor(document: WebMCPDocument, options?: ModelContextOptions) {
		this.#registry = document.modelContext
		this.#emitter = new Emitter<ModelContextEventMap>({
			...(options?.on === undefined ? {} : { on: options.on }),
			...(options?.error === undefined ? {} : { error: options.error }),
		})
		// The subscription arms at construction rather than on a first `publish`, because a
		// registry change between the two would reach nothing. The bound reference is retained
		// so `destroy` removes the same listener it added.
		this.#listener = this.#republish.bind(this)
		this.#registry.addEventListener(WEBMCP_CHANGE_EVENT, this.#listener)
		this.#activated = this.#republishTool.bind(this, 'activate')
		this.#aborted = this.#republishTool.bind(this, 'abort')
		this.#registry.addEventListener(WEBMCP_ACTIVATED_EVENT, this.#activated)
		this.#registry.addEventListener(WEBMCP_ABORT_EVENT, this.#aborted)
	}

	get emitter(): EmitterInterface<ModelContextEventMap> {
		return this.#emitter
	}

	publish(tools: ToolManagerInterface, options?: ModelContextPublishOptions): Promise<void> {
		// Projected here, at the call, rather than where the queue reaches this publication: the
		// contract is the tools the manager holds now, and a manager mutated while this call
		// waits behind an earlier one must not decide what this call registers. The projection
		// is also where a tool WebMCP cannot carry refuses the whole batch, so that refusal
		// reaches the caller as a rejection rather than as a synchronous throw.
		const snapshot = attempt(() => buildWebMCPProjections(tools))
		if (!snapshot.success) return Promise.reject(snapshot.error)
		// Subscribed at the call, beside the snapshot, so there is no window between the two in
		// which a change reaches nothing. A refused projection registers nothing and therefore
		// follows nothing, and a destroyed handle follows nothing either.
		if (!this.#destroyed) this.#follow(tools, options)
		// A synchronisation already queued runs before this publication, and this publication
		// prunes what that synchronisation registered — so the mark it left stops covering the
		// changes that arrive from here on. Clearing it is what sends the next change to a
		// synchronisation of its own, queued after this publication rather than before it.
		this.#pendingManager = undefined
		const settled = this.#queue.then(() => this.#publish(tools, snapshot.value, options))
		// The queue tracks completion, never outcome: a rejected publish must not poison the
		// next one, and the caller already receives the rejection through `settled`.
		this.#queue = settled.catch(() => undefined)
		return settled
	}

	async adopt(options?: ModelContextAdoptOptions): Promise<readonly ToolInterface[]> {
		const registered = await this.#registry.getTools(
			options?.origins === undefined ? {} : { fromOrigins: options.origins },
		)
		return registered
			.filter((tool) => options?.debugging === true || tool.annotations?.debugging !== true)
			.map((tool) => createTool({ ...webMCPToTool(tool), execute: this.#execute.bind(this, tool) }))
	}

	destroy(): void {
		if (this.#destroyed) return
		this.#destroyed = true
		this.#unfollow()
		this.#pendingManager = undefined
		this.#registry.removeEventListener(WEBMCP_CHANGE_EVENT, this.#listener)
		this.#registry.removeEventListener(WEBMCP_ACTIVATED_EVENT, this.#activated)
		this.#registry.removeEventListener(WEBMCP_ABORT_EVENT, this.#aborted)
		for (const held of this.#registrations.values()) held.controller.abort()
		this.#registrations.clear()
		this.#emitter.destroy()
	}

	// Republishes the registry's own `toolchange` as this handle's `change`. It exists as a
	// method so `addEventListener` and `removeEventListener` receive one stable reference.
	#republish(): void {
		this.#emitter.emit('change')
	}

	#republishTool(name: 'activate' | 'abort', event: Event): void {
		if (isWebMCPToolEvent(event)) this.#emitter.emit(name, event.toolName)
	}

	// Subscribes to a manager's own registry events, releasing whatever was followed before.
	// One manager at a time, because a handle's registrations are keyed by name and two
	// managers publishing one name would each believe they owned it.
	#follow(tools: ToolManagerInterface, options?: ModelContextPublishOptions): void {
		this.#unfollow()
		const changed = this.#changed.bind(this, tools, options)
		tools.emitter.on('add', changed)
		tools.emitter.on('remove', changed)
		tools.emitter.on('clear', changed)
		this.#followed = { tools, changed }
	}

	// Releases the subscription by handing `off` the same reference `on` received. The
	// installed emitter's `on` returns nothing, so the handler identity the record retains is
	// the cleanup.
	#unfollow(): void {
		const followed = this.#followed
		if (followed === undefined) return
		this.#followed = undefined
		followed.tools.emitter.off('add', followed.changed)
		followed.tools.emitter.off('remove', followed.changed)
		followed.tools.emitter.off('clear', followed.changed)
	}

	// Reports whether an event is the followed manager's. `#unfollow` hands the emitter its
	// handlers back, but it cannot withdraw them from the listener array a dispatch already
	// walking that event is holding — so a listener that republishes another manager from
	// inside a dispatch leaves this handle's own handler still to run, for a subscription that
	// no longer exists. Manager identity is the whole reading, and it answers destruction too:
	// `destroy` releases the subscription before it aborts anything, so a destroyed handle
	// follows nobody and every followed handler that outlives it stops here.
	#follows(tools: ToolManagerInterface): boolean {
		return this.#followed?.tools === tools
	}

	// Queues one synchronisation for a change the followed manager reported. Every event takes
	// this door, because each of them says only THAT the manager changed: `remove` and `clear`
	// carry tools the manager no longer holds, an earlier listener in the same dispatch may
	// already have put another tool under one of those names, and the manager's own `destroy`
	// empties its map after the `clear` it publishes. What the event carries therefore cannot
	// decide what to release; the manager's state when the queued work runs decides it. It
	// queues rather than acting here, so a change arriving while an earlier publication is
	// still registering runs after it instead of racing it.
	#changed(tools: ToolManagerInterface, options: ModelContextPublishOptions | undefined): void {
		if (!this.#follows(tools)) return
		// A synchronisation queued and not yet started reads the manager when it runs, so it
		// already covers every change that arrives before then — while nothing is queued behind
		// it. `publish` clears the mark for exactly that reason, so a change arriving after a
		// publication takes a synchronisation of its own rather than one the publication will
		// prune. The mark holds the manager rather than a boolean, so a change from a manager a
		// `publish` took up in the meantime still queues its own.
		if (this.#pendingManager === tools) return
		this.#pendingManager = tools
		this.#queue = this.#queue.then(this.#sync.bind(this, tools, options)).catch(() => undefined)
	}

	// Brings this handle's registrations for one manager to what that manager holds NOW. The
	// whole of what a followed change does: every tool the manager advertises reconciles, and a
	// held name it dropped is released. Only registrations bound to this manager are released,
	// so a name another manager's publication put there is left standing.
	async #sync(tools: ToolManagerInterface, options?: ModelContextPublishOptions): Promise<void> {
		// The mark clears as this work STARTS, not when it was queued: the manager is read
		// below, so a change arriving from here on reaches a reading already taken and needs a
		// synchronisation of its own. A mark a later change left is cleared with it, which
		// costs one synchronisation that had already been covered and never one too few.
		if (this.#pendingManager === tools) this.#pendingManager = undefined
		if (this.#destroyed) return
		// A tool WebMCP cannot carry is skipped rather than refusing anything, because a
		// followed change has no caller a refusal could reach. The prune below then releases
		// the name that skip left out, so the registry advertises only what this handle can
		// carry rather than a descriptor whose tool the manager replaced with one WebMCP
		// cannot carry.
		const projections = collectWebMCPProjections(tools)
		try {
			for (const projection of projections) await this.#reconcile(tools, projection, options)
		} finally {
			this.#prune(projections, tools)
		}
	}

	async #publish(
		tools: ToolManagerInterface,
		projections: readonly WebMCPProjection[],
		options?: ModelContextPublishOptions,
	): Promise<void> {
		if (this.#destroyed) return
		try {
			for (const projection of projections) await this.#reconcile(tools, projection, options)
		} finally {
			this.#prune(projections)
		}
	}

	// Brings one name to the descriptor a publication or a followed change is asking for. The
	// single door both paths take, so a tool added through the manager's own event lands under
	// exactly the rule a `publish` would have applied to it.
	async #reconcile(
		tools: ToolManagerInterface,
		projection: WebMCPProjection,
		options?: ModelContextPublishOptions,
	): Promise<void> {
		// The flag is re-read at every step that can register, and this is that step: a
		// publication's loop resumes here after each suspended registration, and a followed
		// change reaches it from a queue a `destroy` may have overtaken. Reading it once, here,
		// is what keeps one rule rather than a copy per caller to drift against.
		if (this.#destroyed) return
		const { descriptor, tool } = projection
		const held = this.#registrations.get(descriptor.name)
		if (held !== undefined && held.tools === tools) {
			// The manager holds the very tool this registration was made for, so nothing it
			// advertises can have changed. Reading tool identity rather than comparing
			// descriptors is also what leaves a descriptor JSON cannot encode — a cyclic
			// `inputSchema` — alone, instead of churning it on every change to another name.
			if (held.tool === tool) return
			// Another tool of the same manager, under the same name, advertising the same
			// descriptor. Execution routes through the manager by name, so a foreign agent
			// already reaches the replacement's handler, and re-registering would abort a
			// live registration to put an identical one back. The tool it now stands for is
			// recorded instead.
			if (matchesDescriptor(held.descriptor, descriptor)) {
				this.#registrations.set(descriptor.name, { ...held, tool })
				return
			}
		}
		if (held !== undefined) {
			// Anything else is a different tool under a name WebMCP keys per document, so the
			// registration this handle holds is released before the new one replaces it.
			// Leaving it would advertise a descriptor whose handler no longer matches it, and
			// a foreign agent would send arguments the registry told it were valid.
			this.#registrations.delete(descriptor.name)
			held.controller.abort()
			// That abort is the registry's unregistration path, and the registry dispatches
			// `toolchange` inside it — synchronously, into listeners that can destroy this
			// handle. So the flag is re-read here, between releasing the old registration and
			// creating its replacement, or a destroyed handle would leave one live controller
			// behind that nothing will ever abort.
			if (this.#destroyed) return
		}
		await this.#register(tools, projection, options)
	}

	async #register(
		tools: ToolManagerInterface,
		projection: WebMCPProjection,
		options?: ModelContextPublishOptions,
	): Promise<void> {
		const { descriptor, tool } = projection
		const controller = new AbortController()
		this.#registrations.set(descriptor.name, { controller, descriptor, tool, tools })
		try {
			await this.#registry.registerTool(
				{ ...descriptor, execute: this.#run.bind(this, tools, descriptor.name) },
				{
					...(options?.origins === undefined ? {} : { exposedTo: options.origins }),
					signal: controller.signal,
				},
			)
		} catch (error) {
			// A registration the registry refused is not one this handle owns. Dropping the
			// entry lets a later publication or synchronisation register the name again, and
			// the abort releases a tool a registry recorded before it failed.
			this.#registrations.delete(descriptor.name)
			controller.abort()
			throw error
		}
	}

	// Prunes this handle's registrations against the projections a batch reconciled: every
	// name they do not carry is released, and WebMCP's unregistration path is the registration
	// signal, so aborting is the removal. Both callers prune LAST, in a `finally` after their
	// projections have reconciled. One order, so no name is withdrawn while the tools replacing
	// it are still being registered; and a `finally`, so a batch that fails partway still
	// releases the names it dropped rather than leaving them advertised until some later batch
	// withdraws them. A failed batch withdraws nothing it carries: `kept` is read from the
	// projections rather than from the registrations, so the names the batch carries are
	// protected whether or not their reconcile ran. A publication hands its own snapshot,
	// across managers, because a publication decides the whole registry: reading the snapshot
	// rather than the live manager is why a manager emptied mid-publication does not unregister
	// what that publication captured. A synchronisation hands what the manager advertises now,
	// and names the manager, because a followed change decides only what that manager put
	// there.
	#prune(projections: readonly WebMCPProjection[], tools?: ToolManagerInterface): void {
		// Read here rather than at each caller, because each abort below dispatches `toolchange`
		// synchronously into listeners that can destroy this handle: one door, one reading, and
		// a destroyed handle has already taken back every registration itself.
		if (this.#destroyed) return
		const kept = new Set(projections.map((projection) => projection.descriptor.name))
		for (const [name, held] of this.#registrations) {
			if (kept.has(name) || (tools !== undefined && held.tools !== tools)) continue
			this.#registrations.delete(name)
			held.controller.abort()
			// The abort dispatches `toolchange` synchronously, into listeners that can destroy
			// this handle, and `destroy` takes back every remaining registration itself.
			if (this.#destroyed) return
		}
	}

	// Runs one published tool on behalf of the registry. The registry's signal becomes the
	// call's `ToolContext.signal`, so a foreign agent's abort reaches the local handler, and a
	// contained failure becomes the rejection WebMCP's own samples catch. That rejection is a
	// FRESH `Error` carrying the failure's text: `ToolFailure.error` is a string, so the value
	// the handler threw no longer exists to forward, and the text is the whole of what the
	// manager kept.
	async #run(
		tools: ToolManagerInterface,
		name: string,
		input: Readonly<Record<string, unknown>>,
		options: WebMCPHandlerOptions,
	): Promise<unknown> {
		const result = await tools.execute(
			{ id: crypto.randomUUID(), name, arguments: input },
			{ signal: options.signal },
		)
		if (!result.success) throw new Error(result.error)
		return result.value
	}

	// Runs one adopted tool through the registry, forwarding the local caller's abort onto
	// WebMCP's own execution signal and resolving the registry's answer unchanged.
	#execute(
		registered: WebMCPRegisteredTool,
		args: Readonly<Record<string, unknown>>,
		context: ToolContext,
	): Promise<unknown> {
		return this.#registry.executeTool(registered, args, { signal: context.signal })
	}
}
