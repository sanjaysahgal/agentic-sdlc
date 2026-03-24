import { describe, it, expect, vi, beforeEach } from "vitest"

// github-client.ts runs `new Octokit()` and `loadWorkspaceConfig()` at module load.
// vi.mock() factories are hoisted above module-level code, so top-level `const mockFn = vi.fn()`
// would be undefined when the factory runs. Use vi.hoisted() to create variables
// that are available at factory execution time.
const { mockGetContent, mockGetRef, mockCreateRef, mockCreateOrUpdateFileContents, mockPaginate, mockListBranches } =
  vi.hoisted(() => ({
    mockGetContent: vi.fn(),
    mockGetRef: vi.fn(),
    mockCreateRef: vi.fn(),
    mockCreateOrUpdateFileContents: vi.fn(),
    mockPaginate: vi.fn(),
    mockListBranches: vi.fn(),
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

import { readFile, saveDraftSpec, saveApprovedSpec, getInProgressFeatures, listSubdirectories, saveDraftEngineeringSpec, saveApprovedEngineeringSpec } from "../../runtime/github-client"

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
