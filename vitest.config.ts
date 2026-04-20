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
      exclude: [
        "**/*.test.ts",
        "**/node_modules/**",
        "interfaces/slack/server.ts",
        "interfaces/slack/app.ts",
        "interfaces/slack/handlers/general.ts",
        "interfaces/slack/handlers/reactions.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 80,  // TODO: raise to 95 after design tool handler extraction
        branches: 80,
      },
    },
  },
})
