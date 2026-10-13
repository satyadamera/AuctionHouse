/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.VITE_API_PROXY ?? 'http://localhost:4000';

/**
 * In development the SPA and API share one origin (localhost:5173) through this proxy, so the
 * HttpOnly refresh cookie is first-party and SameSite=Strict works without any CORS credentials dance.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/uploads': { target: API },
      '/static': { target: API },
      '/socket.io': { target: API, ws: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: API },
      '/uploads': { target: API },
      '/static': { target: API },
      '/socket.io': { target: API, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
