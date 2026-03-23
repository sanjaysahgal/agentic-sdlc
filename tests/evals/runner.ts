// Eval runner — runs golden scenarios against the live Claude API and judges
// each criterion using Haiku as an objective evaluator.
//
// NOT part of the unit test suite. Run with: npm run eval
// Costs real API credits — designed to be opt-in, not run in CI.

import Anthropic from "@anthropic-ai/sdk"
import { runAgent } from "../../runtime/claude-client"

const judge = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type EvalScenario = {
  name: string
  agentLabel: string
  systemPrompt: string                                          // Built by the agent's buildXxxSystemPrompt
  userMessage: string
  history?: Array<{ role: "user" | "assistant"; content: string }>
  criteria: string[]                                           // Plain-English assertions judged by Haiku
}

export type CriterionResult = {
  criterion: string
  passed: boolean
}

export type EvalResult = {
  scenario: string
  agentLabel: string
  passed: boolean          // true only if every criterion passes
  score: number            // fraction of criteria that passed, e.g. 0.75
  criteriaResults: CriterionResult[]
  response: string
  durationMs: number
}

// Uses Haiku to evaluate a single criterion against a response.
// Returns true if the criterion is satisfied, false otherwise.
async function judgesCriterion(response: string, criterion: string): Promise<boolean> {
  const result = await judge.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    system: "You are an objective evaluator. Given an AI agent's response and an evaluation criterion, answer only YES or NO. Be strict — partial satisfaction is a NO.",
    messages: [{
      role: "user",
      content: `Agent response:\n${response}\n\nCriterion: ${criterion}\n\nDoes the response satisfy this criterion?`,
    }],
  })
  const text = result.content[0].type === "text" ? result.content[0].text.trim().toUpperCase() : "NO"
  return text.startsWith("YES")
}

// Runs one scenario: calls the real agent, then judges every criterion.
export async function runScenario(scenario: EvalScenario): Promise<EvalResult> {
  const start = Date.now()

  const response = await runAgent({
    systemPrompt: scenario.systemPrompt,
    history: scenario.history ?? [],
    userMessage: scenario.userMessage,
  })

  // Judge all criteria in parallel — each is an independent Haiku call
  const criteriaResults = await Promise.all(
    scenario.criteria.map(async (criterion) => ({
      criterion,
      passed: await judgesCriterion(response, criterion),
    }))
  )

  const passedCount = criteriaResults.filter((r) => r.passed).length

  return {
    scenario: scenario.name,
    agentLabel: scenario.agentLabel,
    passed: passedCount === criteriaResults.length,
    score: criteriaResults.length > 0 ? passedCount / criteriaResults.length : 1,
    criteriaResults,
    response,
    durationMs: Date.now() - start,
  }
}

// Runs a suite of scenarios sequentially (to avoid API rate limits).
// Returns all results for the caller to aggregate and display.
export async function runSuite(scenarios: EvalScenario[]): Promise<EvalResult[]> {
  const results: EvalResult[] = []
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario))
  }
  return results
}
