# Modo Esteira — Documento de Implementação (Fase 1)

## Conceito

O modo esteira transforma o Orbit de agente reativo em **executor de pipeline de tasks**. O usuário cria um **projeto** (board), define uma **esteira** (sequência fixa de fases), adiciona tasks e dispara a execução — manual ou automática. Cada fase executa com o próprio prompt, modelo, nível de thinking e política de permissões, **sem chats e sem agente gestor**.

```
projeto (board)
 └── esteira (pipeline de fases lineares)
      ├── fases: [Desenvolvimento] → [Validação] → [Pronto]  (fixas, sem pular/retornar)
      ├── branch/worktree dedicada
      └── fila de tasks
           task: pendente → em execução (fase N) → ... → concluída
                                  ↕
                             pausada (manual ou erro)
```

---

## 1. Decisões de design (consolidadas)

| # | Decisão |
|---|---------|
| D1 | **Projetos explícitos** — a pasta da sidebar não define escopo (um chat pode ter várias pastas, e pastas podem ser só referência). Projeto = board com pastas selecionadas, como no seletor de pastas do chat. |
| D2 | **Pipeline linear obrigatório** — toda task passa por **todas** as fases, na ordem, sem pular e sem retornar. (Exceção única: início manual por drag — ver D8.) |
| D3 | **Fases com prompt próprio** — cada fase tem prompt de instrução, modelo, nível de thinking, tools permitidas e política de comandos. **Sem agente gestor** — o roteamento é a própria sequência de fases. |
| D4 | **Templates de fase** — fases padrão do sistema com prompts trabalhados. Ao criar a esteira, as fases são **copiadas** do template; editar a esteira não altera o template mestre. |
| D5 | **Autonomia total** — nenhuma permissão é pedida (nenhuma tool nem comando). O guarda-corpo é a política de comandos em 3 camadas (D6), mais conservadora que o modo interativo por ser execução não supervisionada. |
| D6 | **Política de comandos em 3 camadas** — bloqueados / controlados / livres (qualquer comando fora das listas é livre). |
| D7 | **Falha = retry + pausa** — o agente tenta refazer N vezes; se persistir, a task fica **pausada** com aviso de erro no card e no modal. |
| D8 | **Início manual**: botão "Iniciar" (começa da fase 1) **ou drag do card para uma fase** (a task começa daquela fase em diante). Pausar a task a congela na fase atual; retomar continua dela. |
| D9 | **Modo automático**: fila FIFO, **uma task por vez** — termina uma, começa a próxima. O usuário pode iniciar tasks adicionais manualmente, executadas **em paralelo**. |
| D10 | **Commits**: seguem o padrão de commits do usuário (consultado nas memórias); fallback: Conventional Commits. **Sem** convenção de branch com id de task/esteira. |
| D11 | **Branch/worktree por esteira** — selecionar uma existente ou criar na criação da esteira. |
| D12 | **Sem chats** — esteira não cria sessões de chat e não se comunica com chats. O histórico da execução vive nas anotações por fase da task. |
| D13 | **Relatórios** — cards no footer do board, altura baixa, sem roubar espaço. |
| D14 | **Modal da task** — título editável no topo; coluna direita (datas, tempo, tokens, custo, dependências); coluna esquerda maior com tabs de fases em markdown. |
| D15 | **Dependências entre tasks** — task dependente só inicia após a dependência concluir; a fila automática se reorganiza. |

---

## 2. Modelo de dados

### 2.1 Projeto

```typescript
interface Projeto {
  id: string
  nome: string
  pastas: string[]            // pastas de trabalho (selecionadas como no chat)
  criadoEm: string            // ISO
  esteiras: string[]          // ids de esteiras
}
```

### 2.2 Esteira

