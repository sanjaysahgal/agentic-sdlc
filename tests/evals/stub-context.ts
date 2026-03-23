// Shared stub context and env setup for all eval scenarios.
// Realistic enough to get meaningful agent responses without depending
// on a live GitHub repo.

import type { AgentContext } from "../../runtime/context-loader"

// Set minimal env vars before any agent system prompt is built.
// Call this at the top of each scenario file.
export function setEvalEnv(): void {
  process.env.PRODUCT_NAME      = "Acme"
  process.env.GITHUB_OWNER      = "acme-co"
  process.env.GITHUB_REPO       = "acme-app"
  process.env.SLACK_MAIN_CHANNEL = "all-acme"
  process.env.ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY ?? "test"
}

export const stubContext: AgentContext = {
  productVision: `
# Acme — Product Vision

Acme is a B2B SaaS task management platform for software teams.
Target users: engineering managers and their teams (5–50 people).
Core value: eliminate status meetings by making project state visible at a glance.

Non-negotiable constraints:
- Mobile-first: every feature must work on iOS and Android
- No AI-generated suggestions in v1 — trust and reliability first
- Integrates with GitHub and Slack out of the box
- Single-tenant data isolation per workspace

Established user model:
- Two roles: Manager and Contributor
- Managers see all tasks; Contributors see only their own
- Tasks have: title, description, status, assignee, due date, priority

Previously approved features:
- Task creation and assignment (shipped)
- GitHub PR linking (shipped)
- Slack notifications for status changes (shipped)
`.trim(),

  systemArchitecture: `
# Acme — System Architecture

Stack: Next.js 14 (App Router), tRPC, Prisma, PostgreSQL, Clerk (auth).
Deployed on Vercel + Supabase.

Key constraints:
- All API access via tRPC procedures (no REST endpoints)
- Prisma schema is the source of truth for the data model
- Row-level security enforced at the Supabase level, not application level
- No direct database access from the client — all mutations go through tRPC
- Real-time via Supabase subscriptions (not polling, not WebSockets)
`.trim(),

  featureConventions: `
Each feature follows the spec chain:
1. Product spec (.product.md) — what, who, why, success criteria
2. Design spec (.design.md) — screens, flows, component decisions
3. Engineering spec (.engineering.md) — data model, tRPC procedures, API contracts

Feature branches: spec/<feature-name>-product, spec/<feature-name>-design, etc.
`.trim(),

  currentDraft: "",
}

export const stubContextWithDraft = (draft: string): AgentContext => ({
  ...stubContext,
  currentDraft: draft,
})

// A complete, approval-ready product spec for use in design/architect scenarios.
export const approvedProductSpec = `
# Onboarding — Product Spec

## Problem
New users arrive with no understanding of what Acme does. First-session drop-off is 60%.

## Target Users
Engineering managers at companies with 5–20 engineers, evaluating Acme for the first time.

## User Stories
- US-1: As a new user, I can complete sign-up in under 2 minutes
- US-2: As a new user, I see a sample project pre-loaded so I understand the product immediately
- US-3: As a new user, I can connect my GitHub account during onboarding

## Acceptance Criteria
- Sign-up form: email + password only (no SSO in v1)
- Sample project auto-created on first login with 5 pre-populated tasks
- GitHub OAuth step is optional (skippable)
- Onboarding completes when user lands on the main task board

## Non-Goals
- Team invites during onboarding (post-v1)
- Mobile onboarding optimization (post-v1)

## Open Questions
None.
`.trim()

// A complete design spec for use in architect scenarios.
export const approvedDesignSpec = `
# Onboarding — Design Spec

### Screen 1: Landing / Sign-up
Email + password fields, "Create account" CTA. Clean, centered layout. No nav.

### Screen 2: GitHub Connect (optional step)
Full-screen OAuth prompt. "Skip for now" link prominent at bottom.

### Screen 3: Sample project loaded
Toast notification: "Your sample project is ready." Auto-redirect to task board.

### Flow: US-1 — New user sign-up
Landing → fill email/password → submit → GitHub step → task board

### Flow: US-2 — Skip GitHub
Landing → fill email/password → submit → GitHub step → click Skip → task board

## Open Questions
None.
`.trim()
