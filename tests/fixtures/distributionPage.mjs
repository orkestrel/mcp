// The in-page driver for the distribution composition receipts. It is copied into the
// isolated consumer's page directory and served from there, so each bare specifier it names
// resolves through the page's import map against the packed artifacts that consumer installed
// rather than this workspace's own tree, and no bundler rewrites the graph on the way. Nothing
// here decides anything: each receipt constructs a composition, runs it, and reports what
// happened as JSON text. The test file holds every assertion.
//
// `ScriptedProvider` is a real `ProviderInterface` implementation supplying model output the
// page cannot obtain offline. It stands for the model, not for anything this fleet owns: every
// agent, tool, MCP, and relay path it drives is the installed artifact running for real.
import { createAgent, createRelayProvider } from '@orkestrel/agent'
import { createPageServer } from '@orkestrel/mcp/browser'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { createTool, createToolManager } from '@orkestrel/tool'
import { NOTE, PAINT_SCRIPT, ScriptedProvider, TOOL, buildScript, buildTurn } from './script.mjs'

// The element the page tool writes into.
const LIST = 'receipts'

// The page tool every agent receipt advertises. Its handler mutates the document, so a receipt
// carrying its value proves the handler ran inside the page rather than anywhere else. Its name
// comes from the shared script, which is what the relay's own upstream calls on the Node side.
const PAINT = {
	name: TOOL,
	description: 'Records a note in the page and answers with its receipt.',
	parameters: {
		type: 'object',
		properties: { note: { type: 'string' } },
		required: ['note'],
	},
}

// The tool the hosted MCP server advertises, and the one whose handler parks until its caller
// stops waiting. Each is a plain tool: the server's own registry executes it.
//
// `ADD` carries display metadata and a domain annotation beside its schema, because those are
// what the MCP round trip must preserve. The server projects `pure` onto the `readOnlyHint`
// wire hint and the client projects it back, so a receipt reading `title` and `annotations` off
// the wrapped tool reddens when either side drops a field or invents a default.
const ADD = {
	name: 'add',
	title: 'Add two numbers',
	description: 'Adds two numbers',
	annotations: { pure: true },
	parameters: {
		type: 'object',
		properties: { a: { type: 'number' }, b: { type: 'number' } },
		required: ['a', 'b'],
	},
}
const HOLD = {
	name: 'hold',
	description: 'Waits until its caller stops waiting.',
	parameters: { type: 'object', properties: {} },
}
// The tool the bridge's second turn calls, which no registry holds. The agent reports the miss
// as a failed tool result and keeps running, which is what that receipt reads.
const ABSENT = 'missing'

// The document's own counters. `painted` numbers each receipt so a reading is exact rather
// than random, `fetched` counts every call the page makes through the global transport after
// `arm` wraps it, and `executed` counts the calls the hosted server's own handler ran. Each
// scenario runs in a page of its own, so each starts from this module's initial state.
let painted = 0
let fetched = 0
let executed = 0
let armed = false
let closure = {}
// The page's real transport, held aside by `arm` so the counter can delegate to it.
let carry
// The credential the relay receipt presents, held where the provider's own headers callback
// reads it.
let credential = ''

// The parked tool's moments, published as promises so a caller waits for them instead of
// polling: `ANNOUNCE` settles after the handler is running, `OBSERVE` after its execution
// context has aborted.
const ANNOUNCE = Promise.withResolvers()
const OBSERVE = Promise.withResolvers()

// Counts one call and hands it to the page's real transport. The wrapper replaces nothing: the
// real transport still carries every request, and the count is beside it.
function countedFetch(...request) {
	fetched += 1
	return carry(...request)
}

function arm() {
	if (armed) return
	armed = true
	carry = globalThis.fetch.bind(globalThis)
	globalThis.fetch = countedFetch
}

function fetches() {
	return fetched
}

// Reads what the page's own closure imports published, one export at a time.
function readClosure() {
	const read = {}
	for (const [specifier, namespace] of Object.entries(closure)) {
		const names = Object.keys(namespace).sort()
		const first = names[0]
		read[specifier] = {
			names: names.length,
			first: first ?? '',
			kind: typeof namespace[first],
		}
	}
	return JSON.stringify(read)
}

