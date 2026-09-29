import type { ModelContextEventMap } from '@src/browser'
import { describe, expect, it } from 'vitest'
import { createModelContext, describeWebMCPTool, isWebMCPDocument } from '@src/browser'
import { isMCPError } from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import {
	createRecorder,
	createRecorders,
	readProperty,
	requireValue,
	waitForCondition,
	waitForDelay,
	waitForEvent,
} from '@orkestrel/test'
import {
	createBridge,
	createCyclicTools,
	createDescribedTools,
	createParkedRegistration,
	createParkedTool,
	readOne,
	recordRegistration,
	traceRegistrations,
} from '../../setupBrowser.js'
import { installModelContext } from '../../fixtures/modelContext.js'

// src/browser/ModelContext.ts — the WebMCP bridge, driven in real Chromium against the
// IDL-faithful registry double. Every scenario against the double proves the TRANSLATION; the
// native block at the end of this file claims the integration where the host exposes the
// registry, and `factories.test.ts` holds this page's reading as the relationship between the
// property and what the factory returns. The dated reading of what browsers ship lives in the
// `## WebMCP parity` matrix in `guides/mcp.md`.
//
// Each scenario owns an isolated `Document` from `document.implementation.createHTMLDocument()`,
// so no test mutates the page the suite runs in and none can see another's registrations.

describe('publish — this page registering its tools with the document registry', () => {
	it('registers each advertised tool with its title, schema, and projected annotations', async () => {
		const { fixture, bridge } = createBridge()

		await bridge.publish(createDescribedTools(5))

		const registered = await fixture.registry.getTools()
		expect(registered).toEqual([
			{
				name: 'add',
				title: 'Add',
				description: 'Adds every operand and returns their sum',
				inputSchema: { type: 'object', properties: { left: { type: 'number' } } },
				annotations: {
					readOnlyHint: true,
					untrustedContentHint: true,
					consequentialHint: false,
				},
				window: globalThis.window,
				origin: fixture.origin,
			},
		])
	})

	it('forwards the origins option as WebMCP exposedTo', async () => {
		const { fixture, bridge } = createBridge()

		await bridge.publish(createDescribedTools(5), { origins: ['https://partner.example'] })

		expect(fixture.registrations()[0]?.options?.exposedTo).toEqual(['https://partner.example'])
	})

	it('omits exposedTo when no origins were asked for', async () => {
		const { fixture, bridge } = createBridge()

		await bridge.publish(createDescribedTools(5))

		// Read through `readOne`, because an optional chain over an empty list reports the same
		// `undefined` as a registration made without an exposure list.
		expect(readOne(fixture.registrations(), 'registration').options?.exposedTo).toBeUndefined()
	})

	it('refuses the whole call, registering nothing, when a tool advertises no description', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		tools.add(createTool({ name: 'bare', execute: () => 1 }))

		await expect(bridge.publish(tools)).rejects.toThrow("'bare'")
		expect(fixture.registrations()).toEqual([])
	})

	it('reports the refusal as a coded MCP error rather than a bare throw', async () => {
		const { bridge } = createBridge()
		const tools = createToolManager()
		tools.add(createTool({ name: 'bare', execute: () => 1 }))

		const error: unknown = await bridge.publish(tools).catch((reason: unknown) => reason)

		expect(isMCPError(error) && error.code).toBe(-32602)
	})

	it('adds the names a second call brought and aborts the ones the registry lost', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		await bridge.publish(tools)

		tools.remove('add')
		tools.add(createTool({ name: 'subtract', description: 'Subtracts', execute: () => 1 }))
		await bridge.publish(tools)

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['subtract'])
	})

	it('leaves a name it already registered alone on a second call', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		const recorders = createRecorders<ModelContextEventMap, 'change'>(bridge.emitter, ['change'])
		await bridge.publish(tools)
		const first = readOne(fixture.registrations(), 'registration')
		recorders.change.clear()

		await bridge.publish(tools)

		// Registration identity, not merely a name that is still there: the same manager still
		// holding the same tool leaves the registry entry the first call made, so nothing was
		// re-registered and the registry reported no change nobody made.
		expect(readOne(fixture.registrations(), 'registration')).toBe(first)
		expect(recorders.change.count).toBe(0)
	})

	it('re-registers a name whose definition changed', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'search',
				description: 'Searches the archive',
				parameters: { type: 'object', properties: { term: { type: 'string' } } },
				execute: () => 'archive',
			}),
		)
		await bridge.publish(tools)

		// The manager overwrites by name in place, so this is the same name carrying a
		// different tool — the vector that leaves the registry advertising a schema the
		// registered handler no longer accepts.
		tools.add(
			createTool({
				name: 'search',
				description: 'Searches the index',
				parameters: { type: 'object', properties: { query: { type: 'string' } } },
				execute: () => 'index',
			}),
		)
		await bridge.publish(tools)

		const registered = readOne(await fixture.registry.getTools(), 'registered tool')
		expect(registered.description).toBe('Searches the index')
		expect(registered.inputSchema).toEqual({
			type: 'object',
			properties: { query: { type: 'string' } },
		})
		expect(await fixture.registry.executeTool(registered, {})).toBe('index')
	})

	it('rebinds a name published from a second manager', async () => {
		const { fixture, bridge } = createBridge()
		// One definition, two managers: the projections are equal, so the manager is the only
		// axis that differs and the registry must run the one this call published.
		const first = createToolManager()
		first.add(
			createTool({ name: 'lookup', description: 'Looks up a record', execute: () => 'first' }),
		)
		const second = createToolManager()
		second.add(
			createTool({ name: 'lookup', description: 'Looks up a record', execute: () => 'second' }),
		)
		await bridge.publish(first)

		await bridge.publish(second)

		const registered = readOne(await fixture.registry.getTools(), 'registered tool')
		expect(await fixture.registry.executeTool(registered, {})).toBe('second')
	})

	it('prunes a failed publication and keeps the names it carries', async () => {
		const { fixture, bridge } = createBridge()
		const first = createToolManager()
		first.add(
			createTool({ name: 'dropped', description: 'Dropped by the later call', execute: () => 1 }),
		)
		first.add(createTool({ name: 'kept', description: 'Carried by both calls', execute: () => 1 }))
		await bridge.publish(first)
		const carried = requireValue(
			fixture.registrations().find((entry) => entry.tool.name === 'kept'),
			'the registration the first publication made for the carried name',
		)
		// The carried name is published LAST, behind the name the registry refuses, so its
		// reconcile never runs. That is the vector: a publication decides the whole registry
		// across managers, so its prune must read the names the batch CARRIES rather than the
		// registrations it managed to make.
		const second = createToolManager()
		second.add(
			createTool({
				name: 'accepted',
				description: 'Registered before the refusal',
				execute: () => 1,
			}),
		)
		second.add(
			createTool({ name: 'refused', description: 'Refused by the registry', execute: () => 1 }),
		)
		second.add(createTool({ name: 'kept', description: 'Carried by both calls', execute: () => 1 }))
		const allow = fixture.refuse('refused')

		await expect(bridge.publish(second)).rejects.toThrow(
			"The registry refused to register 'refused'",
		)

		// The refusal rejects the caller and the prune runs anyway, across managers: `dropped`
		// is a name no projection of this call carries, so it is released even though it belongs
		// to the earlier manager; `refused` never reached the registry; `accepted` was
		// registered before the throw.
		const standing = fixture.registrations().map((entry) => entry.tool.name)
		expect(standing.sort()).toEqual(['accepted', 'kept'])
		// Registration identity, not merely a name still standing: the carried name holds the
		// entry the FIRST publication made, so the prune protected it rather than withdrawing a
		// name whose reconcile the refusal cut off.
		expect(fixture.registrations().find((entry) => entry.tool.name === 'kept')).toBe(carried)

		allow()
		await bridge.publish(second)

		// A refusal cleared, the same call converges: the refused name registers, the carried
		// name rebinds to the manager this call published, and `accepted` is left alone.
		const converged = fixture.registrations().map((entry) => entry.tool.name)
		expect(converged.sort()).toEqual(['accepted', 'kept', 'refused'])
	})

	it('registers the snapshot the call captured, then follows the clear that emptied the manager', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		const trace = traceRegistrations(fixture)

		// The manager is emptied between the call and the moment the publication runs. The
		// call still registers what the manager held at the call, and the synchronisation the
		// subscription queued then reads the emptied manager — so the registry saw the
		// snapshot arrive and leave rather than never arrive.
		const pending = bridge.publish(tools)
		tools.clear()
		await pending
		// That synchronisation queued behind the publication, so it runs after the call it
		// followed resolves. The wait is on the end state; the claim is the order the trace
		// recorded.
		await waitForCondition(
			'the followed clear to release the registration',
			() => fixture.registrations().length === 0,
		)

		expect(trace.calls.map(([names]) => names)).toEqual([['add'], []])
		expect(fixture.registrations()).toEqual([])
	})

	it('registers each queued publication against its own snapshot', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		const trace = traceRegistrations(fixture)

		// Both calls are made before either runs, so the second is still queued when the
		// manager is emptied. Each registers what it captured, the second finds the first's
		// registration standing for the same tool and leaves it alone, and the synchronisation
		// the clear triggers reads the emptied manager and releases it.
		const first = bridge.publish(tools)
		const second = bridge.publish(tools)
		tools.clear()
		await Promise.all([first, second])
		await waitForCondition(
			'the followed clear to release the registration',
			() => fixture.registrations().length === 0,
		)

		expect(trace.calls.map(([names]) => names)).toEqual([['add'], []])
		expect(fixture.registrations()).toEqual([])
	})

	it('a queued publication does not see a tool added after its call', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)

		// Both calls are made before either runs, and the manager then takes on a tool WebMCP
		// cannot carry — no description, no summary. Neither snapshot holds it, so both calls
		// resolve and the registry keeps the one name they captured. An implementation that
		// projected a QUEUED call's descriptors when its turn came would read the manager
		// holding `bare` and reject the second call, which is the reading the two snapshot
		// traces beside this one cannot tell apart from the honest answer.
		const first = bridge.publish(tools)
		const second = bridge.publish(tools)
		tools.add(createTool({ name: 'bare', execute: () => 1 }))

		await expect(first).resolves.toBeUndefined()
		await expect(second).resolves.toBeUndefined()

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['add'])
	})

	it('registers nothing after the handle is destroyed', async () => {
		const { fixture, bridge } = createBridge()
		bridge.destroy()

		await bridge.publish(createDescribedTools(5))

		expect(fixture.registrations()).toEqual([])
	})
})

