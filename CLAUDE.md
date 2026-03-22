# CLAUDE.md — agentic-sdlc Agent Entry Point

> Read this before doing anything. These are non-negotiable constraints.

---

## What is this repo?

`agentic-sdlc` is a standalone AI-powered SDLC platform. It is a **generic product** — not tied to any specific app. It connects to any team's Slack workspace and GitHub repo via `WorkspaceConfig`. Health360 is the first customer, not a dependency.

---

## Core Principles (Non-Negotiable)

### 1. Single source of truth
The target repo (e.g. `agentic-health360`) is the authoritative source for all product context — vision, architecture, specs. **Never duplicate this information.** No summary files, no cached copies, no hardcoded excerpts. If an agent needs context, it reads it from the repo. If it needs a subset, it filters programmatically (relevance filtering via Haiku, not truncation).

**Violation examples to avoid:**
- Adding a `PRODUCT_SUMMARY.md` that mirrors `PRODUCT_VISION.md`
- Using `.slice(0, 3000)` to truncate a document
- Hardcoding any product name, repo path, channel name, or spec path as a string literal

### 2. No hardcoding
Every product-specific coordinate lives in `WorkspaceConfig`. This includes: product name, GitHub owner/repo, Slack channel names, spec file paths. Before writing any string literal that refers to a specific product, repo, or path — stop and check if it should come from config.

### 3. Config is the only coupling point
A new team onboarding to agentic-sdlc changes only their `.env`. Nothing in the codebase changes. If onboarding a new team would require editing a TypeScript file, that is a bug.

### 4. Durable over fast
When two approaches solve the problem — one fast/brittle, one slower/durable — always choose durable. Flag the tradeoff explicitly before implementing. Never implement a shortcut without saying so and getting confirmation.

### 5. Extensibility by default
Every agent, function, and data structure should be built assuming more agents and more teams are coming. The pattern established for the pm agent is the pattern for all future agents. Build it right the first time.

---

## Architecture

See `SYSTEM_ARCHITECTURE.md` for the full system design.
See `BACKLOG.md` for the ordered list of what to build next.
See `DECISIONS.md` for solo-team shortcuts that need to change at scale.

---

## Before Writing Any Code

1. Check `BACKLOG.md` — are you working on the right next step?
2. Check `WorkspaceConfig` — does any value you're about to hardcode belong there?
3. Ask: is there a single source of truth for this, and am I reading from it?
4. Ask: if a second team onboarded tomorrow, would this code still work without changes?

---

## Testing Discipline (Non-Negotiable)

Before building the second piece of any system, a test suite must exist for the first. This is not optional and does not require human prompting.

**Current state:** A test suite for the existing pm agent, concierge, routing, GitHub operations, and phase detection is the next item in BACKLOG.md. No new agents are built until it exists.

**Ongoing rule:** Every new agent behavior added must have a corresponding test. A behavior with no test does not count as done.

---

## Definition of Done (Non-Negotiable)

A task is NOT done until the following are updated to reflect the change:

| What changed | What must be updated |
|---|---|
| New agent built or modified | `AGENTS.md` — persona, capabilities, inputs/outputs |
| New runtime behavior, routing, or data flow | `SYSTEM_ARCHITECTURE.md` — architecture section |
| New backlog item completed | `BACKLOG.md` — move to Completed |
| New solo-team shortcut taken | `DECISIONS.md` — add entry with scale gap |
| New WorkspaceConfig field added | `.env.example` — add with comment |

**This applies to every session, every task, without exception.** Do not ask the human if docs need updating — they always do if code changed. Do not defer doc updates to a later session. Update them before marking the task complete.

The CI check in `.github/workflows/` enforces this at the merge level — a PR that touches `agents/` or `runtime/` without touching the relevant docs will fail.
