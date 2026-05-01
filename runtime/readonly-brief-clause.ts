/**
 * @deterministic — single-source-of-truth string constant for the read-only
 * agent contract. Manifest item B7 (regression catalog bug #15).
 *
 * Why this exists:
 * When the platform invokes PM/Designer/Architect with `readOnly: true` (no
 * spec-writing tools provided), the agent has no mechanism to apply changes —
 * it can only recommend. But nothing in the brief prompts told the agent that.
 * The agent would write prose like "Applying the patch to AC 10 now" or
 * "I'll update the product spec," contradicting the platform's truthful
 * "say *yes* to apply" message that follows. Same prose-vs-state mismatch
 * class as Block N2 — but at the brief-prompt layer, where the structural
 * fix is to declare the constraint up front, not at the runtime stripper.
 *
 * The clause must be present in EVERY brief that runs the agent in
 * `readOnly: true` mode. Per CLAUDE.md Principle 15 (cross-agent parity),
 * adding a new readOnly brief site requires injecting this clause AND
 * extending the structural invariant test that pins which briefs use it.
 */

export const READONLY_AGENT_BRIEF_CLAUSE = `READ-ONLY MODE — STRUCTURAL CONSTRAINT.
You have no spec-writing tools available in this conversation. The platform did not provide them. Your role is to give expert RECOMMENDATIONS that the human will review and confirm — you are not applying changes yourself.

Do not write phrases that imply you are performing an action:
- DON'T say: "Applying the patch to AC 10 now"
- DON'T say: "I'll update the product spec"
- DON'T say: "Saving the change"
- DO say: "My recommendation for AC 10: ..."
- DO say: "Recommend updating to ..."

The platform writes your confirmed recommendations to the spec AFTER the human says yes. You recommend; the platform applies. Phrasing that conflates the two is a contract violation.`

/**
 * Marker substring used by the structural invariant to detect the clause's
 * presence in any brief. Kept short and stable so a future re-wording of the
 * full clause body doesn't break the invariant — only renaming this marker
 * does. If you change the marker, update the invariant test in lockstep.
 */
export const READONLY_BRIEF_MARKER = "READ-ONLY MODE — STRUCTURAL CONSTRAINT."
