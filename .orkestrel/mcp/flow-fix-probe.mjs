import { PassThrough } from 'node:stream'

// A transport that records ownership two ways, so the two candidate rules can be compared.
function transport(input, label) {
	const handler = () => {}
	const ownsByCount = input.listenerCount('data') === 0          // the shipped rule
	const ownsByFlow = input.readableFlowing !== true              // the candidate rule
	input.on('data', handler)
	return {
		label,
		release(rule) {
			input.removeListener('data', handler)
			const remaining = input.listenerCount('data')
			const owns = rule === 'count' ? ownsByCount : ownsByFlow
			const paused = rule === 'count'
				? owns                                                  // shipped: pause if owned at start
				: owns && remaining === 0                               // candidate: owned at start AND nobody left
			if (paused) input.pause()
			return { ownsByCount, ownsByFlow, remaining, paused }
		},
	}
}

const CASES = [
	['sole reader', () => {}],
	['caller resumed first', (i) => i.resume()],
	['caller attached then detached', (i) => { const h = () => {}; i.on('data', h); i.removeListener('data', h) }],
]

for (const rule of ['count', 'flow']) {
	console.log(`\n=== rule: ${rule} ===`)
	for (const [name, setup] of CASES) {
		const input = new PassThrough()
		setup(input)
		const t = transport(input, name)
		const r = t.release(rule)
		console.log(`  ${name.padEnd(30)} ownsCount=${String(r.ownsByCount).padEnd(5)} ownsFlow=${String(r.ownsByFlow).padEnd(5)} remaining=${r.remaining} paused=${r.paused}`)
	}
	// second reader attaches AFTER start
	const input = new PassThrough()
	const t = transport(input, 'second reader after start')
	const other = () => {}
	input.on('data', other)
	const r = t.release(rule)
	console.log(`  ${'second reader after start'.padEnd(30)} ownsCount=${String(r.ownsByCount).padEnd(5)} ownsFlow=${String(r.ownsByFlow).padEnd(5)} remaining=${r.remaining} paused=${r.paused}`)
}
console.log('\nCorrect answers: sole reader -> paused; every other case -> not paused.')
