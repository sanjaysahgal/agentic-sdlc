#!/usr/bin/env python3
"""
PreToolUse hook for Write/Edit: blocks hardcoded customer-specific values in production .ts files.
Derives patterns from WorkspaceConfig (.env) at runtime — no hardcoded customer names.
Grows with the system: add new env vars to check as new customer coordinates are added.
"""
import sys, json, re, os

data = json.load(sys.stdin)
file = data.get('tool_input', {}).get('file_path', '')

# Only check production .ts files — not docs, fixtures, or eval test data
if not re.search(r'/(agents|runtime|interfaces|scripts)/[^/]+\.tsx?$', file):
    sys.exit(0)
if re.search(r'/(tests/fixtures|tests/evals|tests/regression)/', file):
    sys.exit(0)
# Skip the hook scripts themselves
if '/scripts/hooks/' in file:
    sys.exit(0)

# Load customer-specific terms from WorkspaceConfig (.env)
env_file = os.path.join(os.path.dirname(__file__), '../../.env')
env_file = os.path.abspath(env_file)
customer_values = {}
if os.path.exists(env_file):
    for line in open(env_file):
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            key, _, val = line.partition('=')
            val = val.strip().strip('"').strip("'")
            # Track all customer-specific coordinates (not generic config)
            if key in ('PRODUCT_NAME', 'GITHUB_REPO', 'GITHUB_OWNER', 'SLACK_MAIN_CHANNEL'):
                if val:
                    customer_values[key] = val

if not customer_values:
    sys.exit(0)  # Can't check without config — fail open

# Get content being written/edited
tool = data.get('tool_name', '')
content = data.get('tool_input', {}).get(
    'content' if tool == 'Write' else 'new_string', ''
)

# Check for hardcoded customer values
for key, val in customer_values.items():
    # Case-insensitive check, skip short values that could be false positives
    if len(val) < 4:
        continue
    if val.lower() in content.lower():
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'permissionDecision': 'deny',
                'permissionDecisionReason': (
                    f'Hardcoded customer value "{val}" ({key}) detected in {os.path.basename(file)}. '
                    f'Use loadWorkspaceConfig() instead. Principle 2: no hardcoding. '
                    f'This hook grows with the system — update scripts/hooks/check-hardcoding.py '
                    f'when new customer coordinates are added to WorkspaceConfig.'
                )
            }
        }))
        sys.exit(0)
