# Routing State Machine

> **Status:** Phase 0 spec — describes today's behavior **including known bugs**. Bugs are encoded as **FLAG** entries; they are fixed as deliberate spec edits in Phase 5 of the refactor (see `~/.claude/plans/elegant-percolating-newell.md` and the BACKLOG entry "Routing state machine refactor").
>
> **Contract:** This document is the spec. The matrix tests in `tests/invariants/routing-matrix.test.ts` parse this file and verify that `routeFeatureMessage` and `routeGeneralMessage` produce the expected `RoutingDecision.kind` for every row. Drift between this doc and the code is structurally impossible — changing one without the other fails CI.

---

## 1. Glossary

| Term | Definition |
|---|---|
| **Entry point** | How a Slack message arrived: direct (no prefix), slash command (`/pm`, `/design`, `/architect`), `@-prefix` (`@pm:`, `@design:`, `@architect:`), or follow-up in a slash-spawned thread. |
| **State** | The set of `Pending*`, `Notification`, `Confirmed*` values currently set for a given feature (or thread, for general channel). |
| **Phase** | The GitHub-derived spec lifecycle phase of a feature (e.g. `design-in-progress`). The general channel has no phase. |
| **Decision** | A single `RoutingDecision` value of one specific `kind`. The router emits exactly one decision per `RoutingInput`. |
| **Post-agent intent** | A second-pass `RoutingInput` built after an agent has run and possibly mutated state. Bounded depth = 1 (invariant I17). |
| **Effect** | A `StateEffect` (write to conversation store) or `PostEffect` (Slack message, GitHub write, re-evaluate). Effects are data, not closures; the dispatcher executes them in fixed order. |
| **Channel** | Either a feature channel (`#feature-{name}`) or the general/concierge channel. Each has its own router; both share the dispatcher. |

---

## 2. Entry points (closed set)

### 2.1 Feature channel

| ID  | Description                                                           | Sets thread-agent? |
|-----|-----------------------------------------------------------------------|--------------------|
| E1  | Direct message in `#feature-{name}` (no agent prefix)                 | no                 |
| E2  | `/pm` slash command                                                    | yes                |
| E3  | `/design` slash command                                                | yes                |
| E4  | `/architect` slash command                                             | yes                |
| E5  | `@pm:` prefix at start of message                                      | yes                |
| E6  | `@design:` prefix at start of message                                  | yes                |
| E7  | `@architect:` prefix at start of message                               | yes                |
| E8  | Follow-up in a thread that previously had a slash override (no prefix) | no (already set)   |

### 2.2 General channel

| ID  | Description                                            | Sets thread-agent? |
|-----|--------------------------------------------------------|--------------------|
| G1  | Direct message to concierge in `#general`              | no                 |
| G2  | `/pm` in `#general`                                    | yes                |
| G3  | `/design` in `#general`                                | yes                |
| G4  | `/architect` in `#general`                             | yes                |
| G5  | Follow-up in a thread with a previously-set thread agent | no (already set)   |

---

## 3. State variables

| ID  | Variable                  | Scope                | TTL              | Cross-channel? |
|-----|---------------------------|----------------------|------------------|----------------|
| S1  | `confirmedAgent`          | per-feature          | none             | feature only   |
| S2  | `threadAgent`             | per-thread           | none             | both           |
| S3  | `pendingEscalation`       | per-feature          | 24h              | feature only   |
| S4  | `escalationNotification`  | per-feature          | clear-on-startup | feature only   |
| S5  | `pendingApproval`         | per-feature          | 24h              | feature only   |
| S6  | `pendingDecisionReview`   | per-feature          | 24h              | feature only   |
| S7  | `isUserOriented`          | per-feature × user   | none             | feature only   |

Persistence: S1 in `.confirmed-agents.json`; S3/S5/S6/S2/S7 in `.conversation-state.json`. S4 is in-memory only and unconditionally cleared on startup (it lacks a timestamp; human context is lost across restarts).

---

## 4. Phases (closed set)

| Phase                                         | Canonical agent | Notes                                              |
|-----------------------------------------------|-----------------|----------------------------------------------------|
| `product-spec-in-progress`                    | `pm`            | Initial state; no spec on main yet.                |
| `product-spec-approved-awaiting-design`       | `ux-design`     | Product on main, no design branch yet.             |
| `design-in-progress`                          | `ux-design`     | Design draft branch active.                        |
| `design-approved-awaiting-engineering`        | `architect`     | Product + design on main, no engineering branch.   |
| `engineering-in-progress`                     | `architect`     | Engineering draft branch active.                   |
| `complete`                                    | (none)          | All three specs on main, all draft branches deleted, no active escalation/approval/review. See §5. |

