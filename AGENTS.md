# agentic-sdlc — Agent Roster

Every agent in this system has a clearly defined role, a phase it owns, a human counterpart it works with, a specific output it produces, and a persona — the experience level and background it operates from. Agents are AI specialists — they assist the human, not replace them.

---

## Concierge agent
**Phase:** Entry point (no phase — always available)
**Human counterpart:** Anyone
**Channel:** Main workspace channel (e.g. #all-health360)
**Output:** Role-aware orientation and current feature status

**Persona:** A deeply experienced program coordinator who has worked across product, design, and engineering teams at top-tier tech companies for over a decade. Understands every role in a software organization intimately — what a PM actually does, what a designer cares about, what an architect worries about, what an engineer needs to be unblocked. Warm and patient but precise. Never talks down to anyone, never over-explains to someone who clearly knows their domain. Reads the room and calibrates instantly.

The front desk. Anyone — PM, designer, engineer, executive — comes here first. Reads the current state of all features from GitHub and explains what's happening and what each person can act on right now. Loads product vision and system architecture from GitHub on every message, filtered to what's relevant to the question (via Haiku relevance filter — no truncation, no summary files). Responds in plain English, never technical jargon.

---

## pm agent
**Phase:** Phase 1 — Product Spec
**Human counterpart:** Product Manager
**Channel:** #feature-<name>
**Output:** `<feature>.product.md` — product spec

**Persona:** A senior product leader with 15+ years shipping consumer and enterprise products at scale. Has worked at companies like Stripe, Airbnb, and Google — has seen 0→1 launches, 100M+ user scaling challenges, and every type of product failure in between. Knows what "good" looks like and is not afraid to say when something isn't there yet. Asks the uncomfortable questions most people avoid. Has written hundreds of product specs and knows exactly where they go wrong: vague success criteria, missing edge cases, unstated assumptions, scope that quietly balloons. Holds every spec to the same standard they would apply at a top-tier company.

Shapes a feature idea into a structured product spec through conversation. Asks clarifying questions, surfaces edge cases, and enforces two hard gates:

1. **Spec audit** — after every draft, runs `spec-auditor.ts` against product vision and architecture before saving. Conflicts block the save and are surfaced explicitly. Gaps are saved but flagged for human decision.
2. **Vision/architecture conflict gate** — if a proposal conflicts with vision or architecture, hard stops and does not touch the spec until the human confirms the upstream doc has been updated. Re-reads the doc from GitHub to verify before proceeding.

**Approved spec mode** — once a spec is approved, the pm agent continues handling all messages in the feature channel (proposals, questions, status) but treats the spec as the current approved baseline. Revisions require explicit re-approval. Open questions are structured: `[type: design|engineering|product] [blocking: yes|no]`.

**Native tool-use (Step 13):** The PM agent uses the Anthropic tool-use API:
- `save_product_spec_draft` — first save; platform runs spec audit and returns `{ url, audit }` as tool result
- `apply_product_spec_patch` — incremental update; same audit
- `run_phase_completion_audit` — Sonnet-based comprehensive completeness check; called on approval intent BEFORE finalize; returns `{ ready, findings }`
- `finalize_product_spec` — blocked if unresolved `[blocking: yes]` questions exist; triggers phase advance to design

**Phase completion gate (PM).** When the PM signals approval, the agent calls `run_phase_completion_audit()` first. The tool runs `auditPhaseCompletion(PM_RUBRIC)` — a Sonnet-based check covering: all user stories have error paths, acceptance criteria are measurable, zero unresolved blocking questions, data requirements are explicit, no architectural contradictions, Non-Goals names at least one scope boundary. If findings exist, the agent surfaces them numbered with recommendations and waits for re-approval. The phase does not advance to design until the audit returns zero findings.

The old text-block protocol (`DRAFT_SPEC_START/END`, `PRODUCT_PATCH_START/END`, `INTENT: CREATE_SPEC`) is fully removed.

---

## UX Design agent
**Phase:** Phase 2 — Design Spec
**Human counterpart:** UX Designer
**Channel:** #feature-<name>
**Output:** `<feature>.design.md` — design spec

**Persona:** A principal UX designer with 12+ years designing consumer-grade digital products. Has led design at companies like Apple, Figma, Airbnb, and Google — organizations where design quality is a competitive advantage, not an afterthought. Deep expertise in interaction design, information architecture, accessibility, design systems, and mobile-first thinking. Has designed for hundreds of millions of users and understands the difference between what looks good in Figma and what actually works at scale. Balances aesthetic sensibility with usability and technical constraints. Knows when to push for design polish and when to ship. Does not let engineers make design decisions silently — surfaces every design question explicitly.

Reads the approved product spec fully before asking a single question. Works with the UX designer to produce: screen inventory, user flows (per user story), component decisions (new vs reused), and open questions for engineering. Holds the same conflict + gap detection gates as the pm agent. Escalates product decisions back to the PM, architectural decisions to the architect. Never makes those calls unilaterally.

**Spec format (`<feature>.design.md`):** Figma link, Design Direction, Brand (tokens + typography), Screens (purpose / states / interactions / notes per screen), User Flows (one per user story), Accessibility decisions, Open Questions. Draft/approval mechanics (auto-save, freeze on approval) wired in Step 3c.

**HTML preview:** On every draft save, the design agent generates a self-contained HTML preview (`<feature>.preview.html`) saved to the design branch alongside the spec. Uses Tailwind CDN + Alpine.js — all screens navigable via tabs, all states (default/loading/empty/error) toggleable per screen, faithful to brand colors and typography. Preview link posted in Slack after every draft save. Non-fatal — draft save succeeds even if preview generation fails.

**Native tool-use (Step 13):** The design agent uses the Anthropic tool-use API. All spec saves, patches, previews, and finalizations are done via typed tool calls:
- `save_design_spec_draft` — first save of the spec; platform runs brand + spec audits and auto-generates HTML preview
- `apply_design_spec_patch` — incremental update; same audits + preview regeneration
- `generate_design_preview` — preview-only, no GitHub save
- `fetch_url` — fetches a reference URL to extract brand tokens
- `offer_pm_escalation` — escalates blocking **product** questions (user-facing behavior, acceptance criteria, user story scope). Stores via `setPendingEscalation(targetAgent: "pm")`; platform prompts user to confirm, then posts PM notification. Called immediately — no permission-seeking.
- `offer_architect_escalation` — escalates blocking **architecture or data design** questions (storage, system design, backend implementation). Stores via `setPendingEscalation(targetAgent: "architect")`. Design agent does NOT escalate visual definition gaps it can resolve with design judgment.
- `finalize_design_spec` — blocked if unresolved `[blocking: yes]` questions exist

The old text-block protocol (`DRAFT_DESIGN_SPEC_START/END`, `DESIGN_PATCH_START/END`, `PREVIEW_ONLY_START/END`, `INTENT: CREATE_DESIGN_SPEC`) is fully removed. The Haiku classifiers `detectRenderIntent` and `detectConfirmationOfDecision` are removed — the agent calls tools directly without platform pre-classification.

**Recommendation-first questioning (rule 6):** Every question the design agent asks must include its recommendation and reasoning BEFORE asking for confirmation. Format: "[Recommendation — specific value or direction, and why] → [Single confirmation question]". The user should only need to say "yes" or describe what's different. Never asks a question without a recommendation.

**HTML preview always full-regeneration:** `apply_design_spec_patch` always calls `renderFromSpec` (via `generateDesignPreview`) with the full merged spec — no patch-based surgical update. Because `renderFromSpec` is deterministic, the same spec always produces identical HTML.

**Readiness query → platform audit injection:** When the user asks a readiness question ("is this ready to hand off to engineering?", "can we ship?", "good to go?", etc.), `isReadinessQuery()` (Haiku classifier — same pattern as `isOffTopicForAgent`/`isSpecStateQuery`, catches any human phrasing) detects it. The platform immediately runs `auditPhaseCompletion(DESIGN_RUBRIC)` and injects findings as `[PLATFORM READINESS AUDIT]` into the enriched user message before the agent runs. The design agent sees the findings and must surface each one: design gaps with its own recommendations, product gaps via `offer_pm_escalation`, architecture gaps via `offer_architect_escalation`. This is platform-enforced — not prompt-rule-dependent.

**HTML renderer structural guarantees:** `renderFromSpec` uses a fixed Alpine.js template — structural correctness is guaranteed by construction, not by sanitizer patches. The template always produces `id="hero"` as sibling of `id="thread"`, hero uses `:class` (not `x-show`), thread has `style="display:none"` + `x-show`, chips are in a horizontal flex row anchored at the bottom of the hero via `margin-top:auto`, and inspector buttons have full static `style=` attributes. `validateRenderedHtml()` performs sanity checks but should never find violations on template-generated output. The render ambiguity auditor (`auditSpecRenderAmbiguity`) checks chip position anchor (horizontal row without a fixed-element anchor is ambiguous) and SSO button icon+text internal layout (icon/text arrangement must be specified).

**Post-response uncommitted decisions audit:** After every design agent text-only response (no save tool called), the platform runs `identifyUncommittedDecisions` on the current 2-message turn. The classifier uses real Haiku with a tightened prompt: counts only decisions the user actively agreed to, excluding proposals, unanswered questions, and regression complaints ("we had fixed", "it used to", "it's back to"). If uncommitted decisions exist, the platform appends a note to the Slack message prompting the user to "save those".

**Context summarization warning.** When design agent conversation history exceeds the 20-message limit, `getPriorContext()` returns a summary of earlier context. The platform posts a one-time Slack notice per feature: "Context from earlier in this thread has been summarized. The spec on GitHub is the full authoritative record." This surfaces what was previously a silent state change.

**Conversation store keyed by featureName, not threadTs.** All messages in `#feature-onboarding` (any Slack thread) share one conversation history keyed by the feature name (`"onboarding"`). A new team member starting a fresh thread in the same channel immediately has access to all prior context — no lost decisions, no cold-start. The `threadTs` is still used for Slack thread routing (replies post in the correct thread), but has no effect on what history the agent loads.

**Brand enforcement is prompt-layer only.** Brand tokens are injected at the top of the design agent's system prompt. The agent is instructed to use them exactly and never ask for Figma files or external URLs when BRAND.md is present. There is no platform-layer stall detection or retry — any design conversation can legitimately have questions, so stall detection cannot be reliably automated at the platform layer.

**Brand token drift detection (color + animation).** `brand-auditor.ts` runs on every response (state query and agent run). It diffs every CSS variable token in the spec's Brand section against BRAND.md canonical values (`auditBrandTokens()`) and also checks animation parameters — glow duration, blur radius, delay, opacity range — against BRAND.md's `## Glow` CSS section (`auditAnimationTokens()`). Both run as pure string diffs — zero API cost, zero latency. All drift (color + animation) is merged into a single PLATFORM NOTICE and injected into the enriched user message. Never silently corrects values without surfacing the drift first.

**Animation Brand section format (CSS, not prose).** The design agent's system prompt instructs it to write the Brand section's animation/glow subsection as CSS code blocks matching BRAND.md's structure: `**Glow (Signature Effect)**` → `**Violet glow:**` + `**Teal glow:**` sub-headings, each with a ` ```css ` block containing `filter: blur(Xpx)`, `@keyframes` with opacity keyframes, `animation: name Xs ...`, and `animation-delay: Xs` on the teal glow. The `auditAnimationTokens` parser tries CSS extraction first (`extractBrandAnimationParams` applied to the spec's Glow section); falls back to prose format for older specs. Format stability is guaranteed by the system prompt instruction, not by regex — if BRAND.md changes its CSS structure, the system prompt must be updated to match.

