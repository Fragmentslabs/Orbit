import { useEffect, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { SvgXml } from 'react-native-svg'

/**
 * Module cache of the SVGs already downloaded (by providerId) + notification to
 * useSyncExternalStore: the catalog re-renders the rows often
 * (search, virtualized scroll) and the logos are tiny and immutable.
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
 * Provider logo (models.dev) with a controlled color.
 *
 * The models.dev SVGs use `fill="currentColor"`. expo-image does not resolve
 * `currentColor` on native and `tintColor` is not applied to SVG — result:
 * a black logo in any theme. react-native-svg resolves `currentColor`
 * through the `color` prop of Svg, so the logo takes on the requested color.
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
