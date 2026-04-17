import { describe, it, expect, vi, beforeEach } from "vitest"

// github-client.ts runs `new Octokit()` and `loadWorkspaceConfig()` at module load.
// vi.mock() factories are hoisted above module-level code, so top-level `const mockFn = vi.fn()`
// would be undefined when the factory runs. Use vi.hoisted() to create variables
// that are available at factory execution time.
const { mockGetContent, mockGetRef, mockCreateRef, mockCreateOrUpdateFileContents, mockPaginate, mockListBranches, mockCreateLabel, mockCreateIssue, mockCreatePR, mockDeleteRef } =
  vi.hoisted(() => ({
    mockGetContent: vi.fn(),
    mockGetRef: vi.fn(),
    mockCreateRef: vi.fn(),
    mockCreateOrUpdateFileContents: vi.fn(),
    mockPaginate: vi.fn(),
    mockListBranches: vi.fn(),
    mockCreateLabel: vi.fn(),
    mockCreateIssue: vi.fn(),
    mockCreatePR: vi.fn(),
    mockDeleteRef: vi.fn(),
  }))

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      repos: {
        getContent: mockGetContent,
        createOrUpdateFileContents: mockCreateOrUpdateFileContents,
        listBranches: mockListBranches,
      },
      git: {
        getRef: mockGetRef,
        createRef: mockCreateRef,
        deleteRef: mockDeleteRef,
      },
      issues: {
        createLabel: mockCreateLabel,
        create: mockCreateIssue,
      },
      pulls: {
        create: mockCreatePR,
      },
      paginate: mockPaginate,
    }
  }),
}))

vi.mock("../../runtime/workspace-config", () => ({
  loadWorkspaceConfig: vi.fn().mockReturnValue({
    githubOwner: "test-owner",
    githubRepo: "test-repo",
    productName: "TestProduct",
    mainChannel: "general",
    paths: {
      productVision: "specs/product/PRODUCT_VISION.md",
      systemArchitecture: "specs/architecture/system-architecture.md",
      featureConventions: "specs/features/CLAUDE.md",
      featuresRoot: "specs/features",
    },
  }),
}))

import { readFile, saveDraftSpec, saveApprovedSpec, getInProgressFeatures, listSubdirectories, saveDraftEngineeringSpec, saveApprovedEngineeringSpec, buildPreviewUrl, createSpecPR, saveAgentFeedback, saveUserFeedback, saveDraftAuditCache, readDraftAuditCache } from "../../runtime/github-client"

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── readFile ───────────────────────────────────────────────────────────────

describe("readFile", () => {
  it("decodes base64 content and returns string", async () => {
    const content = "# Product Vision\nWe build great things."
    mockGetContent.mockResolvedValue({
      data: { content: Buffer.from(content).toString("base64") },
    })
    const result = await readFile("specs/product/PRODUCT_VISION.md")
    expect(result).toBe(content)
  })

  it("returns empty string when GitHub API throws (file not found)", async () => {
    mockGetContent.mockRejectedValue(new Error("Not Found"))
    const result = await readFile("specs/product/PRODUCT_VISION.md")
    expect(result).toBe("")
  })

  it("passes ref parameter when provided", async () => {
    mockGetContent.mockResolvedValue({
      data: { content: Buffer.from("content").toString("base64") },
    })
    await readFile("specs/features/onboarding/onboarding.product.md", "spec/onboarding-product")
    expect(mockGetContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "spec/onboarding-product" })
    )
  })

  it("does not pass ref when not provided", async () => {
    mockGetContent.mockResolvedValue({
      data: { content: Buffer.from("content").toString("base64") },
    })
    await readFile("specs/product/PRODUCT_VISION.md")
    const call = mockGetContent.mock.calls[0][0]
    expect(call).not.toHaveProperty("ref")
  })
})

// ─── saveDraftSpec ───────────────────────────────────────────────────────────

