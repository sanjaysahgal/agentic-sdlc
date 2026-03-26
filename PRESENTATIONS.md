# PRESENTATIONS.md — Canonical facts for all presentation decks

This file is the single source of truth for every claim that appears across the three presentation decks. Update this file first whenever a fact changes, then update the affected presentations.

**Presentations:**
| File | Audience |
|---|---|
| `docs/presentations/platform-engineering-deep-dive.html` | Engineers — architecture, data flow, technical depth |
| `docs/presentations/ai-engineering-practices.html` | Engineering team — Claude Code practices |
| `docs/presentations/investor-pitch.html` | Investors / personal strategic read — product, traction, vision |

---

## Agent status

| Agent | Status | Phase |
|---|---|---|
| Concierge | ✅ Live | Entry point |
| PM agent | ✅ Live | Phase 1 — Product Spec |
| Design agent | ✅ Live | Phase 2 — Design Spec |
| Architect agent | ✅ Live | Phase 3 — Engineering Spec |
| PGM agent | 🔜 Next | Phase 4 — Work Items |
| Backend agent | ⬜ Planned | Phase 4 — Code |
| Frontend agent | ⬜ Planned | Phase 4 — Code |
| QA agent | ⬜ Planned | Phase 5 — QA |
| Spec validator | ⬜ Planned | Cross-cutting |
| Eng-mgr agent | ⬜ Planned | Cross-cutting |

**Headline count:** 4 live · 6 planned

---

## Pipeline phase status

| Phase | Name | Status |
|---|---|---|
| Phase 1 | Product Spec | ✅ Live |
| Phase 2 | Design Spec | ✅ Live |
| Phase 3 | Engineering Spec | ✅ Live |
| Phase 4 | Work Items + Build | 🔜 Next |
| Phase 5 | QA | ⬜ Planned |
| Phase 6 | Deploy | ⬜ Planned |

---

## Roadmap step status

| Step | Description | Status |
|---|---|---|
| Step 1 | Full specification workflow (PM + Design + Architect) | ✅ Complete |
| Step 2 | Work item generation (PGM agent) | 🔜 Next |
| Step 3 | Autonomous code generation (Backend + Frontend + QA) | ⬜ Planned |
| Step 4 | Spec to production, zero humans required (agentic-cicd) | ⬜ Planned |
| Step 5 | Closed loop — production bugs re-enter as specs | ⬜ Planned |

---

## Traction claims

| Claim | Current value |
|---|---|
| Agents live | 4 |
| First product built on Archon Dev | Health360 — AI health companion, built for 100M+ users |
| Health360 status | In development, zero human code written in product repo |
| Onboarding time | Under an hour |
| Onboarding requirement | One config file — no code changes |

---

## Positioning & messaging

| Label | Current copy |
|---|---|
| Tagline | Autonomous Engineering, Human Control |
| One-liner | An AI specialist at every phase — from first idea to shipped code |
| Competitive position | The spec layer that was always missing. Code-gen starts at the wrong layer. |
| Moat summary | Coherence enforcement, phase routing, stateless agents, zero-code onboarding |

---

## Company / product

| Label | Value |
|---|---|
| Company | Archon Labs |
| Product | Archon Dev |
| Website | getarchon.dev |
| Patent | USPTO provisional #64/015,378 — filed March 24, 2026 |
| Founder | Sanjay Sahgal — 34 years shipping software at scale |

---

## Claude Code practices (ai-engineering-practices deck)

| Practice | What it is | Where it lives |
|---|---|---|
| CLAUDE.md | Onboarding doc — context, constraints, checklist, DoD | Repo root |
| Explicit constraints | Rules with violation examples inline | CLAUDE.md › Core Principles |
| Definition of Done | Table: change type → required doc | CLAUDE.md › Definition of Done |
| CI enforcement | doc-sync-check.yml — blocks merge if docs not updated | .github/workflows/ |
| Memory system | MEMORY.md index + per-topic files | ~/.claude/projects/.../memory/ |
| Subagent strategy | Delegate exploration; keep implementation in main context | CLAUDE.md › Subagent Strategy |
| Testing discipline | Second-piece rule + vi.hoisted mocking + vitest in CI | CLAUDE.md › Testing Discipline |
| Behavioral contracts | Autonomous fixing, demand elegance, flag before act, self-rate | CLAUDE.md › behavioral sections |
| DECISIONS.md | Every shortcut documented with scale trigger | DECISIONS.md at repo root |

---

## Update triggers

When any of the following happen, update this file first, then update the affected presentations:

| Trigger | Update PRESENTATIONS.md section | Update these decks |
|---|---|---|
| New agent goes live | Agent status, headline count | platform-deep-dive, investor-pitch |
| Roadmap step completes | Roadmap step status, traction claims | investor-pitch, platform-deep-dive |
| New CLAUDE.md practice added | Claude Code practices table | ai-engineering-practices |
| Website positioning changes | Positioning & messaging | investor-pitch |
| Patent status changes | Company / product | investor-pitch |
| New product launched on Archon Dev | Traction claims | investor-pitch |
