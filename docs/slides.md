# Slides no painel

Uma aba `slides` no painel direito onde o agente escreve um deck e a pessoa
apresenta: palco 16:9, teclado, lista de slides, notas do apresentador e tela
cheia. É a terceira aba do mesmo molde — Design (`canvas.json` + artboards) e
Motion (composição + player) —, com um contrato de autoria mais barato que os
dois.

## Status

**Implementado**, com download em PDF e item próprio na galeria (Mídia). O deck
é **um arquivo** (`index.html` com um `<section class="slide">` por slide), o
app injeta o runtime de navegação e o agente tem duas portas de escrita.

## Por que um arquivo, e não um canvas

O Design custa caro para dirigir: `canvas.json` + um `.html` por artboard +
coordenadas `x/y/w/h` inventadas. Para um deck de cinco telas são ~7 chamadas de
tool até o usuário ver a primeira. Slide não precisa de editor visual — ninguém
arrasta um bullet point —, então o contrato pode ser o de um artifact: **o
conteúdo inteiro numa chamada**.

Isso não tira o valor do Design: ele continua sendo o lugar de ajustar posição.
Slide é narrativa, e narrativa se escreve, não se arrasta.

## O contrato do deck

```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="orbit-slides" content="width=1280,height=720">
  <title>Meu deck</title>
  <style>/* o CSS do deck */</style>
</head>
<body>
  <section class="slide" data-title="Capa">
    <h1>Orbit</h1>
    <aside class="notes">o que DIZER neste slide</aside>
  </section>
  <section class="slide"><h2>Segundo</h2></section>
</body>
</html>
```

- **Um `<section class="slide">` por slide**, na ordem do documento. Seção
  aninhada pertence ao slide que a contém.
- **`data-title`** nomeia o slide na lista da aba; sem ele vale o primeiro
  `h1/h2/h3`, e sem heading o rótulo é "Slide N".
- **Notas**: `<aside class="notes">texto</aside>` (vale o texto do elemento) ou
  `data-notes="texto"` (vale o valor do atributo). Não aparecem no palco.
- **`<meta name="orbit-slides">`** declara o palco; o padrão é 1280×720.
- **Sem JavaScript no deck.** Navegação, escala, lista, notas e tela cheia são
  do app — é o que faz o deck ser conteúdo e continuar abrindo depois de
  qualquer mudança na aba.
- **`?print=1`** na URL serve o mesmo deck empilhado, um slide por página — a
  base do export em PDF, que ainda não existe na interface.

## As duas portas

| | modo código | modo conversa |
| --- | --- | --- |
| tool | `slides_preview({ path })` | `slides_write({ title, slides[] })` |
| quem escreve | o agente, com `write`/`edit` no arquivo | o main, a partir do array |
| onde mora | na pasta do projeto (versionável) | `orbit-data/slides/<sessão>/<slug>/` |
| quando usar | deck que faz parte do repositório | "me faz uma apresentação" |

`slides_write` monta o documento com o tema da casa (fundo escuro, acento
dourado, tipografia grande) e classes de apoio — `.cover`, `.section`,
`.kicker`, `.lead`, `.grid.cols-2/3/4`, `.card`, `.stat`, `.quote`, `.pill`.
É o caminho rápido: uma chamada, sem `write` intermediário.

As duas devolvem o mesmo relatório: quantos slides, o título de cada um e quais
têm notas — lido do arquivo no main, sem janela offscreen (o deck é HTML
estático, ao contrário do motion).

## Arquitetura

```
electron/lib/slides/
  slides-runtime.ts   o script injetado no <head>: palco, escala, teclado, ponte
  slides-store.ts     registro id → pasta/entrada, scheme orbit-slides://, watcher
  slides-open.ts      registra, abre a aba e relata o deck
  slides-gallery.ts   a capa (o slide 1) e o registro na galeria
  slides-deck.ts      leitura do HTML (títulos, notas, contagem) — puro
  deck-template.ts    o molde do slides_write (tema + montagem) — puro
electron/lib/tools/
  slides.ts           slides_preview (modo código)
  slides-chat.ts      slides_write (modo conversa)
src/components/
  slides-tab.tsx      o palco, a lista, as notas e o transporte
```

O scheme `orbit-slides://<id>/<caminho>` serve a pasta registrada (nada fora
dela) e injeta o runtime no HTML; `?raw` devolve o fonte como está no disco.
O watcher (`slides:changed`) recarrega o palco quando o arquivo muda, voltando
ao mesmo slide — o mesmo ciclo do motion/design.

A ponte é postMessage com `source: "orbit-slides"` (iframe `sandbox="allow-scripts"`,
sem `allow-same-origin`):