```typescript
interface Esteira {
  id: string
  projetoId: string
  nome: string
  fases: FaseConfig[]         // cópia dos templates, editável
  branch?: string             // branch selecionada/criada (null = branch atual do repo)
  worktree?: string           // caminho do worktree, se usado
  modoOperacao: 'manual' | 'automatico'   // padrão da esteira; trocável a qualquer momento
  retryCount: number          // retries por fase antes de pausar (padrão: 3)
  pushAoFinal: boolean        // se a fase final faz push (padrão: false)
  politicaComandos: PoliticaComandos
  templateId?: string         // template de fases usado na criação
  criadoEm: string
}
```

### 2.3 Fase

```typescript
interface FaseConfig {
  id: string
  nome: string                // ex.: "Desenvolvimento"
  descricao: string
  prompt: string              // instruções da fase (quando/por que avança, o que anotar, etc.)
  modelo: string              // herda o modelo padrão da esteira; editável por fase
  thinkingNivel: number       // 0 = desligado
  tools: ToolPermitida[]      // ['edit', 'shell', 'browser', 'terminal', ...] — restrigão por fase
  ordem: number               // posição na sequência (fixa: executa em ordem crescente)
}
```

### 2.4 Task

```typescript
type TaskStatus = 'pendente' | 'em_progresso' | 'pausada' | 'concluida'

interface Task {
  id: string
  esteiraId: string
  titulo: string
  descricao: string
  status: TaskStatus
  faseAtual: number           // índice da fase em execução (0-based); null se pendente
  pausaMotivo?: 'manual' | 'erro'
  erro?: string               // último erro (quando pausada por erro)
  dependeDe: string[]         // ids de tasks que precisam concluir antes
  anotacoes: AnotacaoFase[]   // uma por fase executada
  criadoEm: string
  concluidoEm?: string
  iniciadoEm?: string
  tempoTrabalhoMs: number     // soma dos períodos em execução (exclui pausas)
  tokens: number              // tokens totais gastos
  custo: number               // custo estimado (soma por modelo)
}

interface AnotacaoFase {
  faseId: string
  faseNome: string
  status: 'ok' | 'erro' | 'pulada'   // 'pulada' = início manual por drag após a fase
  conteudo: string            // markdown — o que foi feito, artefatos, decisões
  comandosControlados: string[]       // comandos da camada "controlada" executados aqui
  commitHash?: string         // quando a fase criou commit
  tokens: number
  custo: number
  iniciadoEm: string
  concluidoEm: string
}
```

### 2.5 Política de comandos

```typescript
interface PoliticaComandos {
  bloqueados: string[]        // recusa + anota na task
  controlados: string[]       // executa + registra na anotação da fase
  // qualquer comando fora das duas listas: livre
}
```

### 2.6 Relatório (footer)

```typescript
interface RelatorioEsteira {
  esteiraId: string
  tasksConcluidas: number
  tasksFalhas: number
  tasksEmAndamento: number
  commitsCriados: string[]    // hashes
  tokensTotais: number
  custoTotal: number
  tempoTotalMs: number
  atualizadoEm: string
}
```

---

## 3. Criação da esteira (modal)

Fluxo do modal "Nova Esteira":

1. **Nome** da esteira.
2. **Pastas** — reutilizar o componente de seleção de pastas do chat (`folder-selector.tsx`); múltiplas pastas, mesma semântica do chat.
3. **Modelo padrão** — seleção de modelo (`model-picker.tsx`); é **propagado** para todas as fases (cada fase pode ser sobrescrita depois).
4. **Fases** — seleção do template de fases do sistema (multiselect). Cada fase selecionada é **copiada** (D4). O usuário pode remover/ordenar antes de criar; a ordem final vira a sequência fixa.
5. **Branch / Worktree** — selecionar branch existente (reuso de `branch-store.ts`) ou criar nova; opcionalmente criar um worktree dedicado para a esteira (D11).
6. **Retries e push** — `retryCount` (padrão 3) e `pushAoFinal` (padrão false).

Após criar, o usuário pode editar cada fase individualmente (prompt, modelo, thinking, tools) sem afetar o template.

