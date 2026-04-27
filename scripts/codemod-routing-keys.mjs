#!/usr/bin/env node
// Phase 1 codemod — wrap first arg of conversation-store calls in featureKey()/threadKey().
// Single-use mechanical transform. After Phase 1 is committed, this script is unused
// and can be deleted (it has no role in CI). It exists in scripts/ so the codemod is
// reproducible and reviewable rather than a series of ad-hoc Edit tool calls.
//
// Usage: node scripts/codemod-routing-keys.mjs <file...>

import fs from "node:fs"

// Functions whose first arg must be wrapped in featureKey(...).
const FEATURE_KEY_FNS = [
  "getHistory",
  "appendMessage",
  "clearHistory",
  "getConfirmedAgent",
  "setConfirmedAgent",
  "clearConfirmedAgent",
  "isUserOriented",
  "markUserOriented",
  "getPendingEscalation",
  "setPendingEscalation",
  "clearPendingEscalation",
  "getPendingApproval",
  "setPendingApproval",
  "clearPendingApproval",
  "getPendingDecisionReview",
  "setPendingDecisionReview",
  "clearPendingDecisionReview",
  "getEscalationNotification",
  "setEscalationNotification",
  "clearEscalationNotification",
]

// Functions whose first arg must be wrapped in threadKey(...).
const THREAD_KEY_FNS = ["getThreadAgent", "setThreadAgent"]

// Match `<word-boundary><fn>(<arg>` where <arg> contains no commas, parens, or backticks-
// inside-paren. We reject already-wrapped args (next char after `(` matches `featureKey(`
// or `threadKey(`).
function buildPattern(fnNames) {
  const alternation = fnNames.join("|")
  // Lookbehind avoids matching `something.fnName(`-like calls that aren't conversation-store.
  // We rely on identifier boundary; if `something.getHistory(` exists in the codebase it would
  // still match — which is fine because the import-rewrite handles it (.deps wrapping is the
  // only case where this name appears as a method, and we already updated tool-handlers.ts).
  return new RegExp(`\\b(${alternation})\\(`, "g")
}

function findArgEnd(src, start) {
  // Given src[start] is the position right after the opening paren, find the index of the
  // comma or close-paren that ends the first argument, respecting nested parens, brackets,
  // braces, strings, and template literals.
  let depthParen = 0
  let depthBracket = 0
  let depthBrace = 0
  let i = start
  while (i < src.length) {
    const c = src[i]
    // strings
    if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++
        i++
      }
      i++
      continue
    }
    if (c === "`") {
      // template literal — handle ${ ... } interpolations recursively-ish
      i++
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") { i += 2; continue }
        if (src[i] === "$" && src[i + 1] === "{") {
          i += 2
          let braceDepth = 1
          while (i < src.length && braceDepth > 0) {
            if (src[i] === "{") braceDepth++
            else if (src[i] === "}") braceDepth--
            i++
          }
          continue
        }
        i++
      }
      i++
      continue
    }
    if (c === "(") { depthParen++; i++; continue }
    if (c === "[") { depthBracket++; i++; continue }
    if (c === "{") { depthBrace++; i++; continue }
    if (c === ")") {
      if (depthParen === 0) return i
      depthParen--
      i++
      continue
    }
    if (c === "]") { depthBracket--; i++; continue }
    if (c === "}") { depthBrace--; i++; continue }
    if (c === "," && depthParen === 0 && depthBracket === 0 && depthBrace === 0) return i
    i++
  }
  return -1
}

function alreadyWrapped(arg) {
  const trimmed = arg.trim()
  return trimmed.startsWith("featureKey(") || trimmed.startsWith("threadKey(")
}

function wrapArgs(src, fnNames, wrapper) {
  const pattern = buildPattern(fnNames)
  let result = ""
  let lastIndex = 0
  let match
  while ((match = pattern.exec(src)) !== null) {
    const callStart = match.index
    const argStart = match.index + match[0].length
    const argEnd = findArgEnd(src, argStart)
    if (argEnd === -1) continue
    const arg = src.slice(argStart, argEnd)
    if (alreadyWrapped(arg)) continue
    // Keep whitespace prefix outside the wrap so style is preserved.
    const lead = arg.match(/^\s*/)[0]
    const trail = arg.match(/\s*$/)[0]
    const inner = arg.slice(lead.length, arg.length - trail.length)
    if (inner === "") continue
    const replacement = `${lead}${wrapper}(${inner})${trail}`
    result += src.slice(lastIndex, argStart) + replacement
    lastIndex = argEnd
  }
  result += src.slice(lastIndex)
  return result
}

function ensureImport(src, importNames, modulePath) {
  // If any of these names is already imported from this module path, do nothing.
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  const importLineRegex = new RegExp(
    `import\\s*\\{[^}]*\\}\\s*from\\s*["'](${escapedPath})["']`,
  )
  if (importLineRegex.test(src)) {
    // Augment existing import block with missing names.
    return src.replace(
      new RegExp(`(import\\s*\\{)([^}]*)(\\}\\s*from\\s*["']${escapedPath}["'])`),
      (_, open, body, close) => {
        const existing = new Set(body.split(",").map((s) => s.trim()).filter(Boolean))
        let changed = false
        for (const name of importNames) {
          if (!existing.has(name)) {
            existing.add(name)
            changed = true
          }
        }
        if (!changed) return _
        return `${open} ${[...existing].join(", ")} ${close}`
      },
    )
  }
  // Otherwise add a fresh import after the last existing import line.
  const importBlock = src.match(/(?:^|\n)(import [^\n]*\n)+/g)
  const newImport = `import { ${importNames.join(", ")} } from "${modulePath}"\n`
  if (!importBlock || importBlock.length === 0) {
    return newImport + src
  }
  const lastImports = importBlock[importBlock.length - 1]
  const insertAt = src.lastIndexOf(lastImports) + lastImports.length
  return src.slice(0, insertAt) + newImport + src.slice(insertAt)
}

function processFile(filePath) {
  const original = fs.readFileSync(filePath, "utf-8")
  let src = original
  src = wrapArgs(src, FEATURE_KEY_FNS, "featureKey")
  src = wrapArgs(src, THREAD_KEY_FNS, "threadKey")
  if (src === original) return false
  // Determine which wrappers are now used.
  const needsFeatureKey = /\bfeatureKey\(/.test(src) && !/\bfeatureKey\b\s*[,}]/.test(src)
  const needsThreadKey = /\bthreadKey\(/.test(src) && !/\bthreadKey\b\s*[,}]/.test(src)
  const importsToAdd = []
  if (needsFeatureKey) importsToAdd.push("featureKey")
  if (needsThreadKey) importsToAdd.push("threadKey")
  if (importsToAdd.length > 0) {
    // Compute relative path to runtime/routing/types from the file's directory.
    const relativeDir = filePath
      .replace(/^.*?\/agentic-sdlc\//, "")
      .replace(/\/[^\/]+$/, "")
    const depth = relativeDir.split("/").length
    const upDots = "../".repeat(depth)
    const modulePath = `${upDots}runtime/routing/types`
    src = ensureImport(src, importsToAdd, modulePath)
  }
  fs.writeFileSync(filePath, src)
  return true
}

const files = process.argv.slice(2)
let changed = 0
for (const file of files) {
  if (processFile(file)) {
    changed++
    console.log(`changed ${file}`)
  }
}
console.log(`\n${changed} of ${files.length} files modified`)
