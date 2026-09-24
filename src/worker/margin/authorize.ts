import type { WorkerEnv } from '../env'
import {
  getPrincipal,
  type Principal,
  type PrincipalOptions,
} from '../principal'
import { allowlistRole, type AllowlistRole } from './identity'

/**
 * The write gate.
 *
 * Reading the book requires nothing and never reaches this module. Creating or
 * editing any annotation requires an allowlist row; applying a proposal
 * requires the admin row. Both answers come from the database keyed by
 * `(provider, issuer, subject)`, so neither depends on an email address or on
 * anything the caller can assert.
 *
 * Every failure mode here is closed. No principal is a 401; a principal with
 * no allowlist row is a 403; and a missing database binding is a 503 rather
 * than an accidental allow.
 */

export type AuthorizationEnv = Partial<Omit<WorkerEnv, 'ASSETS'>>

export type Authorized = {
  ok: true
  principal: Principal
  role: AllowlistRole
}

export type Unauthorized = {
  ok: false
  response: Response
}

export type Authorization = Authorized | Unauthorized

function deny(status: number, error: string): Unauthorized {
  return {
    ok: false,
    response: new Response(`${JSON.stringify({ error })}\n`, {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    }),
  }
}

async function authorize(
  request: Request,
  env: AuthorizationEnv,
  required: AllowlistRole,
  options: PrincipalOptions,
): Promise<Authorization> {
  const principal = await getPrincipal(request, env, options)
  if (!principal) return deny(401, 'authentication_required')

  const db = env.MARGIN_DB
  if (!db) return deny(503, 'allowlist_unavailable')

  let role: AllowlistRole | null = null
  try {
    role = await allowlistRole(db, principal)
  } catch {
    return deny(503, 'allowlist_unavailable')
  }
  if (!role) return deny(403, 'not_allowed')
  if (required === 'admin' && role !== 'admin') {
    return deny(403, 'admin_required')
  }

  return { ok: true, principal, role }
}

/** Any allowlist row may write. This is what 054's write routes call. */
export function requireWriter(
  request: Request,
  env: AuthorizationEnv,
  options: PrincipalOptions = {},
): Promise<Authorization> {
  return authorize(request, env, 'writer', options)
}

/** Only the bound admin may apply a proposal. */
export function requireAdmin(
  request: Request,
  env: AuthorizationEnv,
  options: PrincipalOptions = {},
): Promise<Authorization> {
  return authorize(request, env, 'admin', options)
}
