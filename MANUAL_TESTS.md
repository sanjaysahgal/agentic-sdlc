# MANUAL_TESTS.md

Canonical list of manual Slack scenarios for paths that automated tests can't faithfully reproduce. Run the relevant scenario after every production-wiring fix to its path.

**Why this file exists:** unit + integration tests pass against synthetic state set up via `setConfirmedAgent` and direct `handleFeatureChannelMessage` calls. They do NOT exercise:
- The Slack slash-command entry through `app.ts` → `handleFeatureChannelMessage` with a real userId
- The two-pass orientation + auto-continue flow that fires for first-time userIds in a feature
- Real LLM behavior on a structured directive (whether the agent honors "MUST report verbatim" or paraphrases)
- Slack-side rendering (markdown, mentions, thread updates)
- `tsx watch` hot-reload caching (covered by the `[BOOT]` fingerprint protocol below)

If a fix touches one of those paths, the corresponding scenario in this file is the only thing that proves it works. **Don't claim a fix is done until the relevant manual scenario passes.**

---

## Pre-flight protocol (run BEFORE any scenario)

1. **Restart the bot.** `tsx watch` may silently fail to reload — `kill -9 $(pgrep -f "tsx.*server.ts" | head -1)` if in doubt, then `npm run dev` (or whatever the bot starts with).
2. **Verify the [BOOT] line in logs.** Tail `logs/bot-YYYY-MM-DD.log` immediately after restart and confirm:
   - `commit=<short-sha>` matches `git rev-parse --short HEAD`
   - `codeMarker=<marker>` matches the `CODE_MARKER` in `runtime/boot-fingerprint.ts`
3. **Only proceed to the scenario if both match.** If either is wrong, the bot is on stale code and any test result is meaningless.

---

## Scenarios

### MT-1 — Architect readiness directive (P14/P15)

**Why this can't be automated:** the production path goes through the slash-command entry in `app.ts`, sets userId orientation, and runs the architect twice (orientation pass + auto-continue substantive pass). Integration tests bypass this and hit `handleFeatureChannelMessage` directly with a fake userId — not the same code path.

**Last verified:** ❌ FAILING — bug reproduced 2026-04-29 on commit 43640ab (the supposed fix). [BOOT] line was not verified before testing; tsx-watch cache may have been stale. Re-run after commit d0f63d3 (BOOT fingerprint) to confirm.

**Setup:**
- Feature: `onboarding` in `agentic-health360`
- Phase: `engineering-in-progress` (engineering draft on `spec/onboarding-engineering`, PM + design specs on `main`)
- The PM spec on main should have at least one deterministic finding (e.g. vague AC like "smooth", "seamless"). If the spec is currently clean, this scenario won't reproduce — pick a feature with known PM-spec gaps or temporarily edit one to introduce a finding.
- The user issuing the test should ALREADY be in `orientedUsers` for this feature. Check `.conversation-state.json` for `"orientedUsers": ["onboarding:<USERID>"]` — if not, send a throwaway message first to trigger orientation, then proceed.

**Actions:**
1. In `#feature-onboarding`, send `/architect hi`.
2. Wait for the architect's response.
3. Repeat: in the same channel, send `Hi, I want to work on this feature` (a non-slash message).

**Expected outcome:**
- Both responses surface the **same numeric counts** for upstream PM gaps + upstream design gaps + own engineering findings.
- Neither response says "✅ Nothing blocking" — the directive forces the architect to report the upstream-gap counts.
- If `pendingEscalation` is queued post-run (auto-trigger), the platform-built CTA names the queued target (`PM` or `Design`) — never a different one than the platform queued.

**Log lines to grep (in `logs/bot-2026-04-29.log` etc):**
```
[BOOT] commit=<sha> codeMarker=readiness-directive+prose-state-fix
[ROUTER] branch=confirmed-architect feature=onboarding
[READINESS] architect feature=onboarding aggregate=<state> own=<status>(<n>) pm=<n> design=<n> esc=<...> total=<n>
```
- One `[READINESS]` line per non-readOnly architect run.
- If escalation auto-triggered: `[ESCALATION] architect assertive override applied for onboarding (queued target=<x>)`.
- If architect called `offer_upstream_revision(target=design)` while PM gaps existed: `[ESCALATION-GATE] architect post-run: PM-first override`.

