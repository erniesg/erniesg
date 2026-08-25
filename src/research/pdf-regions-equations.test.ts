import { strFromU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { buildReadableEpub, inspectEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import {
  proseDominantPdfMathSource,
  reconstructPageRegions,
} from './pdf-regions'
import type { PdfFigureRasterizer } from './pdf-visuals'
import { createSourcePageCropAsset } from './visual-assets'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = 0.018,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function page(
  number: number,
  runs: PdfSourceRun[],
  objects: NonNullable<PdfPageAnalysis['objects']> = [],
): PdfPageAnalysis {
  return {
    page: number,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: objects.length,
    objects,
    runs,
  }
}

function withExplicitEnglishLanguage(page: PdfPageAnalysis): PdfPageAnalysis {
  return {
    ...page,
    ocr: {
      engine: 'test-language-authority',
      engineVersion: '1',
      model: 'test-en',
      modelVersion: '1',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: '1'.repeat(64),
      rasterSha256: '2'.repeat(64),
      confidence: 1,
      words: [],
      lines: [],
    },
  }
}

async function reconstruct(pages: PdfPageAnalysis[], hash = '7') {
  return reconstructPageAnalyses({
    pages,
    sourceHash: hash.repeat(64),
    fileName: 'regions.pdf',
    byteLength: 4096,
  })
}

describe('deterministic scholarly page regions', () => {
  it('keeps a detached right-margin equation number out of following prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'CR = m/N × 100%,', 0.22, 0.4, 0.17),
        run(1, '(4)', 0.466, 0.4, 0.022),
        run(
          1,
          'where N is the number of quadruples in the graph.',
          0.12,
          0.424,
          0.37,
        ),
      ]),
    ])

    const texts = result.regions.map((region) => region.text)
    expect(texts).toContain('(4)')
    expect(texts).toContain('where N is the number of quadruples in the graph.')
    expect(texts).not.toContain(
      '(4) where N is the number of quadruples in the graph.',
    )
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.list !== undefined &&
          node.text.includes('quadruples'),
      ),
    ).toBe(false)
  })

  it('isolates compact unsafe CMEX glyph lines as equation fragments', () => {
    const largeOperator = run(1, 'Z', 0.36, 0.5, 0.018)
    const delimiter = run(1, '\u0000', 0.382, 0.5, 0.01)
    delimiter.fontName = 'Synthetic-CMEX10'
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        run(1, 'The drift is pinned down by', 0.1, 0.47, 0.24),
        largeOperator,
        delimiter,
        run(1, 'μ(t, x) = a + b', 0.4, 0.53, 0.22),
      ]),
    ])

    const fragment = result.regions.find((region) =>
      region.text.includes('\u0000'),
    )
    expect(fragment).toMatchObject({
      kind: 'equation',
      text: '\u0000',
    })
    expect(fragment?.text).not.toContain('Z')
    expect(fragment?.text).not.toContain('The drift is pinned down by')
    expect(fragment?.text).not.toContain('μ(t, x)')
  })

  it('isolates a nonpublishable CMEX line without relying on compact math text', () => {
    const replacement = run(1, '\ufffd', 0.312, 0.37798, 0.012, 11, 0.0142)
    replacement.fontName = 'Synthetic-CMEX99'
    const left = run(1, 'N(a,b)', 0.25, 0.38948, 0.06, 11, 0.0142)
    left.fontName = 'Synthetic-CMMI10'
    const right = run(1, 'cdefghijklmnop', 0.326, 0.38948, 0.18, 11, 0.0142)
    right.fontName = 'Synthetic-CMMI10'

    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        run(1, 'Preceding prose must remain accessible.', 0.12, 0.34, 0.42),
        left,
        replacement,
        right,
        run(1, 'Following prose must remain accessible.', 0.12, 0.42843, 0.42),
      ]),
    ])

    const fragment = result.regions.find((region) =>
      region.lines.some((line) =>
        line.runs.some((sourceRun) => sourceRun.text.includes('\ufffd')),
      ),
    )
    expect(fragment).toMatchObject({ kind: 'equation' })
    expect(fragment?.text).toContain('\ufffd')
    expect(fragment?.text).not.toContain(
      'Preceding prose must remain accessible.',
    )
    expect(fragment?.text).not.toContain(
      'Following prose must remain accessible.',
    )
    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'body',
          text: 'Preceding prose must remain accessible.',
        }),
        expect.objectContaining({
          kind: 'body',
          text: 'Following prose must remain accessible.',
        }),
      ]),
    )
  })

  it('keeps prose-dominant lines with inline math and CMEX accents out of display equations', () => {
    const accent = run(1, '\u0302', 0.302, 0.4, 0.012)
    accent.fontName = 'Synthetic-CMEX10'
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        run(1, 'over [t, t + ∆] be ν', 0.1, 0.4, 0.2),
        accent,
        run(
          1,
          'b(t, ∆) (aggregate across positions). Hedge via an x-variance strip with safeguards.',
          0.315,
          0.4,
          0.57,
        ),
        run(
          1,
          '2. Compute rx and δx via (8)–(9); produce xbid/ask and display pbid/ask = S(·) with safeguards.',
          0.1,
          0.48,
          0.78,
        ),
        run(1, 'β = Cov(x, y) ≈ ρ.', 0.32, 0.58, 0.3),
      ]),
    ])

    expect(
      result.regions.find((region) => region.text.includes('Hedge via')),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) => region.text.startsWith('2. Compute')),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) => region.text === 'β = Cov(x, y) ≈ ρ.'),
    ).toMatchObject({ kind: 'equation' })
  })

  it('keeps held-out prose with one unresolved CMEX glyph out of display equations', () => {
    const unresolvedGlyph = run(1, '\ufffd', 0.525, 0.4, 0.012)
    unresolvedGlyph.fontName = 'Synthetic-CMEX99'
    const shortPrefix = run(1, 'Ask us if x is in y', 0.1, 0.48, 0.22)
    shortPrefix.fontName = 'Synthetic-CMMI10'
    const shortGlyph = run(1, '\ufffd', 0.322, 0.48, 0.012)
    shortGlyph.fontName = 'Synthetic-CMEX99'
    const shortSuffix = run(1, 'now.', 0.338, 0.48, 0.05)
    shortSuffix.fontName = 'Synthetic-CMMI10'
    const punctuatedPrefix = run(1, 'Go, do; it.', 0.1, 0.56, 0.12)
    punctuatedPrefix.fontName = 'Synthetic-CMMI10'
    const punctuatedGlyph = run(1, '\ufffd', 0.222, 0.56, 0.012)
    punctuatedGlyph.fontName = 'Synthetic-CMEX99'
    const bracketedPrefix = run(
      1,
      '（Read1） （this1） （now1）',
      0.1,
      0.64,
      0.24,
    )
    bracketedPrefix.fontName = 'Synthetic-CMMI10'
    const bracketedGlyph = run(1, '\ufffd', 0.342, 0.64, 0.012)
    bracketedGlyph.fontName = 'Synthetic-CMEX99'
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        run(1, 'Sensitivity analysis demonstrates robustness', 0.1, 0.4, 0.415),
        unresolvedGlyph,
        run(1, 'across conditions.', 0.55, 0.4, 0.16),
        shortPrefix,
        shortGlyph,
        shortSuffix,
        punctuatedPrefix,
        punctuatedGlyph,
        bracketedPrefix,
        bracketedGlyph,
      ]),
    ])

    expect(
      result.regions.find((region) =>
        region.text.includes('Sensitivity analysis'),
      ),
    ).toMatchObject({
      kind: 'body',
    })
    expect(
      result.regions.find((region) =>
        region.text.includes('across conditions.'),
      ),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) => region.text.includes('Ask us if')),
    ).toMatchObject({
      kind: 'body',
      text: expect.stringContaining('now.'),
    })
    expect(
      result.regions.find((region) => region.text.includes('Go, do; it.')),
    ).toMatchObject({
      kind: 'body',
    })
    expect(
      result.regions.find((region) =>
        region.text.includes('（Read1） （this1） （now1）'),
      ),
    ).toMatchObject({
      kind: 'body',
    })
    expect(
      result.regions
        .filter((region) => region.kind === 'equation')
        .some((region) => /\p{L}{3,}/u.test(region.text)),
    ).toBe(false)
  })

  it('keeps narrow Type3 prose sentences with one relation out of display equations', () => {
    const firstCount = run(
      1,
      "* First letter: 'r' - This is an 'r', count = 1.",
      0.12,
      0.4,
      0.27,
    )
    firstCount.fontName = 'Synthetic-Type3'
    const seventhCount = run(
      1,
      "* Seventh letter: 'r' - This is an 'r', count = 2.",
      0.12,
      0.44,
      0.28,
    )
    seventhCount.fontName = 'Synthetic-Type3'
    const lexicalEquation = run(
      1,
      'The expected token count = total sequence length.',
      0.34,
      0.52,
      0.27,
    )
    const mathFontEquation = run(
      1,
      'This value is the expected token count = total sequence length.',
      0.33,
      0.58,
      0.29,
    )
    mathFontEquation.fontName = 'Synthetic-CMMI10'
    const multipleRelationEquation = run(
      1,
      'This value is token count = sequence length ≈ budget size.',
      0.33,
      0.64,
      0.29,
    )
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        firstCount,
        seventhCount,
        lexicalEquation,
        mathFontEquation,
        multipleRelationEquation,
      ]),
    ])

    expect(
      result.regions.find((region) => region.text.includes('First letter')),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) => region.text.includes('Seventh letter')),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) =>
        region.text.startsWith('The expected token count'),
      ),
    ).toMatchObject({ kind: 'equation' })
    expect(
      result.regions.find((region) =>
        region.text.startsWith('This value is the expected token count'),
      ),
    ).toMatchObject({ kind: 'equation' })
    expect(
      result.regions.find((region) =>
        region.text.includes('sequence length ≈ budget size'),
      ),
    ).toMatchObject({ kind: 'equation' })
  })

  it('isolates a source-stacked terminal fraction from its prose prefix without linearizing it', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.014,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Left column line one establishes its flow.', 0.1, 0.2, 0.36),
        run(1, 'Right column line one establishes its flow.', 0.52, 0.2, 0.36),
        run(1, 'Left column line two establishes its flow.', 0.1, 0.24, 0.36),
        run(1, 'Right column line two establishes its flow.', 0.52, 0.24, 0.36),
        run(1, 'Left column line three establishes its flow.', 0.1, 0.28, 0.36),
        run(
          1,
          'Right column line three establishes its flow.',
          0.52,
          0.28,
          0.36,
        ),
        sourceRun('which we quantify with', 0.1, 0.74, 0.17, 'Synthetic-Serif'),
        sourceRun('c', 0.278, 0.74, 0.008, 'Synthetic-CMMI10'),
        sourceRun('a,b', 0.286, 0.747, 0.018, 'Synthetic-CMMI7', 7, 0.009),
        sourceRun('=', 0.309, 0.74, 0.012, 'Synthetic-CMR10'),
        sourceRun('(1', 0.33, 0.74, 0.014, 'Synthetic-CMR10'),
        sourceRun('−', 0.348, 0.74, 0.012, 'Synthetic-CMSY10'),
        sourceRun('DE', 0.366, 0.737, 0.02, 'Synthetic-CMR7', 7, 0.009),
        sourceRun('TE', 0.366, 0.75, 0.02, 'Synthetic-CMR7', 7, 0.009),
        sourceRun(')', 0.389, 0.74, 0.006, 'Synthetic-CMR10'),
        sourceRun(
          'helix(a+b)',
          0.402,
          0.737,
          0.068,
          'Synthetic-CMR7',
          7,
          0.009,
        ),
        sourceRun(
          'helix(a,b,a+b)',
          0.4,
          0.75,
          0.085,
          'Synthetic-CMR7',
          7,
          0.009,
        ),
        sourceRun('.', 0.49, 0.74, 0.005, 'Synthetic-Serif'),
        run(
          1,
          'Following prose remains independently readable.',
          0.1,
          0.78,
          0.36,
        ),
      ]),
    ])

    const prefix = result.regions.find(
      (region) => region.text === 'which we quantify with',
    )
    const formula = result.regions.find((region) =>
      region.lines.some(
        (line) =>
          line.runs.some((source) => source.text === 'DE') &&
          line.runs.some((source) => source.text === 'TE'),
      ),
    )
    const following = result.regions.find((region) =>
      region.text.includes('Following prose remains'),
    )

    expect(prefix).toMatchObject({ kind: 'body', column: 'left' })
    expect(formula).toMatchObject({ kind: 'equation', column: 'left' })
    expect(formula?.text).not.toContain('which we quantify with')
    expect(following).toMatchObject({ kind: 'body', column: 'left' })
    expect(
      result.regions
        .filter((region) => region.kind === 'body')
        .map((region) => region.text)
        .join(' '),
    ).not.toMatch(/DE\s*TE|DETE/u)
    const ordered = result.readingOrder.order
    expect(ordered.indexOf(prefix!.id)).toBeLessThan(
      ordered.indexOf(formula!.id),
    )
    expect(ordered.indexOf(formula!.id)).toBeLessThan(
      ordered.indexOf(following!.id),
    )
  })

  it('keeps an indivisible prose-heavy stacked line between display equations in reading order', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.014,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      sourceRun('u = 1506 W/m3', 0.36, 0.3, 0.24, 'Synthetic-CMMI10'),
      sourceRun(
        'The volume of the object is four thirds pi R cubed, so its new power is found below.',
        0.1,
        0.35,
        0.68,
        'Synthetic-Serif',
      ),
      sourceRun('n', 0.5, 0.343, 0.01, 'Synthetic-CMMI7', 7, 0.009),
      sourceRun('d', 0.5, 0.358, 0.01, 'Synthetic-CMMI7', 7, 0.009),
      sourceRun(
        'P = sigma A T4 = four pi sigma R2 T4',
        0.3,
        0.4,
        0.4,
        'Synthetic-CMMI10',
      ),
      run(1, 'Solving for temperature gives the next result.', 0.1, 0.46, 0.5),
    ])

    const first = reconstructPageRegions([sourcePage])
    const second = reconstructPageRegions([sourcePage])
    const prose = first.regions.find((region) =>
      region.text.includes('The volume of the object'),
    )
    const equations = first.regions.filter(
      (region) => region.kind === 'equation',
    )

    expect(prose).toMatchObject({ kind: 'body' })
    expect(
      prose?.lines.some((line) =>
        /-inline-stacked-\d+-formula$/u.test(line.id),
      ),
    ).toBe(true)
    expect(equations.map((region) => region.text)).toEqual([
      expect.stringContaining('u = 1506'),
      expect.stringContaining('P = sigma'),
    ])
    expect(equations.every((region) => !region.text.includes('volume'))).toBe(
      true,
    )
    expect(first.regions.map((region) => region.id)).toEqual(
      second.regions.map((region) => region.id),
    )
    expect(first.readingOrder.order.indexOf(equations[0].id)).toBeLessThan(
      first.readingOrder.order.indexOf(prose!.id),
    )
    expect(first.readingOrder.order.indexOf(prose!.id)).toBeLessThan(
      first.readingOrder.order.indexOf(equations[1].id),
    )
  })

  it('keeps narrow derivation lead-ins separate from source-cropped EPUB equations', async () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.014,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    expect(
      proseDominantPdfMathSource({
        text: 'Case A: x = y',
        width: 0.2,
        runs: [sourceRun('Case A: x = y', 0.1, 0.1, 0.2, 'Synthetic-Serif')],
      }),
    ).toBe(false)
    expect(
      proseDominantPdfMathSource({
        text: 'Multiply by 2:',
        width: 0.1,
        runs: [sourceRun('Multiply by 2:', 0.1, 0.1, 0.1, 'Synthetic-CMMI10')],
      }),
    ).toBe(false)
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      run(1, 'Plugging in the coordinates of C:', 0.1, 0.27, 0.22),
      sourceRun('sqrt', 0.315, 0.27, 0.02, 'Synthetic-CMEX10'),
      sourceRun(
        '(1-t)/(2 cos θ) + √3t/(2 sin θ) = 1',
        0.18,
        0.31,
        0.48,
        'Synthetic-CMMI10',
      ),
      sourceRun('Multiply by 2:', 0.1, 0.36, 0.1, 'Synthetic-Serif'),
      sourceRun('n', 0.19, 0.353, 0.01, 'Synthetic-CMMI7', 7, 0.009),
      sourceRun('d', 0.19, 0.368, 0.01, 'Synthetic-CMMI7', 7, 0.009),
      sourceRun(
        '(1-t) sin θ + √3t cos θ = 2 sin θ cos θ',
        0.12,
        0.41,
        0.62,
        'Synthetic-CMMI10',
      ),
      sourceRun(
        'sin θ - t sin θ + √3t cos θ = sin(2θ)',
        0.14,
        0.45,
        0.58,
        'Synthetic-CMMI10',
      ),
    ])

    const result = reconstructPageRegions([sourcePage])
    const coordinateLeadIn = result.regions.find((region) =>
      region.text.includes('Plugging in the coordinates'),
    )
    const multiplyLeadIn = result.regions.find((region) =>
      region.text.includes('Multiply by 2:'),
    )
    const equations = result.regions.filter(
      (region) => region.kind === 'equation',
    )

    expect(coordinateLeadIn).toMatchObject({ kind: 'body' })
    expect(multiplyLeadIn).toMatchObject({ kind: 'body' })
    expect(
      multiplyLeadIn?.lines.some((line) =>
        /-inline-stacked-\d+-formula$/u.test(line.id),
      ),
    ).toBe(true)
    expect(
      equations.every(
        (region) =>
          !region.text.includes('Plugging') &&
          !region.text.includes('Multiply by'),
      ),
    ).toBe(true)
    expect(equations.length).toBeGreaterThanOrEqual(2)
    expect(
      result.readingOrder.order.indexOf(coordinateLeadIn!.id),
    ).toBeLessThan(result.readingOrder.order.indexOf(equations[0].id))
    expect(result.readingOrder.order.indexOf(equations[0].id)).toBeLessThan(
      result.readingOrder.order.indexOf(multiplyLeadIn!.id),
    )
    expect(result.readingOrder.order.indexOf(multiplyLeadIn!.id)).toBeLessThan(
      result.readingOrder.order.indexOf(equations.at(-1)!.id),
    )

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 24,
          pixels: new Uint8Array(96 * 24 * 4).fill(72),
        }),
    )
    const reconstructed = await reconstructPageAnalyses({
      pages: [withExplicitEnglishLanguage(sourcePage)],
      sourceHash: '7'.repeat(64),
      fileName: 'derivation-regression.pdf',
      byteLength: 4096,
      rasterizeFigure,
    })
    const matchedEquations = reconstructed.visualRelationships.filter(
      (relationship) =>
        relationship.kind === 'equation' && relationship.status === 'matched',
    )
    const proseLineIds = new Set([
      ...coordinateLeadIn!.lines.map((line) => line.id),
      ...multiplyLeadIn!.lines.map((line) => line.id),
    ])

    expect(matchedEquations.length).toBeGreaterThanOrEqual(2)
    expect(
      matchedEquations.every((relationship) =>
        (relationship.sourceLineIds ?? []).every(
          (lineId) => !proseLineIds.has(lineId),
        ),
      ),
    ).toBe(true)
    expect(
      new Set(
        matchedEquations.map((relationship) => relationship.captionRegionId),
      ).size,
    ).toBe(matchedEquations.length)
    const canonicalText = reconstructed.paper.nodes
      .flatMap((node) =>
        'text' in node && typeof node.text === 'string' ? [node.text] : [],
      )
      .join('\n')
    expect(
      canonicalText.match(/Plugging in the coordinates of C:/gu),
    ).toHaveLength(1)
    expect(canonicalText.match(/Multiply by 2:/gu)).toHaveLength(1)

    const epub = await buildReadableEpub(reconstructed.paper, reconstructed)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content.match(/Plugging in the coordinates of C:/gu)).toHaveLength(1)
    expect(content.match(/Multiply by 2:/gu)).toHaveLength(1)
    expect(content).not.toContain('>Display equation p001-')
  })
})
