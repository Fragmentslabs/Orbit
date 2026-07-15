import "../global.css";

import { PortalHost } from "@rn-primitives/portal";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useColorScheme } from "react-native";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <PortalHost />
    </ThemeProvider>
  );
}
