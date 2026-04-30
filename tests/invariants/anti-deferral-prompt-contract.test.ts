import { describe, expect, it } from "vitest"

import { buildPmSystemPrompt } from "../../agents/pm"
import { buildDesignSystemPrompt } from "../../agents/design"
import { buildArchitectSystemPrompt } from "../../agents/architect"
import {
  ANTI_DEFERRAL_BLOCK_MARKER,
  DEFERRAL_PHRASES,
} from "../../runtime/deterministic-auditor"
import type { AgentContext } from "../../runtime/context-loader"

/**
 * Block N (option 3) cross-agent contract per CLAUDE.md Principle 15.
 * The "never defer to the user" prohibition is the kind of rule that must
 * exist in every analogous path: if PM, Designer, and Architect prompts
 * don't all carry the same forbidden-phrase list, drift between agents is
 * structurally guaranteed. This test asserts all three prompt builders
 * inject `ANTI_DEFERRAL_BLOCK_MARKER` and that every DEFERRAL_PHRASES
 * entry appears verbatim in the rendered prompt — same phrases the runtime
 * `enforceNoHedging` gate rewrites.
 *
 * When a new agent is added, this test must be extended to include it.
 * The test importing fails at build time if `ANTI_DEFERRAL_BLOCK_MARKER`
 * is renamed or removed — that's the structural anchor.
 */

const STUB_CONTEXT: AgentContext = {
  productVision:        "stub",
  featureConventions:   "stub",
  systemArchitecture:   "stub",
  currentDraft:         "",
  approvedFeatureSpecs: "",
  designSystem:         "stub",
  brand:                "stub",
}

const FEATURE = "stub-feature"

interface AgentPromptBuilder {
  name:    string
  build:   () => string
}

const BUILDERS: AgentPromptBuilder[] = [
  { name: "PM",        build: () => buildPmSystemPrompt(STUB_CONTEXT, FEATURE)        },
  { name: "Designer",  build: () => buildDesignSystemPrompt(STUB_CONTEXT, FEATURE)    },
  { name: "Architect", build: () => buildArchitectSystemPrompt(STUB_CONTEXT, FEATURE) },
]

describe("anti-deferral block — cross-agent prompt contract (Block N option 3)", () => {
  describe.each(BUILDERS)("$name agent prompt", ({ build }) => {
    const prompt = build()

    it("includes ANTI_DEFERRAL_BLOCK_MARKER", () => {
      expect(prompt).toContain(ANTI_DEFERRAL_BLOCK_MARKER)
    })

    it.each(DEFERRAL_PHRASES.map((p) => [p]))("lists deferral phrase: %s", (phrase) => {
      // The phrase must appear in the rendered prompt — quoted by the block builder.
      expect(prompt).toContain(`"${phrase}"`)
    })
  })
})
