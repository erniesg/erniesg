import matter from 'gray-matter'
import { assertLockedRegionsPreserved as assertLocked } from './locked-regions.mjs'

const TRANSLATABLE_FRONTMATTER_KEYS = new Set(['title', 'description'])
const TRANSLATABLE_ATTRS = new Set(['title', 'alt', 'aria-label'])
const INLINE_PROTECTED_RE = /`[^`\n]+`|!?\[[^\]]+\]\([^)]+\)|<[^>\n]+>/g
const CONTEXTUAL_PROTECTED_RE = /`[^`\n]+`|(?<=\]\()[^)]+(?=\))/g

function nextId(index) {
  return `s${String(index + 1).padStart(4, '0')}`
}

function addSegment(segments, kind, sourceText, start, end, meta = {}) {
  if (!sourceText || sourceText.trim() === '') return
  if (/^https?:\/\//.test(sourceText.trim())) return
  segments.push({
    id: nextId(segments.length),
    kind,
    sourceText,
    start,
    end,
    ...meta,
  })
}

function frontmatterRange(raw, key) {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return null
  const header = raw.slice(4, end)
  const regex = new RegExp(`(^|\\n)(${key}:\\s*)([^\\n]*)`, 'm')
  const match = header.match(regex)
  if (!match) return null
  const lineStart = 4 + match.index + (match[1] ? match[1].length : 0)
  const scalarStart = lineStart + match[2].length
  let scalarEnd = scalarStart + match[3].trimEnd().length
  if (/^[>|][+-]?(?:\s+#.*)?$/.test(match[3].trim())) {
    const firstLineEnd = raw.indexOf('\n', scalarStart)
    scalarEnd = firstLineEnd === -1 ? end : firstLineEnd
    let cursor = scalarEnd + 1
    while (cursor < end) {
      const nextLineEnd = raw.indexOf('\n', cursor)
      const lineEnd = nextLineEnd === -1 ? end : Math.min(nextLineEnd, end)
      const line = raw.slice(cursor, lineEnd)
      if (line && !/^[ \t]/.test(line)) break
      scalarEnd = lineEnd
      cursor = lineEnd + 1
    }
  }
  const value = matter(raw).data?.[key]
  if (typeof value !== 'string') return null
  return { start: scalarStart, end: scalarEnd, value }
}

function bodyStartOffset(raw) {
  if (!raw.startsWith('---\n')) return 0
  const end = raw.indexOf('\n---', 4)
  return end === -1 ? 0 : end + '\n---'.length
}

function pushMarkdownLineSegments(segments, line, lineStart) {
  const trimmed = line.trim()
  if (!trimmed) return
  if (/^(?:import|export)\s/.test(trimmed)) return

  if (
    /^<\/?[A-Z][\w.:-]*/.test(trimmed) ||
    /^<\/?[a-z][\w.:-]*/.test(trimmed)
  ) {
    pushHtmlAttributeSegments(segments, line, lineStart)
    pushInlineTextSegments(segments, line, lineStart, {
      kind: 'html-text',
    })
    return
  }

  const heading = line.match(/^(\s{0,3}#{1,6}\s+)(.+)$/)
  if (heading) {
    pushContextualMarkdownSegment(segments, line, lineStart, {
      kind: 'markdown-heading',
      prefixLength: heading[1].length,
    })
    return
  }

  if (
    /^[-*+]\s+\[[ x]\]/.test(trimmed) ||
    /^[-*+]\s+/.test(trimmed) ||
    /^\d+\.\s+/.test(trimmed)
  ) {
    const prefix =
      line.match(/^(\s*(?:[-*+]|\d+\.)\s+(?:\[[ x]\]\s*)?)/)?.[1] ?? ''
    pushContextualMarkdownSegment(segments, line, lineStart, {
      kind: 'markdown-list-item',
      prefixLength: prefix.length,
    })
    return
  }

  const blockquotePrefix = line.match(/^(\s{0,3}(?:>\s*)+)/)?.[1] ?? ''
  if (/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(line)) {
    pushContextualMarkdownSegment(segments, line, lineStart, {
      kind: blockquotePrefix ? 'markdown-blockquote' : 'markdown-paragraph',
      prefixLength: blockquotePrefix.length,
    })
  }
}

function pushContextualMarkdownSegment(
  segments,
  line,
  lineStart,
  { kind, prefixLength = 0 },
) {
  if (/<[^>\n]+>/.test(line.slice(prefixLength))) {
    pushHtmlAttributeSegments(segments, line, lineStart)
    pushInlineTextSegments(segments, line, lineStart, { kind, prefixLength })
    return
  }

  let start = prefixLength
  let end = line.length
  while (start < end && /\s/.test(line[start])) start += 1
  while (end > start && /\s/.test(line[end - 1])) end -= 1
  if (start === end) return

  const protectedTokens = []
  const sourceText = line
    .slice(start, end)
    .replace(CONTEXTUAL_PROTECTED_RE, (value) => {
      const token = `⟪LOCKED_${String(protectedTokens.length + 1).padStart(4, '0')}⟫`
      protectedTokens.push({ token, value })
      return token
    })
  addSegment(segments, kind, sourceText, lineStart + start, lineStart + end, {
    protectedTokens,
  })
}

function pushInlineTextSegments(
  segments,
  line,
  lineStart,
  { kind, prefixLength = 0 },
) {
  const ranges = [...line.matchAll(INLINE_PROTECTED_RE)]
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }))
    .filter((range) => range.end > prefixLength)
  let cursor = prefixLength

  for (const range of ranges) {
    if (range.start > cursor) {
      pushTextRange(segments, kind, line, lineStart, cursor, range.start)
    }
    cursor = Math.max(cursor, range.end)
  }
  if (cursor < line.length) {
    pushTextRange(segments, kind, line, lineStart, cursor, line.length)
  }
}

function pushTextRange(segments, kind, line, lineStart, start, end) {
  while (start < end && /\s/.test(line[start])) start += 1
  while (end > start && /\s/.test(line[end - 1])) end -= 1
  const sourceText = line.slice(start, end)
  if (!/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(sourceText)) {
    return
  }
  addSegment(segments, kind, sourceText, lineStart + start, lineStart + end)
}

function pushHtmlAttributeSegments(segments, line, lineStart) {
  const regex = /\b(title|alt|aria-label)=["']([^"']+)["']/g
  for (const match of line.matchAll(regex)) {
    if (!TRANSLATABLE_ATTRS.has(match[1])) continue
    const valueStart = lineStart + match.index + match[0].indexOf(match[2])
    addSegment(
      segments,
      `html-${match[1]}`,
      match[2],
      valueStart,
      valueStart + match[2].length,
    )
  }
}

export function extractSegments(raw) {
  const segments = []

  if (raw.startsWith('---\n')) {
    for (const key of TRANSLATABLE_FRONTMATTER_KEYS) {
      const range = frontmatterRange(raw, key)
      if (range) {
        addSegment(
          segments,
          `frontmatter-${key}`,
          range.value,
          range.start,
          range.end,
          { frontmatterKey: key, yamlScalar: true },
        )
      }
    }
  } else {
    try {
      const parsed = matter(raw)
      for (const key of TRANSLATABLE_FRONTMATTER_KEYS) {
        if (typeof parsed.data?.[key] === 'string') {
          addSegment(segments, `frontmatter-${key}`, parsed.data[key], 0, 0, {
            frontmatterKey: key,
            unsafeRange: true,
          })
        }
      }
    } catch {
      // MDX without parseable frontmatter is still handled line by line below.
    }
  }

  const bodyStart = bodyStartOffset(raw)
  let inFence = false
  let offset = 0
  for (const lineWithBreak of raw.matchAll(/[^\n]*(?:\n|$)/g)) {
    const chunk = lineWithBreak[0]
    if (chunk === '') continue
    const line = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk
    const lineStart = offset
    offset += chunk.length
    if (lineStart < bodyStart) continue

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    pushMarkdownLineSegments(segments, line, lineStart)
  }

  return segments
}

export function applySegmentTranslations(raw, translationsById) {
  const segments = extractSegments(raw)
  const replacements = []

  for (const segment of segments) {
    if (!Object.hasOwn(translationsById, segment.id)) continue
    if (segment.unsafeRange) {
      throw new Error(
        `Segment ${segment.id} does not have a safe source range.`,
      )
    }
    let translatedText = String(translationsById[segment.id])
    for (const { token, value } of segment.protectedTokens ?? []) {
      const occurrences = translatedText.split(token).length - 1
      if (occurrences !== 1) {
        throw new Error(
          `Segment ${segment.id} must preserve placeholder ${token} exactly once.`,
        )
      }
      translatedText = translatedText.replace(token, value)
    }
    if (segment.yamlScalar) translatedText = JSON.stringify(translatedText)
    replacements.push({
      start: segment.start,
      end: segment.end,
      text: translatedText,
      id: segment.id,
    })
  }

  let output = raw
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output =
      output.slice(0, replacement.start) +
      replacement.text +
      output.slice(replacement.end)
  }

  assertLocked(raw, output)
  return output
}

export function assertLockedRegionsPreserved(source, output) {
  return assertLocked(source, output)
}
