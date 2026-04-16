import { config } from "dotenv"
config({ path: "/Users/ssahgal/Developer/agentic-sdlc/.env" })

import { readFile } from "../runtime/github-client"
import { auditSpecRenderAmbiguity } from "../runtime/spec-auditor"
import { auditPhaseCompletion, buildDesignRubric } from "../runtime/phase-completion-auditor"
import { auditBrandTokens, auditAnimationTokens, auditMissingBrandTokens } from "../runtime/brand-auditor"

async function main() {
  const spec = await readFile("specs/features/onboarding/onboarding.design.md", "spec/onboarding-design")
  if (!spec) { console.log("NOT FOUND"); return }
  console.log("Spec length:", spec.length, "chars\n")

  const brandMd = await readFile("specs/brand/BRAND.md")

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
    console.log("No BRAND.md found")
  }

  console.log("\n=== QUALITY (auditSpecRenderAmbiguity) ===")
  const quality = await auditSpecRenderAmbiguity(spec, { formFactors: ["mobile", "desktop"] }).catch(e => {
    console.log("ERROR:", e.message); return [] as string[]
  })
  console.log("Quality findings:", quality.length)
  quality.forEach((q, i) => console.log(`  ${i+1}. ${q}`))

  console.log("\n=== READINESS (auditPhaseCompletion) ===")
  const productSpec = await readFile("specs/product/PRODUCT_VISION.md")
  const sysArch = await readFile("specs/architecture/system-architecture.md")
  const readiness = await auditPhaseCompletion({
    specContent: spec,
    rubric: buildDesignRubric(["mobile", "desktop"]),
    featureName: "onboarding",
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