Phase is determined deterministically from GitHub branch state by `resolveAgent()` (today: `interfaces/slack/handlers/message.ts:236`). The pure router never reads GitHub; the snapshot includes the resolved phase.

---

## 5. The `complete` phase rules

A feature reaches `complete` when:

- All three specs (`product`, `design`, `engineering`) exist on `main`
- No `spec/{name}-{product,design,engineering}` branches exist
- No `pendingEscalation`, `escalationNotification`, `pendingApproval`, `pendingDecisionReview`
- `confirmedAgent` is unset OR matches the most recent slash override

Behavior in `complete` phase:

- **Direct messages (E1):** `show-routing-note` ("Feature is complete. Use `/pm`, `/design`, or `/architect` to discuss.")
- **Slash overrides (E2/E3/E4) and `@-prefix` (E5/E6/E7):** `run-agent(addressedAgent, mode: "read-only-consultant")` with consultant template explaining the feature is complete and offering to reopen.
- **Reopen flow:** the placeholder decision `show-reopen-confirmation-prompt` exists in the `RoutingDecision` union for forward compatibility (see BACKLOG: "Spec iteration — reopen approved specs via slash override"). Implementation is out of scope for this refactor.

Invariant **I20** prevents silent reopening: any decision in `complete` phase whose `preEffects` includes `set-pending-*` requires an explicit reopen confirmation flow.

---

## 6. The `pendingDecisionReview` multi-turn shape

The architect's resolved-questions flow is multi-item and multi-turn. When the architect saves an engineering spec and the platform detects N resolved open questions, state is set to:

```ts
{
  items: [{question: string, resolution: string}, ...],   // length N
  cursor: 0,
  filePath: string,
  specContent: string,
  featureName: string,
  timestamp: number
}
```

Each turn:

1. Show item `[cursor]` via `show-decision-review-prompt`.
2. User affirmative → `confirm-decision-review-item` → `advance-decision-review-cursor` StateEffect.
   - If `cursor + 1 === items.length` → `complete-decision-review` (writeback all resolutions to engineering spec on main, clear state, fall through to architect with completion context).
   - Otherwise → loop to step 1 with the next item.
3. User non-affirmative on any item → `reject-decision-review-fall-through` → `clear-pending-decision-review` StateEffect; routing falls through as if the review never existed (architect handles the rejection in its normal flow).

Invariant **I3** enforces precedence: while `pendingDecisionReview` is set, only the four decisions above are reachable.

---

## 7. Invariants (master list)

1. **I1 — Slash-as-confirmation.** A slash command (E2–E7) addressing the agent currently held by `pendingEscalation.targetAgent` counts as confirmation, equivalent to "yes".
   - **Today's behavior (FLAG-A):** today's code evaluates the universal-guard `pendingEscalation` hold BEFORE the slash override. Result: `@pm:` while `pendingEscalation.targetAgent === "pm"` shows the hold message instead of running the escalation. **Encoded as `show-hold-message` rows in the matrix below; rewritten in Phase 5.**
2. **I2 — Closed `targetAgent`.** `pendingEscalation.targetAgent ∈ AgentRegistry.ids`. Anything else → `invalid-state` decision with `cleanupEffects`.
   - **Today's behavior (FLAG-B):** corrupt values silently route to the wrong agent or crash. **Encoded as undefined behavior; defined in Phase 5.**
3. **I3 — Decision review precedence (multi-turn).** While `pendingDecisionReview` is set, the only reachable decisions are `show-decision-review-prompt`, `confirm-decision-review-item`, `complete-decision-review`, `reject-decision-review-fall-through`.
4. **I4 — Stale clearance happens at startup**, not at routing. The router assumes the snapshot is fresh; 24h-TTL'd entries are dropped at startup before any message is routed.
5. **I5 — Slash-override read-only-by-default** for any agent invoked outside its phase, with consultant template from registry.
6. **I6 — Tenant isolation** at the type level via `FeatureKey`/`ThreadKey`. Cross-tenant or feature-vs-thread mixups are compile errors.
7. **I7 — Hold-message labels derived from registry**, not hardcoded literals.
   - **Today's behavior (FLAG-C):** the hold message hardcodes "Design is paused" regardless of which phase the active agent occupies. Architect-phase escalations show the wrong label. **Encoded; rewritten in Phase 5.**
