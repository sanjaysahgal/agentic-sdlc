import Anthropic from "@anthropic-ai/sdk"

// 30s timeout — Haiku gap scans are short; no retries: a stall is a failure.
const client = new Anthropic({ maxRetries: 0, timeout: 30_000 })

const SYSTEM_PROMPT = `You are a gap classifier. Your job: read a UX design agent's escalation question and classify each item as PM-scope or architecture-scope.

THE PM OWNS THE WHAT — NOT THE HOW.
A PM cares about one thing: the best possible customer journey to maximize user delight, retention, and revenue. The PM defines what must happen from the user's perspective. The PM never designs implementations.

Ask yourself for each item: "Can this question be answered by deciding what the user should experience — without designing any implementation?"
- YES → PM-scope.
- NO (answering requires designing a schema, mechanism, or technical approach) → architecture-scope.

PM-scope (flag with GAP:):
- Undefined user-facing behavior: what happens to the user in a given situation that the PM spec never defined
- Missing error experiences: what the user sees/feels when something fails — not how the error is handled technically
- Scope decisions: which users, tiers, or conditions a feature applies to — when unspecified
- Qualitative criteria without measurable definitions: PM spec language like "seamlessly", "handle gracefully", "ambient awareness", "minimal path" that must be made concrete before design can commit

Architecture-scope (flag with ARCH:):
- Design decisions: layout, color, spacing, animation, component choice, screen structure, visual hierarchy, where UI elements are positioned (wordmark placement, button placement, prompt bar position), what styling a component uses (glow effects, gradients, shadows, opacity), whether two screens share the same layout, which screens need to be designed
- Architecture and implementation decisions: HOW anything works technically — session store schema (what fields the record contains, TTL enforcement), account-linking mechanism (how a guest session is claimed on sign-up), data model design, API shape, database schema, auth token structure, data transfer protocol, state machine design
- Brand token questions
- Open design questions the designer is exploring

THE CLEAREST SIGNAL: if a question mentions schema, mechanism, record structure, data model, session fields, API contract, token format, or linking logic — it belongs to the architect, not the PM.

For each item in the input, output exactly one line:
GAP: <one sentence — the specific PM decision needed, framed as a user experience or product requirement>
OR
ARCH: <one sentence — the architecture/implementation decision needed>

If no items exist at all, output exactly: NONE

Output only GAP/ARCH lines or NONE. No preamble, no explanation, no numbering.`

export async function classifyForPmGaps(params: {
  agentResponse: string
  approvedProductSpec?: string
}): Promise<{ gaps: string[], architectItems: string[] }> {
  const { agentResponse, approvedProductSpec } = params

  const userContent = approvedProductSpec
    ? `## Approved Product Spec\n${approvedProductSpec}\n\n## Design Agent Escalation Items\n${agentResponse}`
    : `## Design Agent Escalation Items\n${agentResponse}`

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "NONE"

  if (text === "NONE") {
    console.log(`[CLASSIFIER] classifyForPmGaps: 0 gaps found`)
    return { gaps: [], architectItems: [] }
  }

  const gaps: string[] = []
  const architectItems: string[] = []
  for (const line of text.split("\n")) {
    if (line.startsWith("GAP:")) {
      const gap = line.replace("GAP:", "").trim()
      if (gap) gaps.push(gap)
    } else if (line.startsWith("ARCH:")) {
      const item = line.replace("ARCH:", "").trim()
      if (item) architectItems.push(item)
    }
  }

  console.log(`[CLASSIFIER] classifyForPmGaps: ${gaps.length} PM gap(s), ${architectItems.length} architect item(s)`)
  if (gaps.length > 0) {
    gaps.forEach((g, i) => console.log(`[CLASSIFIER]   PM gap ${i + 1}: ${g.slice(0, 100)}`))
  }
  if (architectItems.length > 0) {
    architectItems.forEach((a, i) => console.log(`[CLASSIFIER]   arch item ${i + 1}: ${a.slice(0, 100)}`))
  }
  return { gaps, architectItems }
}
