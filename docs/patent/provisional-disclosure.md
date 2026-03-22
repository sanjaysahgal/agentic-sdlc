# Provisional Patent Application

**Title:** System and Method for Orchestrating Stateless AI Agents Across Software Development Lifecycle Phases Using Version Control as Authoritative State

**Inventor:** Sanjay Sahgal, United States of America

**Filing Type:** Provisional Patent Application (USPTO)

**Date of Disclosure:** March 21, 2026

---

## Field of the Invention

This invention relates to software development tooling, and more specifically to systems and methods for orchestrating artificial intelligence agents across the phases of a software development lifecycle (SDLC), where version control serves as the authoritative state store, agents are stateless and context-injected, and phase transitions are enforced programmatically through conflict detection and structured specification management.

---

## Background of the Invention

Software development lifecycles traditionally require significant human coordination across phases: product specification, design, engineering planning, implementation, and deployment. Existing tools either (a) automate individual tasks in isolation (e.g., code completion, CI/CD pipelines) or (b) require persistent infrastructure to manage workflow state (e.g., project management databases, issue trackers).

The emergence of large language model (LLM)-based AI agents has introduced new possibilities for automating SDLC coordination. However, existing approaches — including GitHub Copilot Workspace, Linear, Jira Automation, LangChain, and AutoGen — suffer from several limitations:

**GitHub Copilot Workspace** automates code generation and pull request creation but has no awareness of product lifecycle phases, no specification validation, and no multi-team configuration. It operates within a single repository context and cannot enforce consistency between a proposed change and upstream product or architecture documents.

**Linear** and **Jira Automation** provide workflow state management via proprietary databases and rule engines. They require manual configuration per team, store state outside version control (creating divergence risk), and have no AI agent orchestration capability. Onboarding a new team requires significant manual setup within the tool's proprietary data model.

**LangChain** and **AutoGen** provide agent orchestration frameworks but are infrastructure primitives, not SDLC platforms. They require stateful agent processes, have no native understanding of software development phases, provide no specification conflict detection, and require significant per-application engineering to deploy. Neither provides a multi-tenant configuration model.

None of these systems combine: (a) version control as the authoritative state store, (b) stateless agent architecture, (c) synchronous conflict detection with verification, (d) phase-aware behavior switching within a single agent, (e) zero-code-change multi-tenancy, and (f) a unified monitoring interface derived directly from version control state.

The existing approaches suffer from the following specific limitations:

1. **Stateful agent architecture** — LangChain, AutoGen, and similar frameworks require persistent agent processes or databases to track workflow state, creating infrastructure complexity and state synchronization bugs. If the process crashes, state is lost or corrupted.

2. **Hardcoded product specificity** — GitHub Copilot Workspace and similar tools are configured per-repository with no abstraction layer. Onboarding a new team requires duplicating and modifying tool configuration, not simply providing new environment values.

3. **Post-hoc consistency checking** — Jira Automation and Linear validate workflow rules after artifacts are created and committed, allowing inconsistencies between a specification and the product vision to propagate into downstream phases before detection.

4. **Truncation-based context management** — When documents exceed LLM context windows, existing agent frameworks truncate input using fixed character or token limits, discarding potentially critical information arbitrarily rather than filtering by relevance.

5. **Separate agents for separate modes** — AutoGen and multi-agent frameworks deploy distinct agent instances for different roles or states, requiring explicit routing logic and increasing operational complexity as the number of lifecycle phases grows.

6. **Duplicated CI/CD logic** — Standard CI/CD platforms (GitHub Actions, CircleCI) require each application to maintain its own pipeline configuration, leading to drift and inconsistency across a portfolio of applications. There is no native mechanism for centralizing pipeline logic across repositories.

7. **Unstructured specification artifacts** — Linear, Jira, and Confluence store open questions and blocking issues as free-form text or informal comments, preventing automated routing to the correct reviewer or automated phase gating based on resolution status.

8. **Opaque workflow state** — No existing tool provides a unified real-time view of SDLC progress across features, teams, and workspaces derived directly from version control. Stakeholders must query multiple systems (version control, issue tracker, CI/CD dashboard, communication platform) to construct a coherent picture of project state.

What is needed is a unified platform — herein referred to as **Archon** — that addresses all of these limitations through a coherent, config-driven, multi-tenant architecture with a decoupled, interface-agnostic human interaction layer.

---

## Summary of the Invention

The present invention provides a system and method for orchestrating stateless AI agents across software development lifecycle phases, wherein:

