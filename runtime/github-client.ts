import { Octokit } from "@octokit/rest"

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
const owner = process.env.GITHUB_OWNER!
const repo = process.env.GITHUB_REPO!

// Read a file from the repo. Returns empty string if not found.
export async function readFile(path: string): Promise<string> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path })
    const data = response.data as { content: string }
    return Buffer.from(data.content, "base64").toString("utf-8")
  } catch {
    return ""
  }
}

// Save a draft spec to the feature branch without opening a PR.
// Creates the branch if it doesn't exist. Updates the file if it does.
export async function saveDraftSpec(params: {
  featureName: string
  filePath: string
  content: string
}): Promise<void> {
  const { featureName, filePath, content } = params
  const branch = `spec/${featureName}-product`

  // Get main branch SHA
  const mainRef = await octokit.git.getRef({ owner, repo, ref: "heads/main" })
  const mainSha = mainRef.data.object.sha

  // Create branch if it doesn't exist
  try {
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: mainSha })
  } catch {
    // Branch already exists — that's fine, we'll just update the file
  }

  // Check if file already exists on the branch (needed for SHA to update)
  let fileSha: string | undefined
  try {
    const existing = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branch })
    fileSha = (existing.data as { sha: string }).sha
  } catch {
    // File doesn't exist yet — create it
  }

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `[DRAFT] ${featureName} · product.md`,
    content: Buffer.from(content).toString("base64"),
    branch,
    sha: fileSha,
  })
}

// Commit a new file and open a PR against main.
// Returns the PR URL.
export async function createSpecPR(params: {
  featureName: string
  filePath: string
  content: string
  prTitle: string
  prBody: string
}): Promise<string> {
  const { featureName, filePath, content, prTitle, prBody } = params
  const branch = `spec/${featureName}-product`

  // Get main branch SHA
  const mainRef = await octokit.git.getRef({ owner, repo, ref: "heads/main" })
  const mainSha = mainRef.data.object.sha

  // Create branch
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: mainSha,
  })

  // Commit file
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `[SPEC] ${featureName} · product.md`,
    content: Buffer.from(content).toString("base64"),
    branch,
  })

  // Open PR
  const pr = await octokit.pulls.create({
    owner,
    repo,
    title: prTitle,
    body: prBody,
    head: branch,
    base: "main",
  })

  return pr.data.html_url
}
