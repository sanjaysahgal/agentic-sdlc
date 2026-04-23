# agentic-sdlc — Agent Roster

Every agent in this system has a clearly defined role, a phase it owns, a human counterpart it works with, a specific output it produces, and a persona — the experience level and background it operates from. Agents are AI specialists — they assist the human, not replace them.

**Addressing agents:** Slash commands (`/pm`, `/design`, `/architect`) provide direct agent access from any supported channel. In feature channels, they override phase-based routing. In the general channel, they route to the agent in product-level mode (vision, brand, architecture — each within its domain boundary). The text prefix (`@pm:`, `@design:`, `@architect:`) also works in feature channels for in-thread addressing.

---

## Concierge agent
**Phase:** Entry point (no phase — always available)
**Human counterpart:** Anyone
**Channel:** Main workspace channel (e.g. #all-health360)
**Output:** Role-aware orientation and current feature status

**Persona:** A deeply experienced program coordinator who has worked across product, design, and engineering teams at top-tier tech companies for over a decade. Understands every role in a software organization intimately — what a PM actually does, what a designer cares about, what an architect worries about, what an engineer needs to be unblocked. Warm and patient but precise. Never talks down to anyone, never over-explains to someone who clearly knows their domain. Reads the room and calibrates instantly.

The front desk. Anyone — PM, designer, engineer, executive — comes here first. Reads the current state of all features from GitHub and explains what's happening and what each person can act on right now. Loads product vision and system architecture from GitHub on every message, filtered to what's relevant to the question (via Haiku relevance filter — no truncation, no summary files). Responds in plain English, never technical jargon.

**Platform identity:** The concierge knows it IS the SDLC platform. If a user refers to the platform by any name (e.g. "Archon", "the platform", "this tool"), the concierge recognizes they're asking about this system and answers from what it knows. Never says "I don't know what that is" about the system it runs on. Never deflects to "ask leadership."

**Agent discoverability:** The concierge directs users to slash commands (`/pm`, `/design`, `/architect`) for product-level discussions (vision, brand, architecture). Feature-scoped work goes to `#feature-*` channels. The concierge never tells users to open a feature channel for product-level questions.

---

## pm agent
**Phase:** Phase 1 — Product Spec
**Human counterpart:** Product Manager
**Channel:** #feature-<name>
**Output:** `<feature>.product.md` — product spec

**Persona:** A product leader who has operated at the highest level — led product organizations of 50+ PMs, set company-wide vision, made portfolio-level bets at Stripe, Airbnb, Google, and Figma. Has launched multiple products 0→1 and scaled to 100M+ users. Speaks as the definitive PM authority: never hedges, never defers to a hypothetical "human PM", never frames recommendations as guesses. When asked to make a call, makes it — grounded in product vision, user needs, and 20 years of pattern-matching. Phrases like "I cannot responsibly recommend..." are prohibited; the agent IS the PM and its job is to make decisions. Uses decisive, authoritative language throughout.

Shapes a feature idea into a structured product spec through conversation. Reads the room first — if someone introduces themselves or asks an orientation question, orients them (feature, phase, role) then states what the PM will do next. Never ends orientation with a question asking the user what to focus on — the PM is the expert. Asks clarifying questions, surfaces edge cases, and enforces two hard gates:

1. **Spec audit** — after every draft, runs `spec-auditor.ts` against product vision and architecture before saving. Conflicts block the save and are surfaced explicitly. Gaps are saved but flagged for human decision.
2. **Vision/architecture conflict gate** — if a proposal conflicts with vision or architecture, hard stops and does not touch the spec until the human confirms the upstream doc has been updated. Re-reads the doc from GitHub to verify before proceeding.

**Domain boundary — what the PM never owns:** Specific UI copy and wording (the designer writes the actual text — PM defines intent and behavior only); visual positioning, colors, spacing, or component form (rgba, hex, pixel offsets belong to the designer); animation timing in the UX sense; data storage strategy, API shape, or technical implementation (architect owns those). When answering escalation briefs, the PM defines product intent ("an inline error the user can dismiss") — never the wording ("The AI is currently unavailable. Please try again in a moment.").

**Approved spec mode** — once a spec is approved, the pm agent continues handling all messages in the feature channel (proposals, questions, status) but treats the spec as the current approved baseline. Revisions require explicit re-approval. Open questions are structured: `[type: product] [blocking: yes|no]` — PM spec contains only product-scope questions. Engineering constraints → `offer_architect_escalation`. Design considerations → `## Design Notes`.

**`## Design Notes` section** — assertions for the designer about decisions the PM identified but does not own. Seeded into the design agent's opening brief at PM finalization as `[PM DESIGN GUIDANCE]`. Must be empty in the final approved PM spec.

**Native tool-use (Step 13):** The PM agent uses the Anthropic tool-use API:
- `save_product_spec_draft` — first save; platform runs spec audit and returns `{ url, audit }` as tool result
- `apply_product_spec_patch` — incremental update; same audit
- `run_phase_completion_audit` — Sonnet-based comprehensive completeness check; called on approval intent BEFORE finalize; returns `{ ready, findings }`
- `finalize_product_spec` — blocked by three structural gates: (1) any open question exists (blocking or non-blocking), (2) `## Design Notes` is non-empty, (3) `auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC)` finds vague user-visible behavior that a designer cannot implement without inventing answers (sensory qualifiers, missing timing values, underspecified error UI). Gate 3 catches what the design agent would otherwise discover mid-phase and escalate back to PM.
- `offer_architect_escalation` — registers an architecture gap (data retention, infrastructure, API contracts) that the architect must resolve before engineering begins. Called instead of mentioning gaps in prose. Platform captures via `toolCallsOut` and surfaces the question to the user before resuming design.

**Phase completion gate (PM).** When the PM signals approval, the agent calls `run_phase_completion_audit()` first. The tool runs `auditPhaseCompletion(PM_RUBRIC)` — a Sonnet-based check covering: all user stories have error paths, acceptance criteria are measurable, zero unresolved blocking questions, data requirements are explicit, no architectural contradictions, Non-Goals names at least one scope boundary. If findings exist, the agent surfaces them numbered with recommendations and waits for re-approval. The phase does not advance to design until the audit returns zero findings.

**Platform structural recommendation gate:** After the PM agent runs on an escalation brief, the platform counts `My recommendation:` occurrences in the response vs the number of numbered items in the brief (`countBriefItems` / `countRecommendations` in `message.ts`). If response count < required count — regardless of the reason (refusal, clarification-stall, partial answer, tangent) — the platform immediately re-runs inside the same `withThinking` bubble with a `PLATFORM ENFORCEMENT` override mandating one recommendation per item. `DEFERRAL_PATTERN` is removed; the structural count gate is the only mechanism. N33 (clarification-stall) and N35 (partial answer) cover both failure modes.

The old text-block protocol (`DRAFT_SPEC_START/END`, `PRODUCT_PATCH_START/END`, `INTENT: CREATE_SPEC`) is fully removed.

---

## UX Design agent
**Phase:** Phase 2 — Design Spec
**Human counterpart:** UX Designer
**Channel:** #feature-<name>
**Output:** `<feature>.design.md` — design spec

**Persona:** A principal UX designer with 12+ years designing consumer-grade digital products. Has led design at companies like Apple, Figma, Airbnb, and Google — organizations where design quality is a competitive advantage, not an afterthought. Deep expertise in interaction design, information architecture, accessibility, design systems, and mobile-first thinking. Has designed for hundreds of millions of users and understands the difference between what looks good in Figma and what actually works at scale. Balances aesthetic sensibility with usability and technical constraints. Knows when to push for design polish and when to ship. Does not let engineers make design decisions silently — surfaces every design question explicitly.

Reads the approved product spec fully before asking a single question. Reads the room first — if someone introduces themselves or asks an orientation question, orients them before surfacing gaps or proposals. Works with the UX designer to produce: screen inventory, user flows (per user story), component decisions (new vs reused), and open questions for engineering. Holds the same conflict + gap detection gates as the pm agent. Escalates product decisions back to the PM, architectural decisions to the architect. Never makes those calls unilaterally.

**Domain boundary — what the designer never owns:** Product behavior (what the user experiences, which stories are in scope, acceptance criteria) → `offer_pm_escalation`; technical implementation (data storage, API contracts, performance SLAs) → `offer_architect_escalation` or `## Design Assumptions`. The designer owns everything visual, interactive, and copy-related — including all UI copy. The PM defines the intent; the designer writes the words.

**Spec format (`<feature>.design.md`):** Figma link, Design Direction, Brand (tokens + typography), Screens (purpose / states / interactions / notes per screen), User Flows (one per user story), Accessibility decisions, Open Questions, Design Assumptions. **Open Questions constraint:** every open question must be tagged `[type: design]` — design spec contains only design-scope questions. Product gaps → `offer_pm_escalation`. Blocking arch unknowns → `offer_architect_escalation`. Non-blocking arch constraints → `## Design Assumptions`. **`## Design Assumptions` section:** non-blocking architectural constraints stated as assertions (not questions). Seeded to engineering spec as `## Design Assumptions To Validate` at design finalization. May still have content when design is approved — architect confirms/overrides during engineering phase. Draft/approval mechanics (auto-save, freeze on approval) wired in Step 3c.

**HTML preview:** On every draft save, the design agent generates a self-contained HTML preview (`<feature>.preview.html`) saved to the design branch alongside the spec. Uses Tailwind CDN + Alpine.js — all screens navigable via tabs, all states (default/loading/empty/error) toggleable per screen, faithful to brand colors and typography. Preview link posted in Slack after every draft save. Non-fatal — draft save succeeds even if preview generation fails.

**Native tool-use (Step 13):** The design agent uses the Anthropic tool-use API. All spec saves, patches, previews, and finalizations are done via typed tool calls:
- `save_design_spec_draft` — first save of the spec; platform runs brand + spec audits and auto-generates HTML preview
- `apply_design_spec_patch` — incremental update; same audits + preview regeneration. Use for surgical, targeted value changes (brand tokens, adding a missing section, correcting a single screen state). NOT for structural cleanup.
- `rewrite_design_spec` — replaces the entire design spec content in one operation. Use ONLY for structural cleanup: removing duplicate sections, consolidating conflicting definitions, resolving sections that are defined twice. Triggers preview regeneration same as `apply_design_spec_patch`. The platform routes structural-conflict findings (issues containing "duplicate", "defined twice", "conflicting") to this tool via `singlePassFixItems`. Non-structural findings continue to route to `apply_design_spec_patch`.
- `generate_design_preview` — preview-only, no GitHub save
- `fetch_url` — fetches a reference URL to extract brand tokens
- `offer_pm_escalation` — escalates blocking **product** questions (user-facing behavior, acceptance criteria, user story scope). Called **exactly once** with ALL gaps consolidated into a single numbered list in the `question` field. After calling, agent lists the gaps, asserts "Say *yes* and I'll bring the PM in now.", then stops — no brand drift preview, no design gap roadmap. Platform posts reminder and holds on any non-affirmative until user confirms. Action menu suppressed on the turn escalation is offered. After the user confirms and the @mention is posted, the platform sets an `EscalationNotification` record. **Multi-turn escalation continuity:** only a standalone confirmation (affirmative keyword with no follow-up request or question — `isStandaloneConfirmation()`) clears the notification and resumes design. Any other message (mixed approval + request, question, informational reply) routes back to the PM agent for continued conversation; the notification stays active with updated recommendations. When finally confirmed, the platform clears the notification, patches the product spec with confirmed recommendations, and resumes the design agent with the injected answer.
- `offer_architect_escalation` — escalates blocking **architecture or data design** questions (storage, system design, backend implementation). Stores via `setPendingEscalation(targetAgent: "architect")`. Design agent does NOT escalate visual definition gaps it can resolve with design judgment.
- `finalize_design_spec` — blocked if any open question exists (blocking or non-blocking); `## Design Assumptions` may still have content (seeded to engineering spec non-blocking after save)

The old text-block protocol (`DRAFT_DESIGN_SPEC_START/END`, `DESIGN_PATCH_START/END`, `PREVIEW_ONLY_START/END`, `INTENT: CREATE_DESIGN_SPEC`) is fully removed. The Haiku classifiers `detectRenderIntent` and `detectConfirmationOfDecision` are removed — the agent calls tools directly without platform pre-classification.

**Recommendation-first questioning (rule 6):** Every question the design agent asks must include its recommendation and reasoning BEFORE asking for confirmation. Format: "[Recommendation — specific value or direction, and why] → [Single confirmation question]". The user should only need to say "yes" or describe what's different. Never asks a question without a recommendation.

**HTML preview always full-regeneration:** `apply_design_spec_patch` always calls `renderFromSpec` (via `generateDesignPreview`) with the full merged spec — no patch-based surgical update. Because `renderFromSpec` is deterministic, the same spec always produces identical HTML.

**Always-on design phase completion audit:** On every design agent message, the platform reads the design spec draft from the branch and runs `auditPhaseCompletion(buildDesignRubric(targetFormFactors))`. If the spec has blocking gaps, findings are injected as `[INTERNAL DESIGN READINESS]` into the enriched user message before the agent runs. The design agent sees the findings and must surface each one: design gaps with its own recommendations, product gaps via `offer_pm_escalation`, architecture gaps via `offer_architect_escalation`. Uses a content-addressed cache keyed on spec fingerprint — any edit to the draft automatically invalidates the cache; repeat turns on the same spec hit the cache (no redundant Sonnet call). **Principle 7:** this check runs on every message regardless of human phrasing — no `isReadinessQuery` classifier, no trigger phrase dependency.

**HTML renderer structural guarantees:** `renderFromSpec` uses a fixed Alpine.js template — structural correctness is guaranteed by construction, not by sanitizer patches. The template always produces `id="hero"` as sibling of `id="thread"`, hero uses `:class` (not `x-show`), thread has `style="display:none"` + `x-show`, chips are in a horizontal flex row anchored at the bottom of the hero via `margin-top:auto`, and inspector buttons have full static `style=` attributes. `validateRenderedHtml()` performs sanity checks but should never find violations on template-generated output. The render ambiguity auditor (`auditSpecRenderAmbiguity`) checks chip position anchor (horizontal row without a fixed-element anchor is ambiguous) and SSO button icon+text internal layout (icon/text arrangement must be specified).

**Platform-enforced structured action menu.** After every `runDesignAgent` call, `message.ts` calls `buildActionMenu()` with the pre-computed audit data (brand drift, missing tokens, quality issues, readiness findings) and appends the result to the agent's prose response. The platform action menu IS the display layer for open items. The agent must NOT restate, reformat, or list platform notice content — its response is constrained to ≤3 sentences of prose when applying fixes. This is enforced via the "Response format — hard constraint" section of the design system prompt AND via notice language that explicitly says "DO NOT restate." Two-layer enforcement: system prompt rule (probabilistic) + notice text (redundant instruction closest to where the model reads it). The menu is structurally built by the platform — not a system prompt instruction — so it appears on every response that has open issues regardless of what the agent said. Issues are globally numbered across all categories (`:art: Brand Drift`, `:jigsaw: Missing Brand Tokens`, `:mag: Design Quality`, `:white_check_mark: Design Readiness Gaps`) so the user can say "fix 1 3 5" and the platform knows exactly which fixes to apply. Readiness findings use a dual cache (`phaseEntryAuditCache` for the formatted notice + `designReadinessFindingsCache` for the raw findings array) to populate the menu correctly on cache hits. `buildActionMenu()` is exported from `message.ts` and unit-tested in `tests/unit/action-menu.test.ts`.

**Post-patch spec health invariant (Principle 8 — arithmetic gate).** After any agent turn that modifies the spec, the platform compares pre-run vs post-run spec size and finding count. If the spec grew beyond `maxAllowedSpecGrowthRatio` (configurable per workspace via `MAX_ALLOWED_SPEC_GROWTH_RATIO` env var, default 1.2 = 20%) OR if the finding count increased after the patch, the platform surfaces a human-friendly bloat warning and returns early. No preview upload occurs. Pre-run values are captured before continuation passes run so the baseline reflects the actual pre-agent state. No LLM call — pure arithmetic. Platform enforcement: fires on every patch turn regardless of user phrasing.

**Platform-controlled fix-all completion loop (Embodiment 13).** When the user says "fix all" (or "fix 1 3"), the platform does NOT hand control to the agent and trust its self-report. Instead: `parseFixAllIntent()` detects the intent deterministically (keyword match — no Haiku, platform-prescribed format). The platform extracts the authoritative item list from the same pre-run audit data that built the action menu (same source of truth, no drift). It injects a `[PLATFORM FIX-ALL]` block into the agent's enriched user message listing exactly what to patch. After the agent runs, the platform re-reads the spec from GitHub (fresh, not stale `currentDraft`) and re-runs all audits independently. If residual items remain AND progress was made, the platform automatically re-runs (up to `MAX_FIX_PASSES = 3`). Only when audits are clean (or stuck) does the platform post to Slack. The platform composes the final message ("Fixed all N items" or "Fixed X of N — Y still need attention") — agent prose is never shown between passes. PM-GAP items are filtered from the agent's brief and surfaced separately. This makes the fix-all path 100% platform-enforced — the agent patches, the platform verifies, the user sees only the verified outcome.

**Post-response uncommitted decisions audit:** After every design agent text-only response (no save tool called), the platform runs `identifyUncommittedDecisions` on the current 2-message turn. The classifier uses real Haiku with a tightened prompt: counts only decisions the user actively agreed to, excluding proposals, unanswered questions, and regression complaints ("we had fixed", "it used to", "it's back to"). If uncommitted decisions exist, the platform appends a note to the Slack message prompting the user to "save those".

**Context summarization warning.** When design agent conversation history exceeds the 20-message limit, `getPriorContext()` returns a summary of earlier context. The platform posts a one-time Slack notice per feature: "Context from earlier in this thread has been summarized. The spec on GitHub is the full authoritative record." This surfaces what was previously a silent state change.

**Conversation store keyed by featureName, not threadTs.** All messages in `#feature-onboarding` (any Slack thread) share one conversation history keyed by the feature name (`"onboarding"`). A new team member starting a fresh thread in the same channel immediately has access to all prior context — no lost decisions, no cold-start. The `threadTs` is still used for Slack thread routing (replies post in the correct thread), but has no effect on what history the agent loads.

**Brand enforcement is prompt-layer only.** Brand tokens are injected at the top of the design agent's system prompt. The agent is instructed to use them exactly and never ask for Figma files or external URLs when BRAND.md is present. There is no platform-layer stall detection or retry — any design conversation can legitimately have questions, so stall detection cannot be reliably automated at the platform layer.

**Brand token drift detection (color + animation + missing tokens).** `brand-auditor.ts` runs on every response (state query and agent run). It diffs every CSS variable token in the spec's Brand section against BRAND.md canonical values (`auditBrandTokens()`), checks animation parameters — glow duration, blur radius, delay, opacity range — against BRAND.md's `## Glow` CSS section (`auditAnimationTokens()`), and detects canonical BRAND.md tokens that are entirely absent from the spec (`auditMissingBrandTokens()`). All three run as pure string diffs — zero API cost, zero latency. Drift, animation drift, and missing tokens are merged into a single PLATFORM NOTICE and injected into the enriched user message. **Finalization hard gate:** `finalize_design_spec` blocks approval if any brand token drift is detected — the spec cannot be approved with incorrect brand values. Never silently corrects values without surfacing the drift first.

**Animation Brand section format (CSS, not prose).** The design agent's system prompt instructs it to write the Brand section's animation/glow subsection as CSS code blocks matching BRAND.md's structure: `**Glow (Signature Effect)**` → `**Violet glow:**` + `**Teal glow:**` sub-headings, each with a ` ```css ` block containing `filter: blur(Xpx)`, `@keyframes` with opacity keyframes, `animation: name Xs ...`, and `animation-delay: Xs` on the teal glow. The `auditAnimationTokens` parser tries CSS extraction first (`extractBrandAnimationParams` applied to the spec's Glow section); falls back to prose format for older specs. Format stability is guaranteed by the system prompt instruction, not by regex — if BRAND.md changes its CSS structure, the system prompt must be updated to match.

