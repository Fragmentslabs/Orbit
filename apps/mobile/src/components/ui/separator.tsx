import { View, type ViewProps } from "react-native";
import { cn } from "~/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: ViewProps & {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
}) {
  return (
    <View
      role={decorative ? "none" : "separator"}
      aria-orientation={!decorative ? orientation : undefined}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
        className
      )}
      {...props}
    />
  );
}

export { Separator };
