import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  listTargetSidecars,
  localeFromPath,
  parseArgs,
  readMdxFile,
  sourcePathForTarget,
} from './content.mjs'

const CODE_FENCE_RE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g
const INLINE_CODE_RE = /`[^`\n]+`/g
const URL_RE = /https?:\/\/[^\s)>"']+/g
const LOCALE_SCRIPT_RE = {
  zh: /[\u3400-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  ja: /[\u3040-\u30ff]/,
}

const DIRECT_RESIDUE_PATTERNS = {
  zh: [
    /数据\s*sets?/i,
    /数据源s/i,
    /上下文s/i,
    /\b(?:query|queries|ingest|chunk|validate|productionise)\b/i,
  ],
  ko: [
    /데이터\s*소스s/i,
    /데이터\s*sets?/i,
    /맥락s/i,
    /\b(?:query|queries|ingest|chunk|validate|productionise)\b/i,
  ],
  ja: [
    /データ\s*ソースs/i,
    /データ\s*sets?/i,
    /データ\s*base/i,
    /本番環境ise/i,
    /\b(?:query|queries|ingest|chunk|validate|productionise)\b/i,
  ],
}

function stripIgnoredText(text) {
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/, (frontmatter) =>
      frontmatter.replace(/[^\n]/g, ''),
    )
    .replace(CODE_FENCE_RE, '\n')
    .replace(INLINE_CODE_RE, '')
    .replace(URL_RE, '')
}

function lineForOffset(text, offset) {
  return text.slice(0, offset).split('\n').length
}

function counted(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
}

function sameValues(left, right) {
  return JSON.stringify(counted(left)) === JSON.stringify(counted(right))
}

export function structuralParityIssues(
  sourceText,
  targetText,
  { path = '<memory>' } = {},
) {
  const extractors = [
    {
      label: 'URL',
      extract: (text) =>
        [...text.matchAll(/https?:\/\/[^\s)>"'）]+/g)].map((match) => match[0]),
    },
    {
      label: 'relative Markdown destination',
      extract: (text) =>
        [...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
          .map((match) => match[1])
          .filter((value) => value && !/^https?:\/\//.test(value)),
    },
    {
      label: 'HTML src/href attribute',
      extract: (text) =>
        [...text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(
          (match) => match[1],
        ),
    },
    {
      label: 'footnote definition',
      extract: (text) =>
        [...text.matchAll(/^\[\^([^\]]+)\]:/gm)].map((match) => match[1]),
    },
  ]

  return extractors.flatMap(({ label, extract }) =>
    sameValues(extract(sourceText), extract(targetText))
      ? []
      : [`${path}: ${label} structure differs from English source`],
  )
}

export function auditMdxText(text, { path = '<memory>', locale = 'en' } = {}) {
  const errors = []
  const warnings = []
  const visible = stripIgnoredText(text)

  for (const match of visible.matchAll(/\bpreload=["']([^"']+)["']/g)) {
    if (!['metadata', 'none', 'auto'].includes(match[1])) {
      errors.push(
        `${path}:${lineForOffset(visible, match.index)} corrupted fixed HTML vocabulary: preload="${match[1]}"`,
      )
    }
  }

  const patterns = DIRECT_RESIDUE_PATTERNS[locale] ?? []
  for (const pattern of patterns) {
    const match = visible.match(pattern)
    if (match) {
      errors.push(
        `${path}:${lineForOffset(visible, match.index ?? 0)} direct translation residue (${match[0]})`,
      )
    }
  }

  const unescapedCurrency = visible.match(/(?<!\\)\$(?=\d)/)
  if (unescapedCurrency) {
    errors.push(
      `${path}:${lineForOffset(visible, unescapedCurrency.index ?? 0)} unescaped currency dollar may be parsed as math`,
    )
  }

  const unsafeCjkUnderscoreEmphasis = visible.match(
    /(?:[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]_+|_+[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af])/,
  )
  if (unsafeCjkUnderscoreEmphasis) {
    errors.push(
      `${path}:${lineForOffset(visible, unsafeCjkUnderscoreEmphasis.index ?? 0)} underscore emphasis next to CJK text may render literally; use asterisks`,
    )
  }

  const crampedBlockquote = visible.match(/^>\S/m)
  if (crampedBlockquote) {
    errors.push(
      `${path}:${lineForOffset(visible, crampedBlockquote.index ?? 0)} blockquote marker must be followed by a space`,
    )
  }

  const localeScript = LOCALE_SCRIPT_RE[locale]
  if (localeScript) {
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const alt = lines[index].match(
        /<iframe\b[^>]*\balt=["']([^"']+)["']/,
      )?.[1]
      if (!alt || localeScript.test(alt)) continue
      const englishWords = alt.match(/[A-Za-z][A-Za-z'-]*/g) ?? []
      if (englishWords.length < 3) continue
      const caption = lines
        .slice(index + 1)
        .find((line) => line.trim())
        ?.trim()
      if (caption && localeScript.test(caption)) {
        errors.push(
          `${path}:${index + 1} untranslated reader-facing alt text (${alt})`,
        )
      }
    }
  }

  return { errors, warnings }
}

export async function auditFiles(files) {
  const results = []
  for (const filePath of files) {
    const file = await readMdxFile(filePath)
    const locale = file.frontmatter.lang ?? localeFromPath(filePath)
    const result = auditMdxText(file.raw, { path: filePath, locale })
    if (file.frontmatter.translationStatus === 'machine') {
      const source = await readMdxFile(sourcePathForTarget(filePath))
      result.errors.push(
        ...structuralParityIssues(source.raw, file.raw, { path: filePath }),
      )
    }
    results.push({ filePath, locale, ...result })
  }
  return results
}

async function main() {
  const args = parseArgs()
  const files =
    args._.length > 0 ? args._ : await listTargetSidecars(['zh', 'ko', 'ja'])
  const results = await auditFiles(files)
  const errors = results.flatMap((result) => result.errors)
  const warnings = results.flatMap((result) => result.warnings)

  if (args.json) {
    await fs.writeFile(
      typeof args.json === 'string' ? args.json : '/dev/stdout',
      `${JSON.stringify({ errors, warnings, results }, null, 2)}\n`,
    )
  } else {
    for (const warning of warnings) console.warn(`warning: ${warning}`)
    for (const error of errors) console.error(`error: ${error}`)
    console.log(
      `Audited ${results.length} translation files: ${errors.length} errors, ${warnings.length} warnings.`,
    )
  }

  if (errors.length > 0) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
