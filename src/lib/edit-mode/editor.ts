/**
 * Edit mode on a book page (issue 059): the reader types into the prose and
 * saves the result as a proposal for review.
 *
 * The schema is the enforcement mechanism. The page's own HTML is never
 * edited: edit mode renders the node's Markdown source (stamped by the build
 * with the commit it came from) through the prose schema, so an editable
 * block is a paragraph, a heading or a list, and everything else — front
 * matter, `:::` blocks, figures, code — is shown locked. What the reader types
 * is read back from the DOM into schema nodes only (text, emphasis, strong,
 * links, code, soft breaks); a paste goes through the schema's HTML mapping.
 * A proposal is the difference between the source and the edited document,
 * as CriticMarkup hunks against the stamped base commit.
 *
 * This is book code, not margin code: the margin package stays free of the
 * book's Markdown. It talks to the margin service over the same API.
 */
import {
  applyHunks,
  formatHunks,
  parseCriticMarkup,
  parseHunks,
  proposalState,
  proposeHunks,
  type Hunk,
} from '../../annotations/criticmarkup'
import { blocksFromHtml } from '../../annotations/prose-paste'
import {
  EditSession,
  isPermittedHref,
  joinParagraphs,
  parseMarkdown,
  serializeMarkdown,
  type Block,
  type Inline,
  type ProseDoc,
} from '../../annotations/prose-schema'
import { inlineText, replaceBlock, splitAt, withContent, withItems } from './model'
import { SketchController } from './sketch-controller'
import { prefixByCodePoints } from '../../../packages/margin/src/text'
import {
  MARGIN_TARGET_EVENT,
  type MarginTarget,
} from '../../../packages/margin/src/element'
import { proposalStateOf } from '../../../packages/margin/src/records'

const API = '/api/margin/v1'
const AUTH_ME = '/auth/me'
const PRINCIPAL_IRI_PREFIX = 'urn:margin:principal:'
const COMMIT_DEBOUNCE_MS = 300

type Principal = { provider: string; issuer: string; subject: string }
type WireProposal = {
  id: string
  creator: string
  body?: { value: string }
  'margin:baseCommit'?: string
  'margin:revision'?: number
  'margin:withdrawnAt'?: string
  'margin:proposalState'?: string
}

/** The same key `src/worker/margin/identity.ts` stores as `creator`. */
function principalKey(principal: Principal): string {
  const parts = [principal.provider, principal.issuer, principal.subject]
  return `${PRINCIPAL_IRI_PREFIX}${parts.map(encodeURIComponent).join(':')}`
}

function bareId(id: string): string {
  return id.replace(/^urn:margin:annotation:/, '')
}

/* -------------------------------------------------------------------------- */
/* DOM <-> inline nodes                                                       */
/* -------------------------------------------------------------------------- */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Schema nodes as editor HTML. Soft breaks stay `\n`: blocks are pre-wrap. */
export function inlinesToHtml(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return escapeHtml(node.text)
        case 'code':
          return `<code>${escapeHtml(node.text)}</code>`
        case 'em':
          return `<em>${inlinesToHtml(node.content)}</em>`
        case 'strong':
          return `<strong>${inlinesToHtml(node.content)}</strong>`
        case 'link':
          return `<a href="${escapeHtml(node.href)}"${node.title === undefined ? '' : ` title="${escapeHtml(node.title)}"`}>${inlinesToHtml(node.content)}</a>`
      }
    })
    .join('')
}

/**
 * Whitespace at the inner edge of emphasis, strong text or a link is outside
 * it in Markdown (`* first*` is not emphasis), so it is moved out: the mark
 * keeps its words, and the space sits beside it.
 */
function hoistEdges(
  make: (content: Inline[]) => Inline,
  content: Inline[],
): Inline[] {
  const inner = content.slice()
  let lead = ''
  let trail = ''
  const first = inner[0]
  if (first?.type === 'text') {
    const text = first.text.replace(/^\s+/, '')
    lead = first.text.slice(0, first.text.length - text.length)
    if (text) inner[0] = { type: 'text', text }
    else inner.shift()
  }
  const last = inner[inner.length - 1]
  if (last?.type === 'text') {
    const text = last.text.replace(/\s+$/, '')
    trail = last.text.slice(text.length)
    if (text) inner[inner.length - 1] = { type: 'text', text }
    else inner.pop()
  }
  const out: Inline[] = []
  if (lead) out.push({ type: 'text', text: lead })
  if (inner.length) out.push(make(inner))
  if (trail) out.push({ type: 'text', text: trail })
  return out
}

/**
 * What the reader typed, as schema nodes and nothing else. Elements outside
 * the schema contribute their text; `<br>` and block breaks a browser inserts
 * are soft line breaks.
 */
