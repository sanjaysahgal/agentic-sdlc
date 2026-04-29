// Block B5 — cutover flag (the structural pin for Block E).
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`
// (Block B5, cutover gate). When this constant is flipped to `true`, the
// dispatcher routes traffic to the V2 single-path agent runners
// (`runArchitectAgentV2`, `runDesignAgentV2`, `runPmAgentV2`) instead of
// the legacy multi-exit handlers. The flip is the load-bearing event of
// Block E.
//
// The constant lives here (not in `process.env`) so the cutover state is
// auditable in version control, not in deploy configuration. The CI test
// at `tests/invariants/cutover-gate.test.ts` enforces: if this constant
// is `true`, every gating item in `docs/cutover-gate-status.json` must
// have status `done`. Merging a `true` flip while any gate is incomplete
// FAILS at PR time.
//
// Today: `false`. Block E flips this in lockstep with the manifest
// updates, the dispatcher wiring change, and the pre-cutover migration
// smoke (Block C2).

export const CUTOVER_ENABLED = false