**Failure signatures:**
- **No `[READINESS]` line** → my code path was bypassed (most likely a stale `tsx watch` module — verify `[BOOT]` matches HEAD, hard restart if not).
- **`[READINESS]` fires but `pm=0 design=0 total=0` AND the architect says "Nothing blocking"** → the upstream specs are actually clean. Pick a feature with known gaps or seed one.
- **`[READINESS]` fires with non-zero counts but the architect's response paraphrases away the counts** → the directive isn't forceful enough. Add a structural response-side gate (the I21 orientation-enforcer pattern).

---

### MT-2 — PM-first conversational override (architect prose-vs-state)

**Why this can't be automated:** requires the architect's LLM to genuinely produce prose like "I'll bring in the Design agent" while the platform has independently queued PM via auto-trigger or rejected an explicit `offer_upstream_revision(target=design)`. Mocked LLMs let you fake either side but not the natural emergence of the contradiction.

**Last verified:** never (added 2026-04-29 alongside commit 959c604; bug fix not yet manually verified end-to-end).

**Setup:**
- Same as MT-1 (engineering phase, PM + design specs with gaps).

**Actions (variant A — auto-trigger path):**
1. Send `/architect hi` in `#feature-onboarding`.
2. Wait for response.
3. Send a substantive prompt that pushes the architect to propose escalating Design (e.g. `we have 41 design gaps — what's the plan?`).

**Actions (variant B — explicit tool call path):**
1. Send a prompt that nudges the architect to call `offer_upstream_revision(design)` directly (e.g. `escalate the design gaps now`).

**Expected outcome:**
- Variant A: even if the architect's prose says "Design", the final posted text is the platform-built PM CTA — `Upstream PM gaps must be resolved before engineering can proceed. Say *yes* and I'll bring in the PM agent to close them.`
- Variant B: the explicit tool call is overridden — `pendingEscalation.targetAgent` ends up as `pm`, the posted CTA names PM, not Design.
- After typing `yes`: PM agent runs, not Design.

**Log lines to grep:**
```
[ESCALATION-GATE] architect post-run: PM-first override — agent called offer_upstream_revision(design) but PM gaps must close first. Re-queuing target=pm.
[ESCALATION] architect assertive override applied for onboarding (queued target=pm)
[STORE] setPendingEscalation: feature=onboarding targetAgent=pm
```

**Failure signatures:**
- Posted CTA names "Design" → either the override didn't fire (capture timing bug) or the platform-built text isn't being applied to the final `chat.update`.
- `pendingEscalation.targetAgent === "design"` after the user's substantive turn while PM gaps exist → PM-first conversational override didn't fire (check `pmGapsInNotice` parsing).

---

### MT-3 — Routing-state migration (I2 / I8 / FLAG-5)

**Why this can't be automated:** the migration script reads the live `.conversation-state.json` from disk. Tests cover the pure function `migrateRoutingState(parsed)` but not the file IO + dry-run/--write CLI flow.

**Last verified:** never (added 2026-04-28 alongside commits for I2 + I8 + FLAG-5).

**Setup:**
- Stop the bot first (avoid file race).
- Make a backup: `cp .conversation-state.json .conversation-state.json.bak`.
- Optionally inject a corrupt entry to verify the script catches it: edit one `pendingEscalations.<feature>.targetAgent` to `"wat"`.

**Actions:**
1. Run `npx ts-node scripts/migrate-routing-state-v2.ts` (dry run).
2. Verify the dry-run output enumerates dropped entries (or "state is clean — no changes").
3. Run `npx ts-node scripts/migrate-routing-state-v2.ts --write`.
4. Verify a backup was created (`.conversation-state.json.pre-v2-migration.<ts>.bak`).
5. Verify the cleaned `.conversation-state.json` no longer contains the corrupt entries.

**Expected outcome:**
- Dry-run produces a list; --write produces a list + a backup file.
- Re-running --write on the cleaned file is a no-op ("state is clean").

**Failure signatures:**
- Backup file missing after `--write` → file I/O bug.
- Corrupt entry survives migration → validation rule gap.

---

### MT-4 — V2 architect runner shadow log (Block A5 burn-in gate)

**Why this can't be automated:** integration tests verify the shadow log appears with the right shape; only real Slack traffic over 48h verifies the V2 classifier's branch decisions match what legacy actually does on the diversity of real user messages. Divergences detected here gate Block A6 (designer V2 runner).

**Last verified:** ✅ verified — first manual run on commit `5caf671` (codeMarker `v2-architect-shadow`). Shadow correctly fired on the two architect-runner-bound messages (`/architect hi` → `branch=state-query-fast-path`, `Hi, I want to work on this feature` → `branch=normal-agent-turn`) and correctly stayed silent on a third turn that hit the universal-guard hold-pending-escalation path BEFORE reaching the architect branch — this is correct behavior (V2 architect runner wouldn't run there either; the v2 routing layer's `show-hold-message` handles it, already shipped via Phase 5 / I7-extended). 48h zero-divergence burn-in clock started 2026-04-29 13:11.

**Scope clarification:** MT-4 verifies the V2 architect runner shadow fires when the architect runner is invoked. Messages that hit the universal-guard (hold-pending-escalation, escalation-confirmed, etc.) short-circuit before the architect-branch wiring point — shadow correctly does NOT fire on those. The v2 routing shadow (`runtime/routing/shadow.ts`, Phase 3) covers those paths.

**Pre-flight (every manual run):**
1. Restart the bot.
2. Verify the `[BOOT]` line shows `codeMarker=v2-architect-shadow` AND `commit=<HEAD-sha>`.

**Setup:** any feature in engineering phase. Architect is the canonical agent.

**Actions:**
1. Send `/architect hi` in `#feature-<name>`.
2. Send a substantive message: `Hi, I want to work on this feature`.
3. Send a check-in: `where are we`.

