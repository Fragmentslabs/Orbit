# Roteiro de Teste Manual — Revert (Parte B) & Anti-overclaim (Parte A)

**App:** Orbit (desktop, Electron + React) · **Versão testada:** v0.1.0
**Data do roteiro:** 2026-08-11 · **Idioma:** pt-BR (as strings citadas são do locale pt-BR — ver Anexo A)

> **Status dos recursos (verificado no código em 2026-08-11):**
> - **Parte B (cenários 1–5):** implementada — `apps/desktop/electron/lib/session/revert.ts`, `apps/desktop/src/components/revert-bar.tsx`, `packages/shared/src/chat.ts` (tipo `SessionRevert`).
> - **Parte A (cenários 6–9):** `verify_changes` e `session_context` ainda **não estão no código** (em implementação). O roteiro descreve o comportamento esperado por especificação — se o cenário falhar por falta de implementação, reporte como "recurso ausente", não como regressão.
> - **Cenário 5 (flag `snapshot.failed`):** o rodapé da mensagem já renderiza o aviso quando a flag existe (`message-footer.tsx`), mas o `chat-engine` ainda não seta `failed: true` na falha de captura — o cenário 5 pode falhar até essa implementação.

---

## 0. Pré-requisitos

| # | Requisito | Como conferir |
|---|-----------|---------------|
| 0.1 | Node.js 20+ e npm instalados | `node -v && npm -v` |
| 0.2 | Dependências do monorepo instaladas (raiz do projeto) | `npm install` na raiz (`/Users/desknik/Projects/Orbit`) |
| 0.3 | `git` instalado e disponível (o recurso de snapshot usa um repo git auxiliar) | `git --version` |
| 0.4 | Provedor de modelo configurado no app, com modelo **com suporte a ferramentas** (tool calling) | Aba Models → modelo selecionado com badge de tools |
| 0.5 | Pasta de teste isolada para o roteiro (o agente vai editar arquivos nela) | Ex.: `~/orbit-teste-manual/` |
| 0.6 | Idioma do app: **Português (BR)** (senão as strings exatas dos resultados esperados mudam) | Preferências → Idioma |

**Preparação da pasta de teste (uma vez):**

```bash
mkdir -p ~/orbit-teste-manual
printf 'linha original\n' > ~/orbit-teste-manual/ola.txt
cat ~/orbit-teste-manual/ola.txt   # deve exibir: linha original
```

---

## 1. Iniciar o app em dev

A partir da raiz do monorepo (`/Users/desknik/Projects/Orbit`):

```bash
npm run desktop:dev
```

- Equivalente a `npm run dev --workspace=@orbit/desktop` (Vite + Electron, hot reload).
- **Deixe este terminal aberto** — ele recebe os logs do processo principal (importante para o "como reportar falha").
- O app abre em uma janela Electron. Aguarde a interface carregar antes de testar.

> Alternativa: `cd apps/desktop && npm run dev`.

---

## 2. Preparação da sessão de teste (modo código)

Repetir ao começar cada cenário da Parte B (ou usar o passo de limpeza no fim de cada cenário):

| Passo | Ação | Resultado esperado |
|-------|------|--------------------|
| 2.1 | No app, crie uma **nova sessão em modo código** e anexe a pasta `~/orbit-teste-manual` como pasta de trabalho | Sessão criada; a pasta aparece como pasta de trabalho da sessão |
| 2.2 | Envie: `Leia ola.txt e me diga o conteúdo.` | O agente lê o arquivo e responde com "linha original" |
| 2.3 | Aguarde o turno terminar (spinner para / status idle) | Turno concluído sem erros |

**Limpeza entre cenários:** use o botão **"Desfazer"** da barra de revert (se ativa) ou **exclua a sessão** e crie outra. **Nunca** edite os JSON de sessão/mensagem com o app aberto — o app pode sobrescrevê-los.

---

## 3. Parte B — Revert (cenários 1 a 5)

