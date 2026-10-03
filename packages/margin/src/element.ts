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
  isPaintedPlacement,
  type MarginController,
} from './controller.js'
import type { AnnotationPlacement } from './document.js'
import type { AnchorableBlock } from './dom/blocks.js'
import {
  returnFocusToText,
  startKeyboardSelection,
  type KeyboardSelection,
} from './dom/keyboard.js'
import { paintHighlights } from './dom/paint.js'
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
  DELETED_NOTE_TEXT,
  recordFromWebAnnotation,
  serverIdFromIri,
  type MarginVisibility,
  type RailRecord,
} from './records.js'
import {
  indexThreads,
  REPLY_FRAGMENT_PREFIX,
  replyFragment,
  replyFromWebAnnotation,
  UNNAMED_PARTICIPANT,
  type ThreadEntry,
  type ThreadReply,
} from './threads.js'
import {
  MarginTransportError,
  createHttpTransport,
  createMarginClient,
  type MarginClient,
  toWebAnnotation,
  type MarginResponse,
  type MarginTransport,
} from './transport.js'
import {
  createSketchSvg,
  decodeSketch,
  noteText,
  previewAspectRatio,
  updateSketchNote,
} from './sketch.js'

export const MARGIN_RAIL_TAG = 'margin-rail'

/** How many pages of annotations a load follows before it stops asking. */
const FLASH_MS = 1200
const LOAD_FAILED = 'Could not load annotations for this page.'
const PREFS_FAILED =
  'Could not load your margin settings; your annotations may show without their controls. Reload to try again.'
const FLASH_PAINT = 'rgba(250, 204, 21, 0.85)'

const ROLE_SWATCHES = HIGHLIGHT_ROLES.map(
  (role) =>
    `--margin-role-${role}: var(--margin-highlight-${role}, ${ROLE_PALETTE[role]});`,
).join(' ')