**Renderer text fidelity (deterministic).** `validateTextFidelity(html, specContent)` in `html-renderer.ts` runs after every render (both `generateDesignPreview` and `updateDesignPreview`). It extracts `Heading: "..."`, `Tagline: "..."`, `Header: "..."`, `Description: "..."`, and `placeholder: "..."` values from the spec and verifies each appears verbatim in the rendered HTML. Any mismatch means the renderer hallucinated substitute content — the issue surfaces through the existing `validateRenderedHtml` warning pipeline. Pure string matching — no LLM, no latency cost.

**Platform spec facts injection.** After loading the design spec, `message.ts` calls `extractSpecTextLiterals(specContent)` and injects the results as `[PLATFORM SPEC FACTS — committed text literals]` into the enriched user message alongside the existing `brandDriftNotice`. This grounds the design agent in platform-extracted text values it cannot misread or reconstruct from memory. Same pattern as brand drift injection — deterministic, runs every turn.

**Render ambiguity audit.** After every spec save, `auditSpecRenderAmbiguity(designSpec)` in `spec-auditor.ts` runs. It has two stages: (1) a deterministic pre-filter that scans `## User Flows` for screen/sheet/modal names and checks each against `## Screens` — any name referenced in flows but missing a Screens definition is flagged immediately without an LLM call; (2) a Haiku call that checks for defined-but-vague elements: screens with no title/subtitle, positions described only as relative without pixel spacing, sheets/modals with no entry direction or no entry/exit animation timing specified, interactive element text not defined, vague animation without timing values. Result is returned in the tool result as `renderAmbiguities: string[]`. **Render ambiguities are blocking** — when non-empty, the design agent must call `apply_design_spec_patch` in the same response turn to resolve all items — no deferral, no user question. A spec with unresolved render ambiguities is an incomplete spec. The design agent owns the renderer: it generates the spec, calls save tools, receives `renderAmbiguities`, and is responsible for the preview being correct.

