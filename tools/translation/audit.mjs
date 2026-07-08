import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  listTargetSidecars,
  localeFromPath,
  parseArgs,
  readMdxFile,
} from './content.mjs'

const CODE_FENCE_RE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g
const INLINE_CODE_RE = /`[^`\n]+`/g
const URL_RE = /https?:\/\/[^\s)>"']+/g

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
    .replace(CODE_FENCE_RE, '\n')
    .replace(INLINE_CODE_RE, '')
    .replace(URL_RE, '')
}

function lineForOffset(text, offset) {
  return text.slice(0, offset).split('\n').length
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

  return { errors, warnings }
}

export async function auditFiles(files) {
  const results = []
  for (const filePath of files) {
    const file = await readMdxFile(filePath)
    const locale = file.frontmatter.lang ?? localeFromPath(filePath)
    const result = auditMdxText(file.raw, { path: filePath, locale })
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
