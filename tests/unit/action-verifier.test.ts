import { describe, it, expect } from "vitest"
import { verifyActionClaims, ToolCallRecord } from "../../runtime/action-verifier"

describe("verifyActionClaims", () => {
  // ─── Finalization claims ─────────────────────────────────────────────

  it("strips false finalization claim when no finalize tool was called", () => {
    const response = "The spec is finalized and ready for the engineer agents."
    const toolCalls: ToolCallRecord[] = [] // no tools called
    const result = verifyActionClaims(response, toolCalls)
    expect(result).toContain("NOT been finalized")
    expect(result).toContain("approve")
  })

  it("preserves finalization claim when finalize tool WAS called", () => {
    const response = "The spec is finalized and ready for the engineer agents."
    const toolCalls: ToolCallRecord[] = [{ name: "finalize_engineering_spec" }]
    const result = verifyActionClaims(response, toolCalls)
    expect(result).toBe(response) // unchanged
  })

  it("catches 'approved and saved' without finalize tool", () => {
    const result = verifyActionClaims("Spec approved and saved to main.", [])
    expect(result).toContain("NOT been finalized")
  })

  it("catches 'merged to main' without finalize tool", () => {
    const result = verifyActionClaims("Changes merged to main branch.", [])
    expect(result).toContain("NOT been finalized")
  })

  it("catches 'ready for the engineers' without finalize tool", () => {
    const result = verifyActionClaims("The spec is ready for the engineer agents to begin.", [])
    expect(result).toContain("NOT been finalized")
  })

  // ─── Save claims ─────────────────────────────────────────────────────

  it("strips false save claim when no save tool was called", () => {
    const result = verifyActionClaims("I've saved the draft to GitHub.", [])
    expect(result).toContain("no spec changes were saved")
  })

  it("preserves save claim when save tool WAS called", () => {
    const response = "Draft saved to the spec branch."
    const result = verifyActionClaims(response, [{ name: "save_engineering_spec_draft" }])
    expect(result).toBe(response)
  })

  it("preserves save claim when apply tool was called", () => {
    const response = "The spec has been updated with the new API contracts."
    const result = verifyActionClaims(response, [{ name: "apply_engineering_spec_patch" }])
    expect(result).toBe(response)
  })

  it("catches 'spec updated' without save/apply tool", () => {
    const result = verifyActionClaims("The spec is updated with your changes.", [])
    expect(result).toContain("no spec changes were saved")
  })

  // ─── Escalation claims ───────────────────────────────────────────────

  it("strips false escalation claim when no escalation tool was called", () => {
    const result = verifyActionClaims("I've escalated to the PM for resolution.", [])
    expect(result).toContain("no escalation was initiated")
  })

  it("preserves escalation claim when offer tool WAS called", () => {
    const response = "Escalated to the PM — they'll resolve the gap."
    const result = verifyActionClaims(response, [{ name: "offer_upstream_revision" }])
    expect(result).toBe(response)
  })

  // ─── No claims ──────────────────────────────────────────────────────

  it("returns response unchanged when no action claims detected", () => {
    const response = "Here's my analysis of the data model. The User table needs a session_id column."
    const result = verifyActionClaims(response, [])
    expect(result).toBe(response)
  })

  // ─── Multiple false claims ──────────────────────────────────────────

  it("catches multiple false claims in one response", () => {
    const response = "The spec is finalized. I've also saved the draft with additional notes."
    const result = verifyActionClaims(response, [])
    expect(result).toContain("NOT been finalized")
    expect(result).toContain("no spec changes were saved")
  })

  // ─── Determinism ────────────────────────────────────────────────────

  it("is deterministic — same input always produces same output", () => {
    const response = "The spec is finalized and ready."
    const toolCalls: ToolCallRecord[] = []
    const r1 = verifyActionClaims(response, toolCalls)
    const r2 = verifyActionClaims(response, toolCalls)
    expect(r1).toBe(r2)
  })
})
