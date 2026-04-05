import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["agents/**/*.ts", "runtime/**/*.ts", "interfaces/**/*.ts"],
      exclude: ["**/*.test.ts", "**/node_modules/**", "interfaces/slack/server.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
})
