# Pending manual tests

> The current list of MT-N scenarios that need running in real Slack
> against the current bot. Each entry was added when a production-wiring
> commit shipped that needs operator verification (per CLAUDE.md
> manual-test checkpoint discipline).
>
> When you finish running a scenario:
>   - PASSED: `npx tsx scripts/mt.ts done MT-N`
>   - FAILED: leave it pending and tell the assistant what failed
>
> **Two tiers** (introduced 2026-04-30 after the value-of-MT discussion):
>
> - `## Blocking pre-push` — the pre-push hook blocks pushes while this
>   section is non-empty. Use this tier when the MT verifies a behavior
>   that automated tests provably cannot exercise (real LLM compliance
>   with prompt rules, real bot restart, real Slack rendering).
> - `## Spot-check during integration walk` — these are tracked but do
>   NOT block push. Use this tier when integration coverage already
>   exercises the wiring end-to-end with mocks and the only marginal
>   verification a real-Slack run adds is a 60-second smoke check.
>   These get done opportunistically the next time you walk a feature
>   through the relevant phase.
>
> **Default tier:** Blocking. Move to spot-check ONLY when integration
> tests demonstrably cover the path end-to-end and the LLM/IO layer
> isn't the source of risk. Document the rationale in the entry.
>
> The Stop-event hook prints the count of blocking entries at the end of
> every turn so neither side forgets.

## Blocking pre-push

### MT-7 — Hedge gate live in production (Block N enforceNoHedging)

- Added by commit: `b914a28` (Block N: hedge gate rewriter + cross-agent prompt contract)
- Why blocking: real-LLM compliance with prompt rules cannot be synthesized by mocks. The unit test verifies `enforceNoHedging` rewrites correctly; only real Slack proves the rewritten output renders as intended in production.
- Full scenario: see `MANUAL_TESTS.md` MT-7

### MT-8 — Anti-deferral block in agent prompts (Block N buildAntiDeferralBlock)

- Added by commit: `b914a28` (same as MT-7)
- Why blocking: real LLM must actually obey the prohibition; unit tests verify the block is INJECTED into the prompt, not that the model honors it. Mocks cannot verify model compliance.
- Full scenario: see `MANUAL_TESTS.md` MT-8

### MT-16 — Tool-name + platform-commentary stripper sentence-drop (Block N2)

- Added by commit: `ad8132c` (Block N2: sentence-drop)
- Why blocking: stripper drops whole sentences containing tool references. Edge cases — multi-clause sentences mixing legitimate content with the offending token, sentence-end punctuation variations, code blocks, Slack markdown — only surface in real-LLM Slack runs. Mocks cannot synthesize realistic agent prose.
- Full scenario: see `MANUAL_TESTS.md` MT-16

### MT-18 — EscalationNotification survives bot restart within TTL (D5 fix)

- Added by commit: `a5f8eaf` (D5 fix)
- Why blocking: integration tests cannot simulate a real process restart with on-disk persistence. The fix relies on `clearStaleEntries` running at startup and `timestamp` surviving the JSON round-trip — only a real `kill -9` + restart proves both ends.
- Full scenario: see `MANUAL_TESTS.md` MT-18

## Spot-check during integration walk

### MT-17 — Architect→PM escalation resumes to architect (bug #10 fix)

- Added by commit: `9e6727d` (Bug #10 originAgent fix)
- Why spot-check (not blocking): integration test `tests/regression/origin-agent-routing.test.ts` covers the routing assertion (`originAgent` is read directly, not guessed) end-to-end. The only marginal verification a real-Slack run adds is a 60-second smoke check that control visibly returns to architect — already verified once at commit time. Demoted 2026-04-30 per the value-of-MT discussion.
- Run opportunistically: next time we walk a feature through architect-phase escalation in real Slack, confirm post-confirmation control returns to architect (not designer). No need to run as a standalone exercise.
- Full scenario: see `MANUAL_TESTS.md` MT-17

### MT-19 — PM AC-citation hallucination detection in escalation-resume (B11 v1, bug #12)

- Added by commit: `d83762e` (B11 v1)
- Why spot-check (not blocking): integration test `tests/integration/workflows.test.ts` Scenario B11 v1 drives `handleFeatureChannelMessage` → `arch-upstream-escalation-confirmed` → mocked PM response with AC 99 → `readFile` mock → `verifyAcReferences` → `[CONTENT-VERIFIER]` log assertion end-to-end. The only marginal verification a real-Slack run adds is "the real GitHub path resolves correctly" — a 60-second smoke check, not a full scenario. Demoted 2026-04-30 per the value-of-MT discussion.
- Run opportunistically: next time PM is invoked in escalation-resume on a feature where the spec has known AC count, eyeball the bot logs for `[CONTENT-VERIFIER] feature=<name> site=arch-upstream-escalation-confirmed` if PM cites an AC.
- Full scenario: see `MANUAL_TESTS.md` MT-19

### MT-20 — Architect-escalation consolidation gate (B6, bug #13)

- Added by commit: <this commit, B6>
- Why spot-check (not blocking): integration test `tests/integration/workflows.test.ts` Scenario B6 drives `handleFeatureChannelMessage` → architect tool_use `offer_upstream_revision(pm)` with 1 enumerated gap → B6 gate → `pendingEscalation.question` overridden with consolidated 3-gap brief — both positive (override fires) and negative (faithful enumeration retained) cases asserted end-to-end. Real-Slack adds the marginal "operator can read the consolidated brief without confusion" check. Spot-check tier from the start per the value-of-MT discussion.
- Run opportunistically: next time the architect is run in `engineering-in-progress` on a feature with multiple deterministic PM gaps, grep `logs/bot-YYYY-MM-DD.log` for `[ESCALATION-GATE] B6:` to confirm the gate fires when the agent under-enumerates.
- Full scenario: see `MANUAL_TESTS.md` MT-20
