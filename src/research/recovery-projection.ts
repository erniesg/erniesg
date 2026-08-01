import type { ReconstructionDiagnostic } from './import-types'
import type { RecoveryDiagnosticInput } from '../struct/recovery'

type RecoveryProjectionSource = {
  diagnostics: ReadonlyArray<
    Pick<
      ReconstructionDiagnostic,
      | 'code'
      | 'severity'
      | 'message'
      | 'page'
      | 'sourceBoxes'
      | 'relationshipId'
      | 'target'
    > | {
      code: string
      severity: ReconstructionDiagnostic['severity']
      message: string
      page?: number
      sourceBoxes?: ReadonlyArray<{ page: number }>
      relationshipId?: string
      target?: { markerId: string | null }
    }
  >
  visualRelationships?: ReadonlyArray<{ id: string; assetIds: string[] }>
  assets?: ReadonlyArray<{ id: string; bytes?: Uint8Array }>
}

const ALWAYS_AUTOMATIC_CODES = new Set([
  'UNRESOLVED_HYPERLINK',
  'INCOMPLETE_RELATIONSHIP_COVERAGE',
  'AMBIGUOUS_NOTE_MATCH',
  'UNRESOLVED_NOTE_REFERENCE',
  'UNREFERENCED_NOTE',
  'DANGLING_NOTE_REFERENCE',
  'UNRESOLVED_CITATION_REFERENCE',
  'UNRESOLVED_SCHOLARLY_CROSS_REFERENCE',
  'UNMAPPED_CITATION_ANCHOR',
  'UNRESOLVED_CORRUPTING_JOIN',
  'INCOMPLETE_INLINE_STYLE_COVERAGE',
  'UNRESOLVED_FRONT_MATTER',
  'BOUNDED_TABLE_FALLBACK',
])

const ASSET_BACKED_CODES = new Set([
  'UNRESOLVED_VISUAL_OBJECT',
  'AMBIGUOUS_VISUAL_MATCH',
  'UNRESOLVED_EQUATION_TRANSCRIPT',
  'UNRESOLVED_ALGORITHM_BLOCK',
  'UNRESOLVED_ALGORITHM_TRANSCRIPT',
  'UNRESOLVED_PREFORMATTED_BLOCK',
  'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
])

function hasPackagedRelationshipAsset(
  source: RecoveryProjectionSource,
  diagnostic: RecoveryProjectionSource['diagnostics'][number],
) {
  const relationshipIds = new Set(
    [diagnostic.relationshipId, diagnostic.target?.markerId].filter(
      (value): value is string => Boolean(value),
    ),
  )
  if (relationshipIds.size === 0) return false
  const packagedAssetIds = new Set(
    (source.assets ?? [])
      .filter((asset) => (asset.bytes?.byteLength ?? 0) > 0)
      .map((asset) => asset.id),
  )
  return (source.visualRelationships ?? []).some(
    (relationship) =>
      relationshipIds.has(relationship.id) &&
      relationship.assetIds.some((assetId) => packagedAssetIds.has(assetId)),
  )
}

export function recoveryDiagnosticInputs(
  source: RecoveryProjectionSource,
): RecoveryDiagnosticInput[] {
  return source.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.page ?? diagnostic.sourceBoxes?.[0]?.page
      ? { page: diagnostic.page ?? diagnostic.sourceBoxes?.[0]?.page }
      : {}),
    automaticRecovery:
      ALWAYS_AUTOMATIC_CODES.has(diagnostic.code) ||
      (ASSET_BACKED_CODES.has(diagnostic.code) &&
        hasPackagedRelationshipAsset(source, diagnostic)),
  }))
}
