import { useEffect } from 'react'
import { AppState } from 'react-native'
import { useConnectionStore } from '~/stores/connection-store'
import { useDictationPrefsStore } from '~/stores/dictation-prefs-store'
import { useVoiceDesktopStore } from '~/stores/voice-desktop-store'

/**
 * Whether the voice call is offered, and the pause that ends a turn.
 *
 * The desktop decides first (its call switch and its dictation), and the phone's own switch can
 * only narrow that — turning the call off on either side removes the button, and the composer
 * falls back to "send". The desktop's answer is read when the connection is up and again each time
 * the app comes back to the foreground, so a change made there shows up here.
 */
export function useCallAvailability(): { available: boolean; silenceMs: number } {
  const http = useConnectionStore((s) => s.http)
  const refresh = useVoiceDesktopStore((s) => s.refresh)
  const desktopAllows = useVoiceDesktopStore((s) => s.loaded && s.callEnabled)
  const silenceMs = useVoiceDesktopStore((s) => s.silenceMs)
  const phoneAllows = useDictationPrefsStore((s) => s.callEnabled)

  useEffect(() => {
    void refresh()
  }, [http, refresh])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh()
    })
    return () => sub.remove()
  }, [refresh])

  return { available: desktopAllows && phoneAllows, silenceMs }
}
