import { useRef, useState } from 'react';
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
import { usePageTickers } from '../hooks/usePageTickers';
import { DEFAULT_CARD_IDS, isPlaceholderId } from '../hooks/useUnifiedOrder';
import { FEAR_GREED_COLORS } from '../constants';
import type { FearGreed, FearGreedClassification, TickerQuote } from '../types';
import { getDisplayQuote, resolveMarketSession } from '../lib/marketSession';
import { MetricRow, type MetricRowData } from './MetricRow';
import { TickerGroupAssignmentMenu } from './TickerGroupAssignmentMenu';
import type { TickerGroup } from '../hooks/useTickerGroups';
import './MobileMetricList.css';

interface MobileMetricListProps {
  order: string[];
  onReorder: (newOrder: string[]) => void;
  /** 1-indexed current page — drives slice + swipe target. */
  page: number;
  /** Cards per page (typically CARDS_PER_PAGE=12). */
  perPage: number;
  /** Called when a horizontal swipe crosses the threshold. No-op in edit mode. */
  onPageChange: (page: number) => void;
  pageCount: number;
  isDark: boolean;
  editMode: boolean;
  onRemoveTicker: (ticker: string) => void;
  groups?: TickerGroup[];
  onToggleTickerGroup?: (ticker: string, groupId: string, shouldInclude: boolean) => void;
  /**
   * First-paint loading phase — dnd disabled, `__loading-*` ids render
   * shimmer rows, edit mode is forced off. Mirrors CardGrid's behavior.
   */
  isInitialLoading?: boolean;