describe('the registry this handle follows after publishing it', () => {
	it('registers a tool the registry adds after publish', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		await bridge.publish(tools)
		const delivered = waitForEvent<readonly []>(
			(listener) => bridge.emitter.on('change', listener),
			'the registry change the followed addition dispatches',
		)

		tools.add(createTool({ name: 'subtract', description: 'Subtracts', execute: () => 1 }))
		await delivered

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['add', 'subtract'])
	})

	it('aborts the registration of a tool the registry removes', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		tools.add(createTool({ name: 'subtract', description: 'Subtracts', execute: () => 1 }))
		await bridge.publish(tools)
		const delivered = waitForEvent<readonly []>(
			(listener) => bridge.emitter.on('change', listener),
			'the registry change the followed removal dispatches',
		)

		tools.remove('add')
		await delivered

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['subtract'])
	})

	it('aborts every registration when the registry clears', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		tools.add(createTool({ name: 'subtract', description: 'Subtracts', execute: () => 1 }))
		await bridge.publish(tools)
		const delivered = waitForEvent<readonly []>(
			(listener) => bridge.emitter.on('change', listener),
			'the registry change the followed clear dispatches',
		)

		tools.clear()
		await delivered

		expect(fixture.registrations()).toEqual([])
	})

	it('registers what a change added before it releases what the change removed', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		await bridge.publish(tools)
		// Armed after the publication, so it records only what the followed change does.
		const trace = traceRegistrations(fixture)

		tools.remove('add')
		tools.add(createTool({ name: 'subtract', description: 'Subtracts', execute: () => 1 }))
		await waitForDelay(50)

		// A publication and a synchronisation take one order: reconcile what the batch carries,
		// then release what it does not. The two dispatches read in that order, so the registry
		// never withdraws a name while the tools replacing it are still being registered.
		expect(trace.calls.map(([names]) => names)).toEqual([['add', 'subtract'], ['subtract']])
		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['subtract'])
	})

	it('releases what the manager dropped when a registration fails', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		await bridge.publish(tools)
		const allow = fixture.refuse('subtract')

		tools.remove('add')
		tools.add(createTool({ name: 'subtract', description: 'Subtracts', execute: () => 1 }))
		await waitForDelay(50)

		// The refused registration throws out of the reconcile loop, and the prune runs anyway:
		// `add` is a name the batch dropped, so nothing carries it and it is released, while
		// `subtract` never reached the registry at all.
		expect(fixture.registrations()).toEqual([])

		allow()
		tools.add(createTool({ name: 'divide', description: 'Divides', execute: () => 1 }))
		await waitForDelay(50)

		// A dropped registration is not one this handle owns, so the next synchronisation
		// registers the name again and the registry converges on what the manager holds.
		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['subtract', 'divide'])
	})

	it('follows the later manager after a second publish', async () => {
		const { fixture, bridge } = createBridge()
		const first = createDescribedTools(5)
		const second = createToolManager()
		second.add(
			createTool({ name: 'lookup', description: 'Looks up a record', execute: () => 'second' }),
		)
		await bridge.publish(first)
		await bridge.publish(second)
		const delivered = waitForEvent<readonly []>(
			(listener) => bridge.emitter.on('change', listener),
			'the registry change the later manager dispatches',
		)

		// The manager the second call replaced is no longer subscribed, so its addition
		// reaches nothing; the manager this handle now follows registers its own.
		first.add(createTool({ name: 'stale', description: 'Never registered', execute: () => 1 }))
		second.add(
			createTool({ name: 'fresh', description: 'Registered by the follow', execute: () => 2 }),
		)
		await delivered

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['lookup', 'fresh'])
	})

	it('registers a change to a manager published while a synchronisation is queued', async () => {
		const { fixture, bridge } = createBridge()
		const first = createDescribedTools(5)
		const second = createToolManager()
		second.add(
			createTool({ name: 'lookup', description: 'Looks up a record', execute: () => 'second' }),
		)
		await bridge.publish(first)

		// The first manager's change queues a synchronisation that has not started when the
		// second publication takes over the follow. The addition to that second manager has to
		// queue its own: coalescing it into the first manager's would read a manager this
		// handle no longer follows and register nothing for the one it does.
		first.add(createTool({ name: 'stale', description: 'Never registered', execute: () => 1 }))
		const publishing = bridge.publish(second)
		second.add(
			createTool({ name: 'fresh', description: 'Registered by the follow', execute: () => 2 }),
		)
		await publishing
		await waitForDelay(50)

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['lookup', 'fresh'])
	})

	it('registers a tool added after a same-manager publication queued behind a synchronisation', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		await bridge.publish(tools)

		// The clear queues a synchronisation, and the publication queues behind it carrying an
		// empty snapshot — so that publication prunes whatever the synchronisation registered.
		// The addition made after it therefore needs a synchronisation of its own, or the
		// manager holds a tool the registry never advertises again.
		tools.clear()
		const publishing = bridge.publish(tools)
		tools.add(createTool({ name: 'fresh', description: 'Fresh', execute: () => 1 }))
		await publishing
		await waitForDelay(50)

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['fresh'])
	})

	it('registers a tool added after a queued publication while a registration is suspended', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		// The registry holds the first publication inside `registerTool`, so the clear, the
		// second publication, and the addition all land while a registration is in flight.
		const resume = fixture.suspend()
		const first = bridge.publish(tools)
		await waitForCondition(
			'the registration to reach the suspended registry',
			() => fixture.holding() === 1,
		)

		tools.clear()
		const second = bridge.publish(tools)
		tools.add(createTool({ name: 'fresh', description: 'Fresh', execute: () => 1 }))
		resume()
		await Promise.all([first, second])
		await waitForDelay(50)

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['fresh'])
	})

	it('leaves nothing registered when a clear lands after a same-manager publication', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		await bridge.publish(tools)

		// The mirror of the addition: the publication's snapshot carries both tools, and the
		// clear that follows it has to reach the registry after that publication rather than
		// being coalesced into the synchronisation the addition queued before it.
		tools.add(createTool({ name: 'fresh', description: 'Fresh', execute: () => 1 }))
		const publishing = bridge.publish(tools)
		tools.clear()
		await publishing
		await waitForDelay(50)

		expect(tools.tools()).toEqual([])
		expect(fixture.registrations()).toEqual([])
	})

	it('ignores a manager a re-entrant publish replaced', async () => {
		const { fixture, bridge } = createBridge()
		const first = createDescribedTools(5)
		const second = createToolManager()
		second.add(createTool({ name: 'lookup', description: 'Looks up', execute: () => 'second' }))
		// An earlier listener on the first manager republishes the second one on any addition.
		// Releasing a subscription inside a dispatch does not withdraw the handler from the
		// array that dispatch is walking, so the bridge's own listener on the first manager
		// still runs — after the subscription it belonged to was replaced.
		first.emitter.on('add', () => {
			void bridge.publish(second)
		})
		await bridge.publish(first)

		first.add(createTool({ name: 'subtract', description: 'Subtracts', execute: () => 1 }))
		await waitForDelay(50)

		// The manager this handle follows is the second one, so the first one's addition
		// reaches nothing rather than queueing behind the publication that replaced it.
		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['lookup'])
	})

	it('preserves an addition made by an earlier clear listener', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		// The manager empties its map and THEN publishes `clear` with the tools it removed, so
		// an earlier listener's addition inside that dispatch stays in the manager.
		tools.emitter.on('clear', () => {
			tools.add(createTool({ name: 'fresh', description: 'Fresh', execute: () => 1 }))
		})
		await bridge.publish(tools)

		tools.clear()
		await waitForDelay(50)

		// The registry agrees with the manager, which holds exactly this tool: releasing what
		// the event carried would have taken back a tool the `clear` never removed.
		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['fresh'])
	})

	it('preserves a same-name addition made by an earlier clear listener', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		// The addition takes back the very name the `clear` reported, under a different
		// descriptor. Releasing by that name would have taken back a registration the `clear`
		// never covered — the tool standing under the name is the replacement.
		tools.emitter.on('clear', () => {
			tools.add(createTool({ name: 'add', description: 'Adds again', execute: () => 2 }))
		})
		await bridge.publish(tools)

		tools.clear()
		await waitForDelay(50)

		// The replacement stands, advertising its own description: the registry agrees with the
		// manager, which holds exactly this tool under this name.
		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['add'])
		expect(fixture.registrations().map((entry) => entry.tool.description)).toEqual(['Adds again'])
	})

	it('preserves an equal-descriptor replacement made by an earlier remove listener', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createToolManager()
		tools.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'first' }))
		// The replacement advertises the IDENTICAL descriptor, so neither the name nor what the
		// removed tool advertised tells the two apart. The manager's own state does: it holds
		// the replacement, and the registry must keep advertising it.
		tools.emitter.once('remove', () => {
			tools.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'second' }))
		})
		await bridge.publish(tools)

		tools.remove('echo')
		await waitForDelay(50)

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['echo'])
		// Execution routes through the manager by name, so the registration that stood through
		// the removal reaches the replacement's handler.
		const registered = readOne(await fixture.registry.getTools(), 'registered tool')
		expect(await fixture.registry.executeTool(registered, {})).toBe('second')
	})

	it('preserves an equal-descriptor replacement made by an earlier clear listener', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createToolManager()
		tools.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'first' }))
		tools.emitter.once('clear', () => {
			tools.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'second' }))
		})
		await bridge.publish(tools)

		tools.clear()
		await waitForDelay(50)

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['echo'])
		const registered = readOne(await fixture.registry.getTools(), 'registered tool')
		expect(await fixture.registry.executeTool(registered, {})).toBe('second')
	})

	it('preserves an equal-descriptor replacement while a publication is still queued', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createToolManager()
		tools.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'first' }))
		tools.emitter.once('clear', () => {
			tools.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'second' }))
		})
		// Both calls are made before either runs, and the clear that replaces `echo` lands
		// before both: each publication registers what it captured, and the change the follow
		// carries queues behind them.
		const first = bridge.publish(tools)
		const second = bridge.publish(tools)
		tools.clear()
		await Promise.all([first, second])
		await waitForDelay(50)

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['echo'])
		const registered = readOne(await fixture.registry.getTools(), 'registered tool')
		expect(await fixture.registry.executeTool(registered, {})).toBe('second')
	})

	it('preserves an equal-descriptor replacement while a registration is suspended', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createToolManager()
		tools.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'first' }))
		tools.emitter.once('clear', () => {
			tools.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'second' }))
		})
		// The registry holds the publication inside `registerTool`, so the clear and its
		// replacement land while the registration this handle is making is still in flight.
		const release = fixture.suspend()
		const publishing = bridge.publish(tools)
		await waitForCondition(
			'the registration to reach the suspended registry',
			() => fixture.holding() === 1,
		)

		tools.clear()
		release()
		await publishing
		await waitForDelay(50)

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['echo'])
		const registered = readOne(await fixture.registry.getTools(), 'registered tool')
		expect(await fixture.registry.executeTool(registered, {})).toBe('second')
	})

	it('releases an unencodable descriptor after remove', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createCyclicTools()
		await bridge.publish(tools)

		tools.remove('cyclic')
		await waitForDelay(50)

		// A descriptor JSON cannot encode compares equal to nothing, itself included, so a
		// release that read descriptor equality left this registration advertising a tool the
		// manager no longer holds. The manager's own state carries no such blind spot.
		expect((await fixture.registry.getTools()).map((tool) => tool.name)).toEqual([])
		expect((await bridge.adopt()).map((tool) => tool.name)).toEqual([])
		bridge.destroy()
		expect((await fixture.registry.getTools()).map((tool) => tool.name)).toEqual([])
	})

	it('releases an unencodable descriptor after clear', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createCyclicTools()
		await bridge.publish(tools)

		tools.clear()
		await waitForDelay(50)

		expect((await fixture.registry.getTools()).map((tool) => tool.name)).toEqual([])
		expect((await bridge.adopt()).map((tool) => tool.name)).toEqual([])
		bridge.destroy()
		expect((await fixture.registry.getTools()).map((tool) => tool.name)).toEqual([])
	})

	it('leaves an unencodable descriptor alone while its tool stays', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createCyclicTools()
		await bridge.publish(tools)
		const registered = readOne(fixture.registrations(), 'registration')
		// Armed after the publication, so it records only what the followed change does.
		const trace = traceRegistrations(fixture)

		tools.add(createTool({ name: 'other', description: 'Other', execute: () => 2 }))
		await waitForDelay(50)

		// The manager still holds the same `cyclic` instance, so its registration is left
		// exactly as it was: one dispatch, for the tool that was actually added.
		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['cyclic', 'other'])
		expect(fixture.registrations()[0]).toBe(registered)
		expect(trace.calls.map(([names]) => names)).toEqual([['cyclic', 'other']])
	})

	it('drops additions erased when the followed manager is destroyed', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		// `destroy` clears the manager, publishes `clear` with what it removed, destroys its
		// emitter, and then empties the map again — so the addition this listener makes is
		// erased with no event left to report it. Only the manager's state at the moment the
		// queued work runs reports that the tool is gone.
		tools.emitter.on('clear', () => {
			tools.add(createTool({ name: 'fresh', description: 'Fresh', execute: () => 1 }))
		})
		await bridge.publish(tools)

		tools.destroy()
		await waitForDelay(50)

		expect(tools.tools()).toEqual([])
		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual([])
	})

	it('stops following the registry after destroy', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		await bridge.publish(tools)

		bridge.destroy()
		tools.add(createTool({ name: 'later', description: 'Added after destroy', execute: () => 1 }))
		await waitForDelay()

		// The manager reports its own subscriptions, so the release is read from the manager
		// rather than inferred from a registry that registered nothing.
		expect(tools.emitter.count()).toBe(0)
		expect(fixture.registrations()).toEqual([])
	})

	it('leaves a followed tool WebMCP cannot carry unregistered', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		await bridge.publish(tools)

		tools.add(createTool({ name: 'bare', execute: () => 1 }))
		await waitForDelay()

		// A followed addition has no caller to refuse to, so a tool advertising neither a
		// description nor a summary is left unregistered. `publish` still refuses the batch.
		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['add'])
		await expect(bridge.publish(tools)).rejects.toThrow("'bare'")
	})

	it('releases a registered name the manager replaced with a tool WebMCP cannot carry', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createDescribedTools(5)
		await bridge.publish(tools)
		// Armed after the publication, so it counts only what the followed changes produce.
		const recorders = createRecorders<ModelContextEventMap, 'change'>(bridge.emitter, ['change'])

		// The replacement takes the name under which this handle already registered, and
		// advertises neither a description nor a summary. The synchronisation registers only
		// what it can carry, so the name it cannot carry is released rather than left
		// advertising a descriptor the manager no longer stands behind.
		tools.add(createTool({ name: 'add', execute: () => 1 }))
		await waitForDelay(50)

		expect(fixture.registrations()).toEqual([])
		expect((await bridge.adopt()).map((tool) => tool.name)).toEqual([])
		// The diagnostic reports `undefined` for a name `definitions()` still lists, which is
		// the mismatch read from the manager's own side.
		expect(describeWebMCPTool(tools, 'add')).toBeUndefined()
		expect(tools.definitions().map((definition) => definition.name)).toEqual(['add'])
		// Releasing a registered name is a release like any other, so the registry dispatches
		// `toolchange` and this handle republishes it.
		expect(recorders.change.count).toBe(1)

		// A tool WebMCP cannot carry arriving under a name this handle never registered reaches
		// the document registry with nothing to release.
		tools.add(createTool({ name: 'bare', execute: () => 1 }))
		await waitForDelay(50)

		expect(fixture.registrations()).toEqual([])
		expect(recorders.change.count).toBe(1)
	})
})

