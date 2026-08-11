import { spawnSync as rawSpawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  canonicalJsonHash,
  capturePdfCorpusExecutionProvenance,
  createSafeAuditFailureDocument,
  createPdfStructuralReceipt as createRawPdfStructuralReceipt,
  finalizePdfCorpusExecutionProvenance,
  packageContentsIdentity,
  pdfCorpusWorktreeStateSnapshot,
  summarizeAuditDiagnostics,
} from './pdf-corpus-audit-lib.mjs'
import { safeAuditDiagnostic } from './pdf-corpus-audit-safety.mjs'

const REPOSITORY_SCOPED_GIT_ENVIRONMENT_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
]

function spawnSync(command, arguments_, options = {}) {
  if (command !== 'git' || arguments_[0] !== '-C') {
    return rawSpawnSync(command, arguments_, options)
  }
  const environment = { ...process.env, ...options.env }
  for (const key of REPOSITORY_SCOPED_GIT_ENVIRONMENT_KEYS) {
    delete environment[key]
  }
  return rawSpawnSync(command, arguments_, {
    ...options,
    env: environment,
  })
}

function sourceBox(overrides = {}) {
  return {
    page: 1,
    x: 0.1,
    y: 0.2,
    width: 0.1,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text',
    ...overrides,
  }
}

function createPdfStructuralReceipt(reconstruction) {
  return createRawPdfStructuralReceipt({
    canonicalHyphenBoundaryDecisions: [],
    canonicalHyphenBoundaryDecisionCount: 0,
    ...reconstruction,
  })
}

function canonicalHyphenDeletionReconstruction() {
  const fromBox = sourceBox({ page: 1, y: 0.8, width: 0.4 })
  const toBox = sourceBox({ page: 2, y: 0.1, width: 0.4 })
  const proofBox = sourceBox({ page: 2, y: 0.2, width: 0.5 })
  const region = (id, text, box) => ({
    id,
    page: box.page,
    kind: 'body',
    column: 'single',
    text,
    confidence: 1,
    box,
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: 10,
        box,
        runs: [],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: false,
  })
  const fromRegion = region('hyphen-from-region', 'Repre-', fromBox)
  const toRegion = region(
    'hyphen-to-region',
    'sentation, continued source text.',
    toBox,
  )
  const proofRegion = region(
    'hyphen-proof-region',
    'Representation appears elsewhere in the same document.',
    proofBox,
  )
  const decision = {
    id: `canonical-hyphen-boundary:canonical-flow-continuation:${fromRegion.id}:${fromRegion.lines[0].id}->${toRegion.id}:${toRegion.lines[0].id}`,
    context: 'canonical-flow-continuation',
    outcome: 'removed-discretionary-hyphen',
    fromRegionId: fromRegion.id,
    fromLineId: fromRegion.lines[0].id,
    toRegionId: toRegion.id,
    toLineId: toRegion.lines[0].id,
    geometry: { from: fromBox, to: toBox },
    proof: {
      tier: 'exact-same-document',
      sourceBoundaryProven: true,
      pinnedWord: 'representation',
      pinnedJoinedFormValid: true,
      pinnedSplit: { left: 'repre', right: 'sentation', index: 5 },
      splitPointValid: true,
      exactSameDocumentJoinedForm: 'Representation',
      sameDocumentJoinedFormValid: true,
      hardHyphenForm: 'repre-sentation',
      hardHyphenCounterproof: null,
      model: {
        id: 'scowl-2020.12.07+ushyphmax-2005-05-30',
        language: 'en-US',
        dictionarySha256:
          '829a043cf078d1e80e886289a13823454977f442a239a859d2133ea61944aa60',
        affixSha256:
          '70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5',
        hyphenationSha256:
          'f4ffcd96c5cbc886bdad23f95dcae8edc3cd3620eae62f7946eceda97c4e68f8',
      },
      evidence: [
        'source-proven-wrapped-line-boundary',
        'lexical-model:scowl-2020.12.07+ushyphmax-2005-05-30',
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
        'same-document-unhyphenated-word',
        'hard-hyphen-form-not-proved',
        'language-scope:en-US->en-US',
      ],
    },
  }
  return {
    paper: {
      id: 'paper-1',
      nodes: [{ id: 'node-1', type: 'paragraph', text: 'Representation' }],
    },
    regions: [fromRegion, toRegion, proofRegion],
    lineBoundaryDecisions: [],
    unresolvedCorruptingJoinCount: 0,
    structurallyConsumedLineBoundaryCount: 0,
    canonicalHyphenBoundaryDecisions: [decision],
    canonicalHyphenBoundaryDecisionCount: 1,
  }
}

function canonicalDerivedAffixHyphenDeletionReconstruction() {
  const reconstruction = canonicalHyphenDeletionReconstruction()
  const [fromRegion, toRegion, proofRegion] = reconstruction.regions
  fromRegion.text = 'Reparameter-'
  fromRegion.lines[0].text = fromRegion.text
  toRegion.text = 'ized, continued source text.'
  toRegion.lines[0].text = toRegion.text
  proofRegion.text =
    'Parameterized models appear elsewhere in the same document.'
  proofRegion.lines[0].text = proofRegion.text
  reconstruction.paper.nodes[0].text = 'Parameterized'
  reconstruction.canonicalHyphenBoundaryDecisions[0].proof = {
    tier: 'same-document-derived-affix',
    sourceBoundaryProven: true,
    derivedWord: 'reparameterized',
    productivePrefix: {
      kind: 'prefix',
      value: 're',
      affixClass: 'PFX',
      flag: 'A',
      crossProduct: true,
      affixSha256:
        '70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5',
    },
    baseWord: 'parameterized',
    pinnedBaseWordValid: true,
    pinnedSplit: { left: 'reparameter', right: 'ized', index: 11 },
    splitPointValid: true,
    exactSameDocumentBaseWord: 'Parameterized',
    sameDocumentBaseWordValid: true,
    hardHyphenForm: 'reparameter-ized',
    hardHyphenCounterproof: null,
    model: {
      id: 'scowl-2020.12.07+ushyphmax-2005-05-30',
      language: 'en-US',
      dictionarySha256:
        '829a043cf078d1e80e886289a13823454977f442a239a859d2133ea61944aa60',
      affixSha256:
        '70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5',
      hyphenationSha256:
        'f4ffcd96c5cbc886bdad23f95dcae8edc3cd3620eae62f7946eceda97c4e68f8',
    },
    evidence: [
      'source-proven-wrapped-line-boundary',
      'lexical-model:scowl-2020.12.07+ushyphmax-2005-05-30',
      'joined-form-valid:same-document-derived-affix',
      'split-point-valid:pinned-hyphenation-pattern',
      'productive-prefix-valid:pinned-affix-model',
      'base-form-valid:pinned-lexicon',
      'same-document-unhyphenated-base-word',
      'hard-hyphen-form-not-proved',
      'language-scope:en-US->en-US',
    ],
  }
  return reconstruction
}

