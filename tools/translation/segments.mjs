import matter from 'gray-matter'
import { assertLockedRegionsPreserved as assertLocked } from './locked-regions.mjs'

const TRANSLATABLE_FRONTMATTER_KEYS = new Set(['title', 'description'])
const TRANSLATABLE_ATTRS = new Set(['title', 'alt', 'aria-label'])

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
  const regex = new RegExp(`(^|\\n)(${key}:\\s*)(["']?)([^"'\\n]*)(\\3)`, 'm')
  const match = header.match(regex)
  if (!match) return null
  const lineStart = 4 + match.index + (match[1] ? match[1].length : 0)
  const valueStart = lineStart + match[2].length + match[3].length
  const valueEnd = valueStart + match[4].length
  return { start: valueStart, end: valueEnd, value: match[4] }
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
  if (/^<\/?[A-Z][\w.:-]*/.test(trimmed) || /^<\/?[a-z][\w.:-]*/.test(trimmed)) {
    pushHtmlAttributeSegments(segments, line, lineStart)
    return
  }

  const heading = line.match(/^(\s{0,3}#{1,6}\s+)(.+)$/)
  if (heading) {
    const start = lineStart + heading[1].length
    addSegment(
      segments,
      'markdown-heading',
      heading[2].trimEnd(),
      start,
      start + heading[2].trimEnd().length,
    )
    return
  }

  pushImageAltSegments(segments, line, lineStart)
  pushLinkTextSegments(segments, line, lineStart)

  if (/^[-*+]\s+\[[ x]\]/.test(trimmed) || /^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
    const prefix = line.match(/^(\s*(?:[-*+]|\d+\.)\s+(?:\[[ x]\]\s*)?)/)?.[1] ?? ''
    const text = line.slice(prefix.length)
    if (!/[`<>\][]/.test(text)) {
      addSegment(segments, 'markdown-list-item', text, lineStart + prefix.length, lineStart + line.length)
    }
    return
  }

  if (!/[`<>\][]/.test(line) && /[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(line)) {
    addSegment(segments, 'markdown-paragraph', line.trim(), lineStart + line.indexOf(line.trim()), lineStart + line.indexOf(line.trim()) + line.trim().length)
  }
}

function pushImageAltSegments(segments, line, lineStart) {
  const regex = /!\[([^\]]+)\]\(([^)]+)\)/g
  for (const match of line.matchAll(regex)) {
    const altStart = lineStart + match.index + 2
    addSegment(segments, 'markdown-image-alt', match[1], altStart, altStart + match[1].length)
  }
}

function pushLinkTextSegments(segments, line, lineStart) {
  const regex = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g
  for (const match of line.matchAll(regex)) {
    const linkText = match[1]
    if (/^https?:\/\//.test(linkText)) continue
    const textStart = lineStart + match.index + 1
    addSegment(segments, 'markdown-link-text', linkText, textStart, textStart + linkText.length)
  }
}

function pushHtmlAttributeSegments(segments, line, lineStart) {
  const regex = /\b(title|alt|aria-label)=["']([^"']+)["']/g
  for (const match of line.matchAll(regex)) {
    if (!TRANSLATABLE_ATTRS.has(match[1])) continue
    const valueStart = lineStart + match.index + match[0].indexOf(match[2])
    addSegment(segments, `html-${match[1]}`, match[2], valueStart, valueStart + match[2].length)
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
          { frontmatterKey: key },
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
      throw new Error(`Segment ${segment.id} does not have a safe source range.`)
    }
    replacements.push({
      start: segment.start,
      end: segment.end,
      text: translationsById[segment.id],
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
