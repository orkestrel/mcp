// The artifact a consumer installs, measured rather than described. This workspace is packed
// and installed into a throwaway consumer, and the surface drives read every claim off that
// one installed tree: the exports map it publishes, the declarations it ships, and the module
// objects a real runtime hands a consumer. The composition receipts after them install a
// consumer of their own and read what a page built out of it reports — the document's own text,
// a conversation's roles, a JSON-RPC code, an abort reason, and the consumer fixture's own
// accounting.
//
// The surface drives name neither this package nor any of its exports, so each stays true as
// the published surface moves: what they read is whatever the installed exports map names. The
// composition receipts take the opposite rule and name what a composition is of: the packages
// they pin, and the page fixture they copy in, which imports this package by its published
// specifier.
import type { PlaywrightProviderOptions } from '@vitest/browser-playwright'
import type { Browser } from 'playwright'
import type { ProcessInterface } from '@orkestrel/process'
import type { SpawnSyncReturns } from 'node:child_process'
import type { TestContext } from 'vitest'
import { createProcess } from '@orkestrel/process/server'
import { spawnSync } from 'node:child_process'
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'vite'
import { resolveBrowser, resolvePinnedBrowser } from '../configs/browsers.js'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// The compiler this workspace installs, run as a command rather than called in
// process: the command and its plain-text diagnostics are the same across the
// compiler majors this toolchain supports, and its in-process API is not. It is
// resolved from the workspace under proof, so a consumer of the packed artifact is
// checked by the same compiler that workspace's own `check` script runs.
const TSC = createRequire(join(ROOT, 'package.json')).resolve('typescript/bin/tsc')
// Windows needs a shell to launch a `.cmd`: Node refuses one directly since the
// batch-argument hardening, and `spawnSync` returns `EINVAL` with a null status
// rather than an exit code a caller can read. Every following argument is a literal or
// a path this file built, so the shell has nothing to escape.
const SHELL = process.platform === 'win32'
// `prepublishOnly` runs this proof as `npm run test:distribution -- --mode release`.
// Release is the publish gate, so evidence it cannot obtain fails there and skips
// everywhere else: a gate that passes on missing evidence proves nothing.
const RELEASE = import.meta.env.MODE === 'release'
// The built output directory convention a browser face may publish from. Every
// selection reads this prefix off the export target and never off the subpath name. A
// workspace whose only published face is the browser one publishes that face at the
// root subpath, so a rule keyed on the subpath name drives a browser bundle through
// Node and the miss is silent.
const BROWSER_OUTPUT = './dist/src/browser/'
const ABSENT_SUBPATH = '/no-subpath-is-published-under-this-name'
// A compiler diagnostic that says where it is: the path relative to the directory
// the compiler ran in, the 1-based line and column, the code, and the message. The
// diagnostics are the verdict rather than the exit code, which differs between the
// compiler majors this toolchain supports, so a reported line matching nothing here
// came from something other than a check of a consumer module.
const DIAGNOSTIC_PATTERN = /^(.+?)\(\d+,\d+\): error TS\d+: /u
const PING = ['ping', '--fetch-retries=0', '--fetch-timeout=5000', '--loglevel=silent']
const ESM_DRIVER = 'drive.mjs'
const CJS_DRIVER = 'drive.cjs'
const CONSUMER_MANIFEST = `{ "name": "distribution-consumer", "private": true, "type": "module" }\n`
const ESM_DRIVER_SOURCE = `const entry = await import(process.argv[2])
process.stdout.write(JSON.stringify(Object.keys(entry).sort()))
`
const CJS_DRIVER_SOURCE = `const entry = require(process.argv[2])
process.stdout.write(JSON.stringify(Object.keys(entry).sort()))
`
// The artifacts the composition receipts compose this packed workspace with, in the consumer
// they build for it, written as the ranges an application writes down. Each is pinned rather
// than floating: a receipt read against whatever the registry served that morning reports on a
// composition nobody chose.
const COMPOSITION: readonly string[] = [
	'@orkestrel/agent@^0.0.23',
	'@orkestrel/tool@^0.0.15',
	'@orkestrel/ndjson@^0.0.10',
]
// The installed package whose own module names the root entries the page evaluates.
const COMPOSED = '@orkestrel/agent'
// A top-level import or re-export specifier. The emitted entry writes each statement at column
// zero and indents every doc-comment line under its block, so the line anchor is what separates
// the module graph from the prose describing it.
const SPECIFIER_PATTERN = /^(?:import|export)\s[^\n]*?from\s*['"]([^'"]+)['"]/gmu
const CLOSURE_SCOPE = '@orkestrel/'
// The line the consumer's own fixture writes after its listener is bound.
const READY_PATTERN = /^ready (\d+)$/u
// The fictional credential the page presents to the relay route, and the paths the consumer's
// fixture answers on beside the page directory it serves.
const CREDENTIAL = 'Bearer distribution-8f21-token'
// A credential the consumer's fixture does not hold, so the relay's own `authorize` callback is
// the only thing between it and an answered turn.
const REFUSED = 'Bearer distribution-0000-refused'
const RELAY_PATH = '/relay'
const CONTROL_PATH = '/control'
const RECEIPTS_PATH = '/receipts'
// The route the consumer's fixture answers from its own `node_modules`, and the prefix every
// import-map target carries. A page module resolves a bare specifier to a URL under it, and a
// relative specifier resolves against the URL of the module that named it, so the served tree
// mirrors the installed one.
const MODULE_PATH = '/modules/'
// The names the copied fixtures take inside the consumer, and the page module the test writes
// beside them. Each copy keeps the `.mjs` extension it is authored under, so one specifier
// names the shared script on the page side and the Node side alike.
const FIXTURE = 'fixture.mjs'
const PAGE_MODULE = 'receipts.mjs'
const SCRIPT_MODULE = 'script.mjs'
const ENTRY_MODULE = 'main.mjs'
// The authored fixtures those copies are taken from. The scripted provider is copied beside the
// page fixture and beside the Node fixture, so one authored file is what each side runs.
const PAGE_FIXTURE = join(ROOT, 'tests', 'fixtures', 'distributionPage.mjs')
const SERVER_FIXTURE = join(ROOT, 'tests', 'fixtures', 'distributionServer.mjs')
const SCRIPT_FIXTURE = join(ROOT, 'tests', 'fixtures', 'distributionScript.mjs')

// The extensions a JavaScript handler loads as modules. Node loads a native addon
// through its addon handler instead, so that extension is named separately.
const MODULE_EXTENSIONS = ['.js', '.mjs', '.cjs']
const ADDON_EXTENSION = '.node'
// The extensions a declaration file carries. A `require` condition declares
// `.d.cts` and an ESM-only one `.d.mts`, so the `.d.ts` spelling alone does not
// name them.
const DECLARATION_EXTENSIONS = ['.d.ts', '.d.cts', '.d.mts']
type Format = 'module' | 'commonjs'

// The Node import target is resolved with the conditions that driver supplies. The
// CommonJS compile probe is selected from its declaration's format, and its runtime
// drive loads the same subpath through Node's require resolver. Vite's production
// client build enables its module and browser conditions.
const RUNTIME_CONDITIONS = Object.freeze({
	module: Object.freeze(['node-addons', 'node', 'import', 'module-sync']),
	commonjs: Object.freeze(['node-addons', 'node', 'require', 'module-sync']),
	browser: Object.freeze(['module', 'browser', 'production', 'import']),
})
// TypeScript's Node resolutions add `node` to the format condition. Its bundler
// resolution does not, so a browser drive compares against the declaration a bundler
// consumer reads rather than borrowing the Node declaration.
const BUNDLER_CONDITIONS = Object.freeze({
	module: ['types', 'import'],
	commonjs: ['types', 'require'],
})
const DECLARATION_CONDITIONS = Object.freeze({
	module: ['types', 'node', 'import'],
	commonjs: ['types', 'node', 'require'],
	browser: BUNDLER_CONDITIONS.module,
})

interface Resolution {
	readonly label: string
	readonly resolution: string
	readonly module: string
	readonly conditions: Readonly<Record<Format, readonly string[]>>
}

interface TargetResolution {
	readonly target: string
}

// Each compile driver carries the compiler options its scratch project sets and
// the conditions TypeScript applies for that resolution and importing format. A
// `require`-only subpath therefore stays in each CommonJS probe that can resolve it.
// The option values are the spellings the project file takes, so nothing here needs
// the compiler's own API to name them.
const RESOLUTIONS: readonly Resolution[] = [
	{
		label: 'node16',
		resolution: 'node16',
		module: 'node16',
		conditions: DECLARATION_CONDITIONS,
	},
	{
		label: 'nodenext',
		resolution: 'nodenext',
		module: 'nodenext',
		conditions: DECLARATION_CONDITIONS,
	},
	{
		label: 'bundler',
		resolution: 'bundler',
		module: 'esnext',
		conditions: BUNDLER_CONDITIONS,
	},
]

