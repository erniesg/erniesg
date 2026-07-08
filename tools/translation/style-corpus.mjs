import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import { loadConfig, parseArgs } from './content.mjs'

const OUTPUT_PATH = '.translation/style-corpus/zh-human.md'

export async function buildChineseStyleCorpus({ outputPath = OUTPUT_PATH } = {}) {
  const config = await loadConfig()
  const sections = [
    '# Ernie Human Chinese Style Corpus',
    '',
    'Generated from protected legacy Chinese posts. Do not translate this file; use it as style evidence for zh generation and review.',
    '',
  ]

  for (const legacyDir of config.protectedLegacyDirs ?? []) {
    const sourcePath = `${legacyDir}/index.mdx`
    const raw = await fs.readFile(sourcePath, 'utf8')
    const parsed = matter(raw)
    sections.push(`## ${parsed.data.title ?? legacyDir}`)
    if (parsed.data.description) {
      sections.push('', `Description: ${parsed.data.description}`)
    }
    const prose = parsed.content
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim()
        return (
          trimmed &&
          !trimmed.startsWith('<iframe') &&
          !trimmed.startsWith('<audio') &&
          !trimmed.startsWith('![') &&
          !trimmed.startsWith('*Originally published')
        )
      })
      .slice(0, 60)
      .join('\n')
    sections.push('', prose, '')
  }

  await fs.mkdir(outputPath.split('/').slice(0, -1).join('/'), { recursive: true })
  await fs.writeFile(outputPath, `${sections.join('\n').trim()}\n`)
  return outputPath
}

async function main() {
  const args = parseArgs()
  const outputPath = await buildChineseStyleCorpus({
    outputPath: typeof args.output === 'string' ? args.output : OUTPUT_PATH,
  })
  console.log(`Wrote ${outputPath}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