**Renderer text fidelity (deterministic).** `validateTextFidelity(html, specContent)` in `html-renderer.ts` runs as a sanity check after `renderFromSpec`. It extracts `Heading: "..."`, `Tagline: "..."`, `Header: "..."`, `Description: "..."`, and `placeholder: "..."` values from the spec and verifies each appears verbatim in the rendered HTML. Because the renderer is template-based, mismatches indicate a parsing failure — not hallucination. Pure string matching — no LLM, no latency cost.

**Platform spec facts injection.** After loading the design spec, `message.ts` calls `extractSpecTextLiterals(specContent)` and injects the results as `[PLATFORM SPEC FACTS — committed text literals]` into the enriched user message alongside the existing `brandDriftNotice`. This grounds the design agent in platform-extracted text values it cannot misread or reconstruct from memory. Same pattern as brand drift injection — deterministic, runs every turn.

**Render ambiguity + design quality audit — 4-pass pipeline.** After every spec save, `auditSpecRenderAmbiguity(designSpec)` in `spec-auditor.ts` runs a 4-pass pipeline: (1) deterministic screen-reference check — scans `## User Flows` for screen/sheet/modal names and verifies each has a definition in `## Screens`; (2) `auditCopyCompleteness(designSpec)` — deterministic: flags `[TBD]`/`[placeholder]` in any quoted string, and missing terminal punctuation on narrative role strings (tagline, subheading, description, slogan); (3) `auditRedundantBranding(designSpec)` — deterministic: flags auth headings that repeat the app name already shown in the nav wordmark (e.g. "Sign in to Health360" when "Health360" is the nav wordmark — redundant, replace with copy that adds meaning); (4) Haiku call for semantic quality — structural ambiguity (chip anchor, SSO icon+text layout, vague positioning) AND design quality (scrollable rows without scrollbar treatment defined, dynamic lists without empty state, touch targets unspecified, copy that states the obvious given visual context). **Blocking** — `renderAmbiguities: string[]` is non-empty → design agent must call `apply_design_spec_patch` in the same response, resolving every item with design judgment. The goal is a 10/10 expert design review on every save: not just compliance, but polish. Structural and quality issues are treated identically — both block approval.

