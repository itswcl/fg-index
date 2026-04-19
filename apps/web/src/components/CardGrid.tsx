import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FearGreedCard } from './FearGreedCard';
import { VixCard } from './VixCard';
import { BtcCard } from './BtcCard';
import { SpxCard } from './SpxCard';
import { TickerCard } from './TickerCard';
import { TickerCardWrapper } from './TickerCardWrapper';
import { DEFAULT_CARD_IDS } from '../hooks/useUnifiedOrder';
import type { FearGreed, TickerQuote } from '../types';
// Note: 'CardId' type no longer needed — order is string[] now

interface CardGridProps {
  /** Unified order — all card IDs (default + custom) in display order. */
  order: string[];
  /** Called with the full reordered array on drag end. */
  onReorder: (newOrder: string[]) => void;
  isDark: boolean;
  onRemoveTicker: (ticker: string) => void;
  // Default card data
  fearGreedData: FearGreed | null;
  fgLastUpdate: Date | null;
  fgIsLoading: boolean;
  fgIsRefreshing: boolean;
  vixData: TickerQuote | null;
  vixAvailable: boolean;
  vixLastUpdate: Date | null;
  vixIsLoading: boolean;
  vixIsRefreshing: boolean;
  btcData: TickerQuote | null;
  btcLastUpdate: Date | null;
  btcIsLoading: boolean;
  btcIsRefreshing: boolean;
  spxData: TickerQuote | null;
  spxAvailable: boolean;
  spxLastUpdate: Date | null;
  spxIsLoading: boolean;
  spxIsRefreshing: boolean;
}

// ── Per-card sortable slot ─────────────────────────────────
function SortableCardSlot({
  id,
  isDark,
  children,
}: {
  id: string;
  isDark: boolean;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  if (isDragging) {
    return (
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        className={`card-ghost ${isDark ? 'card-ghost-dark' : 'card-ghost-light'}`}
      />
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transform
          ? 'transform 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)'
          : transition ?? undefined,
        cursor: 'grab',
        touchAction: 'none',
      }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

// ── Renders content for a given card id ───────────────────
function renderCardContent(id: string, isDark: boolean, p: CardGridProps) {
  switch (id) {
    case 'feargreed':
      return (
        <FearGreedCard
          data={p.fearGreedData}
          lastUpdate={p.fgLastUpdate}
          isLoading={p.fgIsLoading}
          isRefreshing={p.fgIsRefreshing}
          isDark={isDark}
        />
      );
    case 'vix':
      return (
        <VixCard
          data={p.vixData}
          vixAvailable={p.vixAvailable}
          lastUpdate={p.vixLastUpdate}
          isLoading={p.vixIsLoading}
          isRefreshing={p.vixIsRefreshing}
          isDark={isDark}
        />
      );
    case 'btc':
      return (
        <BtcCard
          data={p.btcData}
          lastUpdate={p.btcLastUpdate}
          isLoading={p.btcIsLoading}
          isRefreshing={p.btcIsRefreshing}
          isDark={isDark}
        />
      );
    case 'spx':
      return (
        <SpxCard
          data={p.spxData}
          spxAvailable={p.spxAvailable}
          lastUpdate={p.spxLastUpdate}
          isLoading={p.spxIsLoading}
          isRefreshing={p.spxIsRefreshing}
          isDark={isDark}
        />
      );
    default:
      // Custom ticker
      return (
        <TickerCardWrapper
          ticker={id}
          isDark={isDark}
          onRemove={p.onRemoveTicker}
        />
      );
  }
}

// ── Lifted card shown in DragOverlay ──────────────────────
function LiftedCard({
  id,
  isDark,
  props,
}: {
  id: string;
  isDark: boolean;
  props: CardGridProps;
}) {
  const liftedStyle: React.CSSProperties = {
    transform: 'scale(1.04)',
    boxShadow: isDark
      ? '0 20px 40px rgba(0,0,0,0.6)'
      : '0 20px 40px rgba(0,0,0,0.22)',
    opacity: isDark ? 0.92 : 0.95,
    borderRadius: '28px',
    cursor: 'grabbing',
    outline: `1.5px solid ${isDark ? 'rgba(95,127,255,0.5)' : 'rgba(95,127,255,0.4)'}`,
    outlineOffset: '-1.5px',
  };

  const isCustom = !(DEFAULT_CARD_IDS as readonly string[]).includes(id);

  return (
    <div style={liftedStyle}>
      {isCustom ? (
        // Show shimmer snapshot for custom tickers during drag
        <TickerCard
          ticker={id}
          data={undefined}
          lastUpdate={null}
          isLoading={true}
          isDark={isDark}
          onRemove={() => {}}
        />
      ) : (
        renderCardContent(id, isDark, props)
      )}
    </div>
  );
}

// ── CardGrid (unified — default + custom in one context) ──
export function CardGrid(props: CardGridProps) {
  const { order, onReorder, isDark } = props;
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = order.indexOf(active.id as string);
      const newIndex = order.indexOf(over.id as string);
      onReorder(arrayMove(order, oldIndex, newIndex));
    }
    setActiveId(null);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={order} strategy={rectSortingStrategy}>
        <div className="cards-grid">
          {order.map((id) => (
            <SortableCardSlot key={id} id={id} isDark={isDark}>
              {renderCardContent(id, isDark, props)}
            </SortableCardSlot>
          ))}
        </div>
      </SortableContext>

      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {activeId ? (
          <LiftedCard id={activeId} isDark={isDark} props={props} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
