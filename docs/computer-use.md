# Computer Use (controle do computador)

O agente do Orbit vê e opera outros apps do Mac: lê a tela (screenshot) e a
árvore de acessibilidade do app-alvo e age sobre ele (clique, digitação, teclas,
scroll, drag). Tudo em TypeScript dentro do `electron/lib`, sem binário
compilado, addon nativo ou MCP externo. A única peça fora do TS é a bridge JXA,
um script que o próprio macOS executa.

A v1 é **só macOS** e fica **desligada na Mac App Store**, porque o sandbox da
loja bloqueia acessibilidade e injeção de eventos. Windows e Linux terão planos
próprios (ver "Fora da v1").

## Como ligar

São duas chaves, e as duas precisam estar ligadas:

1. **Preferências → Computador → Controlar o computador** (vem desligado).
2. **Modo Computador** na conversa: no menu "+" do composer, em chat ou código.
   Todo chat começa com o modo desligado e não existe padrão global. O modo
   também não vai para o celular: fica fora de `session-modes-sync.ts`.

Na barra de modos abaixo do composer, o Computador fica **oculto por padrão**.
Quem quiser o atalho na barra liga em Preferências → Aparência → modos
visíveis.

Com só uma das chaves ligada, as tools `cu_*` não existem no turno. Se o modo
estiver ligado e o interruptor não, o prompt explica ao agente como ligar.

## Arquitetura

```
electron/lib/computer/
  bridges/macos.js   bridge JXA (osascript -l JavaScript): uma invocação = uma operação
  runner.ts          spawn + timeout + abort + parse; erro sempre vira ComputerError
  drivers/macos.ts   driver: bridge, screencapture e "open"
  types.ts           AppInfo, WindowInfo, AxNode, TreeSnapshot, BridgeAction, ComputerDriver
  geometry.ts        px do screenshot ↔ pontos globais
  keys.ts            "cmd+s" → código virtual + flags
  safety.ts          denylist, recusa do próprio Orbit, chave de aprovação por app/site
  registry.ts        observações numeradas por sessão, handles path+identidade, TTL de 120 s
  format.ts          árvore → texto indentado com índice (o contrato com o modelo)
  observe.ts         observe (screenshot + árvore) e query (busca sem screenshot)
  act.ts             as ações do cu_computer
  session.ts         controle ativo: faixa no topo, atalho de pânico, devolução das flags
  index.ts           fachada: disponibilidade, status, teste, dispose
electron/lib/tools/computer.ts   as 5 tools (zod + toModelOutput com imagem)
```

**Protocolo da bridge.** O JSON de entrada vai em `argv[0]` (`{ op, args }`) e a
resposta sai no stdout: `{ ok: true, result }` ou
`{ ok: false, error: { code, message } }`. As operações são `perms`, `apps`,
`tree`, `element` (info/press/focus/setValue), `mouse`, `drag`, `scroll`, `keys`,
`focused`, `activate` e `restore`. A bridge é importada com `?raw` e gravada uma
vez em `$TMPDIR/orbit-computer/macos-bridge-<hash>.js`. A probe e o smoke leem o
mesmo arquivo, então o código medido é o mesmo que roda no app.

**Handle de elemento.** O `AXUIElementRef` não sobrevive entre processos. Por
isso cada índice mostrado ao modelo guarda o caminho (índices de `AXChildren` a
partir da janela) e a identidade (papel e título). Na hora de agir, a bridge
re-caminha o caminho e confere a identidade. Se divergir, vira o erro
`staleIndex`, nunca um clique no lugar errado. Uma observação nova do mesmo app
invalida a anterior, e toda observação vence em 120 s.

**Árvore.** A árvore é lida por BFS com orçamento (nós, profundidade, filhos por
nó e prazo), uma chamada `AXUIElementCopyMultipleAttributeValues` por nó, e
exibida em DFS. Grupos vazios não ganham linha. O frame de cada elemento é
mostrado **no espaço do screenshot** (`@x,y wxh`), o mesmo das coordenadas
`x`/`y`. Campo seguro (`AXSecureTextField`) nunca tem o valor lido.

