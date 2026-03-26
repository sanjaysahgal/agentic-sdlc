#!/bin/sh
# Installs git hooks for this repo.
# Run once after cloning: sh scripts/install-hooks.sh

HOOK_DIR="$(git rev-parse --git-dir)/hooks"

cat > "$HOOK_DIR/pre-commit" << 'EOF'
#!/bin/sh
# Blocks commits that touch agents/ or runtime/ without any test file staged.
CHANGED_SOURCE=$(git diff --cached --name-only | grep -E '^(agents|runtime)/' | grep -v '\.d\.ts$')
CHANGED_TESTS=$(git diff --cached --name-only | grep -E '^tests/')

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

exit 0
EOF

chmod +x "$HOOK_DIR/pre-commit"
echo "Hooks installed."