---

## 4. Fases — templates padrão do sistema

Três fases padrão no template "Padrão" (novas esteiras vêm com estas):

### 4.1 Desenvolvimento
- **Prompt (esqueleto)**: implementar a task conforme a descrição, seguindo as convenções do projeto e as memórias (skills, padrões, preferências). Ao concluir, criar commit seguindo o padrão de commits do usuário (ver §10) e anotar na fase: o que foi feito, arquivos alterados, hash do commit.
- **Tools**: edit, shell, leitura. **Modelo/thinking**: herdados.
- **Contrato de saída**: anotação com `o que foi feito`, `arquivos alterados`, `commitHash`, `decisões`.

### 4.2 Validação
- **Prompt (esqueleto)**: validar a implementação da fase anterior — build, typecheck, testes, e browser quando aplicável. Revisar o diff (sem olhar o contexto de implementação — revisão cega). Corrigir pequenos problemas encontrados; se houver problema que exija reimplementação, **pausar a task com erro** (não há retorno de fase — ver §9).
- **Tools**: shell, browser, edit (correções pontuais).
- **Contrato de saída**: anotação com `resultado`, `testes executados`, `problemas encontrados/corrigidos`, `decisão`.

### 4.3 Pronto
- **Prompt (esqueleto)**: conferir o estado final do repo (branch/worktree da esteira), escrever o **resumo final** da task (o que foi feito, commits, validações), garantir anotações completas. Se `pushAoFinal`, fazer push (comando controlado). **Fechar a task**.
- **Tools**: shell (git), leitura.
- **Contrato de saída**: anotação final + `concluidoEm`.

### 4.4 Templates adicionais (opcionais, mesmos contratos)
- **Segurança** — auditoria de dependências, secrets, permissões.
- **Revisão de código** — code review focado em qualidade/estilo.
- **Infra** — checklist de deploy/ambiente.

Regra de contrato: **cada fase recebe** (descrição da task + anotações das fases anteriores + estado do repo, ex. hash do último commit) e **produz** uma anotação markdown na tab da fase. Sem isso, a fase seguinte recebe ruído.

---

## 5. Máquina de estados da task

```
pendente ── iniciar (clique) ──────────────► em_progresso (fase 1)
pendente ── drag para fase N ─────────────► em_progresso (fase N)  [fases < N anotadas como "pulada"]
em_progresso (fase N) ── fase conclui ────► em_progresso (fase N+1)
em_progresso (última fase) ── conclui ────► concluida
em_progresso ── pausar ───────────────────► pausada (motivo manual)
em_progresso ── erro após retries ────────► pausada (motivo erro)
pausada ── retomar ───────────────────────► em_progresso (mesma fase)
```

- **Linear obrigatório**: o engine só avança `faseAtual → faseAtual+1`. Não existe transição para fase anterior nem pulo automático.
- **Exceção do drag** (D8): drag inicia a task em fase intermediária; as fases anteriores ficam `pulada` nas anotações (registra-se o fato). *Pendência: se a regra "toda task passa por todas as fases" deve valer acima do atalho, o drag passa a enfileirar a task para iniciar da fase 1 — ver §19.*
- **Concluída** = passou pela última fase com sucesso.

---

## 6. Modos de operação

### 6.1 Manual
- Tasks nascem `pendente`.
- **Iniciar** (clique no botão do card) → começa da fase 1.
- **Drag** do card para uma fase → começa da fase solta em diante.
- A partir daí a task **flui sozinha pelas fases** (sem confirmação por fase). O usuário pode **pausar** a qualquer momento; a task congela na fase atual e retoma dela.

### 6.2 Automático
- Liga a esteira: a fila de tasks `pendente` (ordenada por dependências + criação) executa **uma por vez** — termina uma, inicia a próxima automaticamente.
- O usuário pode, enquanto a esteira roda, **iniciar tasks manualmente** — essas executam **em paralelo** com a fila automática.
- Desligar a esteira = as tasks em andamento terminam a fase atual e ficam `pausada` (motivo manual); a fila para de avançar.

