import { cva, type VariantProps } from "class-variance-authority";
import { Text } from "react-native";
import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "flex-row items-center rounded-full border px-2.5 py-0.5 native:py-1",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary",
        secondary: "border-transparent bg-secondary",
        destructive: "border-transparent bg-destructive",
        outline: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

const badgeTextVariants = cva(
  "text-xs native:text-sm font-semibold",
  {
    variants: {
      variant: {
        default: "text-primary-foreground",
        secondary: "text-secondary-foreground",
        destructive: "text-destructive-foreground",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

type BadgeProps = React.ComponentPropsWithoutRef<typeof Text> &
  VariantProps<typeof badgeVariants>;

function Badge({ variant, className, ...props }: BadgeProps) {
  return (
    <Text
      className={cn(badgeVariants({ variant }), badgeTextVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
