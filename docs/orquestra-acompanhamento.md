# Orquestra: o orquestrador acompanha os workers

Hoje o orquestrador planeja, dispara os workers em paralelo, **espera todos terminarem**, escreve a síntese e só então revisa (2 rodadas, uma ação por rodada, lendo os primeiros 2.000 caracteres do texto de cada worker). Para quem olha, ele "fica em espera" e aparece só no fim.

Este plano faz o orquestrador **acompanhar**: revisar cada worker assim que ele termina, pedir ajustes enquanto os outros trabalham, verificar com evidência, respeitar dependências entre tarefas e, opcionalmente, isolar cada worker num worktree.

## Status

**Implementado (etapas 0 a 6).** Decisões em aberto resolvidas pelas propostas: o Rigoroso descobre as verificações pelo projeto, o teto de 4 workers simultâneos é fixo, e o celular só recebe o estado novo (mudar as opções no app fica para depois).

Onde ficou:
- `electron/lib/orquestra/execucao.ts` — coordenador (fila, dependências, teto de 4, revisão por worker, orçamento, integração). Testado com workers e revisores falsos.
- `electron/lib/orquestra/revisor.ts` — o orquestrador como agente com ferramentas (`ver_diff`, `rodar_verificacao`, `aceitar`, `pedir_ajuste`, `marcar_falha`, `criar_worker`).
- `electron/lib/orquestra/verificacoes.ts` — verificações do projeto (scripts do package.json e alvos do Makefile; só os que terminam).
- `electron/lib/orquestra/worktrees.ts` — worktree por worker, commit ao aceitar (sem os `.env` copiados), merge em ordem de dependência.
- `orchestrator.ts` — a fase 2 antiga e a revisão pós-síntese saíram; a síntese recebe estado, notas e o resultado do merge.
- Interface: diálogo da Orquestra (Comportamento), card de progresso (etapas, extras, atividade e ajustes), card do plano (dependências), Loop desabilitado com a Orquestra ligada, e a ajuda sem as combinações Loop + Orquestra.

Diferenças em relação ao texto abaixo:
- Um worker extra criado na revisão gasta um ajuste do orçamento global (é um turno de worker como outro qualquer). Teto de 12 tarefas por plano, contando as extras.
- A revisão de integração roda até 2 passadas; para quando uma passada não pede nada.
- O card do plano mostra as dependências; para tirar uma, desmarque a tarefa pré-requisito (a dependência some com ela).
- Revisor fora do ar (erro do modelo) não trava o plano: o worker é aceito como está, com a nota.

---

## Estado atual

| Peça | Onde | Como é hoje |
|---|---|---|
| Roteamento | `electron/lib/send-dispatch.ts` | Com a orquestra ligada, **liga o Loop sozinho** (`loop: input.options.loop !== false`). |
| Execução | `electron/lib/orchestrator.ts` → `runOrchestration` | Fase 1 planeja; fase 2 roda todos com `Promise.all`; fase 3 sintetiza; fase 4 revisa. |
| Orçamento de revisão | `orchestrator.ts` (`ORCHESTRATION_REVIEW_ROUNDS = 2`) | Com o Loop ligado, vira o `maxIterations` do diálogo do Loop — acoplamento invisível. |
| Decisão de revisão | `orchestrator.ts`, fase 4 | `generateText` que devolve **um** JSON por rodada: `done`, `message_worker`, `create_worker`, `create_test_worker`. |
| Card de progresso | `src/components/task-progress.tsx`, montado em `chat-view.tsx` | Lista `plan.tasks`; não mostra revisão nem workers criados depois. (O status por worker passou a chegar ao terminar cada um.) |
| Configuração | `orchestration-config-dialog.tsx`, `provider-store.ts`, `WorkerConfigSnapshot` (`packages/shared/src/companion.ts`) | Só o modelo do condutor e dos workers. Sincronizada com o main e o celular. |

---

## Configurações (diálogo do modo Orquestra)

Três opções. Ficam no `WorkerConfigSnapshot` (campo novo `orchestration`), que já vai ao main e ao celular; o "+" continua podendo abrir o diálogo antes de um envio.

