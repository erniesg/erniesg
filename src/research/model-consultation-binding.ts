import {
  stableJson as stableModelConsultationJson,
  validateModelConsultationReceipt,
  type ModelFallbackReceipt,
} from './model-fallback-receipt'
import type { PdfReconstruction } from './import-types'
import { sha256HexSync } from './sha256-sync'

export { stableModelConsultationJson }

export function pdfModelConsultationSemanticStateSha256(
  reconstruction: PdfReconstruction,
  receipt: ModelFallbackReceipt,
) {
  const {
    modelConsultations: _modelConsultations,
    source,
    assets,
    ...semanticState
  } = reconstruction
  const { semanticStateSha256: _semanticStateSha256, ...receiptCore } = receipt
  return sha256HexSync(
    stableModelConsultationJson({
      schemaVersion: 'pdf-model-consultation-semantic-state-v1',
      receipt: receiptCore,
      reconstruction: {
        ...semanticState,
        source: {
          sha256: source.sha256,
          byteLength: source.byteLength,
          pageCount: source.pageCount,
        },
        assets: assets.map(({ bytes: _bytes, ...asset }) => asset),
      },
    }),
  )
}

/** Preserve a valid receipt across a later, independently audited state change. */
export function rebindModelConsultationReceipt(
  before: PdfReconstruction,
  after: PdfReconstruction,
) {
  const receipt = before.modelConsultations
  if (
    !validateModelConsultationReceipt(receipt) ||
    receipt.semanticStateSha256 === undefined ||
    receipt.semanticStateSha256 !==
      pdfModelConsultationSemanticStateSha256(before, receipt)
  ) {
    return after
  }
  const rebound = structuredClone(receipt)
  rebound.semanticStateSha256 = pdfModelConsultationSemanticStateSha256(
    after,
    rebound,
  )
  return { ...after, modelConsultations: rebound }
}
