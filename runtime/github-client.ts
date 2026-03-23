import { Octokit } from "@octokit/rest"
import { loadWorkspaceConfig } from "./workspace-config"

// 15s timeout on all GitHub API calls — context loads run in parallel before every agent
// response. An unbounded hang blocks the entire request and leaves the user at "thinking".
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, request: { timeout: 15_000 } })
const { githubOwner: owner, githubRepo: repo } = loadWorkspaceConfig()

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

// Internal: saves a file to a branch, creating the branch from main if needed.
async function saveDraftFile(params: {
  branch: string
  filePath: string
  content: string
  commitMessage: string
}): Promise<void> {
  const { branch, filePath, content, commitMessage } = params

  const mainRef = await octokit.git.getRef({ owner, repo, ref: "heads/main" })
  const mainSha = mainRef.data.object.sha

  try {
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: mainSha })
  } catch {
    // Branch already exists
  }

  let fileSha: string | undefined
  try {
    const existing = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branch })
    fileSha = (existing.data as { sha: string }).sha
  } catch {
    // File doesn't exist yet
  }

  await octokit.repos.createOrUpdateFileContents({
    owner, repo, path: filePath, message: commitMessage,
    content: Buffer.from(content).toString("base64"),
    branch, sha: fileSha,
  })
}

// Save a draft product spec to the feature branch without opening a PR.
export async function saveDraftSpec(params: {
  featureName: string
  filePath: string
  content: string
}): Promise<void> {
  const { featureName, filePath, content } = params
  await saveDraftFile({
    branch: `spec/${featureName}-product`,
    filePath,
    content,
    commitMessage: `[DRAFT] ${featureName} · product.md`,
  })
}

// Save a draft design spec to the feature branch without opening a PR.
export async function saveDraftDesignSpec(params: {
  featureName: string
  filePath: string
  content: string
}): Promise<void> {
  const { featureName, filePath, content } = params
  await saveDraftFile({
    branch: `spec/${featureName}-design`,
    filePath,
    content,
    commitMessage: `[DRAFT] ${featureName} · design.md`,
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
    const { paths } = loadWorkspaceConfig()
    const productSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.product.md`
    const designSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`

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

// Opens a GitHub issue tagged agent-feedback to track feedback about AI agent behavior.
export async function saveAgentFeedback(params: {
  feedback: string
  submittedBy?: string
}): Promise<void> {
  const { feedback, submittedBy } = params
  const body = submittedBy
    ? `**Submitted by:** ${submittedBy}\n\n${feedback}`
    : feedback

  try {
    // Ensure the label exists (idempotent)
    try {
      await octokit.issues.createLabel({ owner, repo, name: "agent-feedback", color: "e4e669" })
    } catch {
      // Label already exists
    }

    await octokit.issues.create({
      owner,
      repo,
      title: `Agent feedback: ${feedback.slice(0, 72).replace(/\n.*/s, "")}`,
      body,
      labels: ["agent-feedback"],
    })
  } catch {
    // Non-fatal — feedback logging should never break the conversation
  }
}

// Saves the final approved design spec. Updates in place if already on main.
export async function saveApprovedDesignSpec(params: {
  featureName: string
  filePath: string
  content: string
}): Promise<"already-on-main" | "saved"> {
  const { featureName, filePath, content } = params

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
      message: `[SPEC] ${featureName} · design.md — final approved`,
      content: Buffer.from(content).toString("base64"),
      sha: mainFileSha,
    })
    return "already-on-main"
  }

  await saveDraftDesignSpec({ featureName, filePath, content })
  return "saved"
}

// Lists the immediate subdirectory names under a path on main.
// Returns empty array if the path doesn't exist or isn't a directory.
export async function listSubdirectories(path: string): Promise<string[]> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path })
    const data = response.data
    if (!Array.isArray(data)) return []
    return data.filter((entry) => entry.type === "dir").map((entry) => entry.name)
  } catch {
    return []
  }
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
