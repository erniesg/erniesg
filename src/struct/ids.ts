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
      // Order by code unit, never by collation. `localeCompare` asks the
      // runtime's ICU locale: `en-US` puts `a` before `B` and Lithuanian puts
      // `y` before `w` — and `w`/`y` are `StructBox` keys. Now that packaging
      // re-derives this digest, a collation-dependent order means a document
      // built on one machine cannot be packaged on another.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}
