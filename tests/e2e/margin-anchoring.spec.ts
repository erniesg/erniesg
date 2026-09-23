import { expect, test, type Page } from '@playwright/test'
import { installStaticRoutes } from './static-build'

/**
 * The margin package on a real book page.
 *
 * The anchoring rules are pinned by unit tests against real renderer output.
 * What can only be checked in a browser is here: that a selection becomes the
 * same anchors however the reader made it, that a selection crossing blocks
 * becomes an ordered set rather than a failure, that painting a highlight
 * leaves the book's markup byte-identical, and that an annotation which cannot
 * re-anchor is still in the rail afterwards.
 */

const CHAPTER = '/books/build-a-coding-agent/ch12-hash-maps/'

type Anchor = {
  nodeId: string
  struct?: { id: string; digest?: string }
  position: { start: number; end: number }
  quote: { exact: string; prefix: string; suffix: string }
}

type Capture = { status: string; anchors?: Anchor[] }

declare global {
  interface Window {
    __marginCaptures: Capture[]
    __marginPointerEvents: number
    __marginPointerSelection?: { range: Range; text: string }
  }
}

const HIGHLIGHT_BUTTON = 'margin-rail button[data-margin-action="highlight"]'

async function open(page: Page) {
  // With `SRT_STATIC_BUILD_DIR` set this runs against the built book in
  // `dist/` — the pages a reader actually gets — and against the dev server
  // otherwise. The package is the same bundle either way.
  await installStaticRoutes(page)
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto(CHAPTER)
  // The element draws its button as soon as it upgrades, so this is the one
  // signal that the package is actually running on the page.
  await expect(page.locator(HIGHLIGHT_BUTTON)).toBeVisible()
  await page.evaluate(() => {
    window.__marginCaptures = []
    window.__marginPointerEvents = 0
    document.addEventListener('margin-selection', (event) => {
      const detail = (event as CustomEvent).detail
      window.__marginCaptures.push(
        detail.status === 'captured'
          ? { status: 'captured', anchors: detail.anchors }
          : { status: detail.status },
      )
    })
    for (const name of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      document.addEventListener(name, () => {
        window.__marginPointerEvents += 1
      })
    }
  })
}

/** The rail's latest report, once it says what the test is waiting for. */
async function waitForCapture(page: Page, status: string): Promise<Capture> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const captures = window.__marginCaptures
        return captures.length ? captures[captures.length - 1].status : ''
      }),
    )
    .toBe(status)
  return page.evaluate(() => {
    const captures = window.__marginCaptures
    return captures[captures.length - 1]
  })
}

async function resetCaptures(page: Page) {
  await page.evaluate(() => {
    window.__marginCaptures = []
  })
}

/**
 * The first two prose blocks long enough to select inside.
 *
 * They are not necessarily siblings: a chapter interleaves figures and cards
 * between its prose. Whatever sits between them is part of the selection too,
 * which is the point — the test asserts the ends and the ordering, not a
 * particular block count.
 */
async function prosePair(page: Page): Promise<[string, string]> {
  const pair = await page.evaluate(() => {
    const ids = Array.from(
      document.querySelectorAll('.book-content [data-block-kind="prose"]'),
    )
      .filter((block) => (block.textContent ?? '').length > 120)
      .map((block) => block.id)
    return ids.length >= 2 ? [ids[0], ids[1]] : null
  })
  expect(
    pair,
    'the chapter has fewer than two long prose blocks',
  ).not.toBeNull()
  return pair as [string, string]
}

/** The widest prose block on the page. */
async function widestProse(page: Page): Promise<string> {
  const id = await page.evaluate(
    () =>
      Array.from(
        document.querySelectorAll('.book-content [data-block-kind="prose"]'),
      )
        .map((block) => ({
          id: block.id,
          length: (block.textContent ?? '').length,
        }))
        .sort((a, b) => b.length - a.length)[0]?.id ?? '',
  )
  expect(id).not.toBe('')
  return id
}

