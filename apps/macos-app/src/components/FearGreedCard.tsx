import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
} from 'react-native';
import { FearGreed, FearGreedClassification } from '@shared/types';
import { FEAR_GREED_COLORS } from '../constants';
import { formatAbsoluteTime, isStale } from '../services/time.utils';
import { useAppColorScheme } from '../hooks/useAppColorScheme';

import { Shimmer } from './Shimmer';

interface FearGreedCardProps {
  data: FearGreed | null;
  lastUpdate?: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
}

/**
 * Returns the brand color associated with a classification.
 */
function getFearGreedColor(classification: FearGreedClassification | string): string {
  // Safe cast for indexing
  const key = classification as keyof typeof FEAR_GREED_COLORS;
  return FEAR_GREED_COLORS[key] || '#FFFFFF';
}

export function FearGreedCard({ data, lastUpdate, isLoading, isRefreshing }: FearGreedCardProps) {
  const colorScheme = useAppColorScheme();
  const isLight = colorScheme === 'light';
  
  const showLoading = isLoading || (isRefreshing && !data);
  const showRefreshing = isRefreshing && !!data;

  const label = data?.classification || 'Fear & Greed';
  const score = data?.score ?? '–';
  const color = getFearGreedColor(label);

  return (
    <View style={[styles.card, isLight && styles.cardLight]}>
      <View style={styles.innerContent}>
        <Text style={styles.label}>Fear & Greed</Text>
        
        <View style={styles.scoreContainer}>
          {showLoading ? (
            <View style={{ alignItems: 'center', gap: 6 }}>
              <Shimmer width={70} height={38} borderRadius={8} />
              <Shimmer width={55} height={12} borderRadius={4} />
            </View>
          ) : (
            <>
              <Text style={[styles.score, isLight && styles.scoreLight, { color }]}>
                {score}
              </Text>
              <Text style={[styles.classification, { color }]}>
                {label}
              </Text>
            </>
          )}
        </View>

        <View style={styles.footerRow}>
          {showRefreshing || showLoading ? (
            <Shimmer width={100} height={8} borderRadius={2} />
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
  scoreContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 42, // Slightly increased to accommodate gap
    gap: 2,
  },
  score: {
    fontSize: 40, 
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  scoreLight: {
  },
  classification: {
    fontSize: 13, 
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 6,
  },
  staleBadge: {
    fontSize: 9,
    color: '#F39C12',
    fontWeight: '700',
    marginBottom: -4,
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
