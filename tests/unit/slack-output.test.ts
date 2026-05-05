// G6 unit tests — outbound Slack message logging.
//
// Verifies: (1) `logOutbound` emits the [OUTBOUND] format with full content
// preserved up to the truncation cap; (2) `instrumentSlackClient` mutates
// the chat.postMessage and chat.update methods so every call logs first
// then delegates; (3) original SDK behavior is preserved (return value,
// args passed through unchanged); (4) truncation happens at the cap with
// the truncated flag set.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logOutbound, instrumentSlackClient } from "../../runtime/slack-output"

describe("G6 — slack-output (outbound logging)", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
  })

  describe("logOutbound", () => {
    it("emits [OUTBOUND] line for chat.postMessage with channel + thread + text_chars + body", () => {
      logOutbound("postMessage", {
        channel: "C123",
        thread_ts: "1234.5678",
        text: "hello world",
      })
      const calls = consoleLogSpy.mock.calls
      expect(calls.length).toBe(1)
      const out = calls[0][0] as string
      expect(out).toMatch(/^\[OUTBOUND\] method=postMessage channel=C123 thread=1234\.5678 text_chars=11/)
      expect(out).toContain("hello world")
    })

    it("emits ts= field for chat.update (since update targets a specific message ts)", () => {
      logOutbound("update", {
        channel: "C123",
        ts: "9999.0001",
        text: "edited content",
      })
      const out = consoleLogSpy.mock.calls[0][0] as string
      expect(out).toContain("method=update")
      expect(out).toContain("ts=9999.0001")
      expect(out).toContain("edited content")
    })

    it("renders thread=— when no thread_ts provided", () => {
      logOutbound("postMessage", { channel: "C1", text: "no thread" })
      const out = consoleLogSpy.mock.calls[0][0] as string
      expect(out).toContain("thread=—")
    })

    it("renders channel=? when no channel provided (defensive)", () => {
      logOutbound("postMessage", { text: "no channel" } as never)
      const out = consoleLogSpy.mock.calls[0][0] as string
      expect(out).toContain("channel=?")
    })

    it("renders empty text as text_chars=0 with empty body", () => {
      logOutbound("postMessage", { channel: "C1", text: "" })
      const out = consoleLogSpy.mock.calls[0][0] as string
      expect(out).toMatch(/text_chars=0(\s|$)/)
    })

    it("preserves full text up to MAX_LOG_TEXT_LENGTH (no truncation under the cap)", () => {
      const text = "x".repeat(50_000)
      logOutbound("postMessage", { channel: "C1", text })
      const out = consoleLogSpy.mock.calls[0][0] as string
      expect(out).not.toContain("truncated=true")
      expect(out).toContain(text)
    })

    it("truncates text exceeding MAX_LOG_TEXT_LENGTH with the truncated flag", () => {
      const text = "y".repeat(150_000)
      logOutbound("postMessage", { channel: "C1", text })
      const out = consoleLogSpy.mock.calls[0][0] as string
      expect(out).toContain("truncated=true")
      expect(out).toContain("[…truncated]")
      // text_chars reports the ORIGINAL length, not the truncated length
      expect(out).toContain("text_chars=150000")
    })
  })

  describe("instrumentSlackClient", () => {
    function fakeClient() {
      const calls: Array<{ method: string; args: unknown }> = []
      const client = {
        chat: {
          postMessage: vi.fn(async (args: unknown) => {
            calls.push({ method: "postMessage", args })
            return { ok: true, ts: "post-1" }
          }),
          update: vi.fn(async (args: unknown) => {
            calls.push({ method: "update", args })
            return { ok: true, ts: "update-1" }
          }),
        },
      }
      return { client, calls }
    }

    it("logs [OUTBOUND] then delegates to the original chat.postMessage", async () => {
      const { client, calls } = fakeClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instrumentSlackClient(client as any)

      const result = await client.chat.postMessage({
        channel: "C42",
        thread_ts: "1.1",
        text: "round-trip",
      } as never)

      // [OUTBOUND] log line emitted exactly once
      expect(consoleLogSpy.mock.calls.length).toBe(1)
      expect(consoleLogSpy.mock.calls[0][0]).toContain("[OUTBOUND] method=postMessage")
      expect(consoleLogSpy.mock.calls[0][0]).toContain("round-trip")

      // Original method still called with same args; return value passed through
      expect(calls.length).toBe(1)
      expect(calls[0]).toEqual({
        method: "postMessage",
        args: { channel: "C42", thread_ts: "1.1", text: "round-trip" },
      })
      expect(result).toEqual({ ok: true, ts: "post-1" })
    })

    it("logs [OUTBOUND] then delegates to the original chat.update", async () => {
      const { client, calls } = fakeClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instrumentSlackClient(client as any)

      const result = await client.chat.update({
        channel: "C42",
        ts: "9.9",
        text: "edit-it",
      } as never)

      expect(consoleLogSpy.mock.calls.length).toBe(1)
      expect(consoleLogSpy.mock.calls[0][0]).toContain("[OUTBOUND] method=update")
      expect(consoleLogSpy.mock.calls[0][0]).toContain("ts=9.9")
      expect(consoleLogSpy.mock.calls[0][0]).toContain("edit-it")

      expect(calls.length).toBe(1)
      expect(calls[0]).toEqual({ method: "update", args: { channel: "C42", ts: "9.9", text: "edit-it" } })
      expect(result).toEqual({ ok: true, ts: "update-1" })
    })

    it("logs every call (no de-dup) — fires once per outbound message", async () => {
      const { client } = fakeClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instrumentSlackClient(client as any)

      await client.chat.postMessage({ channel: "C1", text: "first" } as never)
      await client.chat.postMessage({ channel: "C1", text: "second" } as never)
      await client.chat.update({ channel: "C1", ts: "x", text: "third" } as never)

      expect(consoleLogSpy.mock.calls.length).toBe(3)
      expect(consoleLogSpy.mock.calls[0][0]).toContain("first")
      expect(consoleLogSpy.mock.calls[1][0]).toContain("second")
      expect(consoleLogSpy.mock.calls[2][0]).toContain("third")
    })

    it("instrumenting a client twice produces two log lines per call (idempotency caveat documented)", async () => {
      // Calling instrumentSlackClient twice on the same client double-wraps —
      // each call would log twice. App boot calls it once; if anyone re-calls
      // it (e.g., during tests or a hot-reload), they'll see the doubling.
      // This test pins the behavior so any future change to make it idempotent
      // is a deliberate choice.
      const { client } = fakeClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instrumentSlackClient(client as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instrumentSlackClient(client as any)

      await client.chat.postMessage({ channel: "C1", text: "double" } as never)
      expect(consoleLogSpy.mock.calls.length).toBe(2)
    })
  })
})
