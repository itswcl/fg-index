import React, { useRef, useEffect } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  Text,
  Animated,
  Easing,
} from 'react-native';
import { useAppColorScheme } from '../hooks/useAppColorScheme';

type Status = 'connecting' | 'connected' | 'disconnected';

const STATUS_LABEL: Record<Status, string> = {
  connecting: 'Connecting…',
  connected: 'Live',
  disconnected: 'Disconnected',
};

const STATUS_COLOR: Record<Status, string> = {
  connecting: '#F39C12',
  connected: '#27AE60',
  disconnected: '#E74C3C',
};

const STATUS_BG_COLOR: Record<Status, string> = {
  connecting: 'rgba(243, 156, 18, 0.12)',
  connected: 'rgba(39, 174, 96, 0.12)',
  disconnected: 'rgba(231, 76, 60, 0.12)',
};

interface StatusRefreshButtonProps {
  status: Status;
  onPress: () => void;
  isRefreshing?: boolean;
}

export function StatusRefreshButton({ status, onPress, isRefreshing }: StatusRefreshButtonProps) {
  const colorScheme = useAppColorScheme();
  const isLight = colorScheme === 'light';
  
  const hoverAnim = useRef(new Animated.Value(0)).current;

  const backgroundColor = STATUS_BG_COLOR[status];
  const color = STATUS_COLOR[status];

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => {
        Animated.timing(hoverAnim, { toValue: 1, duration: 200, useNativeDriver: false }).start();
      }}
      onHoverOut={() => {
        Animated.timing(hoverAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start();
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor },
        isLight && styles.buttonLight,
        (pressed || isRefreshing) && styles.buttonPressed,
      ]}
    >
      <View style={styles.content}>
        <View style={styles.indicatorBox}>
          <View style={[styles.dot, { backgroundColor: color }]} />
        </View>
        <Text style={[styles.text, { color }]}>
          {isRefreshing ? 'Refreshing…' : STATUS_LABEL[status]}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 164, // Scaled for 368px window
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLight: {
    borderColor: 'rgba(0, 0, 0, 0.02)',
    backgroundColor: 'rgba(0, 0, 0, 0.035)',
  },
  buttonPressed: {
    opacity: 0.6,
    transform: [{ scale: 0.98 }],
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  indicatorBox: {
    width: 10,
    height: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  dot: {
    width: 3.5,
    height: 3.5,
    borderRadius: 1.75,
  },
  text: {
    fontSize: 7.5,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
});
