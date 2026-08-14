import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Eye, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { modelSupportsVision } from '@orbit/shared'
import type { FilePart } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { useSettingsStore } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'

/**
 * Card de aviso — espelho do VisionHintCard do desktop: o usuário anexou uma
 * imagem e o modelo atual não tem visão e o modo Visão não está configurado —
 * a imagem não chega ao agente. Oferece o atalho para abrir a configuração.
 * Descartável por sessão.
 */
export function VisionHintCard({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [dismissed, setDismissed] = useState(false)
  const prevSessionRef = useRef(sessionId)

  // Descarte é por sessão: ao trocar de chat, o card volta a poder aparecer
  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId
      setDismissed(false)
    }
  }, [sessionId])

  const selected = useSettingsStore((s) => s.selectedModel)
  const catalog = useSettingsStore((s) => s.catalog)
  const visionEnabled = useSettingsStore((s) => s.visionEnabled)
  const setVisionConfigOpen = useSettingsStore((s) => s.setVisionConfigOpen)
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] : undefined))

  // Sem modelo selecionado assume que tem visão (o desktop faz o mesmo: o
  // catálogo pode não estar carregado ainda — não incomoda o usuário).
  const provider = selected && catalog ? catalog[selected.providerId] : undefined
  const modelVision = selected ? modelSupportsVision(provider, selected.modelId) : true

  const lastImage = !modelVision && !visionEnabled && !dismissed && messages
    ? [...messages].reverse().find(
        (m) =>
          m.role === 'user' &&
          m.parts.some((p) => p.type === 'file' && (p as FilePart).mime.startsWith('image/')),
      )
    : undefined
  if (!lastImage) return null

  const primaryBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.12,
  )
  const primaryBorder = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.3,
  )
  const btnBg = hslToRgba(
    tokens.foreground.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.1,
  )

  return (
    <View style={[s.card, { borderColor: primaryBorder, backgroundColor: primaryBg }]}>
      <Eye size={16} color={tokens.primary} />
      <Text style={[s.text, { color: tokens.foreground }]}>{t('vision.hint')}</Text>
      <Pressable
        onPress={() => setVisionConfigOpen(true)}
        style={[s.configureBtn, { backgroundColor: btnBg }]}
      >
        <Text style={[s.configureLabel, { color: tokens.foreground }]}>{t('vision.configure')}</Text>
      </Pressable>
      <Pressable
        onPress={() => setDismissed(true)}
        hitSlop={8}
        accessibilityLabel={t('vision.dismiss')}
        style={s.dismissBtn}
      >
        <X size={15} color={tokens.mutedForeground} />
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  text: { flex: 1, fontSize: 12, lineHeight: 16 },
  configureBtn: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  configureLabel: { fontSize: 12, fontWeight: '500' },
  dismissBtn: { padding: 2, borderRadius: 6 },
})
