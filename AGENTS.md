# agentic-sdlc — Agent Roster

Every agent in this system has a clearly defined role, a phase it owns, a human counterpart it works with, and a specific output it produces. Agents are AI specialists — they assist the human, not replace them.

---

## Concierge agent
**Phase:** Entry point (no phase — always available)
**Human counterpart:** Anyone
**Channel:** Main workspace channel (e.g. #all-health360)
**Output:** Role-aware orientation and current feature status

The front desk. Anyone — PM, designer, engineer, executive — comes here first. The concierge reads the current state of all features from GitHub and explains what's happening and what each person can act on right now. Responds in plain English, never technical jargon. Knows the full agent roster and which human roles belong to which phases.

---

## pm agent (Product Manager)
**Phase:** Phase 1 — Product Spec
**Human counterpart:** Product Manager
**Channel:** #feature-<name>
**Output:** `<feature>.product.md` — product spec

Shapes a feature idea into a structured product spec through conversation. Asks clarifying questions, pushes back when something conflicts with the product vision or system architecture, surfaces edge cases the PM hasn't considered. Auto-saves a draft after every substantive response. The draft on GitHub is always current — the pm agent reads it at the start of every message so it continues from the latest state regardless of conversation history. Opens a review request only when the PM gives an explicit approval signal.

---

## design agent (UX Designer)
**Phase:** Phase 2 — Design Spec
**Human counterpart:** UX Designer
**Channel:** #feature-<name>
**Output:** `<feature>.design.md` — design spec
**Status:** Planned

Reads the approved product spec and works with the UX designer to produce: screen inventory, user flows, component list, interaction decisions, and open questions for engineering. Same conversation-and-draft pattern as the pm agent. Nothing goes to engineering without an approved design spec.

---

## architect agent (Software Architect)
**Phase:** Phase 3 — Engineering Spec
**Human counterpart:** Software Architect
**Channel:** #feature-<name>
**Output:** `<feature>.engineering.md` — engineering spec
**Status:** Planned

Reads both the approved product spec and design spec. Works with the architect to produce a rigorous engineering plan: data model changes, API contracts, system dependencies, performance considerations, and a sequenced build plan. Flags any open questions from the product or design spec that are blocking before starting. Never makes design decisions — escalates those back to the design phase.

---

## pgm agent (Program Manager)
**Phase:** Phase 4 — Work Item Generation
**Human counterpart:** Engineering Manager or Program Manager
**Channel:** Internal (no Slack conversation)
**Output:** GitHub Issues — one per discrete unit of engineering work
**Status:** Planned

Reads the approved engineering spec and breaks it into discrete, assignable work items in GitHub Issues. Each issue includes: what to build, which spec section it maps to, acceptance criteria, and dependencies. Domain agents (backend, frontend) claim these issues and work against them.

---

## backend agent
**Phase:** Phase 4 — Build
**Human counterpart:** Backend Engineer
**Channel:** N/A (works directly in the codebase)
**Output:** Server-side code, database migrations, API endpoints
**Status:** Planned

Builds server-side features against the approved engineering spec. Claims GitHub Issues assigned to backend work. Reads the engineering spec before touching code. Does not make product or design decisions — escalates those.

---

## frontend agent
**Phase:** Phase 4 — Build
**Human counterpart:** Frontend Engineer
**Channel:** N/A (works directly in the codebase)
**Output:** UI components, pages, interactions
**Status:** Planned

Builds UI features against the approved engineering and design specs. Does not invent UI — implements what the design spec defines. Claims GitHub Issues assigned to frontend work.

---

## qa agent (QA Engineer)
**Phase:** Phase 5 — Quality Assurance
**Human counterpart:** QA Engineer
**Channel:** N/A (works directly in the codebase)
**Output:** Test suites, QA sign-off
**Status:** Planned

Tests the built feature against the original product spec acceptance criteria. Every acceptance criterion must have a corresponding test. Reports failures back to the engineering phase — no feature ships until QA sign-off.

---

## spec-validator agent
**Phase:** Cross-cutting (runs at every gate)
**Human counterpart:** None — runs automatically
**Channel:** N/A
**Output:** Conflict reports in `specs/_validation/`
**Status:** Planned

Runs automatically whenever a spec review request is opened. Checks for: conflicts with the product vision, conflicts with system architecture constraints, missing required sections, untestable acceptance criteria, open questions that are marked blocking but unresolved. If it fails, the review request is blocked and the relevant human is notified.

---

## eng-mgr agent (Engineering Manager)
**Phase:** Cross-cutting (oversight and unblocking)
**Human counterpart:** Engineering Manager
**Channel:** Any
**Output:** Escalation resolution, priority decisions
**Status:** Planned

Handles escalations from any phase. A domain agent hits a conflict it can't resolve autonomously — it escalates to eng-mgr. The eng-mgr agent surfaces the conflict to the human engineering manager with context and options, gets a decision, and unblocks the downstream agent.

---

## infra agent
**Phase:** Cross-cutting (infrastructure concerns)
**Human counterpart:** Infrastructure Engineer
**Channel:** N/A
**Output:** Infrastructure configuration, deployment changes
**Status:** Planned

Handles infrastructure concerns that arise during engineering: new environment variables, new third-party service integrations, Vercel configuration changes, database provisioning. Works against `infra/` in the product repo.

---

## data agent
**Phase:** Cross-cutting (data model and pipeline)
**Human counterpart:** Data Engineer
**Channel:** N/A
**Output:** Data model changes, pipeline definitions
**Status:** Planned

Handles data model and pipeline concerns: schema changes, event definitions, analytics instrumentation. Reads the data model constraints in `specs/architecture/` before making any schema decisions.
