# ADR-0001: Deterministic audits as primary gates

## Status

Accepted (codified as CLAUDE.md Principle 11, April 2026).

## Context

The platform's value proposition is that the same input always produces
the same audit findings. A user can ask an agent 10 times back to back
and must get identical results. A feature paused for months must surface
the same gaps when revisited.

In April 2026, `auditPhaseCompletion` with the `ARCHITECT_UPSTREAM_PM_RUBRIC`
evaluated the same approved PM spec on two consecutive runs. Run 1: found
a gap in AC#13. Run 2: `ready=true`, no gaps. The PM spec had not changed.
The architect's assessment of upstream readiness was non-deterministic —
the user could not trust it.

## Decision

Every audit that gates a decision or surfaces findings MUST be implemented
as a deterministic function: parsing, counting, string matching, diff
comparison. No LLM calls in the audit's primary path.

LLM-based evaluation may exist as a **secondary enrichment layer** that
surfaces additional findings beyond what the deterministic layer catches —
but it must never be the primary gate for any decision.

Every audit function declares its kind in JSDoc:
- `@deterministic` — pure function, no LLM, same input = same output
- `@enrichment` — LLM-assisted, not a primary gate

The PR-time gate `tests/invariants/determinism-tags.test.ts` enforces:
mutual exclusion (a module is one or the other), and `@deterministic`
modules cannot import `@anthropic-ai/sdk`.

## Consequences

**Positive:**
- Operators can trust that re-running an audit produces the same answer
- Backlog items don't silently disappear and reappear across sessions
- The "audit re-discovers the same gap forever" complaint is structurally
  retired

**Negative / tradeoffs:**
- Some semantic checks that LLMs handle naturally (e.g. "does this prose
  contradict the spec?") are harder to express deterministically
- Pure-function audits sometimes produce false positives that an LLM
  would suppress (mitigated by inline `audit-exception` markers)

**Reference implementations:** `runtime/deterministic-auditor.ts` (`auditPmSpec`,
`auditDesignSpec`, `auditEngineeringSpec`), `runtime/action-verifier.ts`,
`runtime/escalation-orchestrator.ts`. The enrichment counterpart is
`runtime/phase-completion-auditor.ts`.
