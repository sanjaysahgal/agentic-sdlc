import "dotenv/config"
import { readFile } from "../runtime/github-client"
import { loadWorkspaceConfig } from "../runtime/workspace-config"
import { auditSpecRenderAmbiguity } from "../runtime/spec-auditor"
import { auditPhaseCompletion, buildDesignRubric } from "../runtime/phase-completion-auditor"
import { auditBrandTokens, auditAnimationTokens, auditMissingBrandTokens } from "../runtime/brand-auditor"

async function main() {
  const args = process.argv.slice(2)
  const featureIdx = args.indexOf("--feature")
  const featureName = featureIdx !== -1 ? args[featureIdx + 1] : null

  if (!featureName) {
    console.error("Usage: audit-real-spec.ts --feature <name>")
    console.error("  --feature  required: feature name (e.g. onboarding)")
    process.exit(1)
  }

  const config = loadWorkspaceConfig()
  const { paths } = config

  const designSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`
  const designBranch = `spec/${featureName}-design`

  const spec = await readFile(designSpecPath, designBranch)
  if (!spec) { console.log("NOT FOUND:", designSpecPath, "on", designBranch); return }
  console.log("Spec length:", spec.length, "chars\n")

  const brandMd = await readFile(paths.brand)

  console.log("=== BRAND DRIFT ===")
  if (brandMd) {
    const brandDrifts = auditBrandTokens(spec, brandMd)
    const animDrifts = auditAnimationTokens(spec, brandMd)
    const missingTokens = auditMissingBrandTokens(spec, brandMd)
    console.log("Brand drifts:", brandDrifts.length)
    brandDrifts.forEach((d, i) => console.log(`  ${i+1}. ${d.token}: spec="${d.specValue}" brand="${d.brandValue}"`))
    console.log("Animation drifts:", animDrifts.length)
    animDrifts.forEach((d, i) => console.log(`  ${i+1}. ${d.param}`))
    console.log("Missing tokens:", missingTokens.length)
    missingTokens.forEach((m, i) => console.log(`  ${i+1}. ${m.token}`))
  } else {
    console.log("No brand file found at:", paths.brand)
  }

  console.log("\n=== QUALITY (auditSpecRenderAmbiguity) ===")
  const quality = await auditSpecRenderAmbiguity(spec, { formFactors: ["mobile", "desktop"] }).catch(e => {
    console.log("ERROR:", e.message); return [] as string[]
  })
  console.log("Quality findings:", quality.length)
  quality.forEach((q, i) => console.log(`  ${i+1}. ${q}`))

  console.log("\n=== READINESS (auditPhaseCompletion) ===")
  const productSpec = await readFile(paths.productVision)
  const sysArch = await readFile(paths.systemArchitecture)
  const readiness = await auditPhaseCompletion({
    specContent: spec,
    rubric: buildDesignRubric(["mobile", "desktop"]),
    featureName,
    productVision: productSpec || undefined,
    systemArchitecture: sysArch || undefined,
  }).catch(e => { console.log("ERROR:", e.message); return null })

  if (readiness) {
    console.log("Ready:", readiness.ready)
    console.log("Findings:", readiness.findings.length)
    readiness.findings.forEach((f, i) => console.log(`  ${i+1}. [${f.criterion}] ${f.issue}\n     Fix: ${f.recommendation}`))
  }
}
main().catch(console.error)
