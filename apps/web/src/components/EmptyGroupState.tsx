interface EmptyGroupStateProps {
  groupName: string;
  isDark: boolean;
  isMobile: boolean;
}

export function EmptyGroupState({ groupName, isDark, isMobile }: EmptyGroupStateProps) {
  const content = (
    <div
      className={[
        isMobile ? 'empty-group-list' : 'empty-group-card',
        isDark ? 'empty-group-dark' : 'empty-group-light',
      ].join(' ')}
    >
      <div className="empty-group-title">No tickers in {groupName}</div>
      <div className="empty-group-body">Add a ticker above or assign one from another group.</div>
    </div>
  );

  if (!isMobile) {
    return (
      <div className="cards-grid empty-group-grid">
        {content}
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="card-filler" aria-hidden="true" />
        ))}
      </div>
    );
  }

  return (
    content
  );
}
