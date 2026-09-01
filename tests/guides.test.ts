// The consumer-side guides-parity drop-in: runs @orkestrel/guide's checks against this
// repository's own guides/README.md manifest. The constants below are this package's
// own, and are what a sibling package changes.

import type {
	JSONRPCId,
	JSONRPCMessage,
	JSONRPCNotification,
	MCPDispatcherInterface,
	MCPSubscriptionResult,
} from '@src/core'
import type { ChildProcess } from 'node:child_process'
import type { ScratchInterface } from '@orkestrel/test/server'
import {
	createMCPClient,
	createMCPLegacy,
	createMCPLegacyClientTransport,
	createMCPServer,
	isMCPError,
	isMCPSubscriptionResult,
	MCP_META_SUBSCRIPTION,
} from '@src/core'
import { isRecord } from '@orkestrel/contract'
import { createTool, createToolManager } from '@orkestrel/tool'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createStdioClientTransport, createStdioServer } from '@src/server'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import { requireValue, waitForCondition } from '@orkestrel/test'
import { createScratch, readInventory } from '@orkestrel/test/server'
import { createLoopbackTransport, createSubscriptionServer, waitForSettlement } from './setup.js'
import { findMissingNamedImports } from './setupServer.js'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['text', 'ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({
	'@orkestrel/mcp': 'src/core',
	'@orkestrel/mcp/browser': 'src/browser',
	'@orkestrel/mcp/server': 'src/server',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a local, so
 * it stays exported without being public. Naming it here is what makes that intentional rather
 * than forgotten — and the internal-membership assertion fails when a name stops being stranded,
 * so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md', 'README.md'])

/** Source modules that own removable legacy server ingress. */
const LEGACY_OWNERS = Object.freeze([
	'src/core/MCPLegacy.ts',
	'src/core/factories.ts',
	'src/core/index.ts',
	'src/core/types.ts',
	'src/server/MCPSession.ts',
	'src/server/index.ts',
	'src/server/middlewares.ts',
	'src/server/types.ts',
])

/**
 * Declarations, named imports from any specifier, and barrel exports that make a module own
 * removable legacy ingress.
 */
const LEGACY_OWNER_PATTERN =
	/\b(?:export\s+class\s+(?:MCPLegacy|MCPSession)\b|export\s+function\s+(?:createMCPLegacy|createMCPSession)\b|export\s+interface\s+(?:MCPLegacyOptions|MCPSession(?:Options|Interface|State|Entry))\b|import(?:\s+type)?\s*\{[^}]*\b(?:MCPLegacy|MCPSession)\b[^}]*\}\s*from\s*['"][^'"]+['"]|export\s+\*\s+from\s*['"]\.\/(?:MCPLegacy|MCPSession)\.js['"])/u

/** Return the source modules carrying a removable legacy-ingress declaration or dependency. */
function findLegacyOwners(population: Readonly<Record<string, string>>): readonly string[] {
	return Object.entries(population)
		.filter(([path, source]) => path.startsWith('src/') && LEGACY_OWNER_PATTERN.test(source))
		.map(([path]) => path)
		.sort()
}

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sourceManager = createSourceManager({ files, modules: MODULES })

describe('README.md', () => {
	const readme = createGuide(requireValue(files['README.md'], 'Missing file: README.md'))

	it('contains only repository-relative links or absolute URLs', () => {
		const links = readme.links()
		const broken = links.filter((href) =>
			isExternalLink(href)
				? !URL.canParse(href)
				: files[resolveLink('README.md', href)] === undefined,
		)
		expect(links.length).toBeGreaterThan(0)
		expect(broken).toEqual([])
	})
})

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

describe('legacy server-ingress ownership', () => {
	it('matches the guide membership in both directions', () => {
		expect(findLegacyOwners(files)).toEqual(LEGACY_OWNERS)
	})

	it('reports a planted owner outside the guide membership', () => {
		const controlPath = 'src/core/LegacyControl.ts'
		// The membership rule accepts a named entity binding from any specifier. This alias import
		// sat outside the earlier relative-specifier population and certifies the widened class.
		const control = {
			...files,
			[controlPath]: "import { MCPLegacy } from '@src/core'\n",
		}
		expect(findLegacyOwners(control)).toEqual([...LEGACY_OWNERS, controlPath].sort())
	})

	it('keeps MCPServer free of legacy ownership spellings', () => {
		const source = requireValue(
			files['src/core/MCPServer.ts'],
			'Missing file: src/core/MCPServer.ts',
		)
		const pattern = /\b(?:MCPLegacy|legacy)\b/iu
		expect(source).not.toMatch(pattern)
		expect(`${source}\nconst era = 'legacy'\n`).toMatch(pattern)
	})
})

// The published faces in one table. `SOURCES`, the refusal rows, the live population rows,
// and the package.json export-key check all read it, so a face's scope and its export key have
// exactly one place to be stated. No row carries a hand-picked foreign symbol; each row's negative
// control is derived below from what its neighbours really publish.
const FACES = Object.freeze(
	Object.entries(MODULES).map(([specifier, module]) => ({ specifier, module })),
)
const SOURCES: ReadonlyMap<string, ReturnType<typeof createSource>> = new Map(
	FACES.map((face): [string, ReturnType<typeof createSource>] => [
		face.specifier,
		requireValue(sourceManager.source(face.specifier), `Unmapped specifier: ${face.specifier}`),
	]),
)

// The core-face scope-guard invariant, stated once because it is a property of an expectation and
// not of a hand-picked set of rows: ANY row whose expectation names `createMCPRoutes` against
// `@orkestrel/mcp` is a live core-face scope guard, since `createMCPRoutes` is declared only in
// `src/server` — widen `src/core` to swallow the server module and every such expectation collapses
// to `[]`. The rows matching it are deliberately NOT enumerated anywhere: an enumeration goes stale
// the moment a row is added, and a stale one reads as permission to edit every row it omits. Most
// matching rows carry no comment saying so, and that silence carries no meaning. Changing the
// specifier or the symbol in a matching row disarms a scope guard, silently.
describe('public package faces', () => {
	it('selects each exact face for named imports and rejects unknown true self subpaths', () => {
		expect(
			findMissingNamedImports(
				"import { createMCPServer } from '@orkestrel/mcp'",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toEqual([])
		expect(
			findMissingNamedImports(
				"import { serveMCP } from '@orkestrel/mcp/browser'",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toEqual([])
		expect(
			findMissingNamedImports(
				"import { createMCPRoutes } from '@orkestrel/mcp/server'",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toEqual([])
		expect(
			findMissingNamedImports(
				"import { createMCPRoutes } from '@orkestrel/mcp'",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toEqual(['createMCPRoutes'])
		expect(() =>
			findMissingNamedImports(
				"import { createMCPServer } from '@orkestrel/mcp/internal'",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toThrow('Unmapped self specifier: @orkestrel/mcp/internal')
		expect(
			findMissingNamedImports(
				"import { createMCPServer } from '@orkestrel/mcp-extra'",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toEqual([])
	})

	// One refusal row per face, bound against BOTH of its neighbours. A row's control is every name
	// a neighbour publishes and this face does not, read off the neighbour's live Source: a literal
	// covers one ordered pair and goes stale silently, while the derived difference
	// covers every pair and cannot. Asserting that difference non-empty is the precondition the
	// refusal needs to mean anything, and it is also what a widened `module` breaks — a face that
	// swallows its neighbour's module leaves that neighbour nothing of its own to refuse, so the
	// row reports an empty control instead of passing on a refusal it has stopped making.
	for (const face of FACES) {
		const own = createSource({ files, module: face.module })
			.surface()
			.map((symbol) => symbol.name)
		const neighbours = FACES.filter((other) => other !== face).map((other) =>
			Array.from(
				new Set(
					createSource({ files, module: other.module })
						.surface()
						.map((symbol) => symbol.name),
				),
			).filter((name) => !own.includes(name)),
		)

		it(`refuses every name a neighbouring face owns on ${face.specifier}`, () => {
			for (const foreign of neighbours) {
				expect(foreign.length).toBeGreaterThan(0)
				expect(
					findMissingNamedImports(
						`import { ${foreign.join(', ')} } from '${face.specifier}'`,
						SOURCES,
						'@orkestrel/mcp',
					),
				).toEqual(foreign)
			}
		})
	}

	// Both brace shapes, single-line and multiline, since the multiline one is the shape a real
	// guide example reaches for as soon as it imports more than a name or two.
	it('rejects a repository alias specifier in a named-brace import', () => {
		for (const specifier of ['@src/core', '@src/browser', '@src/server', '@app/server']) {
			for (const fence of [
				`import { createMCPServer } from '${specifier}'`,
				`import {\n\tcreateMCPServer,\n} from '${specifier}'`,
			]) {
				expect(() => findMissingNamedImports(fence, SOURCES, '@orkestrel/mcp')).toThrow(
					`Repository alias specifier: ${specifier}`,
				)
			}
		}
	})

	// An intentional recorded limit, not a guarantee: this row asserts what the check does NOT do,
	// so it goes red only if someone IMPROVES the refusal, and that is deliberate. Both refusals —
	// unmapped self subpath and repository alias — see exactly what `extractFenceImports` surfaces, and
	// what it surfaces is decided by its grammar, stated in full in the `findMissingNamedImports`
	// TSDoc: `import`, whitespace, optionally `type` AND its own trailing whitespace, then the
	// brace, and so on to the quoted specifier. The fences below are EXAMPLES of statements that
	// grammar excludes, never the list of them — a form nobody enumerated is settled by reading the
	// grammar sentence, not by its absence here. The mixed default-and-named form is the one that
	// surprises: those are named bindings Guide is meant to surface and does not, so it is an
	// upstream `extractFenceImports` limit rather than a boundary chosen here, and no fence in `guides/`
	// uses it today. Closing any of these locally would mean a second import reader beside Guide's,
	// which AGENTS.md's ban on a second source-language analyzer forbids; the remedy that remains
	// is to record the gap where a
	// reader meets it, here and in that TSDoc. When one of these forms starts being reached, move
	// that fence to a row asserting the behaviour it now has — the other fences are independent
	// pins and do not travel with it.
	it('records example import forms no refusal reaches', () => {
		for (const fence of [
			"import * as MCP from '@orkestrel/mcp/internal'",
			"import MCP from '@orkestrel/mcp/internal'",
			"import '@orkestrel/mcp/internal'",
			"import MCP, { createMCPServer } from '@orkestrel/mcp/internal'",
			"import * as MCP from '@src/core'",
			"import MCP from '@src/core'",
			"import '@src/core'",
			"import MCP, { createMCPServer } from '@src/core'",
			"import MCP, * as NS from '@src/core'",
			"import{createMCPServer}from'@src/core'",
			"import type{createMCPServer}from'@src/core'",
			"const loaded = await import('@src/core')",
			"export { createMCPServer } from '@src/core'",
			"export * from '@src/core'",
		]) {
			expect(findMissingNamedImports(fence, SOURCES, '@orkestrel/mcp')).toEqual([])
		}
	})

	it('retains a block-commented named binding', () => {
		expect(
			findMissingNamedImports(
				"import { createMCPRoutes /* server face */ } from '@orkestrel/mcp'",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toEqual(['createMCPRoutes'])
	})

	// A comment carrying its own `}` terminates Guide's raw `{([^}]*)}` scan there, so the raw
	// reading matches no import at all rather than losing one binding. Erasing the comment, and
	// with it that brace, is what makes the statement visible, so this row binds the projection
	// itself rather than a trivia position.
	it('retains a named binding whose block comment carries a brace', () => {
		expect(
			findMissingNamedImports(
				"import { createMCPRoutes /* } */ } from '@orkestrel/mcp'",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toEqual(['createMCPRoutes'])
	})

	// This row owns Guide's trivia contract and retains the core-face check that constrains edits.
	// Guide's own trivia handling is asserted here, so a dependency upgrade is caught here instead of
	// quietly changing what `findMissingNamedImports` covers: the row characterizes the FAMILY —
	// every trivia position that costs the raw reading a binding, inside the brace and outside it
	// — and pairs each with the projected reading that recovers it. The raw and projected columns
	// differing is what makes the projection load-bearing rather than decorative, and a position
	// that stops being dropped raw, or stops being recovered projected, belongs in this table on
	// the day it changes. The recovery loop's face contract names `createMCPRoutes` against
	// `@orkestrel/mcp`, so the core-face invariant stated above this describe applies to them
	// unchanged. Change a specifier or a symbol here only with that face check in mind.
	it('characterizes what Guide drops raw and recovers projected, and checks the face', () => {
		// Inside the brace: the statement is still matched, and the binding alone is lost.
		expect(
			extractFenceImports("import { createMCPRoutes /* server face */ } from '@orkestrel/mcp'"),
		).toEqual([{ specifier: '@orkestrel/mcp', names: [] }])
		// Inside the brace, carrying its own `}`, and outside it in positions the raw
		// reading admits only as whitespace: the whole statement is lost, not just the binding.
		for (const fence of [
			"import { createMCPRoutes /* } */ } from '@orkestrel/mcp'",
			"import /* server face */ { createMCPRoutes } from '@orkestrel/mcp'",
			"import { createMCPRoutes } /* server face */ from '@orkestrel/mcp'",
			"import { createMCPRoutes } from /* server face */ '@orkestrel/mcp'",
		]) {
			expect(extractFenceImports(fence)).toEqual([])
		}
		for (const fence of [
			"import { createMCPRoutes /* server face */ } from '@orkestrel/mcp'",
			"import { createMCPRoutes /* } */ } from '@orkestrel/mcp'",
			"import /* server face */ { createMCPRoutes } from '@orkestrel/mcp'",
			"import { createMCPRoutes } /* server face */ from '@orkestrel/mcp'",
			"import { createMCPRoutes } from /* server face */ '@orkestrel/mcp'",
		]) {
			expect(findMissingNamedImports(fence, SOURCES, '@orkestrel/mcp')).toEqual(['createMCPRoutes'])
		}
	})

	it('retains a line-commented named binding', () => {
		expect(
			findMissingNamedImports(
				"import { createMCPRoutes // server face\n} from '@orkestrel/mcp'",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toEqual(['createMCPRoutes'])
	})

	it('retains aliased and type-prefixed bindings across a commented multiline brace', () => {
		const fence = [
			'import {',
			'\tcreateMCPRoutes as routes, /* server face */',
			'\ttype HTTPTransportOptions,',
			"} from '@orkestrel/mcp'",
		].join('\n')
		expect(findMissingNamedImports(fence, SOURCES, '@orkestrel/mcp')).toEqual([
			'createMCPRoutes',
			'HTTPTransportOptions',
		])
	})

	it('reads no import out of a comment', () => {
		const fence = [
			"// import { createMCPRoutes } from '@orkestrel/mcp'",
			"/* import { serveMCP } from '@orkestrel/mcp' */",
		].join('\n')
		expect(findMissingNamedImports(fence, SOURCES, '@orkestrel/mcp')).toEqual([])
	})

	it('reads no import out of a template literal', () => {
		expect(
			findMissingNamedImports(
				"const snippet = `import { createMCPRoutes } from '@orkestrel/mcp'`",
				SOURCES,
				'@orkestrel/mcp',
			),
		).toEqual([])
	})

	// This row owns Guide's string-projection contract and retains its core-face check.
	// `extractSourceLines` keeps quoted text verbatim, so
	// for a fence whose import lives inside an ordinary string the projection is the identity, and
	// an upgrade that started masking string payloads would fail here and take the
	// `findMissingNamedImports` @remarks with it. The face contract names `createMCPRoutes`
	// against `@orkestrel/mcp`, so the core-face invariant stated above this describe applies to it
	// unchanged. Change the specifier or the symbol here only with that face check in mind.
	it('reads an import out of an ordinary string literal and still checks it against the face', () => {
		for (const fence of [
			'const snippet = "import { createMCPRoutes } from \'@orkestrel/mcp\'"',
			'const snippet = \'import { createMCPRoutes } from "@orkestrel/mcp"\'',
		]) {
			expect(findMissingNamedImports(fence, SOURCES, '@orkestrel/mcp')).toEqual(['createMCPRoutes'])
		}
	})

	// The population control for the row above, and what binds the corrected `@remarks` clause in
	// both directions. That row pins the MAPPED specifier `@orkestrel/mcp`, so every fence in it is
	// drawn from inside the instrument's own membership rule — `SOURCES` key membership. It can show
	// that a string-embedded import ENTERS the check; it can never show what entering amounts to
	// when `sources.get` misses, so on its own it reads as a promise of a face. This fence sits
	// outside that rule: an unmapped foreign specifier, kept verbatim by the projection exactly as
	// the sibling row proves, surfaced by `extractFenceImports` as its explicit expectation records, reached
	// by neither refusal, and therefore compared against NO face. The `[]` is that absence, not a
	// clean bill. The sibling row is what catches a projection that started masking ordinary-string
	// payloads — its `['createMCPRoutes']` collapses to `[]` if that ever happens, and this row would
	// not, since `extractFenceImports` reads the raw fence and never consults the projection. What the
	// surfaced-statement expectation records here is narrower and still worth pinning: that Guide's
	// grammar surfaces a string-embedded statement at all, without which the `[]` beside it would go
	// vacuous. Do not re-specifier this row onto a mapped face: the sibling row already owns
	// that population, and merging the two leaves the boundary uncontrolled again.
	it('checks a string-embedded unmapped foreign import against no face', () => {
		const fence = 'const snippet = "import { createMCPServer } from \'@orkestrel/mcp-extra\'"'
		expect(extractFenceImports(fence)).toEqual([
			{ specifier: '@orkestrel/mcp-extra', names: ['createMCPServer'] },
		])
		expect(findMissingNamedImports(fence, SOURCES, '@orkestrel/mcp')).toEqual([])
	})

	// A recorded reader limit, where the `hazard` expectation is the gap rather than a guarantee: it
	// asserts `[]` for a fence whose real import has disappeared, so this row goes red only if
	// someone IMPROVES the projection. Guide's reader is lexical rather than a TypeScript parse,
	// so a slash after a bare `}` reads as division and swallows the rest of the fence; `guarded`
	// proves an explicit `;` restores it, which is the workaround a guide author needs. This row
	// does more than one job, so when the limit moves, RE-PIN `hazard` to the behaviour Guide then has —
	// never delete the row. `guarded` names `createMCPRoutes` against `@orkestrel/mcp`, so the
	// core-face invariant stated above this describe applies to it, and deleting the row to retire
	// the limit would retire that binding with it.
	it('follows the documented division reading of a slash after a bare brace', () => {
		const guarded = [
			'const config = {};',
			"/[/*]/.test('x')",
			"import { createMCPRoutes } from '@orkestrel/mcp'",
		].join('\n')
		const hazard = [
			'const config = {}',
			"/[/*]/.test('x')",
			"import { createMCPRoutes } from '@orkestrel/mcp'",
		].join('\n')
		expect(findMissingNamedImports(guarded, SOURCES, '@orkestrel/mcp')).toEqual(['createMCPRoutes'])
		expect(findMissingNamedImports(hazard, SOURCES, '@orkestrel/mcp')).toEqual([])
	})

	it('derives the exact package export keys from the same face map', () => {
		const parsed: unknown = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		)
		if (!isRecord(parsed) || !('exports' in parsed) || !isRecord(parsed['exports'])) {
			throw new Error('Package manifest must declare object exports')
		}
		const expected = FACES.map((face) =>
			face.specifier === '@orkestrel/mcp'
				? '.'
				: `.${face.specifier.slice('@orkestrel/mcp'.length)}`,
		)
		expect(Object.keys(parsed['exports']).sort()).toEqual(expected.concat('./package.json').sort())
		expect(parsed['exports']['./package.json']).toBe('./package.json')
	})
})

describe('guides/mcp.md tools/list request metadata', () => {
	it('requires modern metadata before the guide request succeeds', async () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', execute: (args) => Number(args['x']) + Number(args['y']) }))
		const server = createMCPServer({
			identity: { name: 'calculator', version: '1.0.0' },
			tools,
		})
		const unstamped = await server.handle('{"jsonrpc":"2.0","method":"tools/list","id":1}')
		const stamped = await server.handle(
			'{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}',
		)

		expect(unstamped).toBe(
			'{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params: request declares no protocol version"}}',
		)
		expect(stamped).toBe(
			'{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"add","inputSchema":{"type":"object"}}],"resultType":"complete","ttlMs":60000,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"calculator","version":"1.0.0"}}}}',
		)
	})
})

// The server and browser faces declare the same class, and only the browser barrel re-exports
// it: the server face strands `HTTPClientTransport`, and reading both faces as one scope hides
// that.
const FIXTURE_FILES: Readonly<Record<string, string>> = Object.freeze({
	'browser/index.ts': "export * from './HTTPClientTransport.js'\n",
	'browser/HTTPClientTransport.ts': 'export class HTTPClientTransport {}\n',
	'server/index.ts': "export * from './HTTPServerTransport.js'\n",
	'server/HTTPServerTransport.ts': 'export class HTTPServerTransport {}\n',
	'server/HTTPClientTransport.ts': 'export class HTTPClientTransport {}\n',
})

// The live faces and that fixture run through one carrier, so the negative control shares the
// live gate's instrument instead of standing beside it. The kinds of row prove different
// things, and only one of them is a scope guard. The FIXTURE rows are the instrument's negative
// control: `stranded server face` forces it to report a non-empty answer, and reading browser and
// server as one scope makes that same answer disappear — the masking a widened scope causes. The
// LIVE rows cannot show that, because a union of internally-complete barrels is itself internally
// complete: their `stranded`/`phantom` expectations stay `[]` under every union of the real faces,
// so a widened `module` passes them unremarked. What binds each live face's scope is that face's
// own neighbour-refusal row above, not these rows; what these rows catch is a real declaration
// going stranded or phantom inside one barrel. The population sizes stay asserted because a
// mistyped module path yields two empty populations, and two empty populations differ by nothing.
const POPULATIONS = Object.freeze([
	...FACES.map((face) => ({
		name: `${face.specifier} barrel`,
		files,
		module: face.module,
		stranded: [],
		phantom: [],
	})),
	{
		name: 'stranded server face',
		files: FIXTURE_FILES,
		module: 'server',
		stranded: ['class HTTPClientTransport'],
		phantom: [],
	},
	{
		name: 'browser and server faces read as one scope',
		files: FIXTURE_FILES,
		module: ['browser', 'server'],
		stranded: [],
		phantom: [],
	},
])

for (const entry of POPULATIONS) {
	const source = createSource({ files: entry.files, module: entry.module })

	describe(`${entry.name}`, () => {
		it('has non-empty direct and barrel populations', () => {
			expect(source.exports().length).toBeGreaterThan(0)
			expect(source.surface().length).toBeGreaterThan(0)
		})
		it('strands exactly its expected declarations', () => {
			expect(findMissingSymbols(source.exports(), source.surface())).toEqual(entry.stranded)
		})
		it('re-exports exactly its expected phantom symbols', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual(entry.phantom)
		})
	})
}

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
		})

		it('extracts non-empty aggregate barrel and documented surfaces', () => {
			expect(source.surface().length).toBeGreaterThan(0)
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('re-exports every direct declaration that is not named internal', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(computeSymbolKey)).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.kind === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('named imports reference only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				expect(findMissingNamedImports(fence.code, SOURCES, '@orkestrel/mcp')).toEqual([])
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}

// ── The stdio client transport's spawn contract, executed ────────────────────
//
// A parity assertion proves a documented name resolves. It can never reach a sentence about
// behaviour, which is how `guides/mcp.md` § stdio transport carried false ones through a
// green gate: that `createStdioClientTransport` spawns through `node:child_process.spawn` with
// a provided `env` REPLACING `process.env`, and that the child's `stderr` INHERITS the parent's.
// Both are now stated the other way round in the guide, so both are executed here.
//
// One child reports what it actually received. Each transport reading is contrasted with the same
// reading taken from a raw `node:child_process.spawn` configured the way the old sentences
// described this transport — `env` replacing and `stderr` inheriting. Those controls sit outside
// this package entirely, which is what makes these assertions evidence rather than a restatement
// of the source.
//
// The host facts below decide what each control can compare:
//
// - Windows injects a host set — `PATH`, `SYSTEMROOT`, `TEMP`, `USERPROFILE`, and more — into any
//   explicit environment, so a child of a REPLACING spawn there reads its parent's own `PATH`
//   unchanged. `PATH` separates a merge from a replacement on a POSIX host alone.
//   `guides/process.md` § The child environment owns that law. What separates them on every host
//   is a key this test names itself, outside the injected set.
// - `fstat` gives a Windows anonymous pipe no file id and reports a per-process handle value as
//   `ino` instead, so two processes holding the SAME pipe read different identities and one
//   process reads a different identity for every child it hands that pipe down to. A `dev:ino`
//   comparison across a process boundary carries meaning only for a descriptor that has a file
//   id. The inherit control therefore hands its child a scratch FILE, not this process's own
//   `stderr`, which under this runner is exactly such a pipe.

/** The bytes the reporting child writes to its own `stderr` before it answers. */
const STDERR_SENTINEL = 'stderr-sentinel'

/** The scratch file the inherit control hands down as its relay's `stderr`. */
const STDERR_FILE = 'stderr.log'

/**
 * One request, one JSON-RPC reply carrying what the spawned child's environment and `stderr` are.
 *
 * The kind reading masks the mode bits itself: `Stats.isFIFO()` answers `false` for a Windows
 * anonymous pipe whose mode carries `S_IFIFO`, so the derived answer is the one that travels.
 */
const REPORT_SCRIPT = `
const readline = require('node:readline')
const { constants, fstatSync } = require('node:fs')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
	const message = JSON.parse(line)
	if (message.method !== 'report') return
	process.stderr.write(${JSON.stringify(STDERR_SENTINEL)})
	const stderr = fstatSync(2)
	process.stdout.write(JSON.stringify({
		jsonrpc: '2.0',
		id: message.id,
		result: {
			path: process.env.PATH,
			supplied: process.env.MCP_GUIDE_SUPPLIED,
			inherited: process.env.MCP_GUIDE_INHERITED,
			absent: process.env.MCP_GUIDE_ABSENT,
			stderr: String(stderr.dev) + ':' + String(stderr.ino),
			// A stdio pipe is a FIFO on some hosts and a socketpair on others: this host reports
			// S_IFSOCK for the very descriptor Node created as 'pipe'. Read the property the
			// assertion needs — a channel the supervisor made — rather than one host's spelling of
			// it. The inherit control hands down a regular file, which is neither, so the reading
			// still separates the two.
			pipe:
				(stderr.mode & constants.S_IFMT) === constants.S_IFIFO
				|| (stderr.mode & constants.S_IFMT) === constants.S_IFSOCK,
		},
	}) + '\\n')
})
`

/**
 * A raw spawn whose `stdio` slot 2 is `'inherit'`, run one level down from this test.
 *
 * The relay is what makes `'inherit'` measurable. This process cannot name its own `stderr` across
 * a process boundary on every host, so it hands the relay a scratch file instead and reads that
 * file's identity back out of the grandchild `'inherit'` passes it down to.
 */
const RELAY_SCRIPT = `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', ${JSON.stringify(REPORT_SCRIPT)}], {
	stdio: ['pipe', 'pipe', 'inherit'],
})
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
`

/** The `env` this guide's claim is about: one key the parent does not carry. */
const SUPPLIED_ENVIRONMENT = Object.freeze({ MCP_GUIDE_SUPPLIED: 'supplied' })

/** The key this process carries and never supplies, so only a merge can put it in a child. */
const INHERITED = Object.freeze({ key: 'MCP_GUIDE_INHERITED', value: 'inherited' })

function readReport(value: unknown): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) throw new Error('The child returned no JSON-RPC envelope')
	const result = value['result']
	if (!isRecord(result)) throw new Error('The child returned no result record')
	return result
}

/** The identity `fstat` reports for one descriptor, in the shape the reporting child reports it. */
function readIdentity(descriptor: number): string {
	const stat = fstatSync(descriptor)
	return `${String(stat.dev)}:${String(stat.ino)}`
}

async function reportThroughTransport(): Promise<Readonly<Record<string, unknown>>> {
	const transport = createStdioClientTransport({
		command: process.execPath,
		args: ['-e', REPORT_SCRIPT],
		env: SUPPLIED_ENVIRONMENT,
	})
	const arrived = new Promise<JSONRPCMessage>((resolve) => {
		transport.emitter.on('message', resolve)
	})
	try {
		await transport.start()
		await transport.send({ jsonrpc: '2.0', id: 1, method: 'report' })
		const message = await waitForSettlement(
			arrived,
			10_000,
			'Timed out waiting for the spawned child report',
		)
		return readReport(message)
	} finally {
		await transport.close()
	}
}

/**
 * Drive the reporting child and answer the tail its transport retained, read after `close()`.
 *
 * The child writes {@link STDERR_SENTINEL} to its own `stderr` before it answers, so the reading is
 * taken after the sentinel has arrived rather than at whatever moment the reply happened to land.
 */
async function readEvidenceThroughTransport(): Promise<string | undefined> {
	const transport = createStdioClientTransport({
		command: process.execPath,
		args: ['-e', REPORT_SCRIPT],
		env: SUPPLIED_ENVIRONMENT,
	})
	const arrived = new Promise<JSONRPCMessage>((resolve) => {
		transport.emitter.on('message', resolve)
	})
	try {
		await transport.start()
		await transport.send({ jsonrpc: '2.0', id: 1, method: 'report' })
		await waitForSettlement(arrived, 10_000, 'Timed out waiting for the spawned child report')
		await waitForCondition(
			'the reporting child stderr sentinel reaches the transport evidence',
			() => transport.evidence?.includes(STDERR_SENTINEL) === true,
			{ budget: 10_000 },
		)
	} finally {
		await transport.close()
	}
	return transport.evidence
}

/** Answer the tail retained for the same child left unasked, so it writes no `stderr` at all. */
async function readSilentEvidenceThroughTransport(): Promise<string | undefined> {
	const transport = createStdioClientTransport({
		command: process.execPath,
		args: ['-e', REPORT_SCRIPT],
		env: SUPPLIED_ENVIRONMENT,
	})
	try {
		await transport.start()
	} finally {
		await transport.close()
	}
	return transport.evidence
}

/** Drive one raw-spawn control through its stdout pipe and read back the one report line. */
async function readSpawnReport(child: ChildProcess): Promise<Readonly<Record<string, unknown>>> {
	const stdout = child.stdout
	const stdin = child.stdin
	if (stdout === null || stdin === null) throw new Error('The control child has no stdio pipes')
	try {
		let buffer = ''
		const line = new Promise<string>((resolve) => {
			stdout.setEncoding('utf8')
			stdout.on('data', (chunk: string) => {
				buffer += chunk
				const newline = buffer.indexOf('\n')
				if (newline !== -1) resolve(buffer.slice(0, newline))
			})
		})
		stdin.write('{"jsonrpc":"2.0","id":1,"method":"report"}\n')
		const text = await waitForSettlement(
			line,
			10_000,
			'Timed out waiting for the control child report',
		)
		return readReport(JSON.parse(text))
	} finally {
		child.kill()
	}
}

/**
 * The environment control: a raw spawn whose `env` REPLACES `process.env`.
 *
 * Its `stderr` is dropped because the reporting child writes a sentinel there and this control
 * makes no claim about that descriptor. The inherit control owns that claim.
 */
async function reportThroughReplacingSpawn(): Promise<Readonly<Record<string, unknown>>> {
	return await readSpawnReport(
		spawn(process.execPath, ['-e', REPORT_SCRIPT], {
			env: { ...SUPPLIED_ENVIRONMENT },
			stdio: ['pipe', 'pipe', 'ignore'],
		}),
	)
}

/** The `stderr` control: a raw spawn that INHERITS the descriptor this test handed its relay. */
async function reportThroughInheritingSpawn(
	descriptor: number,
): Promise<Readonly<Record<string, unknown>>> {
	return await readSpawnReport(
		spawn(process.execPath, ['-e', RELAY_SCRIPT], { stdio: ['pipe', 'pipe', descriptor] }),
	)
}

describe('guides/mcp.md § stdio transport — what the spawned child actually receives', () => {
	let owned: { readonly scratch: ScratchInterface; readonly descriptor: number } | undefined

	beforeAll(() => {
		process.env[INHERITED.key] = INHERITED.value
		const scratch = createScratch()
		scratch.write(STDERR_FILE, '')
		owned = { scratch, descriptor: openSync(join(scratch.path, STDERR_FILE), 'a') }
	})

	afterAll(() => {
		if (owned !== undefined) {
			closeSync(owned.descriptor)
			owned.scratch.destroy()
		}
		owned = undefined
		delete process.env[INHERITED.key]
	})

	it('MERGES a provided env over process.env, so the child inherits every key the guide says it does', async () => {
		const inherited = process.env['PATH']
		expect(typeof inherited).toBe('string')
		expect(inherited).not.toBe('')

		const report = await reportThroughTransport()

		// The sentence the guide now carries: an unlisted parent key still reaches the child. A
		// Windows child reads `PATH` under a replacing spawn too, so the key below is what
		// separates a merge from a replacement on every host.
		expect(report['path']).toBe(inherited)
		expect(report['inherited']).toBe(INHERITED.value)
		// The override layer works, so the merge is a merge and not a plain inherit.
		expect(report['supplied']).toBe('supplied')
		// The readout can report absence, so the assertions above are not an artifact of it
		// always returning something.
		expect(report['absent']).toBeUndefined()
	})

	it('CONTROL — a raw spawn whose env REPLACES the parent withholds every key only the parent carries', async () => {
		const report = await reportThroughReplacingSpawn()

		expect(report['inherited']).toBeUndefined()
		expect(report['absent']).toBeUndefined()
		expect(report['supplied']).toBe('supplied')
	})

	it('PIPES the child stderr, so the parent stderr never receives a byte of it', async () => {
		const report = await reportThroughTransport()

		// A fresh pipe the supervisor made, rather than a descriptor this process handed down.
		// The inherit control proves this reading can report the other answer: a handed-down
		// descriptor carrying a file id reads `false` there.
		//
		// The reading separates the two only on a host whose own `stderr` carries a file id.
		// Under a runner that hands its worker an anonymous pipe — this one — an inherited
		// descriptor reads as a pipe too, and no descriptor this process can name tells them
		// apart. A console or file `stderr` closes that gap without touching this assertion.
		expect(report['pipe']).toBe(true)
	})

	it("CONTROL — a raw spawn with stdio 'inherit' hands the child the exact descriptor its parent holds", async () => {
		const held = requireValue(owned)

		const report = await reportThroughInheritingSpawn(held.descriptor)

		// The grandchild reports the scratch file this test handed the relay, identity and kind.
		expect(report['stderr']).toBe(readIdentity(held.descriptor))
		expect(report['pipe']).toBe(false)
		// And the bytes it wrote to that descriptor landed in the file this process owns.
		expect(held.scratch.read(STDERR_FILE)).toBe(STDERR_SENTINEL)
	})

	it('RETAINS that piped stderr as evidence, so the sentinel survives the transport close', async () => {
		// The bytes the parent never received are the bytes `evidence` carries. A pipe the guide
		// documents as retained is only retained if a consumer can still read it after the child is
		// gone, and this is the reading the guide's evidence sentence rests on.
		expect(await readEvidenceThroughTransport()).toBe(STDERR_SENTINEL)
	})

	it('CONTROL — the same child left unasked writes no stderr and reads an empty tail', async () => {
		expect(await readSilentEvidenceThroughTransport()).toBe('')
	})
})

// ── The flagship stdio composition, executed ─────────────────────────────────
//
// `guides/mcp.md` § stdio transport wires `createStdioServer(createMCPLegacy(mcp)).start()` and
// its trailing comment claims two things: that the composition answers `initialize`, and that
// passing `mcp` alone subtracts exactly that. Parity proves both names resolve and neither
// sentence. So the fence's composition is transcribed here and driven over the injectable stream
// pair the same factory documents — the same dispatcher value, reached through the same call.
//
// The bare dispatcher is the control, and it is the comment's own subtraction: it sits outside
// the decorated population, and it answers the refusal the modern seam owes an unregistered
// method instead of a handshake.

/** The dated handshake a legacy MCP client opens with, framed as the transport frames it. */
const LEGACY_INITIALIZE =
	'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"guide","version":"1.0.0"}}}'

/** A legacy-only stdio peer that answers the adapter handshake and refuses other requests. */
const LEGACY_PEER_SCRIPT = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
	const message = JSON.parse(line)
	if (message.id === undefined) return
	const response = message.method === 'initialize'
		? {
				jsonrpc: '2.0',
				id: message.id,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: { tools: {} },
					serverInfo: { name: 'legacy-peer', version: '1.0.0' },
				},
			}
		: {
				jsonrpc: '2.0',
				id: message.id,
				error: { code: -32601, message: 'Method not found: ' + message.method },
			}
	process.stdout.write(JSON.stringify(response) + '\\n')
})
`

/** Read one newline-framed reply off a stdio server's injected output stream. */
async function readStdioReply(output: PassThrough): Promise<unknown> {
	let buffer = ''
	const line = new Promise<string>((resolve) => {
		output.setEncoding('utf8')
		output.on('data', (chunk: string) => {
			buffer += chunk
			const newline = buffer.indexOf('\n')
			if (newline !== -1) resolve(buffer.slice(0, newline))
		})
	})
	const text = await waitForSettlement(line, 10_000, 'Timed out waiting for the stdio server reply')
	return JSON.parse(text)
}

/** Drive one framed request through a `createStdioServer` pump over injected streams. */
async function driveStdioServer(mcp: MCPDispatcherInterface, request: string): Promise<unknown> {
	const input = new PassThrough()
	const output = new PassThrough()
	const stdio = createStdioServer(mcp, { input, output })
	stdio.start()
	try {
		const reply = readStdioReply(output)
		input.write(`${request}\n`)
		return await reply
	} finally {
		stdio.stop()
	}
}

/** The fence's own server: the docs identity over an empty tool registry. */
function createGuideServer(): ReturnType<typeof createMCPServer> {
	return createMCPServer({
		identity: { name: 'docs', version: '1.0.0' },
		tools: createToolManager(),
	})
}

/** Drives the fence's consumer-side adapter over a spawned legacy stdio peer. */
async function readGuideClientVersion(): Promise<string | undefined> {
	const carrier = createStdioClientTransport({
		command: process.execPath,
		args: ['-e', LEGACY_PEER_SCRIPT],
	})
	const client = createMCPClient({
		transport: createMCPLegacyClientTransport(carrier, { timeout: 10_000 }),
		timeout: 10_000,
	})
	try {
		await client.connect()
		return client.version
	} finally {
		await client.disconnect()
	}
}

describe('guides/mcp.md § stdio transport — what the consumer-visible client exposes', () => {
	it('keeps the client modern through the legacy stdio adapter', async () => {
		await expect(readGuideClientVersion()).resolves.toBe('2026-07-28')
	})
})

describe('guides/mcp.md § stdio transport — what the composed server answers', () => {
	it('answers a legacy initialize, as the composed fence claims', async () => {
		const answer = await driveStdioServer(createMCPLegacy(createGuideServer()), LEGACY_INITIALIZE)

		expect(answer).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: {
				protocolVersion: '2025-11-25',
				capabilities: { tools: {} },
				serverInfo: { name: 'docs', version: '1.0.0' },
			},
		})
	})

	it('CONTROL — the bare dispatcher the comment names refuses that same handshake', async () => {
		const answer = await driveStdioServer(createGuideServer(), LEGACY_INITIALIZE)

		expect(answer).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32601, message: 'Method not found: initialize' },
		})
	})
})

// ── The client subscription fence, executed ──────────────────────────────────
//
// `guides/mcp.md` § Consume a subscription from a client claims an ORDER and a SHAPE: the
// acknowledgement is the first YIELD, every stamped frame follows it in wire order, and the
// graceful terminal is the generator's RETURN value rather than a yield. Parity proves that
// `listen` exists and proves no sentence about what it delivers. So the fence's reads are
// transcribed here and driven against a real in-process `MCPServer` over the duplex loopback —
// the carrier the same section names as the one that delivers incrementally.
//
// Membership rule of the instrument: a notification carrying this subscription's reserved id
// enters the stream, and one carrying no id does not. Both are injected through the SAME
// transport door while the subscription is live, so the negative reading reports on the
// stamping rather than on a delivery path that was dead. A route that claimed every inbound
// notification would satisfy every ordering assertion here and fail the membership row.

/** The honoured families the fence's filter names, as its own fence spells them. */
const GUIDE_SUBSCRIPTION_FILTER = Object.freeze({
	toolsListChanged: true,
	resourceSubscriptions: Object.freeze(['resource://guide']),
})

/** The unstamped server notification that must stay outside the subscription stream. */
const GUIDE_UNSTAMPED_NOTIFICATION: JSONRPCNotification = {
	jsonrpc: '2.0',
	method: 'notifications/message',
	params: { level: 'info', data: 'outside every subscription' },
}

/** What one run of the fence's reads observed, in the order the fence reads them. */
interface GuideSubscriptionReading {
	readonly opened: IteratorResult<JSONRPCNotification, MCPSubscriptionResult>
	/** The method the fence reads behind its `opened.done === false` guard. */
	readonly acknowledged: string | undefined
	readonly frames: readonly string[]
	readonly closure: MCPSubscriptionResult | undefined
	readonly proven: boolean
	readonly unstamped: readonly string[]
}

/** Report the id the client minted for its `subscriptions/listen` request. */
function findListenId(messages: readonly JSONRPCMessage[]): JSONRPCId | undefined {
	for (const message of messages) {
		if (!('method' in message) || message.method !== 'subscriptions/listen') continue
		if ('id' in message) return message.id
	}
	return undefined
}

/** Drive the fence's `listen` reads against a real subscription server over the loopback. */
async function readGuideSubscription(): Promise<GuideSubscriptionReading> {
	const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
	const transport = createLoopbackTransport(
		createSubscriptionServer(() => source.readable, GUIDE_SUBSCRIPTION_FILTER),
	)
	const client = createMCPClient({ transport })
	const unstamped: string[] = []
	client.emitter.on('notification', (message) => {
		if ('method' in message) unstamped.push(message.method)
	})
	await client.connect()

	const subscription = new AbortController()
	const stream = client.listen(GUIDE_SUBSCRIPTION_FILTER, {
		signal: subscription.signal,
		capacity: 16,
	})
	const opened = await stream.next()
	// The fence's own narrowing, transcribed: the member read sits behind `opened.done === false`,
	// so a run where the first read is not a yield reports no method rather than reading one.
	let acknowledged: string | undefined
	if (opened.done === false) acknowledged = opened.value.method

	// Both injections ride the same transport door, while the subscription is live: the stamped
	// one must enter the stream and the unstamped one must not.
	transport.receive({
		jsonrpc: '2.0',
		method: 'notifications/prompts/list_changed',
		params: { _meta: { [MCP_META_SUBSCRIPTION]: findListenId(transport.messages) } },
	})
	transport.receive(GUIDE_UNSTAMPED_NOTIFICATION)
	const frames: string[] = []
	const injected = await stream.next()
	if (injected.done === false) frames.push(injected.value.method)

	// The fence's own shape: one read per frame, so the consumer is parked when each arrives.
	const writer = source.writable.getWriter()
	await writer.write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
	const tools = await stream.next()
	if (tools.done === false) frames.push(tools.value.method)
	await writer.write({
		jsonrpc: '2.0',
		method: 'notifications/resources/updated',
		params: { uri: 'resource://guide' },
	})
	const resources = await stream.next()
	if (resources.done === false) frames.push(resources.value.method)
	await writer.close()

	let closure: MCPSubscriptionResult | undefined
	const terminal = await stream.next()
	if (terminal.done === true) closure = terminal.value
	subscription.abort()
	await client.disconnect()
	return {
		opened,
		acknowledged,
		frames,
		closure,
		proven: isMCPSubscriptionResult(closure),
		unstamped,
	}
}

/** What the method row's progress-before-discard sentence observed. */
interface GuideProgressReading {
	readonly progress: readonly unknown[]
	readonly notifications: readonly string[]
}

/** Drive active progress and unclaimed stale stamps through the same client transport door. */
async function readGuideProgressClaim(): Promise<GuideProgressReading> {
	const release = Promise.withResolvers<void>()
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'slow',
			execute: async () => {
				await release.promise
				return 'done'
			},
		}),
	)
	const transport = createLoopbackTransport(
		createMCPServer({ identity: { name: 'progress-server', version: '1.0.0' }, tools }),
	)
	const client = createMCPClient({ transport })
	const progress: unknown[] = []
	const notifications: string[] = []
	client.emitter.on('notification', (message) => {
		if ('method' in message) notifications.push(message.method)
	})
	await client.connect()

	const call = client.call('slow', {}, { progress: (report) => progress.push(report) })
	const id = transport.messages.find((message) => message.method === 'tools/call')?.id
	if (id === undefined) throw new Error('Expected the guide call to carry an id')
	transport.receive({
		jsonrpc: '2.0',
		method: 'notifications/progress',
		params: {
			progressToken: id,
			progress: 1,
			_meta: { [MCP_META_SUBSCRIPTION]: 9_999 },
		},
	})
	transport.receive({
		jsonrpc: '2.0',
		method: 'notifications/custom',
		params: { _meta: { [MCP_META_SUBSCRIPTION]: 9_999 } },
	})
	transport.receive({
		jsonrpc: '2.0',
		method: 'notifications/progress',
		params: {
			progressToken: 8_888,
			progress: 2,
			_meta: { [MCP_META_SUBSCRIPTION]: 9_999 },
		},
	})
	await Promise.resolve()
	release.resolve()
	await call
	await client.disconnect()
	return { progress, notifications }
}

/** What one run of the section's bad-`capacity` clause observed. */
interface GuideCapacityReading {
	/** The reason the first read rejected with, or `undefined` when that read resolved. */
	readonly refusal: unknown
	/** Every method the transport carried up to and including that read. */
	readonly methods: readonly string[]
}

/** Drive the capacity clause: a `capacity` below one fails the first read, before any write. */
async function readGuideCapacityRefusal(): Promise<GuideCapacityReading> {
	const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
	const transport = createLoopbackTransport(
		createSubscriptionServer(() => source.readable, GUIDE_SUBSCRIPTION_FILTER),
	)
	const client = createMCPClient({ transport })
	await client.connect()

	const stream = client.listen(GUIDE_SUBSCRIPTION_FILTER, {
		signal: new AbortController().signal,
		capacity: 0,
	})
	// The read is settled rather than awaited: the clause's subject is WHICH way it settles.
	const [read] = await Promise.allSettled([stream.next()])
	const methods = transport.messages.map((message) => message.method)
	await client.disconnect()
	return { refusal: read.status === 'rejected' ? read.reason : undefined, methods }
}

/** The families the burst reading asks for and the server honours, so every write matches. */
const BURST_SUBSCRIPTION_FILTER = Object.freeze({
	toolsListChanged: true,
	promptsListChanged: true,
	resourcesListChanged: true,
})

/** The frames the burst reading writes before it reads anything, in wire order. */
const BURST_METHODS = Object.freeze([
	'notifications/tools/list_changed',
	'notifications/prompts/list_changed',
	'notifications/resources/list_changed',
])

/** Write every frame before the first read — the burst the bounded queue exists to retain. */
async function readBurstSubscription(): Promise<readonly string[]> {
	const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
	const transport = createLoopbackTransport(
		createSubscriptionServer(() => source.readable, BURST_SUBSCRIPTION_FILTER),
	)
	const client = createMCPClient({ transport })
	await client.connect()
	const subscription = new AbortController()
	const stream = client.listen(BURST_SUBSCRIPTION_FILTER, { signal: subscription.signal })
	await stream.next()

	const writer = source.writable.getWriter()
	for (const method of BURST_METHODS) await writer.write({ jsonrpc: '2.0', method })
	await writer.close()

	const frames: string[] = []
	for (;;) {
		const frame = await stream.next()
		if (frame.done === true) break
		frames.push(frame.value.method)
	}
	subscription.abort()
	await client.disconnect()
	return frames
}

describe('guides/mcp.md § Consume a subscription from a client — what the stream delivers', () => {
	it('yields the acknowledgement first, then the stamped frames, and returns the terminal', async () => {
		const reading = await readGuideSubscription()

		expect(reading.opened.done).toBe(false)
		expect(reading.acknowledged).toBe('notifications/subscriptions/acknowledged')
		expect(reading.frames).toEqual([
			'notifications/prompts/list_changed',
			'notifications/tools/list_changed',
			'notifications/resources/updated',
		])
		expect(reading.closure?.resultType).toBe('complete')
		expect(reading.proven).toBe(true)
	})

	it('claims a stamped frame and declines an unstamped one arriving the same way', async () => {
		const reading = await readGuideSubscription()

		expect(reading.frames).toContain('notifications/prompts/list_changed')
		expect(reading.frames).not.toContain('notifications/message')
		expect(reading.unstamped).toEqual(['notifications/message'])
	})

	it('claims active progress before dropping other stale-stamped frames', async () => {
		const reading = await readGuideProgressClaim()

		expect(reading.progress).toEqual([
			{
				progressToken: 2,
				progress: 1,
				_meta: { [MCP_META_SUBSCRIPTION]: 9_999 },
			},
		])
		expect(reading.notifications).toEqual([])
	})

	// The section states that EVERY stamped frame arrives, and the bounded queue is the mechanism
	// that makes it true for frames arriving faster than the consumer reads. A burst written
	// before the first read is exactly that case, and it is the read the sentence rests on.
	it('delivers every frame that arrived before the first read', async () => {
		expect(await readBurstSubscription()).toEqual(BURST_METHODS)
	})

	// The section states a refusal — `-32602` on the first read, before anything is sent — and a
	// substring check would pass whatever the client did. So the refusal is executed: its coded
	// error is read, and the transport's own record answers whether the request was written.
	it('refuses a capacity below one on the first read and sends nothing', async () => {
		const reading = await readGuideCapacityRefusal()

		expect(reading.refusal).toMatchObject({ code: -32602 })
		expect(isMCPError(reading.refusal)).toBe(true)
		expect(reading.methods).toEqual(['server/discover'])
	})
})
