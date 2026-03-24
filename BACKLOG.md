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

---

## Active (next up)

### Step 2.5 — API cost optimization

Two changes that compound as the agent roster grows. Build before Step 3 — every agent call made during Orchestrator development benefits immediately.

**Dev-mode model override:**
- Add `SDLC_DEV_MODE` to `.env.example` — when `true`, all agent calls in `claude-client.ts` use `claude-haiku-4-5-20251001` instead of Sonnet
- Haiku is 5x cheaper on input and output — covers testing routing, formatting, and structure where Sonnet-quality reasoning is not needed
- One env flag, one conditional in `claude-client.ts`

**Structured prompt caching (static/dynamic split):**
- The `cache_control: ephemeral` marker added to `claude-client.ts` caches the full system prompt — but the system prompt includes `featureName` and live spec content, so the cache busts on every new feature
- Fix: restructure each agent's `build*SystemPrompt()` function to return two parts — a static block (persona, workflow, spec format, rules) and a dynamic block (featureName, specUrl, live context)
- Pass both to `runAgent()` as separate params; apply `cache_control` only to the static block
- Static block is ~90% of each prompt — this gives cross-feature cache hits and reduces input cost by ~90% on cache hits
- `.env.example` gains `SDLC_DEV_MODE` with comment

**Why before Step 3:**
Every agent call made during Orchestrator development burns Sonnet credits. Dev-mode override eliminates most of that cost. Structured caching then compounds in production as feature volume grows.

---

### Step 2.6 — Spec revision workflow

Support returning to an existing feature at any point in its lifecycle to revise any layer of the spec chain.

**The problem today:** Once all spec branches are deleted and specs are on `main`, `getInProgressFeatures()` loses track of the feature entirely. `getFeaturePhase()` falls back to `"product-spec-in-progress"` — misidentifying a live feature as a new one. The agent starts from scratch with no context.

**What this adds:**

**Phase detection fix:**
- `getFeaturePhase()` checks for existing specs on `main` before falling back — if `.product.md`, `.design.md`, or `.engineering.md` exist, the feature is in `"feature-established"` state, not "new"

**Intent-based layer routing:**
- New Haiku classifier: given "I want to change X", which layer is affected? `product` / `design` / `engineering`
- User says "I want to change the onboarding flow" → PM, with existing product spec loaded as context (editor mode, not blank)
- User says "update the welcome screen" → design agent, existing design spec loaded
- User says "add a new API endpoint" → architect, existing engineering spec loaded
- No forced top-down cascade — user jumps directly to the right layer

**Editor mode:**
- Each agent is given the existing spec as its starting context with an explicit instruction: "This spec exists and is approved. The user wants to revise it. Work from what exists, not from blank."
- Same draft → two-step approval flow as new specs
- On approval, `saveApproved*` already handles "already on main" — updates in place

**Downstream notification (not enforcement):**
- After an upstream spec is updated (e.g. product spec changes), system posts: *"Product spec updated. The design spec may need a revision pass — it still reflects the previous version."*
- Human decides whether to cascade. System does not auto-invalidate.

**Note:** "Feature live" vs "feature built but not deployed" is indistinguishable at the spec level — the system tracks spec state only, not deployment state. Revision workflow applies equally to both.

---

### Step 2.7 — Bug workflow

A dedicated workflow for bugs that is completely separate from the spec chain. Bugs are deviation from intent — the spec is correct, the code is wrong. No spec update needed (unless the bug reveals the spec was ambiguous, which is rare and handled manually).

**What this adds:**

**Bug intake (Slack):**
- In any feature channel or a dedicated `#bugs` channel: "we have a bug where X happens when Y"
- Concierge (or dedicated bug-intake handler) creates a GitHub Issue tagged `bug` with: description, reported-by, feature name, severity (derived from message or asked)
- Confirmation posted in Slack with a link to the issue

**Triage:**
- Bugs go into a triage backlog — visible in GitHub Issues with `bug` + `triage` labels
- Human or future eng-mgr agent sets priority and assigns

**Resolution tracking:**
- Issue linked to a PR that fixes it
- On PR merge, issue closed automatically (GitHub standard behavior)
- Slack notification: "Bug #123 fixed and merged"

**Out of scope for this step:** Automated severity detection from monitoring/alerts, bug SLA tracking, regression test auto-generation. These are follow-on once the basic intake loop is working.

