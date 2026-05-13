import { useEffect, useRef, useState } from 'react';
import { Shimmer } from './Shimmer';
import { MAX_CUSTOM_GROUPS, type TickerGroup } from '../hooks/useTickerGroups';

interface TickerGroupTabsProps {
  groups: TickerGroup[];
  activeGroupId: string;
  isLoading: boolean;
  isDark: boolean;
  isMobile: boolean;
  onSelectGroup: (groupId: string) => void;
  onCreateGroup: (name: string) => Promise<{ ok: boolean; error?: string; groupId?: string }>;
  onRenameGroup: (groupId: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  onDeleteGroup: (groupId: string) => Promise<{ ok: boolean }>;
}

type EditorState =
  | { mode: 'create' }
  | { mode: 'rename'; group: TickerGroup }
  | null;

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

export function TickerGroupTabs({
  groups,
  activeGroupId,
  isLoading,
  isDark,
  isMobile,
  onSelectGroup,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
}: TickerGroupTabsProps) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [editor, setEditor] = useState<EditorState>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TickerGroup | null>(null);
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0];
  const customGroupCount = groups.filter((group) => !group.isDefault).length;
  const atMaxGroups = customGroupCount >= MAX_CUSTOM_GROUPS;

  useEffect(() => {
    tabRefs.current.get(activeGroupId)?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
  }, [activeGroupId, groups.length]);

  useEffect(() => {
    if (!menuOpen) return;
    function close() {
      setMenuOpen(false);
    }
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  const surface = isDark ? 'is-dark' : 'is-light';

  return (
    <div className={`ticker-tabs-shell ${surface}`}>
      <div className="ticker-tabs-scroll-wrap">
        <div className="ticker-tabs-scroll" role="tablist" aria-label="Ticker groups">
          {isLoading ? (
            Array.from({ length: isMobile ? 3 : 5 }, (_, index) => (
              <div key={index} className="ticker-tab-shimmer">
                <Shimmer width={index === 0 ? 74 : 58} height={28} borderRadius={999} />
              </div>
            ))
          ) : (
            groups.map((group) => {
              const active = group.id === activeGroupId;
              return (
                <button
                  key={group.id}
                  ref={(node) => {
                    if (node) tabRefs.current.set(group.id, node);
                    else tabRefs.current.delete(group.id);
                  }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={group.name}
                  className={[
                    'ticker-tab',
                    active ? 'ticker-tab-active' : '',
                    group.isDefault ? 'ticker-tab-default' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onSelectGroup(group.id)}
                >
                  <span className="ticker-tab-label">{group.name}</span>
                  {active && !group.isDefault && (
                    <span
                      className="ticker-tab-menu-anchor"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpen((open) => !open);
                      }}
                    >
                      <DotsIcon />
                    </span>
                  )}
                </button>
              );
            })
          )}
          {isMobile && !isLoading && (
            <button
              type="button"
              className="ticker-tab ticker-tab-add-mobile"
              disabled={atMaxGroups}
              title={atMaxGroups ? `Maximum ${MAX_CUSTOM_GROUPS} groups` : 'Add group'}
              onClick={() => setEditor({ mode: 'create' })}
            >
              +
            </button>
          )}
        </div>
      </div>

      {!isMobile && !isLoading && (
        <button
          type="button"
          className="ticker-tab-add-desktop"
          disabled={atMaxGroups}
          title={atMaxGroups ? `Maximum ${MAX_CUSTOM_GROUPS} groups` : 'Add group'}
          onClick={() => setEditor({ mode: 'create' })}
        >
          +
        </button>
      )}

      {menuOpen && activeGroup && !activeGroup.isDefault && (
        <div
          className={`group-action-menu ${surface}`}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setEditor({ mode: 'rename', group: activeGroup });
            }}
          >
            Rename group
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              setMenuOpen(false);
              setDeleteTarget(activeGroup);
            }}
          >
            Delete group
          </button>
        </div>
      )}

      {editor && (
        <GroupNameEditor
          editor={editor}
          isDark={isDark}
          isMobile={isMobile}
          atMaxGroups={atMaxGroups}
          onClose={() => setEditor(null)}
          onCreate={onCreateGroup}
          onRename={onRenameGroup}
          onSelectGroup={onSelectGroup}
        />
      )}

      {deleteTarget && (
        <DeleteGroupConfirm
          group={deleteTarget}
          isDark={isDark}
          isMobile={isMobile}
          onClose={() => setDeleteTarget(null)}
          onDelete={async () => {
            await onDeleteGroup(deleteTarget.id);
            setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}

function GroupNameEditor({
  editor,
  isDark,
  isMobile,
  atMaxGroups,
  onClose,
  onCreate,
  onRename,
  onSelectGroup,
}: {
  editor: Exclude<EditorState, null>;
  isDark: boolean;
  isMobile: boolean;
  atMaxGroups: boolean;
  onClose: () => void;
  onCreate: TickerGroupTabsProps['onCreateGroup'];
  onRename: TickerGroupTabsProps['onRenameGroup'];
  onSelectGroup: (groupId: string) => void;
}) {
  const [value, setValue] = useState(editor.mode === 'rename' ? editor.group.name : '');
  const [error, setError] = useState(
    editor.mode === 'create' && atMaxGroups ? `Maximum ${MAX_CUSTOM_GROUPS} groups reached` : '',
  );
  const isRename = editor.mode === 'rename';
  const surface = isDark ? 'is-dark' : 'is-light';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (editor.mode === 'create' && atMaxGroups) {
      setError(`Maximum ${MAX_CUSTOM_GROUPS} groups reached`);
      return;
    }
    if (isRename) {
      const result = await onRename(editor.group.id, value);
      if (!result.ok) {
        setError(result.error ?? 'Enter a group name');
        return;
      }
    } else {
      const result = await onCreate(value);
      if (!result.ok) {
        setError(result.error ?? 'Enter a group name');
        return;
      }
      if (result.groupId) onSelectGroup(result.groupId);
    }

    setValue('');
    setError('');
    onClose();
  }

  return (
    <div className={isMobile ? 'group-sheet-backdrop' : 'group-popover-anchor'} onClick={isMobile ? onClose : undefined}>
      <form
        className={`${isMobile ? 'group-name-sheet' : 'group-name-popover'} ${surface}`}
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
      >
        <label className="group-name-label" htmlFor="group-name-input">New group name</label>
        <input
          id="group-name-input"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError('');
          }}
          maxLength={20}
          autoFocus
        />
        {error && <div className="group-name-error">{error}</div>}
        <div className="group-name-actions">
          <button type="button" className="group-secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="group-primary-btn">{isRename ? 'Rename' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function DeleteGroupConfirm({
  group,
  isDark,
  isMobile,
  onClose,
  onDelete,
}: {
  group: TickerGroup;
  isDark: boolean;
  isMobile: boolean;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const surface = isDark ? 'is-dark' : 'is-light';
  return (
    <div className={isMobile ? 'group-sheet-backdrop' : 'group-popover-anchor'} onClick={isMobile ? onClose : undefined}>
      <div
        className={`${isMobile ? 'group-name-sheet' : 'group-name-popover'} ${surface}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="group-delete-copy">Delete group “{group.name}”? Tickers will remain in other groups.</div>
        <div className="group-name-actions">
          <button type="button" className="group-secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="group-danger-btn" onClick={() => { void onDelete(); }}>Delete</button>
        </div>
      </div>
    </div>
  );
}
