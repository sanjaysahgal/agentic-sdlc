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

## Maintenance

- When you add a fix to a path covered above, update the scenario's "Last verified" line.
- When you add a fix to a NEW path that automated tests can't cover, add a new MT-N entry in this file in the same commit as the fix.
- When the codeMarker in `runtime/boot-fingerprint.ts` changes, update MT-1's expected `[BOOT]` line.
