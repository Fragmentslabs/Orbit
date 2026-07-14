# Orbit Mobile — Plano de Implementação

## Resumo

Companion app do Orbit Desktop. Toda lógica de IA roda no Desktop; o Mobile é apenas um cliente conectado via rede local.

---

## Arquitetura

- **Monorepo** com npm workspaces: `desktop/` | `mobile/` | `shared/`
- Desktop já tem `companion-server.ts` (WebSocket + PIN auth + event forwarding)
- Mobile conecta via WebSocket ao Desktop — **zero lógica de IA no mobile**
- QR code com **token temporário** para pareamento seguro

### O que já existe e será reaproveitado

| Componente | Reaproveitamento |
|---|---|
| `shared/companion.ts` | ✅ Protocolo WebSocket completo |
| `shared/chat.ts`, `models.ts`, `memory.ts`, `skills.ts`, `mcp.ts`, `analytics.ts` | ✅ Todos os tipos |
| `electron/lib/companion-server.ts` | ✅ Servidor com auth, handlers, event forwarding |
| `companion-server.ts:302-357` | ✅ `forwardChatEvent`, `notifyCompanionAsk`, `notifyCompanionMessage` |

### O que precisa ser criado

1. **Mudança estrutural** — mover Desktop para `desktop/`, criar monorepo
2. **Novos arquivos em `shared/`** — schemas Zod, constantes, device types
3. **Servidor: geração de token** — extensão mínima ao `companion-server.ts`
4. **Mobile inteiro** — Expo + Expo Router + NativeWind + React Native Reusables

---

## Fases de Implementação

| Fase | Escopo | Status | Dias estimados |
|---|---|---|---|
| 0 | Setup monorepo | ✅ Concluído | 1-2 |
| 1 | Setup Expo + NativeWind + RNR | Pendente | 2-3 |
| 2 | Companion Client + Connection Store | Pendente | 3-4 |
| 3 | Telas de Pairing (QR scan) | Pendente | 2-3 |
| 4 | Dashboard + Session Store | Pendente | 3-4 |
| 5 | Chat/Conversa com streaming | Pendente | 4-5 |
| 6 | Notificações + Aprovações | Pendente | 2-3 |
| 7 | Modelos + Provedores + Preferências | Pendente | 2-3 |
| 8 | Polish + Deploy | Pendente | 2-3 |
| **Total** | | | **~20-28 dias** |

### MVP mínimo
Fases 0-6 parcial: monorepo, Expo funcionando, WebSocket client, QR pairing, lista de sessões, chat com streaming, aprovações. **~15-20 dias.**

---

## Fase 0 — Concluída ✅

### Estrutura final do monorepo

```
orbit/
├── package.json              # workspaces: shared, desktop, mobile
├── tsconfig.json             # project references (shared, desktop, mobile)
├── .eslintrc.base.cjs        # config ESLint compartilhada
├── .gitignore                # cobre todos os workspaces
├── shared/
│   ├── package.json          # @orbit/shared (exports de chat, companion, etc.)
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # barrel export
│       ├── analytics.ts
│       ├── chat.ts           # SessionInfo, ChatMessage, ChatEvent, etc.
│       ├── companion.ts      # Protocolo WebSocket (WsMessage, AuthRequest, etc.)
│       ├── mcp.ts            # McpConfig, McpServerStatus
│       ├── memory.ts         # Memory, searchMemories, etc.
│       ├── models.ts         # OrbitModel, ModelsSnapshot
│       └── skills.ts         # Skill, SkillProposal
├── desktop/
│   ├── package.json          # @orbit/desktop (depends on @orbit/shared)
│   ├── tsconfig.json         # paths: @orbit/shared → ../shared/src
│   ├── vite.config.ts        # aliases: @orbit/shared → shared/src
│   ├── .eslintrc.cjs
│   ├── electron/             # Main process (companion-server, chat-engine, etc.)
│   ├── src/                  # Renderer (React + Zustand)
│   ├── components/
│   ├── hooks/
│   └── lib/
└── mobile/
    ├── package.json          # @orbit/mobile (depends on @orbit/shared)
    ├── tsconfig.json
    ├── .eslintrc.cjs
    ├── .gitignore
    └── index.ts              # placeholder (substituído na Fase 1)
```

### Verificações

- [x] `npm run typecheck` — todos os 3 workspaces passam
- [x] `npm run lint` — mobile passa; desktop tem erros preexistentes (não introduzidos)
- [x] `npm install` — symlinks `@orbit/*` criados corretamente
- [x] Shared exports: chat, companion, models, memory, skills, mcp, analytics
- [x] Desktop importa `@orbit/shared` via tsconfig paths + vite alias

---

## Fase 1 — Setup Expo + NativeWind + RNR (próxima)

### Objetivo
App Expo funcional com NativeWind v4 e React Native Reusables, rodando em web e mobile.

### Entregáveis
- [ ] Expo SDK latest com Expo Router
- [ ] NativeWind v4 configurado (Tailwind CSS 4)
- [ ] React Native Reusables: Button, Card, Input, Badge, Avatar, Dialog
- [ ] Tema escuro (compatível com o design system do Desktop)
- [ ] `expo start --web` funcionando
- [ ] Estrutura de pastas: `app/`, `components/ui/`, `lib/`, `stores/`
