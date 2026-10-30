// Learn more https://docs.expo.dev/guides/customizing-metro
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativewind } = require("nativewind/metro");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

const workspaceRoot = path.resolve(__dirname, "../..");
config.watchFolders = [__dirname, path.resolve(workspaceRoot, "packages")];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// `halo-2.0.riv` (persona) is packed as a local asset; without that entry
// Metro treats the require() as a module and fails with "Unable to resolve".
config.resolver.assetExts = [...config.resolver.assetExts, "riv"];

// The mermaid bundle (3.4 MB) goes as an asset, not as a module: it is read only
// when a diagram shows up and goes embedded in the WebView. Importing it as JS would make
// Metro transpile and embed everything in the main bundle.
config.resolver.assetExts = [...config.resolver.assetExts, "txt"];

// Apply withNativewind FIRST so its CSS resolution chain is established,
// then layer our custom lucide redirect on top.
const nativeWindConfig = withNativewind(config);

// Redirects the `lucide-react-native` imports of the app to the wrapper that
// applies `className` to the icons via styled() (the resolver of react-native-css
// does not cover lucide). The wrapper itself imports the real lucide — that is why
// we skip the redirect when the origin is the file itself.
const lucideStyled = path.resolve(__dirname, "src/lib/lucide-styled.js");
const originalResolveRequest = nativeWindConfig.resolver.resolveRequest;
nativeWindConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === "lucide-react-native" &&
    context.originModulePath !== lucideStyled
  ) {
    return (originalResolveRequest ?? context.resolveRequest)(context, lucideStyled, platform);
  }
  return (originalResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = nativeWindConfig;
