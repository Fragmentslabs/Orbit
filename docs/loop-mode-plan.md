# Modo Loop — Plano de Implementação

## Conceito

Quando ativo, o modo loop faz o agente **revisar o próprio resultado** e iterar até atingir o objetivo ou o limite configurado. Funciona tanto no `runChat` normal quanto no orquestrador.

```
runChat normal sem loop:  [agente responde] → fim
runChat com loop:         [agente responde] → revisa → [se ok] fim
                                                      → [se incompleto] agente continua → revisa → ... (max N)

orquestrador sem loop:  [planeja → workers → sintetiza] → fim
orquestrador com loop:  [planeja → workers → sintetiza] → revisa → [se ok] fim
                                                                   → [se incompleto] cria +workers → sintetiza → revisa → ... (max N)
```

---

## 1. Config Store (`loop-config-store.ts`)

Novo store zustand persistido em localStorage para as configurações do modo loop.

```typescript
interface LoopConfig {
  maxIterations: number       // padrão: 3
  maxTokensPerIter: number    // padrão: 4000 (limite para cada generateText de revisão)
  timeoutMinutes: number      // padrão: 10 (timeout global do loop)
  autoReview: boolean         // padrão: true (se false, pergunta ao usuário antes de cada iteração)
}

// Store com persistência em localStorage (chave "orbit-loop-config")
// Ações: updateConfig(), resetDefaults()
```

**Arquivos:** `apps/desktop/src/stores/loop-config-store.ts`

---

## 2. SendMessageOptions

Adicionar campo em `packages/shared/src/chat.ts`:

```typescript
export interface SendMessageOptions {
  // ... campos existentes ...
  /** Modo loop: agente revisa e itera até completar a tarefa */
  loop?: boolean
}
```

---

## 3. UI — Toggle + Config Modal

### 3.1 ModeToggle

Adicionar `const [loop, setLoop] = useState(false)` em:
- `chat-input.tsx` (linha ~54)
- `code-input.tsx` (linha ~67)

Adicionar `loop` no `buildOptions()` de ambos.

Renderizar `ModeToggle` com ícone `RefreshCw` (seta circular) e label "Loop" nos `PromptInputTools` de ambos os inputs.

### 3.2 Ícone indicador no footer

Quando loop ativo, mostrar `RefreshCw` ao lado dos ícones de subagents/orchestra.

### 3.3 Config Modal

Criar `apps/desktop/src/components/loop-config-dialog.tsx`:

- Input `maxIterations` (number, min 1, max 10)
- Input `maxTokensPerIter` (number, min 1000, max 20000)
- Input `timeoutMinutes` (number, min 1, max 60)
- Toggle `autoReview` (se false, pergunta ao usuário antes de cada nova iteração)
- Botão "Concluir"

Abrir pelo gear icon ao lado do toggle (mesmo padrão do subagents/orchestra).

---

## 4. Loop Engine (`loop-engine.ts`)

Novo arquivo `apps/desktop/electron/lib/loop-engine.ts`. Função principal:

```typescript
export async function runWithLoop(
  win: BrowserWindow,
  input: SendMessageInput,
  runner: (win: BrowserWindow, input: SendMessageInput) => Promise<void>,
  config: LoopConfig,
): Promise<void>
```

O `runner` é `runChat` ou `runOrchestration`. O loop engine:

1. Chama `runner(win, input)` — executa normalmente
2. Após o runner terminar, carrega as mensagens da sessão
3. Se `config.autoReview === true`:
   - Chama `generateText` com tool `review_completion` que analisa:
     - O pedido original do usuário
     - O histórico da conversa (resultados do agente/workers)
     - Retorna: `{ status: "done" | "needs_more", reason: string, followUpPrompt?: string }`
   - Se `done` → fim
   - Se `needs_more` e `iteration < maxIterations`:
     - Cria uma nova mensagem de usuário com `followUpPrompt`
     - Incrementa iteração
     - Volta ao passo 1 com o novo input
4. Se `config.autoReview === false`:
   - Usa a tool `question` para perguntar ao usuário se deve continuar
   - Mostra o `reason` da revisão
   - Se usuário aprova, continua; senão, termina

### Tool `review_completion`

```typescript
createReviewTool(input: SendMessageInput, sessionId: string): ToolSet
```

