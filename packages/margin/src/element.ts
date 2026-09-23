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
import { annotationBody, type TextAnnotation } from './anchor.js'
import {
  annotationsFromAnchors,
  createMarginController,
  type MarginController,
} from './controller.js'
import type { AnchorPlacement } from './document.js'
import type { SelectionCapture } from './dom/selection.js'
import { offsetForPoint, rangeForOffsets } from './dom/text-index.js'
import {
  decodeWebAnnotation,
  orderAndFilterEntries,
  reconcileEntries,
  type RailEntry,
  type Visibility,
} from './rail-state.js'
import { RAIL_STYLES } from './rail-styles.js'
import {
  MarginTransportError,
  createHttpTransport,
  createMarginClient,
  type MarginTransport,
} from './transport.js'

export const MARGIN_RAIL_TAG = 'margin-rail'

const SEMANTIC_COLORS = [
  { key: 'highlight', label: 'Highlight' },
  { key: 'question', label: 'Question' },
  { key: 'insight', label: 'Insight' },
  { key: 'action', label: 'Action' },
] as const

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
  #root: Element | null = null
  #entries: RailEntry[] = []
  #pendingLocalIds = new Set<string>()
  #unsavedIds = new Set<string>()
  #pendingMutations = new Set<string>()
  #pendingDeletes = new Set<string>()
  #ownedIds = new Set<string>()
  #viewerKey: string | null = null
  #stateEpoch = 0
  #placements: AnchorPlacement[] = []
  #capture: SelectionCapture = { status: 'empty' }
  #defaultVisibility: Visibility = 'private'
  #query = ''
  #dialogOpen = false
  #dismissedSelection = ''
  #selectionRange: Range | null = null
  #editingId: string | null = null
  #notice = ''
  #flashTimer = 0
  #popupTimer = 0
  #activeHighlight = ''
  #loadGeneration = 0
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
    style.textContent = RAIL_STYLES
    this.#shadow.append(style, document.createElement('div'))
  }

  get documentUri(): string {
    return this.getAttribute('document-uri') ?? ''
  }

  get annotations(): readonly TextAnnotation[] {
    return this.#entries.map((entry) => entry.annotation)
  }

  set annotations(next: readonly TextAnnotation[]) {
    this.#entries = next.map((annotation) => ({
      annotation,
      visibility: this.#defaultVisibility,
    }))
    this.#paint()
  }

  /** The seam. Set this to point the rail at any host, or at a stub. */
  set transport(next: MarginTransport | null) {
    this.#loadGeneration += 1
    this.#stateEpoch += 1
    this.#pendingMutations.clear()
    this.#pendingDeletes.clear()
    this.#pendingLocalIds.clear()
    this.#unsavedIds.clear()
    this.#ownedIds.clear()
    this.#viewerKey = null
    this.#transport = next
    this.#ownsTransport = false
    if (this.isConnected && next) void this.#load()
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
      this.#entries = []
      this.#pendingLocalIds.clear()
      this.#unsavedIds.clear()
      this.#ownedIds.clear()
      this.#viewerKey = null
      this.#dialogOpen = false
      this.removeAttribute('overlay-open')
    }
    if (name === 'document-uri' || name === 'text-selector') {
      this.#capture = { status: 'empty' }
      this.#dismissedSelection = ''
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
      this.#render()
      return
    }
    this.#root = root

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
        if (this.#dialogOpen) return
        this.#capture = capture
        const view = this.ownerDocument.defaultView
        if (this.#popupTimer) view?.clearTimeout(this.#popupTimer)
        this.#popupTimer = 0
        if (capture.status === 'empty') this.#dismissedSelection = ''
        if (capture.status === 'captured') {
          const key = capture.anchors
            .map(
              (anchor) =>
                `${anchor.nodeId}:${anchor.position.start}:${anchor.position.end}`,
            )
            .join('|')
          if (!this.#dialogOpen && key !== this.#dismissedSelection) {
            this.#selectionRange = capture.range.cloneRange()
            // Selection changes once per Shift+Arrow keystroke. Wait for the
            // reader to finish extending it before moving focus into popup.
            this.#popupTimer =
              view?.setTimeout(() => {
                this.#popupTimer = 0
                if (this.#capture.status !== 'captured' || this.#dialogOpen)
                  return
                this.#dialogOpen = true
                this.#render()
                this.#shadow
                  .querySelector<HTMLElement>('[data-margin-color]')
                  ?.focus({ preventScroll: true })
              }, 180) ?? 0
          }
        }
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
    root.addEventListener('click', this.#onTextClick)
    this.#paint()
    void this.#load()
  }

  disconnectedCallback() {
    this.#detach()
  }

  #detach() {
    this.#loadGeneration += 1
    this.#stateEpoch += 1
    this.#pendingMutations.clear()
    this.#pendingDeletes.clear()
    this.#root?.removeEventListener('click', this.#onTextClick)
    this.#root = null
    this.#controller?.stop()
    this.#controller = null
    const view = this.ownerDocument.defaultView
    if (this.#flashTimer) view?.clearTimeout(this.#flashTimer)
    if (this.#popupTimer) view?.clearTimeout(this.#popupTimer)
    if (this.#activeHighlight) {
      ;(
        view as unknown as { CSS?: { highlights?: Map<string, unknown> } }
      )?.CSS?.highlights?.delete(this.#activeHighlight)
      this.ownerDocument.head
        .querySelector(`[data-margin-active-style="${this.#namespace}"]`)
        ?.remove()
      this.#activeHighlight = ''
    }
  }

  /** Turn the live selection into annotations. Returns what it created. */
  highlightSelection(color = 'highlight'): TextAnnotation[] {
    return this.#createFromCapture({ kind: 'highlight', color })
  }

  noteSelection(body: string): TextAnnotation[] {
    if (!body.trim()) return []
    return this.#createFromCapture({ kind: 'note', body: body.trim() })
  }

  #createFromCapture(
    input:
      { kind: 'highlight'; color: string } | { kind: 'note'; body: string },
  ): TextAnnotation[] {
    if (this.#capture.status !== 'captured') return []
    const created = annotationsFromAnchors(this.#capture.anchors, input)
    this.#entries = [
      ...this.#entries,
      ...created.map((annotation) => ({
        annotation,
        visibility: this.#defaultVisibility,
      })),
    ]
    for (const annotation of created) this.#pendingLocalIds.add(annotation.id)
    for (const annotation of created) this.#ownedIds.add(annotation.id)
    this.#dismissedSelection = this.#capture.anchors
      .map(
        (anchor) =>
          `${anchor.nodeId}:${anchor.position.start}:${anchor.position.end}`,
      )
      .join('|')
    this.#capture = { status: 'empty' }
    this.#dialogOpen = false
    this.ownerDocument.getSelection()?.removeAllRanges()
    this.#paint()
    this.dispatchEvent(
      new CustomEvent('margin-annotations-created', {
        detail: created,
        bubbles: true,
        composed: true,
      }),
    )
    void this.#publish(created, this.#defaultVisibility)
    return created
  }

  async #publish(created: readonly TextAnnotation[], visibility: Visibility) {
    if (!this.#transport || created.length === 0) {
      for (const annotation of created)
        this.#pendingLocalIds.delete(annotation.id)
      return
    }
    const transport = this.#transport
    const documentUri = this.documentUri
    const client = createMarginClient(transport)
    try {
      const first = created[0]
      const common = {
        documentUri: this.documentUri,
        visibility,
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
      if (this.#transport !== transport || this.documentUri !== documentUri)
        return
      // A transport resolves with whatever status it got: an HTTP error is a
      // value here, not a throw. Treating it as success meant a 401, a 429 or a
      // 500 left the annotation in memory only, to disappear on reload with
      // nothing having said so.
      const refused = responses.filter(
        (response) => response.status < 200 || response.status >= 300,
      )
      if (refused.length > 0) {
        responses.forEach((response, index) => {
          if (response.status < 200 || response.status >= 300)
            this.#unsavedIds.add(created[index].id)
        })
        this.#reportTransportFailure(
          new MarginTransportError(
            `the margin service refused ${refused.length} of ${responses.length} annotations`,
            refused,
          ),
        )
      }
      responses.forEach((response, index) => {
        if (response.status < 200 || response.status >= 300) return
        try {
          const serverEntry = decodeWebAnnotation(response.body)
          const localId = created[index].id
          this.#ownedIds.delete(localId)
          this.#ownedIds.add(serverEntry.annotation.id)
          this.#entries = this.#entries.map((entry) =>
            entry.annotation.id === localId ? serverEntry : entry,
          )
          this.#entries = this.#entries.filter(
            (entry, at, all) =>
              all.findIndex(
                (candidate) => candidate.annotation.id === entry.annotation.id,
              ) === at,
          )
        } catch (error) {
          this.#unsavedIds.add(created[index].id)
          this.#reportTransportFailure(error)
        }
      })
      this.#paint()
    } catch (error) {
      if (this.#transport === transport && this.documentUri === documentUri) {
        for (const annotation of created) this.#unsavedIds.add(annotation.id)
        this.#reportTransportFailure(error)
      }
    } finally {
      if (this.#transport === transport && this.documentUri === documentUri) {
        for (const annotation of created)
          this.#pendingLocalIds.delete(annotation.id)
        this.#render()
      }
    }
  }

  async #load() {
    if (!this.#transport || !this.documentUri) return
    const generation = ++this.#loadGeneration
    const client = createMarginClient(this.#transport)
    try {
      const prefs = await client.readPreferences()
      if (generation !== this.#loadGeneration) return
      if (prefs.status >= 200 && prefs.status < 300) {
        this.#notice = ''
        const preference = prefs.body as {
          defaultVisibility?: unknown
          viewerKey?: unknown
        }
        const value = preference?.defaultVisibility
        if (value === 'private' || value === 'public')
          this.#defaultVisibility = value
        this.#viewerKey =
          typeof preference?.viewerKey === 'string'
            ? preference.viewerKey
            : null
      } else if (prefs.status === 401) {
        this.#viewerKey = null
        this.#notice = 'Sign in to manage annotations, then retry access.'
      }
      const collected: RailEntry[] = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const response = await client.listAnnotations(this.documentUri, cursor)
        if (generation !== this.#loadGeneration) return
        if (response.status < 200 || response.status >= 300) {
          throw new MarginTransportError('annotation list was refused', [
            response,
          ])
        }
        const body = response.body as {
          annotations?: unknown
          nextCursor?: unknown
        }
        if (!Array.isArray(body?.annotations))
          throw new Error('Invalid annotation list')
        collected.push(...body.annotations.map(decodeWebAnnotation))
        const next = body.nextCursor
        if (next === undefined) break
        if (typeof next !== 'string' || !next || seen.has(next)) {
          throw new Error('Invalid annotation cursor')
        }
        seen.add(next)
        cursor = next
      } while (cursor)
      this.#entries = reconcileEntries(
        collected,
        this.#entries,
        this.#pendingLocalIds,
        this.#pendingMutations,
        this.#pendingDeletes,
      )
      this.#paint()
    } catch (error) {
      if (generation === this.#loadGeneration)
        this.#reportTransportFailure(error)
    }
  }

  async #setDefaultVisibility(value: Visibility) {
    if (this.#pendingMutations.has('prefs')) return
    const previous = this.#defaultVisibility
    const transport = this.#transport
    const epoch = this.#stateEpoch
    this.#pendingMutations.add('prefs')
    this.#defaultVisibility = value
    this.#render()
    if (!transport) {
      this.#pendingMutations.delete('prefs')
      this.#render()
      return
    }
    try {
      const response =
        await createMarginClient(transport).setDefaultVisibility(value)
      if (epoch !== this.#stateEpoch) return
      if (response.status < 200 || response.status >= 300) {
        throw new MarginTransportError('visibility default was refused', [
          response,
        ])
      }
    } catch (error) {
      if (epoch !== this.#stateEpoch) return
      this.#defaultVisibility = previous
      this.#reportTransportFailure(error)
    } finally {
      if (epoch === this.#stateEpoch) {
        this.#pendingMutations.delete('prefs')
        this.#render()
      }
    }
  }

  async #updateEntry(
    id: string,
    patch: { body?: string; visibility?: Visibility; color?: string },
  ) {
    if (this.#pendingMutations.has(id)) return
    const index = this.#entries.findIndex((entry) => entry.annotation.id === id)
    if (index < 0) return
    const transport = this.#transport
    const documentUri = this.documentUri
    const epoch = this.#stateEpoch
    this.#pendingMutations.add(id)
    const previous = this.#entries[index]
    const changed: RailEntry = {
      ...previous,
      visibility: patch.visibility ?? previous.visibility,
      annotation:
        patch.body === undefined && patch.color === undefined
          ? previous.annotation
          : previous.annotation.kind === 'highlight'
            ? {
                ...previous.annotation,
                appearance: {
                  color: patch.color ?? previous.annotation.appearance.color,
                },
              }
            : {
                ...previous.annotation,
                body: patch.body ?? previous.annotation.body,
              },
    }
    this.#entries = this.#entries.map((entry, at) =>
      at === index ? changed : entry,
    )
    this.#editingId = null
    this.#paint()
    if (!transport || this.#unsavedIds.has(id)) {
      this.#pendingMutations.delete(id)
      this.#render()
      return
    }
    try {
      const response = await createMarginClient(transport).updateAnnotation(
        id,
        documentUri,
        patch,
      )
      if (epoch !== this.#stateEpoch) return
      if (response.status < 200 || response.status >= 300) {
        throw new MarginTransportError('annotation update was refused', [
          response,
        ])
      }
      this.#entries = this.#entries.map((entry) =>
        entry.annotation.id === id ? decodeWebAnnotation(response.body) : entry,
      )
      this.#paint()
    } catch (error) {
      if (epoch !== this.#stateEpoch) return
      this.#entries = this.#entries.map((entry) =>
        entry.annotation.id === id ? previous : entry,
      )
      this.#paint()
      this.#reportTransportFailure(error)
    } finally {
      if (epoch === this.#stateEpoch) {
        this.#pendingMutations.delete(id)
        this.#render()
      }
    }
  }

  async #deleteEntry(id: string) {
    if (this.#pendingMutations.has(id)) return
    const index = this.#entries.findIndex((entry) => entry.annotation.id === id)
    if (index < 0) return
    const transport = this.#transport
    const documentUri = this.documentUri
    const epoch = this.#stateEpoch
    this.#pendingMutations.add(id)
    this.#pendingDeletes.add(id)
    const [removed] = this.#entries.splice(index, 1)
    this.#paint()
    if (!transport || this.#unsavedIds.has(id)) {
      this.#pendingMutations.delete(id)
      this.#pendingDeletes.delete(id)
      this.#unsavedIds.delete(id)
      return
    }
    try {
      const response = await createMarginClient(transport).deleteAnnotation(
        id,
        documentUri,
      )
      if (epoch !== this.#stateEpoch) return
      if (response.status < 200 || response.status >= 300) {
        throw new MarginTransportError('annotation delete was refused', [
          response,
        ])
      }
      this.#ownedIds.delete(id)
    } catch (error) {
      if (epoch !== this.#stateEpoch) return
      this.#entries.splice(index, 0, removed)
      this.#paint()
      this.#reportTransportFailure(error)
    } finally {
      if (epoch === this.#stateEpoch) {
        this.#pendingMutations.delete(id)
        this.#pendingDeletes.delete(id)
        this.#render()
      }
    }
  }

  #onTextClick = (event: Event) => {
    if (!(event instanceof MouseEvent) || !this.#controller) return
    const doc = this.ownerDocument as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const point = doc.caretPositionFromPoint?.(event.clientX, event.clientY)
    const range = point
      ? null
      : doc.caretRangeFromPoint?.(event.clientX, event.clientY)
    const node = point?.offsetNode ?? range?.startContainer
    const offset = point?.offset ?? range?.startOffset
    if (!node || offset === undefined) return
    const block = this.#controller
      .blocks()
      .find((candidate) => candidate.element.contains(node))
    if (!block) return
    const at = offsetForPoint(block.index, node, offset)
    const match = this.#placements.findIndex(
      (placement, index) =>
        this.#entries[index]?.annotation.kind === 'highlight' &&
        placement.status === 'anchored' &&
        placement.nodeId === block.id &&
        at >= placement.start &&
        at <= placement.end,
    )
    if (match >= 0) this.#focusRailEntry(this.#entries[match].annotation.id)
  }

  #focusRailEntry(id: string) {
    this.#query = ''
    this.setAttribute('overlay-open', '')
    this.#render()
    const item = Array.from(
      this.#shadow.querySelectorAll<HTMLElement>('[data-margin-annotation]'),
    ).find((candidate) => candidate.dataset.marginAnnotation === id)
    item?.scrollIntoView({ block: 'nearest' })
    item?.focus({ preventScroll: true })
  }

  #focusText(placement: AnchorPlacement | undefined) {
    if (!placement || placement.status !== 'anchored') return
    const block = this.#controller
      ?.blocks()
      .find((one) => one.id === placement.nodeId)
    if (!block) return
    const range = rangeForOffsets(block.index, placement.start, placement.end)
    if (!range) return
    range.startContainer.parentElement?.scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    })
    const view = this.ownerDocument.defaultView as
      (Window & { Highlight?: new (...ranges: Range[]) => unknown }) | null
    const registry = (
      view as unknown as { CSS?: { highlights?: Map<string, unknown> } }
    )?.CSS?.highlights
    if (!registry || !view?.Highlight) return
    const name = `erniesg-margin-active-${this.#namespace}`
    const old = this.ownerDocument.head.querySelector(
      `[data-margin-active-style="${this.#namespace}"]`,
    )
    old?.remove()
    const style = this.ownerDocument.createElement('style')
    style.dataset.marginActiveStyle = this.#namespace
    style.textContent = `::highlight(${name}) { background:#ffcf5c; color:inherit; }`
    this.ownerDocument.head.append(style)
    registry.set(name, new view.Highlight(range))
    if (this.#flashTimer) view.clearTimeout(this.#flashTimer)
    this.#activeHighlight = name
    this.#flashTimer = view.setTimeout(() => {
      registry.delete(name)
      style.remove()
      this.#activeHighlight = ''
      this.#flashTimer = 0
    }, 1400)
  }

  #dismissDialog() {
    this.#dialogOpen = false
    if (this.#capture.status === 'captured') {
      this.#dismissedSelection = this.#capture.anchors
        .map(
          (anchor) =>
            `${anchor.nodeId}:${anchor.position.start}:${anchor.position.end}`,
        )
        .join('|')
    }
    this.#render()
    const range = this.#selectionRange
    if (!range) return
    const element =
      range.startContainer.nodeType === 1
        ? (range.startContainer as HTMLElement)
        : range.startContainer.parentElement
    const block =
      element?.closest<HTMLElement>('[data-block-kind]') ??
      (this.#root as HTMLElement | null)
    if (block) {
      const hadTabindex = block.hasAttribute('tabindex')
      if (!hadTabindex) {
        block.tabIndex = -1
        block.addEventListener(
          'blur',
          () => block.removeAttribute('tabindex'),
          { once: true },
        )
      }
      block.focus({ preventScroll: true })
    }
    const selection = this.ownerDocument.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  /**
   * A service that is down must not cost the reader their highlight: it is
   * already painted and already in the rail. Say so and keep going.
   */
  #reportTransportFailure(error: unknown) {
    this.#notice =
      error instanceof Error
        ? error.message
        : 'The margin service is unavailable.'
    this.#render()
    this.dispatchEvent(
      new CustomEvent('margin-transport-error', {
        detail: error,
        bubbles: true,
        composed: true,
      }),
    )
  }

  #paint() {
    this.#placements =
      this.#controller
        ?.render(this.annotations)
        .map(({ placement }) => placement) ?? []
    this.#render()
  }

  #render() {
    const container = this.#shadow.lastElementChild
    if (!container) return
    const active = this.#shadow.activeElement as
      HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | null
    const focusKey = active?.dataset.focusKey
    const selectionStart =
      active && 'selectionStart' in active ? active.selectionStart : null
    container.replaceChildren()
    const doc = this.ownerDocument
    const button = (label: string, onClick: () => void) => {
      const control = doc.createElement('button')
      control.type = 'button'
      control.textContent = label
      control.addEventListener('click', onClick)
      return control
    }
    const mobileToggle = button(
      this.hasAttribute('overlay-open') ? 'Close annotations' : 'Annotations',
      () => {
        if (this.hasAttribute('overlay-open')) {
          this.removeAttribute('overlay-open')
          this.#render()
          this.#shadow.querySelector<HTMLElement>('.mobile-toggle')?.focus()
        } else {
          this.setAttribute('overlay-open', '')
          this.#render()
          this.#shadow
            .querySelector<HTMLElement>('[data-margin-search]')
            ?.focus()
        }
      },
    )
    mobileToggle.className = 'mobile-toggle'
    mobileToggle.dataset.marginToggle = ''
    mobileToggle.setAttribute(
      'aria-expanded',
      String(this.hasAttribute('overlay-open')),
    )
    mobileToggle.setAttribute('aria-controls', 'margin-panel')
    container.append(mobileToggle)

    const panel = doc.createElement('aside')
    panel.id = 'margin-panel'
    panel.className = 'panel'
    panel.setAttribute('aria-label', 'Annotations')
    panel.dataset.marginPanel = ''
    const heading = doc.createElement('div')
    heading.className = 'heading'
    const title = doc.createElement('h2')
    title.textContent = 'Annotations'
    const count = doc.createElement('span')
    count.className = 'count'
    count.textContent = `${this.#entries.length}`
    heading.append(title, count)
    panel.append(heading)
    const actions = doc.createElement('div')
    actions.className = 'actions'
    const quick = button('Highlight selection', () => this.highlightSelection())
    quick.dataset.marginAction = 'highlight'
    quick.disabled = this.#capture.status !== 'captured'
    actions.append(quick)
    panel.append(actions)

    const controls = doc.createElement('div')
    controls.className = 'controls'
    const searchLabel = doc.createElement('label')
    searchLabel.textContent = 'Search annotations'
    const search = doc.createElement('input')
    search.type = 'search'
    search.value = this.#query
    search.dataset.marginSearch = ''
    search.dataset.focusKey = 'search'
    search.addEventListener('input', () => {
      this.#query = search.value
      this.#render()
    })
    searchLabel.append(search)
    const defaultLabel = doc.createElement('label')
    defaultLabel.textContent = 'Default for new annotations'
    const defaultSelect = doc.createElement('select')
    defaultSelect.dataset.marginDefaultVisibility = ''
    defaultSelect.dataset.focusKey = 'default'
    for (const value of ['private', 'public'] as const) {
      const option = doc.createElement('option')
      option.value = value
      option.textContent = value === 'private' ? 'Private' : 'Public'
      defaultSelect.append(option)
    }
    defaultSelect.value = this.#defaultVisibility
    defaultSelect.disabled = this.#pendingMutations.has('prefs')
    defaultSelect.addEventListener(
      'change',
      () => void this.#setDefaultVisibility(defaultSelect.value as Visibility),
    )
    defaultLabel.append(defaultSelect)
    controls.append(searchLabel, defaultLabel)
    panel.append(controls)

    if (this.#capture.status === 'non-annotatable') {
      const notice = doc.createElement('p')
      notice.className = 'notice'
      notice.dataset.marginNotice = 'non-annotatable'
      notice.textContent =
        'That region is generated and cannot hold a durable anchor.'
      panel.append(notice)
    }
    if (this.#notice) {
      const notice = doc.createElement('p')
      notice.className = 'notice'
      notice.setAttribute('role', 'status')
      notice.textContent = this.#notice
      panel.append(notice)
      if (this.#notice.startsWith('Sign in')) {
        const retry = button('Retry access', () => void this.#load())
        panel.append(retry)
      }
    }
    const ordered = orderAndFilterEntries(
      this.#entries,
      this.#placements,
      this.#controller?.blocks().map((block) => block.id) ?? [],
      this.#query,
    )
    if (ordered.length === 0) {
      const empty = doc.createElement('p')
      empty.className = 'empty'
      empty.textContent = this.#query
        ? 'No matching annotations.'
        : 'No annotations yet.'
      panel.append(empty)
    }
    const list = doc.createElement('ul')
    list.className = 'list'
    for (const { annotation, visibility, creator } of ordered) {
      const index = this.#entries.findIndex(
        (entry) => entry.annotation.id === annotation.id,
      )
      const placement = this.#placements[index]
      const item = doc.createElement('li')
      item.className = 'entry'
      item.tabIndex = -1
      item.dataset.marginAnnotation = annotation.id
      item.dataset.marginColor =
        annotation.kind === 'highlight'
          ? annotation.appearance.color
          : 'highlight'
      if (placement?.status === 'orphaned') {
        item.dataset.orphaned = placement.reason
      }
      const main = button('', () => this.#focusText(placement))
      main.className = 'entry-main'
      main.dataset.focusKey = `entry:${annotation.id}`
      const quote = doc.createElement('span')
      quote.className = 'quote'
      quote.textContent = `“${annotation.target.quote.exact}”`
      main.append(quote)
      const body = annotationBody(annotation)
      if (body !== null) {
        const paragraph = doc.createElement('span')
        paragraph.className = 'body'
        paragraph.textContent = body
        main.append(paragraph)
      }
      item.append(main)
      const meta = doc.createElement('span')
      meta.className = 'meta'
      meta.textContent = `${annotation.kind} · ${visibility}${placement?.status === 'orphaned' ? ` · ${ORPHAN_LABELS[placement.reason] ?? 'orphaned'}` : ''}`
      if (this.#pendingLocalIds.has(annotation.id))
        meta.textContent += ' · saving'
      if (this.#unsavedIds.has(annotation.id))
        meta.textContent += ' · not saved'
      item.append(meta)
      const canEdit =
        !this.#transport ||
        this.#ownedIds.has(annotation.id) ||
        (this.#viewerKey !== null && creator === this.#viewerKey)
      const entryActions = doc.createElement('div')
      entryActions.className = 'entry-actions'
      const visibilityButton = button(
        `Make ${visibility === 'private' ? 'public' : 'private'}`,
        () =>
          void this.#updateEntry(annotation.id, {
            visibility: visibility === 'private' ? 'public' : 'private',
          }),
      )
      visibilityButton.dataset.marginVisibility = annotation.id
      visibilityButton.disabled =
        this.#pendingMutations.has(annotation.id) ||
        this.#pendingLocalIds.has(annotation.id)
      entryActions.append(visibilityButton)
      const editButton = button('Edit', () => {
        this.#editingId = annotation.id
        this.#render()
        this.#shadow
          .querySelector<HTMLElement>('[data-margin-edit-field]')
          ?.focus()
      })
      editButton.dataset.marginEdit = annotation.id
      editButton.disabled =
        this.#pendingMutations.has(annotation.id) ||
        this.#pendingLocalIds.has(annotation.id)
      entryActions.append(editButton)
      const deleteButton = button(
        'Delete',
        () => void this.#deleteEntry(annotation.id),
      )
      deleteButton.dataset.marginDelete = annotation.id
      deleteButton.disabled =
        this.#pendingMutations.has(annotation.id) ||
        this.#pendingLocalIds.has(annotation.id)
      entryActions.append(deleteButton)
      if (canEdit) item.append(entryActions)
      else {
        const readOnly = doc.createElement('span')
        readOnly.className = 'meta'
        readOnly.textContent = 'Only the author can change this annotation.'
        item.append(readOnly)
      }
      if (this.#editingId === annotation.id) {
        const editor = doc.createElement('div')
        editor.className = 'edit'
        let field: HTMLTextAreaElement | HTMLSelectElement
        if (annotation.kind === 'highlight') {
          const select = doc.createElement('select')
          for (const color of SEMANTIC_COLORS) {
            const option = doc.createElement('option')
            option.value = color.key
            option.textContent = color.label
            select.append(option)
          }
          select.value = annotation.appearance.color
          field = select
        } else {
          const textarea = doc.createElement('textarea')
          textarea.value = annotation.body
          field = textarea
        }
        field.dataset.marginEditField = ''
        field.dataset.focusKey = `edit:${annotation.id}`
        const editActions = doc.createElement('div')
        editActions.className = 'edit-actions'
        editActions.append(
          button('Save', () => {
            if (annotation.kind === 'highlight')
              void this.#updateEntry(annotation.id, { color: field.value })
            else if (field.value.trim())
              void this.#updateEntry(annotation.id, {
                body: field.value.trim(),
              })
          }),
          button('Cancel', () => {
            this.#editingId = null
            this.#render()
          }),
        )
        editor.append(field, editActions)
        item.append(editor)
      }
      list.append(item)
    }
    panel.append(list)
    container.append(panel)

    if (this.#dialogOpen && this.#capture.status === 'captured') {
      const dialog = doc.createElement('div')
      dialog.className = 'dialog'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      dialog.setAttribute('aria-label', 'Annotate selection')
      dialog.dataset.marginPopup = ''
      const rect = this.#selectionRange?.getBoundingClientRect()
      const view = doc.defaultView
      dialog.style.left = `${Math.max(8, Math.min(rect?.left ?? 8, (view?.innerWidth ?? 400) - 360))}px`
      dialog.style.top = `${Math.max(8, Math.min((rect?.bottom ?? 80) + 8, (view?.innerHeight ?? 600) - 270))}px`
      const dialogTitle = doc.createElement('h3')
      dialogTitle.textContent = 'Save selection'
      dialog.append(dialogTitle)
      const swatches = doc.createElement('div')
      swatches.className = 'swatches'
      for (const color of SEMANTIC_COLORS) {
        const swatch = button(color.label, () => {
          this.highlightSelection(color.key)
          this.#dismissDialog()
        })
        swatch.dataset.marginColor = color.key
        swatches.append(swatch)
      }
      dialog.append(swatches)
      const noteLabel = doc.createElement('label')
      noteLabel.textContent = 'Add a note'
      const note = doc.createElement('textarea')
      note.dataset.marginNote = ''
      note.dataset.focusKey = 'note'
      noteLabel.append(note)
      dialog.append(noteLabel)
      const dialogActions = doc.createElement('div')
      dialogActions.className = 'dialog-actions'
      const saveNote = button('Save note', () => {
        if (this.noteSelection(note.value).length) this.#dismissDialog()
      })
      saveNote.dataset.marginSaveNote = ''
      dialogActions.append(
        saveNote,
        button('Cancel', () => this.#dismissDialog()),
      )
      dialog.append(dialogActions)
      dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          this.#dismissDialog()
          return
        }
        if (event.key !== 'Tab') return
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>('button, textarea'),
        )
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && this.#shadow.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && this.#shadow.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      })
      container.append(dialog)
    }

    if (focusKey) {
      const replacement = Array.from(
        this.#shadow.querySelectorAll<HTMLElement>('[data-focus-key]'),
      ).find((candidate) => candidate.dataset.focusKey === focusKey)
      replacement?.focus({ preventScroll: true })
      if (
        selectionStart !== null &&
        replacement &&
        'setSelectionRange' in replacement
      ) {
        try {
          ;(replacement as HTMLInputElement).setSelectionRange(
            selectionStart,
            selectionStart,
          )
        } catch {
          /* search inputs do not support it */
        }
      }
    }
  }
}

/** Idempotent: a page that loads the bundle twice must not throw. */
export function defineMarginElements(
  registry: CustomElementRegistry | undefined = globalThis.customElements,
) {
  if (!registry || registry.get(MARGIN_RAIL_TAG)) return
  registry.define(MARGIN_RAIL_TAG, MarginRailElement)
}
