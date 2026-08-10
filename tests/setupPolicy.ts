import { globSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { basename, extname, join } from 'node:path'
import * as ts from 'typescript'

/** Centralized source modules whose top-level declarations must all be exported. */
export const CENTRAL_SOURCE_FILES: readonly string[] = Object.freeze([
	'combinators.ts',
	'cloners.ts',
	'compilers.ts',
	'constants.ts',
	'contracts.ts',
	'errors.ts',
	'factories.ts',
	'helpers.ts',
	'handlers.ts',
	'inferers.ts',
	'middlewares.ts',
	'parsers.ts',
	'relations.ts',
	'routes.ts',
	'schemas.ts',
	'seeders.ts',
	'shapers.ts',
	'templates.ts',
	'types.ts',
	'validators.ts',
])

/** Centralized files that own module-scope function declarations. */
export const FUNCTION_SOURCE_FILES: readonly string[] = Object.freeze([
	'combinators.ts',
	'cloners.ts',
	'compilers.ts',
	'errors.ts',
	'factories.ts',
	'handlers.ts',
	'helpers.ts',
	'inferers.ts',
	'middlewares.ts',
	'parsers.ts',
	'relations.ts',
	'routes.ts',
	'schemas.ts',
	'seeders.ts',
	'shapers.ts',
	'validators.ts',
])

/** Centralized files that own module-scope data declarations. */
export const DATA_SOURCE_FILES: readonly string[] = Object.freeze([
	'combinators.ts',
	'constants.ts',
	'contracts.ts',
	'relations.ts',
	'routes.ts',
	'schemas.ts',
	'shapers.ts',
	'templates.ts',
	'validators.ts',
])

/** Domain folders whose modules each export one named function rather than one class. */
export const FUNCTION_DOMAIN_FOLDERS: readonly string[] = Object.freeze(['app/browser/composables'])

/** Worker-only value globals that WebWorker typing must not expose to core implementations. */
export const WORKER_SCOPE_VALUE_GLOBALS: readonly string[] = Object.freeze([
	'name',
	'onrtctransform',
	'close',
	'postMessage',
	'dispatchEvent',
	'location',
	'onerror',
	'onlanguagechange',
	'onoffline',
	'ononline',
	'onrejectionhandled',
	'onunhandledrejection',
	'self',
	'importScripts',
	'fonts',
	'caches',
	'crossOriginIsolated',
	'indexedDB',
	'isSecureContext',
	'origin',
	'scheduler',
	'createImageBitmap',
	'reportError',
	'cancelAnimationFrame',
	'requestAnimationFrame',
	'onmessage',
	'onmessageerror',
	'addEventListener',
	'removeEventListener',
])

/** Source extensions inspected by the repository coding-law sweep. */
export const CODING_SOURCE_EXTENSIONS: readonly string[] = Object.freeze([
	'cjs',
	'cts',
	'js',
	'jsx',
	'mjs',
	'mts',
	'ts',
	'tsx',
	'vue',
])

/** Production-source glob derived from the complete inspected extension vocabulary. */
export const CODING_SOURCE_GLOB = `{app,src}/**/*.{${CODING_SOURCE_EXTENSIONS.join(',')}}`

/** Fleet-owned policy files that must stay free of any one package's architecture. */
export const POLICY_INFRASTRUCTURE_FILES: readonly string[] = Object.freeze([
	'tests/policy.test.ts',
	'tests/setupPolicy.ts',
])

/** Source environments whose prefixed paths fleet policy must not name in a literal. */
export const POLICY_SOURCE_ENVIRONMENTS: readonly string[] = Object.freeze([
	'browser',
	'core',
	'server',
])

/**
 * The prefixed source-environment path fleet policy must not name in a literal.
 *
 * @remarks
 * Built rather than written, so this file states no matching literal of its own
 * and can never report itself. Policy names an environment without the source
 * prefix when it must name one at all, which is why the prefix is the rule.
 */
export const POLICY_ENVIRONMENT_PATTERN: RegExp = new RegExp(
	`src/(?:${POLICY_SOURCE_ENVIRONMENTS.join('|')})/`,
	'u',
)

/** Virtual source text used while binding one policy-inspected module. */
export const POLICY_SOURCE_TEXTS: Map<string, string> = new Map()

/** One script block extracted from a Vue SFC by the official compiler. */
export interface VueScriptBlockInterface {
	readonly content: string
	readonly lang?: string
}

/** An injected official Vue SFC script-block extractor. */
export interface VueScriptExtractorInterface {
	(path: string, content: string): readonly VueScriptBlockInterface[]
}

/** Normalize platform separators and duplicate glob segments for stable diagnostics. */
export function normalizePolicyPath(path: string): string {
	return path.replaceAll('\\', '/').replace(/\/+/gu, '/')
}

/** Whether a path belongs to the production-source coding-law corpus. */
export function isCodingSourcePath(path: string): boolean {
	const normalized = normalizePolicyPath(path)
	const extension = normalized.split('.').pop()
	return (
		(normalized.startsWith('app/') || normalized.startsWith('src/')) &&
		extension !== undefined &&
		CODING_SOURCE_EXTENSIONS.includes(extension)
	)
}

/**
 * Whether a path is an eligible function-domain module.
 *
 * @param path - The workspace-relative source path to inspect
 * @returns `true` when the path is a direct module of a registered function domain
 */
export function isFunctionDomainPath(path: string): boolean {
	const normalized = normalizePolicyPath(path)
	const file = basename(normalized)
	const separator = normalized.lastIndexOf('/')
	const parent = separator < 0 ? '' : normalized.slice(0, separator)
	return (
		FUNCTION_DOMAIN_FOLDERS.includes(parent) &&
		/^[a-z][A-Za-z0-9]*\.ts$/u.test(file) &&
		file !== 'index.ts' &&
		file !== 'main.ts' &&
		!CENTRAL_SOURCE_FILES.includes(file) &&
		!FUNCTION_SOURCE_FILES.includes(file) &&
		!DATA_SOURCE_FILES.includes(file)
	)
}

/** Whether a declaration carries an explicit export modifier. */
export function hasExportModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
			true
	)
}

