# CLAUDE.md — agentic-sdlc Agent Entry Point

> Read this before doing anything. These are non-negotiable constraints.

---

## What is this repo?

`agentic-sdlc` is a standalone AI-powered SDLC platform. It is a **generic product** — not tied to any specific app. It connects to any team's Slack workspace and GitHub repo via `WorkspaceConfig`. Health360 is the first customer, not a dependency.

---

## Core Principles (Non-Negotiable)

### 1. Single source of truth
The target repo (e.g. `agentic-health360`) is the authoritative source for all product context — vision, architecture, specs. **Never duplicate this information.** No summary files, no cached copies, no hardcoded excerpts. If an agent needs context, it reads it from the repo. If it needs a subset, it filters programmatically (relevance filtering via Haiku, not truncation).

**Violation examples to avoid:**
- Adding a `PRODUCT_SUMMARY.md` that mirrors `PRODUCT_VISION.md`
- Using `.slice(0, 3000)` to truncate a document
- Hardcoding any product name, repo path, channel name, or spec path as a string literal

### 2. No hardcoding
Every product-specific coordinate lives in `WorkspaceConfig`. This includes: product name, GitHub owner/repo, Slack channel names, spec file paths. Before writing any string literal that refers to a specific product, repo, or path — stop and check if it should come from config.

### 3. Config is the only coupling point
A new team onboarding to agentic-sdlc changes only their `.env`. Nothing in the codebase changes. If onboarding a new team would require editing a TypeScript file, that is a bug.

### 3a. Never modify customer repos to serve the platform
The target repo (`agentic-health360` or any future customer repo) is read-only from the platform's perspective. If a platform parser cannot handle the format of a file in the customer repo, fix the parser — never add, modify, or restructure files in the customer repo to make the parser easier.

**This applies even when the change "just adds a section" or "only adds convenience data."** Any change to a customer repo is a product decision and requires explicit user approval framed as such — not an implementation shortcut made behind the scenes.

**Before touching any file in a customer repo:** stop and ask "Is this a product decision the user has approved, or am I doing this to work around a platform limitation?" If the latter, fix the platform.

### 10. Agents are experts — always give an opinionated recommendation

Every agent in this platform represents a specialist with deep domain expertise. When surfacing findings, gaps, or design issues, the agent always gives a specific, opinionated recommendation — what it would do, grounded in its expertise and the product vision. It does not ask the human to decide what the recommendation should be.

**What this means:**
- "I'd align both to `--muted` for visual consistency" — correct
- "Clarify if this is intentional" — not a recommendation, not acceptable
- "Consider whether this should be X or Y" — not a recommendation, not acceptable

The human overrides when they disagree. That's the relationship: expert proposes, human approves or redirects. Never the other way around.

**Structural enforcement (non-negotiable):** For structured outputs (action menu items, rubric findings), the platform detects hedge language after generation and re-runs the specific finding to force an expert recommendation. Prompt framing improves hit rate but is never the mechanism — the post-generation gate is. See `isHedgeRecommendation()` and `enforceOpinionatedRecommendations()` in `runtime/spec-auditor.ts` as the reference implementation. Every new structured output producer must implement the same gate or delegate to an equivalent enforcer.

**Applies to all agents:** UX Designer, PM, Architect, and all future agents. The system prompt framing ("you are a senior [domain] expert") is required in every agent prompt. The structural gate is required for every structured finding output.

### 11. All audits must be deterministic — same input, same output, always

**This is the founding contract of Archon's value proposition. Every audit that gates a decision or surfaces findings must produce identical results on identical input. No exceptions.**

A user can ask an agent 10 times back to back and must get the exact same findings. A feature can be paused for months and the agent must report the exact same gaps it reported before. If an audit returns different results on different runs with the same input, it is not an audit — it is a suggestion engine. Archon does not ship suggestion engines.

**What this means in practice:**
- Readiness checks, phase completion audits, upstream spec audits, and structural validation must be implemented as deterministic functions: parsing, counting, string matching, diff comparison
- `extractAllOpenQuestions`, `auditBrandTokens`, `auditSpecStructure`, `detectResolvedQuestions` are the correct pattern — pure functions, no LLM, same input = same output
- LLM-based evaluation (Sonnet/Haiku rubric scoring) may exist as a **secondary enrichment layer** that surfaces additional findings beyond what the deterministic layer catches — but it must never be the primary gate for any decision
- When writing a new audit, the first question is: "Can this check be implemented without an LLM?" If yes, it must be. If no, document exactly which aspect requires semantic understanding and why it cannot be reduced to structure

**The test for compliance:** Run the audit twice on the same input. If the results differ, the audit is broken — regardless of whether both results are "reasonable."

