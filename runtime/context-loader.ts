import Anthropic from "@anthropic-ai/sdk"
import { readFile, listSubdirectories } from "./github-client"
import { loadWorkspaceConfig } from "./workspace-config"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Loads the context an agent needs from the target repo.
// Called fresh on every message so agents always see current specs.

export type AgentContext = {
  productVision: string
  featureConventions: string
  systemArchitecture: string
  currentDraft: string
  designSystem?: string             // Design system doc — injected into design agent
  brand?: string                    // Brand tokens (colors, typography, animation) — injected into design agent
  approvedFeatureSpecs?: string     // All approved specs in this agent's domain (cross-feature coherence)
}

// Returns a concise summary of a document relevant to a given question.
// Used when injecting large docs into agents that only need the relevant parts.
// Runs in parallel with other context fetches — minimal latency impact.
async function summarizeForContext(doc: string, question: string): Promise<string> {
  if (!doc) return ""
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: `Extract the parts of this document most relevant to answering the user's question.
Be concise — return only what is needed, verbatim where possible. Maximum 400 words.
If the whole document is relevant, summarize it in 200 words.`,
    messages: [
      { role: "user", content: `Question: ${question}\n\nDocument:\n${doc}` },
    ],
  })
  return response.content[0].type === "text" ? response.content[0].text.trim() : doc.slice(0, 2000)
}

// Loads all approved specs of a given type from the features root on main.
// Used by spec-producing agents for cross-feature coherence.
// e.g. suffix = ".product.md" loads all approved product specs.
// Times out after 10s — cross-feature coherence is an enhancement, not a hard dependency.
async function loadApprovedSpecs(featuresRoot: string, suffix: string, excludeFeature?: string): Promise<string> {
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(""), 10_000))

  const load = async (): Promise<string> => {
    const featureDirs = await listSubdirectories(featuresRoot)
    if (featureDirs.length === 0) return ""

    const specPromises = featureDirs
      .filter((dir) => dir !== excludeFeature)
      .map(async (dir) => {
        const content = await readFile(`${featuresRoot}/${dir}/${dir}${suffix}`)
        if (!content) return ""
        return `### ${dir}\n${content}`
      })

    const specs = await Promise.all(specPromises)
    return specs.filter(Boolean).join("\n\n---\n\n")
  }

  return Promise.race([load(), timeout])
}

// Loads full context — used by the PM agent (spec-shaping + CPO-level cross-feature coherence).
export async function loadAgentContext(featureName?: string): Promise<AgentContext> {
  const { paths } = loadWorkspaceConfig()
  const draftPath = featureName ? `${paths.featuresRoot}/${featureName}/${featureName}.product.md` : ""
  const draftBranch = featureName ? `spec/${featureName}-product` : ""

  const [productVision, featureConventions, systemArchitecture, currentDraft, approvedFeatureSpecs] = await Promise.all([
    readFile(paths.productVision),
    readFile(paths.featureConventions),
    readFile(paths.systemArchitecture),
    draftPath ? readFile(draftPath, draftBranch) : Promise.resolve(""),
    // Load all other approved product specs for cross-feature coherence
    loadApprovedSpecs(paths.featuresRoot, ".product.md", featureName),
  ])

  return { productVision, featureConventions, systemArchitecture, currentDraft, approvedFeatureSpecs }
}

// Loads context for the UX Design agent.
// Reads: approved product spec (source of truth for design phase), current design draft,
// DESIGN_SYSTEM.md (authoritative design doc), and all other approved design specs
// (for cross-feature design coherence).
export async function loadDesignAgentContext(featureName: string): Promise<AgentContext> {
  const { paths } = loadWorkspaceConfig()
  const productSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.product.md`
  const designDraftPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`
  const designBranch = `spec/${featureName}-design`

  const [productVision, featureConventions, systemArchitecture, approvedProductSpec, designDraft, designSystem, brand, approvedFeatureSpecs] = await Promise.all([
    readFile(paths.productVision),
    readFile(paths.featureConventions),
    readFile(paths.systemArchitecture),
    readFile(productSpecPath),           // approved spec lives on main
    readFile(designDraftPath, designBranch), // design draft on feature branch
    readFile(paths.designSystem),        // design system doc — may not exist yet (first feature)
    readFile(paths.brand),               // brand tokens — may not exist yet (first feature)
    // Load all other approved design specs for cross-feature coherence
    loadApprovedSpecs(paths.featuresRoot, ".design.md", featureName),
  ])

  // currentDraft serves dual purpose for design agent:
  // — the approved product spec is the starting point
  // — the design draft (if any) is appended so the agent can continue from where it left off
  const currentDraft = [
    approvedProductSpec ? `## Approved Product Spec\n${approvedProductSpec}` : "",
    designDraft ? `## Current Design Draft\n${designDraft}` : "",
  ].filter(Boolean).join("\n\n")

  return { productVision, featureConventions, systemArchitecture, currentDraft, designSystem, brand, approvedFeatureSpecs }
}

// Loads context for the Architect agent.
// Reads: approved product + design specs (full spec chain), current engineering draft,
// and all other approved engineering specs (for cross-feature technical coherence).
export async function loadArchitectAgentContext(featureName: string): Promise<AgentContext> {
  const { paths } = loadWorkspaceConfig()
  const productSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.product.md`
  const designSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`
  const engineeringDraftPath = `${paths.featuresRoot}/${featureName}/${featureName}.engineering.md`
  const engineeringBranch = `spec/${featureName}-engineering`

  const [productVision, systemArchitecture, approvedProductSpec, approvedDesignSpec, engineeringDraft, approvedFeatureSpecs] = await Promise.all([
    readFile(paths.productVision),
    readFile(paths.systemArchitecture),
    readFile(productSpecPath),                        // approved on main
    readFile(designSpecPath),                         // approved on main
    readFile(engineeringDraftPath, engineeringBranch), // engineering draft on feature branch
    // Load all other approved engineering specs for cross-feature coherence
    loadApprovedSpecs(paths.featuresRoot, ".engineering.md", featureName),
  ])

  // currentDraft: full spec chain (product + design + engineering draft)
  const currentDraft = [
    approvedProductSpec ? `## Approved Product Spec\n${approvedProductSpec}` : "",
    approvedDesignSpec ? `## Approved Design Spec\n${approvedDesignSpec}` : "",
    engineeringDraft ? `## Current Engineering Draft\n${engineeringDraft}` : "",
  ].filter(Boolean).join("\n\n")

  return { productVision, featureConventions: "", systemArchitecture, currentDraft, approvedFeatureSpecs }
}

// Loads context filtered to what's relevant for a specific user question.
// Used by the concierge and any agent that injects context into a bounded prompt.
// Reads the same authoritative docs — no separate summary files.
export async function loadAgentContextForQuery(query: string): Promise<AgentContext> {
  const { paths } = loadWorkspaceConfig()

  const [rawVision, rawArchitecture] = await Promise.all([
    readFile(paths.productVision),
    readFile(paths.systemArchitecture),
  ])

  const [productVision, systemArchitecture] = await Promise.all([
    summarizeForContext(rawVision, query),
    summarizeForContext(rawArchitecture, query),
  ])

  return { productVision, featureConventions: "", systemArchitecture, currentDraft: "" }
}
