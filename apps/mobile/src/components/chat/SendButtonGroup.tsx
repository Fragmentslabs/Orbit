import { useEffect, useState } from 'react'
import { View, Text, Pressable, Modal, Animated, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Send, Square, ArrowUp, ListPlus, CalendarIcon } from 'lucide-react-native'
import { cn } from '~/lib/utils'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface SendButtonGroupProps {
  onSend: () => void
  onStop: () => void
  onQueue: () => void
  onStopAndSend: () => void
  onSchedule: () => void
  isStreaming: boolean
  hasText: boolean
  disabled?: boolean
}

export function SendButtonGroup({
  onSend,
  onStop,
  onQueue,
  onStopAndSend,
  onSchedule,
  isStreaming,
  hasText,
  disabled,
}: SendButtonGroupProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const [menuVisible, setMenuVisible] = useState(false)
  const [slideAnim] = useState(() => new Animated.Value(300))
  const [backdropAnim] = useState(() => new Animated.Value(0))

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: menuVisible ? 0 : 300,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: menuVisible ? 1 : 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start()
  }, [menuVisible, slideAnim, backdropAnim])

  const canAct = hasText && !disabled
  const isBusyNoText = isStreaming && !canAct

  const handleShortPress = () => {
    if (isStreaming && canAct) {
      onQueue()
    } else if (isStreaming) {
      onStop()
    } else if (canAct) {
      onSend()
    }
  }

  const handleLongPress = () => {
    if ((isStreaming && canAct) || (!isStreaming && canAct)) {
      setMenuVisible(true)
    }
  }

  const menuOptions = isStreaming && canAct
    ? [
        { label: 'Parar e enviar', icon: Send, action: () => { setMenuVisible(false); onStopAndSend() } },
        { label: 'Agendar', icon: CalendarIcon, action: () => { setMenuVisible(false); onSchedule() } },
      ]
    : [
        { label: 'Agendar mensagem', icon: CalendarIcon, action: () => { setMenuVisible(false); onSchedule() } },
      ]

  if (isBusyNoText) {
    return (
      <Pressable
        onPress={onStop}
        className="h-9 w-9 rounded-full items-center justify-center"
        style={{ backgroundColor: tokens.destructive ?? '#ef4444' }}
      >
        <Square size={13} color="#fff" fill="#fff" />
      </Pressable>
    )
  }

  return (
    <>
      <Pressable
        onPress={handleShortPress}
        onLongPress={handleLongPress}
        delayLongPress={400}
        disabled={!canAct && !isStreaming}
        className={cn('h-9 w-9 rounded-full items-center justify-center')}
        style={{
          backgroundColor: canAct || isStreaming ? tokens.primary : tokens.muted,
          opacity: canAct || isStreaming ? 1 : 0.4,
        }}
      >
        {isStreaming ? (
          <ListPlus size={16} color={tokens.primaryForeground} />
        ) : (
          <ArrowUp size={18} color={tokens.primaryForeground} />
        )}
      </Pressable>

      <Modal visible={menuVisible} transparent animationType="none" onRequestClose={() => setMenuVisible(false)}>
        <Animated.View style={[s.backdrop, { opacity: backdropAnim }]}>
          <Pressable style={{ flex: 1 }} onPress={() => setMenuVisible(false)} />
        </Animated.View>

        <Animated.View
          style={[
            s.sheet,
            {
              paddingBottom: insets.bottom + 12,
              transform: [{ translateY: slideAnim }],
              backgroundColor: tokens.card,
              borderColor: tokens.border,
            },
          ]}
        >
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />

          <View style={[s.optionsList, { borderBottomColor: tokens.border }]}>
            <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>Opções de envio</Text>
          </View>

          <View style={s.optionItems}>
            {menuOptions.map((opt) => (
              <Pressable
                key={opt.label}
                onPress={opt.action}
                style={({ pressed }) => [s.optionRow, { backgroundColor: tokens.border, opacity: pressed ? 0.7 : 1 }]}
              >
                <opt.icon size={20} color={tokens.foreground} />
                <Text style={[s.optionLabel, { color: tokens.foreground }]}>{opt.label}</Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </Modal>
    </>
  )
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 16,
  },
  optionsList: {
    paddingBottom: 12,
    borderBottomWidth: 1,
    marginBottom: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  optionItems: {
    gap: 8,
    paddingBottom: 8,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
})
