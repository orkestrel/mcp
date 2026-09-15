// The scripted model both halves of the distribution composition receipts drive — the page's
// agent and the consumer's relay upstream. It is copied beside each of those fixtures, so one
// authored file is what each side runs: a page and the consumer's Node process share no module
// graph, and a twin written once per side is a twin that drifts.
//
// It stands for the model and for nothing else. Every agent, tool, MCP, and relay path the
// receipts drive is the installed artifact running for real; this supplies the turns neither
// side can obtain offline.
//
// The scripted turns themselves are authored here for the same reason. The relay's upstream
// answers on the Node side and the page's own provider answers in the browser, and the receipt
// compares one against the other, so the tool, the argument, and the answer are read from here
// by each side rather than written down twice.

// The tool the scripted turn calls.
export const TOOL = 'paint'

// The argument that call carries, which the page tool writes into the document.
export const NOTE = 'kyoto'

// The content the answering turn carries after the tool result comes back.
export const ANSWER = 'the note is recorded'

/**
 * Builds the deltas one scripted turn streams before its assembled result.
 *
 * @param answer - The turn the script holds
 * @returns One content delta, or nothing for a turn that answers with a tool call alone
 */
export function buildDeltas(answer) {
	return answer.content === '' ? [] : [{ channel: 'content', text: answer.content }]
}

/**
 * Builds one scripted turn.
 *
 * @param content - The content the turn answers with. An empty string is a turn that answers
 *   with its call alone.
 * @param call - The call the turn makes, written as its own `index` within the run, the `name`
 *   of the tool it calls, and the `arguments` it carries. Omit it for a turn that calls nothing.
 * @returns The turn, in the shape a provider result takes
 */
export function buildTurn(content, call) {
	if (call === undefined) return { content }
	const identified = {
		id: `call-${String(call.index)}`,
		name: call.name,
		arguments: call.arguments,
	}
	return { content, tools: [identified] }
}

/**
 * Builds the script an agent receipt runs: one tool call, then the answer that follows its
 * result.
 *
 * @param name - The tool the first turn calls
 * @param args - The arguments that call carries
 * @param answer - The content the second turn answers with
 * @returns The turns, in the order the agent reads them
 */
export function buildScript(name, args, answer) {
	return [buildTurn('', { index: 1, name, arguments: args }), buildTurn(answer)]
}

/**
 * Composes the script both sides of the paint composition run: one call on `TOOL` carrying
 * `NOTE`, then the turn answering with `ANSWER`. Composed once here so the page's agent and the
 * relay's upstream run the same script rather than each assembling their own copy of it.
 */
export const PAINT_SCRIPT = buildScript(TOOL, { note: NOTE }, ANSWER)

/**
 * Answers each turn from a fixed script. One provider call is one turn, which is what a request
 * count is read against. The agent drives `stream`, so each turn streams its text and returns
 * the assembled result the loop reads.
 */
export class ScriptedProvider {
	#script
	#turn = 0

	/**
	 * @param id - Identifies this provider to the agent or relay holding it
	 * @param script - The turns to answer with, in order
	 */
	constructor(id, script) {
		this.id = id
		this.name = 'scripted'
		this.#script = script
	}

	/**
	 * Answers the next turn whole.
	 *
	 * @returns The turn the script holds
	 */
	generate() {
		this.#turn += 1
		return Promise.resolve(this.#script[this.#turn - 1])
	}

	/**
	 * Streams the next turn's text and returns its assembled result.
	 *
	 * @returns The turn the script holds, after its deltas
	 */
	async *stream() {
		this.#turn += 1
		const answer = this.#script[this.#turn - 1]
		for (const delta of buildDeltas(answer)) yield delta
		return answer
	}
}
