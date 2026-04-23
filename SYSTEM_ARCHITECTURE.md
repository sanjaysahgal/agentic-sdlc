# archcon — Platform Architecture

## Platform Identity

**archcon** is a licensed, multi-tenant SDLC platform. It is not a tool built for one team — it is a platform that other teams license and deploy to automate their entire software development lifecycle, from the first product conversation to production deployment.

A customer brings three things: a Slack workspace, a GitHub repository, and a `.env` configuration file. archcon provides everything else: agents, spec chain, GitHub integration, and the routing logic that connects them. No code changes are required to onboard a new customer — only environment variables change.

### Two-repo model

archcon is two repos working together as one platform:

| Repo | What it is |
|---|---|
| `archcon` (this repo) | The SDLC engine — Slack bot, agents, spec chain, GitHub integration |
| `agentic-cicd` | The deployment pipeline — builds and deploys the customer's app |

A customer can license archcon alone (SDLC only — specs through to code review) or both repos (full autonomous pipeline — specs through to production). The two repos are designed to be independently useful but compose cleanly.

### The only coupling point

`WorkspaceConfig` is the only thing that changes between customers. It lives in environment variables. Every agent, every routing decision, every GitHub operation reads from it. Nothing else is customer-specific. A new customer onboards by pointing these env vars at their workspace — zero TypeScript changes.

```
PRODUCT_NAME      GITHUB_OWNER      GITHUB_REPO
SLACK_BOT_TOKEN   SLACK_MAIN_CHANNEL
PATH_PRODUCT_VISION   PATH_SYSTEM_ARCHITECTURE   PATH_DESIGN_SYSTEM
PATH_BRAND   PATH_FEATURE_CONVENTIONS   PATH_FEATURES_ROOT
```

---

## The Spec Chain

The spec chain is the authoritative data flow of the platform. Every feature follows this sequence. No phase begins until the previous spec is approved and merged to `main`.

```
PRODUCT_VISION.md (customer repo — authoritative constraint for all features)
SYSTEM_ARCHITECTURE.md (customer repo — authoritative constraint for all features)
DESIGN_SYSTEM.md (customer repo — authoritative constraint for all features)
        │
        ▼
Feature Brief (human in Slack → #feature-<name>)
        │
        ▼
<feature>.product.md  ── Product Spec ── approved by PM
        │
        ▼
<feature>.design.md   ── Design Spec  ── approved by UX Designer
        │
        ▼
<feature>.engineering.md ── Engineering Spec ── approved by Architect
        │
        ▼
<feature>.workitems.md ── Work Items ── approved by team
        │
        ▼
Code (PRs in customer app repo, opened by engineer agents)
        │
        ▼
QA sign-off (QA agent validates against acceptance criteria)
        │
        ▼
Production deploy (via agentic-cicd pipeline)
```

Each approved spec is the source of truth for the next phase. Agents in each phase read all upstream specs before writing a word. The chain is enforced by phase detection — no agent activates out of sequence.

### The three authoritative docs

These three documents are not feature specs. They are the living architectural foundation that every feature spec is evaluated against, and that every agent drafts updates to as features reveal new constraints, patterns, or decisions.

| Document | Owner agent | Updated when |
|---|---|---|
| `PRODUCT_VISION.md` | PM agent | Every approved product spec — PM drafts vision updates inline |
| `DESIGN_SYSTEM.md` | Design agent | Every approved design spec — design agent drafts system updates inline |
| `SYSTEM_ARCHITECTURE.md` | Architect agent | Every approved engineering spec — architect drafts architecture updates inline |

**Upstream doc update behavior (non-negotiable platform behavior):** All three spec-producing agents always draft the actual proposed changes to their authoritative doc as part of every approved spec. They do not flag what needs changing — they write the proposed text, clearly marked for human review. Human approves; agent drafts.

---

## Agent Architecture

### What an agent is

An agent in archcon is not a server, a process, or a fine-tuned model. It is:

1. A **system prompt builder** (`agents/<name>.ts`) — a function that assembles a text string containing the agent's persona, rules, constraints, and all injected context (authoritative docs, cross-feature specs, current draft, conversation history)
2. A **context loader** (`runtime/context-loader.ts`) — reads the authoritative docs + relevant specs from GitHub fresh on every call
3. A **draft/approval detection pattern** — structured markers in the response that the handler parses to trigger saves, audits, and phase transitions

Switching agents means switching which system prompt is built. All agents use the same Claude API call. The PM and the Architect are the same API endpoint with different instructions and different context.

### The agent contract

Every spec-producing agent in archcon must implement this contract:

1. **Reads full context before first response** — authoritative docs + all previously approved specs in its domain + current draft (if any). Never asks questions the docs already answer.
2. **Leads with a structural proposal** — opens with a concrete proposal derived from the specs, not discovery questions. One question at a time, at the end.
3. **Auto-saves drafts** — outputs `DRAFT_<TYPE>_SPEC_START / END` markers after every response where any decision was made. Handler saves to GitHub automatically.
4. **Detects approval intent** — responds to clear approval signals with `INTENT: CREATE_<TYPE>_SPEC`, then generates the full final spec.
5. **Runs conflict + gap detection** — every draft goes through `spec-auditor.ts` before saving. Conflicts block the save. Gaps save but surface a human decision.
6. **Drafts upstream doc updates** — every approved spec includes a ready-to-apply proposed update to the agent's authoritative doc (PRODUCT_VISION.md, DESIGN_SYSTEM.md, or SYSTEM_ARCHITECTURE.md).
7. **Shares a spec link on approval-ready** — always posts a direct GitHub link to the draft before the human commits to approving.

### Model selection

| Use case | Model | Reason |
|---|---|---|
| Spec shaping (all agents) | `claude-sonnet-4-6` | Deep multi-turn reasoning, long-context handling |
| Intent classification | `claude-haiku-4-5-20251001` | Fast, cheap — no deep reasoning required |
| Relevance filtering (concierge) | `claude-haiku-4-5-20251001` | Same — extract relevant subset, not reason about it |
| Spec auditing (conflict/gap) | `claude-haiku-4-5-20251001` | Same — pattern match against vision/architecture |
| Conversation overflow summarization | `claude-haiku-4-5-20251001` | Compress older turns cheaply; output cached in-memory |

The rule: Sonnet for anything requiring judgment. Haiku for everything else. This is enforced explicitly — no default model is used.

### The dual role of spec-producing agents

Every spec-producing agent operates simultaneously at two levels:

- **Feature level:** shapes the current feature's spec through conversation with the human specialist
- **Domain level:** holds cross-feature coherence for their domain, reads all previously approved specs, flags inconsistencies, and drafts updates to their authoritative doc

This is enforced by context loading — every agent loads both the current feature's draft AND all previously approved specs in its domain before responding.

---

## Efficiency & Robustness Patterns

### Parallel context loading

Every agent loads all its context in a single `Promise.all()` call. GitHub reads for product vision, architecture, design system, current draft, and all approved cross-feature specs fire simultaneously — not sequentially. This is enforced in `context-loader.ts`. Sequential loading would add hundreds of milliseconds per request for no benefit.

Cross-feature spec loading (`loadApprovedSpecs`) races against a 10-second timeout. If the GitHub API is slow, the agent proceeds without cross-feature context rather than blocking the response. Cross-feature coherence is an enhancement, not a hard dependency.

### Conversation context management

Conversation history per Slack thread is capped. When history exceeds the limit, older messages are not discarded — they are summarized by Haiku before being injected into the next request. This preserves conversational continuity across long feature threads without inflating the context window.

The summary is cached in-memory, keyed by `(featureName, olderMessageCount)`. Because conversation history is append-only (older messages never change), the cache entry for any given `(feature, count)` is valid forever. A cache hit on a long thread avoids a Haiku call on every subsequent message.

`identifyUncommittedDecisions` (also in `conversation-summarizer.ts`) compares the full conversation history against the committed spec to surface decisions discussed but not yet saved. The full spec is sent to Haiku — not a truncated slice — so sections past position 3000 (such as the Brand section) are visible. Each history message is truncated at 2500 chars (raised from 600) to preserve enough detail for Haiku to read specific decisions — typography, color values, animation params — that often appear beyond the first 600 chars of a design agent response.

Conversation history is keyed by featureName (not threadTs), so all threads within a feature channel share one accumulated history. On startup, `conversation-store.ts` runs a one-time migration (`migrateThreadTsKeys`) that consolidates any pre-migration threadTs-keyed entries into `"_legacy_"`. `identifyUncommittedDecisions` receives `[...getLegacyMessages(), ...getHistory(featureName)]` so decisions from all prior sessions surface in the PENDING section.

On startup, `pendingEscalations` and `escalationNotifications` are cleared — if the bot crashed mid-escalation, the user's confirmation was lost and holding routing in a dead loop (either "say yes" or routing every message to the wrong agent) is worse than a clean slate. `pendingApprovals` survive restart (they represent spec content the user can still confirm).

Implemented in `runtime/conversation-summarizer.ts`.

### Graceful shutdown

