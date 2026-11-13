import type { ResolvedTheme } from '~/stores/theme-store'

/** Inline theme tokens — used where the NativeWind CSS classes do not change with the theme. */

export type ThemeTokens = Record<string, string>

const dark: ThemeTokens = {
  background: 'hsl(240, 11%, 4%)',
  foreground: 'hsl(0, 0%, 98%)',
  card: 'hsl(240, 6%, 10%)',
  cardForeground: 'hsl(0, 0%, 98%)',
  primary: 'hsl(44, 100%, 47%)',
  primaryForeground: 'hsl(30, 83%, 25%)',
  secondary: 'hsl(240, 4%, 16%)',
  secondaryForeground: 'hsl(0, 0%, 98%)',
  muted: 'hsl(240, 4%, 16%)',
  mutedForeground: 'hsl(240, 6%, 64%)',
  accent: 'hsl(240, 4%, 16%)',
  accentForeground: 'hsl(0, 0%, 98%)',
  destructive: 'hsl(359, 100%, 70%)',
  destructiveForeground: 'hsl(0, 0%, 98%)',
  success: 'hsl(142, 71%, 45%)',
  warning: 'hsl(38, 92%, 50%)',
  border: 'hsl(240, 4%, 13%)',
  input: 'hsl(240, 3%, 16%)',
  ring: 'hsl(240, 4%, 46%)',
}

const light: ThemeTokens = {
  background: 'hsl(0, 0%, 100%)',
  foreground: 'hsl(240, 10%, 4%)',
  card: 'hsl(0, 0%, 100%)',
  cardForeground: 'hsl(240, 10%, 4%)',
  primary: 'hsl(44, 100%, 70%)',
  primaryForeground: 'hsl(30, 83%, 25%)',
  secondary: 'hsl(240, 2%, 96%)',
  secondaryForeground: 'hsl(240, 10%, 4%)',
  muted: 'hsl(240, 2%, 96%)',
  mutedForeground: 'hsl(240, 4%, 55%)',
  accent: 'hsl(240, 2%, 96%)',
  accentForeground: 'hsl(240, 10%, 4%)',
  destructive: 'hsl(357, 100%, 45%)',
  destructiveForeground: 'hsl(0, 0%, 98%)',
  success: 'hsl(142, 71%, 36%)',
  warning: 'hsl(32, 95%, 40%)',
  border: 'hsl(240, 4%, 90%)',
  input: 'hsl(240, 4%, 90%)',
  ring: 'hsl(240, 4%, 65%)',
}

export function getThemeTokens(resolved: ResolvedTheme): ThemeTokens {
  return resolved === 'dark' ? dark : light
}

/** Converts `hsl(...)` into `hsla(...)` with the given opacity — translucent backgrounds in the style of `bg-primary/10` on the desktop. */
export function withAlpha(color: string, alpha: number): string {
  return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`)
}
