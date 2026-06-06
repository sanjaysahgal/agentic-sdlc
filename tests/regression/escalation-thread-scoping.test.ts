import { describe, it, expect, vi, beforeEach } from "vitest"
import { featureKey, threadKey } from "../../runtime/routing/types"

/**
 * B30 — regression catalog bug #21.
 *
 * Step 2a observation #40: `escalationNotification` and `pendingEscalation`
 * were keyed by feature only, so opening a new thread in the same feature
 * channel routed through the stale state from another thread. Net effect:
 * user opens fresh thread expecting clean state, bot still hits the
 * arch-upstream-continuation branch for the prior thread's escalation;
 * stuck-state blast radius was channel-wide.
 *
 * Fix: state maps now keyed by composite `${featureKey}:${threadKey}`. State
 * set in thread A is invisible to a getter that passes thread B.
 */

// fsMocks pattern — disable file persistence to avoid touching production state files.
vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => { throw new Error("ENOENT") }),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    promises: { writeFile: vi.fn(), mkdir: vi.fn() },
  },
  readFileSync: vi.fn(() => { throw new Error("ENOENT") }),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}))

describe("bug #21 — escalation state is thread-scoped per (feature, thread) composite key", () => {
  beforeEach(async () => {
    const { disableFilePersistence } = await import("../../runtime/conversation-store")
    disableFilePersistence()
  })

  it("setPendingEscalation in thread A is NOT readable by getPendingEscalation in thread B", async () => {
    const { setPendingEscalation, getPendingEscalation, clearPendingEscalation } = await import("../../runtime/conversation-store")
    const fk = featureKey("isolated-feature")
    const threadA = threadKey("thread-a-1234")
    const threadB = threadKey("thread-b-5678")

    setPendingEscalation(fk, threadA, {
      targetAgent: "pm",
      originAgent: "architect",
      question: "thread A's escalation question",
      designContext: "",
    })

    // Thread A sees its own state.
    const fromA = getPendingEscalation(fk, threadA)
    expect(fromA).not.toBeNull()
    expect(fromA!.question).toBe("thread A's escalation question")

    // Thread B sees NOTHING — escalation state does not leak across threads.
    const fromB = getPendingEscalation(fk, threadB)
    expect(fromB).toBeNull()

    clearPendingEscalation(fk, threadA)
    expect(getPendingEscalation(fk, threadA)).toBeNull()
  })

  it("setEscalationNotification in thread A is NOT readable by getEscalationNotification in thread B", async () => {
    const { setEscalationNotification, getEscalationNotification, clearEscalationNotification } = await import("../../runtime/conversation-store")
    const fk = featureKey("isolated-feature-2")
    const threadA = threadKey("thread-a-9999")
    const threadB = threadKey("thread-b-0000")

    setEscalationNotification(fk, threadA, {
      targetAgent: "pm",
      question: "thread A's notification",
      originAgent: "design",
    })

    expect(getEscalationNotification(fk, threadA)).not.toBeNull()
    expect(getEscalationNotification(fk, threadB)).toBeNull()

    clearEscalationNotification(fk, threadA)
    expect(getEscalationNotification(fk, threadA)).toBeNull()
  })

  it("clearPendingEscalation in thread A does NOT clear thread B's state", async () => {
    const { setPendingEscalation, getPendingEscalation, clearPendingEscalation } = await import("../../runtime/conversation-store")
    const fk = featureKey("isolated-feature-3")
    const threadA = threadKey("thread-a-aaa")
    const threadB = threadKey("thread-b-bbb")

    setPendingEscalation(fk, threadA, { targetAgent: "pm", originAgent: "architect", question: "qA", designContext: "" })
    setPendingEscalation(fk, threadB, { targetAgent: "pm", originAgent: "architect", question: "qB", designContext: "" })

    clearPendingEscalation(fk, threadA)
    expect(getPendingEscalation(fk, threadA)).toBeNull()
    // Thread B's state survives — clears are thread-scoped.
    expect(getPendingEscalation(fk, threadB)?.question).toBe("qB")

    clearPendingEscalation(fk, threadB)
  })

  it("getAnyPendingEscalationForFeature returns any thread's state (used by V2 shadow snapshot)", async () => {
    const { setPendingEscalation, getAnyPendingEscalationForFeature, clearPendingEscalation } = await import("../../runtime/conversation-store")
    const fk = featureKey("isolated-feature-4")
    const threadA = threadKey("thread-a-cross-1")

    setPendingEscalation(fk, threadA, { targetAgent: "pm", originAgent: "architect", question: "qA", designContext: "" })
    // V2 layer doesn't have per-thread context yet — uses the feature-level reader.
    expect(getAnyPendingEscalationForFeature(fk)?.question).toBe("qA")

    clearPendingEscalation(fk, threadA)
  })

  it("clearAllEscalationStateForFeature clears every thread for the feature (test setup helper)", async () => {
    const { setPendingEscalation, setEscalationNotification, clearAllEscalationStateForFeature, getPendingEscalation, getEscalationNotification } = await import("../../runtime/conversation-store")
    const fk = featureKey("isolated-feature-5")
    const threadA = threadKey("thread-a-x")
    const threadB = threadKey("thread-b-y")

    setPendingEscalation(fk, threadA, { targetAgent: "pm", originAgent: "architect", question: "qA", designContext: "" })
    setPendingEscalation(fk, threadB, { targetAgent: "pm", originAgent: "architect", question: "qB", designContext: "" })
    setEscalationNotification(fk, threadA, { targetAgent: "pm", question: "nA", originAgent: "design" })

    clearAllEscalationStateForFeature(fk)
    expect(getPendingEscalation(fk, threadA)).toBeNull()
    expect(getPendingEscalation(fk, threadB)).toBeNull()
    expect(getEscalationNotification(fk, threadA)).toBeNull()
  })

  it("structural assertion: state-file legacy entries (no `:` in key) are lifted to `feature:legacy` synthetic slot on startup", async () => {
    // Pin the migration contract in the source so future refactors don't drop it.
    // Use vi.importActual to bypass the fs mock that's active for the other tests.
    const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs")
    const path = await import("node:path")
    const source = fsActual.readFileSync(path.resolve(__dirname, "..", "..", "runtime/conversation-store.ts"), "utf8")
    expect(source).toMatch(/migrateEscalationStateToThreadScoped/)
    expect(source).toMatch(/LEGACY_THREAD_SUFFIX\s*=\s*["']legacy["']/)
    // The migration runs on startup.
    expect(source).toMatch(/migrateEscalationStateToThreadScoped\(\)/)
  })
})
