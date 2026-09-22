import { describe, expect, it } from 'vitest'
import {
  DEV_PRINCIPAL_HEADER,
  getPrincipal,
  principalSchema,
} from './principal'

const request = (headers: Record<string, string> = {}) =>
  new Request('https://ernie.sg/api/margin/v1/health', { headers })

describe('getPrincipal', () => {
  it('returns null with no stub configured', async () => {
    await expect(getPrincipal(request())).resolves.toBeNull()
    await expect(getPrincipal(request(), {})).resolves.toBeNull()
    await expect(
      getPrincipal(request({ [DEV_PRINCIPAL_HEADER]: 'reader' }), {}),
    ).resolves.toBeNull()
    await expect(
      getPrincipal(request(), { MARGIN_DEV_PRINCIPAL: '   ' }),
    ).resolves.toBeNull()
  })

  it('returns a principal when the stub env var is set', async () => {
    await expect(
      getPrincipal(request(), { MARGIN_DEV_PRINCIPAL: 'reader' }),
    ).resolves.toEqual({
      provider: 'dev',
      issuer: 'urn:margin:dev',
      subject: 'reader',
    })
  })

  it('accepts a full principal as JSON', async () => {
    await expect(
      getPrincipal(request(), {
        MARGIN_DEV_PRINCIPAL: JSON.stringify({
          provider: 'workos',
          issuer: 'https://api.workos.com',
          subject: 'user_123',
          email: 'hello@ernie.sg',
        }),
      }),
    ).resolves.toEqual({
      provider: 'workos',
      issuer: 'https://api.workos.com',
      subject: 'user_123',
      email: 'hello@ernie.sg',
    })
  })

  it('lets a caller claim an identity only while the stub is enabled', async () => {
    const claimed = request({ [DEV_PRINCIPAL_HEADER]: 'other-reader' })

    await expect(
      getPrincipal(claimed, { MARGIN_DEV_PRINCIPAL: 'reader' }),
    ).resolves.toMatchObject({ subject: 'other-reader' })
    await expect(getPrincipal(claimed)).resolves.toBeNull()
  })

  it('fails closed on a malformed claim rather than inventing an identity', async () => {
    for (const claim of ['{', '{}', '{"subject":""}', '   ']) {
      await expect(
        getPrincipal(request({ [DEV_PRINCIPAL_HEADER]: claim }), {
          MARGIN_DEV_PRINCIPAL: 'reader',
        }),
      ).resolves.toBeNull()
    }
  })

  it('keys identity on (provider, issuer, subject)', () => {
    expect(() =>
      principalSchema.parse({
        provider: 'workos',
        issuer: 'https://api.workos.com',
        subject: 'user_123',
        role: 'admin',
      }),
    ).toThrow()
  })
})