const STYLES = `
:host { display: block; font: inherit; color: inherit; ${ROLE_SWATCHES} --margin-role-note: ${NOTE_PAINT}; }
:host([hidden]) { display: none; }
@media print { :host { display: none; } }
* { box-sizing: border-box; }
.panel { display: grid; gap: 0.75rem; }
.panel[data-overlay] { position: fixed; top: 0; right: 0; bottom: 0; z-index: 50; align-content: start; width: min(22rem, 100vw); overflow-y: auto; padding: 1rem; background: var(--margin-surface, Canvas); color: var(--margin-ink, CanvasText); box-shadow: -8px 0 24px rgb(0 0 0 / 0.18); }
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
.sketch { display: block; width: min(100%, 12rem); aspect-ratio: 1; margin-top: 0.35rem; border: 1px solid currentColor; border-radius: 0.25rem; }
.controls { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.35rem; }
.empty, .notice { font-size: 0.8125rem; margin: 0; }
.notice { font-size: 0.75rem; }
button, input, textarea { font: inherit; color: inherit; }
button { font-size: 0.8125rem; cursor: pointer; background: none; border: 1px solid currentColor; border-radius: 0.25rem; padding: 0.2rem 0.55rem; }
button.quote { border: 0; padding: 0; font-size: inherit; }
button[disabled], button[aria-disabled='true'] { cursor: default; opacity: 0.55; }
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
.swatch[aria-pressed='true'] { background: color-mix(in srgb, var(--swatch) 35%, transparent); font-weight: 600; }
.swatch[aria-pressed='true']::before { box-shadow: 0 0 0 2px currentColor; }
button.primary:not([disabled]) { font-weight: 600; }
.swatch::before, .chip::before { content: ''; width: 0.8rem; height: 0.8rem; border-radius: 999px; background: var(--swatch); border: 1px solid currentColor; }
.chip { display: inline-flex; align-items: center; gap: 0.3rem; }
.thread { margin-top: 0.4rem; display: grid; gap: 0.4rem; }
.thread ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
.thread li { border-left-width: 1px; margin-left: calc(var(--indent, 1) * 0.6rem - 0.6rem); }
.thread li:target, .thread li:focus { outline: 2px solid currentColor; outline-offset: 2px; }
.author { font-weight: 600; }
.deleted { font-style: italic; opacity: 0.75; }
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
  /** A temporary `tabindex` keyboard mode handed over, for us to remove. */
  ownedTabIndex: Element | null
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

/** Give the normalized drawing its saved region's proportions in the rail. */
function sketchPreview(doc: Document, sketch: NonNullable<ReturnType<typeof decodeSketch>>): SVGSVGElement {
  const svg = createSketchSvg(sketch, doc)
  svg.setAttribute('class', 'sketch')
  svg.style.aspectRatio = previewAspectRatio(sketch.region)
  return svg
}

export class MarginRailElement extends ElementBase {
  static observedAttributes = [
    'document-uri',
    'text-selector',
    'api-base',
    'collapse-below',
    'collapsed',
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
  /** The role picked in the open popup, if any. Picking one never saves. */
  #roleDraft: string | null = null
  #editDraft = ''
  /** Replies to this document's notes, as the last load returned them. */
  #replies: ThreadReply[] = []
  /**
   * The thread index for `#replies`, built once per load rather than once per
   * root per render. `#replies` is only ever replaced, never mutated, so its
   * identity says when the index is stale.
   */
  #threadIndex: {
    replies: readonly ThreadReply[]
    index: ReturnType<typeof indexThreads>
  } | null = null
  /** The server id the open reply field answers, a note's or a reply's. */
  #replyingTo: string | null = null
  #replyDraft = ''
  /** The server id of the reply being edited. */
  #editingReply: string | null = null
  #replyEditDraft = ''
  /** A reply write is out: its controls wait for it. */
  #threadBusy = false
  #popup: PopupState | null = null
  /** The entry the last click on painted text went to, for cycling overlaps. */
  #lastPointed: string | null = null
  #keyboard: KeyboardSelection | null = null
  #compact = false
  #overlayOpen = false
  #media: MediaQueryList | null = null
  #loadGeneration = 0
  /** Settles once the reader's stored default is known (or known unknowable). */
  #prefsReady: Promise<void> = Promise.resolve()
  #prefsSettled = true
  /** Bumped by every local default change, so an older read cannot undo one. */
  #prefsRevision = 0
  /** The tail of the preference-write queue. */
  #prefsWrites: Promise<void> = Promise.resolve()
  /** The default the service is known to hold, for rolling back a refusal. */
  #savedDefault: MarginVisibility | null = null
  /** Records made before `#prefsReady` settled: their visibility is provisional. */
  /**
   * Records made before the stored default arrived, with the preference
   * revision current at creation. Only a record whose revision is still
   * current takes the loaded default; a later local change of default must
   * not reach back into it.
   */
  #provisional = new WeakMap<RailRecord, number>()
  /**
   * What the service is known to hold for each record, so a refused write
   * rolls the rail back to the truth rather than to its own last guess.
   */
  #confirmed = new WeakMap<
    RailRecord,
    { visibility: MarginVisibility; annotation: TextAnnotation }
  >()
  /** A logical clock, advanced by every write queued or finished. */
  #clock = 0
  /** When each record was last touched by a write, on `#clock`. */
  #touched = new WeakMap<RailRecord, number>()
  /** Records created on this page, with the save each is waiting on. */
  #saving = new WeakMap<RailRecord, Promise<void>>()
  /** The tail of each record's queue of writes after its create. */
  #writes = new WeakMap<RailRecord, Promise<void>>()
  /** How many writes each record has queued or running. */
  #inFlight = new WeakMap<RailRecord, number>()
  /** Writes queued or running per record and field. */
  #fieldWrites = new Map<string, number>()
  /** Records with a delete already on its way. */
  #deleting = new WeakSet<RailRecord>()
  /**
   * Server ids this page deleted. A load whose snapshot predates the delete
   * still lists the row; without this it would come back after being removed.
   */
  #deletedIds = new Set<string>()
  /** Default-visibility writes not yet finished. */
  #prefsWritesPending = new Map<MarginTransport | null, number>()
  #flashTimer = 0
  #unflash: (() => void) | null = null
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
    this.#records = next.map((annotation) => {
      const existing = known.get(annotation.id)
      if (existing) {
        // Same record — its visibility, owner and server id stay — but the
        // host's new value for the annotation itself wins: a controlled update
        // to a body or colour has to render.
        existing.annotation = annotation
        return existing
      }
      return {
        annotation,
        visibility: this.#defaultVisibility,
        mine: true,
        serverId: null,
      }
    })
    this.#paint()
  }

  /** Ask the configured transport for the document's current annotations. */
  async refreshFromService(): Promise<void> {
    await this.#load()
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
    if (next === this.#transport) {
      // The same connection again: a reload, nothing to forget.
      this.#loadGeneration += 1
      if (this.isConnected) void this.#load()
      return
    }
    this.#transport = next
    this.#ownsTransport = false
    // A request through the previous transport must not land after this —
    // least of all when `next` is null and no replacement load starts.
    this.#loadGeneration += 1
    // A different connection is a different backend or session. Its rows —
    // anything with a server id, or still being saved there — are not this
    // one's to show, own or write to; only purely local annotations stay.
    this.#records = this.#records.filter(
      (record) => record.serverId === null && !this.#saving.has(record),
    )
    this.#replies = []
    this.#viewer = null
    this.#deletedIds.clear()
    // The default belonged to that connection's reader too. Until the new one's
    // is read, new annotations take the private fallback, not the old reader's.
    this.#defaultVisibility = DEFAULT_VISIBILITY
    this.#savedDefault = null
    this.#paint()
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
      this.#replies = []
    }
    if (name === 'document-uri' || name === 'text-selector') {
      this.#capture = { status: 'empty' }
    }
    if (name === 'api-base') {
      // Only a transport this element made itself: one that was injected through
      // the `transport` setter belongs to the caller and is not ours to replace.
      // Through the setter, so the old backend's rows, reader and saved default
      // go now rather than when the new one's list arrives.
      if (this.#ownsTransport) this.transport = null
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
    // A load still in flight belongs to the state being torn down; without
    // this, a response for the old document could land after a switch to a
    // state that starts no replacement load, and repopulate the rail.
    this.#loadGeneration += 1
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
    // A reply is addressable: `#margin-reply-<id>` in the page URL, or a
    // reply's own "Link", brings it into view and focuses it.
    const view = doc.defaultView
    if (view) this.#on(view, 'hashchange', () => this.#revealHash())
  }

  #watchLayout() {
    // `collapsed`: the host wants the toggle and overlay at every width, so the
    // text keeps the page. Selection still opens the popup, as when narrow.
    if (this.hasAttribute('collapsed')) {
      this.#compact = true
      return
    }
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
   * The client for a write the reader started under `transport`, or null if
   * the host has since switched connections: a server id from one backend or
   * session means nothing — or something else — to another.
   */
  #clientFor(transport: MarginTransport | null): MarginClient | null {
    return transport && transport === this.#transport
      ? createMarginClient(transport)
      : null
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
    const revision = this.#prefsRevision
    const startedAt = this.#clock
    let settlePrefs = () => {}
    this.#prefsSettled = false
    this.#prefsReady = new Promise<void>((resolve) => {
      settlePrefs = () => {
        // A stale load settles its own promise and nothing else: marking the
        // shared flag would let a record made while the *current* request is
        // still out skip the provisional mark and publish the fallback.
        if (generation === this.#loadGeneration) this.#prefsSettled = true
        resolve()
      }
    })
    try {
      // The default is settled only once it has been applied — or once it is
      // clear it cannot be, whatever the reason — so a save waiting on it never
      // reads the fallback.
      try {
        const prefs = await client.readPrefs()
        if (generation !== this.#loadGeneration) return
        if (prefs.status === 404) {
          // No service mounted here — the dev server, a static preview. The
          // list's 404 says the same, and neither is worth warning about.
          this.#clearPrefsNotice()
        } else if (prefs.status === 401 || prefs.status === 403) {
          // Signed out, or refused: nobody here owns anything, whoever did before.
          this.#viewer = null
          this.#clearPrefsNotice()
        } else if (!isSuccess(prefs)) {
          // A 429 or a 500 says nothing about who is reading. Keep what is
          // known, say the settings did not load, and let the list go on.
          this.#notice = PREFS_FAILED
        } else {
          const body = prefs.body as {
            defaultVisibility?: string
            creator?: string
          }
          this.#viewer = typeof body?.creator === 'string' ? body.creator : null
          const shown = this.#defaultVisibility
          if (
            body?.defaultVisibility === 'public' ||
            body?.defaultVisibility === 'private'
          ) {
            // What the service holds is the rollback baseline either way...
            this.#savedDefault = body.defaultVisibility
            // ...but a reader who changed the default while this read was out
            // has the newer value on screen, and the response is older.
            // A write of the reader's choice still in flight is newer than any
            // read, even one that started after the choice was made.
            if (
              revision === this.#prefsRevision &&
              !this.#prefsWritesPending.get(this.#transport)
            ) {
              this.#defaultVisibility = body.defaultVisibility
            }
          }
          // The settings did load this time; an earlier failure is old news.
          // Drawn once the default is applied, so the controls never show the
          // fallback while the list that follows is still out.
          const cleared = this.#notice === PREFS_FAILED
          if (cleared) this.#notice = ''
          if (cleared || this.#defaultVisibility !== shown) this.#render()
        }
      } finally {
        settlePrefs()
      }

      const loaded: RailRecord[] = []
      // Threads arrive in the same pages as the notes they hang from: one
      // request per page, never one per reply.
      const loadedReplies: ThreadReply[] = []
      const cursors = new Set<string>()
      let response = await client.listAnnotations(documentUri)
      // Every page, not the first N: a rail that silently stops at some count
      // makes the rest of the document's annotations unreachable. The only stop
      // besides the last page is a cursor seen twice, which would loop forever.
      for (;;) {
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
          if (record) {
            loaded.push(record)
            continue
          }
          const reply = replyFromWebAnnotation(wire, this.#viewer)
          if (reply) loadedReplies.push(reply)
        }
        if (!body?.nextCursor || cursors.has(body.nextCursor)) break
        cursors.add(body.nextCursor)
        response = await client.listAnnotationsAfter(
          documentUri,
          body.nextCursor,
        )
      }
      if (generation !== this.#loadGeneration) return
      // Everything the service knows comes from the service — except what this
      // page created, which may be unsaved, or saved after the list's snapshot.
      // One of those that the list already contains is kept once: as the local
      // record, so its entry does not change identity under the reader.
      // Also kept: any record with a write still queued or running. Replacing
      // it with the loaded copy would strand that write — a delete would remove
      // the old object and leave the new one on screen.
      // "Touched after this load started" covers both: a write queued or
      // finished after the snapshot was taken makes the snapshot's copy stale.
      // A create that finished and was not touched since is left to the list,
      // which rebuilds it for whoever is reading now.
      const createdHere = this.#records.filter(
        (record) =>
          this.#saving.has(record) ||
          record.serverId === null ||
          (this.#inFlight.get(record) ?? 0) > 0 ||
          (this.#touched.get(record) ?? -1) > startedAt,
      )
      // A host may hand the rail annotations before the first load, carrying
      // the service's own ids but no server id of their own. Matched by id,
      // such a record takes the loaded row's metadata and stands in for it.
      const loadedById = new Map(
        loaded.map((record) => [record.serverId ?? '', record]),
      )
      for (const record of createdHere) {
        const match =
          record.serverId === null
            ? loadedById.get(record.annotation.id)
            : undefined
        if (match) {
          record.serverId = match.serverId
          record.visibility = match.visibility
          record.mine = match.mine
          // The service's copy is the baseline, not the host's: a refused
          // write must roll back to what is stored.
          this.#confirmed.set(record, {
            visibility: match.visibility,
            annotation: match.annotation,
          })
        }
      }
      const local = new Set(
        createdHere.flatMap((record) =>
          record.serverId ? [record.serverId] : [],
        ),
      )
      const fresh = loaded.filter(
        (record) =>
          !local.has(record.serverId ?? '') &&
          // A tombstone is what a delete leaves when a reply this page had
          // not seen yet hangs from it; the thread still needs its root.
          (!this.#deletedIds.has(record.serverId ?? '') || record.deleted),
      )
      for (const record of fresh) {
        this.#confirmed.set(record, {
          visibility: record.visibility,
          annotation: record.annotation,
        })
      }
      this.#records = [...fresh, ...createdHere]
      // A note this page tombstoned is still a local record; the list's copy
      // of it says so too, but only the local one is drawn.
      for (const record of loaded) {
        if (!record.deleted || !record.serverId || !local.has(record.serverId))
          continue
        const kept = createdHere.find(
          (entry) => entry.serverId === record.serverId,
        )
        if (kept) {
          // Take the service's tombstone, not just its flag: a host-cached
          // body must not stay in `annotations`, `records` or search.
          kept.deleted = true
          kept.annotation = record.annotation
          this.#confirmed.set(kept, {
            visibility: kept.visibility,
            annotation: kept.annotation,
          })
        }
      }
      this.#replies = loadedReplies
      if (this.#notice === LOAD_FAILED) this.#notice = ''
      this.#paint()
      this.#revealHash()
    } catch (error) {
      // A superseded load's failure belongs to state that is gone.
      if (generation !== this.#loadGeneration) return
      // A 404 is a page with no service mounted behind it — the dev server, a
      // static preview. That is not something to warn a reader about; the rail
      // works in memory there, as it does with no transport at all.
      const absent =
        error instanceof MarginTransportError &&
        error.responses.every((response) => response.status === 404)
      this.#reportTransportFailure(error, absent ? undefined : LOAD_FAILED)
    }
  }

  /**
   * An earlier settings failure no longer holds. Drawn now: the list that
   * follows may be slow, and until it lands the warning would stay on screen.
   */
  #clearPrefsNotice() {
    if (this.#notice !== PREFS_FAILED) return
    this.#notice = ''
    this.#render()
  }

  async #publish(
    created: readonly RailRecord[],
    source: {
      documentUri: string
      targetTexts: string[]
      transport: MarginTransport | null
    },
  ) {
    if (!source.transport || created.length === 0) return
    // A record made before the stored default arrived took the fallback; it
    // takes the reader's real default now, before anything is sent. Sending
    // first would store an annotation private for a reader whose default is
    // public, and nothing after could correct it.
    // The *current* readiness: a load that started while this one was waiting
    // replaced it, and the default is only known once the latest has settled.
    await this.#prefsSettledNow()
    // The page moved to another document while this waited: what was selected
    // belongs to the old one, and sending it now would store it against the new.
    if (source.documentUri !== this.documentUri) return
    // Likewise the service: a host that replaced or removed the transport while
    // this waited has switched away from that backend or session, and nothing
    // made under it may be sent there now — nor to the new one unasked.
    if (source.transport !== this.#transport) {
      this.#reportTransportFailure(
        new Error('the margin transport changed before this was saved'),
        'Not saved: the connection changed. It stays on this page only.',
      )
      return
    }
    const client = createMarginClient(source.transport)
    let adjusted = false
    for (const record of created) {
      const revision = this.#provisional.get(record)
      if (revision === undefined) continue
      this.#provisional.delete(record)
      // Only while the reader has not changed the default since: then the
      // loaded one is the default this record was made under.
      if (
        revision === this.#prefsRevision &&
        record.visibility !== this.#defaultVisibility
      ) {
        record.visibility = this.#defaultVisibility
        adjusted = true
      }
    }
    if (adjusted) this.#render()
    try {
      // Each request is built from its own record: a note in several blocks is
      // several records, and one may have been edited while this waited.
      const kindOf = (annotation: TextAnnotation) =>
        annotation.kind === 'highlight'
          ? ({ kind: 'highlight', color: annotation.appearance.color } as const)
          : annotation.kind === 'note'
            ? ({
                kind: 'note',
                body: annotation.body,
                ...(annotation.appearance
                  ? { color: annotation.appearance.color }
                  : {}),
              } as const)
            : ({ kind: annotation.kind, body: annotation.body } as const)
      // Every body is built before any is sent, so a selection that cannot be
      // serialised is refused whole rather than half stored.
      for (const [index, record] of created.entries()) {
        toWebAnnotation({
          documentUri: source.documentUri,
          target: record.annotation.target,
          targetText: source.targetTexts[index],
          ...kindOf(record.annotation),
        })
      }
      // Then one request per annotation, each id kept the moment it arrives: a
      // failure on the third block of a selection must not leave the first two
      // stored with no id here to delete them by.
      const responses: MarginResponse[] = []
      let duplicated = false
      for (const [index, record] of created.entries()) {
        // Checked before every request, not once: a host that switches
        // connections part-way must not have the rest sent to the old one.
        if (source.transport !== this.#transport) {
          this.#reportTransportFailure(
            new Error('the margin transport changed during the save'),
            'Not saved: the connection changed. It stays on this page only.',
          )
          break
        }
        // What this request carries is what the service will hold: the record
        // may change while it is out, and that change is not stored yet.
        const sent = {
          visibility: record.visibility,
          annotation: record.annotation,
        }
        const [response] = await client.createAnnotations({
          documentUri: source.documentUri,
          visibility: sent.visibility,
          targets: [record.annotation.target],
          targetTexts: [source.targetTexts[index]],
          ...kindOf(sent.annotation),
        })
        responses.push(response)
        const id = (response.body as { id?: unknown } | null)?.id
        if (isSuccess(response) && typeof id === 'string') {
          const serverId = serverIdFromIri(id)
          record.serverId = serverId
          this.#confirmed.set(record, sent)
          // A load whose snapshot already held this row, merged before the id
          // arrived, left a second copy of it in the rail.
          const before = this.#records.length
          this.#records = this.#records.filter(
            (entry) => entry === record || entry.serverId !== serverId,
          )
          duplicated ||= this.#records.length !== before
        }
      }
      if (duplicated) this.#paint()
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

  /**
   * Attach a note to the live selection, optionally tagged with a role.
   * Returns what it created.
   */
  noteSelection(body: string, color?: string): TextAnnotation[] {
    if (this.#capture.status !== 'captured' || !body.trim()) return []
    const anchors = this.#capture.anchors
    this.#capture = { status: 'empty' }
    this.ownerDocument.getSelection()?.removeAllRanges()
    return this.#create(anchors, {
      kind: 'note',
      body: body.trim(),
      ...(color ? { color } : {}),
    })
  }

  #create(
    anchors: PopupState['anchors'],
    input:
      | { kind: 'highlight'; color: string }
      | { kind: 'note'; body: string; color?: string },
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
    // Snapshotted now, while the selection's document is the page's document.
    const targetTexts = records.map(
      (record) =>
        this.#controller
          ?.blocks()
          .find((block) => block.id === record.annotation.target.nodeId)
          ?.text ?? '',
    )
    for (const record of records) {
      if (!this.#prefsSettled) {
        this.#provisional.set(record, this.#prefsRevision)
      }
    }
    const saved = this.#publish(records, {
      documentUri: this.documentUri,
      targetTexts,
      transport: this.#transport,
    })
    for (const record of records) this.#saving.set(record, saved)
    // A create is pending only while it is pending. Kept in the map after, it
    // made every record this element ever created outlive a reload — including
    // for the next reader, after a sign-out or account switch.
    void saved.finally(() => {
      this.#clock += 1
      for (const record of records) {
        this.#saving.delete(record)
        this.#touched.set(record, this.#clock)
      }
    })
    this.dispatchEvent(
      new CustomEvent('margin-annotations-created', {
        detail: created,
        bubbles: true,
        composed: true,
      }),
    )
    return created
  }

  /* ------------------------------------------------------------------ */
  /* Changing                                                           */
  /* ------------------------------------------------------------------ */

  #find(id: string) {
    return this.#records.find((record) => record.annotation.id === id)
  }

  /**
   * Run a write for one record after everything already queued for it — its
   * create first, then earlier writes in the order the reader made them. Two
   * quick toggles otherwise race as concurrent PATCHes, and whichever lands
   * last wins on the server while the rail shows the other.
   */
  #enqueue<T>(
    record: RailRecord,
    field: WriteField,
    write: () => Promise<T>,
  ): Promise<T> {
    const before = this.#writes.get(record) ?? this.#saving.get(record)
    const key = fieldKey(record, field)
    this.#inFlight.set(record, (this.#inFlight.get(record) ?? 0) + 1)
    this.#fieldWrites.set(key, (this.#fieldWrites.get(key) ?? 0) + 1)
    this.#touched.set(record, (this.#clock += 1))
    const run = (before ?? Promise.resolve()).then(write, write).finally(() => {
      this.#inFlight.set(record, (this.#inFlight.get(record) ?? 1) - 1)
      const left = (this.#fieldWrites.get(key) ?? 1) - 1
      if (left > 0) this.#fieldWrites.set(key, left)
      else this.#fieldWrites.delete(key)
      this.#touched.set(record, (this.#clock += 1))
    })
    this.#writes.set(
      record,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  /**
   * Whether the running write is the last one queued for this record's field.
   * Per field, not per record: a refused visibility change must roll back
   * even with an unrelated note edit queued behind it, and the reverse.
   */
  #isLastWrite(record: RailRecord, field: WriteField) {
    return (this.#fieldWrites.get(fieldKey(record, field)) ?? 0) <= 1
  }

  /** Resolves once the latest preference read has settled. */
  async #prefsSettledNow() {
    for (;;) {
      const ready = this.#prefsReady
      await ready
      if (ready === this.#prefsReady) return
    }
  }

  /**
   * Flip one annotation's visibility, and only that one. Immediate in the rail;
   * put back if the service refuses, so the rail never claims a state the
   * service does not hold.
   */
  async setVisibility(id: string, visibility: MarginVisibility) {
    const record = this.#find(id)
    if (
      !record ||
      !record.mine ||
      this.#deleting.has(record) ||
      record.visibility === visibility
    )
      return
    record.visibility = visibility
    // The reader chose; the default arriving later must not overwrite that.
    this.#provisional.delete(record)
    this.#render()
    // The document is the one the reader acted on, captured now: by the time a
    // queued write runs, the page may be showing another.
    const documentUri = this.documentUri
    const transport = this.#transport
    await this.#enqueue(record, 'visibility', async () => {
      const client = this.#clientFor(transport)
      if (!client || !record.serverId) return
      try {
        const response = await client.updateAnnotation(
          record.serverId,
          documentUri,
          { visibility },
        )
        if (!isSuccess(response)) {
          throw new MarginTransportError(
            'the margin service refused the change',
            [response],
          )
        }
        const confirmed = this.#confirmed.get(record)
        this.#confirmed.set(record, {
          visibility,
          annotation: confirmed?.annotation ?? record.annotation,
        })
      } catch (error) {
        // Only the last write queued for this record settles what the rail
        // shows: an earlier failure leaves a later write's value alone. The last
        // one, failing, falls back to what the service is known to hold — not
        // to this write's own predecessor, which may never have been stored.
        if (this.#isLastWrite(record, 'visibility')) {
          record.visibility =
            this.#confirmed.get(record)?.visibility ?? record.visibility
          this.#render()
        }
        this.#reportTransportFailure(
          error,
          'Visibility was not changed: the service refused it.',
        )
      }
    })
  }

  /** Only new annotations take the default; existing ones are not touched. */
  async setDefaultVisibility(visibility: MarginVisibility) {
    if (visibility === this.#defaultVisibility) return
    this.#defaultVisibility = visibility
    this.#prefsRevision += 1
    const revision = this.#prefsRevision
    const transport = this.#transport
    this.#render()
    // One preference write at a time, in order, and only the latest choice is
    // sent: two concurrent PATCHes could otherwise land reversed and store the
    // default the reader moved away from.
    // Counted per connection: an old connection's write still in flight must
    // not stop a new connection's read from applying its own default.
    this.#prefsWritesPending.set(
      transport,
      (this.#prefsWritesPending.get(transport) ?? 0) + 1,
    )
    const run = this.#prefsWrites.then(async () => {
      // Whether there is a signed-in reader to save it for is only known once
      // the preference read has settled.
      await this.#prefsSettledNow()
      if (revision !== this.#prefsRevision) return // superseded; that one saves
      // Chosen under one connection, never written through another: that would
      // set a different account's default.
      const client = this.#clientFor(transport)
      if (!client || !this.#viewer) return
      try {
        const response = await client.writePrefs(visibility)
        if (!isSuccess(response)) {
          throw new MarginTransportError(
            'the margin service refused the default',
            [response],
          )
        }
        // Only this connection's baseline: a write that finishes after the host
        // switched says nothing about the new connection's reader.
        if (transport === this.#transport) this.#savedDefault = visibility
      } catch (error) {
        if (revision === this.#prefsRevision && transport === this.#transport) {
          this.#defaultVisibility = this.#savedDefault ?? DEFAULT_VISIBILITY
          this.#render()
        }
        this.#reportTransportFailure(error, 'The default was not saved.')
      }
    })
    this.#prefsWrites = run
      .catch(() => undefined)
      .finally(() => {
        const left = (this.#prefsWritesPending.get(transport) ?? 1) - 1
        if (left > 0) this.#prefsWritesPending.set(transport, left)
        else this.#prefsWritesPending.delete(transport)
      })
    await run
  }

  async editNote(id: string, body: string) {
    const record = this.#find(id)
    const text = body.trim()
    if (
      !record ||
      !record.mine ||
      record.deleted ||
      this.#deleting.has(record) ||
      record.annotation.kind !== 'note' ||
      !text
    )
      return
    let storedBody: string
    try {
      storedBody = updateSketchNote(record.annotation.body, text)
    } catch {
      this.#notice = 'The sketch note is too long to save.'
      this.#render()
      return
    }
    const edited = { ...record.annotation, body: storedBody }
    record.annotation = edited
    this.#editing = null
    this.#paint()
    const documentUri = this.documentUri
    const transport = this.#transport
    // As with visibility: an edit made while the create is in flight is sent
    // once the create has an id, or it is lost on reload.
    await this.#enqueue(record, 'body', async () => {
      const client = this.#clientFor(transport)
      if (!client || !record.serverId) return
      try {
        const response = await client.updateAnnotation(
          record.serverId,
          documentUri,
          { body: storedBody },
        )
        if (!isSuccess(response)) {
          throw new MarginTransportError(
            'the margin service refused the edit',
            [response],
          )
        }
        const confirmed = this.#confirmed.get(record)
        this.#confirmed.set(record, {
          visibility: confirmed?.visibility ?? record.visibility,
          annotation: edited,
        })
      } catch (error) {
        if (this.#isLastWrite(record, 'body')) {
          record.annotation =
            this.#confirmed.get(record)?.annotation ?? record.annotation
          this.#paint()
        }
        this.#reportTransportFailure(
          error,
          'The note was not changed: the service refused it.',
        )
      }
    })
  }

  async deleteAnnotation(id: string) {
    const record = this.#find(id)
    // A double click, or Enter held down, would queue a second delete that runs
    // after the first succeeded and reports a 404 as "Not deleted".
    if (!record || !record.mine || this.#deleting.has(record)) return
    this.#deleting.add(record)
    // Shown as unavailable while the delete is out. `aria-disabled` rather than
    // `disabled`, so the focused control keeps focus instead of dropping it.
    this.#render()
    const documentUri = this.documentUri
    const transport = this.#transport
    // A delete that overtakes its own create would remove the entry here while
    // the create went on to store it — possibly public — to reappear on the
    // next load. It waits for the create, and for any earlier write.
    // Whether the service tombstoned the note rather than removing it. Only its
    // answer can say: a private reply from another reader keeps the note, and
    // this reader cannot see that reply to infer it.
    let tombstoned = false
    const deleted = await this.#enqueue(record, 'delete', async () => {
      if (transport !== this.#transport) return false // switched away; gone anyway
      const client = this.#clientFor(transport)
      if (!client || !record.serverId) return true
      try {
        const response = await client.deleteAnnotation(
          record.serverId,
          documentUri,
        )
        if (!isSuccess(response)) {
          throw new MarginTransportError(
            'the margin service refused the delete',
            [response],
          )
        }
        tombstoned =
          response.status === 200 &&
          (response.body as { 'margin:deleted'?: unknown } | null)?.[
            'margin:deleted'
          ] === true
        return true
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
        return false
      }
    })
    if (!deleted) {
      this.#deleting.delete(record)
      this.#render()
      return
    }
    // A note with replies is tombstoned by the service, not removed: the
    // thread under it stays, so its entry does too, without its text. The text
    // goes locally too, as it has on the service: out of `annotations`, out of
    // search, the same as a tombstone loaded fresh.
    if (tombstoned && record.annotation.kind === 'note') {
      this.#deleting.delete(record)
      record.deleted = true
      record.annotation = { ...record.annotation, body: DELETED_NOTE_TEXT }
      this.#confirmed.set(record, {
        visibility: record.visibility,
        annotation: record.annotation,
      })
      if (this.#editing === id) this.#editing = null
      const hadFocus =
        this.#shadow.activeElement?.getAttribute('data-focus-key') ===
        `delete:${id}`
      this.#render()
      // Its delete button is gone; the entry itself is still there.
      if (hadFocus) this.#focusEntry(id)
      return
    }
    if (record.serverId) this.#deletedIds.add(record.serverId)
    const position = this.#visibleRecords().findIndex(
      (entry) => entry.annotation.id === id,
    )
    // Whether the reader is still on this entry. A slow delete gives them time
    // to move on; focus is only carried forward if it would otherwise be lost.
    const focusedEntry = (
      this.#shadow.activeElement?.closest('li') as HTMLElement | null
    )?.dataset.marginAnnotation
    const doc = this.ownerDocument
    const focusLost = !doc.activeElement || doc.activeElement === doc.body
    this.#records = this.#records.filter((entry) => entry !== record)
    this.#paint()
    if (focusedEntry !== id && !focusLost) return
    // Focus goes to the entry that took its place, or the search box, never
    // to the top of the document.
    const next =
      this.#visibleRecords()[
        Math.min(position, this.#visibleRecords().length - 1)
      ]
    this.#focusEntry(next?.annotation.id)
  }

  /**
   * Focus an entry by the first control it actually renders: an orphan has no
   * "go to" button, and someone else's annotation has no delete.
   */
  #focusEntry(id: string | undefined) {
    const keys = id
      ? [`goto:${id}`, `edit:${id}`, `visibility:${id}`, `delete:${id}`]
      : []
    for (const key of [...keys, 'search']) {
      if (this.#shadow.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)) {
        this.#focusKey(key)
        return
      }
    }
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

  /** The popup for the captured selection, however it was made. */
  #openPopupForCapture() {
    const capture = this.#capture
    if (capture.status !== 'captured' || this.#popup) return
    const selection = this.ownerDocument.getSelection()
    const range =
      selection?.rangeCount && !selection.isCollapsed
        ? selection.getRangeAt(0).cloneRange()
        : null
    this.#openPopup(capture.anchors, range)
  }

  #openPopup(
    anchors: PopupState['anchors'],
    range: Range | null,
    ownedTabIndex: Element | null = null,
  ) {
    const doc = this.ownerDocument
    this.#noteDraft = ''
    this.#roleDraft = null
    this.#popup = {
      anchors,
      range,
      returnTo:
        doc.activeElement && doc.activeElement !== doc.body
          ? doc.activeElement
          : null,
      ownedTabIndex,
    }
    this.#render()
    this.#focusKey(`swatch:${DEFAULT_HIGHLIGHT_ROLE}`)
  }

  #closePopup({ restoreFocus }: { restoreFocus: boolean }) {
    const popup = this.#popup
    if (!popup) return
    this.#popup = null
    this.#render()
    const block = restoreFocus
      ? this.#blockFor(popup.anchors[popup.anchors.length - 1]?.nodeId)
      : undefined
    // A `tabindex` keyboard mode added is ours to remove: now, unless focus is
    // going back to that very block, in which case once focus leaves it.
    const owned = popup.ownedTabIndex
    if (owned && owned !== block?.element) owned.removeAttribute('tabindex')
    if (!restoreFocus) return
    if (block) {
      returnFocusToText(block.element, popup.range, owned === block.element)
    } else if (popup.returnTo instanceof HTMLElement) {
      popup.returnTo.focus()
    }
  }

  /**
   * The popup's one save. A note, when there is text, tagged with the picked
   * role if there is one; otherwise a highlight in the picked role. Nothing
   * picked and nothing written saves nothing.
   */
  #savePopup() {
    const popup = this.#popup
    if (!popup) return
    const body = this.#noteDraft.trim()
    const role = this.#roleDraft
    if (!body && !role) return
    this.#create(
      popup.anchors,
      body
        ? { kind: 'note', body, ...(role ? { color: role } : {}) }
        : { kind: 'highlight', color: role! },
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
        const owned = this.#stopKeyboard({ keepFocus: true })
        this.#capture = capture
        this.#openPopup(capture.anchors, range, owned)
      },
      onExit: () => {
        this.#stopKeyboard()
        this.#focusKey('keyboard-select')
      },
    })
    this.#render()
  }

  #stopKeyboard(options?: { keepFocus?: boolean }): Element | null {
    const owned = this.#keyboard?.stop(options) ?? null
    this.#keyboard = null
    return owned
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
    this.#flash({
      nodeId: entry.placement.nodeId,
      start: entry.placement.start,
      end: entry.placement.end,
    })
    if (this.#compact) {
      // The overlay closes, and the control that had focus goes with it; focus
      // goes to the passage, which is what the reader asked to go to.
      this.#overlayOpen = false
      this.#render()
      if (block) returnFocusToText(block.element, ranges[0] ?? null)
      return
    }
    this.#render()
  }

  /**
   * The flash is painted by the same painter as highlights, under its own
   * registry namespace, so it gets the same fallback: where the Custom
   * Highlight API is missing it draws an overlay rather than nothing.
   */
  #flash(target: { nodeId: string; start: number; end: number }) {
    this.#clearFlash()
    this.setAttribute('data-flashing', '')
    const blocks = this.#controller?.blocks() ?? []
    this.#unflash = paintHighlights(
      blocks,
      [{ id: 'flash', color: 'flash', ...target }],
      {
        palette: { flash: FLASH_PAINT, default: FLASH_PAINT },
        registryNamespace: `${this.#namespace}-flash`,
      },
    )
    const view = this.ownerDocument.defaultView ?? globalThis
    this.#flashTimer = view.setTimeout(
      () => this.#clearFlash(),
      FLASH_MS,
    ) as unknown as number
  }

  #clearFlash() {
    const view = this.ownerDocument?.defaultView ?? globalThis
    if (this.#flashTimer) view.clearTimeout(this.#flashTimer)
    this.#flashTimer = 0
    this.#unflash?.()
    this.#unflash = null
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
        (entry) =>
          // Only what is painted can be clicked: proposals paint as 060's diff
          // and a sketch's relocation quote not at all, so neither may capture
          // a click on unmarked prose.
          isPaintedPlacement(entry) &&
          entry.placement.status === 'anchored' &&
          entry.placement.nodeId === block.id &&
          entry.placement.start <= offset &&
          offset < entry.placement.end,
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
          record.annotation.kind === 'highlight'
            ? ''
            : noteText(record.annotation.body)
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

    this.dispatchEvent(
      new CustomEvent('margin-annotations-changed', {
        detail: { annotations: this.annotations },
        bubbles: true,
        composed: true,
      }),
    )

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
    // A selection made without a pointer or Shift — a screen reader's, say —
    // reports only `selectionchange`, which opens nothing. This opens the same
    // popup, with its roles and note, for whatever is captured.
    const annotate = el(
      doc,
      'button',
      {
        type: 'button',
        'data-margin-action': 'annotate',
        'data-focus-key': 'annotate',
      },
      'Annotate selection',
    )
    annotate.disabled = this.#capture.status !== 'captured'
    annotate.addEventListener('click', () => this.#openPopupForCapture())
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
    actions.append(highlight, annotate, keyboard, help)
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
    // Not mid-composition: rebuilding the rail replaces this field and ends
    // an IME session before the reader has chosen a candidate — no Chinese,
    // Japanese or Korean query could be typed. The query applies at the end.
    search.addEventListener('input', (event) => {
      if ((event as InputEvent).isComposing) return
      this.#query = search.value
      this.#render()
    })
    search.addEventListener('compositionend', () => {
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
        : annotation.kind === 'note' && annotation.appearance
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

    // A note starts a conversation, so it names who started it, the way every
    // reply under it does: by display name, never by address.
    if (annotation.kind === 'note' && record.serverId) {
      item.append(
        el(
          doc,
          'span',
          { class: 'meta author', 'data-margin-author': '' },
          record.mine ? 'You' : (record.creatorName ?? UNNAMED_PARTICIPANT),
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

    const sketch =
      annotation.kind === 'highlight' ? null : decodeSketch(annotation.body)
    const note = annotation.kind === 'highlight' ? '' : noteText(annotation.body)
    if (record.deleted) {
      item.dataset.deleted = ''
      item.append(el(doc, 'p', { class: 'body deleted' }, DELETED_NOTE_TEXT))
    } else if (annotation.kind !== 'highlight') {
      if (this.#editing === id) {
        const label = el(doc, 'label', {}, 'Edit note')
        const field = el(doc, 'textarea', {
          'data-focus-key': `edit-field:${id}`,
          ...(sketch ? { maxlength: '2000' } : {}),
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
          // Focus moves now, with the redraw, not when the request returns:
          // until then the reader would have no focus in the rail, and after
          // it a late return could pull focus back from wherever they went.
          void this.editNote(id, field.value)
          this.#focusKey(`edit:${id}`)
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
        if (sketch) item.append(sketchPreview(doc, sketch))
        item.append(el(doc, 'p', { class: 'body' }, note))
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
      const busy = this.#deleting.has(record) ? 'true' : undefined
      if (busy) item.setAttribute('aria-busy', 'true')
      // A tombstone takes no edit and no visibility change, but keeps Delete:
      // once nothing hangs from it, deleting it again removes it for good.
      if (record.deleted) controls.append(visibility)
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
          'aria-disabled': busy,
        },
        record.visibility === 'public' ? 'Public' : 'Private',
      )
      toggle.addEventListener('click', () => void this.setVisibility(id, next))
      if (!record.deleted) controls.append(toggle)
      if (!record.deleted && annotation.kind === 'note' && this.#editing !== id) {
        const edit = el(
          doc,
          'button',
          {
            type: 'button',
            'data-margin-action': 'edit',
            'data-focus-key': `edit:${id}`,
            'aria-disabled': busy,
          },
          'Edit',
        )
        edit.addEventListener('click', () => {
          if (busy) return
          this.#editing = id
          this.#editDraft = noteText(annotation.body)
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
          'aria-disabled': busy,
        },
        'Delete',
      )
      remove.addEventListener('click', () => void this.deleteAnnotation(id))
      controls.append(remove)
    } else {
      controls.append(visibility)
    }
    const serverId = record.serverId
    if (annotation.kind === 'note' && serverId) {
      if (this.#canReply()) {
        controls.append(this.#replyButton(serverId, `the note on ${quoteText}`))
      }
      item.append(controls)
      const thread = this.#thread(serverId, quoteText)
      if (thread) item.append(thread)
      return item
    }
    item.append(controls)
    return item
  }

  /* ------------------------------------------------------------------ */
  /* Threads                                                            */
  /* ------------------------------------------------------------------ */

  /** Replies from the last load. The service sent only what this reader may see. */
  get replies(): readonly ThreadReply[] {
    return this.#replies
  }

  /** Only a signed-in reader with a service behind the rail can reply. */
  #canReply() {
    return this.#viewer !== null && this.#transport !== null
  }

  /** The note or reply `serverId` names, as something a reply can hang from. */
  #replyParent(
    serverId: string,
  ): { target: TextAnnotation['target']; visibility: MarginVisibility } | null {
    const note = this.#records.find(
      (record) =>
        record.serverId === serverId && record.annotation.kind === 'note',
    )
    if (note) {
      return { target: note.annotation.target, visibility: note.visibility }
    }
    const reply = this.#replies.find((entry) => entry.serverId === serverId)
    return reply ? { target: reply.target, visibility: reply.visibility } : null
  }

  /**
   * Run one thread write, then reload, so the thread on screen is the one the
   * service holds rather than a guess at it. Returns the response, or null
   * when nothing was sent.
   */
  async #threadWrite(
    refusal: string,
    send: (client: MarginClient) => Promise<MarginResponse>,
  ): Promise<MarginResponse | null> {
    const client = this.#client()
    if (!client || this.#threadBusy) return null
    this.#threadBusy = true
    this.#render()
    let response: MarginResponse | null = null
    try {
      response = await send(client)
      if (!isSuccess(response)) {
        this.#reportTransportFailure(
          new MarginTransportError(refusal, [response]),
          response.status === 403
            ? `${refusal} Only its author can change it.`
            : refusal,
        )
      } else {
        this.#notice = ''
        await this.#load()
      }
    } catch (error) {
      this.#reportTransportFailure(error, refusal)
    } finally {
      this.#threadBusy = false
      this.#render()
    }
    return response
  }

  /**
   * Reply to a note or to a reply, by its server id. The reply takes the
   * reader's default visibility, except that a reply to something private is
   * private: the service refuses a public one, since it would show the
   * parent's passage to readers who cannot see the parent.
   */
  async reply(parentId: string, body: string): Promise<boolean> {
    const text = body.trim()
    const documentUri = this.documentUri
    const parent = this.#replyParent(parentId)
    if (!text || !documentUri || !parent || !this.#canReply()) return false
    const transport = this.#transport
    await this.#prefsSettledNow()
    // As `#publish` does: the page or the service may have changed while this
    // waited, and the parent and document it names belong to the old ones.
    // Sending them through the new transport could write under the wrong
    // connection, so nothing is sent; the draft stays for the reader.
    if (documentUri !== this.documentUri) return false
    if (transport !== this.#transport) {
      this.#reportTransportFailure(
        new Error('the margin transport changed before this reply was sent'),
        'Not sent: the connection changed. Your reply is still here.',
      )
      return false
    }
    const visibility: MarginVisibility =
      parent.visibility === 'private' ? 'private' : this.#defaultVisibility
    const targetText =
      this.#controller
        ?.blocks()
        .find((block) => block.id === parent.target.nodeId)?.text ?? undefined
    const response = await this.#threadWrite(
      'The reply was not saved: the service refused it.',
      async (client) => {
        const [created] = await client.createAnnotations({
          documentUri,
          kind: 'note',
          body: text,
          visibility,
          parentId,
          targets: [parent.target],
          ...(targetText === undefined ? {} : { targetTexts: [targetText] }),
        })
        return created
      },
    )
    if (!response || !isSuccess(response)) return false
    this.#replyingTo = null
    this.#replyDraft = ''
    const id = (response.body as { id?: unknown } | null)?.id
    this.#render()
    if (typeof id === 'string') this.#focusReply(serverIdFromIri(id))
    return true
  }

  /** Edit one of the reader's own replies. The service refuses anyone else's. */
  async editReply(serverId: string, body: string): Promise<boolean> {
    const text = body.trim()
    const documentUri = this.documentUri
    if (!text || !documentUri) return false
    const response = await this.#threadWrite(
      'The reply was not changed: the service refused it.',
      (client) => client.updateAnnotation(serverId, documentUri, { body: text }),
    )
    if (!response || !isSuccess(response)) return false
    this.#editingReply = null
    this.#replyEditDraft = ''
    this.#render()
    this.#focusReply(serverId)
    return true
  }

  /**
   * Delete one of the reader's own replies. One that has been answered is
   * tombstoned by the service and stays in the thread without its text.
   */
  async deleteReply(serverId: string): Promise<boolean> {
    const documentUri = this.documentUri
    if (!documentUri) return false
    const reply = this.#replies.find((entry) => entry.serverId === serverId)
    const response = await this.#threadWrite(
      'The reply was not deleted: the service refused it.',
      (client) => client.deleteAnnotation(serverId, documentUri),
    )
    if (!response || !isSuccess(response)) return false
    if (this.#replies.some((entry) => entry.serverId === serverId)) {
      this.#focusReply(serverId)
    } else if (reply) {
      this.#focusReply(reply.parentId)
    }
    return true
  }

  /** Focus a reply, or failing that the note it hangs from. */
  #focusReply(serverId: string) {
    const target = this.#shadow.getElementById(replyFragment(serverId))
    if (target) {
      target.focus()
      return
    }
    const note = this.#records.find((record) => record.serverId === serverId)
    if (note) this.#focusEntry(note.annotation.id)
  }

  /** Bring the reply the page URL names into view, once it has loaded. */
  #revealHash() {
    const hash = this.ownerDocument.defaultView?.location.hash ?? ''
    if (!hash.startsWith(`#${REPLY_FRAGMENT_PREFIX}`)) return
    let id: string
    try {
      id = decodeURIComponent(hash.slice(1))
    } catch {
      return
    }
    const target = this.#shadow.getElementById(id)
    if (!target) return
    if (this.#compact && !this.#overlayOpen) {
      this.#overlayOpen = true
      this.#render()
    }
    const current = this.#shadow.getElementById(id)
    current?.scrollIntoView({ block: 'center' })
    current?.focus({ preventScroll: true })
  }

  #replyButton(serverId: string, what: string): HTMLButtonElement {
    const button = el(
      this.ownerDocument,
      'button',
      {
        type: 'button',
        'data-margin-action': 'reply',
        'data-focus-key': `reply:${serverId}`,
        'aria-label': `Reply to ${what}`,
        'aria-expanded': String(this.#replyingTo === serverId),
        'aria-disabled': this.#threadBusy ? 'true' : undefined,
      },
      'Reply',
    )
    button.addEventListener('click', () => {
      if (this.#threadBusy) return
      if (this.#replyingTo !== serverId) this.#replyDraft = ''
      this.#replyingTo = serverId
      this.#render()
      this.#focusKey(`reply-field:${serverId}`)
    })
    return button
  }

  /** The field that writes a reply to `serverId`, when it is open. */
  #replyForm(serverId: string): HTMLElement | null {
    if (this.#replyingTo !== serverId) return null
    const doc = this.ownerDocument
    const parent = this.#replyParent(serverId)
    const form = el(doc, 'div', { class: 'reply-form' })
    const label = el(doc, 'label', {}, 'Your reply')
    const field = el(doc, 'textarea', {
      'data-focus-key': `reply-field:${serverId}`,
      'data-margin-reply-field': serverId,
    })
    field.value = this.#replyDraft
    field.addEventListener('input', () => {
      this.#replyDraft = field.value
    })
    label.append(field)
    const privateOnly = parent?.visibility === 'private'
    const note = el(
      doc,
      'span',
      { class: 'meta' },
      privateOnly
        ? 'Private, because what it answers is private'
        : this.#defaultVisibility === 'public'
          ? 'Public'
          : 'Private',
    )
    const send = el(
      doc,
      'button',
      {
        type: 'button',
        class: 'primary',
        'data-margin-action': 'reply-send',
        'data-focus-key': `reply-send:${serverId}`,
        'aria-disabled': this.#threadBusy ? 'true' : undefined,
      },
      'Send reply',
    )
    send.addEventListener('click', () => {
      if (this.#threadBusy) return
      void this.reply(serverId, field.value)
    })
    const cancel = el(
      doc,
      'button',
      { type: 'button', 'data-focus-key': `reply-cancel:${serverId}` },
      'Cancel',
    )
    cancel.addEventListener('click', () => {
      this.#replyingTo = null
      this.#replyDraft = ''
      this.#render()
      this.#focusKey(`reply:${serverId}`)
    })
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        cancel.click()
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        send.click()
      }
    })
    const controls = el(doc, 'div', { class: 'controls' })
    controls.append(send, cancel)
    form.append(label, note, controls)
    return form
  }

  /** A note's replies and its reply field, or null when it has neither. */
  #thread(rootId: string, quoteText: string): HTMLElement | null {
    const doc = this.ownerDocument
    if (this.#threadIndex?.replies !== this.#replies) {
      this.#threadIndex = {
        replies: this.#replies,
        index: indexThreads(this.#replies),
      }
    }
    const entries = this.#threadIndex.index.flatten(rootId)
    const rootForm = this.#replyForm(rootId)
    if (entries.length === 0 && !rootForm) return null
    // A group, not a `section`: a labelled section is a region landmark, and
    // one landmark per note would bury the rail's own.
    const section = el(doc, 'div', {
      class: 'thread',
      role: 'group',
      'data-margin-thread': rootId,
      'aria-label': `${entries.length} ${entries.length === 1 ? 'reply' : 'replies'} to the note on ${quoteText}`,
    })
    if (rootForm) section.append(rootForm)
    if (entries.length > 0) {
      const list = el(doc, 'ol', { 'aria-label': 'Replies' })
      for (const entry of entries) list.append(this.#replyEntry(entry))
      section.append(list)
    }
    return section
  }

  #replyEntry({ reply, depth, indent, inReplyTo }: ThreadEntry): HTMLLIElement {
    const doc = this.ownerDocument
    const id = reply.serverId
    const author = reply.mine ? 'You' : reply.creatorName
    const item = el(doc, 'li', {
      id: replyFragment(id),
      tabindex: '-1',
      'data-margin-reply': id,
      'data-depth': String(depth),
      'data-visibility': reply.visibility,
      'aria-label': `${author}, reply at depth ${depth}`,
    })
    item.style.setProperty('--indent', String(indent))
    if (reply.deleted) item.dataset.deleted = ''

    const header = el(doc, 'span', { class: 'meta' })
    header.append(el(doc, 'span', { class: 'author' }, author))
    header.append(
      doc.createTextNode(
        ` · ${reply.visibility === 'public' ? 'Public' : 'Private'}${
          reply.modified && reply.modified !== reply.created ? ' · edited' : ''
        }`,
      ),
    )
    item.append(header)
    // Drawn at the indent cap, a reply says who it answers: the indent alone
    // no longer does.
    if (inReplyTo && depth > indent) {
      item.append(
        el(
          doc,
          'span',
          { class: 'meta', 'data-margin-in-reply-to': inReplyTo.serverId },
          `Replying to ${inReplyTo.mine ? 'you' : inReplyTo.creatorName}`,
        ),
      )
    }

    if (this.#editingReply === id && reply.mine && !reply.deleted) {
      const label = el(doc, 'label', {}, 'Edit reply')
      const field = el(doc, 'textarea', {
        'data-focus-key': `reply-edit-field:${id}`,
      })
      field.value = this.#replyEditDraft
      field.addEventListener('input', () => {
        this.#replyEditDraft = field.value
      })
      label.append(field)
      const save = el(
        doc,
        'button',
        {
          type: 'button',
          'data-focus-key': `reply-edit-save:${id}`,
          'aria-disabled': this.#threadBusy ? 'true' : undefined,
        },
        'Save',
      )
      save.addEventListener('click', () => {
        if (this.#threadBusy) return
        void this.editReply(id, field.value)
      })
      const cancel = el(
        doc,
        'button',
        { type: 'button', 'data-focus-key': `reply-edit-cancel:${id}` },
        'Cancel',
      )
      cancel.addEventListener('click', () => {
        this.#editingReply = null
        this.#render()
        this.#focusKey(`reply-edit:${id}`)
      })
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          cancel.click()
        }
      })
      const editControls = el(doc, 'div', { class: 'controls' })
      editControls.append(save, cancel)
      item.append(label, editControls)
    } else {
      item.append(
        el(
          doc,
          'p',
          { class: reply.deleted ? 'body deleted' : 'body' },
          reply.body,
        ),
      )
    }

    const controls = el(doc, 'div', { class: 'controls' })
    if (this.#canReply()) {
      controls.append(this.#replyButton(id, `${author}`))
    }
    const link = el(
      doc,
      'a',
      {
        href: `#${replyFragment(id)}`,
        'data-focus-key': `reply-link:${id}`,
        'aria-label': `Link to this reply by ${author}`,
      },
      'Link',
    )
    controls.append(link)
    // A tombstoned reply keeps Delete, not Edit: once nothing answers it,
    // deleting it again removes it for good.
    if (reply.mine && this.#editingReply !== id) {
      const busy = this.#threadBusy ? 'true' : undefined
      const edit = el(
        doc,
        'button',
        {
          type: 'button',
          'data-margin-action': 'reply-edit',
          'data-focus-key': `reply-edit:${id}`,
          'aria-disabled': busy,
        },
        'Edit',
      )
      edit.addEventListener('click', () => {
        if (this.#threadBusy) return
        this.#editingReply = id
        this.#replyEditDraft = reply.body
        this.#render()
        this.#focusKey(`reply-edit-field:${id}`)
      })
      const remove = el(
        doc,
        'button',
        {
          type: 'button',
          'data-margin-action': 'reply-delete',
          'data-focus-key': `reply-delete:${id}`,
          'aria-label': 'Delete this reply',
          'aria-disabled': busy,
        },
        'Delete',
      )
      remove.addEventListener('click', () => {
        if (this.#threadBusy) return
        void this.deleteReply(id)
      })
      if (reply.deleted) controls.append(remove)
      else controls.append(edit, remove)
    }
    item.append(controls)
    const form = this.#replyForm(id)
    if (form) item.append(form)
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

    // Picking a role only marks it. The reader may still write a note, and
    // one Save stores whichever they made: a highlight in that role, or a
    // note tagged with it.
    const swatches = el(doc, 'div', {
      class: 'swatches',
      role: 'group',
      'aria-label': 'Tag (optional)',
    })
    const chips: HTMLButtonElement[] = []
    const save = el(
      doc,
      'button',
      {
        type: 'button',
        class: 'primary',
        'data-margin-action': 'save',
        'data-focus-key': 'popup-save',
      },
      'Save',
    ) as HTMLButtonElement
    const sync = () => {
      for (const chip of chips) {
        chip.setAttribute(
          'aria-pressed',
          String(chip.dataset.marginSwatch === this.#roleDraft),
        )
      }
      save.disabled = !this.#roleDraft && !this.#noteDraft.trim()
    }
    for (const role of HIGHLIGHT_ROLES) {
      const swatch = el(
        doc,
        'button',
        {
          type: 'button',
          class: 'swatch',
          'data-margin-swatch': role,
          'data-focus-key': `swatch:${role}`,
          'aria-pressed': 'false',
          'aria-label': `Tag as ${HIGHLIGHT_ROLE_LABELS[role]}`,
        },
        HIGHLIGHT_ROLE_LABELS[role],
      ) as HTMLButtonElement
      swatch.style.setProperty(
        '--swatch',
        `var(--margin-role-${role as HighlightRole})`,
      )
      swatch.addEventListener('click', () => {
        this.#roleDraft = this.#roleDraft === role ? null : role
        sync()
      })
      chips.push(swatch)
      swatches.append(swatch)
    }
    dialog.append(swatches)

    const label = el(doc, 'label', {}, 'Note (optional)')
    const note = el(doc, 'textarea', {
      'data-margin-note': '',
      'data-focus-key': 'popup-note',
    })
    note.value = this.#noteDraft
    note.addEventListener('input', () => {
      this.#noteDraft = note.value
      sync()
    })
    // Enter is a newline in a note; Cmd or Ctrl+Enter saves.
    note.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        this.#savePopup()
      }
    })
    label.append(note)
    dialog.append(label)

    const controls = el(doc, 'div', { class: 'controls' })
    save.addEventListener('click', () => this.#savePopup())
    sync()
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
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea',
        ),
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

type WriteField = 'visibility' | 'body' | 'delete'

/** A key per record object and field, for counting writes. */
const recordKeys = new WeakMap<object, number>()
let nextRecordKey = 0
function fieldKey(record: object, field: WriteField): string {
  let key = recordKeys.get(record)
  if (key === undefined) {
    key = nextRecordKey += 1
    recordKeys.set(record, key)
  }
  return `${key}:${field}`
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
