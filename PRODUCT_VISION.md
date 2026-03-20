# agentic-sdlc — Product Vision

## What it is

agentic-sdlc is a standalone AI-powered software development lifecycle platform. It replaces the informal, human-driven process of turning ideas into shipped software with a structured, agent-assisted workflow where every step is traceable, every handoff is explicit, and no phase can be skipped.

It is built to be sold independently to any software team — from a solo founder wearing every hat, to an enterprise with hundreds of engineers across many feature teams.

## The problem it solves

Software teams waste enormous time on the gap between "we have an idea" and "we have working code." That gap is filled with unclear specs, missed handoffs, design decisions made by engineers, and engineering decisions made by designers. Work starts before it's ready. Specs are incomplete. The wrong person is doing the wrong thing.

agentic-sdlc makes the workflow explicit and assisted at every step:
- The product manager has an AI specialist helping shape and pressure-test the brief
- The UX designer has an AI specialist helping produce clear flows before engineering starts
- The architect has an AI specialist helping produce a rigorous engineering plan
- Engineers have clear, approved specs to build against — no guessing
- Every phase is gated — nothing moves forward until the previous step is approved

## Who uses it

| Role | What they do in agentic-sdlc |
|---|---|
| Product Manager | Shapes feature briefs into product specs through conversation with the pm agent |
| UX Designer | Translates approved product specs into screen flows and component specs with the design agent |
| Software Architect | Translates approved product + design specs into an engineering plan with the architect agent |
| Backend Engineer | Builds server-side features against the approved engineering spec |
| Frontend Engineer | Builds UI features against approved engineering and design specs |
| QA Engineer | Tests the built feature against the original product spec |
| Engineering Manager | Oversees the full pipeline, resolves blockers, reviews gates |

Any of these roles can be played by the same person. The system doesn't enforce headcount — it enforces sequence.

## What makes it different

**Specs are upstream of everything.** No code is written without an approved engineering spec. No engineering spec is written without an approved design spec. No design spec is written without an approved product spec. This is not a convention — it is enforced by the system.

**Agents assist, humans decide.** Every phase has an AI specialist that works through conversation — asking questions, pushing back, surfacing edge cases, auto-saving drafts. But no phase advances without explicit human approval. The human is always in the loop at the gate.

**GitHub is the source of truth.** All specs and work live in GitHub. The Slack workspace is the human interface — the place where conversations happen, approvals are given, and status is checked. The underlying artifacts (specs, code, work items) are always in GitHub and always version-controlled.

**Plain English throughout.** The system never exposes technical concepts to non-technical roles. A PM never sees a "PR" or a "branch." They see "saved," "approved," "in review," "handed off."

**Built to scale.** The workflow is the same whether one person is wearing all the hats or 500 engineers are working in parallel across 50 feature teams. The agent roster, the channel-per-feature model, and the GitHub-backed spec system are all designed for that scale from day one.

## The standalone product pitch

agentic-sdlc connects to any GitHub repository and any Slack workspace. It is not tied to Health360 or any specific app. A team brings:
- Their GitHub repo
- Their Slack workspace
- Their Anthropic API key

agentic-sdlc provides:
- The full agent workflow (pm → design → architect → engineering → qa)
- The Slack entry point and feature channel model
- The spec formats and auto-save system
- The GitHub-backed state machine (phase detection from branches and merged files)
- The plain-English human interface for non-technical roles

## Current state (as of Q1 2026)

The pm agent is live and working. The full workflow from feature idea to approved product spec is operational:
- Entry point concierge in the main Slack channel
- pm agent in feature channels — shapes specs through conversation, auto-saves drafts, opens review requests on approval
- Phase detection from GitHub branch state
- Role-aware responses (PM, UX designer, engineer, etc.)

Design, architect, backend, frontend, and QA agents are defined but not yet built. Each will follow the same pattern as the pm agent.
