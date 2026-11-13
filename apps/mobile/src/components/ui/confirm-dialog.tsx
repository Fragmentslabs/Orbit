import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { getThemeTokens, withAlpha, type ThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * Confirmation box of the mobile app — the counterpart of the desktop's
 * `<ConfirmDialog>` (apps/desktop/components/ui/alert-dialog.tsx).
 *
 * `useConfirm()` returns a promise that resolves to `true` only when the person
 * confirms, so a destructive action becomes:
 *
 *   const confirm = useConfirm()
 *   if (!(await confirm({ title, description, confirmLabel, cancelLabel, destructive: true }))) return
 *
 * With `content` (switches, inputs, a list of choices) the box opens as a bottom
 * sheet instead of the centered alert — the same split the desktop makes between
 * `ConfirmDialog` and `DeleteChatDialog`.
 */

export type ConfirmOptions = {
  title: string
  description?: string
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  /** Extra content. When present the confirmation opens as a bottom sheet. */
  content?: ReactNode
}

type Resolver = (value: boolean) => void

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const resolved = useThemeStore((s) => s.resolved)
  const tokens = useMemo(() => getThemeTokens(resolved), [resolved])
  const resolver = useRef<Resolver | null>(null)
  const [options, setOptions] = useState<ConfirmOptions | null>(null)

  const confirm = useCallback((next: ConfirmOptions) => {
    // A second request while the first is open settles the first one as a cancel.
    resolver.current?.(false)
    setOptions(next)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value)
    resolver.current = null
    setOptions(null)
  }, [])

  const confirmColor = options?.destructive
    ? tokens.destructive
    : // On the light theme the primary is too pale to read as text on a white
      // card, so the action falls back to the foreground color.
      resolved === 'dark'
      ? tokens.primary
      : tokens.foreground

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        visible={!!options}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => settle(false)}
      >
        {options &&
          (options.content ? (
            <ConfirmSheet
              options={options}
              tokens={tokens}
              onCancel={() => settle(false)}
              onConfirm={() => settle(true)}
            />
          ) : (
            <ConfirmAlert
              options={options}
              tokens={tokens}
              confirmColor={confirmColor}
              onCancel={() => settle(false)}
              onConfirm={() => settle(true)}
            />
          ))}
      </Modal>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext)
  if (!confirm) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>')
  }
  return confirm
}

/** Centered alert: the app's skin on the system alert shape. */
function ConfirmAlert({
  options,
  tokens,
  confirmColor,
  onCancel,
  onConfirm,
}: {
  options: ConfirmOptions
  tokens: ThemeTokens
  confirmColor: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Pressable style={s.backdrop} onPress={onCancel}>
      <Pressable
        style={[s.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}
        onPress={() => {}}
        accessibilityRole="alert"
        accessibilityViewIsModal
      >
        <View style={s.body}>
          <Text style={[s.title, { color: tokens.foreground }]}>{options.title}</Text>
          {!!options.description && (
            <Text style={[s.description, { color: tokens.mutedForeground }]}>
              {options.description}
            </Text>
          )}
        </View>
        <View style={[s.actions, { borderTopColor: tokens.border }]}>
          <Pressable
            style={[s.action, { borderRightColor: tokens.border }]}
            onPress={onCancel}
            accessibilityRole="button"
          >
            <Text style={[s.actionText, { color: tokens.foreground }]}>{options.cancelLabel}</Text>
          </Pressable>
          <Pressable style={s.action} onPress={onConfirm} accessibilityRole="button">
            <Text style={[s.actionText, { color: confirmColor }]}>{options.confirmLabel}</Text>
          </Pressable>
        </View>
      </Pressable>
    </Pressable>
  )
}

/** Bottom sheet: used when the confirmation carries options of its own. */
function ConfirmSheet({
  options,
  tokens,
  onCancel,
  onConfirm,
}: {
  options: ConfirmOptions
  tokens: ThemeTokens
  onCancel: () => void
  onConfirm: () => void
}) {
  const insets = useSafeAreaInsets()

  return (
    <View style={s.sheetRoot}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
      <View
        style={[
          s.sheet,
          {
            backgroundColor: tokens.card,
            borderTopColor: tokens.border,
            paddingBottom: insets.bottom + 24,
          },
        ]}
        accessibilityViewIsModal
      >
        <View style={[s.handle, { backgroundColor: tokens.ring }]} />
        <Text style={[s.sheetTitle, { color: tokens.foreground }]}>{options.title}</Text>
        {!!options.description && (
          <Text style={[s.sheetDescription, { color: tokens.mutedForeground }]}>
            {options.description}
          </Text>
        )}
        {!!options.content && <View style={s.sheetContent}>{options.content}</View>}
        <View style={s.sheetActions}>
          <Pressable
            style={[
              s.sheetButton,
              {
                backgroundColor: options.destructive
                  ? withAlpha(tokens.destructive, 0.16)
                  : tokens.primary,
              },
            ]}
            onPress={onConfirm}
            accessibilityRole="button"
          >
            <Text
              style={[
                s.sheetButtonText,
                { color: options.destructive ? tokens.destructive : tokens.primaryForeground },
              ]}
            >
              {options.confirmLabel}
            </Text>
          </Pressable>
          <Pressable
            style={[s.sheetButton, s.sheetCancel, { borderColor: tokens.border }]}
            onPress={onCancel}
            accessibilityRole="button"
          >
            <Text style={[s.sheetButtonText, { color: tokens.foreground }]}>{options.cancelLabel}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  card: {
    width: 300,
    maxWidth: '100%',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
    elevation: 24,
  },
  body: {
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 18,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  description: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    borderTopWidth: 1,
  },
  action: {
    flex: 1,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    fontSize: 15,
    fontWeight: '500',
  },
  sheetRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 18,
    opacity: 0.6,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  sheetDescription: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 19,
  },
  sheetContent: {
    marginTop: 16,
  },
  sheetActions: {
    marginTop: 20,
    gap: 8,
  },
  sheetButton: {
    height: 46,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCancel: {
    borderWidth: 1,
  },
  sheetButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
})
