# Operator runbook

> Block M3 of the approved system-wide plan
> (`~/.claude/plans/rate-this-plan-zesty-tiger.md`). What an on-call operator
> needs to know to keep the bot healthy. Updated alongside any production-
> wiring change.

## Quick links

- Logs: `logs/bot-YYYY-MM-DD.log` (rotated daily by `winston-daily-rotate-file`)
- State files: `.conversation-state.json`, `.confirmed-agents.json`, `.conversation-history.json` (repo root)
- Boot fingerprint: `[BOOT] commit=<sha> codeMarker=<marker>` — the first line in the log after every restart
- Manual test catalog: `MANUAL_TESTS.md`
- Cutover-gate manifest: `docs/cutover-gate-status.json`

## Daily checks

1. **Bot is running**: `pgrep -f "tsx.*server.ts"` returns a PID.
2. **Recent activity in logs**: `tail -50 logs/bot-$(date +%Y-%m-%d).log` shows recent `[BOOT]`, `[ROUTER]`, agent log lines.
3. **No unexpected error spikes**: `grep -c "ERROR" logs/bot-$(date +%Y-%m-%d).log` — flag if much higher than baseline.

## Incident playbooks

### Bot is unresponsive in Slack

1. Check the process: `pgrep -f "tsx.*server.ts"`. If absent, restart with `npm run dev`.
2. Tail the log immediately after restart and confirm the `[BOOT]` line shows the expected `commit` (matches `git rev-parse --short HEAD`) and `codeMarker` (matches `runtime/boot-fingerprint.ts`).
3. If `[BOOT]` doesn't appear within 10 seconds, the process is failing on startup — check stderr.

### Manual tester says "the fix doesn't work"

1. Verify they ran the relevant `MT-N` scenario from `MANUAL_TESTS.md` — including the pre-flight (`[BOOT]` codeMarker check).
2. Cross-check the codeMarker they observed against `git rev-parse --short HEAD`. A mismatch means tsx-watch silently failed to reload — restart the bot.
3. If codeMarker matches HEAD and the scenario still fails, this is a real regression. Open an issue with: feature name, agent, message text, log excerpts (search for `[ROUTER]`, `[STORE]`, `[ESCALATION]`, `[HEDGE-GATE]`).

### Anthropic 529 / overload

The platform's hedge gate, action verifier, and audits are deterministic — they don't call Anthropic and continue working. The agent runner itself fails the turn:
1. Check `logs/bot-*.log` for `withThinking` error path: `[THINKING-ERROR]` lines.
2. Users see the actionable error message ("the AI is overloaded — please retry in a moment"), not a permanent "thinking..." placeholder. Bug #7 / D1.2 covers this.
3. No operator action — Anthropic's 529 typically clears in seconds.

### GitHub 401 / 502

GitHub failures during spec save: `saveApprovedSpec` surfaces the error; no partial commits possible per `createOrUpdateFileContents` atomicity. Block D1 covers this:
1. Check that the GitHub token in `.env` hasn't been rotated/revoked.
2. If 502, retry — typically transient.
3. State is uncorrupted: pendingApproval is cleared only on successful save.

### Slack rate limit during chat.update

Bug #7 + D1: `withThinking` falls back to `chat.postMessage` so the user sees a fresh message rather than a permanent "thinking..." placeholder. No operator action.

### Conversation state file corruption

D2 + property tests guarantee `parseConversationState` never throws on arbitrary input. Symptoms of in-the-wild corruption:
1. Log line `[STORE] loadConversationState: parse error — starting fresh: <truncated>` appears at startup.
2. The bot continues with empty state — no crash loop.
3. Backup the corrupt file (`cp .conversation-state.json .conversation-state.json.corrupt-$(date +%s)`) for postmortem; the platform overwrites it on the next persist.

### Eval gate failing on push

Pre-push hook runs the LLM eval suite and blocks at <85%:
1. Identify failing scenarios in the push output (`grep "✗" /tmp/push-out.log`).
2. Check if the failures are content-shape (LLM-judged "concrete proposal", "concise") or deterministic (literal substring `mustNotContain`). Deterministic failures usually point at a real production behavior change.
3. If the failures are noise/variance, re-run once. If consistent across 2+ runs, treat as a real regression and don't bypass with `--no-verify` (forbidden per CLAUDE.md).
4. Common cause: a recent agent-prompt or runtime change shifted agent output shape. The Block N hedge-gate fix is one example — diagnosed by tracing eval failures back to a prompt-rule rewrite.

### Pre-commit hook keeps blocking

The hooks in `.claude/settings.json` enforce CLAUDE.md principles structurally. If a hook blocks unexpectedly:
1. Read the hook message — it usually names the specific principle and how to satisfy it.
2. Common bypass markers (only when justified): `// MT-CHECKED:`, `// MARKER-BUMP-JUSTIFIED:`, `// SECRET-FALSE-POSITIVE:`, `// TRIGGER-JUSTIFIED:`, `// KEYWORD-JUSTIFIED:`, `// DESIGN-REVIEWED:`, `// ALWAYS-ON-AUDIT-JUSTIFIED:`.
3. Never bypass with `git commit --no-verify` — the gates exist because the rules are non-negotiable.

### "Auto-commit" race during commit

The Stop-event auto-commit hook can fire between staging and committing. If `git commit` is blocked with `[COMMIT EVERYTHING]`:
1. Re-run `git add -A` then immediately `git commit` in a single shell (the auto-commit can fire between Bash tool calls).
2. If the auto-commit absorbed your staged changes into a generic `chore: auto-commit` commit, the work is preserved but the commit message is generic. Per CLAUDE.md, do NOT amend — write a new commit if a follow-up is needed.

## Restoring from full state loss

If `.conversation-state.json` is deleted entirely:
1. The bot starts fresh on next restart — empty state, no in-flight escalations or approvals.
2. Active threads will lose their pending state; users may see the agent re-prompt for things that were already in flight.
3. Spec drafts and approved specs are stored in GitHub — those are unaffected.
4. Confirmed agents are persisted separately in `.confirmed-agents.json` — also lost on full state loss; agent re-confirmation happens on next message.

## Releasing a hotfix

1. Implement the fix on a branch.
2. Run the full test suite locally: `npx vitest run`.
3. Run coverage: `npx vitest run --coverage` — must pass thresholds.
4. Bump `CODE_MARKER` in `runtime/boot-fingerprint.ts` if the fix adds production-visible log lines.
5. Update the relevant `MT-N` scenario's "Last verified" line in `MANUAL_TESTS.md`.
6. Push — pre-push hook runs the eval suite. Must pass at ≥85%.
7. Restart the bot in production: `kill -9 $(pgrep -f "tsx.*server.ts" | head -1)` then `npm run dev`.
8. Verify the `[BOOT]` line shows the new `codeMarker`.
9. Run the MT-N scenario in real Slack.
