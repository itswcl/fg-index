module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module-resolver',
      {
        root: ['./src'],
        alias: {
          '@shared/types': '../../packages/shared-types/src/index.ts',
        },
      },
    ],
  ],
};
