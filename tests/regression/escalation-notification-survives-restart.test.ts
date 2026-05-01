import { describe, it, expect, beforeEach, vi } from "vitest"

// Regression test for D5 (was Bug A): EscalationNotification must survive bot restart within TTL.
//
// Before D5 fix: conversation-store.ts:308-310 cleared ALL escalationNotifications on every
// startup unconditionally. This collided with J3 (CODE_MARKER bump on every production-wiring
// fix → required restart → in-flight escalation lost). User had to redo every escalation
// after every bot fix.
//
// After D5 fix: EscalationNotification carries a `timestamp` field (set by
// setEscalationNotification). startup uses clearStaleEntries() with PENDING_STATE_TTL_MS
// (24h) — same semantics as PendingEscalation/PendingApproval/PendingDecisionReview.
// Notifications within TTL survive restart; older ones get cleared.

describe("bug #11 — EscalationNotification survives bot restart within TTL (manifest D5, was Bug A)", () => {
  it("setEscalationNotification stamps a timestamp", async () => {
    const { setEscalationNotification, getEscalationNotification, clearEscalationNotification, disableFilePersistence } = await import("../../runtime/conversation-store")
    disableFilePersistence()
    const key = { product: "test", feature: "f1" }

    const before = Date.now()
    setEscalationNotification(key, {
      targetAgent: "pm",
      originAgent: "architect",
      question: "vague language in AC#1",
    })
    const after = Date.now()

    const got = getEscalationNotification(key)
    expect(got).not.toBeNull()
    expect(got!.timestamp).toBeDefined()
    expect(got!.timestamp!).toBeGreaterThanOrEqual(before)
    expect(got!.timestamp!).toBeLessThanOrEqual(after)

    clearEscalationNotification(key)
  })

  it("setEscalationNotification overrides any provided timestamp with current time", async () => {
    // Defensive: even if a caller tries to provide its own timestamp (e.g. replaying state),
    // setEscalationNotification stamps Date.now() so the TTL is measured from the actual write.
    const { setEscalationNotification, getEscalationNotification, clearEscalationNotification, disableFilePersistence } = await import("../../runtime/conversation-store")
    disableFilePersistence()
    const key = { product: "test", feature: "f2" }

    const yesterday = Date.now() - 24 * 60 * 60 * 1000 - 1000  // 24h+1sec ago = stale
    setEscalationNotification(key, {
      targetAgent: "pm",
      originAgent: "architect",
      question: "q",
      timestamp: yesterday,
    })

    const got = getEscalationNotification(key)
    expect(got).not.toBeNull()
    // Stamped fresh, NOT preserved from the input
    expect(got!.timestamp!).toBeGreaterThan(yesterday + 1000)

    clearEscalationNotification(key)
  })

  it("the in-memory notification carries the timestamp through round-trip via parseConversationState", async () => {
    // Verify the write/read cycle preserves the timestamp.
    const { parseConversationState } = await import("../../runtime/conversation-store")
    const stamped = Date.now() - 5 * 60 * 1000  // 5 min ago, well within TTL
    const persisted = JSON.stringify({
      escalationNotifications: {
        "test:f3": {
          targetAgent: "pm",
          originAgent: "architect",
          question: "q",
          timestamp: stamped,
        },
      },
    })
    const result = parseConversationState(persisted)
    const notif = result.escalationNotifications.find(([k]) => k === "test:f3")?.[1]
    expect(notif).toBeDefined()
    expect(notif!.timestamp).toBe(stamped)
  })

  it("structural assertion: clearStaleEntries is the startup mechanism for escalationNotifications (not unconditional clear)", async () => {
    // Read the source and assert the intended structure: clearStaleEntries(escalationNotifications, ...)
    // and NOT escalationNotifications.clear() at startup.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "runtime/conversation-store.ts"), "utf8")

    // The good pattern must be present
    expect(source).toMatch(/clearStaleEntries\(escalationNotifications,\s*"escalationNotification"\)/)

    // The legacy pattern (clear-all-on-restart for escalationNotifications) must NOT be present.
    // We look for `escalationNotifications.clear()` followed by NO comment marking it as part of
    // disableFilePersistence (the test helper). disableFilePersistence has its own `.clear()` calls
    // — those are legitimate. The startup-time clear-all that D5 retired must be gone.
    const startupClearPattern = /\[STORE\] startup: clearing \$\{escalationNotifications\.size\} stale escalation notification/
    expect(source).not.toMatch(startupClearPattern)
  })
})
