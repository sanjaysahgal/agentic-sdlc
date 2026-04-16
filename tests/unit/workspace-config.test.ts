import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { loadWorkspaceConfig } from "../../runtime/workspace-config"

describe("loadWorkspaceConfig", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("throws when PRODUCT_NAME is missing", () => {
    delete process.env.PRODUCT_NAME
    process.env.GITHUB_OWNER = "acme"
    process.env.GITHUB_REPO = "my-app"
    expect(() => loadWorkspaceConfig()).toThrow("PRODUCT_NAME")
  })

  it("throws when GITHUB_OWNER is missing", () => {
    process.env.PRODUCT_NAME = "AcmeApp"
    delete process.env.GITHUB_OWNER
    process.env.GITHUB_REPO = "my-app"
    expect(() => loadWorkspaceConfig()).toThrow("GITHUB_OWNER")
  })

  it("throws when GITHUB_REPO is missing", () => {
    process.env.PRODUCT_NAME = "AcmeApp"
    process.env.GITHUB_OWNER = "acme"
    delete process.env.GITHUB_REPO
    expect(() => loadWorkspaceConfig()).toThrow("GITHUB_REPO")
  })

  it("returns config when required vars are set", () => {
    process.env.PRODUCT_NAME = "AcmeApp"
    process.env.GITHUB_OWNER = "acme"
    process.env.GITHUB_REPO = "my-app"
    const config = loadWorkspaceConfig()
    expect(config.productName).toBe("AcmeApp")
    expect(config.githubOwner).toBe("acme")
    expect(config.githubRepo).toBe("my-app")
  })

  it("uses default mainChannel when SLACK_MAIN_CHANNEL is unset", () => {
    process.env.PRODUCT_NAME = "AcmeApp"
    process.env.GITHUB_OWNER = "acme"
    process.env.GITHUB_REPO = "my-app"
    delete process.env.SLACK_MAIN_CHANNEL
    const config = loadWorkspaceConfig()
    expect(config.mainChannel).toBe("general")
  })

  it("uses SLACK_MAIN_CHANNEL when set", () => {
    process.env.PRODUCT_NAME = "AcmeApp"
    process.env.GITHUB_OWNER = "acme"
    process.env.GITHUB_REPO = "my-app"
    process.env.SLACK_MAIN_CHANNEL = "all-acme"
    const config = loadWorkspaceConfig()
    expect(config.mainChannel).toBe("all-acme")
  })

  it("uses default spec paths when PATH_* overrides are unset", () => {
    process.env.PRODUCT_NAME = "AcmeApp"
    process.env.GITHUB_OWNER = "acme"
    process.env.GITHUB_REPO = "my-app"
    delete process.env.PATH_PRODUCT_VISION
    delete process.env.PATH_SYSTEM_ARCHITECTURE
    delete process.env.PATH_FEATURE_CONVENTIONS
    delete process.env.PATH_FEATURES_ROOT
    const config = loadWorkspaceConfig()
    expect(config.paths.productVision).toBe("specs/product/PRODUCT_VISION.md")
    expect(config.paths.systemArchitecture).toBe("specs/architecture/system-architecture.md")
    expect(config.paths.featureConventions).toBe("specs/features/CLAUDE.md")
    expect(config.paths.featuresRoot).toBe("specs/features")
  })

  it("accepts PATH_* overrides for custom repo structures", () => {
    process.env.PRODUCT_NAME = "AcmeApp"
    process.env.GITHUB_OWNER = "acme"
    process.env.GITHUB_REPO = "my-app"
    process.env.PATH_PRODUCT_VISION = "docs/vision.md"
    process.env.PATH_FEATURES_ROOT = "features"
    const config = loadWorkspaceConfig()
    expect(config.paths.productVision).toBe("docs/vision.md")
    expect(config.paths.featuresRoot).toBe("features")
  })

  it("uses default maxAllowedSpecGrowthRatio of 1.2 when unset", () => {
    process.env.PRODUCT_NAME = "AcmeApp"
    process.env.GITHUB_OWNER = "acme"
    process.env.GITHUB_REPO = "my-app"
    delete process.env.MAX_ALLOWED_SPEC_GROWTH_RATIO
    const config = loadWorkspaceConfig()
    expect(config.maxAllowedSpecGrowthRatio).toBe(1.2)
  })

  it("reads maxAllowedSpecGrowthRatio from MAX_ALLOWED_SPEC_GROWTH_RATIO env var", () => {
    process.env.PRODUCT_NAME = "AcmeApp"
    process.env.GITHUB_OWNER = "acme"
    process.env.GITHUB_REPO = "my-app"
    process.env.MAX_ALLOWED_SPEC_GROWTH_RATIO = "1.5"
    const config = loadWorkspaceConfig()
    expect(config.maxAllowedSpecGrowthRatio).toBe(1.5)
  })
})