export function domToInlines(root: Node): Inline[] {
  const out: Inline[] = []
  const walk = (node: Node, into: Inline[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      if (text) into.push({ type: 'text', text })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const name = element.tagName.toLowerCase()
    const children = (): Inline[] => {
      const inner: Inline[] = []
      element.childNodes.forEach((child) => walk(child, inner))
      return inner
    }
    if (name === 'br') {
      into.push({ type: 'text', text: '\n' })
    } else if (name === 'em' || name === 'i') {
      into.push(...hoistEdges((content) => ({ type: 'em', marker: '*', content }), children()))
    } else if (name === 'strong' || name === 'b') {
      into.push(...hoistEdges((content) => ({ type: 'strong', marker: '**', content }), children()))
    } else if (name === 'code') {
      const text = element.textContent ?? ''
      if (text) into.push({ type: 'code', text })
    } else if (name === 'a') {
      const href = element.getAttribute('href') ?? ''
      const title = element.getAttribute('title')
      const content = children()
      if (href && isPermittedHref(href)) {
        into.push(
          ...hoistEdges(
            (inner) => ({ type: 'link', href, ...(title === null ? {} : { title }), content: inner }),
            content,
          ),
        )
      }
      else into.push(...content)
    } else if (name === 'div' || name === 'p') {
      // A browser's own line break inside an editable block.
      if (into.length) into.push({ type: 'text', text: '\n' })
      into.push(...children())
    } else {
      into.push(...children())
    }
  }
  root.childNodes.forEach((child) => walk(child, out))
  // Merge adjacent text and drop a trailing break the browser keeps for the caret.
  const merged: Inline[] = []
  for (const node of out) {
    const last = merged[merged.length - 1]
    if (node.type === 'text' && last?.type === 'text') {
      merged[merged.length - 1] = { type: 'text', text: last.text + node.text }
    } else merged.push(node)
  }
  const last = merged[merged.length - 1]
  if (last?.type === 'text' && last.text.endsWith('\n')) {
    const text = last.text.replace(/\n+$/, '')
    if (text) merged[merged.length - 1] = { type: 'text', text }
    else merged.pop()
  }
  return merged
}

function isBlank(nodes: readonly Inline[]): boolean {
  return inlineText(nodes).trim().length === 0
}

/* -------------------------------------------------------------------------- */
/* Tracked changes                                                            */
/* -------------------------------------------------------------------------- */

function trackedHtml(markup: string): string {
  return parseCriticMarkup(markup)
    .map((segment) => {
      switch (segment.kind) {
        case 'equal':
          return escapeHtml(segment.text)
        case 'delete':
          return `<del>${escapeHtml(segment.text)}</del>`
        case 'insert':
          return `<ins>${escapeHtml(segment.text)}</ins>`
        case 'substitute':
          return `<del>${escapeHtml(segment.old)}</del><ins>${escapeHtml(segment.new)}</ins>`
      }
    })
    .join('')
}

/* -------------------------------------------------------------------------- */
/* The controller                                                             */
/* -------------------------------------------------------------------------- */

type Stamp = { path: string; commit: string; text: string }

export class EditMode {
  readonly #root: HTMLElement
  readonly #content: HTMLElement
  readonly #documentUri: string
  readonly #stamp: Stamp | null
  readonly #disabledReason: string
  readonly #toggle: HTMLButtonElement
  readonly #status: HTMLElement
  readonly #reason: HTMLElement
  readonly #surface: HTMLElement
  readonly #changes: HTMLElement
  readonly #changesList: HTMLElement
  readonly #proposalsList: HTMLElement
  readonly #undo: HTMLButtonElement
  readonly #redo: HTMLButtonElement
  readonly #save: HTMLButtonElement
  readonly #discard: HTMLButtonElement
  #sketch: SketchController | null = null
  #session: EditSession | null = null
  #base: ProseDoc | null = null
  #editing = false
  #revising: WireProposal | null = null
  #me: string | null = null
  #canWrite = false
  /** The reader's own proposals on this page, as the last listing found them. */
  #proposals: WireProposal[] = []
  #pending = new Map<HTMLElement, number>()
  #restoreView: string | null = null
  #saving = false
  /** The text there is nothing unsaved against: the page, or the last save. */
  #cleanText: string | null = null
  /** Unregisters this page's window and document listeners on navigation. */
  #abort = new AbortController()
  /** The id of the proposal a restored draft was revising, if any. */
  #draftRevising: string | null = null

  constructor(root: HTMLElement) {
    this.#root = root
    const content = document.querySelector<HTMLElement>('.book-content')
    const rail = document.querySelector('margin-rail')
    if (!content || !rail) throw new Error('edit mode needs the book content and the margin rail')
    this.#content = content
    this.#documentUri = rail.getAttribute('document-uri') ?? ''
    const script = document.querySelector('script[data-book-source]')
    let stamp: Stamp | null = null
    if (script?.textContent) {
      try {
        stamp = JSON.parse(script.textContent) as Stamp
      } catch {
        stamp = null
      }
    }
    this.#stamp = stamp && stamp.commit === rail.getAttribute('source-commit') ? stamp : null
    this.#disabledReason =
      rail.getAttribute('edit-disabled-reason') ||
      (this.#stamp ? '' : 'This page does not say which commit its text came from.')
    const find = <T extends HTMLElement>(selector: string) => {
      const element = root.querySelector<T>(selector)
      if (!element) throw new Error(`edit mode markup is missing ${selector}`)
      return element
    }
    this.#toggle = find('[data-edit-toggle]')
    this.#status = find('[data-edit-status]')
    this.#reason = find('[data-edit-disabled-reason]')
    this.#surface = find('[data-edit-surface]')
    this.#changes = find('[data-edit-changes]')
    this.#changesList = find('[data-edit-changes-list]')
    this.#proposalsList = find('[data-edit-proposals]')
    this.#undo = find('[data-edit-undo]')
    this.#redo = find('[data-edit-redo]')
    this.#save = find('[data-edit-save]')
    this.#discard = find('[data-edit-discard]')
  }

  /* ---------------------------------------------------------------- drafts */

  /** Where this page's unsaved draft lives: per file and per base commit. */
  #draftKey(): string | null {
    // Per reader too: two writers sharing a browser never see each other's.
    return this.#canWrite && this.#stamp && this.#me
      ? `book-edit-draft:v2:${encodeURIComponent(this.#me)}:${this.#stamp.path}:${this.#stamp.commit}`
      : null
  }

  /** Keep the unsaved edit in this browser, so navigation cannot lose it. */
  #storeDraft(): void {
    const key = this.#draftKey()
    if (!key) return
    try {
      const edited = this.#edited()
      if (edited !== null && edited !== this.#clean()) {
        localStorage.setItem(
          key,
          JSON.stringify({ text: edited, revising: this.#revising ? this.#revising.id : null }),
        )
      } else {
        localStorage.removeItem(key)
      }
    } catch {
      // Storage unavailable: the beforeunload guard still warns.
    }
  }

  #clearDraft(): void {
    const key = this.#draftKey()
    if (!key) return
    try {
      localStorage.removeItem(key)
    } catch {}
  }

  #loadDraft(): { text: string; revising: string | null } | null {
    const key = this.#draftKey()
    if (!key) return null
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const draft = JSON.parse(raw) as { text?: unknown; revising?: unknown }
      return typeof draft.text === 'string'
        ? { text: draft.text, revising: typeof draft.revising === 'string' ? draft.revising : null }
        : null
    } catch {
      return null
    }
  }

  /** Show edit mode to a reader who may write, and wire it. */
  async start(): Promise<void> {
    const me = await this.#whoami()
    if (!me) return // Anonymous or unavailable identity: no editor session.
    this.#me = me.key
    this.#canWrite = me.canWrite
    this.#sketch = new SketchController(
      this.#root, this.#content, me.key, this.#stamp?.commit ?? 'unstamped', this.#abort.signal,
      (drawing) => {
        this.#flush()
        this.#content.hidden = !drawing && this.#editing
        this.#surface.hidden = drawing || !this.#editing
        if (drawing) this.#changes.hidden = true
        else this.#update()
      },
      me.canWrite,
    )
    // Saved drawings are readable without granting editing, draft access or
    // writer event handlers. Their observers still end with this page visit.
    document.addEventListener(
      'astro:after-swap',
      () => {
        document.documentElement.removeAttribute('data-book-editing')
        this.#abort.abort()
      },
      { signal: this.#abort.signal },
    )
    if (!me.canWrite) return
    this.#root.hidden = false
    if (this.#disabledReason) {
      this.#toggle.disabled = true
      this.#reason.hidden = false
      this.#reason.textContent = `Edit mode is off here: ${this.#disabledReason}`
    }
    // An unsaved draft from an earlier visit comes back with the next Edit.
    const draft = this.#loadDraft()
    if (draft && this.#stamp && draft.text !== this.#stamp.text) {
      this.#session = new EditSession(parseMarkdown(draft.text))
      this.#draftRevising = draft.revising
      this.#announce('You have unsaved changes on this page. Press Edit to continue them, or Discard.')
      this.#discard.hidden = false
    }
    // Leaving with unsaved changes asks first, whether or not storage works.
    const signal = this.#abort.signal
    window.addEventListener(
      'beforeunload',
      (event) => {
        this.#flush()
        if (!this.#hasChanges()) return
        this.#storeDraft()
        event.preventDefault()
        event.returnValue = ''
      },
      { signal },
    )
    document.addEventListener(
      'astro:before-preparation',
      () => {
        this.#flush()
        this.#storeDraft()
      },
      { signal },
    )
    this.#toggle.addEventListener('click', () => (this.#editing ? this.exit() : this.enter()))
    this.#undo.addEventListener('click', () => this.#history('undo'))
    this.#redo.addEventListener('click', () => this.#history('redo'))
    this.#save.addEventListener('click', () => void this.save())
    this.#discard.addEventListener('click', () => this.discard())
    this.#surface.addEventListener('input', (event) => this.#onInput(event))
    this.#surface.addEventListener('focusout', (event) => this.#flush(event.target))
    this.#surface.addEventListener('keydown', (event) => this.#onKeydown(event))
    this.#surface.addEventListener('paste', (event) => this.#onPaste(event))
    // Nothing is edited by dragging: not text, not a locked block.
    for (const type of ['dragstart', 'drop', 'dragover'] as const) {
      this.#surface.addEventListener(type, (event) => event.preventDefault())
    }
    await this.refreshProposals()
    // A link to one of the reader's own *pending* proposals (issue 073) opens
    // it as the Reopen button does: its diff, in edit mode. The rail scrolled
    // to it and painted nothing; this is the rest of landing on a proposal.
    // A withdrawn or later-state one is never reopened: it lands read-only,
    // its rail entry focused and saying where it stands.
    const rail = document.querySelector('margin-rail') as
      | (HTMLElement & { readonly target?: MarginTarget | null })
      | null
    const landed = (target: MarginTarget | null | undefined) => {
      if (target?.kind !== 'proposal') return
      const proposal = this.#proposals.find((entry) => bareId(entry.id) === target.id)
      if (proposal) this.reopen(proposal)
    }
    rail?.addEventListener(
      MARGIN_TARGET_EVENT,
      (event) => landed((event as CustomEvent<MarginTarget>).detail),
      { signal: this.#abort.signal },
    )
    landed(rail?.target)
  }

  async #whoami(): Promise<{ key: string; canWrite: boolean } | null> {
    try {
      const response = await fetch(AUTH_ME, { credentials: 'include', headers: { accept: 'application/json' } })
      if (!response.ok) return null
      const me = (await response.json()) as { authenticated?: unknown; canWrite?: unknown; principal?: Principal } | null
      const principal = me?.principal
      if (me?.authenticated !== true || !principal || typeof principal !== 'object' || Array.isArray(principal)) return null
      if (![principal.provider, principal.issuer, principal.subject].every((part) => typeof part === 'string' && part.length > 0)) return null
      return { key: principalKey(principal), canWrite: me.canWrite === true }
    } catch {
      return null
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  enter(from?: string): void {
    if (!this.#canWrite || this.#disabledReason || !this.#stamp || this.#editing) return
    this.#base ??= parseMarkdown(this.#stamp.text)
    if (!this.#session || from !== undefined) {
      this.#session = new EditSession(parseMarkdown(from ?? this.#stamp.text))
    }
    this.#editing = true
    document.documentElement.setAttribute('data-book-editing', '')
    // A challenge's side-by-side view is for the desk; edit mode is prose.
    const view = document.documentElement.getAttribute('data-challenge-view')
    if (view === 'split') {
      this.#restoreView = view
      document.documentElement.setAttribute('data-challenge-view', 'stacked')
    }
    this.#content.hidden = true
    this.#surface.hidden = false
    this.#toggle.setAttribute('aria-pressed', 'true')
    this.#toggle.textContent = 'Stop editing'
    this.#sketch?.setEnabled(true)
    this.#render()
    this.#announce(
      this.#revising
        ? `Revising your proposal (revision ${this.#revising['margin:revision'] ?? 1}).`
        : 'Edit mode on. What you change becomes a proposal for review; the page itself does not change.',
    )
    this.#surface.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
  }

  exit(): void {
    if (!this.#editing) return
    this.#flush()
    this.#sketch?.setEnabled(false)
    this.#editing = false
    document.documentElement.removeAttribute('data-book-editing')
    if (this.#restoreView) {
      document.documentElement.setAttribute('data-challenge-view', this.#restoreView)
      this.#restoreView = null
    }
    this.#content.hidden = false
    this.#surface.hidden = true
    this.#changes.hidden = true
    this.#toggle.setAttribute('aria-pressed', 'false')
    this.#toggle.textContent = 'Edit'
    this.#announce(this.#hasChanges() ? 'Edit mode off. Your unsaved changes are kept until you discard them.' : 'Edit mode off.')
    this.#toggle.focus()
  }

  discard(): void {
    this.#session = this.#stamp ? new EditSession(parseMarkdown(this.#stamp.text)) : null
    this.#revising = null
    this.#draftRevising = null
    this.#cleanText = null
    this.#clearDraft()
    this.#discard.hidden = true
    if (this.#editing) this.#render()
    this.#announce('Changes discarded.')
  }

  /* --------------------------------------------------------------- render */

  #render(): void {
    const doc = this.#session?.doc
    if (!doc) return
    this.#pending.clear()
    this.#surface.replaceChildren(...doc.blocks.map((block, index) => this.#blockElement(block, index)))
    this.#update()
  }

  #blockElement(block: Block, index: number): HTMLElement {
    if (block.type === 'locked') {
      const figure = document.createElement('figure')
      figure.className = 'edit-locked'
      figure.dataset.block = String(index)
      figure.setAttribute('contenteditable', 'false')
      figure.setAttribute('aria-label', `Locked block (${block.reason.replace(/_/g, ' ')}): comment on it instead`)
      const caption = document.createElement('figcaption')
      caption.textContent = `Locked · ${block.reason.replace(/_/g, ' ')} · comment on it instead`
      const pre = document.createElement('pre')
      const lines = block.raw.split('\n')
      pre.textContent = lines.length > 8 ? `${lines.slice(0, 8).join('\n')}\n…` : block.raw
      figure.append(caption, pre)
      return figure
    }
    const editable = (element: HTMLElement, nodes: readonly Inline[]) => {
      element.classList.add('edit-block')
      element.dataset.block = String(index)
      element.setAttribute('contenteditable', 'true')
      element.setAttribute('spellcheck', 'true')
      element.innerHTML = inlinesToHtml(nodes)
      return element
    }
    if (block.type === 'heading') {
      const level = Math.min(Math.max(block.level, 1), 6)
      return editable(document.createElement(`h${level}`), block.content)
    }
    if (block.type === 'paragraph') {
      return editable(document.createElement('p'), block.content)
    }
    const ordered = /^\s*\d/.test(block.items[0]?.marker ?? '')
    const list = document.createElement(ordered ? 'ol' : 'ul')
    list.className = 'edit-list'
    list.dataset.block = String(index)
    block.items.forEach((item, position) => {
      const li = editable(document.createElement('li'), item.content)
      li.dataset.item = String(position)
      // Show the number the Markdown will say, not a renumbering.
      const number = /^\s*(\d+)/.exec(item.marker)
      if (ordered && number) (li as HTMLLIElement).value = Number(number[1])
      list.append(li)
    })
    return list
  }

  /* -------------------------------------------------------------- editing */

  #onInput(event: Event): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-block]')
    if (!target) return
    const previous = this.#pending.get(target)
    if (previous) window.clearTimeout(previous)
    this.#pending.set(target, window.setTimeout(() => this.#commit(target), COMMIT_DEBOUNCE_MS))
  }

  /** Commit what is waiting: one element, or everything. */
  #flush(target?: EventTarget | null): void {
    const element = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-block]') : null
    const waiting = element ? [element] : [...this.#pending.keys()]
    for (const node of waiting) {
      const timer = this.#pending.get(node)
      if (timer === undefined) continue
      window.clearTimeout(timer)
      this.#commit(node)
    }
  }

  /** Read one edited element back into the document. */
  #commit(element: HTMLElement): void {
    this.#pending.delete(element)
    const session = this.#session
    if (!session) return
    const index = Number(element.dataset.block)
    const block = session.doc.blocks[index]
    if (!block || block.type === 'locked') return
    let next: Block[]
    if (block.type === 'list') {
      const list = element.closest<HTMLElement>('ul[data-block], ol[data-block]') ?? element
      const items = [...list.querySelectorAll<HTMLElement>('li')].map((li) => domToInlines(li))
      const edited = withItems(block, items)
      if (edited === block) return this.#update()
      next = edited ? [edited] : []
    } else {
      const content = domToInlines(element)
      if (isBlank(content)) {
        next = []
      } else {
        const edited = withContent(block, content)
        if (edited === block) return this.#update()
        next = [edited]
      }
    }
    session.apply((doc) => replaceBlock(doc, index, next))
    // Removing a block changes every later index; render afresh.
    if (next.length === 0) this.#render()
    else this.#update()
  }

  #onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement
    const element = target.closest<HTMLElement>('[contenteditable="true"][data-block]')
    const mod = event.metaKey || event.ctrlKey
    if (mod && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      this.#history(event.shiftKey ? 'redo' : 'undo')
      return
    }
    if (mod && !event.altKey && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      this.#history('redo')
      return
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault()
      void this.save()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      this.exit()
      return
    }
    if (!element) return
    const index = Number(element.dataset.block)
    const block = this.#session?.doc.blocks[index]
    if (!block) return

    if (event.key === 'Enter' && event.shiftKey) {
      // A soft line break, inside a paragraph only: in a heading or a list
      // item a newline would end the block in Markdown.
      event.preventDefault()
      if (block.type === 'paragraph') document.execCommand('insertText', false, '\n')
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (block.type === 'paragraph') this.#splitAtCaret(element, index)
      return
    }
    if (event.key === 'Backspace' && block.type === 'paragraph' && this.#caretAtStart(element)) {
      const previous = this.#session?.doc.blocks[index - 1]
      if (previous?.type === 'paragraph') {
        event.preventDefault()
        this.#flush()
        const joinAt = inlineText(previous.content).length
        this.#session?.apply((doc) => joinParagraphs(doc, index - 1))
        this.#render()
        this.#placeCaret(index - 1, joinAt)
      }
    }
  }

  #caretAtStart(element: HTMLElement): boolean {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false
    const range = selection.getRangeAt(0)
    const before = document.createRange()
    before.selectNodeContents(element)
    before.setEnd(range.startContainer, range.startOffset)
    return before.toString().length === 0
  }

  #splitAtCaret(element: HTMLElement, index: number): void {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const left = document.createRange()
    left.selectNodeContents(element)
    left.setEnd(range.startContainer, range.startOffset)
    const right = document.createRange()
    right.selectNodeContents(element)
    right.setStart(range.endContainer, range.endOffset)
    const leftContent = domToInlines(left.cloneContents())
    const rightContent = domToInlines(right.cloneContents())
    if (isBlank(leftContent) || isBlank(rightContent)) return
    this.#flush()
    this.#session?.apply((doc) => splitAt(doc, index, leftContent, rightContent))
    this.#render()
    this.#placeCaret(index + 1, 0)
  }

  #placeCaret(index: number, offset: number): void {
    const element = this.#surface.querySelector<HTMLElement>(`[contenteditable="true"][data-block="${index}"]`)
    if (!element) return
    element.focus()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let remaining = offset
    let node = walker.nextNode()
    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return
      }
      remaining -= length
      node = walker.nextNode()
    }
  }

  /** A paste becomes schema nodes: only permitted nodes, ever. */
  #onPaste(event: ClipboardEvent): void {
    event.preventDefault()
    const target = (event.target as HTMLElement | null)?.closest('[contenteditable="true"]')
    if (!target) return
    const data = event.clipboardData
    const html = data?.getData('text/html') || escapeHtml(data?.getData('text/plain') ?? '')
    const blocks = blocksFromHtml(html)
    const inlines: Inline[] = []
    blocks.forEach((block, position) => {
      if (position > 0) inlines.push({ type: 'text', text: ' ' })
      if (block.type === 'list') {
        block.items.forEach((item, k) => {
          if (k > 0) inlines.push({ type: 'text', text: ' ' })
          inlines.push(...item.content)
        })
      } else inlines.push(...block.content)
    })
    if (inlines.length) document.execCommand('insertHTML', false, inlinesToHtml(inlines))
  }

  #history(direction: 'undo' | 'redo'): void {
    const session = this.#session
    if (!session) return
    this.#flush()
    if (direction === 'undo') session.undo()
    else session.redo()
    this.#render()
    this.#announce(direction === 'undo' ? 'Undone.' : 'Redone.')
  }

  /* -------------------------------------------------------------- changes */

  #edited(): string | null {
    const session = this.#session
    return session ? serializeMarkdown(session.doc) : null
  }

  #hunks(): Hunk[] {
    const edited = this.#edited()
    if (!this.#stamp || edited === null || edited === this.#stamp.text) return []
    return proposeHunks(this.#stamp.text, edited)
  }

  /** Nothing is unsaved against this: the page's text, or the last save. */
  #clean(): string | undefined {
    return this.#cleanText ?? this.#stamp?.text
  }

  /** Unsaved: differs from the last saved or opened text. */
  #hasChanges(): boolean {
    const edited = this.#edited()
    return edited !== null && edited !== this.#clean()
  }

  #update(): void {
    const session = this.#session
    this.#undo.disabled = !session?.canUndo
    this.#redo.disabled = !session?.canRedo
    let hunks: Hunk[] = []
    let problem = ''
    try {
      hunks = this.#hunks()
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    this.#save.disabled = this.#saving || hunks.length === 0 || Boolean(problem)
    this.#storeDraft()
    this.#discard.hidden = !this.#hasChanges() && !this.#revising
    this.#changes.hidden = !this.#editing || (hunks.length === 0 && !problem)
    if (problem) {
      this.#changesList.textContent = problem
      return
    }
    this.#changesList.replaceChildren(
      ...hunks.map((hunk) => {
        const item = document.createElement('div')
        item.className = 'edit-change'
        const where = document.createElement('p')
        where.className = 'edit-change-where'
        where.textContent =
          hunk.baseStartLine === hunk.baseEndLine
            ? `Line ${hunk.baseStartLine}`
            : `Lines ${hunk.baseStartLine}–${hunk.baseEndLine}`
        const text = document.createElement('pre')
        text.className = 'edit-tracked'
        text.innerHTML = trackedHtml(hunk.criticMarkup)
        item.append(where, text)
        return item
      }),
    )
  }

  /* ---------------------------------------------------------------- saving */

  /**
   * Anchor the proposal beside the passage it changes: the base line holding
   * the first changed CriticMarkup segment (context lines are skipped), with
   * Markdown punctuation removed, as the page shows it. The hunks and base
   * commit are the proposal; the anchor only places it in the margin, so a
   * line the page renders differently falls back to the next line of the
   * changed stretch, then to the page's opening words.
   */
  #anchor(hunks: Hunk[]): { exact: string; start: number } {
    const pageText = this.#content.textContent ?? ''
    const clean = (text: string) =>
      text
        .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
        .replace(/[*_`]/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .trim()
    const candidates: string[] = []
    const hunk = hunks[0]
    if (hunk) {
      let before = ''
      let changed = ''
      let seenChange = false
      for (const segment of parseCriticMarkup(hunk.criticMarkup)) {
        if (!seenChange && segment.kind === 'equal') {
          before += segment.text
          continue
        }
        seenChange = true
        if (segment.kind === 'equal') {
          changed += segment.text
          if (changed.includes('\n')) break
        } else if (segment.kind === 'delete') changed += segment.text
        else if (segment.kind === 'substitute') changed += segment.old
      }
      // The whole line the change starts on, then what the change touched.
      const lineStart = before.lastIndexOf('\n') + 1
      candidates.push(before.slice(lineStart) + changed.split('\n')[0])
      candidates.push(...changed.split('\n'))
      // A pure insertion anchors to the line it follows.
      candidates.push(before.slice(0, lineStart).split('\n').reverse().find((line) => line.trim()) ?? '')
    }
    const line =
      candidates.map(clean).find((text) => text.length >= 3 && pageText.includes(text)) ?? ''
    const exact = prefixByCodePoints(line || prefixByCodePoints(pageText.trim(), 80) || 'this page', 200)
    const at = pageText.indexOf(exact)
    return { exact, start: at < 0 ? 0 : [...pageText.slice(0, at)].length }
  }

  async save(): Promise<void> {
    // One save at a time: a second Cmd/Ctrl+Enter before the first answers
    // would otherwise POST a duplicate proposal.
    if (!this.#canWrite || this.#disabledReason || this.#saving) return
    this.#flush()
    if (!this.#stamp) return
    let hunks: Hunk[]
    try {
      hunks = this.#hunks()
    } catch (error) {
      this.#announce(`This change cannot be saved as a proposal: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (hunks.length === 0) {
      this.#announce('Nothing to save: the text is unchanged.')
      return
    }
    const body = formatHunks(hunks)
    this.#saving = true
    this.#save.disabled = true
    // A restored draft that was revising a proposal PATCHes that proposal:
    // resolve it first, and refuse to save rather than POST a second one.
    if (this.#draftRevising && !this.#revising) {
      try {
        const found = await fetch(
          `${API}/annotations/${encodeURIComponent(bareId(this.#draftRevising))}?source=${encodeURIComponent(this.#documentUri)}`,
          { credentials: 'include', headers: { accept: 'application/json' } },
        )
        if (!found.ok) throw new Error(`the service answered ${found.status}`)
        this.#revising = (await found.json()) as WireProposal
      } catch (error) {
        this.#saving = false
        this.#update()
        this.#announce(
          `Could not find the proposal this draft was revising, so nothing was saved: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
    }
    this.#announce('Saving your proposal…')
    try {
      let response: Response
      if (this.#revising) {
        response = await fetch(
          `${API}/annotations/${encodeURIComponent(bareId(this.#revising.id))}?source=${encodeURIComponent(this.#documentUri)}`,
          {
            method: 'PATCH',
            credentials: 'include',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ body, 'margin:baseCommit': this.#stamp.commit }),
          },
        )
      } else {
        const anchor = this.#anchor(hunks)
        response = await fetch(`${API}/annotations`, {
          method: 'POST',
          credentials: 'include',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            type: 'Annotation',
            motivation: 'editing',
            body: { type: 'TextualBody', value: body },
            target: {
              source: this.#documentUri,
              selector: [
                { type: 'TextQuoteSelector', exact: anchor.exact },
                { type: 'TextPositionSelector', start: anchor.start, end: anchor.start + [...anchor.exact].length },
              ],
            },
            'margin:baseCommit': this.#stamp.commit,
            'margin:sourcePath': this.#stamp.path,
          }),
        })
      }
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(detail?.error?.message ?? `the service answered ${response.status}`)
      }
      const saved = (await response.json()) as WireProposal
      this.#revising = saved
      this.#draftRevising = null
      this.#cleanText = this.#edited()
      this.#clearDraft()
      this.#announce(
        `Proposal saved (revision ${saved['margin:revision'] ?? 1}). It waits for review; the page is unchanged.`,
      )
      await this.refreshProposals()
    } catch (error) {
      this.#announce(`Could not save the proposal: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.#saving = false
      this.#update()
    }
  }

  /* ------------------------------------------------------------ proposals */

  async refreshProposals(): Promise<void> {
    if (!this.#me) return
    let mine: WireProposal[] = []
    try {
      // The listing pages over every visible proposal on the document; the
      // reader's own may be on any page, so follow the cursor to the end.
      let cursor: string | undefined
      for (let page = 0; page < 50; page += 1) {
        const response = await fetch(
          `${API}/proposals?source=${encodeURIComponent(this.#documentUri)}&limit=200` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
          { credentials: 'include', headers: { accept: 'application/json' } },
        )
        if (!response.ok) break
        const body = (await response.json()) as { annotations: WireProposal[]; nextCursor?: string }
        mine.push(...body.annotations.filter((proposal) => proposal.creator === this.#me))
        cursor = body.nextCursor
        if (!cursor) break
      }
    } catch {
      mine = []
    }
    if (this.#draftRevising && !this.#revising) {
      this.#revising = mine.find((proposal) => proposal.id === this.#draftRevising) ?? null
    }
    this.#proposals = mine
    this.#proposalsList.replaceChildren(...mine.map((proposal) => this.#proposalItem(proposal)))
    this.#proposalsList.hidden = mine.length === 0
  }

  #proposalItem(proposal: WireProposal): HTMLElement {
    const item = document.createElement('div')
    item.className = 'edit-proposal'
    item.dataset.proposal = bareId(proposal.id)
    const base = proposal['margin:baseCommit'] ?? ''
    const state = this.#stamp ? proposalState(base, this.#stamp.commit) : 'stale'
    item.dataset.state = state
    const label = document.createElement('span')
    label.textContent =
      `Your proposal · revision ${proposal['margin:revision'] ?? 1} · ` +
      (state === 'stale' ? 'stale: the text has changed since, so it cannot be applied as is' : 'current')
    const reopen = document.createElement('button')
    reopen.type = 'button'
    reopen.textContent = 'Reopen'
    reopen.disabled = !this.#canReopen(proposal)
    reopen.addEventListener('click', () => this.reopen(proposal))
    const withdraw = document.createElement('button')
    withdraw.type = 'button'
    withdraw.textContent = 'Withdraw'
    withdraw.addEventListener('click', () => void this.withdraw(proposal))
    item.append(label, reopen, withdraw)
    return item
  }

  /** Both the button and a deep link must pass this before changing any draft. */
  #canReopen(proposal: WireProposal): boolean {
    return this.#canWrite && !this.#disabledReason && Boolean(this.#stamp) &&
      proposal.creator === this.#me && proposalStateOf(proposal) === 'pending' &&
      !proposal['margin:withdrawnAt'] &&
      (proposal['margin:proposalState'] === undefined || proposal['margin:proposalState'] === 'pending') &&
      proposal['margin:baseCommit'] === this.#stamp?.commit && typeof proposal.body?.value === 'string'
  }

  reopen(proposal: WireProposal): void {
    if (!this.#canReopen(proposal) || !this.#stamp || !proposal.body) return
    this.#flush()
    if (
      this.#hasChanges() &&
      !window.confirm('You have unsaved changes on this page. Discard them and open this proposal instead?')
    ) {
      return
    }
    let edited: string
    try {
      edited = applyHunks(parseHunks(proposal.body.value), this.#stamp.text)
    } catch (error) {
      this.#announce(`This proposal cannot be reopened: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (this.#editing) this.exit()
    this.#revising = proposal
    this.#draftRevising = null
    this.#cleanText = edited
    this.#clearDraft()
    this.enter(edited)
  }

  async withdraw(proposal: WireProposal): Promise<void> {
    if (!this.#canWrite || proposal.creator !== this.#me || proposalStateOf(proposal) !== 'pending') return
    try {
      const response = await fetch(
        `${API}/proposals/${encodeURIComponent(bareId(proposal.id))}/withdraw?source=${encodeURIComponent(this.#documentUri)}`,
        { method: 'POST', credentials: 'include', headers: { accept: 'application/json' } },
      )
      if (!response.ok) throw new Error(`the service answered ${response.status}`)
      if (this.#revising && bareId(this.#revising.id) === bareId(proposal.id)) {
        this.#revising = null
      }
      this.#announce('Proposal withdrawn from review. Replies to it stay readable.')
      await this.refreshProposals()
    } catch (error) {
      this.#announce(`Could not withdraw the proposal: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #announce(message: string): void {
    this.#status.textContent = message
  }
}
