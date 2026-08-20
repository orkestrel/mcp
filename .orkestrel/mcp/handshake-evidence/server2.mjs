import { createMCPServer, createMCPLegacy } from '@orkestrel/mcp'
import { createStdioServer } from '@orkestrel/mcp/server'
import { createToolManager, createTool } from '@orkestrel/tool'
const tools = createToolManager()
tools.add(createTool({ name: 'echo', execute: (args) => args.value }))
const mcp = createMCPServer({ identity: { name: 'drive-fixture', version: '1.0.0' }, tools })
createStdioServer(createMCPLegacy(mcp)).start()
