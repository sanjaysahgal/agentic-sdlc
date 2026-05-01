import { describe, it, expect } from "vitest"
import {
  PLATFORM_MESSAGE_PREFIX,
  PLATFORM_PREFIX_MARKER,
  FORBIDDEN_AGENT_PREFIXES,
} from "../../runtime/platform-message-prefix"

// Regression test for B10 (platform impersonates agent in third person).
//
// Bug surfaced 2026-04-30: re-escalation message at message.ts:1078 formatted
// as `*Product Manager* — Spec partially updated, but N gap remains. Say *yes*
// to bring the PM agent back.` Prefixes platform's text with agent name (as if
// PM said it) while content talks about PM in third person. Voice/perspective
// inconsistency. Same pattern existed in 5 other platform-composed messages
// in interfaces/slack/handlers/message.ts.
//
// Fix: shared constant runtime/platform-message-prefix.ts (PLATFORM_MESSAGE_PREFIX
// = `*Platform —*`) used as the prefix for every platform-composed notification.
// All 6 violation sites in interfaces/slack/handlers/message.ts converted to use
// the shared constant + bodies rewritten in platform voice ("we'll bring the PM
// agent back" instead of "Say yes to bring the PM back" — first-person platform,
// third-person agent reference is now unambiguous because the prefix is the
// platform's voice, not the agent's). Structural invariant
// tests/invariants/platform-message-prefix.test.ts scans all handler files and
// fails on any agent-name static prefix.

describe("bug #17 — platform-composed messages must not impersonate agents (manifest B10)", () => {
  it("structural assertion: PLATFORM_MESSAGE_PREFIX constant exists and is non-trivial", () => {
    expect(PLATFORM_MESSAGE_PREFIX.length).toBeGreaterThan(0)
    expect(PLATFORM_MESSAGE_PREFIX).toContain(PLATFORM_PREFIX_MARKER)
  })

  it("FORBIDDEN_AGENT_PREFIXES enumerates the canonical violation strings (the actual prefixes that existed pre-B10)", () => {
    // Each of these was used as a static prefix in at least one platform postMessage
    // before B10. The invariant test fires if any of them re-appear.
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*Product Manager*")  // was at lines 757, 779, 856, 873
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*UX Designer*")      // future-proofing
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*Designer*")         // was at line 1118 via interpolation
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*PM*")               // was at line 1132 via interpolation
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*Architect*")        // future-proofing
  })

  it("structural assertion: every platform notification site in message.ts uses PLATFORM_MESSAGE_PREFIX", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )

    // Constant imported from canonical module
    expect(source).toMatch(
      /import\s+\{\s*PLATFORM_MESSAGE_PREFIX\s*\}\s+from\s+["']\.\.\/\.\.\/\.\.\/runtime\/platform-message-prefix["']/,
    )

    // At least 6 usages (one per pre-B10 violation site)
    const usages = (source.match(/\$\{PLATFORM_MESSAGE_PREFIX\}/g) ?? []).length
    expect(usages).toBeGreaterThanOrEqual(6)
  })

  it("structural assertion: no agent-name static prefix survives in message.ts (the actual B10 retirement)", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )

    // The exact pattern that defined the violation: text: `<role>*` immediately
    // followed by a separator. If this regex finds anything, B10 has regressed.
    for (const prefix of FORBIDDEN_AGENT_PREFIXES) {
      const literalEsc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const re = new RegExp(`text:\\s*\`${literalEsc}\\s*[—-]`)
      expect(
        re.test(source),
        `[B10 REGRESSION] Found static agent-name prefix '${prefix}' in interfaces/slack/handlers/message.ts. Replace with \${PLATFORM_MESSAGE_PREFIX} from runtime/platform-message-prefix.ts and rewrite the body in platform voice.`,
      ).toBe(false)
    }
  })

  it("structural assertion: rewritten platform-voice bodies use first-person platform pronouns (we'll, not 'Say yes to bring the X back')", async () => {
    // The original bug was prose-vs-state mismatch — the prefix said one voice
    // ('Product Manager') and the body said another ('the PM agent'). The fix
    // rewrites bodies to be unambiguously platform-voiced. Pin the rewrite by
    // checking that re-escalation messages now use 'we'll bring' (platform 1st
    // person plural) instead of the bare 'bring the PM back' imperative that
    // could be read as the PM speaking about themselves.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )
    // Post-fix phrasing: "we'll bring the <X> agent back into this thread."
    // This is platform-voiced (we'll = platform first-person plural).
    expect(source).toMatch(/we'll bring the .* agent back into this thread/i)
    // Pre-fix bare imperative ("Say yes to bring the PM back") should be gone
    // from the re-escalation sites (it's allowed elsewhere, e.g. inside agent
    // prose, but not as a platform-composed notification body).
    expect(source).not.toMatch(/text:\s*`[^`]*Say \*yes\* to bring the PM back/)
  })
})
