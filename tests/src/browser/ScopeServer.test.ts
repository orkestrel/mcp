import { ScopeServer } from '@src/browser'
import { waitForCondition, waitForDelay } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import { modernRequest } from '../../setup.js'
import {
	buildScopeDiscoveryReply,
	createCalculatorTools,
	createScopeDouble,
} from '../../setupBrowser.js'

describe('ScopeServer', () => {
	it('binds a repeatedly delivered port once and replies once to each request', async () => {
		const fixture = createScopeDouble()
		const tools = createCalculatorTools()
		const accepted: MessageEvent[] = []
		const server = new ScopeServer(
			{ tools, accept: (event) => accepted.push(event) > 0 },
			fixture.scope,
		)
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()
		try {
			fixture.dispatch({ ports: [port1] })
			fixture.dispatch({ ports: [port1] })
			port2.postMessage(JSON.stringify(modernRequest('server/discover', 1)))
			port2.postMessage(JSON.stringify(modernRequest('server/discover', 2)))
			await waitForCondition('The scope answers both requests', () => replies.length >= 2)
			await waitForDelay()
			expect(accepted).toHaveLength(2)
			expect(replies.map((reply) => JSON.parse(String(reply)))).toEqual([
				buildScopeDiscoveryReply(1),
				buildScopeDiscoveryReply(2),
			])
		} finally {
			server.stop()
			port2.close()
			tools.destroy()
		}
	})

	it('owns and releases its scope listener once', () => {
		const fixture = createScopeDouble()
		const tools = createCalculatorTools()
		const server = new ScopeServer({ tools }, fixture.scope)
		try {
			expect(fixture.listenerCount).toBe(1)
			server.stop()
			expect(fixture.listenerCount).toBe(0)
			server.stop()
			expect(fixture.listenerCount).toBe(0)
		} finally {
			server.stop()
			tools.destroy()
		}
	})
})
