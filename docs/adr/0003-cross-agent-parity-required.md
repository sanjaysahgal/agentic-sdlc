# ADR-0003: Cross-agent parity is structural

## Status

Accepted (codified as CLAUDE.md Principle 15, April 2026).

## Context

When an enforcement mechanism (writeback, gate, audit, closure message,
prompt rule) exists in one agent's path, the same mechanism must exist in
EVERY analogous path across all agents. Without this rule, drift between
agents is structurally guaranteed: a fix lands in one path, the analogous
paths in other agents quietly diverge.

April 2026 incident: the architect→PM escalation confirmation path was
built without `patchProductSpecWithRecommendations`. The design→PM path
had it. The PM said "I'll apply that now" and the user confirmed, but the
product spec was never updated. The same writeback existed 200 lines
above in the design path — it was never ported.

## Decision

When a new agent is added or an existing path is modified, the commit
MUST include the same mechanism in every analogous path. The pre-commit
hook `[ESCALATION WRITEBACK GATE]` counts reply paths vs writeback calls
and blocks if they don't match.

This rule applies to:
- **Writebacks**: spec patches, state mutations
- **Gates**: pre-run audits, post-run validators
- **Closures**: confirmation messages, finalization handoffs
- **Prompt rules**: shared blocks injected into all agent prompts (e.g.
  the anti-deferral block from Block N — `buildAntiDeferralBlock` is the
  single source of truth, injected into PM, Designer, Architect prompts;
  cross-agent invariant test enforces parity)
- **Runtime helpers**: `enforceNoHedging` is the single shared rewriter
  used at all 3 agent post-run sites — not duplicated inline

## Consequences

**Positive:**
- Adding a new agent is a structural exercise: reuse the shared helpers
  and prompt blocks rather than re-derive them
- Drift between agents is structurally impossible for the mechanisms
  covered by cross-agent invariant tests

**Negative / tradeoffs:**
- Some agent-specific divergences are legitimate (e.g. PM has no
  upstream gate, only PM agent uses `[type: product]` markers) — these
  are documented as exceptions in the relevant invariant tests rather
  than blanket-allowed
- The rule requires every new mechanism to enumerate its analogous paths
  upfront — additional design discipline at PR time

**Reference enforcement:** `tests/invariants/anti-deferral-prompt-contract.test.ts`,
`tests/invariants/upstream-notice-contract.test.ts`,
`tests/invariants/response-path-coverage.test.ts`, the `[ESCALATION WRITEBACK GATE]`
pre-commit hook.
