// generate-preview.ts — renders a design spec to an interactive HTML preview.
// Usage: npx tsx scripts/generate-preview.ts [featureName] [outputPath]
// Example: npx tsx scripts/generate-preview.ts onboarding /tmp/preview.html
//
// The renderer (generateDesignPreview) is the agent. This script is just the
// entry point that feeds it the spec + brand content and writes the output.
// Never hand-write HTML previews — always use this script.

import { config } from "dotenv"
config({ path: "/Users/ssahgal/Developer/agentic-sdlc/.env" })

import { writeFileSync } from "fs"
import { readFile } from "../runtime/github-client"
import { generateDesignPreview } from "../runtime/html-renderer"
import { loadWorkspaceConfig } from "../runtime/workspace-config"

async function main() {
  const config = loadWorkspaceConfig()
  const featureName = process.argv[2] ?? "onboarding"
  const outputPath = process.argv[3] ?? `/tmp/${featureName}-onboarding-preview.html`

  console.log(`Rendering preview for: ${featureName}`)

  // Read design spec — try committed spec first, then draft branch
  const specBranch = `spec/${featureName}-design`
  const specPath = `${config.paths.featuresRoot}/${featureName}/${featureName}.design.md`

  let specContent = await readFile(specPath)
  if (!specContent) {
    specContent = await readFile(specPath, specBranch)
  }
  if (!specContent) {
    throw new Error(`Design spec not found at ${specPath} (tried main and ${specBranch})`)
  }
  console.log(`Spec loaded: ${specContent.length} chars`)

  // Read BRAND.md — authoritative brand tokens
  const brandContent = await readFile(config.paths.brand)
  if (brandContent) {
    console.log(`BRAND.md loaded: ${brandContent.length} chars`)
  } else {
    console.warn("BRAND.md not found — rendering without brand tokens")
  }

  // Generate the preview via the renderer agent
  const { html, warnings } = await generateDesignPreview({
    specContent,
    featureName,
    brandContent: brandContent ?? undefined,
  })

  if (warnings.length > 0) {
    console.warn("\nRenderer warnings:")
    warnings.forEach(w => console.warn(`  ⚠  ${w}`))
  }

  // Write output via fs (not the Write tool — this is the correct pattern)
  writeFileSync(outputPath, html, "utf-8")
  console.log(`\nPreview written to: ${outputPath}`)
  console.log(`Open in browser: file://${outputPath}`)
}

main().catch(err => {
  console.error("Preview generation failed:", err.message)
  process.exit(1)
})
