import { describe, expect, it } from 'vitest'
import { inferEra } from '@src/core'

describe('inferEra', () => {
	it('classifies the modern revision', () => {
		expect(inferEra('2026-07-28')).toBe('modern')
	})

	it('classifies both supported legacy revisions', () => {
		expect(inferEra('2025-11-25')).toBe('legacy')
		expect(inferEra('2025-06-18')).toBe('legacy')
	})

	it('returns undefined for removed and unknown revisions', () => {
		expect(inferEra('2025-03-26')).toBeUndefined()
		expect(inferEra('2024-11-05')).toBeUndefined()
	})
})
