import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs, readJson } from './content.mjs'
import { extractSegments } from './segments.mjs'

const INLINE_CODE_RE = /`[^`\n]+`/g
const URL_RE = /https?:\/\/[^\s)>"']+/g
const STOPWORDS = new Set([
  'A',
  'An',
  'And',
  'As',
  'At',
  'Before',
  'But',
  'For',
  'From',
  'I',
  'In',
  'It',
  'On',
  'Or',
  'Run',
  'The',
  'This',
  'To',
  'With',
])

function scrubCandidateText(text) {
  return text.replace(INLINE_CODE_RE, '').replace(URL_RE, '')
}

export function extractResearchCandidates({
  segments,
  glossary = { terms: {} },
}) {
  const glossaryTerms = new Set(Object.keys(glossary.terms ?? {}))
  const seen = new Set()
  const candidates = []
  const candidateRe =
    /\b(?:[A-Z][A-Za-z0-9.&'/-]*|[A-Z]{2,}[A-Za-z0-9.&'/-]*)(?:\s+(?:[A-Z][A-Za-z0-9.&'/-]*|[A-Z]{2,}[A-Za-z0-9.&'/-]*))*\b/g

  for (const segment of segments) {
    const text = scrubCandidateText(segment.sourceText)
    for (const match of text.matchAll(candidateRe)) {
      const candidate = match[0].trim().replace(/[.,:;!?]+$/, '')
      if (!candidate || STOPWORDS.has(candidate)) continue
      if (glossaryTerms.has(candidate)) continue
      if (seen.has(candidate)) continue
      seen.add(candidate)
      candidates.push({
        text: candidate,
        segmentIds: [segment.id],
        reason: 'capitalized-proper-name-or-technical-term',
      })
    }
  }

  return candidates
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
