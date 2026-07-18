import { TextInput, StyleSheet, type TextInputProps } from "react-native";
import { getThemeTokens } from '~/lib/theme-tokens';
import { useThemeStore } from '~/stores/theme-store';

const Input = ({ style, ...props }: TextInputProps) => {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved));

  return (
    <TextInput
      style={[s.input, { borderColor: tokens.muted, backgroundColor: tokens.background, color: tokens.foreground }, style]}
      placeholderTextColor={tokens.mutedForeground}
      {...props}
    />
  );
};

const s = StyleSheet.create({
  input: {
    height: 40,
    width: '100%',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
});

export { Input };