**Historical violation (April 2026):** `auditPhaseCompletion` with `ARCHITECT_UPSTREAM_PM_RUBRIC` evaluated the same approved PM spec on two consecutive runs. Run 1: found a gap in AC#13. Run 2: `ready=true`, no gaps. The PM spec had not changed. The architect's assessment of upstream readiness was non-deterministic — the user could not trust it.

**Enforcement:** Every new audit function must include a determinism declaration in its JSDoc: either `@deterministic` (pure function, no LLM) or `@enrichment` (LLM-assisted, not a primary gate). An `@enrichment` audit that is wired as a primary gate is a delivery gap.

### 9. No symptom fixes — ever. Always find the root cause.

**When a bug appears, find the architectural assumption that makes it possible — then fix that. Never patch the symptom.**

A symptom fix is any change that makes the bug stop manifesting without eliminating the condition that causes it. Symptom fixes always produce more bugs of the same class because the underlying assumption is still wrong.

**The mandatory gate before writing any bug fix:**
1. What is the invariant that was violated?
2. What architectural assumption allowed the invariant to be violated?
3. Is this the second time this class of bug has appeared? If yes — stop. The first fix was a symptom fix. Find the assumption.

**The test for a real fix:** After the fix, is it *structurally impossible* for the same class of bug to recur? If another bug of the same class is still possible, you fixed a symptom.

**Historical violation (April 2026):** The design spec contained `[type: product] [blocking: yes]` markers that caused an infinite escalation loop. Three symptom fixes were implemented: (1) markers not cleared → add `clearProductBlockingMarkersFromDesignSpec`, (2) gate re-fires on stale markers → add marker-stripping in auto-close path, (3) N42 test for marker cleanup. The root cause — the design spec was being used as a communication channel for PM-scope state, which it should never contain — was only identified when the user asked "why does the design spec have PM questions in it at all?" One root cause fix eliminated all three symptom fixes.

**Enforcement:** If you are writing a fix for a bug class that already has a prior fix in the codebase, stop and read the prior fix before writing the new one. If the new fix addresses the same symptom at a different location, you are fixing a symptom. Escalate to the user: "This is the second fix for this class. The root cause has not been addressed. Here is what I believe the root cause is: [X]. Should I fix that instead?"

### 4. Durable over fast
When two approaches solve the problem — one fast/brittle, one slower/durable — always choose durable. Flag the tradeoff explicitly before implementing. Never implement a shortcut without saying so and getting confirmation.

### 6. Never bypass an agent — ever
An agent bypass is any implementation that reads state directly (GitHub, disk, memory) and produces output without calling the agent. **Do not propose it. Do not recommend it as an option. Do not implement it.**

The reason is correctness, not performance: agents hold conversation context that the platform cannot access. Bypassing an agent means losing uncommitted decisions, in-flight reasoning, and any context that exists only in the conversation history. The output will be stale or wrong.

**Platform enforcement means enforcing the output shape — not replacing the agent.** If the design agent needs to render a preview, the platform injects a PLATFORM OVERRIDE that tells the agent what block to output. The agent still runs. Platform enforcement = mandatory output block. Platform bypass = agent never called. These are opposites, not synonyms.

**If you are about to write code that reads from GitHub/disk and generates output without calling the agent: stop. That is a bypass. Do not propose it as one option among several. Propose only the agent-in-the-loop approach.**

### 5. Extensibility by default
Every agent, function, and data structure should be built assuming more agents and more teams are coming. The pattern established for the pm agent is the pattern for all future agents. Build it right the first time.

### 8. Platform enforcement first — prompt rules are a last resort, never a primary mechanism

**Every agent behavior that must reliably occur must be enforced by the platform, not instructed in a prompt.**

Prompt rules are probabilistic. The model can ignore them, reinterpret them, or deprioritize them under competing instructions. A behavior that "usually works" is not a behavior you can ship. If the system's correctness depends on the model reading an instruction and choosing to comply, it will fail in production.

**The decision gate — before writing any code that governs agent behavior:**
1. Does this behavior need to happen reliably, not just usually?
2. Can the platform detect whether it happened (by checking state, reading tool call output, or inspecting the response)?
3. If both: **implement the platform check first**. The prompt instruction is a redundant backup, not the mechanism.

**What "platform enforcement" means:**
- After the agent runs, the platform reads state and verifies the required behavior occurred
- If it didn't, the platform corrects it — overrides the response, sets state, triggers the right path — regardless of what the agent said
- Examples: escalation gate (auto-triggers if agent skips `offer_pm_escalation`), brand finalization gate (blocks `finalize_design_spec` if drift detected), approval gate (clears `pendingApproval` before saving)

**What is NOT platform enforcement:**
- A system prompt instruction: "When you see X, call tool Y" — probabilistic
- A notice injected into the user message: "For product gaps, call offer_pm_escalation" — probabilistic
- A tool description: "Call this when Z occurs" — probabilistic
- A regex that matches "bad" text in agent output — probabilistic (there are infinite ways to not comply)

