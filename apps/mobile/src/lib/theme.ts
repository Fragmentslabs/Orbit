/**
 * Orbit Mobile Theme
 * CSS variables e utilitários de tema baseados no desktop
 * Cores em HSL para compatibilidade com NativeWind
 */

// ============================================
// CSS Variables (Light Theme - Default)
// ============================================
export const lightTheme = {
  background: '0 0% 100%',
  foreground: '240 11% 4%',
  card: '0 0% 100%',
  'card-foreground': '240 11% 4%',
  popover: '0 0% 100%',
  'popover-foreground': '240 11% 4%',
  primary: '47 100% 50%',
  'primary-foreground': '30 83% 25%',
  secondary: '240 4% 96%',
  'secondary-foreground': '240 6% 10%',
  muted: '240 4% 96%',
  'muted-foreground': '240 4% 46%',
  accent: '240 4% 96%',
  'accent-foreground': '240 6% 10%',
  destructive: '357 100% 45%',
  'destructive-foreground': '0 0% 98%',
  border: '240 6% 90%',
  input: '240 6% 90%',
  ring: '240 6% 64%',
  radius: '0.875rem',
} as const

// ============================================
// CSS Variables (Dark Theme)
// ============================================
export const darkTheme = {
  background: '240 11% 4%',
  foreground: '0 0% 98%',
  card: '240 6% 10%',
  'card-foreground': '0 0% 98%',
  popover: '240 6% 10%',
  'popover-foreground': '0 0% 98%',
  primary: '44 100% 47%',
  'primary-foreground': '30 83% 25%',
  secondary: '240 4% 16%',
  'secondary-foreground': '0 0% 98%',
  muted: '240 4% 16%',
  'muted-foreground': '240 6% 64%',
  accent: '240 4% 16%',
  'accent-foreground': '0 0% 98%',
  destructive: '359 100% 70%',
  'destructive-foreground': '0 0% 98%',
  border: '240 4% 13%',
  input: '240 3% 16%',
  ring: '240 4% 46%',
  radius: '0.875rem',
} as const

// ============================================
// Theme Type
// ============================================
export type Theme = typeof lightTheme

// ============================================
// Color Utility Functions
// ============================================

/**
 * Convert HSL string to rgba
 * @param hsl - HSL values string (e.g., "43 86% 62%")
 * @param alpha - Alpha value (0-1)
 */
export function hslToRgba(hsl: string, alpha = 1): string {
  const [h, s, l] = hsl.split(' ').map((v) => parseFloat(v))
  const sNorm = s / 100
  const lNorm = l / 100

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lNorm - c / 2

  let r = 0
  let g = 0
  let b = 0

  if (h < 60) {
    r = c; g = x; b = 0
  } else if (h < 120) {
    r = x; g = c; b = 0
  } else if (h < 180) {
    r = 0; g = c; b = x
  } else if (h < 240) {
    r = 0; g = x; b = c
  } else if (h < 300) {
    r = x; g = 0; b = c
  } else {
    r = c; g = 0; b = x
  }

  return `rgba(${Math.round((r + m) * 255)}, ${Math.round((g + m) * 255)}, ${Math.round((b + m) * 255)}, ${alpha})`
}

/**
 * Get a color value from the theme
 * @param theme - Theme object
 * @param key - Color key
 */
export function getThemeColor(
  theme: Theme,
  key: keyof Theme
): string {
  return theme[key]
}

// ============================================
// Breakpoints
// ============================================
export const breakpoints = {
  mobile: 0,
  tablet: 768,
  desktop: 1024,
} as const

export type Breakpoint = keyof typeof breakpoints

/**
 * Get current breakpoint based on width
 * @param width - Current width in pixels
 */
export function getBreakpoint(width: number): Breakpoint {
  if (width >= breakpoints.desktop) return 'desktop'
  if (width >= breakpoints.tablet) return 'tablet'
  return 'mobile'
}

// ============================================
// Shadow Presets
// ============================================
export const shadows = {
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
} as const

// ============================================
// Spacing Scale (for consistent spacing)
// ============================================
export const spacing = {
  '0': '0px',
  '1': '4px',
  '2': '8px',
  '3': '12px',
  '4': '16px',
  '5': '20px',
  '6': '24px',
  '8': '32px',
  '10': '40px',
  '12': '48px',
  '16': '64px',
  '20': '80px',
  '24': '96px',
} as const

// ============================================
// Typography Scale
// ============================================
export const typography = {
  xs: { fontSize: '12px', lineHeight: '16px' },
  sm: { fontSize: '14px', lineHeight: '20px' },
  base: { fontSize: '16px', lineHeight: '24px' },
  lg: { fontSize: '18px', lineHeight: '28px' },
  xl: { fontSize: '20px', lineHeight: '28px' },
  '2xl': { fontSize: '24px', lineHeight: '32px' },
  '3xl': { fontSize: '30px', lineHeight: '36px' },
  '4xl': { fontSize: '36px', lineHeight: '40px' },
} as const

// ============================================
// Theme Provider Utilities (for React Context)
// ============================================

/**
 * Generate CSS variables string for inline styles
 * @param theme - Theme object
 */
export function generateCSSVariables(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(theme)) {
    vars[`--${key}`] = value
  }
  return vars
}

/**
 * Dark mode detection helper
 * Uses React Native's Appearance API or falls back to light
 */
export function getSystemColorScheme(): 'light' | 'dark' {
  try {
    const { Appearance } = require('react-native')
    return Appearance.getColorScheme() ?? 'light'
  } catch {
    return 'light'
  }
}