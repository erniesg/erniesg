/**
 * `@erniesg/margin` — durable text anchoring, selection capture and highlight
 * painting for margin annotations.
 *
 * Nothing in this package imports a book, a paper, a route or a service
 * origin. See `./anchor` for the parts that run outside a browser.
 */
export * from './anchor'
export * from './document'
export * from './transport'
export * from './controller'
export * from './dom/blocks'
export * from './dom/paint'
export * from './dom/selection'
export * from './dom/text-index'
export { MarginRailElement, MARGIN_RAIL_TAG, defineMarginElements } from './element'