### Cenário 1 — Reverter até aqui com snapshot disponível (caminho feliz)

**Objetivo:** em modo código, editar um arquivo e reverter até a pergunta: o arquivo volta ao estado original e a barra mostra "1 arquivo revertido".

| Passo | Ação | Resultado esperado | Critério de aceite |
|-------|------|--------------------|--------------------|
| 1.1 | Crie a sessão de teste (seção 2) | Sessão em modo código com `ola.txt` original | `ola.txt` contém apenas "linha original" |
| 1.2 | Envie: `Adicione a linha "LINHA_ADICIONADA" no final de ola.txt.` e aguarde concluir | Turno concluído; rodapé da mensagem do assistente mostra **"Arquivos alterados neste turno:"** com `ola.txt (1 diff)` | O rodapé (A3) lista exatamente `ola.txt` |
| 1.3 | Confira no disco: `cat ~/orbit-teste-manual/ola.txt` | Conteúdo tem as duas linhas (original + adicionada) | A edição foi realmente gravada |
| 1.4 | Passe o mouse sobre a **mensagem do usuário** e clique em **"Reverter até aqui"** | A conversa é truncada a partir daquela mensagem; as mensagens do turno revertido somem | Só o turno revertido (e posteriores) é removido; mensagens anteriores permanecem |
| 1.5 | Observe a barra acima do input | Barra mostra **"1 arquivo revertido — nova mensagem continua deste ponto"** com botões **"Diff"** e **"Desfazer"** | Texto exato: "1 arquivo revertido" (singular) |
| 1.6 | Clique em **"Diff"** na barra | Abre o diff unificado mostrando a remoção da linha adicionada | O diff corresponde ao que foi revertido |
| 1.7 | Confira no disco: `cat ~/orbit-teste-manual/ola.txt` | Arquivo voltou ao estado original ("linha original") | O filesystem foi restaurado (não é só a conversa) |
| 1.8 | *(Opcional, verificação de estado)* Abra com o app fechado `orbit-data/storage/session/<id>.json` | Campo `"revert"` presente com `"filesRestored": true`, `"files"` e `"diff"` preenchidos | O estado de revert foi salvo (base para o cenário 4) |

> **Não** clique em "Desfazer" ainda — o cenário 4 precisa do estado ativo. Se for seguir direto para o cenário 2/3, faça a limpeza indicada.

### Cenário 2 — Reverter até mensagem sem snapshot → aviso explícito (nunca revert mudo)

**Objetivo:** em modo código, quando não há snapshot para a mensagem revertida, o app **deve avisar explicitamente** que a conversa foi truncada mas os arquivos **não** puderam ser desfeitos — nunca fazer um revert silencioso em sessão de código.

**Preparação (simular mensagem sem snapshot — método A, determinístico):**

1. Feche o app.
2. Localize o JSON de mensagens da sessão:
   ```bash
   find ~/Library/Application\ Support -maxdepth 4 -type d -name orbit-data 2>/dev/null
   # → <userData>/orbit-data/storage/messages/<sessionId>.json
   ```
3. Abra `messages/<sessionId>.json` e, em **uma mensagem de assistente** (ex.: a resposta do 2º turno), **remova o campo `"snapshot"`** inteiro. Salve.
4. Reabra o app e entre na sessão.

> Método alternativo (B, sem editar JSON, porém com janela curta e pode não reproduzir): envie um prompt e clique em "Reverter até aqui" na mensagem do usuário **recém-enviada**, antes de a resposta do assistente ganhar snapshot. Se não reproduzir, use o método A.

