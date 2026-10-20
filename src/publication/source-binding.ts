import { z } from 'zod'

/**
 * The version of the shared publication source-binding contract. It is
 * carried by the binding shapes themselves through their `kind` discriminator
 * and by the receipts that embed them; bumping it means a new discriminator
 * value, never a silent change to an existing one.
 */
export const PUBLICATION_SOURCE_BINDING_VERSION = '1.0.0' as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

/**
 * Legacy variant: a ResearchPaper source with no Struct binding at all. The
 * schema is strict and carries exactly one key, so there is no field that
 * could hold a placeholder, a zero digest, or an absent package pin.
 */
export const legacyResearchPaperSourceBindingSchema = z
  .object({
    kind: z.literal('legacy-research-paper'),
  })
  .strict()

/**
 * Struct variant: bound to one actual Struct document and the exact package
 * pin that produced it. The optional digests are present only when the bytes
 * they describe were actually produced in the same invocation.
 */
export const structCutoverSourceBindingSchema = z
  .object({
    kind: z.literal('struct-cutover'),
    documentSha256: sha256Schema,
    bundleSha256: sha256Schema.optional(),
    semanticReceiptSha256: sha256Schema.optional(),
    packageSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    packageArtifact: z.string().min(1).max(256),
    packageArtifactSha256: sha256Schema,
    packageIntegrity: z.string().min(1).max(256),
    packageVersion: z.string().min(1).max(64),
  })
  .strict()

export const publicationSourceBindingSchema = z.discriminatedUnion('kind', [
  legacyResearchPaperSourceBindingSchema,
  structCutoverSourceBindingSchema,
])

export type LegacyResearchPaperSourceBinding = z.infer<
  typeof legacyResearchPaperSourceBindingSchema
>
export type StructCutoverSourceBinding = z.infer<
  typeof structCutoverSourceBindingSchema
>
export type PublicationSourceBinding = z.infer<
  typeof publicationSourceBindingSchema
>

/**
 * The single factory for the legacy variant. It is emitted only by the
 * ResearchPaper adapter path, whose `provenance.sourceType` is
 * `research-paper`; no other source may carry it.
 */
export function legacyResearchPaperSourceBinding(): LegacyResearchPaperSourceBinding {
  return { kind: 'legacy-research-paper' }
}
