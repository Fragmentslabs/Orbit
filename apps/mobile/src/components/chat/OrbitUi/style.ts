import { getThemeTokens, withAlpha, type ThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/** Theme tokens in the component — the same pair `getThemeTokens` + store as the
 *  other chat components (see NavCard, CodeBlock). */
export function useTokens(): ThemeTokens {
  return getThemeTokens(useThemeStore((s) => s.resolved))
}

/** Background of the block panels: the `bg-secondary/40` of the desktop. */
export const panelBg = (tokens: ThemeTokens) => withAlpha(tokens.secondary, 0.45)

/** Background of the cards (stat, compare): the `bg-secondary/70` of the desktop. */
export const cardBg = (tokens: ThemeTokens) => withAlpha(tokens.secondary, 0.7)

/** Input field: the `bg-secondary` of the desktop. */
export const fieldBg = (tokens: ThemeTokens) => withAlpha(tokens.secondary, 0.9)

/** Radius of the blocks (the `rounded-xl` of the desktop, in px). */
export const RADIUS = 12

/** Fixed green/amber of the design system (the same ones as TodoChecklist). */
export const SUCCESS = '#10b981'
export const WARNING = '#f59e0b'
