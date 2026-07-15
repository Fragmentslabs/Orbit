import "../global.css";

import { useEffect } from "react"
import { Stack, useRouter } from "expo-router"
import { PortalHost } from "@rn-primitives/portal";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useColorScheme } from "react-native";
import { useCompanion } from "../hooks/useCompanion";
import { useNotifications } from "../hooks/useNotifications";
import { useConnectionStore } from "../stores/connection-store";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const connection = useConnectionStore((s) => s.connection);

  // Inicializa o companion (auto-reconnect + event wiring)
  useCompanion();

  // Configura notificações locais reativas aos eventos WS
  useNotifications();

  // ─── Routing lógico baseado no estado de conexão ──────────────────────
  useEffect(() => {
    if (connection.status === "connected") {
      router.replace("/(app)");
    } else if (
      connection.status === "disconnected" ||
      connection.status === "connecting" ||
      connection.status === "authenticating"
    ) {
      router.replace("/(connection)");
    }
  }, [connection.status, router]);

  // Esconde splash screen quando o routing está pronto
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(connection)" />
        <Stack.Screen name="(app)" />
      </Stack>
      <PortalHost />
    </ThemeProvider>
  );
}
