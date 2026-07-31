export const REVIEW_ZOOM_LEVELS = [50, 75, 100, 125, 150, 200] as const
export type ReviewZoomMode = 'fit-page' | 'fit-width' | 'custom'

export function shouldPinReviewScrollToTop(
  reviewMode: boolean,
  zoomMode: ReviewZoomMode,
) {
  return reviewMode && zoomMode === 'fit-page'
}

export function clampReviewZoom(value: number) {
  return Math.min(200, Math.max(50, Math.round(value)))
}

export function steppedReviewZoom(value: number, direction: -1 | 1) {
  const clamped = clampReviewZoom(value)
  if (direction < 0) {
    return (
      [...REVIEW_ZOOM_LEVELS]
        .reverse()
        .find((candidate) => candidate < clamped) ?? REVIEW_ZOOM_LEVELS[0]
    )
  }
  return (
    REVIEW_ZOOM_LEVELS.find((candidate) => candidate > clamped) ??
    REVIEW_ZOOM_LEVELS.at(-1)!
  )
}

export function fittedReviewScale({
  mode,
  customPercent,
  contentWidth,
  contentHeight,
  stageWidth,
  stageHeight,
  gutter = 48,
}: {
  mode: ReviewZoomMode
  customPercent: number
  contentWidth: number
  contentHeight: number
  stageWidth: number
  stageHeight: number
  gutter?: number
}) {
  if (
    contentWidth <= 0 ||
    contentHeight <= 0 ||
    stageWidth <= 0 ||
    stageHeight <= 0
  ) {
    return 1
  }
  const widthScale = Math.max(0.05, (stageWidth - gutter) / contentWidth)
  const heightScale = Math.max(0.05, (stageHeight - gutter) / contentHeight)
  return mode === 'fit-page'
    ? Math.min(widthScale, heightScale)
    : mode === 'fit-width'
      ? widthScale
      : clampReviewZoom(customPercent) / 100
}
