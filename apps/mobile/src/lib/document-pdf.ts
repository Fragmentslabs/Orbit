import type { DocumentPageImage, DocumentTextView } from '@orbit/companion-client'
import type { SourceHtmlOptions } from './document-source'

/**
 * A PDF source drawn as its pages, the way the desktop's "Original" mode does.
 *
 * The desktop rasterizes the pages (pdfjs in a hidden window) and sends, with each picture, the text
 * positioned as FRACTIONS of the page. The phone draws the picture and puts a transparent text layer
 * over it: the real text is in the pixels, the layer only exists so a long-press selects and copies.
 * The cited stretch and the search are marked on top, from the same positions.
 *
 * What runs inside the WebView lives in {@link PDF_SHELL}; it speaks the same `window.__od` protocol
 * as the other document pages (find / step / clear / jump / zoom / init), so the viewer chrome does
 * not care which page it is looking at.
 */

export type PdfTextItem = DocumentPageImage['items'][number]

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Pages asked per call; the desktop caps it at four. */
export const PDF_BATCH = 3
/** Pages that find prefetches: each decoded picture costs memory in the WebView. */
export const PDF_FIND_PREFETCH = 40

/**
 * Whitespace and case ignored: the PDF breaks a sentence into pieces and the spaces between them are
 * not reliable ("a destination" may arrive as "a", "des", "tino"), so what matches is the glued text.
 */
