#!/bin/sh
# Installs git hooks for this repo.
# Run once after cloning: sh scripts/install-hooks.sh

HOOK_DIR="$(git rev-parse --git-dir)/hooks"

cat > "$HOOK_DIR/pre-commit" << 'EOF'
#!/bin/sh
# Pre-commit checks for agentic-sdlc platform code.
# Blocks commits that violate platform integrity rules.

CHANGED_SOURCE=$(git diff --cached --name-only | grep -E '^(agents|runtime)/' | grep -v '\.d\.ts$')
CHANGED_TESTS=$(git diff --cached --name-only | grep -E '^tests/')
CHANGED_AGENTS=$(git diff --cached --name-only | grep -E '^agents/' | grep -v '\.d\.ts$')
CHANGED_RUNTIME=$(git diff --cached --name-only | grep -E '^runtime/' | grep -v '\.d\.ts$')
CHANGED_AGENTS_MD=$(git diff --cached --name-only | grep -E '^AGENTS\.md$')
CHANGED_SYSARCH=$(git diff --cached --name-only | grep -E '^SYSTEM_ARCHITECTURE\.md$')

# ── Rule 1: behavioral changes must include tests ──────────────────────────────
if [ -n "$CHANGED_SOURCE" ] && [ -z "$CHANGED_TESTS" ]; then
  echo ""
  echo "  Pre-commit check failed: behavioral change with no tests"
  echo ""
  echo "  Files staged in agents/ or runtime/:"
  echo "$CHANGED_SOURCE" | sed 's/^/    /'
  echo ""
  echo "  No test files are staged. Add tests before committing."
  echo "  To bypass (only for docs/config changes): git commit --no-verify"
  echo ""
  exit 1
fi

# ── Rule 2: agent changes must update AGENTS.md ───────────────────────────────
if [ -n "$CHANGED_AGENTS" ] && [ -z "$CHANGED_AGENTS_MD" ]; then
  echo ""
  echo "  Pre-commit check failed: agents/ changed but AGENTS.md not staged"
  echo ""
  echo "  Files staged in agents/:"
  echo "$CHANGED_AGENTS" | sed 's/^/    /'
  echo ""
  echo "  AGENTS.md must be updated to reflect persona, capability, or output changes."
  echo "  To bypass (only for refactors with no behavioral change): git commit --no-verify"
  echo ""
  exit 1
fi

# ── Rule 3: runtime changes must update SYSTEM_ARCHITECTURE.md ────────────────
if [ -n "$CHANGED_RUNTIME" ] && [ -z "$CHANGED_SYSARCH" ]; then
  echo ""
  echo "  Pre-commit check failed: runtime/ changed but SYSTEM_ARCHITECTURE.md not staged"
  echo ""
  echo "  Files staged in runtime/:"
  echo "$CHANGED_RUNTIME" | sed 's/^/    /'
  echo ""
  echo "  SYSTEM_ARCHITECTURE.md must reflect any routing, data flow, or system behavior changes."
  echo "  To bypass (only for refactors with no behavioral change): git commit --no-verify"
  echo ""
  exit 1
fi

# ── Rule 4: no hardcoded client strings in platform code ──────────────────────
if [ -n "$CHANGED_SOURCE" ]; then
  VIOLATIONS=""
  for f in $CHANGED_SOURCE; do
    if [ -f "$f" ]; then
      MATCHES=$(git diff --cached "$f" | grep '^+' | grep -v '^+++' | grep -E '(health360|agentic-health|getarchon|sanjaysahgal)' || true)
      if [ -n "$MATCHES" ]; then
        VIOLATIONS="$VIOLATIONS  $f"
      fi
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo ""
    echo "  Pre-commit check failed: hardcoded client strings in platform code"
    echo ""
    echo "  Files with violations:"
    echo "$VIOLATIONS"
    echo ""
    echo "  Customer-specific values (product names, repo paths, user names) must live"
    echo "  in WorkspaceConfig via env vars — never hardcoded in agents/ or runtime/."
    echo "  To bypass (only if false positive): git commit --no-verify"
    echo ""
    exit 1
  fi
fi

exit 0
EOF

cat > "$HOOK_DIR/pre-push" << 'EOF'
#!/bin/sh
# Runs the full test suite before any push.
# A push with failing tests never reaches the remote.

echo "  Running test suite before push..."
npx vitest run --reporter=verbose 2>&1

if [ $? -ne 0 ]; then
  echo ""
  echo "  Pre-push check failed: test suite has failures"
  echo ""
  echo "  Fix the failing tests before pushing."
  echo "  To bypass (only in genuine emergencies): git push --no-verify"
  echo ""
  exit 1
fi

echo "  All tests pass — push proceeding."
exit 0
EOF

chmod +x "$HOOK_DIR/pre-commit"
chmod +x "$HOOK_DIR/pre-push"
echo "Hooks installed."
