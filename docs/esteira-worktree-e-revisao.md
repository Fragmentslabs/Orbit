# Esteira: revisão por rodadas, worktree por task e entrega

Plano de implementação em três etapas, nesta ordem:

1. **Devolver com comentário** — revisar uma task concluída e mandá-la de volta pela esteira, com histórico por rodadas.
2. **Worktree por task** — opção da esteira que isola cada task num `git worktree` com branch próprio.
3. **Entrega ao concluir** — com worktree ligado, "Commit ao final" vira "Ao concluir a task": aguardar revisão, criar PR ou fazer merge.

A etapa 1 não depende das outras e funciona com ou sem worktree. As etapas 2 e 3 andam juntas: a 3 só existe com a 2 ligada.

---

## Estado atual (o que já existe)

| Peça | Onde | Observação |
|---|---|---|
| Tipos `Esteira`, `Task`, `AnotacaoFase` | `packages/shared/src/esteira.ts` | `Esteira.worktree?: string` existe (caminho fixo da esteira inteira), mas nada cria o worktree. |
| Loop de execução da task | `electron/lib/esteira/engine.ts` → `rodarTask` | `raiz = esteira.worktree \|\| projeto.pastas[0]`. Snapshot inicial (`capture`) e diff acumulado da task saem dessa raiz. |
| Conclusão, commit e push finais | `engine.ts` → `concluir`, `tentarCommit`, `gerarMensagemCommit`, `tentarPush` | Commit e push são "entrega": falha vai para `task.commitFalha`/`pushFalha` e não pausa a task. |
| Prompt de cada fase | `electron/lib/esteira/runner.ts` → `montarMensagem` | Descrição da task é o brief principal; notas das fases anteriores entram como contexto. O texto diz "fixed order, without going back". |
| Diretório da fase | `runner.ts` → `sendInputSintetico` / `executarFaseInterna` | `directory: ctx.esteira.worktree \|\| ctx.pastas[0]`. |
| Paralelismo | `Task.auto` | Tasks iniciadas manualmente **já rodam em paralelo, na mesma pasta** — hoje uma pode pisar na outra. O worktree resolve isso. |
| Snapshots | `electron/lib/snapshot/index.ts` | Repositório auxiliar por diretório em `userData/snapshots/<hash>`. |
| UI | `src/components/esteira/task-card.tsx`, `task-modal.tsx`, `esteira-create-dialog.tsx` | Card, modal da task e formulário da esteira. |

---

## Etapa 1 — Devolver com comentário (rodadas)

> **Status: implementada.** Diferenças em relação ao plano: os commits finais das rodadas anteriores ficam em `Task.commitsAnteriores` (relatório e rodapé continuam contando todos), e o modal mostra "esta fase não rodou nesta rodada" para as fases antes de `faseInicial`. Testes em `electron/lib/esteira/devolver.test.ts` e `rodadas.test.ts`.

### Fluxo

1. Task em **Concluídas** → botão **Devolver** no card (e no modal).
2. Diálogo: campo do comentário (obrigatório) + "Voltar a partir de" (select de fases, padrão: a primeira).
3. A task volta para `em_progresso` na fase escolhida, com `rodada + 1`, e roda a esteira de novo **em cima do próprio trabalho** (mesma pasta; com worktree, o mesmo worktree e branch).
4. No card/modal, o histórico mostra as rodadas: `Rodada 1 → comentário → Rodada 2 → …`. A mais recente aberta, as anteriores recolhidas.

### Dados (`packages/shared/src/esteira.ts`)

Tudo opcional, para tasks antigas lerem como rodada 1:

```ts
export interface Devolucao {
  /** Rodada que esta devolução ABRE (a primeira devolução abre a rodada 2) */
  rodada: number
  texto: string
  /** Índice da fase por onde a rodada recomeça */
  faseInicial: number
  criadoEm: string
}

export interface AnotacaoFase {
  // ...campos atuais
  /** Rodada em que a anotação foi escrita (ausente = 1) */
  rodada?: number
}

export interface Task {
  // ...campos atuais
  /** Rodada atual (ausente = 1) */
  rodada?: number
  devolucoes?: Devolucao[]
}
```

`anotacoes` continua uma lista só; a UI agrupa por `rodada`. Tokens, custo e tempo seguem somando na task (o total da task inteira); o resumo por rodada é calculado das anotações.

### Engine (`engine.ts`)

Nova `devolverTask(esteiraId, taskId, texto, faseInicial = 0)`:

- Só aceita task com `status === 'concluida'` e `taskEmExecucao(taskId) === false`.
- Grava: `rodada = (rodada ?? 1) + 1`, acrescenta a `Devolucao`, `status = 'em_progresso'`, `faseAtual = faseInicial`, limpa `commitFalha`, `pushFalha`, `erro`, `pausaMotivo`, `concluidoEm`; `auto = false` (devolução é manual e não entra na fila).
- Chama `executarTask` como o `iniciarTask` faz.
- `diff.inicio` **se mantém**: o diff da task continua sendo o acumulado desde o início (é o que interessa para revisar/mesclar). Opcional: guardar também o snapshot do início da rodada para mostrar "o que mudou nesta rodada".
- Fases puladas (`faseInicial > 0`) **não** geram anotação `pulada` numa devolução — o trabalho delas já existe da rodada anterior.
- Commit final: roda de novo ao fim de cada rodada (um commit por rodada). `gerarMensagemCommit` recebe o comentário da devolução para a mensagem descrever a correção.

Dependentes: se outra task depende desta e já começou/concluiu, avisar no diálogo ("Tarefas que dependem desta já rodaram com a versão anterior") — sem bloquear.

### Prompt da fase (`runner.ts` → `montarMensagem`)

Quando `rodada > 1`:

- Logo após a descrição da task, uma seção prioritária:
  ```
  ## Review feedback (round N)
  The user reviewed the previous round and sent it back with this feedback.
  It takes priority over the original description where they conflict.
  <texto da devolução>
  ```
- Notas: só as anotações da **rodada atual** entram como "Notes from previous phases"; da rodada anterior entra um resumo curto (a nota da última fase da rodada anterior), mais as devoluções anteriores em uma linha cada. Evita reenviar o histórico inteiro a cada rodada (custo e ruído).
- Ajustar o texto "without going back": "this is round N; the repository already contains the previous round's work — fix it, do not redo it from scratch".

### IPC, store e UI

- IPC `esteira:devolverTask(esteiraId, taskId, texto, faseInicial)` em `main.ts`, `esteiraApi` (`src/lib/ipc.ts`) e `esteira-store`.
- `task-card.tsx`: botão **Devolver** em tasks concluídas; selo `R2`, `R3`… quando `rodada > 1`.
- `task-modal.tsx`: anotações agrupadas por rodada, com o comentário da devolução entre elas.
- Novo `devolver-task-dialog.tsx`: textarea + select de fase + aviso de dependentes.
- i18n pt-BR/en.
- Companion/mobile: canal `esteira:devolver` depois (fora do escopo inicial).

### Testes

- `devolverTask`: recusa task não concluída/rodando; incrementa rodada; limpa falhas; mantém `diff.inicio`.
- `montarMensagem`: seção de feedback presente só com `rodada > 1`; notas filtradas pela rodada atual.
- Agrupamento por rodada com anotações antigas sem `rodada`.

### Retomar com instrução (task pausada)

> **Status: implementada.** Complemento da etapa 1 para o meio do caminho.