8. **I8 — `originAgent` required.** `EscalationNotification.originAgent: AgentId` (no `?`). On-disk records without it are cleared during startup migration in Phase 5.
   - **Today's behavior (FLAG-D):** `originAgent` is optional; corrupt notifications can route to wrong agent.
9. **I9 — `pendingEscalation` is exclusive.** Only `show-hold-message`, `run-escalation-confirmed`, or `invalid-state` are reachable while `pendingEscalation` is set. (Combined with I1 in Phase 5 to allow slash-as-confirmation.)
10. **I10 — Approval scoped to spec-owner.** `pendingApproval` blocks dispatch only for the agent that owns the matching spec type (PM owns product, Designer owns design, Architect owns engineering).
11. **I11 — Phase agent ownership single-valued.** `AGENT_REGISTRY` rejects (compile-time) two agents claiming the same phase.
12. **I12 — Decision purity.** `routeFeatureMessage` and `routeGeneralMessage` make no I/O calls. Enforced by ESLint `no-restricted-imports` on those files.
13. **I13 — Decision exhaustiveness.** Every `RoutingDecision` is `kind`-discriminated; the dispatcher exhaustively `switch`es with `assertNever`. Adding a new kind without adding a dispatcher case is a type error.
14. **I14 — Spec-test correspondence.** Matrix test row count is snapshotted; this file is read by tests. Spec drift fails CI.
15. **I15 — In-flight lock is the dispatcher's responsibility**, never the router's. The router runs at most once per Slack event by construction (or twice via bounded re-evaluate; see I17).
16. **I16 — Phase transition wipes history.** Whenever `set-confirmed-agent` changes the agent (current ≠ new), `clear-history-on-phase-change` MUST be the next preEffect. Validated structurally in `dispatch.ts` via `assertCoupledEffects`.
17. **I17 — Re-evaluate is bounded.** `RoutingInput.depth: 0 | 1`. The dispatcher refuses a `re-evaluate` PostEffect when `depth === 1`.
18. **I18 — Post-agent intent has dedicated rows.** A `RoutingInput` with `intent.kind === "post-agent"` is routed exclusively against the post-agent matrix (§10).
19. **I19 — General and feature channels share the same `RoutingDecision` shape.** Type-level: `routeFeatureMessage` and `routeGeneralMessage` return the same union.
20. **I20 — `complete` phase routing is non-mutating by default.** Any decision in `complete` phase whose `preEffects` includes `set-pending-*` requires an explicit reopen confirmation flow.

---

## 8. Decision matrix — feature channel

State columns are abbreviated. `—` means the state is null/unset. State combinations marked impossible by construction are omitted.

### 8.1 Phase: `product-spec-in-progress`

| Entry | confirmedAgent | pendingEscalation | escalationNotification | pendingApproval (product) | userMsg                  | → Decision                                                  | Inv |
|-------|----------------|-------------------|------------------------|---------------------------|--------------------------|-------------------------------------------------------------|-----|
| E1    | pm             | —                 | —                      | —                         | "anything"               | run-agent(pm, primary)                                      | —   |
| E1    | pm             | —                 | —                      | set                       | "yes"                    | approve-spec(product)                                       | I10 |
| E1    | pm             | —                 | —                      | set                       | "no" / non-affirmative   | decline-approval-fall-through                               | I10 |
| E2    | pm             | —                 | —                      | —                         | "@pm: anything"          | run-agent(pm, primary)                                      | —   |
| E3    | pm             | —                 | —                      | —                         | "@design: anything"      | run-agent(ux-design, read-only-consultant)                  | I5  |
| E4    | pm             | —                 | —                      | —                         | "@architect: anything"   | run-agent(architect, read-only-consultant)                  | I5  |
| E1    | —              | —                 | —                      | —                         | any (new thread)         | classify-and-route → run-agent(pm, primary)                 | —   |

### 8.2 Phase: `product-spec-approved-awaiting-design`

