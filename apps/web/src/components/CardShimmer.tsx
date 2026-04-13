import { Shimmer } from './Shimmer';

interface CardShimmerProps {
  /** 'score' uses narrower widths (Fear & Greed); 'price' is the default for all other cards */
  variant?: 'price' | 'score';
}

/**
 * Centralised shimmer placeholder for card loading/refreshing states.
 * Renders the main value block + footer timestamp row.
 */
export function CardShimmer({ variant = 'price' }: CardShimmerProps) {
  const isScore = variant === 'score';

  return (
    <>
      {/* Main value + sub-label */}
      <div className="shimmer-stack">
        <Shimmer width={isScore ? 70 : 90} height={30} borderRadius={8} />
        <Shimmer width={isScore ? 55 : 70} height={11} borderRadius={4} />
      </div>
      {/* Footer timestamp */}
      <Shimmer width={isScore ? 100 : 110} height={8} borderRadius={2} />
    </>
  );
}
