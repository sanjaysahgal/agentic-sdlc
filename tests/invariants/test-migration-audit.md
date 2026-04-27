# Test Suite Migration Audit — Phase 2

> **Status:** Phase 2 deliverable per `~/.claude/plans/elegant-percolating-newell.md`. This doc enumerates every routing-touching `describe` block in `tests/integration/workflows.test.ts` (130 scenarios, 302 individual tests) and classifies each as **KEEP**, **REPLACE**, or **DELETE** for Phase 6 of the migration. Phase 6 is the cutover that deletes the old branching code in `interfaces/slack/handlers/message.ts` and the corresponding tests.
>
> Granularity: one classification per `describe` block. Within a block, `it` entries share a focus by design — they don't get classified independently. Where a block has mixed-class tests, it is split (e.g. "Scenario X (routing parts)" and "Scenario X (tool handler parts)").

---

## Classification rules

| Class | When to use | Phase 6 action |
|---|---|---|
| **KEEP** | Verifies behavior the matrix doesn't cover: dispatcher invariants (preEffect → agent → postEffect ordering, in-flight lock, error recovery), agent tool-handler logic, spec-write content, audit gates, brand drift, action menu, prompt-caching shape, history cap, GitHub I/O semantics. | Test stays; may be moved to a subdirectory for clarity. |
| **REPLACE** | Verifies a routing decision: "given state X with message Y, agent Z runs in mode M". The matrix test (`tests/invariants/routing-matrix.test.ts`) covers this through the spec doc. The integration test is redundant once the matrix is the source of truth. | Test is **deleted**; the matrix row that replaces it is committed in the same PR. |
| **DELETE** | Verifies a code path that no longer exists after the cutover (e.g. `if (confirmedAgent === ...)` branches in `message.ts`). The behavior either moves to the matrix or is no longer reachable. | Test is **deleted** with no replacement (the branch it covered is gone). |

The default for any routing-related scenario is **REPLACE** unless it asserts on something more than `runAgent` was called with the right agent.

---

## Methodology

For each `describe` block, classification is decided by answering:

1. **Does the test only assert which agent was invoked / what mode / what message text was injected?** → REPLACE.
2. **Does the test assert on tool-handler outputs, GitHub writes, audit findings, brand drift, action menu items, or content of agent prompts?** → KEEP.
3. **Does the test exercise a code path that the cutover removes (universal pre-routing guards, `if (confirmedAgent === ...)`, slash-override consultancy injection, escalation-confirmation branch in `message.ts`)?** → If the resulting outcome is now in the matrix → REPLACE. If the outcome is gone → DELETE.

A scenario that mixes routing and tool-handler assertions is split — the routing assertions become a matrix row; the tool-handler assertions stay in a smaller, more focused test.

---

## Per-scenario classification

