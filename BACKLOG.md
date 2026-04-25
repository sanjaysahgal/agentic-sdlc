# agentic-sdlc — Feature Backlog

Ordered by priority. One step at a time — human confirms before proceeding to the next.

---

## Platform context

agentic-sdlc is a licensable SDLC platform. A customer brings their Slack workspace, GitHub repo, and `.env` config — the platform provides everything else: agents, spec chain, code generation, QA, and deployment.

The platform is two repos working together:

| Repo | What it is |
|---|---|
| `agentic-sdlc` | The SDLC engine — Slack bot, agents, spec chain, GitHub integration |
| `agentic-cicd` | The deployment pipeline — builds and deploys the customer's app |

`agentic-health360` is customer zero — the reference implementation that proves the platform end-to-end. health360 is also a real app that will ship to real users. Nothing ships until the full autonomous pipeline exists: spec → code → QA → production, without manual steps.

Brand data (colors, typography, tokens) is customer-specific. health360 owns its brand in `agentic-health360`. The platform reads brand context via a configurable `brandPath` in WorkspaceConfig — it does not own or define brand.

**North star — zero human code in the target repo:** Once Steps 6–8 are complete, no human should need to write source code in `agentic-health360`. Spec → code → QA → deploy should be fully agent-driven. Every tradeoff in Steps 6–8 should be evaluated against this goal. This is not a current constraint; it is the design criterion for the autonomous pipeline.

---

## Active (next up)

---

### Deterministic audits for product-level docs — consistent advice across invocations (2026-04-24)

**Priority: after onboarding end-to-end pipeline is deployed.**

Product-level agents (`/pm`, `/design`, `/architect` in the general channel) give different advice on consecutive invocations because there's no deterministic baseline — every call is a fresh LLM read of the same doc. Feature-level agents solved this with `auditPmSpec`, `auditDesignSpec`, `auditEngineeringSpec`. Product-level mode needs the same.

**Required:**
- `auditProductVision(visionDoc)` — missing sections, vague language, no success metrics, no monetization, no competitive positioning (PM agent)
- `auditSystemArchitecture(archDoc)` — missing data model entities, no auth strategy, no observability, no migration strategy (Architect agent)
- `auditBrandDoc(brandDoc)` — missing tokens, undefined values, incomplete palette (Brand Agent — when it exists, per "Customer onboarding flow" backlog item)
- Inject findings into product-level prompt as `[INTERNAL — N structural gaps]` — same pattern as feature readiness audits
- Deterministic baseline ensures same doc always produces same gaps; LLM adds commentary on top
- Note: Designer agent does not own a product-level doc — brand is the Brand Agent's domain

**Blocked by:** Onboarding end-to-end pipeline completion. Product-level mode is consultation, not the critical path.

---

### Product-level doc editing — agents can edit vision, architecture, brand docs (2026-04-23)

Product-level agents (`/pm`, `/design`, `/architect` in the general channel) can discuss and recommend changes but cannot edit documents. When a user asks the PM to add open questions to PRODUCT_VISION.md, the PM formats ready-to-paste content but can't commit it.

**Required:** Same branch/audit/approve infrastructure as feature specs — draft on a branch (e.g. `spec/product-vision`), deterministic audit, user approval, merge to main. Each agent edits only docs in its domain: PM → PRODUCT_VISION.md, Designer → BRAND.md, Architect → system-architecture.md.

**Blocked by:** Tool registration for product-level mode (currently runs with no tools). Need `save_product_vision_draft`, `save_brand_draft`, `save_architecture_draft` or a generic `save_product_doc_draft(docType, content)`.

---

### Batch escalation — inject ALL deterministic upstream findings into escalation brief (2026-04-24)

**Priority: HIGH — before onboarding end-to-end completion.**

When the architect escalates one vague AC to the PM, the platform should inject ALL deterministic upstream findings (`auditPmSpec` + `auditDesignSpec`) into the escalation question — not just the one the architect mentioned. The PM resolves all gaps in one round, user confirms once, architect resumes.

Currently: architect surfaces 1 finding per turn → 7 findings = 7 escalation round-trips. At scale with 20+ findings this is unusable.

**Fix:** In the `offer_upstream_revision` tool handler (or the escalation confirmation path in `message.ts`), run `auditPmSpec(approvedPmSpec)` and append all findings to the escalation question before sending to the PM. Same for `auditDesignSpec` when escalating to design.

**DESIGN-REVIEWED:** (1) Scale: one `auditPmSpec` call per escalation, <1ms. (2) Ownership: escalation brief construction in `message.ts`. (3) Cross-cutting: applies to all upstream escalation paths (architect→PM, architect→design).

---

### Branch hygiene — prevent rogue draft branches + periodic cleanup (2026-04-24)

**Preventive:** Already handled — escalation continuation paths run agents with `readOnly=true`, which strips spec-writing tools. The rogue PM scenario is no longer possible. A `saveDraftSpec` guard (check main before saving) was attempted but breaks test mocks — the `readOnly` layer is the correct prevention point.

**Cleanup:** On bot startup, scan for spec branches whose corresponding spec is already approved on `main`. Log them and optionally delete. Also scan for branches with no recent commits (stale drafts from abandoned conversations).

---

### Agent persona names — customer-chosen names for slash commands (deferred)

Slash commands are role-based (`/pm`, `/design`, `/architect`). For a white-label or branded experience, customers may want named personas ("Sarah the PM") with custom avatars. This is a branding layer on top of the existing slash command infrastructure — the routing, domain boundaries, and product-level mode don't change. Defer until a customer requests it.

---

~~### Migrate all LLM-based audits to deterministic implementations (Principle 11) (2026-04-22)~~ ✅ DONE (2026-04-22)

`runtime/deterministic-auditor.ts` — five `@deterministic` pure-function auditors now serve as the primary gate at all 5 `auditPhaseCompletion` call sites in `message.ts`:

| Audit | Deterministic primary | LLM @enrichment |
|---|---|---|
| Upstream PM spec (Design) | `auditPmDesignReadiness()` | `auditPhaseCompletion(PM_RUBRIC)` |
| Upstream PM spec (Architect) | `auditPmSpec()` | `auditPhaseCompletion(ARCHITECT_UPSTREAM_PM_RUBRIC)` |
| Design readiness | `auditDesignSpec()` | `auditPhaseCompletion(buildDesignRubric)` |
| Engineering readiness | `auditEngineeringSpec()` | `auditPhaseCompletion(ENGINEER_RUBRIC)` |
| Upstream design spec (Architect) | `auditDesignSpec()` | `auditPhaseCompletion(buildDesignRubric)` |
| Downstream readiness (all finalize) | N/A — adversarial "what would you need?" has no structural ceiling | `auditDownstreamReadiness` (Sonnet, `@enrichment`) |

Deduplication: LLM findings overlapping deterministic findings (first 40 chars) are dropped. `detectHedgeLanguage()` wired as universal post-run gate. 31 unit tests with determinism contract (each audit run twice, results asserted identical). Eval suite (13 deterministic + 26 Haiku-judged criteria) wired into pre-push hook; 92% pass rate.

---

> **Priority reset — trust and determinism before anything else.**
>
> The platform's core promise is that agents behave predictably and users can always know where they stand. This requires two layers: user-facing trust (context limits, committed state visibility, persistence) and infrastructure robustness (reliable writes, retries, idempotency). Both must be in place before any new agent work. A platform users don't trust is not a platform.

---

### ~~PM finalization rubric false-negative — gaps slipping through the upfront audit (2026-04-16)~~ ✅ DONE (2026-04-20)

**Root cause:** PM_RUBRIC criterion 1 said "every user story needs an error path" generically — Sonnet saw nearby edge cases and inferred US-2 was covered. It wasn't.

