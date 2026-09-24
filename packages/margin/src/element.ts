/**
 * `<margin-rail>`: the package as a custom element.
 *
 * Everything it draws lives in a shadow root, so the host page gets no styles
 * from it and it gets none from the host. It has no framework dependency: the
 * React wrapper is a separate entry point that mounts this same element.
 *
 * It holds annotations in memory and, when given a transport, tells the
 * service about them. With no transport it still works — selection, painting
 * and the orphan list are all client-side — which is what makes it embeddable
 * before a host has a service at all.
 */
import type { TextAnnotation } from './anchor.js'
import {
  annotationsFromAnchors,
  createMarginController,
  type MarginController,
} from './controller.js'
import type { AnnotationPlacement } from './document.js'
import type { SelectionCapture } from './dom/selection.js'
import {
  MarginTransportError,
  createHttpTransport,
  createMarginClient,
  type MarginTransport,
} from './transport.js'

export const MARGIN_RAIL_TAG = 'margin-rail'

const STYLES = `
:host { display: block; font: inherit; color: inherit; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
li { border-left: 2px solid currentColor; padding: 0.25rem 0 0.25rem 0.6rem; font-size: 0.8125rem; line-height: 1.45; opacity: 0.9; }
li[data-orphaned] { border-left-style: dashed; opacity: 0.7; }
.reason { display: block; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; }
.quote { display: block; }
.empty { font-size: 0.8125rem; opacity: 0.7; margin: 0; }
button { font: inherit; font-size: 0.8125rem; cursor: pointer; background: none; color: inherit; border: 1px solid currentColor; border-radius: 0.25rem; padding: 0.25rem 0.6rem; }
button[disabled] { cursor: default; opacity: 0.45; }
.actions { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
.notice { font-size: 0.75rem; opacity: 0.75; margin: 0 0 0.75rem; }
`

const ORPHAN_LABELS: Record<string, string> = {
  ambiguous: 'orphaned — the quote is no longer unique',
  'missing-node': 'orphaned — the block is gone',
  'non-text-node': 'orphaned — the block has no text',
  'quote-not-found': 'orphaned — the quote was removed',
}

/**
 * `HTMLElement` when there is one, an empty class when there is not.
 *
 * `react.tsx` imports this module statically, so an SSR build evaluates this
 * class declaration in Node — where `HTMLElement` does not exist — and threw a
 * `ReferenceError` before React reached a `useEffect`. That made the optional
 * React entry unusable in every SSR framework.
 *
 * Nothing on the server instantiates it: `defineMarginElements` returns early
 * without a `customElements` registry, which is the same condition.
 */
