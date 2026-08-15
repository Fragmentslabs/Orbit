import { useEffect, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { SvgXml } from 'react-native-svg'

/**
 * Cache de módulo dos SVGs já baixados (por providerId) + notificação para o
 * useSyncExternalStore: o catálogo re-renderiza as linhas com frequência
 * (busca, scroll virtualizado) e os logos são minúsculos e imutáveis.
 */
const cache = new Map<string, string>()
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

function fetchLogo(providerId: string) {
  if (cache.has(providerId)) return
  fetch(`https://models.dev/logos/${providerId}.svg`)
    .then((r) => (r.ok ? r.text() : ''))
    .then((text) => {
      cache.set(providerId, text)
      notify()
    })
    .catch(() => {
      cache.set(providerId, '')
      notify()
    })
}

/**
 * Logo do provedor (models.dev) com cor controlada.
 *
 * Os SVGs do models.dev usam `fill="currentColor"`. O expo-image não resolve
 * `currentColor` no native e o `tintColor` não é aplicado a SVG — resultado:
 * logo preto em qualquer tema. O react-native-svg resolve `currentColor`
 * através da prop `color` do Svg, então o logo assume a cor pedida.
 */
export function ProviderLogo({
  providerId,
  size,
  color,
}: {
  providerId: string
  size: number
  color: string
}) {
  const xml = useSyncExternalStore(subscribe, () => cache.get(providerId) ?? '')

  useEffect(() => {
    fetchLogo(providerId)
  }, [providerId])

  if (!xml) return <View style={{ width: size, height: size }} />

  return <SvgXml xml={xml} width={size} height={size} color={color} />
}
