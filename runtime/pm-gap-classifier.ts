import Anthropic from "@anthropic-ai/sdk"

// 30s timeout — Haiku gap scans are short; no retries: a stall is a failure.
const client = new Anthropic({ maxRetries: 0, timeout: 30_000 })

const SYSTEM_PROMPT = `You are a gap classifier. Your job: read a UX design agent's escalation question and classify each item as PM-scope, design-scope, or architecture-scope.

THE PM OWNS THE WHAT — NOT THE HOW.
A PM cares about one thing: the best possible customer journey to maximize user delight, retention, and revenue. The PM defines what must happen from the user's perspective. The PM never designs implementations.

Ask yourself for each item:
1. "Can this question be answered by deciding what the user should experience — without designing any implementation?" → YES → PM-scope (GAP:)
2. "Is this a visual or UX decision the designer owns independently — element type, placement, timing, animation, visual treatment?" → YES → design-scope (DESIGN:)
3. "Does answering this require designing a schema, mechanism, or technical approach?" → YES → architecture-scope (ARCH:)

PM-scope (flag with GAP:):
- Undefined user-facing behavior: what happens to the user in a given situation that the PM spec never defined
- Missing error experiences: what the user sees/feels when something fails — not how the error is handled technically
- Scope decisions: which users, tiers, or conditions a feature applies to — when unspecified
- Qualitative criteria without measurable definitions: PM spec language like "seamlessly", "handle gracefully", "ambient awareness", "minimal path" that must be made concrete before design can commit

Design-scope (flag with DESIGN:) — the designer resolves these independently, no PM input needed:
- Visual element decisions: which UI component to use (button vs chip vs link vs icon), exact element type
- Positioning and placement: where exactly to put a UI element on screen, spacing, margins, visual hierarchy
- Animation and timing: entry/exit direction, duration in milliseconds, easing function, transition timing, opacity cycles, animation cycle duration, gradient direction, whether two glows are combined or separate
- Visual treatment: color values, glow effects, gradients, shadows, opacity, border radius, iconography
- Layout decisions: single-column vs two-column, stacked vs side-by-side, screen structure
- Screen-level design questions the designer is exploring — wordmark placement, button placement, prompt bar position, whether two screens share the same layout, which screens need to be designed
- Spec contradictions on visual/animation details: if the question asks which value is correct when the PM spec and design spec show different opacity percentages, animation durations (ms/s), color values, gradient details, or other visual/technical specifics — this is ALWAYS DESIGN-scope. The PM spec should never contain specific animation or visual values; any that appear there are mistakes. The designer owns all visual implementation decisions and resolves spec contradictions on visual details independently. NEVER classify "PM spec says X opacity/duration/gradient, design spec says Y — which is right?" as a PM gap.

Architecture-scope (flag with ARCH:):
- Implementation decisions: HOW anything works technically — session store schema (what fields the record contains, TTL enforcement), account-linking mechanism (how a guest session is claimed on sign-up), data model design, API shape, database schema, auth token structure, data transfer protocol, state machine design
- Brand token questions
- Open technical questions about infrastructure or data flow

THE CLEAREST SIGNAL:
- Mentions schema, mechanism, record structure, data model, session fields, API contract, token format, or linking logic → ARCH
- Mentions element type, placement, timing, animation duration, visual styling, or layout → DESIGN
- Requires a product decision about what the user should experience → GAP

For each item in the input, output exactly one line:
GAP: <one sentence — the specific PM decision needed, framed as a user experience or product requirement>
OR
DESIGN: <one sentence — the visual/UX decision the designer should resolve independently>
OR
ARCH: <one sentence — the architecture/implementation decision needed>

If no items exist at all, output exactly: NONE

Output only GAP/DESIGN/ARCH lines or NONE. No preamble, no explanation, no numbering.`

export async function classifyForPmGaps(params: {
  agentResponse: string
  approvedProductSpec?: string
}): Promise<{ gaps: string[], architectItems: string[], designItems: string[] }> {
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
    return { gaps: [], architectItems: [], designItems: [] }
  }

  const gaps: string[] = []
  const architectItems: string[] = []
  const designItems: string[] = []
  for (const line of text.split("\n")) {
    if (line.startsWith("GAP:")) {
      const gap = line.replace("GAP:", "").trim()
      if (gap) gaps.push(gap)
    } else if (line.startsWith("ARCH:")) {
      const item = line.replace("ARCH:", "").trim()
      if (item) architectItems.push(item)
    } else if (line.startsWith("DESIGN:")) {
      const item = line.replace("DESIGN:", "").trim()
      if (item) designItems.push(item)
    }
  }

  console.log(`[CLASSIFIER] classifyForPmGaps: ${gaps.length} PM gap(s), ${architectItems.length} architect item(s), ${designItems.length} design item(s)`)
  if (gaps.length > 0) {
    gaps.forEach((g, i) => console.log(`[CLASSIFIER]   PM gap ${i + 1}: ${g.slice(0, 100)}`))
  }
  if (architectItems.length > 0) {
    architectItems.forEach((a, i) => console.log(`[CLASSIFIER]   arch item ${i + 1}: ${a.slice(0, 100)}`))
  }
  if (designItems.length > 0) {
    designItems.forEach((d, i) => console.log(`[CLASSIFIER]   design item ${i + 1}: ${d.slice(0, 100)}`))
  }
  return { gaps, architectItems, designItems }
}