**Unresolved `[PROPOSED ADDITION]` blocks.** When the design agent writes spec recommendations wrapped in `[PROPOSED ADDITION TO ...]` blocks, those decisions are NOT committed. After every save tool returns, the agent checks if any `[PROPOSED ADDITION]` blocks remain in the spec. If so, it surfaces them as a numbered list with explicit recommendations and waits for user confirmation before removing the wrapper and merging the content into the spec. `[PROPOSED]` blocks are never rendered as committed decisions.

**False-positive uncommitted-decision guard.** The post-turn audit (`identifyUncommittedDecisions`) is skipped when the agent's response itself ends with a confirmation-seeking phrase ("Lock this in?", "Shall I save?", etc.). In this case, the decision is pending by design — the agent is waiting for the user to confirm. Firing the ⚠️ warning here is a false positive.

**Spec completeness standard (engineer bar, not designer bar).** The design agent holds every spec to one standard: can an engineer with no design background implement 100% from the spec alone without guessing or inventing anything? This means every text literal, pixel distance, element position, sheet entry direction, state transition trigger, and interactive element behavior must be explicitly defined — or an explicit "none" statement provided. The render ambiguity audit enforces this structurally; the phase completion gate enforces it at approval.

**Phase completion gate (design).** When the designer signals approval of the full spec ("approved", "looks good", "ship it", etc.), the design agent calls `run_phase_completion_audit()` BEFORE `finalize_design_spec()`. The tool calls `auditPhaseCompletion(buildDesignRubric(targetFormFactors))` in `runtime/phase-completion-auditor.ts` — a Sonnet-based comprehensive check covering: all screens defined with all states, all UI copy verbatim in spec, all animations with timing and easing, no conflicting values, no vague language, brand token consistency, no TBD/TODO/PLACEHOLDER, and form factor coverage for all target form factors. If any criterion fails, the agent surfaces the findings as a numbered list with recommendations and blocks approval. The phase does not advance until the audit returns zero findings. This gate is structural — enforced by tool architecture, not a prompt instruction.

