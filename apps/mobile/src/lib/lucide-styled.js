/**
 * Aplica `className` aos ícones do lucide-react-native no NativeWind v5.
 *
 * O resolver do react-native-css (globalClassNamePolyfill) só troca os
 * imports de `react-native` e `react-native-safe-area-context` pelas versões
 * "styled". O lucide não entra nessa lista, então `className` em ícones seria
 * ignorado no runtime nativo (a cor/tamanho só funcionavam na web).
 *
 * Aqui cada ícone é embrulhado com `styled()` mapeando className→style e
 * movendo style.color/opacity para as props que o react-native-svg entende
 * (mesmo mapeamento do antigo cssInterop da v4). O metro.config.js redireciona
 * os imports de 'lucide-react-native' feitos pelo app para este arquivo, então
 * os locais de uso continuam iguais (`import { Monitor } from 'lucide-react-native'`).
 *
 * CommonJS de propósito: exports dinâmicos por nome funcionam com o interop de
 * import nomeado do babel/metro.
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

// Aliases (Zap / ZapIcon / LucideZap) apontam pro mesmo ref — embrulha 1x.
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
