/**
 * Bottom sheet genérico: Modal nativo (RN Modal) ancorado na base da tela —
 * imune a problemas de posicionamento de popover/portal (não há como sair dos
 * limites da tela). Padrão do app para pickers e editores compactos.
 *
 * - `fecharAoToqueFora={false}` para editores com conteúdo não salvo (o
 *   fechamento fica explícito nos botões).
 * - Levanta junto com o teclado (KeyboardAvoidingView) em iOS.
 */
import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native'
import Animated, { Easing, FadeIn, SlideInDown } from 'react-native-reanimated'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function BottomSheet({
  aberto,
  aoFechar,
  titulo,
  children,
  fecharAoToqueFora = true,
  alturaMaxima = '82%',
}: {
  aberto: boolean
  aoFechar: () => void
  titulo?: ReactNode
  children: ReactNode
  /** Fechar ao tocar no fundo e no botão voltar do Android. */
  fecharAoToqueFora?: boolean
  alturaMaxima?: `${number}%` | number
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <Modal
      visible={aberto}
      transparent
      animationType="fade"
      onRequestClose={fecharAoToqueFora ? aoFechar : undefined}
    >
      <Animated.View entering={FadeIn.duration(150)} style={s.backdrop}>
        {fecharAoToqueFora && <Pressable style={StyleSheet.absoluteFill} onPress={aoFechar} />}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.avoider}
        >
          <Animated.View
            entering={SlideInDown.duration(260).easing(Easing.out(Easing.cubic))}
            style={[
              s.folha,
              {
                backgroundColor: tokens.card,
                borderColor: tokens.border,
                maxHeight: alturaMaxima,
              },
            ]}
          >
            <View style={[s.alca, { backgroundColor: tokens.mutedForeground }]} />
            {titulo}
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
  folha: {
    width: '100%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 28,
  },
  alca: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10, opacity: 0.4 },
})
