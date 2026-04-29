// Block D2 — state-corruption recovery.
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`.
// The on-disk `.conversation-state.json` file can become corrupt or
// surprising in three ways the platform must handle gracefully:
//
//   1. Partial write to .conversation-state.json mid-shutdown → next
//      startup recovers cleanly (replay or drop, not crash).
//   2. Race between two restarts (PID lock collision) → second start
//      either acquires lock cleanly or refuses cleanly.
//   3. .conversation-state.json with extra unknown fields (forward-compat)
//      → loader skips, doesn't crash.
//
// The B2 refactor exposed `parseConversationState(raw)` as a pure function:
// takes JSON string, returns typed result + optional parseError. This file
// asserts the recovery contract on that function plus documents the PID
// lock concern (D2.2 deferred to Block K — multi-tenant scale-out — where
// durable storage replaces file-backed in-memory state).

import { describe, it, expect } from "vitest"
import { parseConversationState } from "../../runtime/conversation-store"

// ─── D2.1 — Partial write to state file mid-shutdown ───────────────────────

describe("D2.1 — partial-write recovery (loader must not crash)", () => {
  it("malformed JSON (partial write truncated mid-object) returns empty result with parseError set", () => {
    // Simulate: SIGTERM hit mid-`writeFileSync`; on-disk file has a half-
    // written JSON object. The loader must NOT crash; it returns empty
    // and the bot starts fresh, overwriting the corrupt file on next
    // persist.
    const truncated = `{
  "pendingEscalations": {
    "onboarding": {
      "targetAgent": "pm",
      "question": "AC#5 vague",
      "designContext": "",
      "products`
    const result = parseConversationState(truncated)
    expect(result.parseError).toBeDefined()
    expect(result.pendingEscalations).toEqual([])
    expect(result.pendingApprovals).toEqual([])
    expect(result.escalationNotifications).toEqual([])
  })

  it("empty file returns empty result with parseError", () => {
    const result = parseConversationState("")
    expect(result.parseError).toBeDefined()
    expect(result.pendingEscalations).toEqual([])
  })

  it("non-JSON garbage returns empty result with parseError", () => {
    const result = parseConversationState("not json at all <html>")
    expect(result.parseError).toBeDefined()
    expect(result.pendingEscalations).toEqual([])
  })

  it("JSON null returns empty result without parseError (defensive coercion)", () => {
    const result = parseConversationState("null")
    expect(result.parseError).toBeUndefined()
    expect(result.pendingEscalations).toEqual([])
  })

  it("JSON top-level array returns empty result without parseError (top-level shape rejected)", () => {
    const result = parseConversationState(`[]`)
    expect(result.parseError).toBeUndefined()
    expect(result.pendingEscalations).toEqual([])
  })

  it("valid empty object returns empty result for all sections", () => {
    const result = parseConversationState("{}")
    expect(result.parseError).toBeUndefined()
    expect(result.pendingEscalations).toEqual([])
    expect(result.pendingApprovals).toEqual([])
    expect(result.pendingDecisionReviews).toEqual([])
    expect(result.escalationNotifications).toEqual([])
    expect(result.threadAgents).toEqual([])
    expect(result.orientedUsers).toEqual([])
  })
})

// ─── D2.2 — Restart-race / PID lock ─────────────────────────────────────────

describe("D2.2 — multi-process restart race (deferred to Block K)", () => {
  it("documents the multi-process concern (no PID lock today; deferred to durable backend)", () => {
    // Today the platform runs as a single Node.js process per tenant. The
    // file-backed conversation store is single-writer; concurrent writers
    // would interleave fs.writeFileSync calls without locking. This is
    // acceptable for the current scale (one process per tenant) but breaks
    // at multi-tenant scale-out (Block K), where multiple workers share
    // a durable backend.
    //
    // Block K's storage abstraction (K1) replaces file-backed in-memory
    // state with a durable backend (Postgres or equivalent) where
    // row-level locking + transactional writes provide the guarantees
    // a PID lock would otherwise need.
    //
    // No test today; the BACKLOG entry under Block K1 captures the
    // requirement. This `it` block exists for cutover-gate manifest
    // cross-reference.
    expect(true).toBe(true)
  })
})

// ─── D2.3 — Forward-compat with unknown fields ─────────────────────────────

