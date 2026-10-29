import type { ScratchInterface } from '@orkestrel/test/server'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: {
		'@orkestrel/mcp': 'src/core',
		'@orkestrel/mcp/browser': 'src/browser',
		'@orkestrel/mcp/server': 'src/server',
	},
	languages: ['text', 'ts'],
	language: 'ts',
	reader: readInventory,
	runner: createVitest,
}).execute(async (context) => {
	const { EXAMPLE_LANGUAGE } = await import('./setupServer.js')
	const { createMCPLegacy, createMCPServer, isMCPError, MCP_META_SUBSCRIPTION } =
		await import('@src/core')

	const { isRecord } = await import('@orkestrel/contract')
	const { createTool, createToolManager } = await import('@orkestrel/tool')
	const { afterAll, beforeAll, describe, expect, it } = await import('vitest')
	const {
		computeSymbolKey,
		createGuide,
		createSource,
		createSourceManager,
		extractFenceImports,
		findMissing,
		findMissingSymbols,
		findUnexampled,
		isExternalLink,
		resolveLink,
	} = await import('@orkestrel/guide')
	const { requireValue } = await import('@orkestrel/test')
	const { createScratch } = await import('@orkestrel/test/server')
	const { createToolRefresh, refreshTools } = await import('./setup.js')
	const { findMissingNamedImports } = await import('./setupServer.js')

	const { MCPFixtureCell } = await import('./setup.js')
	const {
		PACKAGE_NAME,
		GUIDE_SPEC,
		MODULES,
		INTERNAL,
		LEGACY_OWNERS,
		findLegacyOwners,
		STDERR_SENTINEL,
		STDERR_FILE,
		INHERITED,
		readDescriptorIdentity,
		reportThroughTransport,
		readEvidenceThroughTransport,
		readSilentEvidenceThroughTransport,
		reportThroughReplacingSpawn,
		reportThroughInheritingSpawn,
		LEGACY_INITIALIZE,
		driveStdioServer,
		createGuideServer,
		readGuideClientVersion,
		readGuideSubscription,
		readGuideProgressClaim,
		readGuideCapacityRefusal,
		BURST_METHODS,
		readBurstSubscription,
		readGuideBoundCall,
	} = await import('./setupServer.js')
	const { files, report: parity, rows } = context

	const sourceManager = createSourceManager({ files, modules: MODULES })
	const own = requireValue(
		rows.find((row) => row.entry.spec === GUIDE_SPEC),
		`Missing manifest row: ${GUIDE_SPEC}`,
	)

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
		expect(parity.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(own.entry.spec).toBe(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on both sides `findDrift` compares no pair and the case passes on the summaries
	// alone. This pins the population this repository's own guide contributes, so removing
	// every `@example` title reddens the suite instead of quietly retiring half the gate.
	// The failure names both title sets, because a pin reporting only its own emptiness
	// leaves the reader to work out which side dropped the title.
	it('pairs at least one example title across the guide and the source', () => {
		expect(parity.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	// The README's pitch and the guide's tagline are one text, each read as the blockquote
	// under its file's H1. `README.md` is outside the concept index, so the reader is
	// applied to it directly rather than through a manifest row. Each side is guarded
	// against `undefined` first, so a file that lost its blockquote reports that rather
	// than reporting two absences as agreement.
	it('opens the README with the guide tagline', () => {
		const parsed: unknown = JSON.parse(
			requireValue(files['package.json'], 'Missing inventory: package.json'),
		)
		if (!isRecord(parsed)) throw new Error('Invalid package manifest: package.json')
		expect(parsed.name).toBe(PACKAGE_NAME)
		expect(parity.pitch).toEqual([])
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
					"import { createScopeServer } from '@orkestrel/mcp/browser'",
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
			const published = createSource({ files, module: face.module })
				.surface()
				.map((symbol) => symbol.name)
			const neighbours = FACES.filter((other) => other !== face).map((other) =>
				Array.from(
					new Set(
						createSource({ files, module: other.module })
							.surface()
							.map((symbol) => symbol.name),
					),
				).filter((name) => !published.includes(name)),
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
			// reading admits only as whitespace: the whole statement is lost, not the binding alone.
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
				expect(findMissingNamedImports(fence, SOURCES, '@orkestrel/mcp')).toEqual([
					'createMCPRoutes',
				])
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
				"/* import { createScopeServer } from '@orkestrel/mcp' */",
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
				expect(findMissingNamedImports(fence, SOURCES, '@orkestrel/mcp')).toEqual([
					'createMCPRoutes',
				])
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
			expect(findMissingNamedImports(guarded, SOURCES, '@orkestrel/mcp')).toEqual([
				'createMCPRoutes',
			])
			expect(findMissingNamedImports(hazard, SOURCES, '@orkestrel/mcp')).toEqual([])
		})

		it('derives the exact package export keys from the same face map', () => {
			const parsed: unknown = JSON.parse(
				requireValue(files['package.json'], 'Missing inventory: package.json'),
			)
			if (!isRecord(parsed) || !('exports' in parsed) || !isRecord(parsed['exports'])) {
				throw new Error('Package manifest must declare object exports')
			}
			const expected = FACES.map((face) =>
				face.specifier === '@orkestrel/mcp'
					? '.'
					: `.${face.specifier.slice('@orkestrel/mcp'.length)}`,
			)
			expect(Object.keys(parsed['exports']).sort()).toEqual(
				expected.concat('./package.json').sort(),
			)
			expect(parsed['exports']['./package.json']).toBe('./package.json')
		})
	})

	describe('guides/mcp.md tools/list request metadata', () => {
		it('requires modern metadata before the guide request succeeds', async () => {
			const tools = createToolManager()
			tools.add(
				createTool({ name: 'add', execute: (args) => Number(args['x']) + Number(args['y']) }),
			)
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

	// A synthetic negative control: a `server/HTTPClientTransport.ts` no barrel re-exports, so the
	// instrument's scope guard can be proven against a real stranded declaration instead of only
	// the live faces, which never carry one. Reading both faces as one scope would hide the strand.
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
	// complete apart from the explicitly interned declarations, so a widened `module` still
	// passes them unremarked. What binds each live face's scope is that face's
	// own neighbour-refusal row above, not these rows; what these rows catch is a real declaration
	// going stranded or phantom inside one barrel. The population sizes stay asserted because a
	// mistyped module path yields two empty populations, and two empty populations differ by nothing.
	const POPULATIONS = Object.freeze([
		...FACES.map((face) => ({
			name: `${face.specifier} barrel`,
			files,
			module: face.module,
			stranded: requireValue(SOURCES.get(face.specifier), face.specifier)
				.exports()
				.map(computeSymbolKey)
				.filter((key) => INTERNAL.includes(key)),
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

	// Every behavioural interface a face publishes owes a `## Methods` table. The per-interface
	// loop below iterates the tables the GUIDE already carries, so an interface with no table at
	// all receives no method assertion of any kind: its members are documented nowhere and
	// nothing reports the hole. This reads the population from the SOURCE instead, which is the
	// side that can grow, and the membership is asserted non-empty so a mistyped face — two
	// empty populations differ by nothing — cannot pass it vacuously.
	for (const face of FACES) {
		const faceSource = requireValue(
			SOURCES.get(face.specifier),
			`Unmapped specifier: ${face.specifier}`,
		)
		describe(`${face.specifier} behavioural interfaces`, () => {
			it('documents a Methods table for every interface declaring call-signature members', () => {
				const documented = own.guide.methods().map((group) => group.interface)
				const behavioural = faceSource
					.surface()
					.filter((symbol) => symbol.keyword === 'interface')
					.map((symbol) => symbol.name)
					.filter((name) => faceSource.methods(name).length > 0)

				expect(behavioural.length).toBeGreaterThan(0)
				expect(findMissing(behavioural, documented)).toEqual([])
			})
		})
	}

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(parity.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
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
				const members = source.methods(group.interface).map((method) => method.name)
				const documented = group.methods.map((method) => method.name)
				const entity = group.interface.replace(/Interface$/, '')
				describe(`${group.interface}`, () => {
					it('documents at least one method', () => {
						expect(group.methods.length).toBeGreaterThan(0)
					})
					it('documents every interface method', () => {
						expect(findMissing(members, documented)).toEqual([])
					})
					it('documents no phantom method', () => {
						expect(findMissing(documented, members)).toEqual([])
					})
					it(`${entity} exposes no undocumented method`, () => {
						const extra =
							entity === group.interface
								? []
								: findMissing(
										source.methods(entity).map((method) => method.name),
										documented,
									)
						expect(extra).toEqual([])
					})
				})
			}

			// The equality gate: a `Summary` cell against its export's description paragraph, a
			// titled fence against the `@example` of that title. `findDrift` owns the comparison
			// and names both sides; converge the two sides through the native entry, never by
			// weakening this assertion. `findDrift` pairs an example only where a title is
			// present on both sides, so an untitled `@example` block is outside this case. Each
			// collected line is the spec, the key, and each side's text or `absent` — the same
			// worklist `npm run test:guides` prints, so a failure here is read the way that command's
			// output is.
			it('keeps every compared summary and example equal to its source', () => {
				expect(parity.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(parity.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			for (const group of guide.methods()) {
				const entity = group.interface.replace(/Interface$/, '')
				const documented = group.methods.map((method) => method.name)
				const examples =
					entity === group.interface
						? source.examples(group.interface).map((example) => example.name)
						: source
								.examples(group.interface)
								.map((example) => example.name)
								.concat(source.examples(entity).map((example) => example.name))
				describe(`${group.interface} examples`, () => {
					it('documents an example for every method', () => {
						const fences = guide
							.fences()
							.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
							.map((fence) => fence.code)
						expect(findUnexampled(documented, fences, examples)).toEqual([])
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

	describe('guides/mcp.md § stdio transport — what the spawned child actually receives', () => {
		const owned = new MCPFixtureCell<
			{ readonly scratch: ScratchInterface; readonly descriptor: number } | undefined
		>(undefined)

		beforeAll(() => {
			process.env[INHERITED.key] = INHERITED.value
			const scratch = createScratch()
			scratch.write(STDERR_FILE, '')
			owned.value = { scratch, descriptor: openSync(join(scratch.path, STDERR_FILE), 'a') }
		})

		afterAll(() => {
			if (owned.value !== undefined) {
				closeSync(owned.value.descriptor)
				owned.value.scratch.destroy()
			}
			owned.value = undefined
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
			const held = requireValue(owned.value)

			const report = await reportThroughInheritingSpawn(held.descriptor)

			// The grandchild reports the scratch file this test handed the relay, identity and kind.
			expect(report['stderr']).toBe(readDescriptorIdentity(held.descriptor))
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

	describe('guides/mcp.md § Consume a subscription from a client — what the stream delivers', () => {
		it('yields the acknowledgement first, then the stamped frames, and returns the terminal', async () => {
			const reading = await readGuideSubscription()

			expect(reading.opened.done).toBe(false)
			expect(reading.acknowledged).toBe('notifications/subscriptions/acknowledged')
			expect(reading.frames).toEqual([
				'notifications/prompts/list_changed',
				'notifications/prompts/list_changed',
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

	describe('guides/mcp.md § Bind a server or a client to any duplex transport', () => {
		it('resolves the outcome the fence documents over the bound loopback pair', async () => {
			expect(await readGuideBoundCall()).toEqual({ resultType: 'complete', value: 7 })
		})
	})

	describe('guides/mcp.md — Refresh the tools an agent holds', () => {
		it('adds remote tools beside the local tool from an initial snapshot', async () => {
			const fixture = createToolRefresh()
			try {
				await fixture.client.connect()
				const outcome = await refreshTools(fixture.client, fixture.tools, [])
				expect(outcome).toEqual({ installed: ['remote'], collisions: [], failures: [] })
				expect(fixture.tools.tools().map((tool) => tool.name)).toEqual(['local', 'remote'])
				expect(fixture.tools.tool('local')).toBe(fixture.local)
			} finally {
				await fixture.close()
			}
		})

		it('refuses an initial remote name collision while adding noncolliding tools beside the local tool', async () => {
			const fixture = createToolRefresh()
			try {
				fixture.remote.add(createTool({ name: 'local', execute: () => 'remote collision' }))
				await fixture.client.connect()
				const outcome = await refreshTools(fixture.client, fixture.tools, [])
				expect(outcome).toEqual({ installed: ['remote'], collisions: ['local'], failures: [] })
				expect(fixture.tools.tools().map((tool) => tool.name)).toEqual(['local', 'remote'])
				expect(fixture.tools.tool('local')).toBe(fixture.local)
				expect(
					await fixture.tools.execute({ id: 'local', name: 'local', arguments: {} }),
				).toMatchObject({ success: true, value: 'local value' })
			} finally {
				await fixture.close()
			}
		})

		it('refreshes after a server registry add without re-publishing or polling', async () => {
			const fixture = createToolRefresh()
			const subscription = new AbortController()
			try {
				await fixture.client.connect()
				const notifications = fixture.client.listen(
					{ toolsListChanged: true },
					{ signal: subscription.signal },
				)
				await notifications.next()
				const outcome = new MCPFixtureCell(await refreshTools(fixture.client, fixture.tools, []))
				fixture.remote.add(createTool({ name: 'added', execute: () => 'added' }))
				for await (const notification of notifications) {
					if (notification.method === 'notifications/tools/list_changed') {
						outcome.value = await refreshTools(
							fixture.client,
							fixture.tools,
							outcome.value.installed,
						)
						break
					}
				}
				expect(outcome.value).toEqual({
					installed: ['remote', 'added'],
					collisions: [],
					failures: [],
				})
				expect(
					await fixture.tools.execute({ id: 'added', name: 'added', arguments: {} }),
				).toMatchObject({ success: true, value: 'added' })
				expect(fixture.tools.tool('local')).toBe(fixture.local)
			} finally {
				subscription.abort()
				await fixture.close()
			}
		})

		it('refreshes replacements and removals serially through one notification loop', async () => {
			const fixture = createToolRefresh()
			const subscription = new AbortController()
			try {
				await fixture.client.connect()
				const notifications = fixture.client.listen(
					{ toolsListChanged: true },
					{ signal: subscription.signal },
				)
				await notifications.next()
				const outcome = new MCPFixtureCell(await refreshTools(fixture.client, fixture.tools, []))
				const previous = fixture.tools.tool('remote')
				const refreshed: string[] = []
				fixture.remote.add(
					createTool({ name: 'remote', title: 'Replacement', execute: () => 'replacement' }),
				)
				for await (const notification of notifications) {
					if (notification.method !== 'notifications/tools/list_changed') continue
					outcome.value = await refreshTools(fixture.client, fixture.tools, outcome.value.installed)
					if (fixture.remote.tool('remote') === undefined) {
						refreshed.push('removed')
						break
					}
					expect(fixture.tools.tool('remote')).not.toBe(previous)
					expect(fixture.tools.tool('remote')?.title).toBe('Replacement')
					expect(
						await fixture.tools.execute({ id: 'run', name: 'remote', arguments: {} }),
					).toMatchObject({ success: true, value: 'replacement' })
					refreshed.push('replaced')
					fixture.remote.remove('remote')
				}
				expect(refreshed).toEqual(['replaced', 'removed'])
				expect(outcome.value).toEqual({ installed: [], collisions: [], failures: [] })
				expect(fixture.tools.tool('remote')).toBeUndefined()
				expect(fixture.tools.tool('local')).toBe(fixture.local)
			} finally {
				subscription.abort()
				await fixture.close()
			}
		})

		it('records a remote name collision and preserves the local tool', async () => {
			const fixture = createToolRefresh()
			try {
				await fixture.client.connect()
				const outcome = await refreshTools(fixture.client, fixture.tools, [])
				fixture.remote.add(createTool({ name: 'local', execute: () => 'remote collision' }))
				const collision = await refreshTools(fixture.client, fixture.tools, outcome.installed)
				expect(collision).toEqual({ installed: ['remote'], collisions: ['local'], failures: [] })
				expect(fixture.tools.tool('local')).toBe(fixture.local)
				expect(
					await fixture.tools.execute({ id: 'local', name: 'local', arguments: {} }),
				).toMatchObject({ success: true, value: 'local value' })
			} finally {
				await fixture.close()
			}
		})

		it('records a failed tools fetch and keeps the last installed snapshot', async () => {
			const fixture = createToolRefresh()
			try {
				await fixture.client.connect()
				const outcome = await refreshTools(fixture.client, fixture.tools, [])
				const previous = fixture.tools.tool('remote')
				fixture.server.methods.add('tools/list', () => {
					throw new Error('catalog unavailable')
				})
				const failed = await refreshTools(fixture.client, fixture.tools, outcome.installed)
				expect(failed.installed).toBe(outcome.installed)
				expect(failed.collisions).toEqual([])
				expect(failed.failures).toHaveLength(1)
				expect(failed.failures[0]).toMatchObject({ code: -32603, message: 'Server error' })
				expect(fixture.tools.tool('remote')).toBe(previous)
				expect(fixture.tools.tool('local')).toBe(fixture.local)
				expect(
					await fixture.tools.execute({ id: 'retained', name: 'remote', arguments: {} }),
				).toMatchObject({ success: true, value: 'original' })
			} finally {
				await fixture.close()
			}
		})
	})
})
