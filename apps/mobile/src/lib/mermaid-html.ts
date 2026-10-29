/**
 * O documento HTML que desenha um diagrama mermaid dentro do WebView.
 *
 * Fica fora do componente de propósito: é aqui que mora a única parte com
 * risco de verdade — o texto do diagrama é escrito dentro de um `<script>`, e
 * um `</script>` no meio dele encerraria o bloco e transformaria o resto em
 * HTML executável. Por isso o texto entra sempre por `JSON.stringify` com `<`
 * escapado, e essa é a parte que o teste cobre.
 *
 * A lib chega por parâmetro, já lida do asset do app (`loadMermaidSource`), e
 * vai embutida no documento: o WebView não enxerga o bundle JS do React Native,
 * e buscar de CDN deixaria o desenho dependente de internet — que este app não
 * deveria exigir, já que ele fala com o desktop na LAN. O preço é um documento
 * de ~3,4 MB por diagrama; o componente só monta um quando há diagrama.
 */

export interface MermaidHtmlOptions {
  /** Tema do app — o diagrama acompanha claro/escuro em vez de ficar branco. */
  dark: boolean
  /** O código da lib, de `loadMermaidSource()`. Vazio = não desenha. */
  lib: string
}

/**
 * JSON seguro para dentro de um `<script>`.
 *
 * `JSON.stringify` já resolve aspas e barras; falta o `<`, que é o que permite
 * a sequência `</script>`. `\u003c` é JSON válido e o parser do navegador
 * devolve o mesmo caractere, então o diagrama chega intacto.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * O mesmo problema, do outro lado: a lib é JS e não pode ser JSON-escapada (o
 * `\u003c` fora de string quebraria o código). Aqui só a sequência que fecha a
 * tag precisa sair: `<\/script` continua sendo a mesma string dentro de um
 * literal de JS — e dentro de uma regex `\/` também é uma barra.
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

  // Lib ausente = o asset não foi lido ou não parseou. O RN troca o diagrama
  // pelo código-fonte, que é o que já acontecia antes deste componente existir.
  if (!window.mermaid) { fail('mermaid não carregou'); return; }

  window.mermaid.initialize({
    startOnLoad: false,
    theme: ${dark ? "'dark'" : "'neutral'"},
    securityLevel: 'strict',
    fontFamily: '-apple-system, system-ui, sans-serif'
  });

  window.mermaid.render('orbit-diagram', source).then(function (result) {
    document.getElementById('d').innerHTML = result.svg;
    // A altura só existe depois do layout: um \`sequenceDiagram\` é bem mais
    // alto que um \`graph TD\` de duas caixas, e o host precisa acompanhar.
    requestAnimationFrame(function () {
      var height = document.getElementById('d').getBoundingClientRect().height;
      send({ type: 'height', height: Math.ceil(height) });
    });
  }).catch(function (error) {
    fail((error && error.message) || 'diagrama inválido');
  });
})();
</script>
</body>
</html>`
}
