import { sha256HexSync } from './sha256'

/** Stable IDs are content-addressed so reflowing a page cannot rename a node. */
export function structId(namespace: string, value: string) {
  return `struct-${namespace}-${sha256HexSync(value).slice(0, 24)}`
}

export function structDigest(value: unknown) {
  return sha256HexSync(stableSerialize(value))
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}
