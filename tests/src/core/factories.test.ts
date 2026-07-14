import { createMCPServer } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/agent'

// createMCPServer returns a working MCPServerInterface over a live ToolManager
// (AGENTS §16 — a real registry, no mocks). The behavioral coverage of dispatch /
// handle lives in MCPServer.test.ts; this asserts the factory wires identity, the
// tools, and the emitter through to a working instance.

describe('createMCPServer', () => {
	it('returns a server exposing the configured identity', () => {
		const server = createMCPServer({
			name: 'demo',
			version: '2.0.0',
			tools: createToolManager(),
		})

		expect(server.name).toBe('demo')
		expect(server.version).toBe('2.0.0')
	})

	it('dispatches over the supplied tool registry', async () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
		const server = createMCPServer({ name: 'demo', version: '1.0.0', tools })

		const response = await server.dispatch({
			jsonrpc: '2.0',
			method: 'tools/call',
			id: 1,
			params: { name: 'add', arguments: { x: 4, y: 6 } },
		})

		expect(response?.result).toEqual({ content: [{ type: 'text', text: '10' }] })
	})

	it('wires the on hooks (the §8 reserved key) to the emitter', async () => {
		const seen: (readonly [string, string | number | null])[] = []
		const server = createMCPServer({
			name: 'demo',
			version: '1.0.0',
			tools: createToolManager(),
			on: { request: (method, id) => seen.push([method, id]) },
		})

		await server.dispatch({ jsonrpc: '2.0', method: 'ping', id: 1 })

		expect(seen).toEqual([['ping', 1]])
	})
})
