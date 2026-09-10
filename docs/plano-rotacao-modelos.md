# Plano — Rotação de modelos (v0.1.3)

> Feature: lista ordenada de modelos; se um falhar com erro recuperável, o turno
> tenta o próximo da lista. Múltiplas rotações nomeadas; uma ativa por vez.

## 1. Conceito

Hoje cada turno usa **um** modelo (`SelectedModel` = `{ providerId, modelId }`,
`provider-store.ts:11`). Com rotação, o turno resolve uma **sequência**:

1. **override por chat** (escolha explícita no seletor, `session-model-prefs.ts`)
   → sequência de 1 (comportamento atual **intocado** — o usuário que pinar um
   modelo continua pinado);
2. senão, se a rotação estiver **ativa** (`enabled` + `activeId`) → a lista
   ordenada da rotação ativa;
3. senão, o default global (`provider-store.selectedModel`) — comportamento atual.

O modelo que respondeu fica registrado na mensagem via `ChatMessage.providerId`
(`chat.ts:273`, já gravado pelo engine em `chat-engine.ts:1483`) — o "quem
respondeu" sai de graça, inclusive para a compactação existente.

## 2. Taxonomia de falha (o que rotaciona)

Estender `ErrorKind` em `shared/chat.ts:263` (hoje: `moderation |
model-unavailable | unknown`) com `rate-limit` e `network`, e a classificação em
`electron/lib/errors.ts`:

