import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfVisualAsset,
} from './import-types'

type PdfNativeObject = NonNullable<PdfPageAnalysis['objects']>[number]

const MIN_REPEATED_RECTANGLE_OVERLAP = 0.98
const REPEATED_RECTANGLE_GEOMETRY_TOLERANCE = 0.004
const REPEATED_RECTANGLE_SPATIAL_CELL_SIZE = 0.05

export function isLargeVectorBox(box: NormalizedSourceBox) {
  return box.width >= 0.65 && box.height >= 0.35
}

export function isPageFurnitureVectorBox(box: NormalizedSourceBox) {
  const nearHorizontalEdge = box.y <= 0.15 || box.y + box.height >= 0.85
  const nearVerticalEdge = box.x <= 0.08 || box.x + box.width >= 0.92
  return (
    (nearHorizontalEdge && box.width >= 0.45 && box.height <= 0.008) ||
    (nearVerticalEdge && box.width <= 0.008 && box.height >= 0.2)
  )
}

export function isStructuralVectorRuleBox(box: NormalizedSourceBox) {
  return (
    (box.width >= 0.02 && box.height <= 0.0001) ||
    (box.width >= 0.45 && box.height <= 0.008) ||
    (box.height >= 0.2 && box.width <= 0.012)
  )
}

function sameRepeatedGeometry(left: PdfNativeObject, right: PdfNativeObject) {
  if (left.page === right.page || left.box.rotation !== right.box.rotation)
    return false
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(left.box[key] - right.box[key]) <= 0.004,
  )
}

