Good call. Here's the first draft of the onboarding product spec.

DRAFT_SPEC_START
# Feature: Onboarding

## Overview
Users create an account, complete their health profile, and reach the home screen for the first time.

## User Stories
- As a new user, I want to create an account so I can access Health360.
- As a new user, I want to complete a health profile so the app can personalize my recommendations.
- As a returning user, I want to log in and pick up where I left off.

## Acceptance Criteria
- User can sign up with email and password
- User must complete all required health profile fields before reaching the home screen
- User can skip optional fields and complete them later
- Login persists across sessions (remember me is default on)

## Success Metrics
- 80% of new users complete onboarding within 5 minutes of install
- < 15% drop-off at the health profile step

## Out of Scope
- Social login (Google, Apple) — deferred to v2
- Onboarding tutorial / product tour

## Open Questions
- [type: engineering] [blocking: no] Should we support biometric login (Face ID / fingerprint) at launch?
- [type: product] [blocking: yes] What is the minimum required set of health profile fields?
DRAFT_SPEC_END

Draft saved to GitHub. Review it and say *approved* when you're ready to lock this and hand off to design.
