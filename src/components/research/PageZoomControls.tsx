import {
  REVIEW_ZOOM_LEVELS,
  steppedReviewZoom,
  type ReviewZoomMode,
} from './review-zoom'

export default function PageZoomControls({
  mode,
  percent,
  actualScale,
  onChange,
}: {
  mode: ReviewZoomMode
  percent: number
  actualScale: number
  onChange: (mode: ReviewZoomMode, percent: number) => void
}) {
  const actualPercent = Math.round(actualScale * 100)
  const customBase = mode === 'custom' ? percent : actualPercent
  return (
    <div className="page-zoom-controls" aria-label="Page zoom controls">
      <button
        type="button"
        aria-pressed={mode === 'fit-page'}
        onClick={() => onChange('fit-page', percent)}
      >
        Fit page
      </button>
      <button
        type="button"
        aria-pressed={mode === 'fit-width'}
        onClick={() => onChange('fit-width', percent)}
      >
        Fit width
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => onChange('custom', steppedReviewZoom(customBase, -1))}
      >
        −
      </button>
      <select
        aria-label="Zoom percentage"
        value={
          mode === 'custom' &&
          REVIEW_ZOOM_LEVELS.includes(
            percent as (typeof REVIEW_ZOOM_LEVELS)[number],
          )
            ? percent
            : ''
        }
        onChange={(event) =>
          onChange('custom', Number(event.target.value) || 100)
        }
      >
        {mode !== 'custom' && <option value="">{actualPercent}%</option>}
        {REVIEW_ZOOM_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}%
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => onChange('custom', steppedReviewZoom(customBase, 1))}
      >
        +
      </button>
      <button type="button" onClick={() => onChange('fit-page', 100)}>
        Reset
      </button>
    </div>
  )
}