### 8a. Enforcement output contract rule (non-negotiable extension of Principle 8)

**Before writing any code that re-runs an agent or overrides its response, state the output contract first.**

An output contract is: *"Correct output contains [X]. The platform verifies [X] is present."*

**Verify presence of required output. Never detect absence of good output by matching bad text.**

| ❌ Wrong (text-pattern gate) | ✅ Right (structural gate) |
|---|---|
| `DEFERRAL_PATTERN.test(response)` | `countRecommendations(response) < requiredCount` |
| `response.includes("I cannot")` | `response.match(/my recommendation:/gi).length >= n` |
| Regex list of bad phrases | Count of required format markers |

Text-pattern gates are always incomplete — there are infinite phrasings of non-compliance. A structural gate that verifies the required format is present catches everything: refusal, clarification-stall, partial answer, hallucination, tangent.

**The gate question:** "What must be present in correct output, and can I count or parse it?" If the answer exists, implement the count/parse check. A regex against output content is a code smell for this pattern.

**Delivery requirement:** When any change touches `agents/*.ts`, the self-rating must explicitly enumerate:
- Which behaviors are platform-enforced (structural) and where the enforcement code lives
- Which behaviors are prompt-dependent (probabilistic) and why platform enforcement isn't possible for each

A prompt-dependent behavior with no justification is a delivery gap, same as a missing test.

**Historical violations that were fixed:**
- Escalation trigger: was a prompt instruction ("call offer_pm_escalation when you see product gaps"), now a platform gate in `runDesignAgent` that auto-triggers when `[type: product]` findings exist and `getPendingEscalation` is null
- Brand drift: was a prompt instruction, now `auditBrandTokens()` runs deterministically on every response
- Finalization gate: was a prompt instruction ("don't approve if questions remain"), now `extractBlockingQuestions()` hard-blocks the `finalize_*` tool handler
- PM escalation brief enforcement: was `DEFERRAL_PATTERN` regex against agent response text, now `countRecommendations(response) < countBriefItems(question)` structural count gate

### 7. Zero human errors of omission — the specialist always surfaces violations proactively

**This is the founding premise of Archon. It is not a feature. It cannot be added later.**

The human cannot be expected to know what to ask. They don't know what they don't know. It is the agent's job — not the human's — to detect and surface every constraint violation, gap, conflict, and drift on every response. No check should be trigger-phrase-dependent. No audit should wait for the human to notice a problem and ask the right question.

**What this means in practice:**
- If a spec has blocking questions, the agent surfaces them — without being asked
- If brand tokens have drifted from BRAND.md, the agent flags it — without being asked
- If a design decision contradicts the product spec, the agent stops — without being asked
- If committed decisions exist that aren't in the spec, the agent surfaces them — without being asked

**Every agent must implement a proactive audit for its domain:**
- PM agent → `spec-auditor.ts` runs on every draft save (conflict + gap detection)
- Design agent → `brand-auditor.ts` runs on every response (brand token drift), spec-auditor on every draft save; always-on `designReadinessNotice` via `auditPhaseCompletion(buildDesignRubric)` on every message when design spec draft exists; content-addressed cache on spec fingerprint
- Architect agent → `spec-auditor.ts` runs on every draft save (conflict + gap detection); always-on `archReadinessNotice` via `auditPhaseCompletion(ENGINEER_RUBRIC)` on every message when engineering spec draft exists; same content-addressed cache as design
- Every future agent → must define and wire its equivalent proactive audit before the agent is considered complete

**The test for compliance:** Could a human approve a spec with a known violation without being told? If yes, the audit is missing or mis-wired.

**Violation examples to avoid:**
- Implementing a check that only fires when the user says a specific phrase ("the preview looks wrong")
- Adding a constraint check to the system prompt as an instruction ("if you see drift, surface it") — prompt rules are probabilistic, not deterministic
- Writing an audit that runs on some response paths but not others
- Deferring a constraint check to "when we have more time"

### 12. Design before code — no behavioral change without holistic review

**Before proposing or implementing any change to agent behavior, routing, context injection, or domain boundaries, answer three questions in writing:**

1. **Scale:** How does this behave at 100 features, 10 agents, 5 tenants? If the answer involves unbounded growth (token count, API calls, prompt size), redesign before implementing.
2. **Ownership:** Which existing agent or component already owns this responsibility? If the answer is "another agent already does this," the change is duplication — not a fix.
3. **Cross-cutting:** Does this change affect more than one agent? If yes, design the cross-agent pattern first, then implement. Never patch one agent and discover the pattern later.

**The test:** Could this change be reverted within 24 hours because it conflicted with a design decision that should have been obvious? If yes, the review was insufficient.

