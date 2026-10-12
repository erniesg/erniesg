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

export async function snapshotPublishInputs(root) {
  const config = JSON.parse(
    await fs.readFile(path.join(root, '.translation/config.json'), 'utf8'),
  )
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, '.translation/manifest.json'), 'utf8'),
  )
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
