# archcon Test Plan

**424 tests across 24 files — all passing**

Run: `npx vitest run`

Smoke tests (real API, not in CI): `npm run test:smoke`

---

## Strategy

Mock only the two external boundaries: `@octokit/rest` (GitHub API) and `@anthropic-ai/sdk` (Anthropic API). Everything else — routing logic, conversation state, agent system prompts, spec detection helpers — runs real. Tests that mock internal functions only verify the wrong things; tests that run real internals catch real bugs.

**Single-turn tests** call `handleFeatureChannelMessage` once and assert the output. **Multi-turn tests** call it two or three times in sequence, sharing in-memory state between calls to simulate how a real Slack conversation evolves.

---

## Fixture Rule

**Any parser that reads agent output must be tested against real agent output sourced from actual agent responses.**

Hand-crafted inline strings are a liability — they encode format assumptions that diverge from what agents actually produce. The brand auditor bug (March 2026) passed all unit tests because fixtures used `--token: #HEX` (assumed format) while the agent actually writes `` `--token:` `#HEX` `` (backtick-span format). The parser produced zero results silently in production.

**Fixtures live in `tests/fixtures/agent-output/`.**

| File | Source | Tests that use it |
|---|---|---|
| `brand-md.md` | Real BRAND.md format | `brand-auditor.test.ts` |
| `design-brand-section-drifted.md` | Real design agent spec Brand section, drifted values | `brand-auditor.test.ts` |
| `design-brand-section-canonical.md` | Real design agent spec Brand section, canonical values | `brand-auditor.test.ts` |
| `pm-draft-spec-block.md` | Real PM agent DRAFT_SPEC_START/END response | pending |
| `design-patch-block.md` | Real design agent DESIGN_PATCH_START/END response | pending |
| `architect-draft-engineering-spec-block.md` | Real architect DRAFT_ENGINEERING_SPEC_START/END response | pending |

**When adding a new parser:** commit a sourced fixture to `tests/fixtures/agent-output/` before writing the test. If you can't source a real sample yet, mark the test with a `// TODO: replace with sourced fixture` comment and open a backlog item.

---

## Smoke Tests (`tests/smoke/`)

**What they catch that unit tests cannot:** model format drift. If the Anthropic model changes how it outputs a Brand section, color tokens, or animation values, unit tests pass (they run against static fixtures) but the production parser silently returns empty. Smoke tests catch this.

**How they work:** Send a prompt to the real API instructing the model to output specific drifted values. Assert that `auditBrandTokens` and `auditAnimationTokens` detect those exact drifts. If the model starts formatting its output differently, the parsers will return empty and these tests fail — exposing the format change before it hits production.

**Run:** `npm run test:smoke` (requires real `ANTHROPIC_API_KEY`). Not in CI — incurs API cost and requires live credentials.

**When to run manually:**
- After any change to `brand-auditor.ts` parsers
- After a model upgrade (check `ANTHROPIC_API_KEY` model)
- When a production report suggests drift detection isn't working

| File | What it tests |
|---|---|
| `tests/smoke/parser-format.test.ts` | Brand token format + all 5 animation params against real Haiku output |

---

## Layer 1: Unit Tests

Pure function and module tests. No I/O, no routing, no Anthropic calls.

### `tests/unit/workspace-config.test.ts` — 8 tests

`loadWorkspaceConfig` — the only coupling point between the platform and a customer's environment.

- throws when PRODUCT_NAME is missing
- throws when GITHUB_OWNER is missing
- throws when GITHUB_REPO is missing
- returns config when required vars are set
- uses default mainChannel when SLACK_MAIN_CHANNEL is unset
- uses SLACK_MAIN_CHANNEL when set
- uses default spec paths when PATH_* overrides are unset
- accepts PATH_* overrides for custom repo structures

### `tests/unit/conversation-store.test.ts` — 15 tests

Per-thread state: conversation history, confirmed agent, escalation state.

- getHistory returns empty array for unknown thread
- appendMessage adds message to thread history
- appendMessage is additive — second call appends, does not replace
- thread isolation — messages in thread A do not appear in thread B
- getConfirmedAgent returns null initially
- setConfirmedAgent stores agent and getConfirmedAgent retrieves it
- setConfirmedAgent calls fs.writeFileSync to persist
- clearHistory removes thread history
- clearHistory removes confirmed agent for thread
- clearHistory calls fs.writeFileSync to persist cleared state
- startup does not throw when .confirmed-agents.json does not exist
- getPendingEscalation returns null when no escalation is set
- setPendingEscalation stores escalation and getPendingEscalation retrieves it
- clearPendingEscalation removes the escalation
- escalation is thread-isolated — clearing thread-1 does not affect thread-2

