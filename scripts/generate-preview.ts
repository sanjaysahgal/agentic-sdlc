// generate-preview.ts — renders a design spec to an interactive HTML preview.
// Usage: npx tsx scripts/generate-preview.ts [featureName] [outputPath] [--local-only]
// Example: npx tsx scripts/generate-preview.ts onboarding /tmp/preview.html
//   --local-only  write HTML to disk only; skip pushing to the GitHub design branch.
//
// By default, the generated HTML is pushed to GitHub to update the design agent's
// cache in Slack. Pass --local-only for disk-only output (dev/inspection use only).
//
// The renderer (renderFromSpec) is deterministic — no LLM call. This script
// feeds it the spec + brand content from the repo and writes the output.
// Never hand-write HTML previews — always use this script.

import { config } from "dotenv"
config()

import { writeFileSync } from "fs"
import { readFile, saveDraftHtmlPreview } from "../runtime/github-client"
import { renderFromSpec } from "../runtime/html-renderer"
import { loadWorkspaceConfig } from "../runtime/workspace-config"

async function main() {
  const cfg = loadWorkspaceConfig()
  const args = process.argv.slice(2)
  const localOnly = args.includes("--local-only")
  const positional = args.filter(a => !a.startsWith("--"))
  const featureName = positional[0] ?? "onboarding"
  const outputPath = positional[1] ?? `/tmp/${featureName}-preview.html`

  console.log(`Rendering preview for: ${featureName}`)

  // Read design spec — try committed spec first, then draft branch
  const specBranch = `spec/${featureName}-design`
  const specPath = `${cfg.paths.featuresRoot}/${featureName}/${featureName}.design.md`

  let specContent = await readFile(specPath)
  if (!specContent) {
    specContent = await readFile(specPath, specBranch)
  }
  if (!specContent) {
    throw new Error(`Design spec not found at ${specPath} (tried main and ${specBranch})`)
  }
  console.log(`Spec loaded: ${specContent.length} chars`)

  // Read BRAND.md — authoritative brand tokens
  const brandContent = await readFile(cfg.paths.brand)
  if (brandContent) {
    console.log(`BRAND.md loaded: ${brandContent.length} chars`)
  } else {
    console.warn("BRAND.md not found — rendering without brand tokens")
  }

  // Render the preview — deterministic template, no LLM call
  const html = renderFromSpec(specContent, brandContent ?? "", featureName)
  console.log("Preview rendered from template.")

  // Write output via fs (not the Write tool — this is the correct pattern)
  writeFileSync(outputPath, html, "utf-8")
  console.log(`\nPreview written to: ${outputPath}`)
  console.log(`Open in browser: file://${outputPath}`)

  // Push to GitHub to update the design agent's cache in Slack.
  // The design agent serves the cached preview from the design branch directly.
  // Skip only when --local-only is passed (dev/inspection use).
  if (!localOnly) {
    console.log("\nPushing to GitHub design branch...")
    const htmlFilePath = `${cfg.paths.featuresRoot}/${featureName}/${featureName}.preview.html`
    await saveDraftHtmlPreview({ featureName, filePath: htmlFilePath, content: html })
    console.log(`Pushed: ${htmlFilePath} → spec/${featureName}-design branch`)
    console.log("Design agent will serve this preview on next request.")
  } else {
    console.log("\n--local-only: skipping GitHub push.")
  }
}

main().catch(err => {
  console.error("Preview generation failed:", err.message)
  process.exit(1)
})
