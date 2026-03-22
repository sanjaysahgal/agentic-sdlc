import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type AuditResult =
  | { status: "ok" }
  | { status: "conflict"; message: string }
  | { status: "gap"; message: string }

// Audits a spec draft against product vision and system architecture.
// Runs before every draft save — if a conflict or gap is found, the draft is
// NOT saved and the issue is surfaced to the human instead.
//
// conflict = draft says something that contradicts vision or architecture
// gap      = draft implies something the vision/architecture doesn't address
//            (not necessarily wrong — needs a human decision before proceeding)
export async function auditSpecDraft(params: {
  draft: string
  productVision: string
  systemArchitecture: string
  featureName: string
}): Promise<AuditResult> {
  const { draft, productVision, systemArchitecture, featureName } = params

  if (!productVision && !systemArchitecture) return { status: "ok" }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `You are a spec auditor. Your job is to check a feature spec draft against a product vision and system architecture document.

You are looking for two things:
1. CONFLICT — the draft explicitly contradicts something in the product vision or architecture (e.g. proposes password auth when vision says SSO only, or suggests a REST API when architecture mandates tRPC)
2. GAP — the draft implies or assumes something that the vision or architecture does not address (e.g. assumes a native mobile app exists when the vision only describes web, or assumes a specific data model that the architecture hasn't defined)

IMPORTANT: If the draft already documents the gap as an open question in its "Open Questions" section (tagged [type: engineering] or [type: product]), respond with OK — the gap has been acknowledged by the team and does not need to be re-flagged.

If neither is found, respond with exactly: OK

If a conflict is found, respond with:
CONFLICT: <one sentence naming the specific contradiction and which documents it comes from>

If a gap is found (and it is NOT already in the Open Questions section), respond with:
GAP: <one sentence naming what the draft assumes that is not covered, and what decision needs to be made>

Only flag real issues. Do not flag vague or speculative concerns. One issue at a time — the most important one.`,
    messages: [
      {
        role: "user",
        content: `Feature: ${featureName}

## Product Vision
${productVision || "Not defined."}

## System Architecture
${systemArchitecture || "Not defined."}

## Draft Spec
${draft}`,
      },
    ],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "OK"

  if (text === "OK") return { status: "ok" }

  if (text.startsWith("CONFLICT:")) {
    return { status: "conflict", message: text.replace("CONFLICT:", "").trim() }
  }

  if (text.startsWith("GAP:")) {
    return { status: "gap", message: text.replace("GAP:", "").trim() }
  }

  // Unexpected format — don't block the save
  return { status: "ok" }
}