- A version control system (e.g., Git/GitHub) serves as the sole authoritative state store for all SDLC phase information
- AI agents are stateless functions that receive fresh context on each invocation, enabling deterministic and replayable behavior
- Phase transitions are detected programmatically from version control state, not from a separate database
- Specification artifacts are validated synchronously against upstream documents, with re-read verification enforcing human compliance
- A single agent dynamically switches behavioral modes based on detected phase, eliminating the need for separate agents per mode
- All product-specific configuration is externalized to a workspace configuration object, enabling zero-code-change multi-tenancy
- CI/CD pipeline logic is centralized in a platform repository and consumed by application repositories via configuration-only onboarding
- Structured tagging of open questions within specifications enables machine-readable routing and automated phase gating
- The human interaction layer is decoupled from agent orchestration logic, enabling any messaging platform or web interface to serve as the interface without modification to core platform logic
- A monitoring dashboard derives real-time SDLC state directly from version control, requiring no separate data store

---

## Detailed Description of Preferred Embodiments

### Embodiment 1: Version Control as SDLC State Machine

In a preferred embodiment, the lifecycle phase of any feature is inferred entirely from the state of a version control repository, without reference to a separate database or workflow engine.

Archon detects phase by evaluating:
- Whether a feature branch (e.g., `spec/<feature>-product`) exists in the repository
- Whether the corresponding specification file exists on that branch but not on the main branch (indicating in-progress)
- Whether the specification file has been merged to the main branch (indicating approval)
- Whether downstream branches (e.g., `spec/<feature>-design`, `spec/<feature>-engineering`) exist

Phase transitions are triggered by standard Git operations (branch creation, pull request merge) rather than by explicit workflow commands. This makes all SDLC state visible to humans through standard version control tooling and auditable through Git history.

This embodiment eliminates the need for a separate state management system, reduces infrastructure complexity, and enables replay of any historical state by checking out a prior commit.

---

### Embodiment 2: Stateless AI Agent Architecture with Fresh Context Injection

In a preferred embodiment, AI agents are implemented as stateless functions rather than persistent processes. Each agent invocation constructs an input payload comprising three components:

1. **System prompt** — A structured text block encoding the agent's persona (role, experience level, decision-making style), behavioral constraints (what the agent will and will not do), output format requirements, and references to the workspace configuration for product-specific values. The system prompt is constructed programmatically from the `WorkspaceConfig` object at invocation time.

2. **Conversation history** — An ordered array of message objects, each containing a role identifier (`human` or `assistant`) and message content. This array is persisted externally (e.g., in a database or message platform thread) and passed in full on each invocation. The conversation history is the only stateful element, and it is owned by the calling layer, not the agent.

3. **Injected context** — A set of document excerpts loaded fresh from the version control repository at invocation time, filtered for relevance to the current message using a secondary language model (herein the "relevance filter"). The relevance filter receives the full document and the current human message, and returns only the portions of the document relevant to answering that message. This filtered excerpt is injected into the system prompt as a named context block (e.g., `<product_vision>`, `<architecture>`, `<current_spec>`).

The complete invocation payload has the following structure:

```
{
  system: "<persona> + <constraints> + <injected_context_blocks>",
  messages: [
    { role: "user", content: "<human message>" },
    { role: "assistant", content: "<prior agent response>" },
    ...
    { role: "user", content: "<current human message>" }
  ]
}
```

This payload is passed to the language model API. The response is returned to the calling layer, appended to the conversation history, and the agent function exits. No agent process, thread, or in-memory state persists after the function returns.

The relevance filter is implemented as a separate, lightweight language model call that precedes the main agent invocation. It receives: (a) the full document text, (b) the current human message, and (c) an instruction to return only the passages relevant to answering the message. This two-stage approach — filter then invoke — ensures the main agent always receives current document content without exceeding context limits through truncation.

No agent state persists between invocations. The combination of conversation history and fresh repository context is sufficient to reproduce any prior agent behavior deterministically, given the same repository state.

This architecture eliminates state synchronization bugs, reduces infrastructure requirements, and enables horizontal scaling without coordination overhead. It also enables deterministic replay: given identical repository state and conversation history, an agent produces identical outputs.

---

### Embodiment 3: Synchronous Conflict Detection with Re-Read Verification

In a preferred embodiment, every specification artifact is validated synchronously against upstream authoritative documents (e.g., product vision, system architecture) before being saved to the version control repository.

