// This bound fits at the largest supported review font in the shortest
// landscape page while leaving room for the explicit continuation label.
export const REVIEW_FOOTNOTE_CHUNK_CHARACTERS = 240

export type DiscreteReviewPagination = {
  pageCount: number
  pageForTarget(target: Element): number | null
  show(page: number): number
}

const REVIEW_SOURCE_TEMPLATE_ATTRIBUTE = 'data-review-source-template'
export const REVIEW_PAGINATION_SUPERSEDED_MESSAGE =
  'EPUB review pagination was superseded by a newer layout.'

function yieldReviewPaginationTask() {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
}

function requireActivePagination(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE)
  }
}

export function createReviewPaginationScheduler(
  options: {
    budgetMs?: number
    now?: () => number
    yieldTask?: () => Promise<void>
  } = {},
) {
  const budgetMs = Math.max(1, options.budgetMs ?? 8)
  const now =
    options.now ??
    (() =>
      typeof globalThis.performance?.now === 'function'
        ? globalThis.performance.now()
        : Date.now())
  const yieldTask = options.yieldTask ?? yieldReviewPaginationTask
  let deadline = now() + budgetMs
  return {
    async checkpoint(signal?: AbortSignal) {
      requireActivePagination(signal)
      if (now() < deadline) return
      await yieldTask()
      requireActivePagination(signal)
      deadline = now() + budgetMs
    },
  }
}

export type ReviewPaginationScheduler = ReturnType<
  typeof createReviewPaginationScheduler
>

function* elementsInSubtree(root: Element, includeRoot = true) {
  if (includeRoot) yield root
  const walker = root.ownerDocument.createTreeWalker(root, 1)
  let current = walker.nextNode()
  while (current) {
    yield current as Element
    current = walker.nextNode()
  }
}

function waitForPaginationImage(
  image: HTMLImageElement,
  signal?: AbortSignal,
  timeoutMs = 10_000,
) {
  if (signal?.aborted) {
    return Promise.reject(new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE))
  }
  if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const frameWindow = image.ownerDocument.defaultView
    const finish = (error?: Error) => {
      frameWindow?.clearTimeout(timeout)
      image.removeEventListener('load', loaded)
      image.removeEventListener('error', failed)
      signal?.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    const loaded = () =>
      image.naturalWidth > 0 && image.naturalHeight > 0
        ? finish()
        : finish(
            new Error(
              'EPUB review pagination found an image with no intrinsic size.',
            ),
          )
    const failed = () =>
      finish(
        new Error('EPUB review pagination could not load a packaged image.'),
      )
    const aborted = () =>
      finish(new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE))
    const timeout = frameWindow?.setTimeout(
      () =>
        finish(
          new Error(
            'EPUB review pagination timed out while loading a packaged image.',
          ),
        ),
      timeoutMs,
    )
    image.addEventListener('load', loaded, { once: true })
    image.addEventListener('error', failed, { once: true })
    signal?.addEventListener('abort', aborted, { once: true })
    if (image.complete) loaded()
  })
}

function textBoundaries(value: string) {
  const boundaries = [0]
  for (const match of value.matchAll(/\S+(?:\s+|$)/gu)) {
    boundaries.push(match.index + match[0].length)
  }
  if (boundaries.at(-1) !== value.length) boundaries.push(value.length)
  return [...new Set(boundaries)].sort((left, right) => left - right)
}

export function deterministicTextChunks(
  value: string,
  maximumCharacters = REVIEW_FOOTNOTE_CHUNK_CHARACTERS,
) {
  if (!value) return ['']
  const chunks: string[] = []
  let start = 0
  const boundaries = textBoundaries(value)
  while (start < value.length) {
    const limit = Math.min(value.length, start + maximumCharacters)
    const end =
      boundaries
        .filter((boundary) => boundary > start && boundary <= limit)
        .at(-1) ?? Math.min(value.length, Math.max(start + 1, limit))
    chunks.push(value.slice(start, end))
    start = end
  }
  return chunks
}

