import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import fg from 'fast-glob'
import matter from 'gray-matter'
import { canWriteExistingTarget, getManifestTarget } from './content.mjs'

const digest = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex')
const sidecar = (file) =>
  /^src\/content\/blog\/.+\/(?:zh|ja|ko)\.mdx$/u.test(file)

export function validatePublishInputMetadata(config, manifest) {
  const locales = new Set(['en', 'zh', 'ja', 'ko'])
  for (const list of [config.supportedLocales, config.requiredPublishLocales]) {
    if (list && (!Array.isArray(list) || list.some(locale => !locales.has(locale))))
      throw new Error('Unsupported publication locale configuration')
  }
  if (config.defaultLocale && !locales.has(config.defaultLocale))
    throw new Error('Unsupported publication source locale')
  const safePath = value => typeof value === 'string' && !/[\x00-\x1f\\]/u.test(value) && !value.split('/').some(part => part === '.' || part === '..')
  const sourcePath = value => safePath(value) && /^src\/content\/blog\/[^/]+\/index\.mdx$/u.test(value)
  for (const family of Object.values(manifest.families ?? {})) {
    if (!sourcePath(family.sourcePath) || (family.sourceLocale && !locales.has(family.sourceLocale)))
      throw new Error('Publication manifest contains an unsafe source reference')
    for (const [locale, target] of Object.entries(family.targets ?? {})) {
      if (!locales.has(locale) || !safePath(target.path) || !sidecar(target.path) || path.dirname(target.path) !== path.dirname(family.sourcePath) ||
          (target.sourcePath && !sourcePath(target.sourcePath) && !sidecar(target.sourcePath)) ||
          (target.status === 'machine' && target.sourcePath !== family.sourcePath))
        throw new Error('Publication manifest contains an unsafe target reference')
      if (target.qualityReportPath && (!safePath(target.qualityReportPath) || !/^\.translation\/reports\/[^/]+\.json$/u.test(target.qualityReportPath)))
        throw new Error('Publication manifest contains an unsafe review reference')
    }
  }
}

export async function snapshotPublishInputs(root) {
  const config = JSON.parse(
    await fs.readFile(path.join(root, '.translation/config.json'), 'utf8'),
  )
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, '.translation/manifest.json'), 'utf8'),
  )
  validatePublishInputMetadata(config, manifest)
  const entries = {}
  for (const file of await fg('src/content/blog/**/*', {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: true,
  })) {
    const bytes = await fs.readFile(path.join(root, file))
    const text = bytes.toString('utf8')
    entries[file] = {
      hash: digest(bytes),
      writable:
        sidecar(file) &&
        canWriteExistingTarget({
          filePath: file,
          config,
          frontmatter: matter(text).data,
          manifestTarget: getManifestTarget(manifest, file),
          currentText: text,
        }),
    }
  }
  return entries
}

export async function exportPublishOutputs({ root, snapshot, output }) {
  const changed = []
  for (const [file, entry] of Object.entries(snapshot)) {
    const bytes = await fs.readFile(path.join(root, file))
    if (digest(bytes) === entry.hash) continue
    if (!entry.writable)
      throw new Error(`Original or human-owned content changed: ${file}`)
    changed.push(file)
  }
  for (const file of await fg('src/content/blog/**/*', {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: true,
  })) {
    if (snapshot[file]) continue
    if (!sidecar(file)) throw new Error(`Unexpected new blog input: ${file}`)
    changed.push(file)
  }
  const artifacts = [
    ...new Set([
      '.translation/manifest.json',
      '.translation/pages.json',
      ...(await fg('.translation/reports/**/*.json', {
        cwd: root,
        onlyFiles: true,
        followSymbolicLinks: false,
      })),
      ...changed,
    ]),
  ]
  for (const file of artifacts) {
    const target = path.join(output, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(root, file), target)
  }
  return artifacts
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      snapshot: { type: 'string' },
      output: { type: 'string' },
    },
  })
  if (!values.root || !values.snapshot)
    throw new Error('Provide root and snapshot paths')
  if (positionals[0] === 'snapshot')
    await fs.writeFile(
      values.snapshot,
      JSON.stringify(await snapshotPublishInputs(values.root)),
    )
  else if (positionals[0] === 'export' && values.output)
    await exportPublishOutputs({
      root: values.root,
      snapshot: JSON.parse(await fs.readFile(values.snapshot, 'utf8')),
      output: values.output,
    })
  else throw new Error('Use snapshot or export')
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
