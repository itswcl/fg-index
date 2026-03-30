import React from 'react';
import { render } from '@testing-library/react-native';
import { WsStatusBadge } from '../components/WsStatusBadge';

describe('WsStatusBadge', () => {
  it('shows "Live" when connected', () => {
    const { getByText } = render(<WsStatusBadge status="connected" />);
    expect(getByText('● Live')).toBeTruthy();
  });

  it('shows "Connecting" when connecting', () => {
    const { getByText } = render(<WsStatusBadge status="connecting" />);
    expect(getByText('⟳ Connecting…')).toBeTruthy();
  });

  it('shows "Disconnected" when disconnected', () => {
    const { getByText } = render(<WsStatusBadge status="disconnected" />);
    expect(getByText('✕ Disconnected')).toBeTruthy();
  });
});
