/** Book-side spatial overlays; the margin service owns persistence and privacy. */
import {
  readAnchorableBlocks,
  type AnchorableBlock,
} from '../../../packages/margin/src/dom/blocks'
import {
  createSketchSvg,
  decodeSketch,
  encodeSketch,
  regionWithinBounds,
  type Sketch,
} from '../../../packages/margin/src/sketch'
import { prefixByCodePoints } from '../../../packages/margin/src/text'
import type { TextAnnotation } from '../../../packages/margin/src/anchor'

const API = '/api/margin/v1/annotations'
const MAX_POINTS = 300 // Leaves room for the note inside the existing 8,000-character body.
type Rail = HTMLElement & {
  annotations: readonly TextAnnotation[]
  refreshFromService(): Promise<void>
}
type Point = [number, number]

export class SketchController {
  readonly #content: HTMLElement
  readonly #rail: Rail
  readonly #launcher: HTMLElement
  readonly #toolbar: HTMLElement
  readonly #notePanel: HTMLElement
  readonly #note: HTMLTextAreaElement
  readonly #save: HTMLButtonElement
  readonly #undo: HTMLButtonElement
  readonly #clear: HTMLButtonElement
  readonly #newArea: HTMLButtonElement
  readonly #done: HTMLButtonElement
  readonly #status: HTMLElement
  readonly #instruction: HTMLElement
  readonly #signal: AbortSignal
  readonly #onView: (drawing: boolean) => void
  readonly #key: string
  #enabled = false
  #active = false
  #saving = false
  #draft: Sketch | null = null
  #requestKey = crypto.randomUUID()
  #canvas: SVGSVGElement | null = null
  #selection: SVGSVGElement | null = null
  #stroke: Point[] | null = null
  #saved: { id: string; sketch: Sketch }[] = []
  #frame = 0