**Historical violation (April 2026):** Architect in product-level mode deflected "which feature is being worked on?" Three fixes were attempted in 30 minutes: (1) inject all feature status into all agents, (2) add "pipeline status is common knowledge" to prompts, (3) cap at 10 features. The root cause — should pipeline status be in every agent's context at all? — was only asked after all three fixes shipped. One thoughtful design pass would have produced the right answer (summary count + redirect to concierge for details) without the iteration.

**Enforcement:** Any commit touching `agents/`, `interfaces/slack/handlers/general.ts`, or routing logic in `message.ts` that adds new context injection, domain boundary changes, or cross-agent behavior must include a `// DESIGN-REVIEWED: [1-sentence rationale]` comment at the change site. The pre-commit hook blocks without it.

### 13. Single routing authority — `resolveAgent()` is the only source of truth

**Every feature channel routing decision must flow through `resolveAgent(featureName)`.** No code path may read `confirmedAgent` directly and use it for routing without `resolveAgent()` having run first.

`resolveAgent()` reads the feature's phase from GitHub (deterministic — based on which spec branches exist) and maps it to the canonical agent. If the persisted `confirmedAgent` disagrees, `resolveAgent()` corrects it. This makes stale routing state structurally impossible.

**The phase-to-agent mapping is deterministic:**
```
product-spec-in-progress           → pm
product-spec-approved-awaiting-design → ux-design
design-in-progress                 → ux-design
design-approved-awaiting-engineering → architect
engineering-in-progress            → architect
```

**What this means in practice:**
- No scattered phase-advance checks — `resolveAgent()` handles all transitions
- `setConfirmedAgent()` is only called by `resolveAgent()` for corrections and by phase finalization handlers for advances
- `@pm:` text prefix and slash commands are temporary overrides — they set the local `confirmedAgent` variable but never call `setConfirmedAgent()`
- Tests that set `confirmedAgent` manually for a specific agent path must also mock `getInProgressFeatures` to return matching branches

**Historical violation (April 2026):** `/pm` slash command in `#feature-onboarding` persisted `confirmedAgent=pm` via `setConfirmedAgent()`. The feature was in engineering phase. Next message routed to PM instead of Architect — 1,245 tests didn't catch it because no test verified the invariant "confirmedAgent must agree with GitHub phase."

### 14. Deterministic audits are retroactive — approved specs are not exempt

**When a deterministic auditor is added or improved, all existing specs — including approved ones — must pass the new checks before downstream phases can finalize.**

An approved spec that fails current audits is a platform enforcement gap, not a grandfathered exception. The spec chain is only as strong as its weakest link.

**What this means in practice:**
- `handleFinalizeEngineeringSpec` runs `auditPmSpec()` and `auditDesignSpec()` on the approved upstream specs. If either has findings, finalization is blocked until the upstream agent fixes them via the escalation flow.
- `handleFinalizeDesignSpec` logs `auditPmSpec()` findings as a warning (the hard gate is at engineering finalization).
- When a new deterministic check is added to any auditor, it automatically applies to all specs — past and future — on the next finalization attempt.

**Historical violation (April 2026):** The PM spec was approved before `auditPmSpec()` existed. When the architect tried to finalize the engineering spec, 7 deterministic findings (vague timing, vague language) were present in the approved PM spec but not caught — the finalization gate didn't check upstream specs. The architect finalized AND then escalated PM gaps, which is a contradiction.

### 15. Cross-agent parity — every enforcement mechanism must exist in ALL analogous paths

**When an enforcement mechanism (writeback, gate, audit, closure message) exists in one agent's escalation/confirmation path, it must exist in EVERY analogous path across all agents. No exceptions.**

This is not "nice to have" — it's a structural invariant. When a new agent is added or an existing path is modified, the commit must include the same mechanism in every analogous path. The pre-commit hook counts reply paths vs writeback calls and blocks if they don't match.

**What this means in practice:**
- Design→PM escalation reply has `patchProductSpecWithRecommendations` + closure message → architect→PM escalation reply MUST have the same
- PM finalization has open question blocking → design and engineering finalization MUST have the same
- Design agent has hedge detection → PM and architect MUST have the same

**Historical violation (April 2026):** The architect→PM escalation confirmation path was built without `patchProductSpecWithRecommendations`. The design→PM path had it. The PM said "I'll apply that now" and the user confirmed, but the product spec was never updated. The same writeback existed 200 lines above in the design path — it was never ported.

**Enforcement:** Pre-commit hook `[ESCALATION WRITEBACK GATE]` counts `branch=*-reply` paths vs `patchProductSpecWithRecommendations`/`patchEngineeringSpecWithDecision` calls. Blocks if writebacks < reply paths.

