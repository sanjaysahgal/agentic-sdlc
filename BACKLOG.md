# agentic-sdlc — Feature Backlog

Ordered by priority. One step at a time — human confirms before proceeding to the next.

---

## Active (next up)

### Step 4 — Architect agent (engineering spec)

The architect is a principal engineer with deep expertise in system design, API contracts, data modeling, and scalability. Their job is to translate an approved design spec into a precise engineering spec that a backend or frontend engineer can implement without guessing.

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

**Substeps:**
- **4a** — Architect agent persona: principal engineer mindset, reads full spec chain before first response, leads with a structural proposal (data model + API surface) not discovery questions
- **4b** — Engineering spec format: define `<feature>.engineering.md` structure, section by section
- **4d** — Cross-phase escalation (reactive layer): when any agent surfaces a `[blocking: yes]` question owned by an upstream phase, it stops and offers to pull that agent into the thread with the specific question as context. The upstream agent opens with a concrete answer proposal, not discovery questions. Applies to: design agent surfacing product questions, architect agent surfacing product or design questions. The design agent's version of this is built as part of Step 4 since the pattern is established once and reused.
- **4c** — Full wiring: phase routing (`design-approved-awaiting-engineering`), context loading, draft auto-save, conflict + gap detection, approval detection, thinking indicator ("Architect is thinking...")

### Step 5 — GitHub Actions as handoff trigger

Replace manual Slack handoff messages with merge-triggered GitHub Actions. Today, when a spec is approved it's saved to main and the agent tells the human "hand it to engineering." This step automates that notification.

**How it works:**
- A spec merged to main (`.product.md`, `.design.md`, `.engineering.md`) triggers a GitHub Action
- The action determines which spec was merged and what phase comes next
- It posts a Slack notification in the relevant feature channel: "Onboarding product spec approved and merged. Ready to start design?"
- Human still confirms — the trigger is the merge event, not an automatic phase transition
- No phase advances without human approval; the action just surfaces the readiness

**What this replaces:**
- The hardcoded handoff messages currently in agent system prompts ("save the final spec and hand it to engineering")
- Manual human awareness that a spec was approved

**Prerequisite:** None — can be built independently of the orchestrator (Step 6), though the orchestrator will eventually own this logic at scale.

### Step 6 — SDLC Orchestrator agent

A dedicated agent that owns proactive phase coordination across all in-flight features. Distinct from the concierge (which is the inbound human front door) — the orchestrator is the outbound system coordinator.

**Responsibilities:**
- Watches feature phase state (via GitHub branch + file presence) and detects when a handoff is ready
- Proactively notifies the right person in the right channel: "The onboarding product spec was approved — ready to start design?"
- Routes to the correct specialist agent as the agent roster grows — no hardcoded routing logic scattered across individual message handlers
- Detects stalls (e.g. a spec approved but no activity for N days) and surfaces them to the relevant human
- Escalates blocking open questions that haven't been resolved before a phase can advance — specifically, scans specs at handoff time for any `[blocking: yes]` questions tagged `[type: product]` or `[type: design]` that belong to an upstream agent, and blocks the handoff until they are resolved
- Owns the canonical list of which agent handles which phase — the single source of truth for routing

**Cross-phase question escalation (two-layer model):**
Product and design questions that surface mid-phase are handled at two layers:
- **Reactive (individual agents):** When the design agent encounters a `[type: product] [blocking: yes]` question mid-conversation, it flags it immediately and offers to pull the PM agent into the thread with the specific question as context. The PM agent opens with a concrete answer proposal — not a discovery question. Same pattern applies to the architect agent surfacing product or design questions.
- **Proactive (orchestrator):** At every phase handoff, the orchestrator scans the outgoing spec for unresolved `[blocking: yes]` questions owned by upstream agents. If any exist, it blocks the handoff and notifies the relevant agent and human. This catches questions that slipped through the reactive layer.

The analogy: the individual agent is a designer saying "hold on, this is a product call" mid-meeting. The orchestrator is a PM reviewing the handoff checklist before the meeting starts. Both are needed — the orchestrator prevents the problem, the agent handles it when it slips through anyway.

**Why a separate agent and not just logic in the message handler:**
As the agent roster grows (architect, engineer agents, QA agent), routing logic scattered across handlers becomes unmaintainable. The orchestrator centralises all phase-transition decisions. The message handler becomes thin — it receives a message, asks the orchestrator where it goes, and dispatches.

**Prerequisite:** GitHub Actions handoff triggers (Step 5) so the orchestrator has reliable events to act on rather than polling.

### Step 7 — Spec-validator agent

An automated quality gate that runs before any spec can advance to the next phase. Distinct from the spec auditor (which checks for conflicts with vision/architecture) — the validator checks structural completeness and internal consistency.

