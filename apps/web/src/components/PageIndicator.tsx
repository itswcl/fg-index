import './PageIndicator.css';

interface PageIndicatorProps {
  /** 1-indexed current page. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  isDark: boolean;
  /** Hide chevrons (used on mobile where swipe + dots replace them). */
  showChevrons?: boolean;
}

export function PageIndicator({
  page,
  pageCount,
  onPageChange,
  isDark,
  showChevrons = true,
}: PageIndicatorProps) {
  // Single-page grids render nothing — no affordance needed.
  if (pageCount <= 1) return null;

  const canPrev = page > 1;
  const canNext = page < pageCount;
  const themeClass = isDark ? 'page-indicator-dark' : 'page-indicator-light';

  return (
    <div className={`page-indicator ${themeClass}`} role="tablist" aria-label="Page">
      {showChevrons && (
        <button
          type="button"
          className="page-chevron"
          onClick={() => canPrev && onPageChange(page - 1)}
          disabled={!canPrev}
          aria-label="Previous page"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}
      <div className="page-dots">
        {Array.from({ length: pageCount }, (_, i) => {
          const pageN = i + 1;
          const active = pageN === page;
          return (
            <button
              key={pageN}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`Page ${pageN} of ${pageCount}`}
              className={`page-dot ${active ? 'page-dot-active' : ''}`}
              onClick={() => onPageChange(pageN)}
            />
          );
        })}
      </div>
      {showChevrons && (
        <button
          type="button"
          className="page-chevron"
          onClick={() => canNext && onPageChange(page + 1)}
          disabled={!canNext}
          aria-label="Next page"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}
    </div>
  );
}
