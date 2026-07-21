import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import fixtureManifest from '../../tests/fixtures/pdf/manifest.json'
import type { PdfReconstruction } from './import-types'
import { reconstructPdf } from './pdf'

describe('raw PDF figure caption direction regression', () => {
  let reconstruction: PdfReconstruction
  let repeated: PdfReconstruction
  let sourceBytes: Uint8Array

  beforeAll(async () => {
    ;[sourceBytes, reconstruction, repeated] = await Promise.all([
      readFile(
        new URL(
          '../../tests/fixtures/pdf/caption-direction-figures.pdf',
          import.meta.url,
        ),
      ),
      reconstructPdf(await fixtureFile('caption-direction-figures.pdf')),
      reconstructPdf(await fixtureFile('caption-direction-figures.pdf')),
    ])
  })

  it('is a frozen repository-owned source fixture', () => {
    const manifestEntry = fixtureManifest.fixtures.find(
      (entry) => entry.file === 'caption-direction-figures.pdf',
    )
    expect(fixtureManifest.license).toBe('CC0-1.0')
    expect(createHash('sha256').update(sourceBytes).digest('hex')).toBe(
      manifestEntry && 'sha256' in manifestEntry
        ? manifestEntry.sha256
        : undefined,
    )
  })

  it('binds caption-above and caption-below figures to unique source rasters', () => {
    const figures = reconstruction.visualRelationships.filter(
      (relationship) => relationship.kind === 'figure',
    )

    expect(
      figures.map(({ label, status, sourceObjectIds }) => ({
        label,
        status,
        sourceObjectIds,
      })),
    ).toEqual([
      {
        label: 'Figure 1',
        status: 'matched',
        sourceObjectIds: ['image-p001-001'],
      },
      {
        label: 'Figure 2',
        status: 'matched',
        sourceObjectIds: ['image-p001-002'],
      },
    ])
    expect(figures.map((relationship) => relationship.assetIds)).toEqual([
      [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
    ])
    expect(reconstruction.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_VISUAL_MATCH' }),
        expect.objectContaining({ code: 'UNRESOLVED_VISUAL_OBJECT' }),
      ]),
    )
  })

  it('repeats the same directional ownership deterministically', () => {
    expect(repeated.visualRelationships).toEqual(
      reconstruction.visualRelationships,
    )
    expect(repeated.paper.nodes).toEqual(reconstruction.paper.nodes)
  })
})
