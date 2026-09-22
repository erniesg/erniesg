import type { Principal } from '../principal'

/**
 * The stored form of an identity.
 *
 * `getPrincipal` owns who the caller is; this owns how that answer is written
 * down in a `creator` column and in a Web Annotation's `creator` IRI. Each
 * component is percent-encoded so the `:` separators stay unambiguous and two
 * different identities can never collapse into one key.
 */
export const PRINCIPAL_IRI_PREFIX = 'urn:margin:principal:'

export function principalKey(principal: Principal): string {
  const parts = [principal.provider, principal.issuer, principal.subject]
  return `${PRINCIPAL_IRI_PREFIX}${parts.map(encodeURIComponent).join(':')}`
}
