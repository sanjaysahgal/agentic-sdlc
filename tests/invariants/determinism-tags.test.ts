// Block B4 — determinism-tag structural gate.
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`
// (Block B4) and CLAUDE.md Principle 11 ("All audits must be deterministic
// — same input, same output, always"). The Principle states that every
// audit gating a decision must produce identical results on identical
// input; the historical violation (April 2026 `auditPhaseCompletion`)
// shipped because nothing structurally prevented an LLM call inside a
// function annotated for deterministic use.
//
// This test is the structural enforcement: any source file containing
// `@deterministic` JSDoc cannot import the Anthropic SDK (or any other
// LLM client) at the file level. The convention is: a module is either
// `@deterministic` OR `@enrichment` — never both. `@enrichment` modules
// (LLM-assisted) may import LLM clients freely; they cannot be the
// primary gate for a decision (separate gate enforced via code review +
// CLAUDE.md Principle 11).
//
// Expansion path: future passes can add randomness checks (`Math.random`,
// `crypto.randomUUID` without seed, `Date.now()` in audit-relevant paths).
// The current gate covers the highest-impact case — LLM imports — which
// retired the bug that motivated the principle.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { resolve, join } from "node:path"

// ── File walker ───────────────────────────────────────────────────────────────

const RUNTIME_ROOT = resolve(__dirname, "..", "..", "runtime")

// Forbidden imports for `@deterministic` modules. Any import path matching
// these patterns is a Principle 11 violation: a deterministic function
// must not depend on a probabilistic source.
const FORBIDDEN_IMPORTS = [
  "@anthropic-ai/sdk",  // Anthropic LLM
  // Future expansion: "openai", "@google/genai", "ollama", any other
  // LLM client. The list is curated — additions are intentional.
]

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full))
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(full)
    }
  }
  return out
}

type FileAnalysis = {
  readonly path:                 string
  readonly hasDeterministicTag:  boolean
  readonly hasEnrichmentTag:     boolean
  readonly forbiddenImportLines: ReadonlyArray<{ line: number; importPath: string }>
}

function analyzeFile(path: string): FileAnalysis {
  const text  = readFileSync(path, "utf-8")
  const lines = text.split("\n")

  // Tag detection — JSDoc tag form only, not prose mentions.
  // Matches:
  //   ` * @deterministic` / ` * @deterministic — explanation`
  //   `/** @deterministic */` / `/** @deterministic — comment */`
  // Does NOT match:
  //   ` * The rubric layer remains as @enrichment` (mid-prose mention)
  // This is the structural convention: a tag declares behavior at a JSDoc
  // marker; mentions in prose narrate the convention for other files.
  const detTagRe = /^\s*(?:\*|\/\*\*)\s*@deterministic\b/m
  const enrTagRe = /^\s*(?:\*|\/\*\*)\s*@enrichment\b/m
  const hasDeterministicTag = detTagRe.test(text)
  const hasEnrichmentTag    = enrTagRe.test(text)

  const forbiddenImportLines: Array<{ line: number; importPath: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Match top-level `import ... from "<path>"` and `import "<path>"` shapes
    const m = line.match(/^\s*import\s+(?:[^'"]*\s+from\s+)?["']([^"']+)["']/)
    if (m) {
      const importPath = m[1]
      if (FORBIDDEN_IMPORTS.some((forbidden) => importPath === forbidden || importPath.startsWith(`${forbidden}/`))) {
        forbiddenImportLines.push({ line: i + 1, importPath })
      }
    }
  }

  return { path, hasDeterministicTag, hasEnrichmentTag, forbiddenImportLines }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Block B4 — determinism-tag structural gate (Principle 11)", () => {
  const allFiles = listTsFiles(RUNTIME_ROOT)
  const analyses = allFiles.map(analyzeFile)

  it("AST walker discovers TypeScript files in runtime/", () => {
    expect(allFiles.length).toBeGreaterThan(10)
  })

  describe("module-level invariant — @deterministic and @enrichment are mutually exclusive", () => {
    it("no file is tagged BOTH @deterministic AND @enrichment (a module is one or the other)", () => {
      const conflicts = analyses.filter((a) => a.hasDeterministicTag && a.hasEnrichmentTag)
      const summary = conflicts.map((a) => a.path.replace(RUNTIME_ROOT, "runtime"))
      expect(summary).toEqual([])
    })
  })

  describe("@deterministic modules cannot import LLM clients (Principle 11)", () => {
    const deterministicFiles = analyses.filter((a) => a.hasDeterministicTag)

    it("at least one @deterministic module exists in runtime/ (sanity)", () => {
      expect(deterministicFiles.length).toBeGreaterThanOrEqual(1)
    })

    it("zero @deterministic modules import @anthropic-ai/sdk or any forbidden LLM client", () => {
      const violations = deterministicFiles.flatMap((a) =>
        a.forbiddenImportLines.map((v) => ({
          file: a.path.replace(RUNTIME_ROOT, "runtime"),
          line: v.line,
          importPath: v.importPath,
        }))
      )
      // Expected: empty list. Failure prints exact file:line:import_path so
      // the operator can move the LLM call to an @enrichment module.
      expect(violations).toEqual([])
    })

    // Per-file detail tests — one per `@deterministic` module — give clear
    // failure attribution when something regresses.
    for (const a of deterministicFiles) {
      const rel = a.path.replace(RUNTIME_ROOT, "runtime")
      it(`${rel}: no forbidden imports`, () => {
        expect(a.forbiddenImportLines).toEqual([])
      })
    }
  })

  describe("plan-level gate summary", () => {
    it("emits a roll-up of @deterministic vs @enrichment files for operator visibility", () => {
      const det  = analyses.filter((a) => a.hasDeterministicTag).length
      const enr  = analyses.filter((a) => a.hasEnrichmentTag).length
      const both = analyses.filter((a) => a.hasDeterministicTag && a.hasEnrichmentTag).length
      // eslint-disable-next-line no-console
      console.log(`[B4-GATE] runtime/: deterministic=${det} enrichment=${enr} conflict=${both} totalFiles=${analyses.length}`)
      expect(both).toBe(0)
    })
  })
})
