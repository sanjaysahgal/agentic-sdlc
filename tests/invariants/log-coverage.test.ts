import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Block G1 of the approved system-wide plan
 * (~/.claude/plans/rate-this-plan-zesty-tiger.md). Log-coverage gate:
 * every state-mutation function in `runtime/conversation-store.ts` must
 * emit a structured `console.log(\`[CATEGORY] ...\`)` line within its
 * body. Without this, the platform's behavior cannot be reconstructed
 * from logs alone — operators end up debugging from Slack pastes (the
 * failure mode the user-memory `feedback_read_logs_first.md` calls out).
 *
 * Detection: AST-walks the conversation-store source, finds every exported
 * function with a name starting with `set`, `clear`, `add`, `remove`, or
 * other mutation verbs, then asserts each function body contains a
 * bracketed `console.log` line.
 *
 * Allowlist: pure helpers that don't mutate persistent state are exempt
 * via `LOG_COVERAGE_EXEMPT` set below — kept tight so adding to it is
 * a deliberate decision.
 */

const REPO_ROOT = resolve(__dirname, "..", "..")
const STORE_PATH = resolve(REPO_ROOT, "runtime/conversation-store.ts")

// Functions that don't need a log line — pure helpers, getters, type
// converters, IO wrappers that delegate to logged functions.
const LOG_COVERAGE_EXEMPT = new Set<string>([
  "clearLegacyMessages",  // legacy compat shim, no longer mutates persistent state
  "disableFilePersistence",  // test helper
])

const MUTATION_PREFIXES = ["set", "clear", "add", "remove", "delete", "append", "patch"]

interface ExportedFunction {
  name: string
  body: string
}

function extractExportedMutationFunctions(source: string): ExportedFunction[] {
  const fns: ExportedFunction[] = []
  // Match `export function NAME(...): TYPE { ... }` — body uses brace counting.
  const headerRe = /^export function ([a-zA-Z][a-zA-Z0-9]*)\s*\([^)]*\)\s*:\s*[^{]+\{/gm
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(source)) !== null) {
    const name = m[1]
    if (!MUTATION_PREFIXES.some((p) => name.startsWith(p))) continue

    // Brace-count from the opening { to find the matching close.
    const start = m.index + m[0].length - 1  // index of opening {
    let depth = 1
    let i = start + 1
    while (i < source.length && depth > 0) {
      const ch = source[i]
      if (ch === "{") depth++
      else if (ch === "}") depth--
      i++
    }
    const body = source.slice(start + 1, i - 1)
    fns.push({ name, body })
  }
  return fns
}

describe("log coverage — every state mutation has a structured log line (Block G1)", () => {
  const source = readFileSync(STORE_PATH, "utf8")
  const fns = extractExportedMutationFunctions(source)

  it("scanner found at least 10 exported mutation functions (sanity)", () => {
    expect(fns.length).toBeGreaterThanOrEqual(10)
  })

  it.each(fns)("function $name has a structured `[CATEGORY]` log line", ({ name, body }) => {
    if (LOG_COVERAGE_EXEMPT.has(name)) return
    const hasLog = /console\.log\([\s\n]*[`"']\s*\\?\[[A-Z]/.test(body)
    if (!hasLog) {
      throw new Error(
        `Function ${name} mutates state but has no \`console.log(\`[CATEGORY] ...\`)\` line. ` +
        `Either add one (recommended pattern: \`[STORE] ${name}: <key+args>\`) ` +
        `or add the function name to LOG_COVERAGE_EXEMPT in this test with a justification.`,
      )
    }
  })
})