- Task pausada (por erro ou à mão) ganha **"Retomar com instrução"**: no card (ícone ao lado do play), no banner de erro e no rodapé do modal.
- A instrução fica em `Task.instrucoes` (`InstrucaoRetomada`: texto, rodada, fase, data) e **não** abre rodada nova.
- `retomarTask(esteiraId, taskId, instrucao?)`: parâmetro opcional — sem ele, o comportamento é o de antes (mobile e companion seguem iguais). Com ele, só aceita task pausada.
- Prompt: as instruções da fase que vai rodar entram como prioritárias; as dadas a outras fases da mesma rodada entram como contexto (costumam ser fatos do projeto, como o comando de teste).
- Modal: a instrução aparece no topo da fase a que se refere, na rodada em que foi dada.
- Mobile: junto da etapa 3, como o restante.

---

## Etapa 2 — Worktree por task

### Opção na esteira

- `Esteira.worktreePorTask?: boolean` — switch no formulário: **"Isolar cada task em um worktree"**, com dica: "Cada task trabalha num branch e numa cópia próprios; dá para rodar várias ao mesmo tempo sem uma mexer na outra."
- `Esteira.worktree` (caminho fixo) fica como legado: lido se existir, sem UI.

### Dados

```ts
export interface WorktreeDaTask {
  caminho: string
  branch: string
  /** Branch de onde saiu e para onde volta no merge/PR */
  base: string
  criadoEm: string
}

export interface Task {
  // ...
  worktree?: WorktreeDaTask
}
```

### Módulo novo: `electron/lib/esteira/worktree.ts`

- **Onde:** `userData/orbit-data/worktrees/<projetoId>/<taskId>`. Fora da pasta do projeto de propósito: não aparece nas buscas do agente, não dispara watchers (Vite/dev server) e não depende de `.gitignore`.
- **Criar** (no início da primeira execução da task, antes do snapshot inicial):
  - `base` = `esteira.branch` ou o branch atual do repositório principal.
  - `branch` = `esteira/<slug-do-título>-<6 chars do id>`.
  - `git -C <repo> worktree add -b <branch> <caminho> <base>`.
- **Dependências (o peso real):**
  - Achar os `node_modules` do repositório principal (raiz + workspaces, sem descer dentro de outro `node_modules`) e cloná-los no mesmo caminho relativo:
    - macOS: `cp -c -R` (clone APFS — copy-on-write, quase instantâneo e quase sem espaço). Se o destino estiver em outro volume, cai no symlink.
    - Linux: `cp -R --reflink=auto`; Windows: junction.
  - Copiar também arquivos ignorados essenciais que o worktree não traz: padrão `.env*` (configurável na esteira depois).
  - O prompt da fase avisa: "dependencies were cloned from the main checkout; if you change dependency manifests, run the install".
- **Remover:** `git worktree remove --force <caminho>` (+ `git branch -D` só no descarte), apagar o repositório de snapshots desse caminho, encerrar processos em background cujo `cwd` está dentro dele.
- **Limpeza de órfãos** no boot (junto do `reconciliarExecucoes`): `git worktree prune` e apagar pastas de tasks que não existem mais.

### Engine e runner

- `rodarTask`: `raiz = task.worktree?.caminho ?? esteira.worktree ?? projeto.pastas[0]`. Cria o worktree se `worktreePorTask` e a task ainda não tem um.
- `runner.ts`: `directory` e "Working folders" passam a usar a raiz da task; seção Repository informa `Branch: <branch da task> (worktree isolado; base: <base>)`.
- `removerTask`, `removerEsteira`, `removerProjeto`: removem os worktrees das tasks.
- O worktree **não** é removido ao concluir: fica até merge, PR mesclado ou descarte (etapa 3) — senão a devolução da etapa 1 não teria onde continuar.

### Riscos conhecidos

- Duas tasks com dev server na mesma porta: o segundo sobe em outra porta ou falha; registrar no prompt "prefer an alternative port if the default is busy".
- Pastas extras do projeto (`pastas[1..]`) continuam compartilhadas — só a principal é isolada.
- Repositório sem commits ou pasta que não é repo git: a opção fica desabilitada no formulário, com o motivo.