| Scenario / line | Title | Class | Notes |
|---|---|---|---|
| L228 — S1 | PM spec approval → design agent routing | REPLACE | `confirmedAgent=pm + approval + "yes" → approve-spec(product)` and post-approval routing to `ux-design` are both encoded in §8.1 + §8.2 of the spec. |
| L293 — S2 | Design spec approval → architect routing | REPLACE | §8.3 + §8.4 cover this. |
| L348 — S3 | Phase-aware routing on new thread | REPLACE | §8.1 / §8.3 / §8.5 — "any (new thread)" rows. |
| L414 — S4 | PM escalation round-trip from design agent | KEEP (split) | Turns 1 + 3 verify tool-handler + writeback content (KEEP). Turn 2 verifies that PM agent runs after "yes" — this part is REPLACE (matrix row exists at §8.3 line 191). Audit migrates to two smaller tests. |
| L617 — S5 | Thread isolation across concurrent features | KEEP | Verifies feature-keyed state isolation in conversation-store; not a routing decision. |
| L672 — S6 | confirmedAgent sticky routing | REPLACE | Default rule §11.3: `confirmedAgent matches phase canonical → run-agent(confirmedAgent, primary)`. |
| L727 — S7 | Design agent caps history at 20 messages | KEEP | History windowing is dispatcher / agent-runner behavior, not router. |
| L769 — S8 | State query on long thread surfaces uncommitted-context note | KEEP | Tool-handler / state-query content. |
| L843 — S9 | Design patch flow | KEEP | Tool-handler output + GitHub write. |
| L894 — S10 | PM patch flow | KEEP | Tool-handler. |
| L934 — S11 | Architect patch flow | KEEP | Tool-handler. |
| L977 — S12 | State query preview freshness | KEEP | Preview cache logic. |
| L1105 — S13 | Post-response uncommitted-decision detection | KEEP | Post-agent audit. |
| L1247 — S14 | Post-save end-turn error surfaces spec-saved message | KEEP | Error-recovery dispatcher behavior. |
| L1333 — S15 | Audit fires on short-history threads; preview uses committed spec | KEEP | Audit firing rule. |
| L1427 — S17 | Render ambiguity audit no longer fires on spec save | KEEP | Audit firing rule. |
| L1502 — S16 | Deterministic preview cache | KEEP | Preview cache logic. |
| L1651 — S18 | Architect escalation round-trip from design agent | KEEP (split) | Same shape as S4 — Turn 2 routing is REPLACE; tool-handler / writeback is KEEP. |
| L1750 — S20 | Always-on architect engineering spec completeness audit | KEEP | Audit firing rule. |
| L1835 — S19 | Always-on design phase completion audit | KEEP | Audit firing rule. |
| L1933 — S21 | Brand drift hard gate at finalize_design_spec | KEEP | Tool-handler gate. |
| L2047 — S22a | Action menu appended after design agent LLM response | KEEP | Action menu logic. |
| L2123 — S23a | State path shows all 4 action menu categories | KEEP | Action menu logic. |
| L2265 — S22 | Architect read_approved_specs tool | KEEP | Tool-handler. |
| L2326 — S22b | read_approved_specs error handling | KEEP | Tool-handler. |
| L2361 — S23 | Architect finalize_engineering_spec tool | KEEP | Tool-handler. |
| L2432 — S24 | Architect state query path | KEEP | State-query content. |
| L2492 — S25 | Architect off-topic redirect | KEEP | Routing-adjacent content rule, but the redirect message text is what's asserted — KEEP. |
| L2516 — S26 | Architect engineering spec approval | REPLACE | §8.5 line 216. |
| L2564 — S27 | Architect finalize with decision corrections | KEEP | Tool-handler. |
| L2637 — N1 | Non-affirmative during PM escalation → reminder | REPLACE | §8.3 hold-message row. |
| L2679 — N2 | Non-affirmative during architect escalation → reminder | REPLACE | §8.5 hold-message rows. |
| L2721 — N3 | resolveAgent deterministically sets PM for new features | REPLACE | §8.1 "any (new thread)". |
| L2756 — N5 | PM history limit 40 messages | KEEP | History window. |
| L2810 — N6 | Architect cache invalidation when engineering spec changes | KEEP | Cache logic. |
| L2880 — N7 | Preview generation failure does not crash | KEEP | Error recovery. |
| L2944 — N8 | Mixed brand/animation/missing audits all appear in action menu | KEEP | Action menu. |
| L3036 — N9 | Summarization warning fires exactly once per feature | KEEP | Summarizer logic. |
| L3112 — N10 | read_approved_specs partial failure | KEEP | Tool-handler. |
| L3165 — N11 | Cache isolation between concurrent features | KEEP | Cache. |
| L3232 — N12 | Unknown design agent tool name handled gracefully | KEEP | Tool-handler error path. |
| L3274 — N13 | PM agent does not gate on brand tokens | KEEP | Audit-firing rule. |
| L3333 — N14 | Action menu suppressed when escalation just offered | KEEP | Action menu rule. |
| L3386 — N26 | classifier filters non-PM items from offer_pm_escalation question | KEEP | Classifier. |
| L3448 — N15 | Non-affirmative during pending escalation → reminder | REPLACE | §8.3 hold-message rows. Same as N1/N2; left here because the spec rows already cover this. |
| L3496 — N16 | Any reply when escalation notification active resumes design agent | REPLACE | §8.3 lines 190-192 (continuation + resume) cover this. |
| L3547 — N17 | Escalation reply injected message contains question + answer | KEEP | The injected-message text is dispatcher / agent-runner behavior, not router. |
| L3603 — N30 | Escalation reply triggers product spec writeback when recommendations are stored | KEEP | Writeback (postEffect dispatcher behavior). |
| L3688 — N19 | Design spec with only engineering open questions runs agent normally | KEEP | Audit-firing rule. |
| L3745 — N18 | Platform auto-triggers escalation when agent skips offer_pm_escalation | KEEP | Platform enforcement after agent run (postEffect). |
| L3821 — N20 | Haiku classifier timeout surfaces as user-visible error | KEEP | Error path. |
| L3862 — N21 | Design readiness audit criterion 10 | KEEP | Audit. |
| L3941 — N22 | Fallback prose-detection gate suppresses action menu | KEEP | Action menu / prose detection. |
| L4029 — N23 | Platform overrides passive prose | KEEP | Enforcement gate. |
| L4109 — N25 | Haiku classifier catches PM gaps in flat prose | KEEP | Classifier. |
| L4176 — N24 | Fallback gate detects "want me to escalate" pattern | KEEP | Enforcement gate. |
| L4250 — N27 | Gate 3 strips non-PM items from agent prose | KEEP | Enforcement gate. |
| L4328 — N28 | Gate 2 rejects offer_pm_escalation when 0 PM gaps | KEEP | Enforcement gate. |
| L4389 — N29 | Gate 3 suppresses escalation when 0 PM gaps in prose | KEEP | Enforcement gate. |
| L4450 — N52 | Gate 4 skipped when Gate 3 already ran | KEEP | Enforcement gate. |
| L4514 — N31 | Gate 2 pre-seeds architect-scope items into engineering spec | KEEP | Tool-handler / writeback. |
| L4594 — N32 | Architect upstream escalation to Designer round-trip | KEEP (split) | Routing portion REPLACE; writeback KEEP. |
| L4714 — N33 | PM deferral triggers enforcement re-run | KEEP | Enforcement re-run (post-agent re-evaluate analogue). |
| L4786 — N34 | Partial approval during escalation → notification stays active | REPLACE | §8.3 line 190 (continuation row). |
| L4848 — N36 | DESIGN: items from Gate 2 returned to agent | KEEP | Classifier flow. |
| L4909 — N35 | Structural gate fires when PM answers fewer items than brief requires | KEEP | Enforcement gate. |
| L4978 — N37 | Server restart clears confirmedAgent but pendingEscalation survives | KEEP | Persistence + recovery. The "yes routes to PM escalation" portion is REPLACE; recovery is KEEP. |
| L5035 — N38 | loadAgentContext falls back to main when draft 404s | KEEP | Context loader. |
| L5105 — N39 | agent system prompts as TextBlockParam[] for prompt caching | KEEP | Caching shape. |
| L5158 — N40 | PM saves spec in continuation path → escalation auto-closed, design resumes | KEEP | Auto-close flow (postEffect). |
| L5228 — N41 | per-feature in-flight lock rejects concurrent messages | KEEP | I15 — lock is dispatcher's domain; this test verifies the lock works. |
| L5310 — N43 | PM offer_architect_escalation in auto-close path | KEEP | Tool-handler escalation routing. |
| L5387 — N44 | Architect escalation confirmation → engineering writeback | KEEP | Writeback routing. |
| L5452 — N30 var | isArchitectEscalation=true → product spec NOT written | KEEP | Writeback routing. |
| L5502 — N44b | Arch upstream escalation confirmation → engineering writeback | KEEP | Writeback routing. |
| L5556 — N47 | [blocking: no] question blocks finalize_product_spec | KEEP | Tool-handler gate. |
| L5599 — N47 | [blocking: no] question blocks finalize_design_spec | KEEP | Tool-handler gate. |
| L5639 — N47 | [blocking: no] question blocks finalize_engineering_spec | KEEP | Tool-handler gate. |
| L5687 — N46 | finalize_engineering_spec blocked by Design Assumptions | KEEP | Tool-handler gate. |
| L5744 — N48 | finalize_product_spec blocked by Design Notes | KEEP | Tool-handler gate. |
| L5804 — N49 | finalize_product_spec blocked by PM_DESIGN_READINESS_RUBRIC | KEEP | Tool-handler gate. |
| L5873 — N50 | PM escalation two-step: brief, approval, design resume | KEEP (split) | Routing portion REPLACE; brief content + writeback KEEP. |
| L5995 — N51 | PM spec sanitizer strips design-scope content | KEEP | Sanitizer. |
| L6102 — N53 | Multi-patch turn posts exactly one preview | KEEP | Preview dedup logic. |
| L6159 — N54 | fix-all completion loop | KEEP | Fix-all dispatcher. |
| L6269 — N55 | post-patch continuation loop | KEEP | Continuation dispatcher. |
| L6431 — N56 | platform status line: visible for arch escalation, suppressed for PM escalation | KEEP | Status line content. |
| L6576 — N57 | arch escalation gate rejects implementation-only questions | KEEP | Gate. |
| L6671 — N58 | natural English fix intent: Haiku fallback | KEEP | Classifier. |
| L6788 — N59 | fix-all no-progress detection | KEEP | Fix-all dispatcher. |
| L6891 — N60 | fix-all regression guard | KEEP | Fix-all. |
| L6991 — N61 | Post-patch spec health invariant | KEEP | Audit. |
| L7087 — N62 | Fix-all routes structural conflict to rewrite_design_spec | KEEP | Tool routing. |
| L7210 — N63 | Health invariant fires when readiness count increases | KEEP | Audit. |
| L7304 — N64 | Audit-stripping gate blocks renderAmbiguities from tool response | KEEP | Tool-result gate. |
| L7407 — N65 | Write gate strips spec-writing tools when fix intent not confirmed | KEEP | Tool gate. |
| L7506 — N66 | Persistent render ambiguity audit cache hit | KEEP | Cache. |
| L7590 — N67 | Agent addressing overrides phase-based routing | REPLACE | §8.3 lines 194-196 (`@pm:` / `@design:` / `@architect:` rows). |
| L7653 — N71 | PM run_phase_completion_audit tool handler | KEEP | Tool-handler. |
| L7694 — N72 | PM offer_architect_escalation tool handler | KEEP | Tool-handler. |