describe('a published tool, run by the registry as a foreign agent would run it', () => {
	it('runs the local handler and answers with the value it returned, unchanged', async () => {
		const { fixture, bridge } = createBridge()
		// The MCP content record the WebMCP README's own sample returns, against an IDL that
		// types `executeTool` as `Promise<DOMString>`. The bridge normalizes neither, so the
		// record arrives exactly as the handler produced it.
		const value = { content: [{ type: 'text', text: 'Added' }] }
		await bridge.publish(createDescribedTools(value))
		const registered = await fixture.registry.getTools()

		expect(
			await fixture.registry.executeTool(readOne(registered, 'registered tool'), { left: 2 }),
		).toEqual(value)
	})

	it('preserves the failure text in the rejection', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'boom',
				description: 'Always fails',
				execute: () => {
					throw new Error('kaboom')
				},
			}),
		)
		await bridge.publish(tools)
		const registered = readOne(await fixture.registry.getTools(), 'registered tool')

		const rejection: unknown = await fixture.registry
			.executeTool(registered, {})
			.catch((reason: unknown) => reason)

		// A fresh `Error` carrying the failure's text, not the thrown instance: the manager
		// contained the throw and reports `ToolFailure.error`, which is a string, so the value
		// that was thrown no longer exists to forward.
		expect(rejection).toBeInstanceOf(Error)
		expect(rejection instanceof Error && rejection.message).toBe('kaboom')
	})

	it('carries the registry execution signal into the local handler context signal', async () => {
		const { fixture, bridge } = createBridge()
		const parked = createParkedTool('park')
		const tools = createToolManager()
		tools.add(parked.tool)
		await bridge.publish(tools)
		const registered = await fixture.registry.getTools()
		const controller = new AbortController()

		fixture.registry
			.executeTool(readOne(registered, 'registered tool'), {}, { signal: controller.signal })
			.catch(() => undefined)
		await parked.entered
		controller.abort()

		// Resolution is the proof: `aborted` settles only when the handler's own context
		// signal fires, so the resolution itself is what the claim rests on.
		await expect(parked.aborted).resolves.toBeUndefined()
	})
})

