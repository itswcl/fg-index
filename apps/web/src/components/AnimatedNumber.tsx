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
  const display = useAnimatedNumber(value);
  return (
    <span className={className} style={style}>
      {formatter(display)}
    </span>
  );
}