const ElementBase: typeof HTMLElement =
  (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement ??
  (class {} as unknown as typeof HTMLElement)

export class MarginRailElement extends ElementBase {
  static observedAttributes = ['document-uri', 'text-selector', 'api-base']

  #controller: MarginController | null = null
  #annotations: TextAnnotation[] = []
  #capture: SelectionCapture = { status: 'empty' }
  #transport: MarginTransport | null = null
  /** Whether `#transport` is one this element built from `api-base`. */
  #ownsTransport = false
  /**
   * This rail's own suffix for the document-global highlight registry.
   *
   * A counter rather than the document URI: two rails showing the *same*
   * document — a reading column beside a preview of it — still need separate
   * entries, and a URI would give them the same one.
   */
  static #rails = 0
  readonly #namespace = `rail-${(MarginRailElement.#rails += 1)}`
  #shadow: ShadowRoot

  constructor() {
    super()
    this.#shadow = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLES
    this.#shadow.append(style, document.createElement('div'))
  }

  get documentUri(): string {
    return this.getAttribute('document-uri') ?? ''
  }

  get annotations(): readonly TextAnnotation[] {
    return this.#annotations
  }

  set annotations(next: readonly TextAnnotation[]) {
    this.#annotations = [...next]
    this.#paint()
  }

  /** The seam. Set this to point the rail at any host, or at a stub. */
  set transport(next: MarginTransport | null) {
    this.#transport = next
    this.#ownsTransport = false
  }

  get transport(): MarginTransport | null {
    return this.#transport
  }

  connectedCallback() {
    this.#attach()
  }

  /**
   * Observed attributes are observed for a reason.
   *
   * The class declared three and implemented no callback, so a plain custom-
   * element consumer changing `text-selector` after connection kept a controller
   * attached to the old text root, a new `api-base` never created a transport,
   * and a new `document-uri` left the previous document's annotations in memory.
   * The React binding worked only because it destroys and recreates the element.
   */
  attributeChangedCallback(
    name: string,
    previous: string | null,
    next: string | null,
  ) {
    if (previous === next || !this.isConnected) return
    if (name === 'document-uri') {
      // A different document is a different set of annotations. Keeping the old
      // ones would paint one document's highlights onto another.
      this.#annotations = []
    }
    if (name === 'document-uri' || name === 'text-selector') {
      this.#capture = { status: 'empty' }
    }
    if (name === 'api-base') {
      // Only a transport this element made itself: one that was injected through
      // the `transport` setter belongs to the caller and is not ours to replace.
      if (this.#ownsTransport) this.#transport = null
    }
    this.#detach()
    this.#attach()
  }

  #attach() {
    const selector =
      this.getAttribute('text-selector') ?? '[data-reading-column="text"]'
    const root = this.ownerDocument.querySelector(selector)
    if (!root) {
      // Nothing to annotate, but the rail still draws: a blank column says
      // less than a rail that says there is nothing here.
      this.#render([])
      return
    }

    const base = this.getAttribute('api-base')
    if (base && !this.#transport) {
      this.#transport = createHttpTransport({ baseUrl: base })
      this.#ownsTransport = true
    }

    this.#controller = createMarginController({
      root,
      // Every rail gets its own registry entries. `paint.ts` grew the option and
      // nothing passed one, so two rails on a page went on overwriting and
      // deleting each other's `CSS.highlights` keys and stylesheet — the fix was
      // available and unused.
      registryNamespace: this.#namespace,
      onSelection: (capture) => {
        this.#capture = capture
        this.#render()
        this.dispatchEvent(
          new CustomEvent('margin-selection', {
            detail: capture,
            bubbles: true,
            composed: true,
          }),
        )
      },
    })
    this.#controller.start()
    this.#paint()
  }

  disconnectedCallback() {
    this.#detach()
  }

  #detach() {
    this.#controller?.stop()
    this.#controller = null
  }

  /** Turn the live selection into annotations. Returns what it created. */
  highlightSelection(color = 'amber'): TextAnnotation[] {
    if (this.#capture.status !== 'captured') return []
    const created = annotationsFromAnchors(this.#capture.anchors, {
      kind: 'highlight',
      color,
    })
    this.#annotations = [...this.#annotations, ...created]
    this.#capture = { status: 'empty' }
    this.ownerDocument.getSelection()?.removeAllRanges()
    this.#paint()
    this.dispatchEvent(
      new CustomEvent('margin-annotations-created', {
        detail: created,
        bubbles: true,
        composed: true,
      }),
    )
    void this.#publish(created)
    return created
  }

  async #publish(created: readonly TextAnnotation[]) {
    if (!this.#transport || created.length === 0) return
    const client = createMarginClient(this.#transport)
    try {
      const first = created[0]
      const common = {
        documentUri: this.documentUri,
        targets: created.map((annotation) => annotation.target),
        targetTexts: created.map((annotation) => {
          const text = this.#controller
            ?.blocks()
            .find((block) => block.id === annotation.target.nodeId)?.text
          if (text === undefined)
            throw new Error(
              `Full text unavailable for ${annotation.target.nodeId}`,
            )
          return text
        }),
      }
      const responses = await client.createAnnotations(
        first.kind === 'highlight'
          ? { ...common, kind: 'highlight', color: first.appearance.color }
          : { ...common, kind: first.kind, body: first.body },
      )
      // A transport resolves with whatever status it got: an HTTP error is a
      // value here, not a throw. Treating it as success meant a 401, a 429 or a
      // 500 left the annotation in memory only, to disappear on reload with
      // nothing having said so.
      const refused = responses.filter(
        (response) => response.status < 200 || response.status >= 300,
      )
      if (refused.length > 0) {
        this.#reportTransportFailure(
          new MarginTransportError(
            `the margin service refused ${refused.length} of ${responses.length} annotations`,
            refused,
          ),
        )
      }
    } catch (error) {
      this.#reportTransportFailure(error)
    }
  }

  /**
   * A service that is down must not cost the reader their highlight: it is
   * already painted and already in the rail. Say so and keep going.
   */
  #reportTransportFailure(error: unknown) {
    this.dispatchEvent(
      new CustomEvent('margin-transport-error', {
        detail: error,
        bubbles: true,
        composed: true,
      }),
    )
  }

  #paint() {
    const placements = this.#controller?.render(this.#annotations) ?? []
    this.#render(placements)
  }

  #render(placements?: AnnotationPlacement[]) {
    const container = this.#shadow.lastElementChild
    if (!container) return
    const resolved =
      placements ?? this.#controller?.place(this.#annotations) ?? []

    container.replaceChildren()
    const doc = this.ownerDocument

    const actions = doc.createElement('div')
    actions.className = 'actions'
    const button = doc.createElement('button')
    button.type = 'button'
    button.textContent = 'Highlight selection'
    button.dataset.marginAction = 'highlight'
    button.disabled = this.#capture.status !== 'captured'
    button.addEventListener('click', () => this.highlightSelection())
    actions.append(button)
    container.append(actions)

    if (this.#capture.status === 'non-annotatable') {
      const notice = doc.createElement('p')
      notice.className = 'notice'
      notice.dataset.marginNotice = 'non-annotatable'
      notice.textContent =
        'That region is generated and cannot hold a durable anchor.'
      container.append(notice)
    }

    if (resolved.length === 0) {
      const empty = doc.createElement('p')
      empty.className = 'empty'
      empty.textContent = 'No annotations yet.'
      container.append(empty)
      return
    }

    const list = doc.createElement('ul')
    for (const { annotation, placement } of resolved) {
      const item = doc.createElement('li')
      item.dataset.marginAnnotation = annotation.id
      if (placement.status === 'orphaned') {
        item.dataset.orphaned = placement.reason
        const reason = doc.createElement('span')
        reason.className = 'reason'
        reason.textContent = ORPHAN_LABELS[placement.reason] ?? 'orphaned'
        item.append(reason)
      }
      const quote = doc.createElement('span')
      quote.className = 'quote'
      quote.textContent = annotation.target.quote.exact
      item.append(quote)
      list.append(item)
    }
    container.append(list)
  }
}

/** Idempotent: a page that loads the bundle twice must not throw. */
export function defineMarginElements(
  registry: CustomElementRegistry | undefined = globalThis.customElements,
) {
  if (!registry || registry.get(MARGIN_RAIL_TAG)) return
  registry.define(MARGIN_RAIL_TAG, MarginRailElement)
}
