import { describe, expect, it } from 'vitest'
import {
  createReviewPageSwitcher,
  createReviewPaginationScheduler,
  collectTopLevelReviewCandidates,
  deterministicTextChunks,
  deterministicTextChunksCooperatively,
  materializeDiscreteReviewPages,
  REVIEW_FOOTNOTE_CHUNK_CHARACTERS,
  REVIEW_PAGINATION_SUPERSEDED_MESSAGE,
  reviewFootnoteContinuationLabel,
  splitReviewCandidate,
} from './epub-review-pagination'

class TestStyle {
  private readonly properties = new Map<
    string,
    { value: string; priority: string }
  >()

  setProperty(name: string, value: string, priority = '') {
    this.properties.set(name, { value, priority })
  }

  getPropertyValue(name: string) {
    return this.properties.get(name)?.value ?? ''
  }

  getPropertyPriority(name: string) {
    return this.properties.get(name)?.priority ?? ''
  }

  clone() {
    const clone = new TestStyle()
    for (const [name, property] of this.properties) {
      clone.setProperty(name, property.value, property.priority)
    }
    return clone
  }
}

class TestNode {
  parentNode: TestNode | null = null
  readonly childNodes: TestNode[] = []

  constructor(
    readonly ownerDocument: TestDocument,
    readonly nodeType: number,
    public nodeValue: string | null = null,
  ) {}

  get firstChild() {
    return this.childNodes[0] ?? null
  }

  get nextSibling(): TestNode | null {
    if (!this.parentNode) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return this.parentNode.childNodes[index + 1] ?? null
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? ''
    return this.childNodes.map((child) => child.textContent).join('')
  }

  append(...nodes: TestNode[]) {
    for (const node of nodes) {
      if (node.nodeType === 11) {
        for (const child of [...node.childNodes]) this.append(child)
        continue
      }
      node.remove()
      node.parentNode = this
      this.childNodes.push(node)
    }
  }

  prepend(...nodes: TestNode[]) {
    for (const node of [...nodes].reverse()) {
      node.remove()
      node.parentNode = this
      this.childNodes.unshift(node)
    }
  }

  remove() {
    if (!this.parentNode) return
    const index = this.parentNode.childNodes.indexOf(this)
    if (index >= 0) this.parentNode.childNodes.splice(index, 1)
    this.parentNode = null
  }

  cloneNode(deep = false): TestNode {
    const clone = new TestNode(
      this.ownerDocument,
      this.nodeType,
      this.nodeValue,
    )
    if (deep) {
      for (const child of this.childNodes) clone.append(child.cloneNode(true))
    }
    return clone
  }
}

class TestElement extends TestNode {
  private readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  style = new TestStyle()
  replacements = 0

  constructor(
    ownerDocument: TestDocument,
    readonly tagName: string,
  ) {
    super(ownerDocument, 1)
  }

  get firstElementChild(): TestElement | null {
    return (
      this.childNodes.find(
        (candidate): candidate is TestElement => candidate.nodeType === 1,
      ) ?? null
    )
  }

  get nextElementSibling(): TestElement | null {
    let sibling = this.nextSibling
    while (sibling && sibling.nodeType !== 1) sibling = sibling.nextSibling
    return (sibling as TestElement | null) ?? null
  }

  get childElementCount() {
    return this.childNodes.filter((candidate) => candidate.nodeType === 1)
      .length
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string) {
    return this.attributes.has(name)
  }

  removeAttribute(name: string) {
    this.attributes.delete(name)
  }

  matches() {
    return false
  }

  querySelector<T extends TestElement = TestElement>(selector: string) {
    const descendants: TestElement[] = []
    const visit = (node: TestNode) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) descendants.push(child as TestElement)
        visit(child)
      }
    }
    visit(this)
    if (selector === 'template[data-review-source-template]') {
      return (descendants.find(
        (candidate) =>
          candidate.tagName === 'TEMPLATE' &&
          candidate.hasAttribute('data-review-source-template'),
      ) ?? null) as T | null
    }
    return null
  }

  replaceChildren(...nodes: TestNode[]) {
    this.replacements += 1
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes.length = 0
    this.append(...nodes)
  }

  override cloneNode(deep = false): TestElement {
    const clone = new TestElement(this.ownerDocument, this.tagName)
    for (const [name, value] of this.attributes) clone.setAttribute(name, value)
    Object.assign(clone.dataset, this.dataset)
    clone.style = this.style.clone()
    if (deep) {
      for (const child of this.childNodes) clone.append(child.cloneNode(true))
    }
    return clone
  }
}

