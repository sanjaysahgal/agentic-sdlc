/**
 * GitHub tools used by agents.
 * Agents use these to commit files and open PRs — never call GitHub API directly.
 */

import { Octokit } from "@octokit/rest"

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

export async function commitFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string = "main"
): Promise<void> {
  // Get current file SHA if it exists (needed for updates)
  let sha: string | undefined
  try {
    const existing = await octokit.repos.getContent({ owner, repo, path, ref: branch })
    const data = existing.data as { sha: string }
    sha = data.sha
  } catch {
    // File doesn't exist yet — that's fine
  }

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content).toString("base64"),
    sha,
    branch,
  })
}

export async function openPR(
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string = "main"
): Promise<string> {
  const pr = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head,
    base,
  })
  return pr.data.html_url
}

export async function createBranch(
  owner: string,
  repo: string,
  branch: string,
  fromBranch: string = "main"
): Promise<void> {
  const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${fromBranch}` })
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: ref.data.object.sha,
  })
}
