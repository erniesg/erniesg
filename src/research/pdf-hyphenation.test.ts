import { describe, expect, it } from 'vitest'
import {
  PDF_HYPHEN_LEXICAL_MODEL,
  resolvePdfHyphenBoundary,
} from './pdf-hyphenation'

describe('pinned PDF hyphen lexical proof', () => {
  it('proves a productive re- form through an exact pinned-valid same-document base', () => {
    const unhyphenatedLexicon = new Set(['parameterized'])

    expect(
      resolvePdfHyphenBoundary({
        left: 'reparameter',
        right: 'ized',
        language: 'en',
        sourceProven: true,
        unhyphenatedLexicon,
      }),
    ).toMatchObject({
      verdict: 'remove',
      joinedForm: 'reparameterized',
      pinnedJoinedFormValid: false,
      sameDocumentJoinedFormValid: false,
      joinedFormValid: true,
      splitPointValid: true,
      hardHyphenFormValid: false,
      lexicalProof: {
        tier: 'same-document-derived-affix',
        derivedWord: 'reparameterized',
        productivePrefix: {
          kind: 'prefix',
          value: 're',
          affixClass: 'PFX',
          flag: 'A',
          crossProduct: true,
          affixSha256: PDF_HYPHEN_LEXICAL_MODEL.affixSha256,
        },
        baseWord: 'parameterized',
        pinnedBaseWordValid: true,
        exactSameDocumentBaseWord: 'parameterized',
        sameDocumentBaseWordValid: true,
      },
      evidence: expect.arrayContaining([
        'joined-form-valid:same-document-derived-affix',
        'productive-prefix-valid:pinned-affix-model',
        'base-form-valid:pinned-lexicon',
        'same-document-unhyphenated-base-word',
      ]),
    })
    expect(unhyphenatedLexicon).toEqual(new Set(['parameterized']))
  })

  it.each([
    {
      name: 'unproved source geometry',
      input: {
        left: 'reparameter',
        right: 'ized',
        language: 'en',
        sourceProven: false,
        unhyphenatedLexicon: new Set(['parameterized']),
      },
      expected: {
        verdict: 'unresolved',
        lexicalProof: { tier: 'same-document-derived-affix' },
      },
    },
    {
      name: 'unsupported language',
      input: {
        left: 'reparameter',
        right: 'ized',
        language: 'fr',
        sourceProven: true,
        unhyphenatedLexicon: new Set(['parameterized']),
      },
      expected: {
        verdict: 'unresolved',
        lexicalProof: null,
      },
    },
    {
      name: 'illegal surface split',
      input: {
        left: 'reparamete',
        right: 'rized',
        language: 'en',
        sourceProven: true,
        unhyphenatedLexicon: new Set(['parameterized']),
      },
      expected: {
        verdict: 'unresolved',
        splitPointValid: false,
      },
    },
    {
      name: 'missing exact same-document base',
      input: {
        left: 'reparameter',
        right: 'ized',
        language: 'en',
        sourceProven: true,
      },
      expected: {
        verdict: 'unresolved',
        lexicalProof: null,
      },
    },
    {
      name: 'same-document base is not pinned-valid',
      input: {
        left: 'reparameterizz',
        right: 'ed',
        language: 'en',
        sourceProven: true,
        unhyphenatedLexicon: new Set(['parameterizzed']),
      },
      expected: {
        verdict: 'unresolved',
        lexicalProof: null,
        evidence: expect.arrayContaining(['base-form-not-proved']),
      },
    },
    {
      name: 'prefix is outside the conservative productive set',
      input: {
        left: 'deparameter',
        right: 'ized',
        language: 'en',
        sourceProven: true,
        unhyphenatedLexicon: new Set(['parameterized']),
      },
      expected: {
        verdict: 'unresolved',
        lexicalProof: null,
      },
    },
    {
      name: 'line break is exactly at the productive prefix boundary',
      input: {
        left: 're',
        right: 'entry',
        language: 'en',
        sourceProven: true,
        unhyphenatedLexicon: new Set(['entry']),
      },
      expected: {
        verdict: 'unresolved',
        lexicalProof: null,
      },
    },
  ])('does not remove a derived form with $name', ({ input, expected }) => {
    expect(resolvePdfHyphenBoundary(input)).toMatchObject(expected)
  })

  it('does not remove a derived form with exact same-document hard-hyphen counterproof', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'reparameter',
        right: 'ized',
        language: 'en-US',
        sourceProven: true,
        hardHyphenLexicon: new Set(['reparameter-ized']),
        unhyphenatedLexicon: new Set(['parameterized']),
      }),
    ).toMatchObject({
      verdict: 'ambiguous',
      lexicalProof: { tier: 'same-document-derived-affix' },
      hardHyphenFormValid: true,
      evidence: expect.arrayContaining([
        'hard-hyphen-form-valid:same-document',
      ]),
    })
  })

  it('removes only when geometry, spelling, split, and exact same-document form converge', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'scenar',
        right: 'ios',
        language: 'en',
        sourceProven: true,
        unhyphenatedLexicon: new Set(['scenarios']),
      }),
    ).toMatchObject({
      verdict: 'remove',
      joinedForm: 'scenarios',
      hardHyphenForm: 'scenar-ios',
      sourceBoundaryProven: true,
      pinnedJoinedFormValid: true,
      sameDocumentJoinedFormValid: true,
      joinedFormValid: true,
      splitPointValid: true,
      hardHyphenFormValid: false,
      model: PDF_HYPHEN_LEXICAL_MODEL,
      evidence: expect.arrayContaining([
        'language-scope:en->en-US',
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
        'same-document-unhyphenated-word',
        'hard-hyphen-form-not-proved',
      ]),
    })
  })

  it.each([
    ['bor', 'rowed', 'borrowed'],
    ['ca', 'pable', 'capable'],
  ])(
    'removes %s-/%s only with an exact source-sequence boundary and the pinned lexical model',
    (left, right, joinedForm) => {
      expect(
        resolvePdfHyphenBoundary({
          left,
          right,
          language: 'en',
          sourceProven: true,
          sourceSequenceProven: true,
        }),
      ).toMatchObject({
        verdict: 'remove',
        joinedForm,
        sourceSequenceProven: true,
        pinnedJoinedFormValid: true,
        sameDocumentJoinedFormValid: false,
        joinedFormValid: true,
        splitPointValid: true,
        pinnedFragmentPairValid: false,
        lexicalProof: {
          tier: 'source-sequence-pinned-lexicon',
          pinnedWord: joinedForm,
          pinnedJoinedFormValid: true,
          sourceSequenceProven: true,
        },
        evidence: expect.arrayContaining([
          'source-sequence-attested-wrapped-line-boundary',
          'joined-form-valid:pinned-lexicon',
          'split-point-valid:pinned-hyphenation-pattern',
          'hard-hyphen-form-not-proved',
        ]),
      })
    },
  )

  it('preserves a source-sequence-attested boundary when both printed fragments are independently pinned words', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'mark',
        right: 'huge',
        language: 'en-US',
        sourceProven: true,
        sourceSequenceProven: true,
      }),
    ).toMatchObject({
      verdict: 'preserve',
      joinedFormValid: false,
      pinnedFragmentPairValid: true,
      evidence: expect.arrayContaining([
        'hard-hyphen-form-valid:pinned-fragment-pair',
      ]),
    })
  })

  it('fails closed when source-sequence evidence supports both a joined word and a printed fragment pair', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'Cur',
        right: 'rent',
        language: 'en',
        sourceProven: true,
        sourceSequenceProven: true,
      }),
    ).toMatchObject({
      verdict: 'ambiguous',
      joinedFormValid: true,
      pinnedFragmentPairValid: true,
      lexicalProof: {
        tier: 'source-sequence-pinned-lexicon',
      },
    })
  })

  it('accepts an exact same-document TitleCase token only with source-sequence and pinned split evidence', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'Nor',
        right: 'wegian',
        language: 'en',
        sourceProven: true,
        sourceSequenceProven: true,
        unhyphenatedLexicon: new Set(['norwegian']),
      }),
    ).toMatchObject({
      verdict: 'remove',
      pinnedJoinedFormValid: false,
      sameDocumentJoinedFormValid: true,
      joinedFormValid: true,
      splitPointValid: true,
      lexicalProof: {
        tier: 'source-sequence-same-document-title-case',
        exactSameDocumentJoinedForm: 'norwegian',
        sameDocumentJoinedFormValid: true,
        sourceSequenceProven: true,
      },
    })
  })

  it.each([
    ['Kulka', 'rni', 'Kulkarni'],
    ['Mit', 'tal', 'Mittal'],
  ])(
    'accepts the source-proved bibliography surname %s-/%s only with pinned split evidence',
    (left, right, joinedForm) => {
      expect(
        resolvePdfHyphenBoundary({
          left,
          right,
          language: 'en',
          sourceProven: true,
          sourceSequenceProven: true,
          bibliographySurnameContextProven: true,
        }),
      ).toMatchObject({
        verdict: 'remove',
        joinedForm,
        pinnedJoinedFormValid: false,
        sameDocumentJoinedFormValid: false,
        joinedFormValid: true,
        splitPointValid: true,
        hardHyphenFormValid: false,
        lexicalProof: {
          tier: 'source-sequence-bibliography-surname',
          sourceSequenceProven: true,
          bibliographySurnameContextProven: true,
        },
        evidence: expect.arrayContaining([
          'joined-form-valid:source-proved-bibliography-surname',
          'bibliography-surname-context:source-reference-entry',
          'split-point-valid:pinned-hyphenation-pattern',
          'hard-hyphen-form-not-proved',
        ]),
      })
    },
  )

  it.each([
    {
      name: 'bibliography context is not proved',
      input: {
        left: 'Kulka',
        right: 'rni',
        language: 'en',
        sourceProven: true,
        sourceSequenceProven: true,
      },
    },
    {
      name: 'source sequence is not proved',
      input: {
        left: 'Kulka',
        right: 'rni',
        language: 'en',
        sourceProven: true,
        sourceSequenceProven: false,
        bibliographySurnameContextProven: true,
      },
    },
    {
      name: 'language is unsupported',
      input: {
        left: 'Kulka',
        right: 'rni',
        language: 'pl',
        sourceProven: true,
        sourceSequenceProven: true,
        bibliographySurnameContextProven: true,
      },
    },
    {
      name: 'surface is not TitleCase',
      input: {
        left: 'kulka',
        right: 'rni',
        language: 'en',
        sourceProven: true,
        sourceSequenceProven: true,
        bibliographySurnameContextProven: true,
      },
    },
  ])('does not infer a bibliography surname when $name', ({ input }) => {
    expect(resolvePdfHyphenBoundary(input)).toMatchObject({
      verdict: 'unresolved',
      joinedFormValid: false,
    })
  })

  it('keeps a source-proved bibliography boundary ambiguous when both fragments are pinned words', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'Cur',
        right: 'rent',
        language: 'en',
        sourceProven: true,
        sourceSequenceProven: true,
        bibliographySurnameContextProven: true,
      }),
    ).toMatchObject({
      verdict: 'ambiguous',
      joinedForm: 'Current',
      pinnedFragmentPairValid: true,
      lexicalProof: {
        tier: 'source-sequence-pinned-lexicon',
      },
    })
  })

  it('keeps a source-proved bibliography surname ambiguous when the hard-hyphen form is attested', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'Kulka',
        right: 'rni',
        language: 'en',
        sourceProven: true,
        sourceSequenceProven: true,
        bibliographySurnameContextProven: true,
        hardHyphenLexicon: new Set(['kulka-rni']),
      }),
    ).toMatchObject({
      verdict: 'ambiguous',
      joinedFormValid: true,
      splitPointValid: true,
      hardHyphenFormValid: true,
      lexicalProof: {
        tier: 'source-sequence-bibliography-surname',
      },
    })
  })

  it.each([
    {
      name: 'source sequence is not proved',
      input: {
        left: 'bor',
        right: 'rowed',
        language: 'en',
        sourceProven: true,
        sourceSequenceProven: false,
      },
    },
    {
      name: 'same-document token is an acronym',
      input: {
        left: 'ZX',
        right: 'ALPHA',
        language: 'en',
        sourceProven: true,
        sourceSequenceProven: true,
        unhyphenatedLexicon: new Set(['zxalpha']),
      },
    },
    {
      name: 'language is unsupported',
      input: {
        left: 'bor',
        right: 'rowed',
        language: 'fr',
        sourceProven: true,
        sourceSequenceProven: true,
      },
    },
  ])('does not infer a new lexical tier when $name', ({ input }) => {
    expect(resolvePdfHyphenBoundary(input)).toMatchObject({
      verdict: 'unresolved',
    })
  })

  it('does not substitute a complete same-document word for wrap geometry', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'scenar',
        right: 'ios',
        language: 'en',
        sourceProven: false,
        unhyphenatedLexicon: new Set(['scenarios']),
      }),
    ).toMatchObject({
      verdict: 'unresolved',
      sourceBoundaryProven: false,
      pinnedJoinedFormValid: true,
      sameDocumentJoinedFormValid: true,
      joinedFormValid: true,
      splitPointValid: true,
      hardHyphenFormValid: false,
      evidence: expect.arrayContaining([
        'unproven-wrapped-line-boundary',
        'same-document-unhyphenated-word',
      ]),
    })
  })

  it('fails closed when joined and hard-hyphen forms are both proved', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 're',
        right: 'form',
        language: 'en-US',
        sourceProven: true,
        hardHyphenLexicon: new Set(['re-form']),
        unhyphenatedLexicon: new Set(['reform']),
      }),
    ).toMatchObject({
      verdict: 'ambiguous',
      joinedFormValid: true,
      splitPointValid: true,
      hardHyphenFormValid: true,
    })
  })

  it('preserves when only the hard-hyphen form is proved', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'evidence',
        right: 'based',
        language: 'en',
        sourceProven: true,
        hardHyphenLexicon: new Set(['evidence-based']),
      }),
    ).toMatchObject({
      verdict: 'preserve',
      joinedFormValid: false,
      hardHyphenFormValid: true,
    })
  })

  it('preserves a source-attested proper name without treating it as a joined word', () => {
    expect(
      resolvePdfHyphenBoundary({
        left: 'Euler',
        right: 'Lagrange',
        language: 'en',
        sourceProven: true,
        hardHyphenLexicon: new Set(['euler-lagrange']),
      }),
    ).toMatchObject({
      verdict: 'preserve',
      joinedFormValid: false,
      hardHyphenFormValid: true,
    })
  })

  it.each([
    {
      name: 'missing exact same-document joined form',
      input: {
        left: 'scenar',
        right: 'ios',
        language: 'en',
        sourceProven: true,
      },
    },
    {
      name: 'unproved source geometry',
      input: {
        left: 'scenar',
        right: 'ios',
        language: 'en',
        sourceProven: false,
        unhyphenatedLexicon: new Set(['scenarios']),
      },
    },
    {
      name: 'unsupported language',
      input: {
        left: 'scenar',
        right: 'ios',
        language: 'fr',
        sourceProven: true,
      },
    },
    {
      name: 'invalid split point',
      input: {
        left: 'sc',
        right: 'enario',
        language: 'en',
        sourceProven: true,
      },
    },
    {
      name: 'neither spelling proved',
      input: {
        left: 'covariate',
        right: 'adjusted',
        language: 'en',
        sourceProven: true,
      },
    },
  ])('remains unresolved for $name', ({ input }) => {
    expect(resolvePdfHyphenBoundary(input)).toMatchObject({
      verdict: 'unresolved',
    })
  })
})
