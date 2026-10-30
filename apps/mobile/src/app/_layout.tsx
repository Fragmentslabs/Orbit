import "../global.css";
import "../i18n";

import { useEffect, useMemo, useRef } from "react"
import { useColorScheme } from "react-native"
import { setColorScheme } from "../lib/theme"

import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router"
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { PortalHost } from "@rn-primitives/portal";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCompanion } from "../hooks/useCompanion";
import { useNotifications } from "../hooks/useNotifications";
import { useConnectionStore } from "../stores/connection-store";
import { useNotificationPrefsStore } from "../stores/notification-prefs-store";
import { useSessionStore } from "../stores/session-store";
import { useThemeStore, hydrateThemePreference } from "../stores/theme-store";
import { useAppearanceStore, hydratePersonaVisibility, hydrateModesInRow } from "../stores/appearance-store";
import { useLocaleStore, hydrateLocale } from "../stores/locale-store";
import { useMessageQueueStore } from "../stores/message-queue-store";
import { useModelModePrefs } from "../stores/model-mode-prefs";
import { useModeOverrides } from "../stores/mode-overrides";
import { useSimplePrefs } from "../stores/simple-prefs";
import { useBrainPrefs } from "../stores/brain-prefs";
import { usePermissionPrefs } from "../stores/permission-prefs";
import { useSessionReasoning } from "../stores/session-reasoning";
import { useModelRotationStore } from "../stores/model-rotation-store";
import { hydrateInputDrafts } from "../stores/chat-draft-store";
import { loadLastSessionId, saveLastSessionId } from "../stores/last-chat-store";


SplashScreen.preventAutoHideAsync();

// ─── Navigation themes ─────────────────────────────────────────────────────

const OrbitDarkTheme: typeof DarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "hsl(240, 11%, 4%)",
    card: "hsl(240, 6%, 10%)",
    border: "hsl(240, 4%, 13%)",
    text: "hsl(0, 0%, 98%)",
    primary: "hsl(44, 100%, 47%)",
  },
};

const OrbitLightTheme: typeof DefaultTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: "hsl(0, 0%, 100%)",
    card: "hsl(0, 0%, 100%)",
    border: "hsl(240, 4%, 90%)",
    text: "hsl(240, 10%, 4%)",
    primary: "hsl(44, 100%, 70%)",
  },
};

export default function RootLayout() {
  const router = useRouter();
  const connection = useConnectionStore((s) => s.connection);
  const systemScheme = useColorScheme();
  const systemIsDark = systemScheme !== "light";
  const resolved = useThemeStore((s) => s.resolved);
  const setPreference = useThemeStore((s) => s.setPreference);

  // Hydrates the persisted theme and persona on mount
  useEffect(() => {
    hydrateThemePreference().then((pref) => {
      setPreference(pref, systemIsDark);
      setColorScheme(pref === "system" ? (systemIsDark ? "dark" : "light") : pref);
    });
    hydratePersonaVisibility().then((visibility) => {
      useAppearanceStore.getState().setPersonaVisibility(visibility);
    });
    hydrateModesInRow().then((modes) => {
      useAppearanceStore.getState().setModesInRow(modes);
    });
    hydrateLocale().then((locale) => {
      useLocaleStore.getState().setLocale(locale);
    });
    // Hydrates the defaults/overrides of the active modes (per chat) on mount
    void useModelModePrefs.getState().hydrate();
    void useModeOverrides.getState().hydrate();
    void useSimplePrefs.getState().hydrate();
    void useBrainPrefs.getState().hydrate();
    void usePermissionPrefs.getState().hydrate();
    void useSessionReasoning.getState().hydrate();
    void useModelRotationStore.getState().hydrate();
    // Input drafts per chat (the PromptInput also guarantees them before reading)
    void hydrateInputDrafts();
    // Boot hydration: runs once. Declaring the deps would make the app rehydrate
    // all persisted state on every change of the system theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Syncs changes of the theme-store with the Appearance API (NativeWind v5)
  useEffect(() => {
    setColorScheme(resolved);
  }, [resolved]);

  // Syncs a change of the OS scheme when the preference is "system"
  useEffect(() => {
    const pref = useThemeStore.getState().preference;
    if (pref === "system") {
      setPreference("system", systemIsDark);
      setColorScheme(systemIsDark ? "dark" : "light");
    }
  }, [systemIsDark, setPreference]);

  const navTheme = useMemo(
    () => (resolved === "dark" ? OrbitDarkTheme : OrbitLightTheme),
    [resolved],
  );

  // Inicializa o companion (auto-reconnect + event wiring)
  useCompanion();

  // Sets up local notifications reactive to the WS events
  useNotifications();

  const loadingConfig = useConnectionStore((s) => s.loadingConfig);
  const config = useConnectionStore((s) => s.config);

  // ─── Logical routing based on the connection state ──────────────────────
  // The route decision happens a single time, on the first "connected": without the
  // ref, a socket reconnection in the middle of the session threw the user back to the
  // new chat screen even with another chat open.
  const routedRef = useRef(false);
  useEffect(() => {
    if (connection.status === "connected") {
      if (routedRef.current) return;
      routedRef.current = true;
      void (async () => {
        // Goes back to the last open chat (the input draft comes along), if it
        // still exists on the desktop; otherwise falls back to the new chat screen.
        const lastId = await loadLastSessionId();
        if (lastId) {
          if (useSessionStore.getState().sessions.length === 0) {
            await useSessionStore.getState().fetchSessions();
          }
          const exists = useSessionStore.getState().sessions.some((s) => s.id === lastId);
          if (exists) {
            router.replace({ pathname: "/(main)/chat/[id]", params: { id: lastId } });
            return;
          }
          void saveLastSessionId(null);
        }
        router.replace("/(main)");
      })();
    } else if (!loadingConfig && connection.status === "disconnected") {
      // Only decides the route after loadConfig() has finished
      if (connection.errorReason || !config) {
        // Back to the pairing screen: the next connection decides the route.
        routedRef.current = false;
        router.replace("/(connection)");
      }
      // If there is a config but it errored, the connection screen shows the error
    }
  }, [connection.status, connection.errorReason, loadingConfig, config, router]);

  // Hides the splash only after the initial route decision
  useEffect(() => {
    if (!loadingConfig) {
      SplashScreen.hideAsync();
    }
  }, [loadingConfig]);

  useEffect(() => {
    // What was typed without a connection shows up in the queue before the socket opens.
    void useMessageQueueStore.getState().initialize();
    void useNotificationPrefsStore.getState().loadPrefs();
    // Loads the session cache so they show up immediately
    // (the real fetch over WS happens once it connects)
    void useSessionStore.getState().fetchSessions();
  }, []);

  // While the config loads, renders nothing (splash visible)
  if (loadingConfig && connection.status !== "connected") {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={navTheme}>
          <StatusBar style={resolved === "dark" ? "light" : "dark"} />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(connection)" />
            <Stack.Screen name="(main)" />
          </Stack>
          <PortalHost />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
