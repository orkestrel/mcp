import { snapshotJSON, snapshotToolResult } from '@src/core'
import { describe, expect, it } from 'vitest'

const LIMITS = Object.freeze({ bytes: 256, keys: 8, depth: 4 })

describe('snapshotJSON', () => {
	it('returns one frozen owned value paired with its canonical text', () => {
		const source = { beta: [2], alpha: { enabled: true } }
		const snapshot = snapshotJSON(source, LIMITS)
		source.alpha.enabled = false

		expect(snapshot).toEqual([
			{ alpha: { enabled: true }, beta: [2] },
			'{"alpha":{"enabled":true},"beta":[2]}',
		])
		expect(Object.isFrozen(snapshot)).toBe(true)
		expect(Object.isFrozen(snapshot?.[0])).toBe(true)
	})

	it('rejects unsafe and out-of-bound values without observing accessors', () => {
		let reads = 0
		const accessor = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				reads += 1
				return true
			},
		})
		const cycle: Record<string, unknown> = {}
		cycle['self'] = cycle

		expect(snapshotJSON(accessor, LIMITS)).toBeUndefined()
		expect(snapshotJSON(cycle, LIMITS)).toBeUndefined()
		expect(snapshotJSON({ value: 'large' }, { ...LIMITS, bytes: 4 })).toBeUndefined()
		expect(reads).toBe(0)
	})
})

describe('snapshotToolResult', () => {
	it('owns successful, value-less, and failed Tool results exactly', () => {
		const value = { count: 1 }
		const success = snapshotToolResult({ id: 'one', name: 'probe', success: true, value }, LIMITS)
		value.count = 2

		expect(success).toEqual([
			{ id: 'one', name: 'probe', success: true, value: { count: 1 } },
			'{"count":1}',
		])
		expect(
			snapshotToolResult({ id: 'two', name: 'noop', success: true, value: undefined }, LIMITS),
		).toEqual([{ id: 'two', name: 'noop', success: true, value: undefined }, undefined])
		expect(
			snapshotToolResult({ id: 'three', name: 'fail', success: false, error: 'broken' }, LIMITS),
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
			expect(snapshotToolResult(value, LIMITS)).toBeUndefined()
		}
		expect(
			snapshotToolResult(
				{ id: 'one', name: 'probe', success: true, value: 'large' },
				{ ...LIMITS, bytes: 4 },
			),
		).toBeUndefined()
	})
})
