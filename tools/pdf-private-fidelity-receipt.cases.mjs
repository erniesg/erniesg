import { describe, expect, it } from 'vitest'
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, homedir, tmpdir, join, resolve, spawnSync, createHash, fileURLToPath, canonicalHyphenEvidenceSha256, canonicalJsonHash, PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE, PDF_HYPHEN_LEXICAL_MODEL_RECEIPT, PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT, PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE, applyPrivateDecisionSet, comparePrivateFidelityBaseline, comparePrivateFidelityReceipts, createPrivateFidelityReceipt, createPrivateFidelityRunReceipt, createPrivateReconstructionEvidenceRaw, parsePrivateFidelityArguments, prepareOwnerOnlyDirectory, writeExclusive, privateFidelity, hash, privateCompletenessPolicy, createPrivateReconstructionEvidence, canonicalHyphenDeletionRecord, canonicalDerivedAffixHyphenDeletionRecord, citationRelationship, crossReferenceRelationship, reconstruction, requireReconstructionReview, artifact, inspectedArtifact, run, fidelityReceipt, acceptedBaselineSha256, recomputePrivateReconstructionReceiptSha256, rebuildPrivateFidelityReceipt, installCanonicalHyphenDeletionLedger, forgeCanonicalHyphenDeletionLedger, historicalV14Receipt,
} from './pdf-private-fidelity.cases-support.mjs'

