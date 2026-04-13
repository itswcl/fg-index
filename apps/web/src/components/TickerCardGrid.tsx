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
import { TickerCardWrapper } from './TickerCardWrapper';
import { TickerCard } from './TickerCard';

interface TickerCardGridProps {
  tickers: string[];
  isDark: boolean;
  onRemove: (ticker: string) => void;
  onReorder: (newOrder: string[]) => void;
}

// ── Sortable slot wrapper ──────────────────────────────────
function SortableTickerSlot({
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

// ── Lifted card shown in DragOverlay ──────────────────────
function LiftedTickerCard({
  ticker,
  isDark,
  onRemove,
}: {
  ticker: string;
  isDark: boolean;
  onRemove: (ticker: string) => void;
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

  return (
    <div style={liftedStyle}>
      {/* Show a static snapshot card during drag — no live data needed */}
      <TickerCard
        ticker={ticker}
        data={undefined}
        lastUpdate={null}
        isLoading={true}
        isDark={isDark}
        onRemove={() => onRemove(ticker)}
      />
    </div>
  );
}

// ── TickerCardGrid ─────────────────────────────────────────
export function TickerCardGrid({ tickers, isDark, onRemove, onReorder }: TickerCardGridProps) {
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
      const oldIndex = tickers.indexOf(active.id as string);
      const newIndex = tickers.indexOf(over.id as string);
      onReorder(arrayMove(tickers, oldIndex, newIndex));
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
      <SortableContext items={tickers} strategy={rectSortingStrategy}>
        <div className="custom-tickers-row">
          {tickers.map((ticker) => (
            <SortableTickerSlot key={ticker} id={ticker} isDark={isDark}>
              <TickerCardWrapper ticker={ticker} isDark={isDark} onRemove={onRemove} />
            </SortableTickerSlot>
          ))}
        </div>
      </SortableContext>

      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {activeId ? (
          <LiftedTickerCard ticker={activeId} isDark={isDark} onRemove={onRemove} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
