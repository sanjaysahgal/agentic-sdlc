import Anthropic from "@anthropic-ai/sdk"

// 30s timeout — Haiku gap scans are short; no retries: a stall is a failure.
const client = new Anthropic({ maxRetries: 0, timeout: 30_000 })

const SYSTEM_PROMPT = `You are a PM-scope gap detector. Your job: read a UX design agent's response and identify any gaps that require a PM decision before design can proceed.

PM-scope gaps include:
- Undefined requirements: feature behavior or rules the PM spec never specified
- Missing error states: error paths the PM spec says to "handle gracefully" without defining the actual behavior
- Undefined data requirements: what data must exist, be stored, or be returned — when the PM spec is silent
- Scope decisions: which users, tiers, or conditions a feature applies to — when unspecified
- Qualitative criteria without measurable definitions: any PM spec language like "seamlessly", "appropriately", "ambient awareness", "minimal path" that must be made concrete before design can commit to a specific implementation

NOT PM-scope (do not flag):
- Design decisions: layout, color, spacing, animation, component choice, screen structure, visual hierarchy, where UI elements are positioned (wordmark placement, button placement, prompt bar position), what styling a component uses (glow effects, gradients, shadows, opacity), whether two screens share the same layout, which screens need to be designed
- Architecture or engineering decisions (API shape, database schema, auth implementation, data transfer mechanism, session token structure)
- Brand token questions
- Open design questions the designer is exploring — things the design team will decide themselves without PM input

For each PM-scope gap you find, output exactly one line:
GAP: <one sentence — the specific PM decision needed>

If no PM-scope gaps exist, output exactly: NONE

Output only GAP lines or NONE. No preamble, no explanation, no numbering.`

export async function classifyForPmGaps(params: {
  agentResponse: string
  approvedProductSpec?: string
}): Promise<{ gaps: string[] }> {
  const { agentResponse, approvedProductSpec } = params

  const userContent = approvedProductSpec
    ? `## Approved Product Spec\n${approvedProductSpec}\n\n## Design Agent Response\n${agentResponse}`
    : `## Design Agent Response\n${agentResponse}`

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "NONE"

  if (text === "NONE") {
    console.log(`[CLASSIFIER] classifyForPmGaps: 0 gaps found`)
    return { gaps: [] }
  }

  const gaps: string[] = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("GAP:")) continue
    const gap = line.replace("GAP:", "").trim()
    if (gap) gaps.push(gap)
  }

  console.log(`[CLASSIFIER] classifyForPmGaps: ${gaps.length} gap(s) found`)
  if (gaps.length > 0) {
    gaps.forEach((g, i) => console.log(`[CLASSIFIER]   gap ${i + 1}: ${g.slice(0, 100)}`))
  }
  return { gaps }
}