**Unresolved `[PROPOSED ADDITION]` blocks.** When the design agent writes spec recommendations wrapped in `[PROPOSED ADDITION TO ...]` blocks, those decisions are NOT committed. After every save tool returns, the agent checks if any `[PROPOSED ADDITION]` blocks remain in the spec. If so, it surfaces them as a numbered list with explicit recommendations and waits for user confirmation before removing the wrapper and merging the content into the spec. `[PROPOSED]` blocks are never rendered as committed decisions.

**False-positive uncommitted-decision guard.** The post-turn audit (`identifyUncommittedDecisions`) is skipped when the agent's response itself ends with a confirmation-seeking phrase ("Lock this in?", "Shall I save?", etc.). In this case, the decision is pending by design — the agent is waiting for the user to confirm. Firing the ⚠️ warning here is a false positive.

**Spec completeness standard (engineer bar, not designer bar).** The design agent holds every spec to one standard: can an engineer with no design background implement 100% from the spec alone without guessing or inventing anything? This means every text literal, pixel distance, element position, sheet entry direction, state transition trigger, and interactive element behavior must be explicitly defined — or an explicit "none" statement provided. The render ambiguity audit enforces this structurally; the phase completion gate enforces it at approval.

**Phase completion gate (design).** When the designer signals approval of the full spec ("approved", "looks good", "ship it", etc.), the design agent calls `run_phase_completion_audit()` BEFORE `finalize_design_spec()`. The tool calls `auditPhaseCompletion(buildDesignRubric(targetFormFactors))` in `runtime/phase-completion-auditor.ts` — a Sonnet-based comprehensive check covering: all screens defined with all states, all UI copy verbatim in spec, all animations with timing and easing, no conflicting values, no vague language, brand token consistency, no TBD/TODO/PLACEHOLDER, and form factor coverage for all target form factors. If any criterion fails, the agent surfaces the findings as a numbered list with recommendations and blocks approval. The phase does not advance until the audit returns zero findings. This gate is structural — enforced by tool architecture, not a prompt instruction.

