import { useEffect, useRef, useState } from 'react';
import { MAX_CUSTOM_TICKERS } from '../constants';

interface AddTickerInputProps {
  tickerCount: number;
  isDark: boolean;
  onAdd: (ticker: string) => { ok: boolean; error?: string };
  placeholder?: string;
  /**
   * When true, renders collapsed to a magnifier icon; tap expands the
   * input full-width (per mobile layout spec Q5 for viewports < 420px).
   */
  collapsible?: boolean;
}

export function AddTickerInput({
  tickerCount,
  isDark,
  onAdd,
  placeholder = 'Add ticker (e.g. AAPL, BTC)',
  collapsible = false,
}: AddTickerInputProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(!collapsible);
  const inputRef = useRef<HTMLInputElement>(null);

  const atMax = tickerCount >= MAX_CUSTOM_TICKERS;

  useEffect(() => {
    // Auto-focus when expanding the collapsible variant.
    if (collapsible && expanded) inputRef.current?.focus();
  }, [collapsible, expanded]);

  // If the host toggles `collapsible` off (viewport widens past the breakpoint),
  // make sure the input is visible again.
  useEffect(() => {
    if (!collapsible) setExpanded(true);
  }, [collapsible]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = onAdd(value);
    if (result.ok) {
      setValue('');
      setError('');
      if (collapsible) setExpanded(false);
    } else {
      setError(result.error ?? 'Error');
    }
  };

  const handleBlur = () => {
    if (collapsible && !value.trim()) setExpanded(false);
  };

  if (collapsible && !expanded) {
    const iconColor = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)';
    return (
      <div style={{ flex: '0 0 auto' }}>
        <button
          type="button"
          className={`icon-btn ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
          aria-label="Add ticker"
          onClick={() => setExpanded(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke={iconColor} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <form className="add-ticker-form" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          className={`add-ticker-input ${isDark ? '' : 'add-ticker-input-light'}`}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError('');
          }}
          onBlur={handleBlur}
          placeholder={atMax ? `Maximum ${MAX_CUSTOM_TICKERS} tickers` : placeholder}
          disabled={atMax}
          maxLength={20}
          spellCheck={false}
          autoCapitalize="characters"
          autoCorrect="off"
        />
        <button
          type="submit"
          className={`add-ticker-btn ${isDark ? '' : 'add-ticker-btn-light'}`}
          disabled={atMax || !value.trim()}
          aria-label="Add ticker"
        >
          +
        </button>
      </form>
      {error && <p className="add-ticker-error">{error}</p>}
    </div>
  );
}
