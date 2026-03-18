/**
 * Context Loader
 *
 * Reads relevant files from the target repo and bundles them
 * into the Claude API call as context. This is what makes the
 * pm agent aware of Health360 specifically — without it,
 * Claude has no knowledge of the product vision or conventions.
 */

import { Octokit } from "@octokit/rest"

export interface RepoConfig {
  owner: string
  repo: string
  branch?: string
}

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

async function readFile(config: RepoConfig, path: string): Promise<string> {
  try {
    const response = await octokit.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path,
      ref: config.branch ?? "main",
    })
    const data = response.data as { content: string }
    return Buffer.from(data.content, "base64").toString("utf-8")
  } catch {
    return `[File not found: ${path}]`
  }
}

export async function loadPMContext(config: RepoConfig): Promise<string> {
  const [productVision, featureClaude] = await Promise.all([
    readFile(config, "specs/product/PRODUCT_VISION.md"),
    readFile(config, "specs/features/CLAUDE.md"),
  ])

  return `
## PRODUCT VISION (authoritative — do not contradict)
${productVision}

## FEATURE SPEC CONVENTIONS (follow exactly when creating specs)
${featureClaude}
`.trim()
}
