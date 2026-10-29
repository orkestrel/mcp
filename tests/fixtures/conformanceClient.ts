import { isFunction, isRecord } from '@orkestrel/contract'
import { createServer } from 'vite'

const loader = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
	const entry: unknown = await loader.ssrLoadModule('/tests/setupServer.ts')
	if (!isRecord(entry) || !isFunction(entry['executeConformanceDriver'])) {
		throw new Error('The conformance setup exposes no client driver')
	}
	await entry['executeConformanceDriver'](process.argv[2])
} finally {
	await loader.close()
}