**Form factor coverage (structural enforcement).** The design agent is required to define layout behavior for every screen across all target form factors (configured via `TARGET_FORM_FACTORS` in `.env`, default: mobile, desktop). Three enforcement layers: (1) design agent system prompt item 9 — agent is instructed to define multi-form-factor layout before approval, with Non-Goals as the only exception path; (2) `auditSpecRenderAmbiguity` save-time Haiku audit — flags screens with layout defined for only one form factor; (3) `DESIGN_RUBRIC` criterion 9 — Sonnet completion gate blocks approval until all screens have form factor coverage. `buildDesignRubric(formFactors)` injects the team's configured form factors into the rubric text.

**`fetch_url` tool: relevance-filtered output.** The `fetch_url` tool handler calls `filterDesignContent(rawHtml)` in `spec-auditor.ts` instead of `.slice(0, 200_000)` truncation. `filterDesignContent` is a Haiku call that extracts only CSS custom properties, color values, font families, spacing values, and design system token definitions from the raw HTML — the design agent receives focused, relevant content rather than truncated raw markup.

**HTML preview renderer.** Uses `claude-sonnet-4-6` for production-quality rendering — the same model capable of generating the getarchon.dev site. When BRAND.md is available, its full content is passed as `brandContent` and prepended to the render prompt as an `AUTHORITATIVE BRAND TOKENS` block so the renderer uses canonical values, not spec values that may have drifted. Returns `{ html, warnings }` — warnings surface structural issues (missing keyframes, bg token absent, truncation, missing explicit body background) back to the agent. No hex color values are hardcoded in the renderer. Body `background-color` and `color` are required in the `<style>` tag — Tailwind CDN custom classes fail silently on file:// URLs and Slack attachments when the CDN loads after initial browser paint.