### 6.3 Dependências (D15)
- Task com `dependeDe` não inicia enquanto uma dependência não estiver `concluida`:
  - **Automático**: a task vai para trás na fila, atrás da última dependência pendente; a ordem da fila se reorganiza automaticamente.
  - **Manual**: ao tentar iniciar, aviso "aguardando dependências: <tasks>" com opção de **iniciar mesmo assim** (o usuário assume o risco).
- Dependência circular é bloqueada na criação (validação no modal).

---

## 7. Execução do agente por fase

- **Motor**: o mesmo motor de agentes do Orbit, mas sem criar sessão de chat (D12). A execução de uma fase é: montar contexto → rodar agente → coletar anotação → avançar.
- **Contexto de entrada** de cada fase:
  1. Descrição da task.
  2. Anotações das fases anteriores (markdown).
  3. Estado do repo (branch/worktree, último commit, status).
  4. Prompt da fase.
- **Autonomia**: nenhum prompt de permissão (D5). Guarda-corpo = `tools` da fase + política de comandos (§8).
- **Fim da fase**: o agente finaliza com a anotação markdown da fase (obrigatória — se ausente, a fase é considerada com erro e entra no fluxo de retry).
- **Snapshot**: a task é executada a partir da descrição no momento do disparo; edições no título/descrição durante a execução não alteram a task em andamento (valem para o relatório final/reações futuras).

---

## 8. Política de comandos (3 camadas)

| Camada | Comportamento | Exemplos (listas padrão, editáveis por esteira) |
|---|---|---|
| **Bloqueada** | Recusa + anota na task | `git push --force`, `git reset --hard`, `rm -rf`, `git clean -fdx`, `DROP TABLE`, `DROP DATABASE`, `npm publish`, desinstalar pacotes |
| **Controlada** | Executa + registra o comando na anotação da fase (`comandosControlados`) | `git push`, `git merge`, `npm install`, `pip install`, `git checkout -b`, comandos de rede |
| **Livre** | Qualquer comando não listado nas duas anteriores | `git add`, `git commit`, `npm test`, `npm run build`, leituras, edições |

- A lista é definida por **esteira** e pode ser refinada por **fase** (ex.: Validação herda a lista da esteira).
- Comando bloqueado tentado: conta como falha da fase (entra no retry — o agente deve contornar sem o comando).

---

## 9. Falhas e retry

1. Fase falha (erro de execução, comando bloqueado, anotação ausente, agente reporta impossibilidade).
2. O engine **tenta refazer até `retryCount` vezes** (padrão 3; configurável na esteira). Cada tentativa roda a fase novamente com o contexto anterior + nota de que houve falha.
3. Se uma tentativa passa → a fase conclui normalmente.
4. Se esgota as tentativas → a task fica `pausada` com `motivo: 'erro'`:
   - **Card**: badge/aviso de erro visível.
   - **Modal da task**: banner de aviso com o erro (topo do modal), com botão **Retomar** (nova tentativa, zera o contador) e edição livre.
5. Retomar manualmente reinicia a **mesma fase** (faseAtual não muda).

---

## 10. Commits

- **Padrão**: o agente consulta as **memórias do projeto** (categoria `standard`/`preference` sobre commits) e segue o padrão do usuário (ex.: atomic commits, Conventional Commits com escopo, idioma das mensagens). 
- **Fallback**: Conventional Commits (`feat:`, `fix:`, `refactor:`, ...) — mesmo padrão já usado no repo do Orbit.
- **Quando**: na fase de **Desenvolvimento** (ou na fase que altera código), ao concluir a implementação — o hash é anotado na fase e aparece no resumo da task.
- **Onde**: branch/worktree da esteira (D11). **Sem** convenção de branch `orbit/esteira-<id>`.
- **Push**: só se `pushAoFinal` (controlado, registrado); padrão `false` — commit local.