### `tests/unit/thinking.test.ts` — 7 tests

`withThinking` — posts a placeholder, runs the agent, updates with the response. Handles all error paths without crashing.

- posts placeholder immediately then updates with response
- on error: logs structured JSON with all required fields
- on error: updates placeholder with user-facing error message
- on context-limit error: shows actionable thread-restart message not generic
- on overloaded error: shows overloaded message not generic
- on image error: shows image-specific message
- truncates responses over 39000 chars at paragraph boundary
- always calls decrementActiveRequests in finally — even on error

### `tests/unit/agent-router.test.ts` — 30 tests

All Haiku-based classification functions used for routing decisions.

**detectPhase** (channelState flags → phase enum)
- returns briefing when product spec is not approved
- returns engineering when product spec is approved but engineering spec is not
- returns implementation when both specs are approved
- ignores engineeringSpecApproved when productSpecApproved is false

**classifyIntent** (user message → agent name)
- returns valid agent type when Claude responds with known agent name
- falls back to pm when Claude returns an unknown agent name

**classifyApprovedPhaseIntent** (user message in post-approval phase → intent)
- returns start-design when Claude responds with start-design
- returns spec-query when Claude responds with spec-query
- returns proposal when Claude responds with proposal
- returns status when Claude responds with status
- falls back to status on unexpected Claude response

**classifyMessageScope** (user message → product-context or feature-specific)
- returns product-context when Claude classifies as product-level
- returns feature-specific when Claude classifies as feature-level
- falls back to feature-specific on unexpected Claude response