**Prerequisite for practical use:** Engineer agents (Step 6) — bugs only appear when code is running.

---

### Step 3 — Orchestrator agent

A dedicated agent that owns proactive phase coordination AND continuous spec integrity monitoring across all in-flight features. Built before engineer agents because routing logic scattered across message handlers becomes unmaintainable as the agent roster grows — and because spec conflicts that go undetected compound into expensive rework.

**Routing responsibilities:**
- Owns the canonical routing table: which agent handles which phase — single source of truth, replaces hardcoded routing in the message handler
- Watches feature phase state (via GitHub branch + file presence) and detects when a handoff is ready
- At every phase handoff, scans the outgoing spec for unresolved `[blocking: yes]` questions — blocks the handoff until resolved
- Replaces GitHub Actions as the handoff trigger mechanism — no separate GitHub Actions step needed

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

**Role mapping — new WorkspaceConfig fields:**
```
SLACK_PM_USER         # Slack user ID for the Product Manager
SLACK_DESIGNER_USER   # Slack user ID for the UX Designer
SLACK_ARCHITECT_USER  # Slack user ID for the Architect
```
The `[type: product|design|engineering]` tag on every open question is how the Orchestrator knows which role to alert. These tags already exist on all open questions — the Orchestrator reads them.

**Cross-phase escalation — two layers working together:**
- **Reactive (Steps 1 + 2c):** Agent detects a blocking upstream question mid-conversation and pulls the right agent into the thread immediately
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

**Where it runs:** Between draft save and approval gate. The human sees the validation result before being asked to approve.

---

### Step 5 — Redis persistence + agentic-sdlc production deployment + observability

Deploy the SDLC engine to always-on infrastructure. Observability is bundled here — you cannot operate a production system without being able to see what it's doing. These three things ship together.

**Redis persistence:**
- Conversation history moves from in-memory to Redis — survives bot restarts, scales across multiple processes
- Confirmed agent state moves from disk to Redis — consistent across all bot instances
- Session TTL configurable per workspace

**Observability (bundled — not deferred):**
- Structured logging per agent invocation: timestamp, workspace, channel, thread, agent, intent markers, GitHub operations, latency
- Error logging with full context: what failed, which agent, which thread, raw error — extends the basic error logging from Step 1
- Log aggregation service (Datadog, Logtail, or equivalent)

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

**Shared constraints:**
- All agents read the full spec chain — no partial context
- PRs are opened against the customer's app repo (`agentic-health360`), not the platform repo
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

### Step 8 — agentic-cicd: customer app deployment pipeline

The second half of the licensed platform. A customer who has the SDLC engine but no deployment pipeline cannot ship anything. This step makes the pipeline a first-class platform deliverable and is the point at which health360 ships to real users.

**What agentic-cicd provides for a customer app:**
- Build pipeline: installs dependencies, runs type-check, runs tests, builds production bundle
- Deployment: pushes to the customer's chosen platform (Vercel, Railway, Fly.io, etc.)
- Preview deployments: every PR from an engineer agent gets a preview URL
- Production deployment: triggered on merge to main, after QA agent sign-off
- Rollback: previous deployment retained; one-command rollback
- Secrets management: customer's production secrets stored as pipeline secrets, never in repos

**What makes this a platform feature (not customer-specific):**
The pipeline is templated and configurable — a new customer plugs in their repo, deployment target, and secrets. WorkspaceConfig gains a deployment section alongside the existing GitHub and Slack config.

**health360 milestone:** Once this step is complete, onboarding ships to real health360 users — the first end-to-end proof that the full autonomous pipeline works.

---

### Step 9 — Multi-workspace support

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

### Step 10 — Full audit trail

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

### Step 11 — Figma integration + brand token support

Agent creates Figma files directly via the Figma API on design spec approval. Brand token reading folded in via `brandPath` in WorkspaceConfig.

**What this adds:**
- On design spec approval, agent creates a Figma file with frames matching the screen inventory
- Designer reviews in Figma, gives feedback in Slack, agent iterates
- Approved Figma link stored in `<feature>.design.md`
- `WorkspaceConfig` gains `brandPath` — design agent reads brand tokens from the customer's repo and applies them when generating Figma frames

**Note on brand data:** Brand tokens are customer-specific. health360's brand lives in `agentic-health360`. The platform reads from wherever `brandPath` points — it does not own or define brand.

---

### Step 12 — Vision refinement channel

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
