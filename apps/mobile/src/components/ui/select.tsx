import { Platform, View } from "react-native";
import * as SelectPrimitive from "@rn-primitives/select";
import * as DialogPrimitive from "@rn-primitives/dialog";
import { cssInterop } from "nativewind/macro";
import { cn } from "~/lib/utils";
import { Text } from "react-native";

cssInterop(SelectPrimitive.Root, { className: "style" });
cssInterop(SelectPrimitive.Trigger, { className: "style" });
cssInterop(SelectPrimitive.Value, { className: "style" });
cssInterop(SelectPrimitive.Content, { className: "style" });
cssInterop(SelectPrimitive.Item, { className: "style" });
cssInterop(SelectPrimitive.ItemText, { className: "style" });
cssInterop(SelectPrimitive.ItemIndicator, { className: "style" });
cssInterop(DialogPrimitive.Portal, { className: "style" });
cssInterop(DialogPrimitive.Overlay, { className: "style" });
cssInterop(DialogPrimitive.Content, { className: "style" });

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex h-10 flex-row items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm",
        "web:ring-offset-background",
        "placeholder:text-muted-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="text-muted-foreground">
        <Text>▾</Text>
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Content
      className={cn(
        "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border border-border bg-background shadow-md",
        className
      )}
      {...props}
    >
      {children}
    </SelectPrimitive.Content>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "flex flex-row items-center rounded-sm py-1.5 pl-2 pr-8 native:py-2",
        "web:outline-none web:focus:bg-accent web:focus:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="text-sm native:text-base" />
    </SelectPrimitive.Item>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("py-1.5 pl-8 pr-2 text-sm font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof View>) {
  return (
    <View
      className={cn("-mx-1 my-1 h-px bg-muted", className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
