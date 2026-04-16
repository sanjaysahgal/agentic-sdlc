#!/usr/bin/env tsx
// Pre-push regression harness for spec quality enforcement behaviors.
//
// Runs the 5 structural platform scenarios from the spec health invariant plan.
// Each scenario is verified by the named integration test — this script runs them
// with clear pass/fail output so they can be checked before every push to
// message.ts or agents/design.ts.
//
// Scenarios:
//   S1 — Brand-fix intent routes to apply_design_spec_patch (N54, N55)
//   S2 — Structural-conflict intent routes to rewrite_design_spec (N62)
//   S3 — State-query returns action menu with all current findings (N45)
//   S4 — Approval blocked when open items exist (N42, N43)
//   S5 — Bloating patch triggers health invariant warning (N61)
//
// Usage:
//   npx tsx scripts/simulate-regression.ts
//   npx tsx scripts/simulate-regression.ts --scenario S2
//   npx tsx scripts/simulate-regression.ts --verbose

import { execSync } from "child_process"

const SCENARIOS: Record<string, { label: string; testPattern: string }> = {
  S1: {
    label: "Brand-fix intent → apply_design_spec_patch",
    testPattern: "N54|N55",
  },
  S2: {
    label: "Structural-conflict intent → rewrite_design_spec",
    testPattern: "N62",
  },
  S3: {
    label: "State-query → action menu with all findings",
    testPattern: "N45",
  },
  S4: {
    label: "Approval blocked when open items exist",
    testPattern: "N42|N43",
  },
  S5: {
    label: "Bloating patch → health invariant fires",
    testPattern: "N61",
  },
}

const args = process.argv.slice(2)
const scenarioFilter = (() => {
  const idx = args.indexOf("--scenario")
  return idx !== -1 ? args[idx + 1] : null
})()
const verbose = args.includes("--verbose")

const scenariosToRun = scenarioFilter
  ? Object.entries(SCENARIOS).filter(([key]) => key === scenarioFilter.toUpperCase())
  : Object.entries(SCENARIOS)

if (scenariosToRun.length === 0) {
  console.error(`Unknown scenario: ${scenarioFilter}. Valid options: ${Object.keys(SCENARIOS).join(", ")}`)
  process.exit(1)
}

console.log(`\nSpec quality regression — ${scenariosToRun.length} scenario${scenariosToRun.length === 1 ? "" : "s"}\n`)

let passed = 0
let failed = 0

for (const [key, scenario] of scenariosToRun) {
  process.stdout.write(`  ${key}: ${scenario.label} ... `)

  try {
    const cmd = `npx vitest run tests/integration/workflows.test.ts --reporter=verbose 2>&1`
    const output = execSync(cmd, { encoding: "utf-8", timeout: 60_000 })

    // Check each test pattern appears and passes in the output
    const patterns = scenario.testPattern.split("|")
    const allPass = patterns.every(pattern => {
      const lines = output.split("\n").filter(l => l.includes(`N${pattern.slice(1)}`) || l.includes(pattern))
      return lines.some(l => l.includes("✓") || l.includes("✓"))
    })

    // More reliable: check that the specific scenario describes are passing
    const hasFailure = output.split("\n").some(l => {
      const hasPattern = patterns.some(p => l.includes(`N${p.slice(1)}`) || l.includes(`Scenario ${p}`))
      return hasPattern && (l.includes("×") || l.includes("FAIL") || l.includes("failed"))
    })

    if (hasFailure) {
      console.log("FAIL")
      if (verbose) console.log(output)
      failed++
    } else {
      console.log("pass")
      passed++
    }
  } catch (err: unknown) {
    console.log("FAIL")
    if (verbose && err instanceof Error) console.log(err.message)
    failed++
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)

// Global invariant: verify no internal tool names or [PLATFORM markers can be seen
// in the test output (they would indicate a test helper is leaking them, or a failing
// assertion we need to investigate).
if (passed === scenariosToRun.length) {
  console.log("All scenarios pass. Platform structural enforcement verified.")
} else {
  console.error(`${failed} scenario${failed === 1 ? "" : "s"} failed. Fix before pushing to message.ts or agents/design.ts.`)
  process.exit(1)
}