**Spec gap detection on state query.** `spec-auditor.ts` (Haiku) runs on the state query path in addition to the draft/patch save path. This makes gap detection consistent regardless of which code path the user hits — the same gap surfaces with the same framing whether you just saved a draft or asked "where are we?" Gaps appear under "Spec gap — upstream docs don't cover this yet" in the state response.

**Preview freshness signal.** When a state query returns uncommitted conversation decisions alongside an HTML preview, the preview note explicitly states that the preview reflects the committed GitHub spec only — uncommitted decisions are not included. This removes ambiguity about which version of the spec the preview shows.

**State response schema (three ordered sections).** `buildDesignStateResponse()` always returns in the same priority order: (1) `*── PENDING ──*` — always shown; if uncommitted conversation decisions exist they appear here with a warning to save before approving; if everything is committed it shows "No open items from prior conversations" so the user knows the check ran; (2) `*── DRIFT (spec vs BRAND.md) ──*` — color and animation drift, gates approval; (3) `*── SPEC ──*` — committed decisions, blocking/non-blocking questions, spec gap, preview link. The CTA at the bottom is conditional: uncommitted decisions present → "Save the pending decisions above first"; drift present → "Fix the drift above first"; blocking questions present → "Resolve the blocking questions above"; all clear → "Say *approved* to move to engineering." Approval is never offered while any gate is open.

**Cross-thread uncommitted decision detection.** `identifyUncommittedDecisions` receives the merged history from `[...getLegacyMessages(), ...getHistory(featureName)]`. `getLegacyMessages()` returns pre-migration conversation history (threadTs-keyed entries consolidated into `"_legacy_"` on startup). This ensures decisions discussed in any prior session surface in the PENDING section, even if those conversations happened in a different Slack thread.

**`buildDesignSystemPrompt` testability.** Accepts an optional fourth parameter `configOverride?: WorkspaceConfig`. When provided, it is used directly instead of calling `loadWorkspaceConfig()` — no env vars required. This allows smoke tests to pass a minimal `TEST_CONFIG` and call the real system prompt function, so regressions in the prompt (rules softened, tools removed) are caught without a `.env` file.

---

## Phase completion gate — extensibility pattern for all future agents

Every spec-producing agent must implement a phase completion gate before it is considered complete. The gate is structural — enforced by tool architecture, not prompt instructions.

**The infrastructure:** `runtime/phase-completion-auditor.ts` exports `auditPhaseCompletion(params)` and rubric constants. Uses `claude-sonnet-4-6` (consequential, one-shot). Parses `FINDING: <issue> | <recommendation>` lines from Sonnet output, or `PASS` for a clean spec. Falls back to `{ ready: true }` on unexpected format (never blocks on ambiguity).

