import { TRANSFORMATION_POLICY_VERSION } from './transformation-policy'

export const PUBLICATION_CHECK_VERSION = '1.0.0' as const

export const PUBLICATION_OUTPUT_POLICY_VERSIONS = {
  renderer: '1.0.0',
  semanticHtml: '1.0.0',
  accessibility: '1.0.0',
  transformationPolicy: TRANSFORMATION_POLICY_VERSION,
  publicationCheck: PUBLICATION_CHECK_VERSION,
} as const
