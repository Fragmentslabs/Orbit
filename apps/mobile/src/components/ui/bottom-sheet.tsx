/**
 * Generic bottom sheet: native Modal (RN Modal) anchored to the bottom of the screen —
 * immune to popover/portal positioning issues (there is no way to leave the
 * screen bounds). The app standard for pickers and compact editors.
 *
 * - `closeOnOutsideTap={false}` for editors with unsaved content (the
 *   closing stays explicit in the buttons).
 * - Rises with the keyboard (KeyboardAvoidingView) on iOS.
 */
import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native'
import Animated, { Easing, FadeIn, SlideInDown } from 'react-native-reanimated'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  closeOnOutsideTap = true,
  maxHeight = '82%',
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** Close on tapping the backdrop and on the Android back button. */
  closeOnOutsideTap?: boolean
  maxHeight?: `${number}%` | number
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={closeOnOutsideTap ? onClose : undefined}
    >
      <Animated.View entering={FadeIn.duration(150)} style={s.backdrop}>
        {closeOnOutsideTap && <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.avoider}
        >
          <Animated.View
            entering={SlideInDown.duration(260).easing(Easing.out(Easing.cubic))}
            style={[
              s.sheet,
              {
                backgroundColor: tokens.card,
                borderColor: tokens.border,
                maxHeight: maxHeight,
              },
            ]}
          >
            <View style={[s.handle, { backgroundColor: tokens.mutedForeground }]} />
            {title}
            {children}
          </Animated.View>
        </KeyboardAvoidingView>
      </Animated.View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  avoider: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 28,
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10, opacity: 0.4 },
})
