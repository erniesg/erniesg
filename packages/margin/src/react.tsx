/**
 * The optional React wrapper, on its own entry point.
 *
 * It is `@erniesg/margin/react`, not part of the main entry, so that a host
 * without React never pulls React in. React is an optional peer dependency for
 * the same reason. The component owns no behaviour — it mounts the custom
 * element and hands it props.
 *
 * It creates the element imperatively rather than writing `<margin-rail>` in
 * JSX. Declaring a custom element in `JSX.IntrinsicElements` means augmenting
 * whichever JSX namespace the *host's* React types expose, and a published
 * package should not have an opinion about that.
 */
import { useEffect, useRef } from 'react'
import type { TextAnnotation } from './anchor.js'
import {
  defineMarginElements,
  MARGIN_RAIL_TAG,
  type MarginRailElement,
} from './element.js'
import type { MarginTransport } from './transport.js'
import { createHttpTransport } from './transport.js'

export type MarginRailProps = {
  documentUri: string
  /** Selector for the element holding the document's text. */
  textSelector?: string
  /** Where the margin service lives. Omit to run entirely client-side. */
  apiBase?: string
  transport?: MarginTransport
  annotations?: readonly TextAnnotation[]
  className?: string
}

export function MarginRail({
  documentUri,
  textSelector,
  apiBase,
  transport,
  annotations,
  className,
}: MarginRailProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const rail = useRef<MarginRailElement | null>(null)
  // Read by the effect that builds a replacement element, without being in its
  // dependencies: depending on them would recreate the whole rail every time a
  // caller passed a new transport object or a new array, which is the opposite
  // of what anybody wants.
  const latest = useRef({ transport, annotations })
  latest.current = { transport, annotations }

  useEffect(() => {
    const mount = host.current
    if (!mount) return
    defineMarginElements()
    const element = mount.ownerDocument.createElement(
      MARGIN_RAIL_TAG,
    ) as MarginRailElement
    element.setAttribute('document-uri', documentUri)
    if (textSelector) element.setAttribute('text-selector', textSelector)
    if (apiBase) element.setAttribute('api-base', apiBase)
    // Applied here as well as in the effects below, and before `append` so the
    // element has it by the time it connects. The effects do not rerun when only
    // the element is replaced — their own dependencies are unchanged — so a new
    // rail would otherwise silently lose the caller's transport and every later
    // highlight would stay client-only.
    if (latest.current.transport) element.transport = latest.current.transport
    if (latest.current.annotations) {
      element.annotations = latest.current.annotations
    }
    rail.current = element
    mount.append(element)
    return () => {
      element.remove()
      rail.current = null
    }
  }, [documentUri, textSelector, apiBase])

  useEffect(() => {
    // React's effect runs after connection, including the first render. Restore
    // the declarative API transport when an override is removed; only an absent
    // apiBase means client-only mode.
    if (rail.current) {
      rail.current.transport = transport ??
        (apiBase ? createHttpTransport({ baseUrl: apiBase }) : null)
    }
  }, [transport, apiBase])

  useEffect(() => {
    // `annotations` absent is a controlled transition to empty, not "leave
    // whatever is already painted" — a truthiness guard here left a rail's
    // last set of annotations installed forever once a consumer cleared the
    // prop, since only an unrelated recreation (e.g. `documentUri` changing)
    // ever produced an empty rail.
    if (rail.current) rail.current.annotations = annotations ?? []
  }, [annotations])

  return <div ref={host} className={className} />
}
