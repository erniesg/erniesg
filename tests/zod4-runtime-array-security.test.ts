import { createContext, runInContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

describe('bounded array parsing', () => {
  it('rejects an over-limit array before visiting its elements', () => {
    let visitedElements = 0
    const schema = z
      .array(
        z.string().refine(() => {
          visitedElements += 1
          return false
        }),
      )
      .max(1)

    expect(schema.safeParse(['first', 'second']).success).toBe(false)
    expect(visitedElements).toBe(0)
  })

  it('keeps the early rejection and strict parsing without eval support', () => {
    // Simulates a CSP/Worker no-eval constraint, not a deployed Worker.
    const bundle = buildSync({
      stdin: {
        contents: `
          import { z } from 'zod'
          export function exercise() {
            let visited = 0
            const schema = z.object({
              subject: z.string().min(1),
              items: z.array(z.unknown().superRefine(() => { visited++ })).max(1),
            }).strict()
            return {
              accepted: schema.safeParse({ subject: 'synthetic', items: [] }).success,
              rejected: !schema.safeParse({ subject: 'synthetic', items: [0, 1] }).success,
              unknownRejected: !schema.safeParse({ subject: 'synthetic', items: [], role: 'admin' }).success,
              visited,
            }
          }
        `,
        resolveDir: process.cwd(),
        sourcefile: 'synthetic-zod-no-eval.ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'ZodProbe',
      write: false,
    })
    const context = createContext({}, {
      codeGeneration: { strings: false, wasm: false },
    })
    runInContext(bundle.outputFiles[0].text, context)
    const result = runInContext('ZodProbe.exercise()', context)
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      accepted: true,
      rejected: true,
      unknownRejected: true,
      visited: 0,
    })
  })
})
