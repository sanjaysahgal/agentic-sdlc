// WorkspaceConfig — all product-specific coordinates in one place.
// Every agent reads from here. Nothing else hardcodes repo paths or product names.
//
// To onboard a new team: point these env vars at their repo.
// The repo must follow the same specs/ directory structure.

export type WorkspaceConfig = {
  productName: string        // Display name — used in agent personas and Slack messages
  githubOwner: string        // GitHub org or user
  githubRepo: string         // GitHub repo name
  mainChannel: string        // Main Slack channel for the concierge (e.g. "all-health360")
  targetFormFactors: string[]  // Form factors the design must specify layout for, e.g. ["mobile", "desktop"]
  maxAllowedSpecGrowthRatio: number  // Post-patch health gate: max ratio of spec size increase before bloat warning (default 1.2 = 20%)
  roles: {
    pmUser: string           // Slack user ID for the PM — used by Orchestrator alerts
    designerUser: string     // Slack user ID for the designer
    architectUser: string    // Slack user ID for the architect
  }
  paths: {
    productVision: string          // Product vision doc — injected into every agent
    systemArchitecture: string     // Architecture constraints — injected into every agent
    designSystem: string           // Design system doc — injected into design agent
    brand: string                  // Brand tokens (colors, typography, animation) — injected into design agent
    featureConventions: string     // Feature-level conventions — injected into pm agent
    featuresRoot: string           // Root dir for feature specs, e.g. "specs/features"
  }
}

export function loadWorkspaceConfig(): WorkspaceConfig {
  const productName = process.env.PRODUCT_NAME
  const githubOwner = process.env.GITHUB_OWNER
  const githubRepo = process.env.GITHUB_REPO

  if (!productName || !githubOwner || !githubRepo) {
    throw new Error(
      "Missing required env vars: PRODUCT_NAME, GITHUB_OWNER, GITHUB_REPO. " +
      "Copy .env.example to .env and fill in the values."
    )
  }

  return {
    productName,
    githubOwner,
    githubRepo,
    mainChannel: process.env.SLACK_MAIN_CHANNEL ?? "general",
    targetFormFactors: (process.env.TARGET_FORM_FACTORS ?? "mobile,desktop")
      .split(",")
      .map(f => f.trim())
      .filter(Boolean),
    maxAllowedSpecGrowthRatio: parseFloat(process.env.MAX_ALLOWED_SPEC_GROWTH_RATIO ?? "1.2"),
    roles: {
      pmUser:         process.env.SLACK_PM_USER         ?? "",
      designerUser:   process.env.SLACK_DESIGNER_USER   ?? "",
      architectUser:  process.env.SLACK_ARCHITECT_USER  ?? "",
    },
    paths: {
      productVision:       process.env.PATH_PRODUCT_VISION       ?? "specs/product/PRODUCT_VISION.md",
      systemArchitecture:  process.env.PATH_SYSTEM_ARCHITECTURE  ?? "specs/architecture/system-architecture.md",
      designSystem:        process.env.PATH_DESIGN_SYSTEM        ?? "specs/design/DESIGN_SYSTEM.md",
      brand:               process.env.PATH_BRAND                ?? "specs/brand/BRAND.md",
      featureConventions:  process.env.PATH_FEATURE_CONVENTIONS  ?? "specs/features/CLAUDE.md",
      featuresRoot:        process.env.PATH_FEATURES_ROOT        ?? "specs/features",
    },
  }
}