**What it checks:**
- All required sections are present and non-empty (no `TBD` outside of Figma link)
- Every user story in the product spec has a corresponding flow in the design spec
- Every screen in the design spec has all required states (default, loading, empty, error)
- Every acceptance criterion in the product spec is specific enough to be testable
- No `[blocking: yes]` open questions remain unresolved
- No contradictions between sections within the same spec (e.g. a flow references a screen not defined in Screens)
- Engineering spec: every API endpoint has a defined error response; every data model change has a migration path

**Output:** Pass or fail with specific, actionable failure reasons. A failing spec cannot be approved — the relevant agent is notified and must address the failures before re-submitting.

**Where it runs:** Between draft save and approval gate. The human sees the validation result before being asked to approve.

### Step 8 — Engineer agents (backend + frontend) + pgm agent

Three agents that work from an approved engineering spec to produce and ship code.

**pgm agent (Program Manager):**
- Reads the approved engineering spec and decomposes it into discrete work items
- Each work item: title, acceptance criteria, which agent (backend/frontend), estimated complexity, dependencies
- Posts work items to the feature channel for human review before any code is written
- Work items are also saved to the target repo as a `<feature>.workitems.md` for traceability

**Backend agent:**
- Reads the full spec chain (product → design → engineering) before writing a line of code
- Implements: migrations, models, API endpoints, business logic, tests
- Conflict detection: flags any implementation decision that contradicts the spec chain before committing
- Opens a PR per work item; PR description links back to the spec section it implements
- Never makes product, design, or architecture decisions — escalates upstream

**Frontend agent:**
- Reads the full spec chain, with particular attention to the design spec (screens, states, interactions)
- Implements: components, pages, state management, API integration
- References design spec states explicitly in component code (empty state, error state, loading state)
- Same PR-per-work-item pattern as backend agent

**Shared constraints:**
- No code is written until work items are human-approved
- All agents read the full spec chain — no partial context
- Conflict detection applies to code output, not just specs

### Step 9 — QA agent

Generates feature-specific test plans from acceptance criteria and validates shipped code against them. Blocks merges when criteria are unmet.

**What the QA agent reads:**
- Full spec chain (product → design → engineering) — understands what was promised
- Shipped code (PRs from engineer agents) — understands what was built

**What the QA agent produces (`<feature>.qa.md`):**
- Test plan per acceptance criterion: scenario, preconditions, steps, expected outcome
- Edge cases derived from design spec states (empty state, error state, slow network, RTL layout)
- Accessibility test cases derived from the design spec Accessibility section
- Regression risk areas: which existing features could be affected by this change

**Where the output lives:**
`specs/features/<feature>/<feature>.qa.md` in the target repo (e.g. `agentic-health360`). These are feature-specific test plans. They are distinct from the 111 platform unit tests in `agentic-sdlc`, which test the SDLC engine itself and run on every platform code change.

**Gate:** QA agent reviews shipped PRs against the test plan. PRs that fail acceptance criteria are flagged with specific failures before merge. Human makes the final merge decision.

**Prerequisite:** Engineer agents (Step 8) — the QA agent needs code to validate against.

### Step 10 — Brand repo abstraction + Figma integration

Every team onboarding to agentic-sdlc brings their own brand repo: design tokens (colors, typography, spacing), component inventory, and brand guidelines. `WorkspaceConfig` gains a `brandRepo` field pointing to it. The design agent reads from it before producing any design output — every screen it generates is automatically on-brand.

**Brand repo structure (standardised):**
- `brand/tokens.json` — color palette, typography scale, spacing scale, border radii, shadows
- `brand/components.md` — inventory of existing components with usage guidelines
- `brand/guidelines.md` — brand voice, iconography rules, cultural/accessibility constraints

**Design agent changes:**
- Reads brand tokens at context load time (same pattern as product vision and architecture)
- Populates the Brand section of `<feature>.design.md` from tokens, not from conversation
- Flags any design decision that would introduce a color, font, or spacing value not in the token set
- First feature for a new team bootstraps brand tokens from conversation (designer describes the brand; agent proposes the token set; designer approves)

**Figma integration:**
- Agent creates and iterates on a Figma file directly via the Figma API (or Figma MCP when available)
- Designer reviews in Figma, gives feedback in Slack, agent iterates
- Approved design = Figma link stored in `<feature>.design.md` + file checked into repo together
- Figma link replaces the `TBD` placeholder currently in every design spec

**Health360's brand repo** (`agentic-health360-brand`) is the working model. It was created as an empty repo — Step 10 populates it and proves out the pattern.

### Step 11 — Multi-workspace support + Redis persistence

Make agentic-sdlc a licensable product that can serve multiple teams simultaneously without code changes.

**Multi-workspace Slack:**
- Single bot process handles multiple Slack workspaces
- Each workspace has its own `WorkspaceConfig` (product name, GitHub repo, channel names, spec paths)
- Workspace configs stored in a database, not environment variables — environment variables become a single-workspace shortcut, not the production pattern
- `/sdlc setup` Slack command walks a new workspace through configuration interactively