// The driver a bundled consumer reads declarations under. A browser application
// compiles through a bundler, so the browser drive answers under this one alone,
// and naming it here is what keeps that selection tied to the driver it selects.
const BROWSER_DRIVER = RESOLUTIONS.find((candidate) => candidate.label === 'bundler')
if (BROWSER_DRIVER === undefined) throw new Error("RESOLUTIONS carries no 'bundler' row")

const FORMATS: ReadonlyArray<readonly [extension: string, format: Format]> = [
	['ts', 'module'],
	['cts', 'commonjs'],
]

// One published subpath, resolved to what this proof can drive: the specifier a
// consumer writes, whether the declarations its consumer formats resolve at all,
// whether its target is a browser bundle, and whether it answers `import` and
// `require` at all.
interface Entry {
	readonly subpath: string
	readonly specifier: string
	readonly mapping: unknown
	readonly declaration: {
		readonly module: boolean
		readonly commonjs: boolean
		readonly browser: boolean
	}
	readonly browser: boolean
	readonly module: boolean
	readonly commonjs: boolean
	readonly required: boolean
}

// The installed tree every claim is read from. Every subpath the exports map names
// lands in exactly one of `entries`, `undeclared`, and `excluded`, so a subpath this
// proof cannot drive is reported rather than dropped.
interface Stage {
	readonly consumer: string
	readonly installed: string
	readonly packed: string
	readonly archives: readonly string[]
	readonly entries: readonly Entry[]
	readonly subpaths: readonly string[]
	readonly undeclared: readonly string[]
	readonly excluded: readonly string[]
	readonly targets: readonly string[]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNames(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((name) => typeof name === 'string')
}

// A fallback list, which is what Node reads an array in an exports entry as. The
// narrowing is what the following walkers need: `Array.isArray` widens an `unknown`
// member to `any`, and an entry read that way is not read at all.
function isList(value: unknown): value is readonly unknown[] {
	return Array.isArray(value)
}

// Whether a string is a valid package target. Node rejects a target outside the
// package and a target containing a dot, parent, or node_modules segment during
// package-target resolution. A later module-resolution failure is not the same
// thing: an array falls through the former and keeps the latter.
function isPackageTarget(target: string): boolean {
	if (!target.startsWith('./')) return false
	for (const segment of target.slice(2).split(/[\\/]/u)) {
		let decoded = segment
		try {
			decoded = decodeURIComponent(segment)
		} catch {}
		const normalized = decoded.toLowerCase()
		if (normalized === '.' || normalized === '..' || normalized === 'node_modules') return false
	}
	return true
}

function readJson(path: string): unknown {
	const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
	return parsed
}

function readManifestName(path: string): string {
	const manifest = readJson(path)
	if (!isRecord(manifest) || typeof manifest.name !== 'string') {
		throw new Error(`The manifest at ${path} declares no package name`)
	}
	return manifest.name
}

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content)
}

function readOutput(result: SpawnSyncReturns<string>): string {
	return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

function runNpm(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
	return spawnSync(NPM, [...args], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, npm_config_cache: CACHE },
		shell: SHELL,
		windowsHide: true,
	})
}

function runNode(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [...args], { cwd, encoding: 'utf8', windowsHide: true })
}

// Node's own condition matching, read in declaration order.
function resolvePackageTarget(
	entry: unknown,
	conditions: readonly string[],
): TargetResolution | undefined {
	if (typeof entry === 'string') return { target: entry }
	if (isList(entry)) {
		for (const member of entry) {
			const resolved = resolvePackageTarget(member, conditions)
			if (resolved !== undefined && isPackageTarget(resolved.target)) return resolved
		}
		return undefined
	}
	if (!isRecord(entry)) return undefined
	for (const [condition, nested] of Object.entries(entry)) {
		if (condition !== 'default' && !conditions.includes(condition)) continue
		const resolved = resolvePackageTarget(nested, conditions)
		if (resolved !== undefined) return resolved
	}
	return undefined
}

// A flat entry, a condition-nested entry, and a fallback list all resolve through
// one walker. An entry may declare `types` beside `default` at its top level
// rather than inside `import`, so a fixed `entry.import.types` lookup is not
// equivalent to condition resolution.
function resolveTarget(entry: unknown, conditions: readonly string[]): string | undefined {
	return resolvePackageTarget(entry, conditions)?.target
}

// Whether a path is a physical file. TypeScript's file-existence check refuses a
// directory at the same spelling and continues to the outer package scope.
function matchesFile(path: string): boolean {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}

// TypeScript resolves a declaration target by accepting an existing declaration
// directly or by substituting beside a JavaScript target. A missing target leaves
// the containing condition or fallback list unresolved, so the walk continues.
function targetToDeclaration(target: string, installed: string): string | undefined {
	if (!isPackageTarget(target)) return undefined
	let declaration = target
	if (target.endsWith('.cjs')) declaration = `${target.slice(0, -4)}.d.cts`
	else if (target.endsWith('.mjs')) declaration = `${target.slice(0, -4)}.d.mts`
	else if (target.endsWith('.js')) declaration = `${target.slice(0, -3)}.d.ts`
	else if (!isDeclaration(target)) return undefined
	return matchesFile(join(installed, declaration)) ? declaration : undefined
}

// The declaration TypeScript resolves through one importing format's conditions.
// Condition objects keep manifest order, and arrays keep fallback order.
function resolveDeclaration(
	entry: unknown,
	conditions: readonly string[],
	installed: string,
): string | undefined {
	if (typeof entry === 'string') return targetToDeclaration(entry, installed)
	if (isList(entry)) {
		for (const member of entry) {
			const resolved = resolveDeclaration(member, conditions, installed)
			if (resolved !== undefined) return resolved
		}
		return undefined
	}
	if (!isRecord(entry)) return undefined
	for (const [condition, nested] of Object.entries(entry)) {
		if (condition !== 'default' && !conditions.includes(condition)) continue
		const resolved = resolveDeclaration(nested, conditions, installed)
		if (resolved !== undefined) return resolved
	}
	return undefined
}

