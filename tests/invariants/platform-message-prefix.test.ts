// CLAUDE.md Principle 8 (platform enforcement first) + Principle 15 (cross-agent
// parity) + manifest B10 (regression catalog bug #17).
//
// Every platform-composed Slack notification (any `client.chat.postMessage` call
// in interfaces/slack/handlers/*) must use a neutral platform prefix — never an
// agent-name static prefix. Agent-name static prefixes (e.g. `*Product Manager*
// — …`) impersonate the agent: the reader can't tell whether the platform or the
// agent is speaking, especially when the body refers to that same agent in third
// person ("the PM agent", "bring the PM back").
//
// The legitimate exception is `${mention}` — a Slack `<@U…>` ping (or text
// fallback when no role-holder is assigned) that ADDRESSES the human role-
// holder. That's pinging a person, not impersonating an agent. Only STATIC
// agent-name prefixes are forbidden.
//
// This invariant scans all handler files for the violation pattern. Adding a
// new platform notification requires using `PLATFORM_MESSAGE_PREFIX` from
// `runtime/platform-message-prefix.ts` (or `${mention}` when addressing the
// human role-holder).

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { resolve, join } from "node:path"
import {
  PLATFORM_MESSAGE_PREFIX,
  PLATFORM_PREFIX_MARKER,
  FORBIDDEN_AGENT_PREFIXES,
} from "../../runtime/platform-message-prefix"

const HANDLERS_ROOT = resolve(__dirname, "..", "..", "interfaces", "slack", "handlers")

function listHandlerFiles(dir: string = HANDLERS_ROOT): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...listHandlerFiles(p))
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(p)
  }
  return out
}

describe("PLATFORM_MESSAGE_PREFIX — module-level sanity", () => {
  it("the constant is non-empty and contains the marker substring", () => {
    expect(PLATFORM_MESSAGE_PREFIX.length).toBeGreaterThan(0)
    expect(PLATFORM_MESSAGE_PREFIX).toContain(PLATFORM_PREFIX_MARKER)
  })

  it("FORBIDDEN_AGENT_PREFIXES enumerates the canonical violation strings", () => {
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*Product Manager*")
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*UX Designer*")
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*Architect*")
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*PM*")
    expect(FORBIDDEN_AGENT_PREFIXES).toContain("*Designer*")
  })
})

describe("platform messages do not impersonate agents (B10 / Principle 8)", () => {
  const handlers = listHandlerFiles()

  it("at least one handler file is scanned (sanity guard)", () => {
    expect(handlers.length).toBeGreaterThan(0)
    expect(handlers.some((p) => p.endsWith("message.ts"))).toBe(true)
  })

  it.each(handlers.map((path) => [path.replace(HANDLERS_ROOT + "/", ""), path]))(
    "%s: no postMessage uses an agent-name static prefix in `text:` (use PLATFORM_MESSAGE_PREFIX or ${mention} instead)",
    (_label: string, path: string) => {
      const source = readFileSync(path, "utf-8")
      const violations: Array<{ line: number; snippet: string; prefix: string }> = []
      const lines = source.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const prefix of FORBIDDEN_AGENT_PREFIXES) {
          // Match the literal pattern that introduces a postMessage text body
          // with a static agent-name prefix. Specifically looks for `text: \`<prefix>`
          // (template literal opening). This excludes:
          //   - `${mention}` interpolations (Slack ping or text-fallback role label)
          //   - Comments / docstrings (would not start with `text:`)
          //   - String concatenation that doesn't begin with the prefix
          //
          // The detection is intentionally tight to avoid false positives on
          // legitimate uses (e.g. an agent name appearing inside the body).
          const literalEsc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          const re = new RegExp(`text:\\s*\`${literalEsc}\\s*[—-]`)
          if (re.test(line)) {
            violations.push({ line: i + 1, snippet: line.trim().slice(0, 200), prefix })
          }
        }
      }
      if (violations.length > 0) {
        const lines = violations.map((v) => `  - line ${v.line}: ${v.prefix} prefix → ${v.snippet}`).join("\n")
        throw new Error(
          `[B10 / Principle 8] Found ${violations.length} platform postMessage(s) using an agent-name static prefix in ${path.replace(HANDLERS_ROOT + "/", "")}:\n${lines}\n` +
          `Replace with \`\${PLATFORM_MESSAGE_PREFIX}\` (from runtime/platform-message-prefix.ts) and rewrite the body in platform voice. ` +
          `If this is legitimately addressing the human role-holder, use \`\${mention}\` (the Slack <@U…> ping or text-fallback role label).`,
        )
      }
    },
  )

  it("message.ts uses PLATFORM_MESSAGE_PREFIX on every notification site that previously used an agent-name prefix (post-B10 floor)", () => {
    // Pin a floor count so a regression that drops the platform prefix from any
    // site fails loudly. As of B10 there are 6 platform-prefixed notification
    // sites in message.ts; future additions should raise this floor in the same
    // commit.
    const messageTs = resolve(HANDLERS_ROOT, "message.ts")
    const source = readFileSync(messageTs, "utf-8")
    const usages = (source.match(/\$\{PLATFORM_MESSAGE_PREFIX\}/g) ?? []).length
    expect(usages).toBeGreaterThanOrEqual(6)
  })

  it("message.ts imports PLATFORM_MESSAGE_PREFIX from the canonical module", () => {
    const messageTs = resolve(HANDLERS_ROOT, "message.ts")
    const source = readFileSync(messageTs, "utf-8")
    expect(source).toMatch(
      /import\s+\{\s*PLATFORM_MESSAGE_PREFIX\s*\}\s+from\s+["']\.\.\/\.\.\/\.\.\/runtime\/platform-message-prefix["']/,
    )
  })
})
