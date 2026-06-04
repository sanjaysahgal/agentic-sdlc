// G6 — outbound Slack message logging.
//
// Wraps a Slack WebClient so every `chat.postMessage` and `chat.update`
// call emits a structured `[OUTBOUND]` log line with full content +
// channel + thread. Surfaced during Step 2a verification (observation
// #18/#22): the platform's prior logging captured state mutations and
// truncated agent-response previews, but NOT the actual outbound
// message text. This made MT inspection operator-paste-dependent, and
// made Principle 17 cross-surface consistency structurally unverifiable
// from logs alone.
//
// Design: instrument the existing client in-place (single point at app
// boundary); every code path that already calls `client.chat.postMessage`
// or `client.chat.update` automatically gets logged. No call-site edits
// required, no legacy-handler edits required (Principle 18-friendly).

import type { WebClient, ChatPostMessageArguments, ChatUpdateArguments } from "@slack/web-api"

// Cap to avoid catastrophic log bloat on malformed huge payloads.
// 100k chars is far above any real Slack message (Slack's hard limit
// is ~3,800 per message; we split at that boundary in `splitForSlack`).
// Truncation is logged with a flag so operators know it happened.
const MAX_LOG_TEXT_LENGTH = 100_000

function truncate(text: string | undefined): { content: string; truncated: boolean } {
  if (!text) return { content: "", truncated: false }
  if (text.length <= MAX_LOG_TEXT_LENGTH) return { content: text, truncated: false }
  return { content: text.slice(0, MAX_LOG_TEXT_LENGTH) + "[…truncated]", truncated: true }
}

export function logOutbound(
  method: "postMessage" | "update",
  args: ChatPostMessageArguments | ChatUpdateArguments,
): void {
  const channel = (args as { channel?: string }).channel ?? "?"
  const thread = (args as { thread_ts?: string }).thread_ts ?? "—"
  const ts = method === "update" ? ((args as { ts?: string }).ts ?? "—") : null
  const rawText: string = (args as { text?: string }).text ?? ""
  const { content, truncated } = truncate(rawText)
  const tsField = ts !== null ? ` ts=${ts}` : ""
  const truncField = truncated ? " truncated=true" : ""
  // The full content is appended on a new line so the line-prefix is greppable
  // (`grep '[OUTBOUND]' logs/bot-*.log` returns the metadata; multiline-aware
  // tools see the body).
  console.log(`[OUTBOUND] method=${method} channel=${channel} thread=${thread}${tsField} text_chars=${rawText.length}${truncField}\n${content}`)
}

// Idempotency marker — prevents double-wrapping when the same client is
// instrumented twice (e.g. via Bolt middleware that fires per-event AND
// against `app.client` directly). Without this, the second call would wrap
// the already-wrapped function, producing two `[OUTBOUND]` lines per call.
const G6_INSTRUMENTED = Symbol.for("G6_INSTRUMENTED")

export function instrumentSlackClient(client: WebClient): void {
  // B32 — per Step 2a observation #41: the prior single-call instrumentation
  // at `app.client` boundary did not cover Bolt's per-event clients (each
  // handler receives a distinct WebClient instance with proper auth/retry
  // context — `app.client` is never the object used to post from handlers).
  // Fix: the Bolt middleware in `interfaces/slack/app.ts` now calls this
  // function on every event's `args.client`, so every outbound is captured.
  // Idempotent — safe to call multiple times on the same client.
  if ((client as unknown as Record<symbol, boolean>)[G6_INSTRUMENTED]) return
  ;(client as unknown as Record<symbol, boolean>)[G6_INSTRUMENTED] = true

  const origPost = client.chat.postMessage.bind(client.chat)
  const origUpdate = client.chat.update.bind(client.chat)

  // Method reassignment via `as any` because the SDK types are readonly-typed
  // for these methods. Behavior is identical: log first, then delegate to the
  // original implementation. If the original throws, the log line is still
  // written (the attempt is recorded).
  ;(client.chat as unknown as { postMessage: typeof origPost }).postMessage = async (
    args: ChatPostMessageArguments,
  ) => {
    logOutbound("postMessage", args)
    return origPost(args)
  }

  ;(client.chat as unknown as { update: typeof origUpdate }).update = async (
    args: ChatUpdateArguments,
  ) => {
    logOutbound("update", args)
    return origUpdate(args)
  }
}
