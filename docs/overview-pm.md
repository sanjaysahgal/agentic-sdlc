# agentic-sdlc — Product Manager Guide

## Your role in the system

You are the starting point. No feature moves forward without a product manager first shaping and approving the product spec. Everything — design, engineering, testing — is downstream of what you produce.

## How to start a new feature

1. Go to the main Slack workspace channel (e.g. `#all-health360`) and ask "how do I start a new feature?" The system will walk you through it.
2. Create a new Slack channel named `#feature-<name>` — for example `#feature-onboarding` or `#feature-dashboard`.
3. The AI product specialist will greet you in the channel automatically.
4. Start describing the feature. You don't need to have a full brief ready — start with what you know. The specialist will ask questions.

## What the conversation looks like

The AI product specialist's job is to help you think through the feature completely before anyone builds anything. It will:

- Ask you to clarify who the feature is for and what problem it solves
- Push back if something seems to conflict with the product's overall direction
- Surface edge cases you may not have considered ("what happens if the user closes the tab mid-flow?")
- Tell you what open questions remain before the spec is complete

You don't need to answer everything in one session. Come back the next day — the specialist picks up exactly where you left off. Your work is saved automatically after every conversation.

## What "approving" the spec means

When you're satisfied that the spec is complete, say something like "looks good, let's move forward" or "approved, this is the final spec." The system will:

1. Save the final version of the spec
2. Put it in review (a team member can review it in GitHub if needed)
3. Notify the design team that it's ready for them

**You don't need to know what GitHub is to do this.** Just say you're done in Slack.

## What a good product spec covers

The specialist will guide you through all of this, but a complete spec answers:

- **What problem does this solve?** And for whom?
- **Who are the target users?** Which types of users does this affect?
- **What are the user stories?** What does each type of user want to do, and why?
- **What are the acceptance criteria?** How do we know when this is done and working correctly?
- **What are the edge cases?** What can go wrong, and how should the system handle it?
- **What does this NOT do?** Explicit non-goals prevent scope creep
- **What's still unknown?** Open questions for engineering or design to answer

## Open questions — design vs engineering

Some questions need a designer to answer (what does the screen look like, what does the interaction feel like). Some need an engineer (is this technically feasible, how long will it take). When the specialist surfaces open questions, it will tell you which kind each one is — so you know who to follow up with.

## After you approve

Your work is done on this feature until you're needed for a decision. The design team picks it up next. You'll be notified when:
- Design is complete and ready for review
- Engineering has a question that needs a product decision
- The feature is shipped and ready to test

## How to check on a feature

Go to `#all-health360` and ask "where is the onboarding feature?" (or whatever the feature name is). The system will tell you exactly what phase it's in and what's happening.
