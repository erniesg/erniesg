/**
 * `@erniesg/margin` — durable text anchoring, selection capture and highlight
 * painting for margin annotations.
 *
 * Nothing in this package imports a book, a paper, a route or a service
 * origin. See `./anchor` for the parts that run outside a browser.
 */
export * from './anchor.js'
export * from './document.js'
export * from './transport.js'
export * from './controller.js'
export * from './dom/blocks.js'
export * from './dom/paint.js'
export * from './dom/selection.js'
export * from './dom/text-index.js'
export {
  MarginRailElement,
  MARGIN_RAIL_TAG,
  defineMarginElements,
} from './element.js'
