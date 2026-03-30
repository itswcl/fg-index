import React from 'react';
import { render } from '@testing-library/react-native';
import { VixCard } from '../components/VixCard';
import { Vix } from '@shared/types';

const mockVix: Vix = {
  price: 19.5,
  previousClose: 21.01,
  change: -1.51,
  changePercent: -7.19,
  fetchedAt: '2026-02-24T17:55:41.806Z',
};

describe('VixCard', () => {
  it('shows loading state when isLoading is true', () => {
    const { getByText } = render(
      <VixCard data={null} vixAvailable={true} lastUpdate={null} isLoading={true} />
    );
    expect(getByText('Loading…')).toBeTruthy();
  });

  it('shows N/A when vix is unavailable', () => {
    const { getByText } = render(
      <VixCard data={null} vixAvailable={false} lastUpdate={null} />
    );
    expect(getByText('N/A')).toBeTruthy();
    expect(getByText('Data unavailable')).toBeTruthy();
  });

  it('renders price and change', () => {
    const { getByText } = render(
      <VixCard data={mockVix} vixAvailable={true} lastUpdate={new Date()} />
    );
    expect(getByText('19.50')).toBeTruthy();
    expect(getByText('Prev Close: 21.01')).toBeTruthy();
  });

  it('shows staleness badge when data is old', () => {
    const staleDate = new Date(Date.now() - 20 * 60 * 1000);
    const { getByText } = render(
      <VixCard data={mockVix} vixAvailable={true} lastUpdate={staleDate} />
    );
    expect(getByText('⚠ Data may be stale')).toBeTruthy();
  });

  it('has correct accessibility label', () => {
    const { getByRole } = render(
      <VixCard data={mockVix} vixAvailable={true} lastUpdate={new Date()} />
    );
    expect(
      getByRole('button', { name: /VIX index: 19.5, change -1.51/ })
    ).toBeTruthy();
  });
});