describe('local PDF corpus audit', () => {
  it('keeps the frozen v1.5 audit schema byte-identical', async () => {
    const bytes = await readFile('docs/schemas/pdf-corpus-audit.schema.json')
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '6d6a6b12745ec075c1658208ed389d5420c2e091f0f95e24bd3c04f1a1c3ba73',
    )
  })

  it('keeps the frozen v1.6 audit schema byte-identical', async () => {
    const bytes = await readFile(
      'docs/schemas/pdf-corpus-audit-v1.6.schema.json',
    )
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '3b50cb9fbb60bd004653f4c7831ec3cf0950cc3449e22fa44c6c0575c695eecd',
    )
  })

  it('captures deterministic privacy-safe implementation provenance', async () => {
    const first = await finalizePdfCorpusExecutionProvenance(
      await capturePdfCorpusExecutionProvenance('pdf-corpus-audit'),
    )
    const second = await finalizePdfCorpusExecutionProvenance(
      await capturePdfCorpusExecutionProvenance('pdf-corpus-audit'),
    )
    const expectedCommit = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
    }).stdout.trim()
    const expectedClean =
      spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        encoding: 'utf8',
      }).stdout.trim() === ''
    const packageLockBytes = await readFile('package-lock.json')
    const pdfjsPackageBytes = await readFile(
      'node_modules/pdfjs-dist/package.json',
    )
    const pdfjsPackage = JSON.parse(pdfjsPackageBytes)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      schemaVersion: '1.1.0',
      implementation: {
        gitCommit: expectedCommit,
        worktreeState: expectedClean ? 'clean' : 'dirty',
        exactHead: expectedClean,
      },
      runtime: {
        name: 'node',
        version: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
      },
      tool: {
        id: 'pdf-corpus-audit',
        packageName: 'astro-erudite',
        packageVersion: '1.2.4',
      },
      toolchain: {
        packageLockSha256: createHash('sha256')
          .update(packageLockBytes)
          .digest('hex'),
        pdfjsDist: {
          declaredVersion: '5.4.624',
          lockedVersion: '5.4.624',
          resolvedVersion: pdfjsPackage.version,
          resolvedPackageJsonSha256: createHash('sha256')
            .update(pdfjsPackageBytes)
            .digest('hex'),
          resolvedPackageContentsSha256: (
            await packageContentsIdentity(resolve('node_modules/pdfjs-dist'))
          ).sha256,
        },
      },
      verification: {
        method: 'before-after-exact-match-v1',
        stateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(Date.parse(first.implementation.gitCommitTimestamp)).not.toBeNaN()
    expect(JSON.stringify(first)).not.toContain(resolve('.'))
  }, 15_000)

  it('fails provenance finalization closed when the captured state changed', async () => {
    const capture =
      await capturePdfCorpusExecutionProvenance('pdf-corpus-audit')
    capture.stateSha256 = '0'.repeat(64)

    await expect(finalizePdfCorpusExecutionProvenance(capture)).rejects.toThrow(
      'PDF_CORPUS_PROVENANCE_CHANGED_DURING_RUN',
    )
  })

  it('hashes the complete installed package manifest, not only package metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-package-identity-'))
    try {
      await mkdir(join(directory, 'legacy', 'build'), { recursive: true })
      await writeFile(join(directory, 'package.json'), '{"version":"1.0.0"}\n')
      const implementationPath = join(directory, 'legacy', 'build', 'pdf.mjs')
      await writeFile(implementationPath, 'export const build = "first"\n')
      const first = await packageContentsIdentity(directory)

      await writeFile(implementationPath, 'export const build = "other"\n')
      const second = await packageContentsIdentity(directory)

      expect(second.fileCount).toBe(first.fileCount)
      expect(second.sha256).not.toBe(first.sha256)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it('changes worktree identity when the content of an already-dirty file changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-provenance-git-'))
    try {
      expect(
        spawnSync('git', ['-C', directory, 'init', '--quiet']).status,
      ).toBe(0)
      await writeFile(join(directory, 'tracked.txt'), 'committed\n')
      expect(
        spawnSync('git', ['-C', directory, 'add', 'tracked.txt']).status,
      ).toBe(0)
      expect(
        spawnSync('git', [
          '-C',
          directory,
          '-c',
          'user.name=PDF provenance fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ]).status,
      ).toBe(0)

      await writeFile(join(directory, 'tracked.txt'), 'first dirty state\n')
      const before = await pdfCorpusWorktreeStateSnapshot(directory)
      await writeFile(join(directory, 'tracked.txt'), 'second dirty state\n')
      const after = await pdfCorpusWorktreeStateSnapshot(directory)

      expect(before.worktreeStatus).toBe(after.worktreeStatus)
      expect(before.contentSha256).not.toBe(after.contentSha256)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'rejects tracked files hidden from exact-head verification by %s',
    async (indexFlag) => {
      const directory = await mkdtemp(join(tmpdir(), 'pdf-provenance-index-'))
      try {
        expect(
          spawnSync('git', ['-C', directory, 'init', '--quiet']).status,
        ).toBe(0)
        await writeFile(join(directory, 'tracked.txt'), 'committed\n')
        expect(
          spawnSync('git', ['-C', directory, 'add', 'tracked.txt']).status,
        ).toBe(0)
        expect(
          spawnSync('git', [
            '-C',
            directory,
            '-c',
            'user.name=PDF provenance fixture',
            '-c',
            'user.email=fixture@example.invalid',
            'commit',
            '--quiet',
            '-m',
            'fixture',
          ]).status,
        ).toBe(0)
        expect(
          spawnSync('git', [
            '-C',
            directory,
            'update-index',
            indexFlag,
            'tracked.txt',
          ]).status,
        ).toBe(0)
        await writeFile(join(directory, 'tracked.txt'), 'hidden dirty state\n')

        await expect(pdfCorpusWorktreeStateSnapshot(directory)).rejects.toThrow(
          'PDF_CORPUS_PROVENANCE_UNAVAILABLE',
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it('compares tracked bytes with HEAD despite a reusable Git stat cache entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-provenance-bytes-'))
    try {
      expect(
        spawnSync('git', ['-C', directory, 'init', '--quiet']).status,
      ).toBe(0)
      const trackedPath = join(directory, 'tracked.txt')
      await writeFile(trackedPath, 'aaaaaaaa\n')
      expect(
        spawnSync('git', ['-C', directory, 'add', 'tracked.txt']).status,
      ).toBe(0)
      expect(
        spawnSync('git', [
          '-C',
          directory,
          '-c',
          'user.name=PDF provenance fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ]).status,
      ).toBe(0)
      expect(
        spawnSync('git', [
          '-C',
          directory,
          'config',
          'core.trustctime',
          'false',
        ]).status,
      ).toBe(0)
      const clean = await pdfCorpusWorktreeStateSnapshot(directory)
      const committedTimes = await stat(trackedPath)

      await writeFile(trackedPath, 'bbbbbbbb\n')
      await utimes(trackedPath, committedTimes.atime, committedTimes.mtime)
      const changed = await pdfCorpusWorktreeStateSnapshot(directory)

      expect(clean.worktreeStatus).toBe('')
      expect(changed.worktreeStatus).toContain(
        'tracked-worktree-bytes-differ-from-head',
      )
      expect(changed.contentSha256).not.toBe(clean.contentSha256)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts clean tracked files normalized by Git input filters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-provenance-crlf-'))
    try {
      expect(
        spawnSync('git', ['-C', directory, 'init', '--quiet']).status,
      ).toBe(0)
      expect(
        spawnSync('git', ['-C', directory, 'config', 'core.autocrlf', 'true'])
          .status,
      ).toBe(0)
      const trackedPath = join(directory, 'tracked.txt')
      await writeFile(trackedPath, 'first\nsecond\n')
      expect(
        spawnSync('git', ['-C', directory, 'add', 'tracked.txt']).status,
      ).toBe(0)
      expect(
        spawnSync('git', [
          '-C',
          directory,
          '-c',
          'user.name=PDF provenance fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ]).status,
      ).toBe(0)

      await unlink(trackedPath)
      expect(
        spawnSync('git', ['-C', directory, 'checkout', '--', 'tracked.txt'])
          .status,
      ).toBe(0)
      expect(await readFile(trackedPath, 'utf8')).toBe('first\r\nsecond\r\n')
      expect(
        spawnSync('git', [
          '-C',
          directory,
          'status',
          '--porcelain=v1',
        ]).stdout.toString(),
      ).toBe('')
      const snapshot = await pdfCorpusWorktreeStateSnapshot(directory)

      expect(snapshot.worktreeStatus).toBe('')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects lossy clean-filter equivalence that is not the HEAD checkout representation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-provenance-filter-'))
    try {
      expect(
        spawnSync('git', ['-C', directory, 'init', '--quiet']).status,
      ).toBe(0)
      expect(
        spawnSync('git', [
          '-C',
          directory,
          'config',
          'filter.lossy.clean',
          "sed 's/.*/canonical/'",
        ]).status,
      ).toBe(0)
      await writeFile(
        join(directory, '.gitattributes'),
        'tracked.txt filter=lossy\n',
      )
      const trackedPath = join(directory, 'tracked.txt')
      await writeFile(trackedPath, 'original!\n')
      expect(
        spawnSync('git', [
          '-C',
          directory,
          'add',
          '.gitattributes',
          'tracked.txt',
        ]).status,
      ).toBe(0)
      expect(
        spawnSync('git', [
          '-C',
          directory,
          '-c',
          'user.name=PDF provenance fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ]).status,
      ).toBe(0)
      await unlink(trackedPath)
      expect(
        spawnSync('git', ['-C', directory, 'checkout', '--', 'tracked.txt'])
          .status,
      ).toBe(0)
      expect(await readFile(trackedPath, 'utf8')).toBe('canonical\n')
      const clean = await pdfCorpusWorktreeStateSnapshot(directory)

      await writeFile(trackedPath, 'alternate\n')
      expect(
        spawnSync('git', [
          '-C',
          directory,
          'status',
          '--porcelain=v1',
        ]).stdout.toString(),
      ).toBe('')
      const changed = await pdfCorpusWorktreeStateSnapshot(directory)

      expect(clean.worktreeStatus).toBe('')
      expect(changed.worktreeStatus).toContain(
        'tracked-worktree-bytes-differ-from-head',
      )
      expect(changed.contentSha256).not.toBe(clean.contentSha256)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('compares dangling symbolic-link targets without dereferencing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-provenance-symlink-'))
    try {
      expect(
        spawnSync('git', ['-C', directory, 'init', '--quiet']).status,
      ).toBe(0)
      const trackedPath = join(directory, 'tracked-link')
      await symlink('first-target', trackedPath)
      expect(
        spawnSync('git', ['-C', directory, 'add', 'tracked-link']).status,
      ).toBe(0)
      expect(
        spawnSync('git', [
          '-C',
          directory,
          '-c',
          'user.name=PDF provenance fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ]).status,
      ).toBe(0)
      const clean = await pdfCorpusWorktreeStateSnapshot(directory)

      await unlink(trackedPath)
      await symlink('other-target', trackedPath)
      const changed = await pdfCorpusWorktreeStateSnapshot(directory)

      expect(clean.worktreeStatus).toBe('')
      expect(changed.worktreeStatus).toContain(
        'tracked-worktree-bytes-differ-from-head',
      )
      expect(changed.contentSha256).not.toBe(clean.contentSha256)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses the owner execute bit tracked by Git for file modes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-provenance-mode-'))
    try {
      expect(
        spawnSync('git', ['-C', directory, 'init', '--quiet']).status,
      ).toBe(0)
      const trackedPath = join(directory, 'tracked.txt')
      await writeFile(trackedPath, 'committed\n')
      expect(
        spawnSync('git', ['-C', directory, 'add', 'tracked.txt']).status,
      ).toBe(0)
      expect(
        spawnSync('git', [
          '-C',
          directory,
          '-c',
          'user.name=PDF provenance fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ]).status,
      ).toBe(0)

      const baseline = await pdfCorpusWorktreeStateSnapshot(directory)
      await chmod(trackedPath, 0o645)
      expect(
        spawnSync('git', [
          '-C',
          directory,
          'status',
          '--porcelain=v1',
        ]).stdout.toString(),
      ).toBe('')
      const snapshot = await pdfCorpusWorktreeStateSnapshot(directory)

      expect(snapshot.worktreeStatus).toBe('')
      expect(snapshot.contentSha256).toBe(baseline.contentSha256)

      await chmod(trackedPath, 0o745)
      const ownerExecutable = await pdfCorpusWorktreeStateSnapshot(directory)

      expect(ownerExecutable.worktreeStatus).not.toBe('')
      expect(ownerExecutable.contentSha256).not.toBe(snapshot.contentSha256)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('creates only allowlisted basename-only audit failure rows', () => {
    expect(
      createSafeAuditFailureDocument(
        '/private/source/problematic paper.pdf',
        'PDF_DOCUMENT_TIMEOUT',
      ),
    ).toEqual({
      basename: 'problematic paper.pdf',
      sha256: null,
      code: 'PDF_DOCUMENT_TIMEOUT',
      message: 'The PDF exceeded the local per-document processing time limit.',
    })
    expect(
      createSafeAuditFailureDocument(
        '/private/source/problematic paper.pdf',
        '/private/arbitrary-code',
      ),
    ).toEqual({
      basename: 'problematic paper.pdf',
      sha256: null,
      code: 'AUDIT_FAILED',
      message:
        'The PDF could not be audited; local path and document details were suppressed.',
    })
  })

  it('requires exact source-provenance and inline-semantic completeness fields in the public schema', async () => {
    const schema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
    )
    const completeness = schema.$defs.completeness
    const required = [
      'missingSourceRegionCount',
      'unprovenancedRenderedUnitCount',
      'expectedInlineSpanCount',
      'mappedInlineSpanCount',
      'inlineSpanCoverage',
      'expectedHyperlinkCount',
      'mappedHyperlinkCount',
      'hyperlinkCoverage',
      'structurallyConsumedLineBoundaryCount',
    ]

    expect(completeness.required).toEqual(expect.arrayContaining(required))
    expect(Object.keys(completeness.properties)).toEqual(
      expect.arrayContaining(required),
    )
    expect(
      schema.$defs.citationRelationship.properties.taxonomy.enum,
    ).toContain('author-year-bibliography-citation')
    expect(completeness.dependentRequired).toMatchObject({
      expectedSemanticTableCount: [
        'resolvedSemanticTableCount',
        'semanticTableCoverage',
      ],
      resolvedSemanticTableCount: [
        'expectedSemanticTableCount',
        'semanticTableCoverage',
      ],
      semanticTableCoverage: [
        'expectedSemanticTableCount',
        'resolvedSemanticTableCount',
      ],
    })
  })

  it('validates the required structural line-boundary count in report and receipt schemas', async () => {
    const legacySchema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
    )
    const supportingSchemas = await Promise.all(
      [
        'docs/schemas/pdf-corpus-audit-v1.6.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.7.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.8.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.9.schema.json',
      ].map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
    )
    const schema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit-v1.10.schema.json', 'utf8'),
    )
    const ajv = new Ajv2020({ strict: false })
    ajv.addSchema(legacySchema)
    for (const supportingSchema of supportingSchemas) {
      ajv.addSchema(supportingSchema)
    }
    ajv.addSchema(schema)
    const completenessValidator = ajv.compile({
      $schema: legacySchema.$schema,
      $defs: legacySchema.$defs,
      ...legacySchema.$defs.completeness,
    })
    const receiptValidator = ajv.getSchema(
      `${schema.$id}#/$defs/structuralReceipt`,
    )
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [{ id: 'node-1', type: 'paragraph', text: 'Body' }],
      },
      lineBoundaryDecisions: [
        {
          id: 'boundary-1',
          page: 1,
          regionId: 'table-region-1',
          fromLineId: 'line-1',
          toLineId: 'line-2',
          outcome: 'structural-boundary',
          evidence: ['strict-visual-only-region'],
        },
        {
          id: 'boundary-2',
          page: 1,
          regionId: 'prose-region-1',
          fromLineId: 'line-3',
          toLineId: 'line-4',
          outcome: 'ambiguous',
          evidence: ['ambiguous-joined-and-hard-hyphen-forms'],
        },
      ],
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 1,
      canonicalHyphenBoundaryDecisions: [],
      canonicalHyphenBoundaryDecisionCount: 0,
    }
    const receipt = createPdfStructuralReceipt(reconstruction)

    expect(legacySchema.$id).toBe(
      'https://ernie.sg/schemas/pdf-corpus-audit-1.5.0.json',
    )
    expect(legacySchema.properties.schemaVersion.const).toBe('1.5.0')
    expect(supportingSchemas.at(-1).properties.schemaVersion.const).toBe(
      '1.9.0',
    )
    expect(schema.properties.schemaVersion.const).toBe('1.10.0')
    expect(schema.$defs.structuralReceipt.properties.schemaVersion.const).toBe(
      '1.7.0',
    )
    expect(schema.$defs.structuralReceipt.required).toContain(
      'canonicalNodeProvenanceSha256',
    )
    expect(schema.$defs.structuralReceipt.required).toEqual(
      expect.arrayContaining([
        'crossReferenceRelationshipCount',
        'crossReferenceRelationshipCounts',
        'crossReferenceRelationshipGraph',
        'crossReferenceRelationshipGraphSha256',
      ]),
    )
    expect(legacySchema.$defs.crossReferenceRelationship).toBeDefined()
    expect(legacySchema.$defs.crossReferenceTarget).toBeDefined()
    expect(receipt).toMatchObject({
      schemaVersion: '1.7.0',
      canonicalNodeProvenanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      lineTransitionCount: 2,
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 1,
      canonicalHyphenDeletionLedgerAvailable: true,
      canonicalHyphenDeletionCount: 0,
      canonicalHyphenDeletionContextCounts: {},
      canonicalHyphenDeletionLedger: [],
      canonicalHyphenDeletionLedgerSha256:
        expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(receiptValidator(receipt), receiptValidator.errors).toBe(true)
    expect(
      receiptValidator({
        ...receipt,
        structurallyConsumedLineBoundaryCount: -1,
      }),
    ).toBe(false)
    const { structurallyConsumedLineBoundaryCount: _, ...missingCount } =
      receipt
    expect(receiptValidator(missingCount)).toBe(false)

    const completeness = {
      sourceTextCharacters: 0,
      outputTextCharacters: 0,
      matchedTextCharacters: 0,
      textCoverage: 0,
      duplicateCanonicalSpanCount: 0,
      missingSourceRegionCount: 0,
      unprovenancedRenderedUnitCount: 0,
      expectedInlineSpanCount: 0,
      mappedInlineSpanCount: 0,
      inlineSpanCoverage: 0,
      expectedHyperlinkCount: 0,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
      lineBoundaryCount: 2,
      decidedLineBoundaryCount: 2,
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 1,
      sourceAssetCount: 0,
      exportedAssetCount: 0,
      assetCoverage: 0,
      expectedRelationshipCount: 0,
      resolvedRelationshipCount: 0,
      relationshipCoverage: 0,
      unresolvedObjectCount: 0,
      unresolvedObjects: {
        assets: 0,
        captions: 0,
        tables: 0,
        equations: 0,
        citations: 0,
        footnoteReferences: 0,
        footnotes: 0,
      },
      ocrRequiredPages: [],
      readingOrderDiagnostics: 0,
      readingOrderEvaluation: {
        schemaVersion: '1.0.0',
        algorithm: 'deterministic-geometry-v1',
        mode: 'deterministic-only',
        regionCount: 0,
        acceptedEdgeCount: 0,
        unresolvedEdgeCount: 0,
        cycleRate: 0,
        orderAccuracy: null,
        provider: null,
        modelVersion: null,
        latencyMs: 0,
        costUsd: 0,
        reviewRequired: false,
      },
    }
    expect(
      completenessValidator(completeness),
      completenessValidator.errors,
    ).toBe(true)
    expect(
      completenessValidator({
        ...completeness,
        structurallyConsumedLineBoundaryCount: -1,
      }),
    ).toBe(false)
  })

  it('rejects receipt counts that disagree with the line-boundary decision ledger', () => {
    const reconstruction = {
      paper: { id: 'paper-1', nodes: [] },
      lineBoundaryDecisions: [
        {
          id: 'boundary-1',
          outcome: 'structural-boundary',
          evidence: ['strict-visual-only-region'],
        },
      ],
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 1,
    }

    expect(() => createPdfStructuralReceipt(reconstruction)).toThrow(
      'Line transition counts do not match the decision ledger.',
    )
    expect(() =>
      createPdfStructuralReceipt({
        ...reconstruction,
        unresolvedCorruptingJoinCount: 0,
        structurallyConsumedLineBoundaryCount: 1,
        lineBoundaryDecisions: [
          { ...reconstruction.lineBoundaryDecisions[0], outcome: 'invented' },
        ],
      }),
    ).toThrow('Line transition decision outcome is invalid.')
  })

  // Heavy structuredClone/receipt churn; the default 5s trips on cold CI runners.
  it(
    'persists deterministic privacy-safe canonical hyphen deletion records and rejects incomplete or duplicate proof',
    { timeout: 30_000 },
    async () => {
      const reconstruction = canonicalHyphenDeletionReconstruction()
      const receipt = createPdfStructuralReceipt(reconstruction)

      expect(receipt).toMatchObject({
        schemaVersion: '1.7.0',
        canonicalHyphenDeletionLedgerAvailable: true,
        canonicalHyphenDeletionCount: 1,
        canonicalHyphenDeletionContextCounts: {
          'canonical-flow-continuation': 1,
        },
        canonicalHyphenDeletionLedger: [
          {
            id: expect.stringMatching(/^[a-f0-9]{64}$/),
            context: 'canonical-flow-continuation',
            outcome: 'removed-discretionary-hyphen',
            fromRegionId: expect.stringMatching(/^[a-f0-9]{64}$/),
            fromLineId: expect.stringMatching(/^[a-f0-9]{64}$/),
            toRegionId: expect.stringMatching(/^[a-f0-9]{64}$/),
            toLineId: expect.stringMatching(/^[a-f0-9]{64}$/),
            geometry: {
              from: sourceBox({ page: 1, y: 0.8, width: 0.4 }),
              to: sourceBox({ page: 2, y: 0.1, width: 0.4 }),
            },
            proof: expect.objectContaining({
              tier: 'exact-same-document',
              sourceBoundaryProven: true,
              pinnedWordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              pinnedSplit: {
                leftSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                rightSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                index: 5,
              },
              exactSameDocumentJoinedFormSha256:
                expect.stringMatching(/^[a-f0-9]{64}$/),
              hardHyphenFormSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              hardHyphenCounterproof: null,
              model:
                reconstruction.canonicalHyphenBoundaryDecisions[0].proof.model,
              evidenceSha256s: expect.arrayContaining([
                expect.stringMatching(/^[a-f0-9]{64}$/),
              ]),
            }),
          },
        ],
        canonicalHyphenDeletionLedgerSha256:
          expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(receipt.canonicalHyphenDeletionLedgerSha256).toBe(
        canonicalJsonHash(receipt.canonicalHyphenDeletionLedger),
      )
      expect(
        JSON.stringify(receipt.canonicalHyphenDeletionLedger),
      ).not.toContain('Representation')
      expect(
        JSON.stringify(receipt.canonicalHyphenDeletionLedger),
      ).not.toContain('language-scope:en-US->en-US')
      expect(
        receipt.canonicalHyphenDeletionLedger[0].proof.evidenceSha256s,
      ).toEqual(
        [
          ...receipt.canonicalHyphenDeletionLedger[0].proof.evidenceSha256s,
        ].sort(),
      )

      const reorderedEvidence = structuredClone(reconstruction)
      reorderedEvidence.canonicalHyphenBoundaryDecisions[0].proof.evidence.reverse()
      expect(
        createPdfStructuralReceipt(reorderedEvidence)
          .canonicalHyphenDeletionLedgerSha256,
      ).toBe(receipt.canonicalHyphenDeletionLedgerSha256)

      const secondRegions = structuredClone(reconstruction.regions).map(
        (region) => ({
          ...region,
          id: `second-${region.id}`,
          lines: region.lines.map((line) => ({
            ...line,
            id: `second-${line.id}`,
          })),
        }),
      )
      const secondDecision = structuredClone(
        reconstruction.canonicalHyphenBoundaryDecisions[0],
      )
      secondDecision.context = 'bibliography-continuation'
      secondDecision.fromRegionId = secondRegions[0].id
      secondDecision.fromLineId = secondRegions[0].lines[0].id
      secondDecision.toRegionId = secondRegions[1].id
      secondDecision.toLineId = secondRegions[1].lines[0].id
      secondDecision.id = `canonical-hyphen-boundary:${secondDecision.context}:${secondDecision.fromRegionId}:${secondDecision.fromLineId}->${secondDecision.toRegionId}:${secondDecision.toLineId}`
      const twoDecisions = {
        ...structuredClone(reconstruction),
        regions: [...structuredClone(reconstruction.regions), ...secondRegions],
        canonicalHyphenBoundaryDecisions: [
          structuredClone(reconstruction.canonicalHyphenBoundaryDecisions[0]),
          secondDecision,
        ],
        canonicalHyphenBoundaryDecisionCount: 2,
      }
      const reversedDecisions = structuredClone(twoDecisions)
      reversedDecisions.canonicalHyphenBoundaryDecisions.reverse()
      reversedDecisions.canonicalHyphenBoundaryDecisions.forEach((decision) =>
        decision.proof.evidence.reverse(),
      )
      expect(
        createPdfStructuralReceipt(twoDecisions)
          .canonicalHyphenDeletionLedgerSha256,
      ).toBe(
        createPdfStructuralReceipt(reversedDecisions)
          .canonicalHyphenDeletionLedgerSha256,
      )

      const schemas = await Promise.all(
        [
          'docs/schemas/pdf-corpus-audit.schema.json',
          'docs/schemas/pdf-corpus-audit-v1.6.schema.json',
          'docs/schemas/pdf-corpus-audit-v1.7.schema.json',
          'docs/schemas/pdf-corpus-audit-v1.8.schema.json',
          'docs/schemas/pdf-corpus-audit-v1.9.schema.json',
          'docs/schemas/pdf-corpus-audit-v1.10.schema.json',
        ].map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
      )
      const [, , , v18Schema, , schema] = schemas
      const ajv = new Ajv2020({ strict: false })
      for (const candidateSchema of schemas) ajv.addSchema(candidateSchema)
      const validate = ajv.getSchema(`${schema.$id}#/$defs/structuralReceipt`)
      expect(validate(receipt), validate.errors).toBe(true)
      const historicalReceipt = structuredClone(receipt)
      historicalReceipt.schemaVersion = '1.5.0'
      for (const record of historicalReceipt.canonicalHyphenDeletionLedger) {
        delete record.proof.tier
      }
      historicalReceipt.canonicalHyphenDeletionLedgerSha256 = canonicalJsonHash(
        historicalReceipt.canonicalHyphenDeletionLedger,
      )
      const validateV18Receipt = ajv.compile({
        $schema: v18Schema.$schema,
        $defs: v18Schema.$defs,
        ...v18Schema.$defs.structuralReceipt,
      })
      expect(
        validateV18Receipt(historicalReceipt),
        validateV18Receipt.errors,
      ).toBe(true)
      const schemaMissingMandatoryEvidence = structuredClone(receipt)
      schemaMissingMandatoryEvidence.canonicalHyphenDeletionLedger[0].proof.evidenceSha256s =
        ['a'.repeat(64)]
      expect(validate(schemaMissingMandatoryEvidence)).toBe(false)
      const schemaForbiddenCounterproof = structuredClone(receipt)
      schemaForbiddenCounterproof.canonicalHyphenDeletionLedger[0].proof.evidenceSha256s.push(
        createHash('sha256')
          .update(
            'canonical-hyphen-evidence\0hard-hyphen-form-valid:same-document',
          )
          .digest('hex'),
      )
      schemaForbiddenCounterproof.canonicalHyphenDeletionLedger[0].proof.evidenceSha256s.sort()
      expect(validate(schemaForbiddenCounterproof)).toBe(false)

      const fullReportResult = spawnSync(
        process.execPath,
        [
          'tools/pdf-corpus-audit.mjs',
          '--report-only',
          'tests/fixtures/pdf/born-digital.pdf',
        ],
        { encoding: 'utf8', timeout: 120_000 },
      )
      expect(fullReportResult.status, fullReportResult.stderr).toBe(0)
      const fullReport = JSON.parse(fullReportResult.stdout)
      Object.assign(fullReport.documents[0].structure, {
        canonicalHyphenDeletionLedgerAvailable:
          receipt.canonicalHyphenDeletionLedgerAvailable,
        canonicalHyphenDeletionCount: receipt.canonicalHyphenDeletionCount,
        canonicalHyphenDeletionContextCounts:
          receipt.canonicalHyphenDeletionContextCounts,
        canonicalHyphenDeletionLedger: receipt.canonicalHyphenDeletionLedger,
        canonicalHyphenDeletionLedgerSha256:
          receipt.canonicalHyphenDeletionLedgerSha256,
      })
      const fullAjv = new Ajv2020({ strict: false })
      for (const candidate of schemas) {
        fullAjv.addSchema(candidate)
      }
      const validateFullReport = fullAjv.getSchema(schema.$id)
      expect(validateFullReport(fullReport), validateFullReport.errors).toBe(
        true,
      )

      const malformed = structuredClone(reconstruction)
      malformed.canonicalHyphenBoundaryDecisions[0].proof.pinnedSplit.index += 1
      const duplicate = structuredClone(reconstruction)
      duplicate.canonicalHyphenBoundaryDecisions.push(
        structuredClone(duplicate.canonicalHyphenBoundaryDecisions[0]),
      )
      duplicate.canonicalHyphenBoundaryDecisionCount = 2
      const unknownField = structuredClone(reconstruction)
      unknownField.canonicalHyphenBoundaryDecisions[0].volatile = true
      const wrongModel = structuredClone(reconstruction)
      wrongModel.canonicalHyphenBoundaryDecisions[0].proof.model.id =
        'fake-compatible-shape'
      const uncheckedString = structuredClone(reconstruction)
      uncheckedString.canonicalHyphenBoundaryDecisions[0].proof.pinnedWord = {
        normalize: 'not-callable',
      }
      const missingMandatoryEvidence = structuredClone(reconstruction)
      missingMandatoryEvidence.canonicalHyphenBoundaryDecisions[0].proof.evidence =
        missingMandatoryEvidence.canonicalHyphenBoundaryDecisions[0].proof.evidence.filter(
          (evidence) => evidence !== 'joined-form-valid:pinned-lexicon',
        )
      const caseOnlyHardHyphenCounterproof = structuredClone(reconstruction)
      const collisionRegion = structuredClone(
        caseOnlyHardHyphenCounterproof.regions[2],
      )
      collisionRegion.id = 'case-only-hard-hyphen-counterproof-region'
      collisionRegion.text = 'REPRE-sentation is source text.'
      collisionRegion.lines[0].id = `${collisionRegion.id}-line`
      collisionRegion.lines[0].text = collisionRegion.text
      caseOnlyHardHyphenCounterproof.regions.push(collisionRegion)
      for (const invalid of [
        {
          ...structuredClone(reconstruction),
          canonicalHyphenBoundaryDecisions: undefined,
        },
        malformed,
        duplicate,
        unknownField,
        wrongModel,
        uncheckedString,
        missingMandatoryEvidence,
        caseOnlyHardHyphenCounterproof,
      ]) {
        expect(() => createPdfStructuralReceipt(invalid)).toThrow(
          /Canonical hyphen deletion/u,
        )
      }
      const missingBoth = structuredClone(reconstruction)
      delete missingBoth.canonicalHyphenBoundaryDecisions
      delete missingBoth.canonicalHyphenBoundaryDecisionCount
      expect(() => createRawPdfStructuralReceipt(missingBoth)).toThrow(
        /ledger and count are required/u,
      )
    },
  )

  it('persists a privacy-safe derived-affix receipt and rejects coordinated proof tampering', () => {
    const reconstruction = canonicalDerivedAffixHyphenDeletionReconstruction()
    const receipt = createPdfStructuralReceipt(reconstruction)

    expect(receipt).toMatchObject({
      schemaVersion: '1.7.0',
      canonicalHyphenDeletionCount: 1,
      canonicalHyphenDeletionLedger: [
        {
          proof: {
            tier: 'same-document-derived-affix',
            sourceBoundaryProven: true,
            derivedWordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            productivePrefix: {
              kind: 'prefix',
              value: 're',
              affixClass: 'PFX',
              flag: 'A',
              crossProduct: true,
              affixSha256:
                '70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5',
            },
            baseWordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            derivationBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            pinnedBaseWordValid: true,
            pinnedSplit: {
              leftSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              rightSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              index: 11,
            },
            splitPointValid: true,
            exactSameDocumentBaseWordSha256:
              expect.stringMatching(/^[a-f0-9]{64}$/),
            sameDocumentBaseWordValid: true,
            hardHyphenFormSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            hardHyphenCounterproof: null,
            model:
              reconstruction.canonicalHyphenBoundaryDecisions[0].proof.model,
            evidenceSha256s: expect.arrayContaining([
              expect.stringMatching(/^[a-f0-9]{64}$/),
            ]),
          },
        },
      ],
    })
    const proof = receipt.canonicalHyphenDeletionLedger[0].proof
    expect(proof.baseWordSha256).toBe(proof.exactSameDocumentBaseWordSha256)
    expect(proof.derivedWordSha256).not.toBe(proof.baseWordSha256)
    expect(JSON.stringify(proof)).not.toContain('parameterized')
    expect(proof).not.toHaveProperty('pinnedJoinedFormValid')
    expect(proof).not.toHaveProperty('sameDocumentJoinedFormValid')

    for (const mutate of [
      (candidate) => {
        candidate.proof.productivePrefix.flag = 'Z'
      },
      (candidate) => {
        candidate.proof.exactSameDocumentBaseWord =
          'same-document-but-not-the-base'
      },
      (candidate) => {
        candidate.proof.evidence = candidate.proof.evidence.filter(
          (entry) => entry !== 'base-form-valid:pinned-lexicon',
        )
      },
    ]) {
      const tampered = structuredClone(reconstruction)
      mutate(tampered.canonicalHyphenBoundaryDecisions[0])
      expect(() => createPdfStructuralReceipt(tampered)).toThrow(
        /canonical hyphen deletion/iu,
      )
    }

    const prefixBoundary = canonicalDerivedAffixHyphenDeletionReconstruction()
    prefixBoundary.regions[0].text = 'Re-'
    prefixBoundary.regions[0].lines[0].text = 'Re-'
    prefixBoundary.regions[1].text = 'entry, continued source text.'
    prefixBoundary.regions[1].lines[0].text = prefixBoundary.regions[1].text
    prefixBoundary.regions[2].text = 'Entry appears elsewhere.'
    prefixBoundary.regions[2].lines[0].text = prefixBoundary.regions[2].text
    Object.assign(prefixBoundary.canonicalHyphenBoundaryDecisions[0].proof, {
      derivedWord: 'reentry',
      baseWord: 'entry',
      pinnedSplit: { left: 're', right: 'entry', index: 2 },
      exactSameDocumentBaseWord: 'Entry',
      hardHyphenForm: 're-entry',
    })
    expect(() => createPdfStructuralReceipt(prefixBoundary)).toThrow(
      /canonical hyphen deletion/iu,
    )
  })

  it('canonicalizes structural hashes and recognizes the line-boundary decision ledger', async () => {
    expect(canonicalJson({ beta: 2, alpha: 1 })).toBe(
      canonicalJson({ alpha: 1, beta: 2 }),
    )
    expect(canonicalJsonHash({ beta: 2, alpha: 1 })).toBe(
      canonicalJsonHash({ alpha: 1, beta: 2 }),
    )
    const reconstruction = {
      paper: {
        id: 'paper-1',
        title: 'First title',
        nodes: [{ id: 'node-1', type: 'paragraph', text: 'Body' }],
      },
      readingOrder: { order: ['region-1'] },
      lineBoundaryDecisions: [],
      unresolvedCorruptingJoinCount: 0,
      canonicalHyphenBoundaryDecisions: [],
      canonicalHyphenBoundaryDecisionCount: 0,
      citationRelationships: [
        {
          id: 'citation-1',
          status: 'matched',
          taxonomy: 'bracketed-bibliography-citation',
          referenceRegionId: 'region-1',
          referenceStart: 4,
          referenceEnd: 7,
          labels: ['1'],
          targetNodeIds: ['bibliography-1'],
          canonicalAnchor: { nodeId: 'node-1', start: 4, end: 7 },
          evidence: ['fixture-citation-evidence'],
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.1,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
      crossReferenceRelationships: [
        {
          id: 'cross-reference-1',
          kind: 'figure',
          text: 'Figures 4 and 5',
          labels: ['Figure 4', 'Figure 5'],
          referenceRegionId: 'region-1',
          referenceStart: 8,
          referenceEnd: 23,
          targets: [
            {
              kind: 'figure',
              label: 'Figure 4',
              referenceStart: 16,
              referenceEnd: 17,
              status: 'matched',
              candidateNodeIds: ['figure-4'],
              targetNodeId: 'figure-4',
              evidence: [
                'explicit-scholarly-cross-reference-syntax',
                'canonical-label-unique',
              ],
            },
            {
              kind: 'figure',
              label: 'Figure 5',
              referenceStart: 22,
              referenceEnd: 23,
              status: 'matched',
              candidateNodeIds: ['figure-5'],
              targetNodeId: 'figure-5',
              evidence: [
                'explicit-scholarly-cross-reference-syntax',
                'canonical-label-unique',
              ],
            },
          ],
          targetNodeIds: ['figure-4', 'figure-5'],
          status: 'matched',
          canonicalAnchor: { nodeId: 'node-1', start: 8, end: 23 },
          confidence: 0.99,
          evidence: [
            'explicit-scholarly-cross-reference-syntax',
            'all-canonical-labels-unique',
          ],
          sourceBoxes: [
            {
              page: 1,
              x: 0.2,
              y: 0.3,
              width: 0.2,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    }
    const receipt = createPdfStructuralReceipt(reconstruction)
    const retitled = createPdfStructuralReceipt({
      ...reconstruction,
      paper: { ...reconstruction.paper, title: 'Second title' },
    })

    expect(receipt).toMatchObject({
      schemaVersion: '1.7.0',
      citationRelationshipCount: 1,
      citationRelationshipCounts: { matched: 1 },
      citationRelationshipGraph: [
        expect.objectContaining({
          id: expect.stringMatching(/^[a-f0-9]{64}$/),
          referenceRegionId: expect.stringMatching(/^[a-f0-9]{64}$/),
          labels: [expect.stringMatching(/^[a-f0-9]{64}$/)],
          targetNodeIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
          candidateNodeIds: [],
          canonicalAnchor: expect.objectContaining({
            nodeId: expect.stringMatching(/^[a-f0-9]{64}$/),
            start: 4,
            end: 7,
          }),
          evidenceSha256s: [expect.stringMatching(/^[a-f0-9]{64}$/)],
          sourceBoxes: reconstruction.citationRelationships[0].sourceBoxes,
        }),
      ],
      citationRelationshipGraphSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      crossReferenceRelationshipCount: 1,
      crossReferenceRelationshipCounts: { 'figure:matched': 1 },
      crossReferenceRelationshipGraph: [
        expect.objectContaining({
          id: expect.stringMatching(/^[a-f0-9]{64}$/),
          kind: 'figure',
          status: 'matched',
          textSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          referenceRegionId: expect.stringMatching(/^[a-f0-9]{64}$/),
          labels: [
            expect.stringMatching(/^[a-f0-9]{64}$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
          ],
          targets: [
            expect.objectContaining({
              kind: 'figure',
              labelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              status: 'matched',
              candidateNodeIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
              targetNodeId: expect.stringMatching(/^[a-f0-9]{64}$/),
              evidenceSha256s: expect.arrayContaining([
                expect.stringMatching(/^[a-f0-9]{64}$/),
              ]),
            }),
            expect.objectContaining({
              kind: 'figure',
              labelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              status: 'matched',
              candidateNodeIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
              targetNodeId: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          ],
          targetNodeIds: [
            expect.stringMatching(/^[a-f0-9]{64}$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
          ],
          canonicalAnchor: expect.objectContaining({
            nodeId: expect.stringMatching(/^[a-f0-9]{64}$/),
            start: 8,
            end: 23,
          }),
          confidence: 0.99,
          evidenceSha256s: expect.arrayContaining([
            expect.stringMatching(/^[a-f0-9]{64}$/),
          ]),
          sourceBoxes:
            reconstruction.crossReferenceRelationships[0].sourceBoxes,
        }),
      ],
      crossReferenceRelationshipGraphSha256:
        expect.stringMatching(/^[a-f0-9]{64}$/),
      lineTransitionLedgerAvailable: true,
      lineTransitionCount: 0,
      lineTransitionLedgerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      unresolvedCorruptingJoinCount: 0,
      readingOrderGraphSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(retitled.canonicalContentSha256).not.toBe(
      receipt.canonicalContentSha256,
    )
    const legacySchema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
    )
    const supportingSchemas = await Promise.all(
      [
        'docs/schemas/pdf-corpus-audit-v1.6.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.7.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.8.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.9.schema.json',
      ].map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
    )
    const schema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit-v1.10.schema.json', 'utf8'),
    )
    const ajv = new Ajv2020({ strict: false })
    ajv.addSchema(legacySchema)
    for (const supportingSchema of supportingSchemas) {
      ajv.addSchema(supportingSchema)
    }
    ajv.addSchema(schema)
    const receiptValidator = ajv.getSchema(
      `${schema.$id}#/$defs/structuralReceipt`,
    )
    expect(receiptValidator(receipt), receiptValidator.errors).toBe(true)
    const ambiguousRelationship = {
      ...reconstruction.citationRelationships[0],
      status: 'ambiguous',
      targetNodeIds: [],
      candidateNodeIds: ['bibliography-1', 'bibliography-2'],
      evidence: [
        ...reconstruction.citationRelationships[0].evidence,
        'bibliography-label-target-ambiguous',
      ],
    }
    const ambiguousReceipt = createPdfStructuralReceipt({
      ...reconstruction,
      citationRelationships: [ambiguousRelationship],
    })
    expect(receiptValidator(ambiguousReceipt), receiptValidator.errors).toBe(
      true,
    )
    const changedCandidates = createPdfStructuralReceipt({
      ...reconstruction,
      citationRelationships: [
        {
          ...ambiguousRelationship,
          candidateNodeIds: ['bibliography-1', 'bibliography-3'],
        },
      ],
    })
    expect(changedCandidates.citationRelationshipGraphSha256).not.toBe(
      ambiguousReceipt.citationRelationshipGraphSha256,
    )
    const changedEvidence = createPdfStructuralReceipt({
      ...reconstruction,
      citationRelationships: [
        {
          ...ambiguousRelationship,
          evidence: [...ambiguousRelationship.evidence, 'geometry-tie'],
        },
      ],
    })
    expect(changedEvidence.citationRelationshipGraphSha256).not.toBe(
      ambiguousReceipt.citationRelationshipGraphSha256,
    )
    const invalidCrossReferenceState = structuredClone(receipt)
    invalidCrossReferenceState.crossReferenceRelationshipGraph[0].targets[0] = {
      ...invalidCrossReferenceState.crossReferenceRelationshipGraph[0]
        .targets[0],
      status: 'ambiguous',
    }
    expect(receiptValidator(invalidCrossReferenceState)).toBe(false)
    expect(JSON.stringify(receipt.citationRelationshipGraph)).not.toContain(
      'bibliography-1',
    )
    expect(
      JSON.stringify(receipt.crossReferenceRelationshipGraph),
    ).not.toContain('Figure 4')
    expect(
      JSON.stringify(receipt.crossReferenceRelationshipGraph),
    ).not.toContain('figure-4')
    for (const changedRelationship of [
      {
        ...reconstruction.citationRelationships[0],
        canonicalAnchor: { nodeId: 'node-2', start: 4, end: 7 },
      },
      {
        ...reconstruction.citationRelationships[0],
        targetNodeIds: ['bibliography-2'],
      },
    ]) {
      const changed = createPdfStructuralReceipt({
        ...reconstruction,
        citationRelationships: [changedRelationship],
      })
      expect(changed.citationRelationshipGraphSha256).not.toBe(
        receipt.citationRelationshipGraphSha256,
      )
    }
    for (const mutate of [
      (relationship) => {
        relationship.canonicalAnchor.nodeId = 'node-2'
      },
      (relationship) => {
        relationship.targets[0].candidateNodeIds = ['figure-6']
        relationship.targets[0].targetNodeId = 'figure-6'
        relationship.targetNodeIds = ['figure-6', 'figure-5']
      },
    ]) {
      const relationship = structuredClone(
        reconstruction.crossReferenceRelationships[0],
      )
      mutate(relationship)
      const changed = createPdfStructuralReceipt({
        ...reconstruction,
        crossReferenceRelationships: [relationship],
      })
      expect(changed.crossReferenceRelationshipGraphSha256).not.toBe(
        receipt.crossReferenceRelationshipGraphSha256,
      )
    }
  })

  it('binds visual source-line lineage into the structural relationship hash', () => {
    const relationship = {
      id: 'table-1',
      kind: 'table',
      status: 'matched',
    }
    const reconstruction = {
      paper: { id: 'paper-1', nodes: [] },
      visualRelationships: [
        { ...relationship, sourceLineIds: ['line-1', 'line-2'] },
      ],
    }
    const receipt = createPdfStructuralReceipt(reconstruction)
    const changed = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [{ ...relationship, sourceLineIds: ['line-1'] }],
    })
    const withoutLineage = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [relationship],
    })

    expect(withoutLineage.visualRelationshipGraphSha256).toBe(
      canonicalJsonHash([
        {
          ...relationship,
          semanticKind: null,
          canonicalNodeId: null,
          captionNodeId: null,
          captionRegionId: null,
          sourceRegionIds: [],
          sourceObjectIds: [],
          sourceLineIds: [],
          assetIds: [],
          sourceBoxes: [],
          altTextSource: null,
          preformattedSourceSha256: null,
          selectedCandidateSha256: null,
          selectedCropSha256: null,
        },
      ]),
    )
    expect(changed.visualRelationshipGraphSha256).not.toBe(
      receipt.visualRelationshipGraphSha256,
    )
    expect(canonicalJsonHash(changed)).not.toBe(canonicalJsonHash(receipt))
  })

  it('binds proved preformatted source order and whitespace without exposing source text', () => {
    const sourceLine = {
      text: 'Context: {context}',
      sourceRegionId: 'code-region-private-1',
      sourceLineId: 'code-line-private-1',
      sourceBox: sourceBox(),
      sourceRunBoxes: [sourceBox()],
    }
    const relationship = {
      id: 'code-relationship-1',
      kind: 'figure',
      semanticKind: 'code',
      status: 'matched',
      preformatted: {
        status: 'proved',
        lines: [sourceLine],
        evidence: [
          'exact-single-source-run-per-line',
          'deterministic-page-y-order',
        ],
      },
    }
    const reconstruction = {
      paper: { id: 'paper-1', nodes: [] },
      visualRelationships: [relationship],
    }
    const receipt = createPdfStructuralReceipt(reconstruction)
    const textChanged = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        {
          ...relationship,
          preformatted: {
            ...relationship.preformatted,
            lines: [{ ...sourceLine, text: 'Context:{context}' }],
          },
        },
      ],
    })
    const orderChanged = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        {
          ...relationship,
          preformatted: {
            ...relationship.preformatted,
            lines: [
              sourceLine,
              {
                ...sourceLine,
                text: 'Question: {question}',
                sourceLineId: 'code-line-private-2',
              },
            ].reverse(),
          },
        },
      ],
    })
    const unresolved = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        {
          ...relationship,
          preformatted: {
            ...relationship.preformatted,
            status: 'unresolved',
          },
        },
      ],
    })

    expect(textChanged.visualRelationshipGraphSha256).not.toBe(
      receipt.visualRelationshipGraphSha256,
    )
    expect(orderChanged.visualRelationshipGraphSha256).not.toBe(
      receipt.visualRelationshipGraphSha256,
    )
    expect(unresolved.visualRelationshipGraphSha256).not.toBe(
      receipt.visualRelationshipGraphSha256,
    )
    expect(JSON.stringify(receipt)).not.toContain(sourceLine.text)
    expect(JSON.stringify(receipt)).not.toContain(sourceLine.sourceLineId)
    expect(JSON.stringify(receipt)).not.toContain(sourceLine.sourceRegionId)
  })

  it('binds canonical note-anchor offsets and owning node identity into the note graph hash', () => {
    const noteReference = {
      id: 'note-reference-private-1',
      label: '1',
      target: 'note-private-1',
      start: 4,
      end: 5,
      confidence: 1,
    }
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [
          {
            id: 'paragraph-private-1',
            type: 'paragraph',
            text: 'Body1',
            noteReferences: [noteReference],
          },
          {
            id: 'paragraph-private-2',
            type: 'paragraph',
            text: 'Other',
          },
        ],
      },
      noteRelationships: [
        {
          id: noteReference.id,
          status: 'matched',
          referenceRegionId: 'region-private-1',
          targetNoteId: noteReference.target,
          label: noteReference.label,
          canonicalAnchor: {
            kind: 'node',
            nodeId: 'paragraph-private-1',
            start: noteReference.start,
            end: noteReference.end,
          },
          sourceBoxes: [sourceBox()],
        },
      ],
    }
    const baseline = createPdfStructuralReceipt(reconstruction)
    const offsetChanged = createPdfStructuralReceipt({
      ...reconstruction,
      noteRelationships: reconstruction.noteRelationships.map(
        (relationship) => ({
          ...relationship,
          canonicalAnchor: {
            ...relationship.canonicalAnchor,
            start: 3,
            end: 4,
          },
        }),
      ),
    })
    const ownerChanged = createPdfStructuralReceipt({
      ...reconstruction,
      noteRelationships: reconstruction.noteRelationships.map(
        (relationship) => ({
          ...relationship,
          canonicalAnchor: {
            ...relationship.canonicalAnchor,
            nodeId: 'paragraph-private-2',
          },
        }),
      ),
    })

    for (const changed of [offsetChanged, ownerChanged]) {
      expect(changed.noteRelationshipGraphSha256).not.toBe(
        baseline.noteRelationshipGraphSha256,
      )
      expect(canonicalJsonHash(changed)).not.toBe(canonicalJsonHash(baseline))
    }
    expect(JSON.stringify(baseline)).not.toContain('paragraph-private-1')
    expect(JSON.stringify(baseline)).not.toContain('note-reference-private-1')
  })

  it('binds canonical node provenance without disclosing its private identities', () => {
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [{ id: 'node-private-1', type: 'paragraph', text: 'Body' }],
      },
      provenance: {
        'node-private-1': {
          confidence: 1,
          pages: [1],
          regionIds: ['region-private-1'],
          boxes: [sourceBox()],
          links: [],
          relationshipIds: ['relationship-private-1'],
        },
      },
    }
    const baseline = createPdfStructuralReceipt(reconstruction)
    const changed = createPdfStructuralReceipt({
      ...reconstruction,
      provenance: {
        'node-private-1': {
          ...reconstruction.provenance['node-private-1'],
          regionIds: ['region-private-2'],
        },
      },
    })

    expect(baseline.canonicalNodeProvenanceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(changed.canonicalNodeProvenanceSha256).not.toBe(
      baseline.canonicalNodeProvenanceSha256,
    )
    expect(canonicalJsonHash(changed)).not.toBe(canonicalJsonHash(baseline))
    expect(JSON.stringify(baseline)).not.toContain('region-private-1')
    expect(JSON.stringify(baseline)).not.toContain('relationship-private-1')
  })

  it('normalizes only the volatile PDF.js document counter in provenance font names', () => {
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [{ id: 'node-private-1', type: 'paragraph', text: 'Body' }],
      },
      provenance: {
        'node-private-1': {
          confidence: 1,
          pages: [1],
          regionIds: ['region-private-1'],
          boxes: [sourceBox({ fontName: 'g_d0_f17' })],
          links: [],
        },
      },
    }
    const baseline = createPdfStructuralReceipt(reconstruction)
    const differentDocumentCounter = createPdfStructuralReceipt({
      ...reconstruction,
      provenance: {
        'node-private-1': {
          ...reconstruction.provenance['node-private-1'],
          boxes: [sourceBox({ fontName: 'g_d42_f17' })],
        },
      },
    })
    const differentFont = createPdfStructuralReceipt({
      ...reconstruction,
      provenance: {
        'node-private-1': {
          ...reconstruction.provenance['node-private-1'],
          boxes: [sourceBox({ fontName: 'g_d42_f18' })],
        },
      },
    })

    expect(differentDocumentCounter.canonicalNodeProvenanceSha256).toBe(
      baseline.canonicalNodeProvenanceSha256,
    )
    expect(differentFont.canonicalNodeProvenanceSha256).not.toBe(
      baseline.canonicalNodeProvenanceSha256,
    )
  })

  it('excludes the page-global operator ledger digest from local node provenance identity', () => {
    const sourceTextPaint = {
      algorithm: 'pdfjs-text-paint-run-v1',
      textLedgerSha256: 'a'.repeat(64),
      normalizedTextStart: 0,
      normalizedTextEnd: 4,
      operatorLedgerSha256: 'b'.repeat(64),
      operationIndexes: [7],
      filterableOperationIndexes: [7],
    }
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [{ id: 'node-private-1', type: 'paragraph', text: 'Body' }],
      },
      provenance: {
        'node-private-1': {
          confidence: 1,
          pages: [1],
          regionIds: ['region-private-1'],
          boxes: [sourceBox({ sourceTextPaint })],
          links: [],
        },
      },
    }
    const baseline = createPdfStructuralReceipt(reconstruction)
    const differentPageLedger = createPdfStructuralReceipt({
      ...reconstruction,
      provenance: {
        'node-private-1': {
          ...reconstruction.provenance['node-private-1'],
          boxes: [
            sourceBox({
              sourceTextPaint: {
                ...sourceTextPaint,
                operatorLedgerSha256: 'c'.repeat(64),
              },
            }),
          ],
        },
      },
    })
    const differentLocalOperation = createPdfStructuralReceipt({
      ...reconstruction,
      provenance: {
        'node-private-1': {
          ...reconstruction.provenance['node-private-1'],
          boxes: [
            sourceBox({
              sourceTextPaint: {
                ...sourceTextPaint,
                operationIndexes: [8],
                filterableOperationIndexes: [8],
              },
            }),
          ],
        },
      },
    })

    expect(differentPageLedger.canonicalNodeProvenanceSha256).toBe(
      baseline.canonicalNodeProvenanceSha256,
    )
    expect(differentLocalOperation.canonicalNodeProvenanceSha256).not.toBe(
      baseline.canonicalNodeProvenanceSha256,
    )
  })

  it('binds visual caption-node, selected candidate, and selected crop identities into the visual graph hash', () => {
    const crop = sourceBox({
      x: 0.2,
      y: 0.3,
      width: 0.4,
      height: 0.2,
      method: 'pdf-object',
    })
    const candidate = {
      sourceRegionIds: ['visual-region-private-1'],
      sourceObjectIds: ['visual-object-private-1'],
      assetIds: ['visual-asset-private-1'],
      score: 1,
      evidence: ['source-page-crop'],
      sourceBoxes: [crop],
    }
    const relationship = {
      id: 'visual-relationship-private-1',
      kind: 'figure',
      status: 'matched',
      canonicalNodeId: 'figure-node-private-1',
      captionNodeId: 'caption-node-private-1',
      captionRegionId: 'caption-region-private-1',
      sourceRegionIds: candidate.sourceRegionIds,
      sourceObjectIds: candidate.sourceObjectIds,
      assetIds: candidate.assetIds,
      sourceBoxes: [sourceBox(), crop],
      altTextSource: 'caption',
      candidates: [candidate],
    }
    const asset = {
      id: 'visual-asset-private-1',
      kind: 'raster',
      mediaType: 'image/png',
      rendition: 'source-page-crop',
      sha256: 'a'.repeat(64),
      sourceBoxes: [crop],
      sourceCropBox: crop,
      sourceCropAttempts: [
        {
          schemaVersion: '1.0.0',
          sequence: 1,
          request: {
            kind: 'figure',
            page: crop.page,
            sourceBox: crop,
            sourceObjectIds: ['visual-object-private-1'],
            sourceBoxes: [crop],
          },
          outcome: {
            status: 'accepted',
            assetId: 'visual-asset-private-1',
            assetSha256: 'a'.repeat(64),
          },
        },
      ],
      sourceExclusionMask: {
        algorithm: 'nearest-source-box-v1',
        expansionPixels: 2,
        ownedSourceBoxes: [
          sourceBox({
            x: 0.3,
            y: 0.35,
            width: 0.1,
            height: 0.05,
          }),
        ],
        excludedSourceBoxes: [
          sourceBox({
            x: 0.3,
            y: 0.295,
            width: 0.1,
            height: 0.004,
          }),
        ],
      },
    }
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [
          { id: 'caption-node-private-1', type: 'caption', text: 'Figure 1' },
          { id: 'caption-node-private-2', type: 'caption', text: 'Figure 2' },
          { id: 'figure-node-private-1', type: 'figure', title: 'Figure 1' },
        ],
      },
      visualRelationships: [relationship],
      assets: [asset],
    }
    const baseline = createPdfStructuralReceipt(reconstruction)
    const captionChanged = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        { ...relationship, captionNodeId: 'caption-node-private-2' },
      ],
    })
    const candidateChanged = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        {
          ...relationship,
          candidates: [
            {
              ...candidate,
              sourceObjectIds: ['visual-object-private-2'],
            },
          ],
        },
      ],
    })
    const cropChanged = createPdfStructuralReceipt({
      ...reconstruction,
      assets: [
        {
          ...asset,
          sourceCropBox: { ...crop, x: 0.21 },
        },
      ],
    })
    const maskChanged = createPdfStructuralReceipt({
      ...reconstruction,
      assets: [
        {
          ...asset,
          sourceExclusionMask: {
            ...asset.sourceExclusionMask,
            excludedSourceBoxes:
              asset.sourceExclusionMask.excludedSourceBoxes.map((box) => ({
                ...box,
                x: box.x + 0.001,
              })),
          },
        },
      ],
    })
    const attemptChanged = createPdfStructuralReceipt({
      ...reconstruction,
      assets: [
        {
          ...asset,
          sourceCropAttempts: asset.sourceCropAttempts.map((attempt) => ({
            ...attempt,
            request: {
              ...attempt.request,
              sourceBox: { ...attempt.request.sourceBox, x: 0.21 },
            },
          })),
        },
      ],
    })

    for (const changed of [
      captionChanged,
      candidateChanged,
      cropChanged,
      maskChanged,
      attemptChanged,
    ]) {
      expect(changed.visualRelationshipGraphSha256).not.toBe(
        baseline.visualRelationshipGraphSha256,
      )
      if (changed === maskChanged || changed === attemptChanged) {
        expect(changed.assetManifestSha256).not.toBe(
          baseline.assetManifestSha256,
        )
      }
      expect(canonicalJsonHash(changed)).not.toBe(canonicalJsonHash(baseline))
    }
    expect(JSON.stringify(baseline)).not.toContain('caption-node-private-1')
    expect(JSON.stringify(baseline)).not.toContain('visual-object-private-1')
  })

  it('redacts document text from successful diagnostic messages', () => {
    const privateMarker = 'private reconstructed paragraph'

    expect(
      safeAuditDiagnostic({
        code: 'LOW_CONFIDENCE_BLOCK',
        severity: 'warning',
        page: 3,
        message: `p-001-${privateMarker} needs reading-order review.`,
      }),
    ).toEqual({
      code: 'LOW_CONFIDENCE_BLOCK',
      severity: 'warning',
      page: 3,
      message: 'A reconstructed block requires reading-order review.',
    })
    expect(
      JSON.stringify(
        safeAuditDiagnostic({
          code: 'FUTURE_DIAGNOSTIC',
          severity: 'warning',
          message: privateMarker,
        }),
      ),
    ).not.toContain(privateMarker)
    expect(
      safeAuditDiagnostic({
        code: 'SOURCE_ORDER_FLOAT_FALLBACK',
        severity: 'info',
        page: 4,
        message: privateMarker,
      }),
    ).toEqual({
      code: 'SOURCE_ORDER_FLOAT_FALLBACK',
      severity: 'info',
      page: 4,
      message:
        'An optional float move was skipped to preserve source-proved order.',
    })
  })

  it('counts every diagnostic while emitting only bounded deterministic samples', () => {
    const diagnostics = Array.from({ length: 100 }, (_, index) => ({
      code: index < 90 ? 'UNREFERENCED_VISUAL_ASSET' : 'AMBIGUOUS_VISUAL_MATCH',
      severity: 'warning',
      page: (index % 12) + 1,
      message: `private diagnostic ${index}`,
    }))
    const reversed = summarizeAuditDiagnostics([...diagnostics].reverse())
    const summary = summarizeAuditDiagnostics(diagnostics)

    expect(summary).toEqual(reversed)
    expect(summary.diagnosticCounts).toEqual({
      AMBIGUOUS_VISUAL_MATCH: 10,
      UNREFERENCED_VISUAL_ASSET: 90,
    })
    expect(summary.diagnosticSampleLimit).toEqual({ total: 64, perCode: 3 })
    expect(summary.diagnostics).toHaveLength(6)
    expect(summary.diagnosticSamplesTruncated).toBe(94)
    expect(JSON.stringify(summary)).not.toContain('private diagnostic')
  })

  it('reports only stable document identifiers and quality results', async () => {
    const result = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        'tests/fixtures/pdf/born-digital.pdf',
        'tests/fixtures/pdf/structured-scientific.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )

    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    const schemas = await Promise.all(
      [
        'docs/schemas/pdf-corpus-audit.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.6.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.7.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.8.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.9.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.10.schema.json',
      ].map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
    )
    const ajv = new Ajv2020({ strict: false })
    for (const schema of schemas) ajv.addSchema(schema)
    const reportValidator = ajv.getSchema(
      'https://ernie.sg/schemas/pdf-corpus-audit-1.10.0.json',
    )
    expect(reportValidator(report), reportValidator.errors).toBe(true)
    expect(report).toMatchObject({
      schemaVersion: '1.10.0',
      reportSchema: 'docs/schemas/pdf-corpus-audit-v1.10.schema.json',
      privacy: 'basenames-hashes-metrics-diagnostics-only',
      executionProvenance: {
        schemaVersion: '1.1.0',
        implementation: {
          gitCommit: expect.stringMatching(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        },
        tool: { id: 'pdf-corpus-audit' },
        toolchain: {
          packageLockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          pdfjsDist: {
            declaredVersion: '5.4.624',
            lockedVersion: '5.4.624',
            resolvedVersion: '5.4.624',
            resolvedPackageJsonSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            resolvedPackageContentsSha256:
              expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        verification: {
          method: 'before-after-exact-match-v1',
          stateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      summary: {
        documents: 2,
        ready: 2,
        reviewRequired: 0,
        failed: 0,
        passRate: 1,
        failureReasons: {},
      },
    })
    expect(report.executionProvenance.implementation.exactHead).toBe(
      report.executionProvenance.implementation.worktreeState === 'clean',
    )
    expect(report.documents.map((document) => document.basename)).toEqual([
      'born-digital.pdf',
      'structured-scientific.pdf',
    ])
    expect(report.documents.every((document) => document.sha256)).toBe(true)
    expect(
      report.documents.every(
        (document) =>
          Number.isInteger(document.diagnosticSamplesTruncated) &&
          document.diagnosticSamplesTruncated >= 0 &&
          document.diagnosticSampleLimit.total === 64 &&
          document.diagnosticSampleLimit.perCode === 3 &&
          document.diagnostics.length + document.diagnosticSamplesTruncated ===
            Object.values(document.diagnosticCounts).reduce(
              (total, count) => total + count,
              0,
            ),
      ),
    ).toBe(true)
    expect(
      report.documents.every(
        (document) =>
          document.structure?.schemaVersion === '1.7.0' &&
          document.structure.canonicalHyphenDeletionLedgerAvailable === true &&
          document.structure.canonicalHyphenDeletionCount ===
            document.structure.canonicalHyphenDeletionLedger.length &&
          document.structure.canonicalHyphenDeletionLedgerSha256 ===
            canonicalJsonHash(
              document.structure.canonicalHyphenDeletionLedger,
            ) &&
          document.structure.canonicalNodeCount > 0 &&
          /^[a-f0-9]{64}$/.test(
            document.structure.canonicalNodeSequenceSha256,
          ) &&
          /^[a-f0-9]{64}$/.test(document.structure.canonicalContentSha256) &&
          /^[a-f0-9]{64}$/.test(
            document.structure.visualRelationshipGraphSha256,
          ) &&
          /^[a-f0-9]{64}$/.test(document.structure.assetManifestSha256) &&
          document.structure.unresolvedCorruptingJoinCount +
            document.structure.structurallyConsumedLineBoundaryCount <=
            document.structure.lineTransitionCount,
      ),
    ).toBe(true)
    expect(result.stdout).not.toContain(resolve('.'))
    expect(result.stdout).not.toContain(
      'Synthetic semantic completeness fixture',
    )
  }, 15_000)

  it('requires a complete corpus-contract option pair and rejects a substituted set before audit', () => {
    const missingSet = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        '--corpus-contract',
        'benchmarks/pdf/corpus-contract-v1.json',
        'tests/fixtures/pdf/born-digital.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )
    const substituted = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        '--corpus-contract',
        'benchmarks/pdf/corpus-contract-v1.json',
        '--corpus-set',
        'frozen',
        'tests/fixtures/pdf/born-digital.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )

    expect(missingSet.status).toBe(2)
    expect(missingSet.stderr).toContain('--corpus-contract')
    expect(substituted.status).toBe(2)
    expect(substituted.stderr).toBe('PDF corpus contract binding failed.\n')
    expect(substituted.stdout).toBe('')
  })

  it('redacts parser failures and supplies PDF.js standard-font assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-corpus-private-'))
    const path = join(directory, 'private-corrupt.pdf')
    const privateMarker = 'private parser payload must never enter the report'
    try {
      await writeFile(path, `%PDF-1.7\n${privateMarker}\n`)
      const result = spawnSync(
        process.execPath,
        ['tools/pdf-corpus-audit.mjs', '--report-only', path],
        { encoding: 'utf8', timeout: 120_000 },
      )

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        summary: { documents: 1, ready: 0, reviewRequired: 0, failed: 1 },
        documents: [
          {
            basename: 'private-corrupt.pdf',
            sha256: null,
            code: 'PDF_PARSE_FAILED',
            message:
              'The PDF parser could not open the document; local path and document details were suppressed.',
          },
        ],
      })
      expect(result.stdout).not.toContain(directory)
      expect(result.stdout).not.toContain(privateMarker)
      expect(result.stderr).not.toContain('standardFontDataUrl')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it(
    'streams multiple opt-in private overlays outside the repository without widening the report',
    { timeout: 30_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pdf-corpus-overlays-'))
      try {
        const result = spawnSync(
          process.execPath,
          [
            'tools/pdf-corpus-audit.mjs',
            '--report-only',
            '--overlay-output',
            directory,
            'tests/fixtures/pdf/diagnostic-overlays.pdf',
            'tests/fixtures/pdf/born-digital.pdf',
          ],
          { encoding: 'utf8', timeout: 120_000 },
        )

        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({
          privacy: 'basenames-hashes-metrics-diagnostics-only',
          summary: { documents: 2, ready: 1, reviewRequired: 1 },
        })
        const artifacts = await readdir(directory)
        expect(artifacts).toHaveLength(2)
        const diagnosticArtifact = artifacts.find((artifact) =>
          artifact.startsWith('diagnostic-overlays-'),
        )
        expect(diagnosticArtifact).toMatch(
          /^diagnostic-overlays-[a-f0-9]{16}\.diagnostics\.html$/,
        )
        const html = await readFile(join(directory, diagnosticArtifact), 'utf8')
        expect(html).toContain('pdf-diagnostic-overlay__svg')
        expect(html).toContain('Candidate A · left column then right column')
        expect(result.stdout).not.toContain(directory)
        expect(result.stdout).not.toContain(
          'This deliberately wide source region',
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it('refuses corpus overlay output anywhere inside the repository', () => {
    const result = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        '--overlay-output',
        '.agent/evidence/private-corpus',
        'tests/fixtures/pdf/born-digital.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('outside the repository')
    expect(result.stderr).not.toContain(resolve('.'))
  })
})
