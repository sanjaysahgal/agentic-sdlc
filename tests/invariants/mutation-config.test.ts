import { describe, expect, it } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Block I1 of the approved system-wide plan
 * (~/.claude/plans/rate-this-plan-zesty-tiger.md). Mutation testing via
 * Stryker is wired in at `stryker.config.json` and runnable via
 * `npm run mutation`. The job is too slow for per-PR CI gating but is
 * run periodically (manual cadence: weekly + on changes to mutated
 * modules + on Claude SDK / dep upgrades).
 *
 * This invariant test pins the structural shape of the Stryker config
 * so silent regressions of the mutation surface (removing modules from
 * `mutate`, lowering thresholds, switching test runners) are caught at
 * PR time. Stryker itself enforces the score break threshold; this
 * test enforces the *configuration* contract.
 */

const REPO_ROOT = resolve(__dirname, "..", "..")
const CONFIG_PATH = resolve(REPO_ROOT, "stryker.config.json")
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json")

interface StrykerConfig {
  packageManager?: string
  testRunner?:    string
  mutate?:        string[]
  thresholds?:    {
    high?:  number
    low?:   number
    break?: number
  }
}

const REQUIRED_MUTATE_SET = new Set<string>([
  // The same pure modules covered by Block I4's property-based tests.
  // When adding a new mutated module, add it here AND to stryker.config.json
  // in the same commit.
  "runtime/upstream-notice-format.ts",
  "runtime/deterministic-auditor.ts",
])

const FLOOR_BREAK_THRESHOLD = 55  // today's baseline; raising it is welcome, lowering it requires a documented backlog item

describe("Stryker config invariant (Block I1)", () => {
  it("stryker.config.json exists at repo root", () => {
    expect(existsSync(CONFIG_PATH)).toBe(true)
  })

  const config: StrykerConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))

  it("uses vitest as the test runner", () => {
    expect(config.testRunner).toBe("vitest")
  })

  it("mutates every module in the required set", () => {
    const actual = new Set(config.mutate ?? [])
    const missing = [...REQUIRED_MUTATE_SET].filter((m) => !actual.has(m))
    if (missing.length > 0) {
      throw new Error(
        `stryker.config.json is missing required mutated modules: ${missing.join(", ")}. ` +
        `If a module is intentionally being removed from mutation coverage, also remove it ` +
        `from REQUIRED_MUTATE_SET in this test (with a backlog entry explaining why).`,
      )
    }
  })

  it(`break threshold >= ${FLOOR_BREAK_THRESHOLD}`, () => {
    expect(config.thresholds?.break).toBeDefined()
    expect(config.thresholds!.break!).toBeGreaterThanOrEqual(FLOOR_BREAK_THRESHOLD)
  })

  it("npm script `mutation` is wired to `stryker run`", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"))
    expect(pkg.scripts?.mutation).toBe("stryker run")
  })
})
