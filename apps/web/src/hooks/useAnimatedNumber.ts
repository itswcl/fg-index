import { useEffect, useRef, useState } from 'react';

/**
 * Smoothly interpolates a displayed number from its previous value to the new target.
 * Uses requestAnimationFrame for 60fps animation.
 *
 * @param target  The real value to animate towards
 * @param duration Animation duration in ms (default 400)
 * @returns The current interpolated value
 */
export function useAnimatedNumber(target: number, duration = 400): number {
  const [display, setDisplay] = useState(target);
  const prevRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = prevRef.current;
    const to = target;
    prevRef.current = target;

    // Skip animation if this is the first value or values are equal
    if (from === to) {
      setDisplay(to);
      return;
    }

    const startTime = performance.now();

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic for a smooth deceleration
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (to - from) * eased);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    }

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return display;
}
