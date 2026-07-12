import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import {
  buildLayoutManifest,
  layoutManifestSchema,
  serializeLayoutManifest,
  targetProfiles,
  validateLayoutManifest,
} from './manifest'
import { canonicalContentHash, researchPaperSchema } from './schema'

const paper = researchPaperSchema.parse(rawPaper)

function cloneManifest() {
  return structuredClone(buildLayoutManifest(paper))
}

describe('SRT layout manifest contract', () => {
  it('builds a deterministic versioned manifest for every target', () => {
    const manifest = buildLayoutManifest(paper)

    expect(layoutManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.schemaVersion).toBe('1.0.0')
    expect(manifest.contentHash).toBe(canonicalContentHash(paper))
    expect(manifest.renditions.map((rendition) => rendition.target.id)).toEqual(
      targetProfiles.map((target) => target.id),
    )
    expect(serializeLayoutManifest(manifest)).toBe(
      serializeLayoutManifest(buildLayoutManifest(paper)),
    )
  })

  it('preserves every canonical node, hash, relationship, and provenance in every rendition', () => {
    const manifest = buildLayoutManifest(paper)
    const canonicalIds = paper.nodes.map((node) => node.id)

    for (const rendition of manifest.renditions) {
      expect(rendition.contentHash).toBe(manifest.contentHash)
      expect(rendition.entries.map((entry) => entry.nodeId)).toEqual(
        canonicalIds,
      )
      expect(new Set(rendition.entries.map((entry) => entry.nodeId)).size).toBe(
        canonicalIds.length,
      )

      for (const [order, entry] of rendition.entries.entries()) {
        const node = paper.nodes[order]
        expect(entry.target).toBe(rendition.target.id)
        expect(entry.contentHash).toBe(canonicalContentHash(node))
        expect(entry.source).toBe(node.source)
        expect(entry.placement).toEqual({ kind: 'flow', order })
        expect(entry.diagnostics).toEqual([])
      }

      expect(
        rendition.entries.find((entry) => entry.nodeId === 'fig-pipeline')
          ?.relationships,
      ).toEqual({
        caption: 'cap-pipeline',
      })
    }
  })

  it('rejects silent omission and duplication', () => {
    const omitted = cloneManifest()
    omitted.renditions[0].entries.splice(1, 1)
    expect(() => validateLayoutManifest(paper, omitted)).toThrow(
      /omitted canonical node/,
    )

    const duplicated = cloneManifest()
    duplicated.renditions[0].entries.push(
      structuredClone(duplicated.renditions[0].entries[0]),
    )
    expect(layoutManifestSchema.safeParse(duplicated).success).toBe(false)
  })

  it.each([
    [
      'content hash',
      (manifest: ReturnType<typeof cloneManifest>) =>
        (manifest.renditions[0].entries[0].contentHash = '0'.repeat(64)),
    ],
    [
      'provenance',
      (manifest: ReturnType<typeof cloneManifest>) =>
        (manifest.renditions[0].entries[0].source = 'unknown'),
    ],
    [
      'relationship',
      (manifest: ReturnType<typeof cloneManifest>) =>
        (manifest.renditions[0].entries[5].relationships = {}),
    ],
  ])('rejects %s loss', (_, corrupt) => {
    const manifest = cloneManifest()
    corrupt(manifest)
    expect(() => validateLayoutManifest(paper, manifest)).toThrow()
  })

  it('rejects missing target renditions and mismatched entry targets', () => {
    const missingTarget = cloneManifest()
    missingTarget.renditions.pop()
    expect(() => validateLayoutManifest(paper, missingTarget)).toThrow(
      /Missing rendition target/,
    )

    const mismatchedTarget = cloneManifest()
    mismatchedTarget.renditions[0].entries[0].target = 'print'
    expect(layoutManifestSchema.safeParse(mismatchedTarget).success).toBe(false)
  })

  it('requires explicit diagnostics for fallbacks and fragments', () => {
    const fallback = cloneManifest()
    fallback.renditions[0].entries[0].variant.selection = 'fallback'
    expect(layoutManifestSchema.safeParse(fallback).success).toBe(false)

    const fragmented = cloneManifest()
    fragmented.renditions[0].entries[1].placement = {
      kind: 'fragments',
      items: [
        { index: 0, placement: { kind: 'flow', order: 1 } },
        { index: 1, placement: { kind: 'flow', order: 2 } },
      ],
    }
    expect(layoutManifestSchema.safeParse(fragmented).success).toBe(false)

    fragmented.renditions[0].entries[1].diagnostics.push({
      code: 'CONTENT_FRAGMENTED',
      severity: 'info',
      message: 'Paragraph is explicitly split across two flow regions.',
    })
    expect(() => validateLayoutManifest(paper, fragmented)).not.toThrow()
  })
})