async function textBoundariesCooperatively(
  value: string,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  const boundaries = [0]
  let index = 0
  let scannedSinceCheckpoint = 0
  const whitespace = /\s/u
  const advance = () => {
    index += 1
    scannedSinceCheckpoint += 1
    return scannedSinceCheckpoint >= 256
  }
  const checkpoint = async () => {
    scannedSinceCheckpoint = 0
    await scheduler.checkpoint(signal)
  }
  while (index < value.length) {
    while (index < value.length && whitespace.test(value[index])) {
      if (advance()) await checkpoint()
    }
    let foundWord = false
    while (index < value.length && !whitespace.test(value[index])) {
      foundWord = true
      if (advance()) await checkpoint()
    }
    if (!foundWord) {
      break
    }
    while (index < value.length && whitespace.test(value[index])) {
      if (advance()) await checkpoint()
    }
    boundaries.push(index)
    await scheduler.checkpoint(signal)
  }
  if (boundaries.at(-1) !== value.length) boundaries.push(value.length)
  return boundaries
}

export async function deterministicTextChunksCooperatively(
  value: string,
  options: {
    maximumCharacters?: number
    scheduler: ReviewPaginationScheduler
    signal?: AbortSignal
  },
) {
  if (!value) return ['']
  const maximumCharacters =
    options.maximumCharacters ?? REVIEW_FOOTNOTE_CHUNK_CHARACTERS
  const boundaries = await textBoundariesCooperatively(
    value,
    options.scheduler,
    options.signal,
  )
  const chunks: string[] = []
  let start = 0
  let boundaryIndex = 1
  while (start < value.length) {
    const limit = Math.min(value.length, start + maximumCharacters)
    while (
      boundaryIndex < boundaries.length &&
      boundaries[boundaryIndex] <= limit
    ) {
      boundaryIndex += 1
    }
    const boundary = boundaries[boundaryIndex - 1]
    const end =
      boundary > start
        ? boundary
        : Math.min(value.length, Math.max(start + 1, limit))
    chunks.push(value.slice(start, end))
    start = end
    await options.scheduler.checkpoint(options.signal)
  }
  return chunks
}

async function textContentCooperatively(
  root: Element,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  const values: string[] = []
  const walker = root.ownerDocument.createTreeWalker(root, 4)
  let current = walker.nextNode()
  while (current) {
    values.push(current.nodeValue ?? '')
    await scheduler.checkpoint(signal)
    current = walker.nextNode()
  }
  return values.join('')
}

async function cloneTextRange(
  source: Node,
  start: number,
  end: number,
  state: { offset: number },
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
): Promise<Node | null> {
  await scheduler.checkpoint(signal)
  if (source.nodeType === 3) {
    const value = source.textContent ?? ''
    const nodeStart = state.offset
    const nodeEnd = nodeStart + value.length
    state.offset = nodeEnd
    const overlapStart = Math.max(start, nodeStart)
    const overlapEnd = Math.min(end, nodeEnd)
    return overlapStart < overlapEnd
      ? source.ownerDocument!.createTextNode(
          value.slice(overlapStart - nodeStart, overlapEnd - nodeStart),
        )
      : null
  }
  if (source.nodeType !== 1) return null
  const clone = source.cloneNode(false) as Element
  for (let child = source.firstChild; child; child = child.nextSibling) {
    const childClone = await cloneTextRange(
      child,
      start,
      end,
      state,
      scheduler,
      signal,
    )
    if (childClone) clone.append(childClone)
  }
  return clone.childNodes.length > 0 ? clone : null
}

async function cloneElementTextRange(
  source: HTMLElement,
  start: number,
  end: number,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  const state = { offset: 0 }
  return (await cloneTextRange(
    source,
    start,
    end,
    state,
    scheduler,
    signal,
  )) as HTMLElement | null
}

async function removeAllTargets(
  root: Element,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  for (const element of elementsInSubtree(root)) {
    await scheduler.checkpoint(signal)
    element.removeAttribute('id')
    element.removeAttribute('data-canonical-id')
  }
}

async function removeTargetsOwnedBy(
  root: Element,
  owner: Element,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  const ownedIds = new Set<string>()
  const ownedCanonicalIds = new Set<string>()
  for (const element of elementsInSubtree(owner)) {
    await scheduler.checkpoint(signal)
    const id = element.getAttribute('id')
    if (id) ownedIds.add(id)
    const canonicalId = element.getAttribute('data-canonical-id')
    if (canonicalId) ownedCanonicalIds.add(canonicalId)
  }
  for (const element of elementsInSubtree(root)) {
    await scheduler.checkpoint(signal)
    if (ownedIds.has(element.getAttribute('id') ?? '')) {
      element.removeAttribute('id')
    }
    if (
      ownedCanonicalIds.has(element.getAttribute('data-canonical-id') ?? '')
    ) {
      element.removeAttribute('data-canonical-id')
    }
  }
}