### 16. Spec write ownership — resolved decisions land only in the owner's spec

**Every agent owns exactly one spec; resolved decisions authored by that agent land only in that spec. The platform is always the writer (acting as scribe), but it never moves agent X's resolved content into agent Y's spec.**

| Agent | Owned spec | Path on disk |
|---|---|---|
| PM | product spec | `<features>/<feature>/<feature>.product.md` |
| Designer | design spec | `<features>/<feature>/<feature>.design.md` |
| Architect | engineering spec | `<features>/<feature>/<feature>.engineering.md` |

**The rule applies to RESOLVED content** — a decision the owning agent made that should be the canonical record. If PM's escalation-resume run produces "AC#1 timing is 200ms," that lands in the **product spec only**, not in the engineering spec under a `### Architect Decision` heading. The architect re-reads the product spec on every run via `loadArchitectAgentContext`; duplicating into the engineering spec creates two sources of truth (Principle 1 violation) and append-only writeback layouts that pile up `### Architect Decision (pre-engineering)` blocks.

**Carve-out — preseeded open items / handoff sections.** An upstream agent MAY write into a downstream agent's spec when the content is explicitly **unresolved** — a TODO list or handoff section the downstream agent will resolve. The legitimate cases today:
- `preseedEngineeringSpec` — designer queues architect-scope items as TODOs in the engineering spec for the architect to resolve.
- `seedHandoffSection` — designer seeds `## Design Assumptions To Validate` into the engineering spec for the architect to validate or reject.
- `clearHandoffSection` — architect (after `finalize_engineering_spec`) removes `## Design Assumptions` from the design spec on main, since the assumptions have been validated/superseded. Reciprocal cleanup of a section the upstream agent itself marked transient.

**Carve-out test:** the section heading must contain the words "TODO," "To Validate," "Open Question," or equivalent transient-state language. If you can't justify the cross-agent write as a flagged-open-item, it's a violation.

**The decision gate before writing any new writeback callsite:**
1. Is the content a *resolved decision* or an *open item*?
2. If resolved: who authored it? That agent's owned spec is the only allowed destination.
3. If open: is the destination spec's owner the agent that will resolve it? Use the preseed pattern.
4. If neither: the write doesn't belong here at all.

**Historical violation (April 2026):** `patchEngineeringSpecWithDecision` was called from BOTH paths in `interfaces/slack/handlers/message.ts`:
- Designer→architect escalation reply (correct — architect-authored content into engineering spec)
- Architect→PM/designer escalation reply (wrong — PM/designer-authored content into engineering spec)

The wrong call recorded PM's product-spec resolutions under a `### Architect Decision (pre-engineering)` heading in the engineering spec — wrong author, wrong spec, wrong framing. Append-only layout meant N escalations produced N duplicate-heading blocks. Caught by `auditSpecStructure` after the fact, but no structural gate prevented the write. Manifest B8, regression catalog bug #14.

**Enforcement:** `tests/invariants/spec-write-ownership.test.ts` — AST-greps every callsite of `saveDraft*` / `saveApproved*` / `patch*Spec*` / `preseed*` / `seedHandoffSection` / `updateApprovedSpecOnMain` and verifies each is consistent with the principle (or a documented carve-out). Adding a new writeback that doesn't fit FAILS at PR time.

### 17. Cross-surface message consistency — every claim about state agrees, everywhere, every time

**Every claim the platform makes to a user about feature state must be consistent across all surfaces, all invocations, all channels, and all time within a turn. Same query → same factual answer regardless of who's asking, where they're asking, when they're asking, or which agent is responding.**

This is the foundational Archon promise. A user must be able to trust what the platform says about state — if surfaces contradict each other, the user has no reliable way to know what's actually true.

**Consistency dimensions (non-negotiable in all six):**

| Dimension | What "consistent" means |
|---|---|
| Across invocations | Same query asked 5 times in 5 minutes returns the same factual answer. No drift. |
| Across channels | Concierge in `#all-<product>` about feature X agrees with the active agent in `#feature-X`. |
| Across slash commands | `/pm` in feature channel agrees with `/pm` in main channel about the same feature's state. |
| Across agents | What architect says about the spec chain agrees with what PM and Designer say. |
| Within a single response | Platform's claim ("Nothing blocking") doesn't contradict the platform's own next action ("blocked by 31 findings"). |
| Across time within a turn | State-query response and finalize-gate response query the SAME source of truth. |

**Single source of truth:** every state-query / readiness-summary / finalize-gate computation must derive from the same canonical function — today that's `runtime/readiness-builder.ts`'s `buildReadinessReport()` (and the deterministic auditors it composes per Principle 11). No handler may compute its own readiness independently. Per Principle 1 (single source of truth) and Principle 11 (deterministic audits — same input → same output).