**isOffTopicForAgent** (user message → on/off topic for the current agent's domain)
- returns true for cross-feature global status query (off-topic for design agent)
- returns false for this-feature design spec query — on-topic even if read-only
- returns false for design question (on-topic)
- returns false for engineering question (on-topic)
- falls back to on-topic (false) on unexpected Claude response — do not block on-topic work
- passes the correct domain label to Haiku for design
- passes the correct domain label to Haiku for engineering

**isSpecStateQuery** (user message → is the user asking for spec status?)
- returns true for 'current state?' query
- returns true for 'where are we' query
- returns true for 'are you there' check-in — routes to state fast-path not full agent
- returns false for specific section query ('open questions?')
- returns false for 'show me the flows' — specific content request
- returns false for actual design question
- returns false for a proposal
- returns false for 'yes please and I assume...' — affirmation containing 'spec' is not a state query
- returns false for 'lets lock option A' — decision confirmation is not a state query
- falls back to false on unexpected Claude response — don't block real work
- prompt includes check-in patterns in TRUE examples

### `tests/unit/pm-agent.test.ts` — 19 tests

PM agent helper functions: intent detection, spec extraction.

**isCreateSpecIntent**
- returns true when response contains INTENT: CREATE_SPEC
- returns false when marker is absent
- returns false for partial match (marker must be exact)

**hasDraftSpec**
- returns true when both markers are present
- returns false when only start marker is present
- returns false when only end marker is present
- returns false when neither marker is present

**extractDraftSpec**
- extracts spec content between the markers
- trims whitespace from extracted content
- returns empty string when markers are absent

**extractSpecContent**
- extracts content from first fenced code block
- falls back to full response minus INTENT marker when no code block

**buildPmSystemPrompt**
- includes a GitHub link to the draft spec when the spec is approval-ready
- requires Product Vision Updates section in every approved spec — non-negotiable enforcement
- enforces Product Vision Updates section — explicitly states it is required in every spec
- cross-feature coherence — reads previously approved product specs before every response
- injects approved feature specs when provided
- states first feature message when no approved specs available

### `tests/unit/design-agent.test.ts` — 58 tests

Design agent helper functions, system prompt rules, escalation markers.

**buildDesignSystemPrompt** — prompt content rules
- question is last — prompt instructs agent not to trail with a closing line after the question
- leads with proposal — prompt instructs agent to open with a structural opinion, not discovery questions
- enforces flows before screens
- enforces states before components
- includes featureName in channel scope
- redirects out-of-scope questions to main channel
- injects approved product spec when present
- warns when no approved product spec found
- read-only mode suppresses draft and approval markers
- prohibits permission-asking — shall I, would you like me to, want me to, happy to, what would you like to do
- prohibits ASCII tables — no pipe-and-dash markdown tables in Slack responses
- auto-save rule triggers after every agreed decision, not just when spec is substantial
- short reply re-read rule — re-read last question before interpreting a short reply
- requires Design System Updates section in every approved spec — non-negotiable enforcement
- enforces Design System Updates section — explicitly states it is required in every spec
- PRODUCT_SPEC_UPDATE instruction present — design agent can propose product spec changes when PM authorizes direction change
- post-draft sign-off — prompt instructs agent to end with 'Draft saved to GitHub. Review it and say approved'

**isCreateDesignSpecIntent**
- returns true when response contains INTENT: CREATE_DESIGN_SPEC
- returns false when marker is absent
- returns false for product spec marker

**hasDraftDesignSpec** / **extractDraftDesignSpec** / **extractDesignSpecContent**
- (7 tests covering presence detection, extraction, trimming, code block fallback)

**Cross-phase escalation helpers**
- hasEscalationOffer: returns true when both escalation markers are present
- hasEscalationOffer: returns false when markers are absent
- hasEscalationOffer: returns false when only start marker is present
- extractEscalationQuestion: extracts the question between markers
- extractEscalationQuestion: returns empty string when markers not present
- extractEscalationQuestion: trims whitespace from extracted question
- stripEscalationMarker: removes the escalation marker block from the response
- stripEscalationMarker: preserves the user-visible offer text
- stripEscalationMarker: returns unchanged string when no marker present
- buildDesignSystemPrompt — escalation instruction: instructs the agent to emit OFFER_PM_ESCALATION marker for blocking product questions
- buildDesignSystemPrompt — escalation instruction: tells agent to offer escalation only for product decisions, not engineering or design calls

**PM-authorized product spec update helpers**
- hasProductSpecUpdate: returns true when both markers present
- hasProductSpecUpdate: returns false when only start marker present
- hasProductSpecUpdate: returns false when neither marker present
- hasProductSpecUpdate: returns false when design draft markers present but not product spec markers
- extractProductSpecUpdate: extracts content between product spec update markers
- extractProductSpecUpdate: trims whitespace from extracted content
- extractProductSpecUpdate: returns empty string when markers absent
- buildDesignSystemPrompt — product spec update instruction: instructs agent to emit PRODUCT_SPEC_UPDATE markers when PM authorizes direction change
- buildDesignSystemPrompt — product spec update instruction: tells agent to include complete updated product spec, not a diff
- buildDesignSystemPrompt — product spec update instruction: instructs agent to end post-draft message with 'say *approved*'
- buildDesignSystemPrompt — product spec update instruction: prohibits 'All locked decisions saved' phrasing after draft save

**buildDesignSystemPrompt — approval-ready message**
- prompt includes a direct link to the design spec on GitHub
- prompt tells agent an HTML preview has been saved alongside the spec
- prompt tells agent to direct designer to Slack message for preview link

**buildDesignStateResponse** — spec status summary message
- includes the spec URL
- shows screen and flow counts
- includes preview note when provided and nothing is blocking
- omits preview note when not provided
- CTA says 'approved' and mentions engineering
- lists non-blocking questions without type/blocking metadata tags
- shows blocking warning when blocking questions exist
- handles no open questions — says ready to approve
- handles no draft — prompts to start

### `tests/unit/architect-agent.test.ts` — 31 tests

Architect agent helper functions and system prompt rules.

**buildArchitectSystemPrompt** — prompt content rules
- includes featureName in the prompt
- leads with a structural proposal — data model and API surface in opening
- enforces data model first — no API discussion before data model agreed
- enforces one question at a time
- prohibits permission-asking phrases
- requires system architecture updates section in every approved spec
- mandates auto-save after every agreed decision
- names the DRAFT block markers
- names the approval marker
- redirects out-of-scope questions to main channel
- injects approved spec chain when present
- warns when no approved specs found
- injects approved engineering specs for cross-feature coherence
- notes no prior engineering specs when none exist
- read-only mode activates READ-ONLY MODE block
- read-only mode prohibits DRAFT and INTENT markers
- includes a direct link to the engineering spec on GitHub

**isCreateEngineeringSpecIntent** / **hasDraftEngineeringSpec** / **extractDraftEngineeringSpec** / **extractEngineeringSpecContent**
- (14 tests covering presence detection, extraction, trimming, code block fallback, cross-spec marker isolation)

### `tests/unit/concierge.test.ts` — 13 tests

Concierge system prompt content — the main-channel status agent.

- includes productName from workspace config — not hardcoded
- reflects productName change without code change (config is the only coupling point)
- includes product vision context when provided
- includes system architecture context when provided
- does not use markdown table syntax — Slack formatting only
- describes product-spec-in-progress correctly
- describes product-spec-approved-awaiting-design correctly
- describes design-in-progress correctly
- describes design-approved-awaiting-engineering correctly
- describes engineering-in-progress correctly
- includes 'no features' message when feature list is empty
- lists every agent in ACTIVE_AGENTS registry — fails if a new agent is added without updating the concierge
- includes all in-progress features in the prompt

### `tests/unit/github-client.test.ts` — 47 tests

GitHub API wrapper: file reads, spec saves, branch management, phase detection, preview URLs, PRs, feedback.

**readFile**
- decodes base64 content and returns string
- returns empty string when GitHub API throws (file not found)
- passes ref parameter when provided
- does not pass ref when not provided

**saveDraftSpec**
- creates branch spec/{featureName}-product from main SHA
- does not throw when branch already exists (createRef throws)
- saves file with base64-encoded content
- omits sha when file is new (create path)
- includes file sha when file already exists on branch (update path)

**saveApprovedSpec**
- returns 'already-on-main' and updates in place when file exists on main
- returns 'saved' and delegates to saveDraftSpec when file is not on main

**getInProgressFeatures** — phase detection from GitHub branch state
- returns empty array when no spec branches exist
- returns product-spec-in-progress when branch exists but product spec not on main
- returns product-spec-approved-awaiting-design when product spec on main, no design spec, no design branch
- returns design-in-progress when product spec on main and design branch exists
- returns design-approved-awaiting-engineering when design spec on main but no engineering branch
- returns engineering-in-progress when design spec on main and engineering branch exists
- skips feature when engineering spec already on main (build phase)
- ignores non-spec branches
- returns design-in-progress when only design branch exists (product branch deleted after approval)

**saveDraftEngineeringSpec / saveApprovedEngineeringSpec**
- creates branch spec/{featureName}-engineering from main SHA
- does not throw when branch already exists
- returns 'already-on-main' and updates in place when file exists on main
- returns 'saved' and delegates to saveDraftEngineeringSpec when file is not on main

**listSubdirectories**
- returns directory names from the path
- filters out files — returns only directories
- returns empty array when path does not exist
- returns empty array when response is not an array (single file returned)
- returns empty array on GitHub API timeout

**buildPreviewUrl**
- builds an htmlpreview.github.io URL for the design branch
- uses spec/{featureName}-design branch
- includes featureName in the file path

**createSpecPR**
- creates branch, commits file, opens PR, and returns PR URL

**saveAgentFeedback**
- creates a GitHub issue with agent-feedback label
- includes submittedBy in the issue body when provided
- does not throw when GitHub API fails — non-fatal

**saveUserFeedback**
- appends a new JSONL line when file does not exist yet
- appends to existing content when file already exists
- does not throw when GitHub API fails — non-fatal

### `tests/unit/claude-client.test.ts` — 8 tests

`runAgent` — the core Anthropic API call with history sanitization, image support, and history truncation.

- returns text from first content block
- returns empty string when first content block is not text
- passes systemPrompt as cached system block
- appends userMessage as final user turn after history
- strips leading assistant messages from history to satisfy Anthropic API constraint
- collapses consecutive same-role messages — keeps the later one
- includes image blocks before text when userImages are provided
- truncates history to last 40 messages before the new user turn

### `tests/unit/html-renderer.test.ts` — 6 tests

`generateDesignPreview` — generates self-contained HTML from a design spec.

- returns HTML content from Claude response
- strips leading ```html fence if model adds one
- strips leading ``` fence without language tag
- passes featureName and specContent to Claude
- uses claude-sonnet-4-6 model
- returns empty string when first content block is not text

### `tests/unit/context-loader.test.ts` — 22 tests

Context loading for each agent type: reads the right files from GitHub, assembles the right context shape.

**loadAgentContext** (PM)
- returns productVision and systemArchitecture from readFile
- returns empty strings for docs when readFile returns empty
- loads current draft from feature branch when featureName is provided
- sets currentDraft to empty string when no featureName provided
- reads draft from correct path: {featuresRoot}/{name}/{name}.product.md on spec branch
- loads approved product specs from other features for cross-feature coherence
- returns empty approvedFeatureSpecs when no other features exist
- returns empty approvedFeatureSpecs and does not hang when listSubdirectories never resolves

**loadDesignAgentContext**
- loads design system doc into designSystem field
- sets designSystem to empty string when no DESIGN_SYSTEM.md exists
- combines approved product spec and design draft into currentDraft
- reads design draft from spec branch
- loads approved design specs from other features for cross-feature coherence

**loadArchitectAgentContext**
- combines product spec, design spec, and engineering draft into currentDraft
- reads engineering draft from spec branch
- loads approved engineering specs from other features for cross-feature coherence
- sets featureConventions to empty string (architect doesn't use conventions doc)

**loadAgentContextForQuery** / **summarizeForContext**
- returns Haiku-filtered content for a query
- sets currentDraft and featureConventions to empty string
- skips Haiku call and returns empty string when doc is empty
- uses claude-haiku-4-5-20251001 model for summarization

### `tests/unit/spec-auditor.test.ts` — 9 tests

`auditSpecDraft` — Haiku call that checks a draft spec for conflicts or gaps with the product vision, system architecture, and (when provided) the feature-level product spec.

- returns ok immediately when both productVision and systemArchitecture are empty — no API call
- returns ok immediately when productVision, systemArchitecture, AND productSpec are all empty — no API call
- returns ok when Claude responds OK
- returns conflict with stripped message when Claude responds CONFLICT
- returns gap with stripped message when Claude responds GAP
- returns ok on unexpected Claude response format — does not block save
- uses claude-haiku-4-5-20251001 model
- includes productSpec in the audit prompt when provided
- omits productSpec section from prompt when not provided

### `tests/unit/spec-patcher.test.ts` — 7 tests

`applySpecPatch` — merges a section-level patch into an existing spec.

- returns patch as-is when existing is empty
- returns patch as-is when existing is whitespace only
- replaces a matching section in the existing spec
- preserves sections not mentioned in the patch
- appends new sections not in the existing spec
- preserves preamble (# heading, metadata lines before first ##)
- handles patch with only one section
- handles subsections (### headings) — treats ## section as atomic unit

### `tests/unit/spec-utils.test.ts` — 5 tests

`extractBlockingQuestions` — parses `[blocking: yes]` annotations from spec text.

- returns empty array when no blocking questions exist
- extracts a single blocking question
- extracts multiple blocking questions and ignores non-blocking ones
- strips leading list markers from extracted questions
- returns empty array for spec with no open questions section

---

## Layer 2: Integration Tests

Full `handleFeatureChannelMessage` calls with real routing, real state, mocked external APIs.

### `tests/integration/message-handler.test.ts` — 7 tests

Blocking gate and gap detection — spec approval safety.

**Blocking gate — PM agent**
- blocks approval and does not save when spec has [blocking: yes] questions
- saves approved spec after two-step confirmation — approval intent shows confirm prompt, 'confirmed' saves
- reports blocking count in history when multiple blocking questions exist

**Blocking gate — design agent**
- blocks design spec approval when [blocking: yes] questions remain
- saves approved design spec after two-step confirmation — approval intent shows confirm prompt, 'confirmed' saves

**Gap detection**
- surfaces gap message and question in Slack response and saves the draft
- gap question is stored in history so the agent can interpret the next reply

### `tests/integration/locked-decisions.test.ts` — 5 tests

`extractLockedDecisions` wiring in all three agent runners. Verifies that confirmed conversation decisions are injected into each Sonnet call, and that a Haiku failure in this path never crashes the agent.

The Anthropic call order differs per runner:
- PM: `extractLockedDecisions → classifyMessageScope → runAgent`
- Design: `isOffTopicForAgent → isSpecStateQuery → extractLockedDecisions → runAgent`
- Architect: `isOffTopicForAgent → isSpecStateQuery → extractLockedDecisions → runAgent`

**PM agent**
- injects locked decisions into Sonnet call when Haiku returns bullets
- runner does NOT crash when extractLockedDecisions throws — agent still responds

**Design agent**
- injects locked decisions into Sonnet call when Haiku returns bullets
- runner does NOT crash when extractLockedDecisions throws — design agent still responds

**Architect agent**
- runner does NOT crash when extractLockedDecisions throws — architect still responds

### `tests/integration/workflows.test.ts` — 17 tests

End-to-end multi-turn workflow tests. Each scenario runs multiple `handleFeatureChannelMessage` calls in sequence, asserting state transitions between turns.

**Scenario 1 — PM spec approval → design agent routing**
- Turn 1: approval confirmation shows approval message and preserves pm as confirmedAgent
- Turn 2: next message after approval routes to UX Designer based on GitHub phase

**Scenario 2 — Design spec approval → architect routing**
- Turn 1: design approval confirmation shows approval message
- Turn 2: next message after design approval routes to Architect

**Scenario 3 — Phase-aware routing on new thread**

A new Slack thread (no `confirmedAgent`) reads GitHub branch state to determine the active phase and routes directly — no `classifyIntent` call.

- new thread in design-in-progress feature routes straight to UX Designer
- new thread in design-approved-awaiting-engineering routes straight to Architect
- new thread in product-spec-in-progress routes to PM (via classifyIntent)

**Scenario 4 — PM escalation round-trip from design agent**
- Turn 1: design agent response with escalation offer stores pending escalation
- Turn 2: user says yes → PM agent answers the blocking product question

**Scenario 5 — Thread isolation across concurrent features**
- PM message in Thread A does not affect UX Designer routing in Thread B

**Scenario 6 — confirmedAgent sticky routing**
- second message in PM thread skips classifyIntent and goes straight to PM
- confirmed design agent thread skips classifyIntent — goes straight to UX Designer

**Scenario 8 — State query on long thread surfaces uncommitted-context note**
- state response shows specific uncommitted decisions when thread has prior history
- state response skips uncommitted section when all decisions are in the spec
- state response has no uncommitted section when thread is short (fresh start)

**Scenario 9 — Design patch flow**
- patch block is applied to existing draft and merged draft is saved to GitHub

---

## Layer 3: Regression Tests

Named bug tests. Each test is tagged with the bug number it caught. A new bug gets a new test — never delete these.

### `tests/regression/history-integrity.test.ts` — 4 tests

- **bug #1** — off-topic redirect appends user then assistant in correct order
- **bug #2** — user message is not stored when the agent call fails
- **bug #3** — subsequent call succeeds even when history starts with assistant (corrupted history sanitized)
- **invariant** — history alternates user/assistant after each successful turn

### `tests/regression/approval-detection.test.ts` — 9 tests

- **bug #4** — affirmations containing 'spec' are not state queries (3 cases)
- **bug #5** — decision confirmations are not state queries (6 cases including true positives)
- **bug #6** — single decision confirmation must not save spec (PM and design agents)

### `tests/regression/error-recovery.test.ts` — 5 tests

- **bug #7** — withThinking posts fallback message when chat.update fails (stale TS / rate limit)
- **bug #8** — spec with [blocking: yes] questions is never saved (PM and design agents)
- **bug #9** — gap question is stored in history so agent can interpret next reply; draft is saved even when a gap is detected

---

## Layer 4: Evals (LLM Quality, Not Automated)

`tests/evals/` — not part of `vitest run`. These are manual runs that pass real user messages to the live Anthropic API and score whether the agent response meets quality criteria.

Scenarios exist for: PM agent, design agent, architect agent, concierge.

Run individually: `npx tsx tests/evals/runner.ts`

---

## Adding a New Test

| What changed | Where to add the test |
|---|---|
| New helper function on an agent | `tests/unit/<agent-name>.test.ts` |
| New routing logic in `message.ts` | `tests/integration/workflows.test.ts` — add a scenario |
| New classification function in `agent-router.ts` | `tests/unit/agent-router.test.ts` |
| New GitHub operation | `tests/unit/github-client.test.ts` |
| Bug fixed in production | `tests/regression/` — name it bug #N |
| New agent wired in | `tests/integration/locked-decisions.test.ts` (add crash resilience test) + `tests/integration/workflows.test.ts` (add routing scenario) |

A behavior with no test does not count as done.
