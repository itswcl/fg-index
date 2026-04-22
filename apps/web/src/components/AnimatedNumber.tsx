import { useAnimatedNumber } from '../hooks/useAnimatedNumber';

interface AnimatedNumberProps {
  value: number;
  /** Format the interpolated number for display */
  formatter: (n: number) => string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Renders a number that smoothly animates when its value changes.
 */
export function AnimatedNumber({ value, formatter, className, style }: AnimatedNumberProps) {
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const hasRenderableValue = typeof value === 'number' && Number.isFinite(value);
  const display = useAnimatedNumber(safeValue);

  return (
    <span className={className} style={style}>
      {hasRenderableValue && Number.isFinite(display) ? formatter(display) : '–'}
    </span>
  );
}