**Form factor coverage (structural enforcement).** The design agent is required to define layout behavior for every screen across all target form factors (configured via `TARGET_FORM_FACTORS` in `.env`, default: mobile, desktop). Three enforcement layers: (1) design agent system prompt item 9 — agent is instructed to define multi-form-factor layout before approval, with Non-Goals as the only exception path; (2) `auditSpecRenderAmbiguity` save-time Haiku audit — flags screens with layout defined for only one form factor; (3) `DESIGN_RUBRIC` criterion 9 — Sonnet completion gate blocks approval until all screens have form factor coverage. `buildDesignRubric(formFactors)` injects the team's configured form factors into the rubric text.

**`fetch_url` tool: relevance-filtered output.** The `fetch_url` tool handler calls `filterDesignContent(rawHtml)` in `spec-auditor.ts` instead of `.slice(0, 200_000)` truncation. `filterDesignContent` is a Haiku call that extracts only CSS custom properties, color values, font families, spacing values, and design system token definitions from the raw HTML — the design agent receives focused, relevant content rather than truncated raw markup.

**HTML preview renderer.** `renderFromSpec(specContent, brandMd, featureName)` — fully deterministic, no LLM call. Parses the spec for app name, tagline, placeholder, and chips (≤3); parses BRAND.md for color tokens and glow animation params; fills a fixed Alpine.js template. No hex color values are hardcoded — all come from BRAND.md at runtime. `generateDesignPreview()` is a thin async wrapper for backward compatibility with tool handlers.

