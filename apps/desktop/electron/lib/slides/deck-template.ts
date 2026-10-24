/**
 * O molde de um deck criado pelo agente (modo chat, `slides_write`).
 *
 * Mora aqui, e não junto da tool, porque é PURO: montar o documento é uma
 * função de (título, slides) para HTML, sem tocar em disco nem em `app`. É o
 * que os testes cobrem — o arquivo que a tool grava é exatamente o que esta
 * função devolve.
 *
 * O tema é da casa: fundo escuro, acento dourado, tipografia grande e classes
 * de apoio (`.cover`, `.section`, `.grid`, `.card`, `.stat`, `.quote`, `.pill`)
 * para o modelo montar slides bonitos sem escrever CSS. Quem quer controle
 * total escreve o HTML inteiro e usa `slides_preview` sobre o arquivo.
 */

export interface DeckSlideInput {
  /** Nome do slide na lista da aba (padrão: o primeiro h1/h2/h3). */
  title?: string
  /** O corpo do slide em HTML — sem `<section>` (o molde põe), sem `<script>`. */
  html: string
  /** Notas do apresentador (o que DIZER), fora do palco. */
  notes?: string
}

export function escapeDeckText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** CSS do tema da casa. Fica no `<style>` do deck — o runtime não pinta nada. */
export const DECK_CSS = `
:root{
  --slide-bg:#12100d;
  --slide-fg:#f4f0e7;
  --slide-muted:#a8a094;
  --slide-accent:#f5c542;
  --slide-line:rgba(244,240,231,.12);
  --slide-surface:rgba(244,240,231,.045);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--slide-bg)}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;-webkit-font-smoothing:antialiased}
.slide{
  position:relative;width:100%;height:100%;padding:64px 80px;
  display:flex;flex-direction:column;justify-content:center;gap:22px;
  background:var(--slide-bg);color:var(--slide-fg);overflow:hidden;
}
.slide::after{
  content:attr(data-index);position:absolute;right:40px;bottom:28px;
  font-size:13px;letter-spacing:.14em;color:var(--slide-muted);opacity:.55;
}
h1,h2,h3{margin:0;letter-spacing:-.03em;line-height:1.04;font-weight:600}
h1{font-size:60px}
h2{font-size:40px}
h3{font-size:26px}
p{margin:0;font-size:21px;line-height:1.5;color:var(--slide-muted);max-width:62ch}
strong{color:var(--slide-fg);font-weight:600}
a{color:var(--slide-accent);text-decoration:none}
ul,ol{margin:0;padding-left:1.1em;display:flex;flex-direction:column;gap:12px}
li{font-size:20px;line-height:1.45;color:var(--slide-muted)}
li::marker{color:var(--slide-accent)}
.kicker{
  font-size:13px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--slide-accent);font-weight:600;
}
.lead{font-size:26px;line-height:1.4;color:var(--slide-fg);max-width:56ch}
.muted{color:var(--slide-muted)}
.accent{color:var(--slide-accent)}
.cover{align-items:flex-start;justify-content:center;gap:26px}
.cover h1{font-size:96px;letter-spacing:-.045em}
.section{align-items:flex-start;justify-content:center}
.section h2{font-size:52px}
.grid{display:grid;gap:18px;margin-top:8px}
.cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}
.card{
  border:1px solid var(--slide-line);border-radius:16px;padding:22px 24px;
  background:var(--slide-surface);display:flex;flex-direction:column;gap:8px;
}
.card h3{font-size:20px}
.card p{font-size:16px;line-height:1.45}
.stat{display:flex;flex-direction:column;gap:4px}
.stat-value{font-size:48px;font-weight:600;letter-spacing:-.03em;color:var(--slide-accent)}
.stat-label{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--slide-muted)}
.quote{font-size:30px;line-height:1.32;letter-spacing:-.02em;max-width:26ch}
.quote::before{content:"\\201C";color:var(--slide-accent)}
.rule{height:1px;background:var(--slide-line);margin:6px 0}
.pill{
  display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;
  border:1px solid var(--slide-line);font-size:13px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--slide-muted);width:max-content;
}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;color:var(--slide-accent)}
`.trim()

/**
 * Monta o documento do deck. Puro e determinístico — o teste cobre contagem de
 * seções, título, notas e o `<meta>` do palco.
 */
export function buildDeckHtml(input: { title: string; slides: DeckSlideInput[]; lang?: string }): string {
  const sections = input.slides
    .map((slide) => {
      const attrs = slide.title ? ` data-title="${escapeDeckText(slide.title)}"` : ''
      const notes = slide.notes ? `\n  <aside class="notes">${escapeDeckText(slide.notes)}</aside>` : ''
      return `<section class="slide"${attrs}>\n  ${slide.html.trim()}${notes}\n</section>`
    })
    .join('\n\n')

  return `<!doctype html>
<html lang="${escapeDeckText(input.lang ?? 'pt-BR')}">
<head>
<meta charset="utf-8">
<meta name="orbit-slides" content="width=1280,height=720">
<title>${escapeDeckText(input.title)}</title>
<style>
${DECK_CSS}
</style>
</head>
<body>
${sections}
</body>
</html>
`
}