Archon classifies issues into two categories:
- **CONFLICT**: The specification contradicts a statement in an upstream document. This blocks the save operation entirely.
- **GAP**: The specification assumes something not addressed in upstream documents. This allows the save but surfaces a structured flag.

When a CONFLICT is detected, the agent halts, identifies the specific upstream constraint being violated, and requires the human to resolve the conflict by updating the upstream document before proceeding.

Critically, upon the human's claim that the upstream document has been updated, the agent **re-reads the upstream document from the version control repository** to verify the update was actually committed. The agent does not proceed based on the human's assertion alone. This re-read verification step prevents human circumvention of the conflict gate.

This embodiment enforces architectural coherence at specification creation time rather than at build or deployment time, reducing the cost of fixing inconsistencies by orders of magnitude.

---

### Embodiment 4: Phase-Aware Agent Behavior Switching

In a preferred embodiment, a single AI agent dynamically switches behavioral modes based on the lifecycle phase detected from the version control repository (per Embodiment 1), rather than deploying separate agents for each mode.

For example, a product specification agent operates in two modes:
- **Draft mode**: The agent collaborates with the human to shape the specification, proposes content, detects conflicts, and manages the approval loop.
- **Approved mode**: The specification is treated as a frozen baseline. The agent answers questions about the specification but routes any proposed changes through a re-approval loop.

The mode switch is achieved by injecting different system prompt content based on the detected phase, while the agent's core identity, persona, and conversation history remain continuous. The human experiences a seamless interaction with no visible agent transition.

This embodiment reduces operational complexity by eliminating the need to provision, route to, and maintain separate agents for each lifecycle phase.

---

### Embodiment 5: Config-Driven Multi-Tenant Architecture via Workspace Configuration

In a preferred embodiment, all product-specific coordinates are externalized to a workspace configuration object (herein `WorkspaceConfig`) loaded from environment variables at Archon startup. This includes:

- Product name and description
- Version control repository owner and name
- Communication channel identifiers (e.g., Slack channel names)
- Specification file paths and directory structures
- Agent routing rules

No product-specific string literals appear in the Archon codebase. All agents, routing logic, and context loaders reference `WorkspaceConfig` for any product-specific value.

A new team or product onboards to Archon by providing a new environment configuration file. No changes to the Archon codebase are required. This achieves true multi-tenancy at the code level, not merely at the database level.

A continuous integration check enforces this constraint: any pull request that modifies agent or runtime code without modifying documentation triggers a build failure, preventing regression into hardcoded specificity.

---

### Embodiment 6: Decoupled CI/CD Platform with Configuration-Only Application Onboarding

In a preferred embodiment, CI/CD pipeline logic is centralized in a dedicated platform repository and consumed by application repositories via a reusable workflow invocation mechanism (e.g., GitHub Actions `workflow_call`).

The platform repository owns all pipeline logic: dependency installation, linting, type checking, testing, building, deployment, post-deployment validation (smoke tests, visual regression, performance audits), and notification. Application repositories own only configuration: runtime version, package manager, environment-specific secrets.

An application onboards to the platform CI/CD system by adding a single workflow file that delegates to the platform repository. No pipeline logic is duplicated in the application repository. Pipeline improvements made in the platform repository are automatically inherited by all onboarded applications.

This embodiment enforces consistency across a portfolio of applications, reduces pipeline maintenance overhead, and creates a clear separation of concerns between application development and deployment infrastructure.

---

### Embodiment 7: Structured Open Question Tagging for Automated Phase Gating

In a preferred embodiment, open questions within specification artifacts are tagged with machine-readable metadata using a structured format:

```
[type: product|design|engineering] [blocking: yes|no] <question text>
```

The `type` field enables automated routing to the appropriate human or agent reviewer. The `blocking` field enables automated phase gating: a specification containing one or more `[blocking: yes]` questions cannot be advanced to the next lifecycle phase until those questions are resolved.

Agents enforcing this schema refuse to save specification artifacts containing untagged questions. At the end of each agent response, all unresolved blocking questions are surfaced explicitly to the human.

This embodiment transforms open questions from free-form prose into machine-actionable workflow items, enabling automated enforcement of specification completeness and routing of questions to appropriate stakeholders without human triage.

---

### Embodiment 8: Decoupled Interface-Agnostic Human Interaction Layer

In a preferred embodiment, the Archon platform separates the human interaction layer entirely from agent orchestration logic. The interface layer — whether a messaging platform (e.g., Slack, Microsoft Teams, Discord) or a web application — is responsible only for:

