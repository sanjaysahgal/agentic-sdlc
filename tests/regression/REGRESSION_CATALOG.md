# Regression Catalog

> Block I3 of the approved system-wide plan
> (`~/.claude/plans/rate-this-plan-zesty-tiger.md`). Single source of truth
> for which historical production bugs have a regression test pinning their
> fix. The structural invariant at
> `tests/invariants/regression-catalog.test.ts` enforces bidirectional
> consistency: every row here must have a matching `describe("bug #N — …")`
> block in the listed file, and every such describe block in
> `tests/regression/` must appear here.
>
> This catalog is *additive*. When a new production bug is fixed, the same
> commit that fixes it adds: (1) a new `describe("bug #N — …")` block in
> the appropriate `tests/regression/<topic>.test.ts` file (create one if
> the topic is new), (2) a new row below. Failing to do both is caught at
> PR time by the structural invariant.
>
> Format: each row is `| #N | one-line description | tests/regression/<file>.test.ts |`.
> The test file column is enforced verbatim — relative path from repo root.

| Bug | Description | Test file |
|---|---|---|
| #1 | Fast-path early returns only appended assistant message, skipping the user message — next API call had consecutive `[assistant, assistant]` and 400'd | tests/regression/history-integrity.test.ts |
| #2 | `appendMessage(user)` was called BEFORE `runAgent`; if `runAgent` threw, the user message was orphaned in history | tests/regression/history-integrity.test.ts |
| #3 | Corrupted history (leading assistant from bug #1) caused every subsequent API call to fail until the thread was abandoned | tests/regression/history-integrity.test.ts |
| #4 | `isSpecStateQuery` false positive: "yes please and I assume you will base it exactly on how our spec is written today?" was misclassified as a state query because it contained the word "spec" | tests/regression/approval-detection.test.ts |
| #5 | `isSpecStateQuery` false positive: "lets lock option A" was misclassified as a state query and triggered the fast-path read-only branch | tests/regression/approval-detection.test.ts |
| #6 | Premature spec approval: a text-only agent response was treated as approval intent and saved the spec without explicit user confirmation | tests/regression/approval-detection.test.ts |
| #7 | `withThinking` silently swallowed `chat.update` failures, leaving users with a permanent "thinking..." placeholder | tests/regression/error-recovery.test.ts |
| #8 | Blocking gate: PM agent saved spec even when `[blocking: yes]` questions remained unresolved | tests/regression/error-recovery.test.ts |
| #9 | Gap detection: the gap question must be persisted to conversation history so the next turn has the context to fix it | tests/regression/error-recovery.test.ts |
| #10 | PendingEscalation lacked `originAgent`, so architect→PM escalations were silently routed to designer (router guessed `targetAgent === "design" ? "architect" : "ux-design"`). Fixed by making `originAgent` a required field and reading it directly in the router. | tests/regression/origin-agent-routing.test.ts |
| #11 | EscalationNotification was unconditionally cleared on every bot startup at conversation-store.ts:308-310. Collided with J3 CODE_MARKER bump enforcement: every production-wiring fix → required restart → in-flight escalation lost. Fixed by adding `timestamp` to `EscalationNotification` (set by `setEscalationNotification`) and replacing clear-all with `clearStaleEntries` using the same `PENDING_STATE_TTL_MS` (24h) as the other pending state. Manifest D5. | tests/regression/escalation-notification-survives-restart.test.ts |
| #12 | PM in escalation-resume mode hallucinated AC numbers — cited "AC 27" when the product spec only had 25 ACs. Wrong AC# would have flowed straight into the spec patcher and corrupted the spec; user was the only line of defense (violates Principle 7). Fixed by adding deterministic `runtime/spec-content-verifier.ts` (pure, no LLM) that detects two classes of hallucination — `ac-does-not-exist` and `claimed-wording-not-in-ac` — and wiring it log-only into the PM escalation-resume response site at `interfaces/slack/handlers/message.ts`. v1 is detection + log; v2 will add re-prompt and downstream patcher gating. Manifest B11. | tests/regression/spec-content-hallucination-detection.test.ts |
| #13 | Architect's `offer_upstream_revision(target=pm)` enumerated only 1 of N gaps that `auditPmSpec` detected on the approved PM spec — the remaining N-1 were silently dropped from `pendingEscalation.question`. The deterministic re-audit caught them on the next round-trip, costing the user N round-trips for what should be one. Fixed by adding deterministic count helpers `countPlatformGapItems` and `countAgentGapItems` to `runtime/upstream-notice-format.ts`, plus a post-run consolidation gate at `interfaces/slack/handlers/message.ts` (architect path) that compares the agent's enumeration against the platform's count and overrides `pendingEscalation.question` with the consolidated brief from `parsePmGapText` / `parseDesignGapText` when the agent enumerated fewer items. Both PM and design targets covered per Principle 15 cross-agent parity. Manifest B6. | tests/regression/architect-escalation-consolidation.test.ts |
