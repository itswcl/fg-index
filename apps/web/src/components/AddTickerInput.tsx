import { useState } from 'react';
import { MAX_CUSTOM_TICKERS } from '../constants';

interface AddTickerInputProps {
  tickerCount: number;
  isDark: boolean;
  onAdd: (ticker: string) => { ok: boolean; error?: string };
}

export function AddTickerInput({ tickerCount, isDark, onAdd }: AddTickerInputProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const atMax = tickerCount >= MAX_CUSTOM_TICKERS;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = onAdd(value);
    if (result.ok) {
      setValue('');
      setError('');
    } else {
      setError(result.error ?? 'Error');
    }
  };

  return (
    <div>
      <form className="add-ticker-form" onSubmit={handleSubmit}>
        <input
          className={`add-ticker-input ${isDark ? '' : 'add-ticker-input-light'}`}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError('');
          }}
          placeholder={atMax ? `Maximum ${MAX_CUSTOM_TICKERS} tickers` : 'Add ticker (e.g. AAPL, BTC)'}
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
