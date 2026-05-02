# BLOCK_E_FOCUS — what's next on the path to M0

**Read this at every session start.** Single source of truth for the next concrete work toward M0 (Block E cutover + onboarding ships clean via 4-agent orchestration).

This file is auto-loaded into the assistant's context the same way CLAUDE.md is. Updated whenever a manifest item ships.

---

## Current step: **Step 1 — Reconciliation commit**

The single canonical plan lives at `~/.claude/plans/humble-squishing-starlight.md` (rated by user; structurally enforced via Principle 18 + pre-commit hooks).

Manifest-tracked single source of truth: `docs/cutover-gate-status.json`. Run this to see M0-required items not yet `wired-and-exercised`:

```bash
jq -r '.items[] | select(.m0_required == true) | select(.verification != "wired-and-exercised") | "\(.id) [\(.status)/\(.verification)] \(.title)"' docs/cutover-gate-status.json
```

---

## Next 5 manifest items blocking M0 (ordered by dependency)

1. **A4** — wire `runArchitectAgentV2` to handle real production traffic (currently shadow-only). Status: `done/infrastructure-only` — V2 runner exists but legacy still handles all real architect traffic. Cutover threshold = 48h burn-in green.

2. **A5 + A6 + A7** — complete the in-flight 48h burn-ins (MT-4 architect, MT-5 designer, MT-6 PM). Status: `burn-in/burn-in`. User runs the agent scenarios in real Slack; metrics auto-collect.

3. **B13** — readiness aggregator must include upstream findings. Fix in `runtime/readiness-builder.ts` so V2's state-query response and V2's finalize-gate decision derive from the SAME canonical SSOT (Principle 17 enforced structurally). Status: `pending/pending`. Retired by V2 cutover but the SSOT itself needs to query upstream specs.

4. **O1 + O2 + O3 + O4 + O5** — Block O orchestration continuity. PM → Designer → Architect → finalize works end-to-end without user nudges between phases. Status: all `pending/pending`. Net new platform behavior. Each one closes one of the 5 orchestration gaps surfaced during the integration walks.

5. **B14 + B15 + B16** — auditEngineeringSpec detects B8 residue, applySpecPatch supports section-remove, architect prose-vs-tools reconciliation. Status: all `pending/pending`. Required for clean spec lifecycle on V2.

After these: **C3** (nightly E2E smoke), **F1** (delete legacy handlers), then the **onboarding integration walk on V2** lands the 3 crisp specs and closes M0.

---

## What's NOT in scope for M0 (deferred to M1+)

Per user explicit priority + the canonical plan:

- **K1-K6** (multi-tenant scale-out) — single-tenant only at M0
- **H1-H5** (LLM evals + prompt drift) — manual MTs cover regression detection at M0 scale
- **G2-G5** (observability nice-to-haves) — basic logging works for M0
- **L1, L4, L5** (backup-restore tested, admin audit log, GDPR offboarding) — operational hygiene
- **M3-M5** (operator runbook, customer onboarding doc, contribution guide) — documentation
- **C1, C2, C4** (multi-tenant parallel run, pre-cutover migration smoke, real-fixture producer tests) — rigor; absence creates short-feedback-loop risk during M0 walk

Each deferred item has rationale in `docs/cutover-gate-status.json` (`m0_required: false`) and in BACKLOG.md "Post-M0 (M1+)" section.

---

## Hard rules for any work session (drift prevention)

Per CLAUDE.md Principle 18:

- **No edits to legacy handler files** (`interfaces/slack/handlers/message.ts`, `agents/architect.ts`, `agents/design.ts`, `agents/pm.ts`) without `LEGACY-FIX-JUSTIFIED:` in the commit message. Pre-commit hook enforces.
- **No new B-items** (or any new manifest items) without `retired_by_v2_cutover: <true|false|partial>` field set. Pre-commit hook enforces.
- **Manual testing of legacy paths is suspended** until Block A cutover. See `MANUAL_TESTS_PENDING.md` banner.
- **Single nomenclature:** Block letter + item ID per `docs/cutover-gate-status.json`. No Phases, no Bugs A-G, no Steps 1-10, no S0-S6 sequences.

---

## How to know M0 is DONE

When this query returns empty:

```bash
jq -r '.items[] | select(.m0_required == true) | select(.verification != "wired-and-exercised") | .id' docs/cutover-gate-status.json
```

AND the onboarding feature has 3 crisp specs on main (zero deterministic findings on each), AND all 24 MT scenarios pass.

Then: M0 complete. Promote `F2` (Coder agent) to active priority for M1.
