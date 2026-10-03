import { describe, expect, it } from 'vitest'

import {
  createSketchSvg,
  decodeSketch,
  encodeSketch,
  noteText,
  previewAspectRatio,
  regionWithinBounds,
  sketchPathData,
  updateSketchNote,
  type Sketch,
} from './sketch.js'

const sketch: Sketch = {
  version: 1,
  note: 'Circle the conclusion.',
  anchor: { blockId: 'chapter-1-p-4', quote: 'The conclusion.' },
  region: { x: 0.125, y: -0.04, width: 0.5, height: 0.2 },
  strokes: [
    [
      [0, 0],
      [0.5, 0.25],
      [1, 1],
    ],
  ],
}

class SvgNode {
  readonly attributes = new Map<string, string>()
  readonly children: SvgNode[] = []

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  append(child: SvgNode) {
    this.children.push(child)
  }
}

describe('sketch notes', () => {
  it('round-trips a sketch through the plain-text note envelope', () => {
    expect(decodeSketch(encodeSketch(sketch))).toEqual(sketch)
  })

  it('rejects malformed and out-of-bounds envelopes without throwing', () => {
    expect(decodeSketch('an ordinary note')).toBeNull()
    expect(decodeSketch('margin:sketch:v1\n{')).toBeNull()
    expect(decodeSketch(`${'margin:sketch:v1\n'}${' '.repeat(8001)}`)).toBeNull()
    expect(
      decodeSketch(
        'margin:sketch:v1\n{"version":1,"note":"x","anchor":{"blockId":"p","quote":"q"},"region":{"x":0,"y":0,"width":101,"height":1},"strokes":[]}',
      ),
    ).toBeNull()
    expect(
      decodeSketch(
        'margin:sketch:v1\n{"version":1,"note":"x","anchor":{"blockId":"","quote":"q"},"region":{"x":0,"y":0,"width":1,"height":1},"strokes":[]}',
      ),
    ).toBeNull()
    expect(
      decodeSketch(
        'margin:sketch:v1\n{"version":1,"note":"x","anchor":{"blockId":"p","quote":""},"region":{"x":0,"y":0,"width":1,"height":1},"strokes":[]}',
      ),
    ).toBeNull()
    expect(() =>
      encodeSketch({ ...sketch, anchor: { blockId: 'p', quote: '' } }),
    ).toThrow(/invalid sketch/i)
    expect(() =>
      encodeSketch({ ...sketch, strokes: [[[0, 0], [1.1, 0]]] }),
    ).toThrow(/invalid sketch/i)
    expect(() => encodeSketch({ ...sketch, note: 'x'.repeat(2001) })).toThrow(
      /invalid sketch/i,
    )
    expect(() =>
      encodeSketch({
        ...sketch,
        strokes: Array.from({ length: 100 }, () =>
          Array.from(
            { length: 10 },
            () => [0.12345678901234567, 0.12345678901234567] as [number, number],
          ),
        ),
      }),
    ).toThrow(/invalid sketch/i)
  })

  it('keeps the drawing and anchor when a reader changes its note', () => {
    const body = updateSketchNote(
      encodeSketch(sketch),
      'Underline this instead.',
    )

    expect(noteText(body)).toBe('Underline this instead.')
    expect(decodeSketch(body)).toEqual({
      version: 1,
      note: 'Underline this instead.',
      anchor: { blockId: 'chapter-1-p-4', quote: 'The conclusion.' },
      region: { x: 0.125, y: -0.04, width: 0.5, height: 0.2 },
      strokes: [
        [
          [0, 0],
          [0.5, 0.25],
          [1, 1],
        ],
      ],
    })
  })

  it('leaves regular note bodies untouched', () => {
    expect(noteText('A regular note')).toBe('A regular note')
    expect(updateSketchNote('A regular note', 'An edited note')).toBe(
      'An edited note',
    )
  })

  it('builds path data only from normalized point coordinates', () => {
    expect(sketchPathData([[0, 0], [0.5, 0.25], [1, 1]])).toBe(
      'M 0 0 L 500 250 L 1000 1000',
    )
    expect(() => sketchPathData([[0, 0], [Number.NaN, 1]])).toThrow(
      /invalid sketch/i,
    )
  })

  it('creates a numeric SVG preview without parsing sketch text as markup', () => {
    const document = {
      createElementNS: () => new SvgNode(),
    } as unknown as Document

    const svg = createSketchSvg(sketch, document) as unknown as SvgNode
    expect(svg.attributes.get('viewBox')).toBe('0 0 1000 1000')
    expect(svg.attributes.get('preserveAspectRatio')).toBe('none')
    expect(svg.children[0]?.attributes.get('d')).toBe(
      'M 0 0 L 500 250 L 1000 1000',
    )
    expect(svg.children[0]?.attributes.get('stroke')).toBe('#0369a1')
  })

  // Regions are fractions of the anchor block's width. A stored sketch is
  // untrusted: one out of any drawable range, or a sliver, must not stretch
  // the page or the rail for every reader who receives it.
  it('treats geometry no drag could produce as malformed', () => {
    const envelope = (region: Record<string, number>) =>
      `margin:sketch:v1\n${JSON.stringify({ ...sketch, region })}`
    for (const region of [
      { x: 0, y: 0, width: 0.000001, height: 1 },
      { x: 0, y: 0, width: 1, height: 0.000001 },
      { x: 0, y: 0, width: 1, height: 100 },
      { x: 0, y: 0, width: 3, height: 1 },
      { x: 0, y: 99, width: 1, height: 1 },
      { x: 50, y: 0, width: 1, height: 1 },
    ]) {
      expect(decodeSketch(envelope(region)), JSON.stringify(region)).toBeNull()
    }
    expect(decodeSketch(envelope({ x: -0.2, y: 4, width: 1.2, height: 4.5 }))).not.toBeNull()
    // The drag code asks the same question before it builds a draft.
    expect(regionWithinBounds({ x: 0, y: 0, width: 1, height: 100 })).toBe(false)
    expect(regionWithinBounds({ x: -0.2, y: 4, width: 1.2, height: 4.5 })).toBe(true)
  })

  it('keeps the rail preview between 1:4 and 4:1', () => {
    const ratio = (width: number, height: number) =>
      previewAspectRatio({ x: 0, y: 0, width, height })
    expect(ratio(0.5, 0.2)).toBe('0.5 / 0.2')
    expect(ratio(0.01, 5)).toBe('1 / 4')
    expect(ratio(2, 0.01)).toBe('4 / 1')
  })
})