describe('adopt — reading the registry back as locally executable tools', () => {
	it('excludes debugging tools by default and includes them only when requested', async () => {
		const { fixture, bridge } = createBridge()
		try {
			await fixture.registry.registerTool({
				...recordRegistration('debugger', 'diagnostic').tool,
				annotations: { debugging: true, readOnlyHint: true },
			})
			await fixture.registry.registerTool({
				...recordRegistration('ordinary', 'ordinary').tool,
				annotations: { debugging: false },
			})
			await fixture.registry.registerTool(recordRegistration('unmarked', 'unmarked').tool)

			expect((await bridge.adopt()).map((tool) => tool.name)).toEqual(['ordinary', 'unmarked'])
			expect((await bridge.adopt({ debugging: false })).map((tool) => tool.name)).toEqual([
				'ordinary',
				'unmarked',
			])
			const included = await bridge.adopt({ debugging: true })
			expect(included.map((tool) => tool.name)).toEqual(['debugger', 'ordinary', 'unmarked'])
			const debugging = requireValue(
				included.find((tool) => tool.name === 'debugger'),
				'the debugging tool',
			)
			expect(debugging.annotations).toEqual({ pure: true })
			expect(await debugging.execute({}, { signal: new AbortController().signal })).toBe(
				'diagnostic',
			)
		} finally {
			bridge.destroy()
		}
	})

	it('reads each registered tool as a tool advertising the inverse projection', async () => {
		const { fixture, bridge } = createBridge()
		// Three booleans cannot be pairwise distinct, so one tool alone leaves one swap
		// invisible. Two tools carrying complementary triples leave none: every pair of hints
		// differs in at least one of them, so swapping any two projections reddens a named
		// assertion here.
		await fixture.registry.registerTool({
			name: 'remote',
			title: 'Remote search',
			description: 'Runs in another page',
			inputSchema: { type: 'object', properties: { term: { type: 'string' } } },
			annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
			execute: async () => 'done',
		})
		await fixture.registry.registerTool({
			name: 'purchase',
			description: 'Also runs in another page',
			annotations: { readOnlyHint: true, untrustedContentHint: false, consequentialHint: true },
			execute: async () => 'bought',
		})

		const adopted = await bridge.adopt()
		const remote = requireValue(
			adopted.find((tool) => tool.name === 'remote'),
			'the adopted remote tool',
		)
		const purchase = requireValue(
			adopted.find((tool) => tool.name === 'purchase'),
			'the adopted purchase tool',
		)

		expect(remote.title).toBe('Remote search')
		expect(remote.description).toBe('Runs in another page')
		expect(remote.parameters).toEqual({ type: 'object', properties: { term: { type: 'string' } } })
		expect(remote.annotations?.pure).toBe(true)
		expect(remote.annotations?.untrusted).toBe(true)
		expect(remote.annotations?.consequential).toBe(false)
		expect(purchase.title).toBeUndefined()
		expect(purchase.parameters).toBeUndefined()
		expect(purchase.annotations?.pure).toBe(true)
		expect(purchase.annotations?.untrusted).toBe(false)
		expect(purchase.annotations?.consequential).toBe(true)
	})

	it('forwards the caller arguments to the foreign handler unchanged', async () => {
		const { fixture, bridge } = createBridge()
		const recorded = recordRegistration('remote', 'done')
		await fixture.registry.registerTool(recorded.tool)
		const adopted = readOne(await bridge.adopt(), 'adopted tool')

		const value = await adopted.execute(
			{ term: 'orbit', limit: 3 },
			{ signal: new AbortController().signal },
		)

		expect(value).toBe('done')
		expect(recorded.recorder.calls.map(([input]) => input)).toEqual([{ term: 'orbit', limit: 3 }])
	})

	it('executes an adopted tool through the registry and answers unchanged', async () => {
		const { fixture, bridge } = createBridge()
		const value = { content: [{ type: 'text', text: 'done' }] }
		await fixture.registry.registerTool({
			name: 'remote',
			description: 'Runs in another page',
			execute: async () => value,
		})
		const adopted = await bridge.adopt()

		expect(await adopted[0]?.execute({}, { signal: new AbortController().signal })).toEqual(value)
	})

	it('carries the local context signal onto the foreign handler through executeTool', async () => {
		const { fixture, bridge } = createBridge()
		const parked = createParkedRegistration('remote')
		await fixture.registry.registerTool(parked.tool)
		const adopted = await bridge.adopt()
		const controller = new AbortController()

		void Promise.resolve(adopted[0]?.execute({}, { signal: controller.signal })).catch(
			() => undefined,
		)
		await parked.entered
		controller.abort()

		// Resolution is the proof: `aborted` settles only when the registry's own execution
		// signal fires inside the foreign callback.
		await expect(parked.aborted).resolves.toBeUndefined()
	})

	it('forwards the origins option as WebMCP fromOrigins', async () => {
		const { fixture, bridge } = createBridge()
		await bridge.publish(createDescribedTools(5))

		expect(await bridge.adopt({ origins: [fixture.origin] })).toHaveLength(1)
		expect(await bridge.adopt({ origins: ['https://elsewhere.example'] })).toEqual([])
	})
})