**The decision gate before composing any platform message about state:**
1. What state is this message claiming?
2. Is the claim derived from the canonical SSOT (`buildReadinessReport()` + deterministic auditors)?
3. If a different surface composes a similar message about the same state, do they share that derivation path?
4. If yes to all three: the message is consistent by construction. If no to any: it's a Principle 17 violation.

**Historical violation (manifest B13, surfaced 2026-05-01 in MT walk Step 2):** Architect's state-query fast-path responded `Nothing blocking — you can review and approve when ready` while the upstream PM spec on main had 1 deterministic finding and the design spec had 30 findings. When the user replies `approved`, the finalize gate (Principle 14: deterministic audits are retroactive) runs `auditPmSpec` + `auditDesignSpec` and blocks with 31 findings — directly contradicting the prior message. Same turn, two platform messages, factually inconsistent. Root cause: the readiness aggregator's `aggregate=ready-pending-approval total=0` only counts the architect's own engineering-spec findings; it does not query upstream specs. The fast-path and the finalize-gate are NOT deriving from the same SSOT.

**Enforcement:** `tests/invariants/cross-surface-consistency.test.ts` — extensible structural invariant. v1 pins the SSOT contract (`buildReadinessReport` exists, exports correctly, is the canonical computation). As consistency violations are surfaced via integration walks, specific assertions are added. The invariant test grows over time as the consistency bar gets more concretely enforced; the principle does not change.

**Discipline when a consistency violation is found:**
1. Add a manifest entry for the specific violation (with all surfaces it affects enumerated)
2. Add a regression test pinning the post-fix consistent behavior
3. Add a specific assertion to `tests/invariants/cross-surface-consistency.test.ts` so the class can never recur
4. Fix the root cause: route the violating surface through the canonical SSOT

### 18. Block E focus — no legacy-handler fixes without justification

**While the platform is on the path from legacy multi-exit handlers to the V2 single-path runners (Block A → Block E cutover → Block F1 legacy deletion), no fix may be made to the legacy handler code without explicit justification in the commit message.** Bug fixes that V2 retires by construction are throwaway work and are forbidden — they must be deferred via the manifest's `retired_by_v2_cutover` annotation.

**Why this principle exists.** The platform has two architectures running in parallel: legacy (`runArchitectAgent` / `runDesignAgent` / `runPmAgent` in `interfaces/slack/handlers/message.ts`, multi-exit anti-pattern) and V2 (`runArchitectAgentV2` / `runDesignAgentV2` / `runPmAgentV2` in `runtime/agents/`, single-path with structural invariants). V2 is fully built and runs in shadow mode; cutover is the threshold that retires legacy. Every fix landed in legacy code between now and cutover is deleted at Block F1. **Repeated drift into legacy fixes has consumed weeks of throwaway work this session alone.** This principle structurally prevents the drift.

**The legacy paths protected by this principle:**
- `interfaces/slack/handlers/message.ts` (the multi-exit handler — entire file is the legacy entry point)
- `agents/architect.ts`, `agents/design.ts`, `agents/pm.ts` (the legacy agent entry-point modules)
- Any legacy-only auto-trigger override / readiness-aggregator code that V2's single-path discipline structurally retires

**The legitimate justifications for editing legacy code (must appear verbatim in commit message as `LEGACY-FIX-JUSTIFIED:`):**
- `LEGACY-FIX-JUSTIFIED: security-or-data-loss` — the bug actively causes data loss, security exposure, or PII leakage in production right now
- `LEGACY-FIX-JUSTIFIED: blocks-block-A-cutover` — the bug blocks the cutover itself (e.g., a V2 bug that requires legacy stability to safely deploy V2)
- `LEGACY-FIX-JUSTIFIED: blocks-production` — the bug breaks the running production system in a way users cannot work around

**What is NOT a valid justification:**
- "This bug surfaces in manual testing" — defer via `retired_by_v2_cutover: true` and let cutover retire it
- "This is a small fix" — small fixes accumulate; the size doesn't matter, the throwaway property does
- "We can fix it now and remove it later" — there is no "remove it later" that's cheaper than not fixing it now

**Enforcement:** Pre-commit hook `[LEGACY-FIX GATE]` blocks any commit modifying the legacy paths above without `LEGACY-FIX-JUSTIFIED:` in the commit message. Mechanical, not memory-dependent. Same shape as Hook 4 (bundled-fix detector).

**Companion structural enforcements:**
- Every new B-item added to `docs/cutover-gate-status.json` must declare a `retired_by_v2_cutover: <true|false|partial>` field. Pre-commit hook `[NEW B-ITEM GATE]` enforces.
- `BLOCK_E_FOCUS.md` at repo root lists the next 3-5 manifest items blocking M0, ordered. Read at every session start.
- `MANUAL_TESTS_PENDING.md` carries a banner: "Manual testing of legacy paths is suspended until Block A cutover. Resume on V2 after burn-in." Pre-push hook respects this.

