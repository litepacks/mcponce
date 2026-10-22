import { defineConfig } from 'vitest/config';
import { softscopeVitest } from 'softscope/vitest';

export default defineConfig({
  plugins: [softscopeVitest({
    json: 'softscope-report.json'
  })],
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    teardownTimeout: 60000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types.ts',
        '**/*.d.ts'
      ]
    },
    benchmark: {
      include: ['bench/**/*.bench.ts']
    }
  }
});
