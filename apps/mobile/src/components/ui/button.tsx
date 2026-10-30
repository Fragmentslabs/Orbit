import { Text, Pressable, View, StyleSheet } from "react-native";
import { Children, type ReactNode } from "react";
import { getThemeTokens } from '~/lib/theme-tokens';
import { useThemeStore } from '~/stores/theme-store';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

type ButtonProps = React.ComponentPropsWithoutRef<typeof Pressable> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/**
 * Button content: strings/numbers become <Text> with the color of the variant;
 * elements (icons, Spin, etc.) are kept as they are. Rendering everything in a
 * row <View> avoids the problem of SVG inside <Text> — which aligns the icon by the
 * text baseline instead of the vertical center of the button.
 */
function renderContent(children: ReactNode, textColor: string, disabled: boolean): ReactNode {
  return Children.map(children, (child) => {
    // JSX preserves literal spaces between elements (`<Icon /> {t('...')}`) as
    // " " text nodes — ignoring them avoids a ghost gap between icon and label.
    if (typeof child === 'string' && child.trim() === '') return null;
    if (typeof child === 'string' || typeof child === 'number') {
      return <Text style={[s.text, { color: textColor }, disabled && s.textDisabled]}>{child}</Text>;
    }
    return child;
  });
}

function Button({ variant = 'default', size = 'default', style, disabled, children, ...rest }: ButtonProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved));

  const VARIANT_BG: Record<ButtonVariant, string> = {
    default: tokens.primary,
    destructive: '#ff3344',
    outline: 'transparent',
    secondary: tokens.muted,
    ghost: 'transparent',
    link: 'transparent',
  };

  const VARIANT_TEXT: Record<ButtonVariant, string> = {
    default: tokens.primaryForeground,
    destructive: tokens.foreground,
    outline: tokens.foreground,
    secondary: tokens.foreground,
    ghost: tokens.foreground,
    link: tokens.primary,
  };

  const bgColor = VARIANT_BG[variant];
  const textColor = VARIANT_TEXT[variant];
  const isOutline = variant === 'outline';

  return (
    <Pressable
      style={[
        s.base,
        { backgroundColor: bgColor },
        isOutline && { borderWidth: 1, borderColor: tokens.border },
        SIZE_MAP[size],
        disabled && s.disabled,
        style as any,
      ]}
      disabled={disabled}
      {...rest}
    >
      {(pressState) => (
        <View style={s.content}>
          {renderContent(
            typeof children === 'function' ? children(pressState) : children,
            textColor,
            !!disabled,
          )}
        </View>
      )}
    </Pressable>
  );
}

const SIZE_MAP: Record<ButtonSize, object> = {
  default: {},
  sm: { height: 36, paddingHorizontal: 12 },
  lg: { height: 44, paddingHorizontal: 32 },
  icon: { height: 40, width: 40, paddingHorizontal: 0 },
};

const s = StyleSheet.create({
  base: {
    borderRadius: 6,
    height: 40,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    flexShrink: 1,
  },
  disabled: { opacity: 0.5 },
  text: { fontSize: 14, fontWeight: '500' },
  textDisabled: {},
});

export { Button };
