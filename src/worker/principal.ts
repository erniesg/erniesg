import { z } from 'zod'
import type { WorkerEnv } from './env'

/**
 * The single place any route learns who the caller is.
 *
 * Today this is a development stub: it is inert unless `MARGIN_DEV_PRINCIPAL`
 * is set, and when it is set any caller may claim any identity. That is
 * deliberate and temporary — issue 055 replaces this implementation with a
 * validated WorkOS AuthKit session and nothing else in the tree has to change.
 * No route reads it yet.
 */

/** Identity is `(provider, issuer, subject)`. Email is profile data only. */
export const principalSchema = z
  .object({
    provider: z.string().min(1),
    issuer: z.string().min(1),
    subject: z.string().min(1),
    email: z.string().min(1).optional(),
  })
  .strict()

export type Principal = z.infer<typeof principalSchema>

/** Header a caller uses to claim an identity while the stub is enabled. */
export const DEV_PRINCIPAL_HEADER = 'x-margin-dev-principal'

const DEV_PRINCIPAL_PROVIDER = 'dev'
const DEV_PRINCIPAL_ISSUER = 'urn:margin:dev'

function parseDevPrincipal(value: string): Principal | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const candidate = trimmed.startsWith('{')
    ? (() => {
        try {
          return JSON.parse(trimmed) as unknown
        } catch {
          return null
        }
      })()
    : {
        provider: DEV_PRINCIPAL_PROVIDER,
        issuer: DEV_PRINCIPAL_ISSUER,
        subject: trimmed,
      }
  if (candidate === null) return null

  const result = principalSchema.safeParse(candidate)
  return result.success ? result.data : null
}

export type PrincipalEnv = Pick<WorkerEnv, 'MARGIN_DEV_PRINCIPAL'>

export async function getPrincipal(
  request: Request,
  env: PrincipalEnv = {},
): Promise<Principal | null> {
  const stub = env.MARGIN_DEV_PRINCIPAL
  if (!stub) return null
  return parseDevPrincipal(request.headers.get(DEV_PRINCIPAL_HEADER) ?? stub)
}