| Falha | Padrões | Rotaciona? |
|---|---|---|
| Rate limit | `429`, `Too Many Requests`, `FreeUsageLimitError` | ✅ |
| Rede/indisponível | `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, HTTP 5xx, `fetch failed` | ✅ |
| Moderação | `content_filter` (OpenAI/Qwen) | ✅ — o comentário de `errors.ts:33-34` já recomenda trocar de modelo |
| Modelo indisponível | kind `model-unavailable` | ✅ |
| Auth | 401/403/API key inválida | ❌ — trocar não resolve |
| Abort manual | — | ❌ — respeita o usuário |
| Streaming quebrado no meio | (já emitiu conteúdo) | ❌ na v1 — reenvio custaria tokens duplicados; v1 mostra o erro + ação "repetir com o próximo" |

**Custo**: rotação só é tentada em falha **antes do primeiro token de saída**
(429/rede/moderação ocorrem antes de streamar). Teto: `min(3, len(rotação))`
tentativas (configurável).

## 3. Estado e persistência

```ts
// stores/model-rotation-store.ts (zustand + localStorage, padrão de
// session-model-prefs.ts:17-18,22-51)
interface ModelRotation { id: string; name: string; models: SelectedModel[] } // 1..4 slots
interface RotationState {
  rotations: ModelRotation[]
  sessionOverrides: Record<string, string> // chat (ou "draft") → rotação escolhida
  // ações: create(name), rename(id, name), updateModels(id, models),
  //        remove(id), selectRotation(sessionId, rotationId|null),
  //        adoptRotation(sessionId)
}
```

⚠️ Decisão pós-implementação (2026-09-09): **sem master toggle e sem rotação
"ativa"** — a rotação é apenas criada e escolhida POR CHAT no seletor de
modelo, como se fosse um modelo (escolher modelo limpa a rotação do chat e
vice-versa). Nada de `enabled`/`activeId`/`setActive`.

- `localStorage` key `orbit-model-rotations` (mesmo padrão de load/persist com try/catch de `session-model-prefs.ts:22-51`)
- **Sync pro main**: IPC novo `rotation:sync` espelhando `sessionModelsApi.sync` (`session-model-prefs.ts:83`) — o main guarda o estado em cache e o engine resolve a sequência no momento da chamada. Bônus: requests de companions que passam pelo main herdam a rotação automaticamente (a confirmar na etapa 3, depende do caminho do request mobile).
- ~~v1: desktop-only (mobile segue com modelo único; sem UI lá).~~ **Feito no
  mobile (2026-09-09)**: o celular é companion, então o engine do desktop
  continua sendo quem resolve/roda a sequência. O que foi adicionado é
  transporte + UI:
  - `GET /api/rotations` (snapshot no connect) e evento WS `rotation:change`
    (desktop → companions), ambos alimentados pelo mesmo `rotation:sync`;
  - `rotation:select` (escolha por chat) e `rotation:set` (CRUD, lista
    inteira) do celular → renderer do desktop, que é a fonte da verdade,
    persiste e devolve pelo broadcast — espelho de `models:select`/`prefs:set`;
  - `stores/model-rotation-store.ts` no mobile, telas
    `app/(main)/rotations/{index,[id]}` (lista + editor; reordenar por setas
    ↑/↓ em vez de drag) e o grupo "Rotações" no `ModelPickerModal`, com o
    gatilho do seletor mostrando o nome da rotação;
  - escolher um modelo no celular passa a limpar a rotação do chat nos dois
    lados (o engine resolve a rotação antes do modelo pinado).

## 4. Mecânica no engine

- Novo `electron/lib/model-rotation.ts`: `resolveRotation(sessionId)` → sequência
  (regra da seção 1) + `selectNext(seq, index)`.
- **Retry loop** num helper compartilhado usado no catch do `chat-engine.ts:1436`
  e no do `orchestrator.ts:379`: falha classificada como recuperável → status
  `"tentando fallback 2/3…"` (canal de `status` já existe, `chat-engine.ts:1450`)
  → próximo modelo da lista. Abort/erro final → comportamento atual.
- `rotationIndex` não persiste na mensagem na v1 (o `providerId` basta para o
  badge "via X").

## 5. Interface

### 5.1 Seletor de modelos do input (`model-picker.tsx`)

- **Grupo no topo, acima de "Recentes"**: heading `t("modelPicker.rotation")`
  com **um item por rotação salva**, desenhado como item de modelo (ícone no
  lugar do logo + nome + contagem "N modelos"). Só no modo não-controlado
  (recents já são ocultados no controlado, `:97-98`).
- **Clique no item → SELECIONA a rotação para o chat** (pina, como um modelo;
  destaque `bg-primary/10`; clicar de novo desfaz). Selecionar limpa o modelo
  pinado do chat (e vice-versa no `pick` de modelo). O trigger do seletor
  mostra o nome da rotação com o ícone `ListRestart`.
- **Footer**: 2º botão abaixo de "Configurar/Gerenciar provedores" — `Criar
  rotação` (ícone `ListRestart`), handoff sem `id` → abre o modal com foco em
  criar.

### 5.2 Tela Models (`models/models-view.tsx`)

- Botão na linha do rodapé (`:88-93`), ao lado do `AAKeyButton` (ghost, mesmo
  visual) → abre o **mesmo modal**.

### 5.3 Modal `components/models/rotation-dialog.tsx` (novo)

- **Lista única vertical** (sem painel lado a lado): rotações salvas (nome,
  Nº de slots) + botão "Nova rotação" (outline tracejado, largura total) +
  CRUD (renomear, excluir com `confirm`). Sem toggle e sem "ativa".
- O clique na linha (ou no lápis) **expande o editor como acordeon sob a
  rotação** (seta `ChevronDown` gira; borda `primary` quando expandido);
  apenas uma linha aberta por vez. Abre sem pré-seleção (foco em criar); a
  expansão inicializa só na abertura (ref `wasOpen`) para criar/alterar a
  lista não roubar a edição em curso.
- **Editor (acordeon)**: campo Nome (`Input`), slots 1..4 com alça
  de reordenação (drag manual por pointer events, padrão do board da esteira —
  sem lib nova), cada slot um `ModelPicker` **controlado**
  (`value`/`onValueChange`, `model-picker.tsx:72`) com `triggerClassName`
  (prop já existente — WIP do dialog da esteira) pra visual de linha; botão
  "+ Adicionar modelo" (máx. 4), contador N/4 e "Excluir rotação" no rodapé
  do editor.
- O `ModelPicker` dos slots usa `hideRotationOptions` — variante sem o grupo
  "Rotações" e sem o footer "Criar rotação" (evita o loop de abrir o gerenciador
  de rotação de dentro do editor de rotação).
- i18n: chaves novas em pt-BR e en (`apps/desktop/src/i18n/locales`).

## 6. Etapas

1. **Shared**: tipos `ModelRotation`/`RotationConfig`, `ErrorKind` novos
   (`rate-limit`, `network`) em `chat.ts` + i18n pt/en.
2. **Classificação**: padrões de 429/rede/5xx em `electron/lib/errors.ts`
   (cobrir provedores: OpenAI, Anthropic, OpenRouter, Qwen, Groq, orama,
   Ollama/LM Studio).
3. **Mecânica**: `model-rotation.ts` + retry loop em `chat-engine.ts:1436` e
   `orchestrator.ts:379` + status de fallback. (Confirmar aqui o caminho dos
   requests mobile pelo main.)
4. **Estado**: `model-rotation-store.ts` + IPC `rotation:sync` (renderer→main).
5. **UI**: grupo no picker + footer + modal + botão na ModelsView.
6. **Validação**: typecheck/build + teste manual — 429 simulado com custom
   provider apontando para `baseURL` local (responde 429 no 1º provider,
   sucesso no 2º); conferir badge/status e que escolha explícita por chat
   continua pinando.

## 7. Decisões registradas

- Nome: **"Rotação de modelos"** (escolhido; `rotation`/`rotations` no código).
- Múltiplas rotações nomeadas, **sem ativa global** — a rotação é escolhida por
  chat no seletor, como um modelo (grupo no topo antes de "Recentes");
  gerenciamento (criar/editar/excluir) no modal via footer "Criar rotação" e
  botão da aba Models. Dentro do editor, o seletor de modelo esconde tudo de
  rotação (`hideRotationOptions`).
- Override por chat **pina** (rotação não vale naquele chat) — preserva o
  comportamento atual; revisitar se surgir pedido de "fallback mesmo pinado".
- v1: sem rotação em streaming quebrado; máx. 4 slots; máx. 3 tentativas.
- Flags/bloqueios de atalho não afetam rotação (a rotação é a cadeia default).