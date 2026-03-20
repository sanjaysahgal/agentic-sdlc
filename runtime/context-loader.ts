import { readFile } from "./github-client"

// Loads the context an agent needs from the target repo.
// Called fresh on every message so agents always see current specs.

export type AgentContext = {
  productVision: string
  featureConventions: string
  systemArchitecture: string
  currentDraft: string
}

export async function loadAgentContext(featureName?: string): Promise<AgentContext> {
  const draftPath = featureName ? `specs/features/${featureName}/${featureName}.product.md` : ""
  const draftBranch = featureName ? `spec/${featureName}-product` : ""

  const [productVision, featureConventions, systemArchitecture, currentDraft] = await Promise.all([
    readFile("specs/product/PRODUCT_VISION.md"),
    readFile("specs/features/CLAUDE.md"),
    readFile("specs/architecture/system-architecture.md"),
    draftPath ? readFile(draftPath, draftBranch) : Promise.resolve(""),
  ])

  return { productVision, featureConventions, systemArchitecture, currentDraft }
}
