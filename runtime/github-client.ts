import { Octokit } from "@octokit/rest"
import { loadWorkspaceConfig } from "./workspace-config"

// 15s timeout on all GitHub API calls — context loads run in parallel before every agent
// response. An unbounded hang blocks the entire request and leaves the user at "thinking".
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, request: { timeout: 15_000 } })
const { githubOwner: owner, githubRepo: repo } = loadWorkspaceConfig()

// Separate client for platform-level writes (eval feedback, reaction logs).
// These belong in the agentic-sdlc repo, not the customer's repo.
const platformOwner = process.env.PLATFORM_GITHUB_OWNER ?? owner
const platformRepo  = process.env.PLATFORM_GITHUB_REPO  ?? repo

// Dry-run mode: set SIMULATE_DRY_RUN=true to log writes without executing them.
// Used by scripts/simulate-agent.ts — never set in production.
const isDryRun = () => process.env.SIMULATE_DRY_RUN === "true"

// Read a file from the repo. Returns empty string if not found.
export async function readFile(path: string, ref?: string): Promise<string> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}) })
    const data = response.data as { content: string }
    const content = Buffer.from(data.content, "base64").toString("utf-8")
    console.log(`[GITHUB] readFile: ${path}${ref ? ` (ref=${ref})` : ""} → hit (${content.length} chars)`)
    return content
  } catch {
    console.log(`[GITHUB] readFile: ${path}${ref ? ` (ref=${ref})` : ""} → 404`)
    return ""
  }
}

