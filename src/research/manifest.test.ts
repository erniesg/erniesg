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
} from './canonical-hash'
import { researchPaperSchema } from './schema'
import { getCompositionPolicy, resolveNodeComposition } from './composition'
import { paginateResearchPaper } from './pagination'
import { getTargetProfile } from './targets'

const paper = researchPaperSchema.parse(rawPaper)

function cloneManifest() {
  return structuredClone(buildLayoutManifest(paper))
}

function paperWithTableCellNote() {
  const withNote = structuredClone(paper)
  const figure = withNote.nodes.find((node) => node.type === 'figure')
  if (!figure || figure.type !== 'figure') {
    throw new Error('Fixture lacks a figure node')
  }
  figure.objectType = 'table'
  figure.table = {
    rows: [
      {
        cells: [
          {
            id: 'cell-metric',
            text: 'Metric1',
            headerScope: null,
            columnSpan: 1,
            rowSpan: 1,
            noteReferences: [
              {
                id: 'cell-note-reference',
                label: '1',
                target: 'cell-note',
                start: 6,
                end: 7,
                confidence: 1,
              },
            ],
          },
        ],
      },
    ],
  }
  withNote.nodes.push({
    id: 'cell-note',
    type: 'footnote',
    kind: 'footnote',
    label: '1',
    text: 'Source-backed table note.',
    relationships: { backlinks: ['cell-note-reference'] },
    source: 'fixture:table-note',
  })
  return researchPaperSchema.parse(withNote)
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
      expect(rendition.profile).toEqual(getTargetProfile(rendition.target))
      expect(rendition.policy).toEqual(getCompositionPolicy(rendition.target))
      expect(rendition.pagination).toMatchObject({
        policyVersion: '1.0.0',
        mode: rendition.profile.finiteHeight ? 'finite' : 'continuous',
        pageCountStatus: rendition.profile.finiteHeight
          ? 'final'
          : 'not-applicable',
      })
      expect(rendition.entries).toHaveLength(paper.nodes.length)
      expect(rendition.entries.map((entry) => entry.canonicalId)).toEqual(
        paper.nodes.map((node) => node.id),
      )
      for (const [order, entry] of rendition.entries.entries()) {
        const node = paper.nodes[order]
        const composition = resolveNodeComposition(rendition.target, node)
        const pagination = paginateResearchPaper(paper, rendition.target)
        const paginatedNode = pagination.nodes[order]
        expect(entry).toMatchObject({
          target: rendition.target,
          nodeType: node.type,
          contentHash: canonicalNodeContentHash(node),
          provenance: { source: node.source },
          chosenVariant: composition.chosenVariant,
          paginationPolicy: paginatedNode.policy,
          placementDecision: paginatedNode.decision,
          violations: paginatedNode.violations,
          diagnostics: composition.diagnostics,
        })
        expect(entry.fallback).toEqual(composition.fallback)
        expect(entry.paginationFallback).toEqual(paginatedNode.fallback)
      }
    }
  })

  it('records nested table-cell note targets in every rendition', () => {
    const withNote = paperWithTableCellNote()
    const manifest = buildLayoutManifest(withNote)

    for (const rendition of manifest.renditions) {
      expect(
        rendition.entries.find((entry) => entry.canonicalId === 'fig-pipeline')
          ?.relationships,
      ).toMatchObject({ noteTargets: ['cell-note'] })
    }

    delete manifest.renditions[0].entries.find(
      (entry) => entry.canonicalId === 'fig-pipeline',
    )!.relationships.noteTargets
    expect(() => validateLayoutManifest(manifest, withNote)).toThrow(
      /RELATIONSHIP_MISMATCH/,
    )
  })

  it('composes four materially distinct renditions without changing canonical identity', () => {
    const manifest = buildLayoutManifest(paper)
    const renditionSignatures = manifest.renditions.map((rendition) =>
      JSON.stringify({
        profile: rendition.profile,
        policy: rendition.policy,
        variants: rendition.entries.map((entry) => entry.chosenVariant),
      }),
    )

    expect(new Set(renditionSignatures)).toHaveLength(LAYOUT_TARGETS.length)
    expect(
      new Set(
        manifest.renditions.flatMap((rendition) =>
          rendition.entries
            .filter((entry) => entry.nodeType === 'figure')
            .map((entry) => entry.chosenVariant),
        ),
      ),
    ).toEqual(new Set(['edge-to-edge', 'compact-stack', 'inline', 'full-span']))

    for (const rendition of manifest.renditions) {
      expect(rendition.contentHash).toBe(manifest.document.contentHash)
      expect(rendition.entries.map((entry) => entry.canonicalId)).toEqual(
        paper.nodes.map((node) => node.id),
      )
      expect(rendition.entries.map((entry) => entry.contentHash)).toEqual(
        paper.nodes.map((node) => canonicalNodeContentHash(node)),
      )
    }
  })

  it('records deterministic policy decisions and an explained compact-screen fallback', () => {
    const manifest = buildLayoutManifest(paper)
    const move = manifest.renditions.find(
      (rendition) => rendition.target === 'paperProMove',
    )
    if (!move) throw new Error('Manifest lost the Paper Pro Move rendition')

    expect(move.policy.decisions.map((decision) => decision.code)).toEqual([
      'flow-mode',
      'column-count',
      'figure-placement',
      'fragmentation',
    ])
    expect(
      move.policy.decisions.find(
        (decision) => decision.code === 'fragmentation',
      ),
    ).toMatchObject({ outcome: 'finite-browser-pages' })

    const figure = move.entries.find(
      (entry) => entry.canonicalId === 'fig-pipeline',
    )
    expect(figure).toMatchObject({
      chosenVariant: 'compact-stack',
      fallback: {
        fromVariant: 'dedicated-view',
        diagnosticCode: 'variant-unavailable',
        reason: expect.any(String),
      },
      diagnostics: [
        {
          code: 'variant-unavailable',
          severity: 'info',
        },
      ],
    })
  })

  it('rejects profile, policy, and node-composition drift', () => {
    const profileDrift = cloneManifest()
    profileDrift.renditions[0].profile.margins.left += 1
    expect(() => validateLayoutManifest(profileDrift, paper)).toThrow(
      /TARGET_PROFILE_MISMATCH/,
    )

    const policyDrift = cloneManifest()
    policyDrift.renditions[1].policy.decisions[0].outcome = 'browser-flow'
    expect(() => validateLayoutManifest(policyDrift, paper)).toThrow(
      /COMPOSITION_POLICY_MISMATCH/,
    )

    const variantDrift = cloneManifest()
    variantDrift.renditions[2].entries[5].chosenVariant = 'compact-stack'
    expect(() => validateLayoutManifest(variantDrift, paper)).toThrow(
      /NODE_COMPOSITION_MISMATCH/,
    )
  })

  it('accepts explicitly recorded fragments instead of a whole-node placement', () => {
    const manifest = cloneManifest()
    manifest.renditions[0].entries[1].representation = {
      kind: 'fragments',
      fragments: [
        {
          id: 'p-proposition-1:0',
          index: 0,
          lineage: {
            canonicalId: 'p-proposition-1',
            previousFragmentId: null,
            nextFragmentId: 'p-proposition-1:1',
          },
          textRange: { start: 0, end: 120 },
          placement: {
            kind: 'flow',
            order: 1,
            page: 1,
            region: 0,
            span: 'column',
          },
        },
        {
          id: 'p-proposition-1:1',
          index: 1,
          lineage: {
            canonicalId: 'p-proposition-1',
            previousFragmentId: 'p-proposition-1:0',
            nextFragmentId: null,
          },
          textRange: { start: 120, end: 260 },
          placement: {
            kind: 'flow',
            order: 2,
            page: 2,
            region: 0,
            span: 'column',
          },
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
          lineage: {
            canonicalId: 'sec-proposition',
            previousFragmentId: null,
            nextFragmentId: 'sec-proposition:part',
          },
          placement: {
            kind: 'flow',
            order: 0,
            page: 1,
            region: 0,
            span: 'column',
          },
        },
        {
          id: 'sec-proposition:part',
          index: 2,
          lineage: {
            canonicalId: 'sec-proposition',
            previousFragmentId: 'sec-proposition:part',
            nextFragmentId: null,
          },
          placement: {
            kind: 'flow',
            order: 1,
            page: 1,
            region: 0,
            span: 'column',
          },
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
      reason: 'The requested full-width variant is unavailable.',
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
        page: 1,
      },
    }

    expect(validateLayoutManifest(manifest, paper)).toBeTruthy()
    expect(canonicalContentHash(paper)).toBe(before)
    expect(researchPaperSchema.parse(rawPaper)).not.toHaveProperty(
      'targetGeometry',
    )
  })

  it('rejects zero-based rendition page numbers', () => {
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

    expect(() => layoutManifestSchema.parse(manifest)).toThrow()
  })
})