| Entry | confirmedAgent | pendingEscalation | escalationNotification | pendingApproval | userMsg                | → Decision                                              | Inv |
|-------|----------------|-------------------|------------------------|-----------------|------------------------|---------------------------------------------------------|-----|
| E1    | ux-design      | —                 | —                      | —               | "anything"             | run-agent(ux-design, primary, mode=orientation if !S7)  | —   |
| E5    | ux-design      | —                 | —                      | —               | "@pm: anything"        | run-agent(pm, read-only-consultant)                     | I5  |

### 8.3 Phase: `design-in-progress`

| Entry | confirmedAgent | pendingEscalation | escalationNotification | pendingApproval | userMsg                  | → Decision                                                            | Inv |
|-------|----------------|-------------------|------------------------|-----------------|--------------------------|-----------------------------------------------------------------------|-----|
| E1    | ux-design      | —                 | —                      | —               | "where are we"           | run-agent(ux-design, primary)                                         | —   |
| E1    | ux-design      | target=pm         | —                      | —               | "tell me more"           | show-hold-message(reason=esc, heldAgent=pm)                           | I7, I9 |
| E1    | ux-design      | target=pm         | —                      | —               | "yes"                    | run-escalation-confirmed(origin=ux-design, target=pm)                 | I9  |
| E5    | ux-design      | target=pm         | —                      | —               | "@pm: actually..."       | show-hold-message(reason=esc, heldAgent=pm) **[FLAG-A — fixed Phase 5: run-escalation-confirmed]** | I1, FLAG-A |
| E1    | ux-design      | target=architect  | —                      | —               | "tell me more"           | show-hold-message(reason=esc, heldAgent=architect)                    | I7, I9 |
| E1    | ux-design      | target=architect  | —                      | —               | "yes"                    | run-escalation-confirmed(origin=ux-design, target=architect)          | I9  |
| E1    | ux-design      | target=corrupt    | —                      | —               | any                      | undefined behavior **[FLAG-B — fixed Phase 5: invalid-state]**        | I2, FLAG-B |
| E1    | ux-design      | —                 | target=pm, origin=design | —             | "approved for #4..." (non-standalone) | run-escalation-continuation(target=pm)                  | —   |
| E1    | ux-design      | —                 | target=pm, origin=design | —             | "yes" (standalone)       | resume-after-escalation(origin=ux-design) + writeback                 | —   |
| E1    | ux-design      | —                 | target=architect, origin=design | —      | "yes" (standalone)       | resume-after-escalation(origin=ux-design) + writeback                 | —   |
| E1    | ux-design      | —                 | —                      | set (design)    | "yes"                    | approve-spec(design)                                                  | I10 |
| E5    | ux-design      | —                 | —                      | —               | "@pm: any thoughts?"     | run-agent(pm, read-only-consultant)                                   | I5  |
| E6    | ux-design      | —                 | —                      | —               | "@design: how about X"   | run-agent(ux-design, primary)                                         | —   |
| E7    | ux-design      | —                 | —                      | —               | "@architect: any thoughts?" | run-agent(architect, read-only-consultant)                         | I5  |

### 8.4 Phase: `design-approved-awaiting-engineering`

| Entry | confirmedAgent | pendingEscalation | escalationNotification | pendingApproval | userMsg                | → Decision                                                  | Inv |
|-------|----------------|-------------------|------------------------|-----------------|------------------------|-------------------------------------------------------------|-----|
| E1    | architect      | —                 | —                      | —               | "anything"             | run-agent(architect, primary, mode=orientation if !S7)      | —   |
| E5    | architect      | —                 | —                      | —               | "@pm: anything"        | run-agent(pm, read-only-consultant)                         | I5  |
| E6    | architect      | —                 | —                      | —               | "@design: anything"    | run-agent(ux-design, read-only-consultant)                  | I5  |

### 8.5 Phase: `engineering-in-progress`