// Internal: deletes a spec branch after its spec has been approved to main.
// Non-fatal — branch deletion is cleanup, not critical path.
async function deleteSpecBranch(branch: string): Promise<void> {
  try {
    await octokit.git.deleteRef({ owner, repo, ref: `heads/${branch}` })
  } catch {
    // Branch may already be deleted or may not exist — ignore
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
  if (isDryRun()) { console.log(`[DRY RUN] saveDraftSpec: would write ${filePath} (${content.length} chars)`); return }
  try {
    await saveDraftFile({
      branch: `spec/${featureName}-product`,
      filePath,
      content,
      commitMessage: `[DRAFT] ${featureName} · product.md`,
    })
    console.log(`[GITHUB] saveDraftSpec: ${filePath} → saved`)
  } catch (err) {
    console.log(`[GITHUB] saveDraftSpec: ${filePath} → error: ${err}`)
    throw err
  }
}

// Save a draft design spec to the feature branch without opening a PR.
export async function saveDraftDesignSpec(params: {
  featureName: string
  filePath: string
  content: string
}): Promise<void> {
  const { featureName, filePath, content } = params
  if (isDryRun()) { console.log(`[DRY RUN] saveDraftDesignSpec: would write ${filePath} (${content.length} chars)`); return }
  try {
    await saveDraftFile({
      branch: `spec/${featureName}-design`,
      filePath,
      content,
      commitMessage: `[DRAFT] ${featureName} · design.md`,
    })
    console.log(`[GITHUB] saveDraftDesignSpec: ${filePath} → saved`)
  } catch (err) {
    console.log(`[GITHUB] saveDraftDesignSpec: ${filePath} → error: ${err}`)
    throw err
  }
}

// Returns the current status of all features in flight.
// Determines phase by checking which spec files exist on main vs only on branches.
export type FeatureStatus = {
  featureName: string
  phase: "product-spec-in-progress" | "product-spec-approved-awaiting-design" | "design-in-progress" | "design-approved-awaiting-engineering" | "engineering-in-progress"
}

export async function getInProgressFeatures(): Promise<FeatureStatus[]> {
  const features: FeatureStatus[] = []

  // List all branches matching spec/*
  const branches = await octokit.paginate(octokit.repos.listBranches, { owner, repo, per_page: 100 })

  // Extract unique feature names from ALL spec branches (not just -product).
  // A product branch is deleted after approval — scanning only -product branches
  // causes features in design or engineering phase to silently disappear.
  const featureNames = new Set<string>()
  for (const branch of branches) {
    if (!branch.name.startsWith("spec/")) continue
    const withoutPrefix = branch.name.replace("spec/", "")
    const featureName = withoutPrefix
      .replace(/-product$/, "")
      .replace(/-design$/, "")
      .replace(/-engineering$/, "")
    featureNames.add(featureName)
  }

  const { paths } = loadWorkspaceConfig()

  for (const featureName of featureNames) {
    const productSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.product.md`
    const designSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`
    const engineeringSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.engineering.md`

    const [productOnMain, designOnMain, engineeringOnMain] = await Promise.all([
      readFile(productSpecPath),
      readFile(designSpecPath),
      readFile(engineeringSpecPath),
    ])

    if (engineeringOnMain) {
      // Engineering spec approved — build phase (not tracked here)
    } else if (designOnMain) {
      const hasEngineeringBranch = branches.some((b) => b.name === `spec/${featureName}-engineering`)
      features.push({ featureName, phase: hasEngineeringBranch ? "engineering-in-progress" : "design-approved-awaiting-engineering" })
    } else if (productOnMain) {
      const hasDesignBranch = branches.some((b) => b.name === `spec/${featureName}-design`)
      features.push({ featureName, phase: hasDesignBranch ? "design-in-progress" : "product-spec-approved-awaiting-design" })
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
  if (isDryRun()) { console.log(`[DRY RUN] saveApprovedSpec: would approve ${filePath} (${content.length} chars)`); return "saved" }
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
    await deleteSpecBranch(branch)
    console.log(`[GITHUB] saveApprovedSpec: ${filePath} → updated on main`)
    return "already-on-main"
  }

  // Save to branch then commit directly to main
  await saveDraftSpec({ featureName, filePath, content })
  await deleteSpecBranch(branch)
  console.log(`[GITHUB] saveApprovedSpec: ${filePath} → saved`)
  return "saved"
}

// Opens a GitHub issue tagged agent-feedback to track feedback about AI agent behavior.
export async function saveAgentFeedback(params: {
  feedback: string
  submittedBy?: string
}): Promise<void> {
  const { feedback, submittedBy } = params
  if (isDryRun()) { console.log(`[DRY RUN] saveAgentFeedback: would open issue "${feedback.slice(0, 60)}..."`); return }
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
  if (isDryRun()) { console.log(`[DRY RUN] saveApprovedDesignSpec: would approve ${filePath} (${content.length} chars)`); return "saved" }

  let mainFileSha: string | undefined
  try {
    const existing = await octokit.repos.getContent({ owner, repo, path: filePath })
    mainFileSha = (existing.data as { sha: string }).sha
  } catch {
    // Not on main yet
  }

  const branch = `spec/${featureName}-design`

  if (mainFileSha) {
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: filePath,
      message: `[SPEC] ${featureName} · design.md — final approved`,
      content: Buffer.from(content).toString("base64"),
      sha: mainFileSha,
    })
    await deleteSpecBranch(branch)
    console.log(`[GITHUB] saveApprovedDesignSpec: ${filePath} → updated on main`)
    return "already-on-main"
  }

  await saveDraftDesignSpec({ featureName, filePath, content })
  await deleteSpecBranch(branch)
  console.log(`[GITHUB] saveApprovedDesignSpec: ${filePath} → saved`)
  return "saved"
}

// Save a draft engineering spec to the feature branch without opening a PR.
export async function saveDraftEngineeringSpec(params: {
  featureName: string
  filePath: string
  content: string
}): Promise<void> {
  const { featureName, filePath, content } = params
  if (isDryRun()) { console.log(`[DRY RUN] saveDraftEngineeringSpec: would write ${filePath} (${content.length} chars)`); return }
  try {
    await saveDraftFile({
      branch: `spec/${featureName}-engineering`,
      filePath,
      content,
      commitMessage: `[DRAFT] ${featureName} · engineering.md`,
    })
    console.log(`[GITHUB] saveDraftEngineeringSpec: ${filePath} → saved`)
  } catch (err) {
    console.log(`[GITHUB] saveDraftEngineeringSpec: ${filePath} → error: ${err}`)
    throw err
  }
}

// Saves the final approved engineering spec. Updates in place if already on main.
export async function saveApprovedEngineeringSpec(params: {
  featureName: string
  filePath: string
  content: string
}): Promise<"already-on-main" | "saved"> {
  const { featureName, filePath, content } = params
  if (isDryRun()) { console.log(`[DRY RUN] saveApprovedEngineeringSpec: would approve ${filePath} (${content.length} chars)`); return "saved" }

  let mainFileSha: string | undefined
  try {
    const existing = await octokit.repos.getContent({ owner, repo, path: filePath })
    mainFileSha = (existing.data as { sha: string }).sha
  } catch {
    // Not on main yet
  }

  const branch = `spec/${featureName}-engineering`

  if (mainFileSha) {
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: filePath,
      message: `[SPEC] ${featureName} · engineering.md — final approved`,
      content: Buffer.from(content).toString("base64"),
      sha: mainFileSha,
    })
    await deleteSpecBranch(branch)
    console.log(`[GITHUB] saveApprovedEngineeringSpec: ${filePath} → updated on main`)
    return "already-on-main"
  }

  await saveDraftEngineeringSpec({ featureName, filePath, content })
  await deleteSpecBranch(branch)
  console.log(`[GITHUB] saveApprovedEngineeringSpec: ${filePath} → saved`)
  return "saved"
}

// Pre-seed the engineering spec draft with architect-scope open questions.
// Called by Gate 2 when PM classifier filters items as architecture-scope.
// Creates the draft file if it doesn't exist; appends to ## Open Questions if it does.
// Silent platform action — no user-facing message.
export async function preseedEngineeringSpec(params: {
  featureName: string
  filePath: string
  architectItems: string[]
}): Promise<void> {
  const { featureName, filePath, architectItems } = params
  if (architectItems.length === 0) return

  const branch = `spec/${featureName}-engineering`
  const newLines = architectItems.map(item => `- [open: architecture] ${item}`).join("\n")

  let existing: string | null = null
  try {
    existing = await readFile(filePath, branch)
  } catch {
    // Branch or file doesn't exist yet — will be created below
  }

  let merged: string
  if (!existing) {
    merged = `# ${featureName} Engineering Spec\n\n## Open Questions\n\n${newLines}\n`
  } else if (existing.includes("## Open Questions")) {
    // Append before the next ## heading or at end-of-section
    merged = existing.replace(
      /(## Open Questions\n)([\s\S]*?)(\n## |\n*$)/,
      (_, heading, body, tail) => `${heading}${body.trimEnd()}\n${newLines}\n${tail}`,
    )
  } else {
    merged = `${existing.trimEnd()}\n\n## Open Questions\n\n${newLines}\n`
  }

  await saveDraftEngineeringSpec({ featureName, filePath, content: merged })
  console.log(`[GITHUB] preseedEngineeringSpec: ${architectItems.length} item(s) written to ${filePath} on ${branch}`)
}

// Generic phase handoff seeding — writes a named section into a target spec on a draft branch.
// Used for Design → Engineering seeding (## Design Assumptions To Validate).
// No-op if content is blank/whitespace. Creates branch + file stub if they don't exist.
export async function seedHandoffSection(params: {
  featureName: string
  targetFilePath: string       // path of the spec to seed into
  targetBranchName: string     // branch to write to (e.g. spec/{featureName}-engineering)
  targetSectionHeading: string // e.g. "## Design Assumptions To Validate"
  content: string              // raw body content to write under the section
}): Promise<void> {
  const { featureName, targetFilePath, targetBranchName, targetSectionHeading, content } = params
  if (!content.trim()) return

  let existing: string | null = null
  try {
    existing = await readFile(targetFilePath, targetBranchName)
  } catch {
    // Branch or file doesn't exist yet
  }

  const newSection = `${targetSectionHeading}\n\n${content.trim()}\n`

  let merged: string
  if (!existing) {
    merged = `# ${featureName} Engineering Spec\n\n${newSection}`
  } else if (existing.includes(targetSectionHeading)) {
    // Replace the existing section body
    const escapedHeading = targetSectionHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    merged = existing.replace(
      new RegExp(`${escapedHeading}\\s*\\n[\\s\\S]*?(?=\\n## |\\n*$)`),
      `${newSection}`,
    )
  } else {
    merged = `${existing.trimEnd()}\n\n${newSection}`
  }

  await saveDraftEngineeringSpec({ featureName, filePath: targetFilePath, content: merged })
  console.log(`[GITHUB] seedHandoffSection: "${targetSectionHeading}" seeded to ${targetFilePath} on ${targetBranchName}`)
}

// Removes the body of a named section from an approved spec on main (leaves heading with empty body).
// Called at engineering finalization to clear ## Design Assumptions from the design spec on main.
// Signals "all confirmed" — the heading remains as evidence the section existed.
export async function clearHandoffSection(params: {
  featureName: string
  filePath: string        // spec path on main
  sectionHeading: string  // e.g. "## Design Assumptions"
}): Promise<void> {
  const { featureName, filePath, sectionHeading } = params
  if (isDryRun()) { console.log(`[DRY RUN] clearHandoffSection: would clear "${sectionHeading}" from ${filePath} on main`); return }

  const existing = await readFile(filePath, "main")
  if (!existing) {
    console.log(`[GITHUB] clearHandoffSection: ${filePath} not found on main, skipping`)
    return
  }

  if (!existing.includes(sectionHeading)) {
    console.log(`[GITHUB] clearHandoffSection: section "${sectionHeading}" absent from ${filePath}, no-op`)
    return
  }

  // Replace section body with empty string — heading stays, body is gone
  const escapedHeading = sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const cleared = existing.replace(
    new RegExp(`(${escapedHeading}\\s*\\n)[\\s\\S]*?(?=\\n## |\\n*$)`),
    (_, heading) => `${heading}`,
  )

  // Determine spec type from file path and save to main accordingly
  let mainFileSha: string | undefined
  try {
    const existing2 = await octokit.repos.getContent({ owner, repo, path: filePath })
    mainFileSha = (existing2.data as { sha: string }).sha
  } catch {
    console.log(`[GITHUB] clearHandoffSection: could not get SHA for ${filePath}, skipping`)
    return
  }

  await octokit.repos.createOrUpdateFileContents({
    owner, repo, path: filePath,
    message: `[SPEC] ${featureName} — clear ${sectionHeading} (engineering approved)`,
    content: Buffer.from(cleared).toString("base64"),
    sha: mainFileSha,
  })
  console.log(`[GITHUB] clearHandoffSection: "${sectionHeading}" cleared from ${filePath} on main`)
}

// Save a draft HTML preview to the design branch.
// Saved alongside the design spec — deleted on spec approval (it's a draft artifact).
export async function saveDraftHtmlPreview(params: {
  featureName: string
  filePath: string
  content: string
}): Promise<void> {
  const { featureName, filePath, content } = params
  if (isDryRun()) { console.log(`[DRY RUN] saveDraftHtmlPreview: would write ${filePath} (${content.length} chars)`); return }
  try {
    await saveDraftFile({
      branch: `spec/${featureName}-design`,
      filePath,
      content,
      commitMessage: `[PREVIEW] ${featureName} · design preview`,
    })
    console.log(`[GITHUB] saveDraftHtmlPreview: ${filePath} → saved`)
  } catch (err) {
    console.log(`[GITHUB] saveDraftHtmlPreview: ${filePath} → error: ${err}`)
    throw err
  }
}

// Builds the htmlpreview.github.io URL for a design preview file on a branch.
// Works for public repos. For private repos, user can view the raw file via GitHub UI.
export function buildPreviewUrl(params: {
  githubOwner: string
  githubRepo: string
  featureName: string
  featuresRoot: string
}): string {
  const { githubOwner, githubRepo, featureName, featuresRoot } = params
  const branch = `spec/${featureName}-design`
  const filePath = `${featuresRoot}/${featureName}/${featureName}.preview.html`
  return `https://htmlpreview.github.io/?https://github.com/${githubOwner}/${githubRepo}/blob/${branch}/${filePath}`
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
  if (isDryRun()) { console.log(`[DRY RUN] createSpecPR: would open PR "${prTitle}" for ${filePath}`); return "https://github.com/dry-run/pr/0" }
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

  console.log(`[GITHUB] createSpecPR: ${featureName} → PR created: ${pr.data.html_url}`)
  return pr.data.html_url
}

// Appends a user reaction (👍/👎) to a JSONL feedback log in the repo.
// Each line is a self-contained JSON record — easy to query, never overwrites history.
// Non-fatal: reaction tracking must never break the conversation.
export async function saveUserFeedback(params: {
  timestamp: string
  channel: string
  messageTs: string
  rating: "positive" | "negative"
  agentResponse: string
  userMessage: string
  reactingUser: string
}): Promise<void> {
  if (isDryRun()) { console.log(`[DRY RUN] saveUserFeedback: would append ${params.rating} reaction to feedback log`); return }
  const feedbackPath = "specs/feedback/reactions.jsonl"
  try {
    // Read existing file (returns "" if not found — readFile swallows 404s)
    // Read existing content from the platform repo
    const existingRes = await octokit.repos.getContent({ owner: platformOwner, repo: platformRepo, path: feedbackPath }).catch(() => null)
    const existing = existingRes
      ? Buffer.from((existingRes.data as { content: string }).content, "base64").toString("utf-8")
      : ""
    const fileSha = existingRes ? (existingRes.data as { sha: string }).sha : undefined

    const newLine = JSON.stringify(params)
    const newContent = existing.trim() ? `${existing.trim()}\n${newLine}` : newLine

    await octokit.repos.createOrUpdateFileContents({
      owner: platformOwner,
      repo:  platformRepo,
      path: feedbackPath,
      message: "chore: append user reaction feedback",
      content: Buffer.from(newContent).toString("base64"),
      ...(fileSha ? { sha: fileSha } : {}),
    })
  } catch {
    // Non-fatal — never let feedback tracking interrupt a conversation
  }
}
