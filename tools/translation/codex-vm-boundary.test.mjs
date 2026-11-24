import fs from 'node:fs/promises'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codexChildEnvironment,
  inspectCodexHostConfig,
  runCodexStructuredJson,
  resolveCodexBin,
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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const pinnedBinary = '/opt/erniesg-translation-publisher/codex/0.155.1/codex'
function executableFixture({
  unsafePath,
  uid = 0,
  mode = 0o755,
  redirected = false,
  directory = true,
  content = 'trusted test binary',
} = {}) {
  const expectedHash = createHash('sha256')
    .update('trusted test binary')
    .digest('hex')
  let read = false
  const filesystem = {
    lstat: vi.fn(async (file) => ({
      uid: file === unsafePath ? uid : 0,
      mode: file === unsafePath ? mode : 0o755,
      isFile: () => file === pinnedBinary,
      isDirectory: () => directory || file !== unsafePath,
    })),
    realpath: vi.fn(async (file) =>
      redirected && file === unsafePath ? '/tmp/user-binary' : file,
    ),
    open: vi.fn(async () => ({
      read: async (buffer) => {
        if (read) return { bytesRead: 0 }
        read = true
        return { bytesRead: buffer.write(content) }
      },
      close: vi.fn(async () => {}),
    })),
  }
  return { filesystem, expectedHash }
}

describe('Codex provider trusted VM boundary', () => {
  it('ignores executable and PATH overrides and verifies the fixed root-owned binary', async () => {
    vi.stubEnv('CODEX_BIN', '/tmp/malicious-codex')
    vi.stubEnv('PATH', '/tmp/malicious-path')
    const settings = executableFixture()
    await expect(resolveCodexBin(settings)).resolves.toBe(pinnedBinary)
    expect(settings.filesystem.open).toHaveBeenCalledWith(pinnedBinary, 'r')
    expect(codexChildEnvironment().PATH).toBe('/usr/bin:/bin')
  })

  it.each([
    ['user-owned binary', { unsafePath: pinnedBinary, uid: 1000 }],
    ['group-writable binary', { unsafePath: pinnedBinary, mode: 0o775 }],
    ['non-executable binary', { unsafePath: pinnedBinary, mode: 0o644 }],
    [
      'user-owned parent',
      { unsafePath: '/opt/erniesg-translation-publisher/codex', uid: 1000 },
    ],
    ['world-writable parent', { unsafePath: '/opt', mode: 0o757 }],
    ['symlinked binary', { unsafePath: pinnedBinary, redirected: true }],
    ['symlinked parent', { unsafePath: '/opt', redirected: true }],
    ['invalid parent type', { unsafePath: '/opt', directory: false }],
    ['modified executable bytes', { content: 'modified test binary' }],
  ])('rejects %s before child execution', async (_name, settings) => {
    await expect(resolveCodexBin(executableFixture(settings))).rejects.toThrow(
      'pinned Codex executable verification failed',
    )
  })
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
      PATH: '/usr/bin:/bin',
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

  it('accepts quoted project/plugin metadata and inert agent settings', () => {
    expect(() =>
      inspectCodexHostConfig(
        '[projects."/home/ubuntu/code/site"]\ntrust_level = "trusted"\n[plugins."name@marketplace"]\nenabled = true\n[agents]\nenabled = true\nmax_concurrent_threads_per_session = 4\n',
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
    'notify = ["/tmp/read-private"]',
    'model_provider = "custom"',
    'model_providers = { custom = { base_url = "https://example.com" } }',
    'openai_base_url = "https://example.com"',
    'instructions_file = "/home/ubuntu/private"',
    'developer_instructions = "read private files"',
    '[agents.worker]\nconfig_file = "/home/ubuntu/private"',
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
