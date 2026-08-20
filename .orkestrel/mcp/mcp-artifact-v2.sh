#!/bin/bash
# Mcp artifact proof v2, 2026-08-20, tree 40b5368: pack, scratch install, dual-format load of the
# root, server, and browser entries, one real handle round trip through an installed server,
# sourcemap sources dump, inventory sweep.
set -u
S=/tmp/claude-0/-home-user/c32a4fba-a43a-5868-8bb6-99eb4bc6d839/scratchpad
REPO=/home/user/mcp
C="$S/mcp-consumer"
OUT="$S/mcp-artifact-v2.log"
: > "$OUT"

cd "$REPO" || exit 1
npm run build >> "$OUT" 2>&1; echo "build exit: $?" >> "$OUT"
mkdir -p tmp/pack
npm pack --pack-destination tmp/pack >> "$OUT" 2>&1; echo "pack exit: $?" >> "$OUT"
T="$(ls -t tmp/pack/orkestrel-mcp-*.tgz | head -1)"
echo "tarball: $T" >> "$OUT"

tar -tzf "$T" > "$S/mcp-tar-list.txt"
grep -E "\.env|npmrc|auth\.|token|secret|/tmp/|home/user" "$S/mcp-tar-list.txt" >> "$OUT" && echo "INVENTORY HIT" >> "$OUT" || echo "inventory: clean" >> "$OUT"
rm -rf "$S/mcp-tar-x"; mkdir -p "$S/mcp-tar-x"; tar -xzf "$T" -C "$S/mcp-tar-x"
grep -rl "home/user" "$S/mcp-tar-x/package/dist" >> "$OUT" 2>/dev/null && echo "HOST PATH IN DIST" >> "$OUT" || echo "map sources: no host path" >> "$OUT"
find "$S/mcp-tar-x/package/dist" -name "*.map" | head -8 >> "$OUT"

rm -rf "$C"; mkdir -p "$C"; cd "$C" || exit 1
npm init -y > /dev/null 2>&1
npm install "$REPO/$T" >> "$OUT" 2>&1; echo "install exit: $?" >> "$OUT"

cat > round-trip.mjs <<'EOF'
import { createMCPServer, createMCPLegacy, createToolManager } from '@orkestrel/mcp'
const tools = createToolManager()
const mcp = createMCPLegacy(
	createMCPServer({ identity: { name: 'artifact-proof', version: '1.0.0' }, tools }),
)
const reply = await mcp.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proof', version: '1.0.0' } } })
console.log('initialize ok:', reply?.result?.protocolVersion ?? JSON.stringify(reply))
const listing = await mcp.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
console.log('tools/list carries result or error:', 'result' in (listing ?? {}) || 'error' in (listing ?? {}))
EOF
node round-trip.mjs >> "$OUT" 2>&1; echo "round-trip exit: $?" >> "$OUT"

cat > load-cjs.cjs <<'EOF'
const root = require('@orkestrel/mcp')
const server = require('@orkestrel/mcp/server')
console.log('cjs root createMCPServer:', typeof root.createMCPServer === 'function')
console.log('cjs server createMCPRoutes:', typeof server.createMCPRoutes === 'function')
EOF
node load-cjs.cjs >> "$OUT" 2>&1; echo "cjs exit: $?" >> "$OUT"

cat > load-browser.mjs <<'EOF'
const browser = await import('@orkestrel/mcp/browser')
console.log('browser entry keys sample:', Object.keys(browser).length > 0)
EOF
node load-browser.mjs >> "$OUT" 2>&1; echo "browser load exit: $?" >> "$OUT"

echo "done" >> "$OUT"
tail -20 "$OUT"
