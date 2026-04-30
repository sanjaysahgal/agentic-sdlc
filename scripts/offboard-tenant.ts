// Block L5 of the approved system-wide plan
// (~/.claude/plans/rate-this-plan-zesty-tiger.md). GDPR-compliant tenant
// deletion. Removes all per-tenant state owned by the platform; does NOT
// touch the customer's GitHub repo (per Principle 3a — customer repo is
// read-only from the platform's perspective).
//
// What gets deleted:
//   - All in-memory + on-disk conversation state for the tenant's product
//     (pendingEscalations, pendingApprovals, pendingDecisionReviews,
//      escalationNotifications, threadAgents, orientedUsers,
//      conversation history, confirmed agents)
//   - The tenant's entries from the local state files (single-tenant today;
//     when Block K lands, this becomes a row-delete in the durable backend)
//   - Logged in admin-audit-log per L4
//
// What is NOT deleted (operator must do separately):
//   - GitHub spec files in the customer's repo (the customer's authoritative
//     store — they may want to retain or delete those independently)
//   - Slack messages (Slack's own retention applies)
//   - Anthropic API logs (the customer's account, not ours)
//
// Usage:
//   npx tsx scripts/offboard-tenant.ts --product <name> --actor <email>
//   npx tsx scripts/offboard-tenant.ts --product <name> --actor <email> --dry-run

import * as fs from "node:fs"
import * as path from "node:path"
import {
  recordAdminAuditEvent,
} from "../runtime/admin-audit-log"
import {
  parseConversationState,
} from "../runtime/conversation-store"

interface CliArgs {
  product: string
  actor:   string
  dryRun:  boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--product")  args.product = argv[++i]
    else if (a === "--actor")    args.actor   = argv[++i]
    else if (a === "--dry-run")  args.dryRun  = true
  }
  if (!args.product) throw new Error("--product is required (the tenant's PRODUCT_NAME from .env)")
  if (!args.actor)   throw new Error("--actor is required (operator email/identifier for the audit log)")
  return args as CliArgs
}

function offboardTenant(args: CliArgs): { dropped: Record<string, number> } {
  const repoRoot = path.join(__dirname, "..")
  const stateFile   = path.join(repoRoot, ".conversation-state.json")
  const historyFile = path.join(repoRoot, ".conversation-history.json")
  const agentsFile  = path.join(repoRoot, ".confirmed-agents.json")

  const dropped: Record<string, number> = {
    pendingEscalations:      0,
    pendingApprovals:        0,
    pendingDecisionReviews:  0,
    escalationNotifications: 0,
    threadAgents:            0,
    orientedUsers:           0,
    historyEntries:          0,
    confirmedAgents:         0,
  }

  // ── conversation-state.json ────────────────────────────────────────────────
  let state: ReturnType<typeof parseConversationState> | null = null
  if (fs.existsSync(stateFile)) {
    state = parseConversationState(fs.readFileSync(stateFile, "utf-8"))
  }

  function keyMatches(key: string): boolean {
    // FeatureKey serializes as `<product>:<feature>` in conversation-store.
    // Match all keys whose product half equals the offboarding tenant.
    return key.startsWith(`${args.product}:`) || key === args.product
  }

  if (state) {
    const filtered = {
      pendingEscalations:      state.pendingEscalations.filter(([k]) => !keyMatches(k)),
      pendingApprovals:        state.pendingApprovals.filter(([k]) => !keyMatches(k)),
      pendingDecisionReviews:  state.pendingDecisionReviews.filter(([k]) => !keyMatches(k)),
      escalationNotifications: state.escalationNotifications.filter(([k]) => !keyMatches(k)),
      threadAgents:            state.threadAgents.filter(([k]) => !keyMatches(k)),
      orientedUsers:           state.orientedUsers.filter((u) => !keyMatches(u)),
    }
    dropped.pendingEscalations      = state.pendingEscalations.length      - filtered.pendingEscalations.length
    dropped.pendingApprovals        = state.pendingApprovals.length        - filtered.pendingApprovals.length
    dropped.pendingDecisionReviews  = state.pendingDecisionReviews.length  - filtered.pendingDecisionReviews.length
    dropped.escalationNotifications = state.escalationNotifications.length - filtered.escalationNotifications.length
    dropped.threadAgents            = state.threadAgents.length            - filtered.threadAgents.length
    dropped.orientedUsers           = state.orientedUsers.length           - filtered.orientedUsers.length

    if (!args.dryRun) {
      const next = {
        pendingEscalations:      Object.fromEntries(filtered.pendingEscalations),
        pendingApprovals:        Object.fromEntries(filtered.pendingApprovals),
        pendingDecisionReviews:  Object.fromEntries(filtered.pendingDecisionReviews),
        escalationNotifications: Object.fromEntries(filtered.escalationNotifications),
        threadAgents:            Object.fromEntries(filtered.threadAgents),
        orientedUsers:           filtered.orientedUsers,
      }
      fs.writeFileSync(stateFile, JSON.stringify(next, null, 2))
    }
  }

  // ── conversation-history.json ──────────────────────────────────────────────
  if (fs.existsSync(historyFile)) {
    const raw = fs.readFileSync(historyFile, "utf-8")
    let history: Record<string, unknown> = {}
    try { history = JSON.parse(raw) as Record<string, unknown> } catch { history = {} }
    const before = Object.keys(history).length
    for (const k of Object.keys(history)) {
      if (keyMatches(k)) delete history[k]
    }
    dropped.historyEntries = before - Object.keys(history).length
    if (!args.dryRun) {
      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2))
    }
  }

  // ── .confirmed-agents.json ─────────────────────────────────────────────────
  if (fs.existsSync(agentsFile)) {
    const raw = fs.readFileSync(agentsFile, "utf-8")
    let agents: Record<string, unknown> = {}
    try { agents = JSON.parse(raw) as Record<string, unknown> } catch { agents = {} }
    const before = Object.keys(agents).length
    for (const k of Object.keys(agents)) {
      if (keyMatches(k)) delete agents[k]
    }
    dropped.confirmedAgents = before - Object.keys(agents).length
    if (!args.dryRun) {
      fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2))
    }
  }

  // ── audit log (only on real runs) ──────────────────────────────────────────
  if (!args.dryRun) {
    recordAdminAuditEvent({
      kind:    "tenant-offboarded",
      actor:   args.actor,
      tenant:  args.product,
      details: dropped,
    })
  }

  return { dropped }
}

// ── Entry ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2))
  console.log(`[offboard] product=${args.product} actor=${args.actor} dryRun=${args.dryRun}`)
  const { dropped } = offboardTenant(args)
  console.log(`[offboard] dropped:`)
  for (const [k, n] of Object.entries(dropped)) console.log(`  ${k}: ${n}`)
  if (args.dryRun) {
    console.log(`[offboard] DRY RUN — no files modified, no audit event recorded.`)
  } else {
    console.log(`[offboard] complete. Audit event recorded.`)
  }
}

export { offboardTenant }
