import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Block I3 of the approved system-wide plan
 * (~/.claude/plans/rate-this-plan-zesty-tiger.md). Structural invariant
 * enforcing the contract documented in
 * `tests/regression/REGRESSION_CATALOG.md`: every historical bug listed
 * in the catalog must have a matching `describe("bug #N — …")` block in
 * the named test file, and every such describe block in
 * `tests/regression/` must appear in the catalog.
 *
 * This is the structural enforcement of CLAUDE.md's "every behavior with
 * no test does not count as done" rule, applied to historical bugs:
 * once a bug is in the catalog, removing or renaming its test fails at
 * PR time. Adding a new bug requires both a catalog row AND a describe
 * block in the same commit.
 */

const REPO_ROOT = resolve(__dirname, "..", "..")
const CATALOG_PATH = resolve(REPO_ROOT, "tests", "regression", "REGRESSION_CATALOG.md")
const REGRESSION_DIR = resolve(REPO_ROOT, "tests", "regression")

interface CatalogRow {
  id: string          // e.g. "1"
  description: string // one-line
  file: string        // relative to repo root, e.g. "tests/regression/history-integrity.test.ts"
}

function parseCatalog(source: string): CatalogRow[] {
  // Match: | #N | description | path/to/file.test.ts |
  const rows: CatalogRow[] = []
  const lineRe = /^\|\s*#(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(source)) !== null) {
    rows.push({
      id:          m[1],
      description: m[2].trim(),
      file:        m[3].trim(),
    })
  }
  return rows
}

function listRegressionTestFiles(): string[] {
  return readdirSync(REGRESSION_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => resolve(REGRESSION_DIR, f))
}

interface DescribeMatch {
  id:   string
  file: string
}

function extractBugDescribes(filePath: string): DescribeMatch[] {
  const source = readFileSync(filePath, "utf8")
  // Match: describe("bug #N — …", …)  with either single or double quotes.
  // Also accept a unicode em-dash (—) or a plain hyphen (-) as the separator.
  const matches: DescribeMatch[] = []
  const re = /describe\s*\(\s*["']bug\s+#(\d+)\s*[—-]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    matches.push({ id: m[1], file: filePath })
  }
  return matches
}

describe("regression catalog (Block I3)", () => {
  const catalog = parseCatalog(readFileSync(CATALOG_PATH, "utf8"))
  const allDescribes = listRegressionTestFiles().flatMap(extractBugDescribes)

  it("catalog parses non-empty (sanity)", () => {
    expect(catalog.length).toBeGreaterThan(0)
  })

  it("catalog has no duplicate bug IDs", () => {
    const ids = catalog.map((r) => r.id)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dupes).toEqual([])
  })

  it.each(catalog)("bug #$id is implemented in $file", ({ id, file }) => {
    const fullPath = resolve(REPO_ROOT, file)
    let source: string
    try {
      source = readFileSync(fullPath, "utf8")
    } catch {
      throw new Error(`Catalog says bug #${id} lives in ${file}, but that file does not exist.`)
    }
    const describePattern = new RegExp(`describe\\s*\\(\\s*["']bug\\s+#${id}\\s*[—-]`)
    if (!describePattern.test(source)) {
      throw new Error(
        `Catalog says bug #${id} lives in ${file}, but no \`describe("bug #${id} — …")\` block was found in that file. ` +
        `Either fix the catalog row or add the missing describe block.`,
      )
    }
  })

  it("every describe(\"bug #N — …\") in tests/regression/ is in the catalog", () => {
    const catalogIds = new Set(catalog.map((r) => r.id))
    const orphans = allDescribes.filter((d) => !catalogIds.has(d.id))
    if (orphans.length > 0) {
      const lines = orphans.map((o) => `  - bug #${o.id} in ${o.file.replace(REPO_ROOT + "/", "")}`).join("\n")
      throw new Error(
        `Found describe(\"bug #N — …\") blocks not listed in REGRESSION_CATALOG.md:\n${lines}\n` +
        `Add a row for each in tests/regression/REGRESSION_CATALOG.md.`,
      )
    }
  })

  it("every describe(\"bug #N — …\") block lives in the file the catalog claims", () => {
    // Cross-check: the file column in the catalog must match the file the describe block actually lives in.
    const byId = new Map(catalog.map((r) => [r.id, resolve(REPO_ROOT, r.file)]))
    const mismatches: string[] = []
    for (const d of allDescribes) {
      const expected = byId.get(d.id)
      if (expected && expected !== d.file) {
        mismatches.push(`  - bug #${d.id}: catalog says ${expected.replace(REPO_ROOT + "/", "")}, found in ${d.file.replace(REPO_ROOT + "/", "")}`)
      }
    }
    if (mismatches.length > 0) {
      throw new Error(`Bug describe block lives in a different file than the catalog claims:\n${mismatches.join("\n")}`)
    }
  })
})
