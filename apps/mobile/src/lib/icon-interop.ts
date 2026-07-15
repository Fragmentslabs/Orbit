/**
 * Registra os ícones do lucide-react-native no NativeWind.
 *
 * Sem isso, `className` em ícones é ignorado no runtime nativo (a cor e o
 * tamanho só funcionavam na web, onde className vira CSS de verdade).
 * O cssInterop mapeia className → style e move style.color/opacity para
 * as props que o react-native-svg entende.
 */
import { cssInterop } from 'nativewind'
import * as Lucide from 'lucide-react-native'

const SKIP = new Set(['createLucideIcon', 'Icon', 'LucideProvider', 'useLucideContext', 'default'])

const seen = new Set<unknown>()
for (const [name, component] of Object.entries(Lucide)) {
  if (SKIP.has(name) || typeof component !== 'object' && typeof component !== 'function') continue
  if (seen.has(component)) continue // aliases (Zap / ZapIcon / LucideZap) apontam pro mesmo ref
  seen.add(component)
  cssInterop(component as Parameters<typeof cssInterop>[0], {
    className: {
      target: 'style',
      nativeStyleToProp: { color: true, opacity: true },
    },
  })
}