| Opção | Valores | Padrão |
|---|---|---|
| **Comportamento** | *Só orquestrar* · *Acompanhar* · *Rigoroso* | *Acompanhar* |
| **Ajustes por worker** | 0–5 | 2 |
| **Isolar workers em worktrees** | liga/desliga (só em repositório git) | desligado |

- *Só orquestrar*: divide, roda e sintetiza — sem revisão (o comportamento de antes da fase 4 existir).
- *Acompanhar*: revisa cada worker ao terminar, pede ajustes, cria workers extras se faltar algo, revisão de integração no fim.
- *Rigoroso*: *Acompanhar* + só aceita o trabalho de um worker depois de rodar as verificações do projeto (typecheck/testes/lint).
- **Ajustes por worker** é o orçamento: o teto global é `ajustes × número de workers`. É a única opção que pesa no custo (cada ajuste é um turno de worker).

```ts
// packages/shared/src/companion.ts
export interface OrchestrationSettings {
  comportamento: 'orquestrar' | 'acompanhar' | 'rigoroso'
  ajustesPorWorker: number
  worktrees: boolean
}
export interface WorkerConfigSnapshot {
  // ...campos atuais
  orchestration?: OrchestrationSettings
}
```

Padrões sem botão: revisar ao terminar cada worker; várias ações por rodada; o card mostra tudo; dependências decididas pelo orquestrador no plano (o usuário aprova o plano); diff limitado sempre na revisão; teto automático de workers simultâneos (4, o resto em fila).

---

## Etapa 0 — Desacoplar o Loop

- `send-dispatch.ts`: a orquestra **não liga mais o Loop** (sai `loop: input.options.loop !== false`; `loop` vai como `undefined`).
- `orchestrator.ts`: o orçamento vem só de `orchestration.ajustesPorWorker`; somem `ORCHESTRATION_REVIEW_ROUNDS` e a leitura de `loopConfig`.
- Input do código (`code-input.tsx` e o `+`): com a Orquestra ligada, o toggle do Loop fica desabilitado, com a dica "Na orquestra, quem revisa é o orquestrador — ajuste em Configurações da orquestra". Ligar a Orquestra com o Loop ligado desliga o Loop (e vice-versa, avisando).
- O Loop continua igual para chats comuns.

## Etapa 1 — Revisar cada worker ao terminar

- A fase 2 deixa de ser `Promise.all` cego: cada worker, ao terminar, entra numa **fila de revisão** do orquestrador (serial — o orquestrador é um só, e decisões em paralelo se contradiriam).
- A revisão de um worker olha a tarefa dele, o resultado e o diff (etapa 2) e decide: *aceitar*, *pedir ajuste* (mensagem ao mesmo worker, que volta a rodar), *criar worker extra* ou *marcar falha*.
- Os outros workers seguem rodando enquanto isso. Um worker com ajuste volta para a fila quando terminar de novo.
- A síntese só começa quando todos estão aceitos (ou sem orçamento) — e vem precedida de uma **revisão de integração** (o conjunto atende ao pedido?), que pode gerar mais ajustes dentro do orçamento.
- *Só orquestrar* pula as revisões e vai direto à síntese.

## Etapa 2 — Revisão com evidência (orquestrador com ferramentas)

- A decisão deixa de ser um JSON único: o revisor vira um **agente com ferramentas**, num loop curto:
  - `ver_diff(worker)` — arquivos e patch do worker (limitado, ~20 kB, com os nomes de todos os arquivos);
  - `rodar_verificacao(comando)` — só no *Rigoroso*; comandos de leitura/verificação do projeto (typecheck, testes, lint), com a política de comandos da esteira;
  - `pedir_ajuste(worker, instrução)`, `criar_worker(título, prompt, depende_de?)`, `aceitar(worker)`, `marcar_falha(worker, motivo)`.
- O diff vem do snapshot de cada worker (mesmo mecanismo do diff por turno). Com workers na mesma pasta (sem worktrees), o diff mede a pasta toda — a revisão recebe o aviso de que pode haver mudanças de outros workers; com worktrees (etapa 6), é exato.
- O texto final do worker continua entrando, mas sem o corte de 2.000 caracteres (limite maior, com resumo se passar).

