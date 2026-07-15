import { View, Text } from "react-native";

export default function HomeScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text className="text-2xl font-bold text-foreground">
        Orbit Mobile
      </Text>
      <Text className="text-sm text-muted-foreground mt-2">
        Companion App
      </Text>
    </View>
  );
}
