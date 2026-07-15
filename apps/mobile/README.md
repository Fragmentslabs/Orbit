# Orbit Mobile — Companion App

App mobile (Expo + React Native) que se conecta ao Orbit Desktop via WebSocket/HTTP, permitindo controlar o desktop remotamente: chat streaming, aprovação de perguntas, notificações, troca de modelo e configurações.

## Pré-requisitos

- **Node.js** ≥ 18
- **npm** ≥ 9 (monorepo com workspaces)
- **Expo CLI** — `npx expo --version`
- Orbit Desktop rodando na mesma rede (ou via Tailscale)

## Setup

```bash
# Na raiz do monorepo
npm install

# Rodar o app mobile
cd apps/mobile
npx expo start
```

Opções de execução:
- **Expo Go** (limitado) — `npx expo start` → scan QR code
- **Development build** — `npx expo start --dev-client`
- **Web** — `npx expo start --web`
- **Android** — `npx expo start --android`
- **iOS** — `npx expo start --ios`

## Arquitetura

```
src/
├── app/                       # Expo Router (file-based)
│   ├── _layout.tsx            # Root layout (routing lógico)
│   ├── (connection)/          # Fluxo de pareamento
│   │   ├── _layout.tsx
│   │   └── index.tsx          # QR Code + IP manual + PIN
│   └── (app)/                 # App conectado
│       ├── _layout.tsx        # Bottom tabs
│       ├── index.tsx          # Chat streaming
│       ├── sessions.tsx       # Lista de sessões
│       └── settings.tsx       # Configurações
├── components/
│   ├── chat/                  # MessageBubble, ChatInput, AskCard, StreamingIndicator
│   ├── connection/            # QRScanner, PinInput, ConnectionStatus
│   ├── layout/                # AppHeader, EmptyState, ResponsiveContainer
│   └── ui/                    # Componentes base (React Native Reusables)
├── hooks/
│   ├── useCompanion.ts        # Orquestra WS + HTTP, auto-reconnect
│   └── useNotifications.ts    # Notificações locais reativas
├── lib/
│   ├── notifications.ts       # expo-notifications wrapper
│   ├── theme.ts               # CSS variables, breakpoints, hooks de tema
│   └── utils.ts               # cn() (clsx + twMerge)
├── stores/
│   ├── connection-store.ts    # Estado WS, config, persistência (SecureStore)
│   ├── session-store.ts       # Sessões, mensagens, streaming
│   ├── chat-store.ts          # Mensagens em tempo real, pending asks
│   └── settings-store.ts      # Modelo, catálogo, preferências
└── global.css                 # Tailwind directives + CSS variables do tema
```

## Tecnologias

| Camada | Tecnologia |
|---|---|
| Framework | Expo SDK 57 |
| Router | Expo Router v4 (file-based, typed routes) |
| Estilo | NativeWind v4 + Tailwind CSS 3.4 |
| UI Components | React Native Reusables (via CLI) |
| State | Zustand 5 |
| WebSocket | nativo (React Native) |
| HTTP | fetch API |
| Ícones | lucide-react-native |
| Animações | react-native-reanimated 4.5 |

## Comunicação com Desktop

| Transporte | Porta | Uso |
|---|---|---|
| **WebSocket** | 3847 | Chat streaming, eventos em tempo real, notificações |
| **HTTP REST** | 3848 | Preferências, catálogo de modelos, seleção de modelo |

O app se conecta ao desktop via QR Code ou entrada manual de IP:PIN. A configuração é persistida no SecureStore para reconexão automática.

## Scripts

```bash
npx expo start          # Dev server
npx expo start --web    # Versão web
npx expo start --android
npx expo start --ios
npm run typecheck       # Typecheck (tsc --noEmit)
npm run lint            # Lint via Expo
```

## Pacotes Compartilhados

- `@orbit/shared` — Tipos e schemas Zod (companion.ts, chat.ts, models.ts)
- `@orbit/companion-client` — Cliente WebSocket + HTTP para comunicação mobile↔desktop

## Plataformas

- **Mobile**: iOS e Android (via Expo Go ou dev client)
- **Web**: Responsivo (mobile-first, breakpoints em theme.ts)