---

## 11. Branch / Worktree

- Seleção/criação na criação da esteira (passo 5 do modal) e editável depois nas configurações da esteira.
- **Branch**: reusar `branch-store.ts` (seletor existente) — listar branches do(s) repo(s) das pastas; opção "criar nova".
- **Worktree**: opcional — caminho do worktree dedicado; quando definido, as fases executam dentro dele.
- Todas as tasks da esteira trabalham na mesma branch/worktree.

---

## 12. UI — Board

### 12.1 Página do board
- Listagem de esteiras do projeto; ao abrir uma esteira: **colunas kanban por fase** + coluna "Pendentes".
  - Alternativa aceitável: lista única ordenada por fila (a fila automática segue a ordem da lista). Kanban é o que viabiliza o drag para fase (D8).
- **Card da task**: título, badge da fase atual, badge de erro quando pausada por erro, tempo/tokens (compactos), ícone de pausa quando pausada.
- **Controles da esteira**: ligar/desligar modo automático, pausar tudo, retry config, push config.
- **Footer**: relatório (§13), altura baixa.

### 12.2 Drag & drop
- Drag do card: para a coluna "Pendentes" = mantém pendente; para qualquer fase = inicia a task daquela fase (D8); para a coluna da fase atual de uma task em execução não tem efeito.

---

## 13. UI — Modal da task

```
┌──────────────────────────────────────────────────────────────┐
│ [Aviso de erro — só quando pausada por erro]                  │
│ Título (input editável)                          [status]     │
├───────────────────────────────┬──────────────────────────────┤
│  Tabs de fases (área maior)   │  Direita (coluna fixa)        │
│  ┌───────────────────────────┐│  • Criada em: 05/08 14:00    │
│  │ Fase 1 │ Fase 2 │ Fase 3  ││  • Concluída em: —            │
│  ├───────────────────────────┤│  • Tempo de trabalho: 12min   │
│  │ Conteúdo da anotação em   ││  • Tokens: 45.230            │
│  │ markdown (renderizado,    ││  • Custo: R$ 0,42            │
│  │ com opção de editar)      ││  ─────────────────────────    │
│  │                           ││  Dependências:               │
│  │                           ││  • <task A> ✓ (concluída)    │
│  │                           ││  • <task B> ⏳ (pendente)     │
│  │                           ││  [+ adicionar dependência]   │
│  └───────────────────────────┘│                              │
├───────────────────────────────┴──────────────────────────────┤
│  [Pausar] [Retomar (se pausada)] [Fechar]                    │
└──────────────────────────────────────────────────────────────┘
```

- **Título**: editável inline (não afeta execução em andamento — snapshot, §7).
- **Tabs de fases**: uma tab por fase configurada; tab da fase atual com indicador de execução; fases `pulada` marcadas; conteúdo em markdown (renderização + edição).
- **Coluna direita**: `criadoEm`, `concluidoEm`, `tempoTrabalhoMs`, `tokens`, `custo` (estimado por modelo — §16), e o editor de **dependências** (adicionar/remover tasks do board; validação de ciclo; reorganização da fila automática refletida no board).
- **Aviso de erro**: banner no topo quando `pausaMotivo === 'erro'` com o texto de `erro` e botão **Retomar**.

---

## 14. UI — Relatórios no footer

- Cards **baixos** no rodapé do board (uma linha de altura), um por esteira:
  - ✅ tasks concluídas · ❌ falhas · 🔄 em andamento · commits (`abc1234`, ...) · ⏱ tempo total · tokens · custo.
- Atualização: ao vivo durante execução, e o card da esteira automática mostra progresso `n/total`.
- Clique no card abre o detalhe (lista de tasks por estado + commits).

---

## 15. Persistência e arquivos

Persistência local em JSON na pasta de dados do app (mesma base das memórias/settings do Orbit), sem banco novo nesta fase. Estrutura sugerida:

