# Backup strategy

> Block L1 of the approved system-wide plan
> (`~/.claude/plans/rate-this-plan-zesty-tiger.md`). What we back up,
> how often, where it lives, and how restore is verified.

## What needs backing up

| Asset | Authoritative source | Backup needed? | Cadence |
|---|---|---|---|
| Spec drafts + approved specs | GitHub (customer's repo) | No — GitHub is the authoritative store, with its own redundancy | N/A |
| `PRODUCT_VISION.md`, `SYSTEM_ARCHITECTURE.md`, `BRAND.md` | GitHub | No — same as specs | N/A |
| `.conversation-state.json` | Local file (file-backed in-memory state) | YES | Daily |
| `.confirmed-agents.json` | Local file | YES | Daily |
| `.conversation-history.json` | Local file | YES | Daily |
| Logs (`logs/bot-*.log`) | Local files (rotated daily) | Optional | 30-day rotation already in place via winston-daily-rotate-file |
| `.env` (secrets) | Operator's secret store | Operator-managed (1Password / Vault / env injection) | Operator-managed |

In short: GitHub holds everything important. The local state files hold
in-flight pending state (escalations, approvals, decision reviews) that's
ephemeral but useful — losing it is recoverable per `docs/DR_RUNBOOK.md`
§1.

## Cadence

- **Daily snapshot**: 03:00 local time. The script `scripts/backup-state.sh`
  copies the three state files to `backups/state-YYYY-MM-DD.tar.gz`.
- **Retention**: 30 days. Older snapshots are deleted by the same script.
- **Quarterly DR drill**: per `docs/DR_RUNBOOK.md` — restore verified by
  taking the platform offline, deleting state, restarting, restoring from
  snapshot.

## Restore procedure

```bash
# Pick a snapshot
ls -lh backups/state-*.tar.gz | tail -10

# Stop the bot
kill -TERM $(pgrep -f "tsx.*server.ts" | head -1)

# Restore
tar -xzf backups/state-2026-04-29.tar.gz -C /

# Start the bot
npm run dev

# Verify the [BOOT] line + a quick MT scenario from MANUAL_TESTS.md
```

## Cross-tenant note (Block K dependency)

This backup strategy assumes single-tenant (file-based state). Block K
(multi-tenant scale-out) replaces file-backed state with a durable
storage backend; at that point this doc is superseded by the storage
backend's own backup discipline (e.g. Postgres pg_dump cron, point-in-time
restore from the cloud provider).

## Where backups live

Today: local filesystem (`backups/` directory in the repo root, gitignored).
Block L's longer-term: an off-host destination (S3 bucket with object
versioning + cross-region replication is the recommended path) so a host
loss doesn't take backups with it. Today's local-only backup is a known
shortcut documented in DECISIONS.md.
