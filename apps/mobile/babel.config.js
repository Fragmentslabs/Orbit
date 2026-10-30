module.exports = function (api) {
  api.cache(true);
  return {
    // NativeWind v5 no longer uses babel's preset/jsxImportSource — the
    // transform of className happens in metro (withNativewind). The plugin
    // worklets one is required by react-native-reanimated 4 and must be the
    // last in the list.
    presets: ["babel-preset-expo"],
    plugins: ["react-native-worklets/plugin"],
  };
};
