/**
 * O quadrado padrão das ações da mensagem (copiar, ouvir, responder, reverter).
 *
 * 21×21 = ícone de 13 + 4 de respiro de cada lado. Existe porque o alinhamento
 * da barra não pode depender do tamanho intrínseco do que está dentro: o
 * indicador de atividade do estado "gerando" mede 20px, e com `padding` ele
 * esticava o botão (28×28), empurrando a linha inteira e tirando o ícone da
 * linha óptica dos outros.
 *
 * Com caixa fixa e conteúdo centralizado, as quatro ações ficam no mesmo eixo
 * em QUALQUER estado — inclusive enquanto a voz é gerada.
 */
import type { ReactNode } from 'react'
import { Pressable } from 'react-native'

/** Lado do quadrado. Um só número para todas as ações: é o que as alinha. */
export const ICON_BUTTON_SIZE = 21

interface IconButtonProps {
  onPress: () => void
  accessibilityLabel?: string
  accessibilityState?: { busy?: boolean }
  testID?: string
  children: ReactNode
}

export function IconButton({
  onPress,
  accessibilityLabel,
  accessibilityState,
  testID,
  children,
}: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      testID={testID}
      style={({ pressed }) => ({
        width: ICON_BUTTON_SIZE,
        height: ICON_BUTTON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {children}
    </Pressable>
  )
}
