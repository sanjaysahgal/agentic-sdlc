/**
 * Apply a section-level patch to an existing spec.
 *
 * The patch contains one or more ## sections. Each ## section in the patch
 * replaces the corresponding ## section in the existing spec (matched by heading text).
 *
 * Sub-section awareness (###): if a patch ## section contains ### sub-sections AND the
 * corresponding existing ## section also has ### sub-sections, the merge happens at the
 * ### level — only the named sub-sections in the patch are replaced; all other ### sub-sections
 * in the existing spec are preserved. This prevents a patch of "## Screens\n### Screen 2"
 * from wiping out Screen 1, Screen 3, etc.
 *
 * New ## sections (not in the existing spec) are appended at the end.
 * New ### sub-sections (not in the existing ## section) are appended within the section.
 *
 * If the existing spec is empty/blank, the patch is returned as-is (initial full save).
 */
export function applySpecPatch(existing: string, patch: string): string {
  console.log(`[PATCHER] applySpecPatch: existing=${existing.trim() ? existing.length + " chars" : "empty (initial save)"}`)
  if (!existing.trim()) return patch.trim()

  type Section = { heading: string; body: string }
  type ParsedDoc = { preamble: string; sections: Section[] }

  function splitSections(text: string, headingPrefix: string): ParsedDoc {
    const lines = text.split('\n')
    const preambleLines: string[] = []
    const sections: Section[] = []
    let current: { heading: string; bodyLines: string[] } | null = null

    for (const line of lines) {
      if (line.startsWith(headingPrefix) && !line.startsWith(headingPrefix + '#')) {
        if (current) sections.push({ heading: current.heading, body: current.bodyLines.join('\n') })
        current = { heading: line, bodyLines: [] }
      } else if (current) {
        current.bodyLines.push(line)
      } else {
        preambleLines.push(line)
      }
    }
    if (current) sections.push({ heading: current.heading, body: current.bodyLines.join('\n') })
    return { preamble: preambleLines.join('\n'), sections }
  }

  function hasSubsections(body: string): boolean {
    return body.split('\n').some(line => line.startsWith('### ') && !line.startsWith('#### '))
  }

  function mergeSubsections(existingBody: string, patchBody: string): string {
    const existingDoc = splitSections(existingBody, '### ')
    const patchDoc = splitSections(patchBody, '### ')

    const subPatchMap = new Map(patchDoc.sections.map(s => [s.heading, s.body]))
    const mergedSubs = existingDoc.sections.map(s =>
      subPatchMap.has(s.heading) ? { heading: s.heading, body: subPatchMap.get(s.heading)! } : s
    )

    const existingSubHeadings = new Set(existingDoc.sections.map(s => s.heading))
    for (const patchSub of patchDoc.sections) {
      if (!existingSubHeadings.has(patchSub.heading)) {
        mergedSubs.push(patchSub)
      }
    }

    const parts: string[] = []
    // Use patch preamble when it adds content; fall back to existing preamble
    const preamble = patchDoc.preamble.trim() ? patchDoc.preamble : existingDoc.preamble
    if (preamble.trim()) parts.push(preamble.trimEnd())
    for (const ss of mergedSubs) {
      const body = ss.body.trimEnd()
      parts.push(body ? `${ss.heading}\n${body}` : ss.heading)
    }
    return parts.join('\n\n')
  }

  const existingParsed = splitSections(existing, '## ')
  const patchParsed = splitSections(patch, '## ')

  const patchMap = new Map(patchParsed.sections.map(s => [s.heading, s.body]))

  const merged = existingParsed.sections.map(s => {
    if (!patchMap.has(s.heading)) return s

    const patchBody = patchMap.get(s.heading)!

    // Sub-section-aware merge: if both sides have ### subsections, merge at that level
    // to avoid wiping sibling subsections not mentioned in the patch.
    if (hasSubsections(s.body) && hasSubsections(patchBody)) {
      return { heading: s.heading, body: mergeSubsections(s.body, patchBody) }
    }

    // Flat section — replace body wholesale (original behavior)
    return { heading: s.heading, body: patchBody }
  })

  const existingHeadings = new Set(existingParsed.sections.map(s => s.heading))
  for (const patchSection of patchParsed.sections) {
    if (!existingHeadings.has(patchSection.heading)) {
      merged.push(patchSection)
    }
  }

  const parts: string[] = []
  if (existingParsed.preamble.trim()) parts.push(existingParsed.preamble.trimEnd())
  for (const s of merged) {
    const body = s.body.trimEnd()
    parts.push(body ? `${s.heading}\n${body}` : s.heading)
  }

  const result = parts.join('\n\n').trim()
  console.log(`[PATCHER] applySpecPatch: result=${result.length} chars (${merged.length} sections)`)
  return result
}
