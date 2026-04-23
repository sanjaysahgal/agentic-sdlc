// Eval runner — runs golden scenarios against the live Claude API and judges
// each criterion using Haiku as an objective evaluator.
//
// NOT part of the unit test suite. Run with: npm run eval
// Costs real API credits — designed to be opt-in, not run in CI.

import Anthropic from "@anthropic-ai/sdk"
import { runAgent } from "../../runtime/claude-client"

const judge = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * @deterministic criteria: checked by string matching, no LLM needed.
 * Same input = same result. Principle 11 applies to evals too.
 */
export type DeterministicCriterion = {
  /** What the criterion checks (human-readable label). */
  label: string
  /** Strings that MUST appear in the response (case-insensitive). */
  mustContain?: string[]
  /** Strings that must NOT appear in the response (case-insensitive). */
  mustNotContain?: string[]
  /** Custom predicate for complex checks. */
  check?: (response: string) => boolean
}

export type EvalScenario = {
  name: string
  agentLabel: string
  systemPrompt: string                                          // Built by the agent's buildXxxSystemPrompt
  userMessage: string
  history?: Array<{ role: "user" | "assistant"; content: string }>
  criteria: string[]                                           // Plain-English assertions judged by Haiku
  /** @deterministic — checked without LLM. Same input = same result. */
  deterministicCriteria?: DeterministicCriterion[]
  /** Tools available to the agent (for tool-use scenarios). */
  tools?: Anthropic.Tool[]
  /** Tool handler (for tool-use scenarios). */
  toolHandler?: (name: string, input: Record<string, unknown>) => Promise<{ result?: unknown; error?: string }>
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

/** @deterministic — evaluates a deterministic criterion against a response. No LLM. */
function evaluateDeterministicCriterion(response: string, criterion: DeterministicCriterion): CriterionResult {
  const lower = response.toLowerCase()
  if (criterion.mustContain) {
    for (const phrase of criterion.mustContain) {
      if (!lower.includes(phrase.toLowerCase())) {
        return { criterion: `[DETERMINISTIC] ${criterion.label}: missing "${phrase}"`, passed: false }
      }
    }
  }
  if (criterion.mustNotContain) {
    for (const phrase of criterion.mustNotContain) {
      if (lower.includes(phrase.toLowerCase())) {
        return { criterion: `[DETERMINISTIC] ${criterion.label}: found prohibited "${phrase}"`, passed: false }
      }
    }
  }
  if (criterion.check && !criterion.check(response)) {
    return { criterion: `[DETERMINISTIC] ${criterion.label}: custom check failed`, passed: false }
  }
  return { criterion: `[DETERMINISTIC] ${criterion.label}`, passed: true }
}

// Runs one scenario: calls the real agent, then judges every criterion.
// Retries once on API timeout errors (transient network issues).
export async function runScenario(scenario: EvalScenario): Promise<EvalResult> {
  const start = Date.now()

  let response: string
  try {
    response = await runAgent({
      systemPrompt: scenario.systemPrompt,
      history: scenario.history ?? [],
      userMessage: scenario.userMessage,
      tools: scenario.tools,
      toolHandler: scenario.toolHandler,
    })
  } catch (err: unknown) {
    // Retry once on timeout
    const isTimeout = err instanceof Error && (err.message.includes("timed out") || err.constructor.name.includes("Timeout"))
    if (isTimeout) {
      console.log(`[EVAL] ${scenario.name}: API timeout — retrying once`)
      response = await runAgent({
        systemPrompt: scenario.systemPrompt,
        history: scenario.history ?? [],
        userMessage: scenario.userMessage,
        tools: scenario.tools,
        toolHandler: scenario.toolHandler,
      })
    } else {
      throw err
    }
  }

  // Deterministic criteria first — instant, no API cost, same result every time
  const deterministicResults = (scenario.deterministicCriteria ?? []).map(dc =>
    evaluateDeterministicCriterion(response, dc)
  )

  // Haiku-judged criteria in parallel — each is an independent Haiku call
  const haikuResults = await Promise.all(
    scenario.criteria.map(async (criterion) => ({
      criterion,
      passed: await judgesCriterion(response, criterion),
    }))
  )

  const criteriaResults = [...deterministicResults, ...haikuResults]
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
// A single scenario failure does not abort the suite.
export async function runSuite(scenarios: EvalScenario[]): Promise<EvalResult[]> {
  const results: EvalResult[] = []
  for (const scenario of scenarios) {
    try {
      results.push(await runScenario(scenario))
    } catch (err: unknown) {
      console.error(`[EVAL] ${scenario.name}: CRASHED — ${err instanceof Error ? err.message : String(err)}`)
      results.push({
        scenario: scenario.name,
        agentLabel: scenario.agentLabel,
        passed: false,
        score: 0,
        criteriaResults: [{ criterion: `CRASHED: ${err instanceof Error ? err.message : "unknown"}`, passed: false }],
        response: "",
        durationMs: 0,
      })
    }
  }
  return results
}
