# Orbit Mobile — Companion App

Mobile app (Expo + React Native) that connects to Orbit Desktop over WebSocket/HTTP and controls it remotely: streaming chat, answering questions, notifications, model switching and settings.

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9 (monorepo with workspaces)
- **Expo CLI** — `npx expo --version`
- Orbit Desktop running on the same network (or over Tailscale)
- **Android (build nativo dev):** `APP_VARIANT=development` installs as **"Orbit (Dev)"** (`com.fragmentslabs.orbit.dev`), side by side with the production app. versionCode only goes up — without the variant, Android refuses to install over a build with a higher code (`INSTALL_FAILED_VERSION_DOWNGRADE`)
- **iOS (build nativo dev):** same variant → bundle id `com.fragmentslabs.orbit.dev`; it installs next to the production app instead of overwriting it (iOS has no downgrade lock — the install replaces the data)

## Setup

```bash
# At the monorepo root
npm install

# Run the mobile app
cd apps/mobile
npx expo start
```

Ways to run:
- **Expo Go** (limited) — `npx expo start` → scan QR code
- **Development build** — `npx expo start --dev-client`
- **Web** — `npx expo start --web`
- **Android** — `npx expo start --android`
- **iOS** — `npx expo start --ios`

## Architecture

```
src/
├── app/                       # Expo Router (file-based)
│   ├── _layout.tsx            # Root layout (logical routing)
│   ├── (connection)/          # Pairing flow
│   │   ├── _layout.tsx
│   │   └── index.tsx          # QR Code + IP manual + PIN
│   └── (app)/                 # Connected app
│       ├── _layout.tsx        # Bottom tabs
│       ├── index.tsx          # Chat streaming
│       ├── sessions.tsx       # Session list
│       └── settings.tsx       # Settings
├── components/
│   ├── chat/                  # MessageBubble, ChatInput, AskCard, StreamingIndicator
│   ├── connection/            # QRScanner, PinInput, ConnectionStatus
│   ├── layout/                # AppHeader, EmptyState, ResponsiveContainer
│   └── ui/                    # Base components (React Native Reusables)
├── hooks/
│   ├── useCompanion.ts        # Orchestrates WS + HTTP, auto-reconnect
│   └── useNotifications.ts    # Reactive local notifications
├── lib/
│   ├── notifications.ts       # expo-notifications wrapper
│   ├── theme.ts               # CSS variables, breakpoints, theme hooks
│   └── utils.ts               # cn() (clsx + twMerge)
├── stores/
│   ├── connection-store.ts    # WS state, config, persistence (SecureStore)
│   ├── session-store.ts       # Sessions, messages, streaming
│   ├── chat-store.ts          # Real-time messages, pending asks
│   └── settings-store.ts      # Model, catalog, preferences
└── global.css                 # Tailwind directives + theme CSS variables
```

## Technologies

| Layer | Technology |
|---|---|
| Framework | Expo SDK 57 |
| Router | Expo Router v4 (file-based, typed routes) |
| Styling | NativeWind v4 + Tailwind CSS 3.4 |
| UI Components | React Native Reusables (via CLI) |
| State | Zustand 5 |
| WebSocket | nativo (React Native) |
| HTTP | fetch API |
| Icons | lucide-react-native |
| Animations | react-native-reanimated 4.5 |

## Communication with Desktop

| Transport | Port | Use |
|---|---|---|
| **WebSocket** | 3847 | Streaming chat, real-time events, notifications |
| **HTTP REST** | 3848 | Preferences, model catalog, model selection |

The app connects to the desktop through a QR code or manual IP:PIN entry. The configuration is persisted in SecureStore for automatic reconnection.

## Scripts

```bash
npx expo start          # Dev server
npx expo start --web    # Web version
npx expo start --android
npx expo start --ios
npm run android:dev     # Android native build (Orbit (Dev)) — regenerates the project with the variant
npm run ios:dev         # iOS native build (Orbit (Dev), APP_VARIANT=development)
npm run typecheck       # Typecheck (tsc --noEmit)
npm run lint            # Lint via Expo
```

## Shared Packages

- `@orbit/shared` — Types and Zod schemas (companion.ts, chat.ts, models.ts)
- `@orbit/companion-client` — WebSocket + HTTP client for mobile↔desktop communication

## Platforms

- **Mobile**: iOS and Android (via Expo Go or dev client)
- **Web**: Responsive (mobile-first, breakpoints in theme.ts)
