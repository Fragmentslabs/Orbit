import { View, Text, type TextProps } from "react-native";
import * as TabsPrimitive from "@rn-primitives/tabs";
import { cssInterop } from "nativewind";
import { cn } from "~/lib/utils";

cssInterop(TabsPrimitive.List, { className: "style" });
cssInterop(TabsPrimitive.Trigger, { className: "style" });
cssInterop(TabsPrimitive.Content, { className: "style" });

function Tabs({
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root {...props} />;
}

function TabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "flex-row native:h-12 h-10 items-center justify-center rounded-md bg-muted p-1",
        className
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "flex-row native:h-10 native:px-4 items-center justify-center gap-1.5 rounded-sm bg-transparent px-3 py-1.5",
        "web:transition-colors web:hover:bg-background/50",
        "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        className
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn(
        "mt-2 web:ring-offset-background focus-visible:outline-none",
        className
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
