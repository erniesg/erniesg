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

  it('omits the optional digests when the bytes were not produced', () => {
    const { bundleSha256: _bundle, semanticReceiptSha256: _receipt, ...rest } =
      structBinding
    const parsed = structCutoverSourceBindingSchema.parse(rest)
    expect(parsed.bundleSha256).toBeUndefined()
    expect(parsed.semanticReceiptSha256).toBeUndefined()
    expect(Object.keys(parsed)).not.toContain('bundleSha256')
    expect(Object.keys(parsed)).not.toContain('semanticReceiptSha256')
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