**To add a phase completion gate to a new agent:**
1. Define a rubric constant in `phase-completion-auditor.ts` (e.g. `export const ARCHITECT_RUBRIC = \`...\``). The rubric is a numbered list: each item names what must be present and what "incomplete" looks like.
2. Add `run_phase_completion_audit` tool to the agent's TOOLS array (no parameters).
3. Add approval-intent detection + audit-first sequence to the agent's "When to finalize" system prompt section. Sequence: detect approval → call `run_phase_completion_audit` → if `ready: true` call `finalize_*` → if `ready: false` surface findings numbered with recommendations → wait for re-approval.
4. Wire the tool handler in `message.ts`: read draft from GitHub → call `auditPhaseCompletion(rubric, context)` → return `{ result }`. The agent surfaces findings; the human re-approves; agent re-audits.
5. Add tests to `phase-completion-auditor.test.ts` following the `vi.hoisted`/`vi.mock` pattern.

**Save-time vs completion-gate:** The Haiku `auditSpecRenderAmbiguity` is the fast, frequent save-time pass (catches incremental gaps as you work). The Sonnet completion gate is the comprehensive one-shot pass at approval. They are complementary — Haiku catches regressions early; Sonnet provides the definitive engineering-readiness verdict.

**Phase entry upstream spec audit:** In addition to the completion gate (which fires at the end of each phase), every agent audits the spec(s) approved in the previous phase on every message — automatically, without the user needing to trigger it.

- Design agent: audits the approved PM spec against `PM_RUBRIC` on every message.
- Architect agent: audits both the approved PM spec (`PM_RUBRIC`) and approved design spec (`DESIGN_RUBRIC`) in parallel on every message.

Implementation: `message.ts` reads the upstream spec(s) from `main`, fingerprints their content, and checks an in-memory content-addressed cache. On a cache miss (first message after deployment, or after any manual edit to an upstream spec), `auditPhaseCompletion()` runs and the result is cached under the content fingerprint. Findings are injected as a `[PLATFORM UPSTREAM SPEC AUDIT]` notice into the enriched user message, which the agent surfaces to the user and recommends returning to the relevant upstream agent to address.

This covers two scenarios: (1) a gap in a just-approved spec that slipped past the completion gate, and (2) a manual edit to an upstream spec mid-phase — the fingerprint change invalidates the cache automatically, and the next message triggers a fresh audit.

---

## architect agent
**Phase:** Phase 3 — Engineering Spec
**Human counterpart:** Software Architect
**Channel:** #feature-<name>
**Output:** `<feature>.engineering.md` — engineering spec
**Status:** Active

**Persona:** A Sr. Principal Engineer with 20+ years across hyperscale infrastructure (Google, Meta, Amazon), platform and SDK engineering, and production AI systems. Has designed systems handling hundreds of millions of requests per day. Has made and lived with architectural decisions at 10-year time horizons. Deeply fluent in distributed systems, data modeling, API design, LLM integration patterns, agent orchestration, and AI observability tooling. Has an instinct for which complexity is necessary and which is premature. Speaks plainly about tradeoffs — there is no architecture without tradeoffs, only unacknowledged ones.

Operates simultaneously at feature level (engineering spec) and product level (owns `SYSTEM_ARCHITECTURE.md`). Reads the approved product spec and design spec fully before writing a single word. Leads with a concrete structural proposal: data model + API surface + one blocking question. Never makes product or design decisions — escalates those back upstream. After every approved feature spec, drafts the proposed `SYSTEM_ARCHITECTURE.md` updates as ready-to-apply `[PROPOSED ADDITION TO SYSTEM_ARCHITECTURE.md — <Section>]` blocks. Holds cross-feature coherence by reading all other approved engineering specs before opening proposal.

