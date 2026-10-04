import type { SourceReference } from './contract'

export type NodeKind = 'chapter' | 'challenge'
export interface NodeRegistryEntry {
  readonly id: string
  readonly kind: NodeKind
}

export interface ChallengeSourceReference extends SourceReference {
  readonly kind: NodeKind
}

const SAFE_NODE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_REGISTRY_ENTRIES = 10_000
const MAX_NODE_ID_LENGTH = 128

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_NODE_ID_LENGTH && SAFE_NODE_ID.test(id)
}

/** The supplied registry identifies known nodes; it never supplies source paths. */
export function resolveChallengeDocument(
  documentId: unknown,
  registry: readonly NodeRegistryEntry[],
  expectedKind?: NodeKind,
): ChallengeSourceReference {
  if (!validId(documentId)) throw new TypeError('invalid document id')
  if (expectedKind !== undefined && expectedKind !== 'chapter' && expectedKind !== 'challenge') {
    throw new TypeError('invalid expected kind')
  }
  if (!Array.isArray(registry) || registry.length > MAX_REGISTRY_ENTRIES) {
    throw new TypeError('invalid node registry')
  }
  const seen = new Set<string>()
  let kind: NodeKind | undefined
  for (const entry of registry) {
    if (
      entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'id') || !Object.hasOwn(entry, 'kind') ||
      !validId(entry.id) || (entry.kind !== 'chapter' && entry.kind !== 'challenge') || seen.has(entry.id)
    ) {
      throw new TypeError('invalid node registry entry')
    }
    seen.add(entry.id)
    if (entry.id === documentId) kind = entry.kind
  }
  if (kind === undefined) throw new RangeError('unknown document id')
  if (expectedKind !== undefined && kind !== expectedKind) throw new TypeError('document kind mismatch')
  return {
    documentId,
    kind,
    location: kind === 'chapter'
      ? `books/chapters/${documentId}.md`
      : `books/challenges/${documentId}/challenge.md`,
  }
}
