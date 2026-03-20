import { Octokit } from "@octokit/rest"

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
const owner = process.env.GITHUB_OWNER!
const repo = process.env.GITHUB_REPO!

// Read a file from the repo. Returns empty string if not found.
export async function readFile(path: string, ref?: string): Promise<string> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}) })
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

// Returns the current status of all features in flight.
// Determines phase by checking which spec files exist on main vs only on branches.
export type FeatureStatus = {
  featureName: string
  phase: "product-spec-in-progress" | "product-spec-approved-awaiting-design" | "design-in-progress" | "design-approved-awaiting-engineering"
}

export async function getInProgressFeatures(): Promise<FeatureStatus[]> {
  const features: FeatureStatus[] = []

  // List all branches matching spec/*
  const branches = await octokit.paginate(octokit.repos.listBranches, { owner, repo, per_page: 100 })
  const specBranches = branches.filter((b) => b.name.startsWith("spec/") && b.name.endsWith("-product"))

  for (const branch of specBranches) {
    const featureName = branch.name.replace("spec/", "").replace("-product", "")
    const productSpecPath = `specs/features/${featureName}/${featureName}.product.md`
    const designSpecPath = `specs/features/${featureName}/${featureName}.design.md`

    const productOnMain = await readFile(productSpecPath) // empty string = not on main
    const designOnMain = await readFile(designSpecPath)

    if (designOnMain) {
      features.push({ featureName, phase: "design-approved-awaiting-engineering" })
    } else if (productOnMain) {
      features.push({ featureName, phase: "product-spec-approved-awaiting-design" })
    } else {
      features.push({ featureName, phase: "product-spec-in-progress" })
    }
  }

  return features
}

// Saves the final approved spec to the feature branch.
// If the file is already on main (previously merged), updates it in place on main.
// Returns "already-on-main" | "saved"
export async function saveApprovedSpec(params: {
  featureName: string
  filePath: string
  content: string
}): Promise<"already-on-main" | "saved"> {
  const { featureName, filePath, content } = params
  const branch = `spec/${featureName}-product`

  // Check if already on main — if so, update in place
  let mainFileSha: string | undefined
  try {
    const existing = await octokit.repos.getContent({ owner, repo, path: filePath })
    mainFileSha = (existing.data as { sha: string }).sha
  } catch {
    // Not on main yet
  }

  if (mainFileSha) {
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: filePath,
      message: `[SPEC] ${featureName} · product.md — final approved`,
      content: Buffer.from(content).toString("base64"),
      sha: mainFileSha,
    })
    return "already-on-main"
  }

  // Save to branch (same as draft flow) — human merges to make it official
  await saveDraftSpec({ featureName, filePath, content })
  return "saved"
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