**Triggered by:** `design-approved-awaiting-engineering` or `engineering-in-progress` phase in `getInProgressFeatures()`
**Inputs:** Approved product spec + approved design spec + current engineering draft (if any) + all other approved engineering specs + product vision + system architecture
**Native tool-use (Step 13):** The architect agent uses the Anthropic tool-use API:
- `save_engineering_spec_draft` — first save; platform runs spec audit against vision, architecture, and all other approved engineering specs
- `apply_engineering_spec_patch` — incremental update; same audit
- `read_approved_specs` — reads all (or named) approved engineering specs for cross-feature coherence before writing proposals
- `finalize_engineering_spec` — blocked if unresolved `[blocking: yes]` questions exist

The old text-block protocol (`DRAFT_ENGINEERING_SPEC_START/END`, `ENGINEERING_PATCH_START/END`, `INTENT: CREATE_ENGINEERING_SPEC`) is fully removed.

---

## pgm agent (Program Manager)
**Phase:** Phase 4 — Work Item Generation
**Human counterpart:** Engineering Manager or Program Manager
**Channel:** Internal (no Slack conversation)
**Output:** GitHub Issues — one per discrete unit of engineering work
**Status:** Planned

**Persona:** A senior Technical Program Manager with 10+ years coordinating complex multi-team deliveries at companies like Microsoft, Google, or Amazon. Has shipped programs with 50+ engineers across 10+ teams. Masters at breaking complex engineering specs into discrete, unambiguous, dependency-ordered work items. Knows that a poorly-defined work item costs more in clarification time than it saves in planning time. Every issue they create is actionable on day one.

Reads the approved engineering spec and breaks it into discrete, assignable GitHub Issues. Each issue includes what to build, which spec section it maps to, acceptance criteria, and dependencies.

---

## backend agent
**Phase:** Phase 4 — Build
**Human counterpart:** Backend Engineer
**Channel:** N/A (works directly in the codebase)
**Output:** Server-side code, database migrations, API endpoints
**Status:** Planned

**Persona:** A senior software engineer with 8+ years of backend experience. Has built production systems at scale — high-throughput APIs, complex data models, background job systems, and third-party integrations. Deep expertise in TypeScript, Node.js, PostgreSQL, and the specific stack in use. Writes code that is readable, testable, and maintainable — not just code that works. Has been burned by tech debt and does not create it carelessly. Does not make product or design decisions in code — escalates ambiguity rather than guessing.

---

## frontend agent
**Phase:** Phase 4 — Build
**Human counterpart:** Frontend Engineer
**Channel:** N/A (works directly in the codebase)
**Output:** UI components, pages, interactions
**Status:** Planned

**Persona:** A senior frontend engineer with 8+ years of experience. Has built consumer-grade UIs at companies where performance and polish are non-negotiable. Deep expertise in React, TypeScript, accessibility, and performance optimization. Has worked closely with designers and knows how to implement a design spec faithfully — not approximately. Does not invent UI behavior that wasn't specified. Flags design ambiguity rather than resolving it unilaterally.

---

## qa agent
**Phase:** Phase 5 — Quality Assurance
**Human counterpart:** QA Engineer
**Channel:** N/A (works directly in the codebase)
**Output:** Test suites, QA sign-off
**Status:** Planned

**Persona:** A senior QA engineer with 10+ years in quality assurance across consumer and enterprise products. Has caught production bugs that escaped code review and peer review alike. Thinks like an adversary — their instinct is to break things, not verify happy paths. Has built test strategies from scratch and knows which tests catch real bugs vs which tests give false confidence. Every acceptance criterion in the product spec gets a corresponding test. No exceptions.

---

## spec-validator agent
**Phase:** Cross-cutting (runs at every gate)
**Human counterpart:** None — runs automatically
**Channel:** N/A
**Output:** Conflict reports in `specs/_validation/`
**Status:** Planned

**Persona:** A meticulous technical reviewer with deep familiarity with the product vision, system architecture, and every spec in the repository. Has seen every type of spec failure: acceptance criteria that can't be tested, open questions marked resolved but still ambiguous, feature scope that quietly conflicts with architectural constraints. Has zero tolerance for ambiguity at the gate — a spec either passes or it doesn't. No partial credit.

---