function splittable(element: HTMLElement) {
  return /^(?:P|LI|BLOCKQUOTE|DD|DT)$/u.test(element.tagName)
}

function accessibleContinuationCue(document: Document, label: string) {
  const cue = document.createElement('span')
  cue.setAttribute('data-review-continuation-cue', 'true')
  cue.setAttribute('role', 'note')
  cue.setAttribute('aria-label', label)
  return cue
}

function markListItemContinuation(item: HTMLElement) {
  item.style.setProperty('list-style', 'none', 'important')
  item.style.setProperty('display', 'block', 'important')
  item.setAttribute('data-review-list-item-continuation', 'true')
  for (
    let child = item.firstElementChild;
    child;
    child = child.nextElementSibling
  ) {
    if (child.hasAttribute('data-review-continuation-cue')) return
  }
  item.prepend(
    accessibleContinuationCue(
      item.ownerDocument,
      'Continued from previous page.',
    ),
  )
}

async function cloneNodeCooperatively<T extends Node>(
  source: T,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
): Promise<T> {
  await scheduler.checkpoint(signal)
  const clone = source.cloneNode(false)
  const cloneParent = clone as ParentNode
  for (let child = source.firstChild; child; child = child.nextSibling) {
    cloneParent.append(await cloneNodeCooperatively(child, scheduler, signal))
  }
  return clone as T
}

function integerAttribute(element: Element, name: string) {
  const value = element.getAttribute(name)
  if (!value || !/^[+-]?\d+$/u.test(value)) return null
  const integer = Number(value)
  return Number.isSafeInteger(integer) ? integer : null
}

async function orderedListContinuationStart(
  list: HTMLElement,
  children: Element[],
  point: number,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  const reversed = list.hasAttribute('reversed')
  const step = reversed ? -1 : 1
  let nextOrdinal =
    integerAttribute(list, 'start') ??
    (reversed ? children.filter((child) => child.tagName === 'LI').length : 1)
  for (let index = 0; index < children.length; index += 1) {
    await scheduler.checkpoint(signal)
    const child = children[index]
    if (child.tagName !== 'LI') continue
    const ordinal = integerAttribute(child, 'value') ?? nextOrdinal
    if (index >= point) return ordinal
    nextOrdinal = ordinal + step
  }
  return nextOrdinal
}

async function definitionListSplitPoints(
  children: Element[],
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  if (
    children.length > 0 &&
    children.every((child) => child.tagName === 'DIV')
  ) {
    for (const group of children) {
      let hasTerm = false
      let hasDefinition = false
      let definitionsStarted = false
      for (
        let child = group.firstElementChild;
        child;
        child = child.nextElementSibling
      ) {
        await scheduler.checkpoint(signal)
        if (child.tagName === 'DT' && !definitionsStarted) {
          hasTerm = true
        } else if (child.tagName === 'DD' && hasTerm) {
          hasDefinition = true
          definitionsStarted = true
        } else {
          return []
        }
      }
      if (!hasTerm || !hasDefinition) return []
    }
    return children.slice(0, -1).map((_child, index) => index + 1)
  }
  const points: number[] = []
  let groupHasTerm = false
  let groupHasDefinition = false
  for (let index = 0; index < children.length; index += 1) {
    await scheduler.checkpoint(signal)
    const tagName = children[index].tagName
    if (tagName === 'DT') {
      if (groupHasTerm && groupHasDefinition) {
        points.push(index)
        groupHasTerm = false
        groupHasDefinition = false
      }
      groupHasTerm = true
    } else if (tagName === 'DD' && groupHasTerm) {
      groupHasDefinition = true
    }
  }
  return points
}

