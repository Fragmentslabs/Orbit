import { Text, View, StyleSheet, type TextProps, type ViewProps } from "react-native";
import { getThemeTokens } from '~/lib/theme-tokens';
import { useThemeStore } from '~/stores/theme-store';

const Card = ({ style, ...props }: ViewProps) => {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved));

  return (
    <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.muted }, style]} {...props} />
  );
};

const CardHeader = ({ style, ...props }: ViewProps) => (
  <View style={[s.header, style]} {...props} />
);

const CardTitle = ({ style, ...props }: TextProps) => {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved));

  return (
    <Text style={[s.title, { color: tokens.foreground }, style]} {...props} />
  );
};

const CardDescription = ({ style, ...props }: TextProps) => {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved));

  return (
    <Text style={[s.desc, { color: tokens.mutedForeground }, style]} {...props} />
  );
};

const CardContent = ({ style, ...props }: ViewProps) => (
  <View style={[s.content, style]} {...props} />
);

const CardFooter = ({ style, ...props }: ViewProps) => (
  <View style={[s.footer, style]} {...props} />
);

const s = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 20 },
  header: { flexDirection: 'column', gap: 6 },
  title: { fontSize: 18, fontWeight: '600', lineHeight: 22 },
  desc: { fontSize: 14 },
  content: {},
  footer: { flexDirection: 'row', alignItems: 'center' },
});

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
