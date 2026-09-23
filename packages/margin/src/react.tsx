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
import type { TextAnnotation } from './anchor'
import {
  defineMarginElements,
  MARGIN_RAIL_TAG,
  type MarginRailElement,
} from './element'
import type { MarginTransport } from './transport'

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
    rail.current = element
    mount.append(element)
    return () => {
      element.remove()
      rail.current = null
    }
  }, [documentUri, textSelector, apiBase])

  useEffect(() => {
    if (rail.current && transport) rail.current.transport = transport
  }, [transport])

  useEffect(() => {
    if (rail.current && annotations) rail.current.annotations = annotations
  }, [annotations])

  return <div ref={host} className={className} />
}
