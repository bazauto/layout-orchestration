import { defineConfig } from 'vitest/config';
// vitest ^3.1.0 — kept in sync with @vitest/coverage-v8

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/adapters/dcc/SerialDccAdapter.ts'],
    },
  },
});