export function squash(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/** Rectangles of ALL occurrences of the stretch on the page (the desktop's `locateText`). */
export function locateText(items: PdfTextItem[], needle: string, max = 200): Rect[] {
  const target = squash(needle)
  if (target.length < 2 || items.length === 0) return []

  let flat = ''
  const spans: { from: number; to: number; item: PdfTextItem }[] = []
  for (const item of items) {
    const piece = squash(item.text)
    if (!piece) continue
    spans.push({ from: flat.length, to: flat.length + piece.length, item })
    flat += piece
  }

  const rects: Rect[] = []
  let at = flat.indexOf(target)
  while (at >= 0 && rects.length < max) {
    const end = at + target.length
    for (const span of spans) {
      if (span.to <= at || span.from >= end) continue
      const { x, y, width, height } = span.item
      rects.push({ x, y, width, height })
    }
    at = flat.indexOf(target, at + target.length)
  }
  return rects
}

/** The text of the cited lines, the stretch that gets marked on the page. */
export function citedText(
  view: Pick<DocumentTextView, 'pages'>,
  cite: { page: number; fromLine?: number; toLine?: number } | undefined,
): string {
  if (!cite?.fromLine) return ''
  const page = view.pages.find((p) => p.num === cite.page)
  if (!page) return ''
  const to = Math.max(cite.fromLine, cite.toLine ?? cite.fromLine)
  return page.lines.slice(cite.fromLine - 1, to).join(' ')
}

/** Pages that still need fetching around `page`, `PDF_BATCH` at a time, skipping the ones in hand. */
export function pagesToFetch(page: number, total: number, have: (n: number) => boolean): number[] {
  const out: number[] = []
  for (let n = Math.max(1, page); n <= total && out.length < PDF_BATCH; n += 1) {
    if (!have(n)) out.push(n)
    else if (out.length > 0) break
  }
  return out
}

export interface PdfSetup {
  total: number
  /** Width / height of the first page, for the placeholders of the pages not loaded yet. */
  aspect: number
  outline: { id: string; title: string; level: number }[]
  /** The cited page and its text, marked as soon as the page arrives. */
  cite?: { page: number; text: string }
}

export function setupScript(setup: PdfSetup): string {
  return `window.__pdf&&window.__pdf.setup(${JSON.stringify(setup)});true;`
}

export function addPagesScript(pages: DocumentPageImage[]): string {
  return `window.__pdf&&window.__pdf.addPages(${JSON.stringify(pages)});true;`
}

/** The PDF outline as the viewer's outline entries (jump targets are the page containers `pgN`). */
export function pdfOutline(
  items: { title: string; page: number | null; level: number }[],
): PdfSetup['outline'] {
  return items.flatMap((item) =>
    item.page && item.title.trim()
      ? [{ id: `pg${item.page}`, title: item.title.trim().slice(0, 120), level: Math.min(6, Math.max(1, item.level + 1)) }]
      : [],
  )
}

/** The page the WebView draws before any picture arrives: empty sheets that load as they scroll in. */
export function buildPdfShell(colors: SourceHtmlOptions['colors']): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, user-scalable=yes">
<style>
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:8px 8px 40px;background:${colors.background};color:${colors.foreground};font:14px -apple-system,system-ui,sans-serif}
.page{position:relative;width:100%;margin:0 auto 10px;background:#fff;border:1px solid ${colors.border};border-radius:3px;overflow:hidden;aspect-ratio:var(--ar,595/842)}
.page img{position:absolute;inset:0;width:100%;height:100%;display:block;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;pointer-events:none}
.layer{position:absolute;inset:0}
.layer .t{position:absolute;white-space:pre;line-height:1;color:transparent;transform-origin:0 0;-webkit-user-select:text;user-select:text;cursor:text}
.layer .t::selection{background:${colors.highlight}}
.mark{position:absolute;pointer-events:none;border-radius:2px;mix-blend-mode:multiply}
.mark.cited{background:${colors.highlight};box-shadow:0 0 0 1px ${colors.accent}}
.mark.od-hit{background:#fde04799}
.mark.od-cur{background:#fb923c99}
.num{position:absolute;right:6px;bottom:4px;font-size:10px;color:#888;pointer-events:none}
.ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:12px}
</style></head><body><script>
(function () {
  var post = function (o) { window.ReactNativeWebView.postMessage(JSON.stringify(o)); };
  var squash = function (s) { return String(s).replace(/\\s+/g, '').toLowerCase(); };
  var total = 0, outline = [], cite = null, aspect = 595 / 842;
  var pages = {}, found = [], cur = -1, observer = null, asked = {};

  function locate(items, needle, max) {
    var target = squash(needle);
    if (target.length < 2 || !items.length) return [];
    var flat = '', spans = [];
    for (var i = 0; i < items.length; i++) {
      var piece = squash(items[i].text);
      if (!piece) continue;
      spans.push({ from: flat.length, to: flat.length + piece.length, item: items[i] });
      flat += piece;
    }
    var rects = [], at = flat.indexOf(target);
    while (at >= 0 && rects.length < max) {
      var end = at + target.length;
      for (var j = 0; j < spans.length; j++) {
        if (spans[j].to <= at || spans[j].from >= end) continue;
        var it = spans[j].item;
        rects.push({ x: it.x, y: it.y, width: it.width, height: it.height });
      }
      at = flat.indexOf(target, at + target.length);
    }
    return rects;
  }

  function drawRect(page, r, cls) {
    var d = document.createElement('div');
    d.className = 'mark ' + cls;
    d.style.left = r.x * 100 + '%';
    d.style.top = r.y * 100 + '%';
    d.style.width = r.width * 100 + '%';
    d.style.height = r.height * 100 + '%';
    page.el.appendChild(d);
    return d;
  }

  // Sizes the transparent spans over the glyphs: height from the item, width stretched to the measured one.
  function layout(page) {
    var W = page.el.clientWidth, H = page.el.clientHeight;
    if (!W || !H || !page.spans) return;
    for (var i = 0; i < page.spans.length; i++) {
      var s = page.spans[i], it = page.items[i];
      s.style.transform = 'none';
      s.style.fontSize = Math.max(1, it.height * H) + 'px';
      var natural = s.offsetWidth;
      s.style.transform = natural > 0 ? 'scaleX(' + Math.min(4, Math.max(0.2, (it.width * W) / natural)) + ')' : 'none';
    }
  }

  function addPage(p) {
    var page = pages[p.page];
    if (!page || page.loaded) return;
    page.loaded = true;
    page.items = p.items || [];
    page.el.style.setProperty('--ar', p.width + ' / ' + p.height);
    var ph = page.el.querySelector('.ph');
    if (ph) ph.remove();
    var img = document.createElement('img');
    img.src = p.dataUrl;
    img.alt = '';
    page.el.appendChild(img);
    var layer = document.createElement('div');
    layer.className = 'layer';
    page.spans = [];
    for (var i = 0; i < page.items.length; i++) {
      var it = page.items[i];
      var s = document.createElement('span');
      s.className = 't';
      s.textContent = it.text;
      s.style.left = it.x * 100 + '%';
      s.style.top = it.y * 100 + '%';
      layer.appendChild(s);
      page.spans.push(s);
    }
    page.el.appendChild(layer);
    layout(page);
    if (cite && cite.page === p.page && cite.text) {
      var rects = locate(page.items, cite.text, 200);
      if (!rects.length) rects = locate(page.items, cite.text.slice(0, 80), 200);
      for (var r = 0; r < rects.length; r++) drawRect(page, rects[r], 'cited');
      if (!cite.done) {
        cite.done = true;
        // The layout settles after the picture and the first paint: ask again for a moment, unless
        // the person already moved (a touch or a wheel turn cancels it).
        var reveal = function () {
          if (cite.stop) return;
          var first = page.el.querySelector('.mark.cited');
          (first || page.el).scrollIntoView({ block: 'center' });
        };
        var stop = function () { cite.stop = true; };
        window.addEventListener('touchstart', stop, { once: true, passive: true });
        window.addEventListener('wheel', stop, { once: true, passive: true });
        reveal();
        requestAnimationFrame(reveal);
        img.addEventListener('load', reveal);
        setTimeout(reveal, 400);
        setTimeout(function () { cite.stop = true; }, 1500);
      }
    }
  }

  function clearFind() {
    var hits = document.querySelectorAll('.mark.od-hit');
    for (var i = 0; i < hits.length; i++) hits[i].remove();
    found = [];
    cur = -1;
  }

  function go(i) {
    if (!found.length) { post({ type: 'find', count: 0, index: -1 }); return; }
    if (cur >= 0 && found[cur]) found[cur].classList.remove('od-cur');
    cur = ((i % found.length) + found.length) % found.length;
    found[cur].classList.add('od-cur');
    found[cur].scrollIntoView({ block: 'center', inline: 'nearest' });
    post({ type: 'find', count: found.length, index: cur });
  }

  window.__pdf = {
    setup: function (o) {
      total = o.total; aspect = o.aspect || aspect; outline = o.outline || []; cite = o.cite || null;
      document.documentElement.style.setProperty('--ar', '1 / ' + (1 / aspect));
      document.body.innerHTML = '';
      pages = {};
      var io = 'IntersectionObserver' in window;
      if (io) {
        observer = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (!entries[i].isIntersecting) continue;
            var n = Number(entries[i].target.getAttribute('data-n'));
            if (pages[n] && !pages[n].loaded && !asked[n]) { asked[n] = true; post({ type: 'need', page: n }); }
          }
        }, { rootMargin: '1500px 0px' });
      }
      for (var n = 1; n <= total; n++) {
        var el = document.createElement('div');
        el.className = 'page';
        el.id = 'pg' + n;
        el.setAttribute('data-n', String(n));
        el.style.setProperty('--ar', aspect + ' / 1');
        var ph = document.createElement('div');
        ph.className = 'ph';
        ph.textContent = String(n);
        el.appendChild(ph);
        document.body.appendChild(el);
        pages[n] = { el: el, loaded: false };
        if (observer) observer.observe(el);
      }
      if (cite && pages[cite.page]) pages[cite.page].el.scrollIntoView({ block: 'start' });
      post({ type: 'outline', items: outline });
    },
    addPages: function (list) {
      for (var i = 0; i < list.length; i++) addPage(list[i]);
    }
  };

  window.__od = {
    find: function (q) {
      clearFind();
      q = (q || '').trim();
      if (q.length < 2) { post({ type: 'find', count: 0, index: -1 }); return; }
      var order = Object.keys(pages).map(Number).sort(function (a, b) { return a - b; });
      for (var i = 0; i < order.length && found.length < 500; i++) {
        var page = pages[order[i]];
        if (!page.loaded) continue;
        var rects = locate(page.items, q, 200);
        for (var r = 0; r < rects.length; r++) found.push(drawRect(page, rects[r], 'od-hit'));
      }
      go(0);
    },
    step: function (d) { go(cur + d); },
    clear: function () { clearFind(); post({ type: 'find', count: 0, index: -1 }); },
    jump: function (id) {
      var el = document.getElementById(id);
      if (el) el.scrollIntoView({ block: 'start' });
    },
    zoom: function (z) { document.documentElement.style.zoom = String(z); },
    init: function () {
      var meta = document.querySelector('meta[name="viewport"]');
      if (meta) meta.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, user-scalable=yes');
      if (outline.length) post({ type: 'outline', items: outline });
    }
  };

  window.addEventListener('resize', function () {
    for (var n in pages) if (pages[n].loaded) layout(pages[n]);
  });
})();
</script></body></html>`
}
