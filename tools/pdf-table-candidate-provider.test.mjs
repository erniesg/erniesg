import { describe, expect, it } from 'vitest'
import {
  createProcessTableCandidateProvider,
  DEFAULT_TABLE_CANDIDATE_PROVIDER,
  parseTableCandidateProviderConfiguration,
  resolveTableCandidateProviderConfiguration,
  TABLE_CANDIDATE_PROVIDER_CONTRACT_VERSION,
} from './pdf-table-candidate-provider.mjs'

const identity = (id, fill) => ({
  id,
  version: '1.0.0',
  sha256: fill.repeat(64),
})

function configuration() {
  return {
    provider: 'docling-tableformer',
    command: '/opt/docling-tableformer/run',
    args: ['--json-stdio'],
    version: '2.48.0',
    modelDigest: 'a'.repeat(64),
    adapter: identity('docling-tableformer-adapter', 'b'),
    runtime: identity('docling-python', 'c'),
    configuration: { mode: 'accurate', threads: 2 },
  }
}

describe('table candidate provider operator boundary', () => {
  it('keeps the browser/default operator path provider-free', () => {
    expect(DEFAULT_TABLE_CANDIDATE_PROVIDER).toBe('none')
    expect(
      resolveTableCandidateProviderConfiguration({}),
    ).toMatchObject({
      provider: 'none',
      available: true,
      configuration: null,
    })
  })

  it('requires an explicit opt-in and pinned configuration', () => {
    expect(
      resolveTableCandidateProviderConfiguration({
        provider: 'docling-tableformer',
      }),
    ).toMatchObject({
      available: false,
      diagnostic: { code: 'TABLE_CANDIDATE_OPT_IN_REQUIRED' },
    })
    expect(
      resolveTableCandidateProviderConfiguration({
        provider: 'docling-tableformer',
        optIn: true,
      }),
    ).toMatchObject({
      available: false,
      diagnostic: { code: 'TABLE_CANDIDATE_CONFIGURATION_REQUIRED' },
    })
    expect(parseTableCandidateProviderConfiguration(configuration())).toEqual(
      configuration(),
    )
  })

  it('rejects unpinned adapter/runtime identities and unsafe config shapes', () => {
    const invalid = configuration()
    invalid.runtime.sha256 = 'not-a-digest'
    expect(() => parseTableCandidateProviderConfiguration(invalid)).toThrow(
      /pinned SHA-256/u,
    )
    expect(() =>
      parseTableCandidateProviderConfiguration({
        ...configuration(),
        args: ['--json-stdio', 3],
      }),
    ).toThrow()
  })

  it('publishes a stable process-input contract version', () => {
    expect(TABLE_CANDIDATE_PROVIDER_CONTRACT_VERSION).toBe('1.0.0')
  })

  it('passes only bounded image bytes across the process boundary', async () => {
    const script = [
      "let input = ''",
      "process.stdin.on('data', (chunk) => { input += chunk })",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input)",
      "  if (!payload.image || payload.sourceText || payload.sourcePath) process.exit(9)",
      "  process.stdout.write('null')",
      '})',
    ].join(';')
    const provider = createProcessTableCandidateProvider({
      module: {
        createDoclingTableCandidateProvider: ({ infer, adapter, runtime }) => ({
          identity: {
            id: 'docling-tableformer',
            version: '2.48.0',
            modelDigest: 'a'.repeat(64),
            configurationHash: 'b'.repeat(64),
            adapter,
            runtime,
          },
          locality: 'local',
          propose: infer,
        }),
      },
      configuration: {
        ...configuration(),
        command: process.execPath,
        args: ['-e', script],
      },
    })
    await expect(
      provider.propose({
        image: Uint8Array.from([1, 2, 3]),
        mediaType: 'image/png',
        imageSha256: 'c'.repeat(64),
      }),
    ).resolves.toBeNull()
    expect(provider.identity.adapter).toEqual(configuration().adapter)
    expect(provider.identity.runtime).toEqual(configuration().runtime)
  })
})
