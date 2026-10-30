/**
 * The HTML document that draws a mermaid diagram inside the WebView.
 *
 * It lives outside the component on purpose: this is where the only part with
 * real risk lives — the diagram text is written inside a `<script>`, and
 * a `</script>` in the middle of it would end the block and turn the rest into
 * executable HTML. That is why the text always enters via `JSON.stringify` with `<`
 * escaped, and that is the part the test covers.
 *
 * The lib arrives as a parameter, already read from the app asset (`loadMermaidSource`), and
 * goes embedded in the document: the WebView cannot see the JS bundle of React Native,
 * and fetching from a CDN would leave the drawing dependent on the internet — which this app should
 * not require, since it talks to the desktop on the LAN. The price is a document
 * of ~3.4 MB per diagram; the component only mounts one when there is a diagram.
 */

export interface MermaidHtmlOptions {
  /** App theme — the diagram follows light/dark instead of staying white. */
  dark: boolean
  /** The lib code, from `loadMermaidSource()`. Empty = does not draw. */
  lib: string
  /** Message shown on the page when the drawing fails (already translated). */
  failMessage?: string
}

/**
 * JSON safe to go inside a `<script>`.
 *
 * `JSON.stringify` already handles quotes and backslashes; what is missing is `<`, which is what allows
 * the `</script>` sequence. `\u003c` is valid JSON and the browser parser
 * returns the same character, so the diagram arrives intact.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * The same problem, on the other side: the lib is JS and cannot be JSON-escaped (the
 * `\u003c` outside a string would break the code). Here only the sequence that closes the
 * tag needs to go: `<\/script` is still the same string inside a
 * JS literal — and inside a regex `\/` is also a slash.
 */
function escapeScriptEnd(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script')
}

export function buildMermaidHtml(code: string, options: MermaidHtmlOptions): string {
  const { dark, lib } = options
  const fallbackColor = dark ? '#a1a1aa' : '#52525b'

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { display: flex; justify-content: center; background: transparent; }
  #d { width: 100%; padding: 10px; box-sizing: border-box; }
  #d svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  #e { font: 13px -apple-system, system-ui, sans-serif; padding: 14px; color: ${fallbackColor}; }
</style>
</head>
<body>
<div id="d"></div>
<div id="e" hidden></div>
<script>${escapeScriptEnd(lib)}</script>
<script>
(function () {
  var send = function (payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  };
  var fail = function (message) {
    var box = document.getElementById('e');
    box.hidden = false;
    box.textContent = message;
    send({ type: 'error', message: String(message) });
  };

  var source = ${jsonForScript(code)};

  // Missing lib = the asset was not read or did not parse. RN swaps the diagram
  // for the source code, which is what already happened before this component existed.
  if (!window.mermaid) { fail(${jsonForScript(options.failMessage ?? '')}); return; }

  window.mermaid.initialize({
    startOnLoad: false,
    theme: ${dark ? "'dark'" : "'neutral'"},
    securityLevel: 'strict',
    fontFamily: '-apple-system, system-ui, sans-serif'
  });

  window.mermaid.render('orbit-diagram', source).then(function (result) {
    document.getElementById('d').innerHTML = result.svg;
    // The height only exists after the layout: a \`sequenceDiagram\` is far taller
    // than a \`graph TD\` with two boxes, and the host has to follow.
    requestAnimationFrame(function () {
      var height = document.getElementById('d').getBoundingClientRect().height;
      send({ type: 'height', height: Math.ceil(height) });
    });
  }).catch(function (error) {
    fail((error && error.message) || ${jsonForScript(options.failMessage ?? '')});
  });
})();
</script>
</body>
</html>`
}
