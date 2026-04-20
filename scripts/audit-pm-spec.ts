/**
 * Runs PM_RUBRIC, PM_DESIGN_READINESS_RUBRIC, and auditDownstreamReadiness
 * against a real PM spec on GitHub. Captures output for fixture creation.
 *
 * Usage: npx tsx scripts/audit-pm-spec.ts --feature onboarding
 */
import "dotenv/config"
import { readFile } from "../runtime/github-client"
import { loadWorkspaceConfig } from "../runtime/workspace-config"
import { auditPhaseCompletion, auditDownstreamReadiness, PM_RUBRIC, PM_DESIGN_READINESS_RUBRIC } from "../runtime/phase-completion-auditor"
import { writeFileSync, mkdirSync } from "fs"
import { join } from "path"

async function main() {
  const args = process.argv.slice(2)
  const featureIdx = args.indexOf("--feature")
  const featureName = featureIdx !== -1 ? args[featureIdx + 1] : null

  if (!featureName) {
    console.error("Usage: npx tsx scripts/audit-pm-spec.ts --feature <name>")
    process.exit(1)
  }

  const config = loadWorkspaceConfig()
  const { paths } = config

  // Read the approved PM spec from main
  const pmSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.product.md`
  const spec = await readFile(pmSpecPath, "main")
  if (!spec) { console.log("NOT FOUND:", pmSpecPath, "on main"); return }
  console.log(`PM spec: ${spec.length} chars\n`)

  const productVision = await readFile(paths.productVision) || undefined
  const systemArch = await readFile(paths.systemArchitecture) || undefined

  // ── Run PM_RUBRIC ──────────────────────────────────────────────────────────
  console.log("=== PM_RUBRIC (6 criteria) ===")
  const pmResult = await auditPhaseCompletion({
    specContent: spec,
    rubric: PM_RUBRIC,
    featureName,
    productVision,
    systemArchitecture: systemArch,
  })
  console.log(`Ready: ${pmResult.ready}`)
  console.log(`Findings: ${pmResult.findings.length}`)
  pmResult.findings.forEach((f, i) => console.log(`  ${i + 1}. ${f.issue}\n     Fix: ${f.recommendation}`))

  // ── Run PM_DESIGN_READINESS_RUBRIC ─────────────────────────────────────────
  console.log("\n=== PM_DESIGN_READINESS_RUBRIC (5 criteria) ===")
  const drResult = await auditPhaseCompletion({
    specContent: spec,
    rubric: PM_DESIGN_READINESS_RUBRIC,
    featureName,
    productVision,
    systemArchitecture: systemArch,
  })
  console.log(`Ready: ${drResult.ready}`)
  console.log(`Findings: ${drResult.findings.length}`)
  drResult.findings.forEach((f, i) => console.log(`  ${i + 1}. ${f.issue}\n     Fix: ${f.recommendation}`))

  // ── Run auditDownstreamReadiness (adversarial designer) ────────────────────
  console.log("\n=== ADVERSARIAL DOWNSTREAM READINESS (designer persona) ===")
  const advResult = await auditDownstreamReadiness({
    specContent: spec,
    downstreamRole: "designer",
    featureName,
  })
  console.log(`Findings: ${advResult.findings.length}`)
  advResult.findings.forEach((f, i) => console.log(`  ${i + 1}. ${f.issue}\n     Fix: ${f.recommendation}`))

  // ── Save fixtures ──────────────────────────────────────────────────────────
  const fixtureDir = join(__dirname, "..", "tests", "fixtures", "agent-output")
  mkdirSync(fixtureDir, { recursive: true })

  const fixture = {
    featureName,
    specLength: spec.length,
    timestamp: new Date().toISOString(),
    pmRubric: { ready: pmResult.ready, findingCount: pmResult.findings.length, findings: pmResult.findings },
    designReadinessRubric: { ready: drResult.ready, findingCount: drResult.findings.length, findings: drResult.findings },
    adversarialDesigner: { findingCount: advResult.findings.length, findings: advResult.findings },
  }

  const fixturePath = join(fixtureDir, `pm-rubric-${featureName}.json`)
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2))
  console.log(`\nFixture saved: ${fixturePath}`)

  // ── Summary ────────────────────────────────────────────────────────────────
  const totalFindings = pmResult.findings.length + drResult.findings.length + advResult.findings.length
  console.log(`\n=== SUMMARY ===`)
  console.log(`PM_RUBRIC: ${pmResult.findings.length} findings`)
  console.log(`PM_DESIGN_READINESS_RUBRIC: ${drResult.findings.length} findings`)
  console.log(`Adversarial designer: ${advResult.findings.length} findings`)
  console.log(`Total: ${totalFindings} findings`)

  if (totalFindings === 0) {
    console.log("\n⚠ All three audits returned PASS — no findings at all.")
    console.log("If the spec has known gaps, this is a false-negative that needs rubric sharpening.")
  }
}

main().catch(console.error)
