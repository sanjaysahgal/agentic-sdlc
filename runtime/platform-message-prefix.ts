/**
 * @deterministic — single-source-of-truth prefix for platform-composed Slack
 * messages. Manifest item B10 (regression catalog bug #17).
 *
 * Why this exists:
 * Some platform-composed `client.chat.postMessage` calls used an agent-name
 * static prefix like `*Product Manager* — …` while the body referenced that
 * same agent in third person ("the PM agent", "bring the PM back"). Voice
 * mismatch — the prefix suggested the agent said it; the body talked about
 * the agent. Readers couldn't tell whether the platform or the agent was
 * speaking.
 *
 * Fix: every platform-composed notification uses this neutral prefix.
 * The platform speaks AS the platform, in the platform's voice, never as
 * any of its agents. Agent-name prefixes are reserved for `${mention}`
 * (Slack `<@U…>` ping or text-fallback role label addressing the human
 * role-holder) — those are addressing a person, not impersonating an agent.
 *
 * The cross-agent invariant test pins this contract: no platform postMessage
 * may use an agent-name string as a static text prefix. Adding a new
 * platform notification requires using `PLATFORM_MESSAGE_PREFIX` (or
 * `${mention}` when the message is addressing the human role-holder).
 */

export const PLATFORM_MESSAGE_PREFIX = "*Platform —*"

/**
 * The marker substring used by the structural invariant. Kept stable so
 * cosmetic re-wording of the prefix doesn't break the invariant; only
 * renaming this marker does. If you change the marker, update the invariant
 * test in lockstep.
 */
export const PLATFORM_PREFIX_MARKER = "*Platform —*"

/**
 * Forbidden agent-name static prefixes. Any platform postMessage text that
 * starts with one of these strings (without a Slack `<@U…>` mention prefix)
 * is impersonating an agent the platform is not. Used by the invariant test.
 */
export const FORBIDDEN_AGENT_PREFIXES: readonly string[] = [
  "*Product Manager*",
  "*PM*",
  "*UX Designer*",
  "*Designer*",
  "*Architect*",
] as const