describe("saveDraftSpec", () => {
  it("creates branch spec/{featureName}-product from main SHA", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockResolvedValue({})
    mockGetContent.mockRejectedValue(new Error("Not Found"))
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    await saveDraftSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content: "# Spec",
    })

    expect(mockCreateRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "refs/heads/spec/onboarding-product",
        sha: "abc123",
      })
    )
  })

  it("does not throw when branch already exists (createRef throws)", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockRejectedValue(new Error("Reference already exists"))
    mockGetContent.mockRejectedValue(new Error("Not Found"))
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    await expect(
      saveDraftSpec({
        featureName: "onboarding",
        filePath: "specs/features/onboarding/onboarding.product.md",
        content: "# Spec",
      })
    ).resolves.toBeUndefined()
  })

  it("saves file with base64-encoded content", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockResolvedValue({})
    mockGetContent.mockRejectedValue(new Error("Not Found"))
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    const content = "# Onboarding Spec\n\n## Problem\nUsers can't sign up."
    await saveDraftSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content,
    })

    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        content: Buffer.from(content).toString("base64"),
      })
    )
  })

  it("omits sha when file is new (create path)", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockResolvedValue({})
    mockGetContent.mockRejectedValue(new Error("Not Found"))
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    await saveDraftSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content: "# Spec",
    })

    const call = mockCreateOrUpdateFileContents.mock.calls[0][0]
    expect(call.sha).toBeUndefined()
  })

  it("includes file sha when file already exists on branch (update path)", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockRejectedValue(new Error("Reference already exists"))
    mockGetContent.mockResolvedValue({ data: { sha: "existing-file-sha" } })
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    await saveDraftSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content: "# Spec",
    })

    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "existing-file-sha" })
    )
  })
})

// ─── saveApprovedSpec ────────────────────────────────────────────────────────

describe("saveApprovedSpec", () => {
  it("returns 'already-on-main' and updates in place when file exists on main", async () => {
    mockGetContent.mockResolvedValue({ data: { sha: "main-file-sha" } })
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    const result = await saveApprovedSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content: "# Final Spec",
    })

    expect(result).toBe("already-on-main")
    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "main-file-sha" })
    )
  })

  it("returns 'saved' and delegates to saveDraftSpec when file is not on main", async () => {
    mockGetContent.mockRejectedValueOnce(new Error("Not Found")) // not on main
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockResolvedValue({})
    mockGetContent.mockRejectedValue(new Error("Not Found")) // file not on branch either
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    const result = await saveApprovedSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content: "# Final Spec",
    })

    expect(result).toBe("saved")
  })
})

// ─── getInProgressFeatures ───────────────────────────────────────────────────

