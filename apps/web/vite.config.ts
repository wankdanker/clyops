import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const target = process.env.CLYOPS_DEV_API ?? 'http://127.0.0.1:8080';
export default defineConfig({
  plugins: [sveltekit()],
  server: { proxy: { '/tools': target, '/jobs': target, '/openapi.json': target } },
});