/** Whether a declaration carries a specified modifier. */
export function hasModifier(node: ts.Node, modifier: ts.SyntaxKind): boolean {
	return (
		ts.canHaveModifiers(node) &&
		ts.getModifiers(node)?.some((candidate) => candidate.kind === modifier) === true
	)
}

/** Whether a module specifier uses a URL scheme other than Node's builtin namespace. */
export function isUnsupportedModuleSpecifier(specifier: string): boolean {
	return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier) && !specifier.startsWith('node:')
}

/** Whether an arrow/function expression is an anonymous callback passed directly as an argument. */
export function isDirectCallback(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
	const parent = node.parent
	return (
		(ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
		parent.arguments?.some((argument) => argument === node) === true
	)
}

/**
 * Whether an arrow/function expression is returned directly as a factory or combinator result.
 *
 * @param node - The function expression to inspect
 * @returns `true` when the node is a direct return value, including one parenthesized layer
 */
export function isDirectReturn(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
	const parent = node.parent
	if (ts.isReturnStatement(parent)) return true
	if (ts.isArrowFunction(parent) && parent.body === node) return true
	if (!ts.isParenthesizedExpression(parent)) return false
	const container = parent.parent
	return (
		ts.isReturnStatement(container) || (ts.isArrowFunction(container) && container.body === parent)
	)
}

/** Whether a function expression is assigned by one module-scope variable declaration. */
export function isModuleFunction(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
	const declaration = node.parent
	const list = declaration.parent
	const statement = list.parent
	return (
		ts.isVariableDeclaration(declaration) &&
		ts.isVariableDeclarationList(list) &&
		ts.isVariableStatement(statement) &&
		ts.isSourceFile(statement.parent)
	)
}

/**
 * Format a syntax node's source position as a one-based line and character.
 *
 * @param node - The syntax node whose starting position to format
 * @returns The node's one-based `line:character` position
 */
export function formatPolicyPosition(node: ts.Node): string {
	const source = node.getSourceFile()
	const position = source.getLineAndCharacterOfPosition(node.getStart())
	return `${String(position.line + 1)}:${String(position.character + 1)}`
}

/** Whether a property signature belongs to a centralized interface or type alias contract. */
export function isContractProperty(node: ts.PropertySignature): boolean {
	let parent: ts.Node = node.parent
	while (ts.isTypeLiteralNode(parent)) parent = parent.parent
	return ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)
}

