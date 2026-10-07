import { defineConfig } from 'vite';

// The MultiViewer API (official circuit layouts) doesn't allow requests from
// other websites, so the dev server forwards /mv/... to it on our behalf.
const proxy = {
  '/mv': {
    target: 'https://api.multiviewer.app',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/mv/, ''),
  },
};

export default defineConfig({
  server: { proxy },
  preview: { proxy },
});