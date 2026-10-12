import fs from 'node:fs/promises'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCodexStructuredJson, verifyCodexTrustedVm } from './codex-cli.mjs'

const machineId = '0123456789abcdef0123456789abcdef'
const markerPath = '/etc/erniesg-translation-publisher.json'

function fixture({
  uid = 0,
  mode = 0o100644,
  regular = true,
  realpath = markerPath,
  marker = {
    machineId,
    trustedRunnerRoot: '/opt/erniesg-translation-publisher',
  },
  actualMachineId = machineId,
} = {}) {
  return {
    lstat: vi.fn(async () => ({ uid, mode, isFile: () => regular })),
    realpath: vi.fn(async () => realpath),
    readFile: vi.fn(async (file) =>
      file === markerPath ? JSON.stringify(marker) : `${actualMachineId}\n`,
    ),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('Codex provider trusted VM boundary', () => {
  it('accepts only a root-owned assertion matching the actual Linux machine', async () => {
    await expect(
      verifyCodexTrustedVm({ platform: 'linux', filesystem: fixture() }),
    ).resolves.toBeUndefined()
  })

  it.each([
    ['ordinary macOS host', { platform: 'darwin' }],
    ['missing assertion', { missing: true }],
    ['non-root ownership', { uid: 1000 }],
    ['group writable assertion', { mode: 0o100664 }],
    ['world writable assertion', { mode: 0o100646 }],
    ['non-regular assertion', { regular: false }],
    ['symlink or redirected assertion', { realpath: '/repo/assertion.json' }],
    [
      'different machine',
      { actualMachineId: 'abcdef0123456789abcdef0123456789' },
    ],
    ['invalid machine identity', { actualMachineId: '' }],
    [
      'altered runner root',
      { marker: { machineId, trustedRunnerRoot: '/tmp/runner' } },
    ],
    ['malformed assertion', { malformed: true }],
  ])('rejects %s', async (_label, settings) => {
    const filesystem = fixture(settings)
    if (settings.missing)
      filesystem.lstat.mockRejectedValue(new Error('ENOENT'))
    if (settings.malformed) filesystem.readFile.mockResolvedValue('{')
    await expect(
      verifyCodexTrustedVm({
        platform: settings.platform ?? 'linux',
        filesystem,
      }),
    ).rejects.toThrow('trusted VM')
  })

  it('rejects the real execution entry point before temp files or binary resolution', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    const temporaryDirectory = vi.spyOn(fs, 'mkdtemp')
    const binaryLookup = vi.spyOn(fs, 'access')
    const fileWrite = vi.spyOn(fs, 'writeFile')
    // No injected verifier or environment flag reaches this execution boundary.
    await expect(
      runCodexStructuredJson({
        systemPrompt: 'Return JSON.',
        userPayload: {},
        schema: { type: 'object' },
        providerConfig: { trustedVm: true },
      }),
    ).rejects.toThrow('npm run content:publish')
    expect(temporaryDirectory).not.toHaveBeenCalled()
    expect(binaryLookup).not.toHaveBeenCalled()
    expect(fileWrite).not.toHaveBeenCalled()
  })
})
