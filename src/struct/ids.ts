import { sha256HexSync } from './sha256'

/** Stable IDs are content-addressed so reflowing a page cannot rename a node. */
export function structId(namespace: string, value: string) {
  return `struct-${namespace}-${sha256HexSync(value).slice(0, 24)}`
}

export function structDigest(value: unknown) {
  return sha256HexSync(stableSerialize(value))
}

/** Digest used by serialized STRUCT 0.1.0 documents before ordering was fixed. */
export function legacyStructDigest(value: unknown, locale?: string) {
  return sha256HexSync(legacyStableSerialize(value, locale))
}

const legacyLocaleCandidates = Array.from({ length: 26 * 26 }, (_, index) => {
  const left = String.fromCharCode(97 + Math.floor(index / 26))
  const right = String.fromCharCode(97 + (index % 26))
  return `${left}${right}`
})

/** Reproduce every base-language collation supported by this ICU runtime. */
export function legacyStructDigests(value: unknown) {
  return new Set([
    legacyStructDigest(value),
    ...Intl.Collator.supportedLocalesOf(legacyLocaleCandidates).map((locale) =>
      legacyStructDigest(value, locale),
    ),
  ])
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

function legacyStableSerialize(value: unknown, locale?: string): string {
  if (Array.isArray(value))
    return `[${value.map((item) => legacyStableSerialize(item, locale)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, locale))
      .map(
        ([key, nested]) =>
          `${JSON.stringify(key)}:${legacyStableSerialize(nested, locale)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}
