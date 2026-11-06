import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

/**
 * Drops the inline HMR shim from index.html when building.
 *
 * The shim exists only to keep the AI Studio preview quiet while file watching
 * is disabled. It replaces window.WebSocket and swallows console errors matching
 * "WebSocket" or "@vite/client" - in a real deployment that would hide genuine
 * socket failures from the operator, so it must not reach the bundle.
 * Dev keeps it: `apply: 'build'` leaves the served document untouched.
 */
function stripDevHmrShim(): Plugin {
  return {
    name: 'strip-dev-hmr-shim',
    apply: 'build',
    enforce: 'pre',
    transformIndexHtml(html) {
      return html.replace(
        /[ \t]*<!-- DEV_HMR_SHIM_START -->[\s\S]*?<!-- DEV_HMR_SHIM_END -->\n?/,
        ''
      );
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), stripDevHmrShim()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
