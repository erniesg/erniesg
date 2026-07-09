import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildCodexExecArgs, parseCodexJsonOutput } from './codex-cli.mjs'

describe('local Codex translation provider', () => {
  it('builds high-effort read-only codex exec args for structured JSON', () => {
    const args = buildCodexExecArgs({
      cwd: '/repo',
      schemaPath: '/tmp/schema.json',
      outputPath: '/tmp/output.json',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      search: true,
      model: 'gpt-5.5',
    })

    expect(args).toContain('--search')
    expect(args).toContain('exec')
    expect(args).toContain('--cd')
    expect(args).toContain('/repo')
    expect(args).toContain('--sandbox')
    expect(args).toContain('read-only')
    expect(args).toContain('--output-schema')
    expect(args).toContain('/tmp/schema.json')
    expect(args).toContain('--output-last-message')
    expect(args).toContain('/tmp/output.json')
    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.5')
    expect(args).toContain('model_reasoning_effort="high"')
    expect(args.at(-1)).toBe('-')
  })

  it('parses plain and fenced structured JSON from codex output', () => {
    expect(parseCodexJsonOutput('{"passed":true}')).toEqual({ passed: true })
    expect(
      parseCodexJsonOutput('```json\n{"translations":{"s0001":"你好"},"unresolvedResearch":[]}\n```'),
    ).toEqual({
      translations: { s0001: '你好' },
      unresolvedResearch: [],
    })
  })
})

describe('publish scripts', () => {
  it('uses local Codex for mutating publish while keeping content checks non-mutating', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

    expect(pkg.scripts['translate:codex-sync']).toContain(
      'TRANSLATION_PROVIDER=codex-cli',
    )
    expect(pkg.scripts['translate:codex-sync']).toContain(
      'CODEX_TRANSLATION_REASONING_EFFORT=high',
    )
    expect(pkg.scripts['translate:codex-review']).toContain(
      'TRANSLATION_PROVIDER=codex-cli',
    )
    expect(pkg.scripts['translate:codex-review']).toContain(
      '--refresh-review',
    )
    expect(pkg.scripts['content:publish']).toContain('translate:codex-sync')
    expect(pkg.scripts['content:publish']).toContain('translate:codex-review')
    expect(pkg.scripts['content:check']).not.toContain('translate:codex-sync')
    expect(pkg.scripts['content:check']).not.toContain('translate:sync -- --write')
  })
})
