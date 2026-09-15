import type { ToolAnnotations, ToolDefinition, ToolManagerInterface } from '@orkestrel/tool'
import type {
	WebMCPAnnotations,
	WebMCPDescriptor,
	WebMCPProjection,
	WebMCPRegisteredTool,
} from './types.js'
import { JSONRPC_INVALID_PARAMS, MCPError } from '@src/core'
import { attempt, canonicalStringify } from '@orkestrel/contract'
import { toolToDefinition } from '@orkestrel/tool'

// The browser face's pure projection leaves — the WebMCP direction of the same translation
// `@orkestrel/mcp`'s `toolAnnotationsToMCP` / `mcpAnnotationsToTool` perform for the MCP wire.
// They sit here rather than beside those because the surface they project onto is this face's:
// WebMCP carries a third hint the MCP wire has no counterpart for (`untrustedContentHint`) and
// spells the consequence differently (`consequentialHint`, not `destructiveHint`).

/**
 * Projects domain tool annotations onto WebMCP registry hints without inventing defaults.
 *
 * @param annotations - The authored domain annotations
 * @returns The mapped hints; an omitted annotation stays omitted
 *
 * @example
 * ```ts
 * toolAnnotationsToWebMCP({ pure: true, untrusted: true }) // { readOnlyHint: true, untrustedContentHint: true }
 * ```
 */
export function toolAnnotationsToWebMCP(annotations: ToolAnnotations): WebMCPAnnotations {
	return {
		...(annotations.pure === undefined ? {} : { readOnlyHint: annotations.pure }),
		...(annotations.untrusted === undefined ? {} : { untrustedContentHint: annotations.untrusted }),
		...(annotations.consequential === undefined
			? {}
			: { consequentialHint: annotations.consequential }),
	}
}

/**
 * Projects WebMCP registry hints onto domain tool annotations without inventing defaults.
 *
 * @param annotations - The registry's hints, as the WebMCP dictionary declares them
 * @returns The mapped annotations; an omitted hint stays omitted
 *
 * @example
 * ```ts
 * webMCPAnnotationsToTool({ readOnlyHint: false, consequentialHint: true }) // { pure: false, consequential: true }
 * ```
 */
export function webMCPAnnotationsToTool(annotations: WebMCPAnnotations): ToolAnnotations {
	return {
		...(annotations.readOnlyHint === undefined ? {} : { pure: annotations.readOnlyHint }),
		...(annotations.untrustedContentHint === undefined
			? {}
			: { untrusted: annotations.untrustedContentHint }),
		...(annotations.consequentialHint === undefined
			? {}
			: { consequential: annotations.consequentialHint }),
	}
}

/**
 * Projects one advertised tool definition onto the WebMCP descriptor a registration carries.
 *
 * @remarks
 * Takes the definition a `ToolManagerInterface` advertises rather than the tool itself, so the
 * description here is the one the MCP wire advertises too — the registry substitutes an
 * authored `summary` for the full `description`, and reading the same projection keeps one
 * advertised description across both surfaces.
 *
 * WebMCP requires `description`, so a definition carrying none cannot be registered at all.
 * Returning `undefined` is what lets the caller refuse the whole batch before registering any
 * of it; registering an empty string instead would be an invented value a foreign agent reads
 * as a real one.
 *
 * @param definition - The advertised definition to project
 * @returns The WebMCP descriptor, or `undefined` when the definition advertises no description
 *
 * @example
 * ```ts
 * toolToWebMCP({ name: 'add', description: 'Adds two numbers' })?.description // 'Adds two numbers'
 * ```
 */
export function toolToWebMCP(definition: ToolDefinition): WebMCPDescriptor | undefined {
	if (definition.description === undefined) return undefined
	const annotations =
		definition.annotations === undefined ? {} : toolAnnotationsToWebMCP(definition.annotations)
	return {
		name: definition.name,
		description: definition.description,
		...(definition.title === undefined ? {} : { title: definition.title }),
		...(definition.parameters === undefined ? {} : { inputSchema: definition.parameters }),
		...(Object.keys(annotations).length === 0 ? {} : { annotations }),
	}
}

/**
 * Projects one registered WebMCP tool onto the tool definition an adopted tool advertises.
 *
 * @remarks
 * The inverse of {@link toolToWebMCP}, and deliberately lossy in the other direction: the
 * registry's `window` and `origin` describe where the tool lives rather than what it does, and
 * the bridge hands the whole registered record back to `executeTool` instead of rebuilding it.
 *
 * @param registered - The registered tool the registry reported
 * @returns The definition an adopted tool advertises
 *
 * @example
 * ```ts
 * webMCPToTool({ name: 'add', description: 'Adds', window, origin: 'https://a.example' }).name // 'add'
 * ```
 */
export function webMCPToTool(registered: WebMCPRegisteredTool): ToolDefinition {
	const annotations =
		registered.annotations === undefined ? {} : webMCPAnnotationsToTool(registered.annotations)
	return {
		name: registered.name,
		description: registered.description,
		...(registered.title === undefined ? {} : { title: registered.title }),
		...(registered.inputSchema === undefined ? {} : { parameters: registered.inputSchema }),
		...(Object.keys(annotations).length === 0 ? {} : { annotations }),
	}
}