  fearGreedData: FearGreed | null;
  fgIsLoading: boolean;
  fgIsRefreshing: boolean;
  vixData: TickerQuote | null;
  vixIsLoading: boolean;
  vixIsRefreshing: boolean;
  btcData: TickerQuote | null;
  btcIsLoading: boolean;
  btcIsRefreshing: boolean;
  spxData: TickerQuote | null;
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
  groups,
  onToggleTickerGroup,
}: {
  id: string;
  isDark: boolean;
  editMode: boolean;
  showDivider: boolean;
  onRemoveTicker: (ticker: string) => void;
  groups?: TickerGroup[];
  onToggleTickerGroup?: (ticker: string, groupId: string, shouldInclude: boolean) => void;
}) {
  const { data, isLoading, isFetching } = useTicker(id);
  const showLoading = isLoading || (isFetching && data === undefined);
  const notFound = !isLoading && data === null;

  // During post/pre we paint the extended-hours triplet — same swap the
  // desktop TickerCard performs. getDisplayQuote falls back to regular
  // numbers when the extended-hours fields aren't present.
  const session = data ? resolveMarketSession(data) : undefined;
  const display = session ? getDisplayQuote(data, session) : null;

  const rowData: MetricRowData = {
    id,
    label: id,
    value: display?.price ?? null,
    valueFormatter: formatPrice,
    changePercent: display?.changePercent ?? null,
    changeMode: 'standard',
    isLoading: showLoading,
    isNa: notFound,
    sourceUrl: data?.sourceUrl,
    // Custom tickers respect whatever session the backend reports, with
    // the timestamp fallback inside resolveMarketSession.
    marketSession: session,
    fetchedAt: data?.fetchedAt,
  };

  return (
    <MetricRow
      {...rowData}
      isDark={isDark}
      editMode={editMode}
      isCustom={true}
      onRemove={onRemoveTicker}
      showDivider={showDivider}
      groupMenu={groups && onToggleTickerGroup ? (
        <TickerGroupAssignmentMenu
          ticker={id}
          groups={groups}
          isDark={isDark}
          variant="row"
          onToggleGroup={onToggleTickerGroup}
        />
      ) : undefined}
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
        sourceUrl: fg?.sourceUrl,
        // F&G has no concept of market session — never show the moon.
        marketSession: 'regular',
      };
    }
    case 'vix': {
      const v = p.vixData;
      const showLoading = p.vixIsLoading || (p.vixIsRefreshing && !v);
      const vDisplay = getDisplayQuote(v, 'regular');
      return {
        id,
        label: 'VIX',
        subLabel: 'Volatility',
        value: vDisplay?.price ?? null,
        valueFormatter: (n) => n.toFixed(2),
        changePercent: vDisplay?.changePercent ?? null,
        changeMode: 'inverted',
        isLoading: showLoading,
        sourceUrl: v?.sourceUrl,
        marketSession: 'regular',
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
        sourceUrl: b?.sourceUrl,
        // Crypto trades 24/7 — force regular so the moon never appears.
        marketSession: 'regular',
      };
    }
    case 'spx': {
      const s = p.spxData;
      const showLoading = p.spxIsLoading || (p.spxIsRefreshing && !s);
      const sDisplay = getDisplayQuote(s, 'regular');
      return {
        id,
        label: 'S&P 500',
        subLabel: 'Index',
        value: sDisplay?.price ?? null,
        valueFormatter: formatSpxPrice,
        changePercent: sDisplay?.changePercent ?? null,
        changeMode: 'standard',
        isLoading: showLoading,
        sourceUrl: s?.sourceUrl,
        marketSession: 'regular',
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

/**
 * Threshold params for horizontal swipe paging. `COMMIT_PX` must be
 * crossed before we change page. `LIVE_MAX_PX` caps the live-translate
 * preview so an aggressive fling doesn't fly off-screen during the
 * drag — release still navigates regardless of how far past the cap.
 */
const SWIPE_COMMIT_PX = 50;
const SWIPE_LIVE_MAX_PX = 120;
const SWIPE_AXIS_RATIO = 1.5;

export function MobileMetricList(props: MobileMetricListProps) {
  const {
    order,
    onReorder,
    page,
    perPage,
    onPageChange,
    pageCount,
    isDark,
    editMode,
    onRemoveTicker,
    isInitialLoading,
  } = props;
  // Edit mode is meaningless during the placeholder phase.
  const effectiveEditMode = isInitialLoading ? false : editMode;

  // Sensors only matter when edit mode is on; creating them always keeps hook
  // order stable. TouchSensor has no activation delay here because the user
  // already opted into reorder by tapping the pencil.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 8 } }),
  );

  // ── Page-slice: dnd-kit and render only see the current page ──
  const pageStart = (page - 1) * perPage;
  const pageEnd = pageStart + perPage;
  const pageItems = order.slice(pageStart, pageEnd);

  // ── Batch quote fetch for on-page custom tickers (FE-6) ──
  // Same contract as CardGrid: defaults have their own hooks, placeholders
  // are synthetic, user symbols batch through /api/quote/batch. Fetch only
  // the visible page; the backend active-symbol queue keeps nearby data warm.
  const customSymbolsOnPage = pageItems.filter(
    (id) => !(DEFAULT_CARD_IDS as readonly string[]).includes(id) && !isPlaceholderId(id),
  );
  usePageTickers(customSymbolsOnPage);

  // ── Horizontal swipe to page ──
  // Gated off during edit mode (rows own the gesture). We track a start point
  // on pointerdown, mirror delta-x into a CSS var for live preview up to
  // SWIPE_LIVE_MAX_PX, and on release commit to onPageChange if the commit
  // threshold was crossed. If the pan is mostly vertical (> ratio) we bail —
  // users scrolling the list must not accidentally page-turn.
  const swipeStartRef = useRef<{ x: number; y: number; axis: 'unknown' | 'h' | 'v' } | null>(null);
  const [swipeX, setSwipeX] = useState<number>(0);

  const canNext = page < pageCount;
  const canPrev = page > 1;

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (effectiveEditMode) return;
    if (pageCount <= 1) return;
    // Ignore non-primary buttons / non-touch multi-pointer — PointerDown with
    // button=0 covers touch + mouse-left.
    if (e.button !== 0) return;
    swipeStartRef.current = { x: e.clientX, y: e.clientY, axis: 'unknown' };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = swipeStartRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    // Lock the axis on first significant movement so the list doesn't
    // translate during a purely vertical scroll.
    if (start.axis === 'unknown') {
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX < 6 && absY < 6) return;
      start.axis = absX > absY * SWIPE_AXIS_RATIO ? 'h' : 'v';
      if (start.axis === 'v') {
        // Vertical scroll — drop the gesture, let the browser handle scroll.
        swipeStartRef.current = null;
        setSwipeX(0);
        return;
      }
    }

    if (start.axis !== 'h') return;
    // Clamp preview; also zero it out if swiping toward a non-existent page
    // so users can't drag a phantom "there's no next page" slide.
    let clamped = Math.max(-SWIPE_LIVE_MAX_PX, Math.min(SWIPE_LIVE_MAX_PX, dx));
    if ((clamped < 0 && !canNext) || (clamped > 0 && !canPrev)) clamped = 0;
    setSwipeX(clamped);
  }

  function resetSwipe() {
    swipeStartRef.current = null;
    setSwipeX(0);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const start = swipeStartRef.current;
    if (!start) {
      resetSwipe();
      return;
    }
    const dx = e.clientX - start.x;

    if (start.axis === 'h' && Math.abs(dx) >= SWIPE_COMMIT_PX) {
      if (dx < 0 && canNext) onPageChange(page + 1);
      else if (dx > 0 && canPrev) onPageChange(page - 1);
    }
    resetSwipe();
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndexPage = pageItems.indexOf(active.id as string);
    const newIndexPage = pageItems.indexOf(over.id as string);
    if (oldIndexPage < 0 || newIndexPage < 0) return;
    const reorderedPage = arrayMove(pageItems, oldIndexPage, newIndexPage);
    const newFullOrder = [
      ...order.slice(0, pageStart),
      ...reorderedPage,
      ...order.slice(pageEnd),
    ];
    onReorder(newFullOrder);
  }

  const listClasses = `metric-list ${isDark ? 'metric-list-dark' : 'metric-list-light'}`;

  const rows = pageItems.map((id, idx) => {
    const isDefault = (DEFAULT_CARD_IDS as readonly string[]).includes(id);
    const showDivider = idx < pageItems.length - 1;

    if (isPlaceholderId(id)) {
      // Shimmer row during first-paint padding. No ticker identity, not
      // draggable (we won't enter a DndContext when isInitialLoading).
      return (
        <MetricRow
          key={id}
          id={id}
          label=""
          value={null}
          isLoading={true}
          isDark={isDark}
          editMode={false}
          isCustom={false}
          showDivider={showDivider}
        />
      );
    }

    if (!isDefault) {
      return (
        <TickerMetricRow
          key={id}
          id={id}
          isDark={isDark}
          editMode={effectiveEditMode}
          showDivider={showDivider}
          onRemoveTicker={onRemoveTicker}
          groups={props.groups}
          onToggleTickerGroup={props.onToggleTickerGroup}
        />
      );
    }

    const data = buildRowData(id, props);
    return (
      <MetricRow
        key={id}
        {...data}
        isDark={isDark}
        editMode={effectiveEditMode}
        isCustom={false}
        showDivider={showDivider}
      />
    );
  });

  // Live-preview style: translate the whole list by the current swipe delta.
  // When the user releases, React re-renders with page ± 1, pageItems changes,
  // and swipeX resets to 0 — the list snaps back to resting position. No
  // animation on the outbound direction since the content literally changes.
  const swipeStyle: React.CSSProperties | undefined =
    swipeX !== 0
      ? { transform: `translateX(${swipeX}px)`, transition: 'none' }
      : { transform: 'translateX(0)', transition: 'transform 220ms ease' };

  const swipeHandlers = pageCount > 1 && !effectiveEditMode
    ? {
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerCancel: resetSwipe,
      }
    : undefined;

  // Read-only mode (and the first-paint loading phase): plain <ul>, no
  // DndContext, native scroll unimpeded. Swipe-to-page gesture attached to
  // an outer wrapper so we don't interfere with per-row link taps.
  if (!effectiveEditMode) {
    return (
      <div
        className="metric-list-swipe-wrap"
        style={swipeStyle}
        {...swipeHandlers}
      >
        <ul className={listClasses}>{rows}</ul>
      </div>
    );
  }

  // Edit mode: DndContext + vertical sortable strategy, no swipe.
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={pageItems} strategy={verticalListSortingStrategy}>
        <ul className={listClasses}>{rows}</ul>
      </SortableContext>
    </DndContext>
  );
}
