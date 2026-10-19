// Vitest scope: unit tests live in src/ (e.g. src/lib/ppplink/*.test.ts).
// tests/ holds Playwright e2e specs, which vitest must not try to run.
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'api/**/*.test.ts'],
    // The agent worker vendored under src/core/agent/service is a Node service with
    // its own `node --test` suites (npm test in that dir) -- not vitest specs.
    exclude: [...configDefaults.exclude, '**/src/core/agent/service/**'],
  },
});
