import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_REASONING_EFFORT = 'high'

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function resolveCodexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN
  const bundled = '/Users/erniesg/.codex/bin/codex'
  if (await pathExists(bundled)) return bundled
  return 'codex'
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
  sandbox = 'read-only',
  search = process.env.CODEX_TRANSLATION_SEARCH !== '0',
  model = process.env.CODEX_TRANSLATION_MODEL || process.env.CODEX_MODEL,
  serviceTier = process.env.CODEX_TRANSLATION_SERVICE_TIER,
} = {}) {
  if (!schemaPath) throw new Error('schemaPath is required for codex exec.')
  if (!outputPath) throw new Error('outputPath is required for codex exec.')

  const args = []
  if (search) args.push('--search')
  args.push(
    'exec',
    '--cd',
    cwd,
    '--sandbox',
    sandbox,
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
    'You are running as a local Codex translation worker.',
    'Do not edit files. Return only JSON matching the provided schema.',
    'Use repository context and web search only when needed to avoid guessing technical terms, names, publications, idioms, cultural references, or place names.',
    '',
    'Structured input:',
    JSON.stringify(userPayload, null, 2),
  ].join('\n')
}

async function runProcess({ bin, args, stdin, cwd }) {
  const child = spawn(bin, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
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

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
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
  cwd = process.cwd(),
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-translate-'))
  const schemaPath = path.join(tempDir, 'schema.json')
  const outputPath = path.join(tempDir, 'output.json')
  try {
    await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`)
    const args = buildCodexExecArgs({
      cwd,
      schemaPath,
      outputPath,
      reasoningEffort:
        providerConfig.reasoningEffort ??
        process.env.CODEX_TRANSLATION_REASONING_EFFORT ??
        DEFAULT_REASONING_EFFORT,
      sandbox: providerConfig.sandbox ?? 'read-only',
      search: providerConfig.search ?? process.env.CODEX_TRANSLATION_SEARCH !== '0',
      model:
        process.env.CODEX_TRANSLATION_MODEL ??
        process.env.CODEX_MODEL ??
        providerConfig.model,
      serviceTier:
        process.env.CODEX_TRANSLATION_SERVICE_TIER ??
        providerConfig.serviceTier,
    })
    await runProcess({
      bin: await resolveCodexBin(),
      args,
      stdin: composePrompt({ systemPrompt, userPayload }),
      cwd,
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
