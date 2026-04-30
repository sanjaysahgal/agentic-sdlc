# Contribution guide — adding a new agent

> Block M5 of the approved system-wide plan
> (`~/.claude/plans/rate-this-plan-zesty-tiger.md`). The Nth agent inherits
> N-1 hardened patterns. Treating a new agent as greenfield is the
> single most expensive mistake in this codebase. This guide enumerates
> every enforcement, audit, gate, and prompt block that every agent must
> wire before going live.

## Pre-requisites

Read these first, in order:
1. `CLAUDE.md` — non-negotiable principles. The 15 numbered principles are the
   contract every agent obeys.
2. `AGENTS.md` — current agent roster + the "Agent conventions (apply to every agent)"
   section.
3. `SYSTEM_ARCHITECTURE.md` — agent contract, model selection, state model.
4. `docs/adr/` — architectural decision records. ADR-0002 (platform enforcement
   over prompt rules) and ADR-0003 (cross-agent parity) are load-bearing.

## The new-agent enforcement checklist (non-negotiable)

Every checkbox below must be checked **before** the agent's first live test
(memory: `feedback_new_agent_enforcement_checklist.md`).

### Code

- [ ] **Agent module at `agents/<name>.ts`**: exports `build<Name>SystemPrompt(context, featureName, readOnly?)`, `<NAME>_TOOLS: Anthropic.Tool[]`, `build<Name>SystemBlocks(...)` (cached/uncached split).
- [ ] **Anti-deferral block injected**: prompt template ends with `${buildAntiDeferralBlock()}`. Cross-agent invariant `tests/invariants/anti-deferral-prompt-contract.test.ts` extended to include the new agent's builder. Without this, the runtime hedge gate corrects but the prompt never teaches the agent to avoid the phrases.
- [ ] **DESIGN-REVIEWED comment**: import site of `buildAntiDeferralBlock` carries the standard `// DESIGN-REVIEWED:` rationale per Principle 12.
- [ ] **Domain-boundary section in prompt**: `## Domain boundary — what you never own` enumerating each neighboring agent's exclusive territory.
- [ ] **Read-the-room newcomer orientation**: prompt instructs the agent to orient (feature, phase, role) before substantive work when a user introduces themselves or asks orientation questions.
- [ ] **Proactive constraint audit**: a deterministic auditor (Principle 11 — `@deterministic` JSDoc tag) for the agent's domain. Wired into the agent's draft-save tool handler so it runs on every mutation.

### Runtime wiring (in `interfaces/slack/handlers/message.ts`)

- [ ] **Agent runner**: `async function run<Name>Agent(...)` that orchestrates tool-loop, state mutations, and Slack response.
- [ ] **Always-on platform audit block**: `<name>ReadinessNotice` injected into every message via `auditPhaseCompletion` (or its deterministic equivalent). Reference: `designReadinessNotice` / `archReadinessNotice`.
- [ ] **Hedge gate**: `enforceNoHedging(response)` applied in the agent's post-run path with the same shape as PM/Designer/Architect. The pre-commit `[E2E SCENARIO GATE]` hook in `.claude/settings.json` blocks if `message.ts` changes without a `workflows.test.ts` update.
- [ ] **Upstream-readiness audit** (if non-PM agent): pre-run audit of approved upstream specs. PM gaps must surface before the agent runs. Single-agent finalize handler runs both same-domain rubric AND adversarial downstream-readiness audit.
- [ ] **Approval-confirm path**: detects approval intent (`isSpecApproval` shared classifier), saves spec via `saveApprovedSpec`, advances phase, hands off to next agent.
- [ ] **Escalation-confirm path** (if applicable): includes `patchProductSpecWithRecommendations` or `patchEngineeringSpecWithDecision` writeback per the `[ESCALATION WRITEBACK GATE]` hook.

### State