| Passo | Ação | Resultado esperado | Critério de aceite |
|-------|------|--------------------|--------------------|
| 2.1 | Prepare a sessão conforme acima (mensagem de assistente sem `snapshot`) | Sessão com um turno "antigo" sem snapshot | `messages/<id>.json` tem ao menos uma mensagem de assistente sem campo `snapshot` |
| 2.2 | Passe o mouse sobre a mensagem do **usuário anterior à resposta sem snapshot** e clique em **"Reverter até aqui"** | A conversa é truncada (as mensagens do turno somem) | O truncamento da conversa **acontece** (comportamento do revert normal) |
| 2.3 | Observe a barra acima do input | Barra com ícone de **alerta âmbar** e o texto exato: **"A conversa foi truncada, mas as alterações de arquivo NÃO puderam ser desfeitas (snapshot indisponível para esta mensagem)."** | Aviso explícito e visível — **nunca** um revert mudo em sessão de código |
| 2.4 | Confira no disco: `cat ~/orbit-teste-manual/ola.txt` | O arquivo **continua** com as edições do turno revertido (não foi restaurado) | Sem restauração falsa de arquivos |
| 2.5 | *(Verificação de estado)* Com o app fechado, abra `session/<id>.json` | `"revert"` com `"filesRestored": false` e `"reason": "no-snapshot"` | O motivo ficou registrado no estado persistido |
| 2.6 | **Limpeza:** reabra o app e clique em **"Desfazer"** (ou exclua a sessão) | Barra some; mensagens voltam | Estado limpo para o próximo cenário |

### Cenário 3 — Unrevert (Desfazer): arquivos e mensagens voltam

**Objetivo:** o "Desfazer" da barra restaura a conversa truncada **e** o filesystem para o estado anterior ao revert.

| Passo | Ação | Resultado esperado | Critério de aceite |
|-------|------|--------------------|--------------------|
| 3.1 | Execute o cenário 1 até o passo 1.6 (revert ativo, barra visível) | Barra "1 arquivo revertido" ativa | Estado de revert ativo |
| 3.2 | Anote: nº de mensagens visíveis e conteúdo de `ola.txt` (deve estar original) | Estado "revertido" | — |
| 3.3 | Clique em **"Desfazer"** na barra | A barra some; **as mensagens truncadas reaparecem** (conversa completa de volta) | Todas as mensagens do turno revertido voltaram, na ordem |
| 3.4 | Confira no disco: `cat ~/orbit-teste-manual/ola.txt` | Arquivo **voltou a ter** a linha "LINHA_ADICIONADA" (estado editado) | O filesystem foi restaurado para o estado pré-revert |
| 3.5 | *(Verificação de estado)* Com o app fechado, abra `session/<id>.json` | Campo `"revert"` **ausente** | Estado de revert foi removido da sessão |
| 3.6 | Envie uma nova mensagem e confirme que a sessão funciona normalmente | Turno roda sem resquícios da barra/estado | Sem estado fantasma |

### Cenário 4 — Persistência: fechar e reabrir o app no meio do fluxo

**Objetivo:** o estado de revert sobrevive a fechar/reabrir o app (persistido em disco).

| Passo | Ação | Resultado esperado | Critério de aceite |
|-------|------|--------------------|--------------------|
| 4.1 | Execute o cenário 1 até o passo 1.6 (revert ativo, barra visível) | Barra "1 arquivo revertido" ativa; `ola.txt` original | Estado de revert ativo |
| 4.2 | Feche o app (**Cmd+Q** — não apenas a janela) | App encerra | — |
| 4.3 | Reabra com `npm run desktop:dev` | App abre normalmente | Sem erro de inicialização |
| 4.4 | Navegue até a **mesma sessão** | Barra continua visível: **"1 arquivo revertido — nova mensagem continua deste ponto"** | Estado de revert **persistiu** |
| 4.5 | Confira no disco: `cat ~/orbit-teste-manual/ola.txt` | Continua no estado original (revertido) | O restore do filesystem sobreviveu ao restart |
| 4.6 | Confira a conversa | Continua truncada (mensagens do turno revertido não voltaram) | A persistência preserva o truncamento |
| 4.7 | Clique em **"Desfazer"** | Mensagens e arquivo voltam (comportamento do cenário 3) | O unrevert funciona **após** reabrir o app |
| 4.8 | **Limpeza:** com o revert desfeito, siga para o cenário 5 | Estado limpo | — |

