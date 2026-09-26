/**
 * `<margin-rail>`: the package as a custom element.
 *
 * Everything it draws lives in a shadow root, so the host page gets no styles
 * from it and it gets none from the host. It has no framework dependency: the
 * React wrapper is a separate entry point that mounts this same element.
 *
 * It holds annotations in memory and, when given a transport, keeps them in the
 * service: it loads the document's annotations, saves new ones, and changes or
 * deletes the reader's own. With no transport it still works — selection,
 * painting, the rail and the orphan list are all client-side — which is what
 * makes it embeddable before a host has a service at all.
 *
 * What the reader gets:
 *
 * - Select text (pointer, or the keyboard mode below) and a popup opens beside
 *   it: a row of highlight roles, and a note field. Dismissing it saves nothing.
 * - The rail lists the document's annotations in document order, with a search
 *   box. An entry scrolls to and flashes its passage; clicking a painted passage
 *   focuses its entry.
 * - Every one of the reader's annotations shows its visibility and toggles it.
 *   A default decides the visibility of *new* annotations only.
 * - An annotation whose text is gone stays in the rail, marked, readable,
 *   editable and deletable. It is never hidden and never dropped.
 *
 * The visibility control is only half of the feature. The service's query is
 * the other half — a private annotation is never sent to anyone else — and the
 * rail never filters privacy in the browser, because hiding a row that was
 * delivered is not privacy.
 */
import type { TextAnnotation } from './anchor.js'
import {
  annotationsFromAnchors,
  createMarginController,
  type MarginController,
} from './controller.js'
import type { AnnotationPlacement } from './document.js'
import type { AnchorableBlock } from './dom/blocks.js'
import {
  returnFocusToText,
  startKeyboardSelection,
  type KeyboardSelection,
} from './dom/keyboard.js'
import { anchorsFromSelection, type SelectionCapture } from './dom/selection.js'
import { offsetForPoint, rangesForOffsets } from './dom/text-index.js'
import {
  DEFAULT_HIGHLIGHT_ROLE,
  HIGHLIGHT_ROLE_LABELS,
  HIGHLIGHT_ROLES,
  NOTE_PAINT,
  ROLE_PALETTE,
  highlightRole,
  type HighlightRole,
} from './palette.js'
import {
  DEFAULT_VISIBILITY,
  recordFromWebAnnotation,
  serverIdFromIri,
  type MarginVisibility,
  type RailRecord,
} from './records.js'
import {
  MarginTransportError,
  createHttpTransport,
  createMarginClient,
  type MarginClient,
  type MarginResponse,
  type MarginTransport,
} from './transport.js'

export const MARGIN_RAIL_TAG = 'margin-rail'

/** How many pages of annotations a load follows before it stops asking. */
const MAX_LOAD_PAGES = 20
const FLASH_MS = 1200

const ROLE_SWATCHES = HIGHLIGHT_ROLES.map(
  (role) =>
    `--margin-role-${role}: var(--margin-highlight-${role}, ${ROLE_PALETTE[role]});`,
).join(' ')

const STYLES = `
:host { display: block; font: inherit; color: inherit; ${ROLE_SWATCHES} --margin-role-note: ${NOTE_PAINT}; }
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
.panel { display: grid; gap: 0.75rem; }
.panel[data-overlay] { position: fixed; top: 0; right: 0; bottom: 0; z-index: 50; width: min(22rem, 100vw); overflow-y: auto; padding: 1rem; background: var(--margin-surface, Canvas); color: var(--margin-ink, CanvasText); box-shadow: -8px 0 24px rgb(0 0 0 / 0.18); }
.panel[data-overlay][data-closed] { display: none; }
.toggle { position: fixed; right: 1rem; bottom: 1rem; z-index: 40; background: var(--margin-surface, Canvas); color: var(--margin-ink, CanvasText); box-shadow: 0 2px 10px rgb(0 0 0 / 0.2); }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
li { border-left: 3px solid var(--swatch, currentColor); padding: 0.25rem 0 0.25rem 0.6rem; font-size: 0.8125rem; line-height: 1.45; }
li[data-orphaned] { border-left-style: dashed; }
li:focus-within { outline: 1px dotted currentColor; outline-offset: 2px; }
.reason, .meta { display: block; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.04em; }
.quote { display: block; text-align: left; width: 100%; border: 0; padding: 0; font-style: italic; }
button.quote:hover { text-decoration: underline; }
.body { display: block; margin: 0.25rem 0 0; white-space: pre-wrap; }
.controls { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.35rem; }
.empty, .notice { font-size: 0.8125rem; margin: 0; }
.notice { font-size: 0.75rem; }
button, input, textarea { font: inherit; color: inherit; }
button { font-size: 0.8125rem; cursor: pointer; background: none; border: 1px solid currentColor; border-radius: 0.25rem; padding: 0.2rem 0.55rem; }
button.quote { border: 0; padding: 0; font-size: inherit; }
button[disabled] { cursor: default; opacity: 0.55; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; font-size: 0.8125rem; }
legend { padding: 0; margin-bottom: 0.25rem; font-size: 0.75rem; }
label { font-size: 0.75rem; display: grid; gap: 0.2rem; }
input[type=search], textarea { width: 100%; background: transparent; border: 1px solid currentColor; border-radius: 0.25rem; padding: 0.3rem 0.45rem; font-size: 0.8125rem; }
textarea { min-height: 4.5rem; resize: vertical; }
.popup { position: fixed; z-index: 60; width: min(20rem, calc(100vw - 2rem)); display: grid; gap: 0.6rem; padding: 0.75rem; border: 1px solid currentColor; border-radius: 0.4rem; background: var(--margin-surface, Canvas); color: var(--margin-ink, CanvasText); box-shadow: 0 6px 24px rgb(0 0 0 / 0.2); }
.popup[hidden] { display: none; }
.popup .title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.swatches { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.swatch { display: inline-flex; align-items: center; gap: 0.35rem; }
.swatch::before, .chip::before { content: ''; width: 0.8rem; height: 0.8rem; border-radius: 999px; background: var(--swatch); border: 1px solid currentColor; }
.chip { display: inline-flex; align-items: center; gap: 0.3rem; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`