/** Whether the sole production triple-slash reference is the generated browser Vite contract. */
export function hasAllowedTripleSlashReference(path: string, source: ts.SourceFile): boolean {
	return (
		path.replaceAll('\\', '/') === 'app/browser/env.d.ts' &&
		source.referencedFiles.length === 0 &&
		source.libReferenceDirectives.length === 0 &&
		source.typeReferenceDirectives.length === 1 &&
		source.typeReferenceDirectives[0]?.fileName === 'vite/client'
	)
}

/**
 * Whether a source is self-contained around a positively identified Node runtime dependency.
 *
 * @param source - The parsed source file to inspect.
 * @returns `true` when at least one value import names a real `node:` builtin and no sibling,
 * re-exported, or dynamic runtime dependency is present; type-only imports are erased.
 *
 * @example
 * ```ts
 * const source = ts.createSourceFile(
 * 	'serve.ts',
 * 	"import { parentPort } from 'node:worker_threads'",
 * 	ts.ScriptTarget.Latest,
 * 	true,
 * )
 * isSelfContained(source) // true
 * ```
 */
export function isSelfContained(source: ts.SourceFile): boolean {
	const pending: ts.Node[] = [source]
	while (pending.length > 0) {
		const node = pending.pop()
		if (node === undefined) continue
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			return false
		}
		ts.forEachChild(node, (child) => {
			pending.push(child)
		})
	}

	let builtin = false
	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
			return false
		}
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause
			const named = clause?.namedBindings
			const erased =
				clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
				(clause !== undefined &&
					clause.name === undefined &&
					named !== undefined &&
					ts.isNamedImports(named) &&
					named.elements.length > 0 &&
					named.elements.every((element) => element.isTypeOnly))
			if (erased) continue
			const moduleSpecifier = statement.moduleSpecifier
			if (!ts.isStringLiteral(moduleSpecifier)) return false
			const specifier = moduleSpecifier.text
			if (!specifier.startsWith('node:') || !isBuiltin(specifier)) return false
			builtin = true
		}
		if (ts.isImportEqualsDeclaration(statement)) {
			if (statement.isTypeOnly) continue
			const reference = statement.moduleReference
			if (
				!ts.isExternalModuleReference(reference) ||
				reference.expression === undefined ||
				!ts.isStringLiteral(reference.expression)
			) {
				return false
			}
			const specifier = reference.expression.text
			if (!specifier.startsWith('node:') || !isBuiltin(specifier)) return false
			builtin = true
		}
	}
	return builtin
}

/**
 * Whether the policy compiler can read one source path.
 *
 * @param path - The source path to inspect
 * @returns `true` when the virtual or physical source exists
 */
export function hasPolicySource(path: string): boolean {
	return POLICY_SOURCE_TEXTS.has(path) || ts.sys.fileExists(path)
}

/**
 * Read one virtual or physical policy source.
 *
 * @param path - The source path to read
 * @returns The source text when present
 */
export function readPolicySource(path: string): string | undefined {
	return POLICY_SOURCE_TEXTS.get(path) ?? ts.sys.readFile(path)
}

/**
 * Parse one virtual or physical policy source for the compiler host.
 *
 * @param path - The source path to parse
 * @param language - The requested TypeScript language target
 * @returns The parsed source file when present
 */
