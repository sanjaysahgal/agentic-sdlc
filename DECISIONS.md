# agentic-sdlc — Architectural Decisions & Scale Gaps

This file tracks decisions that are correct for a small team today but need to change as the team grows. Every entry has: what we do now, why it works for now, and what it needs to become.

---

## Spec approval → main

**Now:** PM approval in Slack moves the spec directly to `main`. No second reviewer.

**Why it works now:** Solo team. The PM is the only reviewer. Adding a gate would just add friction with no benefit.

**At scale:** PM approval saves the final version to the branch and notifies a designated reviewer (or the spec-validator agent). The spec lands on `main` only after that second approval. This is the gate that prevents unreviewed specs from becoming the source of truth.

---

## Conversation history is in-memory

**Now:** Conversation history per Slack thread is stored in memory. Lost when the bot restarts. The draft spec on GitHub compensates — the pm agent reads it fresh every message.

**Why it works now:** The draft is the real source of truth. Losing conversation history means losing context on what was already discussed, but the spec itself is preserved.

**At scale:** Conversation history needs Redis or a database (e.g. Neon). Without it, the agent may re-ask questions already answered in previous sessions, reducing quality. Also required for audit trails and handoff summaries.

---

## Confirmed agent stored in a local JSON file

**Now:** Which agent is confirmed for each Slack thread is saved to `.confirmed-agents.json` on the machine running the bot.

**Why it works now:** One machine, one bot instance. The file survives restarts.

**At scale:** Multiple bot instances (for reliability or scale) would each have their own file — they'd conflict. Needs to move to Redis or a shared database keyed by thread ID.

---

## Agent triggers are manual (Slack-initiated)

**Now:** Every agent interaction starts with a human sending a message in Slack. There are no automatic triggers.

**Why it works now:** Small team, one feature at a time. Manual initiation is fine.

**At scale:** Spec approval events should automatically notify the next role (e.g. designer) that their phase is ready. Engineering plan approval should automatically create work items via the pgm agent. These triggers should come from GitHub events (spec merged to main) via GitHub Actions — not from humans manually pinging the next person.

---

## Agent confirmation per thread, not per feature phase

**Now:** Once an agent is confirmed for a Slack thread, all follow-up messages in that thread go to the same agent. A new thread re-triggers classification.

**Why it works now:** Fine for the current single-agent (pm) setup.

**At scale:** Agent routing should be phase-aware, not thread-aware. When the feature moves from product spec to design, the channel should automatically route to the design agent without any new classification step. Phase transitions are events, not per-thread decisions.

---

## No spec-validator gate

**Now:** Specs are approved by PM say-so with no automated quality check.

**Why it works now:** One person wearing all hats. They know if the spec is complete.

**At scale:** The spec-validator agent must run automatically when a spec is submitted for approval. It checks: all required sections present, acceptance criteria are testable, open questions are typed (design/engineering/product) and blocking ones are resolved, no conflicts with product vision or architecture. A spec that fails validation cannot advance to the next phase.

---

## Open questions are unstructured

**Now:** Open questions in specs are free-form text under an "Open Questions" section.

**Why it works now:** One person reads the whole spec. They know which questions are for engineering vs design.

**At scale:** Each open question needs a machine-readable type (`design`, `engineering`, `product`, `infra`) and a blocking flag (`true`/`false`). This allows: automatic routing of questions to the right team, blocking phase transitions when blocking questions are unresolved, and the spec-validator to enforce that all blocking questions are answered before approval.

---

## No design phase

**Now:** The workflow goes pm agent → (nothing) → design is mentioned but not implemented.

**Why it works now:** We're still validating the pm agent flow. Building the next agent before this one is solid would be premature.

**At scale:** The design agent is the critical missing link. Without it, engineering starts without complete screens and flows, which means engineers make design decisions in code. The design agent needs to be built next.

---

## Single Slack workspace

**Now:** The bot is wired to one specific Slack workspace and one specific GitHub repo.

**Why it works now:** One product, one team.

**At scale:** agentic-sdlc is a standalone product meant to serve multiple teams and repos. It needs: multi-workspace Slack support, configurable GitHub repo per workspace, and a setup flow for onboarding a new team.

---

## Feature phase read from GitHub on every message

**Now:** Every incoming message triggers a live GitHub API call to determine the feature's current phase (what files exist on main vs branch).

**Why it works now:** Low traffic, one feature, one team. The latency (~200-300ms) is acceptable.

**At scale:** With many features and many users messaging simultaneously, hitting GitHub on every message creates unnecessary API load and adds latency to every response. The phase state should be cached (in Redis or similar) and invalidated only when a spec file is merged to main — which is an infrequent event. The cache key is `featureName → phase`, TTL can be long since phase only changes on explicit approval.

---

## No audit trail

**Now:** There is no log of which agent ran, what it read, what decision was made, and when.

**Why it works now:** One person, full visibility into everything.

**At scale:** Every agent action needs to be logged: message received, context loaded (which spec version), response generated, decision made (draft saved / spec approved / escalated). Required for debugging, compliance, and understanding why a spec was shaped the way it was.
