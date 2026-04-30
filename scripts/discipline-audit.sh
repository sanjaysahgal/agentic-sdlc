#!/bin/bash
# Hook 5 — end-of-turn discipline audit.
# Prints a single-line PASS/FAIL summary of HEAD's commit-discipline state
# so the user gets automatic visibility without having to dig.
#
# Skips silently if HEAD is older than 10 min (nothing recent to audit).
#
# Discipline rule applied today:
#   if commit touches runtime/agents/handlers AND no regression test added
#   AND no MT-NEEDED/MT-NONE in commit message → FAIL
#
# Future rules can be appended here.

set -e

HEAD_TIME=$(git log -1 --format=%ct 2>/dev/null || echo 0)
NOW=$(date +%s)
AGE=$((NOW - HEAD_TIME))
if [ "$AGE" -gt 600 ]; then
  exit 0  # nothing recent to audit
fi

SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
FILES=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null)
MSG=$(git log -1 --pretty=%B 2>/dev/null)

TOUCHES_RUNTIME=N
echo "$FILES" | grep -qE '^(agents/[^/]+\.ts|runtime/(claude-client|conversation-store|tool-handlers|deterministic-auditor|brand-auditor|action-verifier|escalation-orchestrator|orientation-enforcer|phase-completion-auditor|spec-auditor|html-renderer|routing/(spec-parser|snapshot|migrate-routing-state))\.ts|interfaces/slack/handlers/(message|commands|thinking)\.ts)' && TOUCHES_RUNTIME=Y

HAS_REGRESSION=N
echo "$FILES" | grep -qE '^tests/regression/.*\.test\.ts$' && HAS_REGRESSION=Y

HAS_CATALOG_UPDATE=N
echo "$FILES" | grep -qFx 'tests/regression/REGRESSION_CATALOG.md' && HAS_CATALOG_UPDATE=Y

HAS_MT_ENTRY_UPDATE=N
echo "$FILES" | grep -qFx 'MANUAL_TESTS.md' && HAS_MT_ENTRY_UPDATE=Y

MARKER_BUMPED=N
echo "$FILES" | grep -qFx 'runtime/boot-fingerprint.ts' && MARKER_BUMPED=Y

HAS_MT_DECLARATION=N
echo "$MSG" | grep -qE 'MT-NEEDED:|MT-NONE:' && HAS_MT_DECLARATION=Y

# Verdict
VERDICT=PASS
if [ "$TOUCHES_RUNTIME" = "Y" ] && [ "$HAS_REGRESSION" = "N" ] && [ "$HAS_MT_DECLARATION" = "N" ]; then
  VERDICT=FAIL
fi

printf '[DISCIPLINE] commit=%s touched-runtime=%s regression-test=%s catalog-update=%s MT-update=%s code-marker-bumped=%s has-MT-declaration=%s → %s' \
  "$SHA" "$TOUCHES_RUNTIME" "$HAS_REGRESSION" "$HAS_CATALOG_UPDATE" "$HAS_MT_ENTRY_UPDATE" "$MARKER_BUMPED" "$HAS_MT_DECLARATION" "$VERDICT"
