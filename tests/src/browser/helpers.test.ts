import { describe, expect, it } from 'vitest'
import {
	buildWebMCPProjections,
	collectWebMCPProjections,
	describeWebMCPTool,
	matchesDescriptor,
	toolAnnotationsToWebMCP,
	toolToWebMCP,
	webMCPAnnotationsToTool,
	webMCPToTool,
} from '@src/browser'
import { isMCPError, toolAnnotationsToMCP } from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import { captureError } from '@orkestrel/test'
import { readOne } from '../../setupBrowser.js'

// src/browser/helpers.ts — the WebMCP direction of the annotation and descriptor projection.
// The comparison that makes these assertions falsifiable is the MCP wire's own projection,
// which lives in `@src/core` and disagrees with this one in two named places: WebMCP carries
// `untrustedContentHint` where MCP carries nothing, and spells the consequence
// `consequentialHint` where MCP spells it `destructiveHint`.

describe('toolAnnotationsToWebMCP — the projection WebMCP takes and the MCP wire cannot', () => {
	it('never invents a debugging hint without a domain counterpart', () => {
		expect(toolAnnotationsToWebMCP({})).not.toHaveProperty('debugging')
		expect(
			toolAnnotationsToWebMCP({ pure: true, untrusted: true, consequential: true }),
		).not.toHaveProperty('debugging')
	})

	it('ignores debugging while projecting the supported hints', () => {
		expect(webMCPAnnotationsToTool({ debugging: true, readOnlyHint: true })).toEqual({ pure: true })
		expect(webMCPAnnotationsToTool({ debugging: true })).toEqual({})
	})

	it('carries untrusted onto untrustedContentHint, which the MCP wire drops entirely', () => {
		const annotations = { pure: true, untrusted: true, consequential: false }

		expect(toolAnnotationsToWebMCP(annotations)).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
			consequentialHint: false,
		})
		// The same input through the MCP wire's projection: `untrusted` has no counterpart and
		// the consequence is spelled differently. Two surfaces, two projections.
		expect(toolAnnotationsToMCP(annotations)).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
		})
	})

	it('invents no hint for an omitted annotation, in either direction', () => {
		expect(toolAnnotationsToWebMCP({})).toEqual({})
		expect(webMCPAnnotationsToTool({})).toEqual({})
		expect(toolAnnotationsToWebMCP({ consequential: false })).toEqual({
			consequentialHint: false,
		})
	})

	it('round-trips every hint it carries back to the annotation it came from', () => {
		const annotations = { pure: false, untrusted: true, consequential: true }

		expect(webMCPAnnotationsToTool(toolAnnotationsToWebMCP(annotations))).toEqual(annotations)
	})
})

describe('toolToWebMCP — the advertised definition, and the description WebMCP requires', () => {
	it('advertises the summary as description, exactly as the MCP wire does', () => {
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'add',
				description: 'Adds every operand and returns their sum',
				summary: 'Adds numbers',
				execute: () => 5,
			}),
		)
		const definition = readOne(tools.definitions(), 'advertised definition')

		expect(toolToWebMCP(definition)?.description).toBe('Adds numbers')
	})

	it('carries title, parameters as inputSchema, and the projected annotations', () => {
		const parameters = { type: 'object', properties: { left: { type: 'number' } } }

		expect(
			toolToWebMCP({
				name: 'add',
				title: 'Add',
				description: 'Adds numbers',
				parameters,
				annotations: { pure: true, untrusted: true },
			}),
		).toEqual({
			name: 'add',
			title: 'Add',
			description: 'Adds numbers',
			inputSchema: parameters,
			annotations: { readOnlyHint: true, untrustedContentHint: true },
		})
	})

	it('omits an annotations member entirely when the projection produced no hint', () => {
		expect(toolToWebMCP({ name: 'add', description: 'Adds', annotations: {} })).toEqual({
			name: 'add',
			description: 'Adds',
		})
	})

	it('reports a definition with no advertised description as unprojectable', () => {
		expect(toolToWebMCP({ name: 'add' })).toBeUndefined()
	})
})

describe('webMCPToTool — the inverse, reading a registered tool back as a definition', () => {
	it('reads inputSchema back as parameters and inverts every hint', () => {
		const schema = { type: 'object' }

		expect(
			webMCPToTool({
				name: 'remote',
				title: 'Remote',
				description: 'Runs elsewhere',
				inputSchema: schema,
				annotations: { readOnlyHint: false, consequentialHint: true },
				window: globalThis.window,
				origin: 'https://partner.example',
			}),
		).toEqual({
			name: 'remote',
			title: 'Remote',
			description: 'Runs elsewhere',
			parameters: schema,
			annotations: { pure: false, consequential: true },
		})
	})

	it('drops window and origin, which say where a tool lives rather than what it does', () => {
		const definition = webMCPToTool({
			name: 'remote',
			description: 'Runs elsewhere',
			window: globalThis.window,
			origin: 'https://partner.example',
		})

		expect(Object.keys(definition)).toEqual(['name', 'description'])
	})
})

