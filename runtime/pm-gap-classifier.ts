import Anthropic from "@anthropic-ai/sdk"

// 30s timeout — Haiku gap scans are short; no retries: a stall is a failure.
const client = new Anthropic({ maxRetries: 0, timeout: 30_000 })

const SYSTEM_PROMPT = `You are a PM-scope gap detector. Your job: read a UX design agent's response and identify gaps that require a PM decision before design can proceed.

THE PM OWNS THE WHAT — NOT THE HOW.
A PM cares about one thing: the best possible customer journey to maximize user delight, retention, and revenue. The PM defines what must happen from the user's perspective. The PM never designs implementations.

Ask yourself: "Can this question be answered by deciding what the user should experience — without designing any implementation?"
- YES → PM-scope. Flag it.
- NO (answering requires designing a schema, mechanism, or technical approach) → architecture-scope. Do not flag.

PM-scope gaps (flag these):
- Undefined user-facing behavior: what happens to the user in a given situation that the PM spec never defined
- Missing error experiences: what the user sees/feels when something fails — not how the error is handled technically
- Scope decisions: which users, tiers, or conditions a feature applies to — when unspecified
- Qualitative criteria without measurable definitions: PM spec language like "seamlessly", "handle gracefully", "ambient awareness", "minimal path" that must be made concrete before design can commit

NOT PM-scope — do not flag these:
- Design decisions: layout, color, spacing, animation, component choice, screen structure, visual hierarchy, where UI elements are positioned (wordmark placement, button placement, prompt bar position), what styling a component uses (glow effects, gradients, shadows, opacity), whether two screens share the same layout, which screens need to be designed
- Architecture and implementation decisions: HOW anything works technically — session store schema (what fields the record contains, TTL enforcement), account-linking mechanism (how a guest session is claimed on sign-up), data model design, API shape, database schema, auth token structure, data transfer protocol, state machine design
- Brand token questions
- Open design questions the designer is exploring

THE CLEAREST SIGNAL: if a question mentions schema, mechanism, record structure, data model, session fields, API contract, token format, or linking logic — it belongs to the architect, not the PM. The PM says "the conversation must survive sign-up" (WHAT). The architect decides how the session store works (HOW).

For each PM-scope gap you find, output exactly one line:
GAP: <one sentence — the specific PM decision needed, framed as a user experience or product requirement>

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
