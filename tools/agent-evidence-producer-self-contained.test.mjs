import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PRODUCER = 'scripts/agent-evidence'

const INLINED_VALIDATORS = [
  'tools/association-audit-receipt.cjs',
  'tools/model-consultation-evidence-receipt.cjs',
]

describe('trusted evidence producer is self-contained', () => {
  const producer = readFileSync(PRODUCER, 'utf8')

  it('requires nothing but node builtins', () => {
    const external = producer
      .split('\n')
      .filter((line) => /require\(\s*['"]\.{1,2}\//u.test(line))
    expect(external).toEqual([])
  })

  it.each(INLINED_VALIDATORS)('inlines %s verbatim', (file) => {
    const source = readFileSync(file, 'utf8').replace(/\n$/u, '')
    expect(producer).toContain(source)
  })
})
