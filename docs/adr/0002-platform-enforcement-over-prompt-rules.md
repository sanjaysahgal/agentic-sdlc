# ADR-0002: Platform enforcement over prompt rules

## Status

Accepted (codified as CLAUDE.md Principle 8, April 2026).

## Context

Prompt rules are probabilistic. The model can ignore them, reinterpret
them, or deprioritize them under competing instructions. A behavior that
"usually works" is not a behavior we can ship. If the system's correctness
depends on the model reading an instruction and choosing to comply, it
fails in production.

Multiple production bugs traced to prompt-only enforcement: escalation
gates that the model skipped, brand drift the prompt asked agents to flag
but they didn't, finalization that the prompt told agents not to do but
they did anyway under user pressure.

## Decision

Every agent behavior that must reliably occur MUST be enforced by the
platform, not instructed in a prompt. Concretely:

1. **The decision gate** — before writing any code that governs agent
   behavior, ask: does this need to happen reliably (not just usually)?
   Can the platform detect whether it happened? If both: implement the
   platform check first; the prompt instruction is a redundant backup.

2. **What "platform enforcement" means** — after the agent runs, the
   platform reads state and verifies the required behavior occurred. If
   it didn't, the platform corrects it (overrides the response, sets
   state, triggers the right path) regardless of what the agent said.

3. **Output contract rule (Principle 8a)** — verify presence of required
   output. Never detect absence of good output by matching bad text.
   Text-pattern gates are always incomplete. A structural gate that
   verifies the required format is present catches refusals,
   clarification-stalls, partial answers, hallucinations, tangents.

## Consequences

**Positive:**
- Behaviors degrade gracefully when the model regresses or a model upgrade
  shifts behavior — the platform still corrects
- The contract is explicit and inspectable in code
- New agents start from "what does the platform enforce?" rather than
  "what does the prompt say?"

**Negative / tradeoffs:**
- Higher implementation cost — each enforcement is structural code, not a
  one-line prompt addition
- Some behaviors are genuinely hard to enforce structurally (e.g. tone,
  conversational quality) — these remain prompt-dependent and are
  explicitly documented as such

**Reference implementations:** `enforceNoHedging` (Block N), the
escalation-offer auto-trigger gate at the design agent's post-run path,
the brand-finalization gate, the approval gate that clears
`pendingApproval` before saving. Self-rating discipline (memory:
`feedback_self_rating.md`) requires every code change to enumerate which
behaviors are platform-enforced and which are prompt-dependent with
justification.
