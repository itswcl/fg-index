import { useTicker } from '../hooks/useTicker';
import { TickerCard } from './TickerCard';
import { TickerGroupAssignmentMenu } from './TickerGroupAssignmentMenu';
import type { TickerGroup } from '../hooks/useTickerGroups';

interface TickerCardWrapperProps {
  ticker: string;
  isDark: boolean;
  onRemove: (ticker: string) => void;
  groups?: TickerGroup[];
  onToggleTickerGroup?: (ticker: string, groupId: string, shouldInclude: boolean) => void;
}

export function TickerCardWrapper({
  ticker,
  isDark,
  onRemove,
  groups,
  onToggleTickerGroup,
}: TickerCardWrapperProps) {
  const { data, isLoading, isFetching } = useTicker(ticker);
  const lastUpdate = data?.fetchedAt ? new Date(data.fetchedAt) : null;
  const groupMenu = groups && onToggleTickerGroup ? (
    <TickerGroupAssignmentMenu
      ticker={ticker}
      groups={groups}
      isDark={isDark}
      variant="card"
      onToggleGroup={onToggleTickerGroup}
    />
  ) : undefined;

  return (
    <TickerCard
      ticker={ticker}
      data={data}
      lastUpdate={lastUpdate}
      isLoading={isLoading}
      isRefreshing={isFetching}
      isDark={isDark}
      onRemove={() => onRemove(ticker)}
      groupMenu={groupMenu}
    />
  );
}
