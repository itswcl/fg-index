

interface ShimmerProps {
  width: number | string;
  height: number | string;
  borderRadius?: number;
}

export function Shimmer({ width, height, borderRadius = 4 }: ShimmerProps) {
  return (
    <div
      className="shimmer"
      style={{
        width,
        height,
        borderRadius,
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div className="shimmer-inner" />
    </div>
  );
}