**Fix:** Criterion 1 sharpened: "Enumerate each user story by number. For EACH story individually, verify failure/error scenario exists. Output one FINDING per uncovered story." Real Sonnet run against onboarding PM spec now catches US-2 (returning user sign-in failure path missing) + US-1 (sign-up failure) + US-8 (data requirements for carry-over). Gap 2 (AC#2 display copy) was already fixed in the spec itself.

**Verification:** Real-Sonnet-output fixture at `tests/fixtures/agent-output/pm-rubric-onboarding.json`. Producer tests verify fixture contains US-2 finding, data requirements finding, and design-readiness findings (≥5). All three audit layers (PM_RUBRIC: 4 findings, PM_DESIGN_READINESS_RUBRIC: 10 findings, adversarial designer: 11 findings) produce non-zero results against the approved onboarding spec.

---

~~### Architect must stop at upstream escalation — no spec writing until upstream gaps close (2026-04-21)~~ ✅ DONE (2026-04-22)

**Fix A — Escalation stops the turn:** `ArchitectToolState.escalationFired` flag blocks `save_engineering_spec_draft`, `apply_engineering_spec_patch`, and `finalize_engineering_spec` after `offer_upstream_revision` fires. `runAgent` `forceStopToolNames` parameter strips tools on the next API call iteration, forcing the model to wrap up. Two-layer enforcement: tool handler blocks (synchronous, same-batch) + loop stop (structural, cross-batch).

**Fix B — Decisions surfaced before save:** `detectResolvedQuestions()` compares open questions between existing and new draft. When questions are resolved, content is held in `ArchitectToolState.pendingDecisionReview` instead of saving. Post-run gate in `message.ts` stores `PendingDecisionReview` in conversation state and surfaces decisions with a confirmation CTA. Entry gate at architect handler top confirms or discards pending review before any other processing. First saves (no existing draft) pass through without review.

Tests: 18 new tests across `tool-handlers.test.ts`, `claude-client.test.ts`, and `conversation-store.test.ts`. All 1164 tests pass.

---

~~### Universal post-response hedge detection gate — all agents (2026-04-21)~~ ✅ DONE (2026-04-23)

`detectHedgeLanguage()` (deterministic, `runtime/deterministic-auditor.ts`) now wired as a post-response gate for **all three agents** — PM, Design, and Architect. 16 deferral phrases detected with 5 legitimate-question carveouts. When hedges detected: trailing `?` lines stripped, assertive close appended. Guards: `!readOnly` (all agents), `!escalationJustOffered` (design — CTA is platform-generated), `!escalationJustOfferedArch` (architect). Structural verification test confirms all 3 gates exist.

---

### Port remaining design agent enforcement mechanisms to architect (2026-04-21)

3 of 6 mechanisms ported (2026-04-23). Remaining 3 deferred until architect is actively patching specs in production.

| Mechanism | Design agent impl | Architect status |
|---|---|---|
| ~~Uncommitted decisions audit~~ | Post-response Haiku classifier (`identifyUncommittedDecisions`) | **✅ DONE** — same pattern as design: post-response Haiku check, "save those" CTA |
| Post-patch spec health invariant | Arithmetic gate: blocks if spec size grows >20% or findings increase | **Deferred** — not needed until architect patches regularly |
| ~~Platform status line~~ | Item count prepended to response when >0 items remain | **✅ DONE** — deterministic count from `auditEngineeringSpec` + `auditSpecStructure` |
| ~~Escalation assertive language override~~ | Passive escalation prose → assertive CTA with gap list | **✅ DONE** — replaces agent prose with structured CTA on escalation |
| Post-patch continuation loop | Re-audit + auto-continue up to 2 passes after patches | **Deferred** — not needed until architect patches regularly |
| Platform-direct finalization | If 0 structural findings on approval intent, call finalize directly | **Deferred** — not needed until architect finalization is common |

---

### Pre-design PM completeness gate — surface all PM gaps upfront before design starts (2026-04-16)

**Deferred:** The upfront gate already exists (`finalize_product_spec` audit). The real fix is the rubric false-negative item above — sharpen the rubric so it catches what it's supposed to catch. A second pre-design gate would still only be as good as its rubric. Fix the rubric first.

Once the rubric is verified to catch all gap patterns, the remaining ping-pong (gaps discovered mid-design that weren't in the PM spec at finalization time) is genuinely incremental — design work exposing PM spec gaps that didn't exist when the spec was written. That's unavoidable and acceptable; only false-negatives on the existing spec at finalization time are fixable upfront.

---

### ~~Log agent response content — first 500 chars of every agent response (2026-04-20)~~ ✅ DONE (2026-04-20)

Implemented in `runtime/claude-client.ts` — `runAgent` logs `[AGENT-RESPONSE] ${text.slice(0, 500)}` on every return. Covers all agent paths (PM, design, architect) and all call contexts (normal, escalation, enforcement) automatically since it's in the shared runner.

---

### ~~Enforce empty history on all escalation routes (2026-04-20)~~ ✅ DONE (2026-04-20)

**Root cause:** PM agent had `readOnly ? [] : historyPm` gate, but architect agent passed full history unconditionally. Escalation call sites (lines 427, 429, 447, 662) never passed `readOnly: true`.

**Fix:** (1) Added `effectiveHistoryArch = readOnly ? [] : historyArch` gate in `runArchitectAgent`. (2) All escalation brief call sites now pass `readOnly: true`. (3) Architect skips history-dependent enrichment and upstream audits when `readOnly=true`.

---

### ~~Clean stale escalation state on restart (2026-04-20)~~ ✅ DONE (2026-04-20)

`conversation-store.ts` now clears all `pendingEscalations` on module load. If the bot crashed mid-escalation, the user's confirmation was lost — holding messages in a "say yes to continue" loop forever is worse than a clean slate. Logs what was cleared: `[STORE] startup: clearing N stale pending escalation(s)`.

---

~~### Pre-commit hook: enforce pre-run upstream gate on all agent paths (2026-04-20)~~ ✅ DONE (2026-04-23)

`// UPSTREAM-GATE: [agent]` markers added to design (N18 gate) and architect (upstream gap auto-escalation) paths. PreToolUse hook in `.claude/settings.json` counts `async function run[X]Agent` functions vs `UPSTREAM-GATE:` markers — blocks commit if any non-PM agent path is missing a marker. Structural verification test confirms marker count matches `agentFunctions - 1`.

---

### Mobile-responsive design preview renderer (2026-04-18)

The HTML preview renderer (`runtime/html-renderer.ts`) produces a fixed 390×844px phone frame with absolute positioning. On real mobile devices, content is cut off, not fully visible, and not something a designer would sign off on. The renderer needs to produce responsive HTML that works on any viewport — same way a real app would. The desktop phone-frame + inspector mode stays for desktop review; mobile viewports get native responsive layout.

This is platform-level — affects every customer's design preview, not just Health360.

---

### Customer onboarding flow — foundational specs from zero (2026-04-18)

Archon currently assumes the customer repo already has `PRODUCT_VISION.md`, `BRAND.md`, and `system-architecture.md` populated. No agent creates them. A new customer starting from zero has no way to produce these through the platform.

Required:
1. **Brand Agent** (new) — customer describes vision → produces BRAND.md (palette, typography, spacing, effects)
2. **PM Agent** (existing, extended) — already produces feature specs; extend to also produce PRODUCT_VISION.md when no vision exists
3. **Architect Agent** (existing, extended) — already produces engineering specs; extend to also produce system-architecture.md when no architecture exists

Feature work (PM → Designer → Architect → Engineer per feature) begins only after all three foundational specs exist. Today all three were created manually for Health360.

---

### Auto-deploy design preview via CI/CD platform (2026-04-18)

On every design spec save, auto-deploy the HTML preview to a persistent URL that PM, designer, and engineers can review on any device. The SDLC platform says "deploy this HTML"; the CI/CD platform (`agentic-cicd`) handles the how (Vercel, Netlify, S3, etc.). Add `previewDeployUrl` to `WorkspaceConfig` so the Slack response includes the live URL instead of a file attachment.

Current state: manual Vercel deploy at https://health360-preview.vercel.app. Target: automatic on every `saveDraftHtmlPreview` call.

---

### ~~Platform-enforced finalization — "approved" triggers finalize directly (2026-04-18)~~ ✅ DONE

Platform detects approval intent (`isApprovalIntent` regex), runs `auditSpecStructure` — if 0 structural findings, calls `finalize_design_spec` handler directly (no `runAgent` call). Eliminates the agent blocking approval by running `run_phase_completion_audit` and finding new LLM items. If structural findings > 0, falls through to normal agent path. E2E: N70 + updated S21 tests.

---

### In-memory cache must be read-through from GitHub persistent cache (2026-04-18)

The in-memory `renderAmbiguitiesCache` and `designReadinessFindingsCache` are independent of the persistent GitHub `design-audit.json`. Deleting the GitHub cache doesn't invalidate in-memory state. Bot restart clears in-memory but not GitHub. This caused: (1) false PASS cached in GitHub poisoned the health invariant baseline, (2) deleting the GitHub cache didn't fix it because in-memory still had the wrong data.

Fix: in-memory cache should be a read-through layer backed by GitHub. On cache miss, read from GitHub. On GitHub delete, in-memory invalidates. Single source of truth.

---

### ~~Health invariant must block save, not just response (2026-04-17)~~ ✅ DONE

Health gate added to `saveDesignDraft`: before saving, compares `auditSpecStructure` finding count on old vs new content. If structural findings increased, blocks the save and returns error — bad spec never reaches GitHub. E2E: N69 test.

---

### ~~Deterministic readiness checks — replace LLM rubric floor (2026-04-17)~~ ✅ DONE

`auditSpecStructure()` in `runtime/spec-auditor.ts` — deterministic structural checks (duplicate headings, conflicting values, token mismatches, cross-references, orphaned definitions, copy consistency). Runs on every turn for design + architect, every state query, every save, every finalization. Same input = same output always. No LLM. Findings tagged `[STRUCTURAL]` in action menu. The LLM rubric (`auditPhaseCompletion`) still runs as supplementary but is no longer the convergence floor. E2E: N68 test. Unit tests in `tests/unit/spec-auditor.test.ts`.

---

### ~~Write gate — spec-writing tools stripped on non-fix turns (2026-04-17)~~ ✅ DONE

When a design draft exists with open action items and fix intent is NOT confirmed, spec-writing tools (`save_design_spec_draft`, `apply_design_spec_patch`, `rewrite_design_spec`, `finalize_design_spec`) are removed from the agent's tool list. The agent can analyze, recommend, and escalate but cannot modify the spec. Prevents unauthorized changes when fix intent detection fails (historical: agent modified 20+ elements when user approved only 4).

---

### ~~Tool response audit-stripping gate — prevent divergent patch loops (2026-04-16)~~ ✅ DONE

`saveDesignDraft` returned `renderAmbiguities` in the tool response. The Sonnet agent treated them as work to do, calling `apply_design_spec_patch` again in the same turn — each patch created new ambiguities, causing a divergent loop (spec oscillated 50K→31K→50K→... with findings growing 19→20→32). Root cause: audit findings meant for the user's action menu were leaked to the agent as actionable input.

**Fix (implemented):** (1) Removed `renderAmbiguities` from `saveDesignDraft` return value entirely — audit findings are user-facing only. (2) Added `stripAuditFromToolResult` runtime gate wrapping `designToolHandler` — strips `AGENT_STRIPPED_KEYS` (`renderAmbiguities`, `qualityIssues`) from every tool response before it reaches the agent. Even if a future code change adds them back to `saveDesignDraft`, the gate strips them at the boundary. (3) Regression test N64 verifies the gate works.

---

~~### `auditSpecDraft` false positive — flags PM-spec-covered items as gaps (2026-04-16)~~ ✅ DONE (2026-04-23)

`productSpec` parameter already existed on `auditSpecDraft` — the last missing call site (`handleSavePmSpecDraft` in `tool-handlers.ts`) now passes `ctx.context.approvedProductSpec`. All 5 call sites confirmed with call-site context test.

---

### simulate-regression.ts — 5 real-LLM regression scenarios for structural platform behavior (2026-04-16)

`scripts/simulate-regression.ts` closes the producer–consumer chain gap exposed in live testing today: N62 tests the consumer (platform handles `rewrite_design_spec` calls correctly) but no test verifies the real model, given the fix-all notice, actually *chooses* `rewrite_design_spec` for structural conflicts instead of `apply_design_spec_patch`.

**5 scenarios required:**

| ID | Intent | What the platform must do — asserted structurally |
|---|---|---|
| S1 | Fix brand issues | `apply_design_spec_patch` called ≥1 time; spec size stable (±5%); brand finding count decreases |
| S2 | Clean up structural conflicts / duplicates | `rewrite_design_spec` called ≥1 time AND `apply_design_spec_patch` count = 0 for that turn; post-run finding count lower than pre-run |
| S3 | Ask about current state / readiness | CTA item count in response equals total finding count from last audit |
| S4 | Express approval — when open items exist | `finalize_design_spec` NOT called; response does not contain commitment phrase ("moving to engineering", "approved") |
| S5 | Trigger patch that grows spec >20% | Health invariant fires — response contains degradation warning; platform does not emit "spec updated" success |

**All 5 also assert:** response text contains no `[PLATFORM`, no internal tool function names.

S2 is the critical new scenario — proves structural conflicts reliably route to `rewrite_design_spec` not `apply_design_spec_patch` across any phrasing.

All scenarios derive coordinates from `WorkspaceConfig`, no hardcoded customer values. Use `--dry-run` (default) so no GitHub writes during CI.

**Root cause being closed:** Live "fix 3-23" Slack run showed the agent used `apply_design_spec_patch` for 9 structural conflict findings despite the fixAllNotice routing instruction. The continuation pass now routes correctly in code (committed), but producer compliance under the real model has never been verified end-to-end.

---

### Platform status line suppressed for architect escalations — agent can claim "engineering-ready" with open rubric findings (2026-04-15)

When the design agent calls `offer_architect_escalation`, `escalationJustOffered=true` was suppressing both the action menu AND the platform status line. This let the agent's prose ("Design spec is complete and engineering-ready") go unchallenged even when the rubric showed 10 remaining findings. The suppression was designed for PM escalations (user can't act on design items while PM gap is open) but was incorrectly applied to arch escalations where non-arch design gaps remain.

**Fix:** `escalationJustOfferedPm` replaces `escalationJustOffered` as the platform status line gate — PM escalations suppress the prefix (correct), arch escalations do not (correct). Action menu stays suppressed for all escalations. Fixed in this commit.

---

### `auditSpecRenderAmbiguity` JSON truncation — fails silently on large specs (2026-04-15)

`max_tokens: 500` caused Haiku to truncate its JSON array output at ~500 tokens (~2000 chars). As the design spec grew past 40k chars, every `auditSpecRenderAmbiguity` call failed with unterminated JSON. The repair also failed ("No bracket-delimited content found"). Quality ambiguities were silently dropped — 7 consecutive failures observed in live testing with a 48k-char spec.

**Fix:** Raised `max_tokens` to `2048` in `runtime/spec-auditor.ts`. Fixed in this commit.

---

### Continuation loop — agent runs unbounded tool calls within a single continuation pass (2026-04-15)

The platform's continuation loop gives the agent a free-running turn (no tool call limit, no `maxTokens` cap on `runAgent`). In live testing, the pass-1 continuation ran for 7+ minutes making 7 patches and 3 self-`run_phase_completion_audit` calls. The loop IS bounded at 2 passes, but within each pass the agent can call tools indefinitely. This re-introduces a mild form of "agent controls completion" within the continuation window.

**Fix (deferred):** Pass a `maxToolCalls` cap (e.g., 5) to the continuation `runAgent` call. Or set a timeout on the continuation pass. Low urgency — bounded by 2 passes total regardless.

---

### Escalation cascade — one pending slot forces multiple user round trips for PM + architect gaps (2026-04-14)

The platform has one `pendingEscalation` slot (PM or architect, never both simultaneously). When a design agent turn has both PM gaps and architect gaps, the PM gap is escalated first; the architect gap is classified but dropped. It resurfaces only when the design agent runs again after PM answers. This creates N separate user-facing round trips (each requiring "yes") where ideally there would be 1: all gaps resolved in sequence automatically.

Additionally, the agent only surfaces a subset of audit findings per turn. On a turn with 8 audit findings, the agent wrote prose covering 3 — the other 5 were not addressed and return on the next turn.

**Root cause:** Escalation is sequential by design (single slot) and agent-turn coverage is prompt-dependent (no platform enforcement that all findings are addressed in one turn).

**Fix:** After PM escalation is confirmed and the design agent resumes, the platform should automatically detect remaining architect gaps from the pre-run audit and escalate without requiring another user "yes." Sequential auto-processing within one user turn: PM answered → platform checks architect gaps → auto-escalates if found → architect answers → design agent resumes with all gaps resolved. The user "yes" should only be needed once per cluster of gaps, not once per gap type.

**Related:** The fix-all loop already implements this pattern for design items. The same loop structure should apply to the escalation chain.

---

~~### `offer_pm_escalation` blocked during fix-all — stale escalation persists after loop exits (2026-04-14)~~ ✅ Done (2026-04-14)

Fix-all tool guard added at top of `designToolHandler`: when `fixIntent.isFixAll`, any call to `offer_pm_escalation` or `offer_architect_escalation` is immediately blocked with a structured message directing the agent to only use `apply_design_spec_patch`. `setPendingEscalation` is never called during fix-all passes. PM/architect gaps identified during fix-all are surfaced in the action menu after the loop exits (built from `residualItems`). N55 test 1 + N55 test 2 cover the complete scenario.

---

~~### Agent prose contradicts platform audit — misleads user when items remain (2026-04-14)~~ ✅ Done (2026-04-14)

Platform status line added: when `totalEffectiveItems > 0` after a turn (computed from effective audit variables, not stale pre-run data), the platform prepends `_Platform audit: N items remain before engineering handoff._` before the agent response. Fires on structural condition (`totalEffectiveItems > 0`) — no text-pattern detection. Also fixed the root cause: post-patch continuation loop (see below) means effective items are usually 0 after patches, making the status line a rare safety net rather than a routine occurrence.

---

~~### Post-patch continuation loop — normal turns must not hand completion back to the agent (2026-04-14)~~ ✅ Done (2026-04-14)

Root cause: every normal design agent turn handed completion control back to the agent. The agent addressed whatever subset of findings it chose per turn — prompt-dependent behavior that cannot be shipped. Fix: when any `apply_design_spec_patch` runs in a normal (non-fix-all) turn, the platform re-audits from GitHub (fresh read, never stale `currentDraft`) and runs up to 2 additional continuation passes if design items remain. Loop terminates on clean audit or no-progress (same count as previous pass). PM-GAP items excluded from continuation — those go through Gate 2 escalation. Effective variables (`effectiveBrandDrifts`, `effectiveAnimDrifts`, `effectiveMissingTokens`, `effectiveDeterministicQuality`, `effectiveReadinessFindings`) propagate fresh post-patch state to Gate 2, action menu, and platform status line — stale pre-run data is never surfaced after patches. `clearPhaseAuditCaches()` exported from `message.ts` for test isolation. N55 integration scenario (2 tests) added.

---

### Stale open questions — design spec open questions already answered in product spec are not detected (2026-04-14)

`auditSpecDraft` checks for conflicts and gaps between design spec and product spec, but does not check whether open questions in the design spec's `## Open Questions` section are already answered in the product spec. When the PM later locks an AC that answers a design open question, the question remains in the spec indefinitely and blocks finalization via `extractAllOpenQuestions`.

**Fix:** Add a stale-question pass to `auditSpecDraft` (or a dedicated `auditStaleOpenQuestions`): extract each question from `## Open Questions`, cross-reference against the product spec, and return findings for any question whose answer is already present. Return as `status: "stale-questions"` with the specific question text and the AC that answers it so the agent can remove the question in the same turn.

---

### Double-fire on escalation-continuation branch — in-flight lock not covering all paths (2026-04-13)

Root cause: Slack Socket Mode pong timeout → reconnect → Slack retries the message. The per-feature in-flight lock (N41) prevents double-fire on the main agent path, but the `escalation-continuation` branch in the router appears to bypass or not check the lock. Observed in logs at 18:00:12 and 18:00:21 — same message ("What's blocking us from moving this design to engineering?") processed twice, first with 36 history messages, second with 38 (first response already appended). Not harmful (same PM response both times) but wastes a Haiku call and appends duplicate history.

**Fix:** Verify the `featureInFlight` lock is checked before ALL router branches — not just the main agent invocation path. The escalation-continuation, pending-escalation-confirmed, and any other branch that calls an agent must respect the same lock.

---

~~### Adversarial downstream-readiness audit — replace rubric-based finalization check with open-ended "pretend you're the next role" prompt at every phase boundary (2026-04-13)~~ ✅ Done (2026-04-13)

`auditDownstreamReadiness({ specContent, downstreamRole, featureName })` added to `phase-completion-auditor.ts`. Open-ended Sonnet adversarial prompt: "You are [persona] — list every decision you'd have to invent from this spec." No enumeration ceiling. Wired at all three phase boundaries:
- `finalize_product_spec` — `downstreamRole: "designer"` runs in parallel with `auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC)`
- `finalize_design_spec` — `downstreamRole: "architect"` runs in parallel with `auditSpecDecisions`
- `finalize_engineering_spec` — `downstreamRole: "engineer"` runs in parallel with `auditSpecDecisions`

All three block on any FINDING. CLAUDE.md Definition of Done updated: new agents must implement both same-domain rubric AND adversarial downstream-readiness audit. Unit tests: consumer (PASS/FINDING parsing) + producer (persona injection, open-ended framing, implementation-choice exclusion, Sonnet model, upstream-role attribution). Integration tests: S21, S23, S27, N13, N49 updated for new parallel mock.

~~### PM design-readiness gate — design agent must not be first to discover PM spec vagueness (2026-04-13)~~ ✅ Done (2026-04-13)

`finalize_product_spec` now runs `auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC)` as a third structural gate. Catches vague sensory descriptors ("ambient", "soft"), missing numeric thresholds (session TTL without a value), and underspecified error UI behaviors before the spec reaches the design agent. Production incident: PM said "nothing blocking" after completion audit, design agent immediately found 2 PM-GAP items ("ambient awareness only", unspecified session TTL). Root cause: PM_RUBRIC and design rubric criterion 10 PART B check different things — PM_RUBRIC checks PM-completeness; PART B checks designer-readiness. New rubric bridges the gap. N49 integration test + 5 producer unit tests.

~~### Spec open questions architecture — holistic root cause fix (2026-04-13)~~ ✅ Done (2026-04-13)

Each spec's `## Open Questions` now contains same-domain questions only (`[type: product]` in PM spec, `[type: design]` in design spec, `[type: engineering]` in engineering spec). Cross-domain routes through escalation tools or handoff sections. All three `finalize_*` handlers use `extractAllOpenQuestions` — both `[blocking: yes]` and `[blocking: no]` questions block finalization. New `## Design Notes` section in PM spec seeds design agent brief at finalization. New `## Design Assumptions` section in design spec seeds engineering spec draft at finalization via `seedHandoffSection`; cleared at engineering finalization via `clearHandoffSection`. Architect escalation writeback now routes to engineering spec (`patchEngineeringSpecWithDecision`) not product spec, for both design-originated and PM-originated arch escalation paths. New design rubric criterion 11 (no open questions). PM rubric criterion 3 and ENGINEER rubric criterion 6 updated to catch non-blocking questions. New integration tests N44, N44b, N46, N47 (×3), N48.

~~### Gate 2 silently drops architect-scope items filtered from PM escalation (2026-04-12)~~ ✅ Done (2026-04-12)

Architect-scope items filtered by Gate 2 are now pre-seeded into the engineering spec draft as `[open: architecture]` questions. `pm-gap-classifier.ts` extended to return `architectItems[]` alongside `gaps[]`. `preseedEngineeringSpec` writes to the engineering draft branch (creates branch/file if needed). Gate 2 handler calls `preseedEngineeringSpec` for both the "0 PM gaps" rejection path and the normal "PM + arch items" path. N31 integration test covers.

~~### Architect-escalates-upstream capability (2026-04-12)~~ ✅ Done (2026-04-12)

Architect now has `offer_upstream_revision(question, targetAgent)` tool (targetAgent: "pm" | "design"). Platform handling in `confirmedAgent === "architect"` block mirrors the design agent's PM escalation flow: pending escalation confirmation, hold, and reply resume all implemented. On "yes": platform runs appropriate agent (design or PM) with constraint brief, @mentions reviewer, sets escalation notification with `originAgent: "architect"`. On reply: architect resumes with injected design/PM decision. N32 integration test covers (2 scenarios: confirm + reply).

---

~~### PM agent brief enforcement — agent defers to human instead of making concrete recommendations (2026-04-12)~~ ✅ Done (2026-04-12)

Dual fix:
1. **Platform-level deferral gate** (Principle 8): After `runPmAgent` returns in the escalation confirmation path, `DEFERRAL_PATTERN` regex detects refusal language ("I cannot responsibly", "need to loop in", "without talking to the PM", etc.). If matched: re-runs PM agent inside the same `withThinking` bubble with a `PLATFORM ENFORCEMENT` override message that mandates a concrete recommendation for every item. `capturedAgentResponse` is reset so the enforcement response is what gets stored in `escalationNotification`. N33 integration test covers.
2. **PM agent tone fix**: Added explicit prohibition in `agents/pm.ts` — "You are the authority. Never say 'I cannot responsibly...', never describe your recommendations as guesses, never defer to a higher PM authority. You make the calls." Forbids specific phrases that erode trust.

---

~~### DEFERRAL_PATTERN misses clarification-stall — PM asks question instead of recommending (2026-04-12)~~ ✅ Done (2026-04-12)

Root cause was deeper than the regex: `DEFERRAL_PATTERN` detected bad output patterns — an inherently incomplete approach. Replaced with a **structural output-count gate**: count `My recommendation:` occurrences in the response vs number of numbered items in the brief. If response count < required count → enforcement re-run. Catches all forms of non-compliance (refusal, clarification-stall, partial answer, tangent) with a single deterministic check — no pattern list to maintain.

`DEFERRAL_PATTERN` removed entirely from `message.ts`. PM agent tone updated with explicit clarification-stall prohibition. N33 (clarification-stall triggers gate), N35 (partial answer triggers gate) cover both cases.

---

~~### Gate 2 three-way classifier — DESIGN: items returned to designer, not escalated to PM (2026-04-12)~~ ✅ Done (2026-04-12)

`classifyForPmGaps` now returns three categories: `gaps[]` (GAP: → PM scope), `architectItems[]` (ARCH: → engineering spec), and `designItems[]` (DESIGN: → returned to design agent for self-resolution). When Gate 2 receives only DESIGN: items (0 PM gaps), the `offer_pm_escalation` tool result includes the design items as a numbered list with "resolve these design decisions yourself: [list]" — no `pendingEscalation` set, no PM @mention. Visual/UX decisions (element type, placement, animation timing, visual treatment) stay with the designer. N36 integration test and consumer/producer tests in `pm-gap-classifier.test.ts` cover.

Also extended PM_RUBRIC criterion 2 vague word list: added "soft", "non-intrusive", "proactively", "ambient", "seamlessly", "minimal", "appropriate", "subtle" — specs using these words in acceptance criteria are now flagged before approval.

---

### Escalation UX — agent-triggered offer_pm_escalation path: assertive language + action menu suppression (2026-04-13)

The N18 post-run gate already produces assertive escalation language and suppresses the action menu via early return. However, the *agent-triggered* path — when the design agent calls `offer_pm_escalation` itself — still has two issues:

1. **Passive escalation prose** — agent may ask a wishy-washy question ("Want me to call the PM now?") instead of asserting the block with a numbered gap list + "Say *yes* and I'll bring the PM in."
2. **Action menu still shown** — when escalation is offered this turn (null → set), the 20-item design action menu is appended below the escalation message.

**Fix (when this path surfaces in testing):**
- Fix 1: Strengthen `offer_pm_escalation` instruction in `agents/design.ts` — assert block, numbered gaps, "say *yes*" CTA.
- Fix 2: Snapshot `getPendingEscalation` before/after agent run; if null → set this turn, skip `buildActionMenu`. Also: early return with escalation reminder when escalation pending + user not affirmative.

**Impact:** Medium — UX inconsistency between gate-triggered and agent-triggered escalation paths. No data loss, no broken flows.

---

### Producer test gap: criterion 10 [PM-GAP] prefix needs real-Sonnet fixture (2026-04-13)

The N18 gate filters `designReadinessFindings` for `[PM-GAP]` tagged issues. The consumer side is tested (N18 integration test mocks Sonnet returning `FINDING: [PM-GAP] ...`). But the producer side — whether `buildDesignRubric` criterion 10 actually causes real Sonnet to output `[PM-GAP]` prefix — has no fixture-based producer test.

Per the producer-consumer chain rule: mocking the LLM to return `[PM-GAP]` is not a substitute for verifying the rubric instructs Sonnet to produce it.

**Fix:** Capture a real Sonnet response to `auditPhaseCompletion` where criterion 10 fires, save to `tests/fixtures/agent-output/design-rubric-criterion-10-pm-gap.txt`, add a producer test that verifies the fixture contains `[PM-GAP]` prefix. Same pattern as existing producer tests in `phase-completion-auditor.test.ts`.

**Impact:** Low (tests pass, behavior works in production) but required by the producer-consumer chain rule in CLAUDE.md. This is a coverage gap, not a correctness bug.

---

### Design agent bundles visual sub-questions inside PM escalation items (2026-04-12)

When the design agent formulates `offer_pm_escalation` questions, it bundles visual/UX sub-questions inside what is otherwise a PM-scope question. Example: "Define the visual placement, persistence behavior, and dismissibility of the indicator — is it a nav bar label, banner, or badge?" mixes two PM decisions (persistence, dismissibility) with a design decision (which UI component). The Gate 2 three-way classifier correctly classifies the item as GAP: (PM-scope wins), but the PM brief now includes the visual sub-question that the PM shouldn't be answering.

**Fix:** Add instruction to the design agent system prompt and/or `offer_pm_escalation` tool description: "When formulating escalation questions, separate product-behavior decisions (what the user experiences, when something fires, who can access it) from visual/component decisions (what UI element to use, where it is positioned). The PM question must contain only the product-behavior decision. Strip visual sub-questions — you own those."

**Impact:** Medium — the PM is receiving questions they shouldn't answer, which adds noise and may cause them to make decisions that are rightfully the designer's. The design spec writeback captures the product decision correctly, but the PM brief is imprecise.

---

### Assess: isStandaloneConfirmation UX friction — factual PM answers without a confirmation keyword route to PM agent (2026-04-12)

`isStandaloneConfirmation()` requires a message to start with a known affirmative keyword ("confirmed", "approved", "yes", etc.). A human PM who types a factual answer ("Guest sessions are cleared on sign-up.") without prefixing it with a keyword will be routed back to the PM agent instead of closing the escalation and resuming design. This is correct behavior in the multi-turn sense (it keeps the conversation open), but may surprise users who expect their factual answer to close the loop.

**Assess in production:** Is the affirmative-keyword requirement causing confusion, or do users naturally say "confirmed — X" when they intend to close the escalation? If friction is observed, consider extending `isStandaloneConfirmation` to accept informational statements (no "?", no continuation request, no follow-up ask) as implicit closers — or add a UI affordance (e.g., the @mention message says "Reply with *confirmed* + your answer to close this gap").

**Impact:** Low urgency — the PM agent conversation remains open and will eventually get an explicit confirmation. No data loss.

---

### Assess: architect upstream escalation runs auditPhaseCompletion inside design brief (2026-04-12)

When the architect calls `offer_upstream_revision` and the user confirms, the platform calls `handleDesignPhase` with the constraint brief. If a design spec draft exists on the branch, `auditPhaseCompletion` fires inside that call — injecting design readiness findings into the upstream brief context. Likely benign (findings would be visible to the design agent responding to the constraint), but not the intent. Assess in production: if the audit noise pollutes the constraint-brief response, refactor to call `runDesignAgent` with a flag that skips the completion audit for upstream-revision briefs.

---

~~### Multi-turn escalation continuity — non-confirmation replies during escalation should continue the conversation~~ ✅ Done (2026-04-12)

Real incident: PM agent gave recommendation for #4 only. Human replied "approved for #4, ask for 1-3" — platform treated this as a standalone confirmation and resumed design, losing the request for further recommendations.

**Fix:** `isStandaloneConfirmation()` added as a stricter gate for escalation notification replies. A message that starts with an affirmative keyword but also contains a question mark, "can you", "recommend for", "ask (them|it|the pm)", or similar continuation patterns is NOT a standalone confirmation — it routes back to the escalated agent (PM/architect) for continued conversation. The notification stays active with updated `recommendations` from the latest agent response. Only a clean affirmative (no follow-up request) clears the notification and resumes design. N34 integration test covers (partial approval routes to PM, notification updated, design not resumed).

~~### Escalation reply auto-routing — PM/Architect reply in thread should re-trigger design agent~~ ✅ Done (2026-04-07)

`EscalationNotification` store added to `conversation-store.ts`. After posting the PM @mention, `setEscalationNotification` records the open question. On the next message, if `userId` matches `roles.pmUser` (or `architectUser`), the platform clears the notification and injects `"PM answered: [question] → [answer]"` as the design agent's user message, resuming the design flow. N16/N17 integration scenarios cover PM reply and non-PM bypass. `app.ts` extracts `userId` from the Slack event and passes it through.

---

~~### Design agent escalation must be platform-enforced, not prompt-dependent~~ ✅ Done (2026-04-07, root cause fix 2026-04-13)

Post-run rubric gate in `runDesignAgent`: if `designReadinessFindings` contains `[PM-GAP]` tagged findings after the agent runs and agent did not call `offer_pm_escalation`, platform auto-triggers escalation. `buildDesignRubric` criterion 10 instructs Sonnet to output `[PM-GAP]` prefixed findings — a rubric-level tag only, never written to the design spec. N18 covers this path.

**Root cause fix (2026-04-13):** The original implementation used a two-layer approach where (1) the design agent was allowed to write `[type: product] [blocking: yes]` markers into the design spec, and (2) a pre-run gate re-read those markers each turn. This was architecturally wrong — the design spec should never contain PM-scope questions. The pre-run gate (`extractProductBlockingQuestions`), the marker-clearing function (`clearProductBlockingMarkersFromDesignSpec`), and the N42 test have all been deleted. Criterion 10 now outputs `[PM-GAP]` (rubric-level only). The design agent system prompt explicitly prohibits `[type: product]` in spec open questions. N19 updated to verify no false-positive gate fires on engineering-only open questions.

~~### PM agent must run on escalation confirmation — not raw question dump~~ ✅ Done (2026-04-07)

Escalation confirmation now runs `runPmAgent` (or `runArchitectAgent`) with the blocking questions as its brief (`readOnly: true`). The agent produces concrete recommendations, then a separate `postMessage` @mentions the human PM/Architect: "review the recommendations above and reply here to confirm or adjust." S4 Turn 2 and S18 Turn 2 updated to reflect the new behavior.

---

### PM agent must run on escalation confirmation — not raw question dump (2026-04-07)

When the user confirms escalation ("yes"), the platform currently posts the raw blocking questions directly to Slack and returns. The PM agent never runs. The human PM receives a cold list of questions with zero analysis or recommendations. This violates Principle 6 (never bypass an agent) and the recommendation-first rule.

**What should happen:**
1. User says "yes" → platform calls `runPmAgent` with the blocking questions as its opening brief
2. PM agent produces recommendations for each gap (its recommendation-first rule applies here too)
3. Platform posts that PM agent response + @mentions the human PM for approval/correction
4. Human PM replies → auto-routed back to design agent with the answer

**Implementation:** Replace the raw `postMessage` in the escalation confirmation path with a `withThinking` PM agent run. The `offer_pm_escalation` question string becomes the PM agent's `userMessage`. The PM agent's response is posted as the escalation notification (with @mention appended).

---

~~### PM agent architecture gap escalation — prose mention instead of tool call (2026-04-13)~~ ✅ Done (2026-04-13)

When the PM identified an architecture gap during the design-questions-answering context, it mentioned "say yes and I'll escalate to the architect" in prose — but `PM_TOOLS` had no `offer_architect_escalation` tool. The platform had nothing to act on; the user's "yes" was consumed by the next pending escalation.

**Fix:** Added `offer_architect_escalation(question)` to `PM_TOOLS`. Handler returns success (tool call is captured in `toolCallsOut`). In the auto-close path, after PM saves the spec, platform checks `continuationToolCalls` for `offer_architect_escalation`. If found: set `pendingEscalation` to architect, post a structured message listing the gap and "say yes to bring the architect in", skip running the design agent. Design can continue; the architect addresses the gap in the engineering phase. N43 integration test covers.

---

~~### Escalation loop — [type: product] markers in design spec not cleared after PM resolves them (2026-04-13)~~ ✅ DELETED as symptom fix (root cause fix supersedes, 2026-04-13)

This was a symptom fix for the escalation loop. The actual root cause: the design spec was being used as a communication channel for PM-scope state — rubric criterion 10 wrote `[type: product] [blocking: yes]` markers into the spec, and the pre-run gate re-read them each turn. The root cause fix (same date) eliminated the mechanism that produced the markers. `clearProductBlockingMarkersFromDesignSpec`, `extractProductBlockingQuestions`, and N42 test have been deleted as obsolete. See "Design agent escalation must be platform-enforced" above for the root cause fix details.

---

~~### Per-feature in-flight lock — concurrent Slack messages cause double-fire (PM + UX Designer respond to same message)~~ ✅ Done (2026-04-13)

Root cause: PM agent runs take 10s+. When a Slack retry or rapid follow-up arrived while the first run was still active, both invocations processed concurrently — PM agent ran for the first, design agent ran for the second, both posting responses to the same thread.

**Fix:** Module-level `featureInFlight = new Map<string, boolean>()` in `message.ts`. Set synchronously before the first `await`; cleared in `finally` block. Second invocation checks the lock and immediately posts "_Still working on your last message — I'll be with you shortly._" via `chat.postMessage` and returns — no agent call made. N41 integration test covers (blocking mock on PM agent, second message confirmed as rejected).

---

~~### Escalation auto-close when PM saves spec in continuation path — "agree to both" routing bug~~ ✅ Done (2026-04-13)

Root cause: `isAffirmative()` keyword list did not include "agree" → "agree to both your recommendations" returned false → code took the continuation path → PM ran again via tool, saved spec, but `clearEscalationNotification` was never called → all subsequent messages routed to PM indefinitely.

**Fix (Principle 8 — structural detection):** After `runPmAgent` in the continuation path, inspect `toolCallsOut` for any spec-save tool (`save_product_spec_draft`, `apply_product_spec_patch`, `finalize_product_spec`). A save call is a deterministic signal the escalation is resolved — `clearEscalationNotification` fires and design resumes with an injected brief, regardless of how the human phrased their message. N40 integration test covers.

Also added `toolCallsOut` parameter to `runPmAgent` so the continuation path can collect tool calls from inside the PM run without changing the return type.

---

~~### PM agent editorializing about phase transitions — "Are we ready to hand this to design?"~~ ✅ Done (2026-04-13)

PM agent was saying "These don't block engineering. They block design handoff." (contradicting context it doesn't have) and asking "Are we ready to hand this to design?" (design is already active — the platform resumes it). Fixed via system prompt addition: when called to answer a design team escalation, the PM agent's role is narrow — answer, save, confirm, stop. Explicit prohibition against offering to "hand off to design" or "flag anything else."

---

~~### Prompt caching — system prompt split into stable/dynamic blocks~~ ✅ Done (2026-04-13)

`splitSystemPrompt(prompt, dynamicMarker)` added to `runtime/claude-client.ts`. Splits the system prompt at the first occurrence of `dynamicMarker` — stable block (persona, tools, rules) gets `cache_control: { type: "ephemeral" }`, dynamic block (currentDraft, approvedSpecs) is uncached. `runAgent` accepts `string | TextBlockParam[]` for backward compatibility. All three agents (`buildPmSystemBlocks`, `buildDesignSystemBlocks`, `buildArchitectSystemBlocks`) call `splitSystemPrompt` at their respective markers. ~80% fewer cache-write tokens per agent call when spec context changes. N39 integration test and 3 unit tests in `claude-client.test.ts` cover.

---

~~### Spec writeback appends PM decisions alongside vague criteria — design agent re-escalates same gaps~~ ✅ Done (2026-04-12)

Root cause of the "stuck in escalation loop": `patchProductSpecWithRecommendations` Haiku prompt instructed Haiku to "add confirmed decisions to the spec" — Haiku added them as new entries but left the original vague criteria ("soft, non-intrusive", "ambient awareness") in `## Acceptance Criteria`. Design rubric criterion 10 re-fired on the original vague language every run.

**Fix:** Haiku prompt rewritten with 7 explicit rules: (1) REPLACE vague criteria — find the criterion that the PM recommendation addresses, remove the vague version, insert the concrete one; (2) list the specific vague words to replace ("soft", "non-intrusive", "ambient", "proactively", "seamlessly", "minimal", "appropriate", "subtle"); (3) STRIP visual/design details from PM recommendations before writing to spec (no hex values, RGBA, component choices, pixel positions); (4) keep ALL existing concrete criteria; (5) route to correct sections; (6) HYGIENE PASS — scan entire spec for any remaining vague language beyond current PM recommendations and replace anything whose meaning can be inferred from existing PM decisions; (7) output complete section body. PM agent posts the spec-update message (not the design agent). 6 new producer tests cover the replace rule, vague word list, strip rule, and hygiene pass.

---

### ⚠️ Real-agent fixture for `pm-escalation-spec-writer.ts` Haiku prompt (2026-04-12) — HIGH PRIORITY

Consumer and producer unit tests exist for `pm-escalation-spec-writer.ts`, but the producer tests only verify that the system prompt **contains** the right language — they do not prove that Haiku actually produces `##` output in practice. Per the fixture sourcing rule, this is a false-confidence gap.

**What's needed:**
1. Run `patchProductSpecWithRecommendations` against a real Haiku call with a sample question + recommendations pair (use any approved onboarding product spec as the base)
2. Capture the actual Haiku response and commit it to `tests/fixtures/agent-output/pm-spec-patch-haiku.md`
3. Add a producer test that loads the fixture via `readFileSync` and asserts: (a) response contains `##` headers, (b) response does NOT contain preamble prose before the first `##`, (c) entries are concrete (not "handle gracefully"-style vague language)

**Why high priority:** Without this, the `##` guard in `patchProductSpecWithRecommendations` (which skips `saveApprovedSpec` if no `##` in patch) is untested against real Haiku output. If Haiku consistently returns prose without `##` headers, the writeback silently no-ops on every escalation — the same gap that triggered this entire feature.

---

### Escalation brief pollutes design conversation history (2026-04-07)

When `runPmAgent` runs during escalation confirmation (`readOnly: true`), it appends the escalation brief (`"The UX Designer is blocked on these product questions..."`) and the PM agent's recommendations to the design feature's conversation history. These are PM-context messages in a design-context history — they'll appear in subsequent design agent turns as prior context, which is slightly polluting.

**Fix:** Either (a) run the PM agent against a separate ephemeral history (not `getHistory(featureName)`) during escalation runs, or (b) clear the two appended messages immediately after the agent returns. Option (a) is cleaner — the escalation recommendation pass should not bleed into the design conversation.

---

---

---

### Escalation reply: accept only within a timed window (2026-04-11)

`EscalationNotification` currently accepts **any** reply in the thread as the PM/Architect answer — including the human product owner if they jump in before the PM responds. At scale, the escalation reply window should be time-bounded (e.g., ~5 minutes after the @mention) so that a user follow-up message doesn't accidentally get consumed as a PM recommendation. A simple `timestamp` field on `EscalationNotification` plus a check in `message.ts` would close this.

**Why not now:** Solo-team context — the PM *is* the product owner in most sessions; ambiguity is low. The deterministic behavior of "any reply resumes design" is strictly better than the previous silent-drop bug. Timed window is a precision improvement.

---

### Parallel PM + architect routing for borderline escalation questions (2026-04-11)

The classifier routes each gap question to either PM or architect — never both. Questions that sit on the PM/architect boundary (e.g. "what conversation data must survive sign-up?" is PM-scope; "how is the session store structured?" is architect-scope) are handled by the classifier's WHAT/HOW decision rule, which is probabilistic.

For genuinely borderline questions — where the WHAT and the HOW are intertwined — the right answer is to route to both PM and architect in parallel, let each agent answer from their domain, and surface both responses before design resumes.

**What this needs:**
- A `classifyForArchitectGaps` classifier (parallel to `classifyForPmGaps`) that identifies questions requiring architect input
- Both classifiers run on the extracted question list
- Questions that match only PM → PM escalation only
- Questions that match only architect → architect escalation only
- Questions that match both → parallel escalation: both agents run, both responses shown, design waits for both confirmations
- `PendingEscalation` extended to support `targetAgent: "pm" | "architect" | "both"`

**Why not now:** Requires a new `classifyForArchitectGaps` classifier, parallel escalation state, and a `"both"` resolution path in the confirmation flow. The WHAT/HOW prompt framing added in Apr 2026 is strong enough to handle most cases correctly — this is a precision improvement, not a blocking gap.

---

### Pre-commit hook: statically detect behavioral instructions in agent system prompts without platform checks (2026-04-07)

Prompt-rule-to-platform-check conversions keep happening because there's no automated gate. When a developer adds a behavioral instruction to a system prompt in `agents/` (e.g. "call X when Y happens"), there's no check that a corresponding platform enforcement exists in `runtime/` or `message.ts`.

**What this needs to do:**
- Parse `agents/*.ts` system prompts for imperative behavioral instructions (patterns: "call X when Y", "if Z happens, do W", "you must X", "always X before Y")
- For each detected instruction, check whether a corresponding platform-side enforcement exists (function reference, check, or gate in `runtime/` or `interfaces/slack/handlers/message.ts`)
- If an instruction has no platform enforcement, block the commit and list the unmatched instructions

**Design challenges:**
- False positive rate is high — many prompt instructions are informational, not behavioral (e.g., "tools are listed above", "the spec format is...")
- "Corresponding platform check" is hard to define statically — a behavioral instruction for tool A might be enforced via a post-run check on state B
- Needs to be specific enough to catch real gaps (escalation trigger, finalization gate, brand drift) without flagging every sentence in the system prompt

**Approach to evaluate:** Instead of full static analysis, define an explicit allowlist of known-enforced behaviors in a manifest file (e.g., `.platform-gates.json`). The hook checks: for every behavioral instruction pattern found, does a matching entry exist in the manifest? If a developer adds a prompt rule, they must also add it to the manifest with a pointer to the enforcement code — or the commit is blocked. The manifest itself becomes the audit trail.

---

### ~~`auditSpecDecisions` and `extractLockedDecisions` have zero tests — critical gap (2026-04-07)~~ ✅ DONE

Both functions now have comprehensive consumer + producer tests in `tests/unit/spec-auditor.test.ts`. `auditSpecDecisions`: 7 consumer tests (OK, MISMATCH parsing, malformed lines, multiple corrections, model verification) + producer tests (system prompt format instruction). `extractLockedDecisions`: consumer tests (short-circuit, bullet detection, empty response, model verification) + producer tests. `applyDecisionCorrections`: 5 unit tests (replace, skip, all-occurrences, multiple, empty). Coverage: 99.11% stmts, 100% functions.

---

### ~~Producer tests missing for all 13 LLM-dependent gates (systematic gap) (2026-04-07)~~ ✅ DONE

All 13 gates now have consumer + producer tests. Producer tests verify system prompts contain required format instructions. Consumer tests verify parsing of mocked LLM output. Full list: `auditSpecDraft`, `auditPhaseCompletion`, `auditSpecRenderAmbiguity`, `identifyUncommittedDecisions`, `generateSaveCheckpoint`, `classifyIntent`, `classifyMessageScope`, `isOffTopicForAgent`, `isSpecStateQuery`, `classifyApprovedPhaseIntent`, `auditSpecDecisions`, `extractLockedDecisions`, `classifyForPmGaps`. `summarizeUnlockedDiscussion` has consumer tests only (lower risk — returns free-form bullet summary with no structural gate dependency).

---

### N16/N17 escalation reply tests validate via fallback, not real userId match (2026-04-07)

N16 sets `process.env.SLACK_PM_USER` but `loadWorkspaceConfig()` reads from the workspace config struct — the env var may not be wired through in test, so N16 passes via the `!roles.pmUser && !roles.architectUser` fallback (any user counts as a valid reply when roles aren't configured). In production with real roles, the `userId === roles.pmUser` path is what fires. The correct test would inject a mock `WorkspaceConfig` with `roles.pmUser = "U_PM_123"` to exercise the actual userId match branch.

**Fix:** Update N16/N17 to mock `loadWorkspaceConfig` and verify the userId === roles.pmUser path specifically, separate from the no-roles fallback path.

---

### `buildDesignStateResponse` test must assert Slack char limit and content shape (2026-04-06)

Current unit tests use short inline specs and only assert that content *appears* — not that the response is appropriately shaped. Two production bugs slipped through: (1) raw Design Direction bullet lists blew Slack's 4000-char limit, (2) false positive from cross-line regex in `findUndefinedScreenReferences`. Neither was caught because tests didn't assert the right invariants.

**Fix:** Add a test that loads `onboarding-design-full.md` (the real full-length spec) and asserts:
- Response length ≤ 4000 chars (Slack hard limit)
- Response contains the bold summary statement from Design Direction
- Response does NOT contain `--bg:` or other bullet-list implementation detail
- No finding mentioning "logged-out session" (cross-line false positive regression)

---

### Renderer parsing tests must use real spec fixtures (fixture rule violation, 2026-04-06)

`tests/unit/html-renderer.test.ts` uses a hand-crafted `MINIMAL_SPEC` with `Heading: "..."`, `Tagline: "..."`, `Placeholder: "..."` syntax. The real onboarding spec uses none of these formats — it uses `wordmark:`, inline `tagline "..."`, `placeholder text "..."`. All 36 tests passed while the parser was silently wrong for every field. Discovered only when the preview was visually inspected.

**Fix:** Add parsing-specific tests that load the real onboarding spec from `tests/fixtures/agent-output/onboarding-design-brand-section.md` and assert:
- `wordmark` = "Health360" (not "Sign in to Health360")
- `tagline` = "All your health. One conversation"
- `placeholder` = "Ask anything about your health"
- `authHeading` = "Sign in to Health360"
- `chips` = 0 (spec has no chip content yet — TBD placeholder shown)

These tests must fail if a parser regression is introduced. MINIMAL_SPEC can remain for edge-case tests (fallback behavior, apostrophes, cap-at-3) but must NOT be used for format-sensitive parsing assertions.

---

### Coverage gaps — uncovered paths in critical files (updated 2026-04-20)

Overall: 92.42% stmts / 84.27% branch / 83.18% funcs / 93.89% lines. Remaining gaps:

**`interfaces/slack/handlers/message.ts` — 89% stmts, 78% branch, 65% funcs**
- Routing/orchestration functions still in closures (not yet extracted to testable functions)
- `general.ts`, `reactions.ts`, `app.ts`: 0% — Slack event wiring layer has no tests at all

**`runtime/github-client.ts` — 77% stmts**
- Several GitHub API interaction paths untested (error handling, edge cases)

**`runtime/claude-client.ts` — 100% stmts**
- ~~No-toolhandler error path~~ covered
- ~~Thrown error path~~ covered

**Priority order:** message.ts routing extraction (biggest function% gain); then github-client.ts error paths; then Slack wiring layer last (requires Bolt mocking).

---

### ~~Refactor: extract named functions from tool handler closures in `message.ts`~~ ✅ DONE

All three agent tool handlers (PM, Design, Architect) extracted from `message.ts` closures to `runtime/tool-handlers.ts` as standalone functions with typed context (`ToolHandlerContext`, `DesignToolCtx`) and injected dependencies (`PmToolDeps`, `DesignToolDeps`, `ArchitectToolDeps`). 65 unit tests in `tests/unit/tool-handlers.test.ts`. `message.ts` functions 59% → 65%; overall functions 80% → 83%. Remaining message.ts functions (routing, orchestration) require a second pass extraction.

---

### Gap: Pre-commit new-agent gate has no smoke test

The pre-commit hook in `.claude/settings.json` that blocks new `run[X]Agent()` function exports without an always-on audit block (`[X]ReadinessNotice` or `ALWAYS-ON-AUDIT-JUSTIFIED:` comment) has never been triggered in a real commit. The hook logic is live but unverified. If the regex is wrong, a new agent could ship without the required audit block and the gate would silently pass.

**Fix:** Add a smoke test script at `tests/hooks/new-agent-gate.sh` that:
1. Stages a temp file with `export async function runFooAgent(` and no audit comment
2. Invokes the hook command directly (pipe the staged diff to the command)
3. Asserts exit code indicates block
4. Stages the same file with `// ALWAYS-ON-AUDIT-JUSTIFIED: test` present
5. Asserts exit code indicates pass
6. Cleans up

Run as part of the test suite via `vitest` or as a standalone `npm run test:hooks` script. Until this passes, the gate's correctness is assumed, not verified.

---

### Gap: Scenario 4 smoke test accepts save_design_spec_draft as a pass

Scenario 4 (`apply_design_spec_patch` auto-save after user agreement) accepts either `apply_design_spec_patch` or `save_design_spec_draft` as a passing result. The test context sets `currentDraft` in the `AgentContext` but the agent may not read it from the test message construction — the agent has no prior save call in the conversation that would make it aware a draft exists. The durable fix: add a prior assistant tool call (`save_design_spec_draft`) to the message history in the test's `beforeAll` block, then verify the agent's response to "lock those in" uses `apply_design_spec_patch` specifically.

---

### Trust Step 0.5c — URL-based brand comparison ("compare with this site")

**The problem today:** When a design preview doesn't match a reference site visually, the user has to describe every discrepancy in plain English — which is unreasonable when there are 10+ differences. "Compare with this URL" is the natural, correct interaction. But the design agent can't fetch URLs (it receives a system prompt and user message, no tool access), so the interaction breaks down and the agent either asks for hex codes (wrong) or screenshots (wrong).

**What this adds:**

Platform-layer URL brand extraction, triggered when the user provides a URL in the context of a visual comparison request. Same enforcement pattern as render intent — Haiku classifies the message, platform acts before the agent runs.

**Flow:**
1. Haiku classifies user message: contains a URL + visual comparison intent ("make it match this", "compare with", "should look like") → `"brand-url-comparison"` | `"other"`
2. Platform WebFetches the URL
3. Platform extracts CSS custom properties (`--token: value`) and any inline color values from the fetched HTML/CSS
4. Platform injects a `[REFERENCE SITE VALUES — extracted from <url>]` block into the agent's enriched user message, alongside the current BRAND.md
5. Agent compares extracted values vs BRAND.md, surfaces differences, proposes BRAND.md updates, generates corrected preview with proposed values

**Why platform-layer, not agent-layer:**
The agent cannot call WebFetch — it outputs text only. Any "compare with URL" that reaches the agent unaided will fail. This must be intercepted and resolved before the agent runs, same as render intent.

**CSS extraction requirements:**
- Extract `--custom-property: value` declarations from `<style>` tags and inline styles
- Extract color values from computed styles where custom properties aren't used
- Handle both hex (`#RRGGBB`) and rgb/rgba formats — normalize to hex for comparison
- Non-fatal: if the URL is unreachable or returns no CSS variables, inject a note and let the agent proceed without reference values

**BRAND.md update flow:**
Agent proposes specific BRAND.md changes (e.g. "update `--violet` from `#7C6FCD` to `#8B5CF6`"). User approves → platform updates BRAND.md on main branch AND patches the spec Brand section to match. Both committed atomically.

---

### Trust Step 0.6 — Authoritative doc auto-commit on spec approval

**The problem today:** All three spec-producing agents draft proposed changes to their authoritative docs inline in every approved spec (e.g. `[PROPOSED ADDITION TO DESIGN_SYSTEM.md]`). But applying those changes to the actual doc — `DESIGN_SYSTEM.md`, `PRODUCT_VISION.md`, `SYSTEM_ARCHITECTURE.md` — requires a human to open GitHub, find the inline block, and manually paste it into the doc file. This is a non-technical operation with a high friction cost and frequent skip rate.

**What this adds:**

On Slack "approved" for any spec type, the platform:
1. Reads the approved spec content
2. Searches for `[PROPOSED ADDITION TO <doc>.md]` ... `[END PROPOSED ADDITION]` blocks
3. Reads the current authoritative doc from GitHub (e.g. `DESIGN_SYSTEM.md`)
4. Appends the proposed addition to the appropriate section
5. Commits both the approved spec AND the updated authoritative doc to main in a single atomic operation

**Why this is the right approach:**
- The human already approved the spec, which includes the proposed doc update
- The agent writes the proposed text as ready-to-apply content — not a diff, not a to-do list
- Committing both atomically means the spec chain and authoritative docs are always in sync
- Non-technical users never need to touch GitHub

**Limitations:**
- Platform appends the proposed text to the doc; it does not attempt structural reorganization. If the proposed addition needs to go in a specific section rather than at the end, the human can edit after the fact.
- If the doc doesn't exist yet (first feature), platform creates it with the proposed content.
- One proposed addition per spec type (if the agent drafts multiple blocks, platform applies all of them in order).

**Implementation:** `interfaces/slack/handlers/message.ts` (all three approval paths), `runtime/github-client.ts` (new `appendToAuthoritativeDoc()` function). No new agent work — the agents already produce the proposed text.

**Why before Trust Step 1:** This closes the human-in-the-loop gap for doc updates before we add platform monitoring. The monitoring in Trust Step 1 will surface doc/spec inconsistencies — those inconsistencies are only meaningful once docs are being updated reliably.

---

### Trust Step 1 — Thread health: proactive degradation before context limit

**The problem today:** When a thread gets too long, the Anthropic API call silently fails and the user sees "Something went wrong." They have no warning it was coming, no idea what context was lost, and no clear path forward. This is the single biggest trust destroyer in the current system.

**What this adds:**

**Turn counter in conversation store:**
- Track turn count per thread alongside history
- Estimate token budget consumed: system prompt + context files (loaded fresh each turn) + history length
- No exact token counting needed — a conservative estimate based on character counts is sufficient

**Proactive checkpoint message (at ~70% estimated capacity):**
When the thread approaches the limit, post proactively (not reactively) before anything fails:

> ⚠️ *This thread is getting long — the AI's context window is ~70% full.*
>
> *What's committed to GitHub:* [spec link]
> *Everything else in this thread (decisions discussed but not yet in the spec) will need to be re-established if this thread can't continue.*
>
> *You can keep going here for now, or start a fresh top-level message to continue with a clean slate.*

**Graceful final response at limit (replaces "Something went wrong"):**
Instead of a generic error, the context-limit error path (already in `withThinking`) posts:
> *This thread has hit the AI's context limit.* Your spec is safe on GitHub — nothing committed is lost. Start a fresh top-level message and I'll pick up from the spec.

The context limit error handling already exists — this step improves the proactive warning *before* it fires.

**Implementation:** `runtime/conversation-store.ts` (turn counter), `interfaces/slack/handlers/thinking.ts` (context limit message, already partially done), `interfaces/slack/handlers/message.ts` (proactive warning check per turn).

---

---

### Trust Step 2b — Extend save checkpoint to PM and architect agents

**The problem today:** `buildCheckpointFooter` + `generateSaveCheckpoint` fire only on design spec saves (DRAFT/PATCH). PM and architect agents produce approved specs too — users face the same "what did I just lose?" ambiguity after approving a product or engineering spec, with no committed-vs-discussed boundary shown.

**What this adds:** Call `generateSaveCheckpoint` on every approved PM spec save (`saveApprovedProductSpec`) and every approved architect spec save (`saveApprovedEngineeringSpec`). Post the checkpoint footer alongside the GitHub link, same format as the design agent.

**Implementation:** `interfaces/slack/handlers/message.ts` (PM approval save path, architect approval save path). No changes to `conversation-summarizer.ts` — the function is already generic.

---

### Trust Step 3 — Redis persistence: history survives deployments and scales across instances

**The problem today:** Conversation history and confirmed agent state are stored in two local disk files (`.conversation-history.json`, `.confirmed-agents.json`). This means:
- A redeployment to any new server loses all thread history
- Multiple bot instances would each have their own separate, conflicting state
- There is no TTL or cleanup — files grow unboundedly

This is documented in `DECISIONS.md` as a known shortcut. It was acceptable while the bot ran on one machine for one team. It is not acceptable for a platform that sells reliability.

**What this adds:**
- Conversation history and confirmed agent state move from disk to Redis
- Redis client (`ioredis`) added as a dependency
- `runtime/conversation-store.ts` updated to read/write Redis instead of the local JSON files
- Session TTL configurable per workspace (default: 30 days)
- `REDIS_URL` added to `.env.example` and `WorkspaceConfig`
- Graceful degradation: if Redis is unavailable, fall back to in-memory (not disk) with a Slack warning — history may not survive a restart but the bot stays operational
- Conversation summary cache (`runtime/conversation-summarizer.ts`) moved to Redis — currently in-memory, so the first message after a restart on a long thread re-pays the Haiku summarization cost
- Adaptive Slack truncation: currently pre-truncates at 12,000 chars (a conservative guess). Proper fix is to catch `msg_too_long` from `chat.update` and retry with progressively shorter content until it succeeds, rather than blindly cutting at a fixed limit

**This is Step 5 of the original backlog, pulled forward.** It was originally bundled with deployment because "Redis needs a server." That thinking is wrong — Redis can be added as a managed add-on to any environment (Railway, Fly.io, Upstash) independently of deploying the bot. Do not wait for full production deployment to fix the memory persistence model.

**Note on deployment:** The full agentic-sdlc production deployment (Dockerfile, CI pipeline, health checks) remains at Step 5. Only the Redis persistence piece is pulled forward here.

---

### Trust Step 4 — Infrastructure resilience and atomic writes

**The problem today:** Trust Steps 1–3 address user-facing trust gaps. This step addresses infrastructure trust gaps: what happens when GitHub, Anthropic, or Slack fail. Currently: silent generic errors, no retries, no write verification, and potential duplicate processing from Slack's at-least-once delivery. A spec save that partially fails leaves the spec in an unknown state with no signal to the user.

**What this adds:**

**GitHub API retry with exponential backoff:**
- All GitHub operations (`saveSpec`, `loadSpec`, `getFeaturePhase`, etc.) wrapped in retry logic: 3 attempts, exponential backoff (1s, 2s, 4s), jitter
- If GitHub is unreachable after all retries, post a specific message: *"GitHub is unreachable right now. Your work is safe in this thread — I'll save as soon as it comes back. No decisions are lost."*
- Network errors and 5xx responses are retried; 4xx (auth, not found) are not

**Write verification — atomic spec saves:**
- After every spec write to GitHub, read the file back and verify the content hash matches
- If mismatch or missing: surface immediately — *"Spec save failed — your draft is safe in this thread. Retrying..."* — and retry up to 3 times before surfacing as a hard failure
- Ensures Trust Step 2's committed/discussed boundary is actually reliable, not just claimed

**Anthropic API failure handling:**
- Rate limits (429) and service errors (529, 5xx) get explicit user messages with recovery context, not "Something went wrong"
- Rate limits: *"I've hit an API rate limit — retrying in a moment."* with automatic retry
- Service outages: *"The AI service is temporarily unavailable. Your spec and thread are safe — try again in a minute."*
- Distinguishes rate limits from context limits from service outages — each gets the correct message

**Slack event idempotency:**
- Deduplicate incoming Slack events by `event_id` before processing — Slack's at-least-once delivery means without this, duplicate events cause duplicate writes, duplicate Slack responses, and duplicate GitHub commits
- Event IDs cached in Redis (from Trust Step 3) with a short TTL (5 minutes)

**Slack delivery verification:**
- If a Slack API call to post a message fails, log it and retry rather than silently dropping the agent response
- The user always gets a response or an explicit failure message — never silence

**Why before 2.6 and all subsequent steps:**
Every step from 2.6 onwards assumes writes are reliable and reads are consistent. Spec revision, phase detection, Orchestrator monitoring, spec-validator gates — all of these build on the assumption that what's in GitHub is correct and that writes succeeded. That assumption is false without this step.

---

### Trust Step 4b — Auto-retry loop: handle second truncation in PATCH recovery

**The problem today:** When a DRAFT block is truncated (spec too large), the platform auto-retries with a SYSTEM OVERRIDE to force PATCH. But if that retry also fails to produce a valid PATCH block (truncated again, or falls back to a generic response), the user sees: *"Unable to apply the changes automatically. Please say which specific section you'd like to update."* This still puts the user in the recovery loop.

**What this adds:**

**Retry loop with progressively scoped instruction:**
- On first auto-retry failure, do not surface the error immediately
- Instead, retry a second time with a more constrained instruction: pick the single most-changed section from the original request and ask the agent to patch only that section
- If that also fails, then surface the "specify a section" message — but attach the list of sections from the existing spec so the user can pick one by name without reading the spec themselves
- Cap at 3 total attempts before surfacing the actionable fallback

**Section inventory from existing draft:**
- When surfacing the fallback message, extract all `## Section` headers from the existing draft and include them in the message: *"Which of these sections needs the most attention: [list]?"*
- Removes cognitive load — user doesn't need to remember section names

**Why deferred (not a blocker for current work):**
The first auto-retry succeeds in the vast majority of cases — a second failure only happens when a single PATCH section is also too large to fit in one response, which requires an unusually long spec and an unusually large change. This is a tail case. The first-attempt auto-retry (Trust Step 4's predecessor) is already in place. Fix this before going to production.


---

### Step 2.5a — Agent persona upgrades + authoritative doc ownership

All three spec-producing agents are upgraded simultaneously. This is one step, not three — the pattern is identical across PM, design, and architect, and shipping it piecemeal creates inconsistency.

**Why before 2.5b and 2.6:** These upgrades change what the agents produce (new required spec sections, authoritative doc drafts). The spec schema enforcement step (Trust Step 4c) validates those sections. The spec validator (Step 4) enforces them at approval. Both downstream steps depend on knowing which sections are required — this step defines that.

---

### PM discussion and spec-save coexist in escalation-continuation turn — design resumes before discussion is acknowledged

**The problem:** When the PM calls `apply_product_spec_patch` AND surfaces new discussion in the same response (e.g., a product vision conflict), the platform's `escalation-auto-close` fires on the save and immediately resumes the design agent. The PM's discussion text appears in the same Slack turn as the design agent's next response — the user never gets a chance to weigh in on the PM's discussion before design continues.

**Root cause:** `escalation-auto-close` fires on any PM spec save, unconditionally. It doesn't check whether the PM's response also contains unresolved discussion or open recommendations.

**Correct behavior:** If the PM saves AND discusses in the same turn, design should not auto-resume until the user acknowledges the discussion. One option: require PM to separate save turns from discussion turns via platform enforcement. Another: detect unresolved PM questions in the PM response text and hold design until acknowledged.

**Impact:** Low frequency (only when PM combines save + discuss). Not a correctness failure — no decisions are lost. Design gaps surfaced in the same turn can be answered in the next PM round. UX confusion only.

---

### Move `[PLATFORM ...]` blocks from user message to system prompt (backlog)

Currently ~15 `[PLATFORM ...]` blocks (brand drift notice, quality notice, readiness notice, upstream audit, PM guidance) are injected into the LLM's **user message** turn. This means the agent sees them as user-supplied context — and could echo tool names or block references back to Slack if not explicitly instructed not to.

The structural fix is to move these blocks to the **system prompt** rather than the user message. System prompt content is architecturally "platform context" — the agent doesn't repeat or reference it, it just operates within it. This eliminates the tool-name leakage risk at the source rather than relying on prompt instructions.

**Not urgent** — tool names were stripped from injection blocks in the April 2026 commit (Step 5a). But the underlying structure still passes platform state through the user message. Move to system prompt in a dedicated refactor pass.

---

**PM agent → CPO-level**

Persona: leads product organizations of 50+ PMs, set company-level product vision, made portfolio-level tradeoffs, launched multiple 0→1 products, scaled to 100M+ users. Operates simultaneously at feature level (spec shaping) and product level (cross-feature vision coherence).

New behaviors:
- Holds the full product in mind at all times — evaluates every feature decision against the whole product, flags contradictions with previously approved specs before proceeding
- Owns `PRODUCT_VISION.md` — drafts proposed changes inline in every approved spec, ready-to-apply text not a to-do list
- Cross-feature coherence — reads all approved `.product.md` specs before every response

New required spec section (after Non-Goals, before Open Questions):
```
## Product Vision Updates
<Proposed additions or changes to PRODUCT_VISION.md. Written as ready-to-merge text.>
If no updates needed: "No product vision updates — this feature operates entirely within existing vision constraints."
```

**Design agent → Design Director level**

Persona: has led design organizations, set design systems for products used by millions, directed brand evolution through multiple product generations.

New behaviors:
- Holds the full product design in mind — evaluates every decision against the product's established design language
- Owns `DESIGN_SYSTEM.md` — reads it before every session; drafts additions/changes inline in every approved spec
- Reads all approved `.design.md` specs before opening proposal — flags contradictions with established patterns
- `DESIGN_SYSTEM.md` bootstrap — if no design system doc exists (first feature), drafts the initial `DESIGN_SYSTEM.md` as part of the approved spec

New required spec section (after Accessibility, before Open Questions):
```
## Design System Updates
<Proposed additions or changes to DESIGN_SYSTEM.md. Written as ready-to-apply text.
Covers: new components, updated tokens, new interaction patterns, naming conventions.>
If no updates needed: "No design system updates — this feature uses only established patterns."
```

**Architect agent → strengthen "always draft" language**

The spec section already exists. Change from "list required updates" to "write the proposed additions/changes as `[PROPOSED ADDITION TO SYSTEM_ARCHITECTURE.md]` blocks — ready to paste in, not a to-do list." Add enforcement: spec cannot be marked approval-ready until this section contains actual proposed text.

**WorkspaceConfig + context-loader changes:**
- Add `designSystem` path to `WorkspaceConfig`: `PATH_DESIGN_SYSTEM` env var, defaults to `specs/design/DESIGN_SYSTEM.md`
- Update `loadDesignAgentContext()` to read `DESIGN_SYSTEM.md` and all approved `.design.md` specs
- Update `loadPmAgentContext()` to read all approved `.product.md` specs for cross-feature coherence
- Add to `.env.example`

**Files:** `agents/pm.ts`, `agents/design.ts`, `agents/architect.ts`, `runtime/workspace-config.ts`, `runtime/context-loader.ts`, `.env.example`

**Tests:** Existing unit tests must still pass. New tests for: new required section present in prompt, cross-feature spec injected in prompt, no-specs-yet message present, PROPOSED ADDITION language in architect prompt.

**SYSTEM_ARCHITECTURE.md update:** Three-authoritative-docs table updated with Design Director + DESIGN_SYSTEM.md ownership.

---

### Trust Step 4c — Pre-commit spec schema enforcement

**The problem today:** Required spec sections (Product Vision Updates, Design System Updates, PROPOSED ADDITION blocks) are enforced by prompt only — if the LLM skips a section, the spec is saved without it. Step 4 (spec-validator) runs at approval time. But by approval time, missing sections have been in the draft for multiple turns and the human has already seen an incomplete spec.

**What this adds:**

**Pre-commit section validator (runs before every draft save):**
- After agent produces a response with a DRAFT or PATCH block, and before writing to GitHub, run a lightweight structural check:
  - PM agent response with approval intent: must contain `## Product Vision Updates`
  - Design agent response with approval intent: must contain `## Design System Updates`
  - Architect agent response with approval intent: must contain `PROPOSED ADDITION TO SYSTEM_ARCHITECTURE.md`
- If a required section is absent, do not save the spec. Instead, auto-retry the agent with a targeted instruction: *"Your response is missing the [section name] section. Add it now — write the proposed text as ready-to-apply content. Do not rewrite the rest of the spec."*
- One retry. If still missing after retry, surface to user: *"I couldn't generate the [section] automatically — please tell me what [vision/design system/architecture] updates this feature requires and I'll add them."*
- Draft responses (not final approval) are NOT checked — this gate only applies at the point of approval intent detection.

**Why this is different from Step 4 (spec-validator):**
- Step 4 validates the full spec at approval time: structure, cross-references, acceptance criteria, internal consistency
- This step validates one specific rule at commit time: required sections exist before the human sees the spec
- They compound: this step catches missing sections early; Step 4 catches quality issues at the gate

**Implementation:** `runtime/spec-schema.ts` (new file, ~30 lines) — `validateRequiredSections(agentType, response): string | null` returns the missing section name or null. Called from each agent's approval-intent handler in `message.ts` before `saveApproved*`.

---

### Trust Step 4d — Phase state caching

**The problem today:** Phase detection (`getInProgressFeatures()` + `getFeaturePhase()`) re-reads from GitHub on every message. Each read costs ~200–300ms of latency and one GitHub API call. On a busy channel with multiple team members active, this adds up fast — and the phase almost never changes between messages.

**What this adds:**
- In-memory phase state cache: `Map<featureName, { phase, cachedAt }>` with a 30-second TTL
- Cache is invalidated immediately on any spec save operation (the one moment phase actually changes)
- On cache hit: phase returned instantly, no GitHub API call
- On cache miss or invalidation: read from GitHub, populate cache

**Why deferred (not a blocker):**
Phase detection latency is invisible to users today because it runs in parallel with context loading. It becomes a bottleneck only at higher message volumes. Implement before Step 5 (production deployment) — latency becomes measurable in production.

**Implementation:** `runtime/github-client.ts` — add `phaseCache` Map, wrap `getInProgressFeatures()` with cache check, add `invalidatePhaseCache(featureName)` called from all `save*Spec()` functions.

---

### Trust Step 4e — API rate limit management (GitHub + Anthropic)

**The problem today:** The platform uses a single GitHub token and a single Anthropic API key for all workspaces. At 100+ concurrent features each making 3–8 GitHub reads and 3–8 Anthropic calls per message, both limits break. GitHub REST: 5,000 req/hour per token. Anthropic: RPM/TPM limits per key. There is no queuing, backpressure, or per-workspace isolation.

**What this adds:**
- Per-workspace GitHub tokens: `GITHUB_TOKEN` moved to WorkspaceConfig (already the right abstraction — just needs to be loaded per-request from the workspace registry once Step 10 lands). Until then, pool multiple tokens round-robin.
- Per-workspace Anthropic keys: same pattern — `ANTHROPIC_API_KEY` per workspace, loaded from workspace registry.
- Request queue in `runtime/claude-client.ts`: bounded concurrency (max N in-flight Anthropic calls per workspace), exponential backoff on 429/529, surface rate-limit errors to the user as "_I've hit an API rate limit — retrying in a moment._" rather than "Something went wrong."
- GitHub read deduplication: if two concurrent messages read the same file in the same 10-second window, return the cached result rather than making two identical API calls.

**Prerequisite:** Trust Step 3 (Redis) for per-workspace state, Trust Step 4d (phase cache) for reduced GitHub read volume. Implement before Step 5 (production deployment).

**Source:** DECISIONS.md — "Single API key" and "GitHub rate limits" entries.

---

### Trust Step 4f — Legacy migration cleanup: featureName cross-contamination

**The problem today:** `getHistory(featureName)` merges all entries stored under `_legacy_` (the migration catch-all for old threadTs-keyed messages) into every featureName's history. With one feature this is harmless. With multiple features, feature B's agent sees feature A's full conversation history — injecting irrelevant decisions into `identifyUncommittedDecisions` and producing garbage results.

**What this adds:**
- Build a `threadTs → featureName` index: on every incoming Slack event, store `threadTs → channelName → featureName` mapping in Redis (from Trust Step 3).
- `migrateThreadTsKeys()` re-runs with the index: re-keys each `_legacy_` entry to its correct featureName instead of `_legacy_`.
- `getHistory()` removes the `_legacy_` merge — each feature gets only its own history.
- After migration is confirmed clean (no `_legacy_` entries remain), remove `migrateThreadTsKeys()` entirely.

**Prerequisite:** Trust Step 3 (Redis) — the threadTs index needs a shared store to work across instances. This fix is a correctness issue, not just performance: multiple features means actively wrong agent output.

**Source:** DECISIONS.md — "featureName-keying migration" entry.

---

### Test quality — section header resilience fixtures

**The gap today:** The `auditAnimationTokens — section header format resilience` tests use inline synthetic CSS strings to test that various Glow header formats (`**Animation & Glow**`, `**Glow**`, `**Glow:**`, no-bold, etc.) are correctly recognized. These inline strings are acceptable for testing header variation (not format-sensitive by the fixture rule), but the gold standard would be sourcing one fixture from a real agent response that uses a non-standard header. Today the design agent consistently produces `**Glow (Signature Effect)**`, so there is no real sample to source yet.

**What this adds:** When a real agent response with a non-standard Glow header is observed in production, capture it as `tests/fixtures/agent-output/design-brand-animation-alt-header.md` and add a fixture-sourced test to replace the inline synthetic one for that variant.

**Why deferred:** No non-standard header has been observed in production. Premature fixture creation would require hand-crafting — the exact failure mode the fixture rule prohibits. This becomes actionable when a real sample exists.

**Source:** Self-rating gap noted after animation drift detection fix (April 2026).

---

### Step 2.5b — Remaining API cost optimizations (minor)

Two small items left from the original cost optimization work. Neither is blocking — do these opportunistically between larger steps. **Do not prioritise until onboarding a second workspace** — the savings only compound at multi-user, multi-feature volume.

**Structured prompt caching (static/dynamic split):**
- The `cache_control` marker on the system prompt busts the cache on every new feature because `featureName` and live spec context are embedded throughout the prompt
- Fix: split each agent's `build*SystemPrompt()` into a static block (persona, workflow, spec format, rules) and a dynamic block (featureName, specUrl, current context)
- Pass both to `runAgent()` as separate params; apply `cache_control` only to the static block
- Static block is ~90% of each prompt — gives cross-feature cache hits instead of per-session only
- Affects: `agents/pm.ts`, `agents/design.ts`, `agents/architect.ts`, `runtime/claude-client.ts`

**Application-level response cache for `context-loader.ts`:**
- The context loader calls Haiku to summarize large docs (product vision, architecture) per question
- If the same question hits the same doc at the same git SHA, the answer is deterministic — no need to call the API again
- Cache key: `hash(question + filePath + gitSHA)` → cached summary string, in-memory with a short TTL
- Small savings (already Haiku-level cost) but trivially easy to add

---

### Step 2.6 — Spec revision: phase detection fix + editor mode

**The problem today:** Once all spec branches are deleted and specs are on `main`, `getInProgressFeatures()` loses track of the feature entirely. `getFeaturePhase()` falls back to `"product-spec-in-progress"` — misidentifying a live feature as a new one. The agent starts from scratch with no context.

**Scope — what this step does and does not do:**
This step fixes the detection bug and agent behaviour for established features. It does *not* build intent routing ("I want to change X" → which layer → which agent). That routing logic belongs permanently in the Orchestrator (Step 3) and is built there — not here as a patch that gets refactored away.

**Phase detection fix:**
- `getFeaturePhase()` checks for existing specs on `main` before falling back — if `.product.md`, `.design.md`, or `.engineering.md` exist, the feature is in `"feature-established"` state, not `"new"`
- Any agent receiving a `"feature-established"` feature loads the existing spec automatically

**Editor mode:**
- When loading an established feature, each agent receives the existing spec with an explicit instruction: *"This spec exists and is approved. The user wants to revise it. Work from what exists, not from blank."*
- Same draft → two-step approval flow as new specs
- On approval, `saveApproved*` already handles "already on main" — updates in place

**Downstream notification (not enforcement):**
- After an upstream spec is updated, system posts: *"Product spec updated. The design spec may need a revision pass — it still reflects the previous version."*
- Human decides whether to cascade. System does not auto-invalidate.

**Note:** "Feature live" vs "feature built but not deployed" is indistinguishable at the spec level — the system tracks spec state only. Revision workflow applies equally to both.

---

### Step 2.7 — Agent failure protocol

**Inspired by OpenAI's harness engineering finding:** when agents produce bad output, the correct human response is never "reprompt and try harder." It is always: *what capability is missing, and how do we make it legible and enforceable for the agent?*

This step formalises that protocol so the platform improves systematically instead of through ad-hoc prompt tweaks.

**What this adds:**

**Documented failure taxonomy (in `AGENTS.md`):**
Three categories of agent failure with a prescribed human response for each:

| Failure type | Symptom | Correct response |
|---|---|---|
| Missing context | Agent ignores a constraint or contradicts an upstream spec | Add the constraint to the spec chain or AGENTS.md; re-run — do not reprompt |
| Missing guardrail | Agent produces structurally valid but wrong output (e.g. a spec with no acceptance criteria) | Add a validation rule to the spec-validator (Step 4); do not patch the prompt |
| Missing capability | Agent cannot do the task at all (e.g. can't look up a library API) | Add the tool or MCP; do not ask the agent to "try its best" without the tool |

The rule: a failure that requires the same correction twice is a missing guardrail, not a bad prompt. Build the guardrail.

**Failure log (`specs/failures/failures.jsonl`):**
Append-only JSONL log of agent failures reported via Slack reaction or explicit `/sdlc failure` command. Fields: timestamp, agent, thread, failure type, description, resolution. Reviewed before adding any new prompt instruction — if the fix belongs in a guardrail, it goes there, not in the prompt.

**Slack command:** `/sdlc failure [description]` — creates a failure log entry and optionally opens a GitHub Issue tagged `agent-failure` for tracking.

**Why before Step 3 (Orchestrator):** The Orchestrator will surface conflicts and stalls. Without a defined failure protocol, every Orchestrator alert is handled ad-hoc. This step gives the team a consistent, compounding response to agent failures before the Orchestrator makes them more visible.

**Note on numbering:** Steps 2.7 (bug workflow) and 2.8 (PM review queue) from earlier backlog versions have been relocated — bug workflow moved to Step 9 (only relevant once code is deployed), PM review queue folded into Step 3 (Orchestrator owns all routing). This step takes the 2.7 slot as the next logical item after 2.6.

---

### Step 3 — Orchestrator agent

A dedicated agent that owns all routing logic, proactive phase coordination, continuous spec integrity monitoring, and consolidated human review queues. Built before engineer agents because routing scattered across message handlers becomes unmaintainable as the roster grows — and because spec conflicts that go undetected compound into expensive rework.

**Routing responsibilities:**
- Owns the canonical routing table: which agent handles which phase — single source of truth, replaces all hardcoded routing in the message handler
- Watches feature phase state (via GitHub branch + file presence) and detects when a handoff is ready
- At every phase handoff, scans the outgoing spec for unresolved `[blocking: yes]` questions — blocks the handoff until resolved
- Replaces GitHub Actions as the handoff trigger mechanism — no separate GitHub Actions step needed

**Intent-based layer routing for established features:**
- Haiku classifier: given "I want to change X" on a `feature-established` feature, which layer is affected? `product` / `design` / `engineering`
- Routes directly to the correct agent with the existing spec loaded in editor mode — no forced top-down cascade
- "I want to change the onboarding flow" → PM agent, existing product spec as context
- "Update the welcome screen" → design agent, existing design spec as context
- "Add a new API endpoint" → architect, existing engineering spec as context
- This is the permanent home for this logic — Step 2.6 fixes the detection bug; Step 3 owns the routing

**Proactive monitoring — runs on schedule and on GitHub push events:**
- Re-validates all approved feature specs whenever an authoritative doc (`PRODUCT_VISION.md`, `DESIGN_SYSTEM.md`, `SYSTEM_ARCHITECTURE.md`) is updated — catches conflicts introduced by doc changes, not just new specs
- Detects cross-feature conflicts: flags when a new spec contradicts a previously approved spec in the same domain (e.g. two features that define conflicting data models or contradictory user flows)
- Detects stalls: spec approved but no activity in the next phase for N days — configurable per workspace
- Never makes decisions — surfaces them. Every alert has one specific question for one named human.

**Alert format — specific, actionable, zero ambiguity:**
Every alert the Orchestrator posts follows this structure:
- **Who must resolve it:** the specific role (`Product Manager`, `UX Designer`, `Architect`) and the Slack user mention (from WorkspaceConfig role mapping)
- **What the conflict or issue is:** one sentence, precise
- **Two concrete options:** what the human can do to resolve it
- **Direct links:** the affected spec(s) and the relevant authoritative doc

Example:
> @sanjay — The `PRODUCT_VISION.md` was updated and now conflicts with the approved onboarding product spec.
> **Decision needed: Product Manager**
> The vision now says SSO-only auth, but the onboarding spec assumes email/password signup.
> Options: (1) revise the onboarding spec (requires re-approval) or (2) roll back the vision change.
> Spec: [link] · Vision: [link]

**PM / Designer / Architect review queues (absorbed from Step 2.8):**
At team scale, one PM getting @mentioned in every feature thread is a notification bomb with no triage. The Orchestrator owns consolidated review routing:
- All blocking questions from all feature threads are posted to dedicated review channels (`#pm-review`, `#design-review`, `#arch-review`) in addition to the originating thread
- Each post includes: feature name, the blocking question, link back to the feature thread
- The relevant role replies in the review channel; Orchestrator routes the answer back to the blocked thread and resumes the agent automatically
- Multiple people can watch the same channel — whoever picks it up owns it

**Per-domain role assignment (WorkspaceConfig):**
- `roles` gains a `domains` map: `{ growth: { pmUser: "U123", designerUser: "U456" }, platform: { pmUser: "U789" } }`
- Feature names matched to domains by prefix convention
- Fallback to global role IDs for solo teams — zero-config for small setups, opt-in for larger ones

**Role mapping — WorkspaceConfig fields:**
```
SLACK_PM_USER         # Slack user ID for the Product Manager
SLACK_DESIGNER_USER   # Slack user ID for the UX Designer
SLACK_ARCHITECT_USER  # Slack user ID for the Architect
```

**Cross-phase escalation — two layers working together:**
- **Reactive:** Agent detects a blocking upstream question mid-conversation and pulls the right role into the thread immediately
- **Proactive (this step):** Orchestrator continuously monitors the full spec chain and alerts the named human the moment a conflict or stall is detected — not just at phase handoff time

---

### Step 4 — Spec-validator agent

An automated quality gate that runs before any spec can advance to the next phase. Distinct from the spec auditor (which checks for conflicts with vision/architecture) — the validator checks structural completeness and internal consistency.

**What it checks:**
- All required sections present and non-empty
- Every user story in the product spec has a corresponding flow in the design spec
- Every screen in the design spec has all required states (default, loading, empty, error)
- Every acceptance criterion is specific enough to be testable
- No `[blocking: yes]` open questions remain unresolved
- No internal contradictions within a spec (flow references a screen not defined in Screens)
- Engineering spec: every API endpoint has a defined error response; every data model change has a migration path

**Output:** Pass or fail with specific, actionable failure reasons. A failing spec cannot be approved — the relevant agent is notified and must address the failures before re-submitting.

**Quality score (written back to the spec):**
On every passing validation, the spec-validator appends a structured quality score block to the spec file:

```
<!-- spec-quality: score=87 sections=pass criteria=pass cross-refs=pass open-questions=0 validated=2026-03-24 -->
```

Downstream agents loading a spec can read this score. The architect and engineer agents are instructed to flag if they're loading a spec with a score below threshold (configurable, default: 75) — this surfaces degraded upstream context before work is built on it. Score history is retained as a comment block, not overwritten — so score trends are visible.

**Where it runs:** Between draft save and approval gate. The human sees the validation result before being asked to approve.

---

### Step 5 — agentic-sdlc production deployment + observability

Deploy the SDLC engine to always-on infrastructure. Observability is bundled here — you cannot operate a production system without being able to see what it's doing.

**Note:** Redis persistence is already handled in Trust Step 3 and is not part of this step. This step covers deployment and observability only.

**Observability:**
- Structured logging per agent invocation: timestamp, workspace, channel, thread, agent, intent markers, GitHub operations, latency
- Error logging with full context: what failed, which agent, which thread, raw error
- Log aggregation service (Datadog, Logtail, or equivalent)

**Trace-level agent logging (JSONL):**
Each agent invocation emits a structured JSONL trace of *what the agent did*, not just what it produced:
- Which context files were loaded (git SHA + file path)
- Which tool calls were made and in what order (for engineer/QA agents in Steps 6–7)
- Token usage per call (prompt + completion)
- Whether the agent hit a blocking gate, a conflict, or a gap
- Final disposition: draft saved / approval detected / escalation triggered / error

This trace feeds two systems: (1) the eval harness — evals can assert on *what the agent did*, not just the output text; (2) the failure log from Step 2.9 — a failure entry can link directly to the trace that produced it. Implementation: `runtime/claude-client.ts` wraps each call in a trace context that emits JSONL to the log aggregator.

**agentic-sdlc deployment:**
- Dockerfile with Node.js runtime, tsx compilation, environment variable injection
- Secrets management: Slack tokens, ANTHROPIC_API_KEY, GITHUB_TOKEN stored as platform secrets, never in the repo
- Health check endpoint for the platform's process monitor
- Crash restart policy (always restart, exponential backoff)
- Deployment triggered automatically from `main` branch via `agentic-cicd` pipeline
- Rollback: previous image tag retained; one-command rollback

**Deployment target:** Railway, Fly.io, or equivalent — chosen when this step is active.

**Prerequisite:** Orchestrator (Step 3) — routing must be centralised before the bot runs in a multi-instance environment.

---

### Step 6 — pgm agent + engineer agents (backend + frontend)

Three agents that work from an approved engineering spec to produce and ship code. This is where "autonomous" actually happens.

**Runtime model — this is not the same as spec-shaping agents (critical architectural note):**

Spec-shaping agents (PM, design, architect) use a simple request/response pattern: one Claude API call per message, response is parsed text, handler saves the result. Engineer and QA agents require a fundamentally different runtime — an agentic tool-use loop:

```
system prompt + spec chain
  → Claude emits tool_use
    → tool executes (read file, run test, search docs, open PR)
      → tool result fed back to Claude
        → Claude emits more tool_use or final response
          → loop until done
```

The Claude Agent SDK handles this loop natively and is the right runtime for Steps 6–7. Do not try to build the `stop_reason: "tool_use"` → resubmit cycle by hand.

**MCP tools required (engineer and QA agents):**
- **GitHub MCP** — read spec chain, read existing code, commit files, open PRs, post PR review comments
- **Filesystem / bash** — write code, run tests, run type-checker, run linter, execute migrations in a sandbox
- **Web fetch / search** — look up current API documentation, library changelogs, framework migration guides; engineer agents need recency that the model's training cutoff cannot guarantee
- **Browser** (optional, evaluate at build time) — inspect a deployed preview URL, verify a rendered component against design spec screenshots

Spec-shaping agents do not use external tools. Engineer and QA agents require them — writing code against a library without being able to look up its current API is not autonomous, it is guessing.

**pgm agent (Program Manager):**
- Reads the approved engineering spec and decomposes it into discrete, dependency-ordered work items
- Each work item: title, acceptance criteria, which agent handles it (backend/frontend), estimated complexity, dependencies
- Posts work items to the feature channel for human review before any code is written
- Work items saved as `<feature>.workitems.md` in the target repo for traceability
- No code is written until work items are human-approved
- pgm agent uses the simple request/response pattern (same as spec-shaping agents) — it reads and reasons, it does not execute

**Depth-first decomposition (explicit execution model):**
The pgm agent does not generate a flat issue list. It decomposes depth-first: identify the smallest independently-buildable building block first, make it shippable, use it to unlock the next layer. The work item list is a layered dependency graph, not a flat queue. Example: a "user profile" feature decomposes as data model → API → auth middleware → page component → integration, in that order — each layer is a prerequisite for the next. Work items that cannot be started without a prior item complete are blocked in GitHub Issues until the prerequisite merges. This prevents engineer agents from building on incomplete foundations.

**Backend agent:**
- Reads the full spec chain (product → design → engineering) before writing a line of code
- Uses web fetch/search to look up current documentation for any library or API referenced in the engineering spec
- Implements: migrations, models, API endpoints, business logic, tests
- Runs the test suite and type-checker after every work item — does not open a PR until both pass
- Conflict detection: flags any implementation decision that contradicts the spec chain before committing
- Opens a PR per work item via GitHub MCP; PR description links back to the spec section it implements
- Never makes product, design, or architecture decisions — escalates upstream

**Frontend agent:**
- Reads the full spec chain, with particular attention to the design spec (screens, states, interactions, brand tokens)
- Uses web fetch/search to look up current framework docs (component APIs, CSS-in-JS patterns, etc.)
- Implements: components, pages, state management, API integration
- References design spec states explicitly in code (empty state, error state, loading state)
- Same PR-per-work-item pattern as backend agent

**Per-agent memory files:**
Each code-executing agent (backend, frontend, QA) maintains a persistent knowledge file in the target repo — `backend.memory.md`, `frontend.memory.md`, `qa.memory.md`. This is distinct from conversation history (which is ephemeral and stored in Redis) and from specs (which are authoritative product/design/engineering decisions). Agent memory captures what the agent has learned about the codebase over time: conventions it discovered, patterns it established, past failures and their resolutions, gotchas in the repo. The agent reads its memory file at the start of every invocation and appends new learnings after completing a work item. This gives continuity across restarts and across multiple work items — the agent doesn't start from scratch each time. The architect agent already demonstrates this pattern via `SYSTEM_ARCHITECTURE.md` ownership. This step extends it explicitly to all code-executing agents.

**Shared constraints:**
- All agents read the full spec chain — no partial context
- PRs are opened against the customer's target repo (from `WorkspaceConfig`), not the platform repo
- External tool use is scoped to technical lookups — agents do not browse arbitrarily, they search for specific things they need to complete the work item

---

### Step 7 — QA agent

Generates feature-specific test plans from acceptance criteria and validates shipped code against them. Blocks merges when criteria are unmet.

**Runtime model:** Same agentic tool-use loop as engineer agents. The QA agent reads code (GitHub MCP), runs the test suite (bash), and cross-references results against the spec chain. It does not just read — it executes.

**MCP tools required:** GitHub MCP (read PRs and code), bash (run test suite, accessibility audit tools), web fetch (look up current testing standards or tool documentation if needed).

**What the QA agent reads:**
- Full spec chain (product → design → engineering) — understands what was promised
- Shipped code (PRs from engineer agents) — understands what was built

**What the QA agent produces (`<feature>.qa.md`):**
- Test plan per acceptance criterion: scenario, preconditions, steps, expected outcome
- Edge cases derived from design spec states (empty state, error state, slow network, RTL layout)
- Accessibility test cases derived from the design spec Accessibility section
- Regression risk areas: which existing features could be affected by this change

**Gate:** QA agent reviews shipped PRs against the test plan. PRs that fail acceptance criteria are flagged with specific failures before merge. Human makes the final merge decision.

**Prerequisite:** Engineer agents (Step 6).

---

### Step 8 — agentic-cicd: customer app deployment pipeline + production monitoring

The second half of the licensed platform. A customer who has the SDLC engine but no deployment pipeline cannot ship anything. This step makes the pipeline a first-class platform deliverable and is the point at which health360 ships to real users.

**What agentic-cicd provides for a customer app:**
- Build pipeline: installs dependencies, runs type-check, runs tests, builds production bundle
- Deployment: pushes to the customer's chosen platform (Vercel, Railway, Fly.io, etc.)
- Preview deployments: every PR from an engineer agent gets a preview URL
- Production deployment: triggered on merge to main, after QA agent sign-off
- Rollback: previous deployment retained; one-command rollback
- Secrets management: customer's production secrets stored as pipeline secrets, never in repos

**Production monitoring (bundled — not deferred):**
Deploying without monitoring is not shipping — it is guessing. Monitoring ships with the pipeline:
- Uptime monitoring: health check endpoint polled every minute; Slack alert if down for >2 consecutive checks
- Error rate alerting: uncaught exceptions and 5xx rates tracked; Slack alert if error rate exceeds threshold (configurable per workspace)
- Basic performance visibility: p50/p95 response times logged; no alert by default, visible on demand
- All alerts routed to a configurable `#ops` Slack channel in WorkspaceConfig

**What makes this a platform feature (not customer-specific):**
The pipeline is templated and configurable — a new customer plugs in their repo, deployment target, and secrets. WorkspaceConfig gains a deployment section alongside the existing GitHub and Slack config.

**health360 milestone:** Once this step is complete, onboarding ships to real health360 users — the first end-to-end proof that the full autonomous pipeline works.

---

### Step 9 — Bug workflow

A dedicated workflow for bugs that is completely separate from the spec chain. Bugs are deviation from intent — the spec is correct, the code is wrong. No spec update needed (unless the bug reveals the spec was ambiguous, which is rare and handled manually).

**Why here (not earlier):** Bugs only exist when code is running in production. This step has no value before Step 8 — there is no code to have bugs in. Placing it here means it's built exactly when it becomes needed.

**What this adds:**

**Bug intake (Slack):**
- In any feature channel or a dedicated `#bugs` channel: "we have a bug where X happens when Y"
- Concierge (or dedicated bug-intake handler) creates a GitHub Issue tagged `bug` with: description, reported-by, feature name, severity (derived from message or asked)
- Confirmation posted in Slack with a link to the issue

**Triage:**
- Bugs go into a triage backlog — visible in GitHub Issues with `bug` + `triage` labels
- Human or future eng-mgr agent sets priority and assigns to the relevant engineer agent

**Resolution tracking:**
- Issue linked to a PR that fixes it
- On PR merge, issue closed automatically (GitHub standard behavior)
- Slack notification: "Bug #123 fixed and merged"

**Out of scope for this step:** Automated severity detection from monitoring/alerts, bug SLA tracking, regression test auto-generation. These are follow-on once the basic intake loop is working.

---

### Step 10 — Multi-workspace support

Make agentic-sdlc serve multiple customer teams simultaneously without code changes.

**What changes:**
- Single bot process handles multiple Slack workspaces
- Each workspace has its own WorkspaceConfig stored in a database, not environment variables
- Environment variables remain valid for single-workspace (solo team) deployments
- `/sdlc setup` Slack command walks a new workspace through configuration interactively
- Per-workspace cost controls and rate limiting

**Why after Step 8:**
Multi-workspace requires the full pipeline to exist first. health360 shipping (Step 8) is the proof point that makes onboarding a second customer credible.

---

### Step 11 — Full audit trail

Extend the basic observability from Step 5 into a compliance-grade audit trail.

**Additions beyond Step 5:**
- User message content with PII pattern redaction
- Agent response content (truncated for storage efficiency)
- Full context load record: exact git SHAs of every file read per invocation
- Configurable retention policy per workspace
- Export API: workspace admin can export their audit log on demand

**Why this ordering:**
The basic observability in Step 5 handles operational debugging. The full audit trail is a compliance and enterprise sales feature — relevant when multiple paying customers are running in production.

---

### Step 12 — Figma integration + brand token support

Agent creates Figma files directly via the Figma API on design spec approval. Brand token reading folded in via `brandPath` in WorkspaceConfig.

**What this adds:**
- On design spec approval, agent creates a Figma file with frames matching the screen inventory
- Designer reviews in Figma, gives feedback in Slack, agent iterates
- Approved Figma link stored in `<feature>.design.md`
- `WorkspaceConfig` gains `brandPath` — design agent reads brand tokens from the customer's repo and applies them when generating Figma frames

**Note on brand data:** Brand tokens are customer-specific. health360's brand lives in `agentic-health360`. The platform reads from wherever `brandPath` points — it does not own or define brand.

---

### Step 13b — Restore PM escalation via `offer_pm_escalation` tool

**The gap:** After Step 13, `setPendingEscalation` is imported in `message.ts` but never called. The design agent's escalation offer is now plain text only — when the user says "yes", the pending escalation is not set, so no PM notification is posted. The S4T2 workflow is silently broken in production.

**Fix:** Add `offer_pm_escalation` to `DESIGN_TOOLS`:
```typescript
{
  name: "offer_pm_escalation",
  description: "Offer to escalate a blocking product question to the PM. Use when a user's message requires a product decision that is outside the design spec scope. The platform will prompt the user to confirm, then notify the PM.",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The blocking product question to escalate." },
    },
    required: ["question"],
  },
}
```

In `message.ts` design agent `toolHandler`, handle `offer_pm_escalation`:
```typescript
case "offer_pm_escalation":
  setPendingEscalation(featureName, {
    targetAgent: "pm",
    question: input.question as string,
    designContext: "Design in progress.",
  })
  return { result: "Escalation offer stored. The user will be asked to confirm." }
```

Add a test: design agent calls `offer_pm_escalation` → platform sets pending escalation → user says "yes" on next turn → PM notified via `postMessage`.

---

### Step 14 — Vision refinement channel

A dedicated Slack channel where the pm agent interrogates and strengthens the product vision itself — not spec shaping for a feature, but product strategy.

**What vision-refinement mode does:**
- Reads `PRODUCT_VISION.md` fully before every response
- Asks hard questions and identifies gaps: undefined sections, contradictions, vague constraints
- Proposes concrete changes to `PRODUCT_VISION.md` via PR — human reviews and merges
- After a merge, verifies the updated vision against existing approved specs and flags any that need revisiting

**Why last:**
Most valuable once several features have shipped and patterns in the vision show under real usage.

---

## Completed

- **Remove architect pre-run upstream gate — let the architect work (2026-04-21)** — The architect pre-run gate blocked the architect from starting when upstream PM/design specs had audit findings. This is wrong for SDLC — the architect is the expert who decides which gaps block engineering. Fix: upstream audit findings are now injected as informational context only; the architect runs unconditionally and escalates specific blocking gaps via `offer_upstream_revision(pm|design)` during conversation. Non-blocking gaps are captured in `## Design Assumptions To Validate` and enforced at finalization (exit gate: `finalize_engineering_spec` blocks if unvalidated assumptions remain). Entry/exit asymmetry: no entry gate, but the exit gate ensures nothing ships unvalidated.

- **Architect upstream rubric — dedicated ARCHITECT_UPSTREAM_PM_RUBRIC (2026-04-21)** — PM_RUBRIC (6 criteria) was being reused as the architect's upstream gate, causing engineering-scope gaps (data requirements, measurability, architecture consistency, non-goals) to be escalated to the PM. Fixed by creating a dedicated 2-criteria rubric in `runtime/phase-completion-auditor.ts` that checks only error paths and open questions — the only PM-scope gaps the architect cannot resolve itself.

- **Remove "platform" language from agent context notices (2026-04-21)** — All `[PLATFORM ...]` notice prefixes in architect and design agent paths changed to `[INTERNAL ...]`. Architect prompt now says "Never say 'the platform' to the user — findings are yours." Ensures agents present findings as their own expert recommendations, not as output from an external system.

- **PM readOnly escalation prompt — suppress tool-call syntax (2026-04-21)** — `readOnly=true` now shows ESCALATION MODE instructions that suppress tool-call syntax output, replacing the old READ-ONLY MODE that said "spec is frozen." Ensures the PM agent responds with natural recommendations when answering escalation briefs, not with `save_product_spec_draft(...)` tool-call syntax that leaks platform internals to the user.

- **Spec quality enforcement — dry-run safety, structural cleanup tool, health invariant (April 2026)** — Five gaps closed that allowed spec degradation to happen silently: (1) **Simulate-agent dry-run default**: `SIMULATE_DRY_RUN=true` env var + `isDryRun()` guard added to ALL write functions in `github-client.ts` (`saveDraftSpec`, `saveDraftDesignSpec`, `saveApprovedSpec`, `saveAgentFeedback`, `saveApprovedDesignSpec`, `saveDraftEngineeringSpec`, `saveApprovedEngineeringSpec`, `clearHandoffSection`, `saveDraftHtmlPreview`, `createSpecPR`, `saveUserFeedback`). Simulation runs now read from GitHub but write nothing — `--live` flag required to actually write. (2) **`rewrite_design_spec` tool**: New design agent tool that replaces the entire spec content in one operation for structural cleanup (removing duplicates, consolidating conflicting definitions). Distinct from `apply_design_spec_patch` (targeted, section-level changes) by name and description. Handler wired in `message.ts`; `singlePassFixItems` routing splits structural-conflict findings (matching "duplicate/defined twice/conflicting/appears twice/multiple.*section") to `rewrite_design_spec` and targeted findings to `apply_design_spec_patch`. (3) **`audit-real-spec.ts` WorkspaceConfig compliance**: Removed all hardcoded feature name, spec path, and branch name. Now requires `--feature <name>` CLI arg; all paths derived from `loadWorkspaceConfig()`. (4) **Post-patch spec health invariant (Principle 8)**: After any patch turn, the platform arithmetically compares pre-run spec size and finding count vs post-run state. Pre-run finding count captured BEFORE continuation passes overwrite `designReadinessFindings`. If spec grew beyond `maxAllowedSpecGrowthRatio` (configurable via `MAX_ALLOWED_SPEC_GROWTH_RATIO` env var, default 1.2) OR finding count increased, the platform returns early with a human-friendly warning — no preview upload, no action menu. `maxAllowedSpecGrowthRatio` added to `WorkspaceConfig`. (5) **Tool names stripped from platform injection blocks**: "call offer_pm_escalation" → "escalate to the PM", "call offer_architect_escalation" → "escalate to the Architect" — platform is invisible to humans. N61 integration test added. 7 dry-run unit tests in `github-client.test.ts`. 985 tests pass.

- **Platform-controlled fix-all completion loop + single preview upload (April 2026)** — Root cause fix for two related failures: (1) **Fix-all loop**: When the user says "fix all", the platform previously handed control to the design agent and trusted its self-report ("spec is clean, say approved"). The agent reliably failed to track multi-item completion across a long turn. Root cause: the agent controlled the completion loop — never the platform. Fix: `parseFixAllIntent()` (new exported pure function) detects "fix all" / "fix 1 2 3" intent deterministically (keyword match — no Haiku, platform-prescribed format). The platform extracts the authoritative item list from the same pre-run audit data that built the action menu (same source of truth). It injects a `[PLATFORM FIX-ALL]` block specifying exactly what to patch. After the agent runs, the platform re-reads the spec from GitHub (fresh, not stale `currentDraft`) and re-runs all audits independently: `auditBrandTokens`, `auditAnimationTokens`, `auditMissingBrandTokens` (pure), `auditSpecRenderAmbiguity` (Haiku), `auditPhaseCompletion` (Sonnet — cache naturally misses on changed spec fingerprint). If residual items remain and progress was made, the platform re-runs automatically (up to `MAX_FIX_PASSES = 3`). If no progress: stop and report stuck items. Agent prose is suppressed between passes. PM-GAP items filtered from agent brief, surfaced separately. Platform composes the final message ("Fixed all N items" or "Fixed X of N — Y still need attention"). The fix-all loop returns early, bypassing all post-runAgent escalation gates (irrelevant in fix-all path). (2) **Single preview upload**: When the agent calls `apply_design_spec_patch` multiple times in one turn, each call was triggering an `uploadV2` to Slack — spamming the thread with multiple previews. Fix: `saveDesignDraft()` accepts `{ skipSlackUpload: true }` for patch calls; `patchAppliedThisTurn` flag tracks whether any patch ran; `lastGeneratedPreviewHtml` closure caches the last generated HTML. After all patches complete (normal path or fix-all loop), a single upload fires using `lastGeneratedPreviewHtml`. N53 (2 patches → 1 upload) and N54 (fix-all loop → "Fixed all 1 item", 1 upload) integration tests added. `parseFixAllIntent` unit tests in `action-menu.test.ts`. 938 tests pass.

- **PM escalation spec writeback (April 2026)** — When the human PM confirms escalation recommendations, the platform now writes confirmed decisions back to the approved product spec on main so the spec auditor doesn't re-discover the same gaps on the next design run. Implementation: `EscalationNotification.recommendations` stores the PM agent's full response text; on the next message (PM @mention reply), `patchProductSpecWithRecommendations` (new module `runtime/pm-escalation-spec-writer.ts`) reads the approved product spec from main, calls Haiku to generate a targeted patch (## sections only, concrete measurable entries — no alternatives, no vague language), applies with `applySpecPatch`, and saves back to main via `saveApprovedSpec`. PM agent brief ends with explicit sentence: "Once you approve these recommendations, I'll update the product spec to reflect each confirmed decision." Design agent inject message instructs it to list each recommendation it's applying. N30 integration test verifies the end-to-end: patched spec written to GitHub when spec exists and Anthropic returns a valid ## patch. 775 tests pass.

- **Design agent smoke test hardening + generate-preview default push (April 2026)** — Three gaps closed: (1) `buildDesignSystemPrompt` gains optional `configOverride?: WorkspaceConfig` parameter — if provided, skips `loadWorkspaceConfig()` so the function is usable in tests without a real `.env`. (2) Scenario 1 in `tests/smoke/design-agent-workflow.test.ts` updated to call the real `buildDesignSystemPrompt` with a minimal `TEST_CONFIG` — regressions in the full system prompt (escalation rule softened, tool removed) now caught. (3) Scenario 4 added: verifies design agent calls a save tool (`apply_design_spec_patch` or `save_design_spec_draft`) after user explicitly agrees to a design direction — guards against the agent acknowledging in text but not calling the tool. (4) `scripts/generate-preview.ts`: `--push` made the default behavior; replaced with `--local-only` flag for disk-only output. Eliminates the "I re-rendered but Slack still shows the old one" failure class. 514 tests pass.

- **Phase completion gate + phase entry upstream audit — PM + Design + Architect agents (April 2026)** — Two structural enforcement mechanisms added together: (1) **Phase completion gate**: before any spec can be finalized, the agent calls `run_phase_completion_audit()` — a Sonnet-based comprehensive audit against a domain-specific rubric. PM rubric (6 criteria): all user stories have error paths, acceptance criteria measurable, zero unresolved blocking questions, data requirements explicit, no architectural contradictions, Non-Goals names a scope boundary. Design rubric (8 criteria): all screens defined with all states, all UI copy verbatim, all animations with timing+easing, no conflicting values, no vague language, brand token consistency, no TBD/TODO/PLACEHOLDER. If any criterion fails, the agent surfaces findings as a numbered list with recommendations and blocks `finalize_*`. Phase does not advance until audit returns zero findings. (2) **Phase entry upstream audit**: design agent audits the approved PM spec against PM_RUBRIC on every message; architect agent audits both approved PM and design specs in parallel on every message. Content-addressed in-memory cache (fingerprint = `length:first100:last50`): cache starts empty on restart (first message always audits), and any manual edit to an upstream spec mid-phase automatically invalidates the cache. Findings injected as `[PLATFORM UPSTREAM SPEC AUDIT]` notice into enriched user message — surfaces gaps without the user needing to ask. `auditSpecRenderAmbiguity` Haiku prompt expanded with 4 new save-time check categories (TBD copy, unnamed states without visual descriptions, conflicting values, vague measurement language). Pattern documented for future agents in `runtime/phase-completion-auditor.ts` JSDoc and AGENTS.md. 11 new tests for phase-completion-auditor; 1 new test for expanded Haiku prompt. 489 tests pass.

- **Template-based HTML renderer (April 2026)** — Root cause fix for 5 accumulated sanitizer patches on the LLM-generated HTML renderer. Rewrote `runtime/html-renderer.ts` as a deterministic template renderer: `renderFromSpec(specContent, brandMd, featureName)` parses structured values from the spec (app name, tagline, placeholder, chips ≤3) and brand tokens from BRAND.md (color vars + glow animation params), then fills a fixed Alpine.js HTML template. Structure is correct by construction — `id="hero"` always present as sibling of `id="thread"`, hero uses `:class` (not `x-show`), thread has `style="display:none"` + `x-show`, chips in horizontal flex row anchored via `margin-top:auto`, inspector buttons have full static `style=` attributes, chip text uses `data-chip` attributes for apostrophe safety. `generateDesignPreview()` replaced with a thin async wrapper — backward-compatible with all tool handlers. `sanitizeRenderedHtml()` deleted (no longer needed). All 5 sanitizer patch tests replaced with 36 deterministic structural/parsing/brand-color assertions. 7 integration tests fixed (mock chain no longer includes Anthropic API call for preview render). `scripts/generate-preview.ts` updated to call `renderFromSpec` directly. AGENTS.md, SYSTEM_ARCHITECTURE.md updated. 527 tests pass.

- **Design agent behavioral fixes + renderer structural guarantees (April 2026)** — Five structural fixes addressing renderer hallucination, spec underspecification, incorrect escalation triage, and missed readiness audits: (1) **Renderer Fix 1c** — `sanitizeRenderedHtml()` now catches hero elements missing `id="hero"` by matching the characteristic `x-show="msgs.length === 0"` predicate; injects the id and converts to `:class` pattern so Fix 1a/b can operate. (2) **Renderer Fix 2 enhancement** — Fix 2 now also injects `x-show="msgs.length > 0 || typing"` on `id="thread"` when absent, preventing thread from staying permanently hidden after `display:none` injection. (3) **Two new BLOCKING validators** in `validateRenderedHtml()`: hero must have `id="hero"` (otherwise sanitizer cannot fix it — retry required); hero must not be nested inside thread (structural constraint — overlap is inevitable if violated). Both blocking issues trigger one LLM retry before throwing. (4) **Readiness query → platform audit injection** — `isReadinessQuery()` (Haiku classifier in `runtime/agent-router.ts`, same pattern as `isOffTopicForAgent`/`isSpecStateQuery` — catches any human phrasing: "can we ship?", "good to go?", etc.) detects readiness questions. Platform runs `auditPhaseCompletion(DESIGN_RUBRIC)` and injects `[PLATFORM READINESS AUDIT]` into enriched user message before agent runs. Design agent sees findings and must surface each: design gaps with its own recommendations, product gaps via `offer_pm_escalation`, architecture gaps via `offer_architect_escalation`. Platform-enforced — not prompt-rule-dependent. (5) **Architect escalation triage** — `offer_architect_escalation` tool added to `DESIGN_TOOLS`. `PendingEscalation.targetAgent` extended to `"pm" | "architect"`. Design agent system prompt updated with escalation triage rules: product behavior → PM, architecture/data design → Architect, visual definition gaps → own it with a concrete proposal. Two new Haiku prompt bullets in `auditSpecRenderAmbiguity`: chip position anchor ambiguity and SSO button icon+text internal layout. 19 new tests (Fix 1c × 2, Fix 2 enhancement × 2, blocking validators × 4, system prompt reinforcement × 1, `isReadinessQuery` × 7, Haiku prompt bullets × 2, design-agent tool count × 3). 533 tests pass.

- **Spec render-ambiguity audit + design agent behavioral fixes (April 2026)** — Four structural fixes addressing renderer hallucination, spec underspecification, and agent behavioral failures: (1) **Renderer fidelity** — `validateTextFidelity(html, specContent)` added to `runtime/html-renderer.ts`: deterministic post-render check that extracts `Heading: "..."`, `Tagline: "..."` etc. from the spec and verifies they appear verbatim in the rendered HTML; failures surface through the existing `validateRenderedHtml` warning pipeline. TEXT FIDELITY instruction added to both `generateDesignPreview` and `updateDesignPreview` system prompts. (2) **Pre-generation grounding** — `extractSpecTextLiterals(specContent)` added to `runtime/spec-utils.ts`; `message.ts` calls it after loading the design spec and injects a `[PLATFORM SPEC FACTS]` block into the enriched user message alongside the existing `brandDriftNotice`, giving the design agent platform-extracted text literals it cannot misread. (3) **Post-save render ambiguity audit** — `auditSpecRenderAmbiguity(designSpec)` added to `runtime/spec-auditor.ts`: independent Haiku call that identifies elements too vague for consistent rendering (undefined text content, relative-only positioning, no sheet entry direction, vague animation). Called in `saveDesignDraft()` after preview generation; result included in tool return as `renderAmbiguities` — when non-empty, the design agent must call `apply_design_spec_patch` in the same response. (4) **Design agent system prompt additions**: engineer standard replacing Figma standard, `renderAmbiguities` response rule, hallucinated-content rule, grounding rule, two new banned responses ("I don't have access to the spec", "the renderer is generating that"). **Durable fix — `fetch_url` truncation eliminated**: `filterDesignContent(rawHtml)` added to `runtime/spec-auditor.ts` — replaces `.slice(0, 200_000)` in the `fetch_url` tool handler with a Haiku call that extracts brand-relevant CSS/tokens; design agent receives filtered content instead of truncated raw HTML. **Hook fix**: PostToolUse violation hook output format changed from `hookSpecificOutput.hookEventName` (stops continuation) to `additionalContext` (surfaces as warning without interrupting edit loop); hook now flags only new code in `new_string`, not pre-existing file content. Scenarios 9, 13, 16 tests updated for extra `auditSpecRenderAmbiguity` mock call; Scenario 17 added (2 new tests). 458 tests pass.

- **Design agent quality + purity fixes (March 2026)** — Six fixes addressing design preview quality, brand drift coverage, purity enforcement, and UX issues from March 27–28 onboarding design session: (1) "save those" trigger: design agent system prompt now handles "save those"/"commit those"/"lock those in" by immediately calling `apply_design_spec_patch` — no clarifying question. (2) Animation drift detection: `brand-auditor.ts` gains `auditAnimationTokens()` — parses `## Animation` section from BRAND.md (glow-duration, glow-blur, glow-delay, etc.) and diffs against spec Brand section; both color and animation drift merged into single PLATFORM NOTICE. (3+4) HTML renderer overhaul: switched from `claude-haiku-4-5-20251001` to `claude-sonnet-4-6`; `brandContent` param passes BRAND.md as `AUTHORITATIVE BRAND TOKENS` block so renderer reads canonical values, not drifted spec values; removed hardcoded `0.45→0.75` opacity rule and example hex colors; added gradient text instruction; added `validateRenderedHtml()` returning structural warnings; return type changed from `string` to `{ html, warnings }`. (5) Playwright structural tests: nav tab count > 1, suggestion chips `flex-direction: row` at both desktop and iPhone viewport. (6) Context summarization warning: one-time Slack notice when history exceeds design agent limit. Purity enforcement: pre-commit hook Rule 5 blocks hardcoded hex color string literals in `agents/`, `runtime/`, `interfaces/`; `CHANGED_SOURCE` extended to include `interfaces/`. **White background fix:** renderer system prompt now requires body `background-color` and `color` in the mandatory `<style>` block alongside the glow keyframe — Tailwind CDN custom classes (`bg-primary`, `text-fg`) fail silently on `file://` URLs and Slack attachments when CDN loads after browser paint; `validateRenderedHtml()` adds structural check for explicit body CSS; "structurally complete" test fixture updated to include body CSS. **State response schema redesign:** `buildDesignStateResponse()` now produces three ordered sections — PENDING (uncommitted conversation decisions), DRIFT (brand token drift), SPEC (committed decisions + questions) — with a conditional CTA that gates approval: uncommitted decisions present → save first; drift present → fix first; blocking questions → resolve first; all-clear → approved. Approval cannot be offered while any gate is open. Animation drift (`auditAnimationTokens`) now runs on the state query path (was missing — only ran on agent response path). PENDING section renders even when no committed spec exists (no-draft path). Integration test Scenario 8 updated. 416 tests pass.

- **Step 13 — Agent tool access (architectural evolution)** — All three spec-producing agents (PM, design, architect) migrated from hand-rolled text-block protocol to Anthropic native tool-use API. `runAgent()` in `runtime/claude-client.ts` is now a tool-use loop: calls `messages.create` with typed tool schemas, executes the platform `toolHandler` for each `tool_use` block, injects `tool_result`, loops until `stop_reason === "end_turn"`. PM tools: `save_product_spec_draft`, `apply_product_spec_patch`, `finalize_product_spec`. Design tools: `save_design_spec_draft`, `apply_design_spec_patch`, `generate_design_preview`, `fetch_url`, `finalize_design_spec`. Architect tools: `save_engineering_spec_draft`, `apply_engineering_spec_patch`, `read_approved_specs`, `finalize_engineering_spec`. Removed: all text-block output parsers (`DRAFT_SPEC_START/END`, `DESIGN_PATCH_START/END`, `ENGINEERING_PATCH_START/END`, `PREVIEW_ONLY_START/END`, `INTENT: *`), `detectRenderIntent`, `detectConfirmationOfDecision` Haiku classifiers, PLATFORM OVERRIDE injection, truncation retry loops. Added: post-response uncommitted decisions audit (design agent only — if no save tool called and history > 6 messages, appends "save those" note to Slack response). 395 tests pass.

- **Brand token drift detection in design agent** — When user reports preview doesn't match brand or production site, agent diffs every spec color token and animation value against BRAND.md, surfaces each discrepancy explicitly (spec value → BRAND.md value), states whether BRAND.md itself needs updating, generates corrected preview using BRAND.md as authority, and waits for approval before patching. Combined with `detectConfirmationOfDecision`, approval triggers a `DESIGN_PATCH_START` with corrected values. Gap: no integration test verifying the end-to-end flow (agent sees drifted spec + BRAND.md → surfaces discrepancies in response) — prompt unit tests only.

- **featureName-keyed conversation store + platform-enforced decision commits** — Conversation store re-keyed from `threadTs` to `featureName` so all threads in the same feature channel share one history. A new thread in `#feature-onboarding` loads full accumulated context immediately. `detectConfirmationOfDecision` Haiku classifier added to `agent-router.ts`; when user confirms a design decision (picks option, locks something, agrees), a PLATFORM OVERRIDE is injected forcing a `DESIGN_PATCH_START` block in that response — prevents confirmed decisions from existing only in conversation history. Call order updated for design agent: `[isOffTopicForAgent, isSpecStateQuery, detectRenderIntent, detectConfirmationOfDecision, extractLockedDecisions, runAgent]`. All test files updated to use featureName as store key; 455 tests pass.

- **Trust Step 2 — Save checkpoint (committed vs discussed)** — After every DRAFT/PATCH spec save, `generateSaveCheckpoint()` in `runtime/conversation-summarizer.ts` runs a Haiku call in parallel with HTML preview generation (`Promise.allSettled`). Haiku compares the saved spec against the last 12 conversation turns and returns `{ committed, notCommitted }`. `buildCheckpointFooter()` in `message.ts` formats this as a Slack block showing key committed decisions (bullets) and anything still only in the thread (with a numbered prompt to lock them in). Zero added latency. 5 new unit tests in `conversation-summarizer.test.ts`; all 444 tests pass.

- **Trust Step 0.5 — Platform-enforced render/preview behavior** — `runtime/agent-router.ts` exports `detectRenderIntent()` (Haiku classifier). `interfaces/slack/handlers/message.ts` calls it before the design agent runs on every non-short-circuit message. `render-only` intent: reads current draft from GitHub and calls `generateDesignPreview()` directly — agent is bypassed, deterministic. `apply-and-render` intent: injects a mandatory PLATFORM OVERRIDE into the enriched user message, forcing a PATCH block output. Replaces prompt-rule-only approach which was probabilistic. 9 new `detectRenderIntent` tests in agent-router.test.ts; all 432 tests pass.

- **Trust Step 0 — Slack event idempotency** — `interfaces/slack/app.ts` deduplicates by `event_id` using a module-level `Map<string, number>`. On each incoming event: purge entries older than 5 minutes, drop silently if `event_id` already seen, otherwise record and process. Eliminates duplicate parallel agent runs from Slack's at-least-once delivery (was causing 6-minute hangs and double responses).

- **PATCH mechanism + auto-retry on truncation (all agents)** — All three spec-producing agents (PM, design, architect) use section-level PATCH blocks (`PRODUCT_PATCH_START/END`, `DESIGN_PATCH_START/END`, `ENGINEERING_PATCH_START/END`) when a draft already exists. `runtime/spec-patcher.ts` (`applySpecPatch`) merges patches into the existing draft by section. When a DRAFT block is truncated (start marker present, end marker absent), the platform auto-retries with a SYSTEM OVERRIDE instruction to force PATCH — user never sees the error. 401 tests across 22 files. Unit tests for all patch helpers + `applySpecPatch`. Integration tests for all three patch flows + truncation auto-retry.

- **Design agent HTML preview** — On every design spec draft save, generates a self-contained HTML preview (`<feature>.preview.html`) on the design branch using Tailwind CDN + Alpine.js. All screens tabbed, all states (default/loading/empty/error) toggleable. Preview link posted in Slack. Non-fatal. Implemented in `runtime/html-renderer.ts` + `github-client.ts` + `interfaces/slack/handlers/message.ts`.

- **Deterministic HTML preview (cache + patch-based rendering)** — Two-layer fix for non-deterministic previews. Layer 1: `generate_design_preview` handler reads the saved HTML from the design branch and serves it directly — no LLM call. Preview is always identical across "give me the preview" requests. Layer 2: `apply_design_spec_patch` passes the exact patch sections (not the full merged spec) to `updateDesignPreview` — a new function in `runtime/html-renderer.ts` that gives the renderer existing HTML + the changed sections only, so approved inspector states, animations, and brand values are not re-improvised from scratch. 3 new Scenario 16 integration tests (456 total).

- **Trust Step 4e — Visual regression tests for HTML preview** — Playwright tests open a fixture HTML file (using the exact glow template from the renderer prompt) in a real headless Chromium browser and assert: glow element is visible and attached, `glow-pulse` animation is applied (not "none"), `filter: blur` is present, glow is z-index 0 behind content at z-index 1, page background is #0A0A0F, text luminance > 0.5 (not black-on-black), input text color is light, `@keyframes glow-pulse` is in document stylesheets. 10 tests. Run with `npm run test:visual`. Catches the class of silent regressions (invisible glow, wrong colors, missing animations) that unit tests cannot.

- **Step 2.5 — API cost optimization** — `SDLC_DEV_MODE` env flag in `claude-client.ts` switches all agent calls to Haiku when `true`. `cache_control: ephemeral` applied to system prompts for prompt caching.

- **Eval framework + user feedback loop** — `tests/evals/` with golden scenarios per agent (PM, Design, Architect, Concierge). Each scenario has plain-English criteria judged by Haiku. Run with `npm run eval` or `npm run eval:pm` etc. Opt-in, not in CI. 👍/👎 Slack reaction listener (`reaction_added`) saves `{ userMessage, agentResponse, rating, channel, timestamp }` to `specs/feedback/reactions.jsonl` as an append-only JSONL log. The two systems compound: evals give a controlled benchmark; reactions give production signal.

- **Step 2 — Architect agent (engineering spec)** — Sr. Principal Engineer persona with hyperscale + AI/ML expertise. Full spec chain context loading (product + design + engineering draft + cross-feature engineering specs). Phase routing: `design-approved-awaiting-engineering` and `engineering-in-progress` → architect. Auto-save via `DRAFT_ENGINEERING_SPEC_START/END` → `saveDraftEngineeringSpec()`. Approval detection → `saveApprovedEngineeringSpec()`. Blocking questions gate. Dual-role: owns `SYSTEM_ARCHITECTURE.md`, drafts `[PROPOSED ADDITION]` blocks on every approved spec. 22 new tests across architect-agent + github-client test files.
- **Step 1 — Error logging + cross-phase escalation (design agent → PM)** — Structured JSON error logging in `withThinking` (timestamp, agent, channel, thread, errorType, stack). Design agent emits `OFFER_PM_ESCALATION_START/END` when blocked on a product decision; user confirms; PM agent is invoked in the same thread with the question and design context as a primer — no manual relay, no context loss.
- **Progressive status updates** — withThinking placeholder cycles through visible stages (reading spec, writing, auditing, saving) so the human knows what's happening
- **UX Design agent (Steps 3a–3c)** — persona, design spec format, full wiring: phase routing, context loading, draft auto-save, conflict + gap detection, approval detection, thinking indicator, spec link on approval-ready, visualisation offer (Figma AI / Builder.io / Anima)
- **Automated test suite (platform)** — 129 tests across 11 files. All platform tests — zero real API calls, all external dependencies mocked.
- **Blocking gate** — [blocking: yes] open questions prevent spec approval for both pm and design agents; enforced in code, not just prompt
- **Gap detection history persistence** — gap question stored in conversation history so agent correctly interprets follow-up replies
- **Proactive open questions surfacing** — pm agent appends unresolved [blocking: yes] questions after every exchange, unprompted
- **All-agent conflict + gap detection** — spec auditor runs on every draft save; conflict blocks save; gap flags for human decision
- **Spec link on approval-ready** — all spec-producing agents share a direct GitHub link to the draft; documented in AGENTS.md as a non-negotiable convention
- **pm agent with expert persona** — spec shaping, draft auto-save, approval detection
- **Concierge agent** — role-aware entry point, live feature status from GitHub
- **ACTIVE_AGENTS registry** — single source of truth for active agents
- **Structured open questions** — [type: design|engineering|product] [blocking: yes|no] enforced across all agents
- **Approved spec context mode** — pm agent handles post-approval messages; revisions require re-approval
- **Workspace config layer** — all product-specific coordinates in WorkspaceConfig, zero hardcoding
- **Phase-aware routing** — design phase routes to UX Design agent; approved specs handled in approved-spec mode
- **Thinking indicator** — immediate feedback; label reflects active agent
- **Disk persistence for confirmed agents** — survives bot restarts
- **90s API timeout + 20-message history cap** — prevents indefinite hangs
- **Doc sync enforcement** — CLAUDE.md Definition of Done + CI check
