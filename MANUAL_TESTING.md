# Slack Manual Testing Suite

Track live Slack testing results. Each test builds on the previous — fix failures before continuing.

---

## Layer 1: Concierge baseline (general channel)

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 1.1 | Concierge responds to greeting | General | "hi" | Concierge welcomes, asks role (ambiguous intent) | ✅ 2026-04-23 |
| 1.2 | Bot ignores its own messages | General | (observe after 1.1) | No infinite loop — bot responds once | ✅ 2026-04-23 |
| 1.3 | Intent over identity — product question | General | "I want to know more about this product" | Links to vision doc + suggests `/pm` at top of channel. Does NOT ask role | ✅ 2026-04-23 |
| 1.4 | Intent over identity — feature interest | General | "I'd like to work on onboarding" | Points to `#feature-onboarding` + gives feature status. Does NOT block on role | ✅ 2026-04-23 |
| 1.5 | Product status query | General | "What is the current state of the product?" | Shows pipeline status with features, phases, done/in-progress/not-started | ✅ 2026-04-23 |
| 1.6 | Slash command guidance correct | General | (observe in thread responses) | Says "type `/pm` at the top of this channel" — NOT "right here" | ✅ 2026-04-23 |
| 1.7 | No company names in responses | General | (observe all responses) | No "Stripe", "Google", "Airbnb" etc. No "AI Product Manager" | ✅ 2026-04-23 |
| 1.8 | Thread continuity — concierge multi-turn | General | Multiple messages in same thread | Concierge maintains conversation context across turns | ✅ 2026-04-23 |

---

## Layer 2: Slash command validation (error paths)

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 2.1 | Empty slash command rejected | General | `/pm` (no text) | Ephemeral "Usage: `/pm <your message>`" | |
| 2.2 | Unsupported channel rejected | Any non-feature, non-general | `/pm hello` | "Slash commands work in `#feature-*` and the main channel" | |

---

## Layer 3: Slash commands — agents in general channel

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 3.1 | PM answers vision question | General | `/pm What are the non-negotiable constraints?` | PM answers from PRODUCT_VISION.md content | ✅ 2026-04-23 |
| 3.2 | PM stays in domain | General | `/pm What tech stack should we use?` | PM redirects to architect | ✅ 2026-04-23 |
| 3.3 | PM thread continuity | General | Follow-up in PM thread (no slash) | PM responds (not concierge) | ✅ 2026-04-23 |
| 3.4 | Designer answers brand question | General | `/design What should our design system look like?` | Designer talks brand/visual language | |
| 3.5 | Designer stays in domain | General | `/design What features should we build next?` | Designer redirects to PM | |
| 3.6 | Designer thread continuity | General | Follow-up in design thread (no slash) | Designer responds (not concierge) | |
| 3.7 | Architect answers arch question | General | `/architect What is our current tech stack?` | Architect answers from system-architecture.md | ✅ 2026-04-23 |
| 3.8 | Architect stays in domain | General | `/architect What should our brand colors be?` | Architect redirects to design | |
| 3.9 | Architect thread continuity | General | Follow-up in architect thread (no slash) | Architect responds (not concierge) | ✅ 2026-04-23 |
| 3.10 | Seed message appears | General | Any slash command | "_@you → [Agent] Agent:_" visible in channel | ✅ 2026-04-23 |
| 3.11 | Response in thread | General | Any slash command | Agent response appears as thread reply | ✅ 2026-04-23 |
| 3.12 | No formatting inconsistency | General | Any slash command | Numbered lists where appropriate, consistent style | |

---

## Layer 4: Feature channel slash commands

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 4.1 | /pm overrides phase routing | `#feature-onboarding` | `/pm What's the product spec status?` | Routes to PM regardless of current phase | |
| 4.2 | /design overrides phase routing | `#feature-onboarding` | `/design Summarize the design direction` | Routes to Design regardless of current phase | |
| 4.3 | /architect overrides phase routing | `#feature-onboarding` | `/architect What data model do we need?` | Routes to Architect regardless of current phase | |
| 4.4 | Seed message in feature channel | `#feature-onboarding` | Any slash command | "_@you → [Agent] Agent:_" visible | |
| 4.5 | Feature context loaded | `#feature-onboarding` | `/pm Tell me about this feature` | PM responds with onboarding feature context, not generic | |
| 4.6 | No phase transition on slash command | `#feature-onboarding` | `/pm hi` then normal message | Normal message routes back to phase agent (architect), no history wipe | |

---