### Cenário 5 — Falha de captura de snapshot no início do turno → `snapshot.failed`

**Objetivo:** quando a captura do snapshot do início do turno falha, a UI/estado **registram a falha** (`snapshot.failed`) em vez de silêncio.

| Passo | Ação | Resultado esperado | Critério de aceite |
|-------|------|--------------------|--------------------|
| 5.1 | Feche o app | App encerra | — |
| 5.2 | Localize o repo auxiliar de snapshots da pasta de teste: `find ~/Library/Application\ Support -maxdepth 4 -type d -name snapshots 2>/dev/null` e identifique a subpasta-hash do projeto (a mais recente/única) | Pasta `<userData>/snapshots/<hash>/` existe (criada pelo app no primeiro turno) | Repo auxiliar identificado |
| 5.3 | Trave o repo para forçar a falha de captura: `chmod -R 444 <userData>/snapshots/<hash>` | Nenhuma saída; permissões alteradas (`ls -l` mostra `r--r--r--`) | O `git add`/`write-tree` do snapshot passará a falhar |
| 5.4 | Reabra o app e, na sessão de teste, envie: `Adicione a linha "FALHA_SNAPSHOT" no final de ola.txt.` | O turno **conclui normalmente** (a falha de snapshot não derruba o turno) | A falha de rastreamento não interrompe o agente |
| 5.5 | Observe a mensagem do assistente | Rodapé mostra o aviso: **"As alterações deste turno não puderam ser rastreadas."** | A falha é **visível** — nunca silêncio (sem rodapé nenhum) |
| 5.6 | Observe o terminal do dev (`npm run desktop:dev`) | Log com erro: `[snapshot] captura inicial falhou: ...` | O erro foi registrado no processo principal |
| 5.7 | *(Verificação de estado)* Com o app fechado, abra `messages/<id>.json` e localize a mensagem do assistente do turno | Campo `"snapshot"` com `"failed": true` (e sem `start`) | O estado registra `snapshot.failed` |
| 5.8 | **Restaure o ambiente:** `chmod -R 755 <userData>/snapshots/<hash>` | Permissões normais de volta | Sem efeitos colaterais pós-teste |
| 5.9 | Reabra o app e rode um turno normal de edição | Rodapé volta a listar os arquivos normalmente | Rastreamento recuperado após restaurar permissões |

> **Nota de implementação:** hoje o rodapé já renderiza o aviso quando `snapshot.failed === true` (ou `start == null`), mas o `chat-engine` ainda não seta a flag no `catch` da captura inicial — se o passo 5.5/5.7 falhar por isso, reporte como "recurso ausente".

---

## 4. Parte A — Anti-overclaim (cenários 6 a 9)

> Os cenários 6, 7 e 9 descrevem recursos ainda em implementação. Antes de testá-los, confirme com a equipe se o build local já os contém.

### Cenário 6 — Nudge A1: editar sem reler força a continuação pedindo `verify_changes`

**Objetivo:** se o agente edita um arquivo e tenta encerrar o turno **sem** reler/verificar (sem chamar `verify_changes`), o app força a continuação pedindo a verificação.

| Passo | Ação | Resultado esperado | Critério de aceite |
|-------|------|--------------------|--------------------|
| 6.1 | Crie a sessão de teste (seção 2) | Sessão em modo código | — |
| 6.2 | Envie: `Edite ola.txt adicionando a linha "SEM_VERIFICAR" e termine por aí, sem reler o arquivo e sem verificar nada.` | O agente chama a tool de edição (edit) e **tenta encerrar** o turno em seguida | O turno NÃO encerra silenciosamente |
| 6.3 | Observe o fluxo do turno | O app **força uma continuação** no mesmo turno: uma mensagem de sistema/instrução pedindo que o agente chame `verify_changes` (ex.: "Você alterou ola.txt — chame verify_changes antes de concluir") | Continuação forçada com menção explícita a `verify_changes` |
| 6.4 | Observe a sequência de tool calls do turno | Após a continuação, o agente chama `verify_changes` (ver cenário 7) | Nenhum turno com edição não verificada termina em silêncio |