describe('change — the registry event this handle republishes', () => {
	it('emits exactly one change when the page registers a tool this handle never published', async () => {
		const { fixture, bridge } = createBridge()
		const recorders = createRecorders<ModelContextEventMap, 'change'>(bridge.emitter, ['change'])
		const delivered = waitForEvent<readonly []>(
			(listener) => bridge.emitter.on('change', listener),
			'the bridge change event',
		)

		await fixture.registry.registerTool({
			name: 'elsewhere',
			description: 'Registered by the page itself',
			execute: async () => 'done',
		})

		// The delivery parks on the event rather than polling for it; the recorder is what
		// reports that exactly one registration produced exactly one emission.
		expect(await delivered).toEqual([])
		expect(recorders.change.count).toBe(1)
	})

	it('emits nothing more after the handle is destroyed', async () => {
		const { fixture, bridge } = createBridge()
		const recorders = createRecorders<ModelContextEventMap, 'change'>(bridge.emitter, ['change'])
		// The registry reports what it is subscribed to, so the release is read from the
		// registry rather than inferred from the silence of a destroyed emitter.
		const subscribed = fixture.listeners()

		bridge.destroy()

		await fixture.registry.registerTool({
			name: 'elsewhere',
			description: 'Registered by the page itself',
			execute: async () => 'done',
		})

		expect(subscribed).toHaveLength(3)
		expect(fixture.listeners()).toEqual([])
		expect(recorders.change.count).toBe(0)
	})
})