- Receiving human input and forwarding it to the agent routing layer
- Rendering agent responses to the human
- Maintaining no business logic, agent state, or SDLC knowledge

All routing decisions, agent invocations, conflict detection, and phase management occur in Archon's orchestration layer, which is interface-agnostic. Substituting one interface for another (e.g., replacing a Slack integration with a web chat UI) requires no changes to the agent, routing, or state management components.

This decoupling is enforced architecturally: the interface layer communicates with Archon via a defined event protocol (incoming message event → Archon → outgoing response), and Archon has no dependency on any specific interface implementation.

This embodiment future-proofs Archon against interface platform changes, enables simultaneous support for multiple interfaces, and reduces the blast radius of interface-layer failures to the interface only.

---

### Embodiment 9: Version-Control-Derived Monitoring Dashboard

In a preferred embodiment, the Archon platform exposes a real-time monitoring dashboard that derives all displayed state directly from the version control repository, requiring no separate data store, event stream, or database.

The dashboard provides:

- **Portfolio view**: All active features across all workspaces, their current lifecycle phase (product spec, design, engineering, implementation, deployment), and phase duration
- **Blocking issues view**: All open questions tagged `[blocking: yes]` across all active specifications, grouped by type (product, design, engineering) and assignable to human reviewers
- **Conflict log**: Historical record of all CONFLICT and GAP detections, the specifications affected, and resolution status
- **Agent activity feed**: Timestamped log of all agent invocations, phase transitions, and specification saves, derived from Git commit history
- **Multi-workspace view**: For platform operators managing multiple teams, a cross-workspace summary of SDLC health, phase distribution, and blocking issue counts

Because all state is derived from version control, the dashboard requires no synchronization, cache invalidation, or write path. It is a read-only projection of Git state. Any historical view is reconstructable by querying Git history at a prior point in time.

This embodiment completes the Archon platform's commercial surface: the dashboard is the primary interface for engineering managers, product leads, and platform operators who need visibility without direct participation in agent conversations.

---

## Claims

The following claims define the scope of the invention. As a provisional application, these claims are non-binding and will be refined in the subsequent non-provisional filing.

### Independent System Claims

1. A computer-implemented system for orchestrating AI agents across software development lifecycle phases, comprising: a version control repository serving as the sole authoritative state store for lifecycle phase information; one or more stateless AI agent functions that receive fresh context from the version control repository on each invocation; and a phase detection module that infers current lifecycle phase from version control state without reference to a separate database.

2. A computer-implemented system for enforcing consistency between specification artifacts and upstream authoritative documents in software development, comprising: a conflict detection module that synchronously validates a proposed specification artifact against one or more upstream documents stored in a version control repository; a blocking gate that prevents commitment of the artifact upon detecting a contradiction; and a verification module that re-reads the upstream document from the version control repository to confirm a claimed update was committed before permitting the blocked operation to proceed.

3. A computer-implemented multi-tenant AI agent deployment system, comprising: a workspace configuration object that externalizes all tenant-specific coordinates including product identifiers, repository references, communication channel identifiers, and routing rules; one or more AI agent functions that reference said configuration object for all tenant-specific values and contain no tenant-specific string literals; and a continuous integration enforcement mechanism that fails any code change introducing tenant-specific literals into agent or routing logic.

### Dependent System Claims

4. The system of claim 1, wherein phase transitions are triggered by standard version control operations including branch creation and pull request merge, without requiring explicit workflow commands or external state updates.

5. The system of claim 1, wherein each stateless AI agent function constructs an invocation payload comprising: a system prompt built programmatically from a workspace configuration object; an externally-persisted conversation history array passed in full on each invocation; and context excerpts loaded from the version control repository and filtered for relevance by a secondary language model prior to injection.

6. The system of claim 1, wherein a single AI agent dynamically switches behavioral modes based on detected lifecycle phase by receiving different system prompt injections while maintaining continuous conversation history, without routing to a separate agent instance.

7. The system of claim 1, wherein CI/CD pipeline logic is centralized in a dedicated platform repository and consumed by application repositories via a reusable workflow invocation mechanism, with no pipeline logic duplicated in application repositories.

8. The system of claim 1, wherein open questions within specification artifacts are tagged with machine-readable metadata comprising a type field indicating the responsible review domain and a blocking field indicating whether the question prevents phase advancement, and wherein a phase gate enforces resolution of all blocking-tagged questions before permitting lifecycle phase transition.

