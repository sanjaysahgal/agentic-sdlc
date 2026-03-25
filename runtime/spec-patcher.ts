/**
 * Apply a section-level patch to an existing spec.
 *
 * The patch contains one or more ## sections. Each section in the patch
 * replaces the corresponding section in the existing spec (matched by heading text).
 * New sections (not in the existing spec) are appended at the end.
 *
 * If the existing spec is empty/blank, the patch is returned as-is (initial full save).
 */
export function applySpecPatch(existing: string, patch: string): string {
  if (!existing.trim()) return patch.trim()

  function split(text: string): { preamble: string; sections: Array<{ heading: string; body: string }> } {
    const lines = text.split('\n')
    const preambleLines: string[] = []
    const sections: Array<{ heading: string; body: string }> = []
    let current: { heading: string; bodyLines: string[] } | null = null

    for (const line of lines) {
      if (line.startsWith('## ')) {
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

  const existingParsed = split(existing)
  const patchParsed = split(patch)

  const patchMap = new Map(patchParsed.sections.map(s => [s.heading, s.body]))

  const merged = existingParsed.sections.map(s =>
    patchMap.has(s.heading) ? { heading: s.heading, body: patchMap.get(s.heading)! } : s
  )

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

  return parts.join('\n\n').trim()
}