## Layer 5: Normal flow regression

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 5.1 | Phase-based routing works | `#feature-onboarding` | Normal message (no slash command) | Routes to current phase agent | |
| 5.2 | @pm: text prefix works in thread | `#feature-onboarding` | `@pm: What about the error path?` | Routes to PM (text prefix still functional) | |
| 5.3 | @pm: is temporary override | `#feature-onboarding` | `@pm: hi` then normal message | Next message routes back to phase agent | |
| 5.4 | Escalation flow works | `#feature-onboarding` | Trigger a PM gap in design | Escalation CTA appears, "yes" routes to PM | |

---

## Layer 6: Agent quality (content verification)

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 6.1 | No hedge language in response | Any | Any slash command | Agent gives recommendation, not "what would you like?" | |
| 6.2 | Platform status line appears | `#feature-onboarding` | Message to architect (with eng spec draft) | "_N items to address_" prefix when gaps exist | |
| 6.3 | Uncommitted decisions detected | `#feature-onboarding` | Discuss decisions without saving | "Heads up: decisions were discussed but not saved" | |
| 6.4 | Assertive escalation CTA | `#feature-onboarding` | Trigger upstream gap | Structured CTA, not passive "should we ask PM?" | |
| 6.5 | No company names in any agent | Any | Any interaction | No "Stripe", "Google", "Apple" etc. | ✅ 2026-04-23 |
| 6.6 | No "AI" prefix on agents | Any | Any interaction | "Product Manager" not "AI Product Manager" | ✅ 2026-04-23 |

---

## Layer 7: End-to-end onboarding pipeline

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 7.1 | PM shapes onboarding spec | `#feature-onboarding` | "Let's build an onboarding flow" | PM proposes spec structure, saves draft | |
| 7.2 | PM spec approved | `#feature-onboarding` | "Approved" | Finalization audit runs, spec merged to main | |
| 7.3 | Design phase starts | `#feature-onboarding` | Next message after approval | Routes to Design agent automatically | |
| 7.4 | Design spec shaped | `#feature-onboarding` | Work with designer | Design spec drafted with screens/flows | |
| 7.5 | Design spec approved | `#feature-onboarding` | "Approved" | Design finalization + architect entry | |
| 7.6 | Architect phase starts | `#feature-onboarding` | Next message after design approval | Routes to Architect agent | |
| 7.7 | Engineering spec shaped | `#feature-onboarding` | Work with architect | Engineering spec with API contracts, data model | |
| 7.8 | Engineering spec approved | `#feature-onboarding` | "Approved" | Engineering finalization, spec merged | |

---

## Issues Found

| Date | Test # | Issue | Root cause | Fix | Status |
|---|---|---|---|---|---|
| 2026-04-23 | 1.3 | Concierge asked role instead of acting on intent | "figure out role" instruction prioritized over intent | Intent-over-identity priority rule in prompt | ✅ Fixed |
| 2026-04-23 | 1.7 | Concierge said "shipped at Stripe, Airbnb, Google" | Company names in persona descriptions | Stripped from all agent prompts | ✅ Fixed |
| 2026-04-23 | 1.7 | Concierge said "AI Product Manager" | "AI" prefix in agent descriptions | Removed from all references | ✅ Fixed |
| 2026-04-23 | 1.6 | Concierge said "use /pm right here" in thread | Slash commands don't work in threads | Changed to "at the top of this channel" | ✅ Fixed |
| 2026-04-23 | 1.4 | Concierge kept asking "what's your role?" on clear intent | Role question appended to every response | Explicit NEVER instruction with examples | ✅ Fixed |
| 2026-04-23 | 3.9 | Follow-up in architect thread went to Concierge | No thread-to-agent mapping in general channel | threadAgentMap + routing in app.ts | ✅ Fixed |
| 2026-04-23 | — | "Concierge is thinking..." stuck, no response | Heartbeat timer overwrote final response | finalResponseSent guard flag in withThinking | ✅ Fixed |
| 2026-04-23 | 4.1 | /pm in feature channel wiped 154 messages of history | setConfirmedAgent triggered phase transition | Temporary override — no setConfirmedAgent call | ✅ Fixed |
| 2026-04-23 | — | PM formatting inconsistent in product-context mode | classifyMessageScope bypass used minimal prompt | Removed bypass — one PM code path, one prompt | ✅ Fixed |
| 2026-04-23 | 3.1 | PM refused to edit vision doc + hallucinated "#design-and-docs agent" | Product-level prompt said "no draft branches" → PM interpreted as "can't edit anything" | Added "you own it, format as ready-to-paste, never refuse" + "never reference nonexistent agents" | ✅ Fixed |
| 2026-04-24 | 3.7 | Architect deflected "which feature is being worked on?" to PM | Domain description too narrow — architect thought pipeline status = PM territory | Injected feature status into all product-level prompts + "pipeline status is common knowledge" | ✅ Fixed |
