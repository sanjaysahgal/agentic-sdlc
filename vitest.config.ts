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
        functions: 83,  // raised from 80 after PM/design/architect tool handler extraction; 95 requires further message.ts extraction
        branches: 80,
      },
    },
  },
})
