import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Block I2 of the approved system-wide plan
 * (~/.claude/plans/rate-this-plan-zesty-tiger.md). Coverage thresholds in
 * vitest.config.ts are enforced at PR time by `.github/workflows/test.yml`
 * (`npm run test:coverage`). This invariant test pins the threshold floor so
 * nobody can quietly lower the numbers to make a regression pass — the CI
 * gate would still go green if someone dropped `lines` from 90 to 50, since
 * vitest just compares against whatever the config says. This test prevents
 * that drift class by asserting the configured thresholds remain at or above
 * the documented baseline.
 *
 * Bumping a threshold UP is fine and welcome — update the FLOOR constants
 * here in the same commit. Lowering a threshold requires a deliberate,
 * documented change (and a backlog item explaining why).
 */

const FLOOR_LINES = 90
const FLOOR_FUNCTIONS = 83
const FLOOR_BRANCHES = 80

const VITEST_CONFIG_PATH = resolve(__dirname, "..", "..", "vitest.config.ts")

interface ParsedThresholds {
  lines: number | null
  functions: number | null
  branches: number | null
}

function parseThresholdsFromConfig(source: string): ParsedThresholds {
  const thresholdsBlockMatch = source.match(
    /thresholds\s*:\s*\{([\s\S]*?)\}/,
  )
  if (!thresholdsBlockMatch) {
    return { lines: null, functions: null, branches: null }
  }
  const block = thresholdsBlockMatch[1]
  const pick = (key: string): number | null => {
    const m = block.match(new RegExp(`${key}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`))
    return m ? Number(m[1]) : null
  }
  return {
    lines: pick("lines"),
    functions: pick("functions"),
    branches: pick("branches"),
  }
}

describe("coverage threshold floor (Block I2)", () => {
  const source = readFileSync(VITEST_CONFIG_PATH, "utf8")
  const parsed = parseThresholdsFromConfig(source)

  it("vitest.config.ts declares all three coverage thresholds", () => {
    expect(parsed.lines).not.toBeNull()
    expect(parsed.functions).not.toBeNull()
    expect(parsed.branches).not.toBeNull()
  })

  it(`lines threshold >= ${FLOOR_LINES}`, () => {
    expect(parsed.lines).not.toBeNull()
    expect(parsed.lines!).toBeGreaterThanOrEqual(FLOOR_LINES)
  })

  it(`functions threshold >= ${FLOOR_FUNCTIONS}`, () => {
    expect(parsed.functions).not.toBeNull()
    expect(parsed.functions!).toBeGreaterThanOrEqual(FLOOR_FUNCTIONS)
  })

  it(`branches threshold >= ${FLOOR_BRANCHES}`, () => {
    expect(parsed.branches).not.toBeNull()
    expect(parsed.branches!).toBeGreaterThanOrEqual(FLOOR_BRANCHES)
  })

  it("CI workflow runs coverage (not just `npm test`) so thresholds are enforced at PR time", () => {
    const workflow = readFileSync(
      resolve(__dirname, "..", "..", ".github", "workflows", "test.yml"),
      "utf8",
    )
    expect(workflow).toMatch(/npm run test:coverage/)
  })
})
