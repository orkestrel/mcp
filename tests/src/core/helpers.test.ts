import type { ToolResult } from '@orkestrel/agent'
import {
	buildToolDescriptors,
	buildToolResult,
	initializeResult,
	jsonRPCError,
	jsonRPCResult,
	MCP_PROTOCOL_VERSION,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/agent'

// The pure dispatch builders (AGENTS §5 — exported, independently testable). Each
// turns a piece of MCP state into the JSON-RPC result payload (or envelope) the
// server returns.

describe('jsonRPCResult', () => {
	it('builds a success envelope echoing the id', () => {
		expect(jsonRPCResult(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
	})

	it('carries a null id (a parse / invalid-request error)', () => {
		expect(jsonRPCResult(null, {})).toEqual({ jsonrpc: '2.0', id: null, result: {} })
	})
})

describe('jsonRPCError', () => {
	it('builds an error envelope without data when none is given', () => {
		expect(jsonRPCError(1, -32601, 'Method not found')).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32601, message: 'Method not found' },
		})
	})

	it('includes data when supplied', () => {
		expect(jsonRPCError(1, -32000, 'Server error', { detail: 'x' })).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32000, message: 'Server error', data: { detail: 'x' } },
		})
	})
})

describe('buildToolDescriptors', () => {
	it('maps definitions, renaming parameters to inputSchema', () => {
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'sum',
				description: 'Add',
				parameters: { type: 'object', properties: { a: { type: 'number' } } },
				execute: () => 0,
			}),
		)

		expect(buildToolDescriptors(manager)).toEqual([
			{
				name: 'sum',
				description: 'Add',
				inputSchema: { type: 'object', properties: { a: { type: 'number' } } },
			},
		])
	})

	it('defaults inputSchema to an empty object schema when a tool declares none', () => {
		const manager = createToolManager()
		manager.add(createTool({ name: 'echo', execute: () => 0 }))

		expect(buildToolDescriptors(manager)).toEqual([
			{ name: 'echo', inputSchema: { type: 'object' } },
		])
	})

	it('returns an empty list for an empty registry', () => {
		expect(buildToolDescriptors(createToolManager())).toEqual([])
	})
})

describe('buildToolResult', () => {
	it('serializes a value into one text content block', () => {
		const result: ToolResult = { id: '1', name: 'sum', value: 7 }

		expect(buildToolResult(result)).toEqual({ content: [{ type: 'text', text: '7' }] })
	})

	it('serializes a structured value as JSON', () => {
		const result: ToolResult = { id: '1', name: 'echo', value: { a: 1 } }

		expect(buildToolResult(result)).toEqual({
			content: [{ type: 'text', text: JSON.stringify({ a: 1 }) }],
		})
	})

	it('maps a value-less result to an EMPTY text block (a content block must carry a string text)', () => {
		const result: ToolResult = { id: '1', name: 'noop' }

		expect(buildToolResult(result)).toEqual({ content: [{ type: 'text', text: '' }] })
	})

	it('maps an error result to an isError content block', () => {
		const result: ToolResult = { id: '1', name: 'boom', error: 'kaboom' }

		expect(buildToolResult(result)).toEqual({
			content: [{ type: 'text', text: 'kaboom' }],
			isError: true,
		})
	})
})

describe('initializeResult', () => {
	it('uses the default protocol version when none requested', () => {
		expect(initializeResult('s', '1.0.0')).toEqual({
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: 's', version: '1.0.0' },
		})
	})

	it('echoes a supported requested version', () => {
		expect(initializeResult('s', '1.0.0', '2025-03-26')['protocolVersion']).toBe('2025-03-26')
	})

	it('falls back to the default for an unsupported requested version', () => {
		expect(initializeResult('s', '1.0.0', '1999-01-01')['protocolVersion']).toBe(
			MCP_PROTOCOL_VERSION,
		)
	})
})
