import { describe, expect, it } from 'vitest'
import * as entry from './index'

describe('the Worker entry module', () => {
  // Local `wrangler dev` treats every named runtime export of `main` as an
  // entrypoint and refuses to start on anything that is not a handler, with
  // "Incorrect type for map entry '<name>'". Deployed Workers tolerated it,
  // which is how a constant export got in unnoticed.
  it('exports only its default handler', () => {
    expect(Object.keys(entry).sort()).toEqual(['default'])
    expect(typeof entry.default.fetch).toBe('function')
  })
})