describe('private PDF fidelity receipt cases', () => {
  it('requires an explicit hash, size, external output, profiles, and repeat', () => {
    const arguments_ = [
      '--input-env',
      'SRT_PRIVATE_TEST_PDF',
      '--paper-id',
      'paper-v1',
      '--expected-size',
      '123',
      '--expected-sha256',
      hash,
      '--profiles',
      'mobile,paperProMove,paperPro',
      '--repeat',
      '2',
      '--out',
      '/tmp/private-proof',
      '--require-epubcheck',
    ]
    const parsed = parsePrivateFidelityArguments(arguments_, {
      SRT_PRIVATE_TEST_PDF: '/private/input.pdf',
    })
    expect(parsed).toMatchObject({
      paperId: 'paper-v1',
      expectedSize: 123,
      expectedSha256: hash,
      profiles: ['mobile', 'paperProMove', 'paperPro'],
      repeat: 2,
      requireEpubCheck: true,
    })
    expect(() =>
      parsePrivateFidelityArguments([
        '--input',
        '/private/input.pdf',
        '--paper-id',
        'paper-v1',
      ]),
    ).toThrow()
  })

  it('reads the private source path from exactly one named environment variable', () => {
    const privatePath = '/private/operator-staged/input.pdf'
    const arguments_ = [
      '--input-env',
      'SRT_PRIVATE_TEST_PDF',
      '--paper-id',
      'paper-v1',
      '--expected-size',
      '123',
      '--expected-sha256',
      hash,
      '--profiles',
      'mobile,paperProMove,paperPro',
      '--repeat',
      '2',
      '--out',
      '/tmp/private-proof',
    ]
    const parsed = parsePrivateFidelityArguments(arguments_, {
      SRT_PRIVATE_TEST_PDF: privatePath,
    })

    expect(parsed.input).toBe(privatePath)
    expect(() =>
      parsePrivateFidelityArguments(['--input', privatePath, ...arguments_], {
        SRT_PRIVATE_TEST_PDF: privatePath,
      }),
    ).toThrow()
    expect(() => parsePrivateFidelityArguments(arguments_, {})).toThrow()
    expect(() =>
      parsePrivateFidelityArguments(
        arguments_.toSpliced(1, 1, 'INVALID-NAME'),
        { 'INVALID-NAME': privatePath },
      ),
    ).toThrow()
  })

  it('accepts only a hash-pinned environment-sourced decision sidecar', () => {
    const privatePath = '/private/operator-staged/input.pdf'
    const decisionPath = '/private/operator-staged/decisions.json'
    const baseArguments = [
      '--input-env',
      'SRT_PRIVATE_TEST_PDF',
      '--paper-id',
      'paper-v1',
      '--expected-size',
      '123',
      '--expected-sha256',
      hash,
      '--profiles',
      'mobile',
      '--repeat',
      '2',
      '--out',
      '/tmp/private-proof',
    ]
    const decisionArguments = [
      '--decisions-env',
      'SRT_PRIVATE_TEST_DECISIONS',
      '--expected-decisions-sha256',
      'f'.repeat(64),
    ]
    const environment = {
      SRT_PRIVATE_TEST_PDF: privatePath,
      SRT_PRIVATE_TEST_DECISIONS: decisionPath,
    }

    expect(
      parsePrivateFidelityArguments(
        [...baseArguments, ...decisionArguments],
        environment,
      ),
    ).toMatchObject({
      decisions: decisionPath,
      expectedDecisionsSha256: 'f'.repeat(64),
    })
    for (const incomplete of [
      decisionArguments.slice(0, 2),
      decisionArguments.slice(2),
    ]) {
      expect(() =>
        parsePrivateFidelityArguments(
          [...baseArguments, ...incomplete],
          environment,
        ),
      ).toThrow('INVALID_USAGE')
    }
    expect(() =>
      parsePrivateFidelityArguments([...baseArguments, ...decisionArguments], {
        SRT_PRIVATE_TEST_PDF: privatePath,
      }),
    ).toThrow('INVALID_USAGE')
  })

  it('fails closed unless every pinned private decision applies without staleness', () => {
    const decisionFile = {
      schemaVersion: '1.1.0',
      documentSha256: hash,
      decisions: [{ id: 'decision-1' }, { id: 'decision-2' }],
    }
    const applied = applyPrivateDecisionSet(
      { source: { sha256: hash } },
      decisionFile,
      () => ({
        source: { sha256: hash },
        humanAdjudications: {
          applied: [...decisionFile.decisions],
          stale: [],
        },
      }),
    )
    expect(applied.humanAdjudications.applied).toHaveLength(2)

    expect(() =>
      applyPrivateDecisionSet(
        { source: { sha256: hash } },
        decisionFile,
        () => ({
          humanAdjudications: {
            applied: [decisionFile.decisions[0]],
            stale: [decisionFile.decisions[1]],
          },
        }),
      ),
    ).toThrow('PRIVATE_DECISION_SET_STALE')
  })

  it('accepts one externally pinned frozen baseline without adding its path to receipts', () => {
    const privatePath = '/private/operator-staged/input.pdf'
    const baselinePath = '/external/operator-only/frozen-receipt.json'
    const parsed = parsePrivateFidelityArguments(
      [
        '--input-env',
        'SRT_PRIVATE_TEST_PDF',
        '--paper-id',
        'paper-v1',
        '--expected-size',
        '123',
        '--expected-sha256',
        hash,
        '--profiles',
        'mobile',
        '--repeat',
        '2',
        '--out',
        '/tmp/private-proof',
        '--baseline',
        baselinePath,
        '--expected-baseline-sha256',
        'f'.repeat(64),
      ],
      { SRT_PRIVATE_TEST_PDF: privatePath },
    )

    expect(parsed.baseline).toBe(baselinePath)
    expect(parsed.expectedBaselineSha256).toBe('f'.repeat(64))
    expect(JSON.stringify(fidelityReceipt())).not.toContain(baselinePath)
    expect(() =>
      parsePrivateFidelityArguments(
        [
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'paper-v1',
          '--expected-size',
          '123',
          '--expected-sha256',
          hash,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          '/tmp/private-proof',
          '--baseline',
          baselinePath,
          '--expected-baseline-sha256',
          'f'.repeat(64),
          '--baseline',
          baselinePath,
        ],
        { SRT_PRIVATE_TEST_PDF: privatePath },
      ),
    ).toThrow('INVALID_USAGE')

    for (const incomplete of [
      ['--baseline', baselinePath],
      ['--expected-baseline-sha256', 'f'.repeat(64)],
    ]) {
      expect(() =>
        parsePrivateFidelityArguments(
          [
            '--input-env',
            'SRT_PRIVATE_TEST_PDF',
            '--paper-id',
            'paper-v1',
            '--expected-size',
            '123',
            '--expected-sha256',
            hash,
            '--profiles',
            'mobile',
            '--repeat',
            '2',
            '--out',
            '/tmp/private-proof',
            ...incomplete,
          ],
          { SRT_PRIVATE_TEST_PDF: privatePath },
        ),
      ).toThrow('INVALID_USAGE')
    }
  })

  it('passes only ready byte-identical reconstruction and profile repetitions with an accepted baseline', () => {
    const profiles = ['mobile', 'paperProMove', 'paperPro']
    const runs = [1, 2].map((ordinal) =>
      run(
        ordinal,
        reconstruction(),
        profiles.map((profile) => artifact(profile)),
      ),
    )
    const receipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs,
      repeat: 2,
      profiles,
      baselineComparison: {
        status: 'passed',
        passed: true,
        receiptSha256: 'f'.repeat(64),
      },
    })
    expect(receipt.execution).toMatchObject({
      reconstructionDeterministic: true,
      artifactsDeterministic: true,
      allReady: true,
      lineTransitionGatePassed: true,
      localValidationPassed: true,
    })
    expect(receipt.passed).toBe(true)
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain('/private/input.pdf')
    expect(serialized).not.toContain('/private/operator-staged/input.pdf')
    expect(serialized).not.toContain('SRT_PRIVATE_TEST_PDF')
  })

  it('requires six passing EPUBCheck results for a required three-profile repeat', () => {
    const profiles = ['mobile', 'paperProMove', 'paperPro']
    const checkedRuns = [1, 2].map((ordinal) =>
      run(
        ordinal,
        reconstruction(),
        profiles.map((profile) => {
          const { receiptSha256: _receiptSha256, ...evidence } =
            artifact(profile)
          const checkedEvidence = {
            ...evidence,
            epubCheck: { status: 'passed' },
          }
          return {
            ...checkedEvidence,
            receiptSha256: canonicalJsonHash(checkedEvidence),
          }
        }),
      ),
    )
    const checked = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: checkedRuns,
      repeat: 2,
      profiles,
      epubCheckRequired: true,
    })

    expect(checked.schemaVersion).toBe('1.9.0')
    expect(checked.execution).toMatchObject({
      epubCheckRequired: true,
      epubCheckPassedCount: 6,
      allEpubCheckPassed: true,
      localValidationPassed: true,
    })
    expect(
      checked.runs.flatMap((candidate) => candidate.artifacts),
    ).toHaveLength(6)
    expect(
      checked.runs
        .flatMap((candidate) => candidate.artifacts)
        .every((candidate) => candidate.epubCheck.status === 'passed'),
    ).toBe(true)

    const unchecked = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) =>
        run(
          ordinal,
          reconstruction(),
          profiles.map((profile) => artifact(profile)),
        ),
      ),
      repeat: 2,
      profiles,
      epubCheckRequired: true,
    })
    expect(unchecked.execution).toMatchObject({
      epubCheckRequired: true,
      epubCheckPassedCount: 0,
      allEpubCheckPassed: false,
      localValidationPassed: false,
    })
  })


})
