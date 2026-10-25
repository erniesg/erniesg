import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  annotationBundleSchema,
  legacyAnnotationBundleSchema,
  sourceAnnotationBundleSchema,
} from '../src/annotations/annotation-bundle'
import { publicationInlineRunSchema } from '../src/publication/schema'
import { principalSchema } from '../src/worker/principal'
import {
  loginStateSchema,
  marginSessionSchema,
} from '../src/worker/margin/session'
import { progressBodySchema } from '../src/worker/margin/progress'
import { semanticTextAnchorSchema } from '../packages/margin/src/anchor'

const schemas = {
  principalSchema,
  marginSessionSchema,
  loginStateSchema,
  progressBodySchema,
  semanticTextAnchorSchema,
  // Main's captured annotation contract is the real production legacy branch.
  annotationBundleSchema: legacyAnnotationBundleSchema,
  publicationInlineRunSchema,
}
const baselineBytes = readFileSync(
  new URL(
    './fixtures/zod4/main-zod3-compatibility-baseline.json',
    import.meta.url,
  ),
)
const baseline = JSON.parse(baselineBytes.toString('utf8')) as {
  sourceHead: string
  zodVersion: string
  vectors: Array<{
    id: string
    schema: keyof typeof schemas
    input: unknown
    expected: { success: false } | { success: true; data: unknown }
  }>
}

function normalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true }
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          normalize((value as Record<string, unknown>)[key]),
        ]),
    )
  }
  return value
}

describe('main-era production schema branches on Zod 4', () => {
  it('retains the actual pre-upgrade main corpus, not the later Struct formats', () => {
    expect(createHash('sha256').update(baselineBytes).digest('hex')).toBe(
      '614d6038bb03283a3d52c85cfb2caa9b67d0241ab74d771d0ddf2db7c46e7fe8',
    )
    expect(baseline.sourceHead).toBe('5f8c76ab56bb66730802d5bcd7ec5568e51585af')
    expect(baseline.zodVersion).toBe('3.25.76')
    expect(baseline.vectors).toHaveLength(78)
  })

  it.each(baseline.vectors)('preserves $id', (vector) => {
    const result = schemas[vector.schema].safeParse(vector.input)
    expect(result.success).toBe(vector.expected.success)
    if (result.success && vector.expected.success) {
      expect(normalize(result.data)).toEqual(vector.expected.data)
    }
  })

  it('preserves omitted versus present-undefined optional fields', () => {
    const anchor = {
      nodeId: 'block-1',
      position: { start: 0, end: 5 },
      quote: { exact: 'hello', prefix: '', suffix: '' },
    }
    const cases = [
      {
        schema: principalSchema,
        input: { provider: 'test', issuer: 'urn:test', subject: 'user' },
        key: 'email',
      },
      {
        schema: marginSessionSchema,
        input: { accessToken: 'token', expiresAt: 1800000000 },
        key: 'refreshToken',
      },
      { schema: semanticTextAnchorSchema, input: anchor, key: 'positionUnit' },
      {
        schema: publicationInlineRunSchema,
        input: { start: 0, end: 5 },
        key: 'bold',
      },
    ]
    for (const { schema, input, key } of cases) {
      expect(normalize(schema.parse(input))).toEqual(input)
      expect(normalize(schema.parse({ ...input, [key]: undefined }))).toEqual({
        ...input,
        [key]: { $undefined: true },
      })
    }
    expect(progressBodySchema.parse({ solved: undefined })).toEqual({
      solved: [],
      solvedAt: {},
      drafts: {},
    })
    expect(
      loginStateSchema.safeParse({ state: 'opaque', returnTo: undefined })
        .success,
    ).toBe(false)
  })

  it('keeps legacy graph authority strict in both real production readers', () => {
    for (const schema of [
      legacyAnnotationBundleSchema,
      annotationBundleSchema,
    ]) {
      for (const version of ['1.0.0', '1.1.0']) {
        const bundle = {
          version,
          graphId: 'legacy-graph',
          anchors: [],
          annotations: [],
        }
        expect(schema.safeParse(bundle).success).toBe(true)
        expect(
          schema.safeParse({ ...bundle, graphId: undefined }).success,
        ).toBe(false)
        expect(
          schema.safeParse({ ...bundle, sourceId: undefined }).success,
        ).toBe(false)
      }
    }
    expect(
      legacyAnnotationBundleSchema.safeParse({
        version: '1.2.0',
        sourceId: 'newer-struct-format',
        anchors: [],
        annotations: [],
      }).success,
    ).toBe(false)
  })

  it('connects the captured legacy branch to the actual combined reader', () => {
    const annotations = baseline.vectors.filter(
      (vector) => vector.schema === 'annotationBundleSchema',
    )
    // Only the frozen valid source-authority case extends the old contract.
    // The other 1.2 case has a graphId and must still reject in both readers.
    const extension = annotations.filter(
      (vector) =>
        vector.id === 'annotationBundleSchema-10' &&
        (vector.input as { version?: string } | null)?.version === '1.2.0',
    )
    expect(extension.map((vector) => vector.id)).toEqual([
      'annotationBundleSchema-10',
    ])
    for (const vector of annotations) {
      const legacy = legacyAnnotationBundleSchema.safeParse(vector.input)
      const combined = annotationBundleSchema.safeParse(vector.input)
      if (vector === extension[0]) {
        expect(vector.expected.success).toBe(false)
        expect(legacy.success).toBe(false)
        expect(combined.success).toBe(true)
        const source = sourceAnnotationBundleSchema.parse(vector.input)
        if (combined.success) expect(combined.data).toEqual(source)
      } else {
        expect(combined.success, vector.id).toBe(legacy.success)
        if (combined.success && legacy.success) {
          expect(normalize(combined.data), vector.id).toEqual(
            normalize(legacy.data),
          )
        }
      }
    }
  })
})
