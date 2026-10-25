import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  legacyResearchPaperSourceBinding,
  legacyResearchPaperSourceBindingSchema,
  publicationSourceBindingSchema,
  structCutoverSourceBindingSchema,
  PUBLICATION_SOURCE_BINDING_VERSION,
} from './source-binding'

const hex = (character: string) => character.repeat(64)

const structBinding = {
  kind: 'struct-cutover',
  documentSha256: hex('1'),
  bundleSha256: hex('2'),
  semanticReceiptSha256: hex('3'),
  packageSourceCommit: 'b'.repeat(40),
  packageArtifact:
    'erniesg-struct-0.0.0-90f76f1f80b037cc065169d07b13779c03420026.tgz',
  packageArtifactSha256: hex('4'),
  packageIntegrity:
    'sha512-0WyBLp2PDZr4pOFYhfe6a1IbuZOuBemiR/alDgx73j8JYKZh7m8UthMsimjXp6wt3gUUiNumvXmykYeccnDUBQ==',
  packageVersion: '0.0.0',
}

describe('publication source binding', () => {
  it('publishes one versioned binding contract', () => {
    expect(PUBLICATION_SOURCE_BINDING_VERSION).toBe('1.0.0')
  })

  it('produces the legacy variant with exactly one key and no Struct field', () => {
    const binding = legacyResearchPaperSourceBinding()
    expect(binding).toEqual({ kind: 'legacy-research-paper' })
    expect(Object.keys(binding)).toEqual(['kind'])
    expect(legacyResearchPaperSourceBindingSchema.parse(binding)).toEqual(binding)
    expect(
      legacyResearchPaperSourceBindingSchema.safeParse({
        ...binding,
        documentSha256: hex('1'),
      }).success,
    ).toBe(false)
  })

  it('parses the struct variant and rejects any extra field', () => {
    expect(structCutoverSourceBindingSchema.parse(structBinding)).toEqual(
      structBinding,
    )
    expect(
      structCutoverSourceBindingSchema.safeParse({
        ...structBinding,
        packageSha256: hex('5'),
      }).success,
    ).toBe(false)
  })

  it('omits the bundle digest when the wire bytes were not produced', () => {
    const { bundleSha256: _bundle, ...rest } = structBinding
    const parsed = structCutoverSourceBindingSchema.parse(rest)
    expect(parsed.bundleSha256).toBeUndefined()
    expect(Object.keys(parsed)).not.toContain('bundleSha256')
    // The semantic receipt digest is never optional: a struct-cutover
    // binding without it is refused, not downgraded.
    expect(
      structCutoverSourceBindingSchema.safeParse(rest).success,
    ).toBe(true)
    expect(
      structCutoverSourceBindingSchema.safeParse({
        ...rest,
        semanticReceiptSha256: undefined,
      }).success,
    ).toBe(false)
  })

  it('rejects malformed digests and non-hex package commits', () => {
    expect(
      structCutoverSourceBindingSchema.safeParse({
        ...structBinding,
        documentSha256: 'abc',
      }).success,
    ).toBe(false)
    expect(
      structCutoverSourceBindingSchema.safeParse({
        ...structBinding,
        packageSourceCommit: 'not-hex',
      }).success,
    ).toBe(false)
  })

  it('discriminates the union by kind and refuses an unknown kind', () => {
    expect(publicationSourceBindingSchema.parse(structBinding)).toEqual(
      structBinding,
    )
    expect(
      publicationSourceBindingSchema.parse(
        legacyResearchPaperSourceBinding(),
      ),
    ).toEqual({ kind: 'legacy-research-paper' })
    expect(
      publicationSourceBindingSchema.safeParse({ kind: 'struct-pin' }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The neutral shared contract fixture.
//
// The fixture describes the contract; it is not an authority. It carries no
// package pin, no artifact digest and no source identity, so a lane that
// only reads the fixture learns the shape of the contract without learning
// what any particular publication is, and without a production import edge.
// ---------------------------------------------------------------------------

type ContractField = {
  type: 'literal' | 'string'
  value?: string
  format?: keyof ContractFormats
  required: boolean
  requiredAt?: string
  maxLength?: number
}

type ContractFormats = Record<
  string,
  { type: string; pattern?: string; minLength?: number }
>

type ContractVariant = {
  kind: string
  strict: boolean
  fields: Record<string, ContractField>
}

type ContractFixture = {
  contract: string
  version: string
  authority: boolean
  discriminator: string
  formats: ContractFormats
  variants: Record<string, ContractVariant>
}

const contractFixture = JSON.parse(
  await readFile(
    new URL(
      '../../tests/fixtures/publication-source-binding-contract-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as ContractFixture

const contractFormats: ContractFormats = contractFixture.formats

/**
 * A value that satisfies one field description of the contract fixture.
 *
 * The values are synthetic: they exist to exercise the schema, and they are
 * not a pin of anything.
 */
function contractValue(field: ContractField) {
  if (field.type === 'literal') return field.value
  const format = field.format ? contractFormats[field.format] : undefined
  if (format?.pattern === '^[a-f0-9]{64}$') return hex('1')
  if (format?.pattern === '^[a-f0-9]{40}$') return 'b'.repeat(40)
  if (format?.minLength === 1) return 'contract-value'
  return 'contract-value'
}

function contractBinding(variant: ContractVariant) {
  return Object.fromEntries(
    Object.entries(variant.fields).map(([name, field]) => [
      name,
      contractValue(field),
    ]),
  )
}

describe('the neutral publication source binding contract', () => {
  it('describes the contract without becoming an authority', () => {
    expect(contractFixture.contract).toBe('publication-source-binding-contract')
    expect(contractFixture.version).toBe(PUBLICATION_SOURCE_BINDING_VERSION)
    expect(contractFixture.authority).toBe(false)
    expect(contractFixture.discriminator).toBe('kind')
    // The fixture carries no pin and no identity: it names fields, not
    // values of any real publication.
    const serialized = JSON.stringify(contractFixture)
    expect(serialized).not.toContain('erniesg-struct-')
    expect(serialized).not.toContain('sha512-')
  })

  it('names exactly the variants the schema knows', () => {
    expect(Object.keys(contractFixture.variants).sort()).toEqual([
      'legacy-research-paper',
      'struct-cutover',
    ])
  })

  it('matches the legacy variant field for field', () => {
    const variant = contractFixture.variants['legacy-research-paper']
    expect(variant.strict).toBe(true)
    expect(Object.keys(variant.fields)).toEqual(['kind'])
    const binding = contractBinding(variant)
    expect(legacyResearchPaperSourceBindingSchema.parse(binding)).toEqual(
      binding,
    )
    expect(
      legacyResearchPaperSourceBindingSchema.safeParse({
        ...binding,
        documentSha256: hex('1'),
      }).success,
    ).toBe(false)
  })

  it('matches the struct variant fields, requiredness and formats', () => {
    const variant = contractFixture.variants['struct-cutover']
    expect(variant.strict).toBe(true)
    const schema = structCutoverSourceBindingSchema
    const binding = contractBinding(variant)
    expect(schema.parse(binding)).toEqual(binding)

    // Every required field is required by the schema, and every optional
    // field stays optional in the shape.
    for (const [name, field] of Object.entries(variant.fields)) {
      const without = { ...binding }
      delete without[name]
      const parsed = schema.safeParse(without)
      if (field.required) expect(parsed.success, name).toBe(false)
      else expect(parsed.success, name).toBe(true)
    }

    // The formats of the fixture are the formats of the schema.
    for (const [name, field] of Object.entries(variant.fields)) {
      const format = field.format ? contractFormats[field.format] : undefined
      if (!format?.pattern) continue
      expect(
        schema.safeParse({ ...binding, [name]: 'not-a-valid-value' }).success,
        name,
      ).toBe(false)
    }

    // The variant is strict: an unknown field is refused.
    expect(
      schema.safeParse({ ...binding, unknownField: 'x' }).success,
    ).toBe(false)
  })

  it('names the semantic receipt digest as mandatory and the bundle digest as admission-required', () => {
    const variant = contractFixture.variants['struct-cutover']
    expect(variant.fields.semanticReceiptSha256.required).toBe(true)
    expect(variant.fields.bundleSha256.required).toBe(false)
    expect(variant.fields.bundleSha256.requiredAt).toBe(
      'struct-variant admission',
    )
  })
})