/**
 * Determines whether two WebMCP descriptors advertise the same tool to the registry.
 *
 * @remarks
 * The reading `ModelContextInterface.publish` reconciles a name against once the manager's
 * tool has changed under it: equal descriptors leave the live registration standing, because
 * execution routes through the manager by name, and anything else releases it and registers
 * the new one.
 *
 * Equality is structural and key-order-independent, through `@orkestrel/contract`'s
 * `canonicalStringify`: `inputSchema` is the author's own JSON Schema record, and two
 * authorings of the same schema that differ only in key order describe the same tool. A
 * descriptor JSON cannot encode — a cyclic or unreadable `inputSchema` — is reported as
 * unequal, which re-registers rather than serving a descriptor nothing could compare.
 *
 * @param held - The descriptor the live registration carries
 * @param projected - The descriptor this publication projected
 * @returns True when both describe the same tool; false otherwise
 *
 * @example
 * ```ts
 * matchesDescriptor({ name: 'add', description: 'Adds' }, { description: 'Adds', name: 'add' }) // true
 * ```
 */
export function matchesDescriptor(held: WebMCPDescriptor, projected: WebMCPDescriptor): boolean {
	const left = attempt(() => canonicalStringify(held))
	const right = attempt(() => canonicalStringify(projected))
	if (!left.success || !right.success) return false
	return left.value !== undefined && left.value === right.value
}

/**
 * Projects the descriptor a registry advertises for one tool name, or reports that it has none.
 *
 * @remarks
 * Reads the manager's own `definitions()` rather than a tool instance, so the description here
 * is the one the registry advertises — an authored `summary` in place of the full
 * `description` — and one tool reaches the WebMCP registry and the MCP wire describing itself
 * the same way.
 *
 * `undefined` covers both answers a caller must not conflate with a descriptor: the manager
 * advertises no tool under that name, and the tool it advertises carries no description, which
 * is the member WebMCP requires.
 *
 * @param manager - The tool registry to read
 * @param name - The tool name to describe
 * @returns The WebMCP descriptor, or `undefined` when the registry advertises none
 *
 * @example
 * ```ts
 * const tools = createToolManager()
 * tools.add(createTool({ name: 'add', description: 'Adds two numbers', execute: () => 5 }))
 * describeWebMCPTool(tools, 'add')?.description // 'Adds two numbers'
 * ```
 */
export function describeWebMCPTool(
	manager: ToolManagerInterface,
	name: string,
): WebMCPDescriptor | undefined {
	for (const definition of manager.definitions()) {
		if (definition.name === name) return toolToWebMCP(definition)
	}
	return undefined
}

/**
 * Builds the WebMCP projection of every tool a registry advertises, or refuses the batch.
 *
 * @remarks
 * The WebMCP twin of `@orkestrel/mcp`'s `buildToolDescriptors`. Each tool is projected through
 * `@orkestrel/tool`'s own `toolToDefinition` — the projection `definitions()` applies — so a
 * tool advertises one description across the MCP wire and the WebMCP registry alike. The tool
 * travels beside its descriptor because a registration records which tool it was made for, and
 * a descriptor cannot report that.
 *
 * It refuses rather than skips. WebMCP requires `description`, and each alternative to
 * refusing is worse: an empty string is an invented value a foreign agent reads as a real one,
 * and silently dropping the tool publishes a registry missing a tool its author asked for.
 * Refusing before any registration happens is also what keeps `publish` atomic — nothing is
 * registered when one tool cannot be.
 *
 * @param manager - The tool registry to project
 * @returns One projection per advertised tool, in registry order
 * @throws Thrown as an `MCPError` carrying `-32602` when a tool advertises no description,
 * naming the tool
 *
 * @example
 * ```ts
 * const tools = createToolManager()
 * tools.add(createTool({ name: 'add', description: 'Adds two numbers', execute: () => 5 }))
 * buildWebMCPProjections(tools).map((projection) => projection.descriptor.name) // ['add']
 * ```
 */
export function buildWebMCPProjections(manager: ToolManagerInterface): readonly WebMCPProjection[] {
	const projections: WebMCPProjection[] = []
	for (const tool of manager.tools()) {
		const descriptor = toolToWebMCP(toolToDefinition(tool))
		if (descriptor === undefined) {
			throw new MCPError(
				`WebMCP requires a description for tool '${tool.name}'`,
				JSONRPC_INVALID_PARAMS,
			)
		}
		projections.push({ tool, descriptor })
	}
	return projections
}

/**
 * Collects the WebMCP projection of every tool a registry advertises that WebMCP can carry.
 *
 * @remarks
 * The skipping sibling of {@link buildWebMCPProjections}, and the reading a followed change
 * reconciles against: a followed change reaches no caller, so a tool advertising neither a
 * `description` nor a `summary` is left out of the collection rather than refusing a batch
 * nobody asked for.
 *
 * @param manager - The tool registry to project
 * @returns One projection per advertised tool WebMCP can carry, in registry order
 *
 * @example
 * ```ts
 * const tools = createToolManager()
 * tools.add(createTool({ name: 'bare', execute: () => 1 }))
 * collectWebMCPProjections(tools) // []
 * ```
 */
export function collectWebMCPProjections(
	manager: ToolManagerInterface,
): readonly WebMCPProjection[] {
	const projections: WebMCPProjection[] = []
	for (const tool of manager.tools()) {
		const descriptor = toolToWebMCP(toolToDefinition(tool))
		if (descriptor !== undefined) projections.push({ tool, descriptor })
	}
	return projections
}
