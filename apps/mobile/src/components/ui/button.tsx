import { cva, type VariantProps } from "class-variance-authority";
import { Text, Pressable } from "react-native";
import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "flex-row items-center justify-center gap-2 rounded-md native:h-12 native:px-5 h-10 px-4",
  {
    variants: {
      variant: {
        default: "bg-primary active:opacity-90",
        destructive: "bg-destructive active:opacity-90",
        outline: "border border-border bg-transparent active:bg-accent",
        secondary: "bg-secondary active:opacity-80",
        ghost: "active:bg-accent",
        link: "",
      },
      size: {
        default: "",
        sm: "h-9 px-3 native:h-10",
        lg: "h-11 px-8 native:h-12",
        icon: "h-10 w-10 native:h-12 native:w-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

const buttonTextVariants = cva("native:text-base text-sm font-medium text-primary-foreground", {
  variants: {
    variant: {
      default: "text-primary-foreground",
      destructive: "text-destructive-foreground",
      outline: "text-foreground",
      secondary: "text-secondary-foreground",
      ghost: "text-foreground",
      link: "text-primary underline",
    },
    size: {
      default: "",
      sm: "text-sm native:text-base",
      lg: "text-base native:text-lg",
      icon: "",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

type ButtonProps = React.ComponentPropsWithoutRef<typeof Pressable> &
  VariantProps<typeof buttonVariants> & {
    textClass?: string;
  };

function Button({ variant, size, className, textClass, ...props }: ButtonProps) {
  return (
    <Pressable
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {(state) => (
        <Text
          className={cn(
            buttonTextVariants({ variant, size }),
            props.disabled && "opacity-50",
            textClass
          )}
        >
          {typeof props.children === "function"
            ? props.children(state)
            : props.children}
        </Text>
      )}
    </Pressable>
  );
}

export { Button, buttonVariants, buttonTextVariants };
