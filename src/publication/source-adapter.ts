import { z } from 'zod'
import type { AssetBundle } from './asset-bundle'
import { publicationGraphSchema, type PublicationGraph } from './schema'

export const PUBLICATION_SOURCE_ADAPTER_VERSION = '1.0.0' as const

export const adapterDiagnosticSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'error']),
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9-]+$/),
    message: z.string().min(1).max(100_000),
    sourceId: z.string().min(1).max(2_048).optional(),
    nodeId: z.string().min(1).max(256).optional(),
  })
  .strict()

export const adapterProvenanceSchema = z
  .object({
    adapterId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    adapterVersion: z.literal(PUBLICATION_SOURCE_ADAPTER_VERSION),
    sourceType: z.enum(['astro', 'payload', 'docx', 'pdf', 'research-paper']),
    sourceId: z
      .string()
      .min(1)
      .max(2_048)
      .refine(
        (value) =>
          !/^(?:file:|[A-Za-z]:[\\/]|\/|\\\\)/.test(value) &&
          !/(?:token|secret|password|credential|api[_-]?key)=/i.test(value),
        'Source ids cannot contain local paths or secret material',
      ),
    sourceRevision: z.string().min(1).max(256).optional(),
  })
  .strict()

export type AdapterDiagnostic = z.infer<typeof adapterDiagnosticSchema>
export type AdapterProvenance = z.infer<typeof adapterProvenanceSchema>

export type PublicationSourceResult = {
  graph: PublicationGraph
  assetBundle: AssetBundle
  diagnostics: AdapterDiagnostic[]
  provenance: AdapterProvenance
}

export interface PublicationSourceAdapter<Input = unknown> {
  readonly id: string
  readonly version: typeof PUBLICATION_SOURCE_ADAPTER_VERSION
  adapt(
    input: Input,
  ): Promise<PublicationSourceResult> | PublicationSourceResult
}

export function validatePublicationSourceResult(
  value: PublicationSourceResult,
): PublicationSourceResult {
  return {
    graph: publicationGraphSchema.parse(value.graph),
    assetBundle: value.assetBundle,
    diagnostics: z
      .array(adapterDiagnosticSchema)
      .max(10_000)
      .parse(value.diagnostics),
    provenance: adapterProvenanceSchema.parse(value.provenance),
  }
}