**Expected outcome:**
- Legacy architect responds normally to each message (V2 doesn't intercept; production behavior unchanged).
- For each message, exactly one `[V2-ARCHITECT-SHADOW]` line appears in `logs/bot-YYYY-MM-DD.log` BEFORE the legacy architect's response logs.
- Each shadow line includes `feature=<name>`, `branch=<kind>`, `aggregate=<state>`, `total=<n>`.

**Branch expectations for the canonical messages:**
- `/architect hi` (slash, "hi" alone matches CHECK_IN_RE) → shadow `branch=state-query-fast-path`.
- `Hi, I want to work on this feature` (substantive, not a check-in) → shadow `branch=normal-agent-turn`.
- `where are we` (substantive, not CHECK_IN_RE — note: shadow degrades to false on isStateQuery in this minimal A5) → shadow `branch=normal-agent-turn`. *(A future A5 expansion adds isStateQuery LLM-classification to shadow; until then, shadow may classify state-queries as normal-agent-turn — acceptable observation gap.)*

**Failure signatures:**
- **No `[V2-ARCHITECT-SHADOW]` line** → wiring bug in `interfaces/slack/handlers/message.ts` architect branch entry. Check the import + call site.
- **Shadow line includes `[V2-ARCHITECT-SHADOW-ERROR]`** → internal shadow failure; check the error reason field. Should NEVER block the legacy handler from running.
- **Shadow `branch=` doesn't match the legacy actual response shape** → V2 classifier diverges from legacy intent classification; document the divergence and investigate before A6.

**Burn-in clock:** Block A5 gates A6 on 48h of zero-divergence shadow logs. Operator monitors the log accumulation; flags any unexpected branch shifts (e.g. shadow says `state-query-fast-path` but legacy responded with a full LLM turn).

---

### MT-5 — V2 designer runner shadow log (Block A6 burn-in gate)

**Why this can't be automated:** integration tests verify the shadow log appears with the right shape; only real Slack traffic over 48h verifies the V2 classifier's branch decisions match what legacy actually does on the diversity of real user messages. Divergences detected here gate Block A7 (PM V2 runner). Same shape as MT-4 with the agent swapped — designer-bound messages instead of architect-bound.

**Last verified:** never (added alongside Block A6 commit; 48h zero-divergence burn-in clock starts on first verified manual run).

**Scope clarification:** MT-5 verifies the V2 designer runner shadow fires when the designer runner is invoked. Messages that hit the universal-guard (hold-pending-escalation, escalation-confirmed, etc.) short-circuit before the design-branch wiring point — shadow correctly does NOT fire on those. The v2 routing shadow (`runtime/routing/shadow.ts`, Phase 3) covers those paths.

**Pre-flight (every manual run):**
1. Restart the bot.
2. Verify the `[BOOT]` line shows `codeMarker=v2-designer-shadow` AND `commit=<HEAD-sha>`.

**Setup:** any feature in design phase. Designer is the canonical agent.

**Actions:**
1. Send `/design hi` in `#feature-<name>`.
2. Send a substantive message: `Hi, I want to work on this feature`.
3. Send a check-in: `where are we`.

**Expected outcome:**
- Legacy designer responds normally to each message (V2 doesn't intercept; production behavior unchanged).
- For each message, exactly one `[V2-DESIGNER-SHADOW]` line appears in `logs/bot-YYYY-MM-DD.log` BEFORE the legacy designer's response logs.
- Each shadow line includes `feature=<name>`, `branch=<kind>`, `aggregate=<state>`, `total=<n>`.

**Branch expectations for the canonical messages:**
- `/design hi` (slash, "hi" alone matches CHECK_IN_RE) → shadow `branch=state-query-fast-path`.
- `Hi, I want to work on this feature` (substantive, not a check-in) → shadow `branch=normal-agent-turn`.
- `where are we` (substantive, not CHECK_IN_RE — same minimal-shadow caveat as MT-4: `isStateQuery` degrades to false in this initial wiring) → shadow `branch=normal-agent-turn`.

**Failure signatures:**
- **No `[V2-DESIGNER-SHADOW]` line** → wiring bug in `interfaces/slack/handlers/message.ts` design branch entry. Check the import + call site.
- **Shadow line includes `[V2-DESIGNER-SHADOW-ERROR]`** → internal shadow failure; check the error reason field. Should NEVER block the legacy handler from running.
- **Shadow `branch=` doesn't match the legacy actual response shape** → V2 classifier diverges from legacy intent classification; document the divergence and investigate before A7.

**Burn-in clock:** Block A6 gates A7 on 48h of zero-divergence shadow logs. Operator monitors the log accumulation; flags any unexpected branch shifts (e.g. shadow says `state-query-fast-path` but legacy responded with a full LLM turn).

---

### MT-6 — V2 PM runner shadow log (Block A7 burn-in gate)

**Why this can't be automated:** integration tests verify the shadow log appears with the right shape; only real Slack traffic over 48h verifies the V2 classifier's branch decisions match what legacy actually does on the diversity of real user messages. Same shape as MT-4 / MT-5 with the agent swapped — PM-bound messages instead of architect/designer-bound. Block A (architect + designer + PM V2 runners) is feature-complete; this is the last per-agent burn-in before Block E (cutover) becomes eligible.

**Last verified:** never (added alongside Block A7 commit; 48h zero-divergence burn-in clock starts on first verified manual run).

**Scope clarification:** MT-6 verifies the V2 PM runner shadow fires when the PM runner is invoked. Messages that hit the universal-guard (hold-pending-escalation, escalation-confirmed, etc.) short-circuit before the PM-branch wiring point — shadow correctly does NOT fire on those.

**Pre-flight (every manual run):**
1. Restart the bot.
2. Verify the `[BOOT]` line shows `codeMarker=v2-pm-shadow` AND `commit=<HEAD-sha>`.

**Setup:** any feature in `product-spec-in-progress` phase. PM is the canonical agent.

**Actions:**
1. Send `/pm hi` in `#feature-<name>`.
2. Send a substantive message: `Hi, I want to work on this feature`.
3. Send a check-in: `where are we`.

**Expected outcome:**
- Legacy PM responds normally to each message (V2 doesn't intercept; production behavior unchanged).
- For each message, exactly one `[V2-PM-SHADOW]` line appears in `logs/bot-YYYY-MM-DD.log` BEFORE the legacy PM's response logs.
- Each shadow line includes `feature=<name>`, `branch=<kind>`, `aggregate=<state>`, `total=<n>`.

**Branch expectations for the canonical messages:**
- `/pm hi` (slash, "hi" alone matches CHECK_IN_RE) → shadow `branch=state-query-fast-path`.
- `Hi, I want to work on this feature` (substantive, not a check-in) → shadow `branch=normal-agent-turn`.
- `where are we` (substantive, not CHECK_IN_RE — same minimal-shadow caveat as MT-4/5: `isStateQuery` degrades to false in this initial wiring) → shadow `branch=normal-agent-turn`.

**Failure signatures:**
- **No `[V2-PM-SHADOW]` line** → wiring bug in `interfaces/slack/handlers/message.ts` PM branch entry. Check the import + call site.
- **Shadow line includes `[V2-PM-SHADOW-ERROR]`** → internal shadow failure; check the error reason field. Should NEVER block the legacy handler from running.
- **Shadow `branch=` doesn't match the legacy actual response shape** → V2 classifier diverges from legacy intent classification; document the divergence and investigate before Block E.

**Burn-in clock:** Block A7 contributes the third of three 48h zero-divergence shadow clocks (architect MT-4, designer MT-5, PM MT-6). All three must be green before Block E (cutover) is eligible.

---

### MT-7 — Hedge gate live in production (Block N enforceNoHedging)

**Why this can't be automated:** unit tests verify `enforceNoHedging` rewrites correctly given a fixed string; only real LLM + real Slack proves the rewriter actually fires on agent-produced text and that the rewritten output renders cleanly through Slack's markdown. The gate runs at three call sites — verify against any one agent.

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** any feature in any in-progress phase. Pick the agent matching the phase.

**Actions:**
1. Coax the agent into producing a deferral phrase. Suggested prompt: "I'm not sure which way to go on this — give me your two options and ask me which one I prefer."
2. Read the Slack reply.

**Expected outcome:**
- Agent's response does NOT contain "shall I", "would you like me to", "what would you like to focus on", "up to you", or any other `DEFERRAL_PHRASES` entry.
- If the agent did produce one, the platform rewrote it: log line `[HEDGE-GATE] <agent>: rewrote N deferral phrase(s): <phrases>` appears in `logs/bot-YYYY-MM-DD.log`, AND the Slack reply contains the rewritten imperative form ("I'll X" instead of "shall I X") OR the deferring sentence is gone.
- The response does NOT contain the legacy canned text "I'll proceed with the approach outlined above" — that string is retired.

**Failure signatures:**
- Slack reply contains a verbatim `DEFERRAL_PHRASES` entry AND no `[HEDGE-GATE]` log line → gate not firing on this path; check the call-site guard (e.g. `escalationJustOffered`).
- Slack reply contains "I'll proceed with the approach outlined above" → legacy code path still wired somewhere; grep the codebase.

---

### MT-8 — Anti-deferral block in agent prompts (Block N buildAntiDeferralBlock)

**Why this can't be automated:** the cross-agent invariant test asserts the block is INJECTED into prompts; only real-LLM behavior verifies the model actually OBEYS the instruction and stops producing deferral phrases at the source. Complementary to MT-7 (which checks the runtime rewrite gate).

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** fresh feature, no draft yet. Pick PM (canonical first-agent path).

**Actions:**
1. Send `/pm` in `#feature-<name>`.
2. Send a deliberately ambiguous opener: "We need to build something. Let's start there."

**Expected outcome:**
- PM's first response is opinionated and proposes a concrete direction WITHOUT asking "what would you like to focus on?" or "shall I X?". Acceptable closing: a single numbered-options pick question ("Which option — 1, 2, or 3?") which is allowed because the prompt's "When presenting options" rule overrides general anti-deferral.
- Run the same flow with Designer + Architect agents on their respective phases — same expectation.

**Failure signatures:**
- Agent's response contains a `DEFERRAL_PHRASES` entry that the platform did NOT rewrite → rare double-failure; the prompt rule was ignored AND the runtime gate also missed it (check `LEGITIMATE_QUESTIONS` context — may have been suppressed).

---

### MT-9 — PM spec-auditor surfaces gaps on every draft save (real-LLM)

**Why this can't be automated:** integration tests stub `auditPmSpec` calls; only real LLM + real GitHub draft persistence verifies the audit findings render correctly in Slack alongside the save confirmation, with a clickable spec URL.

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** fresh feature in `product-spec-in-progress`.

**Actions:**
1. Send a partial spec via PM: include user stories but omit the `## Open Questions` section entirely. Ask PM to "save the draft."
2. Read the Slack reply.

**Expected outcome:**
- Slack reply contains the saved-draft confirmation with GitHub URL.
- Slack reply also contains audit findings — at minimum a flag for the missing/incomplete section (the PM_RUBRIC enforces an Open Questions section).
- `logs/bot-YYYY-MM-DD.log` contains `[AUDITOR] auditPmSpec: N finding(s)` with N >= 1.

**Failure signatures:**
- Save confirmation appears but no audit findings → audit not running on save path; check `auditPmSpec` invocation in tool handler.
- Audit findings logged but not in Slack reply → findings consumed but not surfaced; check the response composition.

---

### MT-10 — Designer brand auditor on every response (real BRAND.md)

**Why this can't be automated:** brand auditor pulls live BRAND.md content from the customer repo; integration tests stub `auditBrandTokens`. Only a live Slack run with a designer-produced spec containing a drifted token (e.g. `--accent: #FF0000` vs BRAND.md `--accent: #00B894`) verifies the auditor catches drift in the actual production-rendered spec.

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** feature in `design-in-progress` with an existing draft.

**Actions:**
1. Ask designer to "update the primary button to use --accent: #FF0000."
2. Designer should patch the spec.

**Expected outcome:**
- Slack reply includes a brand-audit warning naming the drifted token AND the canonical BRAND.md value.
- `logs/bot-YYYY-MM-DD.log` contains `[BRAND-AUDIT] design: N drift finding(s)` with N >= 1.

**Failure signatures:**
- Spec patched but no brand-audit warning → auditor not invoked on patch path. Check `auditBrandTokens` call in design tool handler.

---

### MT-11 — Architect downstream-readiness audit blocks finalize on upstream gaps

**Why this can't be automated:** the audit reads approved PM + design specs from main branch via real GitHub API; integration tests stub the spec fetcher. Verifies CLAUDE.md Principle 14 (deterministic audits are retroactive) — even an approved upstream spec can fail current rubrics, blocking finalization.

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** feature in `engineering-in-progress` with PM + design specs approved on main. Pick a feature whose PM spec contains vague language that `auditPmSpec` flags (or seed one).

**Actions:**
1. Architect builds a complete engineering spec.
2. Send "approved — finalize" to architect.

**Expected outcome:**
- Finalize is BLOCKED. Slack reply explains the upstream PM gaps and offers escalation (`offer_pm_escalation` flow).
- `logs/bot-YYYY-MM-DD.log` contains `[ESCALATION] architect → PM` with the gap count.

**Failure signatures:**
- Finalize succeeds despite known upstream gaps → `handleFinalizeEngineeringSpec` not running upstream audit. Check the gate.

---

### MT-12 — Concierge orientation + cross-channel routing

**Why this can't be automated:** concierge runs in a different channel scope (`#general` or main channel), routes to feature channels using live workspace config; integration tests stub the channel resolver. Verifies the operator-facing flow.

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** at least one feature in any in-progress phase.

**Actions:**
1. Send `hi` in `#${mainChannel}` (the workspace's general channel — never a feature channel).
2. Read the reply.
3. Send a feature-specific question: "what's the status of the onboarding feature?"

**Expected outcome:**
- (1) Concierge orients: introduces itself, lists current in-progress features with phases, points at the right channel for each.
- (3) Concierge gives a status summary AND points to `#feature-onboarding` for substantive work.

**Failure signatures:**
- Concierge claims to be PM/Designer/Architect → wrong agent loaded for `#general`; check `agent-router.ts`.
- Concierge tries to write a spec → domain-boundary violation; check concierge prompt + tool stripping.

---

### MT-13 — Cross-agent approval-confirm flow

**Why this can't be automated:** approval intent classification + spec save + phase advance is tested in isolation; only real Slack proves the user-facing `Spec approved → saved → phase advanced → next agent introduces itself` chain renders correctly across agents.

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** any feature with a draft pending approval (PM, Designer, OR Architect).

**Actions:**
1. Send "approved — let's lock it in" to the current agent.
2. Read the Slack reply.

**Expected outcome:**
- Slack reply confirms the spec was saved, includes the GitHub URL.
- Phase advances on the next message: posting any message in the same channel routes to the next-phase agent (PM → Designer → Architect).
- The next agent introduces itself with a "Read the room first" orientation: names the feature, current phase, what it owns.

**Failure signatures:**
- Re-confirmation loop ("are you sure?") → approval-detection regression; check `isSpecApproval` classifier.
- Phase doesn't advance → `resolveAgent()` not corrected; check `setConfirmedAgent` call in finalize handler.
- Next agent doesn't orient → orientation prompt block missing or `orientedUsers` set incorrectly.

---

### MT-14 — Slash-command override during read-only (post-approval) mode

**Why this can't be automated:** spec-iteration override (slash-as-confirmation) is exercised in tests but the real LLM has to honor the read-only directive AND offer the iteration prompt. Verifies the I22 dismiss-classifier flow.

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** feature in `product-spec-approved-awaiting-design` (PM spec approved; design not started). Confirmed agent is design.

**Actions:**
1. Send `/pm` in `#feature-<name>`.
2. Send "I want to revise the success criteria for AC-3."

**Expected outcome:**
- (1) PM acknowledges the iteration entry, references the approved spec, asks how the user wants to change AC-3 (read-only orientation).
- (2) PM proposes a specific edit, NOT silently overwriting the spec.

**Failure signatures:**
- PM writes the spec without asking → read-only override not in effect; check spec-iteration mode wiring.

---

### MT-15 — First-time-user orientation (cross-agent)

**Why this can't be automated:** orientation triggers on unknown `userId`; integration tests use fake userIds. Real Slack run with a never-seen user verifies the two-pass orientation + auto-continue substantive pass.

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** any in-progress feature. User who has NOT messaged this feature before (clear `orientedUsers` if needed via state file edit).

**Actions:**
1. Send a substantive message that would normally trigger an LLM turn: "what should I focus on next?"

**Expected outcome:**
- First Slack post: orientation — agent introduces itself, names the feature + phase + what it owns. Brief.
- Second Slack post (auto-continued): substantive answer to the question.
- `orientedUsers` set updated for `<feature>:<userId>`.

**Failure signatures:**
- Single response that mixes orientation + substance → auto-continue not firing.
- No orientation, just substance → orientation gate skipped; check `userId` not in `orientedUsers`.

---

### MT-16 — Tool-name + platform-commentary stripper sentence-drop (Block N2)

**Why this can't be automated:** unit tests verify the regex pattern is sentence-level (not token-level). Only real LLM + real Slack proves the new stripper handles real agent output gracefully — multi-clause sentences mixing legitimate content with the offending token, sentence-end punctuation variations, code blocks, and Slack markdown all interact at runtime.

**Pre-flight:** restart bot, verify `[BOOT]` codeMarker matches HEAD.

**Setup:** any feature in any in-progress phase. Architect is the most likely to produce tool-name leaks (engineering spec finalize flow).

**Actions:**
1. Coax the agent into mentioning a tool by name. Suggested: in `engineering-in-progress`, say to architect "approved — go ahead and finalize."
2. Read the Slack reply.

**Expected outcome:**
- Slack reply does NOT contain literal tool-name tokens like `finalize_engineering_spec()`, `save_product_spec_draft()`, `apply_design_spec_patch()`.
- The reply is NOT mangled with empty backticks like `Calling \`\` now.` — that's the pre-N2 failure mode.
- The reply still has substantive content. If the agent's only sentence was the tool-name claim, the response may be short — that's acceptable; the platform's tool-loop will continue and produce a follow-up.
- `logs/bot-YYYY-MM-DD.log` contains `[AGENT-RESPONSE] dropping sentences containing tool name references: <names>` when stripping fires.

**Failure signatures:**
- Reply contains literal `finalize_*()` or other tool names → regex pattern broken.
- Reply contains `\`\`` or other empty-backtick artifacts → sentence-drop not catching the surrounding punctuation.
- Reply is empty / mangled paragraph → drop was too aggressive (a multi-clause sentence with the tool-name in one clause lost the whole thing). Document the input that triggered it and tighten the pattern.

---

## Maintenance

- When you add a fix to a path covered above, update the scenario's "Last verified" line.
- When you add a fix to a NEW path that automated tests can't cover, add a new MT-N entry in this file in the same commit as the fix.
- When the codeMarker in `runtime/boot-fingerprint.ts` changes, update MT-1's expected `[BOOT]` line.
