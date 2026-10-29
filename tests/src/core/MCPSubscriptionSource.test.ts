import { describe, expect, it } from 'vitest'
import { createToolManager } from '@orkestrel/tool'
import { DEFAULT_MCP_LIMITS, MCPSubscriptionSource } from '@src/core'
import { createSilentSource } from '../../setup.js'

describe('MCPSubscriptionSource', () => {
	it('ends when its producer ends and no registry family keeps it open', async () => {
		const lifetime = new AbortController()
		const source = new MCPSubscriptionSource(
			{
				identity: { name: 'source', version: '1' },
				tools: createToolManager(),
				subscription: { notifications: {}, producer: createSilentSource },
			},
			{},
			{ signal: lifetime.signal },
			DEFAULT_MCP_LIMITS,
		)
		try {
			expect(await source.stream.getReader().read()).toEqual({ done: true, value: undefined })
			expect(() => source.finish()).not.toThrow()
		} finally {
			lifetime.abort()
		}
	})
})
