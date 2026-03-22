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

### Step 4 — Architect agent (engineering spec)

The architect is a principal engineer with deep expertise in system design, API contracts, data modeling, and scalability. Their job is to translate an approved design spec into a precise engineering spec that backend and frontend engineer agents can implement without guessing.

**What the architect reads before responding:**
- Approved product spec (from main) — understands the problem and acceptance criteria
- Approved design spec (from main) — understands every screen, flow, and state that must be built
- System architecture doc — understands the existing stack, patterns, and constraints

**What the architect produces (`<feature>.engineering.md`):**
- Data model changes: new tables, fields, relations, migrations
- API contracts: endpoints, request/response shapes, auth requirements, error codes
- Component breakdown: which frontend components are new vs. reused, what props they need
- State management: where state lives, how it flows, what gets persisted
- Integration points: third-party services, internal services, event triggers
- Non-functional requirements: performance targets, caching strategy, rate limits
- Open questions tagged `[type: product|design|engineering] [blocking: yes|no]`

**Constraints (same as all agents):**
- Never makes product or design decisions — escalates upstream
- Conflict detection: flags any engineering decision that contradicts the product or design spec before saving
- Gap detection: flags any assumption the engineer agents would have to make that isn't covered by the spec chain
- Approval gate: engineering spec cannot advance until human explicitly approves it
- Spec link on approval-ready: shares a direct GitHub link to the draft spec (same pattern as pm and design agents)

**Substeps:**
- **4a** — Architect agent persona: principal engineer mindset, reads full spec chain before first response, leads with a structural proposal (data model + API surface) not discovery questions
- **4b** — Engineering spec format: define `<feature>.engineering.md` structure, section by section
- **4c** — Cross-phase escalation (reactive layer): when the architect surfaces a `[blocking: yes]` question owned by an upstream phase (product or design), it stops and offers to pull that agent into the thread with the specific question as context. The upstream agent opens with a concrete answer proposal, not discovery questions. Design agent gets the same pattern for product-owned blocking questions — built once here, applied to both.
- **4d** — Full wiring: phase routing (`design-approved-awaiting-engineering`), context loading (full spec chain), draft auto-save, conflict + gap detection, approval detection, thinking indicator ("Architect is thinking...")

---

### Step 5 — Orchestrator agent

A dedicated agent that owns proactive phase coordination across all in-flight features. Distinct from the concierge (which is the inbound human front door) — the orchestrator is the outbound system coordinator. Built before engineer agents because routing logic scattered across message handlers becomes unmaintainable as the agent roster grows.

**Responsibilities:**
- Owns the canonical routing table: which agent handles which phase — single source of truth, replaces hardcoded routing in the message handler
- Watches feature phase state (via GitHub branch + file presence) and detects when a handoff is ready
- Proactively notifies the right person in the right channel when a spec is approved and the next phase is ready
- Detects stalls (spec approved but no activity for N days) and surfaces them to the relevant human
- At every phase handoff, scans the outgoing spec for unresolved `[blocking: yes]` questions owned by upstream agents — blocks the handoff until resolved
- Replaces GitHub Actions as the handoff trigger mechanism — no separate GitHub Actions step needed

**Cross-phase question escalation (two-layer model):**
- **Reactive (individual agents — Step 4c):** Agent surfaces a blocking upstream question mid-conversation, offers to pull the upstream agent in immediately
- **Proactive (orchestrator — this step):** At every handoff, scans specs for unresolved blocking questions that slipped through the reactive layer and blocks the advance until resolved

**Why this replaces GitHub Actions (previously Step 5):**
A separate GitHub Actions handoff step would be superseded by the orchestrator anyway. The orchestrator owns all phase-transition logic natively — triggering it from GitHub merge events is one implementation detail inside the orchestrator, not a standalone step.

---

### Step 6 — Spec-validator agent

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

### Step 7 — Redis persistence + agentic-sdlc production deployment

Deploy the SDLC engine to always-on infrastructure before building the full engineering execution layer. Building 4+ more agents on a localhost process is the wrong order — infrastructure migration after the fact risks breaking assumptions baked into the agents.

**Redis persistence:**
- Conversation history moves from in-memory to Redis — survives bot restarts, scales across multiple processes
- Confirmed agent state moves from disk to Redis — consistent across all bot instances
- Session TTL configurable per workspace

**agentic-sdlc deployment:**
- Dockerfile with Node.js runtime, tsx compilation, environment variable injection
- Secrets management: Slack tokens, ANTHROPIC_API_KEY, GITHUB_TOKEN stored as platform secrets, never in the repo
- Health check endpoint for the platform's process monitor
- Crash restart policy (always restart, exponential backoff)
- Deployment triggered automatically from `main` branch via `agentic-cicd` pipeline
- Rollback: previous image tag retained; one-command rollback

**Deployment target:** Railway, Fly.io, or equivalent — chosen when this step is active.

**Prerequisite:** Orchestrator (Step 5) — routing must be centralised before the bot runs in a multi-instance environment.

---

### Step 8 — Basic observability

