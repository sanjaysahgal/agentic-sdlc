#!/usr/bin/env tsx
// Eval runner CLI — runs golden scenarios against the live Claude API.
//
// Usage:
//   npm run eval                    # run all agents
//   npm run eval -- --agent pm      # run one agent
//   npm run eval -- --verbose       # print full responses
//
// Each run prints a pass rate per agent and an overall score.
// Costs real API credits — not run in CI.

import "dotenv/config"
import { runSuite, EvalResult } from "../tests/evals/runner"
import { pmScenarios } from "../tests/evals/scenarios/pm"
import { designScenarios } from "../tests/evals/scenarios/design"
import { architectScenarios } from "../tests/evals/scenarios/architect"
import { conciergeScenarios } from "../tests/evals/scenarios/concierge"

const RESET  = "\x1b[0m"
const GREEN  = "\x1b[32m"
const RED    = "\x1b[31m"
const YELLOW = "\x1b[33m"
const BOLD   = "\x1b[1m"
const DIM    = "\x1b[2m"

const tick = `${GREEN}✓${RESET}`
const cross = `${RED}✗${RESET}`

const args = process.argv.slice(2)
const agentFilter = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : null
const verbose = args.includes("--verbose")

const allSuites: Array<{ label: string; key: string; scenarios: ReturnType<typeof pmScenarios.map> }> = [
  { label: "PM agent",   key: "pm",        scenarios: pmScenarios },
  { label: "Design",     key: "design",    scenarios: designScenarios.filter(s => s.userMessage !== "__SKIP_AGENT_CALL__") },
  { label: "Architect",  key: "architect", scenarios: architectScenarios },
  { label: "Concierge",  key: "concierge", scenarios: conciergeScenarios },
]

const suites = agentFilter
  ? allSuites.filter(s => s.key === agentFilter)
  : allSuites

if (suites.length === 0) {
  console.error(`Unknown agent: ${agentFilter}. Options: pm, design, architect, concierge`)
  process.exit(1)
}

function printResult(result: EvalResult): void {
  const icon = result.passed ? tick : cross
  const pct = `${Math.round(result.score * 100)}%`
  const dur = `${DIM}(${result.durationMs}ms)${RESET}`
  console.log(`  ${icon} ${result.scenario} ${DIM}${pct}${RESET} ${dur}`)

  if (!result.passed || verbose) {
    for (const cr of result.criteriaResults) {
      const ci = cr.passed ? tick : cross
      console.log(`      ${ci} ${DIM}${cr.criterion}${RESET}`)
    }
  }

  if (verbose) {
    console.log(`\n${DIM}Response:${RESET}`)
    console.log(result.response.split("\n").map(l => `      ${l}`).join("\n"))
    console.log()
  }
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}agentic-sdlc evals${RESET}  ${DIM}${new Date().toISOString()}${RESET}\n`)

  const allResults: EvalResult[] = []

  for (const suite of suites) {
    console.log(`${BOLD}${suite.label}${RESET}`)
    const results = await runSuite(suite.scenarios as any)
    for (const r of results) printResult(r)

    const passed = results.filter(r => r.passed).length
    const pct = Math.round((passed / results.length) * 100)
    const color = pct >= 80 ? GREEN : pct >= 60 ? YELLOW : RED
    console.log(`  ${DIM}──${RESET} ${color}${passed}/${results.length} passed (${pct}%)${RESET}\n`)
    allResults.push(...results)
  }

  const totalPassed = allResults.filter(r => r.passed).length
  const totalPct = Math.round((totalPassed / allResults.length) * 100)
  const totalColor = totalPct >= 80 ? GREEN : totalPct >= 60 ? YELLOW : RED
  console.log(`${BOLD}Overall: ${totalColor}${totalPassed}/${allResults.length} passed (${totalPct}%)${RESET}\n`)

  // Exit non-zero if below threshold — blocks push.
  // Threshold starts at 50% (current baseline) and rises as agent prompts improve.
  const EVAL_PASS_THRESHOLD = 50
  if (totalPct < EVAL_PASS_THRESHOLD) {
    console.log(`${RED}EVAL GATE FAILED: ${totalPct}% < ${EVAL_PASS_THRESHOLD}% threshold${RESET}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error("Eval runner failed:", err)
  process.exit(1)
})