// The nearest package scope that decides a `.d.ts` declaration's module format. A
// physical nested manifest starts a scope even when it omits `type` or cannot be
// parsed. A directory at that spelling is not a manifest, so the walk continues.
function readPackageType(installed: string, target: string): unknown {
	let directory = dirname(join(installed, target))
	while (true) {
		const path = join(directory, 'package.json')
		if (matchesFile(path)) {
			try {
				const manifest = readJson(path)
				return isRecord(manifest) ? manifest.type : undefined
			} catch {
				return undefined
			}
		}
		if (directory === installed) return undefined
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

function resolvesBrowser(entry: unknown): boolean {
	const module = resolveTarget(entry, RUNTIME_CONDITIONS.browser)
	if (module !== undefined && module.startsWith(BROWSER_OUTPUT)) return true
	if (module === undefined) return false
	const imported = resolveTarget(entry, RUNTIME_CONDITIONS.module)
	const required = resolveTarget(entry, RUNTIME_CONDITIONS.commonjs)
	return module !== imported && module !== required
}

// Whether the target selected by Node's CommonJS conditions is a module require can
// load. A JavaScript target takes its own nearest package scope. Native addons and
// extensionless targets have their own CommonJS handlers.
function resolvesCommonJS(entry: unknown, installed: string): boolean {
	const target = resolveTarget(entry, RUNTIME_CONDITIONS.commonjs)
	if (target === undefined) return false
	const name = target.slice(target.lastIndexOf('/') + 1)
	if (name.endsWith('.cjs')) return true
	if (name.endsWith('.mjs')) return false
	if (name.endsWith('.node')) return true
	if (!name.includes('.')) return true
	return name.endsWith('.js') && readPackageType(installed, target) !== 'module'
}

// Whether the declaration selected by a typed CommonJS consumer admits that entry.
// A `.d.cts` declaration admits and a `.d.mts` declaration refuses. A `.d.ts`
// declaration takes its own nearest package scope.
function declaresCommonJS(entry: unknown, installed: string): boolean {
	const declaration = resolveDeclaration(entry, DECLARATION_CONDITIONS.commonjs, installed)
	if (declaration === undefined) return false
	if (declaration.endsWith('.d.cts')) return true
	if (declaration.endsWith('.d.mts')) return false
	return declaration.endsWith('.d.ts') && readPackageType(installed, declaration) !== 'module'
}

// Every target an entry names under any condition. A fallback list omits members
// Node rejects during package-target validation, because no reader can take them.
function collectTargets(entry: unknown): readonly string[] {
	if (typeof entry === 'string') return [entry]
	if (isList(entry)) return entry.flatMap(collectTargets).filter(isPackageTarget)
	if (!isRecord(entry)) return []
	return Object.values(entry).flatMap((nested) => collectTargets(nested))
}

// Whether a target is a file a runtime loads for its names, which is what a
// declaration is owed for. The extension on the target's own file name decides it,
// and a name carrying no extension is code: `require` reads such a file through its
// JavaScript handler, so an extensionless target loads and publishes names. Node
// loads `.node` through its native-addon handler. Every other extension is an asset
// a consumer reads rather than imports — a stylesheet, a WebAssembly binary, the
// `"./package.json"` manifest pointer, and a declaration alike.
// The cost is an extensionless file published for a reader, such as a `LICENSE`:
// that target reports undeclared until it is given an extension or a declaration.
function isModule(target: string): boolean {
	const name = target.slice(target.lastIndexOf('/') + 1)
	const dot = name.lastIndexOf('.')
	if (name.endsWith(ADDON_EXTENSION)) return true
	return dot === -1 || MODULE_EXTENSIONS.includes(name.slice(dot))
}

// Whether a resolved target is a declaration rather than the JavaScript a
// `default` branch answers with when the entry declares no `types` condition.
function isDeclaration(target: string): boolean {
	return DECLARATION_EXTENSIONS.some((extension) => target.endsWith(extension))
}

// The declarations the Node module, Node CommonJS, and browser drives compare
// against. Each field uses the conditions of the TypeScript consumer paired with
// that runtime. A JavaScript target resolves through TypeScript's adjacent
// declaration substitution rather than standing in for the declaration itself.
function readDeclaration(
	entry: unknown,
	installed: string,
): {
	readonly module: string | undefined
	readonly commonjs: string | undefined
	readonly browser: string | undefined
} {
	return {
		module: resolveDeclaration(entry, DECLARATION_CONDITIONS.module, installed),
		commonjs: resolveDeclaration(entry, DECLARATION_CONDITIONS.commonjs, installed),
		browser: resolveDeclaration(entry, DECLARATION_CONDITIONS.browser, installed),
	}
}

// The entries one compile driver can resolve under its own conditions.
function selectEntries(entries: readonly Entry[], conditions: readonly string[]): readonly Entry[] {
	return entries.filter(
		(entry) =>
			resolveTarget(entry.mapping, conditions) !== undefined &&
			(!conditions.includes('require') || entry.commonjs),
	)
}

// The compile drivers whose conditions reach one entry under one importing format.
// A driver that resolves no target for that entry compiles nothing, so a consumer
// written under it would report a resolution failure this package never made.
function selectDrivers(entry: Entry, format: Format): readonly Resolution[] {
	return RESOLUTIONS.filter(
		(driver) => selectEntries([entry], driver.conditions[format]).length > 0,
	)
}

// Require-loadable entries that declare CommonJS support but a typed CommonJS
// consumer cannot compile against. A default branch resolving under the require
// condition set makes no CommonJS claim.
function selectUntypable(entries: readonly Entry[], installed: string): readonly Entry[] {
	return entries.filter(
		(entry) =>
			entry.required &&
			isRecord(entry.mapping) &&
			Object.hasOwn(entry.mapping, 'require') &&
			!declaresCommonJS(entry.mapping, installed),
	)
}

// One surface comparison, written as the consumer module that proves it: the
// installed entry that consumer imports, the file extension fixing its importing
// format, the names a real runtime published off it, and the driver whose scratch
// project compiles it.
interface Surface {
	readonly entry: Entry
	readonly extension: string
	readonly published: readonly string[]
	readonly driver: Resolution
}

// A scratch project over named consumer modules, written beside them so their own
// resolution reaches the installed package. Nothing is emitted and no ambient types
// are pulled in, so what the check reads is the installed declarations alone.
function writeProject(
	stage: Stage,
	name: string,
	driver: Resolution,
	files: readonly string[],
): string {
	const path = join(stage.consumer, `tsconfig.${name}.json`)
	const project = {
		compilerOptions: {
			module: driver.module,
			moduleResolution: driver.resolution,
			noEmit: true,
			skipLibCheck: true,
			strict: true,
			target: 'esnext',
			types: [],
		},
		files: [...files],
	}
	writeFile(path, `${JSON.stringify(project, undefined, '\t')}\n`)
	return path
}

// The diagnostics the compiler this workspace installs reports for one scratch
// project. The compiler runs as a command, so nothing here reaches an API that
// moves between its majors, and the located lines it prints are the verdict rather
// than the exit code, which moves between them. A line carrying no location, a line
// naming the scratch project rather than a consumer module, and anything at all on
// the error stream are faults of this proof rather than of the package under proof,
// so each is raised where it happens instead of counted against the package.
function checkProject(stage: Stage, project: string): readonly string[] {
	const result = runNode([TSC, '--noEmit', '--pretty', 'false', '-p', project], stage.consumer)
	const refused = `${result.stderr ?? ''}`.trim()
	if (refused.length > 0) {
		throw new Error(`The consumer compiler wrote ${refused} to its error stream`)
	}
	const reported: string[] = []
	for (const line of `${result.stdout ?? ''}`.split(/\r\n|\n/u)) {
		if (line.trim().length === 0) continue
		const last = reported.at(-1)
		// An elaborated diagnostic prints its detail on indented lines under its own
		// first line, so each of those joins the diagnostic it elaborates.
		if (/^\s/u.test(line) && last !== undefined) {
			reported[reported.length - 1] = `${last} ${line.trim()}`
			continue
		}
		const located = DIAGNOSTIC_PATTERN.exec(line)?.[1]
		if (located === undefined) {
			throw new Error(`The consumer compiler reported ${line}, which names no location`)
		}
		if (resolve(stage.consumer, located) === project) {
			throw new Error(`The scratch project is itself at fault: ${line}`)
		}
		reported.push(line)
	}
	if (reported.length === 0 && result.status !== 0) {
		throw new Error(`The consumer compiler refused the project: ${readOutput(result)}`)
	}
	return reported
}

// One installed entry's published names checked against its own declarations by
// the compiler this workspace installs, in the direction each divergence surfaces
// under. The runtime's key list is written into the consumer as a literal, so the
// published side comes from a real process and the declared side from the
// declarations that process's package ships, and the two can disagree. A name the
// declarations carry and the runtime does not lands on `declared`. A name the
// runtime carries and the declarations do not, and a name the declarations publish
// as a type alone, land on `surfaced`: a variable widens into the type
// `declared` annotates, and only `surfaced` reads the literal's own keys back.
// Each names the member it is about, so the failure says which export moved.
function checkSurface(stage: Stage, surface: Surface): readonly string[] {
	const slug = surface.entry.subpath.replaceAll(/[^\w]+/gu, '-')
	const name = `surface.${surface.driver.label}${slug}.${surface.extension}`
	const module = `${name}`
	const keys = surface.published.map((key) => `${JSON.stringify(key)}: true`).join(', ')
	writeFile(
		join(stage.consumer, module),
		`import * as entry from ${JSON.stringify(surface.entry.specifier)}
const published = {${keys.length === 0 ? '' : ` ${keys} `}} as const
const declared: Record<keyof typeof entry, true> = published
const surfaced: Record<keyof typeof published, true> = declared
`,
	)
	const project = writeProject(stage, name, surface.driver, [`./${module}`])
	return checkProject(stage, project).map((line) => `${surface.driver.label}: ${line}`)
}

// One consumer module importing every installed entry, written where its own
// resolution finds the installed package.
function writeConsumerProbe(stage: Stage, path: string, specifiers: readonly string[]): void {
	const names: string[] = []
	const bindings: string[] = []
	for (const [index, specifier] of specifiers.entries()) {
		const binding = `entry${String(index)}`
		names.push(binding)
		bindings.push(`import * as ${binding} from ${JSON.stringify(specifier)}`)
	}
	const source = `${bindings.join('\n')}\nexport const surface = [${names.join(', ')}]\n`
	writeFile(join(stage.consumer, path), source)
}

// The runtime key set a real process reads off one installed entry under one
// condition. The driver is a file rather than an `--eval` string, so the specifier
// travels as an argument and nothing needs escaping.
function driveRuntime(stage: Stage, specifier: string, driver: string): readonly string[] {
	const result = runNode([join(stage.consumer, driver), specifier], stage.consumer)
	if (result.status !== 0) {
		throw new Error(`Loading ${specifier} from the consumer failed: ${readOutput(result)}`)
	}
	const published: unknown = JSON.parse(result.stdout)
	if (!isNames(published)) throw new Error(`The driver printed no name list for ${specifier}`)
	return published
}

const BROWSER_PAGE = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<title>Distribution</title>
	</head>
	<body>
		<script type="module" src="./main.js"></script>
	</body>
</html>
`

function readContentType(path: string): string {
	if (path.endsWith('.html')) return 'text/html'
	if (path.endsWith('.js')) return 'text/javascript'
	if (path.endsWith('.css')) return 'text/css'
	if (path.endsWith('.json') || path.endsWith('.map')) return 'application/json'
	return 'application/octet-stream'
}

// `resolveBrowser` answers with provider options and never reports absence: its
// last resort is a channel nothing verified. So the launch is attempted and its
// rejection classified, rather than probed for and ruled on.
function describeBrowser(options: PlaywrightProviderOptions): string {
	const endpoint = options.connectOptions?.wsEndpoint
	if (endpoint !== undefined) return `the browser server at ${endpoint}`
	const executable = options.launchOptions?.executablePath
	if (executable !== undefined) return `the executable at ${executable}`
	const channel = options.launchOptions?.channel
	if (channel !== undefined) return `the ${channel} channel`
	return 'the Chromium Playwright installed for itself'
}

async function launchBrowser(options: PlaywrightProviderOptions): Promise<Browser> {
	const endpoint = options.connectOptions?.wsEndpoint
	if (endpoint !== undefined) return chromium.connect(endpoint)
	return chromium.launch({ ...options.launchOptions, headless: true })
}

// A consumer of one installed browser entry, bundled by the Vite toolchain this
// workspace already declares. Nothing is stubbed: the bundle resolves the installed
// package and its whole transitive graph as an application consuming it would.
async function bundleEntry(stage: Stage, entry: Entry): Promise<string> {
	const page = join(stage.consumer, 'pages', entry.subpath.replaceAll(/[^\w]+/gu, '-'))
	const specifier = JSON.stringify(entry.specifier)
	writeFile(join(page, 'index.html'), BROWSER_PAGE)
	writeFile(
		join(page, 'main.js'),
		`import * as entry from ${specifier}\nglobalThis.subject = Object.keys(entry).sort()\n`,
	)
	await build({
		base: './',
		build: { emptyOutDir: true, outDir: 'bundle' },
		configFile: false,
		logLevel: 'error',
		root: page,
	})
	return join(page, 'bundle')
}

// The key set the bundled module publishes in a real browser, read off the page
// once it has loaded over a loopback server. A module that never evaluated
// publishes nothing, and a page error is raised rather than compared away.
async function readBrowserExports(browser: Browser, bundle: string): Promise<readonly string[]> {
	const server = createServer((request, response) => {
		const asked = request.url === undefined || request.url === '/' ? '/index.html' : request.url
		const path = join(bundle, decodeURIComponent(asked))
		if (!path.startsWith(bundle) || !existsSync(path)) {
			response.writeHead(404)
			response.end()
			return
		}
		response.writeHead(200, { 'content-type': readContentType(path) })
		response.end(readFileSync(path))
	})
	try {
		await new Promise<void>((settle) => {
			server.listen(0, '127.0.0.1', settle)
		})
		const address = server.address()
		if (address === null || typeof address === 'string') {
			throw new Error('The bundle server bound no port')
		}
		const page = await browser.newPage()
		const failures: string[] = []
		page.on('pageerror', (error) => failures.push(String(error)))
		await page.goto(`http://127.0.0.1:${String(address.port)}/`, { waitUntil: 'load' })
		const published: unknown = await page.evaluate('globalThis.subject')
		if (failures.length > 0) throw new Error(`The bundle raised ${failures.join(' | ')}`)
		if (!isNames(published)) throw new Error('The bundled module published no name list')
		return published
	} finally {
		server.close()
	}
}