Structured logging before any customer app code is written. You cannot debug a production system without a record of what happened.

**What gets logged per agent invocation:**
- Timestamp, workspace, channel, thread ID
- Which agent was invoked and in which mode
- Which context was loaded: spec file paths, git SHAs of files read
- Intent markers detected (INTENT: CREATE_DESIGN_SPEC, DRAFT_SPEC_START, etc.)
- Any GitHub operations triggered (branch created, file saved)
- Latency (message received → response sent)

**Storage:** Structured JSON to a log aggregation service (Datadog, Logtail, or equivalent).

**Not in this step:** Full audit trail with PII redaction and compliance-grade retention — that's Step 13. This step is the minimum needed to operate a production system.

---

### Step 9 — pgm agent + engineer agents (backend + frontend)

Three agents that work from an approved engineering spec to produce and ship code. This is where "autonomous" actually happens — the first time a feature goes from spec to merged, tested code without a human writing a line.

**pgm agent (Program Manager):**
- Reads the approved engineering spec and decomposes it into discrete, dependency-ordered work items
- Each work item: title, acceptance criteria, which agent handles it (backend/frontend), estimated complexity, dependencies on other work items
- Posts work items to the feature channel for human review before any code is written
- Work items saved as `<feature>.workitems.md` in the target repo for traceability
- No code is written until work items are human-approved

**Backend agent:**
- Reads the full spec chain (product → design → engineering) before writing a line of code
- Implements: migrations, models, API endpoints, business logic, tests
- Conflict detection: flags any implementation decision that contradicts the spec chain before committing
- Opens a PR per work item; PR description links back to the spec section it implements
- Never makes product, design, or architecture decisions — escalates upstream

**Frontend agent:**
- Reads the full spec chain, with particular attention to the design spec (screens, states, interactions, brand tokens)
- Implements: components, pages, state management, API integration
- References design spec states explicitly in code (empty state, error state, loading state)
- Same PR-per-work-item pattern as backend agent

**Shared constraints:**
- All agents read the full spec chain — no partial context
- Conflict detection applies to code output, not just specs
- PRs are opened against the customer's app repo (`agentic-health360`), not the platform repo

---

### Step 10 — QA agent

Generates feature-specific test plans from acceptance criteria and validates shipped code against them. Blocks merges when criteria are unmet.

**What the QA agent reads:**
- Full spec chain (product → design → engineering) — understands what was promised
- Shipped code (PRs from engineer agents) — understands what was built

**What the QA agent produces (`<feature>.qa.md`):**
- Test plan per acceptance criterion: scenario, preconditions, steps, expected outcome
- Edge cases derived from design spec states (empty state, error state, slow network, RTL layout)
- Accessibility test cases derived from the design spec Accessibility section
- Regression risk areas: which existing features could be affected by this change

**Where the output lives:** `specs/features/<feature>/<feature>.qa.md` in the customer repo (`agentic-health360`). Distinct from the platform's own test suite (`agentic-sdlc/tests/`) which tests the SDLC engine itself.

**Gate:** QA agent reviews shipped PRs against the test plan. PRs that fail acceptance criteria are flagged with specific failures before merge. Human makes the final merge decision.

**Prerequisite:** Engineer agents (Step 9).

---

### Step 11 — agentic-cicd: customer app deployment pipeline

The second half of the licensed platform. A customer who has the SDLC engine but no deployment pipeline cannot ship anything. This step makes the pipeline a first-class platform deliverable.

**What agentic-cicd provides for a customer app:**
- Build pipeline: installs dependencies, runs type-check, runs tests, builds production bundle
- Deployment: pushes to the customer's chosen platform (Vercel, Railway, Fly.io, etc.)
- Preview deployments: every PR from an engineer agent gets a preview URL
- Production deployment: triggered on merge to main, after QA agent sign-off
- Rollback: previous deployment retained; one-command rollback
- Secrets management: customer's production secrets stored as pipeline secrets, never in repos

**What makes this a platform feature (not customer-specific):**
The pipeline is templated and configurable — a new customer plugs in their repo, deployment target, and secrets. The same pipeline that deploys health360 deploys any future customer's app. WorkspaceConfig gains a deployment section alongside the existing GitHub and Slack config.

**health360 specifically:** `agentic-health360` is the reference implementation. Once this step is complete, onboarding ships to real health360 users — the first end-to-end proof that the platform works.

---

### Step 12 — Multi-workspace support

Make agentic-sdlc serve multiple customer teams simultaneously without code changes.

**What changes:**
- Single bot process handles multiple Slack workspaces
- Each workspace has its own WorkspaceConfig stored in a database, not environment variables
- Environment variables become a single-workspace shortcut (still valid for solo teams), not the production pattern
- `/sdlc setup` Slack command walks a new workspace through configuration interactively
- Per-workspace cost controls and rate limiting (each Anthropic API call is billed to the workspace)

**Why after Step 11:**
Multi-workspace requires the full platform to exist first — you can't onboard a second customer to a platform that hasn't shipped its first app. health360 shipping (Step 11) is the proof point that makes onboarding a second customer credible.

---

