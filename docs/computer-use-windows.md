# Computer Use no Windows

Plano e estado do Computer Use do Orbit no Windows. O desenho do macOS (tools
`cu_*`, observação numerada, registro, segurança, painéis e gravação) está em
[computer-use.md](computer-use.md) e não muda: o Windows entra como **mais um
driver** atrás do mesmo contrato `ComputerDriver`
(`apps/desktop/electron/lib/computer/types.ts`).

> **Estado:** Stages 1 a 4 implementados e testados no Mac (typecheck, lint e
> vitest com driver falso). **O Stage 0 ainda não foi medido**: precisa de uma
> máquina Windows. O probe está pronto em `apps/desktop/scripts/cu-probe-win.mjs`.
> Até o portão do Stage 0 passar, o Windows é **experimental**: o código existe,
> mas os números e o comportamento em segundo plano por tipo de app são
> hipóteses.

## Referência e licença

Usamos o runtime Windows do open-computer-use
(`apps/OpenComputerUseWindows`, MIT) **só como leitura**: como eles resolveram
DPI awareness, `EM_REPLACESEL`, mensagens de janela, a ordem de tentativas no
clique e quais cenários os testes cobrem. O código aqui é nosso, com outro
desenho:

| Ponto | open-computer-use | Orbit |
|---|---|---|
| Processo | um `powershell.exe` por operação (~1–2 s de `Add-Type` a cada vez) | **host persistente**: um processo, `Add-Type` uma vez, JSON por linha |
| Lógica | funções PowerShell iterando a UIA | C# compilado pelo `Add-Type`; o PowerShell só inicia o laço |
| Árvore | `Current.*` elemento a elemento | **`CacheRequest`** (um round-trip por nó expandido) |
| Captura | `CopyFromScreen` (pega o que está por cima) | **`PrintWindow(PW_RENDERFULLCONTENT)`**; `CopyFromScreen` só se a janela não está coberta |
| Retângulo | `GetWindowRect` (inclui a borda invisível de ~7 px) | **`DWMWA_EXTENDED_FRAME_BOUNDS`**, um só para apps, captura e frames |
| Achar o elemento | varre a subárvore a cada clique | **`ref`** da observação (mapa no host), `path` como fallback |
| `SetFocus` / abrir app | atrás de variável de ambiente | nunca `SetFocus`; abrir app é ação normal com aprovação |
| Saída da captura | base64 no JSON | caminho de arquivo |

Nenhum trecho foi copiado. Se algum dia um trecho ficar parecido o bastante
para contar como derivado, o aviso de copyright MIT do projeto deles vai junto
no arquivo.

## Arquitetura

```
tools/computer.ts ── observe.ts / act.ts / format.ts / registry.ts / safety.ts
                                   │  (ComputerDriver)
               ┌───────────────────┴───────────────────┐
     drivers/macos.ts                         drivers/windows.ts
     createBridgeRunner (1 osascript/op)      createPersistentRunner (1 host)
     bridges/macos.js (JXA)                   bridges/windows.ps1 (PowerShell + C#)
```

### Host persistente (`bridges/windows.ps1`)

- Roda em `powershell.exe` 5.1 (sempre presente no Windows 10/11; o
  `System.Windows.Automation` gerenciado e o `JavaScriptSerializer` são do .NET
  Framework, não do PowerShell 7).
- Na partida: confere o `LanguageMode` (Constrained Language Mode bloqueia o
  `Add-Type` — o host responde `unavailable` com o motivo a todo pedido), liga
  `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` e compila o C# **uma
  vez**.
- Protocolo: uma linha JSON por pedido no stdin
  (`{"id":7,"op":"tree","args":{…}}`), uma linha por resposta no stdout
  (`{"id":7,"ok":true,"result":…}` ou `{"id":7,"ok":false,"error":{"code","message"}}`).
  stdin e stdout são abertos como UTF-8 sem BOM — o PowerShell 5.1 usa a página
  de código ANSI por padrão e corromperia texto não-ASCII digitado.
- Estado no host: `ref → AutomationElement` por pid, trocado a cada árvore
  daquele pid (contador de geração no `ref`), e o "alvo de texto" do `focus`
  (ver Stage 3).

### Runner (`runner.ts → createPersistentRunner`)

Mesma assinatura do `createBridgeRunner`: `run(op, args, { timeoutMs, signal })`.

- Sobe o host no primeiro uso (o primeiro pedido ganha um prazo extra para a
  compilação do `Add-Type`).
