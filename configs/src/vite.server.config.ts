import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { srcServer, resolveWorkspacePath } from '../../vite.config.ts'

// vite-plugin-dts bundles the server face while keeping core external through
// the package's published root export.
export default defineConfig(
	srcServer({
		plugins: [
			dts({
				tsconfigPath: resolveWorkspacePath('configs/src/tsconfig.server.json'),
				include: [resolveWorkspacePath('src/server')],
				beforeWriteFile: (path, content) => ({
					content: /[\\/]dist[\\/]src[\\/]server[\\/]index\.d\.ts$/.test(path)
						? content.replaceAll(/(?:\.\.\/)+core\/index\.ts/g, '@orkestrel/mcp')
						: content,
				}),
				bundleTypes: true,
			}),
		],
	}),
)
