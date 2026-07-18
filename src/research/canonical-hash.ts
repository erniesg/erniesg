import { createHash } from 'node:crypto'
import type { ResearchNode, ResearchPaper } from './schema'

const omittedRenditionKeys = new Set([
  'bbox',
  'bounds',
  'computedGeometry',
  'geometry',
  'layoutCache',
  'page',
  'pages',
  'position',
  'rect',
  'rendition',
  'renditions',
  'targetGeometry',
  'targets',
  'x',
  'y',
])

function stripRenditionFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripRenditionFields)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !omittedRenditionKeys.has(key))
        .map(([key, nested]) => [key, stripRenditionFields(nested)]),
    )
  }
  return value
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalContentHash(paper: ResearchPaper | unknown) {
  return canonicalValueHash(paper)
}

export function canonicalNodeContentHash(node: ResearchNode | unknown) {
  return canonicalValueHash(node)
}

function canonicalValueHash(value: unknown) {
  const canonicalJson = stableJson(stripRenditionFields(value))
  return createHash('sha256').update(canonicalJson).digest('hex')
}
