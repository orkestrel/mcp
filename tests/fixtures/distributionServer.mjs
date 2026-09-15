// The Node half of the distribution composition receipts, run inside the isolated consumer so
// every bare specifier resolves against the packed artifacts that consumer installed. It is a
// real consumer application: one origin serving the page directory, the installed modules that
// page resolves through its import map, the positive control's target, and the authenticated
// relay endpoint the page's provider dials.
//
// It reads the page directory, the module root, and the relay credential from its own
// arguments, and writes `ready <port>` on its output stream after the listener is bound. Every
// request it answers on the relay route is retained and published at `/receipts`, so the
// server's own accounting sits beside the browser's request log.
//
// `ScriptedProvider` supplies the model output the page cannot obtain offline and nothing else.
// `createRelay`, the dispatcher, the listener, and the NDJSON framing between them are the
// installed artifacts running for real.
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createRelay } from '@orkestrel/agent'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { PAINT_SCRIPT, ScriptedProvider } from './script.mjs'

const PAGE = resolve(process.argv[2] ?? '')
const MODULES = resolve(process.argv[3] ?? '')
const CREDENTIAL = process.argv[4] ?? ''
const TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
}
// The turns the relay's upstream answers with: a call on the page tool, then the answer that
// follows its result. One provider call is one turn, which is what the request count is read
// against. The composed script is imported from the shared fixture, so this upstream and the
// page's own provider answer the same run.
const SCRIPT = PAINT_SCRIPT

let relayed = []

// Answers with a file under one of the roots this fixture serves. The consumer installs no test
// toolkit, so the containment check is written here rather than taken from one.
function serveUnder(root, target) {
	const path = resolve(join(root, target === '' ? 'index.html' : target))
	if (path !== root && !path.startsWith(`${root}${sep}`)) {
		return new Response('outside the served root', { status: 404 })
	}
	let body
	try {
		body = readFileSync(path)
	} catch {
		return new Response('no such file', { status: 404 })
	}
	const dot = path.lastIndexOf('.')
	const type = TYPES[path.slice(dot)] ?? 'application/octet-stream'
	return new Response(body, { headers: { 'content-type': type } })
}

// Retains what one relay request carried, so the receipt states the conversation each turn
// sent rather than only how many turns there were.
async function record(request) {
	let body = {}
	try {
		body = JSON.parse(await request.clone().text())
	} catch {}
	const messages = Array.isArray(body.messages) ? body.messages : []
	relayed.push({
		roles: messages.map((message) => message.role),
		tools: Array.isArray(body.tools) ? body.tools.map((tool) => tool.name) : [],
	})
}

// Reports what the relay route has taken since the last read, and clears it. A reading is the
// scenario's own, so a second relay receipt cannot read the first one's total back.
function reportRelayed() {
	const taken = relayed
	relayed = []
	return new Response(JSON.stringify({ relay: taken.length, served: taken }), {
		headers: { 'content-type': 'application/json; charset=utf-8' },
	})
}

const relay = createRelay({
	provider: new ScriptedProvider('scripted-upstream', SCRIPT),
	authorize: (request) => request.headers.get('authorization') === CREDENTIAL,
})

// Answers one relay turn. What the request carried is retained before the installed relay reads
// it, so a refused request is recorded here the same as an authorized one.
async function serveRelay(request) {
	await record(request)
	return relay(request)
}

// The positive control's target: one deliberate request with a body the page reads back, and no
// caching between the page and this answer.
function serveControl() {
	return new Response('control', {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
		},
	})
}

// The import map's other half: a bare specifier the page resolves lands here as the
// package-relative path of the file the consumer installed.
function serveModule(request, context) {
	return serveUnder(MODULES, context.params.rest)
}

// The page itself, which is what an address naming no path asks for.
function serveIndex() {
	return serveUnder(PAGE, '')
}

// Every other asset the page directory holds, addressed by its own path under it.
function servePage(request, context) {
	return serveUnder(PAGE, context.params.rest)
}

// The served surface, written as a table. The module route's literal first segment outranks the
// page's own wildcard, so a page asset and an installed module never contend for one path.
const dispatcher = createDispatcher()
dispatcher.add({ method: 'POST', path: '/relay', handler: serveRelay })
dispatcher.add({ method: 'GET', path: '/receipts', handler: reportRelayed })
dispatcher.add({ method: 'GET', path: '/control', handler: serveControl })
dispatcher.add({ method: 'GET', path: '/modules/*rest', handler: serveModule })
dispatcher.add({ method: 'GET', path: '/', handler: serveIndex })
dispatcher.add({ method: 'GET', path: '/*rest', handler: servePage })

const server = createServer({
	dispatcher,
	state: () => ({}),
	host: '127.0.0.1',
})
const port = await server.start()
process.stdout.write(`ready ${port}\n`)
