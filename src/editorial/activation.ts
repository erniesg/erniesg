/**
 * The activation value the inactive writer and the inactive route adapter
 * refuse to work without.
 *
 * ## Why there is a value at all
 *
 * The inactive writer and the inactive route adapter are modules that exist
 * but are not wired into anything. "Not wired in" is a claim about the *tree*
 * — no route imports them, the Worker entry does not import them — and a tree
 * claim is only as strong as the next commit that adds an import. So the
 * modules carry a second, independent claim about *themselves*: they refuse
 * to act unless the caller hands them an activation value.
 *
 * The value is a phrase. It is **not** a configuration file, an environment
 * variable, a binding or a secret, because every one of those is a thing a
 * later commit could add without anybody thinking about it. It is a literal a
 * caller has to pass, and the only place in this repository that passes one is
 * this module's own test.
 *
 * The phrase is exported, so it is not a secret — it is a **claim of
 * authority**. What the phrase means is "the caller has read the design
 * record and has decided the cutover may happen". A caller that pastes the
 * literal without that decision has asserted something untrue, and the
 * inactivity evidence in `inactivity.test.ts` shows that no module in this
 * repository does it.
 *
 * ## What it is not
 *
 * It is not a kill switch and it is not a feature flag. A feature flag that
 * defaults to off is off until somebody turns it on, and the turn-on is a
 * configuration change in a file this repository does not own. An activation
 * value has to be *carried*, per call, by the caller: there is no ambient
 * state that a future commit could set once and forget.
 */

/**
 * The phrase that activates the inactive writer and route adapter.
 *
 * It is a constant so a test can assert that it appears in no file outside
 * `src/editorial/`, and so the modules compare against one literal instead
 * of a pattern.
 */
export const EDITORIAL_ACTIVATION_PHRASE = 'erniesg.editorial.activate.v1' as const

/**
 * An activation this module granted.
 *
 * It is a plain object with a literal `phrase`, so a caller cannot forge one
 * by casting: `isEditorialActivation` checks the literal, not the type.
 */
export type EditorialActivation = {
  readonly phrase: typeof EDITORIAL_ACTIVATION_PHRASE
  /** Who says the cutover may happen. Free text, for the record. */
  readonly grantedBy: string
}

/**
 * Grant an activation, if the phrase is the right one.
 *
 * `null` when it is not. A refusal, not a fallback: a caller that holds the
 * wrong phrase has no activation, and a module that holds no activation does
 * nothing.
 */
export function grantEditorialActivation(
  phrase: string,
  grantedBy: string,
): EditorialActivation | null {
  if (phrase !== EDITORIAL_ACTIVATION_PHRASE) return null
  return { phrase: EDITORIAL_ACTIVATION_PHRASE, grantedBy }
}

/** Whether a value is an activation this module granted. */
export function isEditorialActivation(
  value: unknown,
): value is EditorialActivation {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { phrase?: unknown; grantedBy?: unknown }
  return (
    candidate.phrase === EDITORIAL_ACTIVATION_PHRASE &&
    typeof candidate.grantedBy === 'string' &&
    candidate.grantedBy.length > 0
  )
}

/**
 * The message an inactive module gives when it has no activation.
 *
 * The **code** belongs to the module that refuses: the writer says
 * `editorial_writer_inactive` and the route adapter says
 * `editorial_route_inactive`, so a caller can tell which one it reached.
 * The message is shared, so the two refuse identically.
 */
export const EDITORIAL_INACTIVE_MESSAGE =
  'the editorial writer and route adapter are inactive: this repository sets no activation value, so nothing they publish or serve is authorised' as const
