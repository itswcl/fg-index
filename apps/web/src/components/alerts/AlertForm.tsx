import { useState } from 'react';
import type { Alert, Condition } from '../../types/alerts';

interface AlertFormProps {
  initial?: Alert;
  onSubmit: (data: Omit<Alert, 'id' | 'createdAt'>) => void;
  onCancel: () => void;
  isDark: boolean;
}

const EMPTY_CONDITION: Condition = { metric: 'fearGreed', operator: '<', value: 25 };

const METRIC_LABELS: Record<Condition['metric'], string> = {
  fearGreed: 'F&G',
  vix: 'VIX',
  btc: 'BTC',
  spx: 'SPX',
};

function conditionLabel(c: Condition): string {
  return `${METRIC_LABELS[c.metric]} ${c.operator} ${c.value}`;
}
// Exported for use in AlertItem
export { conditionLabel };

export function AlertForm({ initial, onSubmit, onCancel, isDark }: AlertFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [conditions, setConditions] = useState<Condition[]>(
    initial?.conditions.length ? initial.conditions : [{ ...EMPTY_CONDITION }],
  );
  const [logic, setLogic] = useState<'AND' | 'OR'>(initial?.logic ?? 'AND');
  const [enabled, setEnabled] = useState<boolean>(initial?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Alert name is required.';
    if (conditions.length === 0) e.conditions = 'Add at least one condition.';
    conditions.forEach((c, i) => {
      if (isNaN(c.value)) e[`condition_${i}`] = 'Value must be a number.';
    });
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    onSubmit({ name: name.trim(), conditions, logic, enabled });
  };

  const updateCondition = (index: number, patch: Partial<Condition>) => {
    setConditions((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const addCondition = () => {
    setConditions((prev) => [...prev, { ...EMPTY_CONDITION }]);
  };

  const removeCondition = (index: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== index));
  };

  const cardBg = isDark ? 'rgba(28,28,30,0.9)' : 'rgba(255,255,255,0.97)';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = '#8E8E93';
  const borderColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)';
  const inputBg = isDark ? 'rgba(44,44,46,0.9)' : '#F2F2F7';
  const inputBorder = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';
  const errorColor = '#E74C3C';
  const accentColor = '#007AFF';

  return (
    <div
      style={{
        background: cardBg,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 20,
        padding: '20px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        boxShadow: isDark
          ? '0 8px 24px rgba(0,0,0,0.5)'
          : '0 4px 16px rgba(0,0,0,0.12)',
      }}
    >
      <h3
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: textColor,
          letterSpacing: 0.3,
          margin: 0,
        }}
      >
        {initial ? 'Edit Alert' : 'New Alert'}
      </h3>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Name */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: subTextColor, textTransform: 'uppercase', letterSpacing: 1 }}>
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Extreme Fear"
            style={{
              background: inputBg,
              border: `1px solid ${errors.name ? errorColor : inputBorder}`,
              borderRadius: 8,
              padding: '7px 10px',
              fontSize: 13,
              color: textColor,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          {errors.name && (
            <span style={{ fontSize: 10, color: errorColor }}>{errors.name}</span>
          )}
        </div>

        {/* Conditions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={{ fontSize: 10, fontWeight: 700, color: subTextColor, textTransform: 'uppercase', letterSpacing: 1 }}>
              Conditions
            </label>
            <button
              type="button"
              onClick={addCondition}
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: accentColor,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: '2px 4px',
              }}
            >
              + Add
            </button>
          </div>

          {errors.conditions && (
            <span style={{ fontSize: 10, color: errorColor }}>{errors.conditions}</span>
          )}

          {conditions.map((cond, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: inputBg,
                border: `1px solid ${errors[`condition_${i}`] ? errorColor : inputBorder}`,
                borderRadius: 8,
                padding: '6px 8px',
              }}
            >
              {/* Metric */}
              <select
                value={cond.metric}
                onChange={(e) =>
                  updateCondition(i, { metric: e.target.value as Condition['metric'] })
                }
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: 12,
                  color: textColor,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  outline: 'none',
                  flex: '0 0 auto',
                }}
              >
                <option value="fearGreed">F&amp;G</option>
                <option value="vix">VIX</option>
                <option value="btc">BTC</option>
                <option value="spx">SPX</option>
              </select>

              {/* Operator */}
              <select
                value={cond.operator}
                onChange={(e) =>
                  updateCondition(i, { operator: e.target.value as Condition['operator'] })
                }
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: 12,
                  color: textColor,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  outline: 'none',
                  flex: '0 0 auto',
                }}
              >
                <option value="<">&lt;</option>
                <option value=">">&gt;</option>
                <option value="<=">&lt;=</option>
                <option value=">=">&gt;=</option>
                <option value="==">==</option>
              </select>

              {/* Value */}
              <input
                type="number"
                value={cond.value}
                onChange={(e) =>
                  updateCondition(i, { value: parseFloat(e.target.value) })
                }
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: 12,
                  color: textColor,
                  fontFamily: 'inherit',
                  outline: 'none',
                  flex: 1,
                  minWidth: 0,
                  width: '100%',
                }}
              />

              {/* Remove */}
              {conditions.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeCondition(i)}
                  aria-label="Remove condition"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#636366',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    padding: '0 2px',
                    fontFamily: 'inherit',
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Logic selector (only shown when multiple conditions) */}
        {conditions.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: subTextColor, textTransform: 'uppercase', letterSpacing: 1 }}>
              Match
            </span>
            {(['AND', 'OR'] as const).map((opt) => (
              <label
                key={opt}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  color: logic === opt ? accentColor : subTextColor,
                }}
              >
                <input
                  type="radio"
                  name="logic"
                  value={opt}
                  checked={logic === opt}
                  onChange={() => setLogic(opt)}
                  style={{ accentColor }}
                />
                {opt}
              </label>
            ))}
          </div>
        )}

        {/* Enable toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: subTextColor, textTransform: 'uppercase', letterSpacing: 1 }}>
            Enabled
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((v) => !v)}
            style={{
              width: 36,
              height: 20,
              borderRadius: 10,
              border: 'none',
              cursor: 'pointer',
              background: enabled ? accentColor : (isDark ? '#3A3A3C' : '#D1D1D6'),
              position: 'relative',
              transition: 'background 0.2s ease',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: enabled ? 18 : 2,
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: '#FFFFFF',
                transition: 'left 0.2s ease',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
              }}
            />
          </button>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 2 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: subTextColor,
              background: 'transparent',
              border: `1px solid ${borderColor}`,
              borderRadius: 8,
              padding: '6px 14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'opacity 0.15s',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: '#FFFFFF',
              background: accentColor,
              border: 'none',
              borderRadius: 8,
              padding: '6px 16px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'opacity 0.15s',
            }}
          >
            {initial ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
