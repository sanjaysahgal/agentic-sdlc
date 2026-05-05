// B20 regression test — wrong-phase label in hold-pending-escalation message.
//
// Step 2a verification observation #12: when a queued escalation existed
// (targetAgent=pm, originAgent=architect) and the user sent a non-affirmative
// follow-up, the platform's hold message read "Design is paused — the PM
// needs to resolve a constraint" — wrong-phase label in an engineering-phase
// channel. A user-visible Principle 17 violation. Pre-B20 the originPhase
// derivation was based on `targetAgent` and only handled 2 cases (design vs
// anything-else, defaulting to "Design"). Architect→PM (targetAgent=pm)
// fell into the default "Design" branch.
//
// Fix shape: derive originPhase from `originAgent` (which is already on
// pendingEscalation per the bug #10 fix). Mapping: pm→Product,
// ux-design→Design, architect→Engineering.
//
// This test pins the derivation by structural inspection of message.ts —
// catches regression at PR time without standing up the full Slack
// dispatcher integration shape.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const MESSAGE_TS = resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts")

describe("B20 — hold-pending-escalation message uses originAgent for phase label (regression)", () => {
  const source = readFileSync(MESSAGE_TS, "utf8")

  it("does NOT contain the pre-B20 buggy mapping (targetAgent === 'design' ? 'Engineering' : 'Design')", () => {
    // The buggy ternary maps every non-design target to 'Design' — wrong for architect→PM.
    // Pre-B20 line 496-497 had this; if it reappears, the bug class returned.
    const buggyPattern = /universalPending\.targetAgent === "design"\s*\?\s*"Engineering"\s*:\s*"Design"/
    expect(source).not.toMatch(buggyPattern)
  })

  it("derives originPhase from originAgent with all three agent mappings present", () => {
    // The fix maps each known origin agent to its phase label. All three
    // mappings must be present and use the originAgent field.
    expect(source).toMatch(/universalPending\.originAgent === "pm"\s*\?\s*"Product"/)
    expect(source).toMatch(/universalPending\.originAgent === "ux-design"\s*\?\s*"Design"/)
    expect(source).toMatch(/universalPending\.originAgent === "architect"\s*\?\s*"Engineering"/)
  })

  it("the [ROUTER] universal-guard log line includes originAgent + originPhase fields for diagnosis", () => {
    // Without these fields in the log line, the bug would have been invisible —
    // operators would only see targetAgent and not realize originAgent was the
    // missing data point. Pin the log shape to keep diagnostic surfaces complete.
    expect(source).toMatch(/\[ROUTER\] universal-guard:.*originAgent=\$\{universalPending\.originAgent\}.*originPhase=\$\{originPhase\}/)
  })

  it("the user-visible hold-message text uses originPhase variable (not a hard-coded label)", () => {
    // The post-fix text template must use the computed originPhase, not a
    // literal "Design" or "Engineering" string. If anyone hard-codes a
    // phase label (defeating the whole fix), this catches it.
    expect(source).toMatch(/text:\s*`\$\{originPhase\} is paused — the \$\{holderName\} needs to resolve a constraint/)
  })
})