/** Select `[start, end)` of one block's text, with no input event at all. */
async function selectWithin(
  page: Page,
  blockId: string,
  start: number,
  end: number,
) {
  await page.evaluate(
    ({ blockId, start, end }) => {
      const block = document.getElementById(blockId)
      if (!block) throw new Error(`no block ${blockId}`)
      const point = (offset: number) => {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
        let seen = 0
        let node = walker.nextNode() as Text | null
        while (node) {
          if (offset <= seen + node.data.length) {
            return { node, offset: offset - seen }
          }
          seen += node.data.length
          node = walker.nextNode() as Text | null
        }
        throw new Error(`offset ${offset} is past the end of ${blockId}`)
      }
      const from = point(start)
      const to = point(end)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      const range = document.createRange()
      range.setStart(from.node, from.offset)
      range.setEnd(to.node, to.offset)
      selection?.addRange(range)
    },
    { blockId, start, end },
  )
}

/** Select from inside the first block through into the second. */
async function selectAcross(page: Page, pair: [string, string]) {
  await page.evaluate(([first, second]) => {
    const edgeText = (id: string, last: boolean) => {
      const block = document.getElementById(id)!
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode() as Text | null
      let found = node
      while (node) {
        if (!last) return node
        found = node
        node = walker.nextNode() as Text | null
      }
      return found!
    }
    const selection = window.getSelection()!
    selection.removeAllRanges()
    const range = document.createRange()
    range.setStart(edgeText(first, false), 4)
    const end = edgeText(second, true)
    range.setEnd(end, Math.min(20, end.data.length))
    selection.addRange(range)
  }, pair)
}

async function paintedTexts(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const registry = (
      CSS as unknown as { highlights?: Map<string, Set<Range>> }
    ).highlights
    if (!registry) return null
    return Array.from(registry.values()).flatMap((highlight) =>
      Array.from(highlight).map((range) => range.toString()),
    )
  })
}

async function mountOmittedTextFixture(page: Page) {
  await page.evaluate(() => {
    const root = document.createElement('section')
    root.id = 'margin-omitted-fixture'
    root.style.cssText = 'width:320px;font-size:20px;line-height:1.5'
    const block = document.createElement('p')
    block.id = 'margin-omitted-block'
    block.dataset.blockKind = 'prose'
    block.append('before ')
    const button = document.createElement('button')
    button.textContent = 'OMITTED'
    block.append(button, ' after')
    root.append(block)
    document.body.append(root)

    const rail = document.createElement('margin-rail') as HTMLElement & {
      annotations: unknown
    }
    rail.setAttribute('text-selector', '#margin-omitted-fixture')
    rail.setAttribute('document-uri', 'https://example.test/omitted')
    document.body.append(rail)
    const quote = 'before  after'
    rail.annotations = [
      {
        id: 'omitted-spanning-highlight',
        kind: 'highlight',
        target: {
          nodeId: block.id,
          position: { start: 0, end: quote.length },
          quote: { exact: quote, prefix: '', suffix: '' },
        },
        appearance: { color: 'amber' },
        geometryCache: [],
      },
    ]
  })
}

