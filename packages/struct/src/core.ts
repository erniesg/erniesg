/** Stable STRUCT graph, codec, and layout APIs. */
export * from './schema.js'
export {
  StructCodecError,
  decodeStructDocument,
  encodeStructDocument,
  migrateStructDocument,
  type StructDocumentJson,
} from './codec/index.js'
export { orderBlocksByLayout, pageLayoutsFromBlocks } from './reading-order.js'
export {
  MODEL_CONSULTATION_SCHEMA_VERSION,
  validateModelConsultationReceipt,
} from './model-consultation-receipt.js'
export type {
  ModelConsultationMetric,
  ModelConsultationMetrics,
  ModelConsultationRecord,
  ModelConsultationRecordStatus,
  ModelDecisionMetricEvent,
  ModelFallbackCandidate,
  ModelFallbackChoice,
  ModelFallbackDecisionClass,
  ModelFallbackReceipt,
} from './model-consultation-receipt.js'