export async function splitReviewCandidate(
  element: HTMLElement,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  await scheduler.checkpoint(signal)
  const elementText = await textContentCooperatively(element, scheduler, signal)
  if (splittable(element) && elementText.length > 1) {
    const value = elementText
    return {
      points: (
        await textBoundariesCooperatively(value, scheduler, signal)
      ).filter((boundary) => boundary > 0 && boundary < value.length),
      async split(point: number) {
        return {
          head: await cloneElementTextRange(
            element,
            0,
            point,
            scheduler,
            signal,
          ),
          tail: await cloneElementTextRange(
            element,
            point,
            value.length,
            scheduler,
            signal,
          ),
        }
      },
    }
  }
  if (/^(?:OL|UL|DL)$/u.test(element.tagName)) {
    const children: Element[] = []
    for (
      let child = element.firstElementChild;
      child;
      child = child.nextElementSibling
    ) {
      children.push(child)
      await scheduler.checkpoint(signal)
    }
    if (children.length > 1) {
      const points =
        element.tagName === 'DL'
          ? await definitionListSplitPoints(children, scheduler, signal)
          : children.slice(0, -1).map((_child, index) => index + 1)
      return {
        points,
        async split(point: number) {
          const head = element.cloneNode(false) as HTMLElement
          const tail = element.cloneNode(false) as HTMLElement
          for (let index = 0; index < children.length; index += 1) {
            const clone = await cloneNodeCooperatively(
              children[index],
              scheduler,
              signal,
            )
            if (index < point) head.append(clone)
            else tail.append(clone)
          }
          if (element.tagName === 'OL') {
            if (
              element.hasAttribute('reversed') &&
              integerAttribute(element, 'start') === null
            ) {
              head.setAttribute(
                'start',
                String(
                  children.filter((child) => child.tagName === 'LI').length,
                ),
              )
            }
            tail.setAttribute(
              'start',
              String(
                await orderedListContinuationStart(
                  element,
                  children,
                  point,
                  scheduler,
                  signal,
                ),
              ),
            )
          }
          return { head, tail }
        },
      }
    }
    const onlyChild = children[0] as HTMLElement | undefined
    const value = onlyChild
      ? await textContentCooperatively(onlyChild, scheduler, signal)
      : ''
    if (element.tagName !== 'DL' && onlyChild && value.length > 1) {
      return {
        points: (
          await textBoundariesCooperatively(value, scheduler, signal)
        ).filter((boundary) => boundary > 0 && boundary < value.length),
        async split(point: number) {
          const head = element.cloneNode(false) as HTMLElement
          const tail = element.cloneNode(false) as HTMLElement
          const headChild = await cloneElementTextRange(
            onlyChild,
            0,
            point,
            scheduler,
            signal,
          )
          const tailChild = await cloneElementTextRange(
            onlyChild,
            point,
            value.length,
            scheduler,
            signal,
          )
          if (headChild) {
            if (
              headChild.tagName === 'LI' &&
              onlyChild.getAttribute('data-review-list-item-continuation') ===
                'true'
            ) {
              markListItemContinuation(headChild)
            }
            head.append(headChild)
          }
          if (tailChild) {
            if (tailChild.tagName === 'LI') {
              markListItemContinuation(tailChild)
            }
            tail.append(tailChild)
          }
          return { head, tail }
        },
      }
    }
  }
  return null
}

async function referencedNoteIds(
  element: Element,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const candidate of elementsInSubtree(element, false)) {
    await scheduler.checkpoint(signal)
    if (
      candidate.tagName !== 'A' ||
      !candidate.getAttribute('href')?.startsWith('#') ||
      (!candidate
        .getAttribute('epub:type')
        ?.split(/\s+/u)
        .includes('noteref') &&
        candidate.getAttribute('role') !== 'doc-noteref')
    ) {
      continue
    }
    const href = candidate.getAttribute('href') ?? ''
    try {
      const id = href.length > 1 ? decodeURIComponent(href.slice(1)) : ''
      if (id && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    } catch {
      // Ignore malformed same-document identifiers exactly as before.
    }
  }
  return ids
}

async function pageOverflows(
  page: HTMLElement,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  const body = page.querySelector<HTMLElement>('[data-review-page-body]')!
  const notes = page.querySelector<HTMLElement>('[data-review-page-notes]')!
  const hasUnfittedDescendantOverflow = async (container: HTMLElement) => {
    for (const candidate of elementsInSubtree(container, false)) {
      await scheduler.checkpoint(signal)
      const element = candidate as HTMLElement
      if (element.closest('[data-review-atomic-fit="true"]')) continue
      if (
        element.clientWidth > 0 &&
        element.scrollWidth > element.clientWidth + 1
      ) {
        return true
      }
    }
    return false
  }
  await scheduler.checkpoint(signal)
  if (
    body.scrollWidth > body.clientWidth + 1 ||
    body.scrollHeight > body.clientHeight + 1 ||
    notes.scrollWidth > notes.clientWidth + 1 ||
    notes.scrollHeight > notes.clientHeight + 1 ||
    page.scrollWidth > page.clientWidth + 1
  ) {
    return true
  }
  return (
    (await hasUnfittedDescendantOverflow(body)) ||
    (await hasUnfittedDescendantOverflow(notes))
  )
}

