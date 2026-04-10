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

Implemented in `runtime/conversation-summarizer.ts`.

### Graceful shutdown

`runtime/request-tracker.ts` tracks all in-flight Claude API requests. On `SIGTERM`, the process waits for all in-flight requests to drain before exiting — with a 6-minute maximum (must exceed Anthropic's 5-minute API timeout). This prevents a deployment or restart from cutting off a user mid-response. Any request still in-flight after the deadline is abandoned and the process exits with a warning.

All Anthropic clients set `maxRetries: 0` and explicit timeouts. The SDK default of 2 retries × 10-minute timeout = 30 minutes per stalled call — two sequential stalls meant a user could wait an hour at "thinking..." with no error surfaced. Timeouts by client role: main agent (`claude-client.ts`) 5 min; rubric auditor (`phase-completion-auditor.ts`) 90s; spec/decision auditors (`spec-auditor.ts`) 60s; conversation summarizer (`conversation-summarizer.ts`) 60s; classifiers (`agent-router.ts`, `context-loader.ts`) 30s. A stall now surfaces as a user-visible error in under 90 seconds.

### Agent tool-use loop (Step 13)

All spec-producing agents (PM, design, architect) use the Anthropic native tool-use API instead of the former hand-rolled text-block protocol. `runAgent()` in `runtime/claude-client.ts` is a tool-use loop:

1. Call `messages.create` with the agent's declared tool schemas
2. If `stop_reason === "tool_use"`: execute the platform `toolHandler` for each `tool_use` content block, inject `tool_result` messages, loop
3. If `stop_reason === "end_turn"`: return the final text response

Tool results carry structured data (spec URL, audit findings, preview URL) back to the agent. The agent interprets results and either calls another tool or produces a final text response. No regex parsing, no PLATFORM OVERRIDE injection.

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
4. **Haiku classifier** (`runtime/pm-gap-classifier.ts`) — final safety net; sends agent response to Haiku with a focused system prompt that identifies PM-scope gaps (undefined requirements, missing error states, scope decisions, unmeasurable qualitative criteria). Returns `GAP: <sentence>` lines or `NONE`. Fires only when no escalation is pending, no spec was saved, and agent is not seeking confirmation.

When any gate sets `pendingEscalation` this turn (`escalationJustOffered`): (a) the platform overrides passive prose with assertive CTA ("Design cannot move forward. Say *yes*..."), and (b) the action menu is suppressed. The only exit from pending-escalation state is user affirmation ("yes") → PM @mentioned, escalation cleared.

### Proactive constraint audit pattern

Every agent in the platform runs a deterministic audit for its domain-specific constraints on every response. This is not prompt-based — it is platform-enforced, pure code, no API call.

The principle: **the specialist surfaces all violations proactively**. The human cannot be expected to know what constraint to check or what question to ask. If a violation must be reported, it must be reported on every response, unconditionally.

| Audit | File | What it checks | Model |
|---|---|---|---|
| Spec conflict + gap | `runtime/spec-auditor.ts` → `auditSpecDraft()` | Vision conflicts, architecture gaps | Haiku (runs post-draft-save) |
| Render ambiguity (save-time) | `runtime/spec-auditor.ts` → `auditSpecRenderAmbiguity()` | Two-stage: (1) deterministic pre-filter — screens referenced in User Flows but missing from Screens section; (2) Haiku — vague elements: undefined text, relative-only positioning, no sheet entry direction/animation timing, TBD copy, unnamed states without visual descriptions, conflicting values, vague measurement language | Deterministic + Haiku (runs post-draft-save; design agent must resolve all before next response) |
| **Phase completion gate — PM** | `runtime/phase-completion-auditor.ts` → `auditPhaseCompletion(PM_RUBRIC)` | All user stories have error paths, acceptance criteria are measurable, zero unresolved blocking questions, data requirements explicit, no architectural contradictions, Non-Goals names a scope boundary | **Sonnet** (runs once on approval intent, before `finalize_product_spec`; blocks phase advance until zero findings) |
| **Phase completion gate — Design** | `runtime/phase-completion-auditor.ts` → `auditPhaseCompletion(DESIGN_RUBRIC)` | All screens defined with all states, all UI copy verbatim, all animations with timing+easing, no conflicting values, no vague language, brand token consistency, no TBD/TODO/PLACEHOLDER, no unresolved product assumptions or PM spec vagueness (criterion 10 two-part: PART A catches design decisions that assume product answers not in the PM spec; PART B scans the PM spec itself for requirements too vague to design against — e.g. "handle gracefully", "preserve conversations" — and flags them when the design spec also lacks a specific implementation; receives `productVision`, `systemArchitecture`, AND `approvedProductSpec` as context) | **Sonnet** (runs once on approval intent, before `finalize_design_spec`; blocks phase advance until zero findings) |
| **Phase entry upstream audit — Design** | `message.ts` → `auditPhaseCompletion(PM_RUBRIC)` on approved PM spec | PM spec gaps that would propagate into design (same PM_RUBRIC criteria) | **Sonnet** (runs on every design agent message; content-addressed cache — invalidates automatically when PM spec is edited; result injected as PLATFORM UPSTREAM SPEC AUDIT notice) |
| **Phase entry upstream audit — Architect** | `message.ts` → `auditPhaseCompletion(PM_RUBRIC)` + `auditPhaseCompletion(buildDesignRubric(targetFormFactors))` on approved upstream specs, in parallel | PM and Design spec gaps that would propagate into engineering | **Sonnet** (runs on every architect agent message; same content-addressed caching; combined notice injected if any findings) |
| **Form factor coverage** | `runtime/phase-completion-auditor.ts` → `buildDesignRubric(targetFormFactors)` criterion 9; `runtime/spec-auditor.ts` → `auditSpecRenderAmbiguity(spec, { formFactors })` | Every screen defines layout for all target form factors (mobile, desktop, etc.) — or Non-Goals explicitly excludes a form factor | Sonnet (completion gate); Haiku (save-time); design agent system prompt (proactive) — all three layers enforce the same requirement |
| Renderer text fidelity | `runtime/html-renderer.ts` → `validateTextFidelity()` | Spec-defined text literals (Heading, Tagline, etc.) appear verbatim in rendered HTML | None (pure string match) |
| Renderer structural validation | `runtime/html-renderer.ts` → `validateRenderedHtml()` | Hero present (`id="hero"`); hero must not be nested inside thread (BLOCKING); hero uses `:class` not `x-show` (BLOCKING); thread has `display:none` + `x-show` (BLOCKING); body has explicit background-color; keyframe animations present | None (pure string/regex match — no retry needed; template always produces correct structure) |
| **Always-on design phase completion audit** | `message.ts` → `auditPhaseCompletion(buildDesignRubric(targetFormFactors))`; `runtime/phase-completion-auditor.ts` | Runs on every design agent message when design spec draft exists on branch. Content-addressed cache on spec fingerprint — invalidates automatically when draft is edited. Findings injected as `[PLATFORM DESIGN READINESS]` into enriched user message before agent runs. Design gaps → agent recommends fix. Product gaps → `offer_pm_escalation`. Architecture gaps → `offer_architect_escalation`. **Principle 7: no trigger phrase required.** | Sonnet (runs on every message, cached per spec version) |
| **Always-on architect engineering spec completeness audit** | `message.ts` → `auditPhaseCompletion(ENGINEER_RUBRIC)`; `runtime/phase-completion-auditor.ts` → `ENGINEER_RUBRIC` | Runs on every architect agent message when engineering spec draft exists on branch. Content-addressed cache on engineering spec fingerprint. Criteria: API contracts (method+path+request+response types), data model (explicit field names + cardinality), error paths (HTTP status + response shape per operation), auth/authorization (named role/condition per endpoint), migration strategy (explicit approach per schema change), no unresolved blocking questions. Findings injected as `[PLATFORM ENGINEERING READINESS]` into enriched user message. **Principle 7: no trigger phrase required.** | Sonnet (runs on every message, cached per spec version) |
| Design escalation triage | `agents/design.ts` → `DESIGN_TOOLS` (`offer_pm_escalation` + `offer_architect_escalation`); `runtime/conversation-store.ts` → `PendingEscalation.targetAgent: "pm" \| "architect"`; `EscalationNotification` (post-confirmation store); `interfaces/slack/app.ts` → `userId` extracted and passed; `runtime/spec-utils.ts` → `extractProductBlockingQuestions()` | Product behavior questions → PM. Architecture/data design questions → Architect. Visual definition gaps agent can resolve → agent owns it with a concrete proposal. **Two-layer platform enforcement for product gaps:** (1) Pre-run structural gate: `extractProductBlockingQuestions()` scans the design spec draft for `[type: product] [blocking: yes]` lines before `runAgent` is called — if found and no pending escalation, auto-triggers escalation and returns without an Anthropic call (deterministic, zero LLM cost). (2) Post-run rubric gate: if `designReadinessFindings` contains `[type: product]` findings after the agent runs, platform overrides the response and sets pending escalation. `buildDesignRubric` criterion 10 instructs Haiku to prefix such findings with `[type: product] [blocking: yes]`. **Escalation reply auto-routing:** after the user confirms and the @mention is posted, `setEscalationNotification` tracks the open question. When the PM/Architect replies in the same thread (detected by `userId === roles.pmUser/architectUser`), the platform clears the notification and injects `"PM answered: [question] → [answer]"` as the design agent's user message, resuming design automatically. | None (pre-run: pure string match; post-run: rubric LLM output tagging; reply routing: userId match) |
| Render ambiguity + design quality audit | `runtime/spec-auditor.ts` → `auditSpecRenderAmbiguity()` | **4-pass pipeline:** (1) deterministic undefined screen references; (2) `auditCopyCompleteness()` — TBD markers + narrative punctuation; (3) `auditRedundantBranding()` — auth heading repeating nav wordmark; (4) Haiku semantic pass — structural ambiguity (chip anchor, SSO layout, vague language) + design quality (scrollable rows without scrollbar treatment, dynamic lists without empty state, touch targets unspecified, copy redundancy). All findings block — agent must patch before proceeding. **Principle 7: runs on every save, no trigger required.** | Haiku (one call, passes 1–3 results in; returns merged array) |
| **Redundant branding audit** | `runtime/spec-auditor.ts` → `auditRedundantBranding()` | Auth heading repeats the app name already shown in the nav wordmark — redundant in context; flag with concrete replacement recommendation. | None (pure string match — `includes()` on wordmark vs all `Heading: "..."` occurrences) |
| **State response quality gate** | `agents/design.ts` → `buildDesignStateResponse({ qualityIssues })` + state query path in `message.ts` | Full `auditSpecRenderAmbiguity()` (4-pass) runs on every state query — replaces the two prior separate deterministic calls. SPEC section shows only bold summary statements from Design Direction (not raw bullet lists) to stay within Slack's 4000-char limit and surface crisper content. CTA priority: uncommitted > drift > quality > blocking — approval blocked until all clear. | Haiku (one call via `auditSpecRenderAmbiguity`) |
| **Copy completeness audit** | `runtime/spec-auditor.ts` → `auditCopyCompleteness()` | (1) All quoted strings: no `[TBD]`/`[placeholder]` bracket patterns. (2) Narrative role strings only (`tagline`, `subheading`, `description`, `slogan`, `hero text`, `nudge text`): must end with terminal punctuation (. ! ?). Button labels, headings, auth copy, and placeholder text are intentionally excluded. Wired into `auditSpecRenderAmbiguity()` return — blocking, same enforcement path as render ambiguity. | None (deterministic string scan — no LLM call) |
| Brand color drift | `runtime/brand-auditor.ts` → `auditBrandTokens()` | Entire spec hex values vs BRAND.md (all sections, not just ## Brand) | None (pure string diff) |
| Brand animation drift | `runtime/brand-auditor.ts` → `auditAnimationTokens()` | Spec glow duration, blur, delay, opacity-min/max vs BRAND.md `## Glow` CSS section. CSS-format spec parsed with `extractBrandAnimationParams` (same parser as BRAND.md, prefixed with synthetic `## Glow` heading); prose-format fallback for older specs. | None (pure string diff) |
| Brand missing tokens | `runtime/brand-auditor.ts` → `auditMissingBrandTokens()` | Canonical BRAND.md tokens entirely absent from spec (case-insensitive). Distinct from drift — a drifted token is present with wrong value; a missing token is not referenced anywhere. | None (pure string match) |
| **Brand drift finalization gate** | `message.ts` → `finalize_design_spec` handler | `finalize_design_spec` runs `auditBrandTokens()` + `auditAnimationTokens()` on the final spec before calling `saveApprovedDesignSpec`. If any drift exists, returns an error and blocks approval. Hard gate — spec cannot be approved with incorrect brand values. | None (pure string diff) |
| **Platform-enforced structured action menu** | `message.ts` → `buildActionMenu()` (exported) | After `runDesignAgent` completes, the platform deterministically builds and appends a numbered action menu to the agent's prose response. Categories: Brand Drift, Missing Brand Tokens, Design Quality, Design Readiness Gaps. Issues are globally numbered across all categories so the user can say "fix 1 3 5" and the platform knows exactly which fixes to apply. This is structural enforcement — not a system prompt instruction — so it appears on every response that has open issues regardless of how the agent phrased its reply. Readiness findings use a dual cache (`phaseEntryAuditCache` for the formatted notice + `designReadinessFindingsCache` for the raw findings array) so the action menu is populated correctly on cache hits. | None (pure formatting — all audit data pre-computed before `runAgent`) |

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

**Preview regeneration on save:** `apply_design_spec_patch` calls `saveDesignDraft(mergedSpec)`, which calls `renderFromSpec` with the full merged spec and saves the result to the design branch. Because `renderFromSpec` is deterministic, the same spec always produces identical HTML — no caching strategy required. The `generate_design_preview` tool handler reads the saved preview from the design branch and serves it directly.

**Context summarization warning:** When design agent conversation history exceeds `DESIGN_HISTORY_LIMIT` (20 messages), `getPriorContext()` returns a summary. The platform detects this and posts a one-time Slack message informing the user that earlier context was summarized and that the spec on GitHub is the full authoritative record. Posted once per feature (tracked via `summarizationWarnedFeatures` Set) to prevent repeating on every subsequent message.

**Pre-commit purity enforcement (`scripts/install-hooks.sh`):** Rule 4 (hardcoded product names) now covers `interfaces/` in addition to `agents/` and `runtime/`. Rule 5 (hardcoded hex color string literals) is new — blocks any commit that adds `"#RRGGBB"` quoted string literals in source files, enforcing that brand values always come from BRAND.md at runtime.

Every new agent added to the platform must wire its equivalent audit before the agent is considered complete.

### Known efficiency gaps (from DECISIONS.md)

| Gap | Current | Target |
|---|---|---|
| Phase state | Re-read from GitHub on every message (~200–300ms overhead) | Redis cache, invalidated on spec merge to main |
| Conversation history | In-memory + disk (one process) | Redis — survives redeploys, works across multiple bot instances |
| Confirmed agents | `.confirmed-agents.json` on disk | Redis — same reasons |
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

**Dev persistence:** `.confirmed-agents.json` on disk — survives bot restarts
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
