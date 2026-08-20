import { createMCPClient } from '@orkestrel/mcp'
import { createStdioClientTransport } from '@orkestrel/mcp/server'
const client = createMCPClient({
	transport: createStdioClientTransport({ command: process.execPath, args: ['server.mjs'] }),
	identity: { name: 'drive-client', version: '1.0.0' },
})
try {
	await client.connect()
	console.log(`no-timeout unpinned negotiated=${client.version}`)
} catch (error) {
	console.log(`no-timeout unpinned FAILED: ${error && error.message ? error.message : String(error)}`)
} finally {
	try { await client.disconnect() } catch {}
}