`runtime/request-tracker.ts` tracks all in-flight Claude API requests. On `SIGTERM`, the process waits for all in-flight requests to drain before exiting — with a 6-minute maximum (must exceed Anthropic's 5-minute API timeout). This prevents a deployment or restart from cutting off a user mid-response. Any request still in-flight after the deadline is abandoned and the process exits with a warning.

All Anthropic clients set `maxRetries: 0` and explicit timeouts. The SDK default of 2 retries × 10-minute timeout = 30 minutes per stalled call — two sequential stalls meant a user could wait an hour at "thinking..." with no error surfaced. Timeouts by client role: main agent (`claude-client.ts`) 5 min; rubric auditor (`phase-completion-auditor.ts`) 90s; spec/decision auditors (`spec-auditor.ts`) 60s; conversation summarizer (`conversation-summarizer.ts`) 60s; classifiers (`agent-router.ts`, `context-loader.ts`) 30s. A stall now surfaces as a user-visible error in under 90 seconds.

### Structured runtime logging

All logging is routed through `runtime/logger.ts` (winston + `winston-daily-rotate-file`). Logs are written to stdout and to `logs/bot-YYYY-MM-DD.log` with 14-day retention, 20MB per-file cap, and gzip compression. Errors are also mirrored to `logs/bot-error-YYYY-MM-DD.log` with 30-day retention. `console.log/error/warn` in `server.ts` are redirected through winston so all `[COMPONENT]` log lines from every runtime file are captured automatically.

Every decision point emits a single line using a consistent `[COMPONENT] message` format. No full message content is logged (privacy); user messages are truncated to 100 chars. Components:

| Tag | File | What it logs |
|---|---|---|
| `[ROUTER]` | `runtime/agent-router.ts`, `interfaces/slack/handlers/message.ts` | Intent classification result, agent selected, phase detected, off-topic/state-query boolean, routing branch taken, agent-addressing override (`@pm:`, `@design:`, `@architect:` prefix overrides phase-based routing) |
| `[CONTEXT]` | `runtime/context-loader.ts`, `runtime/conversation-summarizer.ts` | Feature name, hit/miss per GitHub path, summarizer input/output sizes, uncommitted decision scan result |
| `[AUDITOR]` | `runtime/phase-completion-auditor.ts`, `runtime/brand-auditor.ts`, `runtime/spec-auditor.ts` | Phase completion ready/not-ready + finding count + each finding individually (`[AUDITOR] auditPhaseCompletion[N]: issue → recommendation`); brand/animation drift count + each drift token; render ambiguity count + each finding (`[AUDITOR] auditSpecRenderAmbiguity[N]: issue — recommendation`). Every finding visible in logs without Slack inspection. |
| `[GITHUB]` | `runtime/github-client.ts` | Every file read (hit/404), every draft/approved save (success/error), PR URL on creation |
| `[STORE]` | `runtime/conversation-store.ts` | Pending escalation set/clear (with targetAgent), pending approval set/clear, disk persistence errors, stale escalation cleanup on startup |
| `[AGENT-RESPONSE]` | `runtime/claude-client.ts` | First 500 chars of every agent response — makes content quality evaluable from logs alone (hallucination, wrong tone, asking instead of asserting) |
| `[CLASSIFIER]` | `runtime/pm-gap-classifier.ts` | PM gap count, architect item count, design item count + first 100 chars of each |
| `[PATCHER]` | `runtime/spec-patcher.ts` | Existing spec size or "initial save", output size and section count |
| `[ESCALATION-GATE]` | `interfaces/slack/handlers/message.ts` | Architect upstream audit result (`ARCHITECT_UPSTREAM_PM_RUBRIC`), finding count — injected as informational context (not blocking) |

This is observability infrastructure — no behavioral change. Every log line corresponds to a decision that previously required a screenshot or Slack test to diagnose.

### Agent tool-use loop (Step 13)

All spec-producing agents (PM, design, architect) use the Anthropic native tool-use API instead of the former hand-rolled text-block protocol. `runAgent()` in `runtime/claude-client.ts` is a tool-use loop:

1. Call `messages.create` with the agent's declared tool schemas
2. If `stop_reason === "tool_use"`: execute the platform `toolHandler` for each `tool_use` content block, inject `tool_result` messages, loop
3. If `stop_reason === "end_turn"`: return the final text response

Tool results carry structured data (spec URL, preview URL, brand drifts) back to the agent. The agent interprets results and either calls another tool or produces a final text response. No regex parsing, no PLATFORM OVERRIDE injection.

**Write gate (P0):** When a design draft exists with open action items and fix intent is NOT confirmed, spec-writing tools are physically removed from the agent's tool list. The agent runs read-only — it can analyze, recommend, and escalate, but cannot modify the spec. This prevents unauthorized changes when the user's message is misinterpreted as a general instruction (e.g., "approving fixes for 2, 3, 5 and 8" bypassed fix intent detection, agent modified 20+ elements). Regression test N65 verifies the gate.

**Persistent render ambiguity cache:** Render ambiguity audit results (from Haiku `auditSpecRenderAmbiguity`) are persisted to the design branch as `{feature}.design-audit.json`, keyed by spec fingerprint. Same spec version = same findings, always — survives bot restarts, shared across users. The LLM runs once per spec version; all subsequent queries read from the persisted cache. Eliminates the non-deterministic count fluctuation (18→19→20→22) that made convergence impossible to track.

**Audit-stripping gate (P0):** All tool responses pass through `stripAuditFromToolResult` before reaching the agent. This runtime gate removes keys in `AGENT_STRIPPED_KEYS` (`renderAmbiguities`, `qualityIssues`) — audit findings that are meant for the user's action menu, not for the agent to act on. Without this gate, the agent treats audit findings as work to do and calls `apply_design_spec_patch` again, creating a divergent loop (each patch creates new ambiguities → more patches → spec oscillates). The gate is structural: even if a future code change adds audit data to the tool response, it is stripped before the agent sees it.

**Removed by this migration:**
- Text-block output parsers: `DRAFT_SPEC_START/END`, `DESIGN_PATCH_START/END`, `ENGINEERING_PATCH_START/END`, `PREVIEW_ONLY_START/END`, `INTENT: *`
- Haiku classifiers: `detectRenderIntent`, `detectConfirmationOfDecision`
- PLATFORM OVERRIDE injection in `message.ts`
- Truncation retry loops

**Post-response uncommitted decisions audit (design agent only):** After every design agent turn where no save tool was called, the platform calls `identifyUncommittedDecisions` on the 2-message current turn (user message + agent response). If the Haiku finds decisions the user actively agreed to that are not in the committed spec, the platform appends a "save those" note to the Slack response. Not cached (caching per thread_ts caused stale results across turns). Haiku prompt counts only agreed decisions — not proposed options, unanswered questions, or clarifying exchanges.

**PM-gap escalation cascade (design agent, four gates):** After the design agent responds, `message.ts` runs four gates in sequence to catch PM-scope gaps that require escalation, regardless of how the agent expresses them:

1. **Pre-run structural gate** — `auditPhaseCompletion(buildDesignRubric(...))` criterion 10 runs before the agent; if FINDING lines contain `[type: product] [blocking: yes]`, `offer_pm_escalation` is called before the agent even runs.
2. **N18 gate** — post-run: if criterion 10 FINDING lines exist in the readiness audit result, `offer_pm_escalation` is auto-triggered.
3. **Fallback prose gate** — `extractPmEscalationFromAgentResponse`: detects numbered PM-gap lists with "say yes", "bring the PM", "want me to escalate to PM", or "cannot move forward" patterns; sets `pendingEscalation` without tool call.
4. **Haiku classifier** (`runtime/pm-gap-classifier.ts`) — final safety net; sends agent response to Haiku with a focused system prompt that classifies each item into one of three categories. **PM identity framing:** the PM owns the WHAT (customer journey, user delight, retention, revenue) — never the HOW. **Three-way classification:** `GAP:` (PM-scope — undefined user-facing behavior, missing error experiences, scope decisions, qualitative criteria requiring measurable definitions), `DESIGN:` (design-scope — visual/UX decisions the designer owns independently: element type, placement, animation timing, visual treatment, layout), `ARCH:` (architecture-scope — technical implementation: schema, mechanism, data model, API, state machine). Returns one classified line per item, or `NONE`. Returns `{ gaps[], designItems[], architectItems[] }`. **Gates 2 and 3 also filter through this classifier before storing** — so non-PM items are stripped regardless of which gate fires.

**Zero-PM-gap rejection (Gates 2 and 3):** If the classifier returns 0 PM-scope gaps, the platform rejects the escalation. Gate 2 (tool call): if `designItems` are present, returns them to the agent as a numbered self-resolution list ("resolve these design decisions yourself: [list]") — no `pendingEscalation` stored, no PM involved. If only `architectItems` with no design items: returns `REJECTED` directing agent to route to architect. Gate 3 (prose): suppresses without storing. This prevents visual/UX decisions and architecture questions from incorrectly reaching the PM. Real case Apr 2026: design agent raised "exact element type", "placement", "animation timing" as PM gaps — all DESIGN: scope, designer owns them.

**Gate 2 architect-scope pre-seeding:** When Gate 2's Haiku classifier identifies `ARCH:` items (architect-scope) in an `offer_pm_escalation` call, those items are written to the engineering spec draft as `[open: architecture] <question>` entries via `preseedEngineeringSpec` (`runtime/github-client.ts`). The draft is created on the `spec/{feature}-engineering` branch if it doesn't exist. This is a silent platform action — no user-facing message. The architect encounters these pre-seeded questions when the engineering phase begins. Real incident Apr 2026: design agent raised 3 blocking gaps; classifier correctly identified 2 as architect-scope (session storage, conversation data fields) but they were silently dropped. Fix: classifier now returns `architectItems[]` alongside `gaps[]` and `designItems[]`, and Gate 2 pre-seeds architect items.

**Architect upstream escalation:** When the architect discovers an implementation constraint that requires a previously locked design or product spec to be revised, the `offer_upstream_revision(question, targetAgent)` tool is available (targetAgent: `"pm"` | `"design"`). The platform's `confirmedAgent === "architect"` routing block handles the full escalation lifecycle — mirrors the design agent's PM escalation flow exactly: pending escalation confirmation, hold reminder, and escalation-notification reply resume. On user "yes": platform runs the appropriate agent (design or PM agent) with a constraint brief, @mentions the human reviewer, and stores an `EscalationNotification` with `originAgent: "architect"`. On reply: architect resumes with the upstream revision injected. This closes the feedback loop: architect-scope items don't block design, but if an implementation constraint invalidates a locked upstream decision, the architect can escalate UP to the designer or PM at engineering time.

**Escalation stops the turn (2026-04-22):** Two-layer enforcement prevents the architect from writing spec content in the same turn as an escalation. Layer 1 (tool handler): `ArchitectToolState.escalationFired` flag is set synchronously when `offer_upstream_revision` fires. All subsequent `save_engineering_spec_draft`, `apply_engineering_spec_patch`, and `finalize_engineering_spec` calls in the same `runAgent` invocation return an error. Layer 2 (loop stop): `runAgent` accepts `forceStopToolNames: string[]`. After any tool batch containing a matching tool name, the loop sets `forceStopFired = true` — the next iteration strips tools from the API request, forcing the model to produce `end_turn`. The architect wraps up its response (acknowledging the escalation) without making further tool calls.

**Decision review gate (2026-04-22):** `detectResolvedQuestions()` in `runtime/tool-handlers.ts` compares `extractAllOpenQuestions(existingDraft)` against `extractAllOpenQuestions(newContent)`. Questions present in the old draft but absent in the new content are resolved decisions. When any questions are resolved, the spec content is NOT saved — it is held in `ArchitectToolState.pendingDecisionReview`. After the agent run completes, `message.ts` stores the review in `PendingDecisionReview` (conversation-store) and appends a structured CTA listing each resolved question. User confirms → content saved to draft branch. User objects → content discarded, architect continues. First saves (no existing draft) always pass through without review — there is nothing to diff against.

When any gate sets `pendingEscalation` this turn (`escalationJustOffered`): (a) the platform overrides passive prose with assertive CTA ("Design cannot move forward. Say *yes*..."), and (b) the action menu is suppressed. The only exit from pending-escalation state is user affirmation ("yes") → PM @mentioned, escalation cleared.

`clearPendingEscalation` is called **after** the @mention `postMessage` succeeds — not before the agent runs. This ensures a network failure or agent refusal does not silently drop the escalation state, which would force the design agent to rediscover gaps (potentially finding fewer or incorrect ones) on the next turn.

`PendingEscalation` carries `productSpec?: string` — the approved product spec content stored at gate call time (when `context.approvedProductSpec` is in scope). When the user confirms ("yes"), the PM brief includes the spec inline as `APPROVED PRODUCT SPEC`. This is the primary path. Secondary fallback: `loadAgentContext` now tries the draft branch (`spec/{feature}-product`) first, then falls back to main if the draft branch 404s — so even if `pendingEscalation.productSpec` is absent (e.g., state restored from disk without the field), the PM agent still loads the approved spec from main.

**Escalation notification reply routing:** After the PM/Architect is @mentioned, `setEscalationNotification(featureName, { targetAgent, question, recommendations? })` is stored — including the PM/Architect agent's full response text (`recommendations`) so the platform can write confirmed decisions back to the product spec. On the next message in the thread, if an `EscalationNotification` is active, **any reply** is treated as the PM/Architect answer — userId matching is intentionally skipped. The PM was explicitly @mentioned; whoever replies next is the intended responder. A silent userId mismatch (`SLACK_PM_USER` env var wrong) would otherwise cause the notification to be swallowed every time, re-triggering the same escalation instead of resuming design. The platform injects `"PM answered the blocking question: '...' → '...'. Resume design with this answer — the PM gap is now closed. Begin your response by listing each recommendation you are applying..."` into the design agent, which then continues from the answered state.

**Escalation writeback routing (2026-04-13):** When `escalationNotification.recommendations` is set, the platform routes the writeback by `targetAgent`: if `isArchitectEscalation` (`targetAgent === "architect"`), `patchEngineeringSpecWithDecision` (`runtime/engineering-spec-decision-writer.ts`) writes the decision to the engineering spec draft under `## Pre-Engineering Architectural Decisions` — no Haiku, raw append. If `targetAgent === "pm"`, `patchProductSpecWithRecommendations` runs as described below. This routing fix applies to both code paths: design-originated architect escalation (standalone confirmation) and architect upstream reply (N43 path). Previously both wrote to the product spec unconditionally — the root cause of architect decisions being lost.

**Phase-transition history clearing (2026-04-20):** When `setConfirmedAgent` detects a phase transition (agent changes from one value to another), it clears all conversation history for that feature. The incoming agent has all approved specs loaded from GitHub in its system prompt — raw prior-phase conversation is noise that causes hallucination ("I see from earlier conversations that X was discussed but not committed"). Platform-level mechanism: applies to all current and future agents automatically. Combined with the orientation gate (first message from a userId suppresses audit notices), this ensures no agent inherits stale discussion state from a prior phase.

**Phase handoff seeding (2026-04-13):** `seedHandoffSection` and `clearHandoffSection` in `runtime/github-client.ts` drive all phase transitions. `finalize_design_spec` calls `seedHandoffSection` (non-blocking) to write `## Design Assumptions To Validate` into the engineering spec draft. `finalize_engineering_spec` calls `clearHandoffSection` (non-blocking) to empty `## Design Assumptions` in the approved design spec on main after all assumptions are confirmed. `finalize_engineering_spec` also runs a structural pre-save blocking gate: if `extractHandoffSection(draft, "## Design Assumptions To Validate")` is non-empty, finalization is blocked — architect must confirm or escalate each assumption before engineering is approved.

**Finalization gate (2026-04-13):** All three `finalize_*` handlers now use `extractAllOpenQuestions` (from `runtime/spec-utils.ts`) instead of `extractBlockingQuestions`. `extractAllOpenQuestions` returns both `[blocking: yes]` and `[blocking: no]` lines from `## Open Questions`. Any open question — blocking or not — prevents spec approval. The design and engineering rubric criteria (11 and 6 respectively) also verify this at audit time.

**Product spec writeback on escalation confirmation (PM path):** When `escalationNotification.recommendations` is set and `targetAgent !== "architect"`, `patchProductSpecWithRecommendations` (`runtime/pm-escalation-spec-writer.ts`) runs before the design agent resumes. It reads the approved product spec from main, calls Haiku to generate a targeted patch, applies the patch with `applySpecPatch`, and saves back to main via `saveApprovedSpec`. `max_tokens: 4096` — bumped from 1024 to prevent silent truncation when many recommendations are applied in one round. The Haiku patch prompt enforces nine rules: (1) REPLACE vague criteria in-place; (2) keep all existing concrete criteria; (3) STRIP visual/design details AND UI copy; (4) add new concrete criteria for gaps not previously in the spec; (5) route to correct sections; (6) RESOLVE contradictions; (7) COMPLETE or REMOVE incomplete criteria; (8) HYGIENE PASS; (9) output complete section body. **Post-patch visual detail audit (structural gate, not prompt-based):** After `applySpecPatch` generates the merged spec, `hasVisualDetails()` scans all criteria lines against `VISUAL_DETAIL_PATTERNS` (opacity %, animation ms/s, hex colors, rgba, radial gradient details, easing functions). If any match, `stripVisualDetailsFromSpec()` runs a second focused Haiku pass to remove them before `saveApprovedSpec`. This is defense-in-depth: the Haiku patch prompt already instructs stripping (Rule 3) but can miss cases; the structural scan catches any that slip through. Real incident Apr 2026: Haiku wrote "opacity cycling 25%→35%→25% over 2.5 seconds" into a PM spec criterion despite Rule 3.

**Subsection-aware patcher (2026-04-14):** `applySpecPatch` (`runtime/spec-patcher.ts`) now merges at `###` subsection level when both the existing `##` section and the patch `##` section contain `###` headings. Previously, a patch of `## Screens\n### Screen 2: Auth Sheet\n[content]` replaced the entire `## Screens` section body with only Screen 2's content, wiping all other screens. Root cause: split function only recognized `##` as section boundaries. Fix: `mergeSubsections()` recursively applies the same merge logic at `###` level when both sides have subsections — only named `###` sections in the patch are updated; all sibling `###` sections are preserved. New `###` subsections in the patch are appended. Flat `##` sections (no `###` subsections in either side) still replace wholesale as before. Real incident Apr 2026: fix-all loop applied 9 patches to the design spec, each replacing the `## Screens` section with only the one screen addressed in that patch. Spec went from 36,831 → 14,435 chars (lost ~60% of content).

**`auditSpecRenderAmbiguity` JSON parse fix (2026-04-14):** LLM sometimes wraps its JSON array output in markdown code fences (` ```json ... ``` `). The prior parse logic failed to strip fences, tried a repair regex, but the non-greedy `[\s\S]*?` match failed to capture the full array. Result: all quality audits silently returned empty findings. Fix: strip code fences from LLM output before JSON.parse; use greedy `[\s\S]*` in the repair regex so the full array is captured. This was causing false-positive "Fixed all N items" completions in the fix-all loop — quality issues were invisible.

**`auditSpecRenderAmbiguity` max_tokens fix (2026-04-15):** `max_tokens: 500` caused JSON truncation on specs > ~10k chars — Haiku truncated mid-array, causing `JSON parse failed` errors and silent empty results. Real incident: 7 consecutive parse failures in live logs (`Unterminated string in JSON at position 2088`) when spec grew to 48k chars. Fix: `max_tokens: 2048` in `runtime/spec-auditor.ts`. Producer test added: asserts `max_tokens >= 2048` on every `auditSpecRenderAmbiguity` call. **Second incident (2026-04-15):** spec grew to 48k chars; Haiku output truncated at 8547 chars with `Unterminated string in JSON at position 8547` — 2048 tokens still insufficient for large specs. Fix: `max_tokens: 4096`. Producer test updated to assert `>= 4096`.

**Platform status line suppression fix (2026-04-15):** `escalationJustOffered=true` (set for both PM and arch escalations) gated the platform status line — design agent could offer an architect escalation then claim "engineering-ready" while rubric findings remained. Root cause: the suppression logic treated PM and arch escalations identically. PM escalations correctly suppress the status line (user cannot act while PM gap is open). Arch escalations must NOT suppress it — the user can still proceed with other items and the platform must show what remains. Fix: `escalationJustOfferedPm = escalationJustOffered && pendingEscalation?.targetAgent === "pm"` — status line only suppressed for PM path. N56 integration scenario added: arch escalation → status line shown; PM escalation (Gate 2 accepts) → status line suppressed.

**Fix intent detection — fast path + Haiku fallback (2026-04-15):** `parseFixAllIntent` (keyword match, no API cost) is the primary path for "fix all" and "fix 1 3". When fast path doesn't match but the message contains "fix" or "apply" (pre-filter), `classifyFixIntent` (`runtime/fix-intent-classifier.ts`) runs as a Haiku fallback — classifies natural English fix requests ("go ahead and fix all of these", "apply all the fixes") into `FIX-ALL`, `FIX-ITEMS: 1,3,5`, or `NOT-FIX`. Safe default: Haiku error or unexpected output → `NOT-FIX` (never accidentally enters the platform fix loop). Pre-filter excludes words like "update" and "resolve" that appear in platform-generated briefs — only "fix" and "apply" are unambiguous signals. Once intent is detected (by either path), the platform-controlled loop is identical: item list from pre-run audit, agent runs, re-audit from fresh GitHub read, platform composes final message.

**Arch escalation Gate (2026-04-15):** `classifyForArchGap` (`runtime/arch-gap-classifier.ts`) runs inside the `offer_architect_escalation` tool handler on every call from the design agent. The test: "Would the UI look or behave differently depending on the answer?" ARCH-GAP → escalation accepted, `setPendingEscalation` called, existing flow proceeds. DESIGN-ASSUMPTION → escalation rejected, tool returns structured rejection message directing agent to add a `## Design Assumptions` entry instead; `setPendingEscalation` is never called. Identical pattern to Gate 2 (`classifyForPmGaps`) for PM escalations. Real incident Apr 2026: design agent escalated "how are logged-out conversations stored — client-side or server-side?" to the architect. UI is identical regardless of storage mechanism. Gate now deterministically rejects this class. Safe default: unexpected Haiku output → "ARCH-GAP" (do not block valid escalations). Token budget: `max_tokens: 32` (single-keyword response). N57 integration test covers rejection path; Scenario 18 Turn 1 updated to use genuine ARCH-GAP question. Also fixed: pending-escalation-hold message hardcoded "PM" regardless of `targetAgent` — now routes to correct agent label.

**Deterministic audit layer (Principle 11, 2026-04-22):** `runtime/deterministic-auditor.ts` — pure-function auditors that replace `auditPhaseCompletion` as the primary gate for all readiness checks. `auditPmSpec` (open questions, vague language, timing, errors, deferrals, non-goals), `auditPmDesignReadiness` (extends PM with broader vague scan + loading states), `auditDesignSpec` (open questions, TBD markers, vague language, animation timing/easing, form factor coverage, missing copy), `auditEngineeringSpec` (open questions, API contracts, endpoint auth, data model fields, migration strategy), `detectHedgeLanguage` (universal deferral phrase detection). Every function is `@deterministic`: same input → same output, always. No LLM calls. Wired at all 5 `auditPhaseCompletion` call sites in `message.ts`: deterministic findings are the floor, LLM rubric runs in parallel as `@enrichment` (additive findings only, never the sole gate). Deduplication: LLM findings that overlap a deterministic finding (first 40 chars match) are dropped. Hedge detection wired as post-run gate for architect. 31 unit tests with determinism contract (each audit run twice, results asserted identical).

**`auditSpecDraft` cross-spec context (2026-04-22):** `runtime/spec-auditor.ts` `auditSpecDraft` accepts optional `productSpec` parameter — the approved PM spec for the feature. When provided, Haiku checks whether flagged gaps are already covered in the PM spec before reporting them. `loadArchitectAgentContext` now returns `approvedProductSpec` as a separate field (previously only embedded in `currentDraft`). All architect save/patch call sites and the design state query path pass `productSpec` to prevent false positives on items the PM spec explicitly covers.

**Extracted tool handlers** | `runtime/tool-handlers.ts` | All three agent tool handlers (PM, Design, Architect) extracted from `message.ts` closures into standalone functions with typed context (`ToolHandlerContext`) and injected dependencies (`PmToolDeps`, `DesignToolDeps`, `ArchitectToolDeps`). Each handler is independently unit-testable without E2E routing ceremony. The dispatch functions (`handlePmTool`, `handleDesignTool`, `handleArchitectTool`) are drop-in replacements wired in `message.ts`. Design handler uses `DesignToolState` (mutable ref object) to propagate `patchAppliedThisTurn` and `lastGeneratedPreviewHtml` back to the caller. Architect handler uses `ArchitectToolState` (mutable ref object) with `escalationFired` (blocks spec saves after `offer_upstream_revision`) and `pendingDecisionReview` (holds spec content when open questions are resolved, pending human confirmation). Slack file upload abstracted via `SlackFileUploader` adapter. Pattern: all future agents follow the same extraction — handler logic in `tool-handlers.ts`, wiring in `message.ts`. | None (pure refactor — no behavioral change) |

**`auditSpecRenderAmbiguity` token budget:** uses `max_tokens: 8192` (Haiku's maximum) with a ≤25 word brevity cap per finding. The previous 4096-token limit caused JSON truncation when a spec had 26+ findings (~3900+ chars of output), silently returning an empty quality section. The brevity cap ensures output stays well within budget even at maximum finding count.

**Gate 2/3/4 classifier token budget:** `classifyForPmGaps` uses `max_tokens: 1024` — sufficient for up to ~20 classified items without truncation. The previous 512-token limit caused the last `GAP:` line to be cut mid-sentence when 6+ items were classified in one pass, producing a truncated `pending.question` in Slack.

**Gate 2/3/4 classifier approved-spec cross-reference rule:** `classifyForPmGaps` system prompt now includes a CRITICAL RULE: read the approved PM spec before classifying anything. If a question is already explicitly answered in the approved PM spec, classify it as DESIGN (the designer should read the spec) — not GAP:. Real incident Apr 2026: session expiry duration (AC#23: 60 min inactivity, AC#8: 10-min warning) was explicitly in the approved PM spec, but Gate 4 still returned GAP: because the classifier had no instruction to cross-reference it. Root cause: PM spec was provided as context but the prompt never said "check if it's already answered there." Fix: CRITICAL RULE added at the top of the classifier's PM-scope section.

**Gate 2 classifier visual-contradiction rule:** `classifyForPmGaps` (`runtime/pm-gap-classifier.ts`) system prompt explicitly addresses the spec-contradiction pattern: if a question asks which value is correct when PM spec and design spec have different animation durations, opacity values, or other visual/technical details, it is ALWAYS classified as DESIGN-scope — never PM-scope. The PM spec should never contain specific visual values; any that appear there are mistakes the designer resolves independently. Real incident Apr 2026: design agent asked "PM spec says 25%→35% opacity over 2.5s, design spec says 50-100% over 4s — which is right?" — classifier saw "PM spec" and incorrectly returned GAP: instead of DESIGN:.

**PM spec draft sanitizer (2026-04-14):** `sanitizePmSpecDraft` (`runtime/pm-spec-sanitizer.ts`) runs at every PM spec save point — both `save_product_spec_draft` and `apply_product_spec_patch` tool handlers — before writing to GitHub. It strips two classes of content that must never appear in a PM spec: (1) **Design-scope sections** — entire `##` sections whose headings match `DESIGN_SCOPE_HEADING_PREFIXES` (prefix-matched, case-insensitive): `## Design Direction`, `## Design Language`, `## Color Palette`, `## Animation`, `## Visual Design`, `## Typography`, `## Layout`, `## UI Design`, `## Branding`, `## Component`, and others. A section runs from its `##` heading to the next `##` heading or EOF. Stripped section headings are logged and reported in `SanitizeResult.strippedSections`. (2) **Cross-domain open questions** — lines in `## Open Questions` that contain `[type: engineering]` or `[type: design]`. PM spec open questions must be `[type: product]` only; engineering and design questions belong in their respective specs and should be routed via escalation tools, not written to the PM spec. Stripped lines are logged and reported in `SanitizeResult.strippedOpenQuestions`. After stripping, multiple consecutive blank lines are collapsed to a single blank line. Returns `SanitizeResult { content, wasModified, strippedSections, strippedOpenQuestions }`. Real incident Apr 2026: PM agent wrote an entire `## Design Direction` section with hex colors (`#0A0E27`), opacity cycles (`25%→35%→25% over 2.5s`), and cubic bezier values directly into a PM product spec. Root cause: no domain validation at the save layer. Platform fix: structural sanitization gate that cannot be bypassed regardless of what the PM agent writes.

### Proactive constraint audit pattern

Every agent in the platform runs a deterministic audit for its domain-specific constraints on every response. This is not prompt-based — it is platform-enforced, pure code, no API call.

The principle: **the specialist surfaces all violations proactively**. The human cannot be expected to know what constraint to check or what question to ask. If a violation must be reported, it must be reported on every response, unconditionally.

| Audit | File | What it checks | Model |
|---|---|---|---|
| Spec conflict + gap | `runtime/spec-auditor.ts` → `auditSpecDraft()` | Vision conflicts, architecture gaps | Haiku (runs post-draft-save) |
| Render ambiguity (save-time) | `runtime/spec-auditor.ts` → `auditSpecRenderAmbiguity()` | Two-stage: (1) deterministic pre-filter — screens referenced in User Flows but missing from Screens section; (2) Haiku — vague elements: undefined text, relative-only positioning, no sheet entry direction/animation timing, TBD copy, unnamed states without visual descriptions, conflicting values, vague measurement language | Deterministic + Haiku (runs post-draft-save; design agent must resolve all before next response) |
| **Phase completion gate — PM** | `runtime/deterministic-auditor.ts` → `auditPmSpec()` (primary); `runtime/phase-completion-auditor.ts` → `auditPhaseCompletion(PM_RUBRIC)` (@enrichment) | **Primary (deterministic):** open questions, vague language, timing gaps, missing error paths, deferral markers, non-goals. **Enrichment (Sonnet):** Criterion 1: enumerate each user story by number, verify each individually has an explicit failure/error path — one FINDING per uncovered story (sharpened 2026-04-20 after US-2 false-negative). Remaining criteria: acceptance criteria are measurable, zero unresolved blocking questions, data requirements explicit, no architectural contradictions, Non-Goals names a scope boundary. Enrichment findings deduplicated against deterministic floor. | **Deterministic primary** + Sonnet @enrichment (runs on approval intent, before `finalize_product_spec`) |
| **PM design-readiness gate** | `runtime/phase-completion-auditor.ts` → `auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC)` + `auditDownstreamReadiness({ downstreamRole: "designer" })` inside `finalize_product_spec` handler, run in parallel | Two-layer gate running in parallel at finalization: (1) **Rubric layer** — 5 fixed criteria: VAGUE LANGUAGE (sensory descriptors, missing thresholds, underspecified error UI); INTERACTION COMPLETENESS (every tappable element defines tap behavior); ERROR AND FAILURE RECOVERY (every failure mode has a recovery path); UI MODALITY AND PLACEMENT (modality, dismissibility, persistence); LOADING AND TRANSITION STATES (every async operation defines loading treatment). (2) **Adversarial layer** — `auditDownstreamReadiness` uses an open-ended Sonnet prompt: "You are a senior UX designer — list every decision you'd have to invent from this spec." No enumerated criteria — catches novel gap classes that no rubric can anticipate. Both layers must return zero findings for finalization to proceed. Combined findings list is returned to PM agent. Added after third production incident (2026-04-13) where rubric enumeration ceiling was reached — same 6 gaps recurred despite 5-criterion rubric. | **Sonnet** (two parallel calls inside `finalize_product_spec` handler; blocks save if any findings from either) |
| **Post-patch adversarial gate (PM escalation)** | `runtime/phase-completion-auditor.ts` → `auditDownstreamReadiness({ downstreamRole: "designer" })` run after `patchProductSpecWithRecommendations` returns patched spec content in PM one-step escalation path (`message.ts`) | After PM patches the product spec via escalation, platform runs an adversarial audit on the patched content before resuming design. If remaining gaps are found (designer would have to invent decisions), sets new `pendingEscalation` with ALL remaining gaps and does NOT resume design — surfaces all gaps in one PM round instead of iteratively through the design agent. Eliminates "one gap per PM escalation" loop. | **Sonnet** (one call inside PM one-step escalation path; blocks design resume if any findings; skipped non-blocking if patch failed) |
| **Design architect-readiness gate** | `runtime/phase-completion-auditor.ts` → `auditDownstreamReadiness({ downstreamRole: "architect" })` run in parallel with `auditSpecDecisions` inside `finalize_design_spec` handler | Adversarial open-ended audit: "You are a senior software architect — list every decision you'd have to invent from this design spec." Same pattern as PM gate: no rubric enumeration ceiling. Runs in parallel with `auditSpecDecisions` — blocks save if any findings. Symmetric with PM gate. | **Sonnet** (one parallel call inside `finalize_design_spec` handler; blocks save if any findings) |
| **Engineering build-readiness gate** | `runtime/phase-completion-auditor.ts` → `auditDownstreamReadiness({ downstreamRole: "engineer" })` run in parallel with `auditSpecDecisions` inside `finalize_engineering_spec` handler | Adversarial open-ended audit: "You are an engineer implementing this feature — list every decision you'd have to invent from this engineering spec." Runs in parallel with `auditSpecDecisions` — blocks save if any findings. Completes the three-phase adversarial coverage: PM→Design, Design→Architect, Architect→Build. | **Sonnet** (one parallel call inside `finalize_engineering_spec` handler; blocks save if any findings) |
| **Phase completion gate — Design** | `runtime/deterministic-auditor.ts` → `auditDesignSpec()` (primary); `runtime/phase-completion-auditor.ts` → `auditPhaseCompletion(DESIGN_RUBRIC)` (@enrichment) | **Primary (deterministic):** open questions, TBD markers, vague language, animation timing/easing, form factor coverage, missing copy. **Enrichment (Sonnet):** All screens defined with all states, all UI copy verbatim, all animations with timing+easing, no conflicting values, no vague language, brand token consistency, no TBD/TODO/PLACEHOLDER, no unresolved product assumptions or PM spec vagueness (criterion 10 two-part: PART A catches design decisions that assume product answers not in the PM spec; PART B scans the PM spec itself for requirements too vague to design against — e.g. "handle gracefully", "preserve conversations" — and flags them when the design spec also lacks a specific implementation; receives `productVision`, `systemArchitecture`, AND `approvedProductSpec` as context). Enrichment findings deduplicated against deterministic floor. | **Deterministic primary** + Sonnet @enrichment (runs on approval intent, before `finalize_design_spec`) |
| **Phase entry upstream audit — Design** | `message.ts` → `auditPmDesignReadiness()` (primary) + `auditPhaseCompletion(PM_RUBRIC)` (@enrichment) on approved PM spec | **Primary (deterministic):** open questions, vague language, loading/async states. **Enrichment (Sonnet):** PM spec gaps that would propagate into design (same PM_RUBRIC criteria). Deterministic findings are the floor; enrichment adds semantic gaps. | **Deterministic primary** + Sonnet @enrichment (runs on every design agent message; content-addressed cache; result injected as PLATFORM UPSTREAM SPEC AUDIT notice) |
| **Phase entry upstream audit — Architect (informational, not blocking)** | `message.ts` → `auditPmSpec()` + `auditDesignSpec()` (primary) + `auditPhaseCompletion(ARCHITECT_UPSTREAM_PM_RUBRIC)` + `auditPhaseCompletion(buildDesignRubric(targetFormFactors))` (@enrichment) on approved upstream specs, in parallel | **Primary (deterministic):** PM spec: open questions, vague language, missing error paths, deferrals. Design spec: open questions, TBD markers, animation timing, form factors. **Enrichment (Sonnet):** PM spec: product-scope gaps — 2 criteria. Design spec: full design rubric. Data requirements, measurability, architecture consistency, non-goals are the architect's own responsibility — not escalated upstream. Findings are injected as informational context — the architect runs unconditionally and decides which gaps to escalate via `offer_upstream_revision(pm|design)` and which to handle as engineering assumptions in `## Design Assumptions To Validate`. Non-blocking gaps are enforced at the EXIT gate (`finalize_engineering_spec` blocks if unvalidated assumptions remain), not the entry gate. | **Deterministic primary** + Sonnet @enrichment (runs on every architect agent message; same content-addressed caching; combined notice injected as context if any findings) |
| **Form factor coverage** | `runtime/phase-completion-auditor.ts` → `buildDesignRubric(targetFormFactors)` criterion 9; `runtime/spec-auditor.ts` → `auditSpecRenderAmbiguity(spec, { formFactors })` | Every screen defines layout for all target form factors (mobile, desktop, etc.) — or Non-Goals explicitly excludes a form factor | Sonnet (completion gate); Haiku (save-time); design agent system prompt (proactive) — all three layers enforce the same requirement |
| Renderer text fidelity | `runtime/html-renderer.ts` → `validateTextFidelity()` | Spec-defined text literals (Heading, Tagline, etc.) appear verbatim in rendered HTML | None (pure string match) |
| Renderer structural validation | `runtime/html-renderer.ts` → `validateRenderedHtml()` | Hero present (`id="hero"`); hero must not be nested inside thread (BLOCKING); hero uses `:class` not `x-show` (BLOCKING); thread has `display:none` + `x-show` (BLOCKING); body has explicit background-color; keyframe animations present | None (pure string/regex match — no retry needed; template always produces correct structure) |
| **Always-on design phase completion audit** | `message.ts` → `auditDesignSpec()` (primary) + `auditPhaseCompletion(buildDesignRubric(targetFormFactors))` (@enrichment); `runtime/deterministic-auditor.ts` + `runtime/phase-completion-auditor.ts` | **Primary (deterministic):** open questions, TBD markers, vague language, animation timing/easing, form factor coverage, missing copy. **Enrichment (Sonnet):** full design rubric including semantic checks. Runs on every design agent message when design spec draft exists on branch. Content-addressed cache on spec fingerprint — invalidates automatically when draft is edited. Findings injected as `[INTERNAL DESIGN READINESS]` into enriched user message before agent runs. Design gaps → agent recommends fix. Product gaps → `offer_pm_escalation`. Architecture gaps → `offer_architect_escalation`. **Principle 7: no trigger phrase required.** | **Deterministic primary** + Sonnet @enrichment (runs on every message, cached per spec version) |
| **Always-on architect engineering spec completeness audit** | `message.ts` → `auditEngineeringSpec()` (primary) + `auditPhaseCompletion(ENGINEER_RUBRIC)` (@enrichment); `runtime/deterministic-auditor.ts` + `runtime/phase-completion-auditor.ts` → `ENGINEER_RUBRIC` | **Primary (deterministic):** open questions, API contracts, endpoint auth, data model fields, migration strategy. **Enrichment (Sonnet):** semantic criteria — response shape completeness, cardinality coverage, cross-section consistency. Runs on every architect agent message when engineering spec draft exists on branch. Content-addressed cache on engineering spec fingerprint. Findings injected as `[INTERNAL ENGINEERING READINESS]` into enriched user message. **Principle 7: no trigger phrase required.** | **Deterministic primary** + Sonnet @enrichment (runs on every message, cached per spec version) |
| Design escalation triage | `agents/design.ts` → `DESIGN_TOOLS` (`offer_pm_escalation` + `offer_architect_escalation`); `runtime/conversation-store.ts` → `PendingEscalation.targetAgent: "pm" \| "architect"` — `setPendingEscalation` normalizes inline numbered items (e.g. `"1. gap 2. gap"`) to newline-separated before storing, so Slack renders each gap on its own line; `EscalationNotification` (post-confirmation store); `interfaces/slack/app.ts` → `userId` extracted and passed | Product behavior questions → PM. Architecture/data design questions → Architect. Visual definition gaps agent can resolve → agent owns it with a concrete proposal. **Platform enforcement for product gaps (root cause fix 2026-04-13):** Design spec open questions must only be `[type: design]` — product-scope questions are architecturally prohibited from the spec. `buildDesignRubric` criterion 10 outputs `[PM-GAP]` prefix findings — a rubric-level tag only, never written to the design spec. Post-run gate: if `designReadinessFindings` contains `[PM-GAP]` findings after the agent runs and the agent did not call `offer_pm_escalation`, platform auto-triggers escalation. `extractProductBlockingQuestions()` and `clearProductBlockingMarkersFromDesignSpec()` deleted — they were symptom fixes for a root cause that is now eliminated at the source. **Escalation reply auto-routing:** after the user confirms and the @mention is posted, `setEscalationNotification` tracks the open question. When the PM/Architect replies in the same thread (detected by `userId === roles.pmUser/architectUser`), the platform clears the notification and injects `"PM answered: [question] → [answer]"` as the design agent's user message, resuming design automatically. | None (post-run: rubric LLM output tagging via `[PM-GAP]`; reply routing: userId match) |
| Render ambiguity + design quality audit | `runtime/spec-auditor.ts` → `auditSpecRenderAmbiguity()` | **4-pass pipeline:** (1) deterministic undefined screen references; (2) `auditCopyCompleteness()` — TBD markers + narrative punctuation; (3) `auditRedundantBranding()` — auth heading repeating nav wordmark; (4) Haiku semantic pass — structural ambiguity (chip anchor, SSO layout, vague language) + design quality (scrollable rows without scrollbar treatment, dynamic lists without empty state, touch targets unspecified, copy redundancy). All findings block — agent must patch before proceeding. **Principle 7: runs on every save, no trigger required.** | Haiku (one call, passes 1–3 results in; returns merged array) |
| **Redundant branding audit** | `runtime/spec-auditor.ts` → `auditRedundantBranding()` | Auth heading repeats the app name already shown in the nav wordmark — redundant in context; flag with concrete replacement recommendation. | None (pure string match — `includes()` on wordmark vs all `Heading: "..."` occurrences) |
| **State response quality gate** | `agents/design.ts` → `buildDesignStateResponse({ qualityIssues })` + state query path in `message.ts` | Full `auditSpecRenderAmbiguity()` (4-pass) runs on every state query — replaces the two prior separate deterministic calls. SPEC section shows only bold summary statements from Design Direction (not raw bullet lists) to stay within Slack's 4000-char limit and surface crisper content. CTA priority: uncommitted > drift > quality > blocking — approval blocked until all clear. | Haiku (one call via `auditSpecRenderAmbiguity`) |
| **Copy completeness audit** | `runtime/spec-auditor.ts` → `auditCopyCompleteness()` | (1) All quoted strings: no `[TBD]`/`[placeholder]` bracket patterns. (2) Narrative role strings only (`tagline`, `subheading`, `description`, `slogan`, `hero text`, `nudge text`): must end with terminal punctuation (. ! ?). Button labels, headings, auth copy, and placeholder text are intentionally excluded. Wired into `auditSpecRenderAmbiguity()` return — blocking, same enforcement path as render ambiguity. | None (deterministic string scan — no LLM call) |
| **Structural spec audit (convergence floor)** | `runtime/spec-auditor.ts` → `auditSpecStructure()` | Deterministic structural checks: duplicate headings, conflicting pixel/token values in same section, `--error`/`--warning` token mixing, screen/flow cross-references, orphaned definitions, copy consistency. Runs on every turn (design + architect), every state query, every save, every finalization. Same input = same output always. No LLM. The convergence floor — if the LLM rubric (`auditPhaseCompletion`) disagrees, structural findings still appear. Findings tagged `[STRUCTURAL]` in action menu so user can distinguish deterministic vs LLM-generated items. | None (pure regex/parsing — zero LLM calls) |
| **Health gate (save-blocking)** | `message.ts` → `saveDesignDraft()` | Before saving to GitHub, runs `auditSpecStructure` on old and new content. If structural findings increased, blocks the save and returns error. Prevents bad specs from persisting — the health invariant previously only blocked the Slack response but the spec was already saved. | None (pure comparison) |
| **Platform-enforced finalization** | `message.ts` → approval intent detection + direct `finalize_design_spec` call | When user says "approved"/"finalize" and `auditSpecStructure` returns 0 findings, platform calls `finalize_design_spec` handler directly — no `runAgent` call, no LLM rubric that might find new items to block on. Eliminates the agent bypassing finalization by running `run_phase_completion_audit` instead. If structural findings > 0, falls through to normal agent path. | None (regex intent detection + structural check) |
| Brand color drift | `runtime/brand-auditor.ts` → `auditBrandTokens()` | Entire spec hex values vs BRAND.md (all sections, not just ## Brand) | None (pure string diff) |
| Brand animation drift | `runtime/brand-auditor.ts` → `auditAnimationTokens()` | Spec glow duration, blur, delay, opacity-min/max vs BRAND.md `## Glow` CSS section. CSS-format spec parsed with `extractBrandAnimationParams` (same parser as BRAND.md, prefixed with synthetic `## Glow` heading); prose-format fallback for older specs. | None (pure string diff) |
| Brand missing tokens | `runtime/brand-auditor.ts` → `auditMissingBrandTokens()` | Canonical BRAND.md tokens entirely absent from spec (case-insensitive). Distinct from drift — a drifted token is present with wrong value; a missing token is not referenced anywhere. | None (pure string match) |
| **Brand drift finalization gate** | `message.ts` → `finalize_design_spec` handler | `finalize_design_spec` runs `auditBrandTokens()` + `auditAnimationTokens()` on the final spec before calling `saveApprovedDesignSpec`. If any drift exists, returns an error and blocks approval. Hard gate — spec cannot be approved with incorrect brand values. | None (pure string diff) |
| **Platform-enforced structured action menu** | `message.ts` → `buildActionMenu()` (exported) | After `runDesignAgent` completes, the platform deterministically builds and appends a numbered action menu to the agent's prose response. Categories: Brand Drift, Missing Brand Tokens, Design Quality, Design Readiness Gaps. Issues are globally numbered across all categories so the user can say "fix 1 3 5" and the platform knows exactly which fixes to apply. This is structural enforcement — not a system prompt instruction — so it appears on every response that has open issues regardless of how the agent phrased its reply. Readiness findings use a dual cache (`phaseEntryAuditCache` for the formatted notice + `designReadinessFindingsCache` for the raw findings array) so the action menu is populated correctly on cache hits. FINDING fix recommendations are instructed to commit to one specific fix — no "or" alternatives — so the user always has an unambiguous action. | None (pure formatting — all audit data pre-computed before `runAgent`) |
| **Platform-controlled fix-all completion loop** | `message.ts` → `parseFixAllIntent()` + fix-all loop inside `runDesignAgent` | When the user says "fix all" (or "fix 1 2 3"), `parseFixAllIntent()` detects the intent deterministically (keyword match — platform-prescribed format, no Haiku). The platform extracts the authoritative item list from the same pre-run audit arrays that built the action menu (zero drift between display and execution). A `[PLATFORM FIX-ALL]` block is injected into the enriched user message listing every required patch. After the agent runs, the platform re-reads the spec from GitHub (fresh read, never `currentDraft` which is stale post-patch) and re-audits independently: pure audits (`auditBrandTokens`, `auditAnimationTokens`, `auditMissingBrandTokens`) + LLM audits (`auditSpecRenderAmbiguity`, `auditPhaseCompletion`). LLM audit caches naturally miss on changed spec fingerprint — no manual clearing needed. If residual items remain and count decreased (progress), the platform re-runs (up to `MAX_FIX_PASSES = 3`). No-progress → stop. **No-progress detection (2026-04-15 fix):** for "fix all" (`selectedIndices=null`), `selectedResidual = residualItems` (fresh audit list directly) — count-based comparison against `prevItemCount`. Prior implementation used exact-string matching of LLM-generated readiness issue text (`r.issue === a.issue`) which falsely signaled "progress" every pass because the auditor produces different text each call for the same conceptual finding. Result: all 3 passes ran, re-applying the same patches, then reporting misleading "Fixed N items" when rubric criteria were unchanged. Fix: text matching only applies for "fix 1,3" (`selectedIndices` set), where brand/quality text is deterministic. N59 integration scenario verifies: post-pass audit returning same count with different text → break after 1 pass. **Regression guard (2026-04-15):** `totalFixed = Math.max(0, autoFixItems.length - selectedResidual.length)` — patches that add new content can trigger additional issues, causing `residualItems.length > autoFixItems.length` and a negative `totalFixed`. Real incident: pre-run=8, post-pass=26 → "Fixed -18 of 8 items". Clamped at 0. N60 integration scenario verifies: post-pass returns 2 findings when pre-run had 1 → "Fixed 0 of 1 item" (not -1). Platform composes the final Slack message ("Fixed all N items" or "Fixed X of N — Y still need attention + action menu"). Agent prose is suppressed between passes. PM-GAP items filtered from the agent's brief, surfaced with a separate escalation offer. Fix-all path returns early — post-runAgent escalation gates do not run. `patchAppliedThisTurn` + `lastGeneratedPreviewHtml` ensure exactly one preview upload per turn even when multiple patches are applied. **Fix-all tool guard:** At top of `designToolHandler`, when `fixIntent.isFixAll`, any call to `offer_pm_escalation` or `offer_architect_escalation` is blocked — the tool returns a structured message directing the agent to only apply patches; `setPendingEscalation` is never called during fix-all passes. | `parseFixAllIntent` unit tests in `tests/unit/action-menu.test.ts`; N54 integration scenario in `tests/integration/workflows.test.ts` |
| **Post-patch continuation loop (normal turns)** | `message.ts` → `runFreshDesignAudit()` + continuation loop inside `runDesignAgent` | Extends platform-owned completion to ALL normal patch-producing turns (not just explicit "fix all"). Root cause closed: on every normal turn, the agent previously controlled the completion loop — it decided which subset of findings to address per turn (prompt-dependent). Fix: after any `apply_design_spec_patch` in a normal turn (`patchAppliedThisTurn && !readOnly`), the platform re-reads the spec from GitHub (`readFile` — fresh, not stale `currentDraft`), runs `runFreshDesignAudit()` (pure audits + `auditPhaseCompletion`), and computes `designResidual` — design items that remain excluding PM-GAP entries. If `designResidual.length > 0`, the platform runs up to 2 continuation passes: injects a `[PLATFORM CONTINUATION]` block, runs `runAgent` again, re-reads and re-audits after each pass. Loop terminates when clean audit or no-progress (`designResidual.length >= prevCount`). PM-GAP items are filtered out of `designResidual` (those surface through Gate 2 escalation). After the loop, `effectiveBrandDrifts`, `effectiveAnimDrifts`, `effectiveMissingTokens`, `effectiveDeterministicQuality`, `effectiveReadinessFindings` are updated to the post-patch fresh state — stale pre-run data is never surfaced downstream. `designReadinessFindings` is reassigned from `effectiveReadinessFindings` so Gate 2 reads post-patch PM-GAP state. `clearPhaseAuditCaches()` exported for test isolation (not called in production). | N55 integration scenario (2 tests) in `tests/integration/workflows.test.ts` |
| **Post-patch spec health invariant** | `message.ts` → arithmetic comparison after continuation loop | After the continuation loop completes, the platform compares the pre-run spec size (`designDraftContent.length`, captured at load time before the agent runs) against the post-run size (`freshDraft.length`). Pre-run finding count is captured before the continuation loop starts (before `effectiveReadinessFindings` overwrites `designReadinessFindings`). If spec grew beyond `maxAllowedSpecGrowthRatio` (from `WorkspaceConfig`, env var `MAX_ALLOWED_SPEC_GROWTH_RATIO`, default 1.2 = 20%) OR finding count increased, the platform surfaces a human-friendly bloat/degradation warning and returns early — no preview upload, no action menu. Pure arithmetic — no LLM call. Fires on every patch turn regardless of user phrasing (Principle 8). The human never has to discover spec degradation — the platform catches and reports it immediately. | N61 integration scenario in `tests/integration/workflows.test.ts` |
| **`rewrite_design_spec` tool** | `agents/design.ts` tool definition + `message.ts` handler → `saveDesignDraft(content)` | Replaces the entire design spec content in one operation. Use ONLY for structural cleanup: removing duplicate sections, consolidating conflicting definitions, resolving sections defined twice. Distinct from `apply_design_spec_patch` (targeted, section-level changes) — the two tools have non-overlapping use cases enforced by description. The `singlePassFixItems` routing in `message.ts` separates structural-conflict findings (issues matching "duplicate/defined twice/conflicting/appears twice/multiple.*section") from targeted findings — structural items route to `rewrite_design_spec`, targeted items route to `apply_design_spec_patch`. Triggers the same `saveDesignDraft` path as `apply_design_spec_patch` including preview regeneration. | `rewrite_design_spec` unit tests in `tests/unit/design-agent.test.ts` |
| **Effective audit variables + platform status line** | `message.ts` → effective variable declarations + `platformStatusPrefix` construction | `effectiveBrandDrifts`, `effectiveAnimDrifts`, `effectiveMissingTokens`, `effectiveDeterministicQuality`, `effectiveReadinessFindings` initialized from pre-run audit data, updated to fresh post-patch data after the continuation loop. All downstream consumers (Gate 2, action menu, platform status line, Gate 4) read these instead of stale pre-run data. `totalEffectiveItems` is the sum across all categories. When `totalEffectiveItems > 0` and no escalation was just offered, the platform prepends `_Platform audit: N items remain before engineering handoff._` to the agent response — structural condition (count > 0), no text-pattern detection of agent prose. After the continuation loop, effective items are typically 0 so the status line is a rare safety net rather than a routine occurrence. | N55 integration scenario |

**Upstream rubric design rule:** Each agent's upstream rubric is deliberately designed for that agent's perspective — never copy another agent's self-evaluation rubric for a different agent's upstream gate. Example: `ARCHITECT_UPSTREAM_PM_RUBRIC` (2 criteria) is the architect's upstream gate for PM spec quality. `PM_RUBRIC` (6 criteria) is the PM's own self-evaluation gate. Reusing `PM_RUBRIC` as the architect's upstream gate caused engineering-scope gaps (data requirements, measurability) to be escalated to the PM instead of handled by the architect.

`brand-auditor.ts` is a pure string diff — zero API cost, zero latency. `auditBrandTokens()`, `auditAnimationTokens()`, and `auditMissingBrandTokens()` run on every design agent response: state query path (called in `message.ts`, results passed into `buildDesignStateResponse`) and full agent run path (injected as PLATFORM NOTICE into the enriched user message). Color drift and animation drift are merged. `auditBrandTokens()` scans the entire spec line-by-line (not just `## Brand`) so stale tokens in Design System Updates, proposed additions, or any other section are surfaced. Each drifted token is reported once — the first non-canonical value found wins. `extractSpecAnimValue()` handles tilde-prefixed values (e.g. `~200px`) by stripping the `~` before numeric extraction. Opacity is handled separately by `extractSpecOpacityRange()` which parses the design agent's "Opacity cycle: X → Y" range format. `extractBrandAnimationParams()` reads directly from the `## Glow (Signature Effect)` CSS in BRAND.md — parsing `animation:` shorthand for duration, `filter: blur()` for blur radius, `animation-delay:` for delay, and `@keyframes` opacity values for opacity min/max. The platform adapts to the format the team committed; it never adds auxiliary sections to customer repos to make parsing easier.

**Platform spec facts injection:** After loading the design spec, `message.ts` calls `extractSpecTextLiterals(specContent)` from `runtime/spec-utils.ts` — a pure regex extraction that finds `Heading: "..."`, `Tagline: "..."`, `Header: "..."`, `Description: "..."`, and `placeholder: "..."` values. These are injected into the enriched user message as a `[PLATFORM SPEC FACTS]` block alongside the existing `brandDriftNotice`. This gives the design agent platform-extracted text literals it cannot misread or reconstruct from memory — the platform extract is authoritative, the agent's recall is not.

**HTML preview renderer (`runtime/html-renderer.ts`):** Fully deterministic — no LLM call. `renderFromSpec(specContent, brandMd, featureName)` parses the spec for structured values and fills a fixed Alpine.js HTML template.

**Parsing authority:** Spec is authoritative for structural values and glow animation; BRAND.md is authoritative for color tokens only.
- `wordmark` — parsed from Nav Shell section ("X wordmark:"); derived from auth heading if absent
- `authHeading` — first `Heading: "..."` match (auth sheet heading, e.g. "Sign in to Health360")
- `tagline` — matches both `tagline "..."` (inline format) and `Tagline: "..."` (colon format)
- `placeholder` — matches both `placeholder text "..."` and `Placeholder: "..."` formats
- `chips` — extracted from Starter Chips section quoted strings (≤3); shows 3 correctly-dimensioned placeholder pills (44px height, 40px border-radius, teal 15% border) when none found — layout is reviewable before copy is defined
- Glow animation (`heartbeat-violet` / `heartbeat-teal`) — parsed from spec `## Brand` section; two independent keyframes with 5 control points (0%/12%/36%/60%/100%), scale + opacity, `cubic-bezier(0.4, 0, 0.2, 1)` easing; never read from BRAND.md
- Color tokens — read from BRAND.md (including `--error` for error state text color)

**Template guarantees:** No hex color hardcoded; all values runtime-injected. Chip text via `data-chip` attributes (apostrophe-safe). SSO buttons: `rgba(teal, 0.15)` borders (spec), 56px height, 40px border-radius (rounded pill). Auth sheet: 16px border-radius. Error color: `--error` token. `validateRenderedHtml()` checks blocking structural issues. `generateDesignPreview()` is a thin async wrapper for backward compatibility. `scripts/generate-preview.ts` is the CLI entry point.

**Preview regeneration on save:** `apply_design_spec_patch` calls `saveDesignDraftInternal(mergedSpec)` (in `runtime/tool-handlers.ts`), which calls `renderFromSpec` with the full merged spec and saves the result to the design branch. Because `renderFromSpec` is deterministic, the same spec always produces identical HTML — no caching strategy required. The `generate_design_preview` tool handler reads the saved preview from the design branch and serves it directly.

**Context summarization warning:** When design agent conversation history exceeds `DESIGN_HISTORY_LIMIT` (20 messages), `getPriorContext()` returns a summary. The platform detects this and posts a one-time Slack message informing the user that earlier context was summarized and that the spec on GitHub is the full authoritative record. Posted once per feature (tracked via `summarizationWarnedFeatures` Set) to prevent repeating on every subsequent message.

**Pre-commit purity enforcement (`scripts/install-hooks.sh`):** Rule 4 (hardcoded product names) now covers `interfaces/` in addition to `agents/` and `runtime/`. Rule 5 (hardcoded hex color string literals) is new — blocks any commit that adds `"#RRGGBB"` quoted string literals in source files, enforcing that brand values always come from BRAND.md at runtime.

Every new agent added to the platform must wire its equivalent audit before the agent is considered complete.

### Known efficiency gaps (from DECISIONS.md)

| Gap | Current | Target |
|---|---|---|
| Phase state | Re-read from GitHub on every message (~200–300ms overhead) | Redis cache, invalidated on spec merge to main |
| Conversation history | In-memory + disk (one process) | Redis — survives redeploys, works across multiple bot instances |
| Confirmed agents | `.confirmed-agents.json` on disk | Redis — same reasons |
| Pending escalation / approval / notification | `.conversation-state.json` on disk — persisted on every write, loaded on startup | Redis — same reasons |
| Context limit | Silent failure when thread exceeds model window | Proactive warning at ~70% capacity; explicit error surfaced to user at limit |

---

## State Model

### Primary state: GitHub

GitHub is the database. No application database is required for business logic state.

- **Approved spec** = file on `main` branch
- **In-progress spec** = file on a `spec/<feature>-<type>` branch, not yet merged
- **Feature phase** = derived from which spec files exist on `main` (see Phase Detection below)

This model is intentional: it makes state auditable, version-controlled, and human-readable without any tooling beyond `git log`.

### Secondary state: conversation store

In-memory per **feature**, keyed by `featureName` (derived from `channelName` — e.g. `"feature-onboarding"` → `"onboarding"`):
- Conversation history (capped at 40 messages — Sonnet context window management)
- Confirmed agent per feature (which agent is handling this feature)

All Slack threads in the same feature channel share one history entry. A new team member or a new thread in `#feature-onboarding` loads the full accumulated context immediately — no cold-start, no lost decisions from prior threads.

`threadTs` is still passed to Slack API calls (replies post in the correct thread) but is no longer used as the store key.

**Dev persistence:** `.confirmed-agents.json` (confirmed agents), `.conversation-history.json` (history), `.conversation-state.json` (pending escalation/approval/notification) — all persisted on every write, loaded on startup, survive bot restarts including nodemon file-watch restarts triggered by code changes. `disableFilePersistence()` is called by all test files at module level: it prevents writes (so test teardown cannot overwrite production state files) AND clears all five in-memory maps (store, confirmedAgents, pendingEscalations, pendingApprovals, escalationNotifications) so disk-loaded state from the module import does not bleed into test runs.
**Prod target:** Redis — survives multi-instance deployment, configurable TTL per workspace

### Zero application database for business logic

The platform deliberately avoids a database for spec state, feature state, and phase detection. GitHub provides all of this. A database is introduced only when GitHub cannot provide it (real-time session state, multi-workspace config at scale).

---

## Phase Detection

The system determines feature phase by reading GitHub — no separate state store. `getInProgressFeatures()` in `runtime/github-client.ts` implements this.

| GitHub state | Feature phase |
|---|---|
| Branch `spec/<feature>-product` exists, `.product.md` not on `main` | Product spec in progress |
| `<feature>.product.md` on `main`, `.design.md` not on `main` | Design phase |
| `<feature>.design.md` on `main`, `.engineering.md` not on `main` | Engineering phase |
| `<feature>.engineering.md` on `main` | Build phase |

Phase detection drives routing: `handleFeatureChannelMessage` reads the current phase and routes to the correct agent without human configuration.

---

## Extensibility: Adding a New Agent

The pattern is established. Every new agent follows the same six steps:

1. **`agents/<name>.ts`** — system prompt builder + `hasDraft<Name>Spec()`, `extractDraft<Name>Spec()`, `isCreate<Name>SpecIntent()`, `extract<Name>SpecContent()` helpers
2. **`runtime/context-loader.ts`** — add `load<Name>AgentContext()` that reads the full context this agent needs (authoritative docs + all approved upstream specs + current draft)
3. **`runtime/github-client.ts`** — add `saveDraft<Name>Spec()` and `saveApproved<Name>Spec()`, update `getInProgressFeatures()` phase list and `FeatureStatus` type
4. **`interfaces/slack/handlers/message.ts`** — add `run<Name>Agent()` function and phase routing for the new phase
5. **`AGENTS.md`** — document the new agent's persona, capabilities, inputs, outputs
6. **`SYSTEM_ARCHITECTURE.md`** — add the new agent to the agent roster and update the spec chain diagram

No other files change. The WorkspaceConfig extensibility model means a new agent that needs a new doc path adds one env var and one field to `WorkspaceConfig` — no hardcoding.

---

## Multi-Workspace Evolution

### Current: single-tenant via env vars

One `WorkspaceConfig` loaded at startup from environment variables. One Slack workspace, one GitHub repo, one customer. This is the correct model for a solo team or an early customer — no operational overhead.

### Target (Step 9): database-backed multi-tenant

When multiple paying customers are running simultaneously:
- `WorkspaceConfig` moves from env vars to a database table, keyed by Slack workspace ID
- One bot process handles N workspaces; config is loaded per-message, not at startup
- `/sdlc setup` Slack command walks a new workspace through configuration interactively
- Per-workspace cost controls and rate limiting
- Env var loading remains valid as a fallback for single-workspace deployments

The migration path is deliberate: env vars now → same structure in a database later. The `WorkspaceConfig` type does not change — only where it's loaded from.

---

## agentic-cicd Integration

archcon produces the spec chain and the work items. agentic-cicd executes the delivery.

```
archcon                          agentic-cicd
──────────────────────────────   ──────────────────────────────
Spec chain (GitHub)          →   Reads approved engineering spec
Work items (GitHub issues)   →   Triggers build pipeline
Code PRs (opened by agents)  →   Runs CI: type-check, test, build
QA sign-off (GitHub comment) →   Deploys to production
```

**Handoff mechanism:** agentic-cicd watches the customer's GitHub repo for approved engineering specs and work items. archcon does not call agentic-cicd directly — GitHub is the integration point.

**Customer options:**
- License archcon only → gets spec chain through code review, manual deployment
- License both repos → gets the full autonomous pipeline, specs to production

**WorkspaceConfig deployment section** (added in Step 8): customers configure their deployment target (Vercel, Railway, Fly.io), preview URL pattern, and production secrets path in `.env` — agentic-cicd reads from the same config structure.

---

## Security Model

### What archcon holds
- Slack bot token — workspace-scoped, read messages + post messages in invited channels only
- GitHub token — repo-scoped, read/write to the customer's spec repo only
- Anthropic API key — used for all Claude API calls; no customer data is stored by Anthropic beyond the request window

### What archcon can access
- Customer's GitHub spec repo (read + write to spec branches and `main`)
- Slack channels the bot has been invited to
- The authoritative doc files and spec files in the customer repo

### What archcon cannot access
- Production infrastructure of any kind
- Customer databases or user data
- Any secrets beyond the three tokens above
- Other customers' repos or Slack workspaces

### Customer secret boundary
Customer production secrets (database passwords, third-party API keys, payment credentials) **never flow through archcon**. They are agentic-cicd's concern — stored as pipeline secrets, injected at build/deploy time, never written into spec files.

---

## Technology Choices

| Component | Technology | Why |
|---|---|---|
| Primary AI (spec shaping) | `claude-sonnet-4-6` | Best reasoning for complex spec work and long context chains |
| Secondary AI (classification, filtering, auditing) | `claude-haiku-4-5-20251001` | Fast and cheap for bounded classification tasks |
| Human interface | Slack (Socket Mode) | Where teams already work; Socket Mode requires no public URL |
| GitHub integration | Octokit REST | Official GitHub SDK; full API coverage |
| Primary state | GitHub branches + files | Version-controlled, auditable, no extra database required |
| Conversation history | In-memory + disk (dev) / Redis (prod) | Fast for dev; Redis for production multi-instance reliability |
| Runtime | Node.js + TypeScript (`tsx` in dev) | Type safety, strong tooling, no compile step in development |
| Testing | Vitest | Fast, ESM-native, compatible with TypeScript without additional config |

---

## Agent Roster (current)

| Agent | Phase | Output | Authoritative doc owned |
|---|---|---|---|
| Concierge | Entry point (no phase) | Role-aware orientation + feature status | — |
| PM agent | Phase 1 — Product Spec | `<feature>.product.md` | `PRODUCT_VISION.md` |
| Design agent | Phase 2 — Design Spec | `<feature>.design.md` | `DESIGN_SYSTEM.md` |
| Architect agent | Phase 3 — Engineering Spec | `<feature>.engineering.md` | `SYSTEM_ARCHITECTURE.md` |
| pgm agent | Phase 4 — Work Items | `<feature>.workitems.md` | — |
| Backend agent | Phase 4 — Code | PRs in customer app repo | — |
| Frontend agent | Phase 4 — Code | PRs in customer app repo | — |
| QA agent | Phase 5 — QA | `<feature>.qa.md` + PR sign-off | — |

Agents in _italic_ are planned; others are built or in progress.

---

## Test Coverage

Tests live in `tests/unit/` and run with `npx vitest run`. All external dependencies (Anthropic API, GitHub API, disk I/O) are mocked — no real API calls in CI.

**Mocking pattern:** `vi.hoisted()` for mock functions referenced in `vi.mock()` factories. `function()` syntax (not arrow functions) for constructors used with `new`. Top-level `vi.mock()` per file.

See individual test files for coverage details. The rule: every new agent behavior added must have a corresponding test. A behavior with no test does not count as done.

### Pipeline Eval Tier

A separate eval tier (`tests/evals/pipeline/**/*.eval.ts`) runs hybrid tests — mocked GitHub (deterministic state) + real Anthropic API (live reasoning) + Haiku judge (pass/fail criteria). These are not in the main test suite.

| Config | `vitest.pipeline.config.ts` |
|---|---|
| Run command | `npm run eval:pipeline` |
| Setup file | `tests/pipeline-setup.ts` — loads dotenv before any module reads `ANTHROPIC_API_KEY` |
| Timeout | 120s per test (real API calls) |
| Purpose | Validate Principle 7 (zero human errors of omission) — agent must surface blocking gaps without trigger phrases |

**Current evals:** `principle7-design.eval.ts` — design agent surfaces PM blocking questions on neutral phrasing ("what is the next step for this feature", "are we ready to start designing?") with Haiku judge verifying the response is not generic, names specific blockers, and escalates appropriately.
