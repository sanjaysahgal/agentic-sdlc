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

## Subagent Strategy

Use subagents for exploration, research, and parallel analysis — keep the main context focused on implementation decisions. One task per subagent. For broad codebase searches or multi-file analysis, always prefer an Explore subagent over inline grep/read loops.

---

## Self-Correction

After any correction from the user, immediately save a feedback memory so the same mistake does not recur across sessions. Do not wait until the end of the session. The correction is only useful if it persists.

---

## Autonomous Bug Fixing

When given a bug or failing test: fix it end-to-end without hand-holding. Read the error, trace the root cause, implement the fix, verify it works. Do not ask the human to confirm intermediate steps. Zero context-switching cost to the user is the goal.

---

## Demand Elegance

For non-trivial changes: before presenting a solution, ask "is there a more elegant way?" If a fix feels hacky, implement the clean version — not the workaround. Skip this for obvious one-liners. Never sacrifice durability for elegance — the two are not in conflict here, they compound.

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
| New agent goes live | `PRESENTATIONS.md` + `platform-engineering-deep-dive.html` + `investor-pitch.html` |
| Roadmap step completes | `PRESENTATIONS.md` + `investor-pitch.html` + `platform-engineering-deep-dive.html` |
| New Claude Code practice added | `PRESENTATIONS.md` + `ai-engineering-practices.html` |
| Website positioning changes | Cross-check `investor-pitch.html` against `getarchon.dev` |

**This applies to every session, every task, without exception.** Do not ask the human if docs need updating — they always do if code changed. Do not defer doc updates to a later session. Update them before marking the task complete.

The CI check in `.github/workflows/` enforces this at the merge level — a PR that touches `agents/` or `runtime/` without touching the relevant docs will fail.
