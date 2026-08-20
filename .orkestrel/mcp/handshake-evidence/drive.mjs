import { createMCPClient } from '@orkestrel/mcp'
import { createStdioClientTransport } from '@orkestrel/mcp/server'

async function drive(label, version) {
	const client = createMCPClient({
		transport: createStdioClientTransport({ command: process.execPath, args: ['server.mjs'] }),
		identity: { name: 'drive-client', version: '1.0.0' },
		timeout: 15_000,
		...(version === undefined ? {} : { version }),
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

await drive('unpinned', undefined)
await drive('pin 2026-07-28', '2026-07-28')
await drive('pin 2025-11-25', '2025-11-25')
await drive('pin 2025-06-18', '2025-06-18')
await drive('control bogus 2020-01-01', '2020-01-01')
console.log('done')
