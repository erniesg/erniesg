import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const DEFAULT_REASONING_EFFORT = 'high'
const TRUSTED_VM_MARKER = '/etc/erniesg-translation-publisher.json'
const TRUSTED_RUNNER_ROOT = '/opt/erniesg-translation-publisher'
const CODEX_EXECUTABLE =
  '/opt/erniesg-translation-publisher/codex/0.155.1/codex'
const CODEX_EXECUTABLE_SHA256 =
  '298d3d73d0bbc1367e58a370df5b6216fe30ce0a92e8b6b0afb0377a958dc335'
const DISABLED_TRANSLATION_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'code_mode_host',
  'browser_use',
  'computer_use',
  'multi_agent',
  'hooks',
  'skill_search',
  'view_image',
  'image_generation',
  'workspace_dependencies',
  'memories',
  'multi_agent_v2',
  'browser_use_external',
  'in_app_browser',
]

export function inspectCodexHostConfig(text) {
  const parseKey = (value) => {
    const keys = []
    let rest = value.trim()
    while (rest) {
      const match = rest.match(/^([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')/)
      if (!match) throw new Error('Unsupported Codex host configuration key.')
      const token = match[1]
      try {
        keys.push(
          token.startsWith('"')
            ? JSON.parse(token)
            : token.startsWith("'")
              ? token.slice(1, -1)
              : token,
        )
      } catch {
        throw new Error('Unsupported Codex host configuration key escape.')
      }
      rest = rest.slice(token.length).trim()
      if (!rest) break
      if (!rest.startsWith('.'))
        throw new Error('Unsupported Codex host configuration key.')
      rest = rest.slice(1).trim()
      if (!rest) throw new Error('Unsupported Codex host configuration key.')
    }
    return keys
  }
  const rootKeys = new Set([
    'approvals_reviewer',
    'model',
    'model_reasoning_effort',
  ])
  const allowedMetadata = {
    agents: new Set([
      'enabled',
      'interrupt_message',
      'max_concurrent_threads_per_session',
    ]),
    projects: new Set(['trust_level']),
    plugins: new Set(['enabled']),
    mcp_servers: new Set(['url', 'enabled']),
    features: new Set([
      ...DISABLED_TRANSLATION_FEATURES,
      'network_proxy',
      'prevent_idle_sleep',
    ]),
  }
  let section = []
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (/'''|"""/.test(trimmed)) {
      throw new Error(
        'Unsupported legacy or multiline Codex host configuration.',
      )
    }
    if (trimmed.startsWith('[')) {
      const header = trimmed.match(/^\[\[?(.+?)\]\]?\s*(?:#.*)?$/)
      if (!header)
        throw new Error('Unsupported Codex host configuration table.')
      const keys = parseKey(header[1])
      if (
        keys.includes('mcp_servers') &&
        (keys.length !== 2 ||
          keys[0] !== 'mcp_servers' ||
          keys[1] !== 'openaiDeveloperDocs')
      ) {
        throw new Error('Unsupported MCP server in Codex host configuration.')
      }
      if (
        !(keys[0] in allowedMetadata || keys[0] === 'tui') ||
        (['projects', 'plugins', 'mcp_servers'].includes(keys[0])
          ? keys.length !== 2
          : keys[0] === 'tui'
            ? keys.length !== 2 || keys[1] !== 'model_availability_nux'
            : keys.length !== 1)
      ) {
        throw new Error('Unsupported Codex host configuration table.')
      }
      section = keys
    } else {
      const assignment = trimmed.match(
        /^((?:[^="']|"(?:[^"\\]|\\.)*"|'[^']*')+)=/,
      )
      if (!assignment) {
        throw new Error('Unsupported Codex host configuration key.')
      }
      const keys = parseKey(assignment[1])
      if (
        keys.length !== 1 ||
        (section.length === 0
          ? !rootKeys.has(keys[0])
          : section[0] !== 'tui' &&
            !allowedMetadata[section[0]]?.has(keys[0])) ||
        [
          'notify',
          'hooks',
          'model_provider',
          'model_providers',
          'openai_base_url',
          'config_file',
          'sandbox_mode',
          'instructions',
          'developer_instructions',
          'instructions_file',
          'model_instructions_file',
        ].includes(keys[0]) ||
        !/^\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|true|false|[+-]?\d+(?:\.\d+)?)\s*(?:#.*)?$/.test(
          trimmed.slice(assignment[0].length),
        )
      ) {
        throw new Error('Unsupported Codex host configuration key or value.')
      }
    }
  }
}

export function codexChildEnvironment(environment = process.env) {
  const result = { PATH: '/usr/bin:/bin' }
  for (const key of ['HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME']) {
    if (typeof environment[key] === 'string') result[key] = environment[key]
  }
  return result
}

async function verifyCodexHostConfig() {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  try {
    inspectCodexHostConfig(
      await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'),
    )
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

// This assertion is provisioned by the VM administrator, outside repository
// control. Environment variables and checkout files cannot authorize a host.
export async function verifyCodexTrustedVm({
  platform = os.platform(),
  filesystem = fs,
} = {}) {
  const deny = (reason) => {
    throw new Error(
      `Codex translation requires the trusted VM (${reason}). Run npm run content:publish to use the trusted publisher.`,
    )
  }
  if (platform !== 'linux') deny('unsupported host')
  let marker
  let machineId
  try {
    const stat = await filesystem.lstat(TRUSTED_VM_MARKER)
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      deny('unsafe publisher assertion')
    }
    if ((await filesystem.realpath(TRUSTED_VM_MARKER)) !== TRUSTED_VM_MARKER) {
      deny('redirected publisher assertion')
    }
    marker = JSON.parse(await filesystem.readFile(TRUSTED_VM_MARKER, 'utf8'))
    machineId = (await filesystem.readFile('/etc/machine-id', 'utf8')).trim()
  } catch {
    deny('missing or invalid publisher assertion')
  }
  if (
    !/^[a-f0-9]{32}$/.test(machineId) ||
    marker?.machineId !== machineId ||
    marker?.trustedRunnerRoot !== TRUSTED_RUNNER_ROOT
  ) {
    deny('publisher assertion does not match this VM')
  }
}

export function isCodexUsageLimitError(error) {
  return /hit your usage limit/i.test(String(error?.message ?? error ?? ''))
}

export async function resolveCodexBin({
  filesystem = fs,
  expectedHash = CODEX_EXECUTABLE_SHA256,
} = {}) {
  const reject = () => {
    throw new Error('Trusted pinned Codex executable verification failed.')
  }
  try {
    let currentPath = CODEX_EXECUTABLE
    while (true) {
      const stat = await filesystem.lstat(currentPath)
      if (
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        (currentPath === CODEX_EXECUTABLE
          ? !stat.isFile() || (stat.mode & 0o100) === 0
          : !stat.isDirectory()) ||
        (await filesystem.realpath(currentPath)) !== currentPath
      )
        reject()
      if (currentPath === '/') break
      currentPath = path.dirname(currentPath)
    }
    const handle = await filesystem.open(CODEX_EXECUTABLE, 'r')
    const hash = createHash('sha256')
    try {
      const buffer = Buffer.alloc(1024 * 1024)
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
    if (hash.digest('hex') !== expectedHash) reject()
    return CODEX_EXECUTABLE
  } catch {
    reject()
  }
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

export function buildCodexExecArgs({
  cwd = process.cwd(),
  schemaPath,
  outputPath,
  reasoningEffort = process.env.CODEX_TRANSLATION_REASONING_EFFORT ??
    DEFAULT_REASONING_EFFORT,
  model = process.env.CODEX_TRANSLATION_MODEL,
  serviceTier = process.env.CODEX_TRANSLATION_SERVICE_TIER,
} = {}) {
  if (!schemaPath) throw new Error('schemaPath is required for codex exec.')
  if (!outputPath) throw new Error('outputPath is required for codex exec.')

  const filesystem = {
    ':minimal': 'read',
    ':workspace_roots': 'deny',
    '/home/ubuntu': 'deny',
    '/root': 'deny',
    '/tmp': 'deny',
    '/opt': 'deny',
    '/var': 'deny',
    '/proc': 'deny',
    '/etc/pdf2epub': 'deny',
    [os.homedir()]: 'deny',
  }
  const filesystemPolicy = `{ ${Object.entries(filesystem)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ')} }`
  const args = DISABLED_TRANSLATION_FEATURES.flatMap((feature) => [
    '--disable',
    feature,
  ])
  args.push(
    '-c',
    'default_permissions="erniesg-translation"',
    '-c',
    `permissions.erniesg-translation.filesystem=${filesystemPolicy}`,
    '-c',
    'permissions.erniesg-translation.network.enabled=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'approval_policy="never"',
    '-c',
    'mcp_servers.openaiDeveloperDocs.enabled=false',
    'exec',
    '--skip-git-repo-check',
    '--cd',
    cwd,
    '-c',
    `model_reasoning_effort=${tomlString(reasoningEffort)}`,
  )
  if (serviceTier) args.push('-c', `service_tier=${tomlString(serviceTier)}`)
  if (model) args.push('--model', model)
  args.push(
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    '--ephemeral',
    '-',
  )
  return args
}

export function parseCodexJsonOutput(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error('Codex returned empty structured output.')

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  try {
    return JSON.parse(candidate)
  } catch (firstError) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        // Fall through to the original parse error so callers see the raw issue.
      }
    }
    throw new Error(`Codex returned invalid JSON: ${firstError.message}`)
  }
}

function composePrompt({ systemPrompt, userPayload }) {
  return [
    systemPrompt,
    '',
    'You are running as a trusted VM Codex translation worker.',
    'Do not edit files. Return only JSON matching the provided schema.',
    'Use only the structured input below. Tools, repository access, and web search are disabled.',
    '',
    'Structured input:',
    JSON.stringify(userPayload, null, 2),
  ].join('\n')
}

async function runProcess({ bin, args, stdin, cwd }) {
  const child = spawn(bin, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: codexChildEnvironment(),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdin.end(stdin)

  const timeoutMs = Number.parseInt(
    process.env.CODEX_TRANSLATION_TIMEOUT_MS ?? '600000',
    10,
  )
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, timeoutMs)
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  clearTimeout(timeout)
  if (timedOut) {
    throw new Error(`codex exec timed out after ${timeoutMs}ms.`)
  }
  if (code !== 0) {
    throw new Error(
      [
        `codex exec failed with exit code ${code}.`,
        stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
        stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
  }
  return { stdout, stderr }
}

export async function runCodexStructuredJson({
  systemPrompt,
  userPayload,
  schema,
  providerConfig = {},
}) {
  await verifyCodexTrustedVm()
  await verifyCodexHostConfig()
  const codexBin = await resolveCodexBin()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-translate-'))
  const schemaPath = path.join(tempDir, 'schema.json')
  const outputPath = path.join(tempDir, 'output.json')
  try {
    await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`)
    const workerCwd = process.env.CODEX_TRANSLATION_WORKDIR ?? tempDir
    const args = buildCodexExecArgs({
      cwd: workerCwd,
      schemaPath,
      outputPath,
      reasoningEffort:
        providerConfig.reasoningEffort ??
        process.env.CODEX_TRANSLATION_REASONING_EFFORT ??
        DEFAULT_REASONING_EFFORT,
      model: process.env.CODEX_TRANSLATION_MODEL ?? providerConfig.model,
      serviceTier:
        process.env.CODEX_TRANSLATION_SERVICE_TIER ??
        providerConfig.serviceTier,
    })
    await runProcess({
      bin: codexBin,
      args,
      stdin: composePrompt({ systemPrompt, userPayload }),
      cwd: workerCwd,
    })
    const output = await fs.readFile(outputPath, 'utf8')
    return parseCodexJsonOutput(output)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

export async function createCodexStructuredTranslation({
  providerConfig,
  systemPrompt,
  segments,
  schema,
}) {
  return runCodexStructuredJson({
    providerConfig,
    systemPrompt,
    schema,
    userPayload: {
      segments: segments.map((segment) => ({
        id: segment.id,
        kind: segment.kind,
        sourceText: segment.sourceText,
      })),
    },
  })
}

export async function createCodexStructuredReview({
  providerConfig,
  systemPrompt,
  sourceText,
  targetText,
  schema,
}) {
  return runCodexStructuredJson({
    providerConfig,
    systemPrompt,
    schema,
    userPayload: {
      sourceText,
      targetText,
    },
  })
}
