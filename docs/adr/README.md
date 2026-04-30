# Architecture Decision Records (ADRs)

> Block M2 of the approved system-wide plan
> (`~/.claude/plans/rate-this-plan-zesty-tiger.md`). One markdown file per
> non-trivial architectural decision, append-only after acceptance.

## When to write an ADR

Write an ADR when a decision:
- Establishes a project-wide invariant or principle
- Locks in a non-trivial design tradeoff (one-way door choices)
- Will outlive the immediate context that motivated it
- Will be referenced by future agents or contributors building related work

If the decision is purely tactical or scope-limited (a single bug fix, a
specific feature implementation), **don't** write an ADR — the commit
message and `SYSTEM_ARCHITECTURE.md` are the right places.

## File naming

`docs/adr/NNNN-kebab-case-title.md` — sequential 4-digit number, no
gaps. Bootstrapped at 0001.

## Required format

Every ADR must contain these section headers (the structural invariant
test `tests/invariants/adr-format.test.ts` enforces this):

```
# ADR-NNNN: Title
## Status
## Context
## Decision
## Consequences
```

`Status` must be one of: `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-NNNN`.

After acceptance, ADRs are append-only. To revise a decision, write a new
ADR that supersedes the old one — preserving the history.

## Index

- [ADR-0001](./0001-deterministic-audits-as-primary-gates.md) — Deterministic audits as primary gates (Principle 11)
- [ADR-0002](./0002-platform-enforcement-over-prompt-rules.md) — Platform enforcement over prompt rules (Principle 8)
- [ADR-0003](./0003-cross-agent-parity-required.md) — Cross-agent parity is structural (Principle 15)