**Historical context.** Across multiple sessions before this principle was codified, the assistant repeatedly drifted from the canonical Block-A-to-Block-E sequence into reactive single-bug-per-session legacy fixes. Each drift surfaced more bugs (B6, B7, B8, B9, B9b, B10, B11 v1, B13, B14, B15, B16) — most of which were patches to the legacy multi-exit handler that V2's single-path discipline retires by construction. Hours of work landed in code scheduled for deletion at Block F1. This principle, plus the hooks, mechanically prevents the pattern from recurring.

---

## Architecture

See `SYSTEM_ARCHITECTURE.md` for the full system design.
See `BACKLOG.md` for the ordered list of what to build next.
See `DECISIONS.md` for solo-team shortcuts that need to change at scale.

---

## Before Writing Any Code

1. Check `BACKLOG.md` — are you working on the right next step?
2. Check `WorkspaceConfig` — does any value you're about to hardcode belong there?
3. Ask: is there a single source of truth for this, and am I reading from it?
4. Ask: if a second team onboarded tomorrow, would this code still work without changes?

---

## Testing Discipline (Non-Negotiable)

Before building the second piece of any system, a test suite must exist for the first. This is not optional and does not require human prompting.

**Current state:** A test suite for the existing pm agent, concierge, routing, GitHub operations, and phase detection is the next item in BACKLOG.md. No new agents are built until it exists.

**Ongoing rule:** Every new agent behavior added must have a corresponding test. A behavior with no test does not count as done.

### Fixture Rule (Non-Negotiable)

**Any component that parses agent output must be tested against real agent output — not hand-crafted strings.**

This is not optional and applies to every parser, every auditor, every block detector, every classifier in the platform.

**The rule:**
- When adding a parser that reads agent output (spec blocks, patch blocks, brand sections, classification responses), capture a real sample from an actual agent run and commit it to `tests/fixtures/agent-output/`
- The test must load the fixture via `readFileSync` — not reproduce the format from memory or approximation
- Hand-crafted inline strings are only acceptable for explicit edge cases (empty string, partial input, boundary conditions) — never for format validation

**Why this rule exists:**
The brand auditor bug (March 2026) was caused by a regex that matched the assumed format (`--token: #RRGGBB`) but not the real format (`` `--token:` `#RRGGBB` ``). All tests passed because the test fixtures were hand-crafted to match the assumed format. The parser silently produced zero results in production. The tests gave false confidence — they validated an input that never appears.

**Enforcement:** Every new parser that ships without a real-agent-output fixture is considered incomplete. A "behavior with no real fixture" is the same failure class as "a behavior with no test." A PR that adds a parser without a sourced fixture will be flagged.

### Producer–Consumer Chain Rule (Non-Negotiable)

**When a platform gate depends on a specific tag or pattern appearing in LLM output, there must be a test that exercises the full producer → consumer chain — not just the consumer in isolation.**

The fixture rule catches: "test format doesn't match real format." This rule catches: "test assumes the producer generates X, but producer was never verified to generate X."

**The rule:**
- If a gate fires when string S appears in LLM output, there must be a test that verifies the LLM prompt (rubric, system prompt, or classifier) actually instructs the model to produce S
- Mocking the LLM to return S directly is valid for testing the consumer (gate logic) — it is NOT a substitute for testing the producer (prompt contains the instruction)
- When a prompt is updated to add a new instruction or tag, add a fixture showing real LLM output that demonstrates the instruction is followed

**Why this rule exists:**
The N18 escalation gate (April 2026) was tested by injecting `[type: product]` directly into the mocked Anthropic response. The gate logic was correct. But `buildDesignRubric` criteria 1–9 contained no instruction to produce `[type: product]` tagged output — so the real Haiku run never generated that tag. The gate was tested in isolation from the rubric that was supposed to feed it. The fix required adding a pre-run deterministic gate that doesn't depend on LLM tagging at all, plus a new rubric criterion 10.

**Enforcement:** Any gate that pattern-matches on LLM output must have: (1) a consumer test (mocked LLM, validates gate logic) AND (2) a producer test (real or fixture-verified LLM output, validates that the prompt generates the expected tag/pattern).

### Call-Site Context Rule (Non-Negotiable)

**Any rubric criterion that says "compare against [X]" must have a call-site test that verifies [X] is actually passed as a non-empty parameter at every call site.**

The producer-consumer chain rule catches: "test format doesn't match real format" and "producer never generates the expected tag." This rule catches: "the criterion references context that is never provided to the function."