describe("getInProgressFeatures", () => {
  it("returns empty array when no spec branches exist", async () => {
    mockPaginate.mockResolvedValue([{ name: "main" }, { name: "feature/something" }])
    const result = await getInProgressFeatures()
    expect(result).toEqual([])
  })

  it("returns product-spec-in-progress when branch exists but product spec not on main", async () => {
    mockPaginate.mockResolvedValue([{ name: "spec/onboarding-product" }])
    mockGetContent.mockRejectedValue(new Error("Not Found"))

    const result = await getInProgressFeatures()
    expect(result).toEqual([{ featureName: "onboarding", phase: "product-spec-in-progress" }])
  })

  it("returns product-spec-approved-awaiting-design when product spec on main, no design spec, no design branch", async () => {
    mockPaginate.mockResolvedValue([{ name: "spec/onboarding-product" }])
    mockGetContent.mockResolvedValueOnce({
      data: { content: Buffer.from("# Product Spec").toString("base64") },
    })
    mockGetContent.mockRejectedValueOnce(new Error("Not Found")) // design not on main
    mockGetContent.mockRejectedValueOnce(new Error("Not Found")) // engineering not on main

    const result = await getInProgressFeatures()
    expect(result).toEqual([
      { featureName: "onboarding", phase: "product-spec-approved-awaiting-design" },
    ])
  })

  it("returns design-in-progress when product spec on main and design branch exists", async () => {
    mockPaginate.mockResolvedValue([
      { name: "spec/onboarding-product" },
      { name: "spec/onboarding-design" },
    ])
    mockGetContent.mockResolvedValueOnce({
      data: { content: Buffer.from("# Product Spec").toString("base64") },
    })
    mockGetContent.mockRejectedValueOnce(new Error("Not Found")) // design not on main
    mockGetContent.mockRejectedValueOnce(new Error("Not Found")) // engineering not on main

    const result = await getInProgressFeatures()
    expect(result).toEqual([
      { featureName: "onboarding", phase: "design-in-progress" },
    ])
  })

  it("returns design-approved-awaiting-engineering when design spec on main but no engineering branch", async () => {
    mockPaginate.mockResolvedValue([{ name: "spec/onboarding-product" }])
    mockGetContent.mockResolvedValueOnce({
      data: { content: Buffer.from("# Product Spec").toString("base64") },
    })
    mockGetContent.mockResolvedValueOnce({
      data: { content: Buffer.from("# Design Spec").toString("base64") },
    })
    mockGetContent.mockRejectedValueOnce(new Error("Not Found")) // engineering not on main

    const result = await getInProgressFeatures()
    expect(result).toEqual([
      { featureName: "onboarding", phase: "design-approved-awaiting-engineering" },
    ])
  })

  it("returns engineering-in-progress when design spec on main and engineering branch exists", async () => {
    mockPaginate.mockResolvedValue([
      { name: "spec/onboarding-product" },
      { name: "spec/onboarding-engineering" },
    ])
    mockGetContent.mockResolvedValueOnce({
      data: { content: Buffer.from("# Product Spec").toString("base64") },
    })
    mockGetContent.mockResolvedValueOnce({
      data: { content: Buffer.from("# Design Spec").toString("base64") },
    })
    mockGetContent.mockRejectedValueOnce(new Error("Not Found")) // no engineering spec on main

    const result = await getInProgressFeatures()
    expect(result).toEqual([
      { featureName: "onboarding", phase: "engineering-in-progress" },
    ])
  })

  it("skips feature when engineering spec already on main (build phase)", async () => {
    mockPaginate.mockResolvedValue([{ name: "spec/onboarding-product" }])
    mockGetContent.mockResolvedValueOnce({
      data: { content: Buffer.from("# Product Spec").toString("base64") },
    })
    mockGetContent.mockResolvedValueOnce({
      data: { content: Buffer.from("# Design Spec").toString("base64") },
    })
    mockGetContent.mockResolvedValueOnce({
      data: { content: Buffer.from("# Engineering Spec").toString("base64") },
    })

    const result = await getInProgressFeatures()
    expect(result).toEqual([])
  })

  it("ignores non-spec branches", async () => {
    mockPaginate.mockResolvedValue([
      { name: "main" },
      { name: "feature/new-ui" },
      { name: "spec/onboarding-design" },
      { name: "spec/onboarding-product" },
    ])
    mockGetContent.mockRejectedValue(new Error("Not Found"))

    const result = await getInProgressFeatures()
    expect(result).toHaveLength(1)
    expect(result[0].featureName).toBe("onboarding")
  })

  // Regression: product branch is deleted after approval. Only the design branch
  // remains. The concierge must still surface this feature as design-in-progress.
  it("returns design-in-progress when only design branch exists (product branch deleted after approval)", async () => {
    mockPaginate.mockResolvedValue([
      { name: "spec/onboarding-design" },  // product branch was deleted on approval
    ])
    mockGetContent
      .mockResolvedValueOnce({ data: { content: Buffer.from("# Product Spec").toString("base64") } }) // product on main
      .mockRejectedValueOnce(new Error("Not Found"))  // design not on main
      .mockRejectedValueOnce(new Error("Not Found"))  // engineering not on main

    const result = await getInProgressFeatures()
    expect(result).toEqual([{ featureName: "onboarding", phase: "design-in-progress" }])
  })
})

// ─── saveDraftEngineeringSpec ─────────────────────────────────────────────────