```
orbit-data/
└── esteira/
    ├── projetos.json
    ├── esteiras.json
    └── tasks-<esteiraId>.json
```

Stores zustand (padrão do app):

| Arquivo | Conteúdo |
|---|---|
| `apps/desktop/src/stores/projeto-store.ts` | CRUD de projetos (nome + pastas) |
| `apps/desktop/src/stores/esteira-store.ts` | CRUD de esteiras, fases, política de comandos, modo de operação, persistência |
| `apps/desktop/src/stores/esteira-exec-store.ts` | estado de execução: fila, tasks em andamento, retries, relatórios (efêmero + persistido) |

Componentes:

| Arquivo | Conteúdo |
|---|---|
| `apps/desktop/src/components/esteira/esteira-board.tsx` | página do board (kanban por fase + footer de relatórios) |
| `apps/desktop/src/components/esteira/esteira-create-dialog.tsx` | modal de criação (nome, pastas, modelo, fases, branch/worktree) |
| `apps/desktop/src/components/esteira/task-card.tsx` | card da task (badges de fase/erro/pausa) |
| `apps/desktop/src/components/esteira/task-modal.tsx` | modal da task (título, tabs de fases markdown, coluna direita, dependências) |
| `apps/desktop/src/components/esteira/esteira-footer.tsx` | cards de relatório do footer |

---

## 16. Telemetria

- **Tokens**: contados por fase (anotação + task).
- **Custo**: estimado — tokens × preço por 1k tokens do modelo usado (`models-store.ts`). Arredondado para 4 casas.
- **Tempo de trabalho**: soma dos períodos `em_progresso` (pausas e tempo pendente não contam).
- Exibidos no modal da task (coluna direita) e no relatório do footer.

---

## 17. Fora de escopo (fases futuras)

- **Rotinas** — agendador (cron) para executar esteiras/agentes em horários definidos.
- **Watcher QA** — agente em loop testando projetos e criando tasks na esteira ao achar erros/melhorias (depende de Rotinas).
- **Concorrência automática** — múltiplas tasks em paralelo pela esteira automática (hoje: 1 por vez; paralelismo só por início manual).
- **Agente gestor** — cancelado (D3): o roteamento é a sequência de fases, revisão é só mais uma fase.
- **Notificações externas** (sistema/email) e **execução em background quando o app está fechado**.

---

## 18. Riscos

| Risco | Mitigação |
|---|---|
| Agente validando trabalho do mesmo modelo → falso positivo | Validação com revisão cega (diff sem contexto) + modelo por fase permite trocar o modelo da Validação |
| Autonomia sem supervisão causando estrago no repo | Política em 3 camadas + commit local sem push (padrão) + branch/worktree dedicada |
| Custo alto em esteiras longas | Fases com modelos distintos, telemetria visível no footer/modal, pausa a qualquer momento |
| Dependências complexas travando a fila | Validação de ciclo na criação + aviso no modo manual + fila se reorganiza sozinha |
| Fase presa em loop de retry | `retryCount` limitado → pausa com erro e intervenção humana |

---

## 19. Decisões assumidas (pendências a confirmar)

1. **Retry padrão = 3** — confirmar se o default deve ser outro.
2. **Drag inicia da fase solta** — fases anteriores ficam `pulada`. Se a regra "passar por todas as fases" for absoluta, o drag deve apenas **enfileirar** a task (início na fase 1). **A confirmar.**
3. **Custo = estimado por tokens×preço do modelo** (não há faturamento real nesta fase).
4. **Push automático desligado por padrão** (`pushAoFinal: false`).
5. **Anotações editáveis pelo usuário** — edição não sobrescreve conteúdo do agente (append com autor/ts).
6. **Validação pode corrigir pequenos problemas**; problemas maiores → pausa com erro (não há retorno de fase).
7. **Board = kanban por fase** (para viabilizar o drag); lista simples é alternativa se o kanban ficar pesado.
