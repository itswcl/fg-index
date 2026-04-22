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
  const effectivePageCount = Math.max(pageCount, 1);
  const effectivePage = Math.min(Math.max(page, 1), effectivePageCount);

  const canPrev = effectivePage > 1;
  const canNext = effectivePage < effectivePageCount;
  const themeClass = isDark ? 'page-indicator-dark' : 'page-indicator-light';

  return (
    <div className={`page-indicator ${themeClass}`} role="tablist" aria-label="Page">
      {showChevrons && effectivePageCount > 1 && (
        <button
          type="button"
          className="page-chevron"
          onClick={() => canPrev && onPageChange(effectivePage - 1)}
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
        {Array.from({ length: effectivePageCount }, (_, i) => {
          const pageN = i + 1;
          const active = pageN === effectivePage;
          return (
            <button
              key={pageN}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`Page ${pageN} of ${effectivePageCount}`}
              className={`page-dot ${active ? 'page-dot-active' : ''}`}
              onClick={() => onPageChange(pageN)}
              disabled={effectivePageCount === 1}
            />
          );
        })}
      </div>
      {showChevrons && effectivePageCount > 1 && (
        <button
          type="button"
          className="page-chevron"
          onClick={() => canNext && onPageChange(effectivePage + 1)}
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