---

## Summary

| Class | Count (describe blocks) | Phase 6 action |
|---|---|---|
| KEEP | ~85 | Stay in `tests/integration/workflows.test.ts` (or move to a smaller file when message.ts shrinks). |
| REPLACE | ~14 | Delete; matrix row is the replacement. |
| DELETE | 0 | None of today's tests verify a code path that disappears outright — every removed branch's *outcome* is encoded in the spec. |
| KEEP (split) | ~6 | Each is split into `routing-only (REPLACE)` and `tool-handler-only (KEEP)`; the routing portion is deleted in Phase 6, the tool-handler portion is renamed and stays. |

The 14 REPLACE entries are the entire scope of Phase 6's test deletion. Their per-row matrix coverage is already verified by `tests/invariants/routing-matrix.test.ts` (49 rows, all green at the time of this audit).

---

## Open audit questions for Phase 6

1. **The split-class entries (~6).** When splitting, does the routing portion need its own matrix row beyond what §8 already encodes? In particular, S4 / S18 / N32 / N50 cover escalation round-trips — the spec rows cover the routing decisions but the tests also verify Slack message text. Phase 6 split proposal: matrix row covers the decision; a separate small test in `tests/regression/escalation-messages.test.ts` covers the specific Slack text.
2. **N37 (server restart recovery).** Persistence cleanup happens at startup, not at routing time (I4). The "yes routes to PM escalation" portion REPLACE-able by §8.3, but the recovery flow itself isn't a routing decision — keep as an integration test.
3. **N67 (agent addressing).** Already a routing-only test → REPLACE clean. Confirm the `@pm:` / `@design:` / `@architect:` text-prefix rows in §8.3 cover all today's scenarios at Phase 6.