**The rule:**
- When a rubric criterion references external context (e.g. "compare against the approved product spec"), enumerate every call site of the audit function
- For each call site, verify in a test that the relevant context parameter (e.g. `approvedProductSpec`) is non-empty when the criterion is expected to fire
- A criterion that references context not present in the params is silently a no-op — it will return PASS even when gaps exist

**Why this rule exists:**
Criterion 10 of `buildDesignRubric` was updated to compare design decisions against the approved product spec. Tests verified the rubric text and the gate's parsing. But `approvedProductSpec` was never added to the `auditPhaseCompletion` params — so criterion 10 always evaluated against an empty context and returned PASS. The design agent then caught the same gaps in prose but didn't call `offer_pm_escalation` (prompt-dependent), so the N18 gate never fired. Discovered only via Slack testing, not proactively.

**Enforcement:** When any rubric criterion is added or modified to reference external context, immediately: (1) add `approvedXxx?: string` to the audit function's param type, (2) inject it into the context section, (3) add a unit test asserting the param appears in the user message, (4) verify every call site passes the param.

---

## Subagent Strategy

Use subagents for exploration, research, and parallel analysis — keep the main context focused on implementation decisions. One task per subagent. For broad codebase searches or multi-file analysis, always prefer an Explore subagent over inline grep/read loops.

---

## Self-Correction

After any correction from the user, immediately save a feedback memory so the same mistake does not recur across sessions. Do not wait until the end of the session. The correction is only useful if it persists.

---

## Autonomous Bug Fixing

When given a bug or failing test: fix it end-to-end without hand-holding. Read the error, trace the root cause, implement the fix, verify it works. Do not ask the human to confirm intermediate steps. Zero context-switching cost to the user is the goal.

---

## Demand Elegance

For non-trivial changes: before presenting a solution, ask "is there a more elegant way?" If a fix feels hacky, implement the clean version — not the workaround. Skip this for obvious one-liners. Never sacrifice durability for elegance — the two are not in conflict here, they compound.

---

## Definition of Done (Non-Negotiable)

A task is NOT done until the following are updated to reflect the change:

| What changed | What must be updated |
|---|---|
| New agent built or modified | `AGENTS.md` — persona, capabilities, inputs/outputs; agent prompt must include `## Domain boundary — what you never own` section naming each neighboring agent's exclusive territory |
| New branch or path added to `message.ts` or `agent-router.ts` | `tests/integration/workflows.test.ts` — new scenario in the **same commit**; `--coverage` alone is insufficient (lines executed ≠ behavior verified) |
| New runtime behavior, routing, or data flow | `SYSTEM_ARCHITECTURE.md` — architecture section |
| New backlog item completed | `BACKLOG.md` — move to Completed |
| New solo-team shortcut taken | `DECISIONS.md` — add entry with scale gap |
| New agent built | `message.ts` — must add always-on platform audit block (`[X]ReadinessNotice`) before agent is considered complete; see `designReadinessNotice` / `archReadinessNotice` as reference implementations. Finalization handler must run TWO checks: (1) same-domain rubric (`[X]_RUBRIC`), (2) adversarial downstream-readiness audit (`auditDownstreamReadiness` with the next role's persona) — an open-ended "pretend you're [next role], what's missing?" prompt with no enumeration ceiling. Both checks are required; the rubric alone is insufficient. Agent prompt must include `## Domain boundary — what you never own` with explicit prohibitions for each neighboring agent's exclusive territory (e.g. PM: never write UI copy or visual specs; Designer: never make product behavior decisions; Architect: never make product or design decisions). Agent prompt must include a "Read the room first" newcomer orientation instruction — if someone introduces themselves or asks an orientation question, orient them (feature, phase, your role) before gap analysis or proposals. **Enforcement audit (non-negotiable):** Before the agent's first live test, enumerate every platform enforcement mechanism from existing agents in a table: mechanism name, existing agent implementation, new agent implementation, justification if skipped. Every enforcement that exists in any agent must be implemented or explicitly justified. Never treat a new agent as greenfield — it is the Nth instance of a pattern with N-1 hardened implementations. |
| New WorkspaceConfig field added | `.env.example` — add with comment |
| New agent goes live | `PRESENTATIONS.md` + `platform-engineering-deep-dive.html` + `investor-pitch.html` |
| Roadmap step completes | `PRESENTATIONS.md` + `investor-pitch.html` + `platform-engineering-deep-dive.html` |
| New Claude Code practice added | `PRESENTATIONS.md` + `ai-engineering-practices.html` |
| Website positioning changes | Cross-check `investor-pitch.html` against `getarchon.dev` |

**This applies to every session, every task, without exception.** Do not ask the human if docs need updating — they always do if code changed. Do not defer doc updates to a later session. Update them before marking the task complete.

The CI check in `.github/workflows/` enforces this at the merge level — a PR that touches `agents/` or `runtime/` without touching the relevant docs will fail.