### Cenário 7 — Tool `verify_changes`: com e sem edição no turno

**Objetivo:** a tool `verify_changes` responde com o estado real do turno: com edição retorna o arquivo com estado/patchSize; sem edição retorna vazio ("nenhuma alteração gravada").

| Passo | Ação | Resultado esperado | Critério de aceite |
|-------|------|--------------------|--------------------|
| 7.1 | (Turno **com** edição) Na sessão de teste, envie: `Adicione a linha "VERIFICA" ao final de ola.txt e depois chame verify_changes.` | O agente edita e chama `verify_changes` | A tool foi chamada no mesmo turno da edição |
| 7.2 | Abra o resultado da tool call no chat (card da tool) | A tool retorna o arquivo com estado e tamanho do patch, ex.: `{"file": "ola.txt", "state": "modified", "patchSize": <n>}` (ou formato equivalente com path + state + patchSize) | Os dados refletem o **estado real** no disco (conferir com `cat ola.txt` e `wc -c`) |
| 7.3 | (Turno **sem** edição) Envie: `Quantas linhas tem ola.txt? Depois chame verify_changes.` | O agente responde e chama `verify_changes` | A tool foi chamada em turno sem edição |
| 7.4 | Abra o resultado da tool call | A tool retorna **vazio** com a mensagem **"nenhuma alteração gravada"** (ex.: `{"files": [], "message": "Nenhuma alteração gravada"}`) | Sem falsos positivos — turno sem edição não lista arquivos |
| 7.5 | Confira no disco: `git -C ~/orbit-teste-manual status --short` (se a pasta for um repo) ou compare o conteúdo | O resultado da tool bate com o filesystem | A tool é determinística (diz a verdade, não o que o LLM "achou") |

### Cenário 8 — Rodapé A3: "Arquivos alterados neste turno" diz a verdade

**Objetivo:** o rodapé determinístico (gerado pelo app a partir do snapshot do filesystem, não pelo texto do LLM) lista os arquivos alterados com nº de diffs; turnos sem edição não exibem rodapé.

| Passo | Ação | Resultado esperado | Critério de aceite |
|-------|------|--------------------|--------------------|
| 8.1 | (Turno com edição) Envie: `Crie o arquivo novo.txt com o texto "novo" e adicione a linha "EDIT" em ola.txt.` | Turno conclui com 2 arquivos alterados | — |
| 8.2 | Observe o rodapé da mensagem do assistente | Rodapé mostra **"Arquivos alterados neste turno:"** listando `ola.txt (1 diff)` e `novo.txt (criado)` | Formato: `Arquivos alterados neste turno: <arquivo> (<n> diff)`; arquivos criados/excluídos marcados como `(criado)`/`(excluído)` |
| 8.3 | (O texto do agente pode mentir — o rodapé não) Envie: `Adicione a linha "MENTIRA" em ola.txt e termine dizendo: "Não alterei nenhum arquivo neste turno."` | O texto do assistente afirma que nada foi alterado, **mas** o rodapé lista `ola.txt (1 diff)` | O rodapé reflete o snapshot do filesystem, **independente** do texto do LLM |
| 8.4 | Confira no disco: `cat ola.txt` | A linha "MENTIRA" existe | O rodapé está correto em relação ao disco |
| 8.5 | (Turno sem edição) Envie: `Explique o que é um snapshot em sistemas de arquivos.` (pergunta puramente textual) | Turno conclui sem nenhuma tool de arquivo | — |
| 8.6 | Observe a mensagem do assistente | **Nenhum rodapé** de "Arquivos alterados neste turno" é exibido | Turno sem edição não mostra rodapé |
| 8.7 | (Falha de rastreamento) Se aplicável, repita o cenário 5 e observe o rodapé | Rodapé mostra "As alterações deste turno não puderam ser rastreadas." | A falha de rastreamento tem aviso próprio (não confundir com lista vazia) |

