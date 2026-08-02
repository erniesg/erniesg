import { describe, expect, it } from 'vitest'
import type {
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import {
  auditEquationRenderOnlySourceRunOwnerships,
  proveEquationRenderOnlySourceRunOwnerships,
} from './equation-render-only-ownership'

function run(
  text: string,
  x: number,
  width: number,
  fontName: string,
  sourceSequenceIndex: number,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y: 0.4,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName,
    fontSize: 12,
    sourceSequenceIndex,
    confidence: 1,
  }
}

function fixture() {
  const prefix = run('q = (', 0.35, 0.07, 'Synthetic-CMMI12', 12)
  const preceding = run(')', 0.42, 0.02, 'Synthetic-CMEX10', 13)
  const marker: PdfSourceRun = {
    ...run('\ufffd', 0.44, 0.01, 'Synthetic-CMEX10', 14),
    sourceSemanticAdmission: {
      algorithm: 'pdf-text-item-semantic-admission-v1' as const,
      status: 'unresolved-extension-glyph' as const,
    },
  }
  const following = run('ν', 0.45, 0.02, 'Synthetic-CMMI12', 15)
  const line = {
    id: 'equation-line',
    text: 'q = ()ν',
    fontSize: 12,
    box: {
      page: 1,
      x: 0.35,
      y: 0.39,
      width: 0.12,
      height: 0.04,
      rotation: 0,
      method: 'pdf-text' as const,
    },
    runs: [prefix, preceding, following],
  }
  const region: PdfPageRegion = {
    id: 'equation-region',
    page: 1,
    kind: 'equation',
    column: 'single',
    text: line.text,
    confidence: 1,
    box: { ...line.box },
    lines: [line],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
  const page: PdfPageAnalysis = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 8,
    imageCount: 0,
    runs: [prefix, preceding, following],
    renderVisibleTextRuns: [prefix, preceding, marker, following],
  }
  const scope = {
    id: 'equation-scope',
    page: 1,
    sourceRegionIds: [region.id],
    sourceLineIds: [line.id],
  }
  return { following, line, marker, page, preceding, region, scope }
}

function unrelatedRegion(source: ReturnType<typeof fixture>) {
  const unrelatedRun = run('z', 0.7, 0.01, 'Synthetic-CMMI12', 99)
  const unrelatedLine = {
    ...source.line,
    id: 'unrelated-line',
    text: unrelatedRun.text,
    box: {
      ...source.line.box,
      x: unrelatedRun.x,
      width: unrelatedRun.width,
    },
    runs: [unrelatedRun],
  }
  const region: PdfPageRegion = {
    ...source.region,
    id: 'unrelated-region',
    text: unrelatedLine.text,
    box: { ...unrelatedLine.box },
    lines: [unrelatedLine],
  }
  return { line: unrelatedLine, region }
}