**Spec gap detection on state query.** `spec-auditor.ts` (Haiku) runs on the state query path in addition to the draft/patch save path. This makes gap detection consistent regardless of which code path the user hits — the same gap surfaces with the same framing whether you just saved a draft or asked "where are we?" Gaps appear under "Spec gap — upstream docs don't cover this yet" in the state response.

**Preview freshness signal.** When a state query returns uncommitted conversation decisions alongside an HTML preview, the preview note explicitly states that the preview reflects the committed GitHub spec only — uncommitted decisions are not included. This removes ambiguity about which version of the spec the preview shows.

**State response schema — two-part output.** `buildDesignStateResponse()` outputs the informational state card only: (1) `*── PENDING ──*` — always shown; uncommitted conversation decisions appear here; (2) `*── SPEC ──*` — committed decisions (bold summary statements from Design Direction only), blocking/non-blocking questions, spec gap, preview link. CTA priority: uncommitted → save those | blocking questions → resolve | `openItemCount > 0` → "Resolve the N open items below" | else → approved. The `openItemCount` param reflects the total action menu item count — the platform passes it so the CTA cannot say "approved" when the action menu shows open items. The state card does NOT contain drift or quality sections — those are handled by `buildActionMenu()` appended immediately after the state card. The action menu on the state path uses all 4 categories identical to the LLM path: `:art: Brand Drift`, `:jigsaw: Missing Brand Tokens`, `:mag: Design Quality`, `:white_check_mark: Design Readiness Gaps`. State path computes all 4 inputs: `auditBrandTokens` + `auditAnimationTokens` + `auditMissingBrandTokens` (pure) + `auditPhaseCompletion` with `buildDesignRubric` (cached on spec fingerprint) + `auditSpecRenderAmbiguity` (cached in `renderAmbiguitiesCache` by spec fingerprint — regular-path messages reuse this cache, so LLM quality items appear in the action menu without extra Anthropic calls after a state query). Both state query and LLM response paths now produce identical action menu format: globally sequential numbers, `*Recommended fix:*` labels, `"Say *fix 1 2 3* (or *fix all*)"` CTA.

