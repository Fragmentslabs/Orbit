import * as React from "react";
import { ScrollView, type ScrollViewProps } from "react-native";
import { cn } from "~/lib/utils";

const ScrollView = React.forwardRef<ScrollView, ScrollViewProps>(
  ({ className, ...props }, ref) => (
    <ScrollView
      ref={ref}
      className={cn("", className)}
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      {...props}
    />
  )
);
ScrollView.displayName = "ScrollView";

export { ScrollView };
