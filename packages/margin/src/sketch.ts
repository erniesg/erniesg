/**
 * The compact, plain-text representation of a drawing attached to a note.
 *
 * The annotation API stores a note body as text. Keeping the versioned
 * envelope here avoids a second storage path while making malformed remote
 * bodies harmless to readers.
 */
export type Sketch = {
  version: 1
  note: string
  anchor: { blockId: string; quote: string }
  region: { x: number; y: number; width: number; height: number }
  strokes: [number, number][][]
}

export const SKETCH_PREFIX = 'margin:sketch:v1\n'

const MAX_NOTE_LENGTH = 2000
const MAX_QUOTE_LENGTH = 2000
const MAX_BLOCK_ID_LENGTH = 256
const MAX_STROKES = 100
const MAX_POINTS = 1000
const MAX_ENCODED_LENGTH = 8000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function invalidSketch(): never {
  throw new TypeError('Invalid sketch')
}

/** Validate and copy data at the envelope boundary. */
function normalizeSketch(value: unknown): Sketch {
  if (!isRecord(value) || value.version !== 1) invalidSketch()
  if (!validString(value.note, MAX_NOTE_LENGTH)) invalidSketch()

  const anchor = value.anchor
  if (
    !isRecord(anchor) ||
    !validString(anchor.blockId, MAX_BLOCK_ID_LENGTH) ||
    !validString(anchor.quote, MAX_QUOTE_LENGTH) ||
    anchor.blockId.length === 0 ||
    anchor.quote.length === 0
  )
    invalidSketch()

  const region = value.region
  if (
    !isRecord(region) ||
    !isFiniteNumber(region.x) ||
    !isFiniteNumber(region.y) ||
    !isFiniteNumber(region.width) ||
    !isFiniteNumber(region.height) ||
    region.x < -100 ||
    region.x > 100 ||
    region.y < -100 ||
    region.y > 100 ||
    region.width <= 0 ||
    region.width > 100 ||
    region.height <= 0 ||
    region.height > 100
  )
    invalidSketch()

  if (!Array.isArray(value.strokes) || value.strokes.length > MAX_STROKES)
    invalidSketch()

  let pointCount = 0
  const strokes: [number, number][][] = value.strokes.map((stroke) => {
    if (!Array.isArray(stroke)) invalidSketch()
    return stroke.map((point) => {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !isFiniteNumber(point[0]) ||
        !isFiniteNumber(point[1]) ||
        point[0] < 0 ||
        point[0] > 1 ||
        point[1] < 0 ||
        point[1] > 1 ||
        ++pointCount > MAX_POINTS
      )
        invalidSketch()
      return [point[0], point[1]]
    })
  })

  return {
    version: 1,
    note: value.note,
    anchor: { blockId: anchor.blockId, quote: anchor.quote },
    region: {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    },
    strokes,
  }
}

/** Serialize a bounded sketch into the existing annotation text body. */
export function encodeSketch(sketch: Sketch): string {
  const normalized = normalizeSketch(sketch)
  const body = `${SKETCH_PREFIX}${JSON.stringify(normalized)}`
  if (body.length > MAX_ENCODED_LENGTH) invalidSketch()
  return body
}

/** Safely recognize a sketch body received from storage, or leave it alone. */
export function decodeSketch(body: string): Sketch | null {
  if (body.length > MAX_ENCODED_LENGTH || !body.startsWith(SKETCH_PREFIX))
    return null
  try {
    return normalizeSketch(JSON.parse(body.slice(SKETCH_PREFIX.length)))
  } catch {
    return null
  }
}

/** The reader-facing text for search, editing and the rail caption. */
export function noteText(body: string): string {
  return decodeSketch(body)?.note ?? body
}

/** Change only a sketch's note text, keeping its stored geometry intact. */
export function updateSketchNote(body: string, note: string): string {
  const sketch = decodeSketch(body)
  return sketch ? encodeSketch({ ...sketch, note }) : note
}

/**
 * Path syntax for an SVG preview. Coordinates are accepted only after the
 * same normalized-point validation used by the stored envelope.
 */
export function sketchPathData(stroke: readonly (readonly [number, number])[]): string {
  if (!Array.isArray(stroke)) invalidSketch()
  return stroke
    .map((point, index) => {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !isFiniteNumber(point[0]) ||
        !isFiniteNumber(point[1]) ||
        point[0] < 0 ||
        point[0] > 1 ||
        point[1] < 0 ||
        point[1] > 1
      )
        invalidSketch()
      return `${index === 0 ? 'M' : 'L'} ${point[0] * 1000} ${point[1] * 1000}`
    })
    .join(' ')
}

/** Create a safe SVG preview from numeric paths, without parsing SVG markup. */
export function createSketchSvg(sketch: Sketch, doc: Document): SVGSVGElement {
  const normalized = normalizeSketch(sketch)
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 1000 1000')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Sketch')
  for (const stroke of normalized.strokes) {
    if (stroke.length === 0) continue
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', sketchPathData(stroke))
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', '#0369a1')
    path.setAttribute('stroke-width', '2.5')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    path.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.append(path)
  }
  return svg
}