// Writes one note into the document and answers with the receipt it wrote.
function paint(args) {
	painted += 1
	const receipt = `receipt-${painted}`
	const item = document.createElement('li')
	item.dataset.note = String(args.note ?? '')
	item.textContent = receipt
	document.getElementById(LIST).append(item)
	return receipt
}

// Reads back what the page tool wrote, so a receipt states the document's own text.
function readPainted() {
	return [...document.getElementById(LIST).children].map((item) => ({
		note: item.dataset.note,
		text: item.textContent,
	}))
}

// Adds the two numbers the caller supplied.
function addNumbers(args) {
	return Number(args.a) + Number(args.b)
}

// The same sum, counted, so a receipt can state that the hosted server's own handler ran rather
// than something upstream answering for it.
function countAdd(args) {
	executed += 1
	return addNumbers(args)
}

// Parks until its own execution context aborts, announcing each moment on the promise a caller
// is already waiting on.
function hold(args, context) {
	return new Promise((resolve, reject) => {
		context.signal.addEventListener(
			'abort',
			() => {
				OBSERVE.resolve(String(context.signal.reason))
				reject(new Error('the hosted handler stopped on its own abort'))
			},
			{ once: true },
		)
		ANNOUNCE.resolve()
	})
}

// The headers the relay provider presents on every turn.
function relayHeaders() {
	return { authorization: credential }
}

// What one tool advertises to whoever holds it: the identity, the display metadata, the schema,
// and the domain annotations. A field a projection dropped is absent here rather than defaulted.
function readTool(tool) {
	return {
		name: tool.name,
		title: tool.title,
		description: tool.description,
		parameters: tool.parameters,
		annotations: tool.annotations,
	}
}

// Records each turn and each dispatched call. The agent wires its hooks from the object's own
// enumerable keys, so `hooks` hands it bound callbacks rather than this instance, whose methods
// live on its prototype.
class Ledger {
	turns = []
	calls = []

	get hooks() {
		return { turn: this.turn.bind(this), tool: this.tool.bind(this) }
	}

	turn(index) {
		this.turns.push(index)
	}

	tool(call, result) {
		this.calls.push({
			name: call.name,
			success: result.success,
			value: result.success ? result.value : String(result.error),
		})
	}
}

// Reports the conversation the run leaves behind — the roles in order and the tool message's
// own content, which is where a page tool's value re-enters the model's input.
function readMessages(agent) {
	const messages = agent.context.messages.messages()
	return {
		roles: messages.map((message) => message.role),
		tool: messages.filter((message) => message.role === 'tool').map((message) => message.content),
	}
}

// Reads the JSON-RPC code off a rejection, which is what a client reports for a call it
// refuses outright.
function readCode(error) {
	const code = error?.code
	return typeof code === 'number' ? code : 0
}

// The run the page receipt and the relay receipt each report. The provider is what separates
// them — a script answering in the page, or the relay endpoint answering over the origin — and
// everything else is held here, so each receipt is comparable with the other: what differs
// between their readings is the provider and nothing else.
async function runPaint(provider) {
	const tools = createToolManager()
	tools.add(createTool({ ...PAINT, execute: paint }))
	const ledger = new Ledger()
	const agent = createAgent(provider, { tools, limit: 4, on: ledger.hooks })
	agent.context.messages.add({
		role: 'user',
		content: `record the note ${NOTE}`,
	})
	const result = await agent.generate()
	return JSON.stringify({
		painted: readPainted(),
		calls: ledger.calls,
		turns: ledger.turns,
		content: result.content,
		partial: result.partial,
		...readMessages(agent),
	})
}

// An agent with a page-defined tool, running entirely in the page.
function runPage() {
	return runPaint(new ScriptedProvider('scripted', PAINT_SCRIPT))
}