  constructor(
    root: HTMLElement,
    content: HTMLElement,
    viewer: string,
    commit: string,
    signal: AbortSignal,
    onView: (drawing: boolean) => void,
  ) {
    this.#content = content
    this.#signal = signal
    this.#onView = onView
    this.#rail = document.querySelector('margin-rail') as Rail
    this.#key = `book-sketch-draft:v1:${encodeURIComponent(viewer)}:${encodeURIComponent(this.#endpoint())}:${encodeURIComponent(this.#rail.getAttribute('document-uri') ?? '')}:${commit}`
    const find = <T extends HTMLElement>(selector: string) =>
      root.querySelector<T>(selector)!
    this.#launcher = find('[data-sketch-launcher]')
    this.#toolbar = find('[data-sketch-toolbar]')
    this.#notePanel = find('[data-sketch-note-panel]')
    this.#note = find('[data-sketch-note]')
    this.#save = find('[data-sketch-save]')
    this.#undo = find('[data-sketch-undo]')
    this.#clear = find('[data-sketch-clear]')
    this.#newArea = find('[data-sketch-new]')
    this.#done = find('[data-sketch-done]')
    this.#status = find('[data-sketch-status]')
    this.#instruction = find('[data-sketch-instruction]')
    find('[data-sketch-toggle]').addEventListener('click', () => this.open(), {
      signal,
    })
    this.#done.addEventListener('click', () => this.close(), { signal })
    this.#newArea.addEventListener(
      'click',
      () => {
        this.#draft = null
        this.#requestKey = crypto.randomUUID()
        this.#canvas?.remove()
        this.#canvas = null
        this.#store()
        this.#selectArea()
        this.#update()
      },
      { signal },
    )
    this.#undo.addEventListener(
      'click',
      () => {
        this.#draft?.strokes.pop()
        this.#drawDraft()
        this.#store()
      },
      { signal },
    )
    this.#clear.addEventListener(
      'click',
      () => {
        if (this.#draft) this.#draft.strokes = []
        this.#drawDraft()
        this.#store()
      },
      { signal },
    )
    this.#note.addEventListener(
      'input',
      () => {
        this.#store()
        this.#update()
      },
      { signal },
    )
    this.#save.addEventListener('click', () => void this.#persist(), { signal })
    // Capture before prose shortcuts: Escape leaves the tool, not edit mode.
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.isComposing || event.repeat) return
        if (
          this.#enabled &&
          (event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === 'd'
        ) {
          event.preventDefault()
          event.stopImmediatePropagation()
          if (this.#active) this.close()
          else this.open()
        } else if (this.#active && event.key === 'Escape') {
          event.preventDefault()
          event.stopImmediatePropagation()
          this.close()
        }
      },
      { signal, capture: true },
    )
    const changed = () => {
      this.#saved = (this.#rail.annotations ?? []).flatMap((annotation) => {
        const sketch =
          annotation.kind === 'note' ? decodeSketch(annotation.body) : null
        return sketch ? [{ id: annotation.id, sketch }] : []
      })
      this.#scheduleLayout()
    }
    this.#rail.addEventListener('margin-annotations-changed', changed, {
      signal,
    })
    changed()
    const observer = new ResizeObserver(() => this.#scheduleLayout())
    observer.observe(content)
    for (const block of this.#blocks()) observer.observe(block.element)
    window.addEventListener('resize', () => this.#scheduleLayout(), { signal })
    document.addEventListener('astro:before-preparation', () => this.#store(), {
      signal,
    })
    signal.addEventListener(
      'abort',
      () => {
        observer.disconnect()
        cancelAnimationFrame(this.#frame)
        this.#selection?.remove()
        this.#canvas?.remove()
      },
      { once: true },
    )
    this.#restore()
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    if (!enabled) this.close()
    this.#launcher.hidden = !enabled || this.#active
    this.#scheduleLayout()
  }

  open(): void {
    if (!this.#enabled || this.#saving || this.#active) return
    this.#active = true
    this.#onView(true)
    this.#launcher.hidden = true
    this.#toolbar.hidden = false
    this.#status.textContent =
      'Private annotation · drag with a mouse, touch or pen.'
    // An old draft whose text vanished remains stored until explicitly cleared.
    if (this.#draft && !this.#anchor(this.#draft)) {
      this.#status.textContent =
        'The passage for your draft has changed. Clear it to select a new area.'
    } else if (this.#draft) this.#drawDraft()
    else this.#selectArea()
    this.#update()
    this.#done.focus({ preventScroll: true })
    this.#scheduleLayout()
  }

  close(): void {
    if (!this.#active) return
    this.#finishStroke()
    this.#store()
    this.#active = false
    this.#selection?.remove()
    this.#selection = null
    this.#canvas?.remove()
    this.#canvas = null
    this.#toolbar.hidden = true
    this.#launcher.hidden = !this.#enabled
    this.#onView(false)
    this.#launcher
      .querySelector<HTMLButtonElement>('button')
      ?.focus({ preventScroll: true })
  }

  #endpoint(): string {
    return `${(this.#rail.getAttribute('api-base') ?? '/').replace(/\/+$/u, '')}${API}`
  }

  #blocks(): AnchorableBlock[] {
    return readAnchorableBlocks(this.#content).filter((block) =>
      block.text.trim(),
    )
  }

  #anchor(sketch: Sketch): AnchorableBlock | undefined {
    const blocks = this.#blocks()
    return (
      blocks.find(
        (block) =>
          block.id === sketch.anchor.blockId &&
          block.text.includes(sketch.anchor.quote),
      ) ??
      (() => {
        const matching = blocks.filter((block) =>
          block.text.includes(sketch.anchor.quote),
        )
        return matching.length === 1 ? matching[0] : undefined
      })()
    )
  }

  #selectArea(): void {
    this.#selection?.remove()
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('sketch-selection')
    svg.dataset.marginAnnotatable = 'false'
    svg.setAttribute('aria-label', 'Drag to select a sketch area')
    this.#selection = svg
    this.#content.append(svg)
    let start: Point | null = null
    let block: AnchorableBlock | undefined
    let pointer: number | null = null
    const point = (event: PointerEvent): Point => {
      const box = this.#content.getBoundingClientRect()
      return [
        Math.max(0, Math.min(box.width, event.clientX - box.left)),
        Math.max(0, Math.min(box.height, event.clientY - box.top)),
      ]
    }
    const rectangle = document.createElementNS(svg.namespaceURI, 'rect')
    rectangle.setAttribute('fill', 'rgb(3 105 161 / .08)')
    rectangle.setAttribute('stroke', '#0369a1')
    svg.append(rectangle)
    const bounds = (end: Point) => ({
      x: Math.min(start![0], end[0]),
      y: Math.min(start![1], end[1]),
      width: Math.abs(end[0] - start![0]),
      height: Math.abs(end[1] - start![1]),
    })
    svg.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0 || pointer !== null) return
        const blocks = this.#blocks()
        // Code and figures attach to their containing or nearest prose block.
        block =
          blocks.find((candidate) => {
            const rect = candidate.element.getBoundingClientRect()
            return (
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom
            )
          }) ??
          blocks.sort(
            (a, b) =>
              Math.abs(a.element.getBoundingClientRect().top - event.clientY) -
              Math.abs(b.element.getBoundingClientRect().top - event.clientY),
          )[0]
        if (!block) {
          this.#status.textContent =
            'This page has no passage to attach a sketch to.'
          return
        }
        event.preventDefault()
        pointer = event.pointerId
        start = point(event)
        svg.setPointerCapture(event.pointerId)
      },
      { signal: this.#signal },
    )
    svg.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerId !== pointer || !start) return
        const rect = bounds(point(event))
        for (const [key, value] of Object.entries(rect))
          rectangle.setAttribute(key, String(value))
      },
      { signal: this.#signal },
    )
    svg.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerId !== pointer || !start || !block) return
        const rect = bounds(point(event))
        pointer = null
        if (rect.width < 12 || rect.height < 12) {
          start = null
          this.#status.textContent = 'Drag a larger area, then draw inside it.'
          return
        }
        const host = this.#content.getBoundingClientRect()
        const anchor = block.element.getBoundingClientRect()
        const region = {
          x: (rect.x - (anchor.left - host.left)) / anchor.width,
          y: (rect.y - (anchor.top - host.top)) / anchor.width,
          width: rect.width / anchor.width,
          height: rect.height / anchor.width,
        }
        // The same bounds every stored sketch is decoded against: an area no
        // reader could be shown is refused here, with the selection kept.
        if (!regionWithinBounds(region)) {
          start = null
          this.#status.textContent =
            'That area is too large to keep beside one passage. Drag a smaller one.'
          return
        }
        this.#requestKey = crypto.randomUUID()
        this.#draft = {
          version: 1,
          note: '',
          anchor: { blockId: block.id, quote: prefixByCodePoints(block.text, 160) },
          region,
          strokes: [],
        }
        this.#selection?.remove()
        this.#selection = null
        this.#drawDraft()
        this.#store()
        this.#status.textContent =
          'Draw inside the area, then add a note. Saved annotations are private.'
      },
      { signal: this.#signal },
    )
    svg.addEventListener(
      'pointercancel',
      () => {
        pointer = null
        start = null
        rectangle.setAttribute('width', '0')
        rectangle.setAttribute('height', '0')
      },
      { signal: this.#signal },
    )
  }

  #drawDraft(): void {
    this.#canvas?.remove()
    this.#canvas = null
    if (!this.#draft || !this.#active) {
      this.#update()
      return
    }
    // The SVG factory accepts a nonempty note; an unsaved drawing has no note yet.
    const canvas = createSketchSvg(
      { ...this.#draft, note: this.#note.value || 'Draft sketch' },
      document,
    )
    canvas.classList.add('sketch-layer')
    canvas.dataset.sketchCanvas = ''
    canvas.dataset.marginAnnotatable = 'false'
    canvas.setAttribute('aria-label', 'Draw in the selected area')
    this.#canvas = canvas
    this.#content.append(canvas)
    this.#position(canvas, this.#draft)
    let pointer: number | null = null
    const addPoint = (event: PointerEvent) => {
      if (!this.#draft || !this.#stroke) return
      if (
        this.#draft.strokes.reduce(
          (total, stroke) => total + stroke.length,
          0,
        ) >= MAX_POINTS
      ) {
        this.#status.textContent =
          'Sketch is full. Undo or save this annotation before adding more.'
        return
      }
      const box = canvas.getBoundingClientRect()
      const normalize = (value: number) =>
        Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000
      const point: Point = [
        normalize((event.clientX - box.left) / box.width),
        normalize((event.clientY - box.top) / box.height),
      ]
      const last = this.#stroke[this.#stroke.length - 1]
      if (
        last &&
        Math.hypot(
          (point[0] - last[0]) * box.width,
          (point[1] - last[1]) * box.height,
        ) < 2
      )
        return
      this.#stroke.push(point)
      const path = canvas.lastElementChild!
      const points =
        this.#stroke.length === 1
          ? [point, [point[0] + 0.001, point[1]]]
          : this.#stroke
      path.setAttribute(
        'd',
        points
          .map(
            (p, index) => `${index ? 'L' : 'M'}${p[0] * 1000} ${p[1] * 1000}`,
          )
          .join(' '),
      )
    }
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (
          event.button !== 0 ||
          pointer !== null ||
          this.#saving ||
          !this.#draft
        )
          return
        if (
          this.#draft.strokes.length >= 100 ||
          this.#draft.strokes.reduce(
            (total, stroke) => total + stroke.length,
            0,
          ) >= MAX_POINTS
        )
          return
        event.preventDefault()
        event.stopPropagation()
        pointer = event.pointerId
        canvas.setPointerCapture(event.pointerId)
        this.#stroke = []
        this.#draft.strokes.push(this.#stroke)
        const path = document.createElementNS(canvas.namespaceURI, 'path')
        path.setAttribute('fill', 'none')
        path.setAttribute('stroke', 'currentColor')
        path.setAttribute('stroke-width', '2.5')
        path.setAttribute('stroke-linecap', 'round')
        path.setAttribute('stroke-linejoin', 'round')
        path.setAttribute('vector-effect', 'non-scaling-stroke')
        canvas.append(path)
        addPoint(event)
      },
      { signal: this.#signal },
    )
    canvas.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerId === pointer) addPoint(event)
      },
      { signal: this.#signal },
    )
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return
      pointer = null
      this.#finishStroke()
      this.#update()
    }
    canvas.addEventListener('pointerup', finish, { signal: this.#signal })
    canvas.addEventListener('pointercancel', finish, { signal: this.#signal })
    canvas.addEventListener('lostpointercapture', finish, {
      signal: this.#signal,
    })
    this.#update()
  }

  #finishStroke(): void {
    if (!this.#stroke) return
    // A tap is a visible dot, including after a reload.
    if (this.#stroke.length === 1) this.#stroke.push([...this.#stroke[0]])
    this.#stroke = null
    this.#store()
  }

  #position(svg: SVGSVGElement, sketch: Sketch): void {
    const block = this.#anchor(sketch)
    if (!block || this.#content.hidden) {
      svg.style.display = 'none'
      return
    }
    const rect = block.element.getBoundingClientRect()
    const host = this.#content.getBoundingClientRect()
    if (!rect.width) {
      svg.style.display = 'none'
      return
    }
    svg.style.display = ''
    svg.style.left = `${rect.left - host.left + sketch.region.x * rect.width}px`
    svg.style.top = `${rect.top - host.top + sketch.region.y * rect.width}px`
    svg.style.width = `${sketch.region.width * rect.width}px`
    svg.style.height = `${sketch.region.height * rect.width}px`
  }

  #scheduleLayout(): void {
    cancelAnimationFrame(this.#frame)
    this.#frame = requestAnimationFrame(() => {
      if (this.#signal.aborted) return
      this.#content
        .querySelectorAll('[data-sketch-saved]')
        .forEach((svg) => svg.remove())
      for (const { id, sketch } of this.#saved) {
        const svg = createSketchSvg(sketch, document)
        svg.classList.add('sketch-layer')
        svg.dataset.sketchSaved = id
        svg.dataset.marginAnnotatable = 'false'
        svg.setAttribute('aria-label', `Sketch: ${sketch.note}`)
        this.#content.append(svg)
        this.#position(svg, sketch)
      }
      if (this.#canvas && this.#draft) this.#position(this.#canvas, this.#draft)
    })
  }

  #update(): void {
    const draft = this.#draft
    this.#notePanel.hidden = !draft
    const strokes = Boolean(draft?.strokes.length)
    this.#undo.disabled = this.#saving || !strokes
    this.#clear.disabled = this.#saving || !draft
    this.#newArea.disabled = this.#saving || !draft || strokes
    this.#save.disabled =
      this.#saving ||
      !strokes ||
      !this.#note.value.trim() ||
      !draft ||
      !this.#anchor(draft)
    this.#note.disabled = this.#saving
    this.#done.disabled = this.#saving
    this.#instruction.textContent = draft
      ? 'Pen · draw inside the selected area'
      : 'Drag over an area to sketch'
  }

  #store(): void {
    try {
      if (!this.#draft) {
        localStorage.removeItem(this.#key)
        return
      }
      const encoded = encodeSketch({
        ...this.#draft,
        note: this.#note.value.trim() || 'Draft sketch',
      })
      localStorage.setItem(
        this.#key,
        JSON.stringify({
          body: encoded,
          note: this.#note.value,
          requestKey: this.#requestKey,
        }),
      )
    } catch {
      this.#status.textContent =
        'Your draft could not be kept in this browser. Save it before leaving.'
    }
  }

  #restore(): void {
    try {
      const raw = localStorage.getItem(this.#key)
      if (!raw || raw.length > 12_000) return
      const stored = JSON.parse(raw)
      const sketch =
        typeof stored.body === 'string' ? decodeSketch(stored.body) : null
      if (
        sketch &&
        typeof stored.note === 'string' &&
        stored.note.length <= 2000
      ) {
        if (
          typeof stored.requestKey === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            stored.requestKey,
          )
        )
          this.#requestKey = stored.requestKey
        this.#draft = sketch
        this.#note.value = stored.note
      }
    } catch {
      /* Storage unavailable or a corrupt draft: keep the page usable. */
    }
  }

  async #persist(): Promise<void> {
    this.#finishStroke()
    if (
      this.#saving ||
      !this.#draft ||
      !this.#note.value.trim() ||
      !this.#draft.strokes.length
    )
      return
    const sketch = { ...this.#draft, note: this.#note.value.trim() }
    const block = this.#anchor(sketch)
    if (!block) return
    let body: string
    try {
      body = encodeSketch(sketch)
    } catch {
      this.#status.textContent =
        'This sketch is too large. Undo a few strokes and try again.'
      return
    }
    this.#saving = true
    this.#update()
    this.#status.textContent = 'Saving annotation…'
    try {
      const exact = sketch.anchor.quote
      const start = [...block.text.slice(0, block.text.indexOf(exact))].length
      const response = await fetch(this.#endpoint(), {
        method: 'POST',
        credentials: 'include',
        signal: this.#signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'Idempotency-Key': this.#requestKey,
        },
        body: JSON.stringify({
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          motivation: 'commenting',
          body: { type: 'TextualBody', value: body, format: 'text/plain' },
          target: {
            source: this.#rail.getAttribute('document-uri'),
            selector: [
              { type: 'TextQuoteSelector', exact },
              {
                type: 'TextPositionSelector',
                start,
                end: start + [...exact].length,
              },
              {
                type: 'margin:StructSelector',
                'margin:nodeId': block.id,
                'margin:structId': block.structId,
              },
            ],
          },
          'margin:visibility': 'private',
        }),
      })
      if (!response.ok)
        throw new Error(`the service answered ${response.status}`)
      const saved = (await response.json()) as { id?: unknown }
      if (typeof saved.id !== 'string' || !saved.id)
        throw new Error('the service did not confirm the annotation ID')
      this.#saved.push({ id: saved.id, sketch })
      this.#draft = null
      this.#requestKey = crypto.randomUUID()
      this.#note.value = ''
      this.#canvas?.remove()
      this.#canvas = null
      this.#store()
      this.#scheduleLayout()
      this.#status.textContent =
        'Annotation saved privately. View or edit its note in Margin.'
      // Creation is already confirmed: a refresh failure must never invite a duplicate POST.
      void this.#rail.refreshFromService().catch(() => {})
      if (this.#active) this.#selectArea()
    } catch (error) {
      if (!this.#signal.aborted)
        this.#status.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)}. Your sketch and note are kept for retry.`
    } finally {
      this.#saving = false
      this.#update()
    }
  }
}