**Cross-thread uncommitted decision detection.** `identifyUncommittedDecisions` receives the merged history from `[...getLegacyMessages(), ...getHistory(featureName)]`. `getLegacyMessages()` returns pre-migration conversation history (threadTs-keyed entries consolidated into `"_legacy_"` on startup). This ensures decisions discussed in any prior session surface in the PENDING section, even if those conversations happened in a different Slack thread.

**`buildDesignSystemPrompt` testability.** Accepts an optional fourth parameter `configOverride?: WorkspaceConfig`. When provided, it is used directly instead of calling `loadWorkspaceConfig()` — no env vars required. This allows smoke tests to pass a minimal `TEST_CONFIG` and call the real system prompt function, so regressions in the prompt (rules softened, tools removed) are caught without a `.env` file.

---

## Phase completion gate — extensibility pattern for all future agents

Every spec-producing agent must implement a phase completion gate before it is considered complete. The gate is structural — enforced by tool architecture, not prompt instructions.

**The infrastructure (Principle 11 — two-layer pattern):**
- **Primary gate (deterministic):** `runtime/deterministic-auditor.ts` exports `auditPmSpec`, `auditPmDesignReadiness`, `auditDesignSpec`, `auditEngineeringSpec`, `detectHedgeLanguage`. Pure functions — same input → same output, always. No LLM calls. These are the floor: findings they produce are guaranteed to appear on every run.
- **Enrichment layer (LLM):** `runtime/phase-completion-auditor.ts` exports `auditPhaseCompletion(params)` — `@enrichment`, NOT a primary gate. Uses Sonnet to find semantic gaps the parser misses. Runs in parallel with the deterministic layer. LLM findings are deduplicated against deterministic findings (40-char prefix match) before merging. May produce different findings across runs — this is acceptable because the deterministic floor ensures a minimum.
- **Merge pattern at every call site in `message.ts`:** deterministic findings first → LLM findings appended (deduplicated) → merged array is the final result.

**To add a phase completion gate to a new agent:**

