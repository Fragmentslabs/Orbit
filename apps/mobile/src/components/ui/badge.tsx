import { Text, StyleSheet, type TextProps } from "react-native";
import { getThemeTokens } from '~/lib/theme-tokens';
import { useThemeStore } from '~/stores/theme-store';

type BadgeProps = TextProps & {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline';
};

function Badge({ variant = 'default', style, ...props }: BadgeProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved));

  const variantStyles: Record<typeof variant, object> = {
    default: { borderColor: 'transparent', backgroundColor: tokens.primary, color: tokens.primaryForeground },
    secondary: { borderColor: 'transparent', backgroundColor: tokens.muted, color: tokens.foreground },
    destructive: { borderColor: 'transparent', backgroundColor: '#ff3344', color: tokens.foreground },
    outline: { backgroundColor: 'transparent', color: tokens.foreground },
  };

  return (
    <Text style={[s.base, variantStyles[variant], style]} {...props} />
  );
}

const s = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', borderRadius: 9999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 2, fontSize: 12, fontWeight: '600' },
});

export { Badge };