| Entry | confirmedAgent | pendingEscalation | escalationNotification | pendingApproval | pendingDecisionReview | userMsg                | → Decision                                                | Inv |
|-------|----------------|-------------------|------------------------|-----------------|-----------------------|------------------------|-----------------------------------------------------------|-----|
| E1    | architect      | —                 | —                      | —               | —                     | "anything"             | run-agent(architect, primary)                             | —   |
| E1    | architect      | target=pm         | —                      | —               | —                     | "tell me more"         | show-hold-message(reason=esc, heldAgent=pm)               | I7, I9 |
| E1    | architect      | target=pm         | —                      | —               | —                     | "yes"                  | run-escalation-confirmed(origin=architect, target=pm)     | I9  |
| E1    | architect      | target=design     | —                      | —               | —                     | "yes"                  | run-escalation-confirmed(origin=architect, target=ux-design) | I9 |
| E5    | architect      | target=pm         | —                      | —               | —                     | "@pm: actually..."     | show-hold-message **[FLAG-A — fixed Phase 5]**            | I1, FLAG-A |
| E1    | architect      | —                 | target=pm, origin=architect | —          | —                     | "yes" (standalone)     | resume-after-escalation(origin=architect) + writeback     | —   |
| E1    | architect      | —                 | —                      | set (engineering) | —                   | "yes"                  | approve-spec(engineering)                                 | I10 |
| E1    | architect      | —                 | —                      | —               | set                   | (any except affirm/decline) | show-decision-review-prompt(items[cursor])           | I3  |
| E1    | architect      | —                 | —                      | —               | set                   | "yes"                  | confirm-decision-review-item → next prompt OR complete    | I3  |
| E1    | architect      | —                 | —                      | —               | set                   | non-affirmative        | reject-decision-review-fall-through                       | I3  |

### 8.6 Phase: `complete`

| Entry | confirmedAgent | userMsg                | → Decision                                              | Inv |
|-------|----------------|------------------------|---------------------------------------------------------|-----|
| E1    | any/none       | "anything"             | show-routing-note(complete)                             | I20 |
| E2    | any/none       | "@pm: anything"        | run-agent(pm, read-only-consultant, complete-template)  | I5, I20 |
| E3    | any/none       | "@design: anything"    | run-agent(ux-design, read-only-consultant, complete-template) | I5, I20 |
| E4    | any/none       | "@architect: anything" | run-agent(architect, read-only-consultant, complete-template) | I5, I20 |

Reopen flow: out of scope for this refactor. The `show-reopen-confirmation-prompt` decision exists as a placeholder; today's behavior is "stay read-only" (BACKLOG: spec iteration item).

---

## 9. Decision matrix — general channel

The general channel has no GitHub-derived phase. Routing is concierge-driven; slash commands set a `threadAgent` so follow-ups stay with the addressed agent.

| Entry | threadAgent | userMsg                | → Decision                                              | Inv |
|-------|-------------|------------------------|---------------------------------------------------------|-----|
| G1    | —           | "anything"             | run-agent(concierge, primary)                           | —   |
| G2    | —           | "@pm: anything"        | run-agent(pm, primary, product-level) + set-thread-agent(pm) | —   |
| G3    | —           | "@design: anything"    | run-agent(ux-design, primary, product-level) + set-thread-agent(ux-design) | — |
| G4    | —           | "@architect: anything" | run-agent(architect, primary, product-level) + set-thread-agent(architect) | — |
| G5    | pm          | "anything" (no prefix) | run-agent(pm, primary, product-level)                   | —   |
| G5    | ux-design   | "anything" (no prefix) | run-agent(ux-design, primary, product-level)            | —   |
| G5    | architect   | "anything" (no prefix) | run-agent(architect, primary, product-level)            | —   |
| G2/G3/G4 | any (different from new prefix) | "@<other>: anything" | run-agent(<other>, primary, product-level) + set-thread-agent(<other>) — overrides prior thread agent | — |

**Note:** Today, product-level mode runs agents without spec-writing tools (BACKLOG: "Product-level doc editing"). The `mode: "primary, product-level"` indicates the agent runs but its toolset is restricted by the registry's product-level template. This refactor does not change that surface.

---

## 10. Post-agent decision matrix

Triggered when `intent.kind === "post-agent"` (depth = 1). Built by the dispatcher after an agent's tool calls have mutated state.

| Trigger (state set during agent run)            | → Decision                                              | Notes |
|------------------------------------------------|---------------------------------------------------------|-------|
| `pendingEscalation` was set by tool call       | show-escalation-offer-prompt                            | Agent's own offer; not a hold. |
| `pendingApproval` was set by tool call         | show-approval-prompt                                    | Surfaces approval CTA. |
| `pendingDecisionReview` was set by tool call   | show-decision-review-prompt(items[0])                   | Multi-turn entry. |
| Writeback succeeded; re-audit clean            | resume-after-escalation(origin) + post-slack-message    | Origin agent resumes. |
| Writeback succeeded; re-audit dirty            | set-pending-escalation (new brief) + show-hold-message  | Re-escalate. |
| Writeback failed                               | set-pending-escalation (retry brief) + show-hold-message | Today's "writeback failure compensation". |
| No state change                                | (no second pass — re-evaluate not in postEffects)       | — |

