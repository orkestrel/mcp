import type { ServeMCPOptions, ServeMCPScopeInterface } from './types.js'
import { bindServer, createMCPServer } from '@src/core'
import { DEFAULT_MCP_SERVER_NAME, DEFAULT_MCP_SERVER_VERSION } from './constants.js'
import { createScopeTransport } from './factories.js'
import { createScopeMessageListener } from './helpers.js'

// The `serveWorker` analog (PROPOSAL §3.3.4): boot an `MCPServer` inside a hostable
// scope and wire its message events to it. `serveMCP(options)` is a one-liner over
// `globalThis`; `serveMCPScope(scope, options)` is the testable core — it takes the
// scope as a parameter so a test drives it with a scope double instead of the real
// `globalThis`.
//
// UNIFIED dedicated-worker / Service-Worker wiring, no upfront detection flag: a
// dedicated worker's implicit channel (no port) and a Service Worker's per-client
// `MessagePort` are structurally distinguishable PER EVENT (`event.ports.length`),
// so ONE `message` listener handles both shapes uniformly — an event carrying a port
// spawns a per-port `MessagePortTransport` binding (multi-client); an event with no
// port but a string `data` routes through the implicit scope channel. Per AGENTS §3.3.4,
// this face imports project code freely (`@src/core` bundles into the worker) — the
// inlined-guards exception `node:worker_threads`' type-stripping forces on the Node
// face's `serve.ts` (`@orkestrel/worker`) does NOT apply here and is not copied.

/**
 * Boot an `MCPServer` inside a hostable scope (a dedicated Web Worker's `self`, or a
 * Service Worker's `self`) and wire its message events to it.
 *
 * @remarks
 * Binds the implicit scope channel EAGERLY (at call time, not lazily on first use) —
 * `bindServer` is called once against a {@link import('./types.js').ScopeTransportInterface}
 * wrapping `scope` for the whole lifetime of the returned dispose, so a dedicated
 * worker's very first portless message is served with no first-use setup cost or
 * ordering hazard. A Service-Worker-shaped scope simply never posts a portless
 * message (every client connects via its own `MessagePort`), so the eagerly-bound
 * implicit channel sits idle and harmless in that shape.
 *
 * Every inbound `message` event is inspected structurally: `event.ports.length > 0`
 * spawns a fresh {@link import('./factories.js').createMessagePortTransport} +
 * `bindServer` for THAT port (tracked for teardown) — this holds even on a
 * dedicated-worker-shaped scope, the unified design's deliberate cross-case. An
 * event with NO ports and a STRING `event.data` is delivered onto the implicit scope
 * channel; any other event (no ports, non-string data) is dropped.
 *
 * @param scope - The hostable scope to wire (structurally, `self` inside a worker)
 * @param options - `tools` (the live registry to expose; REQUIRED), optional
 *   `name`/`version` (default {@link import('./constants.js').DEFAULT_MCP_SERVER_NAME} /
 *   {@link import('./constants.js').DEFAULT_MCP_SERVER_VERSION}); see
 *   {@link ServeMCPOptions}
 * @returns A dispose function — unbinds every binding, closes every accepted
 *   `MessagePort`, and removes the scope's `message` listener. Idempotent.
 *
 * @example
 * ```ts
 * const { port1, port2 } = new MessageChannel()
 * const scope = { postMessage() {}, addEventListener() {}, removeEventListener() {} }
 * const dispose = serveMCPScope(scope, { tools: createToolManager() })
 * // ... later:
 * dispose()
 * ```
 */
export function serveMCPScope(scope: ServeMCPScopeInterface, options: ServeMCPOptions): () => void {
	const server = createMCPServer({
		tools: options.tools,
		name: options.name ?? DEFAULT_MCP_SERVER_NAME,
		version: options.version ?? DEFAULT_MCP_SERVER_VERSION,
	})
	const scopeTransport = createScopeTransport(scope)
	const unbindScope = bindServer(server, scopeTransport)
	const teardowns = new Set<() => void>()
	const onMessage = createScopeMessageListener(server, scopeTransport, teardowns)
	scope.addEventListener('message', onMessage)
	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		scope.removeEventListener('message', onMessage)
		unbindScope()
		for (const teardown of teardowns) teardown()
		teardowns.clear()
	}
}

/**
 * Boot an `MCPServer` inside the CURRENT hostable scope (`globalThis` — a dedicated
 * Web Worker or a Service Worker) and wire its message events to it.
 *
 * @remarks
 * A one-liner over {@link serveMCPScope}: `serveMCP(options)` is exactly
 * `serveMCPScope(globalThis, options)`. Kept as its own export so the scope-facing
 * wiring stays independently testable (AGENTS §5) — drive {@link serveMCPScope}
 * directly with a scope double for a test, and this thin wrapper for real deploys.
 *
 * @param options - `tools` (the live registry to expose; REQUIRED), optional
 *   `name`/`version`; see {@link ServeMCPOptions}
 * @returns A dispose function — see {@link serveMCPScope}
 *
 * @example
 * ```ts
 * // Inside a dedicated Web Worker's entry module:
 * import { serveMCP } from '@orkestrel/mcp/browser'
 * import { createToolManager, createTool } from '@orkestrel/agent'
 *
 * const tools = createToolManager()
 * tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
 * const dispose = serveMCP({ tools, name: 'worker-mcp', version: '1.0.0' })
 * // ... later, on teardown:
 * dispose()
 * ```
 */
export function serveMCP(options: ServeMCPOptions): () => void {
	return serveMCPScope(globalThis, options)
}
