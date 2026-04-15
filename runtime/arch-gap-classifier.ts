import Anthropic from "@anthropic-ai/sdk"

// 30s timeout — Haiku classifier; no retries: a stall is a failure.
const client = new Anthropic({ maxRetries: 0, timeout: 30_000 })

const SYSTEM_PROMPT = `You are a design escalation scope classifier. A UI designer is asking an architect a question before escalating it.

Your job: determine whether this question is a true design-blocking architectural unknown, or just an implementation detail the designer should state as a design assumption and continue.

THE SINGLE TEST:
"Would the UI look or behave differently depending on the answer?"

If YES → ARCH-GAP. The designer cannot commit to a UI decision without the architectural answer.
If NO → DESIGN-ASSUMPTION. The UI is identical regardless of the answer. The designer should state the user-visible behavior, add an assumption, and continue.

ARCH-GAP examples (UI changes based on answer):
- "Does the API support streaming? I need to decide between a typing indicator vs a loading spinner."
- "What is the max file upload size? I need to design the progress bar and error state."
- "Is there a rate limit per user? I need to design the throttling feedback state."

DESIGN-ASSUMPTION examples (UI is identical regardless of answer):
- "How are logged-out conversations stored — client-side, server-side, or hybrid?"
- "What encryption algorithm is used for session data?"
- "Is the backend REST or GraphQL?"
- "How is account linking implemented when a guest signs up?"
- "What is the session store schema?"

The clearest signal: if the question asks about storage mechanism, encryption, data model, API protocol, schema, or account-linking implementation — those are always DESIGN-ASSUMPTION. The designer states "conversation is preserved on sign-in" and moves on.

Respond with exactly one word: ARCH-GAP or DESIGN-ASSUMPTION`

export async function classifyForArchGap(question: string): Promise<"ARCH-GAP" | "DESIGN-ASSUMPTION"> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 32,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: question }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "ARCH-GAP"
  const result: "ARCH-GAP" | "DESIGN-ASSUMPTION" = text.startsWith("DESIGN-ASSUMPTION") ? "DESIGN-ASSUMPTION" : "ARCH-GAP"
  console.log(`[CLASSIFIER] classifyForArchGap: "${question.slice(0, 80)}…" → ${result}`)
  return result
}