class TestFragment extends TestNode {
  constructor(ownerDocument: TestDocument) {
    super(ownerDocument, 11)
  }

  get firstElementChild(): TestElement | null {
    return (
      this.childNodes.find(
        (candidate): candidate is TestElement => candidate.nodeType === 1,
      ) ?? null
    )
  }

  override cloneNode(deep = false): TestFragment {
    const clone = new TestFragment(this.ownerDocument)
    if (deep) {
      for (const child of this.childNodes) clone.append(child.cloneNode(true))
    }
    return clone
  }
}

class TestTemplate extends TestElement {
  readonly content: TestFragment

  constructor(ownerDocument: TestDocument) {
    super(ownerDocument, 'TEMPLATE')
    this.content = new TestFragment(ownerDocument)
  }
}

class TestDocument {
  readonly head = new TestElement(this, 'HEAD')
  main: TestElement | null = null

  querySelector<T extends TestElement = TestElement>(selector: string) {
    return (selector === 'main' ? this.main : null) as T | null
  }

  createElement(tagName: string) {
    return tagName.toLowerCase() === 'template'
      ? new TestTemplate(this)
      : new TestElement(this, tagName.toUpperCase())
  }

  createTextNode(value: string) {
    return new TestNode(this, 3, value)
  }

  createComment(value: string) {
    return new TestNode(this, 8, value)
  }

  createDocumentFragment() {
    return new TestFragment(this)
  }

  createTreeWalker(root: TestNode, whatToShow: number) {
    const descendants: TestNode[] = []
    const includedNodeType = whatToShow === 4 ? 3 : whatToShow
    const visit = (node: TestNode) => {
      for (const child of node.childNodes) {
        if (child.nodeType === includedNodeType) descendants.push(child)
        visit(child)
      }
    }
    visit(root)
    let index = 0
    return {
      nextNode() {
        return descendants[index++] ?? null
      },
    }
  }
}

function testElement(
  document: TestDocument,
  tagName: string,
  options: {
    attributes?: Record<string, string>
    children?: Array<TestElement | string>
  } = {},
) {
  const element = document.createElement(tagName) as TestElement
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    element.setAttribute(name, value)
  }
  for (const child of options.children ?? []) {
    element.append(
      typeof child === 'string' ? document.createTextNode(child) : child,
    )
  }
  return element
}

const immediateScheduler = {
  checkpoint: async () => undefined,
}