test.describe('selection capture', () => {
  test('changing either document context clears a captured selection', async ({
    page,
  }) => {
    await open(page)
    const widest = await widestProse(page)
    const rail = page.locator('margin-rail').first()

    await selectWithin(page, widest, 5, 25)
    await waitForCapture(page, 'captured')
    await expect(page.locator(HIGHLIGHT_BUTTON)).toBeEnabled()
    await rail.evaluate((element) =>
      element.setAttribute('text-selector', '#missing-root'),
    )
    await expect(page.locator(HIGHLIGHT_BUTTON)).toBeDisabled()

    await rail.evaluate((element) => element.removeAttribute('text-selector'))
    await selectWithin(page, widest, 5, 25)
    await waitForCapture(page, 'captured')
    await expect(page.locator(HIGHLIGHT_BUTTON)).toBeEnabled()
    await rail.evaluate((element) =>
      element.setAttribute('document-uri', 'https://example.test/other'),
    )
    await expect(page.locator(HIGHLIGHT_BUTTON)).toBeDisabled()
  })

  test('a keyboard-extended selection gives the mouse selection’s anchor', async ({
    page,
  }) => {
    await open(page)

    // The longest paragraph on the page, so the pointer has plenty of words
    // to land on.
    const paragraphs = page.locator('.book-content [data-block-kind="prose"] p')
    const index = await paragraphs.evaluateAll((nodes) => {
      let best = -1
      let length = 0
      nodes.forEach((node, position) => {
        const size = (node.textContent ?? '').length
        if (size > length) {
          length = size
          best = position
        }
      })
      return best
    })
    expect(index, 'the chapter has no prose paragraph').toBeGreaterThanOrEqual(
      0,
    )

    const paragraph = paragraphs.nth(index)
    // The pointer works in viewport coordinates, so a paragraph below the fold
    // has to be brought into view before its box means anything.
    await paragraph.scrollIntoViewIfNeeded()
    const box = await paragraph.boundingBox()
    if (!box) throw new Error('the paragraph has no box to point at')

    // A double click is the reader's shortest mouse selection, and unlike a
    // synthetic drag it lands on a word rather than on whatever pixel the
    // pointer stopped at. Some of those pixels are the space between words, so
    // try a few until one of them selects something.
    let text = ''
    for (const fraction of [0.3, 0.36, 0.42, 0.48, 0.54, 0.6]) {
      await resetCaptures(page)
      await page.mouse.dblclick(
        box.x + box.width * fraction,
        box.y + box.height / 2,
      )
      text = await page.evaluate(() => {
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          return ''
        }
        const range = selection.getRangeAt(0)
        window.__marginPointerSelection = {
          range: range.cloneRange(),
          text: range.toString(),
        }
        return range.toString()
      })
      if (text.trim().length >= 3) break
    }
    expect(text.trim().length).toBeGreaterThanOrEqual(3)

    const byPointer = await waitForCapture(page, 'captured')
    expect(byPointer.anchors).toHaveLength(1)

    // The same range again, extended one character at a time with no pointer
    // event of any kind. Chromium only maps shift+arrow onto this under caret
    // browsing, which Playwright cannot switch on, so the test makes the call
    // the browser's shift+arrow handler makes — the same one a screen reader
    // makes when it extends a selection.
    await resetCaptures(page)
    const pointersBefore = await page.evaluate(
      () => window.__marginPointerEvents,
    )
    const keyboardText = await page.evaluate(() => {
      const pointed = window.__marginPointerSelection
      const selection = window.getSelection()
      if (!pointed || !selection) return ''
      selection.removeAllRanges()
      selection.collapse(
        pointed.range.startContainer,
        pointed.range.startOffset,
      )
      const modify = (
        selection as Selection & {
          modify?: (
            alter: string,
            direction: string,
            granularity: string,
          ) => void
        }
      ).modify
      if (!modify) return ''
      for (
        let guard = 0;
        selection.toString().length < pointed.text.length && guard < 2000;
        guard += 1
      ) {
        modify.call(selection, 'extend', 'forward', 'character')
      }
      return selection.toString()
    })

    expect(keyboardText).toBe(text)
    expect(await page.evaluate(() => window.__marginPointerEvents)).toBe(
      pointersBefore,
    )
    expect(await waitForCapture(page, 'captured')).toEqual(byPointer)
  })

  test('a selection crossing blocks becomes an ordered set of anchors', async ({
    page,
  }) => {
    await open(page)
    const pair = await prosePair(page)
    await selectAcross(page, pair)

    const capture = await waitForCapture(page, 'captured')
    const ids = capture.anchors?.map((anchor) => anchor.nodeId) ?? []
    const documentOrder = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll('.book-content [data-block-kind]'),
      ).map((block) => block.id),
    )

    // The ends are the blocks the selection started and finished in, and
    // everything anchorable in between is there, in the order the page has it.
    expect(ids.length).toBeGreaterThanOrEqual(2)
    expect(ids[0]).toBe(pair[0])
    expect(ids[ids.length - 1]).toBe(pair[1])
    expect(ids).toEqual(documentOrder.filter((id) => ids.includes(id)))
    expect(capture.anchors?.map((anchor) => anchor.struct?.id)).toEqual(ids)
    for (const anchor of capture.anchors ?? []) {
      expect(anchor.quote.exact.length).toBe(
        anchor.position.end - anchor.position.start,
      )
      expect(anchor.struct?.digest).toMatch(/^[0-9a-f]{12}$/)
    }
  })
})

