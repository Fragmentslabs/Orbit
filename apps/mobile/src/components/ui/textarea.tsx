import { TextInput, type TextInputProps } from "react-native";
import { cn } from "~/lib/utils";
import { getThemeTokens } from '~/lib/theme-tokens';
import { useThemeStore } from '~/stores/theme-store';

const Textarea = ({ className, ...props }: TextInputProps) => {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved));
  return (
    <TextInput
      multiline
      style={{ fontSize: 14 }}
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
        "web:ring-offset-background",
        "placeholder:text-muted-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      placeholderTextColor={tokens.mutedForeground}
      textAlignVertical="top"
      {...props}
    />
  );
};

export { Textarea };
