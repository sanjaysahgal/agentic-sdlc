import { describe, it, expect } from "vitest"
import logger from "../../runtime/logger"

describe("logger", () => {
  it("exports a logger with info, warn, and error methods", () => {
    expect(typeof logger.info).toBe("function")
    expect(typeof logger.warn).toBe("function")
    expect(typeof logger.error).toBe("function")
  })

  it("does not throw when logging a string", () => {
    expect(() => logger.info("test log line")).not.toThrow()
    expect(() => logger.warn("test warning")).not.toThrow()
    expect(() => logger.error("test error")).not.toThrow()
  })
})
