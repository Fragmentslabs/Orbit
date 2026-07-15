import { TextInput, type TextInputProps } from "react-native";
import { cn } from "~/lib/utils";

const Textarea = ({ className, ...props }: TextInputProps) => {
  return (
    <TextInput
      multiline
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
        "web:ring-offset-background",
        "placeholder:text-muted-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      placeholderTextColor="hsl(var(--muted-foreground))"
      textAlignVertical="top"
      {...props}
    />
  );
};

export { Textarea };
