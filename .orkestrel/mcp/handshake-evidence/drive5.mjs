import { createMCPClient } from '@orkestrel/mcp'
import { createStdioClientTransport } from '@orkestrel/mcp/server'
async function drive(label, options) {
	const client = createMCPClient({
		transport: createStdioClientTransport({ command: process.execPath, args: ['server3.mjs'] }),
		identity: { name: 'drive-client', version: '1.0.0' },
		...options,
	})
	try {
		await client.connect()
		const outcome = await client.call('echo', { value: 'ping' })
		console.log(`[double-wrap ${label}] negotiated=${client.version} call=${outcome.resultType}:${JSON.stringify(outcome.value)}`)
	} catch (error) {
		console.log(`[double-wrap ${label}] FAILED: ${error && error.message ? error.message : String(error)}`)
	} finally {
		try { await client.disconnect() } catch {}
	}
}
await drive('unpinned no-timeout', {})
await drive('pin 2025-06-18', { version: '2025-06-18', timeout: 15_000 })