test.describe('highlight painting', () => {
  test('does not paint excluded text inside a spanning anchor', async ({
    page,
  }) => {
    await open(page)
    await mountOmittedTextFixture(page)
    const text = await page.evaluate(() => {
      const registry = (
        CSS as unknown as { highlights: Map<string, Set<Range>> }
      ).highlights
      return Array.from(registry.values()).flatMap((highlight) =>
        Array.from(highlight)
          .filter((range) =>
            range.startContainer.parentElement?.closest(
              '#margin-omitted-fixture',
            ),
          )
          .map((range) => range.toString()),
      )
    })
    expect(text).toEqual(['before ', ' after'])
  })

  test('fallback boxes follow layout changes and clean up', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(CSS, 'highlights', {
        configurable: true,
        value: undefined,
      })
    })
    await open(page)
    await mountOmittedTextFixture(page)
    const boxes = page.locator(
      '[data-erniesg-margin-overlay] [data-margin-highlight="omitted-spanning-highlight"]',
    )
    await expect(boxes).toHaveCount(2)
    const measure = () =>
      boxes.evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          }
        }),
      )
    const before = await measure()
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(
        '#margin-omitted-fixture',
      )!.style.fontSize = '32px'
    })
    await expect.poll(measure).not.toEqual(before)
    const afterFont = await measure()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(
        '#margin-omitted-fixture',
      )!.style.width = '120px'
    })
    await expect.poll(measure).not.toEqual(afterFont)
    await page.evaluate(() => {
      document
        .querySelector('margin-rail[text-selector="#margin-omitted-fixture"]')!
        .remove()
    })
    await expect(boxes).toHaveCount(0)
  })

  test('paints across blocks and round-trips to the same anchors', async ({
    page,
  }) => {
    await open(page)
    const pair = await prosePair(page)
    const before = await page.locator('.book-content').innerHTML()

    await selectAcross(page, pair)
    const captured = await waitForCapture(page, 'captured')
    await page.locator(HIGHLIGHT_BUTTON).click()

    const spanned = captured.anchors?.length ?? 0
    expect(spanned).toBeGreaterThanOrEqual(2)
    await expect(
      page.locator('margin-rail li[data-margin-annotation]'),
    ).toHaveCount(spanned)
    await expect(page.locator('margin-rail li[data-orphaned]')).toHaveCount(0)

    // Nothing in the book moved: the highlight lives in the browser's registry
    // rather than in a wrapper element.
    expect(await page.locator('.book-content').innerHTML()).toBe(before)

    const painted = await paintedTexts(page)
    expect(painted, 'this browser has no Custom Highlight API').not.toBeNull()
    // Painting has one Range per indexed text node so skipped descendants
    // cannot be filled in by a spanning DOM Range.
    expect(painted?.join('')).toBe(
      captured.anchors?.map((anchor) => anchor.quote.exact).join(''),
    )

    // Select exactly what was painted, and read the anchors back out.
    await resetCaptures(page)
    await page.evaluate(() => {
      const registry = (
        CSS as unknown as { highlights: Map<string, Set<Range>> }
      ).highlights
      const ranges = Array.from(registry.values()).flatMap((highlight) =>
        Array.from(highlight),
      )
      const selection = window.getSelection()!
      selection.removeAllRanges()
      const range = document.createRange()
      range.setStart(ranges[0].startContainer, ranges[0].startOffset)
      const last = ranges[ranges.length - 1]
      range.setEnd(last.endContainer, last.endOffset)
      selection.addRange(range)
    })

    expect(await waitForCapture(page, 'captured')).toEqual(captured)
  })

  test('paints two overlapping highlights without either being lost', async ({
    page,
  }) => {
    await open(page)
    const widest = await widestProse(page)
    const length = await page.evaluate(
      (id) => (document.getElementById(id)?.textContent ?? '').length,
      widest,
    )
    expect(length).toBeGreaterThan(80)

    const before = await page.locator('.book-content').innerHTML()
    const highlight = page.locator(HIGHLIGHT_BUTTON)

    await selectWithin(page, widest, 5, 45)
    await waitForCapture(page, 'captured')
    await highlight.click()

    await resetCaptures(page)
    await selectWithin(page, widest, 25, 70)
    await waitForCapture(page, 'captured')
    await highlight.click()

    await expect(
      page.locator('margin-rail li[data-margin-annotation]'),
    ).toHaveCount(2)
    await expect(page.locator('margin-rail li[data-orphaned]')).toHaveCount(0)
    expect(await page.locator('.book-content').innerHTML()).toBe(before)

    const painted = await paintedTexts(page)
    expect(painted).toHaveLength(2)

    // They genuinely overlap, and neither was clipped to make room for the
    // other: both still span the offsets they were made from.
    const positions = await page.evaluate(() => {
      const rail = document.querySelector('margin-rail') as HTMLElement & {
        annotations: { target: { position: { start: number; end: number } } }[]
      }
      return rail.annotations.map((annotation) => annotation.target.position)
    })
    expect(positions).toHaveLength(2)
    expect(positions[1].start).toBeGreaterThan(positions[0].start)
    expect(positions[1].start).toBeLessThan(positions[0].end)
    expect(positions[1].end).toBeGreaterThan(positions[0].end)
  })
})