describe("saveDraftEngineeringSpec", () => {
  it("creates branch spec/{featureName}-engineering from main SHA", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockResolvedValue({})
    mockGetContent.mockRejectedValue(new Error("Not Found"))
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    await saveDraftEngineeringSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.engineering.md",
      content: "# Engineering Spec",
    })

    expect(mockCreateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "refs/heads/spec/onboarding-engineering" })
    )
  })

  it("does not throw when branch already exists", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockRejectedValue(new Error("Reference already exists"))
    mockGetContent.mockRejectedValue(new Error("Not Found"))
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    await expect(
      saveDraftEngineeringSpec({
        featureName: "onboarding",
        filePath: "specs/features/onboarding/onboarding.engineering.md",
        content: "# Engineering Spec",
      })
    ).resolves.toBeUndefined()
  })
})

// ─── saveApprovedEngineeringSpec ──────────────────────────────────────────────

describe("saveApprovedEngineeringSpec", () => {
  it("returns 'already-on-main' and updates in place when file exists on main", async () => {
    mockGetContent.mockResolvedValue({ data: { sha: "main-file-sha" } })
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    const result = await saveApprovedEngineeringSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.engineering.md",
      content: "# Final Engineering Spec",
    })

    expect(result).toBe("already-on-main")
    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "main-file-sha" })
    )
  })

  it("returns 'saved' and delegates to saveDraftEngineeringSpec when file is not on main", async () => {
    mockGetContent.mockRejectedValueOnce(new Error("Not Found")) // not on main
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockResolvedValue({})
    mockGetContent.mockRejectedValue(new Error("Not Found")) // file not on branch either
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    const result = await saveApprovedEngineeringSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.engineering.md",
      content: "# Final Engineering Spec",
    })

    expect(result).toBe("saved")
  })
})

// ─── listSubdirectories ───────────────────────────────────────────────────────

describe("listSubdirectories", () => {
  it("returns directory names from the path", async () => {
    mockGetContent.mockResolvedValue({
      data: [
        { type: "dir", name: "onboarding" },
        { type: "dir", name: "dashboard" },
        { type: "file", name: "CLAUDE.md" },
      ],
    })

    const result = await listSubdirectories("specs/features")
    expect(result).toEqual(["onboarding", "dashboard"])
  })

  it("filters out files — returns only directories", async () => {
    mockGetContent.mockResolvedValue({
      data: [
        { type: "file", name: "README.md" },
        { type: "dir", name: "onboarding" },
      ],
    })

    const result = await listSubdirectories("specs/features")
    expect(result).toEqual(["onboarding"])
  })

  it("returns empty array when path does not exist", async () => {
    mockGetContent.mockRejectedValue(new Error("Not Found"))

    const result = await listSubdirectories("specs/features")
    expect(result).toEqual([])
  })

  it("returns empty array when response is not an array (single file returned)", async () => {
    mockGetContent.mockResolvedValue({
      data: { type: "file", name: "CLAUDE.md", content: "" },
    })

    const result = await listSubdirectories("specs/features")
    expect(result).toEqual([])
  })

  it("returns empty array on GitHub API timeout", async () => {
    mockGetContent.mockRejectedValue(new Error("ETIMEDOUT"))

    const result = await listSubdirectories("specs/features")
    expect(result).toEqual([])
  })
})

// ─── buildPreviewUrl ──────────────────────────────────────────────────────────

describe("buildPreviewUrl", () => {
  it("builds an htmlpreview.github.io URL for the design branch", () => {
    const url = buildPreviewUrl({
      githubOwner: "myorg",
      githubRepo: "myapp",
      featureName: "onboarding",
      featuresRoot: "specs/features",
    })
    expect(url).toBe(
      "https://htmlpreview.github.io/?https://github.com/myorg/myapp/blob/spec/onboarding-design/specs/features/onboarding/onboarding.preview.html"
    )
  })

  it("uses spec/{featureName}-design branch", () => {
    const url = buildPreviewUrl({
      githubOwner: "o",
      githubRepo: "r",
      featureName: "dashboard",
      featuresRoot: "specs/features",
    })
    expect(url).toContain("spec/dashboard-design")
  })

  it("includes featureName in the file path", () => {
    const url = buildPreviewUrl({
      githubOwner: "o",
      githubRepo: "r",
      featureName: "profile",
      featuresRoot: "specs/features",
    })
    expect(url).toContain("profile.preview.html")
  })
})