describe('execution events — the registry events this handle republishes', () => {
	it('republishes toolactivated before the tool callback runs', async () => {
		const { fixture, bridge } = createBridge()
		const names = createRecorder<readonly [string]>()
		bridge.emitter.on('activate', names.handler)
		try {
			await fixture.registry.registerTool({
				name: 'lookup',
				description: 'Looks up a record',
				execute: async () => names.calls.map(([name]) => name),
			})
			const tool = readOne(await fixture.registry.getTools(), 'registered tool')
			expect(await fixture.registry.executeTool(tool)).toEqual(['lookup'])
			expect(names.calls).toEqual([['lookup']])
		} finally {
			bridge.destroy()
		}
	})

	it('republishes toolcancel when the caller aborts an in-flight execution', async () => {
		const { fixture, bridge } = createBridge()
		const names = createRecorder<readonly [string]>()
		bridge.emitter.on('abort', names.handler)
		const parked = createParkedRegistration('park')
		const caller = new AbortController()
		try {
			await fixture.registry.registerTool(parked.tool)
			const tool = readOne(await fixture.registry.getTools(), 'registered tool')
			const pending = fixture.registry.executeTool(tool, {}, { signal: caller.signal })
			await parked.entered
			expect(names.calls).toEqual([])
			const reason = new Error('caller stopped')
			caller.abort(reason)
			await expect(pending).rejects.toBe(reason)
			expect(names.calls).toEqual([['park']])
		} finally {
			caller.abort()
			bridge.destroy()
		}
	})

	it('ignores a toolactivated event that carries no toolName', () => {
		const { fixture, bridge } = createBridge()
		const names = createRecorder<readonly [string]>()
		bridge.emitter.on('activate', names.handler)
		try {
			fixture.registry.dispatchEvent(new Event('toolactivated'))
			expect(names.calls).toEqual([])
		} finally {
			bridge.destroy()
		}
	})

	it('removes the execution subscriptions at destroy', () => {
		const { fixture, bridge } = createBridge()
		const subscribed = fixture.listeners()
		bridge.destroy()
		expect(subscribed).toHaveLength(3)
		expect(fixture.listeners()).toEqual([])
	})

	it('reports no abort after an execution settles', async () => {
		const { fixture, bridge } = createBridge()
		const names = createRecorder<readonly [string]>()
		bridge.emitter.on('abort', names.handler)
		try {
			await fixture.registry.registerTool(recordRegistration('lookup', 'done').tool)
			const tool = readOne(await fixture.registry.getTools(), 'registered tool')
			const caller = new AbortController()
			expect(await fixture.registry.executeTool(tool, {}, { signal: caller.signal })).toBe('done')
			caller.abort()
			expect(names.calls).toEqual([])
		} finally {
			bridge.destroy()
		}
	})
})

