import { View, Image, type ImageProps } from "react-native";
import { cn } from "~/lib/utils";

type AvatarProps = ImageProps & {
  size?: number;
  fallback?: string;
};

function Avatar({ className, size = 40, fallback, ...props }: AvatarProps) {
  const initials = fallback
    ? fallback
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  return (
    <View
      className={cn(
        "relative items-center justify-center overflow-hidden rounded-full bg-muted",
        className
      )}
      style={{ width: size, height: size }}
    >
      {props.source ? (
        <Image
          {...props}
          style={{ width: size, height: size, borderRadius: size / 2 }}
        />
      ) : (
        <View className="items-center justify-center">
          <Image
            {...props}
            style={{ width: size, height: size, borderRadius: size / 2 }}
          />
        </View>
      )}
    </View>
  );
}

export { Avatar };
