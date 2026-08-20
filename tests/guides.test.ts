// The consumer-side guides-parity drop-in: runs @orkestrel/guide's checks against this
// repository's own guides/README.md manifest. The constants below are this package's
// own, and are what a sibling package changes.

import type { JSONRPCMessage } from '@src/core'
import { isRecord } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { fstatSync, readFileSync } from 'node:fs'
import { createStdioClientTransport } from '@src/server'
import {
	createGuide,
	createSource,
	createSourceManager,
	fenceImports,
	findMissing,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	missingSymbols,
	parseManifest,
	resolveLink,
	symbolKey,
} from '@orkestrel/guide'
import { requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'
import { waitForSettlement } from './setup.js'
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
 * Declarations deliberately kept out of the barrel, as `symbolKey` strings.
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

	it('resolves every relative link', () => {
		const broken = readme
			.links()
			.filter((href) => !isExternalLink(href))
			.map((href) => resolveLink('README.md', href))
			.filter((path) => files[path] === undefined)
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
	// unmapped self subpath and repository alias — see exactly what `fenceImports` surfaces, and
	// what it surfaces is decided by its grammar, stated in full in the `findMissingNamedImports`
	// TSDoc: `import`, whitespace, optionally `type` AND its own trailing whitespace, then the
	// brace, and so on to the quoted specifier. The fences below are EXAMPLES of statements that
	// grammar excludes, never the list of them — a form nobody enumerated is settled by reading the
	// grammar sentence, not by its absence here. The mixed default-and-named form is the one that
	// surprises: those are named bindings Guide is meant to surface and does not, so it is an
	// upstream `fenceImports` limit rather than a boundary chosen here, and no fence in `guides/`
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
			fenceImports("import { createMCPRoutes /* server face */ } from '@orkestrel/mcp'"),
		).toEqual([{ specifier: '@orkestrel/mcp', names: [] }])
		// Inside the brace, carrying its own `}`, and outside it in positions the raw
		// reading admits only as whitespace: the whole statement is lost, not just the binding.
		for (const fence of [
			"import { createMCPRoutes /* } */ } from '@orkestrel/mcp'",
			"import /* server face */ { createMCPRoutes } from '@orkestrel/mcp'",
			"import { createMCPRoutes } /* server face */ from '@orkestrel/mcp'",
			"import { createMCPRoutes } from /* server face */ '@orkestrel/mcp'",
		]) {
			expect(fenceImports(fence)).toEqual([])
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
	// the sibling row proves, surfaced by `fenceImports` as its explicit expectation records, reached
	// by neither refusal, and therefore compared against NO face. The `[]` is that absence, not a
	// clean bill. The sibling row is what catches a projection that started masking ordinary-string
	// payloads — its `['createMCPRoutes']` collapses to `[]` if that ever happens, and this row would
	// not, since `fenceImports` reads the raw fence and never consults the projection. What the
	// surfaced-statement expectation records here is narrower and still worth pinning: that Guide's
	// grammar surfaces a string-embedded statement at all, without which the `[]` beside it would go
	// vacuous. Do not re-specifier this row onto a mapped face: the sibling row already owns
	// that population, and merging the two leaves the boundary uncontrolled again.
	it('checks a string-embedded unmapped foreign import against no face', () => {
		const fence = 'const snippet = "import { createMCPServer } from \'@orkestrel/mcp-extra\'"'
		expect(fenceImports(fence)).toEqual([
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
			expect(missingSymbols(source.exports(), source.surface())).toEqual(entry.stranded)
		})
		it('re-exports exactly its expected phantom symbols', () => {
			expect(missingSymbols(source.surface(), source.exports())).toEqual(entry.phantom)
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
			const stranded = missingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = missingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(missingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(missingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(missingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(symbolKey)).toEqual([])
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
// One child reports what it actually received. Every reading is compared against the same
// reading taken from a raw `node:child_process.spawn` configured the way the old sentences
// described this transport — `env` replacing and `stderr` inheriting. That control sits outside
// this package entirely and reports the opposite of every assertion below, which is what makes
// these assertions evidence rather than a restatement of the source.

/** One request, one JSON-RPC reply carrying what the spawned child's environment and `stderr` are. */
const REPORT_SCRIPT = `
const readline = require('node:readline')
const { fstatSync } = require('node:fs')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
	const message = JSON.parse(line)
	if (message.method !== 'report') return
	const stderr = fstatSync(2)
	process.stdout.write(JSON.stringify({
		jsonrpc: '2.0',
		id: message.id,
		result: {
			path: process.env.PATH,
			supplied: process.env.MCP_GUIDE_SUPPLIED,
			absent: process.env.MCP_GUIDE_ABSENT,
			stderr: String(stderr.dev) + ':' + String(stderr.ino),
		},
	}) + '\\n')
})
`

/** The `env` this guide's claim is about: one key the parent does not carry. */
const SUPPLIED_ENVIRONMENT = Object.freeze({ MCP_GUIDE_SUPPLIED: 'supplied' })

function readReport(value: unknown): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) throw new Error('The child returned no JSON-RPC envelope')
	const result = value['result']
	if (!isRecord(result)) throw new Error('The child returned no result record')
	return result
}

/** The identity of this process's own `stderr`, the thing an inherited descriptor would equal. */
function readOwnStderr(): string {
	const own = fstatSync(2)
	return `${String(own.dev)}:${String(own.ino)}`
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

async function reportThroughReplacingSpawn(): Promise<Readonly<Record<string, unknown>>> {
	const child = spawn(process.execPath, ['-e', REPORT_SCRIPT], {
		env: { ...SUPPLIED_ENVIRONMENT },
		stdio: ['pipe', 'pipe', 'inherit'],
	})
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

describe('guides/mcp.md § stdio transport — what the spawned child actually receives', () => {
	it('MERGES a provided env over process.env, so the child inherits every key the guide says it does', async () => {
		const inherited = process.env['PATH']
		expect(typeof inherited).toBe('string')
		expect(inherited).not.toBe('')

		const report = await reportThroughTransport()

		// The sentence the guide now carries: an unlisted parent key still reaches the child.
		expect(report['path']).toBe(inherited)
		// The override layer works, so the merge is a merge and not a plain inherit.
		expect(report['supplied']).toBe('supplied')
		// The readout can report absence, so the assertions above are not an artifact of it
		// always returning something.
		expect(report['absent']).toBeUndefined()
	})

	it('CONTROL — a raw spawn whose env REPLACES the parent hands the child no PATH at all', async () => {
		const report = await reportThroughReplacingSpawn()

		expect(report['path']).toBeUndefined()
		expect(report['supplied']).toBe('supplied')
	})

	it('PIPES the child stderr, so the parent stderr never receives a byte of it', async () => {
		const report = await reportThroughTransport()

		// A piped descriptor is a fresh pipe: it cannot be the one this process writes to.
		expect(typeof report['stderr']).toBe('string')
		expect(report['stderr']).not.toBe(readOwnStderr())
	})

	it("CONTROL — a raw spawn with stdio 'inherit' hands the child this process's own stderr", async () => {
		const report = await reportThroughReplacingSpawn()

		expect(report['stderr']).toBe(readOwnStderr())
	})
})
