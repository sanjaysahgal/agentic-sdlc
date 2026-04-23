# Slack User Testing Checklist

Track live Slack testing results. Each test builds on the previous — fix failures before continuing.

---

## Layer 1: Baseline (bot is running)

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 1.1 | Concierge responds to normal message | `#all-acme` | "What's happening right now?" | Concierge replies with feature status or welcome | |
| 1.2 | Bot ignores its own messages | `#all-acme` | (observe after 1.1) | No infinite loop — bot responds once | |

---

## Layer 2: Slash command validation (error paths)

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 2.1 | Empty slash command rejected | `#all-acme` | `/pm` (no text) | Ephemeral "Usage: `/pm <your message>`" | |
| 2.2 | Unsupported channel rejected | Any non-feature, non-general | `/pm hello` | "Slash commands work in `#feature-*` and `#all-acme`" | |

---

## Layer 3: Product-level mode (general channel)

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 3.1 | PM answers vision question | `#all-acme` | `/pm What are the non-negotiable constraints?` | PM answers from PRODUCT_VISION.md content | |
| 3.2 | PM stays in domain | `#all-acme` | `/pm What tech stack should we use?` | PM redirects to architect agent | |
| 3.3 | Designer answers brand question | `#all-acme` | `/design What should our design system look like?` | Designer talks brand/visual language | |
| 3.4 | Designer stays in domain | `#all-acme` | `/design What features should we build next?` | Designer redirects to PM agent | |
| 3.5 | Architect answers arch question | `#all-acme` | `/architect What is our current tech stack?` | Architect answers from system-architecture.md | |
| 3.6 | Architect stays in domain | `#all-acme` | `/architect What should our brand colors be?` | Architect redirects to design agent | |
| 3.7 | Seed message appears | `#all-acme` | Any slash command | "_@you → [Agent] Agent:_" visible in channel | |
| 3.8 | Response in thread | `#all-acme` | Any slash command | Agent response appears as thread reply, not top-level | |

---

## Layer 4: Feature channel slash commands

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 4.1 | /pm overrides phase routing | `#feature-onboarding` | `/pm What's the product spec status?` | Routes to PM regardless of current phase | |
| 4.2 | /design overrides phase routing | `#feature-onboarding` | `/design Summarize the design direction` | Routes to Design regardless of current phase | |
| 4.3 | /architect overrides phase routing | `#feature-onboarding` | `/architect What data model do we need?` | Routes to Architect regardless of current phase | |
| 4.4 | Seed message in feature channel | `#feature-onboarding` | Any slash command | "_@you → [Agent] Agent:_" visible | |
| 4.5 | Feature context loaded | `#feature-onboarding` | `/pm Tell me about this feature` | PM responds with onboarding feature context, not generic | |

---

## Layer 5: Normal flow regression

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 5.1 | Phase-based routing works | `#feature-onboarding` | Normal message (no slash command) | Routes to current phase agent | |
| 5.2 | @pm: text prefix works | `#feature-onboarding` | `@pm: What about the error path?` | Routes to PM (text prefix still functional) | |
| 5.3 | Escalation flow works | `#feature-onboarding` | Trigger a PM gap in design | Escalation CTA appears, "yes" routes to PM | |

---

## Layer 6: Agent quality (content verification)

| # | Test | Channel | Input | Expected | Status |
|---|---|---|---|---|---|
| 6.1 | No hedge language in response | Any | Any slash command | Agent gives recommendation, not "what would you like?" | |
| 6.2 | Platform status line appears | `#feature-onboarding` | `/architect` (with eng spec draft) | "_N items to address_" prefix when gaps exist | |
| 6.3 | Uncommitted decisions detected | `#feature-onboarding` | Discuss decisions without saving | "Heads up: decisions were discussed but not saved" | |
| 6.4 | Assertive escalation CTA | `#feature-onboarding` | Trigger upstream gap | Structured CTA, not passive "should we ask PM?" | |

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
| | | | | | |
