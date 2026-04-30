import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { resolve, relative } from "node:path"

/**
 * Block L3 of the approved system-wide plan
 * (~/.claude/plans/rate-this-plan-zesty-tiger.md). Defense-in-depth for
 * accidental secret commits. Two layers:
 *
 *   1. Pre-commit hook in .claude/settings.json — catches secrets in
 *      staged diffs at commit time. Fast, blocks before history
 *      contamination.
 *
 *   2. This invariant test — scans the entire repository on every CI run.
 *      Catches secrets that snuck in via paths the pre-commit hook
 *      missed (auto-commit Stop event, --no-verify bypass, foreign tools).
 *      Also asserts the pre-commit hook is wired in settings.json.
 *
 * Patterns target high-confidence vendor prefixes — false positives are
 * suppressed via:
 *   - Path allowlist (tests, fixtures, this scanner, .git, node_modules)
 *   - Inline `// SECRET-FALSE-POSITIVE: <reason>` marker on the same line
 */

const REPO_ROOT = resolve(__dirname, "..", "..")

interface SecretPattern {
  name:    string
  re:      RegExp
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "Slack bot token (xoxb-)",   re: /\bxoxb-\d{10,}-\d{10,}-[a-zA-Z0-9]{20,}/g  },
  { name: "Slack app token (xoxa-)",   re: /\bxoxa-\d{10,}-\d{10,}-[a-zA-Z0-9]{20,}/g  },
  { name: "Slack user token (xoxp-)",  re: /\bxoxp-\d{10,}-\d{10,}-\d{10,}-[a-zA-Z0-9]{20,}/g },
  { name: "Anthropic API key",         re: /\bsk-ant-[a-zA-Z0-9_-]{32,}/g              },
  { name: "OpenAI API key",            re: /\bsk-proj-[a-zA-Z0-9_-]{32,}/g             },
  { name: "GitHub PAT",                re: /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/g },
  { name: "AWS access key",            re: /\bAKIA[0-9A-Z]{16}\b/g                     },
  { name: "Private key block",         re: /-----BEGIN ((RSA|DSA|EC|OPENSSH|PGP) )?PRIVATE KEY-----/g },
]

// Files & folders that legitimately contain look-alike secret strings.
// All paths are relative to REPO_ROOT.
const PATH_ALLOWLIST_PREFIXES = [
  "node_modules/",
  ".git/",
  "tests/fixtures/",
  "coverage/",
  "reports/",
  "stryker-tmp/",
  ".stryker-tmp/",
  // Scanner files reference the patterns themselves.
  "tests/invariants/secrets-hygiene.test.ts",
  ".claude/settings.json",
  ".claude/settings.local.json",
]

// File extensions worth scanning. Binary types are skipped to avoid noise.
const SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".env.example", ".yml", ".yaml", ".sh"]

function shouldScan(relPath: string): boolean {
  if (PATH_ALLOWLIST_PREFIXES.some((p) => relPath.startsWith(p))) return false
  // Skip test files — they may legitimately contain stub keys for mocking.
  if (relPath.endsWith(".test.ts")) return false
  if (relPath.includes("/__snapshots__/")) return false
  return SCAN_EXTENSIONS.some((ext) => relPath.endsWith(ext))
}

function listFilesRecursive(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      const rel = relative(REPO_ROOT, full)
      if (PATH_ALLOWLIST_PREFIXES.some((p) => rel.startsWith(p.replace(/\/$/, "")))) continue
      listFilesRecursive(full, acc)
    } else if (st.isFile()) {
      const rel = relative(REPO_ROOT, full)
      if (shouldScan(rel)) acc.push(rel)
    }
  }
  return acc
}

interface SecretFinding {
  file:    string
  line:    number
  pattern: string
  excerpt: string
}

function scanFileForSecrets(relPath: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  const content = readFileSync(resolve(REPO_ROOT, relPath), "utf8")
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes("SECRET-FALSE-POSITIVE:")) continue
    for (const { name, re } of SECRET_PATTERNS) {
      re.lastIndex = 0
      const m = re.exec(line)
      if (m) {
        findings.push({
          file:    relPath,
          line:    i + 1,
          pattern: name,
          excerpt: line.trim().slice(0, 120),
        })
      }
    }
  }
  return findings
}

describe("secrets hygiene (Block L3)", () => {
  it("no secret patterns in committed source files", () => {
    const files = listFilesRecursive(REPO_ROOT)
    const allFindings: SecretFinding[] = []
    for (const f of files) {
      allFindings.push(...scanFileForSecrets(f))
    }
    if (allFindings.length > 0) {
      const lines = allFindings.map((f) => `  - ${f.file}:${f.line} [${f.pattern}] ${f.excerpt}`).join("\n")
      throw new Error(
        `Found ${allFindings.length} potential secret(s) in committed source:\n${lines}\n\n` +
        `Required action: rotate the leaked credential immediately, then either delete the value from code or add // SECRET-FALSE-POSITIVE: <reason> on the same line if it is a documented example.`,
      )
    }
  })

  it("pre-commit secret-scanner hook is wired in .claude/settings.json", () => {
    const settings = readFileSync(resolve(REPO_ROOT, ".claude/settings.json"), "utf8")
    expect(settings).toContain("[SECRETS HYGIENE GATE")
  })
})
