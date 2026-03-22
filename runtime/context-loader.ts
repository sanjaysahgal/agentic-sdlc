import Anthropic from "@anthropic-ai/sdk"
import { readFile } from "./github-client"
import { loadWorkspaceConfig } from "./workspace-config"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Loads the context an agent needs from the target repo.
// Called fresh on every message so agents always see current specs.

export type AgentContext = {
  productVision: string
  featureConventions: string
  systemArchitecture: string
  currentDraft: string
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

// Loads full context — used by spec-shaping agents (pm, architect) that need everything.
export async function loadAgentContext(featureName?: string): Promise<AgentContext> {
  const { paths } = loadWorkspaceConfig()
  const draftPath = featureName ? `${paths.featuresRoot}/${featureName}/${featureName}.product.md` : ""
  const draftBranch = featureName ? `spec/${featureName}-product` : ""

  const [productVision, featureConventions, systemArchitecture, currentDraft] = await Promise.all([
    readFile(paths.productVision),
    readFile(paths.featureConventions),
    readFile(paths.systemArchitecture),
    draftPath ? readFile(draftPath, draftBranch) : Promise.resolve(""),
  ])

  return { productVision, featureConventions, systemArchitecture, currentDraft }
}

// Loads context for the UX Design agent.
// Reads the approved product spec from main (source of truth for design phase)
// and the current design draft from the design branch if one exists.
export async function loadDesignAgentContext(featureName: string): Promise<AgentContext> {
  const { paths } = loadWorkspaceConfig()
  const productSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.product.md`
  const designDraftPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`
  const designBranch = `spec/${featureName}-design`

  const [productVision, featureConventions, systemArchitecture, approvedProductSpec, designDraft] = await Promise.all([
    readFile(paths.productVision),
    readFile(paths.featureConventions),
    readFile(paths.systemArchitecture),
    readFile(productSpecPath), // approved spec lives on main
    readFile(designDraftPath, designBranch), // design draft on feature branch
  ])

  // currentDraft serves dual purpose for design agent:
  // — the approved product spec is injected into the system prompt as the starting point
  // — the design draft (if any) is appended so the agent can continue from where it left off
  const currentDraft = [
    approvedProductSpec ? `## Approved Product Spec\n${approvedProductSpec}` : "",
    designDraft ? `## Current Design Draft\n${designDraft}` : "",
  ].filter(Boolean).join("\n\n")

  return { productVision, featureConventions, systemArchitecture, currentDraft }
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
