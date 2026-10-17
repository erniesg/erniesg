import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  adapterCases,
  loadAdapterCase,
} from './fixtures/struct-adapter-parity/cases'
import { observeAdapterCase } from './fixtures/struct-adapter-parity/observe'

const frozen = JSON.parse(
  await readFile(
    new URL('./fixtures/struct-adapter-parity/expected.json', import.meta.url),
    'utf8',
  ),
)

describe('frozen app reconstruction adapter parity at 74d483a', () => {
  it.each(adapterCases)('preserves the %s source and output', async (name) => {
    const observed = await observeAdapterCase(await loadAdapterCase(name))
    expect(observed).toEqual(frozen[name])
  })
})
