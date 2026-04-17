import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ maxRetries: 0, timeout: 15_000 })

const SYSTEM_PROMPT = `You are classifying a user's message to a design review tool that shows a numbered list of open issues.

Determine if the user is requesting that the tool apply fixes to some or all of the listed issues.

CONSERVATIVE RULE: Only classify as a fix request when the message clearly and unambiguously requests applying, fixing, or patching issues. Expressions of agreement, approval, or acknowledgment WITHOUT an explicit fix request are NOT fix requests.

Examples that ARE fix requests:
- "fix all"
- "fix everything"
- "yes fix them all"
- "go ahead and fix all of these"
- "apply all the fixes"
- "fix all of it"
- "fix 1, 3, and 5"
- "fix items 2 and 7"
- "fix the first three"
- "please fix 1 and 4"
- "can you fix all"
- "approving fixes for 2, 3, 5 and 8"
- "approve fixes 1-5"
- "fix 1 to 5 for now"
- "fix first 5 recommendations"
- "go ahead with 1 through 3"
- "apply your recommendations for 1, 4, and 7"
- "yes apply those fixes"

Examples that are NOT fix requests:
- "yes"
- "sounds good"
- "those all look right"
- "I agree"
- "approved" (no items referenced)
- "ok"
- "looks good to me"
- "yes I think those are valid issues"
- "makes sense"
- "what is item 3 about"
- "tell me more about item 5"

Respond with exactly one of:
FIX-ALL
FIX-ITEMS: 1,3,5
NOT-FIX`

export async function classifyFixIntent(message: string): Promise<{
  isFixAll: boolean
  selectedIndices: number[] | null
}> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 32,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: message }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "NOT-FIX"

  if (text === "FIX-ALL") {
    return { isFixAll: true, selectedIndices: null }
  }

  if (text.startsWith("FIX-ITEMS:")) {
    const indexPart = text.replace("FIX-ITEMS:", "").trim()
    const indices = indexPart.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0)
    if (indices.length > 0) return { isFixAll: true, selectedIndices: indices }
  }

  return { isFixAll: false, selectedIndices: null }
}
