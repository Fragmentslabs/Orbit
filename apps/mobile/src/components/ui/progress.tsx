import { View } from "react-native";
import * as ProgressPrimitive from "@rn-primitives/progress";
import { cn } from "~/lib/utils";

function Progress({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-secondary",
        className
      )}
      {...props}
    />
  );
}

function ProgressIndicator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Indicator>) {
  return (
    <ProgressPrimitive.Indicator
      className={cn(
        "absolute inset-0 bg-primary transition-all",
        className
      )}
      {...props}
    />
  );
}

export { Progress, ProgressIndicator };
