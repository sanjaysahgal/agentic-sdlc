# Customer onboarding — bringing a new team onto agentic-sdlc

> Block M4 of the approved system-wide plan
> (`~/.claude/plans/rate-this-plan-zesty-tiger.md`). Everything a new
> customer team needs to provide and configure to use the platform.
> CLAUDE.md Principle 3: a new team onboarding changes only their `.env`.
> Nothing in the codebase changes.

## Pre-requisites the customer must provide

### 1. A GitHub repo (the customer's product repo)

Required structure:
```
<repo-root>/
├── PRODUCT_VISION.md          # required — the authoritative product vision
├── SYSTEM_ARCHITECTURE.md     # required — the authoritative architecture
├── BRAND.md                   # required for design agent — brand tokens
└── features/                  # required — root for feature specs
    └── <feature-name>/
        ├── <feature-name>.product.md     # PM-managed
        ├── <feature-name>.design.md      # Designer-managed
        └── <feature-name>.engineering.md # Architect-managed
```

These three docs (`PRODUCT_VISION.md`, `SYSTEM_ARCHITECTURE.md`, `BRAND.md`) are
the single source of truth for product / architecture / brand context. The
platform reads them every turn — it does not cache, summarize, or duplicate
them. Updating them updates agent behavior on the next message.

### 2. A Slack workspace

Required:
- A main channel (e.g. `#general` or `#archcon`) for the concierge.
- Per-feature channels named `#feature-<name>` — one per active feature.
  Channel name pattern is hard-coded; the feature name in the channel must
  match the directory name in `features/<name>/`.

### 3. A Slack bot installation

Bot must have these scopes:
- `chat:write` — post and update messages
- `app_mentions:read` — @-mentions
- `channels:history` — read channel messages in public channels the bot is in
- `groups:history` — same for private channels
- `commands` — slash commands
- `users:read` — fetch user info for orientation

Slash commands the bot must register (each scoped to the feature channel
pattern):
- `/pm`, `/design`, `/architect` — explicit agent override
- `/spec` — show current spec state

### 4. A GitHub bot account

Recommended pattern: a dedicated bot user (not a personal PAT) with
write access to the customer's product repo. Token scopes:
- `repo` (read + write to private repos OR `public_repo` for public)

### 5. An Anthropic API key

The platform uses Claude Sonnet 4.6 for agent runs and Claude Haiku 4.5 for
classifiers. Pre-pay credit balance is recommended — the eval-gated push
flow can fail if the balance hits zero mid-test.

## WorkspaceConfig — the only coupling point

Everything customer-specific lives in `WorkspaceConfig`. The platform
loads it from `.env` via `runtime/workspace-config.ts:loadWorkspaceConfig`.
See `.env.example` for the canonical list — every field is required.

| Field | Source | Example |
|---|---|---|
| `PRODUCT_NAME` | Customer's product brand name | `Health360` |
| `MAIN_CHANNEL` | Slack channel for the concierge | `general` (no `#`) |
| `GITHUB_OWNER` | GitHub org or user that owns the customer repo | `acme-corp` |
| `GITHUB_REPO` | Customer repo name | `agentic-health360` |
| `GITHUB_TOKEN` | The bot's PAT (see prereqs §4) | `ghp_…` (rotate quarterly) |
| `SLACK_BOT_TOKEN` | The bot's xoxb token | `xoxb-…` |
| `SLACK_APP_TOKEN` | The bot's xapp token (Socket Mode) | `xapp-…` |
| `ANTHROPIC_API_KEY` | Customer's Anthropic key | `sk-ant-…` |
| `FEATURES_ROOT` | Path to feature directory in the customer repo | `features` |
| `PRODUCT_VISION_PATH` | Path to vision doc | `PRODUCT_VISION.md` |
| `SYSTEM_ARCHITECTURE_PATH` | Path to architecture doc | `SYSTEM_ARCHITECTURE.md` |
| `BRAND_PATH` | Path to brand doc | `BRAND.md` |

## Onboarding checklist

For each new customer:

- [ ] Customer provides credentials per "Pre-requisites" §1–5.
- [ ] Set the `WorkspaceConfig` env vars in `.env` (or whatever secret store the
      platform deployment uses).
- [ ] Restart the bot. Verify the `[BOOT]` log line.
- [ ] Send a test message in `#${mainChannel}` — concierge should orient.
- [ ] Create a test feature: `mkdir features/onboarding-test/` in the customer
      repo with a stub `onboarding-test.product.md`. Send `/pm` in
      `#feature-onboarding-test` — PM agent should orient.
- [ ] Run the MT-12 (concierge), MT-15 (first-time-user orientation), and at
      least one phase-specific MT scenario from `MANUAL_TESTS.md` to confirm
      end-to-end flow.

## What the platform does NOT touch in the customer repo

Per CLAUDE.md Principle 3a: the customer repo is read-only from the platform's
perspective. The platform never:
- Adds files to the customer repo to make a parser easier
- Modifies `PRODUCT_VISION.md`, `SYSTEM_ARCHITECTURE.md`, `BRAND.md` directly
  (it surfaces proposed changes to the human; the human commits)
- Deletes anything in `features/`
- Changes branch naming or directory structure

The platform's only writes to the customer repo are via the agent's
spec-write tools (`save_*_spec_draft`, `save_approved_*_spec`,
`apply_*_spec_patch`) and only to the per-feature spec branches and the
canonical `features/<name>/<name>.<type>.md` paths.

## Common onboarding issues

### "Bot doesn't respond"

Check that the Slack bot is **invited to the feature channel**. The bot
won't see messages in channels it isn't in.

### "Agent says 'I can't find the product vision'"

The bot loaded but couldn't read `PRODUCT_VISION.md` from GitHub. Check:
1. `GITHUB_TOKEN` has `repo` scope (or `public_repo` for public repos).
2. `PRODUCT_VISION_PATH` matches the actual filename in the customer repo
   (case-sensitive).

### "The platform tried to write to features/<name>/ but the directory doesn't exist"

The platform creates the directory + spec file on first save. If the
customer wants to bootstrap a feature with no platform interaction, they
can pre-create the directory; the platform will read existing content.

### "Slash command `/pm` returns 'command not found'"

Slack slash commands are registered per-app, per-workspace. The customer's
Slack admin must add the slash command in the Slack app config.
