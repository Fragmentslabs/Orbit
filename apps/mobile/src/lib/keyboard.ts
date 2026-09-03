import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * Respiro entre o input e a barra de gestos do aparelho quando o teclado está
 * FECHADO. É um padding fixo do input — nunca animado.
 *
 * Quem anima é só o KeyboardAvoidingView, e ele recebe este mesmo valor como
 * `keyboardVerticalOffset` NEGATIVO, o que faz a conta dele virar
 * `padding = alturaDoTeclado - respiro`. Somando o respiro fixo do input:
 * fechado sobra o respiro, aberto o input encosta no teclado, e no meio da
 * transição existe uma única animação.
 *
 * A versão anterior animava o respiro por fora (interpolando o `progress` do
 * teclado): dava certo nos extremos, mas o `progress` do KAV e o do hook
 * público vêm de handlers diferentes — as duas animações saíam de fase por
 * alguns pixels e o input passava do ponto e voltava.
 *
 * O piso de 8 existe porque aparelho sem barra de gestos reporta inset 0, e aí
 * o input encostaria na borda da tela.
 */
export function useBottomBreathing(): number {
  const insets = useSafeAreaInsets()
  return Math.max(insets.bottom, 8)
}