// ─── createSpecPR ────────────────────────────────────────────────────────────

describe("createSpecPR", () => {
  it("creates branch, commits file, opens PR, and returns PR URL", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockResolvedValue({})
    mockCreateOrUpdateFileContents.mockResolvedValue({})
    mockCreatePR.mockResolvedValue({ data: { html_url: "https://github.com/test-owner/test-repo/pull/42" } })

    const url = await createSpecPR({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content: "# Spec",
      prTitle: "Spec: onboarding",
      prBody: "Product spec for onboarding.",
    })

    expect(url).toBe("https://github.com/test-owner/test-repo/pull/42")
    expect(mockCreateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "refs/heads/spec/onboarding-product", sha: "abc123" })
    )
    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "specs/features/onboarding/onboarding.product.md",
        content: Buffer.from("# Spec").toString("base64"),
        branch: "spec/onboarding-product",
      })
    )
    expect(mockCreatePR).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Spec: onboarding",
        head: "spec/onboarding-product",
        base: "main",
      })
    )
  })
})

// ─── saveAgentFeedback ────────────────────────────────────────────────────────

describe("saveAgentFeedback", () => {
  it("creates a GitHub issue with agent-feedback label", async () => {
    mockCreateLabel.mockResolvedValue({})
    mockCreateIssue.mockResolvedValue({})

    await saveAgentFeedback({ feedback: "The agent asked too many questions at once." })

    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ["agent-feedback"],
        title: expect.stringContaining("Agent feedback"),
      })
    )
  })

  it("includes submittedBy in the issue body when provided", async () => {
    mockCreateLabel.mockResolvedValue({})
    mockCreateIssue.mockResolvedValue({})

    await saveAgentFeedback({ feedback: "Too slow.", submittedBy: "U123" })

    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("U123") })
    )
  })

  it("does not throw when GitHub API fails — non-fatal", async () => {
    mockCreateLabel.mockRejectedValue(new Error("Forbidden"))
    mockCreateIssue.mockRejectedValue(new Error("Forbidden"))

    await expect(saveAgentFeedback({ feedback: "Feedback." })).resolves.toBeUndefined()
  })
})

// ─── saveUserFeedback ─────────────────────────────────────────────────────────

describe("saveUserFeedback", () => {
  const baseParams = {
    timestamp: "2024-01-01T00:00:00.000Z",
    channel: "C123",
    messageTs: "1234.5678",
    rating: "positive" as const,
    agentResponse: "Here is the spec.",
    userMessage: "looks great",
    reactingUser: "U456",
  }

  it("appends a new JSONL line when file does not exist yet", async () => {
    mockGetContent.mockRejectedValue(new Error("Not Found"))
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    await saveUserFeedback(baseParams)

    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "specs/feedback/reactions.jsonl",
        message: "chore: append user reaction feedback",
      })
    )
    const call = mockCreateOrUpdateFileContents.mock.calls[0][0]
    const written = Buffer.from(call.content, "base64").toString("utf-8")
    const parsed = JSON.parse(written)
    expect(parsed.rating).toBe("positive")
    expect(parsed.reactingUser).toBe("U456")
  })

  it("appends to existing content when file already exists", async () => {
    const existing = JSON.stringify({ timestamp: "2024-01-01", rating: "negative" })
    mockGetContent.mockResolvedValue({
      data: {
        content: Buffer.from(existing).toString("base64"),
        sha: "existing-sha",
      },
    })
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    await saveUserFeedback(baseParams)

    const call = mockCreateOrUpdateFileContents.mock.calls[0][0]
    const written = Buffer.from(call.content, "base64").toString("utf-8")
    const lines = written.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).rating).toBe("negative")
    expect(JSON.parse(lines[1]).rating).toBe("positive")
    // Must pass existing sha for update
    expect(call.sha).toBe("existing-sha")
  })

  it("does not throw when GitHub API fails — non-fatal", async () => {
    mockGetContent.mockRejectedValue(new Error("Network error"))
    mockCreateOrUpdateFileContents.mockRejectedValue(new Error("Network error"))

    await expect(saveUserFeedback(baseParams)).resolves.toBeUndefined()
  })
})