describe('the IDL surface the double publishes, read as the specification declares it', () => {
	it('rejects with the reason and dispatches nothing for an already-aborted caller', async () => {
		const fixture = installModelContext(document.implementation.createHTMLDocument())
		const events = createRecorder<readonly [Event]>()
		let ran = false
		await fixture.registry.registerTool({
			name: 'never',
			description: 'Never runs',
			execute: async () => {
				ran = true
				return 'ran'
			},
		})
		const tool = readOne(await fixture.registry.getTools(), 'registered tool')
		fixture.registry.addEventListener('toolactivated', events.handler)
		fixture.registry.addEventListener('toolcancel', events.handler)
		const reason = new Error('already stopped')
		await expect(
			fixture.registry.executeTool(tool, {}, { signal: AbortSignal.abort(reason) }),
		).rejects.toBe(reason)
		expect(events.calls).toEqual([])
		expect(ran).toBe(false)
	})

	it('aborts the tool signal before it dispatches toolcancel', async () => {
		const fixture = installModelContext(document.implementation.createHTMLDocument())
		const order: string[] = []
		await fixture.registry.registerTool({
			name: 'park',
			description: 'Parks until aborted',
			execute: (_input, { signal }) =>
				new Promise<never>(() => {
					signal.addEventListener('abort', () => order.push('tool'), { once: true })
				}),
		})
		const tool = readOne(await fixture.registry.getTools(), 'registered tool')
		fixture.registry.addEventListener('toolcancel', () => order.push('cancel'))
		const caller = new AbortController()
		const pending = fixture.registry.executeTool(tool, {}, { signal: caller.signal })
		caller.abort()
		await expect(pending).rejects.toBeInstanceOf(DOMException)
		expect(order).toEqual(['tool', 'cancel'])
	})

	it('assigns, replaces, and releases the execution event handlers', async () => {
		const fixture = installModelContext(document.implementation.createHTMLDocument())
		const first = createRecorder<readonly [Event]>()
		const second = createRecorder<readonly [Event]>()
		const parked = createParkedRegistration('park')
		await fixture.registry.registerTool(parked.tool)
		const tool = readOne(await fixture.registry.getTools(), 'registered tool')
		try {
			for (const handler of [first.handler, second.handler, null]) {
				fixture.registry.ontoolactivated = handler
				fixture.registry.ontoolcancel = handler
				expect(fixture.registry.ontoolactivated).toBe(handler)
				expect(fixture.registry.ontoolcancel).toBe(handler)
				const caller = new AbortController()
				const pending = fixture.registry.executeTool(tool, {}, { signal: caller.signal })
				await parked.entered
				caller.abort()
				await expect(pending).rejects.toBeInstanceOf(DOMException)
			}
			expect(first.calls.map(([event]) => event.type)).toEqual(['toolactivated', 'toolcancel'])
			expect(second.calls.map(([event]) => event.type)).toEqual(['toolactivated', 'toolcancel'])
			for (const [event] of [...first.calls, ...second.calls]) {
				expect(event).toBeInstanceOf(Event)
				expect(readProperty<unknown>(event, 'toolName')).toBe('park')
			}
			expect(first.calls.map(([event]) => event.constructor.name)).toEqual([
				'ToolActivatedEvent',
				'ToolCancelEvent',
			])
			expect(fixture.listeners()).toEqual([])
		} finally {
			fixture.registry.ontoolactivated = null
			fixture.registry.ontoolcancel = null
		}
	})

	it('dispatches the IDL ontoolchange handler', async () => {
		const fixture = installModelContext(document.implementation.createHTMLDocument())
		const first = createRecorder<readonly [Event]>()
		const second = createRecorder<readonly [Event]>()

		fixture.registry.ontoolchange = first.handler
		await fixture.registry.registerTool({
			name: 'one',
			description: 'The first',
			execute: async () => 1,
		})
		// Assigning replaces rather than adds, which is what an IDL `EventHandler` attribute
		// means, and `null` releases it outright.
		fixture.registry.ontoolchange = second.handler
		await fixture.registry.registerTool({
			name: 'two',
			description: 'The second',
			execute: async () => 2,
		})
		fixture.registry.ontoolchange = null
		await fixture.registry.registerTool({
			name: 'three',
			description: 'The third',
			execute: async () => 3,
		})

		expect(first.count).toBe(1)
		expect(second.count).toBe(1)
		expect(fixture.registry.ontoolchange).toBeNull()
		expect(fixture.listeners()).toEqual([])
	})
})

