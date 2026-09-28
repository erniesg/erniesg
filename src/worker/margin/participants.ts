/**
 * How a thread names the people in it.
 *
 * Issue 058: each participant is shown by display name, never by email. margin
 * stores no profile name — identity is `(provider, issuer, subject)` and email
 * is kept only to bind the owner's admin row — so the display name is a stable
 * pseudonym derived from the principal key. The same reader gets the same name
 * on every annotation and every page, which is what a conversation needs, and
 * nothing about it is derived from, or can reveal, an address.
 *
 * FNV-1a rather than a digest from `crypto.subtle`: it has to be synchronous so
 * a response can be assembled in one pass, and it only needs to be stable and
 * well spread, not secret. The key it hashes is already on the wire as
 * `creator`.
 */

export const DISPLAY_NAME_PREFIX = 'Reader'

export function displayNameFor(creator: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < creator.length; index += 1) {
    hash ^= creator.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${DISPLAY_NAME_PREFIX} ${hash.toString(36).toUpperCase().padStart(7, '0').slice(-5)}`
}
