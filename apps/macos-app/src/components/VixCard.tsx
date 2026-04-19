import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
} from 'react-native';
import { TickerQuote } from '@shared/types';
import { formatAbsoluteTime, isStale } from '../services/time.utils';
import { useAppColorScheme } from '../hooks/useAppColorScheme';
import { Shimmer } from './Shimmer';

interface VixCardProps {
  data: TickerQuote | null;
  vixAvailable: boolean;
  lastUpdate: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
}

export function VixCard({ data, vixAvailable, lastUpdate, isLoading, isRefreshing }: VixCardProps) {
  const [hovered, setHovered] = useState(false);
  const colorScheme = useAppColorScheme();
  const isLight = colorScheme === 'light';

  // Hover scale animation
  const showLoading = isLoading || (isRefreshing && !data);
  const showRefreshing = isRefreshing && !!data;

  if (!vixAvailable) {
    return (
      <View style={[styles.card, isLight && styles.cardLight]}>
        <View style={styles.innerContent}>
          <Text style={styles.label}>VIX</Text>
          <View style={styles.priceContainer}>
            <Text style={styles.naText}>N/A</Text>
            <Text style={styles.naSubtext}>Market Closed</Text>
          </View>
          <View style={styles.footerRow}>
            {lastUpdate && (
              <Text style={styles.updatedAt}>
                Last Close {lastUpdate.toLocaleTimeString()}
              </Text>
            )}
          </View>
        </View>
      </View>
    );
  }

  const price = data?.price ? data.price.toFixed(2) : '–';
  const change = data?.change ?? 0;
  const changePct = data?.changePercent ?? 0;
  const isPositive = change >= 0;
  const color = isPositive ? '#E74C3C' : '#27AE60'; // Red for VIX up (fear), Green for VIX down (greed)
  const arrow = isPositive ? '↑' : '↓';

  return (
    <View style={[styles.card, isLight && styles.cardLight]}>
      <View style={styles.innerContent}>
        <Text style={styles.label}>VIX</Text>
        
        <View style={styles.priceContainer}>
          {showRefreshing || showLoading ? (
            <View style={{ alignItems: 'center', gap: 6 }}>
              <Shimmer width={90} height={38} borderRadius={8} />
              <Shimmer width={70} height={13} borderRadius={4} />
            </View>
          ) : (
            <>
              <Text style={[styles.price, isLight && styles.priceLight]}>{price}</Text>
              <View style={styles.changeBox}>
                <Text style={[styles.change, { color }]}>
                  {arrow} {Math.abs(change).toFixed(2)}
                </Text>
                <Text style={[styles.changePct, { color }]}>
                  {' '}({Math.abs(changePct).toFixed(2)}%)
                </Text>
              </View>
            </>
          )}
        </View>

        <View style={styles.footerRow}>
          {showRefreshing || showLoading ? (
            <Shimmer width={110} height={8} borderRadius={2} />
          ) : lastUpdate ? (
            <Text style={[styles.updatedAt, isLight && styles.updatedAtLight]}>
              Updated {formatAbsoluteTime(lastUpdate)}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(28, 28, 30, 0.9)',
    borderRadius: 28,
    flex: 1,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    cursor: 'default',
    overflow: 'hidden',
  } as any,
  cardLight: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderColor: 'rgba(0, 0, 0, 0.05)',
    shadowOpacity: 0.1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
  },
  cardHovered: {
    backgroundColor: 'rgba(44, 44, 46, 0.95)',
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  cardHoveredLight: {
    backgroundColor: '#FFFFFF',
    borderColor: 'rgba(0, 0, 0, 0.12)',
  },
  cardUnavailable: {
    opacity: 0.8,
  },
  innerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  label: {
    fontSize: 7.5,
    fontWeight: '800',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  priceContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 42,
    gap: 2,
  },
  price: {
    fontSize: 34,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.5,
  },
  priceLight: {
    color: '#000000',
  },
  changeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  change: {
    fontSize: 12,
    fontWeight: '700',
  },
  changePct: {
    fontSize: 10,
    fontWeight: '600',
    opacity: 0.9,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 6,
  },
  naText: {
    fontSize: 32,
    fontWeight: '800',
    color: '#636366',
    letterSpacing: -0.5,
  },
  naSubtext: {
    fontSize: 9,
    color: '#636366',
    fontWeight: '600',
  },
  staleBadge: {
    fontSize: 8,
    color: '#F39C12',
    fontWeight: '700',
    marginBottom: -2,
  },
  updatedAt: {
    fontSize: 7.5,
    color: '#636366',
    fontWeight: '500',
  },
  updatedAtLight: {
    color: '#8E8E93',
  },
  loading: {
    fontSize: 18,
    color: '#636366',
    fontWeight: '600',
    textAlign: 'center',
    flex: 1,
    textAlignVertical: 'center',
  },
});
