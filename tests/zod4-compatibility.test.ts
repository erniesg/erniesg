import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { annotationBundleSchema } from '../src/annotations/annotation-bundle'
import { publicationInlineRunSchema } from '../src/publication/schema'
import { principalSchema } from '../src/worker/principal'
import {
  loginStateSchema,
  marginSessionSchema,
} from '../src/worker/margin/session'
import { progressBodySchema } from '../src/worker/margin/progress'
import { semanticTextAnchorSchema } from '../packages/margin/src/anchor'
import { editorialActorSchema } from '../src/editorial/records'

type Baseline = {
  sourceHead: string
  zodVersion: string
  vectors: Array<{
    id: string
    schema: string
    input: unknown
    expected: { success: false } | { success: true; data: unknown }
  }>
}

const baselineBytes = readFileSync(
  new URL('./fixtures/zod4/zod3-compatibility-baseline.json', import.meta.url),
)
const baseline = JSON.parse(baselineBytes.toString('utf8')) as Baseline

const schemas = {
  principalSchema,
  marginSessionSchema,
  loginStateSchema,
  progressBodySchema,
  semanticTextAnchorSchema,
  annotationBundleSchema,
  publicationInlineRunSchema,
  editorialActorSchema,
}

function normalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true }
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

describe('Zod 4 compatibility', () => {
  it('preserves every captured Zod 3 schema decision and parsed value', () => {
    expect(createHash('sha256').update(baselineBytes).digest('hex')).toBe(
      '1a25bcdb7a033fed5bc384053f292b691d4128499dfced830679f0e281d4713f',
    )
    expect(baseline.vectors).toHaveLength(89)
    expect(baseline.sourceHead).toBe(
      'eda74c7f5605b5c190789092ef3d6fbcc174755f',
    )
    expect(baseline.zodVersion).toBe('3.25.76')

    for (const vector of baseline.vectors) {
      const schema = schemas[vector.schema as keyof typeof schemas]
      const result = schema.safeParse(vector.input)
      expect(result.success, vector.id).toBe(vector.expected.success)
      if (result.success && vector.expected.success) {
        expect(normalize(result.data), vector.id).toEqual(vector.expected.data)
      }
    }
  })

  it('preserves omitted and present-undefined optional/default fields', () => {
    const anchor = {
      nodeId: 'block-1',
      position: { start: 0, end: 5 },
      quote: { exact: 'hello', prefix: '', suffix: '' },
    }
    const cases = [
      {
        schema: principalSchema,
        omitted: { provider: 'test', issuer: 'urn:test', subject: 'user' },
        present: {
          provider: 'test',
          issuer: 'urn:test',
          subject: 'user',
          email: undefined,
        },
        expected: {
          omitted: { provider: 'test', issuer: 'urn:test', subject: 'user' },
          present: {
            provider: 'test',
            email: { $undefined: true },
            issuer: 'urn:test',
            subject: 'user',
          },
        },
      },
      {
        schema: marginSessionSchema,
        omitted: { accessToken: 'token', expiresAt: 1800000000 },
        present: {
          accessToken: 'token',
          expiresAt: 1800000000,
          refreshToken: undefined,
        },
        expected: {
          omitted: { accessToken: 'token', expiresAt: 1800000000 },
          present: {
            accessToken: 'token',
            expiresAt: 1800000000,
            refreshToken: { $undefined: true },
          },
        },
      },
      {
        schema: progressBodySchema,
        omitted: {},
        present: { solved: undefined },
        expected: {
          omitted: { drafts: {}, solved: [], solvedAt: {} },
          present: { drafts: {}, solved: [], solvedAt: {} },
        },
      },
      {
        schema: semanticTextAnchorSchema,
        omitted: anchor,
        present: { ...anchor, positionUnit: undefined },
        expected: {
          omitted: anchor,
          present: { ...anchor, positionUnit: { $undefined: true } },
        },
      },
      {
        schema: publicationInlineRunSchema,
        omitted: { start: 0, end: 5 },
        present: { start: 0, end: 5, bold: undefined },
        expected: {
          omitted: { start: 0, end: 5 },
          present: { start: 0, end: 5, bold: { $undefined: true } },
        },
      },
    ]

    for (const { schema, omitted, present, expected } of cases) {
      const omittedResult = schema.safeParse(omitted)
      const presentResult = schema.safeParse(present)
      expect(omittedResult.success).toBe(true)
      expect(presentResult.success).toBe(true)
      if (omittedResult.success && presentResult.success) {
        expect(normalize(omittedResult.data)).toEqual(expected.omitted)
        expect(normalize(presentResult.data)).toEqual(expected.present)
      }
    }
  })

  it('keeps required fields required when present with undefined', () => {
    expect(
      loginStateSchema.safeParse({ state: 'opaque' }).success,
    ).toBe(false)
    expect(
      loginStateSchema.safeParse({ state: 'opaque', returnTo: undefined })
        .success,
    ).toBe(false)

    const actor = { kind: 'producer', keyId: 'key', policyEpoch: 1 }
    expect(
      editorialActorSchema.safeParse({ kind: 'producer', keyId: 'key' })
        .success,
    ).toBe(false)
    expect(
      editorialActorSchema.safeParse({ ...actor, policyEpoch: undefined })
        .success,
    ).toBe(false)
  })

  it('preserves present-undefined optional fields in legacy annotations', () => {
    const omitted = {
      version: '1.0.0',
      graphId: 'legacy-graph',
      anchors: [],
      annotations: [],
    }
    const omittedResult = annotationBundleSchema.safeParse(omitted)
    const presentResult = annotationBundleSchema.safeParse({
      ...omitted,
      sourceId: undefined,
    })

    expect(omittedResult.success).toBe(true)
    expect(presentResult.success).toBe(true)
    if (omittedResult.success && presentResult.success) {
      expect(normalize(omittedResult.data)).toEqual(omitted)
      expect(normalize(presentResult.data)).toEqual({
        ...omitted,
        sourceId: { $undefined: true },
      })
    }
  })

  it('keeps annotation version authority and session shape strict', () => {
    expect(
      annotationBundleSchema.safeParse({
        version: '1.2.0',
        graphId: 'legacy-graph',
        anchors: [],
        annotations: [],
      }).success,
    ).toBe(false)
    expect(
      annotationBundleSchema.safeParse({
        version: '1.2.0',
        sourceId: 'struct-document-1',
        anchors: [],
        annotations: [],
      }).success,
    ).toBe(true)
    expect(
      marginSessionSchema.safeParse({
        accessToken: 'token',
        expiresAt: 1800000000,
        role: 'admin',
      }).success,
    ).toBe(false)
    expect(
      principalSchema.safeParse({
        provider: 'test',
        issuer: 'urn:test',
        subject: 'user',
        role: 'admin',
      }).success,
    ).toBe(false)
    expect(
      editorialActorSchema.safeParse({
        kind: 'producer',
        keyId: 'synthetic-key',
        policyEpoch: -1,
      }).success,
    ).toBe(false)
  })
})