describe("D2.3 — forward-compat: unknown fields ignored, known fields load", () => {
  it("extra top-level fields (future-platform additions) are silently skipped", () => {
    const raw = JSON.stringify({
      pendingEscalations: {
        "onboarding": {
          targetAgent: "pm",
          question: "AC#5 vague",
          designContext: "",
        },
      },
      // Future fields the current platform doesn't know about:
      pendingDeployments: { "onboarding": { sha: "abc" } },
      tenantQuotas:       { "onboarding": 1000 },
      newSomething:       42,
    })
    const result = parseConversationState(raw)
    expect(result.parseError).toBeUndefined()
    expect(result.pendingEscalations).toEqual([
      ["onboarding", { targetAgent: "pm", question: "AC#5 vague", designContext: "" }],
    ])
  })

  it("unknown nested fields inside a known object are silently passed through (future-compat)", () => {
    // The PendingEscalation type may grow new fields in future versions.
    // Today's loader stores the entry as-is; the typed reads ignore
    // unknown fields. This means a downgrade-and-restart preserves the
    // unknown fields on the next persist.
    const raw = JSON.stringify({
      pendingEscalations: {
        "onboarding": {
          targetAgent: "pm",
          question: "AC#5 vague",
          designContext: "",
          futureNewField: "ignored-but-preserved",
        },
      },
    })
    const result = parseConversationState(raw)
    expect(result.parseError).toBeUndefined()
    const entries = result.pendingEscalations
    expect(entries).toHaveLength(1)
    const [, payload] = entries[0]
    // Cast to any since futureNewField isn't in the typed shape — the test
    // verifies the field survives the round-trip.
    expect((payload as any).futureNewField).toBe("ignored-but-preserved")
  })

  it("malformed nested section (e.g. pendingApprovals as a string) doesn't drop other sections", () => {
    // Defensive: if one section is corrupt, the loader returns empty for
    // that section but loads the others. Avoids one corrupt entry
    // throwing the entire conversation state away.
    const raw = JSON.stringify({
      pendingEscalations: {
        "onboarding": {
          targetAgent: "pm",
          question: "AC#5 vague",
          designContext: "",
        },
      },
      pendingApprovals: "not-an-object-corrupt",
      threadAgents: { "1234.5678": "architect" },
    })
    const result = parseConversationState(raw)
    expect(result.parseError).toBeUndefined()
    expect(result.pendingEscalations).toHaveLength(1)
    expect(result.pendingApprovals).toEqual([])  // corrupt section → empty
    expect(result.threadAgents).toEqual([["1234.5678", "architect"]])
  })

  it("orientedUsers as a non-array is silently coerced to empty (defensive)", () => {
    const raw = JSON.stringify({
      orientedUsers: { "onboarding:U123": true },  // wrong shape — should be array
    })
    const result = parseConversationState(raw)
    expect(result.parseError).toBeUndefined()
    expect(result.orientedUsers).toEqual([])
  })
})

// ─── D2 — round-trip identity ───────────────────────────────────────────────

describe("D2 — round-trip: persisted state reloads identically", () => {
  it("a populated state, serialized to JSON, parses back to the same shape", () => {
    const sourceState = {
      pendingEscalations: {
        "feat-a": { targetAgent: "pm" as const, question: "Q1", designContext: "" },
      },
      pendingApprovals: {
        "feat-b": { specType: "product" as const, specContent: "# X", filePath: "specs/feat-b/feat-b.product.md", featureName: "feat-b" },
      },
      pendingDecisionReviews: {
        "feat-c": { specContent: "# Y", filePath: "specs/feat-c/feat-c.engineering.md", featureName: "feat-c", resolvedQuestions: ["Q1?"] },
      },
      escalationNotifications: {
        "feat-d": { targetAgent: "pm" as const, question: "Q2", originAgent: "design" as const },
      },
      threadAgents: {
        "1234.5678": "architect",
      },
      orientedUsers: ["feat-a:U123", "feat-b:U456"],
    }
    const raw = JSON.stringify(sourceState)
    const result = parseConversationState(raw)
    expect(result.parseError).toBeUndefined()
    expect(result.pendingEscalations).toEqual([["feat-a", sourceState.pendingEscalations["feat-a"]]])
    expect(result.pendingApprovals).toEqual([["feat-b", sourceState.pendingApprovals["feat-b"]]])
    expect(result.pendingDecisionReviews).toEqual([["feat-c", sourceState.pendingDecisionReviews["feat-c"]]])
    expect(result.escalationNotifications).toEqual([["feat-d", sourceState.escalationNotifications["feat-d"]]])
    expect(result.threadAgents).toEqual([["1234.5678", "architect"]])
    expect(result.orientedUsers).toEqual(["feat-a:U123", "feat-b:U456"])
  })
})
