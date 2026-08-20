import { createMCPClient } from '@orkestrel/mcp'
import { createStdioClientTransport } from '@orkestrel/mcp/server'

async function drive(label, options) {
	const client = createMCPClient({
		transport: createStdioClientTransport({ command: process.execPath, args: ['server2.mjs'] }),
		identity: { name: 'drive-client', version: '1.0.0' },
		...options,
	})
	try {
		await client.connect()
		const names = (await client.tools()).map((tool) => tool.name)
		const outcome = await client.call('echo', { value: 'ping' })
		console.log(`[${label}] negotiated=${client.version} tools=${JSON.stringify(names)} call=${outcome.resultType}:${JSON.stringify(outcome.value)}`)
	} catch (error) {
		console.log(`[${label}] FAILED: ${error && error.message ? error.message : String(error)}`)
	} finally {
		try { await client.disconnect() } catch {}
	}
}

await drive('legacy-wrapped unpinned no-timeout', {})
await drive('legacy-wrapped unpinned timeout 15s', { timeout: 15_000 })
await drive('legacy-wrapped pin 2026-07-28 no-timeout', { version: '2026-07-28' })
await drive('legacy-wrapped pin 2026-07-28 timeout 15s', { version: '2026-07-28', timeout: 15_000 })
await drive('legacy-wrapped pin 2025-11-25', { version: '2025-11-25', timeout: 15_000 })
await drive('legacy-wrapped pin 2025-06-18', { version: '2025-06-18', timeout: 15_000 })
await drive('control bogus 2020-01-01', { version: '2020-01-01', timeout: 15_000 })
console.log('done')
