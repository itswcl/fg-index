const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const path = require('path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  watchFolders: [
    path.resolve(__dirname, '../../packages/shared-types'),
  ],
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      // Proxy all react-native requires to react-native-macos
      if (moduleName === 'react-native') {
        return context.resolveRequest(context, 'react-native-macos', platform);
      }
      return context.resolveRequest(context, moduleName, platform);
    },
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(__dirname, '../../node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