### Step 13 — Full audit trail

Extend the basic observability from Step 8 into a compliance-grade audit trail.

**Additions beyond Step 8:**
- User message content with PII pattern redaction
- Agent response content (truncated for storage efficiency)
- Full context load record: exact git SHAs of every file read per invocation
- Configurable retention policy per workspace (e.g. 90 days for standard, 7 years for regulated industries)
- Export API: workspace admin can export their audit log on demand

**Why this ordering:**
Basic observability (Step 8) handles operational debugging. The full audit trail is a compliance and enterprise sales feature — it becomes relevant when multiple paying customers are running in production.

---

### Step 14 — Figma integration

Agent creates and iterates on a Figma file directly via the Figma API. Fold brand token reading into this step via a `brandPath` in WorkspaceConfig.

**What this adds to the design agent:**
- On design spec approval, agent creates a Figma file with frames matching the spec's screen inventory
- Designer reviews in Figma, gives feedback in Slack, agent iterates
- Approved Figma link stored in `<feature>.design.md`
- `WorkspaceConfig` gains `brandPath` — design agent reads brand tokens (colors, typography, spacing) from the customer's repo and applies them when creating Figma frames

**Note on brand data:**
Brand tokens are customer-specific — health360's brand lives in `agentic-health360`, a future customer's brand lives in their repo. The platform reads from wherever `brandPath` points. agentic-sdlc does not own or define brand.

---

### Step 15 — Vision refinement channel

A dedicated Slack channel (e.g. `#product-vision`) where the pm agent operates in a distinct mode: not spec shaping for a feature, but interrogating and strengthening the product vision itself.

**What vision-refinement mode does:**
- Reads `PRODUCT_VISION.md` fully before every response
- Asks hard questions: "Who is the user in this vision — a care manager or a patient? The answer shapes every feature."
- Identifies gaps: vision sections that are undefined, contradictory, or too vague to constrain a spec
- Proposes concrete changes to `PRODUCT_VISION.md` via PR — human reviews and merges
- After a merge, verifies the updated vision against existing approved specs — flags any specs that need revisiting

**Why last:**
Most valuable once several features have been specced and shipped, and patterns in the vision start to show under real usage. Not on the critical path to the first autonomous deployment.

---

## Completed

- **UX Design agent (Steps 3a–3c)** — persona (globally accessible, consumer mindset, holistic end-to-end thinking, leads with proposals not discovery questions), design spec format (`<feature>.design.md`: Figma link, Design Direction, Brand, Screens with states + interactions, User Flows per user story, Accessibility, Open Questions), full wiring: phase routing, context loading (approved product spec from main + design draft from branch), draft auto-save after every agreed decision, conflict + gap detection, approval detection, thinking indicator ("UX Designer is thinking..."), spec link on approval-ready, visualisation offer (Figma AI / Builder.io / Anima)
- **Automated test suite (platform)** — 129 tests across 11 files: routing, phase detection, pm agent helpers, spec auditor, GitHub client, context loader, concierge, conversation store, design agent, spec utils, workspace config, integration tests for message handler. All platform tests — zero real API calls, all external dependencies mocked.
- **Blocking gate** — [blocking: yes] open questions prevent spec approval for both pm and design agents; gate enforced in code, not just prompt
- **Gap detection history persistence** — gap question stored in conversation history so agent correctly interprets follow-up replies
- **Proactive open questions surfacing** — pm agent appends unresolved `[blocking: yes]` questions after every exchange, unprompted
- **All-agent conflict + gap detection** — spec auditor runs on every draft save; conflict blocks save; gap flags for human decision; vision/arch gate re-reads from GitHub to verify
- **Spec link on approval-ready** — all spec-producing agents share a direct GitHub link to the current draft when the spec is ready for approval; documented in AGENTS.md as a non-negotiable convention for all future agents
- **pm agent with expert persona** — spec shaping, draft auto-save, approval detection
- **Concierge agent** — role-aware entry point, live feature status from GitHub, agent feedback tracking (surfaces as GitHub issue)
- **ACTIVE_AGENTS registry** — single source of truth for active agents; concierge prompt built from it; invariant test catches regressions when new agents are added
- **Structured open questions** — `[type: design|engineering|product] [blocking: yes|no]` format enforced across all agents
- **Approved spec context mode** — pm agent handles all messages post-approval; revisions require re-approval
- **Workspace config layer** — all product-specific coordinates in WorkspaceConfig, zero hardcoding; new team onboards via `.env` only
- **Product context available from any channel** — concierge and pm agent load vision + architecture from GitHub via Haiku relevance filtering
- **Phase-aware routing** — approved specs handled by pm agent in approved-spec mode; design phase routes to UX Design agent
- **Thinking indicator** — immediate feedback while agent processes; label reflects the active agent ("UX Designer is thinking...")
- **Disk persistence for confirmed agents** — survives bot restarts
- **90s API timeout + 20-message history cap** — prevents indefinite hangs on long conversations
- **Doc sync enforcement** — CLAUDE.md Definition of Done table + CI check in `.github/workflows/doc-sync-check.yml`
