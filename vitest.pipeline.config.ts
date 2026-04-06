// Pipeline eval config — real Anthropic API, mocked GitHub, Haiku judge.
// Run with: npm run eval:pipeline
// NOT run in main test suite (uses .eval.ts extension, separate config).

import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/evals/pipeline/**/*.eval.ts"],
    setupFiles: ["tests/pipeline-setup.ts"],
    testTimeout: 120_000,   // real API calls — allow up to 2 min per test
    hookTimeout: 30_000,
    // No coverage — evals are quality checks, not coverage tools
  },
})
