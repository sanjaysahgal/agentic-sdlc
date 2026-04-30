import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  recordAdminAuditEvent,
  readAdminAuditEvents,
  setAdminAuditLogPath,
  type AdminAuditEvent,
} from "../../runtime/admin-audit-log"

describe("admin-audit-log (Block L4)", () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "admin-audit-"))
    logPath = join(tmpDir, "audit.jsonl")
    setAdminAuditLogPath(logPath)
  })

  it("appends one event, readable round-trip", () => {
    const event = recordAdminAuditEvent({
      kind:    "tenant-onboarded",
      actor:   "alice@example.com",
      tenant:  "acme",
      details: { product: "ACME Health", repo: "acme/agentic-acme" },
    })
    expect(existsSync(logPath)).toBe(true)
    const events = readAdminAuditEvents()
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("tenant-onboarded")
    expect(events[0].actor).toBe("alice@example.com")
    expect(events[0].timestamp).toBe(event.timestamp)
  })

  it("preserves ordering across multiple appends", () => {
    recordAdminAuditEvent({ kind: "secret-rotated", actor: "alice", details: { secret: "github-token" } })
    recordAdminAuditEvent({ kind: "cutover-flipped", actor: "bob",   details: { from: false, to: true   } })
    recordAdminAuditEvent({ kind: "tenant-offboarded", actor: "alice", tenant: "old-tenant", details: {} })

    const events = readAdminAuditEvents()
    expect(events.length).toBe(3)
    expect(events.map((e) => e.kind)).toEqual([
      "secret-rotated",
      "cutover-flipped",
      "tenant-offboarded",
    ])
  })

  it("never overwrites or rewrites existing lines (append-only contract)", () => {
    recordAdminAuditEvent({ kind: "secret-rotated", actor: "alice", details: { secret: "github-token" } })
    const beforeBytes = readFileSync(logPath, "utf-8")
    recordAdminAuditEvent({ kind: "secret-rotated", actor: "bob", details: { secret: "anthropic-key" } })
    const afterBytes = readFileSync(logPath, "utf-8")
    // Append-only: the original bytes must appear unchanged at the start of the new content.
    expect(afterBytes.startsWith(beforeBytes)).toBe(true)
  })

  it("each event includes ISO-8601 timestamp", () => {
    recordAdminAuditEvent({ kind: "tenant-onboarded", actor: "alice", tenant: "acme", details: {} })
    const events = readAdminAuditEvents()
    expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it("readAdminAuditEvents returns [] when log file does not exist", () => {
    setAdminAuditLogPath(join(tmpDir, "nonexistent.jsonl"))
    expect(readAdminAuditEvents()).toEqual([])
  })

  it("typed event kinds enforced at compile time (compile-time check)", () => {
    // This test exists to assert the type narrowing — TypeScript would fail
    // compile if the kind were not in AdminAuditEventKind.
    const event: AdminAuditEvent = {
      timestamp: new Date().toISOString(),
      kind:      "state-restored-from-backup",
      actor:     "alice",
      details:   { snapshot: "state-2026-04-29.tar.gz" },
    }
    expect(event.kind).toBe("state-restored-from-backup")
  })
})