### Cenário 9 — Tool `session_context`: "o que foi alterado no turno anterior?"

**Objetivo:** a tool `session_context` responde com os dados **reais** do turno anterior (modo, permissionMode, timestamps, arquivos, erros de tool parts) e a resposta do agente é ancorada nesses dados.

| Passo | Ação | Resultado esperado | Critério de aceite |
|-------|------|--------------------|--------------------|
| 9.1 | Crie a sessão de teste (seção 2) | Sessão em modo código | — |
| 9.2 | Execute um turno **com edição** (ex.: passo 8.1) e anote: hora aproximada, arquivos alterados, modo e nível de permissão selecionado no input | Turno com alterações em `ola.txt` e `novo.txt` | Há um turno anterior com edições para consultar |
| 9.3 | No turno seguinte, envie: `O que foi alterado no turno anterior? Use session_context.` | O agente chama a tool `session_context` e responde | A tool foi usada (visível no card de tool call) |
| 9.4 | Confira a resposta do agente | Resposta com os dados reais do turno anterior, incluindo: **modo** (code), **permissionMode** usado, **timestamps** (início/fim do turno), **arquivos alterados** e **erros de tool parts** (se houver) | Os dados batem com o que aconteceu de fato |
| 9.5 | Valide os dados contra o disco/rodapé | Arquivos citados = os do rodapé do turno anterior (cenário 8) e do `git status`/`cat` | A tool é fiel ao estado real — não "inventa" o resumo |
| 9.6 | (Turno anterior **sem** edição) Envie uma pergunta textual, depois pergunte novamente o que foi alterado | A tool responde indicando que **nada** foi alterado no turno anterior | Sem inventar arquivos em turno sem edição |
| 9.7 | (Com erro de tool, se reproduzível) Force um erro de tool (ex.: pedir para ler um arquivo inexistente) e consulte `session_context` | A resposta menciona o erro da tool part | Erros de tool parts aparecem nos dados |

---

## 5. Como reportar uma falha

Se qualquer passo falhar, colete **antes de reiniciar/limpar** o ambiente:

### O que coletar

1. **Identificação do cenário e passo** — ex.: "Cenário 2, passo 2.3".
2. **Ação executada** — prompt enviado, cliques feitos.
3. **Resultado observado vs. esperado** — descreva o que apareceu (ou não apareceu), com print se possível.
4. **Logs do processo principal** — terminal onde roda `npm run desktop:dev`: capture trechos com `[snapshot]`, `error`, `revert`, `unrevert`, `[chat-engine]`.
5. **Console do renderer** — no app, `Cmd+Alt+I` (DevTools) → aba **Console** → copie erros/avisos.
6. **Estado em disco** (com o app fechado):

```bash
# Descobrir a pasta de dados do app:
find ~/Library/Application\ Support -maxdepth 4 -type d -name orbit-data 2>/dev/null
# Estrutura relevante:
#   <userData>/orbit-data/storage/session/<sessionId>.json   → estado de revert (bloco "revert")
#   <userData>/orbit-data/storage/messages/<sessionId>.json  → mensagens ("snapshot"/"failed"/"parts"/"tokens")
#   <userData>/snapshots/<hash>/                             → repo git auxiliar de snapshots
```

7. **Versões e ambiente:**
   ```bash
   git rev-parse HEAD          # commit do código testado
   node -v && npm -v
   sw_vers                     # versão do macOS
   ```
   + versão do app (canto inferior da janela ou `apps/desktop/package.json`).

### Template de relato