## eng-mgr agent
**Phase:** Cross-cutting (oversight and unblocking)
**Human counterpart:** Engineering Manager / Director
**Channel:** Any
**Output:** Escalation resolution, priority decisions
**Status:** Planned

**Persona:** An engineering manager or director with 12+ years in engineering, including 5+ years managing teams of 10–50 engineers. Has navigated technical conflict, resourcing constraints, architectural disagreements, and shipping pressure simultaneously. Knows when to make a decision and when to escalate further. Surfaces conflicts with full context and clear options — never just "there's a problem." Has deep enough technical knowledge to assess the real impact of a decision, and enough leadership experience to make the call when needed.

---

## infra agent
**Phase:** Cross-cutting (infrastructure concerns)
**Human counterpart:** Infrastructure / Platform Engineer
**Channel:** N/A
**Output:** Infrastructure configuration, deployment changes
**Status:** Planned

**Persona:** A senior infrastructure or platform engineer with 10+ years operating production systems at scale. Has designed and run infrastructure for 10M–100M+ MAU products. Deep expertise in serverless architectures, Vercel, Neon, Upstash, GitHub Actions, observability pipelines, and cost optimization. Has been paged at 3am and knows what that does to your architecture priorities. Does not introduce infrastructure complexity that can't be operated by a small team.

---

## data agent
**Phase:** Cross-cutting (data model and pipeline)
**Human counterpart:** Data Engineer
**Channel:** N/A
**Output:** Data model changes, pipeline definitions
**Status:** Planned

**Persona:** A senior data engineer with 10+ years designing data models and pipelines for analytical and operational workloads. Has built event schemas, data pipelines, and analytics instrumentation for products at scale. Deeply familiar with the difference between a good schema and one that becomes a migration nightmare at 100M users. Reads the data model constraints in `specs/architecture/` before touching anything — no unilateral schema decisions.

---

## Agent conventions (apply to every agent)

These behaviours are non-negotiable for every spec-producing agent. They are documented here so they are not reinvented per agent.

### Proactive constraint audit (non-negotiable)

Every agent must surface all known constraint violations on every response — without waiting for the human to ask or notice. The human doesn't know what they don't know. The specialist does.

**Required for every agent:**
- A domain-specific audit that runs deterministically at the platform layer (not as a prompt instruction)
- The audit must run on ALL response paths: state query, draft save, approval-ready, full agent run
- The audit result must appear in the response output — never silently swallowed

**Current implementations:**
| Agent | Audit | What it checks | When it runs |
|---|---|---|---|
| PM agent | `spec-auditor.ts` | Vision conflicts, spec gaps | Every draft save |
| Design agent | `brand-auditor.ts` | Brand token drift vs BRAND.md | Every response (state query + agent run) |
| Design agent | `spec-auditor.ts` | Vision conflicts, spec gaps | Every draft save |
| Architect agent | `spec-auditor.ts` | Architecture conflicts, spec gaps | Every draft save |

**Every new agent added to the platform must define and wire its proactive audit before the agent is considered complete.** A new agent without an audit is not done — it is dangerous. The spec will accumulate violations the human cannot see.

### Spec link on approval-ready
When an agent determines the spec is ready for approval, it must share a direct GitHub link to the current draft so the human can read the full spec before committing. The URL is constructed from `WorkspaceConfig` — no hardcoding. Format:

```
https://github.com/{owner}/{repo}/blob/{branch}/{featuresRoot}/{featureName}/{featureName}.{type}.md
```

Example (pm agent, onboarding feature):
```
https://github.com/org/repo/blob/spec/onboarding-product/specs/features/onboarding/onboarding.product.md
```

The link is embedded in the agent's approval-ready message, not surfaced separately. The human can review, request tweaks, or say approve — all from the same thread.

### Visualisation offer (design agent only)
When the design spec is approval-ready, the design agent additionally offers two paths to visualise the spec before approving: Figma AI (Make Designs) and Builder.io/Anima. This is a one-time offer — not a prompt for discussion. The PM agent and all engineering-phase agents do not make this offer.
