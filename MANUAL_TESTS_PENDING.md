# Pending manual tests

> The current list of MT-N scenarios that need running in real Slack
> against the current bot. Each entry was added when a production-wiring
> commit shipped that needs operator verification (per CLAUDE.md
> manual-test checkpoint discipline).
>
> When you finish running a scenario:
>   - PASSED: `npx tsx scripts/mt.ts done MT-N`
>   - FAILED: leave it pending and tell the assistant what failed
>
> Pre-push hook blocks pushes while this list is non-empty. The Stop-event
> hook prints the count at the end of every turn so neither side forgets.

## Current pending

### MT-7 — Hedge gate live in production (Block N enforceNoHedging)

- Added by commit: `b914a28` (Block N: hedge gate rewriter + cross-agent prompt contract)
- Why this blocks cutover: real-Slack rendering of rewritten output isn't covered by unit tests
- Full scenario: see `MANUAL_TESTS.md` MT-7

### MT-8 — Anti-deferral block in agent prompts (Block N buildAntiDeferralBlock)

- Added by commit: `b914a28` (same as MT-7)
- Why: real LLM has to actually obey the new prohibition; unit tests verify the block is INJECTED, not honored
- Full scenario: see `MANUAL_TESTS.md` MT-8

### MT-16 — Tool-name + platform-commentary stripper sentence-drop (Block N2)

- Added by commit: `ad8132c` (Block N2: sentence-drop)
- Why: the stripper now drops whole sentences containing tool references. Edge cases — multi-clause sentences mixing legitimate content with the offending token — only surface in real-LLM Slack runs
- Full scenario: see `MANUAL_TESTS.md` MT-16