Exhaustiveness: depth=1 inputs are routed exclusively against this matrix (I18). Any combination not listed is a `no-op` (the dispatcher does not call the router again).

---

## 11. Decision composition rules

### 11.1 `preEffects` derivation

Every decision's `preEffects` is the minimum set of state writes required to make the post-decision snapshot consistent:

- `run-escalation-confirmed`: `[clear-pending-escalation, set-escalation-notification]`
- `resume-after-escalation`: `[clear-escalation-notification]`
- `confirm-decision-review-item`: `[advance-decision-review-cursor]`
- `complete-decision-review`: `[clear-pending-decision-review]`
- `reject-decision-review-fall-through`: `[clear-pending-decision-review]`
- `decline-approval-fall-through`: `[clear-pending-approval]`
- `approve-spec`: `[clear-pending-approval]`
- Phase transition (any decision that changes confirmedAgent): `[set-confirmed-agent, clear-history-on-phase-change]` (I16)

### 11.2 Decision equivalence

Two decisions are equivalent if their `kind`, agent (if any), and `preEffects` (as a sorted set) are equal. `postEffects` are NOT part of identity — they describe writebacks and follow-ups, not routing.

### 11.3 Default rules (apply when no row matches)

- If `confirmedAgent` matches the phase's canonical agent and no pending state is set → `run-agent(confirmedAgent, primary)`.
- If `confirmedAgent` is unset → classify-and-route via `resolveAgent()` then `run-agent(canonicalAgent, primary)`.
- If a slash override addresses an agent that does NOT own the current phase → `run-agent(addressedAgent, read-only-consultant)` (I5).
- Otherwise (no rule matches) → `invalid-state(no-rule-matched)` with cleanup.

---

## 12. FLAG entries (today's bugs encoded)

| ID      | Description                                                                                              | Where in matrix       | Phase 5 fix                        |
|---------|----------------------------------------------------------------------------------------------------------|-----------------------|------------------------------------|
| FLAG-A  | `@pm:` while `pendingEscalation.targetAgent === "pm"` shows hold message instead of running confirmation | §8.3, §8.5            | I1 — slash-as-confirmation          |
| FLAG-B  | Corrupt `targetAgent` value silently routes to wrong agent or crashes                                    | §8.3                  | I2 — invalid-state with cleanup     |
| FLAG-C  | Hold message hardcodes "Design is paused" regardless of actual paused phase                              | All hold-message rows | I7 — registry-derived label         |
| FLAG-D  | `EscalationNotification.originAgent` is optional; missing values can route to wrong agent on resume      | §8.3, §8.5            | I8 — required at type level         |
| FLAG-E  | `pendingEscalation.productSpec` is optional but used unchecked downstream                                | (not in matrix)       | I8/FLAG-5 — typed required          |

These behaviors are encoded so Phase 2 can produce byte-equivalent behavior, then Phase 5 fixes each as a deliberate spec edit + matrix row diff + new test.

---

## 13. Spec maintenance

- **Adding a new agent (Coder, Reviewer):** add an entry in `runtime/routing/agent-registry.ts`, add new phases in §4, add new rows in §8 covering every (entry × state) cell. The exhaustiveness test fails until every cell is covered.
- **Adding a new state type:** add a row in §3, add a new column to the relevant matrix tables, add cases to `evaluateGuards` in `routeMessage`. The exhaustiveness test fails until every (entry × phase) cell with the new state has an explicit decision.
- **Adding a new entry point:** add a row in §2, add new rows in matrices §8/§9. Exhaustiveness test enforces coverage.
- **Fixing a FLAG:** spec edit + code edit + matrix row diff + new test, all in one PR. Phase 5 of the refactor follows this pattern.

---

## 14. References

- Plan file: `~/.claude/plans/elegant-percolating-newell.md`
- BACKLOG entry: "Routing state machine refactor — system-level architecture (Path B) (2026-04-27)"
- Today's routing implementation: `interfaces/slack/handlers/message.ts`, `interfaces/slack/handlers/general.ts`, `runtime/conversation-store.ts`, `runtime/agent-router.ts`
- Related architectural principles: CLAUDE.md Principle 13 (single routing authority), Principle 15 (cross-agent parity), Principle 11 (deterministic audits), Principle 8 (platform enforcement first).