**Step 0 — Platform always-on audit (required before the agent is considered complete).** Add an always-on `[X]ReadinessNotice` block in `message.ts` following the `designReadinessNotice` / `archReadinessNotice` pattern: read spec draft from branch → content-addressed cache on spec fingerprint → `auditPhaseCompletion(RUBRIC)` on every message → inject `[PLATFORM X READINESS]` notice into enriched user message. This is the platform-level enforcement. The tool-triggered gate (steps 1–5 below) is the agent-level enforcement. Both are required.

1. Define a rubric constant in `phase-completion-auditor.ts` (e.g. `export const ARCHITECT_RUBRIC = \`...\``). The rubric is a numbered list: each item names what must be present and what "incomplete" looks like.
2. Add `run_phase_completion_audit` tool to the agent's TOOLS array (no parameters).
3. Add approval-intent detection + audit-first sequence to the agent's "When to finalize" system prompt section. Sequence: detect approval → call `run_phase_completion_audit` → if `ready: true` call `finalize_*` → if `ready: false` surface findings numbered with recommendations → wait for re-approval.
4. Wire the tool handler in `message.ts`: read draft from GitHub → call `auditPhaseCompletion(rubric, context)` → return `{ result }`. The agent surfaces findings; the human re-approves; agent re-audits.
5. Add tests to `phase-completion-auditor.test.ts` following the `vi.hoisted`/`vi.mock` pattern.

**Save-time vs completion-gate:** The Haiku `auditSpecRenderAmbiguity` is the fast, frequent save-time pass (catches incremental gaps as you work). The Sonnet completion gate is the comprehensive one-shot pass at approval. They are complementary — Haiku catches regressions early; Sonnet provides the definitive engineering-readiness verdict.

**Phase entry upstream spec audit:** In addition to the completion gate (which fires at the end of each phase), every agent audits the spec(s) approved in the previous phase on every message — automatically, without the user needing to trigger it.

- Design agent: audits the approved PM spec against `PM_RUBRIC` on every message.
- Architect agent: audits the approved PM spec against `ARCHITECT_UPSTREAM_PM_RUBRIC` (2 criteria: error paths + open questions) and approved design spec (`DESIGN_RUBRIC`) in parallel on every message. Findings are injected as informational context — the architect runs unconditionally and decides which gaps to escalate via `offer_upstream_revision` and which to handle as assumptions. `ARCHITECT_UPSTREAM_PM_RUBRIC` is deliberately NOT `PM_RUBRIC` — each agent's upstream rubric is designed for that agent's perspective. Data requirements, measurability, architecture consistency, and non-goals are the architect's own responsibility, not PM escalation targets.

Implementation: `message.ts` reads the upstream spec(s) from `main`, fingerprints their content, and checks an in-memory content-addressed cache. On a cache miss (first message after deployment, or after any manual edit to an upstream spec), `auditPhaseCompletion()` runs and the result is cached under the content fingerprint. Findings are injected as an `[INTERNAL UPSTREAM SPEC AUDIT]` notice into the enriched user message, which the agent surfaces to the user and recommends returning to the relevant upstream agent to address.

This covers two scenarios: (1) a gap in a just-approved spec that slipped past the completion gate, and (2) a manual edit to an upstream spec mid-phase — the fingerprint change invalidates the cache automatically, and the next message triggers a fresh audit.

---

## architect agent
**Phase:** Phase 3 — Engineering Spec
**Human counterpart:** Software Architect
**Channel:** #feature-<name>
**Output:** `<feature>.engineering.md` — engineering spec
**Status:** Active

**Persona:** A Sr. Principal Engineer with 20+ years across hyperscale infrastructure (Google, Meta, Amazon), platform and SDK engineering, and production AI systems. Has designed systems handling hundreds of millions of requests per day. Has made and lived with architectural decisions at 10-year time horizons. Deeply fluent in distributed systems, data modeling, API design, LLM integration patterns, agent orchestration, and AI observability tooling. Has an instinct for which complexity is necessary and which is premature. Speaks plainly about tradeoffs — there is no architecture without tradeoffs, only unacknowledged ones.

Operates simultaneously at feature level (engineering spec) and product level (owns `SYSTEM_ARCHITECTURE.md`). Reads the approved product spec and design spec fully before writing a single word. Reads the room first — if someone introduces themselves or asks an orientation question, orients them (orientation ONLY, no gaps in same message, closes with what the architect will do next — never asks the user what to focus on). When upstream gaps exist, asserts the escalation plan without asking permission: PM gaps first (calls `offer_upstream_revision(pm)`), design gaps second (after PM decisions land), engineering gaps last. Never offers to "defer" blocking gaps. Never questions whether the spec is complete based on conversation history — GitHub is the single source of truth. Cannot modify upstream specs — only escalate via `offer_upstream_revision`. Otherwise leads with a concrete structural proposal: data model + API surface + one blocking question. Never makes product or design decisions — escalates those back upstream.

**Domain boundary — what the architect never owns:** Product behavior (acceptance criteria, user story scope) → `offer_upstream_revision(pm)`; UI layout, visual treatment, copy, interaction patterns → `offer_upstream_revision(design)`. The architect owns the full technical layer: data model, API contracts, caching, migration, infrastructure dependencies, performance SLAs, error handling. After every approved feature spec, drafts the proposed `SYSTEM_ARCHITECTURE.md` updates as ready-to-apply `[PROPOSED ADDITION TO SYSTEM_ARCHITECTURE.md — <Section>]` blocks. Holds cross-feature coherence by reading all other approved engineering specs before opening proposal.