describe('destroy — releasing what this handle registered and nothing else', () => {
	it('unregisters this handle tools and leaves another handle registrations standing', async () => {
		const host = document.implementation.createHTMLDocument()
		const fixture = installModelContext(host)
		const mine = requireValue(createModelContext({ document: host }), 'the first bridge')
		const theirs = requireValue(createModelContext({ document: host }), 'the second bridge')
		const ours = createToolManager()
		ours.add(createTool({ name: 'mine', description: 'Mine', execute: () => 1 }))
		const other = createToolManager()
		other.add(createTool({ name: 'theirs', description: 'Theirs', execute: () => 2 }))
		await mine.publish(ours)
		await theirs.publish(other)

		mine.destroy()

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['theirs'])
	})

	it('leaves a page registration this handle never made standing', async () => {
		const { fixture, bridge } = createBridge()
		await fixture.registry.registerTool({
			name: 'elsewhere',
			description: 'Registered by the page itself',
			execute: async () => 'done',
		})
		await bridge.publish(createDescribedTools(5))

		bridge.destroy()

		expect(fixture.registrations().map((entry) => entry.tool.name)).toEqual(['elsewhere'])
	})

	it('is inert on a repeat', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createToolManager()
		tools.add(createTool({ name: 'first', description: 'The first', execute: () => 1 }))
		tools.add(createTool({ name: 'second', description: 'The second', execute: () => 2 }))
		// The registry holds the first registration at its entry, so both calls land while the
		// publication is suspended inside it. That is the property the destroyed flag guards:
		// the registration that has not happened yet never happens, and the repeat adds
		// nothing to what the first call already did.
		const release = fixture.suspend()
		const publishing = bridge.publish(tools)
		await waitForCondition(
			'the first registration to reach the suspended registry',
			() => fixture.holding() === 1,
		)

		bridge.destroy()
		bridge.destroy()
		release()
		await publishing

		expect(fixture.registrations()).toEqual([])
		expect(fixture.listeners()).toEqual([])
		expect(bridge.emitter.destroyed).toBe(true)
	})

	it('registers nothing when destroy runs during replacement unregistration', async () => {
		const { fixture, bridge } = createBridge()
		const first = createToolManager()
		first.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'first' }))
		const second = createToolManager()
		second.add(createTool({ name: 'echo', description: 'Echoes', execute: () => 'second' }))
		await bridge.publish(first)
		// Releasing the live registration dispatches `toolchange` synchronously, so this
		// listener runs between that release and the registration meant to replace it — the
		// one moment a replacement could outlive the handle that was registering it.
		bridge.emitter.once('change', () => {
			bridge.destroy()
		})

		await bridge.publish(second)

		expect(fixture.registrations()).toEqual([])
	})

	it('leaves no registration alive when destroy runs mid-publish from a toolchange listener', async () => {
		const { fixture, bridge } = createBridge()
		const tools = createToolManager()
		tools.add(createTool({ name: 'first', description: 'The first', execute: () => 1 }))
		tools.add(createTool({ name: 'second', description: 'The second', execute: () => 2 }))
		fixture.registry.addEventListener('toolchange', () => {
			bridge.destroy()
		})

		await bridge.publish(tools)

		// The first registration is released by the abort `destroy` issued, and the second
		// never happens because the suspended publication re-reads the flag before each one.
		expect(fixture.registrations()).toEqual([])
	})

	it('replaces an earlier handle registration when a second handle publishes the same name', async () => {
		const host = document.implementation.createHTMLDocument()
		const fixture = installModelContext(host)
		const mine = requireValue(createModelContext({ document: host }), 'the first bridge')
		const theirs = requireValue(createModelContext({ document: host }), 'the second bridge')
		const ours = createToolManager()
		ours.add(createTool({ name: 'shared', description: 'Shared', execute: () => 'mine' }))
		const other = createToolManager()
		other.add(createTool({ name: 'shared', description: 'Shared', execute: () => 'theirs' }))
		await mine.publish(ours)

		await theirs.publish(other)

		// WebMCP keys a registration by name per document, so the later registration replaced
		// the earlier one and the registry runs the second handle's tool.
		const registered = readOne(await fixture.registry.getTools(), 'registered tool')
		expect(await fixture.registry.executeTool(registered, {})).toBe('theirs')

		// And the name is the identity, so the earlier handle's release takes the registration
		// the later handle put under that name with it.
		mine.destroy()
		expect(fixture.registrations()).toEqual([])
		theirs.destroy()
	})
})

describe('the document the bridge was built on', () => {
	it('is narrowed by the same guard the factory runs', () => {
		const bare = document.implementation.createHTMLDocument()
		const carrying = document.implementation.createHTMLDocument()
		installModelContext(carrying)
		// The discriminating case: the member is present and is not a registry, so a factory
		// detecting with a bare `in` check would build a bridge the guard refuses.
		const malformed = document.implementation.createHTMLDocument()
		Object.defineProperty(malformed, 'modelContext', { value: {}, configurable: true })

		for (const host of [bare, carrying, malformed]) {
			const bridge = createModelContext({ document: host })
			expect(bridge !== undefined).toBe(isWebMCPDocument(host))
			bridge?.destroy()
		}

		expect(isWebMCPDocument(carrying)).toBe(true)
		expect(isWebMCPDocument(malformed)).toBe(false)
	})
})

// The native registry, run against whenever the host actually exposes one. The reading is
// taken from this page at collection time, so these scenarios execute on a browser that ships
// `document.modelContext` and are not collected on one that does not — the absence path stays
// an ordinary assertion over an isolated document in `factories.test.ts` rather than a skip
// nobody re-reads, and this page's own reading is held there as the relationship between the
// property and what the factory returns, so a host whose registry the guard refuses reddens
// rather than leaving these scenarios silently uncollected.
describe.runIf(isWebMCPDocument(document))('the native registry this host exposes', () => {
	it('publishes to the real document registry and reads its own tools back', async () => {
		const bridge = requireValue(createModelContext(), 'the native bridge')
		try {
			await bridge.publish(createDescribedTools(5))

			const adopted = await bridge.adopt()

			expect(adopted.map((tool) => tool.name)).toContain('add')
		} finally {
			bridge.destroy()
		}
	})

	it('releases every registration it made on the real document registry', async () => {
		const bridge = requireValue(createModelContext(), 'the native bridge')
		await bridge.publish(createDescribedTools(5))
		const reader = requireValue(createModelContext(), 'the reading bridge')
		try {
			bridge.destroy()

			expect((await reader.adopt()).map((tool) => tool.name)).not.toContain('add')
		} finally {
			reader.destroy()
		}
	})
})
