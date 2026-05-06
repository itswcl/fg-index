import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_CUSTOM_TICKERS } from '../constants';
import type { TickerGroup } from '../hooks/useTickerGroups';

interface TickerGroupAssignmentMenuProps {
  ticker: string;
  groups: TickerGroup[];
  isDark: boolean;
  variant: 'card' | 'row';
  onToggleGroup: (ticker: string, groupId: string, shouldInclude: boolean) => void;
}

function MenuIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

export function TickerGroupAssignmentMenu({
  ticker,
  groups,
  isDark,
  variant,
  onToggleGroup,
}: TickerGroupAssignmentMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [draftGroupIds, setDraftGroupIds] = useState<Set<string>>(() => new Set());
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const originalGroupIdsRef = useRef<Set<string>>(new Set());

  function currentGroupIds(): Set<string> {
    return new Set(groups.filter((group) => group.tickers.includes(ticker)).map((group) => group.id));
  }

  function commitDraft() {
    const original = originalGroupIdsRef.current;
    const next = draftGroupIds;
    const allIds = new Set([...original, ...next]);
    for (const groupId of allIds) {
      const wasChecked = original.has(groupId);
      const shouldBeChecked = next.has(groupId);
      if (wasChecked !== shouldBeChecked) {
        onToggleGroup(ticker, groupId, shouldBeChecked);
      }
    }
  }

  function closeMenu({ commit }: { commit: boolean }) {
    if (commit) commitDraft();
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 220;
    const left = Math.min(window.innerWidth - width - 10, Math.max(10, rect.right - width));
    const top = Math.min(window.innerHeight - 260, rect.bottom + 8);
    setPosition({ top: Math.max(10, top), left });
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu({ commit: true });
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu({ commit: false });
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [draftGroupIds, groups, onToggleGroup, open, ticker]);

  const buttonClass = variant === 'card' ? 'card-group-btn' : 'metric-row-menu-btn';
  const surface = isDark ? 'is-dark' : 'is-light';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClass}
        aria-label={`Edit ${ticker} groups`}
        aria-expanded={open}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (open) {
            closeMenu({ commit: true });
            return;
          }
          const checked = currentGroupIds();
          originalGroupIdsRef.current = checked;
          setDraftGroupIds(new Set(checked));
          setOpen(true);
        }}
      >
        <MenuIcon />
      </button>
      {open && position && createPortal(
        <div
          ref={menuRef}
          className={`ticker-group-menu ${surface}`}
          style={{ top: position.top, left: position.left }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="ticker-group-menu-title">Groups</div>
          {groups.map((group) => {
            const checked = draftGroupIds.has(group.id);
            const full = !checked && group.tickers.length >= MAX_CUSTOM_TICKERS;
            return (
              <button
                key={group.id}
                type="button"
                className="ticker-group-menu-row"
                disabled={full}
                onClick={() => {
                  setDraftGroupIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  });
                }}
              >
                <span className={`ticker-group-checkbox ${checked ? 'checked' : ''}`} aria-hidden="true" />
                <span className="ticker-group-row-name" title={group.name}>{group.name}</span>
                <span className="ticker-group-row-count">
                  {full ? 'Full' : `${group.tickers.length}/${MAX_CUSTOM_TICKERS}`}
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
