// Phase 5 / I2 — one-time migration script for stale on-disk routing state.
//
// Run before Phase 4 cutover (and idempotently on every subsequent startup
// if you want belt-and-suspenders) to drop any pendingEscalation /
// escalationNotification entry whose targetAgent isn't a valid AgentId. The
// v2 router enforces I2 at runtime ("corrupt targetAgent → invalid-state with
// cleanup") — this script handles the disk-side counterpart so stale records
// from before I2 landed can't trigger that path on every message after
// cutover.
//
// Legacy "design" is preserved — it's an aliased AgentId that the router
// canonicalizes to "ux-design" on read. Only genuinely corrupt values
// (typos, removed agents, missing field) are dropped.
//
// Usage (CLI):
//   npx ts-node scripts/migrate-routing-state-v2.ts          # dry-run, prints diff
//   npx ts-node scripts/migrate-routing-state-v2.ts --write  # writes cleaned file
//
// The pure function `migrateRoutingState(parsed)` is exported for tests.

import * as fs from "node:fs"
import * as path from "node:path"
import { isAgentId } from "../runtime/routing/agent-registry"

const STATE_FILE = path.resolve(__dirname, "..", ".conversation-state.json")
const LEGACY_TARGET_ALIASES = new Set(["design"])

export type OnDiskEntry = { targetAgent?: unknown; [k: string]: unknown }
export type RoutingStateOnDisk = {
  pendingEscalations?:      Record<string, OnDiskEntry>
  escalationNotifications?: Record<string, OnDiskEntry>
  // Other fields pass through untouched. Typed as unknown so the migration
  // never mutates state it isn't responsible for cleaning.
  [otherKey: string]:       unknown
}

export type MigrationReport = {
  droppedPendingEscalations:      Array<{ key: string; reason: string }>
  droppedEscalationNotifications: Array<{ key: string; reason: string }>
  // True iff any drops occurred. False means the input was already clean —
  // re-running the migration on the same file is a no-op (idempotency proof).
  changed: boolean
}

export type MigrationResult = {
  cleaned: RoutingStateOnDisk
  report:  MigrationReport
}

// ── Pure function (the testable core) ─────────────────────────────────────────

export function migrateRoutingState(input: RoutingStateOnDisk): MigrationResult {
  const cleaned: RoutingStateOnDisk = { ...input }
  const report: MigrationReport = {
    droppedPendingEscalations:      [],
    droppedEscalationNotifications: [],
    changed: false,
  }

  if (input.pendingEscalations) {
    const next: Record<string, OnDiskEntry> = {}
    for (const [key, value] of Object.entries(input.pendingEscalations)) {
      const reason = validationReason(value?.targetAgent)
      if (reason) {
        report.droppedPendingEscalations.push({ key, reason })
        report.changed = true
        continue
      }
      next[key] = value
    }
    cleaned.pendingEscalations = next
  }

  if (input.escalationNotifications) {
    const next: Record<string, OnDiskEntry> = {}
    for (const [key, value] of Object.entries(input.escalationNotifications)) {
      const reason = validationReason(value?.targetAgent)
      if (reason) {
        report.droppedEscalationNotifications.push({ key, reason })
        report.changed = true
        continue
      }
      next[key] = value
    }
    cleaned.escalationNotifications = next
  }

  return { cleaned, report }
}

function validationReason(targetAgent: unknown): string | null {
  if (typeof targetAgent !== "string") return `missing-or-non-string targetAgent (got ${typeof targetAgent})`
  if (LEGACY_TARGET_ALIASES.has(targetAgent)) return null  // canonicalized at read time
  if (isAgentId(targetAgent)) return null
  return `corrupt targetAgent value: "${targetAgent}"`
}

// ── CLI wrapper ───────────────────────────────────────────────────────────────

function main(): void {
  const writeMode = process.argv.includes("--write")

  if (!fs.existsSync(STATE_FILE)) {
    console.log(`[migrate-routing-state-v2] no state file at ${STATE_FILE} — nothing to do.`)
    return
  }

  const raw = fs.readFileSync(STATE_FILE, "utf-8")
  let parsed: RoutingStateOnDisk
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(`[migrate-routing-state-v2] failed to parse ${STATE_FILE}: ${String(err)}`)
    process.exit(1)
  }

  const { cleaned, report } = migrateRoutingState(parsed)

  console.log(`[migrate-routing-state-v2] dropped pendingEscalations: ${report.droppedPendingEscalations.length}`)
  for (const d of report.droppedPendingEscalations)      console.log(`  - ${d.key}: ${d.reason}`)
  console.log(`[migrate-routing-state-v2] dropped escalationNotifications: ${report.droppedEscalationNotifications.length}`)
  for (const d of report.droppedEscalationNotifications) console.log(`  - ${d.key}: ${d.reason}`)

  if (!report.changed) {
    console.log(`[migrate-routing-state-v2] state is clean — no changes.`)
    return
  }

  if (!writeMode) {
    console.log(`[migrate-routing-state-v2] dry-run — pass --write to persist cleanup.`)
    return
  }

  const backup = `${STATE_FILE}.pre-v2-migration.${Date.now()}.bak`
  fs.copyFileSync(STATE_FILE, backup)
  fs.writeFileSync(STATE_FILE, JSON.stringify(cleaned, null, 2))
  console.log(`[migrate-routing-state-v2] wrote cleaned state. Backup: ${backup}`)
}

if (require.main === module) main()
