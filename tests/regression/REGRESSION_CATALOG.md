# Regression Catalog

> Block I3 of the approved system-wide plan
> (`~/.claude/plans/rate-this-plan-zesty-tiger.md`). Single source of truth
> for which historical production bugs have a regression test pinning their
> fix. The structural invariant at
> `tests/invariants/regression-catalog.test.ts` enforces bidirectional
> consistency: every row here must have a matching `describe("bug #N — …")`
> block in the listed file, and every such describe block in
> `tests/regression/` must appear here.
>
> This catalog is *additive*. When a new production bug is fixed, the same
> commit that fixes it adds: (1) a new `describe("bug #N — …")` block in
> the appropriate `tests/regression/<topic>.test.ts` file (create one if
> the topic is new), (2) a new row below. Failing to do both is caught at
> PR time by the structural invariant.
>
> Format: each row is `| #N | one-line description | tests/regression/<file>.test.ts |`.
> The test file column is enforced verbatim — relative path from repo root.

| Bug | Description | Test file |
|---|---|---|
| #1 | Fast-path early returns only appended assistant message, skipping the user message — next API call had consecutive `[assistant, assistant]` and 400'd | tests/regression/history-integrity.test.ts |
| #2 | `appendMessage(user)` was called BEFORE `runAgent`; if `runAgent` threw, the user message was orphaned in history | tests/regression/history-integrity.test.ts |
| #3 | Corrupted history (leading assistant from bug #1) caused every subsequent API call to fail until the thread was abandoned | tests/regression/history-integrity.test.ts |
| #4 | `isSpecStateQuery` false positive: "yes please and I assume you will base it exactly on how our spec is written today?" was misclassified as a state query because it contained the word "spec" | tests/regression/approval-detection.test.ts |
| #5 | `isSpecStateQuery` false positive: "lets lock option A" was misclassified as a state query and triggered the fast-path read-only branch | tests/regression/approval-detection.test.ts |
| #6 | Premature spec approval: a text-only agent response was treated as approval intent and saved the spec without explicit user confirmation | tests/regression/approval-detection.test.ts |
| #7 | `withThinking` silently swallowed `chat.update` failures, leaving users with a permanent "thinking..." placeholder | tests/regression/error-recovery.test.ts |
| #8 | Blocking gate: PM agent saved spec even when `[blocking: yes]` questions remained unresolved | tests/regression/error-recovery.test.ts |
| #9 | Gap detection: the gap question must be persisted to conversation history so the next turn has the context to fix it | tests/regression/error-recovery.test.ts |