// ─── saveDraftAuditCache ──────────────────────────────────────────────────────

describe("saveDraftAuditCache", () => {
  it("calls saveDraftFile with JSON-stringified content on the design branch", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockResolvedValue({})
    mockGetContent.mockRejectedValue(new Error("Not Found"))
    mockCreateOrUpdateFileContents.mockResolvedValue({})

    const content = { specFingerprint: "fp-abc", findings: ["Gap 1", "Gap 2"] }
    await saveDraftAuditCache({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.audit-cache.json",
      content,
    })

    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
        branch: "spec/onboarding-design",
      })
    )
  })
})

// ─── readDraftAuditCache ─────────────────────────────────────────────────────

describe("readDraftAuditCache", () => {
  it("returns findings when fingerprint matches", async () => {
    const cached = { specFingerprint: "fp-abc", findings: ["Gap 1", "Gap 2"] }
    mockGetContent.mockResolvedValue({
      data: { content: Buffer.from(JSON.stringify(cached)).toString("base64") },
    })

    const result = await readDraftAuditCache({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.audit-cache.json",
      expectedFingerprint: "fp-abc",
    })

    expect(result).toEqual(["Gap 1", "Gap 2"])
  })

  it("returns null when fingerprint does not match", async () => {
    const cached = { specFingerprint: "fp-old", findings: ["Gap 1"] }
    mockGetContent.mockResolvedValue({
      data: { content: Buffer.from(JSON.stringify(cached)).toString("base64") },
    })

    const result = await readDraftAuditCache({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.audit-cache.json",
      expectedFingerprint: "fp-new",
    })

    expect(result).toBeNull()
  })

  it("returns null when file does not exist (404)", async () => {
    mockGetContent.mockRejectedValue(new Error("Not Found"))

    const result = await readDraftAuditCache({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.audit-cache.json",
      expectedFingerprint: "fp-abc",
    })

    expect(result).toBeNull()
  })
})

// ─── dry-run mode ────────────────────────────────────────────────────────────

describe("dry-run mode (SIMULATE_DRY_RUN=true)", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, SIMULATE_DRY_RUN: "true" }
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("saveDraftSpec: skips all GitHub writes in dry-run", async () => {
    await saveDraftSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content: "# Spec",
    })
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled()
    expect(mockCreateRef).not.toHaveBeenCalled()
  })

  it("saveApprovedSpec: returns 'saved' without writing in dry-run", async () => {
    const result = await saveApprovedSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content: "# Final",
    })
    expect(result).toBe("saved")
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled()
  })

  it("saveDraftEngineeringSpec: skips all GitHub writes in dry-run", async () => {
    await saveDraftEngineeringSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.engineering.md",
      content: "# Engineering",
    })
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled()
  })

  it("saveApprovedEngineeringSpec: returns 'saved' without writing in dry-run", async () => {
    const result = await saveApprovedEngineeringSpec({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.engineering.md",
      content: "# Final Engineering",
    })
    expect(result).toBe("saved")
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled()
  })

  it("createSpecPR: returns dry-run URL without creating anything", async () => {
    const url = await createSpecPR({
      featureName: "onboarding",
      filePath: "specs/features/onboarding/onboarding.product.md",
      content: "# Spec",
      prTitle: "Spec: onboarding",
      prBody: "Product spec.",
    })
    expect(url).toContain("dry-run")
    expect(mockCreatePR).not.toHaveBeenCalled()
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled()
  })

  it("saveAgentFeedback: skips issue creation in dry-run", async () => {
    await saveAgentFeedback({ feedback: "Great response." })
    expect(mockCreateIssue).not.toHaveBeenCalled()
  })

  it("saveUserFeedback: skips file write in dry-run", async () => {
    await saveUserFeedback({
      timestamp: "2024-01-01T00:00:00.000Z",
      channel: "C123",
      messageTs: "1234.5678",
      rating: "positive",
      agentResponse: "response",
      userMessage: "message",
      reactingUser: "U456",
    })
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled()
  })
})