**Redis persistence:**
- Conversation history moves from in-memory to Redis — survives bot restarts, scales across multiple processes
- Phase state cache moves to Redis — consistent across all bot instances
- Session TTL configurable per workspace

**Why this ordering:**
Redis is a prerequisite for production deployment (Step 12) because in-memory state is lost on restart. Multi-workspace support is bundled here because it requires the same database infrastructure.

### Step 12 — Production deployment via agentic-cicd

Move the bot off localhost onto always-on infrastructure.

**What "always-on" means for this bot:**
Socket Mode means no public URL is required — just a persistent outbound WebSocket connection to Slack. The process must never exit. Any crash must trigger an automatic restart.

**Deployment target:** Railway, Fly.io, or equivalent (chosen when this step is active based on current platform pricing and reliability).

**What gets built:**
- Dockerfile with Node.js runtime, tsx compilation, environment variable injection
- Secrets management: SLACK tokens, ANTHROPIC_API_KEY, GITHUB_TOKEN stored as platform secrets, never in the repo
- Health check endpoint for the platform's process monitor
- Crash restart policy (always restart, exponential backoff)
- Deployment triggered automatically from `main` branch via `agentic-cicd` pipeline
- Rollback: previous image tag retained; one-command rollback

**Prerequisite:** Redis persistence (Step 11) — in-memory state is lost on restart, so persistence must exist before the bot moves to a multi-instance, restartable environment.

### Step 13 — Vision-refinement channel

A dedicated Slack channel (e.g. `#product-vision`) where the pm agent operates in a distinct mode: not spec shaping for a feature, but interrogating and strengthening the product vision itself.

**What vision-refinement mode does:**
- Reads `PRODUCT_VISION.md` fully before every response
- Asks hard questions: "Who is the user in this vision — a care manager or a patient? The answer shapes every feature." "This vision says 'seamless' four times but never defines what friction it's removing."
- Identifies gaps: vision sections that are undefined, contradictory, or too vague to constrain a spec
- Proposes concrete changes to `PRODUCT_VISION.md` via PR — human reviews and merges
- After a merge, verifies the updated vision against the existing approved specs — flags any specs that need revisiting

**Why a separate channel:**
The pm agent in a feature channel is constrained to spec work. Vision-refinement is product strategy, not feature delivery — it needs a distinct context and a distinct prompt mode to avoid contaminating feature conversations.

**Prerequisite:** None — can be built independently, but most valuable once several features have been specced and patterns in the vision start to show.

### Step 14 — Audit trail

Log every agent action with enough context to reconstruct why any decision was made, debug unexpected behavior, and satisfy compliance requirements.

**What gets logged (per agent invocation):**
- Timestamp, workspace, channel, thread ID
- Which agent was invoked and in which mode (e.g. design agent, read-only mode)
- Which context was loaded: spec file paths, git SHAs of files read (so the exact version of every doc is traceable)
- The user message (redacted if it matches a PII pattern)
- The agent response (truncated after N characters for storage efficiency)
- Any intent markers detected (INTENT: CREATE_DESIGN_SPEC, DRAFT_DESIGN_SPEC_START, etc.)
- Any GitHub operations triggered (branch created, file saved, issue created)
- Latency (time from message received to response sent)

**Storage:** Structured JSON logs, written to a log aggregation service (Datadog, Logtail, or equivalent). Not stored in GitHub.

**Why this matters:**
- Debugging: "Why did the agent approve a spec that had a blocking open question?" → read the log.
- Compliance: enterprise customers need to know what data their employees shared with an AI system and what the AI did with it.
- Product improvement: latency data and intent classification accuracy inform which parts of the system need tuning.

---

## Completed

- **UX Design agent (Steps 3a–3c)** — persona (globally accessible, consumer mindset, holistic end-to-end thinking, leads with proposals not discovery questions), design spec format (`<feature>.design.md`: Figma link, Design Direction, Brand, Screens with states + interactions, User Flows per user story, Accessibility, Open Questions), full wiring: phase routing, context loading (approved product spec from main + design draft from branch), draft auto-save after every agreed decision, conflict + gap detection, approval detection, thinking indicator ("UX Designer is thinking...")
- **Automated test suite (platform)** — 111 tests across 9 files: routing, phase detection, pm agent helpers, spec auditor, GitHub client, context loader, concierge, conversation store, design agent. All platform tests — zero real API calls, all external dependencies mocked. Feature-specific test plans are produced by the QA agent (Step 9) and live in the target repo.
- **Proactive open questions surfacing** — pm agent appends unresolved `[blocking: yes]` questions after every exchange, unprompted
- **All-agent conflict + gap detection** — spec auditor runs on every draft save; conflict blocks save; gap flags for human decision; vision/arch gate re-reads from GitHub to verify
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
