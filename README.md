# agentic-sdlc

SDLC agent infrastructure for the agentic portfolio.

## What this is
The agent runtime and delivery interfaces for the development workflow. Not to be confused with the product runtime agents (Orchestrator, Analytics, etc.) which live in each product repo.

## Structure
```
agents/          ← SDLC agent definitions (pm, architect, backend, frontend, qa)
runtime/         ← context loader, Claude API wrapper
tools/           ← shared tools (GitHub read/write, PR creation)
interfaces/
  slack/         ← Slack bot (primary human interface)
  github/        ← GitHub Actions triggers (future)
  web/           ← Web portal (future)
```

## Portfolio
- `agentic-health360` — the app
- `agentic-brand` — design tokens
- `agentic-cicd` — deployment pipeline
- `agentic-sdlc` — this repo (SDLC workflow agents)

## Running locally
```bash
cp .env.example .env
# fill in all values
npm install
npm run dev
```

## Environment variables
See `.env.example` for all required variables.
