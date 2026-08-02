export default function PageNavigation({
  page,
  pageCount,
  label,
  onPageChange,
}: {
  page: number
  pageCount: number
  label: string
  onPageChange: (page: number) => void
}) {
  return (
    <div className="page-navigation" aria-label={`${label} page navigation`}>
      <button
        type="button"
        aria-label="Previous page"
        title="Previous page"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        ←
      </button>
      <strong aria-live="polite">
        {label} page {page} of {Math.max(1, pageCount)}
      </strong>
      <button
        type="button"
        aria-label="Next page"
        title="Next page"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        →
      </button>
    </div>
  )
}
