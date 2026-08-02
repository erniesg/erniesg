import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parsePublicationCheckArgs,
  verifyArtifactReceipt,
} from './publication-check.mjs'

describe('publication:check CLI', () => {
  it('requires the exact four-output matrix', () => {
    expect(
      parsePublicationCheckArgs([
        '--input',
        '.agent/evidence/publication',
        '--matrix',
        'phone-webpub,eink-epub,a5-pdf,a4-pdf',
      ]).matrix,
    ).toHaveLength(4)
    expect(() =>
      parsePublicationCheckArgs([
        '--input',
        'output',
        '--matrix',
        'phone-webpub,eink-epub',
      ]),
    ).toThrow(/exactly/)
  })

  it('fails closed when an EPUB or PDF no longer matches its receipt bytes', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-receipt-'))
    try {
      const bytes = Buffer.from('exact publication artifact')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const artifact = {
        profile: 'eink-epub',
        sha256,
        byteLength: bytes.byteLength,
      }
      await writeFile(resolve(root, 'eink.epub'), bytes)
      await expect(
        verifyArtifactReceipt(root, artifact, 'eink.epub'),
      ).resolves.toEqual(new Uint8Array(bytes))
      await writeFile(resolve(root, 'eink.epub'), Buffer.alloc(bytes.length, 0x58))
      await expect(
        verifyArtifactReceipt(root, artifact, 'eink.epub'),
      ).rejects.toThrow(/hash changed/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