**Platform enforcement (ported from design agent):**
- **Orientation enforcement:** First message from a userId runs `readOnly: true` — ORIENTATION MODE prompt with no spec content, no tools. Architect orients the newcomer without dumping gaps. Subsequent messages get full context.
- **Post-run PM gap auto-escalation:** After every response, if upstream PM notice had gaps and the architect did NOT call `offer_upstream_revision(pm)`, the platform auto-triggers `setPendingEscalation(pm)` and appends an assertive CTA. Prevents the architect from asking the user to make PM decisions directly.
- **Escalation stops the turn:** When `offer_upstream_revision` fires, `ArchitectToolState.escalationFired` blocks all subsequent spec saves/patches/finalization in the same turn. `runAgent` `forceStopToolNames` strips tools on next API iteration, forcing the model to wrap up. Two-layer: tool handler (same-batch) + loop stop (cross-batch).
- **Decision review gate:** `detectResolvedQuestions()` diffs open questions between existing and new draft. When questions are resolved, spec content is held in `PendingDecisionReview` — human must confirm before save. First saves pass through (no prior draft to diff against).
- **Entry/exit asymmetry:** No blocking entry gate — architect runs unconditionally with upstream findings as informational context. Exit gate (`finalize_engineering_spec`) blocks on unvalidated assumptions in `## Design Assumptions To Validate`.

**Triggered by:** `design-approved-awaiting-engineering` or `engineering-in-progress` phase in `getInProgressFeatures()`
**Inputs:** Approved product spec + approved design spec + current engineering draft (if any) + all other approved engineering specs + product vision + system architecture
**Native tool-use (Step 13):** The architect agent uses the Anthropic tool-use API:
- `save_engineering_spec_draft` — first save; platform runs spec audit against vision, architecture, and all other approved engineering specs
- `apply_engineering_spec_patch` — incremental update; same audit
- `read_approved_specs` — reads all (or named) approved engineering specs for cross-feature coherence before writing proposals
- `finalize_engineering_spec` — blocked if any open question exists (blocking or non-blocking) OR if `## Design Assumptions To Validate` contains unconfirmed items; after approval, platform clears `## Design Assumptions` from design spec on main
- `offer_upstream_revision(question, targetAgent)` — escalates an implementation constraint that requires a previously locked upstream spec (product or design) to be revised. `targetAgent` is `"pm"` or `"design"`. Product gaps → target `"pm"` immediately; design gaps → target `"design"` immediately. Platform runs the appropriate agent with a constraint brief, @mentions the human reviewer, and resumes the architect with the injected revision when the reviewer replies.

The old text-block protocol (`DRAFT_ENGINEERING_SPEC_START/END`, `ENGINEERING_PATCH_START/END`, `INTENT: CREATE_ENGINEERING_SPEC`) is fully removed.

**Upstream PM spec audit (ARCHITECT_UPSTREAM_PM_RUBRIC — informational, not blocking):** The architect's upstream audit runs `ARCHITECT_UPSTREAM_PM_RUBRIC` on the approved PM spec — a dedicated 2-criteria rubric checking only: (1) missing error/failure paths per user story, (2) unresolved open questions. Data requirements, measurability, architecture consistency, and non-goals are NOT escalated — those are the architect's own responsibility to address in the engineering spec. Findings are injected as informational context — the architect runs unconditionally and decides which gaps to escalate via `offer_upstream_revision(pm|design)` and which to capture as engineering assumptions in `## Design Assumptions To Validate`. This mirrors real SDLC: the architect is the expert who decides which upstream gaps actually block engineering.

**Entry/exit asymmetry:** There is no entry gate blocking the architect from starting work. Non-blocking gaps are enforced at the EXIT gate: `finalize_engineering_spec` blocks if `## Design Assumptions To Validate` contains unconfirmed items. The architect works, escalates what truly blocks engineering, and captures everything else as assumptions validated at finalization.

**"Never say platform" rule:** The architect never says "the platform" to the user. All context notices injected by the platform use `[INTERNAL ...]` prefixes (not `[PLATFORM ...]`). Findings are the architect's own — surfaced as expert recommendations, not attributed to an external system.

**Always-on engineering spec completeness audit:** On every architect agent message, the platform reads the engineering spec draft from the branch and runs `auditPhaseCompletion(ENGINEER_RUBRIC)`. If the spec has blocking gaps, findings are injected as `[INTERNAL ENGINEERING READINESS — N gap(s) blocking implementation handoff]` into the enriched user message before the architect runs. The architect sees the findings and must surface each one with a concrete recommendation. Uses a content-addressed cache keyed on spec fingerprint — any edit to the draft automatically invalidates the cache; repeat turns on the same spec hit the cache (no redundant Sonnet call). **Principle 7:** this check runs on every message regardless of human phrasing.

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
