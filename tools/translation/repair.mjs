import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  canWriteExistingTarget,
  getManifestTarget,
  listTargetSidecars,
  loadManifest,
  nowIso,
  parseArgs,
  readMdxFile,
  saveManifest,
  sha256,
} from './content.mjs'
import { auditMdxText } from './audit.mjs'

const IGNORED_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)|`[^`\n]+`|https?:\/\/[^\s)>"']+/g

const REPAIRS = {
  zh: [
    [/preload=(["'])meta数据\1/g, 'preload=$1metadata$1'],
    [/数据\s*sets?/gi, '数据集'],
    [/数据源s/g, '数据源'],
    [/上下文s/g, '上下文'],
    [/\bitems\b/g, '条目'],
    [/\bschemas\b/g, '模式'],
    [/\bstrategies\b/g, '策略'],
    [/\btests\b/g, '测试'],
    [/\bingest(?:ed|ing)?\b/gi, '导入'],
    [/\bchunk(?:ed|ing)?\b/gi, '分块'],
    [/\bqueries\b/gi, '查询'],
    [/\bquery\b/gi, '查询'],
    [/\bvalidate(?:d|s|ing)?\b/gi, '验证'],
  ],
  ko: [
    [/데이터\s*소스s/g, '데이터 소스'],
    [/데이터\s*sets?/gi, '데이터셋'],
    [/맥락s/g, '맥락'],
    [/items를/g, '항목을'],
    [/\bitems\b/g, '항목'],
    [/tests를/g, '테스트를'],
    [/\btests\b/g, '테스트'],
    [/ingest할/g, '수집할'],
    [/\bingest(?:ed|ing)?\b/gi, '수집하다'],
    [/chunk하게/g, '나누어 넣게'],
    [/\bchunk(?:ed|ing)?\b/gi, '분할하다'],
    [/query하게/g, '질의하게'],
    [/\bqueries\b/gi, '질의'],
    [/\bquery\b/gi, '질의'],
    [/validate하게/g, '검증하게'],
    [/\bvalidate(?:d|s|ing)?\b/gi, '검증하다'],
    [/\bstrategies\b/gi, '전략'],
  ],
  ja: [
    [/データ\s*ソースs/g, 'データソース'],
    [/データ\s*sets?/gi, 'データセット'],
    [/データ\s*base/gi, 'データベース'],
    [/本番環境ise/g, '本番運用化'],
    [/ingest and chunk する/gi, '取り込み、分割する'],
    [/ingest する/gi, '取り込む'],
    [/\bingest(?:ed|ing)?\b/gi, '取り込み'],
    [/chunk する/gi, '分割する'],
    [/\bchunk(?:ed|ing)?\b/gi, '分割'],
    [/\bqueries\b/gi, '問い合わせ'],
    [/\bquery\b/gi, '問い合わせ'],
    [/\bvalidate(?:d|s|ing)?\b/gi, '検証'],
    [/\bitems\b/g, '項目'],
    [/\btests\b/g, 'テスト'],
    [/\bstrategies\b/g, '方針'],
  ],
}

function ignoredRanges(text) {
  return [...text.matchAll(IGNORED_RE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function overlapsIgnored(start, end, ranges) {
  return ranges.some((range) => start < range.end && end > range.start)
}

function replaceOutsideIgnored(text, regex, replacement) {
  const ranges = ignoredRanges(text)
  return text.replace(regex, (match, ...args) => {
    const offset = args.at(-2)
    if (overlapsIgnored(offset, offset + match.length, ranges)) return match
    return typeof replacement === 'function' ? replacement(match, ...args) : replacement
  })
}

function repairText(raw, locale) {
  let output = raw
  for (const [regex, replacement] of REPAIRS[locale] ?? []) {
    output = replaceOutsideIgnored(output, regex, replacement)
  }
  return output
}

export async function repairMachineTranslations({ apply = false } = {}) {
  const manifest = await loadManifest()
  const files = await listTargetSidecars(['zh', 'ko', 'ja'])
  const results = []

  for (const filePath of files) {
    const file = await readMdxFile(filePath)
    const locale = file.frontmatter.lang
    if (file.frontmatter.translationStatus !== 'machine') {
      results.push({ filePath, action: 'skipped-human-owned' })
      continue
    }

    const manifestTarget = getManifestTarget(manifest, filePath)
    if (!canWriteExistingTarget({ frontmatter: file.frontmatter, manifestTarget, currentText: file.raw })) {
      results.push({ filePath, action: 'skipped-hash-drift' })
      continue
    }

    const repaired = repairText(file.raw, locale)
    if (repaired === file.raw) {
      results.push({ filePath, action: 'unchanged' })
      continue
    }

    const audit = auditMdxText(repaired, { path: filePath, locale })
    if (audit.errors.length > 0) {
      results.push({ filePath, action: 'needs-manual-repair', errors: audit.errors })
      continue
    }

    manifestTarget.targetSha256 = sha256(repaired)
    manifestTarget.repairedAt = nowIso()
    manifestTarget.qualityStatus = 'mechanical-passed'
    manifestTarget.unresolvedResearch = [
      ...new Set([...(manifestTarget.unresolvedResearch ?? []), 'native-review-required-after-deterministic-repair']),
    ]

    if (apply) {
      await fs.writeFile(filePath, repaired)
    }
    results.push({ filePath, action: apply ? 'repaired' : 'would-repair' })
  }

  if (apply) await saveManifest(manifest)
  return results
}

async function main() {
  const args = parseArgs()
  const results = await repairMachineTranslations({ apply: Boolean(args.apply) })
  const counts = results.reduce((acc, result) => {
    acc[result.action] = (acc[result.action] ?? 0) + 1
    return acc
  }, {})
  for (const [action, count] of Object.entries(counts)) console.log(`${action}: ${count}`)
  for (const result of results.filter((item) => item.errors?.length)) {
    console.error(`${result.filePath}:\n${result.errors.join('\n')}`)
  }
  if (!args.apply) console.log('Dry run only. Re-run with --apply to repair machine-owned translations.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