test.describe('annotations that cannot re-anchor', () => {
  test('stay in the rail, marked, with their quote readable', async ({
    page,
  }) => {
    await open(page)
    const widest = await widestProse(page)
    const quote = 'a sentence this chapter has never contained'

    await page.evaluate(
      ({ blockId, quote }) => {
        const rail = document.querySelector('margin-rail') as HTMLElement & {
          annotations: unknown
        }
        rail.annotations = [
          {
            id: 'orphan-1',
            kind: 'note',
            target: {
              nodeId: blockId,
              position: { start: 0, end: quote.length },
              quote: { exact: quote, prefix: '', suffix: '' },
            },
            body: 'Kept, because losing it silently would be worse.',
            geometryCache: [],
          },
        ]
      },
      { blockId: widest, quote },
    )

    const orphan = page.locator('margin-rail li[data-orphaned]')
    await expect(orphan).toHaveCount(1)
    await expect(orphan).toHaveAttribute('data-orphaned', 'quote-not-found')
    await expect(orphan).toContainText(quote)
  })

  test('marks a region with no durable text as non-annotatable', async ({
    page,
  }) => {
    await open(page)
    const figures = await page.locator('.book-content figure').count()
    test.skip(figures === 0, 'this chapter renders no figure to select inside')

    await page.evaluate(() => {
      const figure = document.querySelector('.book-content figure')!
      const selection = window.getSelection()!
      selection.removeAllRanges()
      const range = document.createRange()
      range.selectNodeContents(figure)
      selection.addRange(range)
    })

    await waitForCapture(page, 'non-annotatable')
    await expect(
      page.locator('margin-rail [data-margin-notice="non-annotatable"]'),
    ).toBeVisible()
  })
})