## Etapa 3 — Várias ações por rodada, orçamento por worker

- Uma rodada de revisão pode emitir várias ações (ajustar A e C, criar D).
- Cada worker tem seu contador de ajustes (`task.revisions`, que já existe); o teto global protege contra um plano de 10 workers com 5 ajustes cada.
- Sem orçamento para um worker, a revisão só pode aceitá-lo ou marcá-lo com falha — e a síntese diz o que ficou pendente.

## Etapa 4 — Card de progresso mostra o acompanhamento

- Estados por tarefa: *na fila* · *rodando* · *em revisão* · *ajuste N* · *aceito* · *falhou* (hoje: rodando/concluído/erro).
- Workers criados durante a revisão entram na lista (com o selo "extra").
- Linha de status do orquestrador: "Revisando: Motores de STT", "Pediu ajuste em TTS (2/2)", "Revisão de integração".
- Contador: aceitos/total e ajustes usados/teto.
- `OrchestrationTask.status` ganha os estados novos; o card (`task-progress.tsx`) e o `TaskItem` acompanham. O mobile mostra os mesmos estados.

## Etapa 5 — Dependências entre tarefas

- O plano ganha `dependeDe: string[]` por tarefa (ids de outras tarefas). O prompt do planejamento passa a pedir isso quando a ordem importa (ex.: "testes de integração" depois de "API" e "UI").
- Uma tarefa só sai da fila quando as dependências foram **aceitas** — e recebe o resumo delas no prompt.
- O card de aprovação do plano mostra as dependências (e o usuário pode removê-las antes de aprovar).
- Ciclos são recusados no planejamento (o mesmo `criaCiclo` da esteira).

## Etapa 6 — Worktree por worker (opcional)

- Com a opção ligada (e a pasta num repositório git), cada worker roda num worktree próprio, criado pelo núcleo de worktrees (`electron/lib/worktrees`), num branch `orquestra/<sessão>/<tarefa>`, a partir do branch atual.
- Dependentes partem do branch das dependências (como a esteira faz com uma dependência só; com várias, o orquestrador mescla antes).
- Ao aceitar todos, o orquestrador **junta os branches** no worktree do chat (ou no principal), em ordem de dependência. Conflito: tenta resolver com um worker de integração; não conseguindo, para e mostra os arquivos em conflito.
- Worktrees dos workers são removidos ao final (branches mantidos até o merge). Respeitam a preferência "Pasta dos worktrees".

---

## Custo

Os workers dominam o custo de uma orquestração; o orquestrador é pequeno perto deles.

| Etapa | Extra | O que controla |
|---|---|---|
| 1 | baixo — uma revisão curta por worker | — |
| 2 | médio — o diff entra no contexto (limitado); testes custam tempo, não tokens | *Rigoroso* liga as verificações |
| 3 | o maior — cada ajuste é um turno de worker | **Ajustes por worker** |
| 4 | zero | — |
| 5 | neutro ou menor — evita retrabalho por ordem errada | — |
| 6 | zero em tokens; ~16 s e disco por worker; risco de conflito no merge | **Isolar em worktrees** |

---

## Ordem de implementação

1. **Etapa 0** (desacoplar o Loop) + o tipo `OrchestrationSettings` e o diálogo.
2. **Etapas 1, 3 e 4** juntas — mudam a sensação de "espera" para "acompanha".
3. **Etapa 2** — o maior ganho de qualidade.
4. **Etapa 5**.
5. **Etapa 6**.

Cada passo com testes do orquestrador usando workers falsos (mock de `runWorkerTurn` e do modelo), como os da esteira.

## Decisões em aberto

1. *Rigoroso*: quais comandos de verificação? Proposta: o orquestrador descobre pelo projeto (scripts do `package.json`, `Makefile`), e o usuário pode fixar uma lista no diálogo depois.
2. Teto de workers simultâneos: fixo em 4 ou também configurável? Proposta: fixo agora, configurável se aparecer necessidade.
3. Mobile: mostrar e mudar as três opções no app desde a etapa 0, ou só mostrar?
