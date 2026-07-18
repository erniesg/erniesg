import { describe, expect, it } from 'vitest'
import {
  ambiguousNoteMarkerFixture,
  decisiveNoteMarkerFixtures,
  orphanedNoteFixture,
  type NoteMarkerFixture,
} from '../../tests/fixtures/note-marker-fixtures'
import type { ReconstructionDiagnostic } from './import-types'
import {
  PDF_NOTE_RELATIONSHIP_THRESHOLD,
  reconstructPageAnalyses,
} from './pdf-layout'
import { PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD } from './pdf-note-classifier'

const BLOCKING_NOTE_CODES = new Set<ReconstructionDiagnostic['code']>([
  'UNRESOLVED_NOTE_REFERENCE',
  'AMBIGUOUS_NOTE_MATCH',
  'UNREFERENCED_NOTE',
])

function reconstruct(fixture: NoteMarkerFixture, hashCharacter: string) {
  return reconstructPageAnalyses({
    pages: fixture.pages,
    sourceHash: hashCharacter.repeat(64),
    fileName: `${fixture.name.replace(/[^a-z0-9]+/gi, '-')}.pdf`,
    byteLength: 4096,
  })
}

function markerDiagnostics(
  result: Awaited<ReturnType<typeof reconstruct>>,
) {
  return result.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'CLASSIFIED_NOTE_MARKER',
  )
}

describe('scholarly note-marker taxonomy', () => {
  for (const [index, fixture] of decisiveNoteMarkerFixtures.entries()) {
    it(`classifies ${fixture.name} with recorded deciding evidence`, async () => {
      const result = await reconstruct(fixture, String(index + 1))
      const diagnostics = markerDiagnostics(result)

      expect(
        diagnostics.map(
          (diagnostic) => diagnostic.noteMarkerClassification?.taxonomy,
        ),
      ).toEqual(fixture.expectedTaxonomies)
      expect(diagnostics).toHaveLength(fixture.expectedTaxonomies.length)
      expect(
        diagnostics.every(
          (diagnostic) =>
            diagnostic.severity === 'info' &&
            diagnostic.noteMarkerClassification !== undefined &&
            diagnostic.noteMarkerClassification.evidence.length > 0 &&
            diagnostic.noteMarkerClassification.threshold ===
              PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
        ),
      ).toBe(true)
      expect(
        result.diagnostics.filter((diagnostic) =>
          BLOCKING_NOTE_CODES.has(diagnostic.code),
        ),
      ).toEqual([])
    })
  }

  it('keeps citations and scholarly cross-references as prose without note relationships', async () => {
    for (const [index, fixture] of decisiveNoteMarkerFixtures
      .slice(0, 4)
      .entries()) {
      const result = await reconstruct(fixture, String(index + 1))
      expect(result.noteRelationships).toEqual([])
      expect(result.semanticSignals).toMatchObject({
        footnoteReferences: 0,
        footnotes: 0,
      })
    }
  })

  it('preserves bibliography entries in node order instead of emitting orphaned notes', async () => {
    const fixture = decisiveNoteMarkerFixtures[1]
    const result = await reconstruct(fixture, '7')

    expect(result.paper.nodes.map((node) => node.type)).toEqual([
      'paragraph',
      'heading',
      'paragraph',
      'heading',
      'paragraph',
      'paragraph',
    ])
    expect(
      result.paper.nodes.map((node) => ('text' in node ? node.text : '')),
    ).toEqual([
      'Superscript citation study',
      'Abstract',
      'Prior evidence¹,² supports the claim.',
      'References',
      '1. First citation.',
      '2. Second citation.',
    ])
    expect(result.paper.nodes.some((node) => node.type === 'footnote')).toBe(
      false,
    )
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNREFERENCED_NOTE' }),
      ]),
    )
  })

  it('accepts true note relationships only at the documented threshold and retains node order', async () => {
    for (const [fixtureIndex, fixture] of decisiveNoteMarkerFixtures
      .slice(4)
      .entries()) {
      const result = await reconstruct(fixture, String(fixtureIndex + 8))
      expect(result.noteRelationships).toEqual([
        expect.objectContaining({
          status: 'matched',
          threshold: PDF_NOTE_RELATIONSHIP_THRESHOLD,
          evidence: expect.arrayContaining(['label-exact']),
        }),
      ])
      expect(result.noteRelationships[0].confidence).toBeGreaterThanOrEqual(
        result.noteRelationships[0].threshold,
      )
      const note = result.paper.nodes.find((node) => node.type === 'footnote')
      expect(note).toBeDefined()
      expect(result.paper.nodes.indexOf(note!)).toBeGreaterThan(0)
      expect(note?.relationships.backlinks).toEqual([
        result.noteRelationships[0].id,
      ])
    }
  })

  it('keeps genuinely ambiguous matches blocked below the uniqueness margin', async () => {
    const result = await reconstruct(ambiguousNoteMarkerFixture, 'a')

    expect(markerDiagnostics(result)).toEqual([
      expect.objectContaining({
        noteMarkerClassification: expect.objectContaining({
          taxonomy: 'footnote-reference',
        }),
      }),
    ])
    expect(result.noteRelationships).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        targetNoteId: null,
        threshold: PDF_NOTE_RELATIONSHIP_THRESHOLD,
      }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_NOTE_MATCH',
          severity: 'error',
        }),
      ]),
    )
  })

  it('still blocks genuinely orphaned note bodies', async () => {
    const result = await reconstruct(orphanedNoteFixture, 'b')

    expect(markerDiagnostics(result)).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_NOTE',
          severity: 'error',
        }),
      ]),
    )
  })
})
