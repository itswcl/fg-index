import { useState, useEffect } from 'react';
import { Appearance } from 'react-native';

/**
 * Safe drop-in for useColorScheme on react-native-macos.
 * Uses Appearance.getColorScheme() (static getter) to read the system
 * theme without registering a NativeEventEmitter subscription, which
 * crashes in the macOS standalone build when the Appearance module is
 * initialised before the bridge is ready.
 */
export function useAppColorScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    // Only attempt to read system theme inside useEffect when the bridge is likely stable
    try {
      const current = Appearance.getColorScheme();
      if (current) {
        setScheme(current);
      }
    } catch (err) {
      // If still failing, fall back to dark and don't re-throw to avoid crashing the app
      console.warn('Failed to read system color scheme:', err);
    }
  }, []);

  return scheme;
}
