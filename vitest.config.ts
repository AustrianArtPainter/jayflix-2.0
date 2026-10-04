import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // Next preserves JSX; Vite 8's OXC must lower it before Vitest import analysis.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Keep large jsdom lifecycle fixtures responsive alongside local previews.
    maxWorkers: 2,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
