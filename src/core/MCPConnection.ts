import type { ContractInterface } from '@orkestrel/contract'
import type { MCPListedTool, MCPMessageTransportInterface, MCPModernVersion } from './types.js'
import { JSONRPC_INVALID_PARAMS } from '@orkestrel/jsonrpc'
import { attempt, createContract, isRecord, schemaToShape } from '@orkestrel/contract'
import { MCPError } from './errors.js'

/**
 * Owns one negotiation, the close still owed for the transport it opened, and the output
 * schemas its latest tool listing declared.
 */
export class MCPConnection {
	readonly #transport: MCPMessageTransportInterface
	readonly #negotiation: Promise<void>
	readonly #closings = new Set<Promise<void>>()
	readonly #contracts = new WeakMap<object, ContractInterface<unknown>>()
	#outputs: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map()
	#version: MCPModernVersion | undefined
	#settled = false
	#superseded = false
	#claimed = false
	#closed = false

	constructor(
		transport: MCPMessageTransportInterface,
		negotiate: (connection: MCPConnection) => Promise<void>,
	) {
		this.#transport = transport
		this.#negotiation = Promise.resolve().then(() => negotiate(this))
		void this.#negotiation.then(
			() => this.#settle(),
			() => this.#settle(),
		)
	}

	get negotiation(): Promise<void> {
		return this.#negotiation
	}

	get version(): MCPModernVersion | undefined {
		return this.#version
	}

	get connected(): boolean {
		return this.#version !== undefined
	}

	get settled(): boolean {
		return this.#settled
	}

	get superseded(): boolean {
		return this.#superseded
	}

	get owed(): boolean {
		return this.#claimed && !this.#closed
	}

	claim(): void {
		this.#claimed = true
	}

	accept(version: MCPModernVersion): void {
		this.#version = version
	}

	supersede(): void {
		this.#superseded = true
		this.#version = undefined
	}

	release(): void {
		this.supersede()
		this.#closed = true
	}

	// One complete listing replaces the last, so a tool it no longer declares an output for is
	// checked against nothing. A fresh schema object is a fresh memo key, so no contract goes stale.
	adopt(tools: readonly MCPListedTool[]): void {
		this.#outputs = new Map(
			tools.flatMap((tool): ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> => {
				const schema = tool['outputSchema']
				return isRecord(schema) ? [[tool.name, schema]] : []
			}),
		)
	}

	// Compiled on the first call of the tool that declares it, because a listing can be long and
	// most of its tools are never called. A foreign schema that cannot compile fails at use.
	output(name: string): ContractInterface<unknown> | undefined {
		const schema = this.#outputs.get(name)
		if (schema === undefined) return undefined
		const known = this.#contracts.get(schema)
		if (known !== undefined) return known
		const compiled = attempt(() => createContract(schemaToShape(schema)))
		if (!compiled.success) {
			throw new MCPError(
				`MCP tool '${name}' declares an outputSchema this client cannot compile, so its answer cannot be checked; the server must declare a JSON Schema built from plain values`,
				JSONRPC_INVALID_PARAMS,
			)
		}
		this.#contracts.set(schema, compiled.value)
		return compiled.value
	}

	async close(): Promise<void> {
		const [running] = this.#closings
		if (running !== undefined) return await running
		const closing = this.#transport.close()
		this.#closings.add(closing)
		try {
			await closing
			this.#closed = true
		} finally {
			this.#closings.delete(closing)
		}
	}

	#settle(): void {
		this.#settled = true
	}
}