// The in-page MCP pair: connect, list, call, and the terminal's own refusal. The listing
// is where the tool's display metadata and annotations come back off the wire.
async function runPair() {
	const tools = createToolManager()
	tools.add(createTool({ ...ADD, execute: addNumbers }))
	const pair = createPageServer({
		tools,
		name: 'distribution-page',
		version: '0.0.1',
	})
	await pair.client.connect()
	// The client's own connection flag, read after each lifecycle call that moves it. One
	// reading proves the flag follows nothing, so the receipt reports the flag under the call
	// that preceded it.
	const connect = pair.client.connected
	const version = pair.client.version
	const listed = await pair.client.tools()
	const outcome = await pair.client.call(ADD.name, { a: 2, b: 3 })
	pair.stop()
	let code = 0
	try {
		await pair.client.call(ADD.name, { a: 2, b: 3 })
	} catch (error) {
		code = readCode(error)
	}
	return JSON.stringify({
		connected: { connect, stop: pair.client.connected },
		version,
		listed: listed.map(readTool),
		outcome,
		code,
	})
}

// An agent whose registry holds the hosted server's tools: the call executes in the
// server, a name the server does not hold comes back as a failure, and the run continues. The
// registry's own entry is read back, so the metadata is followed from the wire into the
// registry the agent dispatches from.
async function runBridge() {
	const hosted = createToolManager()
	hosted.add(createTool({ ...ADD, execute: countAdd }))
	const pair = createPageServer({ tools: hosted })
	await pair.client.connect()
	const advertised = await pair.client.tools()
	const registry = createToolManager()
	registry.add(advertised)
	const ledger = new Ledger()
	const script = [
		buildTurn('', { index: 1, name: ADD.name, arguments: { a: 2, b: 3 } }),
		buildTurn('', { index: 2, name: ABSENT, arguments: {} }),
		buildTurn('the sum is 5'),
	]
	const agent = createAgent(new ScriptedProvider('scripted', script), {
		tools: registry,
		limit: 5,
		on: ledger.hooks,
	})
	agent.context.messages.add({ role: 'user', content: 'add 2 and 3' })
	const result = await agent.generate()
	pair.stop()
	return JSON.stringify({
		advertised: advertised.map(readTool),
		registered: readTool(registry.tool(ADD.name)),
		executed,
		calls: ledger.calls,
		turns: ledger.turns,
		content: result.content,
		partial: result.partial,
		...readMessages(agent),
	})
}

// The caller's abort, carried from the agent's run through the client's request and into
// the hosted handler's own execution context.
async function runCancel() {
	const hosted = createToolManager()
	hosted.add(createTool({ ...HOLD, execute: hold }))
	const pair = createPageServer({ tools: hosted })
	await pair.client.connect()
	const registry = createToolManager()
	registry.add(await pair.client.tools())
	const ledger = new Ledger()
	const agent = createAgent(
		new ScriptedProvider('scripted', buildScript(HOLD.name, {}, 'released')),
		{
			tools: registry,
			limit: 4,
			on: ledger.hooks,
		},
	)
	agent.context.messages.add({ role: 'user', content: 'hold the call' })
	const run = agent.generate()
	await ANNOUNCE.promise
	agent.abort('the caller stopped waiting')
	const result = await run
	const reason = await OBSERVE.promise
	pair.stop()
	return JSON.stringify({
		reason,
		partial: result.partial,
		calls: ledger.calls,
		turns: ledger.turns,
	})
}

// On the page side, the agent's provider is the relay endpoint on this page's own origin, and
// the tool it dispatches still executes in the page.
function runRelay(url, value) {
	credential = value
	return runPaint(
		createRelayProvider({
			url,
			parser: createNDJSONParser,
			headers: relayHeaders,
		}),
	)
}

// The instrument's own control: one deliberate request the request log and the counter must
// each report.
async function runControl(url) {
	const response = await fetch(url, { cache: 'no-store' })
	return JSON.stringify({
		status: response.status,
		text: await response.text(),
	})
}

/**
 * Publishes the page's receipts and the root entries the page imported.
 *
 * @param namespaces - Each `@orkestrel` root entry the installed agent's own module names,
 *   imported by the generated page module and keyed by its specifier
 */
export function publish(namespaces) {
	closure = namespaces
	globalThis.receipts = {
		arm,
		fetches,
		closure: readClosure,
		page: runPage,
		pair: runPair,
		bridge: runBridge,
		cancel: runCancel,
		relay: runRelay,
		control: runControl,
	}
}
