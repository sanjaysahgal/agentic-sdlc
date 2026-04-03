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

All Anthropic clients (`claude-client.ts`, `html-renderer.ts`) set `maxRetries: 0`. The SDK default of 2 retries turns a 5-minute timeout into an 18-minute hang with no chance of recovery — large-token requests that time out will not succeed on retry.

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

**Post-response uncommitted decisions audit (design agent only):** After every design agent turn, if no save tool was called in that turn AND conversation history > 6 messages, the platform calls `identifyUncommittedDecisions`. If uncommitted decisions are found, the platform appends a "save those" note to the Slack response. This replaces the PLATFORM OVERRIDE safety net.

### Proactive constraint audit pattern

Every agent in the platform runs a deterministic audit for its domain-specific constraints on every response. This is not prompt-based — it is platform-enforced, pure code, no API call.

The principle: **the specialist surfaces all violations proactively**. The human cannot be expected to know what constraint to check or what question to ask. If a violation must be reported, it must be reported on every response, unconditionally.

| Audit | File | What it checks | Model |
|---|---|---|---|
| Spec conflict + gap | `runtime/spec-auditor.ts` | Vision conflicts, architecture gaps | Haiku (runs post-draft-save) |
| Brand color drift | `runtime/brand-auditor.ts` → `auditBrandTokens()` | Entire spec hex values vs BRAND.md (all sections, not just ## Brand) | None (pure string diff) |
| Brand animation drift | `runtime/brand-auditor.ts` → `auditAnimationTokens()` | Spec glow duration, blur radius vs BRAND.md ## Animation section | None (pure string diff) |

`brand-auditor.ts` is a pure string diff — zero API cost, zero latency. Both `auditBrandTokens()` and `auditAnimationTokens()` run on every design agent response: state query path (called in `message.ts`, results passed into `buildDesignStateResponse`) and full agent run path (injected as PLATFORM NOTICE into the enriched user message). Color drift and animation drift are merged. `auditBrandTokens()` scans the entire spec line-by-line (not just `## Brand`) so stale tokens in Design System Updates, proposed additions, or any other section are surfaced. Each drifted token is reported once — the first non-canonical value found wins. `extractSpecAnimValue()` handles tilde-prefixed values (e.g. `~200px`) by stripping the `~` before numeric extraction. Opacity is handled separately by `extractSpecOpacityRange()` which parses the design agent's "Opacity cycle: X → Y" range format. `extractBrandAnimationParams()` reads directly from the `## Glow (Signature Effect)` CSS in BRAND.md — parsing `animation:` shorthand for duration, `filter: blur()` for blur radius, `animation-delay:` for delay, and `@keyframes` opacity values for opacity min/max. The platform adapts to the format the team committed; it never adds auxiliary sections to customer repos to make parsing easier.

**HTML preview renderer (`runtime/html-renderer.ts`):** Uses `claude-sonnet-4-6` (not Haiku) for production-quality rendering. When `context.brand` is available, it is passed as a separate `brandContent` parameter and prepended to the user message as an `AUTHORITATIVE BRAND TOKENS` block — the renderer reads color and animation values from this block, not the spec's Brand section (which may have drifted). Returns `{ html: string, warnings: string[] }` — `warnings` contains structural validation results (missing keyframes, background token not applied, truncation, missing explicit body background-color) that are surfaced as a tool result field. **No hex color values are hardcoded** in the renderer; all values come from BRAND.md at runtime. The system prompt enforces that body `background-color` and `color` are always in the `<style>` tag — Tailwind CDN custom classes (`bg-primary`, `text-fg`) fail silently on `file://` URLs and Slack attachments because the CDN may not load before browser paint. The system prompt requires Alpine.js state and methods to be declared in a `<script>` block using the `x-data="functionName()"` pattern — `$nextTick` and other Alpine magic properties are not safe inside HTML attribute strings. The rendered preview uses a phone frame (390×844) + inspector panel layout: the phone frame contains the fully interactive app experience; the inspector panel lists all spec states as clickable buttons that directly apply a state to the phone frame without requiring click-through. **The renderer is the agent** — HTML preview files are never hand-written. `scripts/generate-preview.ts` is the CLI entry point that reads the spec and brand files from GitHub, calls `generateDesignPreview()`, and writes the output via `fs.writeFileSync()`.

**Deterministic preview rendering (two-layer):** The renderer is non-deterministic — calling `generateDesignPreview` twice with the same spec produces different HTML (different inspector states, animation timing, heading copy). Two behaviors prevent this from causing regressions:

- **Layer 1 (cache):** The `generate_design_preview` tool handler reads the saved `<feature>.preview.html` from the design branch and serves it directly — no LLM call. The preview is always identical across "give me the preview" requests. Only falls through to generation when no cached file exists (first-ever request), saving the result for future requests.

- **Layer 2 (patch-based update):** `apply_design_spec_patch` passes the original patch string (the changed spec sections only) to `saveDesignDraft()`. When cached HTML exists, `saveDesignDraft()` calls `updateDesignPreview()` (a targeted-update function in `html-renderer.ts`) instead of `generateDesignPreview()`. The renderer receives existing HTML + only the changed sections — not the full merged spec — so it knows exactly which HTML elements to update and leaves everything else identical.

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
