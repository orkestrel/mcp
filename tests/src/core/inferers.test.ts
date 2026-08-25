import { describe, expect, it } from 'vitest'
import {
	inferEra,
	inferVersion,
	SUPPORTED_LEGACY_PROTOCOL_VERSIONS,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@src/core'

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

	// The rows above pin the literal revisions; this one pins the era of whatever each set
	// holds, so a revision added to a set without an era reads as a failure here rather than
	// as a silently unclassified revision at every call site.
	it('gives every member of each supported set the era of that set', () => {
		expect(SUPPORTED_PROTOCOL_VERSIONS.map((version) => inferEra(version))).toEqual(
			SUPPORTED_PROTOCOL_VERSIONS.map(() => 'modern'),
		)
		expect(SUPPORTED_LEGACY_PROTOCOL_VERSIONS.map((version) => inferEra(version))).toEqual(
			SUPPORTED_LEGACY_PROTOCOL_VERSIONS.map(() => 'legacy'),
		)
		expect(SUPPORTED_PROTOCOL_VERSIONS.length).toBeGreaterThan(0)
		expect(SUPPORTED_LEGACY_PROTOCOL_VERSIONS.length).toBeGreaterThan(0)
		expect(inferEra('2020-01-01')).toBeUndefined()
	})
})

describe('inferVersion', () => {
	it('selects the supported modern revision without selecting a legacy offer', () => {
		expect(inferVersion(['2025-06-18', 'future', '2026-07-28'])).toBe('2026-07-28')
		expect(inferVersion(['2025-06-18', '2025-11-25'])).toBeUndefined()
	})

	it('returns undefined when no offered revision is supported', () => {
		expect(inferVersion(['2025-03-26', 'future'])).toBeUndefined()
	})
})