9. The system of claim 1, further comprising a human interaction layer that is decoupled from agent orchestration logic via a defined event protocol, wherein substitution of one interface implementation for another requires no modification to agent, routing, state management, or conflict detection components.

10. The system of claim 1, further comprising a monitoring dashboard that derives all displayed state from the version control repository without a separate data store, the dashboard providing real-time visibility into lifecycle phase status, unresolved blocking questions, conflict detection history, agent activity derived from commit history, and cross-workspace SDLC health metrics.

### Independent Method Claims

11. A computer-implemented method for orchestrating stateless AI agents across software development lifecycle phases, comprising: inferring a current lifecycle phase for a software feature by evaluating version control repository state including branch existence and file merge status, without querying a separate database; constructing an agent invocation payload comprising a programmatically-built system prompt, an externally-persisted conversation history, and context filtered from version control documents by a secondary language model; invoking an AI agent function with said payload; and returning the agent response to the calling layer without persisting agent state.

12. A computer-implemented method for enforcing architectural coherence in AI-assisted software development, comprising: loading a specification artifact proposed by an AI agent; comparing the artifact against one or more upstream authoritative documents stored in a version control repository; blocking commitment of the artifact upon detecting a contradiction; surfacing the specific violated constraint to the human; re-reading the upstream document from the version control repository to verify any claimed update was committed; and permitting commitment of the artifact only after re-read verification confirms the update.

13. A computer-implemented method for multi-tenant AI agent deployment, comprising: externalizing all tenant-specific configuration to an environment-loaded workspace configuration object; referencing said configuration object for all tenant-specific values within agent, routing, and context-loading logic; and enforcing via continuous integration that no tenant-specific string literals appear in system source code, such that onboarding a new tenant requires no modification to system source code.

### Computer-Readable Medium Claims

14. A non-transitory computer-readable medium storing instructions that, when executed by one or more processors, implement a system for orchestrating stateless AI agents across software development lifecycle phases, the instructions causing the processors to: infer lifecycle phase from version control repository state without reference to a separate database; construct per-invocation agent payloads comprising programmatically-built system prompts, externally-persisted conversation histories, and relevance-filtered version control context; invoke AI agent functions statelessly; and detect conflicts between specification artifacts and upstream authoritative documents synchronously before committing artifacts to the version control repository.

15. A non-transitory computer-readable medium storing instructions that, when executed, implement a multi-tenant AI agent orchestration platform wherein all tenant-specific coordinates are loaded from an environment configuration object at startup, no tenant-specific literals appear in platform source code, and a continuous integration mechanism enforces this constraint on every code change.

---

## Abstract

Archon is a system and method for orchestrating stateless artificial intelligence agents across software development lifecycle phases, wherein a version control repository serves as the sole authoritative state store. Lifecycle phases are inferred from version control state (branch existence, file merge status) without a separate database. AI agents are stateless functions receiving fresh context on each invocation, enabling deterministic replay. Specification artifacts are validated synchronously against upstream documents with re-read verification enforcing human compliance. A single agent switches behavioral modes based on detected phase via system prompt injection. All product-specific configuration is externalized to a workspace configuration object, enabling zero-code-change multi-tenant onboarding. CI/CD pipeline logic is centralized in a platform repository and consumed by application repositories via configuration only. Open questions within specifications are tagged with machine-readable type and blocking metadata, enabling automated phase gating. The human interaction layer is decoupled from orchestration logic, enabling interface substitution without platform changes. A monitoring dashboard derives real-time SDLC state directly from version control, requiring no separate data store.

---

## Notes for Non-Provisional Filing

The following should be addressed when converting to a non-provisional application:

- Conduct formal prior art search, particularly against: LangChain, AutoGen, CrewAI, GitHub Copilot Workspace, Linear, Jira Automation, and Anthropic's own published work
- Add formal drawings illustrating: (1) phase state machine, (2) agent invocation flow, (3) conflict detection sequence, (4) WorkspaceConfig dependency graph, (5) CI/CD platform/app decoupling, (6) interface-agnostic interaction layer architecture, (7) dashboard data flow from version control
- Refine claims to ensure each is independently defensible
- Consider filing continuation claims on the relevance-filtering-via-secondary-model pattern (using a smaller LLM to filter context before passing to a primary LLM) as a separate application
- Estimated cost for non-provisional with patent attorney: $8,000–$15,000
- Provisional priority date must be converted within 12 months of this filing date
