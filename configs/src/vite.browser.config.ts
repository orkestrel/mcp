import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { srcBrowser, resolveWorkspacePath } from '../../vite.config.ts'

// vite-plugin-dts rolls this face into one declaration, and the roll-up reaches
// src/core through a relative source path the tarball does not carry. The rewrite
// below externalizes core through the package's own published root export, on the
// final roll-up only.
export default defineConfig(
	srcBrowser({
		plugins: [
			dts({
				tsconfigPath: resolveWorkspacePath('configs/src/tsconfig.browser.json'),
				bundleTypes: true,
				beforeWriteFile: (path, content) => ({
					content: /[\\/]dist[\\/]src[\\/]browser[\\/]index\.d\.ts$/.test(path)
						? content.replaceAll(/(?:\.\.\/)+core\/index\.ts/g, '@orkestrel/mcp')
						: content,
				}),
			}),
		],
	}),
)
