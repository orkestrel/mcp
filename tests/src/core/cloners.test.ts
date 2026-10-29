import { MCP_CLONE_LIMITS } from '../../setup.js'
import { snapshotJSON, snapshotToolResult } from '@src/core'
import { describe, expect, it } from 'vitest'
import { MCPFixtureCell } from '../../setup.js'

describe('snapshotJSON', () => {
	it('returns one frozen owned value paired with its canonical text', () => {
		const source = { beta: [2], alpha: { enabled: true } }
		const snapshot = snapshotJSON(source, MCP_CLONE_LIMITS)
		source.alpha.enabled = false

		expect(snapshot).toEqual([
			{ alpha: { enabled: true }, beta: [2] },
			'{"alpha":{"enabled":true},"beta":[2]}',
		])
		expect(Object.isFrozen(snapshot)).toBe(true)
		expect(Object.isFrozen(snapshot?.[0])).toBe(true)
	})

	it('rejects unsafe and out-of-bound values without observing accessors', () => {
		const reads = new MCPFixtureCell(0)
		const accessor = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				reads.value += 1
				return true
			},
		})
		const cycle: Record<string, unknown> = {}
		cycle['self'] = cycle

		expect(snapshotJSON(accessor, MCP_CLONE_LIMITS)).toBeUndefined()
		expect(snapshotJSON(cycle, MCP_CLONE_LIMITS)).toBeUndefined()
		expect(snapshotJSON({ value: 'large' }, { ...MCP_CLONE_LIMITS, bytes: 4 })).toBeUndefined()
		expect(reads.value).toBe(0)
	})
})

describe('snapshotToolResult', () => {
	it('owns successful, value-less, and failed Tool results exactly', () => {
		const value = { count: 1 }
		const success = snapshotToolResult(
			{ id: 'one', name: 'probe', success: true, value },
			MCP_CLONE_LIMITS,
		)
		value.count = 2

		expect(success).toEqual([
			{ id: 'one', name: 'probe', success: true, value: { count: 1 } },
			'{"count":1}',
		])
		expect(
			snapshotToolResult(
				{ id: 'two', name: 'noop', success: true, value: undefined },
				MCP_CLONE_LIMITS,
			),
		).toEqual([{ id: 'two', name: 'noop', success: true, value: undefined }, undefined])
		expect(
			snapshotToolResult(
				{ id: 'three', name: 'fail', success: false, error: 'broken' },
				MCP_CLONE_LIMITS,
			),
		).toEqual([{ id: 'three', name: 'fail', success: false, error: 'broken' }, undefined])
	})

	it('rejects extra, missing, accessor, and oversized Tool results', () => {
		const accessor = Object.defineProperty({ id: 'one', name: 'probe', success: true }, 'value', {
			enumerable: true,
			get: () => 1,
		})
		for (const value of [
			{ id: 'one', name: 'probe', success: true },
			{ id: 'one', name: 'probe', success: true, value: 1, extra: true },
			{ id: 'one', name: 'probe', success: false, error: 7 },
			accessor,
		]) {
			expect(snapshotToolResult(value, MCP_CLONE_LIMITS)).toBeUndefined()
		}
		expect(
			snapshotToolResult(
				{ id: 'one', name: 'probe', success: true, value: 'large' },
				{ ...MCP_CLONE_LIMITS, bytes: 4 },
			),
		).toBeUndefined()
	})
})