### Testes

- `worktree.ts` com repositório temporário: criar, nome do branch, remoção, prune de órfãos.
- Busca dos `node_modules` em monorepo (não entra em `node_modules` aninhado).
- `rodarTask` usa a raiz da task quando há worktree.

---

## Etapa 3 — Ao concluir a task (com worktree)

### Formulário

Com **worktree ligado**, as linhas "Commit ao final" e "Push ao final" dão lugar a um select **"Ao concluir a task"**:

| Opção | O que faz |
|---|---|
| **Aguardar revisão** (padrão) | Commit no branch da task e para. O card mostra Merge / Criar PR / Descartar, e dá para devolver. |
| **Criar PR** | Commit, push e abre o PR. Devoluções seguintes atualizam o mesmo PR (mesmo branch). |
| **Fazer merge** | Junta no branch base direto. Com aviso: pula a revisão. Conflito → para em "aguardando revisão". |

A engrenagem do prompt de commit continua nos dois modos. Com **worktree desligado**, nada muda (commit + push como hoje).

```ts
export type AoConcluir = 'revisao' | 'pr' | 'merge'
export interface Esteira {
  // ...
  /** Só vale com worktreePorTask; commit final fica sempre ligado */
  aoConcluir?: AoConcluir
}

export interface EntregaDaTask {
  estado: 'aguardando' | 'pr' | 'mesclada' | 'descartada' | 'conflito'
  prUrl?: string
  erro?: string
  atualizadoEm: string
}
export interface Task {
  // ...
  entrega?: EntregaDaTask
}
```

### Ações

- **Merge** (`git` no repositório principal):
  - Se o repositório principal está no branch base e limpo → `git merge --no-ff <branch>` lá.
  - Se está no base mas com alterações → recusa com o motivo (não mexe no trabalho do usuário).
  - Se o base não está em checkout em lugar nenhum → `git merge-tree --write-tree` + `commit-tree` + `update-ref` (requer git ≥ 2.38; abaixo disso, recusa e sugere PR).
  - Conflito → `entrega.estado = 'conflito'` e o card oferece **"Devolver para resolver conflito"**: abre uma rodada (etapa 1) com feedback pronto pedindo para trazer a base para o branch da task e resolver.
  - Sucesso → remove o worktree e, opcionalmente, o branch.
- **Criar PR:** `git push -u origin <branch>`; com `gh` instalado e autenticado, `gh pr create --base <base> --head <branch>` com título da task e corpo montado das notas das rodadas. Sem `gh`: push + abrir a página de comparação do GitHub (`shell.openExternal`, URL derivada do remote). Guarda `prUrl`.
  - Devolução de task com PR: ao fim da rodada, push no mesmo branch (o PR atualiza sozinho).
  - O worktree fica até o usuário descartar ou o PR ser mesclado (checagem opcional via `gh pr view --json state`).
- **Descartar:** confirmação → remove worktree e branch, `estado = 'descartada'`.

### UI

- Card concluído: selo do estado da entrega (Aguardando revisão / PR aberto / Mesclada / Conflito / Descartada) e botões conforme o estado.
- PR: link "Abrir PR".
- Modal: a mesma área, com o erro completo quando houver.

### Testes

- Merge nos três cenários (base em checkout limpo, base com alterações, base fora de checkout) e conflito.
- Montagem do corpo do PR; fallback sem `gh`.
- Formulário: com worktree, commit forçado e push oculto; sem worktree, comportamento atual.

---

## Decisões

1. Ao mesclar, o branch da task é apagado.
2. Devolver uma task já mesclada é permitido, com aviso (cria um worktree novo a partir da base).
3. Só `.env*` é copiado para o worktree além dos `node_modules`.
4. Devolver e as ações de entrega chegam ao mobile (companion) junto da etapa 3.