function singleSolidRectangleFallbackAsset(asset: PdfVisualAsset | undefined) {
  if (
    !asset ||
    asset.kind !== 'vector' ||
    asset.mediaType !== 'image/svg+xml' ||
    asset.rendition !== 'bounded-svg-fallback'
  ) {
    return false
  }
  const svg = new TextDecoder().decode(asset.bytes)
  const paths = [...svg.matchAll(/<path\b([^>]*)\/?>/giu)]
  if (
    paths.length !== 1 ||
    /<(?:circle|ellipse|image|line|polygon|polyline|rect|text|use)\b/iu.test(
      svg,
    )
  ) {
    return false
  }
  const attributes = paths[0][1]
  const fill = attributes.match(/\bfill=(["'])(.*?)\1/iu)?.[2]?.trim()
  const stroke = attributes.match(/\bstroke=(["'])(.*?)\1/iu)?.[2]?.trim()
  const path = attributes.match(/\bd=(["'])(.*?)\1/iu)?.[2]?.trim()
  if (!path || !fill || fill === 'none' || stroke !== 'none') return false

  const tokens =
    path.match(/[MLZ]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/giu) ?? []
  if (tokens.join(' ').replace(/\s+/g, '') !== path.replace(/\s+/g, '')) {
    return false
  }
  const points: Array<{ x: number; y: number }> = []
  let command = ''
  let index = 0
  let closed = false
  while (index < tokens.length) {
    const token = tokens[index++]
    if (/^[MLZ]$/iu.test(token)) {
      command = token.toUpperCase()
      if (command === 'Z') {
        closed = index === tokens.length
        continue
      }
    } else {
      index -= 1
    }
    if (!['M', 'L'].includes(command) || index + 1 >= tokens.length) {
      return false
    }
    const x = Number(tokens[index++])
    const y = Number(tokens[index++])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    points.push({ x, y })
  }
  if (!closed || points.length < 4 || points.length > 5) return false
  if (
    points.length === 5 &&
    points[0].x === points[4].x &&
    points[0].y === points[4].y
  ) {
    points.pop()
  }
  if (points.length !== 4) return false
  const xs = [...new Set(points.map((point) => point.x))].sort(
    (left, right) => left - right,
  )
  const ys = [...new Set(points.map((point) => point.y))].sort(
    (left, right) => left - right,
  )
  if (xs.length !== 2 || ys.length !== 2) return false
  const corners = new Set(points.map((point) => `${point.x}:${point.y}`))
  if (corners.size !== 4) return false
  return points.every((point, pointIndex) => {
    const next = points[(pointIndex + 1) % points.length]
    return point.x === next.x || point.y === next.y
  })
}

export type PdfRectangleIndexEvidence = {
  candidateComparisons: number
}

function rectangleGeometryCell(object: PdfNativeObject) {
  return [object.box.x, object.box.y, object.box.width, object.box.height]
    .map((value) => Math.floor(value / REPEATED_RECTANGLE_GEOMETRY_TOLERANCE))
    .join(':')
}

function neighboringRectangleGeometryCells(object: PdfNativeObject) {
  const base = [
    object.box.x,
    object.box.y,
    object.box.width,
    object.box.height,
  ].map((value) => Math.floor(value / REPEATED_RECTANGLE_GEOMETRY_TOLERANCE))
  const keys: string[] = []
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let width = -1; width <= 1; width += 1) {
        for (let height = -1; height <= 1; height += 1) {
          keys.push(
            `${base[0] + x}:${base[1] + y}:${base[2] + width}:${base[3] + height}`,
          )
        }
      }
    }
  }
  return keys
}

function rectangleSpatialCells(object: PdfNativeObject) {
  const left = Math.floor(object.box.x / REPEATED_RECTANGLE_SPATIAL_CELL_SIZE)
  const top = Math.floor(object.box.y / REPEATED_RECTANGLE_SPATIAL_CELL_SIZE)
  const right = Math.floor(
    (object.box.x + object.box.width) / REPEATED_RECTANGLE_SPATIAL_CELL_SIZE,
  )
  const bottom = Math.floor(
    (object.box.y + object.box.height) / REPEATED_RECTANGLE_SPATIAL_CELL_SIZE,
  )
  const cells: string[] = []
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) cells.push(`${x}:${y}`)
  }
  return cells
}

function intersectionArea(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  if (left.page !== right.page || left.rotation !== right.rotation) return 0
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  )
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  )
  return width * height
}

export function repeatedRectangleFallbackObjectIds(
  pages: PdfPageAnalysis[],
  evidence?: PdfRectangleIndexEvidence,
) {
  const assets = new Map(
    pages
      .flatMap((page) => page.assets ?? [])
      .map((asset) => [asset.id, asset] as const),
  )
  const rectangles = pages
    .flatMap((page) => page.objects ?? [])
    .filter(
      (
        object,
      ): object is PdfNativeObject & {
        kind: 'vector'
        assetId: string
      } =>
        object.kind === 'vector' &&
        Boolean(object.assetId) &&
        singleSolidRectangleFallbackAsset(assets.get(object.assetId!)),
    )
  const repeated = new Set<string>()
  const byAsset = new Map<string, typeof rectangles>()
  for (const object of rectangles) {
    const matches = byAsset.get(object.assetId) ?? []
    matches.push(object)
    byAsset.set(object.assetId, matches)
  }
  for (const matches of byAsset.values()) {
    if (matches.length < 2) continue
    for (const object of matches) repeated.add(object.id)
  }

  const geometryCells = new Map<string, typeof rectangles>()
  for (const object of rectangles) {
    const candidates = new Set(
      neighboringRectangleGeometryCells(object).flatMap(
        (key) => geometryCells.get(key) ?? [],
      ),
    )
    for (const candidate of candidates) {
      if (object.page === candidate.page) continue
      if (repeated.has(object.id) && repeated.has(candidate.id)) continue
      if (evidence) evidence.candidateComparisons += 1
      if (!sameRepeatedGeometry(object, candidate)) continue
      repeated.add(object.id)
      repeated.add(candidate.id)
    }
    const key = rectangleGeometryCell(object)
    const values = geometryCells.get(key) ?? []
    values.push(object)
    geometryCells.set(key, values)
  }

  const spatialCellsByPage = new Map<number, Map<string, typeof rectangles>>()
  for (const object of rectangles) {
    const cells =
      spatialCellsByPage.get(object.page) ??
      new Map<string, typeof rectangles>()
    spatialCellsByPage.set(object.page, cells)
    const objectCells = rectangleSpatialCells(object)
    const candidates = new Set(
      objectCells.flatMap((key) => cells.get(key) ?? []),
    )
    for (const candidate of candidates) {
      if (repeated.has(object.id) && repeated.has(candidate.id)) continue
      if (evidence) evidence.candidateComparisons += 1
      const smallerArea = Math.min(
        object.box.width * object.box.height,
        candidate.box.width * candidate.box.height,
      )
      if (
        smallerArea <= 0 ||
        intersectionArea(object.box, candidate.box) / smallerArea <
          MIN_REPEATED_RECTANGLE_OVERLAP
      ) {
        continue
      }
      repeated.add(object.id)
      repeated.add(candidate.id)
    }
    for (const key of objectCells) {
      const values = cells.get(key) ?? []
      values.push(object)
      cells.set(key, values)
    }
  }
  return repeated
}

export function decorativeNativeObjectIds(
  pages: PdfPageAnalysis[],
  repeatedRectangleObjectIds = repeatedRectangleFallbackObjectIds(pages),
) {
  const vectors = pages
    .flatMap((page) => page.objects ?? [])
    .filter((object) => object.kind === 'vector')
  const decorative = new Set(
    vectors
      .filter(
        (object) =>
          isPageFurnitureVectorBox(object.box) ||
          isStructuralVectorRuleBox(object.box),
      )
      .map((object) => object.id),
  )
  for (const object of vectors) {
    if (
      isLargeVectorBox(object.box) &&
      repeatedRectangleObjectIds.has(object.id)
    ) {
      decorative.add(object.id)
    }
  }
  return decorative
}
