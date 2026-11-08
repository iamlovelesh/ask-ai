import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Server tests live in server/test/**; web has its own (jsdom) config and
    // runs via the `test` script's per-workspace invocation.
    include: ['server/test/**/*.test.ts', 'eval/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