// Pack this workspace, install the archive into an isolated consumer, and read the
// published surface back off the installed tree. Every later claim reads this
// result, so a failure here is raised where it happens rather than once per entry.
function buildStage(): Stage {
	const packed = join(SCRATCH, 'packed')
	const consumer = join(SCRATCH, 'consumer')
	mkdirSync(packed, { recursive: true })
	const pack = runNpm(['pack', '--ignore-scripts', '--pack-destination', packed], ROOT)
	if (pack.status !== 0) throw new Error(`npm pack refused this workspace: ${readOutput(pack)}`)
	const archives = readdirSync(packed).filter((name) => name.endsWith('.tgz'))
	const archive = archives[0]
	if (archives.length !== 1 || archive === undefined) {
		throw new Error(`npm pack wrote no single archive: ${archives.join(', ')}`)
	}
	writeFile(join(consumer, 'package.json'), CONSUMER_MANIFEST)
	writeFile(join(consumer, ESM_DRIVER), ESM_DRIVER_SOURCE)
	writeFile(join(consumer, CJS_DRIVER), CJS_DRIVER_SOURCE)
	const install = runNpm(
		['install', '--ignore-scripts', '--no-audit', '--no-fund', join(packed, archive)],
		consumer,
	)
	if (install.status !== 0) {
		throw new Error(`Installing the packed archive failed: ${readOutput(install)}`)
	}
	const name = readManifestName(join(ROOT, 'package.json'))
	const installed = join(consumer, 'node_modules', ...name.split('/'))
	const manifest = readJson(join(installed, 'package.json'))
	if (!isRecord(manifest) || !isRecord(manifest.exports)) {
		throw new Error('The installed manifest publishes no exports map')
	}
	const entries: Entry[] = []
	const targets: string[] = []
	const subpaths: string[] = []
	const undeclared: string[] = []
	const excluded: string[] = []
	for (const [subpath, entry] of Object.entries(manifest.exports)) {
		const files = collectTargets(entry)
		targets.push(...files)
		subpaths.push(subpath)
		const declaration = readDeclaration(entry, installed)
		// A subpath resolving no declaration is partitioned rather than dropped. It is a
		// defect when a runtime loads one of its targets for names, because a consumer
		// importing it compiles against nothing under `node16`. It is an excluded
		// publication otherwise: the `"./package.json"` manifest pointer and a stylesheet
		// are published for a reader rather than an importer.
		if (
			declaration.module === undefined &&
			declaration.commonjs === undefined &&
			declaration.browser === undefined
		) {
			if (files.some(isModule)) undeclared.push(subpath)
			else excluded.push(subpath)
			continue
		}
		const imported = resolveTarget(entry, RUNTIME_CONDITIONS.module)
		const requiredTarget = resolveTarget(entry, RUNTIME_CONDITIONS.commonjs)
		const browserTarget = resolveTarget(entry, RUNTIME_CONDITIONS.browser)
		const browser = resolvesBrowser(entry)
		const required = requiredTarget !== undefined && !(browser && requiredTarget === browserTarget)
		const commonjs = required && resolvesCommonJS(entry, installed)
		entries.push({
			subpath,
			specifier: subpath === '.' ? name : `${name}${subpath.slice(1)}`,
			mapping: entry,
			declaration: {
				module: declaration.module !== undefined,
				commonjs: declaration.commonjs !== undefined,
				browser: declaration.browser !== undefined,
			},
			browser,
			module: imported !== undefined && !(browser && imported === browserTarget),
			commonjs,
			required,
		})
	}
	return {
		consumer,
		installed,
		packed,
		archives,
		entries,
		subpaths,
		undeclared,
		excluded,
		targets,
	}
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'distribution-'))
const CACHE = join(SCRATCH, 'cache')
mkdirSync(CACHE, { recursive: true })
// The scratch tree holds the npm cache, the packed archive, and the installed
// consumer, so its removal is registered before the first thing that can throw.
//
// The composition stage runs out of that same tree, so this one hook closes the stage first and
// removes the tree after. The order is what the close buys: the child and the browser are gone
// before the tree they hold files under is removed. The `finally` is what the removal buys: the
// browser is launched before the guard that can throw, and the child exists before the origin
// read, so a stage that rejected on its way up already opened both, and the `catch` around the
// stage is what closes them. The tree's removal runs whether the stage resolved, rejected, or
// was torn down by that `catch`.
afterAll(async () => {
	try {
		await closeReceipts()
	} finally {
		rmSync(SCRATCH, { force: true, recursive: true })
	}
})

