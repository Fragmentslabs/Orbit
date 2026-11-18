/**
 * What runs INSIDE the document the WebView shows (generated-document preview, source text or
 * converted .docx): outline from the headings, find with highlights, jump and zoom.
 *
 * One script for the three pages, so the viewer chrome (React Native) does not care which one it
 * is looking at. The page answers through `ReactNativeWebView.postMessage` with JSON, which
 * {@link parseDocMessage} reads back.
 */

export interface OutlineEntry {
  id: string
  title: string
  level: number
}

export type DocMessage =
  | { type: 'outline'; items: OutlineEntry[] }
  | { type: 'find'; count: number; index: number }
  /** A PDF page scrolled near the viewport and still has no picture. */
  | { type: 'need'; page: number }

export function parseDocMessage(data: string): DocMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as Record<string, unknown>
  if (msg.type === 'outline' && Array.isArray(msg.items)) {
    const items = msg.items.flatMap((item): OutlineEntry[] => {
      if (!item || typeof item !== 'object') return []
      const { id, title, level } = item as Record<string, unknown>
      return typeof id === 'string' && typeof title === 'string' && typeof level === 'number'
        ? [{ id, title, level }]
        : []
    })
    return { type: 'outline', items }
  }
  if (msg.type === 'find' && typeof msg.count === 'number' && typeof msg.index === 'number') {
    return { type: 'find', count: msg.count, index: msg.index }
  }
  if (msg.type === 'need' && typeof msg.page === 'number' && Number.isInteger(msg.page) && msg.page > 0) {
    return { type: 'need', page: msg.page }
  }
  return null
}

/** Installs `window.__od` (idempotent) and runs `init`. Injected on every page load. */
export const DOC_SCRIPT = `(function () {
  try {
    if (!window.__od) {
      var marks = [];
      var cur = -1;
      var post = function (o) { window.ReactNativeWebView.postMessage(JSON.stringify(o)); };
      var style = document.createElement('style');
      style.textContent = 'mark.od-hit{background:#fde04799;color:inherit;border-radius:2px}mark.od-cur{background:#fb923c;color:#000}';
      (document.head || document.documentElement).appendChild(style);
      var outline = function () {
        var hs = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
        var items = [];
        for (var i = 0; i < hs.length && items.length < 300; i++) {
          var title = (hs[i].textContent || '').replace(/\\s+/g, ' ').trim();
          if (!title) continue;
          if (!hs[i].id) hs[i].id = 'od-h' + i;
          items.push({ id: hs[i].id, title: title.slice(0, 120), level: Number(hs[i].tagName.charAt(1)) });
        }
        return items;
      };
      var clear = function () {
        for (var i = 0; i < marks.length; i++) {
          var m = marks[i];
          var p = m.parentNode;
          if (!p) continue;
          p.replaceChild(document.createTextNode(m.textContent || ''), m);
          p.normalize();
        }
        marks = [];
        cur = -1;
      };
      var go = function (i) {
        if (!marks.length) { post({ type: 'find', count: 0, index: -1 }); return; }
        if (cur >= 0 && marks[cur]) marks[cur].classList.remove('od-cur');
        cur = ((i % marks.length) + marks.length) % marks.length;
        marks[cur].classList.add('od-cur');
        marks[cur].scrollIntoView({ block: 'center', inline: 'nearest' });
        post({ type: 'find', count: marks.length, index: cur });
      };
      window.__od = {
        find: function (q) {
          clear();
          q = (q || '').trim();
          if (q.length < 2) { post({ type: 'find', count: 0, index: -1 }); return; }
          var re = new RegExp(q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'gi');
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
              var t = n.parentNode && n.parentNode.nodeName;
              return t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            }
          });
          var nodes = [];
          while (walker.nextNode()) nodes.push(walker.currentNode);
          for (var i = 0; i < nodes.length && marks.length < 500; i++) {
            var text = nodes[i].nodeValue || '';
            re.lastIndex = 0;
            if (!re.test(text)) continue;
            re.lastIndex = 0;
            var frag = document.createDocumentFragment();
            var last = 0, m;
            while ((m = re.exec(text)) !== null && m[0].length) {
              frag.appendChild(document.createTextNode(text.slice(last, m.index)));
              var mark = document.createElement('mark');
              mark.className = 'od-hit';
              mark.textContent = m[0];
              frag.appendChild(mark);
              marks.push(mark);
              last = m.index + m[0].length;
            }
            frag.appendChild(document.createTextNode(text.slice(last)));
            nodes[i].parentNode.replaceChild(frag, nodes[i]);
          }
          go(0);
        },
        step: function (d) { go(cur + d); },
        clear: function () { clear(); post({ type: 'find', count: 0, index: -1 }); },
        jump: function (id) {
          var el = document.getElementById(id);
          if (el) el.scrollIntoView({ block: 'start' });
        },
        zoom: function (z) { document.documentElement.style.zoom = String(z); },
        init: function () {
          var meta = document.querySelector('meta[name="viewport"]');
          if (!meta) {
            meta = document.createElement('meta');
            meta.setAttribute('name', 'viewport');
            (document.head || document.documentElement).appendChild(meta);
          }
          meta.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, user-scalable=yes');
          post({ type: 'outline', items: outline() });
          var cited = document.querySelector('.cited');
          if (cited) cited.scrollIntoView({ block: 'center' });
        }
      };
    }
    window.__od.init();
  } catch (err) {}
})();
true;`

/** Calls into the page; JSON-encoded so a quote in the query cannot break out of the string. */
export function findScript(query: string): string {
  return `window.__od&&window.__od.find(${JSON.stringify(query)});true;`
}
export function stepScript(direction: 1 | -1): string {
  return `window.__od&&window.__od.step(${direction});true;`
}
export const CLEAR_FIND_SCRIPT = 'window.__od&&window.__od.clear();true;'
export function jumpScript(id: string): string {
  return `window.__od&&window.__od.jump(${JSON.stringify(id)});true;`
}
export function zoomScript(zoom: number): string {
  return `window.__od&&window.__od.zoom(${Number(zoom).toFixed(2)});true;`
}

export const ZOOM_MIN = 0.6
export const ZOOM_MAX = 2.4
export const ZOOM_STEP = 0.2

/** Next zoom level, clamped and free of float drift (0.6 + 0.2 + 0.2 …). */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = Math.round((zoom + direction * ZOOM_STEP) * 100) / 100
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
}
