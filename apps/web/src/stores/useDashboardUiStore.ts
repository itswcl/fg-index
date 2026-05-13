import { create } from 'zustand';
import { createJSONStorage, persist, subscribeWithSelector, type StateStorage } from 'zustand/middleware';

const THEME_STORAGE_KEY = 'fg-theme';
const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export interface DashboardUiState {
  alertsOpen: boolean;
  editMode: boolean;
  activeGroupId: string;
  manualFgUpdateMs: number;
  manualVixUpdateMs: number;
  themePreference: ThemePreference;
}

export interface DashboardUiActions {
  setAlertsOpen: (open: boolean) => void;
  toggleAlertsOpen: () => void;
  setEditMode: (enabled: boolean) => void;
  setActiveGroupId: (groupId: string) => void;
  markManualFgUpdate: () => void;
  markManualVixUpdate: () => void;
  setThemePreference: (preference: ThemePreference) => void;
}

export type DashboardUiStore = DashboardUiState & DashboardUiActions;

type PersistedDashboardUiState = Pick<DashboardUiState, 'themePreference'>;

function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

const themePreferenceStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === 'undefined') return null;

    try {
      const raw = window.localStorage.getItem(name);
      if (!raw) return null;

      if (isThemePreference(raw)) {
        return JSON.stringify({ state: { themePreference: raw } });
      }

      return raw;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') return;

    try {
      const parsed = JSON.parse(value) as { state?: { themePreference?: unknown } };
      const preference = parsed.state?.themePreference;
      if (isThemePreference(preference)) {
        window.localStorage.setItem(name, preference);
        return;
      }
      window.localStorage.setItem(name, value);
    } catch {
      window.localStorage.setItem(name, value);
    }
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(name);
  },
};

export const useDashboardUiStore = create<DashboardUiStore>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        alertsOpen: false,
        editMode: false,
        activeGroupId: 'default',
        manualFgUpdateMs: 0,
        manualVixUpdateMs: 0,
        themePreference: 'system',
        setAlertsOpen: (alertsOpen) => set({ alertsOpen }),
        toggleAlertsOpen: () => set((state) => ({ alertsOpen: !state.alertsOpen })),
        setEditMode: (editMode) => set({ editMode }),
        setActiveGroupId: (activeGroupId) => set({ activeGroupId }),
        markManualFgUpdate: () => set({ manualFgUpdateMs: Date.now() }),
        markManualVixUpdate: () => set({ manualVixUpdateMs: Date.now() }),
        setThemePreference: (themePreference) => set({ themePreference }),
      }),
      {
        name: THEME_STORAGE_KEY,
        storage: createJSONStorage<PersistedDashboardUiState>(() => themePreferenceStorage),
        partialize: (state) => ({ themePreference: state.themePreference }),
      },
    ),
  ),
);
