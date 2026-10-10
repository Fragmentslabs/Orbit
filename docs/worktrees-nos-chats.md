# Worktrees nos chats

Plano para os chats do modo código trabalharem num `git worktree`, além do repositório principal.

## Status

**Etapas 0, 1 e 2 implementadas.** Decisões: branches dos chats em `orbit/<nome>`; worktrees criados fora do Orbit aparecem (remover pede confirmação e avisa); o repositório do próprio Orbit não tem tratamento especial.

Diferenças em relação ao plano abaixo:
- **Sem registro próprio** (`worktrees.json`): a origem de cada worktree sai do caminho (`orbit-data/worktrees/chats/…` = chat, `orbit-data/worktrees/<projeto>/…` = esteira, fora disso = externo) e o estado sai do git. "À frente" conta commits que o branch do principal ainda não tem — dá o mesmo aviso que "mesclado", sem precisar saber a base.
- **Excluir o chat não remove o worktree dele** (ainda): o worktree fica na lista do seletor para ser removido à mão. Entra junto da etapa 3.
- **Seletor de branch**: trocar para um branch aberto em outro worktree mostra um aviso próprio, em vez do diálogo de alterações não commitadas.
- **Pastas recentes**: sem mudança — a lista guarda as pastas do workspace, e voltar a um chat num worktree reabre o worktree, que é o certo.

Código: `electron/lib/worktrees/` (núcleo compartilhado com a esteira, `principal.ts`, `servico.ts`), `electron/lib/tools/worktrees.ts`, `src/components/worktree-selector.tsx`, `src/stores/worktree-store.ts`.

## Por que (e para quem)

Um worktree é uma segunda cópia de trabalho do mesmo repositório, num branch próprio, que compartilha o `.git`. No dia a dia do Orbit ele resolve três situações:

1. **Dois chats no mesmo projeto ao mesmo tempo.** Hoje os dois editam a mesma pasta: um pisa no outro, e o diff/revert de um mostra o trabalho do outro.
2. **Experimento descartável.** "Tenta reescrever isso de outro jeito" sem sujar o branch atual. Se não prestar, descarta; se prestar, faz merge.
3. **O Orbit trabalhando no próprio código em modo dev.** Editar `electron/` reinicia o app no meio do turno. Num worktree, o app que está rodando não vê as mudanças.

Quem não usa worktree não deve notar nada: o recurso fica escondido até a pasta ser um repositório git, e o padrão continua sendo o repositório principal.

## Recomendação

**As duas formas, com a UI como principal e o agente como atalho.**

- **UI (principal):** uma seção "Worktree" no seletor de pasta, que já existe e já é onde se escolhe "onde este chat trabalha". Ela lista os worktrees do repositório e permite trocar, criar e remover. É o caminho para quem não lembra comandos de git e para ver o estado de tudo de uma vez.
- **Agente (atalho):** ferramentas para listar, criar e trocar, para frases como "faz isso num worktree separado" ou "volta para o principal". Remover pede confirmação, como qualquer ação destrutiva.

Só agente seria invisível (você não saberia em que pasta o chat está sem perguntar). Só UI perderia o "faz isso isolado" no meio da conversa, que é justamente quando a ideia surge.

---

## Etapa 0 — Base compartilhada (pré-requisito, corrige a esteira)

### Projeto lógico = repositório principal

Vários pontos identificam o projeto **pelo caminho da pasta**. Um worktree fica em outro caminho, então hoje viraria um "projeto novo":

| Ponto | Onde | Efeito sem a correção |
|---|---|---|
| Memória do projeto | `electron/lib/memory/service.ts` → `resolveProjectScope` / `projectIdOf` | Sem memórias e sem mapa do projeto; memórias novas presas a um caminho que some ao remover o worktree. **Já acontece com o worktree por task da esteira (`f3796376`).** |
| Pasta da sidebar | `session-store.ts` → `folderKey` / `normalizeFolderName` | O chat cairia numa pasta nova da sidebar, com o nome do worktree. |
| Pastas recentes | `folder-selector.tsx` (`orbit-recent-folders`) | Worktrees poluiriam a lista de recentes. |

**Correção:** uma função `repositorioPrincipal(pasta)` que, para uma pasta dentro de um worktree, devolve a pasta equivalente no repositório principal:

- `git rev-parse --git-common-dir` aponta para o `.git` do principal; o pai dele é a raiz do principal.
- Preserva a subpasta: `<worktree>/apps/web` vira `<principal>/apps/web` (o `/init` em monorepo depende disso).
- Resultado em cache por pasta (é chamada em todo turno).

Usada em `resolveProjectScope`, no agrupamento da sidebar e nos recentes. Corrige a esteira de graça.

> **Memória: feito.** `electron/lib/worktrees/principal.ts` (`pastaNoRepositorioPrincipal`) é chamada na entrada de `resolveProjectScope`. Como toda leitura e escrita de memória de projeto passa por ali (ferramentas de memória, contexto do prompt, `/init`, mensagem do commit final da esteira), um worktree enxerga e alimenta a memória do principal. Sidebar e recentes ficam para a etapa 1, junto do seletor — hoje só a esteira cria worktrees, e as tasks não aparecem na sidebar.

### Serviço de worktrees compartilhado

Hoje a lógica está em `electron/lib/esteira/worktree.ts`. Ela vira `electron/lib/worktrees/` e passa a servir a esteira e os chats:

