# Onboarding — Design Spec (Open Questions Fixture)

<!-- FIXTURE NOTE: This fixture was constructed to match the exact format produced by the design agent
     system prompt (agents/design.ts). It validates that extractAllOpenQuestions is section-scoped:
     the [blocking: yes] line in ## Design Assumptions below must NOT be returned.
     Replace with a real agent capture once available via Slack testing. -->

## User Flows

### Flow 1: First-time login
1. User lands on auth screen — default state with prompt placeholder visible
2. User enters credentials — input focus style activates
3. [blocking: no] Server returns error — inline error treatment applied

## Screens

### Auth Screen
**Purpose:** Entry point for returning and first-time users.
**States:**
- Default: gradient placeholder visible, glow animation active, no input yet
- Focus: input border highlights, placeholder dims to 40% opacity
- Loading [blocking: yes]: spinner replaces CTA button, button dims — timing TBD
- Error: inline red text beneath input, shake animation 200ms ease-out

## Open Questions

- [type: design] [blocking: yes] What is the empty state treatment when a user has no prior sessions — show the full onboarding prompt, or a simplified welcome-back screen?
- [type: design] [blocking: no] Should the "forgot password" link appear on the auth screen by default, or only after a failed login attempt?

## Design Assumptions

- Designed for max 10MB file uploads — upload UX assumes immediate processing.
- Session timeout treated as 30 minutes [blocking: yes but this is in Design Assumptions not Open Questions].

## Design System Updates

[PROPOSED ADDITION TO DESIGN_SYSTEM.md — Auth Components]
New token: `--auth-input-focus-border: rgba(79, 175, 168, 0.6)` — teal focus ring at 60% opacity.
[END PROPOSED ADDITION]
