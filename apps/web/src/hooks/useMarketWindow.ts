import { useEffect, useState } from 'react';
import { isMarketWindowOpen } from '../../../../packages/shared-types/src/market-window';

export function useMarketWindow(): boolean {
  const [open, setOpen] = useState(() => isMarketWindowOpen());
  useEffect(() => {
    const update = () => setOpen(isMarketWindowOpen());
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return open;
}
