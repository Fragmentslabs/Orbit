import "../global.css";
import "../i18n";

import { useEffect, useMemo, useRef, useState } from "react"
import { useColorScheme } from "react-native"
import { setColorScheme } from "../lib/theme"

import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider,
  usePathname,
  useRootNavigationState,
  useRouter,
  useSegments,
  type Href,
} from "expo-router"
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { PortalHost } from "@rn-primitives/portal";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import type { ConnectionErrorReason } from "@orbit/companion-client"
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

/** Failures the phone cannot get past on its own: the pairing has to be redone. */
function isAuthRejection(reason?: ConnectionErrorReason): boolean {
  return (
    reason === "invalid_pin" ||
    reason === "already_paired" ||
    reason === "rate_limited" ||
    reason === "unknown"
  );
}

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
    void useSessionTools.getState().hydrate();
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
  // WHERE the app opens is decided once per connection: the last chat (if it still
  // exists on the desktop) or the new chat screen. A socket reconnection in the middle
  // of the session must not pull the person out of the chat they are reading.
  const segments = useSegments();
  const pathname = usePathname();
  const navigationState = useRootNavigationState();
  // The pairing screen lives in a group of its own. It is recognized by the PATH, not by
  // the segment: if `segments` ever comes back without the group (or before the navigator
  // hydrates), a replace fired on every connection change would remount the screen and
  // close the QR modal / wipe the PIN — the pairing would look broken.
  const inConnection = pathname === "/connect" || segments[0] === "(connection)";
  const atDraft = !inConnection && (pathname === "/" || pathname === "");
  const navReady = !!navigationState?.key;

  /** Where the app opens: the last chat (if it still exists on the desktop) or the new
   *  chat screen. Tied to the desktop it was read from — pairing another one starts over
   *  (`null` = still being read). */
  const pairingKey = config ? `${config.host}:${config.port}` : "";
  const [resolvedEntry, setResolvedEntry] = useState<{ key: string; href: Href } | null>(null);
  const destination = resolvedEntry && resolvedEntry.key === pairingKey ? resolvedEntry.href : null;
  const enteredRef = useRef(false);

  useEffect(() => {
    if (connection.status !== "connected" || destination) return;
    void (async () => {
      let href: Href = "/(main)";
      try {
        const lastId = await loadLastSessionId();
        if (lastId) {
          if (useSessionStore.getState().sessions.length === 0) {
            await useSessionStore.getState().fetchSessions();
          }
          const exists = useSessionStore.getState().sessions.some((s) => s.id === lastId);
          if (exists) {
            href = { pathname: "/(main)/chat/[id]", params: { id: lastId } };
          } else {
            void saveLastSessionId(null);
          }
        }
      } catch {
        // Failing here only costs "resume where I stopped": it opens on the new chat
        // instead of leaving the app stuck on the pairing screen.
      }
      setResolvedEntry({ key: pairingKey, href });
    })();
  }, [connection.status, destination, pairingKey]);

  useEffect(() => {
    if (loadingConfig) return;

    if (connection.status === "connected") {
      // Entering the app. On the pairing screen the navigation is RETRIED on every
      // pass: a replace fired before the navigator was ready used to be silently lost
      // and the app stayed there showing "Connected".
      if (inConnection) {
        if (navReady && destination) router.replace(destination);
        return;
      }
      // Opened straight into the app (the new chat screen is "/"): resumes the last
      // chat once. Later on, "new chat" is a decision of the person — never a detour.
      if (atDraft && !enteredRef.current) {
        // The destination is read from the device: until it arrives, this effect waits
        // for it (the state is in the deps) instead of giving up.
        if (!destination) return;
        enteredRef.current = true;
        if (navReady && destination !== "/(main)") router.replace(destination);
        return;
      }
      enteredRef.current = true;
      return;
    }

    if (inConnection) return;
    // The pairing screen is the only way forward without a saved pairing, or when the
    // desktop refused the credentials. A network failure with a saved config does NOT
    // take the person out of the chat: the phone keeps retrying on its own (and the
    // messages typed meanwhile wait in the queue).
    if (!config || (connection.status === "disconnected" && isAuthRejection(connection.errorReason))) {
      enteredRef.current = false;
      if (navReady) router.replace("/connect");
    }
  }, [
    navReady,
    loadingConfig,
    connection.status,
    connection.errorReason,
    config,
    inConnection,
    atDraft,
    destination,
    router,
  ]);

  // Hides the splash only when there is a screen to show: on a cold start with a saved
  // pairing, opening the chat screen and only then jumping to the last chat looked like
  // a bug. The timer is the safety net — the splash never gets stuck.
  const decidingRoute =
    !loadingConfig &&
    ((!inConnection && !config) ||
      (connection.status === "connected" && atDraft && destination === null));
  useEffect(() => {
    if (!loadingConfig && !decidingRoute) {
      SplashScreen.hideAsync();
    }
  }, [loadingConfig, decidingRoute]);
  useEffect(() => {
    const timer = setTimeout(() => {
      SplashScreen.hideAsync();
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    // What was typed without a connection shows up in the queue before the socket opens.
    void useMessageQueueStore.getState().initialize();
    void useNotificationPrefsStore.getState().loadPrefs();
    // Loads the session cache so they show up immediately
    // (the real fetch over WS happens once it connects)
    void useSessionStore.getState().fetchSessions();
  }, []);

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
