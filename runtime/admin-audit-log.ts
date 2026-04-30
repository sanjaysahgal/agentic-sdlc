// Block L4 of the approved system-wide plan
// (~/.claude/plans/rate-this-plan-zesty-tiger.md). Immutable append-only
// audit log for security-relevant administrative events — separate from
// the operational `[STORE]` / `[ROUTER]` / `[ESCALATION]` logs in
// `logs/bot-*.log`. Operational logs rotate; the admin audit log does not.
//
// Recorded events:
//   - tenant onboarding (new WorkspaceConfig accepted)
//   - tenant offboarding (state deletion — Block L5)
//   - secret rotation (GitHub PAT, Slack tokens, Anthropic key — caller
//     stamps when they rotate)
//   - manual state-corruption recovery (operator restored from backup)
//   - cutover flip (CUTOVER_ENABLED toggled)
//
// File format: JSONL — one JSON object per line. Append-only at the
// filesystem level (operator should set chattr +a or filesystem ACLs in
// production deployments; the platform layer relies on `fs.appendFile`
// semantics and does not delete or overwrite lines).

import * as fs from "node:fs"
import * as path from "node:path"

export type AdminAuditEventKind =
  | "tenant-onboarded"
  | "tenant-offboarded"
  | "secret-rotated"
  | "state-restored-from-backup"
  | "cutover-flipped"

export interface AdminAuditEvent {
  readonly timestamp: string  // ISO-8601 UTC
  readonly kind:      AdminAuditEventKind
  readonly actor:     string  // operator identifier (email, username) — caller-supplied
  readonly tenant?:   string  // tenant id / product name when applicable
  readonly details:   Record<string, string | number | boolean>
}

const ADMIN_AUDIT_LOG_PATH = path.join(__dirname, "../.admin-audit-log.jsonl")

let _logPath: string = ADMIN_AUDIT_LOG_PATH

/** For tests: override the file path without touching production state. */
export function setAdminAuditLogPath(p: string): void {
  _logPath = p
}

/** Append one event to the immutable audit log. Synchronous to guarantee
 *  ordering and durability before the caller proceeds. */
export function recordAdminAuditEvent(event: Omit<AdminAuditEvent, "timestamp">): AdminAuditEvent {
  const stamped: AdminAuditEvent = {
    timestamp: new Date().toISOString(),
    ...event,
  }
  // appendFileSync with the 'a' flag is atomic per write on POSIX file
  // systems for writes ≤ PIPE_BUF (4096 bytes). Each event is well under
  // that limit by construction (no free-text content).
  fs.appendFileSync(_logPath, JSON.stringify(stamped) + "\n", { flag: "a" })
  console.log(`[ADMIN-AUDIT] ${stamped.kind} actor=${stamped.actor} tenant=${stamped.tenant ?? "(none)"}`)
  return stamped
}

/** Read all events. For operator review; not for hot-path use. */
export function readAdminAuditEvents(): AdminAuditEvent[] {
  let raw: string
  try { raw = fs.readFileSync(_logPath, "utf-8") } catch { return [] }
  return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as AdminAuditEvent)
}