const ORPHAN_LABELS: Record<string, string> = {
  ambiguous: 'orphaned — the quote is no longer unique',
  'missing-node': 'orphaned — the block is gone',
  'non-text-node': 'orphaned — the block has no text',
  'quote-not-found': 'orphaned — the quote was removed',
}

type PopupState = {
  anchors: Extract<SelectionCapture, { status: 'captured' }>['anchors']
  range: Range | null
  /** Where focus goes back to when the popup closes. */
  returnTo: Element | null
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

function isSuccess(response: MarginResponse) {
  return response.status >= 200 && response.status < 300
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Partial<Record<string, string>> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  for (const [name, value] of Object.entries(props)) {
    if (value !== undefined) node.setAttribute(name, value)
  }
  if (text !== undefined) node.textContent = text
  return node
}

export class MarginRailElement extends ElementBase {
  static observedAttributes = [
    'document-uri',
    'text-selector',
    'api-base',
    'collapse-below',
  ]

  #controller: MarginController | null = null
  #records: RailRecord[] = []
  #placements: AnnotationPlacement[] = []
  #capture: SelectionCapture = { status: 'empty' }
  #transport: MarginTransport | null = null
  /** Whether `#transport` is one this element built from `api-base`. */
  #ownsTransport = false
  #defaultVisibility: MarginVisibility = DEFAULT_VISIBILITY
  /** The service's name for this reader, once it has told us. */
  #viewer: string | null = null
  #query = ''
  #notice = ''
  #editing: string | null = null
  /**
   * What the reader has typed but not saved. The rail is rebuilt from state, so
   * text that lived only in a control would be lost to the next rebuild — a
   * selection change is enough to trigger one.
   */
  #noteDraft = ''
  #editDraft = ''
  #popup: PopupState | null = null
  /** The entry the last click on painted text went to, for cycling overlaps. */
  #lastPointed: string | null = null
  #keyboard: KeyboardSelection | null = null
  #compact = false
  #overlayOpen = false
  #media: MediaQueryList | null = null
  #loadGeneration = 0
  #flashTimer = 0
  #listeners: (() => void)[] = []
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
    return this.#records.map((record) => record.annotation)
  }

  /**
   * Annotations the host supplies directly. They are the reader's own and take
   * the current default visibility — except one already in the rail, which
   * keeps whatever visibility it has: setting the list is not a reason to
   * change anybody's privacy.
   */
  set annotations(next: readonly TextAnnotation[]) {
    const known = new Map(
      this.#records.map((record) => [record.annotation.id, record]),
    )
    this.#records = next.map(
      (annotation) =>
        known.get(annotation.id) ?? {
          annotation,
          visibility: this.#defaultVisibility,
          mine: true,
          serverId: null,
        },
    )
    this.#paint()
  }

  /** What the rail holds, with visibility and ownership. */
  get records(): readonly RailRecord[] {
    return this.#records
  }

  get defaultVisibility(): MarginVisibility {
    return this.#defaultVisibility
  }

  /** The seam. Set this to point the rail at any host, or at a stub. */
  set transport(next: MarginTransport | null) {
    this.#transport = next
    this.#ownsTransport = false
    if (this.isConnected) void this.#load()
  }

  get transport(): MarginTransport | null {
    return this.#transport
  }

  /**
   * Set on first connection. An upgrading element gets one
   * `attributeChangedCallback` per attribute *before* `connectedCallback`, while
   * already connected — so without this it attached, loaded and detached once
   * per attribute before attaching for real.
   */
  #started = false

  connectedCallback() {
    this.#started = true
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
    if (previous === next || !this.isConnected || !this.#started) return
    if (name === 'document-uri') {
      // A different document is a different set of annotations. Keeping the old
      // ones would paint one document's highlights onto another.
      this.#records = []
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
    this.#watchLayout()
    const selector =
      this.getAttribute('text-selector') ?? '[data-reading-column="text"]'
    const root = this.ownerDocument.querySelector(selector)
    if (!root) {
      // Nothing to annotate, but the rail still draws: a blank column says
      // less than a rail that says there is nothing here.
      this.#render()
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
        // Focusing one of the rail's own controls fires `selectionchange` too,
        // and a redraw re-focuses — so redrawing on every report is a loop that
        // never lets the rail settle. Only a different capture is news.
        const changed = captureKey(capture) !== captureKey(this.#capture)
        this.#capture = capture
        if (changed) this.#render()
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
    this.#listen(root)
    this.#paint()
    void this.#load()
  }

  disconnectedCallback() {
    this.#detach()
  }

  #detach() {
    this.#closePopup({ restoreFocus: false })
    this.#stopKeyboard()
    for (const remove of this.#listeners.splice(0)) remove()
    this.#controller?.stop()
    this.#controller = null
    this.#clearFlash()
  }

  #on<T extends Event>(
    target: EventTarget,
    type: string,
    handler: (event: T) => void,
    options?: AddEventListenerOptions,
  ) {
    const listener = handler as EventListener
    target.addEventListener(type, listener, options)
    this.#listeners.push(() =>
      target.removeEventListener(type, listener, options),
    )
  }

  /**
   * The document-level listeners: a finished pointer selection opens the
   * popup, a click on a painted passage focuses its entry, and a press outside
   * an open popup dismisses it.
   */
  #listen(root: Element) {
    const doc = this.ownerDocument
    const inside = (event: Event) => event.composedPath().includes(this)

    this.#on<PointerEvent>(doc, 'pointerup', (event) => {
      if (inside(event) || !root.contains(event.target as Node)) return
      // After this event's own selection update, not before it.
      queueMicrotask(() => this.#maybeOpenPopup())
    })
    this.#on<KeyboardEvent>(doc, 'keyup', (event) => {
      // Shift released after extending a selection by keyboard — the path a
      // reader with the browser's caret browsing on takes. The margin's own
      // keyboard mode commits with Enter instead.
      if (event.key !== 'Shift' || this.#keyboard || inside(event)) return
      if (!root.contains(doc.getSelection()?.anchorNode ?? null)) return
      this.#maybeOpenPopup()
    })
    this.#on<PointerEvent>(doc, 'pointerdown', (event) => {
      if (this.#popup && !inside(event))
        this.#closePopup({ restoreFocus: false })
    })
    this.#on<MouseEvent>(root, 'click', (event) => {
      const selection = doc.getSelection()
      if (selection && !selection.isCollapsed) return
      this.#focusEntryAtPoint(event.clientX, event.clientY)
    })
  }

  #watchLayout() {
    const below = Number(this.getAttribute('collapse-below'))
    const view = this.ownerDocument.defaultView
    if (!below || !view?.matchMedia) {
      this.#compact = false
      return
    }
    this.#media = view.matchMedia(`(max-width: ${below - 0.02}px)`)
    this.#compact = this.#media.matches
    this.#on<MediaQueryListEvent>(this.#media, 'change', (event) => {
      this.#compact = event.matches
      this.#overlayOpen = false
      this.#render()
    })
  }

  /* ------------------------------------------------------------------ */
  /* The service                                                        */
  /* ------------------------------------------------------------------ */

  #client(): MarginClient | null {
    return this.#transport ? createMarginClient(this.#transport) : null
  }

  /**
   * The document's annotations and the reader's default.
   *
   * A reader who is not signed in gets a 401 from `/prefs`; that is not an
   * error, it is a reader who can read public annotations and whose own stay
   * on this page until they sign in.
   */
  async #load() {
    const client = this.#client()
    const documentUri = this.documentUri
    if (!client || !documentUri) return
    const generation = (this.#loadGeneration += 1)
    try {
      const prefs = await client.readPrefs()
      if (generation !== this.#loadGeneration) return
      if (isSuccess(prefs)) {
        const body = prefs.body as {
          defaultVisibility?: string
          creator?: string
        }
        this.#viewer = typeof body?.creator === 'string' ? body.creator : null
        if (
          body?.defaultVisibility === 'public' ||
          body?.defaultVisibility === 'private'
        ) {
          this.#defaultVisibility = body.defaultVisibility
        }
      }

      const loaded: RailRecord[] = []
      let response = await client.listAnnotations(documentUri)
      for (let page = 0; page < MAX_LOAD_PAGES; page += 1) {
        if (generation !== this.#loadGeneration) return
        if (!isSuccess(response)) {
          throw new MarginTransportError(
            'the margin service refused the list',
            [response],
          )
        }
        const body = response.body as {
          annotations?: unknown[]
          nextCursor?: string
        }
        for (const wire of body?.annotations ?? []) {
          const record = recordFromWebAnnotation(wire, this.#viewer)
          if (record) loaded.push(record)
        }
        if (!body?.nextCursor) break
        response = await client.listAnnotationsAfter(
          documentUri,
          body.nextCursor,
        )
      }
      if (generation !== this.#loadGeneration) return
      // Anything made on this page before the load finished and not yet saved
      // stays; everything the service knows comes from the service.
      const pending = this.#records.filter((record) => record.serverId === null)
      this.#records = [...loaded, ...pending]
      this.#paint()
    } catch (error) {
      // A 404 is a page with no service mounted behind it — the dev server, a
      // static preview. That is not something to warn a reader about; the rail
      // works in memory there, as it does with no transport at all.
      const absent =
        error instanceof MarginTransportError &&
        error.responses.every((response) => response.status === 404)
      this.#reportTransportFailure(
        error,
        absent ? undefined : 'Could not load annotations for this page.',
      )
    }
  }

  async #publish(created: readonly RailRecord[]) {
    const client = this.#client()
    if (!client || created.length === 0) return
    try {
      const first = created[0].annotation
      const common = {
        documentUri: this.documentUri,
        visibility: created[0].visibility,
        targets: created.map((record) => record.annotation.target),
        targetTexts: created.map((record) => {
          const text = this.#controller
            ?.blocks()
            .find((block) => block.id === record.annotation.target.nodeId)?.text
          if (text === undefined)
            throw new Error(
              `Full text unavailable for ${record.annotation.target.nodeId}`,
            )
          return text
        }),
      }
      const responses = await client.createAnnotations(
        first.kind === 'highlight'
          ? { ...common, kind: 'highlight', color: first.appearance.color }
          : { ...common, kind: first.kind, body: first.body },
      )
      responses.forEach((response, index) => {
        const id = (response.body as { id?: unknown } | null)?.id
        if (isSuccess(response) && typeof id === 'string') {
          created[index].serverId = serverIdFromIri(id)
        }
      })
      // A transport resolves with whatever status it got: an HTTP error is a
      // value here, not a throw. Treating it as success meant a 401, a 429 or a
      // 500 left the annotation in memory only, to disappear on reload with
      // nothing having said so.
      const refused = responses.filter((response) => !isSuccess(response))
      if (refused.length > 0) {
        this.#reportTransportFailure(
          new MarginTransportError(
            `the margin service refused ${refused.length} of ${responses.length} annotations`,
            refused,
          ),
          refused.some((response) => response.status === 401)
            ? 'Not saved: sign in to keep annotations beyond this page.'
            : 'Not saved: the margin service refused it. It stays on this page only.',
        )
      }
    } catch (error) {
      this.#reportTransportFailure(
        error,
        'Not saved: the margin service is unreachable. It stays on this page only.',
      )
    }
  }

  /**
   * A service that is down must not cost the reader their highlight: it is
   * already painted and already in the rail. Say so and keep going.
   */
  #reportTransportFailure(error: unknown, notice?: string) {
    if (notice) {
      this.#notice = notice
      this.#render()
    }
    this.dispatchEvent(
      new CustomEvent('margin-transport-error', {
        detail: error,
        bubbles: true,
        composed: true,
      }),
    )
  }

  /* ------------------------------------------------------------------ */
  /* Creating                                                           */
  /* ------------------------------------------------------------------ */

  /** Turn the live selection into highlights. Returns what it created. */
  highlightSelection(color: string = DEFAULT_HIGHLIGHT_ROLE): TextAnnotation[] {
    if (this.#capture.status !== 'captured') return []
    const anchors = this.#capture.anchors
    this.#capture = { status: 'empty' }
    this.ownerDocument.getSelection()?.removeAllRanges()
    return this.#create(anchors, { kind: 'highlight', color })
  }

  /** Attach a note to the live selection. Returns what it created. */
  noteSelection(body: string): TextAnnotation[] {
    if (this.#capture.status !== 'captured' || !body.trim()) return []
    const anchors = this.#capture.anchors
    this.#capture = { status: 'empty' }
    this.ownerDocument.getSelection()?.removeAllRanges()
    return this.#create(anchors, { kind: 'note', body: body.trim() })
  }

  #create(
    anchors: PopupState['anchors'],
    input:
      { kind: 'highlight'; color: string } | { kind: 'note'; body: string },
  ): TextAnnotation[] {
    const created = annotationsFromAnchors(anchors, input)
    // The default is read now, at creation, and written onto the record. A later
    // change of default therefore has nothing to reach back into.
    const records = created.map((annotation) => ({
      annotation,
      visibility: this.#defaultVisibility,
      mine: true,
      serverId: null,
    }))
    this.#records = [...this.#records, ...records]
    this.#notice = ''
    this.#paint()
    this.dispatchEvent(
      new CustomEvent('margin-annotations-created', {
        detail: created,
        bubbles: true,
        composed: true,
      }),
    )
    void this.#publish(records)
    return created
  }

  /* ------------------------------------------------------------------ */
  /* Changing                                                           */
  /* ------------------------------------------------------------------ */

  #find(id: string) {
    return this.#records.find((record) => record.annotation.id === id)
  }

  /**
   * Flip one annotation's visibility, and only that one. Immediate in the rail;
   * put back if the service refuses, so the rail never claims a state the
   * service does not hold.
   */
  async setVisibility(id: string, visibility: MarginVisibility) {
    const record = this.#find(id)
    if (!record || !record.mine || record.visibility === visibility) return
    const previous = record.visibility
    record.visibility = visibility
    this.#render()
    const client = this.#client()
    if (!client || !record.serverId) return
    try {
      const response = await client.updateAnnotation(
        record.serverId,
        this.documentUri,
        { visibility },
      )
      if (!isSuccess(response)) {
        throw new MarginTransportError(
          'the margin service refused the change',
          [response],
        )
      }
    } catch (error) {
      record.visibility = previous
      this.#reportTransportFailure(
        error,
        'Visibility was not changed: the service refused it.',
      )
    }
  }

  /** Only new annotations take the default; existing ones are not touched. */
  async setDefaultVisibility(visibility: MarginVisibility) {
    if (visibility === this.#defaultVisibility) return
    const previous = this.#defaultVisibility
    this.#defaultVisibility = visibility
    this.#render()
    const client = this.#client()
    if (!client || !this.#viewer) return
    try {
      const response = await client.writePrefs(visibility)
      if (!isSuccess(response)) {
        throw new MarginTransportError(
          'the margin service refused the default',
          [response],
        )
      }
    } catch (error) {
      this.#defaultVisibility = previous
      this.#reportTransportFailure(error, 'The default was not saved.')
    }
  }

  async editNote(id: string, body: string) {
    const record = this.#find(id)
    const text = body.trim()
    if (!record || !record.mine || record.annotation.kind !== 'note' || !text)
      return
    const previous = record.annotation
    record.annotation = { ...previous, body: text }
    this.#editing = null
    this.#paint()
    const client = this.#client()
    if (!client || !record.serverId) return
    try {
      const response = await client.updateAnnotation(
        record.serverId,
        this.documentUri,
        { body: text },
      )
      if (!isSuccess(response)) {
        throw new MarginTransportError('the margin service refused the edit', [
          response,
        ])
      }
    } catch (error) {
      record.annotation = previous
      this.#reportTransportFailure(
        error,
        'The note was not changed: the service refused it.',
      )
    }
  }

  async deleteAnnotation(id: string) {
    const record = this.#find(id)
    if (!record || !record.mine) return
    const client = this.#client()
    if (client && record.serverId) {
      try {
        const response = await client.deleteAnnotation(
          record.serverId,
          this.documentUri,
        )
        if (!isSuccess(response)) {
          throw new MarginTransportError(
            'the margin service refused the delete',
            [response],
          )
        }
      } catch (error) {
        const replies =
          error instanceof MarginTransportError &&
          error.responses.some((response) => response.status === 409)
        this.#reportTransportFailure(
          error,
          replies
            ? 'Not deleted: other readers have replied to it.'
            : 'Not deleted: the service refused it.',
        )
        return
      }
    }
    const position = this.#visibleRecords().findIndex(
      (entry) => entry.annotation.id === id,
    )
    this.#records = this.#records.filter((entry) => entry !== record)
    this.#paint()
    // Focus goes to the entry that took its place, or the search box, never
    // to the top of the document.
    const next =
      this.#visibleRecords()[
        Math.min(position, this.#visibleRecords().length - 1)
      ]
    this.#focusKey(next ? `goto:${next.annotation.id}` : 'search')
  }

  /* ------------------------------------------------------------------ */
  /* The popup                                                          */
  /* ------------------------------------------------------------------ */

  #maybeOpenPopup() {
    if (!this.#controller || this.#popup) return
    const doc = this.ownerDocument
    const selection = doc.getSelection()
    const capture = anchorsFromSelection(selection, this.#controller.blocks())
    if (capture.status !== 'captured') return
    this.#capture = capture
    this.#openPopup(
      capture.anchors,
      selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null,
    )
  }

  #openPopup(anchors: PopupState['anchors'], range: Range | null) {
    const doc = this.ownerDocument
    this.#noteDraft = ''
    this.#popup = {
      anchors,
      range,
      returnTo:
        doc.activeElement && doc.activeElement !== doc.body
          ? doc.activeElement
          : null,
    }
    this.#render()
    this.#focusKey(`swatch:${DEFAULT_HIGHLIGHT_ROLE}`)
  }

  #closePopup({ restoreFocus }: { restoreFocus: boolean }) {
    const popup = this.#popup
    if (!popup) return
    this.#popup = null
    this.#render()
    if (!restoreFocus) return
    const block = this.#blockFor(
      popup.anchors[popup.anchors.length - 1]?.nodeId,
    )
    if (block) {
      returnFocusToText(block.element, popup.range)
    } else if (popup.returnTo instanceof HTMLElement) {
      popup.returnTo.focus()
    }
  }

  #savePopup(
    input:
      { kind: 'highlight'; color: string } | { kind: 'note'; body: string },
  ) {
    const popup = this.#popup
    if (!popup) return
    if (input.kind === 'note' && !input.body.trim()) return
    this.#create(
      popup.anchors,
      input.kind === 'note' ? { kind: 'note', body: input.body.trim() } : input,
    )
    this.#capture = { status: 'empty' }
    this.#closePopup({ restoreFocus: true })
  }

  /**
   * Near the selection when it has a box on screen. A selection that spans a
   * scroll boundary, or has scrolled out of view, has no box worth pointing
   * at, so the popup anchors to the rail's edge instead.
   */
  #popupPosition(range: Range | null): { top: number; left: number } {
    const view = this.ownerDocument.defaultView
    const width = view?.innerWidth ?? 1024
    const height = view?.innerHeight ?? 768
    const rects = range ? Array.from(range.getClientRects()) : []
    const last = rects[rects.length - 1]
    if (last && last.bottom > 0 && last.top < height) {
      const top =
        last.bottom + 8 + 260 > height
          ? Math.max(8, last.top - 268)
          : last.bottom + 8
      return {
        top,
        left: Math.min(Math.max(8, last.left), Math.max(8, width - 336)),
      }
    }
    return { top: 80, left: Math.max(8, width - 344) }
  }

  /* ------------------------------------------------------------------ */
  /* Keyboard selection                                                 */
  /* ------------------------------------------------------------------ */

  startKeyboardSelection() {
    if (!this.#controller) return
    this.#stopKeyboard()
    this.#overlayOpen = false
    this.#keyboard = startKeyboardSelection({
      blocks: () => this.#controller?.blocks() ?? [],
      onCommit: () => {
        const capture = anchorsFromSelection(
          this.ownerDocument.getSelection(),
          this.#controller?.blocks() ?? [],
        )
        if (capture.status !== 'captured') return
        const selection = this.ownerDocument.getSelection()
        const range = selection?.rangeCount
          ? selection.getRangeAt(0).cloneRange()
          : null
        this.#stopKeyboard({ keepFocus: true })
        this.#capture = capture
        this.#openPopup(capture.anchors, range)
      },
      onExit: () => {
        this.#stopKeyboard()
        this.#focusKey('keyboard-select')
      },
    })
    this.#render()
  }

  #stopKeyboard(options?: { keepFocus?: boolean }) {
    this.#keyboard?.stop(options)
    this.#keyboard = null
  }

  /* ------------------------------------------------------------------ */
  /* Rail ↔ text                                                        */
  /* ------------------------------------------------------------------ */

  #blockFor(nodeId: string | undefined): AnchorableBlock | undefined {
    return this.#controller?.blocks().find((block) => block.id === nodeId)
  }

  /** Scroll a passage into view and flash it, without touching its markup. */
  #goTo(id: string) {
    const entry = this.#placements.find((item) => item.annotation.id === id)
    if (!entry || entry.placement.status !== 'anchored') return
    const block = this.#blockFor(entry.placement.nodeId)
    if (!block) return
    const ranges = rangesForOffsets(
      block.index,
      entry.placement.start,
      entry.placement.end,
    )
    const view = this.ownerDocument.defaultView
    const reduced = view?.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches
    ;(ranges[0]?.startContainer.parentElement ?? block.element).scrollIntoView({
      block: 'center',
      behavior: reduced ? 'auto' : 'smooth',
    })
    this.#flash(ranges)
    if (this.#compact) this.#overlayOpen = false
    this.#render()
  }

  #flashName() {
    return `erniesg-margin-flash-${this.#namespace}`
  }

  #flash(ranges: Range[]) {
    const view = this.ownerDocument.defaultView as
      | (Window & {
          CSS?: { highlights?: Map<string, unknown> }
          Highlight?: new (...ranges: Range[]) => unknown
        })
      | null
    this.#clearFlash()
    const name = this.#flashName()
    this.setAttribute('data-flashing', '')
    if (view?.CSS?.highlights && view.Highlight && ranges.length) {
      const doc = this.ownerDocument
      if (!doc.querySelector(`style[data-margin-flash="${name}"]`)) {
        const style = doc.createElement('style')
        style.dataset.marginFlash = name
        style.textContent = `::highlight(${name}) { background-color: rgba(250, 204, 21, 0.85); color: inherit; }`
        doc.head.append(style)
      }
      view.CSS.highlights.set(name, new view.Highlight(...ranges))
    }
    this.#flashTimer = (view ?? globalThis).setTimeout(
      () => this.#clearFlash(),
      FLASH_MS,
    ) as unknown as number
  }

  #clearFlash() {
    const view = this.ownerDocument?.defaultView as
      (Window & { CSS?: { highlights?: Map<string, unknown> } }) | null
    if (this.#flashTimer) (view ?? globalThis).clearTimeout(this.#flashTimer)
    this.#flashTimer = 0
    view?.CSS?.highlights?.delete(this.#flashName())
    this.removeAttribute('data-flashing')
  }

  /**
   * A click on painted text focuses the entry for it. Where highlights
   * overlap, the narrowest wins, and clicking again moves to the next one —
   * so every one of an overlapping pair can be reached.
   */
  #focusEntryAtPoint(x: number, y: number) {
    const doc = this.ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null
    }
    const position = doc.caretPositionFromPoint?.(x, y)
    const caret = position
      ? { node: position.offsetNode, offset: position.offset }
      : (() => {
          const range = doc.caretRangeFromPoint?.(x, y)
          return range
            ? { node: range.startContainer, offset: range.startOffset }
            : null
        })()
    if (!caret) return
    const block = this.#controller
      ?.blocks()
      .find((candidate) => candidate.element.contains(caret.node))
    if (!block) return
    const offset = offsetForPoint(block.index, caret.node, caret.offset)
    const hits = this.#placements
      .filter(
        ({ placement }) =>
          placement.status === 'anchored' &&
          placement.nodeId === block.id &&
          placement.start <= offset &&
          offset < placement.end,
      )
      .sort((a, b) => span(a) - span(b))
    if (hits.length === 0) return
    // Remembered rather than read off focus: pressing on the text again has
    // already taken focus out of the rail by the time this click arrives.
    const current = hits.findIndex(
      (hit) => hit.annotation.id === this.#lastPointed,
    )
    const target = hits[(current + 1) % hits.length]
    this.#lastPointed = target.annotation.id
    if (
      !this.#visibleRecords().some(
        (record) => record.annotation.id === target.annotation.id,
      )
    ) {
      this.#query = ''
    }
    if (this.#compact) this.#overlayOpen = true
    this.#render()
    this.#focusKey(`goto:${target.annotation.id}`)
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  #paint() {
    this.#placements = this.#controller?.render(this.annotations) ?? []
    this.#render()
  }

  /** Records in document order: block order first, then offset in the block. */
  #ordered(): {
    record: RailRecord
    placement: AnnotationPlacement['placement'] | null
  }[] {
    const blockOrder = new Map(
      (this.#controller?.blocks() ?? []).map((block, index) => [
        block.id,
        index,
      ]),
    )
    const placementById = new Map(
      this.#placements.map((item) => [item.annotation.id, item.placement]),
    )
    return this.#records
      .map((record, index) => {
        const placement = placementById.get(record.annotation.id) ?? null
        const nodeId = placement?.nodeId ?? record.annotation.target.nodeId
        return {
          record,
          placement,
          key: [
            blockOrder.get(nodeId) ?? Number.MAX_SAFE_INTEGER,
            placement?.status === 'anchored'
              ? placement.start
              : record.annotation.target.position.start,
            index,
          ],
        }
      })
      .sort(
        (a, b) =>
          a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2],
      )
  }

  #visibleRecords(): RailRecord[] {
    const query = this.#query.trim().toLocaleLowerCase()
    return this.#ordered()
      .map((item) => item.record)
      .filter((record) => {
        if (!query) return true
        const body =
          record.annotation.kind === 'highlight' ? '' : record.annotation.body
        return `${record.annotation.target.quote.exact}\n${body}`
          .toLocaleLowerCase()
          .includes(query)
      })
  }

  #focusKey(key: string) {
    const target = this.#shadow.querySelector<HTMLElement>(
      `[data-focus-key="${CSS.escape(key)}"]`,
    )
    target?.focus()
  }

  /**
   * Redraw, keeping focus where it was.
   *
   * The whole rail is rebuilt from state, which is simple and keeps the DOM
   * honest, but a rebuilt control is a new control: without this a reader who
   * toggled a visibility would find focus thrown back to the page.
   */
  #render() {
    const container = this.#shadow.lastElementChild
    if (!container) return
    const active = this.#shadow.activeElement as HTMLElement | null
    const activeKey = active?.getAttribute('data-focus-key') ?? null
    const caret = isTextField(active)
      ? ([active.selectionStart, active.selectionEnd, active.value] as const)
      : null

    container.replaceChildren(...this.#build())

    if (activeKey) {
      const next = this.#shadow.querySelector<HTMLElement>(
        `[data-focus-key="${CSS.escape(activeKey)}"]`,
      )
      if (next) {
        next.focus({ preventScroll: true })
        // Only a text field has a caret. `setSelectionRange` on a radio throws,
        // and a throw here left the default-visibility change unsaved.
        if (caret && isTextField(next)) {
          next.value = caret[2]
          next.setSelectionRange(caret[0], caret[1])
        }
      }
    }
  }

  #build(): Node[] {
    const doc = this.ownerDocument
    const nodes: Node[] = []
    const total = this.#records.length

    if (this.#compact) {
      const toggle = el(
        doc,
        'button',
        {
          type: 'button',
          class: 'toggle',
          'aria-expanded': String(this.#overlayOpen),
          'aria-controls': 'margin-panel',
          'data-margin-action': 'toggle-rail',
          'data-focus-key': 'toggle-rail',
        },
        total ? `Margin (${total})` : 'Margin',
      )
      toggle.addEventListener('click', () => {
        this.#overlayOpen = !this.#overlayOpen
        this.#render()
        if (this.#overlayOpen) this.#focusKey('search')
      })
      nodes.push(toggle)
    }

    const panel = el(doc, 'div', { class: 'panel', id: 'margin-panel' })
    if (this.#compact) {
      panel.setAttribute('data-overlay', '')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', 'Margin')
      if (!this.#overlayOpen) panel.setAttribute('data-closed', '')
      panel.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || this.#popup) return
        this.#overlayOpen = false
        this.#render()
        this.#focusKey('toggle-rail')
      })
    }
    nodes.push(panel)

    const actions = el(doc, 'div', { class: 'actions' })
    const highlight = el(
      doc,
      'button',
      {
        type: 'button',
        'data-margin-action': 'highlight',
        'data-focus-key': 'highlight',
      },
      'Highlight selection',
    )
    highlight.disabled = this.#capture.status !== 'captured'
    highlight.addEventListener('click', () => this.highlightSelection())
    const keyboard = el(
      doc,
      'button',
      {
        type: 'button',
        'data-margin-action': 'keyboard-select',
        'data-focus-key': 'keyboard-select',
        'aria-describedby': 'keyboard-help',
      },
      this.#keyboard ? 'Selecting…' : 'Select with keyboard',
    )
    keyboard.addEventListener('click', () => this.startKeyboardSelection())
    const help = el(
      doc,
      'span',
      { id: 'keyboard-help', class: 'sr-only' },
      'Arrow up and down move between paragraphs. Shift and arrow keys select; add Alt to select by word. Enter annotates the selection, Escape leaves.',
    )
    actions.append(highlight, keyboard, help)
    if (this.#compact) {
      const close = el(
        doc,
        'button',
        { type: 'button', 'data-focus-key': 'close-rail' },
        'Close',
      )
      close.addEventListener('click', () => {
        this.#overlayOpen = false
        this.#render()
        this.#focusKey('toggle-rail')
      })
      actions.append(close)
    }
    panel.append(actions)

    const live = el(doc, 'p', {
      class: 'notice',
      role: 'status',
      'data-margin-notice': this.#notice ? 'transport' : undefined,
    })
    live.textContent = this.#notice
    panel.append(live)

    if (this.#capture.status === 'non-annotatable') {
      panel.append(
        el(
          doc,
          'p',
          { class: 'notice', 'data-margin-notice': 'non-annotatable' },
          'That region is generated and cannot hold a durable anchor.',
        ),
      )
    }

    const defaults = el(doc, 'fieldset', {
      'data-margin-default-visibility': this.#defaultVisibility,
    })
    defaults.append(el(doc, 'legend', {}, 'New annotations are'))
    for (const value of ['private', 'public'] as const) {
      const label = el(doc, 'label', { class: 'chip-radio' })
      label.style.display = 'inline-flex'
      label.style.gap = '0.3rem'
      label.style.alignItems = 'center'
      const radio = el(doc, 'input', {
        type: 'radio',
        name: `default-visibility-${this.#namespace}`,
        value,
        'data-focus-key': `default:${value}`,
      })
      radio.checked = this.#defaultVisibility === value
      radio.addEventListener(
        'change',
        () => void this.setDefaultVisibility(value),
      )
      label.append(
        radio,
        doc.createTextNode(value === 'private' ? 'Private' : 'Public'),
      )
      defaults.append(label)
    }
    panel.append(defaults)

    const searchLabel = el(doc, 'label', {}, 'Search annotations')
    const search = el(doc, 'input', {
      type: 'search',
      'data-margin-search': '',
      'data-focus-key': 'search',
    })
    search.value = this.#query
    search.addEventListener('input', () => {
      this.#query = search.value
      this.#render()
    })
    searchLabel.append(search)
    panel.append(searchLabel)

    const visible = new Set(this.#visibleRecords())
    const ordered = this.#ordered().filter((item) => visible.has(item.record))
    if (ordered.length === 0) {
      panel.append(
        el(
          doc,
          'p',
          { class: 'empty' },
          total ? 'No annotations match.' : 'No annotations yet.',
        ),
      )
    } else {
      const list = el(doc, 'ul', { 'aria-label': 'Annotations' })
      for (const { record, placement } of ordered)
        list.append(this.#entry(record, placement))
      panel.append(list)
    }

    if (this.#popup) nodes.push(this.#buildPopup(this.#popup))
    return nodes
  }

  #entry(
    record: RailRecord,
    placement: AnnotationPlacement['placement'] | null,
  ): HTMLLIElement {
    const doc = this.ownerDocument
    const { annotation } = record
    const id = annotation.id
    const item = el(doc, 'li', {
      'data-margin-annotation': id,
      'data-kind': annotation.kind,
      'data-visibility': record.visibility,
    })
    const role =
      annotation.kind === 'highlight'
        ? highlightRole(annotation.appearance.color)
        : null
    item.style.setProperty(
      '--swatch',
      role ? `var(--margin-role-${role})` : 'var(--margin-role-note)',
    )

    const orphaned = placement?.status === 'orphaned' ? placement : null
    if (orphaned) {
      item.dataset.orphaned = orphaned.reason
      item.append(
        el(
          doc,
          'span',
          { class: 'reason' },
          ORPHAN_LABELS[orphaned.reason] ?? 'orphaned',
        ),
      )
    } else {
      item.append(
        el(
          doc,
          'span',
          { class: 'meta' },
          role
            ? HIGHLIGHT_ROLE_LABELS[role]
            : annotation.kind === 'note'
              ? 'Note'
              : 'Proposal',
        ),
      )
    }

    const quoteText = annotation.target.quote.exact
    if (orphaned) {
      item.append(el(doc, 'span', { class: 'quote' }, quoteText))
    } else {
      const quote = el(
        doc,
        'button',
        {
          type: 'button',
          class: 'quote',
          'data-focus-key': `goto:${id}`,
          'aria-label': `Go to: ${quoteText}`,
        },
        quoteText,
      )
      quote.addEventListener('click', () => this.#goTo(id))
      item.append(quote)
    }

    if (annotation.kind !== 'highlight') {
      if (this.#editing === id) {
        const label = el(doc, 'label', {}, 'Edit note')
        const field = el(doc, 'textarea', {
          'data-focus-key': `edit-field:${id}`,
        })
        field.value = this.#editDraft
        field.addEventListener('input', () => {
          this.#editDraft = field.value
        })
        label.append(field)
        const save = el(
          doc,
          'button',
          { type: 'button', 'data-focus-key': `edit-save:${id}` },
          'Save',
        )
        save.addEventListener('click', () => {
          void this.editNote(id, field.value).then(() =>
            this.#focusKey(`edit:${id}`),
          )
        })
        const cancel = el(
          doc,
          'button',
          { type: 'button', 'data-focus-key': `edit-cancel:${id}` },
          'Cancel',
        )
        cancel.addEventListener('click', () => {
          this.#editing = null
          this.#render()
          this.#focusKey(`edit:${id}`)
        })
        field.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            cancel.click()
          }
        })
        const controls = el(doc, 'div', { class: 'controls' })
        controls.append(save, cancel)
        item.append(label, controls)
      } else {
        item.append(el(doc, 'p', { class: 'body' }, annotation.body))
      }
    }

    const controls = el(doc, 'div', { class: 'controls' })
    const visibility = el(
      doc,
      'span',
      { class: 'meta', 'data-margin-visibility': record.visibility },
      record.visibility === 'public' ? 'Public' : 'Private',
    )
    if (record.mine) {
      const next: MarginVisibility =
        record.visibility === 'public' ? 'private' : 'public'
      const toggle = el(
        doc,
        'button',
        {
          type: 'button',
          'data-margin-action': 'visibility',
          'data-focus-key': `visibility:${id}`,
          'aria-label': `${record.visibility === 'public' ? 'Public' : 'Private'}. Make ${next}`,
        },
        record.visibility === 'public' ? 'Public' : 'Private',
      )
      toggle.addEventListener('click', () => void this.setVisibility(id, next))
      controls.append(toggle)
      if (annotation.kind === 'note' && this.#editing !== id) {
        const edit = el(
          doc,
          'button',
          {
            type: 'button',
            'data-margin-action': 'edit',
            'data-focus-key': `edit:${id}`,
          },
          'Edit',
        )
        edit.addEventListener('click', () => {
          this.#editing = id
          this.#editDraft = annotation.body
          this.#render()
          this.#focusKey(`edit-field:${id}`)
        })
        controls.append(edit)
      }
      const remove = el(
        doc,
        'button',
        {
          type: 'button',
          'data-margin-action': 'delete',
          'data-focus-key': `delete:${id}`,
          'aria-label': `Delete: ${quoteText}`,
        },
        'Delete',
      )
      remove.addEventListener('click', () => void this.deleteAnnotation(id))
      controls.append(remove)
    } else {
      controls.append(visibility)
    }
    item.append(controls)
    return item
  }

  #buildPopup(popup: PopupState): HTMLElement {
    const doc = this.ownerDocument
    const quote = popup.anchors.map((anchor) => anchor.quote.exact).join(' … ')
    const short = quote.length > 80 ? `${quote.slice(0, 77)}…` : quote
    const dialog = el(doc, 'div', {
      class: 'popup',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'margin-popup-title',
      'data-margin-popup': '',
    })
    const { top, left } = this.#popupPosition(popup.range)
    dialog.style.top = `${top}px`
    dialog.style.left = `${left}px`

    dialog.append(
      el(
        doc,
        'p',
        { class: 'title', id: 'margin-popup-title' },
        `Annotate “${short}”`,
      ),
    )

    const swatches = el(doc, 'div', {
      class: 'swatches',
      role: 'group',
      'aria-label': 'Highlight',
    })
    for (const role of HIGHLIGHT_ROLES) {
      const swatch = el(
        doc,
        'button',
        {
          type: 'button',
          class: 'swatch',
          'data-margin-swatch': role,
          'data-focus-key': `swatch:${role}`,
          'aria-label': `Highlight as ${HIGHLIGHT_ROLE_LABELS[role]}`,
        },
        HIGHLIGHT_ROLE_LABELS[role],
      )
      swatch.style.setProperty(
        '--swatch',
        `var(--margin-role-${role as HighlightRole})`,
      )
      swatch.addEventListener('click', () =>
        this.#savePopup({ kind: 'highlight', color: role }),
      )
      swatches.append(swatch)
    }
    dialog.append(swatches)

    const label = el(doc, 'label', {}, 'Note')
    const note = el(doc, 'textarea', {
      'data-margin-note': '',
      'data-focus-key': 'popup-note',
    })
    note.value = this.#noteDraft
    note.addEventListener('input', () => {
      this.#noteDraft = note.value
    })
    label.append(note)
    dialog.append(label)

    const controls = el(doc, 'div', { class: 'controls' })
    const save = el(
      doc,
      'button',
      {
        type: 'button',
        'data-margin-action': 'save-note',
        'data-focus-key': 'popup-save',
      },
      'Save note',
    )
    save.addEventListener('click', () =>
      this.#savePopup({ kind: 'note', body: note.value }),
    )
    const cancel = el(
      doc,
      'button',
      {
        type: 'button',
        'data-margin-action': 'cancel',
        'data-focus-key': 'popup-cancel',
      },
      'Cancel',
    )
    cancel.addEventListener('click', () =>
      this.#closePopup({ restoreFocus: true }),
    )
    controls.append(save, cancel)
    dialog.append(controls)

    // Focus stays inside while it is open: Tab from the last control wraps to
    // the first and Shift+Tab from the first to the last. Escape dismisses and
    // saves nothing.
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        this.#closePopup({ restoreFocus: true })
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button, textarea'),
      )
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const current = this.#shadow.activeElement
      if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    })
    return dialog
  }
}

function isTextField(
  element: Element | null,
): element is HTMLInputElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      ['text', 'search'].includes(element.type))
  )
}

function captureKey(capture: SelectionCapture): string {
  return capture.status === 'captured'
    ? `captured:${JSON.stringify(capture.anchors)}`
    : capture.status
}

function span(item: AnnotationPlacement) {
  return item.placement.status === 'anchored'
    ? item.placement.end - item.placement.start
    : Infinity
}

/** Idempotent: a page that loads the bundle twice must not throw. */
export function defineMarginElements(
  registry: CustomElementRegistry | undefined = globalThis.customElements,
) {
  if (!registry || registry.get(MARGIN_RAIL_TAG)) return
  registry.define(MARGIN_RAIL_TAG, MarginRailElement)
}
