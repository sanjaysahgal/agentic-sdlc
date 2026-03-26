import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/visual",
  use: {
    browserName: "chromium",
    headless: true,
  },
})