```text
Cenário: C<X>, passo <Y>
Comando usado: npm run desktop:dev (commit <hash>)
Ação: <o que fiz>
Esperado: <critério de aceite do passo>
Observado: <o que aconteceu>
Logs: <colar trecho do terminal / DevTools>
Estado em disco: <session/<id>.json → bloco "revert" ou messages/<id>.json → "snapshot">
Classificação: [ ] regressão  [ ] recurso ausente  [ ] falha intermitente
```

---

## 6. Checklist final de aceite

| # | Cenário | Passou? | Observações |
|---|---------|---------|-------------|
| C1 | Revert com snapshot: arquivo volta + "1 arquivo revertido" | ☐ | |
| C2 | Revert sem snapshot: aviso explícito (nunca mudo) | ☐ | |
| C3 | Unrevert: arquivos e mensagens voltam | ☐ | |
| C4 | Fechar/reabrir no meio do fluxo: estado persiste | ☐ | |
| C5 | Falha de captura de snapshot: `snapshot.failed` registrado | ☐ | |
| C6 | Nudge A1: continuação forçada pedindo `verify_changes` | ☐ | |
| C7 | `verify_changes`: com edição → arquivo+estado+patchSize; sem edição → "nenhuma alteração gravada" | ☐ | |
| C8 | Rodapé A3: turno com edição mostra arquivos (n diff); sem edição não mostra; rodapé diz a verdade | ☐ | |
| C9 | `session_context`: resposta com dados reais do turno anterior | ☐ | |

**Decisão:** ☐ Aprovado para release · ☐ Aprovado com ressalvas (listar) · ☐ Reprovado

---

## Anexo A — Strings exatas (locale pt-BR)

Fonte: `apps/desktop/src/i18n/locales/pt-BR.json`

| Chave | Valor |
|-------|-------|
| `chat.revert` | "Reverter até aqui" |
| `revert.filesRevertedOne` | "1 arquivo revertido" |
| `revert.filesRevertedNone` / `Many` | "Arquivos revertidos" / "{{n}} arquivos revertidos" |
| `revert.filesNotRestored` | "A conversa foi truncada, mas as alterações de arquivo NÃO puderam ser desfeitas (snapshot indisponível para esta mensagem)." |
| `revert.conversationReverted` | "Conversa revertida até este ponto" |
| `revert.continueFromHere` | "nova mensagem continua deste ponto" |
| `revert.unrevert` | "Desfazer" |
| `revert.diff` | "Diff" |
| `messageFooter.title` | "Arquivos alterados neste turno:" |
| `messageFooter.diffCount_one` / `other` | "{{count}} diff" / "{{count}} diffs" |
| `messageFooter.created` / `deleted` | "criado" / "excluído" |
| `messageFooter.failed` | "As alterações deste turno não puderam ser rastreadas." |

## Anexo B — Referências de código (para depuração)

| Área | Arquivo |
|------|---------|
| Estado de revert (tipos) | `packages/shared/src/chat.ts` (linhas ~28–52: `SessionRevert`, `filesRestored`, `reason`) |
| Lógica revert/unrevert/cleanup | `apps/desktop/electron/lib/session/revert.ts` |
| Barra de revert (UI) | `apps/desktop/src/components/revert-bar.tsx` |
| Rodapé de arquivos alterados (A3) | `apps/desktop/src/components/messages/message-footer.tsx` |
| Ação "Reverter até aqui" (UI) | `apps/desktop/src/components/messages/shared.tsx` (~linha 417) |
| Captura de snapshots (início/fim do turno) | `apps/desktop/electron/lib/chat-engine.ts` (~linhas 484–491 e 599–611) |
| Engine de snapshots (git auxiliar) | `apps/desktop/electron/lib/snapshot/index.ts` |
| Handlers IPC | `apps/desktop/electron/main.ts` (~linha 1019: `session:revert` / `session:unrevert`) |
| Storage em disco | `apps/desktop/electron/lib/storage.ts` |