- Correlaciona respostas por `id`; o host é sequencial, os pedidos esperam na
  fila do stdin.
- Timeout ou abort de uma operação: **registra o desfecho antes do kill** (o
  `close` provocado pelo kill não pode trocar "timeout" por "saiu sem
  resposta"), mata o host e rejeita os outros pedidos pendentes com uma
  mensagem de "host reiniciado". O próximo uso sobe um host novo.
- Morte inesperada: rejeita tudo que está pendente com o fim do stderr.

### Coordenadas e DPI

O host é **per-monitor DPI aware v2**. Com isso, UIA (`BoundingRectangle`,
`FromPoint`), `DwmGetWindowAttribute`, `PrintWindow`, `SendInput` e
`ScreenToClient` falam **pixel físico** do desktop virtual. O `Frame` do
contrato no Windows é pixel físico, e o screenshot já sai do tamanho do frame.
Por isso `scaleFor` é **1** no win32 (`tools/computer.ts`): no Mac ele vale 2 no
Retina porque o AX fala pontos e o screenshot pixels.

O único lugar em que DIP entra é o Electron (`screen`, `BrowserWindow`): a
faixa e os painéis usam a área útil do monitor em DIP, sem frame de janela-alvo.
Se algum dia precisarmos desenhar sobre a janela-alvo, a conversão é
`physicalToDip()` em `geometry.ts` (testada com 150%).

### Identidade do elemento (`ref`)

`AxNode.ref?: string`. No Windows:

- `r:<geração>:<RuntimeId em base64>` — resolve pelo mapa do host;
- `k:<AutomationId>|<ControlType>|<Name>` — quando não há RuntimeId; resolve por
  busca sob a janela.

O `act.ts` manda `ref` quando existe e `path` (índices de filhos na Control View
a partir da janela) como fallback. O host **sempre** confere a identidade
(papel nativo e nome) do que achou: se não bate, devolve `staleIndex`; se o
elemento morreu (`ElementNotAvailableException`) e o `path` também não serve,
`staleRef`. Nunca clica no elemento errado. O macOS ignora `ref`.

O handle guarda `nativeRole` (o papel como o host mandou) além do `role`
normalizado: o host confere identidade no vocabulário dele.

### Papéis

A UIA fala `ControlType` (`Button`, `Edit`, `Document`…). O host manda o nome
cru; `format.ts → normalizeRole()` traduz para o vocabulário do AX que o resto
do módulo (e o prompt) já conhece:

| UIA | AX | Observação |
|---|---|---|
| `Document` | `AXWebArea` | com URL, ou somente leitura |
| `Document` editável | `AXTextArea` | Bloco de Notas do Windows 11 é `Document` |
| `Edit` | `AXTextField` | |
| `Hyperlink` | `AXLink` | |
| `Text` | `AXStaticText` | |
| `Pane`, `Group`, `Custom`, `TitleBar` | `AXGroup` / `AXUnknown` | somem da árvore se não dizem nada |
| `Tab` / `TabItem` | `AXTabGroup` / `AXTab` | |
| `Tree` / `TreeItem` | `AXOutline` / `AXTreeItem` | |
| `ListItem`, `DataItem` | `AXListItem`, `AXRow` | |
| demais | `AX<Nome>` equivalente | tabela completa em `format.ts` |

Ações viram o vocabulário do AX também: `Invoke → AXPress`, `Toggle →
AXToggle`, `SelectionItem → AXPick`, `ExpandCollapse → AXExpand/AXCollapse`,
`ScrollItem → AXScrollToVisible` (silenciosa).

### Teclas

`keys.ts` é por plataforma. No Windows o combo é `{ code: VK, flags }` com flags
`shift=1, ctrl=2, alt=4, win=8`. `cmd`/`command` viram **Ctrl** (o modelo manda
`cmd+s` por hábito do Mac); `win`/`super`/`meta` viram a tecla Windows.

### Erros novos

| Código | Quando | O que o modelo ouve |
|---|---|---|
| `elevated` | o app roda como administrador (UIPI bloqueia mensagens e `SendInput` de um processo comum) | pedir para o usuário fazer, ou abrir o Orbit como administrador — nunca contornar |
| `secureDesktop` | UAC, tela de bloqueio ou Ctrl+Alt+Del (a área de trabalho de entrada não é `Default`) | parar e pedir ao usuário |
| `staleRef` | o elemento do `ref` não existe mais | observar de novo |

## Tabela de operações

| op | Windows | macOS (referência) |
|---|---|---|
| `perms` | `LanguageMode`, UIA carregada, nível de integridade do Orbit | TCC |
| `apps` | `EnumWindows` (ordem z = frente→trás) + `DWMWA_CLOAKED` + `WS_EX_TOOLWINDOW` + dono; `ApplicationFrameHost` resolve para o processo da `CoreWindow` (UWP); nome por `FileDescription`, id por exe (ou AUMID) | `NSWorkspace` + `CGWindowList` |
| `tree` | `CacheRequest` + filhos na Control View, BFS com `maxNodes`/`maxDepth`/prazo; `ref`, `secure` (`IsPassword`), URL pela barra de endereço do Chromium | AX BFS |
| `capture` | `PrintWindow(PW_RENDERFULLCONTENT)` recortado ao frame do DWM; preto → `CopyFromScreen` só se a janela não estiver coberta; senão, sem imagem | `screencapture -l` |
| `element` | `ref` → `path`; `press` (Invoke/Toggle/SelectionItem/ExpandCollapse, numa thread com prazo: Invoke que abre modal bloqueia), `setValue` (ValuePattern/RangeValue), `select` (TextPattern `FindText` + `Select`; Edit Win32 por `EM_SETSEL`), `focus` (no-op que só guarda o alvo de texto), `info` | AX |
| `hit` | `AutomationElement.FromPoint`, conferindo que é do pid e da janela (coberta → nada, e o `act` cai para mensagem) | AX hit-test |
| `focused` | `GetGUIThreadInfo(hwndFocus)` → UIA; também `ES_PASSWORD` no Edit | `AXFocusedUIElement` |
| `selection` | `TextPattern.GetSelection` + `MoveEndpointByRange` para a `location` | `AXSelectedTextRange` |
| `scrollAx` | `ScrollPattern` no ancestral sob o ponto (`SetScrollPercent` calculado pelo `ViewSize`) | barra de rolagem AX |
| `mouse` | **só global**: `SendInput` com deslize do cursor. Sem mensagem de janela (decisão: ver "Decisão de entrada") | CGEvent |
| `scroll` | dirigido: `ScrollPattern` (`scrollAx`); global: `SendInput` | CGEvent |
| `drag` | só global (`SendInput`) | só global |
| `keys` | só global: `SendInput` por VK e `KEYEVENTF_UNICODE` para texto. O texto no modo dirigido vai pelo `set_value`/`ValuePattern`, com `EM_REPLACESEL` só como fallback em Edit/RichEdit nativo | CGEvent por pid |
| `openApp` | já aberto → traz para a frente; senão caminho, App Paths, atalho do Menu Iniciar ou `shell:AppsFolder` (UWP), esperando a janela | `open -a/-b` |
| `restore` | no-op (não há flag a desligar) | `AXManualAccessibility` |

Sem `SetFocus` em lugar nenhum: no Windows, focar um controle de outro app
**ativa a janela** e rouba o teclado do usuário. Por isso `focus` vira um
no-op de sucesso que só guarda o elemento como alvo da próxima digitação
daquele pid (expira em 10 s).

### Decisão de entrada: o modo dirigido é só UI Automation

Mensagens de janela postadas (`PostMessage` de mouse e teclado) e o truque dos
modificadores (`AttachThreadInput` + `SetKeyboardState`) falham sem avisar em
Chromium, UWP e WPF e são o padrão que EDR marca como suspeito. Por isso, como
no macOS (Fase 0), o modo dirigido vai **só pela UIA**:

1. Elemento por índice: padrão de UIA (`press`: Invoke, Toggle, SelectionItem,
   ExpandCollapse).
2. Ponto: `hit` + padrão de UIA no elemento sob o ponto.
3. Sem padrão: erro explicando que o modo dirigido só clica em controles, e
   oferecendo o ponteiro global.
4. Ponteiro global (opt-in nas Preferências): `SendInput`, que move o cursor
   real e traz o app para a frente, com a faixa avisando.

`capabilities().messageMouse` fica `false` no driver do Windows (o caminho
genérico em `act.ts` continua coberto por teste, caso o Stage 0 mostre que vale
ligar para algum tipo de app). O texto em segundo plano vai por `set_value`
(ValuePattern) e, em campos Edit/RichEdit nativos sem ValuePattern, por
`EM_REPLACESEL`. `focus` nunca usa `SetFocus`.

## Stages

### Stage 0 — medição (portão) ⏳ falta rodar num Windows

`node apps/desktop/scripts/cu-probe-win.mjs` (ver o cabeçalho do script). Ele
sobe o mesmo host, abre os apps de teste e grava um relatório JSON + texto.

**Latência**

| Medida | Meta |
|---|---|
| Árvore do Chrome (~1500 nós), com `CacheRequest` | < 800 ms |
| A mesma árvore sem `CacheRequest` (comparação) | registrar |
| Captura do Chrome **coberto**: `PrintWindow` vs `CopyFromScreen` | < 150 ms, e a imagem é a do Chrome |
| Clique (elemento por `ref`) | < 150 ms |
| Partida do host (`Add-Type`) | registrar (paga uma vez) |

**Entrada em segundo plano, por tipo de app** — o ponto que a análise original
esquecia. No macOS a Fase 0 mostrou que mouse e rolagem por pid eram ignorados e
o modo dirigido teve de ir todo pela acessibilidade. No Windows, Chromium, UWP
e WPF podem ignorar mensagens de mouse sintéticas ou não levar `WM_CHAR` ao
elemento com foco. Para cada app — **Bloco de Notas (Win32/RichEdit), Explorer,
Chrome, um app Electron, Calculadora (UWP), um app WPF, Excel** — com a janela
**atrás de outra** (o probe também mede as mensagens de janela como
experimento, para decidir se `messageMouse` volta a ser ligado):

| Cenário | Como o probe confere |
|---|---|
| clique por padrão UIA | o estado mudou (Toggle, valor, nova janela) |
| clique por mensagem | idem |
| `WM_CHAR` / `EM_REPLACESEL` / `ValuePattern` | releitura do valor |
| tecla com modificador (`ctrl+a`) por `AttachThreadInput` | seleção lida pelo TextPattern |
| rolagem por `ScrollPattern` e por `WM_MOUSEWHEEL` | `VerticalScrollPercent` mudou |
| o app continuou atrás? | `GetForegroundWindow` não mudou |

**Ambiente**

- PowerShell em Constrained Language Mode → o probe reporta e o host recusa com
  mensagem clara.
- App elevado (abrir um Bloco de Notas como administrador) → `elevated`.
- DPI a 150% num segundo monitor → frame do DWM, `FromPoint` e captura batem
  (o probe clica no centro de um botão no monitor de 150%).
- `desktopCapturer` (Windows Graphics Capture) grava janela coberta? A borda
  amarela aparece?

**Critério de aceite:** todas as latências dentro da meta e uma decisão
registrada por tipo de app: o que funciona em segundo plano, o que exige o
ponteiro global, o que não funciona. Essa tabela vira código (listas por classe
de janela no host) e texto no prompt.

### Stage 1 — contrato ✅

- `ref?: string` no `AxNode` e no `ElementHandle` (+ `nativeRole`); o `act.ts`
  manda `ref` e `path`.
- `window.id` opcional em `TreeRequest`/`element` (o `HWND`); o macOS ignora.
- `keys.ts` por plataforma.
- `capabilities()` honesto: `messageMouse` (mouse por mensagem chega ao app) —
  `false` nos dois; o Stage 0 pode ligar no Windows por tipo de app.
- `perms()` com `notes` (CLM, integridade).
- `AppInfo.elevated`; erros `elevated`, `secureDesktop`, `staleRef`.
- `normalizeRole()` no `format.ts`.
- `scaleFor = 1` no win32.

**Aceite:** macOS sem mudança de comportamento (suíte verde); testes de
`normalizeRole`, `parseKeys('ctrl+s', 'win32')` e do `ref` no `act`.

### Stage 2 — driver e host ✅ (não medido)

- `bridges/windows.ps1` (host), `createPersistentRunner()`, `drivers/windows.ts`.
- `apps`, `tree`, `capture` como na tabela.

**Aceite no Mac:** testes do runner persistente com um processo falso
(correlação por id, timeout que mata e volta, abort, morte do host, linhas
partidas e UTF-8) e do parse do protocolo. **No Windows (Stage 0):** latências.

### Stage 3 — ações ✅ (não medido)

Tudo da tabela de operações. **Aceite no Windows:** a tabela de entrada em
segundo plano do Stage 0 preenchida.

### Stage 4 — fiação ✅

- `computerSupport()` por plataforma e factory de driver em `computer/index.ts`.
- Gates de UI que exigiam darwin: `src/stores/computer-mode.ts`,
  `src/components/appearance-panel.tsx`, `src/components/settings-dialog.tsx`;
  o painel de Preferências mostra "o Windows não pede permissão" no lugar da
  Acessibilidade/Gravação de Tela.
- `safety.ts`: denylist por exe/AUMID (gerenciadores de senha, Segurança do
  Windows, UAC `consent.exe`, Configurações, `CredentialUIBroker.exe`, tela de
  bloqueio) e navegadores por exe.
- `computerStatus` sem `systemPreferences` no Windows.
- Prompt sem "macOS", com permissões e atalhos por plataforma.
- Faixa e painéis: `type: 'panel'` é só do macOS. No Windows, `focusable: false`
  vira `WS_EX_NOACTIVATE` no Electron: clicar no Parar ou num painel **não**
  traz o Orbit para a frente.
- Atalho de pânico: **Ctrl+Shift+.** no Windows. Não colide com atalho do
  sistema (Win+. é o painel de emoji; Ctrl+Shift sozinho troca o layout, mas com
  `.` não). Enquanto o controle está ativo ele é global e "rouba" o atalho de
  apps que o usam (VS Code: breadcrumbs; Word: aumentar fonte é Ctrl+Shift+>).
  A reserva `Ctrl+Shift+Esc` **não** é registrada no Windows: é o Gerenciador
  de Tarefas.

## Riscos

**Aprovação por site nos navegadores.** No macOS a URL vem da `AXWebArea`; a
**UIA não tem URL**. O host lê a barra de endereço do Chromium (Chrome, Edge,
Brave, Vivaldi, Opera: o `Edit` da barra, por `AutomationId`/nome, pelo
`ValuePattern`) **só quando ela não está com foco** — com foco, o valor é o que
está sendo digitado, não a página. Sem esquema (o Chrome esconde `https://`), o
driver completa. Firefox não expõe isso de forma confiável. Quando não há URL, o
Windows **degrada para aprovação por app**, e isso aparece:

- no pedido de aprovação ("vale para TODAS as abas deste navegador");
- no prompt (o agente avisa o usuário antes de trocar de site).

**Entrada em segundo plano.** Mensagens de mouse sintéticas podem ser ignoradas
por Chromium (a renderização pode exigir `WM_POINTER`/foco), UWP (a
`CoreWindow` lê entrada do sistema, não da fila de mensagens) e WPF (lê o
estado do mouse pelo `GetCursorPos`). Modificadores por `PostMessage` não
existem (o app lê `GetKeyState`): o `AttachThreadInput` + `SetKeyboardState` é
um truque que pode falhar. O Stage 0 decide o que fica e o que vai para o
ponteiro global.

**`PrintWindow` preto** em apps com aceleração de GPU (alguns jogos, players,
Chromium com certas flags). Detectamos imagem toda preta e caímos para
`CopyFromScreen` só se a janela está descoberta; senão a observação sai sem
imagem e com o motivo — melhor que mostrar outra janela.

**Gravação.** O `desktopCapturer` usa Windows Graphics Capture e deve pegar a
janela coberta; o `id` da fonte é `window:<HWND>:0`, o mesmo número do nosso
`WindowInfo.id`. O Windows desenha uma **borda amarela** em volta da janela
capturada (no Windows 11 dá para tirar com `IsBorderRequired = false`, que o
Electron não expõe). Confirmar no Stage 0.

**UIA gerenciada.** `System.Windows.Automation` é mais lenta que a COM
`IUIAutomation` e às vezes perde elementos de Chromium. Se o Stage 0 reprovar a
árvore, o próximo passo é falar COM direto do C# (sem mudar o protocolo).

**`Invoke` síncrono.** Um botão que abre diálogo modal pode prender o `Invoke`
até o diálogo fechar; o host chama numa thread com prazo e devolve
`unconfirmed`.

**Antivírus/EDR.** PowerShell com `Add-Type`, `SendInput` e `PrintWindow` em
outros processos parece comportamento de malware para alguns EDRs. Registrar no
Stage 0 se o Defender reclama; a saída de longo prazo é um helper nativo
assinado.

**UIPI e desktop seguro.** Não há como (nem se deve) agir em app elevado ou no
UAC a partir de um processo comum: recusamos com mensagem clara (`elevated`,
`secureDesktop`) e o `consent.exe` está na denylist.

## Como validar

No Mac (o que roda hoje):

```bash
cd apps/desktop && npx tsc --noEmit && npm run lint && npx vitest run
```

No Windows (Stage 0):

```bash
cd apps/desktop && node scripts/cu-probe-win.mjs --out cu-probe-report.json
```
