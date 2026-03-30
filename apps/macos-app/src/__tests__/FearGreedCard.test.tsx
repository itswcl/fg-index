import React from 'react';
import { render } from '@testing-library/react-native';
import { FearGreedCard } from '../components/FearGreedCard';
import { FearGreed } from '@shared/types';

const mockData: FearGreed = {
  score: 43,
  classification: 'Fear',
  previousClose: 38,
  oneWeekAgo: 41,
  oneMonthAgo: 55,
  oneYearAgo: 30,
  updatedAt: '2026-02-24T17:49:43+00:00',
};

describe('FearGreedCard', () => {
  it('shows loading state when isLoading is true', () => {
    const { getByText } = render(
      <FearGreedCard data={null} lastUpdate={null} isLoading={true} />
    );
    expect(getByText('Loading…')).toBeTruthy();
  });

  it('renders score and classification', () => {
    const { getByText } = render(
      <FearGreedCard data={mockData} lastUpdate={new Date()} />
    );
    expect(getByText('43')).toBeTruthy();
    expect(getByText('Fear')).toBeTruthy();
  });

  it('shows all trend items', () => {
    const { getByText } = render(
      <FearGreedCard data={mockData} lastUpdate={new Date()} />
    );
    expect(getByText('Prev Close')).toBeTruthy();
    expect(getByText('1W')).toBeTruthy();
    expect(getByText('1M')).toBeTruthy();
    expect(getByText('1Y')).toBeTruthy();
  });

  it('shows staleness badge when data is old', () => {
    const staleDate = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
    const { getByText } = render(
      <FearGreedCard data={mockData} lastUpdate={staleDate} />
    );
    expect(getByText('⚠ Data may be stale')).toBeTruthy();
  });

  it('has correct accessibility label', () => {
    const { getByRole } = render(
      <FearGreedCard data={mockData} lastUpdate={new Date()} />
    );
    expect(
      getByRole('button', {
        name: 'Fear and Greed Index: 43, Fear',
      })
    ).toBeTruthy();
  });
});
