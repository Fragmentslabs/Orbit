import * as React from "react";
import { ScrollView as RNScrollView, type ScrollViewProps } from "react-native";
import { cn } from "~/lib/utils";

const ScrollView = React.forwardRef<RNScrollView, ScrollViewProps>(
  ({ className, ...props }, ref) => (
    <RNScrollView
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
