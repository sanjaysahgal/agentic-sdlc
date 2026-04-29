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

## Maintenance

- When you add a fix to a path covered above, update the scenario's "Last verified" line.
- When you add a fix to a NEW path that automated tests can't cover, add a new MT-N entry in this file in the same commit as the fix.
- When the codeMarker in `runtime/boot-fingerprint.ts` changes, update MT-1's expected `[BOOT]` line.
