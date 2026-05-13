import { useCallback, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { hydrateQuoteCacheIntoQueryClient } from './lib/quoteCache';
import { useTheme } from './hooks/useTheme';
import {
  DEFAULT_CARD_IDS,
  PLACEHOLDER_ID_PREFIX,
  isDefaultCardId,
  isPlaceholderId,
} from './hooks/useUnifiedOrder';
import { DEFAULT_GROUP_ID, useTickerGroups } from './hooks/useTickerGroups';
import { useAlerts } from './hooks/useAlerts';
import { useDefaultMarketPresentation } from './hooks/useDefaultMarketPresentation';
import { CardGrid } from './components/CardGrid';
import { MobileMetricList } from './components/MobileMetricList';
import { IconBar } from './components/IconBar';
import { AlertsPopup } from './components/AlertsPopup';
import { AddTickerInput } from './components/AddTickerInput';
import { PageIndicator } from './components/PageIndicator';
import { TickerGroupTabs } from './components/TickerGroupTabs';
import { EmptyGroupState } from './components/EmptyGroupState';
import { usePagination } from './hooks/usePagination';
import { CARDS_PER_PAGE } from './constants';
import { useIsMobile, useIsNarrow } from './hooks/useIsMobile';
import { useDashboardUiStore } from './stores/useDashboardUiStore';
import type { AlertTriggeredMessage } from './types/alerts';
import './App.css';

const queryClient = new QueryClient();
// Seed every ['ticker', SYMBOL] cache entry from localStorage before the
// tree first renders, so custom ticker cards paint last-known prices on
// reload instead of flashing shimmer / "Not Found" while the batch
// request is in flight. Live fetches overwrite as they arrive.
hydrateQuoteCacheIntoQueryClient(queryClient);

function MarketIndicators() {
  const {
    alerts,
    addAlert,
    updateAlert,
    deleteAlert,
    toggleAlert,
    isAnonymous: alertsAnonymous,
    migrationCandidate: alertsMigrationCandidate,
    acceptMigration: acceptAlertsMigration,
    dismissMigration: dismissAlertsMigration,
  } = useAlerts();

  const handleAlertTriggered = useCallback(
    (msg: AlertTriggeredMessage) => {
      updateAlert(msg.alertId, { lastTriggeredAt: msg.triggeredAt });
    },
    [updateAlert],
  );

  const {
    wsStatus,
    fearGreedData,
    vixData,
    btcData,
    spxData,
    fgLastUpdate,
    vixLastUpdate,
    btcLastUpdate,
    spxLastUpdate,
    fgIsLoading,
    fgIsRefreshing,
    vixIsLoading,
    vixIsRefreshing,
    btcIsLoading,
    btcIsRefreshing,
    spxIsLoading,
    spxIsRefreshing,
    refreshDefaultIndicators,
  } = useDefaultMarketPresentation({ alerts, onAlertTriggered: handleAlertTriggered });

  const { theme, setTheme, isDark } = useTheme();
  const alertsOpen = useDashboardUiStore((state) => state.alertsOpen);
  const setAlertsOpen = useDashboardUiStore((state) => state.setAlertsOpen);
  const toggleAlertsOpen = useDashboardUiStore((state) => state.toggleAlertsOpen);
  const isMobile = useIsMobile();
  const isNarrow = useIsNarrow();
  const editMode = useDashboardUiStore((state) => state.editMode);
  const setEditMode = useDashboardUiStore((state) => state.setEditMode);

  // Exiting mobile viewport should always leave edit mode; desktop uses native drag.
  useEffect(() => {
    if (!isMobile && editMode) setEditMode(false);
  }, [editMode, isMobile, setEditMode]);

  const activeAlertCount = alerts.filter(a => a.enabled).length;
  const {
    groups,
    isLoading: isGroupsLoading,
    createGroup,
    renameGroup,
    deleteGroup,
    addTickerToGroup,
    setTickerMembership,
    reorderGroupTickers,
  } = useTickerGroups();
  const activeGroupId = useDashboardUiStore((state) => state.activeGroupId);
  const setActiveGroupId = useDashboardUiStore((state) => state.setActiveGroupId);
  const defaultGroup = groups.find((group) => group.isDefault) ?? groups[0];
  const activeGroupExists = groups.some((group) => group.id === activeGroupId);
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? defaultGroup;
  const isDefaultGroup = activeGroup?.isDefault ?? true;
  const groupTickers = activeGroup?.tickers ?? [];

  const order = isGroupsLoading
    ? [
        ...(isDefaultGroup ? DEFAULT_CARD_IDS : []),
        ...Array.from(
          { length: isDefaultGroup ? CARDS_PER_PAGE - DEFAULT_CARD_IDS.length : CARDS_PER_PAGE },
          (_, index) => `${PLACEHOLDER_ID_PREFIX}${index}`,
        ),
      ]
    : [
        ...(isDefaultGroup ? DEFAULT_CARD_IDS : []),
        ...groupTickers,
      ];

  const isInitialLoading = isGroupsLoading;
  // URL-bound pagination. During group hydration the indicator stays mounted
  // with a single placeholder dot so the footer does not jump.
  const { page, setPage, pageCount } = usePagination(order.length, { perPage: CARDS_PER_PAGE });
  const indicatorPage = isInitialLoading ? 1 : page;
  const indicatorPageCount = isInitialLoading ? 1 : pageCount;
  const previousGroupIdRef = useRef(activeGroupId);

  useEffect(() => {
    if (groups.length > 0 && !activeGroupExists) {
      setActiveGroupId(defaultGroup?.id ?? DEFAULT_GROUP_ID);
    }
  }, [activeGroupExists, defaultGroup?.id, groups.length, setActiveGroupId]);

  useEffect(() => {
    if (previousGroupIdRef.current === activeGroupId) return;
    previousGroupIdRef.current = activeGroupId;
    setPage(1);
    setEditMode(false);
  }, [activeGroupId, setEditMode, setPage]);

  const handleAddTicker = useCallback(
    (ticker: string) => {
      if (!activeGroup) return { ok: false, error: 'Enter a ticker' };
      return addTickerToGroup(activeGroup.id, ticker);
    },
    [activeGroup, addTickerToGroup],
  );

  const handleReorder = useCallback(
    (newOrder: string[]) => {
      if (!activeGroup) return;
      const tickerOrder = newOrder.filter((id) => !isDefaultCardId(id) && !isPlaceholderId(id));
      reorderGroupTickers(activeGroup.id, tickerOrder);
    },
    [activeGroup, reorderGroupTickers],
  );

  const handleRemoveTicker = useCallback(
    (ticker: string) => {
      if (!activeGroup) return;
      setTickerMembership(ticker, activeGroup.id, false);
    },
    [activeGroup, setTickerMembership],
  );

  const handleToggleTickerGroup = useCallback(
    (ticker: string, groupId: string, shouldInclude: boolean) => {
      setTickerMembership(ticker, groupId, shouldInclude);
    },
    [setTickerMembership],
  );

  return (
    <div className={`app-container ${isMobile ? 'app-container-mobile' : ''} ${isDark ? 'app-dark' : 'app-light'}`}>
      <div className="widget">
        <div className="top-bar">
          <AddTickerInput
            tickerCount={groupTickers.length}
            isDark={isDark}
            onAdd={handleAddTicker}
            placeholder={`Add ticker to ${activeGroup?.name ?? 'Default'} (e.g. AAPL, TSLA)`}
            collapsible={isNarrow}
          />
          <IconBar
            isDark={isDark}
            wsStatus={wsStatus}
            onStatusClick={refreshDefaultIndicators}
            activeAlertCount={activeAlertCount}
            onAlertsClick={toggleAlertsOpen}
            theme={theme}
            onThemeSelect={setTheme}
          />
          {isMobile && !isInitialLoading && (
            editMode ? (
              <button
                type="button"
                className="edit-toggle edit-toggle-done"
                onClick={() => setEditMode(false)}
                aria-label="Finish reordering"
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                className={`icon-btn edit-toggle ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
                onClick={() => setEditMode(true)}
                aria-label="Edit order"
                aria-pressed={editMode}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke={isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)'}
                  strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </button>
            )
          )}
        </div>
        <TickerGroupTabs
          groups={groups}
          activeGroupId={activeGroup?.id ?? DEFAULT_GROUP_ID}
          isLoading={isGroupsLoading}
          isDark={isDark}
          isMobile={isMobile}
          onSelectGroup={setActiveGroupId}
          onCreateGroup={createGroup}
          onRenameGroup={renameGroup}
          onDeleteGroup={async (groupId) => {
            const result = await deleteGroup(groupId);
            if (result.ok) setActiveGroupId(DEFAULT_GROUP_ID);
            return result;
          }}
        />
        {alertsOpen && (
          <AlertsPopup
            isDark={isDark}
            alerts={alerts}
            onAdd={addAlert}
            onUpdate={updateAlert}
            onDelete={deleteAlert}
            onToggle={toggleAlert}
            onClose={() => setAlertsOpen(false)}
            isAnonymous={alertsAnonymous}
            migrationCandidate={alertsMigrationCandidate}
            onAcceptMigration={() => { void acceptAlertsMigration(); }}
            onDismissMigration={dismissAlertsMigration}
          />
        )}
        {!isInitialLoading && !isDefaultGroup && order.length === 0 ? (
          <EmptyGroupState
            groupName={activeGroup?.name ?? 'Group'}
            isDark={isDark}
            isMobile={isMobile}
          />
        ) : isMobile ? (
          <MobileMetricList
            order={order}
            onReorder={handleReorder}
            page={page}
            perPage={CARDS_PER_PAGE}
            onPageChange={setPage}
            pageCount={pageCount}
            onRemoveTicker={handleRemoveTicker}
            groups={groups}
            onToggleTickerGroup={handleToggleTickerGroup}
            isDark={isDark}
            editMode={editMode}
            isInitialLoading={isInitialLoading}
            fearGreedData={fearGreedData}
            fgIsLoading={fgIsLoading}
            fgIsRefreshing={fgIsRefreshing}
            vixData={vixData}
            vixIsLoading={vixIsLoading}
            vixIsRefreshing={vixIsRefreshing}
            btcData={btcData}
            btcIsLoading={btcIsLoading}
            btcIsRefreshing={btcIsRefreshing}
            spxData={spxData}
            spxIsLoading={spxIsLoading}
            spxIsRefreshing={spxIsRefreshing}
          />
        ) : (
          <CardGrid
            order={order}
            onReorder={handleReorder}
            page={page}
            perPage={CARDS_PER_PAGE}
            pageCount={pageCount}
            onPageChange={setPage}
            onRemoveTicker={handleRemoveTicker}
            groups={groups}
            onToggleTickerGroup={handleToggleTickerGroup}
            isDark={isDark}
            isInitialLoading={isInitialLoading}
            fearGreedData={fearGreedData}
            fgLastUpdate={fgLastUpdate}
            fgIsLoading={fgIsLoading}
            fgIsRefreshing={fgIsRefreshing}
            vixData={vixData}
            vixLastUpdate={vixLastUpdate}
            vixIsLoading={vixIsLoading}
            vixIsRefreshing={vixIsRefreshing}
            btcData={btcData}
            btcLastUpdate={btcLastUpdate}
            btcIsLoading={btcIsLoading}
            btcIsRefreshing={btcIsRefreshing}
            spxData={spxData}
            spxLastUpdate={spxLastUpdate}
            spxIsLoading={spxIsLoading}
            spxIsRefreshing={spxIsRefreshing}
          />
        )}
        {indicatorPageCount >= 1 && (
          <PageIndicator
            page={indicatorPage}
            pageCount={indicatorPageCount}
            onPageChange={setPage}
            isDark={isDark}
            // Mobile relies on swipe for navigation; show dots only.
            showChevrons={!isMobile}
          />
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MarketIndicators />
    </QueryClientProvider>
  );
}
