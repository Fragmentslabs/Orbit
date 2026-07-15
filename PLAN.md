Aqui está o plano completo para o **Orbit Mobile**:

---

# 📋 Plano: Orbit Mobile — Companion App

## 1. Objetivo

Criar o **Orbit Mobile**, um app companion (Expo + React Native) que se conecta ao Orbit Desktop via QR Code/PIN, permitindo controlar o app desktop remotamente: chat streaming, aprovação de perguntas, notificações, troca de modelos e gerenciamento de preferências. O app será responsivo e funcionará tanto em mobile quanto na web.

## 2. Tecnologias

| Camada | Tecnologia | Versão |
|---|---|---|
| **Framework** | Expo | SDK 57 (latest) |
| **Router** | Expo Router | v4 (file-based) |
| **Estilo** | NativeWind | v4.1 (estável) [1](https://www.nativewind.dev/docs/getting-started/installation) |
| **UI Components** | React Native Reusables | CLI latest [2](https://reactnativereusables.com/docs/cli) |
| **Tailwind CSS** | tailwindcss | ^3.4.17 (peer do NativeWind v4) |
| **State** | Zustand | (já no desktop, reaproveitar padrão) |
| **WebSocket** | nativo (React Native) | built-in |
| **HTTP** | fetch API | built-in |
| **Compartilhado** | @orbit/shared | monorepo workspace |
| **Ícones** | lucide-react-native | (compatível com desktop) |
| **Animações** | react-native-reanimated | ~4.5.0 |

## 3. Abordagem

### 3.1 Arquitetura Geral

```
┌─────────────────────────────────────────────┐
│              Orbit Mobile (Expo)             │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ WebSocket│  │ HTTP API │  │   UI Layer│ │
│  │ Client   │  │ Client   │  │  (Native  │ │
│  │ (stream) │  │ (prefs)  │  │  Wind +   │ │
│  │          │  │          │  │ Reusables)│ │
│  └────┬─────┘  └────┬─────┘  └───────────┘ │
│       │              │                       │
│  ┌────┴──────────────┴─────┐                │
│  │     Zustand Stores      │                │
│  │  (connection, session,  │                │
│  │   chat, settings)       │                │
│  └─────────────────────────┘                │
└──────────────────┬──────────────────────────┘
                   │ WebSocket (porta 3847)
                   │ HTTP REST (porta 3848 — novo)
┌──────────────────┴──────────────────────────┐
│           Orbit Desktop (Electron)           │
│  companion-server.ts (WS) + companion-http  │
└─────────────────────────────────────────────┘
```

### 3.2 Dual Transport

- **WebSocket (porta 3847)** — já implementado em `companion-server.ts`. Usado para:
  - Autenticação (PIN)
  - Chat streaming (chat:event com part-delta)
  - Notificações (notify:pending-ask, notify:new-message)
  - Requests/responses correlacionados via `WsMessage.id`
  
- **HTTP REST (porta 3848)** — novo endpoint no desktop. Usado para:
  - `GET/PUT /api/preferences` — preferências gerais
  - `GET/PUT /api/models/selected` — modelo ativo
  - `GET /api/catalog` — catálogo de modelos
  - Simples request/response, sem streaming

### 3.3 UI Components — Estratégia

1. **Componentes base do React Native Reusables** (via CLI `add`): Button, Input, Card, Dialog, Badge, Avatar, Tabs, Select, Textarea, Skeleton, Separator, Tooltip
2. **Componentes específicos do Orbit** (recriados com NativeWind + Reusables como base):
   - Chat components: `ChatMessage`, `MessageBubble`, `StreamingIndicator`
   - Ask/Permission: `AskCard`, `PermissionCard`
   - Connection: `QRCodeScanner`, `PinInput`, `ConnectionStatus`
   - Settings: `ModelPicker`, `ProviderSelector`
   - Layout: `AppLayout`, `ConnectionGuard`

### 3.4 Monorepo — Reutilização

- `@orbit/shared` já é dependency do mobile — tipos de `companion.ts`, `chat.ts`, `models.ts` são reutilizados diretamente
- Novo pacote `@orbit/companion-client` em `packages/companion-client/` — cliente WebSocket + HTTP que encapsula toda a comunicação mobile↔desktop

## 4. Regras

- **Não adicionar dependências desnecessárias** — usar APIs nativas do React Native quando possível (WebSocket, fetch)
- **NativeWind v4.1** (não v5 pre-release) para estabilidade
- **React Native Reusables** via CLI para componentes base — não copiar/colar do desktop
- **Separar UI da lógica** — stores Zustand puras, componentes presentacionais
- **Responsivo desde o início** — web deve funcionar, mas mobile-first
- **Não duplicar tipos** — sempre importar de `@orbit/shared`
- **Manter o padrão de nomes do desktop** — `camelCase` para funções, `PascalCase` para componentes
- **Expo Router file-based routing** — seguir convenções do template atual
- **TypeScript estrito** — `strict: true` já configurado

## 5. Definições

| Pergunta | Resposta |
|---|---|
| Versão do NativeWind? | **v4.1 (estável)** |
| Componentes UI? | **CLI do react-native-reusables para base + recriação dos específicos do Orbit** |
| Transporte para preferências? | **HTTP REST (porta 3848) para configurações, WebSocket (3847) para streaming/chat/notificações** |
| App standalone? | **Não — apenas companion, conecta ao desktop** |
| Plataformas? | **Mobile (iOS/Android) + Web (responsivo)** |

## 6. Fases

### Fase 1: Setup do NativeWind + React Native Reusables

> Configurar a base de estilos e componentes UI no projeto mobile existente.

- [ ] Instalar dependências do NativeWind v4.1:
  - `npm install nativewind react-native-reanimated react-native-safe-area-context`
  - `npm install --dev tailwindcss@^3.4.17 babel-preset-expo`
- [ ] Criar `apps/mobile/tailwind.config.js` com paths para `./src/**/*.{ts,tsx}`
  - Adicionar preset `nativewind/preset`
  - Configurar CSS variables do tema Orbit (dark/light) baseado em `apps/desktop/src/index.css`
- [ ] Criar/atualizar `apps/mobile/babel.config.js`:
  - Preset `babel-preset-expo` com `jsxImportSource: "nativewind"`
  - Preset `nativewind/babel`
- [ ] Criar `apps/mobile/metro.config.js`:
  - `withNativeWind(config, { input: './src/global.css', inlineRem: 16 })`
  - Configurar aliases `@/*` → `./src/*`
- [ ] Atualizar `apps/mobile/src/global.css`:
  - Substituir CSS atual por diretivas Tailwind (`@tailwind base/components/utilities`)
  - Adicionar CSS variables do tema (extrair de `apps/desktop/src/index.css`)
- [ ] Criar `apps/mobile/nativewind-env.d.ts` com `/// <reference types="nativewind/types" />`
- [ ] Atualizar `apps/mobile/app.json`:
  - Adicionar `"web": { "bundler": "metro" }`
  - Verificar `userInterfaceStyle: "automatic"`
- [ ] Instalar dependências do React Native Reusables:
  - `npx expo install tailwindcss-animate class-variance-authority clsx tailwind-merge @rn-primitives/portal`
- [ ] Criar `apps/mobile/lib/utils.ts`:
  - Função `cn()` (clsx + twMerge)
- [ ] Criar `apps/mobile/components.json` (configuração para CLI do reusables)
- [ ] Adicionar `PortalHost` no `_layout.tsx`
- [ ] Limpar template: remover componentes placeholder (`ThemedText`, `ThemedView`, `WebBadge`, etc.)
- [ ] Adicionar componentes base via CLI:
  - `npx @react-native-reusables/cli@latest add button input card badge avatar tabs separator skeleton dialog select textarea tooltip scroll-area`

**Arquivos afetados:**
```
apps/mobile/package.json              (deps instaladas)
apps/mobile/tailwind.config.js        (CRIADO)
apps/mobile/babel.config.js           (CRIADO)
apps/mobile/metro.config.js           (CRIADO)
apps/mobile/src/global.css            (REESCRITO)
apps/mobile/nativewind-env.d.ts       (CRIADO)
apps/mobile/app.json                  (MODIFICADO)
apps/mobile/lib/utils.ts              (CRIADO)
apps/mobile/components.json           (CRIADO)
apps/mobile/src/app/_layout.tsx       (MODIFICADO — PortalHost + import CSS)
apps/mobile/src/components/ui/        (componentes adicionados via CLI)
apps/mobile/src/app/index.tsx         (LIMPO —removido template)
```

---

### Fase 2: Pacote Compartilhado — @orbit/companion-client ✅

> Criar o cliente de comunicação que encapsula WebSocket + HTTP, reutilizando tipos de `@orbit/shared`.

- [x] Criar `packages/companion-client/package.json`:
  - name: `@orbit/companion-client`
  - dependencies: `@orbit/shared`
- [x] Criar `packages/companion-client/src/index.ts` — exportar tudo
- [x] Criar `packages/companion-client/src/types.ts`:
  - `ConnectionConfig { host: string, port: number, pin: string }`
  - `ConnectionState { status: 'disconnected'|'connecting'|'authenticating'|'connected', error?: string }`
- [x] Criar `packages/companion-client/src/websocket-client.ts`:
  - Classe `CompanionWebSocket`:
    - `connect(config: ConnectionConfig)` — abre WS para `ws://{host}:{port}`
    - `send(payload: CompanionRequest): Promise<ApiResponse>` — envia com correlação de ID
    - `subscribe(eventType, handler)` — listener para eventos do server
    - `disconnect()` — fecha conexão
    - Reconexão automática com backoff exponencial
    - Heartbeat/ping a cada 30s
    - Queue de requests durante desconexão
- [x] Criar `packages/companion-client/src/http-client.ts`:
  - Classe `CompanionHttp`:
    - `getPreferences()` → `GET http://{host}:3848/api/preferences`
    - `updatePreferences(patch)` → `PATCH http://{host}:3848/api/preferences`
    - `getSelectedModel()` → `GET http://{host}:3848/api/models/selected`
    - `selectModel(providerId, modelId)` → `PUT http://{host}:3848/api/models/selected`
    - Headers: `Authorization: Bearer {pin}`
- [x] Criar `packages/companion-client/src/qr-code.ts`:
  - Função `generateConnectionPayload(host, port, pin)` → string para QR code
  - Função `parseConnectionPayload(data)` → `ConnectionConfig | null`
- [x] Atualizar `packages/companion-client/tsconfig.json`
- [x] Adicionar workspace no `package.json` raiz (já coberto por `packages/*`)

**Arquivos afetados:**
```
packages/companion-client/package.json           (CRIADO)
packages/companion-client/tsconfig.json          (CRIADO)
packages/companion-client/src/index.ts           (CRIADO)
packages/companion-client/src/types.ts           (CRIADO)
packages/companion-client/src/websocket-client.ts (CRIADO)
packages/companion-client/src/http-client.ts     (CRIADO)
packages/companion-client/src/qr-code.ts         (CRIADO)
apps/mobile/package.json                         (adicionar dep @orbit/companion-client)
```

---

### Fase 3: Endpoints HTTP no Desktop ✅

> Adicionar servidor HTTP REST no desktop para operações de preferências (além do WebSocket).

- [x] Criar `apps/desktop/electron/lib/companion-http.ts`:
  - Servidor HTTP na porta 3848 (0.0.0.0)
  - Auth via header `Authorization: Bearer {pin}` (reutilizar `validatePin`)
  - Endpoints:
    - `GET /api/preferences` → retorna preferências (brain, permissions, reasoning, model-mode)
    - `PATCH /api/preferences` → atualiza preferências
    - `GET /api/models/selected` → modelo ativo + worker
    - `PUT /api/models/selected` → seleciona modelo (broadcast para renderer)
    - `GET /api/catalog` → catálogo completo
    - `GET /api/status` → status geral (online, sessões, uptime)
  - CORS habilitado para desenvolvimento local
- [x] Integrar `companion-http.ts` no `companion-server.ts`:
  - Iniciar HTTP server junto com o WS server em `startCompanionServer()`
  - Parar em `stopCompanionServer()`
- [x] Atualizar `getCompanionStatus()` para incluir porta HTTP

**Arquivos afetados:**
```
apps/desktop/electron/lib/companion-http.ts      (CRIADO)
apps/desktop/electron/lib/companion-server.ts    (MODIFICADO — integrar HTTP server)
```

---

### Fase 4: Stores Zustand no Mobile ✅

> Criar os stores de estado do mobile, espelhando a arquitetura do desktop mas simplificada para companion.

- [x] Criar `apps/mobile/src/stores/connection-store.ts`:
  - Estado: `ConnectionState`, `config: ConnectionConfig | null`, `serverVersion: string`
  - Ações: `connect()`, `disconnect()`, `setPin()`, `saveConfig()`, `loadConfig()`
  - Persistência: `expo-secure-store` para PIN e config (ou AsyncStorage)
- [x] Criar `apps/mobile/src/stores/session-store.ts`:
  - Estado: `sessions: SessionInfo[]`, `activeSessionId: string | null`, `messages: Record<string, ChatMessage[]>`, `status: Record<string, ChatStatus>`
  - Ações: `fetchSessions()`, `selectSession()`, `fetchMessages()`, `sendMessage()`, `abortChat()`
  - Conecta via `CompanionWebSocket` para requests `sessions:list`, `messages:get`, `messages:send`, `chat:abort`
- [x] Criar `apps/mobile/src/stores/chat-store.ts`:
  - Estado: `streamingMessages`, `pendingAsks: PendingAskUI[]`
  - Ações: `applyChatEvent()`, `replyToAsk()`
  - Conecta via WebSocket events: `chat:event`, `notify:pending-ask`, `notify:new-message`
- [x] Criar `apps/mobile/src/stores/settings-store.ts`:
  - Estado: `selectedModel`, `catalog`, `preferences`
  - Ações: `fetchCatalog()`, `selectModel()`, `fetchPreferences()`, `updatePreferences()`
  - Conecta via HTTP REST (companion-http) para operações simples
- [x] Criar `apps/mobile/src/hooks/useCompanion.ts`:
  - Hook que orquestra conexão WS + HTTP
  - Inicializa stores, configura event listeners
  - Reconexão automática

**Arquivos afetados:**
```
apps/mobile/src/stores/connection-store.ts    (CRIADO)
apps/mobile/src/stores/session-store.ts       (CRIADO)
apps/mobile/src/stores/chat-store.ts          (CRIADO)
apps/mobile/src/stores/settings-store.ts      (CRIADO)
apps/mobile/src/hooks/useCompanion.ts         (CRIADO)
apps/mobile/src/app/_layout.tsx               (MODIFICADO — adicionar useCompanion)
```

---

### Fase 5: Tela de Conexão (QR Code + PIN) ✅

> Tela inicial do app — pareamento com o desktop.

- [x] Criar `apps/mobile/src/components/connection/QRScanner.tsx`:
  - Câmera para escanear QR code do desktop
  - Usa `expo-camera` (CameraView + onBarcodeScanned)
  - Decodifica payload → `ConnectionConfig`
  - Overlay de scan com moldura visual
- [x] Criar `apps/mobile/src/components/connection/PinInput.tsx`:
  - Input de 6 dígitos para PIN manual (estilo OTP)
  - Auto-submit quando completo
  - Suporte a paste de PIN completo
  - Backspace navega entre campos
- [x] Criar `apps/mobile/src/components/connection/ConnectionStatus.tsx`:
  - Badge indicando status: desconectado/conectando/conectado
  - Indicador de latência e nome do device
  - Animação de spin durante conexão
- [x] Criar `apps/mobile/src/app/(connection)/index.tsx`:
  - Tela de conexão com 3 modos:
    1. Menu principal com opções (QR Code + IP manual)
    2. Scanner de QR Code (tela dedicada)
    3. Entrada manual de IP:Porta → PIN entry
  - Tela de PIN com feedback de status
  - Auto-reconnect loading quando config salva existe
  - Dica sobre Tailscale
- [x] Criar `apps/mobile/src/app/(connection)/_layout.tsx`:
  - Stack layout sem header para fluxo de conexão
- [x] Criar `apps/mobile/src/app/(app)/_layout.tsx` + `index.tsx`:
  - Placeholder para app conectado (Fase 6 expande)
- [x] Atualizar `apps/mobile/src/app/_layout.tsx`:
  - Redirecionar para `/(connection)` se não conectado
  - Redirecionar para `/(app)` se conectado
  - Splash screen ocultado após routing

**Arquivos afetados:**
```
apps/mobile/src/components/connection/QRScanner.tsx     (CRIADO)
apps/mobile/src/components/connection/PinInput.tsx      (CRIADO)
apps/mobile/src/components/connection/ConnectionStatus.tsx (CRIADO)
apps/mobile/src/app/(connection)/index.tsx              (CRIADO)
apps/mobile/src/app/(connection)/_layout.tsx            (CRIADO)
apps/mobile/src/app/(app)/index.tsx                     (CRIADO — placeholder)
apps/mobile/src/app/(app)/_layout.tsx                   (CRIADO — placeholder)
apps/mobile/src/app/_layout.tsx                         (MODIFICADO — routing lógico)
apps/mobile/src/app/index.tsx                           (REMOVIDO — substituído por groups)
```

---

### Fase 6: Layout Principal + Navegação

> Estrutura de navegação do app conectado.

- [ ] Criar `apps/mobile/src/app/(app)/_layout.tsx`:
  - Bottom tabs: Chat, Sessões, Configurações
  - Header com `ConnectionStatus` + nome do desktop
- [ ] Criar `apps/mobile/src/app/(app)/chat.tsx`:
  - Tela principal de conversa
  - Lista de mensagens com scroll
  - Input de mensagem na parte inferior
  - Indicador de streaming
  - Botão de abortar
- [ ] Criar `apps/mobile/src/app/(app)/sessions.tsx`:
  - Lista de sessões do desktop
  - Pull-to-refresh
  - Indicador de sessão ativa/streaming
  - Swipe para deletar
- [ ] Criar `apps/mobile/src/app/(app)/settings.tsx`:
  - Configurações gerais:
    - Seleção de modelo/provider
    - Preferências (permission mode, reasoning, etc.)
    - Info de conexão
    - Botão desconectar
- [ ] Criar `apps/mobile/src/components/layout/AppHeader.tsx`:
  - Header customizado com status de conexão
  - Nome do desktop conectado
  - Botão de configurações
- [ ] Criar `apps/mobile/src/components/layout/EmptyState.tsx`:
  - Componente reutilizável para estados vazios

**Arquivos afetados:**
```
apps/mobile/src/app/(app)/_layout.tsx          (CRIADO)
apps/mobile/src/app/(app)/chat.tsx             (CRIADO)
apps/mobile/src/app/(app)/sessions.tsx         (CRIADO)
apps/mobile/src/app/(app)/settings.tsx         (CRIADO)
apps/mobile/src/components/layout/AppHeader.tsx (CRIADO)
apps/mobile/src/components/layout/EmptyState.tsx (CRIADO)
```

---

### Fase 7: Componentes de Chat

> Componentes específicos do chat — recriados do desktop com NativeWind + Reusables.

- [ ] Criar `apps/mobile/src/components/chat/MessageBubble.tsx`:
  - Bolha de mensagem (user vs assistant)
  - Suporte a parts: text, reasoning, tool, image
  - Streaming: cursor pulsante no final do texto
- [ ] Criar `apps/mobile/src/components/chat/StreamingIndicator.tsx`:
  - Indicador visual de "digitando..." / streaming
  - Animated dots ou shimmer
- [ ] Criar `apps/mobile/src/components/chat/ChatInput.tsx`:
  - TextInput expansível (auto-grow)
  - Botão de enviar (só aparece com texto)
  - Botão de abortar (quando streamando)
  - Keyboard avoiding view
- [ ] Criar `apps/mobile/src/components/chat/MessageList.tsx`:
  - FlatList/FlashList de mensagens
  - Auto-scroll para baixo em nova mensagem
  - Pull-to-refresh para carregar histórico
  - Separator entre mensagens
- [ ] Criar `apps/mobile/src/components/chat/AskCard.tsx`:
  - Card para perguntas/permissões pendentes
  - Exibe título, descrição, opções
  - Botões de aprovar/rejeitar/ responder
  - Notificação push quando chega

**Arquivos afetados:**
```
apps/mobile/src/components/chat/MessageBubble.tsx       (CRIADO)
apps/mobile/src/components/chat/StreamingIndicator.tsx  (CRIADO)
apps/mobile/src/components/chat/ChatInput.tsx           (CRIADO)
apps/mobile/src/components/chat/MessageList.tsx         (CRIADO)
apps/mobile/src/components/chat/AskCard.tsx             (CRIADO)
```

---

### Fase 8: Notificações + Push

> Notificações locais quando o agente termina ou há pergunta pendente.

- [ ] Instalar `expo-notifications`
- [ ] Criar `apps/mobile/src/lib/notifications.ts`:
  - `registerForPushNotifications()` — permissão + token
  - `scheduleLocalNotification(title, body, data)` — notificação local
  - Listener para notificações recebidas (app aberto)
- [ ] Integrar no `chat-store.ts`:
  - Quando `notify:pending-ask` → notificação local "Pergunta pendente"
  - Quando `notify:new-message` → notificação local "Nova mensagem de {sessionTitle}"
  - Quando `chat:event` status=error → notificação de erro
- [ ] Criar `apps/mobile/src/hooks/useNotifications.ts`:
  - Hook que configura listeners e integra com stores

**Arquivos afetados:**
```
apps/mobile/src/lib/notifications.ts           (CRIADO)
apps/mobile/src/hooks/useNotifications.ts      (CRIADO)
apps/mobile/src/stores/chat-store.ts           (MODIFICADO — integrar notificações)
apps/mobile/package.json                       (adicionar expo-notifications)
```

---

### Fase 9: Tema + Responsividade

> Garantir dark mode, tema consistente e responsividade web.

- [ ] Criar `apps/mobile/src/lib/theme.ts`:
  - Definir CSS variables do tema (light/dark) baseado no desktop
  - Cores: primary, secondary, muted, destructive, etc.
  - Integrar com NativeWind `dark:` classes
- [ ] Atualizar `apps/mobile/tailwind.config.js`:
  - Adicionar `darkMode: 'class'`
  - Estender theme com CSS variables do Orbit
- [ ] Criar `apps/mobile/src/components/layout/ResponsiveContainer.tsx`:
  - Container que adapta layout para mobile (full-width) vs web (max-width centrado)
  - Breakpoints: mobile (<768px), tablet (768-1024px), desktop (>1024px)
- [ ] Testar e ajustar todas as telas para web:
  - `apps/mobile/src/app/(app)/chat.tsx` — layout adaptativo
  - `apps/mobile/src/app/(app)/sessions.tsx` — grid vs list
  - `apps/mobile/src/app/(app)/settings.tsx` — sidebar vs full-width

**Arquivos afetados:**
```
apps/mobile/src/lib/theme.ts                          (CRIADO)
apps/mobile/tailwind.config.js                        (MODIFICADO)
apps/mobile/src/global.css                            (MODIFICADO — CSS vars)
apps/mobile/src/components/layout/ResponsiveContainer.tsx (CRIADO)
apps/mobile/src/app/(app)/chat.tsx                    (MODIFICADO — responsivo)
apps/mobile/src/app/(app)/sessions.tsx                (MODIFICADO — responsivo)
apps/mobile/src/app/(app)/settings.tsx                (MODIFICADO — responsivo)
```

---

### Fase 10: Polish + Integração Final

> Testes, ajustes e preparação para deploy.

- [ ] Testar conexão WS completa: connect → auth → sessions → chat → streaming → ask → reply
- [ ] Testar HTTP REST: preferences, models, catalog
- [ ] Testar notificações em background
- [ ] Testar reconexão automática (perda de Wi-Fi, sleep do celular)
- [ ] Testar responsividade web (Chrome DevTools)
- [ ] Adicionar `expo-router` typed routes (já habilitado no app.json)
- [ ] Rodar `npx @react-native-reusables/cli@latest doctor` para verificar setup
- [ ] Rodar `npm run typecheck` no monorepo
- [ ] Atualizar `apps/mobile/README.md` com instruções de setup
- [ ] Adicionar scripts no `package.json` raiz se necessário

**Arquivos afetados:**
```
apps/mobile/README.md      (MODIFICADO)
package.json               (possíveis scripts adicionais)
```

---

## 7. Arquivos Afetados (Consolidado)

### Criados (novos)
```
# Config
apps/mobile/tailwind.config.js
apps/mobile/babel.config.js
apps/mobile/metro.config.js
apps/mobile/nativewind-env.d.ts
apps/mobile/components.json
apps/mobile/lib/utils.ts

# Pacote compartilhado
packages/companion-client/package.json
packages/companion-client/tsconfig.json
packages/companion-client/src/index.ts
packages/companion-client/src/types.ts
packages/companion-client/src/websocket-client.ts
packages/companion-client/src/http-client.ts
packages/companion-client/src/qr-code.ts

# Desktop — HTTP server
apps/desktop/electron/lib/companion-http.ts

# Stores
apps/mobile/src/stores/connection-store.ts
apps/mobile/src/stores/session-store.ts
apps/mobile/src/stores/chat-store.ts
apps/mobile/src/stores/settings-store.ts

# Hooks
apps/mobile/src/hooks/useCompanion.ts
apps/mobile/src/hooks/useNotifications.ts

# Lib
apps/mobile/src/lib/notifications.ts
apps/mobile/src/lib/theme.ts

# Rotas
apps/mobile/src/app/(connection)/_layout.tsx
apps/mobile/src/app/(connection)/index.tsx
apps/mobile/src/app/(app)/_layout.tsx
apps/mobile/src/app/(app)/index.tsx            (placeholder — expandido na Fase 6)
apps/mobile/src/app/(app)/chat.tsx
apps/mobile/src/app/(app)/sessions.tsx
apps/mobile/src/app/(app)/settings.tsx

# Componentes
apps/mobile/src/components/connection/QRScanner.tsx
apps/mobile/src/components/connection/PinInput.tsx
apps/mobile/src/components/connection/ConnectionStatus.tsx
apps/mobile/src/components/layout/AppHeader.tsx
apps/mobile/src/components/layout/EmptyState.tsx
apps/mobile/src/components/layout/ResponsiveContainer.tsx
apps/mobile/src/components/chat/MessageBubble.tsx
apps/mobile/src/components/chat/StreamingIndicator.tsx
apps/mobile/src/components/chat/ChatInput.tsx
apps/mobile/src/components/chat/MessageList.tsx
apps/mobile/src/components/chat/AskCard.tsx
```

### Modificados
```
apps/mobile/package.json              (deps: nativewind, reusables, etc.)
apps/mobile/app.json                  (web bundler: metro)
apps/mobile/src/global.css            (Tailwind directives + CSS vars)
apps/mobile/src/app/_layout.tsx       (routing lógico + PortalHost)
apps/mobile/src/app/index.tsx         (removido template placeholder)
apps/mobile/tsconfig.json             (possíveis ajustes)
apps/desktop/electron/lib/companion-server.ts (integrar HTTP server)
package.json                          (possíveis scripts)
```

---

## Fluxo de Dados — Resumo

```
1. APP INICIA → Tela de Conexão
2. USER ESCANEIA QR / INSERE PIN → WS connect + auth
3. AUTH OK → Redireciona para (app) → carrega sessões via WS
4. USER ABRE SESSÃO → fetch messages via WS → exibe chat
5. USER ENVIA MENSAGEM → WS messages:send → desktop processa
6. STREAMING → WS chat:event (part-delta) → UI atualiza em tempo real
7. PERGUNTA PENDENTE → WS notify:pending-ask → notificação + AskCard
8. USER RESponde → WS ask:reply → desktop continua
9. CONFIG → HTTP GET/PATCH preferences → desktop atualiza
10. MODELO → HTTP PUT models:select → desktop broadcasta para renderer
```

---

O que acha deste plano? Alguma fase que gostaria de ajustar, reordenar ou que eu possa ter esquecido? Posso salvar como `PLAN.md` quando você aprovar.