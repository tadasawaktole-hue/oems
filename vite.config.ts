import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// On GitHub Actions the site is served from https://<user>.github.io/<repo>/,
// so the base path is taken from the repository name automatically.
// (A "<user>.github.io" repository is served from the root.)
const repo = (process.env.GITHUB_REPOSITORY || '').split('/')[1] || '';
const onPages = !!process.env.GITHUB_ACTIONS && !!repo;
const base = onPages && !repo.endsWith('.github.io') ? `/${repo}/` : '/';

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false },
});
