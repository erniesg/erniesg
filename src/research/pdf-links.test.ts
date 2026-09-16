import { describe, expect, it } from 'vitest'
import {
  normalizedPdfExternalLinkTarget,
  resolvePdfExternalLinkSourceIntervalOwnership,
  safePdfExternalLinkTarget,
} from './pdf-links'
import type { NormalizedSourceBox } from './import-types'

function sourceBox(
  rotation = 0,
  overrides: Partial<NormalizedSourceBox> = {},
): NormalizedSourceBox {
  return {
    page: 1,
    x: 0.1,
    y: 0.2,
    width: 0.72,
    height: 0.02,
    rotation,
    method: 'pdf-text',
    ...overrides,
  }
}

function substringBox(
  box: NormalizedSourceBox,
  text: string,
  start: number,
  end: number,
  reverse = false,
): NormalizedSourceBox {
  const startFraction = reverse ? 1 - end / text.length : start / text.length
  const sizeFraction = (end - start) / text.length
  return {
    ...box,
    x: box.x + box.width * startFraction,
    width: box.width * sizeFraction,
    method: 'pdf-link',
  }
}

describe('PDF external links', () => {
  it('keeps real DOI links and suppresses incomplete or placeholder DOI links', () => {
    expect(
      safePdfExternalLinkTarget('https://doi.org/10.1145/3626772.3657676'),
    ).toBe(true)
    expect(
      normalizedPdfExternalLinkTarget(
        'https://doi.org/10.1145/3626772.3657676',
      ),
    ).toBe('https://doi.org/10.1145/3626772.3657676')

    expect(safePdfExternalLinkTarget('https://doi.org/10.1145/')).toBe(false)
    expect(
      safePdfExternalLinkTarget('https://doi.org/10.1145/nnnnnnn.nnnnnnn'),
    ).toBe(false)
  })

  it.each(
    [0, 90, 180, 270].flatMap((rotation) =>
      [false, true].map((reverse) => ({ rotation, reverse })),
    ),
  )(
    'recovers one token-bounded source character interval at $rotation° with reverse=$reverse',
    ({ rotation, reverse }) => {
      const text = 'Read the project homepage for details'
      const start = text.indexOf('project homepage')
      const end = start + 'project homepage'.length
      const runBox = sourceBox(rotation)
      const annotation = {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external' as const,
        url: 'https://example.test/project',
        box: substringBox(runBox, text, start, end, reverse),
      }

      expect(
        resolvePdfExternalLinkSourceIntervalOwnership({
          annotation,
          candidates: [
            {
              ownerId: 'region-1\u0000line-1\u00000',
              sourceStart: 0,
              sourceEnd: text.length,
              text,
              sourceBox: runBox,
            },
          ],
        }),
      ).toEqual({
        ownerId: 'region-1\u0000line-1\u00000',
        sourceStart: start,
        sourceEnd: end,
        text: 'project homepage',
        sourceBox: {
          ...annotation.box,
          method: 'pdf-text',
        },
        evidence: 'single-pdf-text-run-character-interval-v1',
      })
    },
  )

  it('fails closed when opposite advance directions identify different token intervals', () => {
    const text = 'alpha bravo charlie delta'
    const runBox = sourceBox()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external' as const,
      url: 'https://example.test/project',
      box: substringBox(runBox, text, 0, 'alpha'.length),
    }

    expect(
      resolvePdfExternalLinkSourceIntervalOwnership({
        annotation,
        candidates: [
          {
            ownerId: 'region-1\u0000line-1\u00000',
            sourceStart: 0,
            sourceEnd: text.length,
            text,
            sourceBox: runBox,
          },
        ],
      }),
    ).toBeNull()
  })

  it('fails closed when more than one source run can own the annotation', () => {
    const text = 'Project homepage'
    const runBox = sourceBox()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external' as const,
      url: 'https://example.test/project',
      box: { ...runBox, method: 'pdf-link' as const },
    }

    expect(
      resolvePdfExternalLinkSourceIntervalOwnership({
        annotation,
        candidates: ['first', 'second'].map((ownerId) => ({
          ownerId,
          sourceStart: 0,
          sourceEnd: text.length,
          text,
          sourceBox: runBox,
        })),
      }),
    ).toBeNull()
  })

  it('fails closed for a narrow annotation whose edges cut through tokens', () => {
    const text = 'Read the project homepage for details'
    const runBox = sourceBox()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external' as const,
      url: 'https://example.test/project',
      box: {
        ...runBox,
        x: runBox.x + runBox.width * 0.28,
        width: runBox.width * 0.22,
        method: 'pdf-link' as const,
      },
    }

    expect(
      resolvePdfExternalLinkSourceIntervalOwnership({
        annotation,
        candidates: [
          {
            ownerId: 'region-1\u0000line-1\u00000',
            sourceStart: 0,
            sourceEnd: text.length,
            text,
            sourceBox: runBox,
          },
        ],
      }),
    ).toBeNull()
  })

  it('fails closed for rotation-mismatched source geometry', () => {
    const text = 'Project homepage'
    const runBox = sourceBox(90)
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external' as const,
      url: 'https://example.test/project',
      box: { ...runBox, rotation: 0, method: 'pdf-link' as const },
    }

    expect(
      resolvePdfExternalLinkSourceIntervalOwnership({
        annotation,
        candidates: [
          {
            ownerId: 'region-1\u0000line-1\u00000',
            sourceStart: 0,
            sourceEnd: text.length,
            text,
            sourceBox: runBox,
          },
        ],
      }),
    ).toBeNull()
  })
})
