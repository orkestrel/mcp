import type {
	MCPRequestFunction,
	MCPTaskClientInterface,
	MCPTaskClientOptions,
	MCPTaskDetail,
} from './types.js'
import { JSONRPC_INVALID_PARAMS } from './constants.js'
import { MCPError } from './errors.js'
import { isMCPTaskDetail } from './validators.js'

/**
 * The CLIENT half of the draft Tasks extension — the `tasks/*` methods over one
 * correlated-request door, exposed as an {@link import('./types.js').MCPClientInterface}'s
 * `tasks`.
 *
 * @remarks
 * - **The mirror of the server-side port, minus `start`.** An
 *   {@link import('./types.js').MCPTaskManagerInterface} is the consumer's durable store the
 *   SERVER creates tasks in; this is the client's read/answer/stop access to the tasks a peer
 *   already created. Creation is missing on purpose: the extension gives a client no flag and
 *   no parameter to ask for a task, so `start` has no wire method to be.
 * - **No plural accessor, no loop, no cache.** MCP defines no `tasks/list`, so nothing here
 *   enumerates. A task snapshot's `pollIntervalMs` is carried untouched and a one-shot read
 *   sits beside it; the SCHEDULE is the consumer's, because this package has no durable place
 *   to keep a task, no idea when the application still cares, and no lifetime to hang a timer
 *   on that outlives the request it was born from. An instance left alone writes nothing.
 * - **One channel.** Every request goes through the injected
 *   {@link import('./types.js').MCPRequestFunction}, so a task read shares the issuing
 *   client's id space, pending table, deadline policy, and `disconnect` drain rather than
 *   opening a second path to the same peer.
 * - **The peer authorizes.** Nothing is checked locally. A server that never configured the
 *   extension answers each of them `-32601`, and a task that never existed, one whose TTL purged
 *   it, and one belonging to another principal are all the same `-32602` — a refusal this
 *   client passes on rather than resolving into a distinction the peer refused to publish.
 *
 * @example
 * ```ts
 * const outcome = await client.call('render', { page: 3 })
 * if (outcome.resultType === 'task') {
 * 	// `outcome.pollIntervalMs` is the peer's HINT — the schedule is yours to run.
 * 	const detail = await client.tasks.task(outcome.taskId)
 * 	if (detail.status === 'input_required') await client.tasks.update(outcome.taskId, { ok: true })
 * 	else if (detail.status === 'working') await client.tasks.abort(outcome.taskId)
 * }
 * ```
 */
export class MCPTaskClient implements MCPTaskClientInterface {
	readonly #request: MCPRequestFunction
	readonly #timeout: number | undefined

	constructor(options: MCPTaskClientOptions) {
		this.#request = options.request
		this.#timeout = options.timeout
	}

	async task(id: string): Promise<MCPTaskDetail> {
		const result = await this.#request('tasks/get', { taskId: id }, this.#timeout)
		// PROVEN, not assumed. The peer is the untrusted half here exactly as a consumer's
		// manager is on the server side, and the same guard the server proves its answer with
		// before writing it proves this one before a caller narrows on `status`. A snapshot that
		// does not hold together is refused with the code a malformed payload earns, not passed
		// on as a task whose `status` a caller would then switch over.
		if (!isMCPTaskDetail(result)) {
			throw new MCPError('MCP server returned an invalid task', JSONRPC_INVALID_PARAMS)
		}
		return result
	}

	async update(id: string, responses: Readonly<Record<string, unknown>>): Promise<void> {
		// `inputResponses` is the WIRE spelling, carried verbatim from the extension's schema;
		// the record inside it is the caller's and travels unread, because which keys a task
		// published is the task's own knowledge and this client holds none of it.
		await this.#request('tasks/update', { taskId: id, inputResponses: responses }, this.#timeout)
	}

	async abort(id: string): Promise<void> {
		// `tasks/cancel` is the protocol's spelling of this package's `abort`, and the ask is
		// ADVISORY: the acknowledgement this awaits reports that the request was accepted, never
		// that the task stopped. Nothing is returned because there is nothing true to return.
		await this.#request('tasks/cancel', { taskId: id }, this.#timeout)
	}
}
