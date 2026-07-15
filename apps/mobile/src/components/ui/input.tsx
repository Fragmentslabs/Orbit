import { TextInput, type TextInputProps } from "react-native";
import { cn } from "~/lib/utils";

const Input = ({ className, ...props }: TextInputProps) => {
  return (
    <TextInput
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
        "web:ring-offset-background",
        "file:border-0 file:bg-transparent file:font-medium",
        "placeholder:text-muted-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      placeholderTextColor="hsl(var(--muted-foreground))"
      {...props}
    />
  );
};

export { Input };
