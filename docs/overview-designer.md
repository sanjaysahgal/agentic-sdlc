# agentic-sdlc — UX Designer Guide

## Your role in the system

You come in after the product spec is approved and before engineering begins. Your job is to translate what the product manager has defined into screens, flows, and component specifications that engineers can build from without guessing.

No engineering work begins until the design spec is approved.

## When you're needed

The system will notify you (via Slack) when a product spec is ready for design. You can also check anytime by going to `#all-health360` and saying "I'm a designer — what's ready for me?" The system reads the current state of all features and tells you exactly what's waiting.

## How the design conversation works

Go to the feature's Slack channel (e.g. `#feature-onboarding`). Tell the AI design specialist you're picking up the design phase. It will:

1. Give you a summary of the product spec — what the feature does, who it's for, the key user stories
2. Ask you questions to shape the design: what screens are needed, what the flow looks like, what components are reused vs new
3. Help you think through edge cases: empty states, error states, loading states, mobile vs desktop
4. Surface the open questions from the product spec that need design decisions
5. Auto-save your work after every exchange

You don't need to come in with finished designs. You can think out loud, iterate, and come back across multiple sessions.

## What you produce

A design spec (`<feature>.design.md`) that covers:

- **Screen inventory** — every screen the feature requires, with a plain description of what's on it
- **User flows** — step-by-step paths for each user story from the product spec
- **Component list** — which UI components are needed (new vs existing)
- **Interaction decisions** — key behaviors, animations, transitions that matter
- **Open questions for engineering** — anything that has a design decision but needs engineering input on feasibility

You don't produce the actual design files here (Figma, etc.) — those are linked from the design spec. The spec is the written, version-controlled record of what was decided and why.

## How to hand off to engineering

When you're satisfied with the design spec, say "approved" or "this is ready for engineering." The system will save the final spec and notify the architect that engineering planning can begin.

## What the system protects

The system will not let engineering start before your work is done and approved. This means engineers always have complete screens and flows to build against — they are not making design decisions while coding.

If an engineer encounters something ambiguous that needs a design call, it will come back to you as a specific question, not as an assumption baked into the code.