// Installing the packed archive resolves its own runtime dependencies, so an
// unreachable registry leaves nothing to measure. Under release that is the gate
// failing; anywhere else the suite skips and names the mechanism it wanted.
//
// A module that throws while loading never reaches the `afterAll` it registered,
// so every throw here removes the scratch tree on its way out.
function openStage(): Stage | undefined {
	try {
		if (runNpm(PING, ROOT).status !== 0) {
			if (!RELEASE) return undefined
			throw new Error(
				'The release gate requires a reachable npm registry, and npm ping did not answer',
			)
		}
		return buildStage()
	} catch (error) {
		rmSync(SCRATCH, { force: true, recursive: true })
		throw error
	}
}

const STAGE = openStage()
const STAGED = STAGE !== undefined

describe('distribution classifiers', () => {
	it('classifies synthetic export mappings without a registry stage', () => {
		const root = join(SCRATCH, 'classifiers')
		writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				type: 'commonjs',
				exports: {
					condition: { browser: './b.js', default: './n.js' },
					convention: { default: './dist/src/browser/index.js' },
					universal: { default: './shared.js' },
					'import-shared': {
						browser: './shared.mjs',
						import: './shared.mjs',
						default: './node.js',
					},
					'require-shared': {
						browser: './shared.cjs',
						require: './shared.cjs',
						default: './node.js',
					},
					node: { node: './node.js', default: './node.js' },
					silent: { 'module-sync': './x.cjs', import: './x.mjs' },
					module: { require: './x.mjs' },
					'nested-module': { require: './module/x.js' },
					'nested-commonjs': { require: './commonjs/x.js' },
					esm: { import: './x.mjs' },
				},
			}),
		)
		writeFile(join(root, 'module/package.json'), '{ "type": "module" }\n')
		writeFile(join(root, 'commonjs/package.json'), '{ "type": "commonjs" }\n')
		const manifest = readJson(join(root, 'package.json'))
		if (!isRecord(manifest) || !isRecord(manifest.exports)) {
			throw new Error('The classifier fixture declares no exports map')
		}
		const mappings = manifest.exports
		expect({
			condition: resolvesBrowser(mappings.condition),
			convention: resolvesBrowser(mappings.convention),
			universal: resolvesBrowser(mappings.universal),
			import: resolvesBrowser(mappings['import-shared']),
			require: resolvesBrowser(mappings['require-shared']),
			node: resolvesBrowser(mappings.node),
		}).toStrictEqual({
			condition: true,
			convention: true,
			universal: false,
			import: false,
			require: false,
			node: false,
		})
		expect({
			silent: resolvesCommonJS(mappings.silent, root),
			module: resolvesCommonJS(mappings.module, root),
			nestedModule: resolvesCommonJS(mappings['nested-module'], root),
			nestedCommonJS: resolvesCommonJS(mappings['nested-commonjs'], root),
			esm: resolvesCommonJS(mappings.esm, root),
		}).toStrictEqual({
			silent: true,
			module: false,
			nestedModule: false,
			nestedCommonJS: true,
			esm: false,
		})
	})
})

// The staged consumer, or a skip naming what the run could not reach. `it.skipIf`
// carries no reason, so the gate sits here where the test context can state one.
function requireStage(context: TestContext): Stage {
	if (!STAGED) {
		return context.skip('`npm ping` did not answer, so nothing was packed or installed')
	}
	return STAGE
}

describe('installed package consumer', () => {
	it('packs one archive and installs it in isolation [requires the registry]', (context) => {
		const stage = requireStage(context)
		expect(stage.archives).toHaveLength(1)
		expect(existsSync(join(stage.installed, 'package.json'))).toBe(true)
		expect(stage.entries.length).toBeGreaterThan(0)
	})

	it('ships every relative target its exports map names [requires the registry]', (context) => {
		const stage = requireStage(context)
		const relative = stage.targets.filter((target) => target.startsWith('./'))
		expect(relative).not.toStrictEqual([])
		expect(relative.filter((target) => !existsSync(join(stage.installed, target)))).toStrictEqual(
			[],
		)
	})

	// Every published subpath is driven, excluded by name, or reported here. A dropped
	// one leaves no trace: no runtime test, no declaration comparison, and no place in
	// the resolution compile, so the run reports success for a subpath it never
	// measured.
	it('declares types for every module it publishes [requires the registry]', (context) => {
		const stage = requireStage(context)
		const partitioned = [
			...stage.entries.map((entry) => entry.subpath),
			...stage.undeclared,
			...stage.excluded,
		]
		expect(stage.undeclared).toStrictEqual([])
		expect(partitioned.sort()).toStrictEqual([...stage.subpaths].sort())
		// A driven subpath answers a runtime condition. One resolving a declaration and
		// no Node or browser target compiles for a consumer and throws when that consumer
		// loads it. Each later drive retires itself for that entry, so this assertion names
		// the subpath rather than counting it as driven.
		const unreachable = stage.entries.filter(
			(entry) => !entry.module && !entry.required && !entry.browser,
		)
		expect(unreachable.map((entry) => entry.subpath)).toStrictEqual([])
		const untypable = selectUntypable(stage.entries, stage.installed)
		expect(untypable.map((entry) => entry.subpath)).toStrictEqual([])
	})

	it('refuses a subpath its exports map does not name [requires the registry]', (context) => {
		const stage = requireStage(context)
		const name = readManifestName(join(stage.installed, 'package.json'))
		const driver = join(stage.consumer, ESM_DRIVER)
		const result = runNode([driver, `${name}${ABSENT_SUBPATH}`], stage.consumer)
		expect(result.status).not.toBe(0)
		expect(readOutput(result)).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED')
	})

	// The absent subpath is the firing control: a resolution that reports nothing
	// for every published entry has not been shown to resolve anything at all. Each
	// module format carries its own control, because a format that resolves nothing
	// is silent for the same reason a resolution that resolves nothing is.
	it('compiles a consumer under every module resolution [requires the registry]', (context) => {
		const stage = requireStage(context)
		const name = readManifestName(join(stage.installed, 'package.json'))
		const reported: string[] = []
		const silent: string[] = []
		for (const driver of RESOLUTIONS) {
			for (const [extension, format] of FORMATS) {
				const written = selectEntries(stage.entries, driver.conditions[format])
				if (written.length === 0) continue
				const label = `${driver.label}.${extension}`
				const probe = `probe.${label}`
				const specifiers = written.map((entry) => entry.specifier)
				writeConsumerProbe(stage, probe, specifiers)
				const project = writeProject(stage, probe, driver, [`./${probe}`])
				for (const message of checkProject(stage, project)) {
					reported.push(`${label}: ${message}`)
				}
				const control = `control.${label}`
				writeConsumerProbe(stage, control, [`${name}${ABSENT_SUBPATH}`])
				const refused = writeProject(stage, control, driver, [`./${control}`])
				if (checkProject(stage, refused).length === 0) silent.push(label)
			}
		}
		expect(reported).toStrictEqual([])
		expect(silent).toStrictEqual([])
	})
})

for (const entry of STAGE?.entries ?? []) {
	describe(`installed entry ${entry.subpath}`, () => {
		it.runIf(entry.module)(
			'publishes what it declares to a Node import, and no more',
			(context) => {
				const stage = requireStage(context)
				// The exports-map walk resolved a declaration a typed importer reads, so an
				// entry reaching this drive without one is reported for that rather than for
				// what a consumer of a missing declaration goes on to say.
				if (!entry.declaration.module) {
					throw new Error(`${entry.subpath} publishes no import declaration`)
				}
				const published = driveRuntime(stage, entry.specifier, ESM_DRIVER)
				const drivers = selectDrivers(entry, 'module')
				expect(drivers).not.toStrictEqual([])
				const reported = drivers.flatMap((driver) =>
					checkSurface(stage, { entry, extension: 'ts', published, driver }),
				)
				expect(reported).toStrictEqual([])
			},
		)

		it.runIf(entry.required)(
			'publishes what it declares to a Node require, and no more',
			(context) => {
				const stage = requireStage(context)
				if (!entry.declaration.commonjs) {
					throw new Error(`${entry.subpath} publishes no require declaration`)
				}
				const published = driveRuntime(stage, entry.specifier, CJS_DRIVER)
				// A subpath whose `require` resolves to a module that no typed CommonJS
				// consumer can compile against carries no declared side to compare here, and
				// whether it may publish one at all is the untypable set's question rather
				// than this drive's. The preceding runtime drive ran either way.
				const drivers = selectDrivers(entry, 'commonjs')
				expect(drivers).not.toStrictEqual([])
				const reported = drivers.flatMap((driver) =>
					checkSurface(stage, { entry, extension: 'cts', published, driver }),
				)
				expect(reported).toStrictEqual([])
			},
		)

		it.runIf(entry.browser)(
			'publishes what it declares to a real browser, and no more [requires a browser]',
			async (context) => {
				const stage = requireStage(context)
				if (!entry.declaration.browser) {
					throw new Error(`${entry.subpath} publishes no browser declaration`)
				}
				const options = resolveBrowser(resolvePinnedBrowser(), process.platform, process.env)
				const browser = await launchBrowser(options).catch((error: unknown) => {
					const cause = `${describeBrowser(options)} was rejected: ${String(error)}`
					if (RELEASE) throw new Error(`The release gate requires a browser, and ${cause}`)
					return context.skip(`No browser launched. ${cause}`)
				})
				try {
					const bundle = await bundleEntry(stage, entry)
					const published = await readBrowserExports(browser, bundle)
					// A browser consumer reads the installed declarations through a bundler, so
					// that is the one driver this face answers under.
					const reported = checkSurface(stage, {
						entry,
						extension: 'ts',
						published,
						driver: BROWSER_DRIVER,
					})
					expect(reported).toStrictEqual([])
				} finally {
					await browser.close()
				}
			},
		)
	})
}