- deck → painel: `ready` (total, palco, títulos, notas), `change` (índice),
  `error`, `request-fullscreen`
- painel → deck: `go(index)`, `next`, `prev`

## Armadilhas que o teste pegou

1. **O runtime é o primeiro script do `<head>`** — roda antes de existir
   `<body>`. Sem esperar o `DOMContentLoaded`, `querySelectorAll('.slide')`
   devolve vazio e o palco nasce em branco. Tudo o que toca no documento vive
   dentro de `start()`.
2. **O palco é maior que a janela de um painel estreito.** Grid/flex não
   centralizam um item maior que o container (ele vaza para a direita): o palco
   é ancorado em `left/top: 50%` e centralizado com `translate(-50%,-50%)`
   antes do `scale`.
3. **`resize` não basta.** O iframe é redimensionado pelo painel, e nem toda
   mudança de layout chega como evento na janela dele — daí o `ResizeObserver`
   no viewport.
4. **A string do runtime não pode ter template literal.** Uma crase dentro do
   script fecha a string do módulo. Há um teste que compila o texto com
   `new Function`.

## Baixar em PDF

O PDF é a **impressão do próprio `index.html`** — não existe um segundo formato.
O runtime tem um modo `?print=1` que empilha os slides (um por página, `@page`
com o tamanho do palco), e o main abre uma janela oculta e chama o `printToPDF`
do Chromium. Mesmo caminho do documento (`media.ts:renderPdf`), sem biblioteca de
geração de PDF no projeto.

Botão de download no cabeçalho da aba → `slides:export` → `renderSlidesPdf`
(`electron/lib/slides/slides-export.ts`) → diálogo de salvar. Cancelar não é
erro. O nome sugerido é o título do deck.

### A unidade do `pageSize` mente

A tabela de tipos do Electron diz que um `pageSize` custom é um `Size` em
**microns**. Na 44.3.0 (macOS) não é: o valor é lido como **polegadas**, e
multiplicado por 72. Verificado imprimindo de verdade:

| Valor passado | O que sai |
|---|---|
| `{ width: 338667, height: 190500 }` (microns) | falha: `Printing failed` |
| `{ width: 595, height: 842 }` | página de 595×842 **polegadas** (MediaBox 60624×42840) |
| `{ width: 1280/96, height: 720/96 }` | **MediaBox `[0 0 960 540]`** — 16:9 exato, sem margem |

Um tamanho grande demais também estoura um limite de 16 bits da caixa:
960×540 polegadas = 69120 pt > 65535 pt — daí o "Printing failed" em vez de uma
página gigante.

Como a documentação promete uma unidade e a implementação usa outra, o export
**mede o PDF que saiu** (pdf-lib) e, se a página não for o tamanho pedido, refaz
na outra unidade. Um Electron futuro que conserte a unidade não devolve um deck
de 0,35 mm: cai no retry. `slides-export.test.ts` fixa os dois mundos.

## Na galeria (Mídia)

O deck entra como um tipo próprio (`kind: "slides"`), com a capa tirada do
**primeiro slide** — e ela sai barata: o deck é servido com o runtime injetado,
que monta o palco e já mostra o slide 1; fotografar uma janela offscreen do
tamanho declarado no meta dá a capa exata, **sem seek nem medição de camada**.

- `slides-gallery.ts` tem o `registerSlidesCover` e o hook de exclusão; quem
  chama o registro é o `slides_open`, depois de confirmar que o deck TEM slides
  (capa de palco vazio não serve).
- `slides_write` substitui o deck inteiro, então a capa é refeita a cada
  escrita (`refreshCover`); no modo código ela só é capturada quando o item
  ainda não existe — o deck é fonte, não entregável nosso.
- Excluir na galeria apaga a pasta do deck, com as travas de
  `deleteSlidesDeck`: a pasta tem de existir, conter a entrada do deck e estar
  DENTRO da raiz do chat ou do projeto que a registrou — **nunca ser o projeto**.
  Os PDFs já baixados ficam.
- O clique no tile reabre a aba Slides (o mesmo `slides:open` do card do chat).

O arquivo da capa é `dck_<id>.png` em `artifactsDir()`, como `dsn_`/`mot_`; o
prefixo é diferente do `sld_` do deck de propósito, para não misturar os dois
espaços de nome na hora de depurar.

## O que ainda não tem

- Miniaturas de verdade na LISTA do palco (a galeria já tem capa): o iframe é
  opaco, então cada miniatura exigiria uma captura por slide. Hoje a lista
  mostra título + número, que é o que se procura ao navegar.
- Janela do apresentador (notas + próximo slide + cronômetro numa segunda tela).
- Transições entre slides.