async function fitAtomicCandidate(
  document: Document,
  body: HTMLElement,
  candidate: HTMLElement,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  await scheduler.checkpoint(signal)
  body.append(candidate)
  const naturalWidth = Math.max(
    candidate.scrollWidth,
    Math.ceil(candidate.getBoundingClientRect().width),
  )
  const naturalHeight = Math.max(
    candidate.scrollHeight,
    Math.ceil(candidate.getBoundingClientRect().height),
  )
  const availableWidth = body.clientWidth
  const availableHeight = body.clientHeight
  candidate.remove()
  await scheduler.checkpoint(signal)
  if (
    naturalWidth < 1 ||
    naturalHeight < 1 ||
    availableWidth < 1 ||
    availableHeight < 1
  ) {
    return false
  }
  const scale = Math.min(
    1,
    availableWidth / naturalWidth,
    availableHeight / naturalHeight,
  )
  const wrapper = document.createElement('div')
  wrapper.dataset.reviewAtomicFit = 'true'
  wrapper.style.width = `${Math.min(availableWidth, naturalWidth * scale)}px`
  wrapper.style.height = `${Math.min(availableHeight, naturalHeight * scale)}px`
  wrapper.style.position = 'relative'
  wrapper.style.overflow = 'hidden'
  candidate.style.setProperty('width', `${naturalWidth}px`, 'important')
  candidate.style.setProperty('max-width', 'none', 'important')
  candidate.style.setProperty('margin', '0', 'important')
  candidate.style.setProperty('box-sizing', 'border-box', 'important')
  candidate.style.position = 'absolute'
  candidate.style.inset = '0 auto auto 0'
  candidate.style.transform = `scale(${scale})`
  candidate.style.transformOrigin = 'top left'
  wrapper.append(candidate)
  body.append(wrapper)
  return true
}

function reviewPage(document: Document, pageNumber: number) {
  const page = document.createElement('section')
  page.dataset.reviewPageFragment = String(pageNumber)
  page.setAttribute('aria-label', `EPUB page ${pageNumber}`)
  const body = document.createElement('div')
  body.dataset.reviewPageBody = 'true'
  const notes = document.createElement('footer')
  notes.dataset.reviewPageNotes = 'true'
  notes.setAttribute('aria-label', 'Page footnotes')
  page.append(body, notes)
  return page
}

export function createReviewPageSwitcher(
  pages: HTMLElement[],
  onSelection: (page: number) => void = () => undefined,
) {
  let visibleIndex = -1
  return (requestedPage: number) => {
    const selected = Math.min(
      Math.max(1, pages.length),
      Math.max(1, Math.trunc(requestedPage) || 1),
    )
    const selectedIndex = pages.length > 0 ? selected - 1 : -1
    if (selectedIndex === visibleIndex) return selected
    if (visibleIndex >= 0) {
      pages[visibleIndex].hidden = true
      pages[visibleIndex].setAttribute('aria-hidden', 'true')
    }
    if (selectedIndex >= 0) {
      pages[selectedIndex].hidden = false
      pages[selectedIndex].setAttribute('aria-hidden', 'false')
    }
    visibleIndex = selectedIndex
    onSelection(selected)
    return selected
  }
}

export function reviewFootnoteContinuationLabel(
  chunkIndex: number,
  chunkCount: number,
) {
  if (chunkCount <= 1 || chunkIndex < 0 || chunkIndex >= chunkCount) return null
  const continuesFromPrior = chunkIndex > 0
  const continuesOnNext = chunkIndex < chunkCount - 1
  if (continuesFromPrior && continuesOnNext) {
    return 'Continued from prior page and on next page.'
  }
  return continuesFromPrior
    ? 'Continued from prior page.'
    : 'Continued on next page.'
}

