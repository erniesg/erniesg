import fs from 'node:fs/promises'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codexChildEnvironment,
  inspectCodexHostConfig,
  runCodexStructuredJson,
  verifyCodexTrustedVm,
} from './codex-cli.mjs'

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
  it('removes credentials, publisher controls and capability overrides from child environment', () => {
    expect(
      codexChildEnvironment({
        PATH: '/usr/bin',
        HOME: '/home/ubuntu',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        TMPDIR: '/tmp',
        CODEX_HOME: '/home/ubuntu/.codex',
        OPENAI_API_KEY: 'test',
        SSH_AUTH_SOCK: '/tmp/socket',
        PUBLISHER_SECRET: 'test',
        CODEX_TRANSLATION_MODEL: 'override',
        CODEX_TRANSLATION_SEARCH: '1',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/ubuntu',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      TMPDIR: '/tmp',
      CODEX_HOME: '/home/ubuntu/.codex',
    })
  })

  it('accepts the known host MCP server, which is disabled in fixed command arguments', () => {
    expect(() =>
      inspectCodexHostConfig(
        'model = "configured-model"\n[mcp_servers.openaiDeveloperDocs]\nurl = "https://developers.openai.com/mcp"\n',
      ),
    ).not.toThrow()
  })

  it('accepts quoted project, plugin and agent metadata namespaces', () => {
    expect(() =>
      inspectCodexHostConfig(
        '[projects."/home/ubuntu/code/site"]\ntrust_level = "trusted"\n[plugins."name@marketplace"]\nenabled = true\n[agents."editor.worker"]\nconfig_file = "/home/ubuntu/agent.toml"\n',
      ),
    ).not.toThrow()
  })

  it.each([
    'sandbox_mode = "danger-full-access"',
    '[profiles.publisher]\nsandbox_mode = "workspace-write"',
    '[mcp_servers.other]\ncommand = "provider"',
    'mcp_servers = { other = { command = "provider" } }',
    '["mcp_servers".other]\ncommand = "provider"',
    '"mcp_servers" = {}',
    '["\\u006dcp_servers".other]\ncommand = "provider"',
    '"\\u0073andbox_mode" = "danger-full-access"',
    'description = """multiline"""',
  ])('rejects legacy or unsupported host configuration: %s', (config) => {
    expect(() => inspectCodexHostConfig(config)).toThrow(
      'Codex host configuration',
    )
  })
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
