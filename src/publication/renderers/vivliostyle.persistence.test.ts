import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAdapterCase } from '../../../tests/fixtures/struct-adapter-parity/cases'
import { adaptAstroBlogEntry } from '../adapters/astro'
import { buildStructDocument } from '../../struct-adapters'
import {
  createStructBundleForDocument,
  structCutoverSourceBinding,
} from '../struct-source-binding'
import { readStructPackagePin } from '../struct-package-pin'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
  writePublicationSemanticArtifacts,
  type PublicationReceipt,
} from './vivliostyle'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)))
      continue
    }
    files.push(path.slice(root.length + 1))
  }
  return files.sort()
}

describe('publication render persistence', () => {
  it('persists the Struct artifacts and never the graph', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-semantic-'))
    try {
      const output = resolve(root, 'render-output')
      await mkdir(output)
      const document = buildStructDocument(
        await loadAdapterCase('ordinary-pdf'),
      )
      const pin = await readStructPackagePin(repositoryRoot)
      // The adapter that owns the document also owns the bundle handle, so
      // the binding's bundle digest is the digest of real wire bytes.
      const sourceBinding = await structCutoverSourceBinding(
        document,
        pin,
        createStructBundleForDocument(document),
      )
      await writePublicationSemanticArtifacts(output, {
        structDocument: document,
        sourceBinding,
      } as Parameters<typeof writePublicationSemanticArtifacts>[1])
      expect(await readdir(output)).toEqual([
        'struct-bundle.json',
        'struct-document.json',
      ])
      const descriptor = JSON.parse(
        await readFile(resolve(output, 'struct-bundle.json'), 'utf8'),
      )
      expect(descriptor.documentSha256).toBe(sourceBinding.documentSha256)
      expect(descriptor.bundleSha256).toBe(sourceBinding.bundleSha256)
      await expect(
        access(resolve(output, 'publication-graph.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists no semantic artifact without a Struct document', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-semantic-'))
    try {
      const output = resolve(root, 'render-output')
      await mkdir(output)
      await writePublicationSemanticArtifacts(output, {} as Parameters<
        typeof writePublicationSemanticArtifacts
      >[1])
      expect(await readdir(output)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes no graph and no graph node into the render output', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-render-graph-'))
    const output = resolve(root, 'render-output')
    try {
      const bundle = await adaptAstroBlogEntry({
        entryId: 'moving-to-cloudflare-with-astro',
      })
      const receipt = (await vivliostyleRenderer.render(bundle, {
        outputDirectory: output,
        profiles: [...PUBLICATION_PROFILES],
      })) as PublicationReceipt
      await expect(
        access(resolve(output, 'publication-graph.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      // The graph digests stay in the receipt as diagnostic back-compat
      // fields; they are never the source identity and never a persisted
      // graph.
      expect(receipt.source.graphSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(receipt.source.assetBundleSha256).toMatch(/^[a-f0-9]{64}$/)
      const persisted = await listFiles(output)
      expect(persisted).toContain('publication-receipt.json')
      expect(persisted).not.toContain('publication-graph.json')
      for (const file of persisted.filter((path) => path.endsWith('.json'))) {
        const contents = await readFile(resolve(output, file), 'utf8')
        expect(contents.includes('"nodes"')).toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
