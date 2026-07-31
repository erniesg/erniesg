import { describe, expect, it } from 'vitest'
import {
  clampReviewZoom,
  fittedReviewScale,
  shouldPinReviewScrollToTop,
  steppedReviewZoom,
} from './review-zoom'

describe('review page zoom', () => {
  it('fits the complete page inside both stage dimensions', () => {
    expect(
      fittedReviewScale({
        mode: 'fit-page',
        customPercent: 150,
        contentWidth: 600,
        contentHeight: 800,
        stageWidth: 700,
        stageHeight: 700,
        gutter: 20,
      }),
    ).toBe(0.85)
  })

  it('keeps fit width and visual zoom independent of reflow geometry', () => {
    expect(
      fittedReviewScale({
        mode: 'fit-width',
        customPercent: 50,
        contentWidth: 600,
        contentHeight: 800,
        stageWidth: 920,
        stageHeight: 400,
        gutter: 20,
      }),
    ).toBe(1.5)
    expect(
      fittedReviewScale({
        mode: 'custom',
        customPercent: 125,
        contentWidth: 600,
        contentHeight: 800,
        stageWidth: 920,
        stageHeight: 400,
      }),
    ).toBe(1.25)
  })

  it('uses bounded deterministic zoom levels', () => {
    expect(clampReviewZoom(12)).toBe(50)
    expect(clampReviewZoom(260)).toBe(200)
    expect(steppedReviewZoom(100, 1)).toBe(125)
    expect(steppedReviewZoom(100, -1)).toBe(75)
    expect(steppedReviewZoom(200, 1)).toBe(200)
  })

  it('pins only fit-page review scrolling while custom and fit-width remain reachable', () => {
    expect(shouldPinReviewScrollToTop(true, 'fit-page')).toBe(true)
    expect(shouldPinReviewScrollToTop(true, 'fit-width')).toBe(false)
    expect(shouldPinReviewScrollToTop(true, 'custom')).toBe(false)
    expect(shouldPinReviewScrollToTop(false, 'fit-page')).toBe(false)
  })
})