describe('buildWebMCPProjections — the batch, refused whole when one tool cannot carry', () => {
	it('projects every advertised tool in registry order', () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', description: 'Adds', execute: () => 5 }))
		tools.add(createTool({ name: 'subtract', description: 'Subtracts', execute: () => 1 }))

		expect(buildWebMCPProjections(tools).map((projection) => projection.descriptor.name)).toEqual([
			'add',
			'subtract',
		])
	})

	it('carries the registry own tool beside each descriptor', () => {
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'add',
				description: 'Adds every operand and returns their sum',
				summary: 'Adds',
				execute: () => 5,
			}),
		)

		// Identity, not a copy: a registration records which tool it was made for, and a
		// rebuilt definition would answer that question for a tool the manager never held.
		// The descriptor beside it still advertises the summary the registry advertises.
		const projection = readOne(buildWebMCPProjections(tools), 'projection')
		expect(projection.tool).toBe(tools.tool('add'))
		expect(projection.descriptor.description).toBe('Adds')
	})

	it('refuses the batch with a coded error naming the tool that advertises no description', () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', description: 'Adds', execute: () => 5 }))
		tools.add(createTool({ name: 'bare', execute: () => 1 }))

		const error: unknown = captureError(() => buildWebMCPProjections(tools))

		expect(isMCPError(error)).toBe(true)
		expect(isMCPError(error) && error.code).toBe(-32602)
		expect(isMCPError(error) && error.message.includes("'bare'")).toBe(true)
	})
})

describe('collectWebMCPProjections — the batch a followed change reconciles against', () => {
	it('skips a tool WebMCP cannot carry and keeps the rest in registry order', () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', description: 'Adds', execute: () => 5 }))
		tools.add(createTool({ name: 'bare', execute: () => 1 }))
		tools.add(createTool({ name: 'subtract', description: 'Subtracts', execute: () => 1 }))

		// The refusing sibling rejects this same registry whole. A followed change has no
		// caller to refuse to, so the tool that cannot be carried is left out instead.
		expect(collectWebMCPProjections(tools).map((projection) => projection.descriptor.name)).toEqual(
			['add', 'subtract'],
		)
		expect(captureError(() => buildWebMCPProjections(tools))).toBeInstanceOf(Error)
	})

	it('carries the registry own tool beside each descriptor', () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', description: 'Adds', execute: () => 5 }))

		expect(readOne(collectWebMCPProjections(tools), 'projection').tool).toBe(tools.tool('add'))
	})

	it('collects nothing from an empty registry', () => {
		expect(collectWebMCPProjections(createToolManager())).toEqual([])
	})
})

describe('describeWebMCPTool — one name, read the way the registry advertises it', () => {
	it('advertises the authored summary in place of the full description', () => {
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'add',
				description: 'Adds every operand and returns their sum',
				summary: 'Adds',
				execute: () => 5,
			}),
		)

		// The registry substitutes the summary, and reading the registry is the whole point:
		// projecting the tool instance instead would advertise a description to WebMCP that
		// the MCP wire never sees.
		expect(describeWebMCPTool(tools, 'add')?.description).toBe('Adds')
	})

	it('reports nothing for a name the registry does not advertise', () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', description: 'Adds', execute: () => 5 }))

		expect(describeWebMCPTool(tools, 'subtract')).toBeUndefined()
	})

	it('reports nothing for a tool that advertises no description', () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'bare', execute: () => 1 }))

		// The same answer as an absent name, deliberately: WebMCP requires `description`, so
		// neither case yields a descriptor a caller could register.
		expect(describeWebMCPTool(tools, 'bare')).toBeUndefined()
	})
})

describe('matchesDescriptor — the reading a later publish reconciles a name against', () => {
	it('reads two authorings of one descriptor as the same tool', () => {
		const schema = { type: 'object', properties: { term: { type: 'string' } } }

		// Key order is the author's, and the same schema written in two orders describes one
		// tool: an encoding that read them apart would re-register on every publish.
		expect(
			matchesDescriptor(
				{ name: 'search', description: 'Searches', inputSchema: schema },
				{
					inputSchema: { properties: { term: { type: 'string' } }, type: 'object' },
					description: 'Searches',
					name: 'search',
				},
			),
		).toBe(true)
	})

	it('reads a changed member as a different tool', () => {
		const held = {
			name: 'search',
			title: 'Search',
			description: 'Searches',
			inputSchema: { type: 'object', properties: { term: { type: 'string' } } },
			annotations: { readOnlyHint: true },
		}

		expect(matchesDescriptor(held, { ...held, description: 'Looks up' })).toBe(false)
		expect(matchesDescriptor(held, { ...held, title: 'Lookup' })).toBe(false)
		expect(
			matchesDescriptor(held, { ...held, inputSchema: { type: 'object', properties: {} } }),
		).toBe(false)
		expect(matchesDescriptor(held, { ...held, annotations: { readOnlyHint: false } })).toBe(false)
	})

	it('reads a descriptor JSON cannot encode as a different tool', () => {
		const cyclic: Record<string, unknown> = { type: 'object' }
		cyclic['self'] = cyclic
		const held = { name: 'search', description: 'Searches', inputSchema: cyclic }

		// Unequal rather than equal: re-registering a descriptor nothing could compare is the
		// safe direction, because the alternative serves a stale one forever.
		expect(matchesDescriptor(held, held)).toBe(false)
	})
})
