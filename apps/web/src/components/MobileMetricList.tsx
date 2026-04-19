import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTicker } from '../hooks/useTicker';
import { DEFAULT_CARD_IDS } from '../hooks/useUnifiedOrder';
import { FEAR_GREED_COLORS } from '../constants';
import type { FearGreed, FearGreedClassification, TickerQuote } from '../types';
import { MetricRow, type MetricRowData } from './MetricRow';
import './MobileMetricList.css';

interface MobileMetricListProps {
  order: string[];
  onReorder: (newOrder: string[]) => void;
  isDark: boolean;
  editMode: boolean;
  onRemoveTicker: (ticker: string) => void;

  fearGreedData: FearGreed | null;
  fgIsLoading: boolean;
  fgIsRefreshing: boolean;
  vixData: TickerQuote | null;
  vixAvailable: boolean;
  vixIsLoading: boolean;
  vixIsRefreshing: boolean;
  btcData: TickerQuote | null;
  btcIsLoading: boolean;
  btcIsRefreshing: boolean;
  spxData: TickerQuote | null;
  spxAvailable: boolean;
  spxIsLoading: boolean;
  spxIsRefreshing: boolean;
}

function formatPrice(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatBtcPrice(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatSpxPrice(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fearGreedColor(classification: FearGreedClassification | string | undefined): string | undefined {
  if (!classification) return undefined;
  const key = classification as keyof typeof FEAR_GREED_COLORS;
  return FEAR_GREED_COLORS[key];
}

/** Row renderer for custom tickers — needs its own hook call so it lives in a child. */
function TickerMetricRow({
  id,
  isDark,
  editMode,
  showDivider,
  onRemoveTicker,
}: {
  id: string;
  isDark: boolean;
  editMode: boolean;
  showDivider: boolean;
  onRemoveTicker: (ticker: string) => void;
}) {
  const { data, isLoading, isFetching } = useTicker(id);
  const showLoading = isLoading || (isFetching && data === undefined);
  const notFound = !isLoading && data === null;

  const rowData: MetricRowData = {
    id,
    label: id,
    subLabel: data?.name,
    value: data?.price ?? null,
    valueFormatter: formatPrice,
    changePercent: data?.changePercent ?? null,
    changeMode: 'standard',
    isLoading: showLoading,
    isNa: notFound,
    sourceUrl: data?.sourceUrl,
  };

  return (
    <MetricRow
      {...rowData}
      isDark={isDark}
      editMode={editMode}
      isCustom={true}
      onRemove={onRemoveTicker}
      showDivider={showDivider}
    />
  );
}

function buildRowData(id: string, p: MobileMetricListProps): MetricRowData {
  switch (id) {
    case 'feargreed': {
      const fg = p.fearGreedData;
      const showLoading = p.fgIsLoading || (p.fgIsRefreshing && !fg);
      return {
        id,
        label: 'FEAR & GREED',
        subLabel: fg?.classification ?? 'Loading',
        value: fg?.score ?? null,
        valueFormatter: (n) => Math.round(n).toString(),
        valueColor: fearGreedColor(fg?.classification),
        changeMode: 'none',
        isLoading: showLoading,
      };
    }
    case 'vix': {
      const v = p.vixData;
      const showLoading = p.vixIsLoading || (p.vixIsRefreshing && !v);
      return {
        id,
        label: 'VIX',
        subLabel: 'Volatility',
        value: v?.price ?? null,
        valueFormatter: (n) => n.toFixed(2),
        changePercent: v?.changePercent ?? null,
        changeMode: 'inverted',
        isLoading: showLoading,
        isNa: !p.vixAvailable,
      };
    }
    case 'btc': {
      const b = p.btcData;
      const showLoading = p.btcIsLoading || (p.btcIsRefreshing && !b);
      return {
        id,
        label: 'BTC',
        subLabel: 'Bitcoin',
        value: b?.price ?? null,
        valueFormatter: formatBtcPrice,
        changePercent: b?.changePercent ?? null,
        changeMode: 'standard',
        isLoading: showLoading,
      };
    }
    case 'spx': {
      const s = p.spxData;
      const showLoading = p.spxIsLoading || (p.spxIsRefreshing && !s);
      return {
        id,
        label: 'S&P 500',
        subLabel: 'Index',
        value: s?.price ?? null,
        valueFormatter: formatSpxPrice,
        changePercent: s?.changePercent ?? null,
        changeMode: 'standard',
        isLoading: showLoading,
        isNa: !p.spxAvailable,
      };
    }
    default:
      // Handled by <TickerMetricRow/>
      return {
        id,
        label: id,
        value: null,
      };
  }
}

export function MobileMetricList(props: MobileMetricListProps) {
  const { order, onReorder, isDark, editMode, onRemoveTicker } = props;

  // Sensors only matter when edit mode is on; creating them always keeps hook
  // order stable. TouchSensor has no activation delay here because the user
  // already opted into reorder by tapping the pencil.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 8 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(active.id as string);
    const newIndex = order.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(order, oldIndex, newIndex));
  }

  const listClasses = `metric-list ${isDark ? 'metric-list-dark' : 'metric-list-light'}`;

  const rows = order.map((id, idx) => {
    const isDefault = (DEFAULT_CARD_IDS as readonly string[]).includes(id);
    const showDivider = idx < order.length - 1;

    if (!isDefault) {
      return (
        <TickerMetricRow
          key={id}
          id={id}
          isDark={isDark}
          editMode={editMode}
          showDivider={showDivider}
          onRemoveTicker={onRemoveTicker}
        />
      );
    }

    const data = buildRowData(id, props);
    return (
      <MetricRow
        key={id}
        {...data}
        isDark={isDark}
        editMode={editMode}
        isCustom={false}
        showDivider={showDivider}
      />
    );
  });

  // Read-only mode: plain <ul>, no DndContext, native scroll unimpeded.
  if (!editMode) {
    return <ul className={listClasses}>{rows}</ul>;
  }

  // Edit mode: DndContext + vertical sortable strategy.
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <ul className={listClasses}>{rows}</ul>
      </SortableContext>
    </DndContext>
  );
}
