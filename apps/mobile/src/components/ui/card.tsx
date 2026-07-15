import { Text, View, type TextProps, type ViewProps } from "react-native";
import { cn } from "~/lib/utils";

const Card = ({ className, ...props }: ViewProps) => (
  <View
    className={cn(
      "rounded-xl border border-border bg-card p-5 shadow-sm",
      className
    )}
    {...props}
  />
);

const CardHeader = ({ className, ...props }: ViewProps) => (
  <View className={cn("flex flex-col gap-1.5", className)} {...props} />
);

const CardTitle = ({ className, ...props }: TextProps) => (
  <Text
    className={cn(
      "text-lg font-semibold leading-none tracking-tight text-card-foreground",
      className
    )}
    {...props}
  />
);

const CardDescription = ({ className, ...props }: TextProps) => (
  <Text
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
);

const CardContent = ({ className, ...props }: ViewProps) => (
  <View className={cn("pt-0", className)} {...props} />
);

const CardFooter = ({ className, ...props }: ViewProps) => (
  <View
    className={cn("flex flex-row items-center pt-0", className)}
    {...props}
  />
);

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
