import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs, readJson } from './content.mjs'
import { extractSegments } from './segments.mjs'

const INLINE_CODE_RE = /`[^`\n]+`/g
const URL_RE = /https?:\/\/[^\s)>"']+/g
const MAX_RESEARCH_CANDIDATES = 24
const STOPWORDS = new Set([
  'A',
  'An',
  'And',
  'Anyway',
  'As',
  'At',
  'Above',
  'Before',
  'But',
  'For',
  'From',
  'Due',
  'Going',
  'Here',
  'However',
  'I',
  'If',
  'Indeed',
  'In',
  'Intuitively',
  'Is',
  'It',
  'Maybe',
  'Now',
  'On',
  'One',
  'Or',
  'Originally',
  'Perhaps',
  'Recently',
  'Run',
  'Should',
  'So',
  'Still',
  'Such',
  'The',
  'Then',
  'There',
  'Those',
  'This',
  'Thus',
  'To',
  'Two',
  'We',
  'While',
  'Which',
  'With',
  'Yet',
])

function scrubCandidateText(text) {
  return text.replace(INLINE_CODE_RE, '').replace(URL_RE, '')
}

export function extractResearchCandidates({
  segments,
  glossary = { terms: {} },
}) {
  const glossaryTerms = new Set(Object.keys(glossary.terms ?? {}))
  const candidates = new Map()
  const namedWord = String.raw`(?:[A-Z][A-Za-z0-9.&'/-]*|[A-Z]{2,}[A-Za-z0-9.&'/-]*)`
  const connector = String.raw`(?:of|for|the|and|to|in|on|with)`
  const candidateRe = new RegExp(
    String.raw`\b${namedWord}(?:\s+(?:(?:${connector})\s+)?${namedWord})*\b`,
    'g',
  )

  for (const segment of segments) {
    const text = scrubCandidateText(segment.sourceText)
    for (const match of text.matchAll(candidateRe)) {
      const rawCandidate = match[0].trim().replace(/[.,:;!?]+$/, '')
      const trimmedTokens = rawCandidate.split(/\s+/)
      while (trimmedTokens.length && STOPWORDS.has(trimmedTokens[0]))
        trimmedTokens.shift()
      while (
        trimmedTokens.length &&
        STOPWORDS.has(trimmedTokens[trimmedTokens.length - 1])
      )
        trimmedTokens.pop()
      const candidate = trimmedTokens.join(' ')
      if (!candidate || STOPWORDS.has(candidate)) continue
      if (glossaryTerms.has(candidate)) continue
      const tokens = candidate.split(/\s+/)
      const hasStopword = tokens.some((token) => STOPWORDS.has(token))
      const hasStrongShape = tokens.some(
        (token) =>
          /^[A-Z]{2,}$/.test(token) ||
          /[A-Z].*[A-Z0-9.]|[0-9.].*[A-Z]/.test(token),
      )
      const before = text.slice(0, match.index).trimEnd()
      const startsSentence = before === '' || /[.!?]["'”’)]?$/.test(before)
      const likelyNamedTerm =
        hasStrongShape || (tokens.length > 1 && !hasStopword) || !startsSentence
      if (!likelyNamedTerm) continue

      const existing = candidates.get(candidate)
      if (existing) {
        if (!existing.segmentIds.includes(segment.id))
          existing.segmentIds.push(segment.id)
        continue
      }
      if (candidates.size >= MAX_RESEARCH_CANDIDATES) continue
      candidates.set(candidate, {
        text: candidate,
        segmentIds: [segment.id],
        reason: 'capitalized-proper-name-or-technical-term',
      })
    }
  }

  return [...candidates.values()]
}

export async function buildResearchReport({
  sourcePath,
  sourceLocale = 'en',
  targetLocale,
  glossaryPath = 'docs/translation/glossary.json',
}) {
  const source = await fs.readFile(sourcePath, 'utf8')
  const glossary = await readJson(glossaryPath, { terms: {} })
  const segments = extractSegments(source)
  return {
    sourcePath,
    sourceLocale,
    targetLocale,
    candidates: extractResearchCandidates({
      sourceLocale,
      targetLocale,
      segments,
      glossary,
    }),
  }
}

async function main() {
  const args = parseArgs()
  const [sourcePath] = args._
  if (!sourcePath)
    throw new Error(
      'Usage: npm run translate:research -- <source.mdx> --target zh',
    )
  const report = await buildResearchReport({
    sourcePath,
    sourceLocale: args.source ?? 'en',
    targetLocale: args.target ?? 'zh',
  })
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
