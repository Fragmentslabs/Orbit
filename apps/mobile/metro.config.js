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

// `halo-2.0.riv` (persona) é empacotado como asset local; sem essa entrada o
// Metro trata o require() como módulo e falha com "Unable to resolve".
config.resolver.assetExts = [...config.resolver.assetExts, "riv"];

// Apply withNativewind FIRST so its CSS resolution chain is established,
// then layer our custom lucide redirect on top.
const nativeWindConfig = withNativewind(config);

// Redireciona os imports de `lucide-react-native` do app para o wrapper que
// aplica `className` aos ícones via styled() (o resolver do react-native-css
// não cobre o lucide). O próprio wrapper importa o lucide real — por isso
// pulamos o redirect quando a origem é o próprio arquivo.
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
