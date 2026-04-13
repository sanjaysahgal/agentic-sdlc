# agentic-sdlc — Architectural Decisions & Scale Gaps

This file tracks decisions that are correct for a small team today but need to change as the team grows. Every entry has: what we do now, why it works for now, and what it needs to become.

---

## Spec approval → main

**Now:** PM approval in Slack moves the spec directly to `main`. No second reviewer.

**Why it works now:** Solo team. The PM is the only reviewer. Adding a gate would just add friction with no benefit.

**At scale:** PM approval saves the final version to the branch and notifies a designated reviewer (or the spec-validator agent). The spec lands on `main` only after that second approval. This is the gate that prevents unreviewed specs from becoming the source of truth.

---

## Conversation history lives on local disk, not in a shared store

**Now:** Conversation history per Slack thread is written to `.conversation-history.json` on the machine running the bot. It survives process restarts but is lost on redeployments and does not work across multiple bot instances.

**Why it works now:** One machine, one process. The draft spec on GitHub compensates — every agent reads the current spec from GitHub on every message, so the spec state is always fresh even if history is lost.

**At scale:** Conversation history needs Redis. Without it: (a) a redeploy wipes all in-flight conversation context; (b) horizontal scaling (two bot processes) means different instances have split views of the same thread; (c) the agent may re-ask questions already answered in previous sessions. Trust Step 3 in the backlog — pull forward before any significant traffic increase.

---

## Confirmed agent stored in a local JSON file

**Now:** Which agent is confirmed for each Slack thread is saved to `.confirmed-agents.json` on the machine running the bot.

**Why it works now:** One machine, one bot instance. The file survives restarts.

**At scale:** Multiple bot instances (for reliability or scale) would each have their own file — they'd conflict. Needs to move to Redis or a shared database keyed by thread ID.

---

## Ephemeral conversation state persisted to `.conversation-state.json`

**Now:** `pendingEscalation`, `pendingApproval`, and `escalationNotification` are persisted to `.conversation-state.json` on every write and loaded on startup. Previously these lived in memory only — a server restart (e.g. nodemon on code change) silently wiped pending state, causing users who said "yes" after a code push to have their confirmation ignored and the design agent re-run instead of triggering PM escalation.

**Why it works now:** One machine, one process. The file survives nodemon restarts. If the process crashes mid-write, the file may be stale by one operation — acceptable for a solo-team setup.

**At scale:** Needs Redis. Same constraints as conversation history and confirmed agents.

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

## Spec revision not yet handled — live features misidentified as new

**Now:** Once a feature's spec branches are deleted and all specs are on `main`, `getInProgressFeatures()` loses track of it. `getFeaturePhase()` falls back to `"product-spec-in-progress"`. A user returning to a live feature to revise anything gets routed as if starting a new feature — no existing spec context, no editor mode.

**Why it works now:** health360 has one feature (onboarding) still in the spec chain. No feature has cleared all three spec layers yet, so this gap hasn't been hit in production.

**At scale:** Every feature that ships will eventually be revised. The system must detect `"feature-established"` state (specs on main, no active branches), route intent to the right layer (product/design/engineering), and load the existing spec as editor context. See Step 2.6.

---

## Spec cascade not enforced

**Now:** When a product spec is updated, the existing design and engineering specs are not flagged as potentially stale. The system posts a note ("design spec may need a revision pass") but does not enforce or track whether the downstream spec was actually reviewed.

**Why it works now:** Solo team. One person wears all hats and knows which downstream specs need updating.

**At scale:** A proper impact analysis is needed — when an upstream spec changes, automatically identify which downstream specs reference the changed section, flag them as "stale pending review", and block the next phase transition until a human confirms the downstream spec is still valid.

---

## No bug workflow

**Now:** Bugs discovered in production have no intake path through the system. They are tracked manually (GitHub Issues, Slack messages, memory) with no structured triage, assignment, or resolution loop.

**Why it works now:** No code is in production yet. health360 hasn't shipped.

**At scale:** Once engineer agents are shipping code (Step 6), bugs will appear. Without a structured workflow they pile up untracked. See Step 2.7.

---

## No audit trail

**Now:** There is no log of which agent ran, what it read, what decision was made, and when.

**Why it works now:** One person, full visibility into everything.

**At scale:** Every agent action needs to be logged: message received, context loaded (which spec version), response generated, decision made (draft saved / spec approved / escalated). Required for debugging, compliance, and understanding why a spec was shaped the way it was.

---

## Agent reasons from history, not from spec — trust gap

**Now:** Agents maintain two knowledge sources simultaneously: (a) the spec on GitHub, which is read fresh on every message, and (b) the conversation history, which tells the agent what was discussed. In practice, agents sometimes reason from unverified history ("I saved those decisions") rather than confirmed spec state. This causes hallucination: the agent asserts things are saved when they are only in conversation history, not in the GitHub spec.

**Why it works now (poorly):** A solo user can detect the inconsistency and ask the agent to re-confirm. The damage is embarrassment and re-work, not data loss — the spec on GitHub is always the authority.

**At scale:** The agent must not assert the state of anything that can be verified from GitHub unless it has actually read it from GitHub in the current turn. Spec state responses must be derived from GitHub reads, not from memory. The checkpoint protocol (Trust Step 2) addresses this: after every draft save, the agent explicitly distinguishes "committed to GitHub" from "discussed this turn." Until this is enforced, users cannot trust agent assertions about what is saved.

---

## No thread health monitoring — context limit failure is silent

**Now:** When a Slack thread accumulates enough history to approach the model's context limit, the next call either silently fails or returns a degraded response. There is no warning before this happens and no recovery path after. The user sees the agent go quiet or give wrong answers with no explanation.

**Why it works now (poorly):** Specs are developed over relatively short threads. Health360's early sessions stayed well within limits. The failure mode has appeared (evident from user transcripts) but was survivable.

**At scale:** Long feature threads — especially ones that span multiple sessions or involve many revision cycles — will hit the limit reliably. Trust Step 1 in the backlog: implement a turn counter and proactive degradation warning at ~70% of estimated capacity ("This thread is getting long — I'd recommend opening a new thread for the next phase or continuing from a spec link to preserve full context."). When the limit is actually hit, the error must surface explicitly to the user, not silently produce wrong output.

---

## Legacy conversation history merged across all features (threadTs migration shortcut)

**Now:** Before the featureName-keying migration, history was stored under Slack `threadTs` float strings. On startup, `migrateThreadTsKeys()` in `conversation-store.ts` consolidates all those entries into a single `"_legacy_"` key. `getHistory(featureName)` then merges `_legacy_` into every featureName lookup — meaning all legacy messages appear in every feature's history.

**Why it works now:** Health360 has one active feature (`onboarding`). All pre-migration history belongs to that feature. Merging it into every featureName call has no visible side effects.

**At scale:** With multiple features, `getHistory("feature-B")` would include all messages from `"feature-A"`. This would inject irrelevant context into `identifyUncommittedDecisions` and produce garbage results. The fix requires a `threadTs → featureName` index built from Slack channel metadata — the channel name of each thread's parent message maps to the featureName. This index must be populated when messages are received (the Slack `channel` field on every event) and stored alongside the conversation history. At that point, `migrateThreadTsKeys()` can re-key each legacy entry to its correct featureName.