- **Criar:** branch novo ou existente, a partir de uma base, com `node_modules` clonado copy-on-write e `.env*` copiados. É o que a esteira já faz, mas com o nome do branch vindo de fora.
- **Listar:** `git worktree list --porcelain` + um registro do Orbit (`orbit-data/worktrees.json`) com o dono de cada um (`chat:<sessionId>`, `esteira:<taskId>` ou nenhum, para worktrees criados fora do Orbit). Assim aparecem também os worktrees que o usuário criou à mão.
- **Estado:** alterações não commitadas, commits à frente/atrás da base, se o branch já foi mesclado. É o que alimenta os avisos de remoção.
- **Remover:** pasta + registro + snapshots + processos em background com `cwd` dentro dele. O branch fica, a menos que seja pedido.
- **Órfãos:** limpeza no boot, como a da esteira, mas guiada pelo registro.
- Pastas: `orbit-data/worktrees/<id-do-repo>/<nome>`. Os da esteira continuam onde estão.

---

## Etapa 1 — Seletor de worktree no chat

### Onde aparece

O seletor de pasta já tem duas formas, e as duas ganham a mesma seção:

- **Normal** (`FolderSelector`): uma seção **Worktree** no dropdown, abaixo da pasta principal.
- **Compacta** (`CompactWorkspaceSelector`, header estreito): um terceiro atalho no menu, ao lado de "Branch" e "Pastas": **Worktree ›**, mostrando o atual.

O botão do seletor mostra onde o chat está:

```
📁 Orbit                    ← repositório principal (como hoje)
📁 Orbit · ⎇ chat-login     ← num worktree (branch dele)
```

### A seção

```
Worktree
  ● Principal                 homolog
  ○ chat-login                3 alterações
  ○ teste-novo-layout         mesclado
  ○ esteira/frete-a1b2c3      (esteira)      ← só leitura aqui
  ─────────────
  + Novo worktree…
```

- **Clicar** troca a pasta principal deste chat para o worktree (as pastas extras continuam). Trocar no meio de uma conversa é permitido: a próxima mensagem já roda lá, e o agente é avisado da troca.
- **Cada linha:** branch, estado ("3 alterações", "2 commits à frente", "mesclado") e um `×` para remover (exceto o principal e os da esteira, que a esteira gerencia).
- **Remover:** confirmação que diz o que se perde. "Sem alterações e já mesclado" remove direto; com alterações não commitadas, avisa e oferece "Apagar o branch também" (desmarcado).
- **Novo worktree…:** um diálogo curto:
  - nome (sugestão a partir do título do chat; vira o branch `orbit/<nome>`);
  - base (padrão: o branch atual do principal);
  - "Trocar este chat para ele" (marcado).
  Enquanto clona o `node_modules`, o botão mostra "Preparando…" (~16 s no Orbit).

### Por chat, não global

O worktree é da **sessão**, como as pastas já são: dois chats podem estar em worktrees diferentes do mesmo repositório. Um chat novo começa no principal. No futuro, pode haver a opção "Novo chat em worktree" no "+".

### Integrações que precisam respeitar o worktree

| Ponto | O que fazer |
|---|---|
| Seletor de branch | Num worktree, mostrar o branch dele; o checkout de um branch em uso em outro worktree falha no git: traduzir o erro ("já está aberto no worktree X"). |
| Diff, revert, snapshots | Já funcionam por pasta; remover o worktree apaga os snapshots dele. |
| Terminal e processos | `cwd` = worktree; ao remover, encerrar os processos que rodam lá dentro. |
| Excluir o chat | Se o chat criou o worktree: limpo e mesclado, remove junto; com alterações, pergunta. Worktree que outro chat também usa nunca é removido junto. |
| Sidebar | Chat continua na pasta do repositório principal, com um ícone de branch. |

---

## Etapa 2 — Ferramentas do agente

- `worktree_list`: worktrees do repositório do chat, com estado.
- `worktree_create { nome, base?, trocar? }`: cria e, por padrão, troca o chat para ele.
- `worktree_switch { nome | "principal" }`: troca a pasta principal do chat. O renderer atualiza o seletor pelo evento de sessão que já existe.
- `worktree_remove { nome, apagarBranch? }`: sempre pede aprovação, mesmo no modo de permissão total.

O prompt do modo código ganha uma linha quando o chat está num worktree ("você está no worktree X, branch Y, criado de Z; o principal é de outros chats"), como a esteira já faz.

---

## Etapa 3 — Fechar o trabalho

Reaproveita o que a etapa 3 da esteira vai construir (`docs/esteira-worktree-e-revisao.md`): **Merge**, **Criar PR** e **Descartar**, agora também na linha do worktree no seletor (menu `⋯`) e como ferramentas do agente ("junta isso no homolog"). Por isso a ordem sugerida é fazer a etapa 3 da esteira já em cima do serviço compartilhado da etapa 0.

---

## Etapa 4 — Mobile

O app mostra em que worktree o chat está (badge no cabeçalho) e permite trocar entre os existentes. Criar e remover ficam no desktop, ou pelo agente.

---

## Ordem sugerida

1. **Etapa 0**, com a correção da memória primeiro: é um bug do worktree da esteira que já está no `homolog`.
2. Etapa 3 da esteira (merge/PR/descarte), já no serviço compartilhado.
3. Etapa 1 (seletor) e etapa 2 (agente) dos chats.
4. Etapa 4 (mobile).

## Decisões em aberto

1. Prefixo do branch dos worktrees de chat: `orbit/<nome>` (proposta) ou sem prefixo?
2. Worktrees criados fora do Orbit aparecem na lista (proposta: sim, e podem ser selecionados; remover só com confirmação extra)?
3. Em modo dev, sugerir sozinho "trabalhar num worktree" quando o chat está na pasta do próprio Orbit (evita o reinício no meio do turno)?
