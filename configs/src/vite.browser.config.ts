import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { srcBrowser, resolveWorkspacePath } from '../../vite.config.ts'

// vite-plugin-dts bundles the browser face while keeping core external through
// the package's published root export.
export default defineConfig(
	srcBrowser({
		plugins: [
			dts({
				tsconfigPath: resolveWorkspacePath('configs/src/tsconfig.browser.json'),
				beforeWriteFile: (path, content) => ({
					content: /[\\/]dist[\\/]src[\\/]browser[\\/]index\.d\.ts$/.test(path)
						? content.replaceAll(/(?:\.\.\/)+core\/index\.ts/g, '@orkestrel/mcp')
						: content,
				}),
				bundleTypes: true,
			}),
		],
	}),
)
