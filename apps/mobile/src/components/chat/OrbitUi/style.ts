import { getThemeTokens, withAlpha, type ThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/** Tokens do tema no componente — o mesmo par `getThemeTokens` + store dos
 *  outros componentes de chat (ver NavCard, CodeBlock). */
export function useTokens(): ThemeTokens {
  return getThemeTokens(useThemeStore((s) => s.resolved))
}

/** Fundo dos painéis de bloco: o `bg-secondary/40` do desktop. */
export const panelBg = (tokens: ThemeTokens) => withAlpha(tokens.secondary, 0.45)

/** Fundo dos cards (stat, compare): o `bg-secondary/70` do desktop. */
export const cardBg = (tokens: ThemeTokens) => withAlpha(tokens.secondary, 0.7)

/** Campo de entrada: o `bg-secondary` do desktop. */
export const fieldBg = (tokens: ThemeTokens) => withAlpha(tokens.secondary, 0.9)

/** Raio dos blocos (o `rounded-xl` do desktop, em px). */
export const RADIUS = 12

/** Verde/âmbar fixos do design system (os mesmos do TodoChecklist). */
export const SUCCESS = '#10b981'
export const WARNING = '#f59e0b'