**Um só espaço de coordenadas por janela.** x/y e os frames da árvore
(`@x,y wxh`) estão sempre nos pixels do screenshot daquela janela, ou seja,
pontos × escala do monitor, reduzidos ao lado máximo (`windowSpace`), **com ou
sem imagem na observação**. Antes, sem screenshot, eles viravam pontos da janela.
No teste no app, o agente repetiu "os mesmos passos" de uma observação com
imagem numa sem imagem: manteve o deslocamento "+15" (que era 7,5 pt) como
15 pt, e o arrasto caiu **abaixo da linha de texto**, selecionando nada. No
TextEdit, o arrasto seleciona a linha a +4/+8/+10 pt do topo e nada a
+13/+15/+20 pt. A explicação que o agente deu ("soltar 2 px fora do campo
cancela a seleção") não se confirmou: medido, a seleção fica.

**Retorno da seleção.** Depois de arrastar ou de clique duplo/triplo, o
resultado diz o que ficou selecionado (`op: 'selection'`, `AXSelectedTextRange`
+ `AXSelectedText`), ou avisa que nada foi e por quê. `triple_click` seleciona a
linha (só no ponteiro global).

**Geometria.** No macOS, AX, CGWindowList e eventos usam pontos globais, com
origem no topo esquerdo do monitor principal e coordenadas negativas para
monitores à esquerda ou acima. Entre o screenshot e esses pontos só existe a
razão de escala da janela. A conversão DIP↔px (`screen.dipToScreenPoint`) é do
Windows e não é usada aqui.

## Tools

| Tool | Papel | Gate |
|---|---|---|
| `cu_apps` | Apps e janelas visíveis (pid, bundle, id, título, tamanho) | Nativa (não pede) |
| `cu_observe` | Screenshot e árvore numerada de uma janela | Nativa |
| `cu_query` | Busca na árvore por texto/papel, sem screenshot | Nativa |
| `cu_permissions` | Status das permissões; `request: true` pede ao usuário | Nativa |
| `cu_computer` | Ações: left/right/middle/double_click, move, drag, scroll, type, key, set_value, invoke, open_app, wait | Aprovação por app |

O `cu_computer` tenta primeiro a ação de acessibilidade (AXPress, AXValue). No
ponteiro **dirigido** (o padrão) tudo vai pela acessibilidade, porque o AppKit
ignora mouse e roda entregues por pid (Fase 0). O clique por x/y vira hit-test
do AX, a rolagem move a barra de rolagem do AX, e teclado e texto vão por pid.
Nada move o cursor do usuário, e o app pode ficar em segundo plano. Clique
duplo, clique do meio, hover e drag exigem o ponteiro **global**, que usa
eventos HID reais. Com `read_back` (o padrão), a resposta já traz a observação
seguinte. Se a árvore não mudar, a resposta avisa que a ação talvez
não tenha funcionado.

## Segurança

- **Denylist, bloqueio duro** em qualquer modo de permissão: cofres de senha
  (1Password, Bitwarden, LastPass, Dashlane, Keychain, Senhas), Ajustes do
  Sistema e prompts de segurança. Vale também para observar. É checada no gate
  (`isForbidden`, pelo texto) e de novo na tool (depois de resolver o app).
- **O próprio Orbit** nunca é alvo.
- **Campo de senha**: o agente recusa `type` e `set_value`, seja no elemento
  indicado, seja no foco do app.
- **Aprovação por app.** A primeira ação em cada app pede aprovação
  (`cu:app:<bundleId>`). Nos navegadores a aprovação é por site
  (`cu:app:<bundleId>@<host>`, com a URL da última observação). As opções são
  as mesmas de qualquer permissão do Orbit:
  - **Permitir neste turno:** a mesma regra não pergunta de novo até o turno
    acabar. Isso vale para toda permissão, não só o Computer Use. Antes era "só
    esta vez", e o agente pedia a mesma coisa a cada clique;
  - **Sempre neste chat:** vale pela conversa;
  - **Sempre:** grava a regra daquele app (ou site), que vale daqui para frente.

  Ações que perguntam sempre (como remover worktree) continuam uma a uma. O
  modo Irrestrito aprova sozinho, como o `bash`.
- **Prompt injection.** Todo texto vindo da tela vai dentro de
  `<screen_content untrusted="true">`, e o prompt diz que isso é dado e nunca
  instrução. Ação que a tela pede e o usuário não pediu: parar e perguntar.
- **Visibilidade e parada.** Enquanto o agente controla, aparecem a faixa
  amarela no topo da tela, com o botão **Parar** (painel não ativador, sem
  foco, do tamanho da faixa: clicar não traz o Orbit para a frente), e o chip
  "Controlando <app>" no header, com **Parar**. O atalho global
  **⌘⇧.** (ou ⌘⇧Esc) para tudo. Os atalhos, a faixa e os painéis duram o
  turno inteiro: com o vencimento antigo de 20 s sem ação, o agente pensando
  entre duas ações perdia o atalho, e o ⌘⇧. não parava nada. Parar aborta o turno, o que mata a bridge em andamento e
  limpa as aprovações da conversa. Fim do turno ou 20 s sem atividade encerram
  o controle, soltam o atalho e devolvem as flags de acessibilidade ligadas nos
  apps.

## Com o Orbit fora de foco

Enquanto o agente controla outro app e nenhuma janela do Orbit tem foco, uma
janela transparente por cima da tela mostra dois painéis no desenho da tela
cheia do navegador (alça recolhida que abre no hover):

- **esquerda: a conversa**, ao vivo, com os cards de aprovação. Um pedido novo
  abre o painel sozinho, senão o agente ficaria esperando um card que ninguém vê;
- **direita: as ações** `cu_*` desta conversa, da mais recente para a mais
  antiga, cada uma com a frase do que fez, o resumo da saída (clique expande) e
  o botão Parar. No topo, a **miniatura do último screenshot** da janela
  controlada, com o alvo da última ação marcado (retângulo no elemento, círculo
  no ponto). Ela mostra *onde* o agente agiu mesmo com o app atrás de outras
  janelas, porque o screenshot é da janela, não da tela.

**Screenshots fora da galeria.** Com uma observação por ação (`read_back`),
gravar cada screenshot na galeria encheria a aba de mídia com dezenas de
arquivos por tarefa. O modelo recebe a imagem pelo `toModelOutput`, e o main
guarda só o último screenshot de cada conversa, em memória (`computer/shots.ts`),
apagado quando o controle termina.

**Cursor no ponteiro global.** No modo global, o cursor real desliza até o alvo
numa curva suavizada (~250 ms) antes de clicar, rolar ou arrastar, em vez de
pular. No modo dirigido não há cursor nenhum, nem desenhado: o app costuma estar
em segundo plano ou coberto, e um cursor pintado por cima da tela apontaria para
a janela da frente. É a miniatura com o marcador que mostra o lugar. (O OCU
desenha um cursor de software sobre o app; ele só faz sentido com a janela alvo
visível.)

Peças: `computer/panels.ts` (a janela: área útil da tela, `focusable: false`,
atravessável pelo mouse fora dos painéis, nível `floating`, abaixo da faixa
amarela), `computer-panels.html` + `src/computer-panels-main.tsx` (entrada
própria do renderer, sem os sincronizadores da janela principal) e
`src/components/computer-panels.tsx`. A janela espelha o chat por
`startChatMirror()` no store das sessões: aplica os eventos ao estado e pula os
efeitos colaterais (disco, preferências e, principalmente, a fila de mensagens,
que a janela principal já dispara).

## Gravação de uma janela

`cu_record_start` → ações com `cu_computer` → `cu_record_stop` grava **uma
janela** e entrega um MP4 no chat (e na galeria).

- **Captura:** é do próprio Electron. O `desktopCapturer` acha a janela pelo
  CGWindowID, e uma janela oculta grava com o `MediaRecorder` (H.264). Por
  baixo é o ScreenCaptureKit: a janela sai inteira **mesmo coberta por outras**
  (medido). A página do gravador é um arquivo, porque `data:` não é contexto
  seguro e não tem `mediaDevices`. O bruto vai para o disco a cada segundo.
- **Sem tempo ocioso:** a gravação roda direto e é **cortada depois**
  (`recording-plan.ts`). Cada ação fica com 0,3 s antes e 0,9 s depois, trechos
  a menos de 0,5 s se juntam, e `wait` fica inteiro (é o agente segurando um
  estado de propósito). Cortar depois, em vez de pausar o gravador, não
  depende da latência do pause/resume.
- **Pulso de clique:** um retângulo amarelo no alvo de cada ação, no instante
  dela (`drawbox`). No modo dirigido, sem cursor na tela, é ele que mostra o
  que foi clicado.
- **O agente sabe o tempo:** o `cu_record_stop` devolve a linha do tempo do
  **vídeo final** ("0.3–0.5s left_click on element 3"), para refinar com o
  `video_render` (EDL) se precisar. `cu_record_mark` põe marcos.
- **Não se perde:** se o turno acaba, ou se a pessoa clica Parar ou aperta ⌘⇧.
  sem o `cu_record_stop`, o vídeo é montado assim mesmo e vai para a galeria.
  Limite de 20 min por gravação.
- **Medido em 2026-10-23:** 9,8 s gravados com 6 s de ociosidade viraram
  **2,7 s** de vídeo, com 7,1 s cortados. A montagem levou 0,3 s, e o arquivo
  final tem 22 KB. Enquanto grava, o macOS mostra o ícone de "janela sendo
  compartilhada" na barra de título, e ele aparece no vídeo.
- Para páginas web, o `browser_record` (roteiro declarativo) continua melhor.

## Permissões do macOS

| Permissão | Para quê | Sem ela |
|---|---|---|
| Acessibilidade | Árvore AX, ações AX e eventos de teclado/mouse | Nada funciona (`axDenied`) |
| Gravação de Tela | Screenshot (`screencapture -l`) e títulos de janela | Só a árvore (o texto avisa) |

O TCC atribui a permissão ao **processo responsável**: o `osascript` e o
`screencapture` filhos herdam a do Orbit. Em desenvolvimento o dono é o binário
do **Electron**, não o Orbit, e o item aparece como "Electron" em Ajustes. O
botão **Testar** das Preferências faz uma leitura real pelo processo filho, o que
prova a herança de verdade. A flag `isTrustedAccessibilityClient` sozinha não
prova isso. No Sequoia, a Gravação de Tela volta a pedir confirmação
periodicamente.

Não usamos o System Events, então nem `NSAppleEventsUsageDescription` nem a
entitlement `com.apple.security.automation.apple-events` são necessários. Se
algum caminho passar a usá-lo, os dois entram juntos.

## Fase 0: medição

O spike mede a bridge antes de qualquer decisão de produto:

```bash
node apps/desktop/scripts/cu-probe.mjs --runs 5
node apps/desktop/scripts/cu-probe.mjs --frozen
```

**Critérios de aprovação** (fixados antes de medir):

| Critério | Aprovado se |
|---|---|
| Latência de observe | p95 < 1,5 s com 250 nós em Safari e TextEdit (bridge fria) |
| Chromium | Árvore não vazia em Chrome e VS Code com a flag de acessibilidade |
| Timeout | App congelado (SIGSTOP) responde em < 3 s, com árvore parcial |
| Clique em background | Funciona em ≥ 1 app Chromium e 1 nativo sem mover o cursor (smoke) |
| TCC | A permissão do Orbit vale para os filhos, em dev e no build assinado |
| Captura | p95 < 600 ms por janela |

Se a latência ou o TCC reprovarem, a decisão 2 é reaberta e entra o helper
Swift. Se reprovar só o clique em background, o ponteiro "dirigido" deixa de ser
o padrão para apps Chromium.

### Resultados

Medido em 2026-10-23, Darwin 25.4.0 (Apple Silicon), pelo Electron 44.3.0 do
projeto aberto pelo LaunchServices (o mesmo caminho de permissão do Orbit em
dev), 5 execuções por medição:

| Critério | Resultado | |
|---|---|---|
| Latência de observe | TextEdit: p95 **166–196 ms**. Safari (250 nós): p95 **390–421 ms**. Claude/Electron (250 nós): p95 **342–346 ms** | ✓ |
| Chromium | Electron (Claude): **13 nós** lidos logo após ligar `AXManualAccessibility` → **250+** depois de ~300 ms | ✓ (com espera na 1ª vez) |
| Timeout | App congelado (SIGSTOP): resposta em **615–623 ms**, erro `axTimeout` acionável (a lista de janelas já não responde, então não há árvore parcial) | ✓ |
| Clique em background | Evento de mouse **por pid é ignorado** pelo AppKit (TextEdit, nem na frente nem atrás). Hit-test + AXPress/foco por AX: ✓ em segundo plano, cursor parado | ✓ com mudança de desenho |
| Teclado em background | Unicode por pid (acentos, ✓, 👍🏽) chega com o app atrás | ✓ |
| Rolagem em background | Roda por pid ignorada; barra de rolagem por `AXValue`: ✓ (300 px → conteúdo sobe 306 px) | ✓ com mudança de desenho |
| TCC | `osascript` filho atribuído ao Electron do Orbit (log do `tccd`) e com `accessibility: true` | ✓ em dev; build assinado ainda não medido |
| Captura | TextEdit p95 **107–109 ms**, Safari **191–197 ms**, Electron **145–158 ms** | ✓ |

Custos fixos: subir o `osascript` ~55 ms, invocação mínima da bridge ~115 ms,
lista de apps e janelas p95 ~150 ms.

**O que a Fase 0 mudou no código:**

1. **Conversão da árvore 4x mais rápida.** O Safari levava p95 de 1,2 a 2,8 s
   (reprovado). Os números finais acima já são da bridge corrigida. O perfil mostrou 65% do tempo em converter valores JXA → JS
   (vários `isKindOfClass` por atributo e `description` em todo atributo
   ausente). Trocado por um `ObjC.unwrap` raso do array e um por item. A
   `AXURL` saiu do pedido em lote e só é lida em links e áreas web. Resultado:
   ~830 ms → ~190 ms de conversão, e p95 de 390 ms no Safari.
2. **Frame de AXValue.** O `unwrap` de um AXValue é um `{}` vazio, não
   `undefined`, e por isso posição e tamanho saem do valor bruto. Os testes com
   driver falso não pegavam isso; o smoke pegou.
3. **Texto Unicode.** O `CGEventKeyboardSetUnicodeString` recebia a string JS e
   a descartava: todo caractere virava a tecla 0 ("a"). A função foi religada
   com `ObjC.bindFunction(... 'void*')`, com os bytes UTF-16 de um `NSData`.
4. **Modo dirigido sem mouse.** Como o AppKit ignora mouse e roda por pid, o
   clique por coordenada no modo dirigido virou hit-test do AX
   (`AXUIElementCopyElementAtPosition` → AXPress/AXShowMenu ou foco em campo de
   texto, subindo até 4 ancestrais) e a rolagem virou a barra de rolagem do AX
   (com Page Up/Down de reserva). Clique duplo, clique do meio, hover e drag
   passam a exigir o ponteiro global, com erro explicativo. É o mesmo recorte do
   OCU.
5. **Ação sem confirmação.** Uma ação que abre animação ou diálogo pode
   responder -25204 já tendo rodado (o botão de tela cheia entrou em tela cheia
   e respondeu -25204). Agora isso conta como "provavelmente executada", e a
   bridge não tenta outra ação nem o ancestral.
6. **Chromium.** A primeira leitura depois de ligar a flag espera 450 ms.
   `AXEnhancedUserInterface` ficou só para navegadores Chromium, porque em app
   nativo ele mexe em animação de janela. O Chromium mantém a árvore ligada
   mesmo depois do `restore`.

**Pendente:** clique dirigido em Chrome/VS Code de verdade (não estavam abertos;
o Electron medido foi o app Claude, só leitura) e o TCC no build assinado.

**Como medir pelo mesmo caminho do app.** Rodar a probe pelo Electron do projeto,
aberto pelo LaunchServices, faz o `osascript` herdar a permissão do Electron,
exatamente como no Orbit em dev:

```bash
open -n -W -a "$PWD/node_modules/electron/dist/Electron.app" --env ELECTRON_RUN_AS_NODE=1 --stdout /tmp/cu-probe.txt --stderr /tmp/cu-probe.err --args "$PWD/apps/desktop/scripts/cu-probe.mjs" --runs 5
```

**Armadilha em dev: vários "Electron".** Cada projeto Electron da máquina tem o
próprio `Electron.app` com assinatura ad-hoc (`Identifier=Electron`), e o TCC
amarra a permissão ao hash do binário. Em Ajustes, todos aparecem como
"Electron": liberar o de outro projeto (aqui, o Electron 30.5.1 do Fracta) não
libera o do Orbit (44.3.0). Para criar a entrada certa, o próprio binário deve
pedir a permissão (`isTrustedAccessibilityClient(true)` e uma chamada a
`desktopCapturer.getSources`). É o que o botão "Pedir" das Preferências faz.

Para diagnosticar, o log do `tccd` mostra a quem a permissão foi atribuída e o
veredito (`authValue`: 0 negado, 1 sem entrada, 2 permitido):

```bash
/usr/bin/log show --last 2m --style compact --predicate 'process == "tccd"' | grep -E "AUTHREQ_ATTRIBUTION|AUTHREQ_RESULT"
```

Em 2026-10-23, o log confirmou que o `osascript` filho é atribuído ao Electron
do Orbit (`responsible_path=…/Orbit/node_modules/electron/…/Electron`). A herança
funciona. O que faltava era a entrada certa ligada em Ajustes.

**Orbit em `npm run dev` é do terminal.** No primeiro teste no app, as
Preferências mostravam "não concedido" com o Electron liberado. A cadeia era
`Electron ← node ← npm run dev ← zsh ← login ← Terminal.app`, e o log do `tccd`
registrava todos os pedidos do Orbit com `responsible=com.apple.Terminal`. Quem
roda o app por um terminal precisa liberar **o terminal** (Terminal, iTerm,
VS Code…) em Acessibilidade e Gravação de Tela. Abrir pelo Finder ou pelo
LaunchServices torna o próprio app o dono. As Preferências → Computador mostram
esse app (`responsibleApp()`: sobe pelos processos pais até o primeiro `.app`).

**Sem as tools, o agente improvisava.** Com o Computer Use desligado na
conversa, o agente ofereceu `osascript` + System Events no bash, o que passa
por fora da denylist, da aprovação por app e da recusa de campo de senha. Agora
o prompt, no macOS, diz como ligar e proíbe o improviso, e o gate pede
aprovação para `osascript` com System Events (`bash:gui-automation`).

A lição para o produto: a permissão é de quem **lança** o processo filho. O
Orbit chama `osascript` direto pelo `child_process`, então herda a do próprio
app. Um wrapper que se declare responsável (como o `disclaimer` do Claude)
quebraria essa herança.

## Como validar

1. Conceda Acessibilidade e Gravação de Tela ao Electron do projeto e rode a
   probe e o smoke por ele (o terminal do Claude Code não serve: o `disclaimer`
   no meio da cadeia o torna dono das próprias permissões):
   ```bash
   open -n -W -a "$PWD/node_modules/electron/dist/Electron.app" --env ELECTRON_RUN_AS_NODE=1 --stdout /tmp/cu-smoke.txt --stderr /tmp/cu-smoke.err --args "$PWD/apps/desktop/scripts/cu-smoke.mjs" --act
   ```
   O smoke só age num documento novo do TextEdit que ele mesmo abre.
2. No app: Preferências → Computador → ligar, conceder as permissões ao
   Orbit/Electron, clicar em **Testar**.
3. Numa conversa com o modo Computador ligado, peça algo como "abra o TextEdit e
   escreva uma lista de compras". O esperado: o card de aprovação, a faixa no
   topo, o chip com Parar, e ⌘⇧. interrompendo o turno.

Testes automáticos (`vitest`, com driver falso, sem tocar no SO):
`electron/lib/computer/*.test.ts`, `permission/rules.test.ts`,
`permission/modo-global.test.ts` e `app-settings.test.ts`.

## Fora da v1

- **Windows**: UIA via PowerShell. Ficam para o plano dele o custo do `Add-Type`
  (bridge persistente), a lentidão da UIA em árvores grandes, o UIPI com janelas
  elevadas e a conversão DPI/DIP.
- **Linux**: AT-SPI via PyGObject. Ficam para o plano dele a dependência de
  `python3-gi`, a acessibilidade habilitada e o Wayland (captura e injeção só
  via portal, best-effort).
- Rotinas, esteira e celular, display virtual, `select_text` e aba
  "Computador" no painel direito (Fase 2 de polimento). O cursor desenhado saiu
  do plano: veja "Cursor no ponteiro global".