describe('render-only equation source-run ownership', () => {
  it('proves one uniquely bracketed assembly item without publishing it as source text', () => {
    const source = fixture()
    const result = proveEquationRenderOnlySourceRunOwnerships({
      pages: [source.page],
      regions: [source.region],
      scopes: [source.scope],
    })

    expect(result.get(source.scope.id)).toMatchObject({
      sourceRuns: [
        expect.objectContaining({
          text: '\ufffd',
          sourceSequenceIndex: 14,
        }),
      ],
      ownerships: [
        expect.objectContaining({
          sourceLineId: source.line.id,
          sourceSequenceIndex: 14,
          precedingSourceSequenceIndex: 13,
          followingSourceSequenceIndex: 15,
        }),
      ],
    })
    expect(source.region.text).not.toContain('\ufffd')
    expect(source.region.lines[0].runs).not.toContain(source.marker)
  })

  it.each([
    {
      name: 'missing semantic-admission provenance',
      mutate: (source: ReturnType<typeof fixture>) => {
        delete source.marker.sourceSemanticAdmission
      },
    },
    {
      name: 'horizontal gap before the marker',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.marker.x += 0.002
        source.marker.width -= 0.002
      },
    },
    {
      name: 'no same-font assembly neighbor',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.marker.fontName = 'Synthetic-CMEX99'
      },
    },
  ])('fails closed for $name', ({ mutate }) => {
    const source = fixture()
    mutate(source)

    expect(
      proveEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region],
        scopes: [source.scope],
      }).get(source.scope.id),
    ).toBeUndefined()
  })

  it('fails closed when the bracketing runs are owned by different lines', () => {
    const source = fixture()
    source.line.runs = source.line.runs.filter(
      (candidate) => candidate !== source.following,
    )
    const competingLine = {
      ...source.line,
      id: 'competing-prose-line',
      text: source.following.text,
      runs: [source.following],
    }
    const competingRegion: PdfPageRegion = {
      ...source.region,
      id: 'competing-prose-region',
      kind: 'body',
      text: competingLine.text,
      lines: [competingLine],
    }

    expect(
      proveEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region, competingRegion],
        scopes: [source.scope],
      }).get(source.scope.id),
    ).toBeUndefined()
  })

  it('fails closed when two component scopes claim the same bracketing line', () => {
    const source = fixture()

    expect(
      proveEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region],
        scopes: [
          source.scope,
          {
            ...source.scope,
            id: 'competing-equation-scope',
          },
        ],
      }).size,
    ).toBe(0)
  })

  it('fails closed when a duplicate page-number container is an empty twin', () => {
    const source = fixture()
    const emptyTwin: PdfPageAnalysis = {
      ...source.page,
      runs: [],
      renderVisibleTextRuns: [],
    }

    expect(
      proveEquationRenderOnlySourceRunOwnerships({
        pages: [source.page, emptyTwin],
        regions: [source.region],
        scopes: [source.scope],
      }).size,
    ).toBe(0)
  })

  it('fails closed when a page container owns runs carrying another page number', () => {
    const source = fixture()
    source.page.page = 2

    expect(
      proveEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region],
        scopes: [source.scope],
      }).size,
    ).toBe(0)
  })

  it.each([
    {
      name: 'nonexistent source region id',
      mutate: (
        source: ReturnType<typeof fixture>,
        _unrelated: ReturnType<typeof unrelatedRegion>,
      ) => {
        source.scope.sourceRegionIds.push('missing-region')
      },
    },
    {
      name: 'nonexistent source line id',
      mutate: (
        source: ReturnType<typeof fixture>,
        _unrelated: ReturnType<typeof unrelatedRegion>,
      ) => {
        source.scope.sourceLineIds.push('missing-line')
      },
    },
    {
      name: 'extra source region with no selected line',
      mutate: (
        source: ReturnType<typeof fixture>,
        unrelated: ReturnType<typeof unrelatedRegion>,
      ) => {
        source.scope.sourceRegionIds.push(unrelated.region.id)
      },
    },
    {
      name: 'extra source line outside the selected regions',
      mutate: (
        source: ReturnType<typeof fixture>,
        unrelated: ReturnType<typeof unrelatedRegion>,
      ) => {
        source.scope.sourceLineIds.push(unrelated.line.id)
      },
    },
  ])('fails closed for an inexact scope: $name', ({ mutate }) => {
    const source = fixture()
    const unrelated = unrelatedRegion(source)
    mutate(source, unrelated)

    expect(
      proveEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region, unrelated.region],
        scopes: [source.scope],
      }).size,
    ).toBe(0)
  })

  it('fails closed when region ids are not globally unique', () => {
    const source = fixture()
    const emptyTwin: PdfPageRegion = {
      ...source.region,
      lines: [],
    }

    expect(
      proveEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region, emptyTwin],
        scopes: [source.scope],
      }).size,
    ).toBe(0)
  })

  it('fails closed when line ids are not globally unique', () => {
    const source = fixture()
    const duplicateLineRegion: PdfPageRegion = {
      ...source.region,
      id: 'duplicate-line-region',
      lines: [
        {
          ...source.line,
          runs: [],
        },
      ],
    }

    expect(
      proveEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region, duplicateLineRegion],
        scopes: [source.scope],
      }).size,
    ).toBe(0)
  })

  it('fails closed when scope ids are not globally unique', () => {
    const source = fixture()
    const unrelated = unrelatedRegion(source)

    expect(
      proveEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region, unrelated.region],
        scopes: [
          source.scope,
          {
            id: source.scope.id,
            page: 1,
            sourceRegionIds: [unrelated.region.id],
            sourceLineIds: [unrelated.line.id],
          },
        ],
      }).size,
    ).toBe(0)
  })

  it.each(['preceding', 'following'] as const)(
    'fails closed for a negative-width %s neighbor',
    (neighbor) => {
      const source = fixture()
      if (neighbor === 'preceding') {
        source.preceding.x = source.marker.x + 0.02
        source.preceding.width = -0.02
      } else {
        source.following.width = -0.02
      }

      expect(
        proveEquationRenderOnlySourceRunOwnerships({
          pages: [source.page],
          regions: [source.region],
          scopes: [source.scope],
        }).size,
      ).toBe(0)
    },
  )

  it('retains an ownership obligation when the middle render item is deleted', () => {
    const source = fixture()
    source.page.renderVisibleTextRuns = [
      source.page.renderVisibleTextRuns![0],
      source.preceding,
      source.following,
    ]

    const audit = auditEquationRenderOnlySourceRunOwnerships({
      pages: [source.page],
      regions: [source.region],
      scopes: [source.scope],
    })

    expect(audit.structurallyValid).toBe(true)
    expect(audit.projections.get(source.scope.id)).toBeUndefined()
    expect(audit.obligationScopeIds).toContain(source.scope.id)
  })

  it.each([
    {
      name: 'ordinary non-CMEX sequence gap',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.preceding.fontName = 'Synthetic-CMMI12'
      },
    },
    {
      name: 'ordinary explicit-whitespace sequence gap',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.following = {
          ...source.following,
          sourceWhitespaceBefore: 'pdf-text-item',
          sourceWhitespacePredecessorIndex:
            source.preceding.sourceSequenceIndex!,
        }
        source.line.runs[source.line.runs.length - 1] = source.following
      },
    },
    {
      name: 'unbounded horizontal gap',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.following.x = 0.465
        source.line.box.width = 0.15
        source.region.box.width = 0.15
      },
    },
    {
      name: 'sequence gap without a geometric gap',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.following.x = source.preceding.x + source.preceding.width
      },
    },
  ])('does not infer an obligation from an $name', ({ mutate }) => {
    const source = fixture()
    mutate(source)
    source.page.renderVisibleTextRuns = [
      source.page.renderVisibleTextRuns![0],
      source.preceding,
      source.following,
    ]

    const audit = auditEquationRenderOnlySourceRunOwnerships({
      pages: [source.page],
      regions: [source.region],
      scopes: [source.scope],
    })

    expect(audit.structurallyValid).toBe(true)
    expect(audit.obligationScopeIds).not.toContain(source.scope.id)
  })

  it('does not issue ownership for a marker whose deletion leaves an unbounded gap', () => {
    const source = fixture()
    source.marker.width = 0.015
    source.following.x = source.marker.x + source.marker.width
    source.line.box.width = 0.125
    source.region.box.width = 0.125

    const audit = auditEquationRenderOnlySourceRunOwnerships({
      pages: [source.page],
      regions: [source.region],
      scopes: [source.scope],
    })

    expect(audit.structurallyValid).toBe(true)
    expect(audit.projections.get(source.scope.id)).toBeUndefined()
  })

  it('does not issue ownership when the bracketing runs are not adjacent in their source line', () => {
    const source = fixture()
    const intervening = {
      ...source.following,
      text: 'x',
      x: 0.38,
      width: 0.01,
      sourceSequenceIndex: 99,
    }
    source.line.runs = [
      source.line.runs[0],
      source.preceding,
      intervening,
      source.following,
    ]
    source.page.runs.push(intervening)
    source.page.renderVisibleTextRuns!.push(intervening)

    const audit = auditEquationRenderOnlySourceRunOwnerships({
      pages: [source.page],
      regions: [source.region],
      scopes: [source.scope],
    })

    expect(audit.structurallyValid).toBe(true)
    expect(audit.projections.get(source.scope.id)).toBeUndefined()
  })

  it('does not issue ownership when another render item shares the marker sequence', () => {
    const source = fixture()
    const duplicateSequence = {
      ...source.following,
      text: 'x',
      x: 0.38,
      width: 0.01,
      sourceSequenceIndex: source.marker.sourceSequenceIndex,
    }
    source.page.renderVisibleTextRuns!.push(duplicateSequence)

    const audit = auditEquationRenderOnlySourceRunOwnerships({
      pages: [source.page],
      regions: [source.region],
      scopes: [source.scope],
    })

    expect(audit.structurallyValid).toBe(true)
    expect(audit.projections.get(source.scope.id)).toBeUndefined()
  })

  it.each([
    {
      name: 'infinite selected-line width',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.line.box.width = Number.POSITIVE_INFINITY
      },
    },
    {
      name: 'zero selected-line height',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.line.box.height = 0
      },
    },
    {
      name: 'infinite region width',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.region.box.width = Number.POSITIVE_INFINITY
      },
    },
    {
      name: 'zero region height',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.region.box.height = 0
      },
    },
    {
      name: 'region page/box mismatch',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.region.box.page = 2
      },
    },
    {
      name: 'line page/region mismatch',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.line.box.page = 2
      },
    },
    {
      name: 'line/region rotation mismatch',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.line.box.rotation = 90
      },
    },
    {
      name: 'line outside its region',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.line.box.x = 0.2
      },
    },
    {
      name: 'run page/line mismatch',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.preceding.page = 2
      },
    },
    {
      name: 'run/line rotation mismatch',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.preceding.rotation = 90
      },
    },
    {
      name: 'run outside its line',
      mutate: (source: ReturnType<typeof fixture>) => {
        source.preceding.x = 0.8
      },
    },
  ])('fails closed for structurally invalid geometry: $name', ({ mutate }) => {
    const source = fixture()
    mutate(source)

    const audit = auditEquationRenderOnlySourceRunOwnerships({
      pages: [source.page],
      regions: [source.region],
      scopes: [source.scope],
    })

    expect(audit.structurallyValid).toBe(false)
    expect(audit.projections.size).toBe(0)
  })

  it('fails closed for a nonblank competing region with no lines', () => {
    const source = fixture()
    const competingRegion: PdfPageRegion = {
      ...source.region,
      id: 'competing-prose-region',
      kind: 'body',
      text: 'competing prose',
      lines: [],
    }

    expect(
      auditEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region, competingRegion],
        scopes: [source.scope],
      }).structurallyValid,
    ).toBe(false)
  })

  it('fails closed for a blank competing line with a nonblank overlapping run', () => {
    const source = fixture()
    const competingRun = {
      ...source.preceding,
      sourceSequenceIndex: 99,
    }
    const competingLine = {
      ...source.line,
      id: 'competing-prose-line',
      text: '',
      runs: [competingRun],
    }
    const competingRegion: PdfPageRegion = {
      ...source.region,
      id: 'competing-prose-region',
      kind: 'body',
      text: competingRun.text,
      lines: [competingLine],
    }

    expect(
      auditEquationRenderOnlySourceRunOwnerships({
        pages: [source.page],
        regions: [source.region, competingRegion],
        scopes: [source.scope],
      }).structurallyValid,
    ).toBe(false)
  })
})
