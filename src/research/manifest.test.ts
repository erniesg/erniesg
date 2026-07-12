import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import {
  buildLayoutManifest,
  LAYOUT_MANIFEST_VERSION,
  LAYOUT_TARGETS,
  layoutManifestSchema,
  ManifestInvariantError,
  serializeLayoutManifest,
  validateLayoutManifest,
} from './manifest'
import {
  canonicalContentHash,
  canonicalNodeContentHash,
  researchPaperSchema,
} from './schema'

const paper = researchPaperSchema.parse(rawPaper)

function cloneManifest() {
  return structuredClone(buildLayoutManifest(paper))
}

function invariantCodes(error: unknown) {
  if (!(error instanceof ManifestInvariantError)) throw error
  return error.issues.map((issue) => issue.code)
}

describe('SRT layout manifest contract', () => {
  it('builds a versioned, deterministic structural record for every target', () => {
    const manifest = buildLayoutManifest(paper)

    expect(manifest.schemaVersion).toBe(LAYOUT_MANIFEST_VERSION)
    expect(manifest.renditions.map((rendition) => rendition.target)).toEqual(
      LAYOUT_TARGETS,
    )
    expect(manifest.document.contentHash).toBe(canonicalContentHash(paper))
    expect(serializeLayoutManifest(manifest)).toBe(
      serializeLayoutManifest(buildLayoutManifest(paper)),
    )

    for (const rendition of manifest.renditions) {
      expect(rendition.entries).toHaveLength(paper.nodes.length)
      expect(rendition.entries.map((entry) => entry.canonicalId)).toEqual(
        paper.nodes.map((node) => node.id),
      )
      for (const [order, entry] of rendition.entries.entries()) {
        const node = paper.nodes[order]
        expect(entry).toMatchObject({
          target: rendition.target,
          nodeType: node.type,
          contentHash: canonicalNodeContentHash(node),
          provenance: { source: node.source },
          representation: { kind: 'whole', placement: { kind: 'flow', order } },
          diagnostics: [],
        })
      }
    }
  })

  it('accepts explicitly recorded fragments instead of a whole-node placement', () => {
    const manifest = cloneManifest()
    manifest.renditions[0].entries[1].representation = {
      kind: 'fragments',
      fragments: [
        {
          id: 'p-proposition-1:0',
          index: 0,
          placement: { kind: 'flow', order: 1 },
        },
        {
          id: 'p-proposition-1:1',
          index: 1,
          placement: { kind: 'flow', order: 2 },
        },
      ],
    }

    expect(validateLayoutManifest(manifest, paper)).toBeTruthy()
  })

  it('rejects a silent node omission', () => {
    const manifest = cloneManifest()
    manifest.renditions[0].entries.splice(2, 1)

    expect(() => validateLayoutManifest(manifest, paper)).toThrow(
      ManifestInvariantError,
    )
    try {
      validateLayoutManifest(manifest, paper)
    } catch (error) {
      expect(invariantCodes(error)).toContain('MISSING_NODE')
    }
  })

  it('rejects duplicate nodes and malformed fragment records', () => {
    const duplicate = cloneManifest()
    duplicate.renditions[0].entries.push(
      structuredClone(duplicate.renditions[0].entries[0]),
    )
    expect(() => layoutManifestSchema.parse(duplicate)).toThrow(
      /Duplicate manifest entry/,
    )

    const fragments = cloneManifest()
    fragments.renditions[0].entries[0].representation = {
      kind: 'fragments',
      fragments: [
        {
          id: 'sec-proposition:part',
          index: 0,
          placement: { kind: 'flow', order: 0 },
        },
        {
          id: 'sec-proposition:part',
          index: 2,
          placement: { kind: 'flow', order: 1 },
        },
      ],
    }
    expect(() => layoutManifestSchema.parse(fragments)).toThrow(
      /Duplicate fragment id|Fragment indices/,
    )
  })

  it('rejects lost figure-caption relationships', () => {
    const manifest = cloneManifest()
    const figure = manifest.renditions[1].entries.find(
      (entry) => entry.canonicalId === 'fig-pipeline',
    )
    if (!figure) throw new Error('Manifest lost its figure entry')
    figure.relationships = {}

    try {
      validateLayoutManifest(manifest, paper)
      throw new Error('Expected relationship validation to fail')
    } catch (error) {
      expect(invariantCodes(error)).toContain('RELATIONSHIP_MISMATCH')
    }
  })

  it('rejects changed content hashes and provenance', () => {
    const manifest = cloneManifest()
    const entry = manifest.renditions[2].entries[0]
    entry.contentHash = '0'.repeat(64)
    entry.provenance.source = 'unknown source'

    try {
      validateLayoutManifest(manifest, paper)
      throw new Error('Expected identity validation to fail')
    } catch (error) {
      expect(invariantCodes(error)).toEqual(
        expect.arrayContaining(['NODE_HASH_MISMATCH', 'PROVENANCE_MISMATCH']),
      )
    }
  })

  it('rejects a fallback without its coded diagnostic', () => {
    const manifest = cloneManifest()
    manifest.renditions[3].entries[5].fallback = {
      fromVariant: 'full-width',
      diagnosticCode: 'variant-unavailable',
    }

    expect(() => layoutManifestSchema.parse(manifest)).toThrow(
      /lacks diagnostic variant-unavailable/,
    )
  })

  it('keeps rendition geometry out of canonical content', () => {
    const before = canonicalContentHash(paper)
    const manifest = cloneManifest()
    manifest.renditions[3].entries[0].representation = {
      kind: 'whole',
      placement: {
        kind: 'geometry',
        units: 'mm',
        x: 20,
        y: 25,
        width: 170,
        height: 12,
        page: 0,
      },
    }

    expect(validateLayoutManifest(manifest, paper)).toBeTruthy()
    expect(canonicalContentHash(paper)).toBe(before)
    expect(researchPaperSchema.parse(rawPaper)).not.toHaveProperty(
      'targetGeometry',
    )
  })
})
