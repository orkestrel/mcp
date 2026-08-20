#!/bin/sh
set -x
SCRATCH=/tmp/claude-0/-home-user/c32a4fba-a43a-5868-8bb6-99eb4bc6d839/scratchpad
DIR=$SCRATCH/mcp-drive
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR" || exit 1
npm pack /home/user/mcp --ignore-scripts --silent
npm init -y > /dev/null
npm pkg set type=module
npm install ./orkestrel-mcp-0.0.19.tgz --no-audit --no-fund 2>&1 | tail -2

cat > server.mjs <<'EOF'
import { createMCPServer } from '@orkestrel/mcp'
import { createStdioServer } from '@orkestrel/mcp/server'
import { createToolManager, createTool } from '@orkestrel/tool'
const tools = createToolManager()
tools.add(createTool({ name: 'echo', execute: (args) => args.value }))
const mcp = createMCPServer({ identity: { name: 'drive-fixture', version: '1.0.0' }, tools })
createStdioServer(mcp).start()
EOF

cat > drive.mjs <<'EOF'
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
EOF

node drive.mjs
echo "drive exit: $?"