Input: histórico da conversa + plano original (se orquestração)
Output: `{ status: "done" | "needs_more", reason: string, followUpPrompt?: string }`

O prompt de revisão instrui o modelo a:
- Verificar se o objetivo do usuário foi atingido
- Identificar gaps, erros ou partes incompletas
- Sugerir o que falta fazer (followUpPrompt)
- Ser crítico: se houver qualquer dúvida, marcar como `needs_more`

---

## 5. Integração no Main Process

### `apps/desktop/electron/main.ts` (linha ~486)

```typescript
ipcMain.handle('chat:send', async (_event, input: SendMessageInput) => {
  // ... sanitização worker ...
  const config = loadLoopConfig() // da store persistida
  if (input.options.loop) {
    void runWithLoop(win, input, input.options.orchestrate ? runOrchestration : runChat, config)
  } else {
    if (input.options.orchestrate) void runOrchestration(win, input)
    else void runChat(win, input)
  }
})
```

A configuração do loop precisa ser acessível no main process. Opções:
- Passar via `SendMessageInput` (adicionar `loopConfig` ao input)
- Ou carregar do disco (salvar config em JSON no `dataDir()`)

Recomendo passar via `SendMessageInput` para manter o renderer como source of truth.

---

## 6. Prompt de Revisão

Adicionar em `apps/desktop/electron/lib/prompts.ts`:

```
Você é um revisor crítico. Sua função é analisar se o objetivo do usuário foi
completamente atingido com base no histórico da conversa e nos resultados obtidos.

Regras:
- Se o objetivo foi atingido de forma satisfatória → status: "done"
- Se há qualquer gap, erro, funcionalidade incompleta, teste faltando → status: "needs_more"
- Seja criterioso: é melhor revisar demais do que deixar passar
- Para needs_more, descreva exatamente o que falta no followUpPrompt
- O followUpPrompt será enviado como nova instrução para o agente continuar
```

---

## 7. Plano de Execução

### Fase 1: Setup
1. Criar `loop-config-store.ts` — store zustand + localStorage
2. Adicionar `loop?: boolean` no `SendMessageOptions`
3. Adicionar local state + `buildOptions()` em `chat-input.tsx` e `code-input.tsx`
4. Adicionar `ModeToggle` com ícone `RefreshCw` nos dois inputs

### Fase 2: Config Modal
5. Criar `loop-config-dialog.tsx` — modal de configuração
6. Integrar no dropdown "+" (como subagents/orchestra)

### Fase 3: Engine
7. Criar `loop-engine.ts` — `runWithLoop()`
8. Implementar `review_completion` tool
9. Integrar no `main.ts` handler

### Fase 4: Orquestração
10. Adaptar `runOrchestration` para o loop: após síntese, rodar revisão, criar workers de continuação se necessário
11. Workers de continuação herdam o plano original como contexto

### Fase 5: UX
12. Indicador visual de iteração no chat (ex: "Iteração 2/3")
13. Botão de cancelar loop (aborta iterações restantes)
14. Timeout global com fallback para resposta parcial

---

## Arquivos Afetados

| Arquivo | Mudança |
|---------|---------|
| `packages/shared/src/chat.ts` | +`loop?: boolean` em `SendMessageOptions` |
| `apps/desktop/src/stores/loop-config-store.ts` | **Novo** — config persistida |
| `apps/desktop/src/components/loop-config-dialog.tsx` | **Novo** — modal de configuração |
| `apps/desktop/src/components/chat-input.tsx` | +state `loop` + `ModeToggle` + config gear |
| `apps/desktop/src/components/code-input.tsx` | +state `loop` + `ModeToggle` + config gear |
| `apps/desktop/src/components/delegation-menu.tsx` | +item loop + gear |
| `apps/desktop/src/components/mode-toggle.tsx` | (sem mudança — reutilizável) |
| `apps/desktop/electron/lib/loop-engine.ts` | **Novo** — `runWithLoop()` + `review_completion` tool |
| `apps/desktop/electron/lib/prompts.ts` | +REVIEW_PROMPT |
| `apps/desktop/electron/main.ts` | roteamento `input.options.loop → runWithLoop()` |
| `packages/shared/src/chat.ts` | +`LoopConfig` type (se passar pelo input) |
