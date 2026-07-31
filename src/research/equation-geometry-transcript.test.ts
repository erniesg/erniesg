import { describe, expect, it } from 'vitest'
import {
  createSourceGeometryScriptTranscript,
  renderSourceGeometryScriptMathMl,
  verifySourceGeometryScriptTranscript,
} from './equation-geometry-transcript'
import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfSourceRun,
  PdfVisualAsset,
} from './import-types'
import { sha256HexSync } from './sha256-sync'

function run(
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number,
  sourceSequenceIndex: number,
  fontName = 'Synthetic-CMMI10',
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
    fontName,
    fontSize,
    sourceSequenceIndex,
    confidence: 1,
  }
}

function transcriptFixture(
  position: 'superscript' | 'subscript' | 'both' = 'superscript',
) {
  const runs = [
    run('x', 0.1, 0.2, 0.01, 0.014, 10, 0),
    ...(position === 'superscript' || position === 'both'
      ? [run('2', 0.111, 0.191, 0.006, 0.007, 7, 1)]
      : []),
    ...(position === 'subscript' || position === 'both'
      ? [run('i', 0.111, 0.215, 0.006, 0.007, 7, 2)]
      : []),
    run('=', 0.122, 0.2, 0.008, 0.014, 10, 3, 'Synthetic-CMSY10'),
    run('y', 0.136, 0.2, 0.01, 0.014, 10, 4),
  ]
  const lineBox: NormalizedSourceBox = {
    page: 1,
    x: 0.1,
    y: 0.19,
    width: 0.046,
    height: 0.033,
    rotation: 0,
    method: 'pdf-text',
  }
  const region: PdfPageRegion = {
    id: 'equation-region',
    page: 1,
    kind: 'equation',
    column: 'single',
    text: runs.map((item) => item.text).join(''),
    confidence: 1,
    box: { ...lineBox },
    lines: [
      {
        id: 'equation-line',
        text: runs.map((item) => item.text).join(''),
        fontSize: 10,
        box: { ...lineBox },
        runs,
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
  const bytes = new TextEncoder().encode('synthetic exact source crop')
  const asset: PdfVisualAsset = {
    id: 'asset-synthetic-equation-crop',
    href: 'assets/asset-synthetic-equation-crop.png',
    mediaType: 'image/png',
    kind: 'equation',
    rendition: 'source-page-crop',
    sha256: sha256HexSync(bytes),
    bytes,
    width: 200,
    height: 80,
    resolutionDpi: 144,
    sourceObjectIds: ['equation-source-object'],
    sourceBoxes: [{ ...region.box, method: 'pdf-object' }],
    sourceCropBox: {
      page: 1,
      x: 0.08,
      y: 0.17,
      width: 0.09,
      height: 0.08,
      rotation: 0,
      method: 'pdf-object',
    },
  }
  const input = {
    sourceRegionIds: [region.id],
    sourceLineIds: [region.lines[0].id],
    sourceObjectIds: [...asset.sourceObjectIds],
    regions: [region],
    sourceCropAsset: asset,
  }
  return { region, asset, input }
}

describe('source-geometry-script-transcript-v1', () => {
  it.each([
    {
      position: 'superscript' as const,
      node: {
        type: 'msup',
        base: { type: 'mi', text: 'x' },
        superscript: { type: 'mn', text: '2' },
      },
      plainText: 'x^(2) = y',
      spokenText: 'x superscript 2 equals y',
    },
    {
      position: 'subscript' as const,
      node: {
        type: 'msub',
        base: { type: 'mi', text: 'x' },
        subscript: { type: 'mi', text: 'i' },
      },
      plainText: 'x_(i) = y',
      spokenText: 'x subscript i equals y',
    },
    {
      position: 'both' as const,
      node: {
        type: 'msubsup',
        base: { type: 'mi', text: 'x' },
        subscript: { type: 'mi', text: 'i' },
        superscript: { type: 'mn', text: '2' },
      },
      plainText: 'x_(i)^(2) = y',
      spokenText: 'x subscript i superscript 2 equals y',
    },
  ])(
    'promotes one exact $position relationship without populating flat source text',
    ({ position, node, plainText, spokenText }) => {
      const { input } = transcriptFixture(position)
      const transcript = createSourceGeometryScriptTranscript(input)

      expect(transcript).toMatchObject({
        schemaVersion: '1.0.0',
        source: 'source-geometry-script-transcript-v1',
        mathml: {
          type: 'math',
          display: 'block',
          children: [
            node,
            { type: 'mo', text: '=' },
            { type: 'mi', text: 'y' },
          ],
        },
        plainText,
        spokenText,
        provenance: {
          algorithm: 'exact-unicode-math-font-script-geometry-v1',
          sourceRegionIdsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sourceLineIdsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sourceRunsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sourceCropAssetSha256: input.sourceCropAsset.sha256,
          transcriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      })
      expect(verifySourceGeometryScriptTranscript(transcript!, input)).toBe(
        true,
      )
    },
  )

  it('renders deterministic structured MathML with spoken and plain fallbacks', () => {
    const { input } = transcriptFixture('superscript')
    const transcript = createSourceGeometryScriptTranscript(input)!

    expect(
      renderSourceGeometryScriptMathMl(transcript, 'equation-description'),
    ).toBe(
      '<math xmlns="http://www.w3.org/1998/Math/MathML" id="equation-description" class="visually-hidden" display="block" data-equation-transcript-source="source-geometry-script-transcript-v1" data-equation-spoken-text="x superscript 2 equals y"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>=</mo><mi>y</mi></mrow><annotation encoding="text/plain">x^(2) = y</annotation></semantics></math>',
    )
  })

  it.each([
    {
      value: '12',
      plainText: 'x^(12) = y',
      spokenText: 'x superscript 12 equals y',
    },
    {
      value: '12.5',
      plainText: 'x^(12.5) = y',
      spokenText: 'x superscript 12.5 equals y',
    },
  ])(
    'preserves the numeric value $value in the spoken transcript',
    ({ value, plainText, spokenText }) => {
      const { region, input } = transcriptFixture('superscript')
      region.lines[0].runs[1].text = value
      region.lines[0].text = region.lines[0].runs
        .map((item) => item.text)
        .join('')
      region.text = region.lines[0].text

      const transcript = createSourceGeometryScriptTranscript(input)

      expect(transcript).toMatchObject({
        mathml: {
          children: [
            {
              type: 'msup',
              base: { type: 'mi', text: 'x' },
              superscript: { type: 'mn', text: value },
            },
            { type: 'mo', text: '=' },
            { type: 'mi', text: 'y' },
          ],
        },
        plainText,
        spokenText,
      })
    },
  )

  it.each([
    {
      label: 'source-line projection is incomplete',
      mutate: ({ input }: ReturnType<typeof transcriptFixture>) => {
        input.sourceLineIds = []
      },
    },
    {
      label: 'scope contains multiple lines',
      mutate: ({ region, input }: ReturnType<typeof transcriptFixture>) => {
        region.lines.push({
          ...structuredClone(region.lines[0]),
          id: 'second-equation-line',
        })
        input.sourceLineIds.push('second-equation-line')
      },
    },
    {
      label: 'crop is only a glyph fragment',
      mutate: ({ region, asset }: ReturnType<typeof transcriptFixture>) => {
        asset.sourceCropBox = { ...region.box, method: 'pdf-object' }
      },
    },
    {
      label: 'crop masks unowned source text',
      mutate: ({ asset }: ReturnType<typeof transcriptFixture>) => {
        asset.sourceExclusionMask = {
          algorithm: 'nearest-source-box-v1',
          expansionPixels: 2,
          ownedSourceBoxes: [],
          excludedSourceBoxes: [],
        }
      },
    },
    {
      label: 'unowned run overlaps the selected source',
      mutate: ({ region, input }: ReturnType<typeof transcriptFixture>) => {
        input.regions.push({
          ...structuredClone(region),
          id: 'unowned-region',
          lines: [
            {
              ...structuredClone(region.lines[0]),
              id: 'unowned-line',
              runs: [structuredClone(region.lines[0].runs[0])],
            },
          ],
        })
      },
    },
    {
      label: 'two adjacent bases can own the script',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0] = run('a', 0.1, 0.2, 0.002, 0.014, 10, 0)
        region.lines[0].runs.splice(
          1,
          0,
          run('x', 0.103, 0.2, 0.002, 0.014, 10, 5),
        )
        const script = region.lines[0].runs.find((item) => item.fontSize === 7)!
        script.x = 0.106
        region.lines[0].text = region.lines[0].runs
          .map((item) => item.text)
          .join('')
      },
    },
    {
      label: 'orphan denominator is centered below its alleged base',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        const script = region.lines[0].runs.find((item) => item.fontSize === 7)!
        script.y = 0.215
        script.x = 0.102
      },
    },
    {
      label: 'baseline drifts',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs.at(-1)!.y = 0.205
      },
    },
    {
      label: 'source run boxes overlap',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        const script = region.lines[0].runs.find((item) => item.fontSize === 7)!
        script.x = 0.105
        script.y = 0.198
      },
    },
    {
      label: 'source uses OCR',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0].method = 'ocr'
      },
    },
    {
      label: 'source glyph is missing',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0].text = '\ufffd'
        region.lines[0].text = region.lines[0].runs
          .map((item) => item.text)
          .join('')
      },
    },
    {
      label: 'source contains a control glyph',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0].text = '\u0012'
        region.lines[0].text = region.lines[0].runs
          .map((item) => item.text)
          .join('')
      },
    },
    {
      label: 'source uses CMEX',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
      },
    },
    {
      label: 'source contains an integral',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0].text = '∫'
        region.lines[0].text = region.lines[0].runs
          .map((item) => item.text)
          .join('')
      },
    },
    {
      label: 'source contains a fraction slash',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[2].text = '/'
        region.lines[0].text = region.lines[0].runs
          .map((item) => item.text)
          .join('')
      },
    },
    {
      label: 'source contains a root',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0].text = '√'
        region.lines[0].text = region.lines[0].runs
          .map((item) => item.text)
          .join('')
      },
    },
    {
      label: 'source contains matrix brackets',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0].text = '['
        region.lines[0].text = region.lines[0].runs
          .map((item) => item.text)
          .join('')
      },
    },
    {
      label: 'source contains an accent',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0].text = 'x\u0302'
        region.lines[0].text = region.lines[0].runs
          .map((item) => item.text)
          .join('')
      },
    },
    {
      label: 'source has incomplete parenthesis scope',
      mutate: ({ region }: ReturnType<typeof transcriptFixture>) => {
        region.lines[0].runs[0].text = '('
        region.lines[0].text = region.lines[0].runs
          .map((item) => item.text)
          .join('')
      },
    },
  ])('rejects when $label', ({ mutate }) => {
    const fixture = transcriptFixture()
    mutate(fixture)

    expect(createSourceGeometryScriptTranscript(fixture.input)).toBeNull()
  })

  it('rejects transcript or source-crop provenance drift', () => {
    const { input } = transcriptFixture()
    const transcript = createSourceGeometryScriptTranscript(input)!
    transcript.plainText = 'x^(3) = y'

    expect(verifySourceGeometryScriptTranscript(transcript, input)).toBe(false)

    const fresh = createSourceGeometryScriptTranscript(input)!
    input.sourceCropAsset.bytes = new TextEncoder().encode('drifted crop')
    expect(verifySourceGeometryScriptTranscript(fresh, input)).toBe(false)
  })
})
