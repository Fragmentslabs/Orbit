/**
 * Applies `className` to the lucide-react-native icons on NativeWind v5.
 *
 * The react-native-css resolver (globalClassNamePolyfill) only swaps the
 * `react-native` and `react-native-safe-area-context` imports for the
 * "styled" versions. lucide is not in that list, so `className` on icons would be
 * ignored in the native runtime (the color/size only worked on the web).
 *
 * Here each icon is wrapped with `styled()` mapping className→style and
 * moving style.color/opacity to the props react-native-svg understands
 * (same mapping as the old cssInterop of v4). metro.config.js redirects
 * the 'lucide-react-native' imports made by the app to this file, so
 * the use sites stay the same (`import { Monitor } from 'lucide-react-native'`).
 *
 * CommonJS on purpose: dynamic exports by name work with the named import
 * interop of babel/metro.
 */
const Lucide = require("lucide-react-native");
const { styled } = require("react-native-css");

const SKIP = new Set([
  "createLucideIcon",
  "Icon",
  "LucideProvider",
  "useLucideContext",
  "default",
  "__esModule",
]);

const mapping = {
  className: {
    target: "style",
    nativeStyleToProp: { color: true, opacity: true },
  },
};

// Aliases (Zap / ZapIcon / LucideZap) point to the same ref — wrap it once.
const cache = new Map();

Object.defineProperty(module.exports, "__esModule", { value: true });

for (const name of Object.keys(Lucide)) {
  const component = Lucide[name];
  const isComponent =
    component != null &&
    (typeof component === "function" || typeof component === "object");

  if (SKIP.has(name) || !isComponent) {
    module.exports[name] = component;
    continue;
  }

  let wrapped = cache.get(component);
  if (!wrapped) {
    wrapped = styled(component, mapping);
    cache.set(component, wrapped);
  }
  module.exports[name] = wrapped;
}