async function noteChunks(
  note: HTMLElement,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  const text = await textContentCooperatively(note, scheduler, signal)
  const chunks = await deterministicTextChunksCooperatively(text, {
    scheduler,
    signal,
  })
  const clones: HTMLElement[] = []
  let start = 0
  for (let index = 0; index < chunks.length; index += 1) {
    const end = start + chunks[index].length
    const clone =
      (await cloneElementTextRange(note, start, end, scheduler, signal)) ??
      (await cloneNodeCooperatively(note, scheduler, signal))
    if (index > 0) await removeAllTargets(clone, scheduler, signal)
    clone.dataset.reviewFootnoteChunk = `${index + 1}/${chunks.length}`
    const continuationLabel = reviewFootnoteContinuationLabel(
      index,
      chunks.length,
    )
    if (continuationLabel) {
      const label = note.ownerDocument.createElement('span')
      label.className = 'review-footnote-continuation-label'
      label.textContent = `${continuationLabel} `
      clone.prepend(label)
    }
    clones.push(clone)
    start = end
  }
  return clones
}

export async function collectTopLevelReviewCandidates(
  main: HTMLElement,
  document: Document,
  scheduler: ReviewPaginationScheduler,
  signal?: AbortSignal,
) {
  const candidates: HTMLElement[] = []
  const pendingComments: ChildNode[] = []
  while (main.firstChild) {
    const node = main.firstChild
    ;(node as ChildNode).remove()
    if (node.nodeType === 1) {
      const element = node as HTMLElement
      if (pendingComments.length > 0) {
        element.prepend(...pendingComments.splice(0))
      }
      candidates.push(element)
    } else if (node.nodeType === 3 && node.textContent?.trim()) {
      const anonymousBlock = document.createElement('p')
      anonymousBlock.dataset.reviewAnonymousBlock = 'true'
      anonymousBlock.append(...pendingComments.splice(0), node)
      candidates.push(anonymousBlock)
    } else if (node.nodeType === 8) {
      pendingComments.push(node as ChildNode)
    }
    await scheduler.checkpoint(signal)
  }
  if (pendingComments.length > 0) {
    const lastCandidate = candidates.at(-1)
    if (lastCandidate) lastCandidate.append(...pendingComments)
    else main.append(...pendingComments)
  }
  return candidates
}