- [ ] **Phase mapping**: extend `runtime/routing/types.ts` and `runtime/routing/agent-registry.ts` so `resolveAgent(featureName)` deterministically routes to the new agent based on GitHub spec branches. Per ADR-0003, phase-to-agent mapping is the single source of truth — no scattered checks.
- [ ] **`AgentContext` extension** (if new domain context needed): add field to `runtime/context-loader.ts` and load in `loadAgentContext`. Document in `SYSTEM_ARCHITECTURE.md` "What the platform passes to agents" section.

### Tests

- [ ] **Unit tests**: tool-handlers, classifier, prompt builder. Located in `tests/unit/`.
- [ ] **Integration scenario**: at least one `Scenario N<NN>` in `tests/integration/workflows.test.ts` exercising the agent's main path. Mandatory per the `[E2E SCENARIO GATE]` hook.
- [ ] **Cross-agent invariants extended**: every invariant in `tests/invariants/` that enumerates agents (anti-deferral-prompt-contract, response-path-coverage, log-coverage if the agent adds new state) must be extended to include the new agent.
- [ ] **Deterministic audit tests**: real-fixture tests in `tests/unit/<name>-auditor.test.ts` using fixtures from `tests/fixtures/agent-output/<name>/`. Per the Fixture Rule, hand-crafted strings are not acceptable for format-sensitive auditors.

### Manual scenarios

- [ ] **MT-N entry in `MANUAL_TESTS.md`** for every behavior automated tests can't faithfully reproduce: orientation, draft save, approval, hedge gate, escalation, brand audit (if applicable). The catalog invariant requires sequential numbering — pick the next free number.
- [ ] **CODE_MARKER bumped** in `runtime/boot-fingerprint.ts` if the agent adds a new bracketed log line that needs production verification. The `[CODE_MARKER BUMP GATE]` hook enforces this.

### Documentation (Definition of Done)

- [ ] **`AGENTS.md`**: persona, capabilities, inputs/outputs, domain boundaries.
- [ ] **`SYSTEM_ARCHITECTURE.md`**: agent's place in the spec chain, audit it owns, downstream consumers.
- [ ] **`BACKLOG.md`**: move the "add `<name>` agent" entry from active to completed.
- [ ] **`PRESENTATIONS.md`** + relevant HTML decks: agent appears in the platform overview.
- [ ] **`.env.example`**: any new `WorkspaceConfig` field this agent requires.

## The enforcement-audit table (mandatory before first live test)

Before the new agent's first live test, fill out this table and store it in
the agent's PR description. Every mechanism that exists in any agent must
be implemented or explicitly justified for the new agent.

| Mechanism (in any existing agent) | Implementation in new agent | Justification if skipped |
|---|---|---|
| Anti-deferral prompt block | | |
| Domain boundary section in prompt | | |
| Read-the-room orientation | | |
| Proactive deterministic audit | | |
| Always-on readiness notice | | |
| Hedge gate (`enforceNoHedging`) | | |
| Upstream-readiness audit | | |
| Approval-confirm path | | |
| Escalation writeback (if applicable) | | |
| Phase resolver (`resolveAgent`) wiring | | |
| Cross-agent invariant test extended | | |
| MT-N manual scenario added | | |
| CODE_MARKER bump | | |

If the table has any blank cells, the agent is not ready to ship.

## Anti-patterns to avoid

- **Greenfield mindset**: "this is a new agent so it doesn't need [mechanism]." The Nth agent inherits N-1 hardened patterns. If you find yourself implementing something the existing agents don't have, ask: should the existing agents have it too? (Cross-cutting answer.)
- **Inline hedge gate copies**: do not duplicate `enforceNoHedging` logic at a new call site. Use the shared helper.
- **Prompt-only enforcement**: per ADR-0002, every behavior the system relies on must be platform-enforced. A prompt rule is a redundant backup, never the mechanism.
- **Skipping the cross-agent invariant extension**: if you wire the new agent without extending the invariants, the test suite passes but the parity is fictitious — drift between agents starts on day one.