// ── The packed artifacts composed in one real page ──────────────────────────
//
// The preceding surface drives read what this package publishes. These read what a consumer can
// build out of it: an isolated consumer holding the packed workspace beside the installed
// `@orkestrel/agent`, `@orkestrel/tool`, and `@orkestrel/ndjson` artifacts, loaded by a real
// Chromium page over an import map and served by the consumer's own Node fixture. No bundler
// stands between the published files and the page: the browser resolves every bare specifier
// through that map and fetches the installed file itself, so what evaluates is the published
// closure rather than a graph a bundler rewrote. Nothing is stubbed and nothing is polyfilled:
// the only authored stand-in is a scripted provider supplying model output a page cannot obtain
// offline, and every agent, tool, MCP, and relay path it drives is the installed artifact
// running for real.
//
// Each receipt is read with independent recorders armed after the page and its modules have
// loaded — the browser's own request log and a counter wrapped around the page's global
// transport — so a claim of no network covers the composition alone. The control case fires one
// deliberate request through the same page, which is what shows the recorders can see traffic
// at all.

// The page the receipts run in. The list element is where the page tool writes, so a reading
// off that element is the document's own text rather than the handler's report of it. The
// import map is read before the module script, so every bare specifier the page's own graph
// names resolves to a file the consumer installed.
function buildReceiptPage(modules: Modules): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<link rel="icon" href="data:," />
		<title>Distribution receipts</title>
		<script type="importmap">
${JSON.stringify({ imports: modules.imports }, undefined, '\t')}
		</script>
	</head>
	<body>
		<ul id="receipts"></ul>
		<script type="module" src="./${ENTRY_MODULE}"></script>
	</body>
</html>
`
}

// The composition stage: one browser, one consumer-hosted origin, the root entries the page
// imported, and the import map it resolved them through. Built once because it installs,
// launches, and listens. The consumer's own path travels with it, because the derivation the
// map rests on is a claim about that installed tree rather than about the page.
interface Receipts {
	readonly consumer: string
	readonly origin: string
	readonly browser: Browser
	readonly child: ProcessInterface
	readonly closure: readonly string[]
	readonly modules: Modules
}

// One reading off the page: the receipt the scenario reported, every request the browser made
// after the recorders armed, and the page's own count of calls through its global transport.
interface Reading {
	readonly receipt: unknown
	readonly requests: readonly string[]
	readonly fetches: number
}

// The page's own module resolution, written down as the browser reads it. `imports` is the
// import map: every bare specifier the page's graph names, mapped to the URL the consumer's
// fixture answers from its own `node_modules`. `files` is what that map and the relative
// specifiers under it reach. `outside` is every specifier the installed tree serves nothing
// for, which stops the stage rather than falling back to a bundler.
interface Modules {
	readonly imports: Readonly<Record<string, string>>
	readonly files: readonly string[]
	readonly outside: readonly string[]
}

// Every bare specifier one module's own top-level statements name.
function readSpecifiers(source: string): readonly string[] {
	const named = new Set<string>()
	for (const match of source.matchAll(SPECIFIER_PATTERN)) {
		const specifier = match[1]
		if (specifier !== undefined && !specifier.startsWith('.')) named.add(specifier)
	}
	return [...named].sort()
}

// Every `@orkestrel` root entry one installed package's own built module names, read off the
// module a browser consumer resolves rather than off a list written down here. This is what
// that one module imports, not a walk of everything those imports go on to reach.
function readClosure(consumer: string, name: string): readonly string[] {
	const installed = join(consumer, 'node_modules', ...name.split('/'))
	const manifest = readJson(join(installed, 'package.json'))
	if (!isRecord(manifest) || !isRecord(manifest.exports)) {
		throw new Error(`The installed ${name} publishes no exports map`)
	}
	const target = resolveTarget(manifest.exports['.'], RUNTIME_CONDITIONS.browser)
	if (target === undefined) throw new Error(`The installed ${name} resolves no browser target`)
	const source = readFileSync(join(installed, target), 'utf8')
	return readSpecifiers(source).filter((specifier) => specifier.startsWith(CLOSURE_SCOPE))
}

// The path under the consumer's `node_modules` one bare specifier resolves to, read off the
// owning package's own exports map under the conditions a browser reads. A specifier naming a
// package the consumer did not install, a subpath that map does not publish, or a condition set
// with no browser answer resolves to nothing, and the caller reports it rather than guessing.
function resolveSpecifier(consumer: string, specifier: string): string | undefined {
	const segments = specifier.split('/')
	const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
	if (name === undefined || name === '') return undefined
	const subpath = specifier.slice(name.length)
	const installed = join(consumer, 'node_modules', ...name.split('/'))
	const path = join(installed, 'package.json')
	if (!matchesFile(path)) return undefined
	const manifest = readJson(path)
	if (!isRecord(manifest) || !isRecord(manifest.exports)) return undefined
	const entry = manifest.exports[subpath === '' ? '.' : `.${subpath}`]
	const target = resolveTarget(entry, RUNTIME_CONDITIONS.browser)
	if (target === undefined || !isPackageTarget(target)) return undefined
	return `${name}/${target.slice(2)}`
}

// One relative specifier resolved against the served path of the module that names it. The
// served paths are URL paths rather than host paths, so the segments are walked here instead of
// handed to a host joiner that would answer in the host's own separator.
function joinServed(served: string, relative: string): string {
	const segments = served.split('/').slice(0, -1)
	for (const segment of relative.split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') segments.pop()
		else segments.push(segment)
	}
	return segments.join('/')
}

// The import map one set of entry specifiers needs, derived by walking the installed tree the
// page resolves against. Each bare specifier resolves through its own package's exports map and
// enters the map; each relative specifier resolves against the module that named it and is
// followed without entering the map, because a relative URL needs no mapping. The walk reads
// the top-level statements of each module it reaches, so a specifier reached some other way —
// a dynamic import, a side-effect import — is absent from the map and reports as a page console
// error rather than passing unnoticed.
function walkModules(consumer: string, entries: readonly string[]): Modules {
	const root = join(consumer, 'node_modules')
	const imports: Record<string, string> = {}
	const outside = new Set<string>()
	const read = new Set<string>()
	const bare = [...entries]
	const served: string[] = []
	while (bare.length > 0 || served.length > 0) {
		const specifier = bare.shift()
		if (specifier !== undefined) {
			if (Object.hasOwn(imports, specifier)) continue
			const target = resolveSpecifier(consumer, specifier)
			if (target === undefined) {
				outside.add(specifier)
				continue
			}
			imports[specifier] = `${MODULE_PATH}${target}`
			served.push(target)
			continue
		}
		const path = served.shift()
		if (path === undefined || read.has(path)) continue
		read.add(path)
		if (!matchesFile(join(root, ...path.split('/')))) {
			outside.add(path)
			continue
		}
		const source = readFileSync(join(root, ...path.split('/')), 'utf8')
		for (const match of source.matchAll(SPECIFIER_PATTERN)) {
			const named = match[1]
			if (named === undefined) continue
			if (named.startsWith('.')) served.push(joinServed(path, named))
			else bare.push(named)
		}
	}
	return { imports, files: [...read].sort(), outside: [...outside].sort() }
}

// Every `node_modules` directory nested under one installed root. The derivation resolves each
// bare specifier against the consumer's top-level `node_modules` whatever module named it, which
// is what a flat install makes true. Where installed packages need releases of a shared
// dependency that no single copy satisfies, npm nests the extra copy under the package that
// needs it, an import map has no way to express the duplicate, and the map would describe a
// resolution the consumer's own Node never performs.
function findNested(root: string): readonly string[] {
	const found: string[] = []
	const pending: string[] = [root]
	while (pending.length > 0) {
		const directory = pending.shift()
		if (directory === undefined) continue
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const path = join(directory, entry.name)
			if (entry.name === 'node_modules') found.push(path)
			else pending.push(path)
		}
	}
	return found
}

// The page directory, written where the consumer's fixture serves it. Each root entry is
// imported by name and handed to the driver, so the page evaluating at all is the proof that
// every one of them resolved through the map and evaluated.
function writeReceiptPage(consumer: string, closure: readonly string[], modules: Modules): string {
	const page = join(consumer, 'pages', 'receipts')
	const bindings = closure.map(
		(specifier, index) => `import * as closure${String(index)} from ${JSON.stringify(specifier)}`,
	)
	const entries = closure.map(
		(specifier, index) => `\t${JSON.stringify(specifier)}: closure${String(index)},`,
	)
	writeFile(join(page, 'index.html'), buildReceiptPage(modules))
	writeFile(
		join(page, ENTRY_MODULE),
		`${bindings.join('\n')}\nimport { publish } from './${PAGE_MODULE}'\n\npublish({\n${entries.join('\n')}\n})\n`,
	)
	copyFileSync(PAGE_FIXTURE, join(page, PAGE_MODULE))
	copyFileSync(SCRIPT_FIXTURE, join(page, SCRIPT_MODULE))
	return page
}

// The origin the consumer's fixture bound, read off the line it writes after its listener is
// up. The fact arrives on the child's own stream, so nothing here waits on a duration.
async function readOrigin(child: ProcessInterface): Promise<string> {
	for await (const line of child.lines) {
		const port = READY_PATTERN.exec(line)?.[1]
		if (port !== undefined) return `http://127.0.0.1:${port}`
	}
	throw new Error(`The consumer fixture reported no listening port: ${child.evidence}`)
}

