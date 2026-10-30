/**
 * The template of a deck created by the agent (chat mode, `slides_write`).
 *
 * It lives here, and not next to the tool, because it is PURE: building the
 * document is a function from (title, slides) to HTML, without touching disk or
 * `app`. That is what the tests cover — the file the tool writes is exactly what
 * this function returns.
 *
 * The theme is ours: dark background, gold accent, large typography and helper
 * classes (`.cover`, `.section`, `.grid`, `.card`, `.stat`, `.quote`, `.pill`)
 * so the model can build good-looking slides without writing CSS. Whoever wants
 * full control writes the whole HTML and uses `slides_preview` on the file.
 */

export interface DeckSlideInput {
  /** Slide name in the tab list (default: the first h1/h2/h3). */
  title?: string
  /** The slide body in HTML — without `<section>` (the template adds it), without `<script>`. */
  html: string
  /** Presenter notes (what to SAY), off the stage. */
  notes?: string
}

export function escapeDeckText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** CSS of our theme. It goes in the deck's `<style>` — the runtime paints nothing. */
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
 * Builds the deck document. Pure and deterministic — the test covers section
 * count, title, notes and the stage `<meta>`.
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