export async function materializeDiscreteReviewPages(
  document: Document,
  options: {
    signal?: AbortSignal
    scheduler?: ReviewPaginationScheduler
  } = {},
): Promise<DiscreteReviewPagination> {
  requireActivePagination(options.signal)
  const scheduler = options.scheduler ?? createReviewPaginationScheduler()
  const main = document.querySelector<HTMLElement>('main')
  if (!main) {
    return {
      pageCount: 1,
      pageForTarget: () => null,
      show: () => 1,
    }
  }
  let sourceTemplate = document.head.querySelector<HTMLTemplateElement>(
    `template[${REVIEW_SOURCE_TEMPLATE_ATTRIBUTE}]`,
  )
  if (!sourceTemplate) {
    sourceTemplate = document.createElement('template')
    sourceTemplate.setAttribute(REVIEW_SOURCE_TEMPLATE_ATTRIBUTE, 'true')
    for (let node = main.firstChild; node; node = node.nextSibling) {
      sourceTemplate.content.append(
        await cloneNodeCooperatively(node, scheduler, options.signal),
      )
    }
    document.head.append(sourceTemplate)
  }
  let mainWasMutated = false
  try {
    const storedSourceNodes: Node[] = []
    const restoredSource = document.createDocumentFragment()
    for (
      let node = sourceTemplate.content.firstChild;
      node;
      node = node.nextSibling
    ) {
      storedSourceNodes.push(node)
      restoredSource.append(
        await cloneNodeCooperatively(node, scheduler, options.signal),
      )
    }
    main.replaceChildren(restoredSource)
    mainWasMutated = true
    await scheduler.checkpoint(options.signal)
    const images: HTMLImageElement[] = []
    for (const element of elementsInSubtree(main, false)) {
      await scheduler.checkpoint(options.signal)
      if (element.tagName === 'IMG') images.push(element as HTMLImageElement)
    }
    await Promise.all(
      images.map((image) => waitForPaginationImage(image, options.signal)),
    )
    requireActivePagination(options.signal)
    const notesById = new Map<string, HTMLElement>()
    for (const element of elementsInSubtree(main, false)) {
      await scheduler.checkpoint(options.signal)
      if (
        element.matches(
          'aside[epub\\:type~="footnote"], aside[role="doc-footnote"], aside[role="doc-endnote"]',
        ) &&
        element.id
      ) {
        notesById.set(element.id, element as HTMLElement)
      }
    }
    for (const note of notesById.values()) {
      note.remove()
      await scheduler.checkpoint(options.signal)
    }
    // Move the exact loaded nodes into the pagination queue. Cloning here would
    // create fresh image elements after the readiness barrier and make their
    // pre-load height look safe even though they later expand and clip.
    const queue = await collectTopLevelReviewCandidates(
      main,
      document,
      scheduler,
      options.signal,
    )
    const pagesRoot = document.createElement('div')
    pagesRoot.dataset.reviewPages = 'true'
    pagesRoot.dataset.reviewMeasuring = 'true'
    main.append(pagesRoot)

    const pages: HTMLElement[] = []
    const scheduledNotes = new Set<string>()
    const pendingNoteChunks: HTMLElement[] = []
    const pendingNoteFront: HTMLElement[] = []
    let pendingNoteIndex = 0
    const hasPendingNoteChunks = () =>
      pendingNoteFront.length > 0 || pendingNoteIndex < pendingNoteChunks.length
    const takePendingNoteChunk = () =>
      pendingNoteFront.pop() ?? pendingNoteChunks[pendingNoteIndex++]!
    const restorePendingNoteChunk = (chunk: HTMLElement) =>
      pendingNoteFront.push(chunk)
    let page = reviewPage(document, 1)
    pagesRoot.append(page)
    let body = page.querySelector<HTMLElement>('[data-review-page-body]')!
    let footer = page.querySelector<HTMLElement>('[data-review-page-notes]')!

    const finishPage = async () => {
      // A completed page no longer participates in measurement. Keeping every
      // prior sheet visible makes each subsequent overflow read relayout the
      // entire book, which becomes quadratic on 200-page documents. Hidden
      // fragments retain their DOM, IDs, links, and target ownership for
      // deterministic navigation without contributing layout work.
      page.hidden = true
      page.setAttribute('aria-hidden', 'true')
      pages.push(page)
      page = reviewPage(document, pages.length + 1)
      pagesRoot.append(page)
      body = page.querySelector<HTMLElement>('[data-review-page-body]')!
      footer = page.querySelector<HTMLElement>('[data-review-page-notes]')!
      while (hasPendingNoteChunks()) {
        await scheduler.checkpoint(options.signal)
        const continuation = takePendingNoteChunk()
        footer.append(continuation)
        if (await pageOverflows(page, scheduler, options.signal)) {
          continuation.remove()
          restorePendingNoteChunk(continuation)
          break
        }
      }
    }

    let paginationOperations = 0
    const maximumPaginationOperations = Math.max(
      1_000,
      storedSourceNodes.length * 256,
    )
    const queueFront: HTMLElement[] = []
    let queueIndex = 0
    const hasQueuedCandidates = () =>
      queueFront.length > 0 || queueIndex < queue.length
    const takeQueuedCandidate = () => queueFront.pop() ?? queue[queueIndex++]!
    const restoreQueuedCandidate = (candidate: HTMLElement) =>
      queueFront.push(candidate)
    while (hasQueuedCandidates()) {
      await scheduler.checkpoint(options.signal)
      paginationOperations += 1
      if (paginationOperations > maximumPaginationOperations) {
        throw new Error(
          'EPUB review pagination exceeded its deterministic operation bound.',
        )
      }
      const candidate = takeQueuedCandidate()
      const addedNotes: Array<{ id: string; chunks: HTMLElement[] }> = []
      body.append(candidate)
      for (const id of await referencedNoteIds(
        candidate,
        scheduler,
        options.signal,
      )) {
        if (scheduledNotes.has(id)) continue
        const note = notesById.get(id)
        if (!note) continue
        const chunks = await noteChunks(note, scheduler, options.signal)
        footer.append(chunks[0])
        addedNotes.push({ id, chunks })
      }
      const candidateOverflows = await pageOverflows(
        page,
        scheduler,
        options.signal,
      )
      if (!candidateOverflows) {
        for (const added of addedNotes) {
          scheduledNotes.add(added.id)
          pendingNoteChunks.push(...added.chunks.slice(1))
        }
        continue
      }

      candidate.remove()
      for (const added of addedNotes) added.chunks[0].remove()
      if (body.childElementCount > 0 || footer.childElementCount > 0) {
        restoreQueuedCandidate(candidate)
        await finishPage()
        continue
      }

      const split = await splitReviewCandidate(
        candidate,
        scheduler,
        options.signal,
      )
      if (split && split.points.length > 0) {
        let lower = 0
        let upper = split.points.length - 1
        let accepted: {
          head: HTMLElement
          tail: HTMLElement | null
          notes: Array<{ id: string; chunks: HTMLElement[] }>
        } | null = null
        while (lower <= upper) {
          await scheduler.checkpoint(options.signal)
          const middle = Math.floor((lower + upper) / 2)
          const point = split.points[middle]
          const { head, tail } = await split.split(point)
          if (!head) break
          body.replaceChildren(head)
          footer.replaceChildren()
          const tentativeNotes: Array<{
            id: string
            chunks: HTMLElement[]
          }> = []
          for (const id of await referencedNoteIds(
            head,
            scheduler,
            options.signal,
          )) {
            if (scheduledNotes.has(id)) continue
            const note = notesById.get(id)
            if (!note) continue
            const chunks = await noteChunks(note, scheduler, options.signal)
            footer.append(chunks[0])
            tentativeNotes.push({ id, chunks })
          }
          if (await pageOverflows(page, scheduler, options.signal)) {
            upper = middle - 1
          } else {
            accepted = { head, tail, notes: tentativeNotes }
            lower = middle + 1
          }
        }
        body.replaceChildren()
        footer.replaceChildren()
        if (accepted) {
          body.append(accepted.head)
          for (const added of accepted.notes) {
            footer.append(added.chunks[0])
            scheduledNotes.add(added.id)
            pendingNoteChunks.push(...added.chunks.slice(1))
          }
          if (accepted.tail) {
            await removeTargetsOwnedBy(
              accepted.tail,
              accepted.head,
              scheduler,
              options.signal,
            )
            accepted.tail.dataset.reviewContinuation = 'true'
            restoreQueuedCandidate(accepted.tail)
          }
          await finishPage()
          continue
        }
      }

      for (const added of addedNotes) footer.append(added.chunks[0])
      if (
        !(await fitAtomicCandidate(
          document,
          body,
          candidate,
          scheduler,
          options.signal,
        )) ||
        (await pageOverflows(page, scheduler, options.signal))
      ) {
        throw new Error(
          'EPUB review pagination could not fit a complete atomic semantic object without clipping.',
        )
      }
      for (const added of addedNotes) {
        scheduledNotes.add(added.id)
        pendingNoteChunks.push(...added.chunks.slice(1))
      }
      await finishPage()
    }

    if (body.childElementCount > 0 || footer.childElementCount > 0) {
      page.hidden = true
      page.setAttribute('aria-hidden', 'true')
      pages.push(page)
    } else {
      page.remove()
    }
    while (hasPendingNoteChunks()) {
      await scheduler.checkpoint(options.signal)
      const continuationPage = reviewPage(document, pages.length + 1)
      const continuationFooter = continuationPage.querySelector<HTMLElement>(
        '[data-review-page-notes]',
      )!
      continuationFooter.append(takePendingNoteChunk())
      pagesRoot.append(continuationPage)
      if (await pageOverflows(continuationPage, scheduler, options.signal)) {
        throw new Error(
          'EPUB review pagination could not fit a complete footnote continuation without clipping.',
        )
      }
      continuationPage.hidden = true
      continuationPage.setAttribute('aria-hidden', 'true')
      pages.push(continuationPage)
    }

    pagesRoot.removeAttribute('data-review-measuring')
    await scheduler.checkpoint(options.signal)
    const show = createReviewPageSwitcher(pages, (selected) => {
      pagesRoot.dataset.reviewPage = String(selected)
    })
    show(1)
    return {
      pageCount: Math.max(1, pages.length),
      pageForTarget(target) {
        const owner = target.closest<HTMLElement>('[data-review-page-fragment]')
        const value = Number(owner?.dataset.reviewPageFragment)
        return Number.isInteger(value) && value > 0 ? value : null
      },
      show,
    }
  } catch (error) {
    if (mainWasMutated) {
      main.replaceChildren(sourceTemplate.content.cloneNode(true))
    }
    throw error
  }
}
