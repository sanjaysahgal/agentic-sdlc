import { readFile } from "./github-client"

// Loads the context an agent needs from the target repo.
// Called fresh on every message so agents always see current specs.

export type AgentContext = {
  productVision: string
  featureConventions: string
  systemArchitecture: string
}

export async function loadAgentContext(): Promise<AgentContext> {
  const [productVision, featureConventions, systemArchitecture] = await Promise.all([
    readFile("specs/product/PRODUCT_VISION.md"),
    readFile("specs/features/CLAUDE.md"),
    readFile("specs/architecture/system-architecture.md"),
  ])

  return { productVision, featureConventions, systemArchitecture }
}
