#!/usr/bin/env python3
"""
PreToolUse hook for ExitPlanMode: scans the most recent plan file for violation patterns
before plan approval is allowed. Derives customer-specific patterns from .env at runtime.
Grows with the system: add new pattern checks as new violation classes are discovered.
"""
import sys, json, re, os, glob

# Find most recent plan file
plan_dir = os.path.expanduser('~/.claude/plans/')
plans = sorted(glob.glob(os.path.join(plan_dir, '*.md')), key=os.path.getmtime, reverse=True)
if not plans:
    sys.exit(0)

plan = open(plans[0]).read()

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
            if key in ('PRODUCT_NAME', 'GITHUB_REPO', 'GITHUB_OWNER') and val and len(val) >= 4:
                customer_values[key] = val

def block(reason):
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': reason
        }
    }))
    sys.exit(0)

# Check 1: hardcoded customer-specific values
for key, val in customer_values.items():
    # Allow mentions in the accountability/already-implemented section (context only)
    # but block if they appear in step descriptions or code examples
    lines_with_val = [l for l in plan.splitlines() if val.lower() in l.lower()]
    # Filter out lines that are clearly historical context (✅ rows, accountability section)
    actionable = [l for l in lines_with_val if not any(x in l for x in ['✅', 'Already implemented', '---'])]
    if actionable:
        block(
            f'Plan contains hardcoded customer value "{val}" ({key}) in actionable step. '
            f'Generalize using WorkspaceConfig before approving. '
            f'Offending lines: {actionable[:2]}'
        )

# Check 2: hardcoded size/count thresholds in step descriptions
# Allow in accountability table (context) but not in step instructions
threshold_pattern = re.compile(r'\d+k (?:chars?|findings?|lines?)|[≤≥<>]\s*\d+ findings?|\d{2,}k with conflicts', re.IGNORECASE)
for line in plan.splitlines():
    if threshold_pattern.search(line) and '✅' not in line and 'Already implemented' not in line:
        block(
            f'Plan contains hardcoded size/count threshold: "{line.strip()}". '
            f'These must come from audit output at runtime, not be hardcoded in steps.'
        )

# Check 3: hardcoded dates in step instructions
date_pattern = re.compile(r'\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b')
for line in plan.splitlines():
    if date_pattern.search(line) and '✅' not in line:
        block(
            f'Plan contains hardcoded date: "{line.strip()}". '
            f'Replace with relative reference or derive at runtime.'
        )

# All checks passed
sys.exit(0)
