import { Text as RNText, type TextProps } from "react-native";
import { cn } from "~/lib/utils";

const Text = ({
  className,
  ...props
}: TextProps) => (
  <RNText
    className={cn("text-foreground", className)}
    {...props}
  />
);

export { Text };