export function createPolicySource(
	path: string,
	language: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.SourceFile | undefined {
	const content = readPolicySource(path)
	return content === undefined ? undefined : ts.createSourceFile(path, content, language, true)
}

/**
 * Bind one policy-inspected module without loading ambient host declarations.
 *
 * @param path - The source path used in diagnostics
 * @param content - The TypeScript source text to bind
 * @returns A one-file TypeScript program whose checker resolves lexical bindings
 */
export function createPolicyProgram(path: string, content: string): ts.Program {
	const options: ts.CompilerOptions = {
		allowJs: true,
		noLib: true,
		noResolve: true,
		target: ts.ScriptTarget.Latest,
		types: [],
	}
	POLICY_SOURCE_TEXTS.set(path, content)
	const host = ts.createCompilerHost(options)
	host.fileExists = hasPolicySource
	host.readFile = readPolicySource
	host.getSourceFile = createPolicySource
	const program = ts.createProgram([path], options, host)
	POLICY_SOURCE_TEXTS.delete(path)
	return program
}

/**
 * Whether an identifier is a standalone runtime value reference.
 *
 * @param node - The identifier occurrence to classify
 * @param checker - The binder used to distinguish lexical values from ambient globals
 * @returns `true` only when the occurrence reads or writes a runtime value
 */
export function isValueReferenceIdentifier(node: ts.Identifier, checker: ts.TypeChecker): boolean {
	if (ts.isPartOfTypeNode(node)) return false

	let ancestor: ts.Node = node.parent
	while (!ts.isSourceFile(ancestor) && !ts.isStatement(ancestor)) {
		if (ts.isTypeQueryNode(ancestor)) return false
		if (ts.isComputedPropertyName(ancestor) && ts.isTypeElement(ancestor.parent)) return false
		ancestor = ancestor.parent
	}

	const parent = node.parent
	if (
		(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
		(ts.isPropertyAssignment(parent) && parent.name === node) ||
		(ts.isPropertyDeclaration(parent) && parent.name === node) ||
		(ts.isPropertySignature(parent) && parent.name === node) ||
		(ts.isMethodDeclaration(parent) && parent.name === node) ||
		(ts.isMethodSignature(parent) && parent.name === node) ||
		(ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
		(ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
		(ts.isVariableDeclaration(parent) && parent.name === node) ||
		(ts.isParameter(parent) && parent.name === node) ||
		(ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
		(ts.isFunctionDeclaration(parent) && parent.name === node) ||
		(ts.isFunctionExpression(parent) && parent.name === node) ||
		(ts.isClassDeclaration(parent) && parent.name === node) ||
		(ts.isClassExpression(parent) && parent.name === node) ||
		(ts.isInterfaceDeclaration(parent) && parent.name === node) ||
		(ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
		(ts.isTypeParameterDeclaration(parent) && parent.name === node) ||
		(ts.isEnumDeclaration(parent) && parent.name === node) ||
		(ts.isEnumMember(parent) && parent.name === node) ||
		(ts.isModuleDeclaration(parent) && parent.name === node) ||
		ts.isImportClause(parent) ||
		ts.isImportSpecifier(parent) ||
		ts.isNamespaceImport(parent) ||
		ts.isImportEqualsDeclaration(parent) ||
		ts.isExportSpecifier(parent) ||
		ts.isNamespaceExport(parent) ||
		ts.isNamespaceExportDeclaration(parent) ||
		(ts.isLabeledStatement(parent) && parent.label === node) ||
		(ts.isBreakOrContinueStatement(parent) && parent.label === node) ||
		(ts.isJsxAttribute(parent) && parent.name === node)
	) {
		return false
	}
	return (
		(ts.isShorthandPropertyAssignment(parent)
			? checker.getShorthandAssignmentValueSymbol(parent)
			: checker.getSymbolAtLocation(node)) === undefined
	)
}

/** Inspect a Vue single-file component for syntax that can bypass declared import policy. */
export function inspectVueCodingLaw(
	path: string,
	scripts: readonly VueScriptBlockInterface[] = [],
): readonly string[] {
	const violations: string[] = []
	for (const [index, script] of scripts.entries()) {
		if (
			script.lang !== 'ts' &&
			script.lang !== 'tsx' &&
			script.lang !== 'mts' &&
			script.lang !== 'cts'
		) {
			violations.push(`${path}.script-${String(index)} requires a TypeScript script language`)
		}
		const extension =
			script.lang === 'tsx' || script.lang === 'mts' || script.lang === 'cts' ? script.lang : 'ts'
		violations.push(
			...inspectCodingLaw(`${path}.script-${String(index)}.${extension}`, script.content),
		)
	}
	return violations
}

/** Inspect one production source through the shared coding-law route. */
export function inspectCodingSource(
	path: string,
	content: string,
	vueScripts?: VueScriptExtractorInterface,
): readonly string[] {
	const normalizedPath = normalizePolicyPath(path)
	if (!normalizedPath.endsWith('.vue')) return inspectCodingLaw(normalizedPath, content)
	const violations: string[] = []
	if (!normalizedPath.startsWith('app/browser/')) {
		violations.push(`${normalizedPath} Vue components belong in app/browser`)
	}
	// A missing extractor is reported, never absorbed. Returning [] here would make
	// every SFC's script block silently unchecked while the surrounding sweep still
	// reported success — an instrument claiming a coverage it does not have.
	if (vueScripts === undefined) {
		violations.push(
			`${normalizedPath} requires a Vue script extractor; its script blocks were not inspected`,
		)
		return violations
	}
	violations.push(...inspectVueCodingLaw(normalizedPath, vueScripts(normalizedPath, content)))
	return violations
}

/** Add syntax-wide coding-law violations while traversing one source tree. */
export function inspectCodingNode(
	path: string,
	node: ts.Node,
	violations: string[],
	checker: ts.TypeChecker,
): void {
	if (
		/^(?:app|src)[\\/]core[\\/]/u.test(path) &&
		ts.isIdentifier(node) &&
		WORKER_SCOPE_VALUE_GLOBALS.includes(node.text) &&
		isValueReferenceIdentifier(node, checker)
	) {
		violations.push(
			`${path}:${formatPolicyPosition(node)} forbids worker-scope global ${node.text} in core`,
		)
	}
	if (
		ts.isAsExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isNonNullExpression(node)
	) {
		violations.push(`${path}:${formatPolicyPosition(node)} forbids type/non-null assertions`)
	}
	if (node.kind === ts.SyntaxKind.AnyKeyword) {
		violations.push(`${path}:${formatPolicyPosition(node)} forbids any`)
	}
	if (
		(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
		node.moduleSpecifier !== undefined &&
		ts.isStringLiteral(node.moduleSpecifier) &&
		isUnsupportedModuleSpecifier(node.moduleSpecifier.text)
	) {
		violations.push(`${path}:${formatPolicyPosition(node)} forbids non-Node URL module specifiers`)
	}
	if (
		ts.isPropertySignature(node) &&
		isContractProperty(node) &&
		!hasModifier(node, ts.SyntaxKind.ReadonlyKeyword)
	) {
		violations.push(`${path}:${formatPolicyPosition(node)} requires readonly contract properties`)
	}
	if (
		ts.isCallExpression(node) &&
		node.expression.kind === ts.SyntaxKind.ImportKeyword &&
		(node.arguments.length !== 1 || !node.arguments.every(ts.isStringLiteral))
	) {
		violations.push(
			`${path}:${formatPolicyPosition(node)} requires dynamic imports to use string literals so import policy remains enforceable`,
		)
	}
	if (
		ts.isCallExpression(node) &&
		node.expression.kind === ts.SyntaxKind.ImportKeyword &&
		node.arguments.length === 1 &&
		node.arguments.every(ts.isStringLiteral) &&
		isUnsupportedModuleSpecifier(node.arguments[0]?.text ?? '')
	) {
		violations.push(`${path}:${formatPolicyPosition(node)} forbids non-Node URL module specifiers`)
	}
	if (ts.isFunctionDeclaration(node) && !ts.isSourceFile(node.parent)) {
		violations.push(`${path}:${formatPolicyPosition(node)} forbids nested function declarations`)
	}
	if (
		(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
		!isDirectCallback(node) &&
		!isDirectReturn(node) &&
		!isModuleFunction(node)
	) {
		violations.push(`${path}:${formatPolicyPosition(node)} forbids hidden function assignments`)
	}
	ts.forEachChild(node, (child) => inspectCodingNode(path, child, violations, checker))
}

/**
 * Inspect one eligible function-domain module for its required declaration shape.
 *
 * @param path - The source path used in diagnostics
 * @param source - The parsed source file to inspect
 * @returns A shape violation when the module is not imports plus one matching named export
 */
export function inspectFunctionModule(path: string, source: ts.SourceFile): readonly string[] {
	const file = basename(normalizePolicyPath(path))
	const declarations = source.statements.filter(ts.isFunctionDeclaration)
	const functions = declarations.filter((declaration) => declaration.body !== undefined)
	const invalid = source.statements.filter(
		(statement) => !ts.isImportDeclaration(statement) && !ts.isFunctionDeclaration(statement),
	)
	const declaration = functions[0]
	if (
		functions.length === 1 &&
		invalid.length === 0 &&
		declarations.every((candidate) => candidate.name?.text === file.slice(0, -3)) &&
		declaration !== undefined &&
		hasExportModifier(declaration) &&
		!hasModifier(declaration, ts.SyntaxKind.DefaultKeyword)
	) {
		return []
	}
	return [`${path} declarations do not form one matching exported function implementation`]
}

/** Inspect one TypeScript source module for repository coding-law violations. */
export function inspectCodingLaw(path: string, content: string): readonly string[] {
	const violations: string[] = []
	const program = createPolicyProgram(path, content)
	const source = program.getSourceFile(path)
	if (source === undefined) throw new Error(`Policy source was not bound at ${path}`)
	const checker = program.getTypeChecker()
	const file = basename(path)
	const stem = basename(file, extname(file))
	const functionModule = isFunctionDomainPath(path)
	const placementExempt =
		!CENTRAL_SOURCE_FILES.includes(file) &&
		!FUNCTION_SOURCE_FILES.includes(file) &&
		!DATA_SOURCE_FILES.includes(file) &&
		isSelfContained(source)

	if (/\.[cm]?jsx?$/u.test(path)) {
		violations.push(`${path} production modules use TypeScript source extensions`)
	}
	if (FUNCTION_DOMAIN_FOLDERS.some((folder) => basename(folder) === stem)) {
		violations.push(`${path} names a function domain, which belongs in a folder rather than a file`)
	}
	if (/@ts-(?:expect-error|ignore|nocheck)|eslint-disable|oxlint-disable/u.test(content)) {
		violations.push(`${path} forbids suppression directives`)
	}
	if (
		(source.referencedFiles.length > 0 ||
			source.libReferenceDirectives.length > 0 ||
			source.typeReferenceDirectives.length > 0) &&
		!hasAllowedTripleSlashReference(path, source)
	) {
		violations.push(`${path} forbids triple-slash references outside app/browser/env.d.ts`)
	}

	if (file === 'index.ts') {
		for (const statement of source.statements) {
			if (
				!ts.isExportDeclaration(statement) ||
				statement.exportClause !== undefined ||
				statement.isTypeOnly ||
				statement.moduleSpecifier === undefined
			) {
				violations.push(`${path} barrels contain only export * declarations`)
			}
		}
	}

	for (const statement of source.statements) {
		if (
			(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
			file !== 'types.ts'
		) {
			violations.push(`${path} centralizes interfaces and type aliases in types.ts`)
		}
		if (
			CENTRAL_SOURCE_FILES.includes(file) &&
			(ts.isClassDeclaration(statement) ||
				ts.isFunctionDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isVariableStatement(statement)) &&
			!hasExportModifier(statement)
		) {
			violations.push(`${path} exports every centralized declaration`)
		}
		if (
			!placementExempt &&
			!functionModule &&
			ts.isFunctionDeclaration(statement) &&
			!FUNCTION_SOURCE_FILES.includes(file)
		) {
			violations.push(`${path} places module functions in their centralized kind file`)
		}
		if (
			!placementExempt &&
			!functionModule &&
			ts.isVariableStatement(statement) &&
			!DATA_SOURCE_FILES.includes(file)
		) {
			violations.push(`${path} places module data in its centralized kind file`)
		}
		if (
			ts.isClassDeclaration(statement) &&
			file !== 'errors.ts' &&
			!/^[A-Z][A-Za-z0-9]*\.ts$/u.test(file)
		) {
			violations.push(`${path} places each class in its matching implementation or errors file`)
		}
		if (ts.isEnumDeclaration(statement) && file !== 'types.ts') {
			violations.push(`${path} centralizes enum contracts in types.ts`)
		}
		if (file === 'constants.ts' && ts.isVariableStatement(statement)) {
			if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
				violations.push(`${path} constants.ts permits only const declarations`)
			}
			for (const declaration of statement.declarationList.declarations) {
				if (
					!ts.isIdentifier(declaration.name) ||
					!/^[A-Z][A-Z0-9_]*$/u.test(declaration.name.text)
				) {
					violations.push(
						`${path}:${formatPolicyPosition(declaration)} requires UPPER_SNAKE_CASE constants`,
					)
				}
				if (
					declaration.initializer !== undefined &&
					(ts.isArrayLiteralExpression(declaration.initializer) ||
						ts.isObjectLiteralExpression(declaration.initializer))
				) {
					violations.push(
						`${path}:${formatPolicyPosition(declaration)} freezes collection constants`,
					)
				}
			}
		}
	}

	if (functionModule) {
		violations.push(...inspectFunctionModule(path, source))
	}

	if (/^[A-Z][A-Za-z0-9]*\.ts$/u.test(file)) {
		const classes = source.statements.filter(ts.isClassDeclaration)
		const invalid = source.statements.filter(
			(statement) => !ts.isImportDeclaration(statement) && !ts.isClassDeclaration(statement),
		)
		if (
			classes.length !== 1 ||
			invalid.length !== 0 ||
			classes[0]?.name?.text !== file.slice(0, -3) ||
			classes[0] === undefined ||
			!hasExportModifier(classes[0])
		) {
			violations.push(
				`${path} implementation modules contain imports and one matching exported class`,
			)
		}
		for (const member of classes[0]?.members ?? []) {
			if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) {
				violations.push(`${path}:${formatPolicyPosition(member)} uses runtime # privacy`)
			}
		}
	}

	inspectCodingNode(path, source, violations, checker)
	return violations
}

/**
 * Inspect every production source under one workspace.
 *
 * @remarks
 * `vueScripts` is required whenever the workspace contains a `.vue` file: script
 * blocks cannot be read without it, and omitting it is reported as a violation
 * against each SFC rather than passing silently.
 */
export function inspectCodingWorkspace(
	root: string,
	vueScripts?: VueScriptExtractorInterface,
): readonly string[] {
	const violations: string[] = []
	for (const path of globSync(CODING_SOURCE_GLOB, {
		cwd: root,
	})) {
		const content = readFileSync(join(root, path), 'utf8')
		violations.push(...inspectCodingSource(path, content, vueScripts))
	}
	return violations
}

/**
 * Read one workspace's declared package name.
 *
 * @param root - The workspace root holding the package manifest
 * @returns The declared package name
 */
export function readPackageName(root: string): string {
	const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
	const name =
		typeof manifest === 'object' && manifest !== null && 'name' in manifest
			? manifest.name
			: undefined
	if (typeof name !== 'string') throw new Error(`Package manifest at ${root} declares no name`)
	return name
}

/**
 * Derive the identifier prefixes fleet policy must not use from a package name.
 *
 * @param name - The declared package name, scoped or bare
 * @returns The short name's upper-snake and Pascal spellings, deduped
 *
 * @example
 * ```ts
 * derivePolicyTokens('@orkestrel/my-router') // ['MY_ROUTER', 'MyRouter']
 * ```
 */
export function derivePolicyTokens(name: string): readonly string[] {
	const short = name.slice(name.lastIndexOf('/') + 1)
	const words = short.split(/[^A-Za-z0-9]+/u).filter((word) => word.length > 0)
	const upper = words.map((word) => word.toUpperCase()).join('_')
	const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')
	return [...new Set([upper, pascal])].filter((token) => token.length > 0)
}

/**
 * Add package-architecture violations while traversing one fleet policy source tree.
 *
 * @remarks
 * An identifier carries a package's architecture when it is named for that package,
 * so it must begin with the token. A word that merely holds the token somewhere
 * inside it belongs to the fleet's own vocabulary and is left alone.
 */
export function inspectPolicyNode(
	path: string,
	node: ts.Node,
	violations: string[],
	tokens: readonly string[],
): void {
	if (ts.isIdentifier(node)) {
		const token = tokens.find((candidate) => node.text.startsWith(candidate))
		if (token !== undefined) {
			violations.push(`${path}:${formatPolicyPosition(node)} forbids the ${token} package token`)
		}
	}
	if (
		(ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) &&
		POLICY_ENVIRONMENT_PATTERN.test(node.text)
	) {
		violations.push(
			`${path}:${formatPolicyPosition(node)} forbids a source-environment path literal`,
		)
	}
	ts.forEachChild(node, (child) => inspectPolicyNode(path, child, violations, tokens))
}

/**
 * Inspect one fleet policy module for a single package's architecture.
 *
 * @param path - The workspace-relative source path used in diagnostics
 * @param content - The TypeScript source text to inspect
 * @param tokens - The package identifier tokens no identifier may begin with
 * @returns Every violation, in source-position order
 */
export function inspectPolicyPurity(
	path: string,
	content: string,
	tokens: readonly string[],
): readonly string[] {
	const violations: string[] = []
	const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
	inspectPolicyNode(path, source, violations, tokens)
	return violations
}

/**
 * Inspect every fleet policy module under one workspace.
 *
 * @param root - The workspace root whose manifest names the consuming package
 * @returns Every violation across the fleet policy files, in file and position order
 */
export function inspectPolicyWorkspace(root: string): readonly string[] {
	const tokens = derivePolicyTokens(readPackageName(root))
	const violations: string[] = []
	for (const path of POLICY_INFRASTRUCTURE_FILES) {
		const content = readFileSync(join(root, path), 'utf8')
		violations.push(...inspectPolicyPurity(path, content, tokens))
	}
	return violations
}