describe('discrete EPUB review pagination', () => {
  it('yields when one logical operation exhausts its elapsed-time budget', async () => {
    let now = 100
    let yields = 0
    const scheduler = createReviewPaginationScheduler({
      budgetMs: 8,
      now: () => now,
      yieldTask: async () => {
        yields += 1
      },
    })

    now = 107
    await scheduler.checkpoint()
    expect(yields).toBe(0)

    now = 108
    await scheduler.checkpoint()
    expect(yields).toBe(1)

    now = 115
    await scheduler.checkpoint()
    expect(yields).toBe(1)

    now = 116
    await scheduler.checkpoint()
    expect(yields).toBe(2)
  })

  it('switches visibility by touching only the old and selected pages', () => {
    const touched = new Set<number>()
    const pages = Array.from({ length: 1_000 }, (_value, index) => {
      let hidden = true
      return {
        get hidden() {
          return hidden
        },
        set hidden(value: boolean) {
          hidden = value
          touched.add(index)
        },
        setAttribute() {
          touched.add(index)
        },
      }
    }) as unknown as HTMLElement[]
    const show = createReviewPageSwitcher(pages)

    expect(show(500)).toBe(500)
    expect([...touched]).toEqual([499])

    touched.clear()
    expect(show(501)).toBe(501)
    expect([...touched]).toEqual([499, 500])

    touched.clear()
    expect(show(501)).toBe(501)
    expect([...touched]).toEqual([])
  })

  it('cooperatively scans one large text value without changing its chunks', async () => {
    let clock = 0
    let yields = 0
    const scheduler = createReviewPaginationScheduler({
      budgetMs: 4,
      now: () => clock++,
      yieldTask: async () => {
        yields += 1
      },
    })
    const text = Array.from(
      { length: 200 },
      (_value, index) => `token-${index}`,
    ).join(' ')

    const chunks = await deterministicTextChunksCooperatively(text, {
      maximumCharacters: 80,
      scheduler,
    })

    expect(chunks.join('')).toBe(text)
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true)
    expect(yields).toBeGreaterThan(0)
  })

  it('splits oversized footnotes deterministically at word boundaries', () => {
    const text = Array.from(
      { length: 160 },
      (_, index) => `word-${String(index).padStart(3, '0')}`,
    ).join(' ')
    const first = deterministicTextChunks(text)
    const second = deterministicTextChunks(text)

    expect(second).toEqual(first)
    expect(first.join('')).toBe(text)
    expect(first.length).toBeGreaterThan(1)
    expect(
      first.every((chunk) => chunk.length <= REVIEW_FOOTNOTE_CHUNK_CHARACTERS),
    ).toBe(true)
    expect(first.slice(0, -1).every((chunk) => /\s$/u.test(chunk))).toBe(true)
  })

  it('makes progress for an individual token longer than the note limit', () => {
    const text = 'x'.repeat(REVIEW_FOOTNOTE_CHUNK_CHARACTERS * 2 + 17)
    const chunks = deterministicTextChunks(text)

    expect(chunks.join('')).toBe(text)
    expect(chunks).toHaveLength(3)
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true)
  })

  it('describes both directions for an intermediate footnote chunk', () => {
    expect(reviewFootnoteContinuationLabel(0, 3)).toBe(
      'Continued on next page.',
    )
    expect(reviewFootnoteContinuationLabel(1, 3)).toBe(
      'Continued from prior page and on next page.',
    )
    expect(reviewFootnoteContinuationLabel(2, 3)).toBe(
      'Continued from prior page.',
    )
    expect(reviewFootnoteContinuationLabel(0, 1)).toBeNull()
  })

  it('keeps the superseded-layout failure explicit and stable', () => {
    expect(REVIEW_PAGINATION_SUPERSEDED_MESSAGE).toBe(
      'EPUB review pagination was superseded by a newer layout.',
    )
  })

  it('rejects a superseded job before reading or mutating its document', async () => {
    const controller = new AbortController()
    controller.abort()
    const document = {
      querySelector() {
        throw new Error('the cancelled job touched its stale document')
      },
    } as unknown as Document

    await expect(
      materializeDiscreteReviewPages(document, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(REVIEW_PAGINATION_SUPERSEDED_MESSAGE)
  })

  it.each<{
    name: string
    attributes: Record<string, string>
    items: Array<{ text: string; value?: string }>
    point: number
    expectedStart: string
  }>([
    {
      name: 'start',
      attributes: { start: '4' },
      items: [{ text: 'four' }, { text: 'five' }, { text: 'six' }],
      point: 2,
      expectedStart: '6',
    },
    {
      name: 'reversed',
      attributes: { reversed: '' },
      items: [{ text: 'three' }, { text: 'two' }, { text: 'one' }],
      point: 1,
      expectedStart: '2',
    },
    {
      name: 'li value',
      attributes: { start: '4' },
      items: [{ text: 'four' }, { text: 'nine', value: '9' }, { text: 'ten' }],
      point: 2,
      expectedStart: '10',
    },
    {
      name: 'reversed li value',
      attributes: { reversed: '', start: '10' },
      items: [{ text: 'ten' }, { text: 'seven', value: '7' }, { text: 'six' }],
      point: 2,
      expectedStart: '6',
    },
  ])(
    'continues ordered-list numbering after a split with $name',
    async ({ attributes, items, point, expectedStart }) => {
      const document = new TestDocument()
      const list = testElement(document, 'ol', {
        attributes,
        children: items.map(({ text, value }) =>
          testElement(document, 'li', {
            attributes: value ? { value } : undefined,
            children: [text],
          }),
        ),
      })

      const split = await splitReviewCandidate(
        list as unknown as HTMLElement,
        immediateScheduler,
      )
      const result = await split?.split(point)

      expect(result?.tail?.getAttribute('start')).toBe(expectedStart)
    },
  )

  it('preserves the original head ordinal when splitting a default reversed list', async () => {
    const document = new TestDocument()
    const list = testElement(document, 'ol', {
      attributes: { reversed: '' },
      children: ['three', 'two', 'one'].map((text) =>
        testElement(document, 'li', { children: [text] }),
      ),
    })

    const split = await splitReviewCandidate(
      list as unknown as HTMLElement,
      immediateScheduler,
    )
    const result = await split?.split(1)

    expect(result?.head?.getAttribute('start')).toBe('3')
    expect(result?.tail?.getAttribute('start')).toBe('2')
  })

  it.each(['ol', 'ul'])(
    'suppresses the repeated marker when one long %s item continues',
    async (tagName) => {
      const document = new TestDocument()
      const list = testElement(document, tagName, {
        children: [
          testElement(document, 'li', {
            children: ['alpha beta gamma'],
          }),
        ],
      })

      const split = await splitReviewCandidate(
        list as unknown as HTMLElement,
        immediateScheduler,
      )
      const result = await split?.split('alpha '.length)
      const continuation = result?.tail?.firstElementChild as HTMLElement

      expect(continuation.style.getPropertyValue('list-style')).toBe('none')
      expect(continuation.style.getPropertyPriority('list-style')).toBe(
        'important',
      )
      expect(continuation.style.getPropertyValue('display')).toBe('block')
      expect(continuation.style.getPropertyPriority('display')).toBe(
        'important',
      )
      expect(
        continuation.getAttribute('data-review-list-item-continuation'),
      ).toBe('true')
      const cue = continuation.firstElementChild
      expect(cue?.getAttribute('role')).toBe('note')
      expect(cue?.getAttribute('aria-label')).toBe(
        'Continued from previous page.',
      )
      expect(cue?.textContent).toBe('')
      expect(continuation.textContent).toBe('beta gamma')
    },
  )

  it('retains an accessible cue when a list continuation splits again', async () => {
    const document = new TestDocument()
    const list = testElement(document, 'ol', {
      children: [
        testElement(document, 'li', {
          children: ['alpha beta gamma delta'],
        }),
      ],
    })
    const firstSplit = await splitReviewCandidate(
      list as unknown as HTMLElement,
      immediateScheduler,
    )
    const first = await firstSplit?.split('alpha '.length)
    const secondSplit = await splitReviewCandidate(
      first?.tail as HTMLElement,
      immediateScheduler,
    )
    const second = await secondSplit?.split('beta '.length)
    const intermediate = second?.head
      ?.firstElementChild as unknown as TestElement
    const cue = intermediate.firstElementChild

    expect(
      intermediate.getAttribute('data-review-list-item-continuation'),
    ).toBe('true')
    expect(cue?.getAttribute('aria-label')).toBe(
      'Continued from previous page.',
    )
    expect(intermediate.textContent).toBe('beta ')
  })

  it('offers definition-list splits only after complete term-definition groups', async () => {
    const document = new TestDocument()
    const list = testElement(document, 'dl', {
      children: [
        testElement(document, 'dt', { children: ['First'] }),
        testElement(document, 'dd', { children: ['First definition'] }),
        testElement(document, 'dd', { children: ['First example'] }),
        testElement(document, 'dt', { children: ['Second'] }),
        testElement(document, 'dd', { children: ['Second definition'] }),
      ],
    })

    const split = await splitReviewCandidate(
      list as unknown as HTMLElement,
      immediateScheduler,
    )

    expect(split?.points).toEqual([3])
  })

  it('splits direct DIV-wrapped definition groups only when every group is complete', async () => {
    const document = new TestDocument()
    const completeGroup = (term: string, definition: string) =>
      testElement(document, 'div', {
        children: [
          testElement(document, 'dt', { children: [term] }),
          testElement(document, 'dd', { children: [definition] }),
        ],
      })
    const complete = testElement(document, 'dl', {
      children: [
        completeGroup('First', 'First definition'),
        completeGroup('Second', 'Second definition'),
      ],
    })
    const incomplete = testElement(document, 'dl', {
      children: [
        completeGroup('First', 'First definition'),
        testElement(document, 'div', {
          children: [testElement(document, 'dt', { children: ['Second'] })],
        }),
      ],
    })

    const completeSplit = await splitReviewCandidate(
      complete as unknown as HTMLElement,
      immediateScheduler,
    )
    const incompleteSplit = await splitReviewCandidate(
      incomplete as unknown as HTMLElement,
      immediateScheduler,
    )
    const result = await completeSplit?.split(1)

    expect(completeSplit?.points).toEqual([1])
    expect(result?.head?.firstElementChild?.tagName).toBe('DIV')
    expect(result?.tail?.firstElementChild?.tagName).toBe('DIV')
    expect(incompleteSplit?.points).toEqual([])
  })

  it('restores the original main DOM when pagination is superseded after mutation', async () => {
    const document = new TestDocument()
    const original = testElement(document, 'p', {
      attributes: { id: 'original' },
      children: [
        'Before ',
        testElement(document, 'em', { children: ['pagination'] }),
      ],
    })
    document.main = testElement(document, 'main', { children: [original] })
    const controller = new AbortController()
    const scheduler = {
      async checkpoint() {
        if (
          document.main?.replacements === 1 &&
          document.main.childElementCount === 0
        ) {
          controller.abort()
        }
        if (controller.signal.aborted) {
          throw new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE)
        }
      },
    }

    await expect(
      materializeDiscreteReviewPages(document as unknown as Document, {
        scheduler,
        signal: controller.signal,
      }),
    ).rejects.toThrow(REVIEW_PAGINATION_SUPERSEDED_MESSAGE)

    expect(document.main.replacements).toBe(2)
    expect(document.main.firstElementChild?.tagName).toBe('P')
    expect(document.main.firstElementChild?.getAttribute('id')).toBe('original')
    expect(document.main.textContent).toBe('Before pagination')
  })

  it('restores the original main DOM when pagination fails after mutation', async () => {
    const document = new TestDocument()
    const original = testElement(document, 'blockquote', {
      attributes: { id: 'original-quote' },
      children: ['A complete semantic object'],
    })
    document.main = testElement(document, 'main', { children: [original] })
    const scheduler = {
      async checkpoint() {
        if (
          document.main?.replacements === 1 &&
          document.main.childElementCount === 0
        ) {
          throw new Error('forced pagination failure')
        }
      },
    }

    await expect(
      materializeDiscreteReviewPages(document as unknown as Document, {
        scheduler,
      }),
    ).rejects.toThrow('forced pagination failure')

    expect(document.main.replacements).toBe(2)
    expect(document.main.firstElementChild?.tagName).toBe('BLOCKQUOTE')
    expect(document.main.firstElementChild?.getAttribute('id')).toBe(
      'original-quote',
    )
    expect(document.main.textContent).toBe('A complete semantic object')
  })

  it('restores top-level text and comments after a partial pagination failure', async () => {
    const document = new TestDocument()
    const text = document.createTextNode('Loose text')
    const comment = document.createComment('editorial marker')
    const paragraph = testElement(document, 'p', {
      children: ['Structured text'],
    })
    document.main = testElement(document, 'main')
    document.main.append(text, comment, paragraph)
    const scheduler = {
      async checkpoint() {
        if (
          document.main?.replacements === 1 &&
          document.main.childNodes.length === 0
        ) {
          throw new Error('forced all-node rollback')
        }
      },
    }

    await expect(
      materializeDiscreteReviewPages(document as unknown as Document, {
        scheduler,
      }),
    ).rejects.toThrow('forced all-node rollback')

    expect(document.main.childNodes.map((node) => node.nodeType)).toEqual([
      3, 8, 1,
    ])
    expect(document.main.childNodes[0]?.nodeValue).toBe('Loose text')
    expect(document.main.childNodes[1]?.nodeValue).toBe('editorial marker')
    expect(document.main.childNodes[2]?.textContent).toBe('Structured text')
  })

  it('preserves top-level comments in normal candidates while ignoring layout-only whitespace', async () => {
    const document = new TestDocument()
    const paragraph = testElement(document, 'p', {
      children: ['Structured text'],
    })
    document.main = testElement(document, 'main')
    document.main.append(
      document.createTextNode('\n  '),
      document.createComment('before paragraph'),
      paragraph,
      document.createTextNode(' \n '),
      document.createTextNode('Loose text'),
      document.createComment('after loose text'),
      document.createTextNode('\n'),
    )

    const candidates = await collectTopLevelReviewCandidates(
      document.main as unknown as HTMLElement,
      document as unknown as Document,
      immediateScheduler,
    )

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toBe(paragraph)
    expect(
      (candidates[0] as unknown as TestElement).childNodes.map(
        (node) => node.nodeType,
      ),
    ).toEqual([8, 3])
    expect(candidates[0].textContent).toBe('Structured text')
    expect(candidates[1].dataset.reviewAnonymousBlock).toBe('true')
    expect(
      (candidates[1] as unknown as TestElement).childNodes.map(
        (node) => node.nodeType,
      ),
    ).toEqual([3, 8])
    expect(candidates[1].textContent).toBe('Loose text')
    expect(document.main.childNodes).toEqual([])
  })
})
