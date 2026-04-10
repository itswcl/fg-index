import { useTicker } from '../hooks/useTicker';
import { TickerCard } from './TickerCard';

interface TickerCardWrapperProps {
  ticker: string;
  isDark: boolean;
  onRemove: (ticker: string) => void;
}

export function TickerCardWrapper({ ticker, isDark, onRemove }: TickerCardWrapperProps) {
  const { data, isLoading, isFetching } = useTicker(ticker);
  const lastUpdate = data?.fetchedAt ? new Date(data.fetchedAt) : null;

  return (
    <TickerCard
      ticker={ticker}
      data={data}
      lastUpdate={lastUpdate}
      isLoading={isLoading}
      isRefreshing={isFetching}
      isDark={isDark}
      onRemove={() => onRemove(ticker)}
    />
  );
}
