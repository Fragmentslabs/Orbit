import { View, type ViewProps } from "react-native";
import { cn } from "~/lib/utils";

function Skeleton({ className, ...props }: ViewProps) {
  return (
    <View
      className={cn("rounded-md bg-muted animate-pulse", className)}
      {...props}
    />
  );
}

export { Skeleton };
