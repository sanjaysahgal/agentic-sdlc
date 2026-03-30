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

### 3a. Never modify customer repos to serve the platform
The target repo (`agentic-health360` or any future customer repo) is read-only from the platform's perspective. If a platform parser cannot handle the format of a file in the customer repo, fix the parser — never add, modify, or restructure files in the customer repo to make the parser easier.

**This applies even when the change "just adds a section" or "only adds convenience data."** Any change to a customer repo is a product decision and requires explicit user approval framed as such — not an implementation shortcut made behind the scenes.

**Before touching any file in a customer repo:** stop and ask "Is this a product decision the user has approved, or am I doing this to work around a platform limitation?" If the latter, fix the platform.

### 4. Durable over fast
When two approaches solve the problem — one fast/brittle, one slower/durable — always choose durable. Flag the tradeoff explicitly before implementing. Never implement a shortcut without saying so and getting confirmation.

### 6. Never bypass an agent — ever
An agent bypass is any implementation that reads state directly (GitHub, disk, memory) and produces output without calling the agent. **Do not propose it. Do not recommend it as an option. Do not implement it.**

The reason is correctness, not performance: agents hold conversation context that the platform cannot access. Bypassing an agent means losing uncommitted decisions, in-flight reasoning, and any context that exists only in the conversation history. The output will be stale or wrong.

**Platform enforcement means enforcing the output shape — not replacing the agent.** If the design agent needs to render a preview, the platform injects a PLATFORM OVERRIDE that tells the agent what block to output. The agent still runs. Platform enforcement = mandatory output block. Platform bypass = agent never called. These are opposites, not synonyms.

**If you are about to write code that reads from GitHub/disk and generates output without calling the agent: stop. That is a bypass. Do not propose it as one option among several. Propose only the agent-in-the-loop approach.**

### 5. Extensibility by default
Every agent, function, and data structure should be built assuming more agents and more teams are coming. The pattern established for the pm agent is the pattern for all future agents. Build it right the first time.

### 7. Zero human errors of omission — the specialist always surfaces violations proactively

**This is the founding premise of Archon. It is not a feature. It cannot be added later.**

The human cannot be expected to know what to ask. They don't know what they don't know. It is the agent's job — not the human's — to detect and surface every constraint violation, gap, conflict, and drift on every response. No check should be trigger-phrase-dependent. No audit should wait for the human to notice a problem and ask the right question.

**What this means in practice:**
- If a spec has blocking questions, the agent surfaces them — without being asked
- If brand tokens have drifted from BRAND.md, the agent flags it — without being asked
- If a design decision contradicts the product spec, the agent stops — without being asked
- If committed decisions exist that aren't in the spec, the agent surfaces them — without being asked

**Every agent must implement a proactive audit for its domain:**
- PM agent → `spec-auditor.ts` runs on every draft save (conflict + gap detection)
- Design agent → `brand-auditor.ts` runs on every response (brand token drift), spec-auditor on every draft save
- Architect agent → `spec-auditor.ts` runs on every draft save (conflict + gap detection)
- Every future agent → must define and wire its equivalent proactive audit before the agent is considered complete

**The test for compliance:** Could a human approve a spec with a known violation without being told? If yes, the audit is missing or mis-wired.

**Violation examples to avoid:**
- Implementing a check that only fires when the user says a specific phrase ("the preview looks wrong")
- Adding a constraint check to the system prompt as an instruction ("if you see drift, surface it") — prompt rules are probabilistic, not deterministic
- Writing an audit that runs on some response paths but not others
- Deferring a constraint check to "when we have more time"

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

### Fixture Rule (Non-Negotiable)

**Any component that parses agent output must be tested against real agent output — not hand-crafted strings.**

This is not optional and applies to every parser, every auditor, every block detector, every classifier in the platform.

**The rule:**
- When adding a parser that reads agent output (spec blocks, patch blocks, brand sections, classification responses), capture a real sample from an actual agent run and commit it to `tests/fixtures/agent-output/`
- The test must load the fixture via `readFileSync` — not reproduce the format from memory or approximation
- Hand-crafted inline strings are only acceptable for explicit edge cases (empty string, partial input, boundary conditions) — never for format validation

**Why this rule exists:**
The brand auditor bug (March 2026) was caused by a regex that matched the assumed format (`--token: #RRGGBB`) but not the real format (`` `--token:` `#RRGGBB` ``). All tests passed because the test fixtures were hand-crafted to match the assumed format. The parser silently produced zero results in production. The tests gave false confidence — they validated an input that never appears.

**Enforcement:** Every new parser that ships without a real-agent-output fixture is considered incomplete. A "behavior with no real fixture" is the same failure class as "a behavior with no test." A PR that adds a parser without a sourced fixture will be flagged.

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