// Builds the composition stage, or reports what the run could not reach.
//
// The composition consumer is its own tree: this workspace's packed archive and the artifacts
// these receipts compose it with, resolved in one install. One install is what keeps the packed
// archive in place — a second one re-resolves the first one's ranges and can replace it with the
// registry copy of the same version. A tree of its own is what keeps an artifact this host
// cannot install away from the preceding drives, which measure the packed workspace alone.
async function startReceipts(stage: Stage): Promise<Receipts | string> {
	const consumer = join(SCRATCH, 'compose')
	const archive = stage.archives[0]
	if (archive === undefined) throw new Error('The stage packed no archive to compose')
	writeFile(join(consumer, 'package.json'), CONSUMER_MANIFEST)
	const install = runNpm(
		[
			'install',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			join(stage.packed, archive),
			...COMPOSITION,
		],
		consumer,
	)
	if (install.status !== 0) {
		return `The composed artifacts ${COMPOSITION.join(' ')} did not install: ${readOutput(install)}`
	}
	const options = resolveBrowser(resolvePinnedBrowser(), process.platform, process.env)
	let browser: Browser
	try {
		browser = await launchBrowser(options)
	} catch (error) {
		return `No browser launched. ${describeBrowser(options)} was rejected: ${String(error)}`
	}
	let child: ProcessInterface | undefined
	try {
		const closure = readClosure(consumer, COMPOSED)
		const modules = walkModules(consumer, [
			...readSpecifiers(readFileSync(PAGE_FIXTURE, 'utf8')),
			...closure,
		])
		if (modules.outside.length > 0) {
			throw new Error(
				`The consumer's installed tree serves no module for ${modules.outside.join(', ')}`,
			)
		}
		const page = writeReceiptPage(consumer, closure, modules)
		copyFileSync(SERVER_FIXTURE, join(consumer, FIXTURE))
		copyFileSync(SCRIPT_FIXTURE, join(consumer, SCRIPT_MODULE))
		child = createProcess({
			command: {
				file: process.execPath,
				arguments: [FIXTURE, page, join(consumer, 'node_modules'), CREDENTIAL],
			},
			workspace: consumer,
		})
		return {
			consumer,
			origin: await readOrigin(child),
			browser,
			child,
			closure,
			modules,
		}
	} catch (error) {
		if (child !== undefined) await child.destroy()
		await browser.close()
		throw error
	}
}

let RECEIPTS: Promise<Receipts | string> | undefined

// The composition stage, or a skip naming what the run could not reach. A release run has no
// skip available to it: evidence a gate cannot obtain is the gate failing.
async function requireReceipts(context: TestContext): Promise<Receipts> {
	RECEIPTS ??= startReceipts(requireStage(context))
	const opened = await RECEIPTS
	if (typeof opened === 'string') {
		if (RELEASE) throw new Error(`The release gate requires the composed page. ${opened}`)
		return context.skip(opened)
	}
	return opened
}

// Closes the composition stage. The scratch tree's own removal calls it, so the child and the
// browser are gone before the tree they run out of is removed.
async function closeReceipts(): Promise<void> {
	const opened = await RECEIPTS
	if (opened === undefined || typeof opened === 'string') return
	await opened.child.destroy()
	await opened.browser.close()
}

// One scenario run in its own page, with the request log and the transport counter armed
// between the load and the run. The page reports its receipt as JSON text, so what crosses the
// boundary is the same value on each side of it rather than whatever a structured clone made of
// the page's objects.
//
// A module the import map does not cover fails to resolve, and the browser reports that on its
// console rather than as a thrown page error, so the console's own error stream is read beside
// the page errors and a load that left anything unresolved is raised rather than measured.
async function readReceipt(receipts: Receipts, call: string): Promise<Reading> {
	const page = await receipts.browser.newPage()
	try {
		const failures: string[] = []
		page.on('pageerror', (error) => failures.push(String(error)))
		page.on('console', (message) => {
			if (message.type() === 'error') failures.push(message.text())
		})
		await page.goto(`${receipts.origin}/`, { waitUntil: 'load' })
		if (failures.length > 0) throw new Error(`The page raised ${failures.join(' | ')}`)
		const requests: string[] = []
		page.on('request', (request) => requests.push(request.url()))
		await page.evaluate('globalThis.receipts.arm()')
		const reported: unknown = await page.evaluate(`globalThis.receipts.${call}`)
		const counted: unknown = await page.evaluate('globalThis.receipts.fetches()')
		if (failures.length > 0) throw new Error(`The page raised ${failures.join(' | ')}`)
		if (typeof reported !== 'string') throw new Error(`${call} reported no receipt`)
		if (typeof counted !== 'number') throw new Error(`${call} reported no transport count`)
		const receipt: unknown = JSON.parse(reported)
		return { receipt, requests, fetches: counted }
	} finally {
		await page.close()
	}
}

// What the consumer's own fixture recorded, read from the route it publishes. The read is made
// from this process rather than from the page, so it lands in neither page recorder. The route
// reports and clears, so a reading states what the scenario that preceded it relayed rather
// than a total carried over from an earlier one.
async function readRelayed(receipts: Receipts): Promise<unknown> {
	const response = await fetch(`${receipts.origin}${RECEIPTS_PATH}`)
	if (!response.ok) {
		throw new Error(`The consumer fixture refused its own receipts: ${String(response.status)}`)
	}
	const relayed: unknown = await response.json()
	return relayed
}

