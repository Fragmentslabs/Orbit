module.exports = function (api) {
  api.cache(true);
  return {
    // NativeWind v5 não usa mais o preset/jsxImportSource de babel — o
    // transform de className acontece no metro (withNativewind). O plugin
    // de worklets é exigido pelo react-native-reanimated 4 e deve ser o
    // último da lista.
    presets: ["babel-preset-expo"],
    plugins: ["react-native-worklets/plugin"],
  };
};