describe('installed artifacts composed in a page', () => {
	it('evaluates every @orkestrel entry the installed agent imports [requires a browser]', async (context) => {
		const receipts = await requireReceipts(context)
		const reading = await readReceipt(receipts, 'closure()')
		expect(receipts.closure.length).toBeGreaterThan(0)
		// Every bare specifier the walk reached is served from the consumer's own `node_modules`
		// through the import map, so nothing was bundled and nothing was left for a resolver this
		// page does not have. A relative specifier is absent from the map by construction: it
		// resolves against the URL of the module that named it, which the same route already
		// serves.
		expect(receipts.modules.outside).toStrictEqual([])
		const mapped = Object.keys(receipts.modules.imports)
		expect(receipts.closure.filter((specifier) => !mapped.includes(specifier))).toStrictEqual([])
		expect(
			Object.values(receipts.modules.imports).filter((url) => !url.startsWith(MODULE_PATH)),
		).toStrictEqual([])
		// The installed tree the map was derived against is flat, which is what lets every bare
		// specifier resolve against the consumer's top level whatever module named it.
		const root = join(receipts.consumer, 'node_modules')
		expect(findNested(root)).toStrictEqual([])
		// What the walk reached, which is the population the map was derived from: each entry is
		// a file inside an installed `@orkestrel` package under that top level, every target the
		// map names is among them, and the set is closed under the relative edges its own files
		// name — a walk that stopped following a relative specifier would shrink this set
		// silently, and the assertion following this one would still see only what remained.
		expect(
			receipts.modules.files.filter(
				(file) => !file.startsWith(CLOSURE_SCOPE) || !matchesFile(join(root, ...file.split('/'))),
			),
		).toStrictEqual([])
		const served = Object.values(receipts.modules.imports).map((url) =>
			url.slice(MODULE_PATH.length),
		)
		expect(served.filter((target) => !receipts.modules.files.includes(target))).toStrictEqual([])
		const unclosed = receipts.modules.files.flatMap((file) => {
			const source = readFileSync(join(root, ...file.split('/')), 'utf8')
			const relatives = [...source.matchAll(SPECIFIER_PATTERN)]
				.map((match) => match[1])
				.filter((named): named is string => named !== undefined && named.startsWith('.'))
			return relatives
				.map((named) => joinServed(file, named))
				.filter((target) => !receipts.modules.files.includes(target))
		})
		expect(unclosed).toStrictEqual([])
		// The core entry is reached only through the browser entry's relative edge to it, never
		// through the import map: no bare specifier names `@orkestrel/mcp`'s root export, so its
		// served path is among the entries the walk read and absent from every target the map
		// names.
		const coreEntry = '@orkestrel/mcp/dist/src/core/index.js'
		expect(receipts.modules.files).toContain(coreEntry)
		expect(served).not.toContain(coreEntry)
		const read = reading.receipt
		if (!isRecord(read)) throw new Error('The page reported no closure reading')
		expect(Object.keys(read).sort()).toStrictEqual([...receipts.closure].sort())
		const silent = Object.entries(read).filter(
			(entry) => !isRecord(entry[1]) || entry[1].names === 0 || entry[1].kind === 'undefined',
		)
		expect(silent.map((entry) => entry[0])).toStrictEqual([])
		expect(reading.requests).toStrictEqual([])
		expect(reading.fetches).toBe(0)
	})

	it('runs a page tool through an installed agent with no request at all [requires a browser]', async (context) => {
		const receipts = await requireReceipts(context)
		const reading = await readReceipt(receipts, 'page()')
		expect(reading.receipt).toStrictEqual({
			painted: [{ note: 'kyoto', text: 'receipt-1' }],
			calls: [{ name: 'paint', success: true, value: 'receipt-1' }],
			turns: [0, 1],
			content: 'the note is recorded',
			partial: false,
			roles: ['user', 'assistant', 'tool', 'assistant'],
			tool: ['"receipt-1"'],
		})
		expect(reading.requests).toStrictEqual([])
		expect(reading.fetches).toBe(0)
	})

	it('completes an in-page MCP pair with no request at all [requires a browser]', async (context) => {
		const receipts = await requireReceipts(context)
		const reading = await readReceipt(receipts, 'pair()')
		expect(reading.receipt).toStrictEqual({
			// The client's own connection flag under the call that moved it: `connect` opened it
			// and `stop` closed it.
			connected: { connect: true, stop: false },
			version: '2026-07-28',
			// The display metadata and the domain annotation survive the round trip whole: the
			// server projects `pure` onto `readOnlyHint` and the client projects it back, and
			// neither side invents the hints the tool did not author.
			listed: [
				{
					name: 'add',
					title: 'Add two numbers',
					description: 'Adds two numbers',
					annotations: { pure: true },
					parameters: {
						type: 'object',
						properties: {
							a: { type: 'number' },
							b: { type: 'number' },
						},
						required: ['a', 'b'],
					},
				},
			],
			outcome: { resultType: 'complete', value: 5 },
			code: -32600,
		})
		expect(reading.requests).toStrictEqual([])
		expect(reading.fetches).toBe(0)
	})

	it('dispatches an agent call into the page server with no request at all [requires a browser]', async (context) => {
		const receipts = await requireReceipts(context)
		const reading = await readReceipt(receipts, 'bridge()')
		expect(reading.receipt).toStrictEqual({
			advertised: [
				{
					name: 'add',
					title: 'Add two numbers',
					description: 'Adds two numbers',
					annotations: { pure: true },
					parameters: {
						type: 'object',
						properties: {
							a: { type: 'number' },
							b: { type: 'number' },
						},
						required: ['a', 'b'],
					},
				},
			],
			// The registry the agent dispatches from holds the same metadata the wire delivered,
			// so the projection reaches the agent rather than stopping at the client.
			registered: {
				name: 'add',
				title: 'Add two numbers',
				description: 'Adds two numbers',
				annotations: { pure: true },
				parameters: {
					type: 'object',
					properties: {
						a: { type: 'number' },
						b: { type: 'number' },
					},
					required: ['a', 'b'],
				},
			},
			executed: 1,
			calls: [
				{ name: 'add', success: true, value: 5 },
				{
					name: 'missing',
					success: false,
					value: 'tool not found: missing',
				},
			],
			turns: [0, 1, 2],
			content: 'the sum is 5',
			partial: false,
			roles: ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'],
			tool: ['5', 'tool not found: missing'],
		})
		expect(reading.requests).toStrictEqual([])
		expect(reading.fetches).toBe(0)
	})

	it('carries a caller abort into the page server handler [requires a browser]', async (context) => {
		const receipts = await requireReceipts(context)
		const reading = await readReceipt(receipts, 'cancel()')
		const read = reading.receipt
		if (!isRecord(read)) throw new Error('The page reported no cancellation reading')
		// This package does not carry the cancellation notification's own `reason` into the
		// per-request abort, so the reason the hosted handler reads is whatever aborted the
		// request rather than the sentence the caller passed to `abort`. That limit is why the
		// receipt pins the error's class instead of its sentence. The client's refusal beside it
		// is this package's own wording and is pinned whole.
		const { reason, ...settled } = read
		expect(String(reason)).toContain('AbortError')
		expect(settled).toStrictEqual({
			calls: [
				{
					name: 'hold',
					success: false,
					value: "MCP request 'tools/call' was aborted",
				},
			],
			partial: true,
			turns: [0, 1],
		})
		expect(reading.requests).toStrictEqual([])
		expect(reading.fetches).toBe(0)
	})

	it('spends one relay request per model turn and runs the tool in the page [requires a browser]', async (context) => {
		const receipts = await requireReceipts(context)
		const relay = `${receipts.origin}${RELAY_PATH}`
		const reading = await readReceipt(
			receipts,
			`relay(${JSON.stringify(relay)}, ${JSON.stringify(CREDENTIAL)})`,
		)
		expect(reading.receipt).toStrictEqual({
			painted: [{ note: 'kyoto', text: 'receipt-1' }],
			calls: [{ name: 'paint', success: true, value: 'receipt-1' }],
			turns: [0, 1],
			content: 'the note is recorded',
			partial: false,
			roles: ['user', 'assistant', 'tool', 'assistant'],
			tool: ['"receipt-1"'],
		})
		expect(reading.requests).toStrictEqual([relay, relay])
		expect(reading.fetches).toBe(2)
		expect(await readRelayed(receipts)).toStrictEqual({
			relay: 2,
			served: [
				{ roles: ['user'], tools: ['paint'] },
				{ roles: ['user', 'assistant', 'tool'], tools: ['paint'] },
			],
		})
	})

	// The relay route carries an `authorize` callback, and the preceding receipt presents the
	// credential it accepts. A relay that stopped calling that callback would leave every
	// assertion before this one green, so this one presents a credential the consumer's fixture
	// does not hold and reads what the installed relay answers. The route's own accounting is
	// read after it, which is what separates a relay that refused the turn from a route that
	// never saw it.
	//
	// The dial is made from this process rather than from the page. Chromium reports a refused
	// resource load on the page's console, the page reader raises a console error rather than
	// measuring it, and the only way to tell that line from the unresolved-module error the
	// reader exists to catch is to match wording Chromium owns.
	it('refuses a relay turn presenting a credential the fixture does not hold [requires a browser]', async (context) => {
		const receipts = await requireReceipts(context)
		const response = await fetch(`${receipts.origin}${RELAY_PATH}`, {
			method: 'POST',
			headers: { authorization: REFUSED, 'content-type': 'application/json' },
			body: JSON.stringify({ messages: [{ role: 'user', content: 'record the note kyoto' }] }),
		})
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('')
		expect(await readRelayed(receipts)).toStrictEqual({
			relay: 1,
			served: [{ roles: ['user'], tools: [] }],
		})
	})

	it('reports one deliberate request on the request log and the counter [requires a browser]', async (context) => {
		const receipts = await requireReceipts(context)
		const control = `${receipts.origin}${CONTROL_PATH}`
		const reading = await readReceipt(receipts, `control(${JSON.stringify(control)})`)
		expect(reading.receipt).toStrictEqual({ status: 200, text: 'control' })
		expect(reading.requests).toStrictEqual([control])
		expect(reading.fetches).toBe(1)
	})
})
