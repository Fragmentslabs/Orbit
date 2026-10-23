// Bridge macOS do Computer Use: JXA (osascript -l JavaScript) com a ponte
// ObjC. Uma invocação = uma operação: o JSON de entrada chega em argv[0] e a
// resposta sai como o retorno de run() (stdout). Nada aqui guarda estado entre
// chamadas — AXUIElementRef não sobrevive ao processo, por isso o elemento é
// re-encontrado pelo caminho (índices de AXChildren a partir da janela).
//
// Este arquivo é importado com ?raw pelo driver e também lido pela probe da
// Fase 0 (scripts/cu-probe.mjs): o código medido é o mesmo que roda no app.

ObjC.import('AppKit')
ObjC.import('ApplicationServices')
ObjC.import('CoreGraphics')

// A assinatura padrão pede UniChar*, e o JXA não converte string JS para isso:
// passada direto, a string some e o evento digita a tecla 0 ("a") — Fase 0.
// Religada com void*, aceita os bytes UTF-16 de um NSData.
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void*', 'unsigned long', 'void*']])
var UTF16LE = 0x94000100

var AX_OK = 0
var AX_API_DISABLED = -25211
var AX_CANNOT_COMPLETE = -25204

// Uma ida ao app por nó: AXUIElementCopyMultipleAttributeValues traz tudo de
// uma vez. A ordem importa — read() lê por posição. AXURL fica de fora: só
// links e áreas web têm, e pedi-la em todo nó custava uma conversão por nó.
var ATTRS = [
  'AXRole', 'AXSubrole', 'AXTitle', 'AXValue', 'AXDescription', 'AXPosition', 'AXSize',
  'AXEnabled', 'AXFocused', 'AXChildren', 'AXPlaceholderValue', 'AXHelp', 'AXSelected',
]
var URL_ROLES = { AXLink: 1, AXWebArea: 1 }

// Papéis que nunca têm ação útil: pular a CopyActionNames economiza uma ida
// ao app por nó, que é o custo dominante da árvore.
var NO_ACTION_ROLES = { AXStaticText: 1, AXScrollArea: 1, AXSplitter: 1, AXLayoutArea: 1, AXUnknown: 1 }

function fail(code, message) {
  var e = new Error(message)
  e.code = code
  throw e
}

function nsString(o) {
  try {
    if (o.isKindOfClass($.NSString)) return ObjC.unwrap(o)
    if (o.isKindOfClass($.NSAttributedString)) return ObjC.unwrap(o.string)
  } catch (_) {}
  return null
}

// Converte o que veio do AX para JS. AXValue (ponto, tamanho, erro) não tem
// conversão direta no JXA — a descrição textual dele é estável e basta.
function toJs(o) {
  if (!o || o.isNil && o.isNil()) return null
  var s = nsString(o)
  if (s !== null) return s
  try {
    if (o.isKindOfClass($.NSNumber)) return ObjC.unwrap(o)
    if (o.isKindOfClass($.NSURL)) return ObjC.unwrap(o.absoluteString)
    if (o.isKindOfClass($.NSArray)) return { array: o }
  } catch (_) {}
  var d = ''
  try { d = ObjC.unwrap(o.description) } catch (_) { return null }
  var m
  if ((m = /x:([-\d.]+) y:([-\d.]+)/.exec(d))) return { x: parseFloat(m[1]), y: parseFloat(m[2]) }
  if ((m = /w:([-\d.]+) h:([-\d.]+)/.exec(d))) return { w: parseFloat(m[1]), h: parseFloat(m[2]) }
  if (/kAXValueAXErrorType/.test(d)) return null
  if (/AXUIElement/.test(d)) return { element: o }
  return null
}

function copyAttr(el, name) {
  var out = Ref()
  var err = $.AXUIElementCopyAttributeValue(el, $(name), out)
  if (err !== AX_OK) return { err: err, value: null }
  return { err: AX_OK, value: toJs(ObjC.castRefToObject(out[0])) }
}

function clip(text, limit) {
  if (typeof text !== 'string') return null
  var single = text.replace(/\s+/g, ' ').trim()
  if (!single) return null
  return single.length > limit ? single.slice(0, limit) + '…' : single
}

function actionNames(el) {
  var out = Ref()
  if ($.AXUIElementCopyActionNames(el, out) !== AX_OK) return []
  // Só strings: o deepUnwrap converte o array inteiro numa chamada.
  var names = ObjC.deepUnwrap(ObjC.castRefToObject(out[0]))
  return Array.isArray(names) ? names : []
}

// Ponto/tamanho chegam como AXValue, que o JXA não converte: a descrição
// textual dele é estável ("x:120 y:80", "w:300 h:20").
function struct(o) {
  if (o === null || o === undefined || typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') return null
  var d = ''
  try { d = ObjC.unwrap(o.description) } catch (_) { return null }
  var m
  if ((m = /x:([-\d.]+) y:([-\d.]+)/.exec(d))) return { x: parseFloat(m[1]), y: parseFloat(m[2]) }
  if ((m = /w:([-\d.]+) h:([-\d.]+)/.exec(d))) return { w: parseFloat(m[1]), h: parseFloat(m[2]) }
  return null
}

// Lê os atributos de um elemento numa única chamada. Campo seguro nunca tem o
// valor devolvido — nem para o driver, nem para o modelo.
//
// Conversão: um unwrap raso do array e um unwrap por item. Strings, números,
// booleanos e a lista de filhos saem prontos; o que sobra objeto é AXValue
// (ponto, tamanho ou atributo ausente). Medido na Fase 0: 4x mais rápido do que
// testar a classe de cada valor, que era 65% do tempo da árvore.
function read(el, textLimit, withActions) {
  var out = Ref()
  var err = $.AXUIElementCopyMultipleAttributeValues(el, $(ATTRS), 0, out)
  if (err !== AX_OK) return { err: err }
  var raw = ObjC.unwrap(ObjC.castRefToObject(out[0]))
  var v = []
  for (var i = 0; i < raw.length; i++) {
    var u = ObjC.unwrap(raw[i])
    v.push(u === undefined ? raw[i] : u)
  }
  var str = function (x) { return typeof x === 'string' ? x : null }
  var role = str(v[0]) || 'AXUnknown'
  var subrole = str(v[1])
  var secure = subrole === 'AXSecureTextField' || role === 'AXSecureTextField'
  var value = v[3]
  if (secure) value = null
  else if (typeof value === 'number' || typeof value === 'boolean') value = String(value)
  else if (typeof value === 'string') value = clip(value, textLimit)
  else value = clip(value ? nsString(raw[3]) : null, textLimit)
  // Do valor bruto: o unwrap de um AXValue não é undefined, é um {} vazio.
  var pos = struct(raw[5])
  var size = struct(raw[6])
  var children = Array.isArray(v[9]) ? v[9] : null
  var url = null
  if (URL_ROLES[role]) {
    var u2 = copyAttr(el, 'AXURL').value
    url = typeof u2 === 'string' ? u2 : null
  }
  var node = {
    role: role,
    subrole: subrole,
    title: clip(str(v[2]), textLimit),
    value: value,
    desc: clip(str(v[4]), textLimit),
    frame: pos && size && pos.x !== undefined && size.w !== undefined ? [pos.x, pos.y, size.w, size.h] : null,
    enabled: v[7] !== false,
    focused: v[8] === true,
    placeholder: clip(str(v[10]), textLimit),
    help: clip(str(v[11]), textLimit),
    selected: v[12] === true,
    url: url,
    secure: secure,
    childCount: children ? children.length : 0,
    actions: withActions && !NO_ACTION_ROLES[role] ? actionNames(el) : [],
  }
  return { node: node, children: children }
}

function appElement(pid) {
  return $.AXUIElementCreateApplication(pid)
}

// Sem a permissão, o AX devolve erros diferentes conforme a chamada (-25211,
// -25204): a checagem explícita dá um erro só, que o driver sabe explicar.
function requireTrust() {
  var trusted = $.AXIsProcessTrusted()
  if (!(trusted === true || trusted === 1)) fail('axDenied', 'Accessibility permission is not granted to Orbit.')
}

// Timeout de mensageria: sem isto um app travado segura CADA chamada AX por
// ~6 s (padrão do sistema). No elemento system-wide vale para todos.
function setGlobalTimeout(seconds) {
  try { $.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(), seconds) } catch (_) {}
}

function windowsOf(app) {
  var r = copyAttr(app, 'AXWindows')
  if (r.err === AX_API_DISABLED) fail('axDenied', 'Accessibility permission is not granted to Orbit.')
  if (r.err === AX_CANNOT_COMPLETE) fail('axTimeout', 'The app did not answer the accessibility request (busy or frozen).')
  if (!r.value || !r.value.array) return []
  var list = []
  for (var i = 0; i < r.value.array.count; i++) list.push(r.value.array.objectAtIndex(i))
  return list
}

// A janela AX que corresponde à janela do CGWindowList: os dois usam o mesmo
// espaço (pontos, origem no topo do monitor principal), então o frame casa.
function findWindow(pid, target) {
  var app = appElement(pid)
  var wins = windowsOf(app)
  if (!wins.length) fail('windowNotFound', 'The app has no accessible window.')
  var best = null
  var bestScore = Infinity
  for (var i = 0; i < wins.length; i++) {
    var pos = copyAttr(wins[i], 'AXPosition').value
    var size = copyAttr(wins[i], 'AXSize').value
    if (!pos || !size || !target || !target.frame) continue
    var f = target.frame
    var score = Math.abs(pos.x - f[0]) + Math.abs(pos.y - f[1]) + Math.abs(size.w - f[2]) + Math.abs(size.h - f[3])
    if (score < bestScore) { bestScore = score; best = wins[i] }
  }
  if (best && bestScore <= 8) return { app: app, window: best }
  if (target && target.title) {
    for (var j = 0; j < wins.length; j++) {
      if (copyAttr(wins[j], 'AXTitle').value === target.title) return { app: app, window: wins[j] }
    }
  }
  var focused = copyAttr(app, 'AXFocusedWindow').value
  if (focused && focused.element) return { app: app, window: focused.element }
  return { app: app, window: wins[0] }
}

function childAt(el, index) {
  var r = copyAttr(el, 'AXChildren')
  if (!r.value || !r.value.array || index >= r.value.array.count) return null
  return r.value.array.objectAtIndex(index)
}

// Re-caminha o path e confere a identidade: um índice de uma observação velha
// que hoje aponta para outro elemento vira erro, nunca um clique no lugar errado.
function resolvePath(pid, target, path, expect) {
  var found = findWindow(pid, target)
  var el = found.window
  for (var i = 0; i < path.length; i++) {
    el = childAt(el, path[i])
    if (!el) fail('staleIndex', 'The element no longer exists at that position.')
  }
  if (expect) {
    var role = copyAttr(el, 'AXRole').value
    if (expect.role && role !== expect.role) fail('staleIndex', 'The element changed (expected ' + expect.role + ', found ' + role + ').')
    if (expect.title) {
      var title = clip(copyAttr(el, 'AXTitle').value, 500)
      if (title && title !== expect.title) fail('staleIndex', 'The element changed (title differs).')
    }
  }
  return { app: found.app, el: el }
}

// ---------------------------------------------------------------- operações

function opPerms() {
  var trusted = $.AXIsProcessTrusted()
  return { accessibility: trusted === true || trusted === 1 }
}

function opApps() {
  var ws = $.NSWorkspace.sharedWorkspace
  var running = ws.runningApplications
  var front = ws.frontmostApplication
  var frontPid = front ? front.processIdentifier : -1
  var apps = []
  for (var i = 0; i < running.count; i++) {
    var a = running.objectAtIndex(i)
    // activationPolicy chega como string pela ponte.
    if (Number(a.activationPolicy) !== 0) continue
    apps.push({
      pid: a.processIdentifier,
      bundleId: ObjC.unwrap(a.bundleIdentifier) || null,
      name: ObjC.unwrap(a.localizedName) || '',
      active: a.processIdentifier === frontPid,
      hidden: a.hidden === true,
    })
  }
  // Na tela, excluindo elementos da área de trabalho, em ordem de frente para trás.
  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))
  var windows = []
  for (var j = 0; j < list.count; j++) {
    var d = list.objectAtIndex(j)
    if (ObjC.unwrap(d.objectForKey('kCGWindowLayer')) !== 0) continue
    var b = d.objectForKey('kCGWindowBounds')
    var w = ObjC.unwrap(b.objectForKey('Width'))
    var h = ObjC.unwrap(b.objectForKey('Height'))
    if (w < 40 || h < 40) continue
    var alpha = ObjC.unwrap(d.objectForKey('kCGWindowAlpha'))
    if (alpha === 0) continue
    windows.push({
      id: ObjC.unwrap(d.objectForKey('kCGWindowNumber')),
      pid: ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID')),
      // O título só vem com Gravação de Tela concedida; sem ela, null.
      title: ObjC.unwrap(d.objectForKey('kCGWindowName')) || null,
      frame: [ObjC.unwrap(b.objectForKey('X')), ObjC.unwrap(b.objectForKey('Y')), w, h],
    })
  }
  return { apps: apps, windows: windows }
}

// Liga a árvore de acessibilidade de apps Chromium/Electron, que por padrão
// expõem quase nada. AXManualAccessibility é o pedido do Electron e vale para
// qualquer app (os nativos só recusam). AXEnhancedUserInterface é o do Chrome,
// mas mexe em animação de janela de app nativo — só com `full` (navegadores
// Chromium, decididos pelo driver).
function enhance(app, full) {
  var yes = $.NSNumber.numberWithBool(true)
  var a = $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), yes)
  var b = full ? $.AXUIElementSetAttributeValue(app, $('AXEnhancedUserInterface'), yes) : -1
  return a === AX_OK || b === AX_OK
}

function opRestore(args) {
  var no = $.NSNumber.numberWithBool(false)
  for (var i = 0; i < (args.pids || []).length; i++) {
    var app = appElement(args.pids[i])
    $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), no)
    $.AXUIElementSetAttributeValue(app, $('AXEnhancedUserInterface'), no)
  }
  return { restored: (args.pids || []).length }
}

// Árvore por BFS com orçamento (nós, profundidade, filhos por nó e prazo): o
// orçamento cobre a janela por camadas, em vez de uma barra lateral grande
// consumir tudo antes do conteúdo. A ordem de exibição (DFS) é feita no driver.
function opTree(args) {
  requireTrust()
  var started = Date.now()
  var maxNodes = args.maxNodes || 250
  var maxDepth = args.maxDepth || 64
  var maxChildren = args.maxChildren || 120
  var textLimit = args.textLimit || 300
  var deadline = started + (args.deadlineMs || 6000)
  setGlobalTimeout(args.axTimeout || 0.5)
  var app = appElement(args.pid)
  var enhanced = args.enhance ? enhance(app, args.enhanceFull === true) : false
  // O Chromium monta a árvore de forma assíncrona depois do pedido: lida na
  // hora, ela ainda tem só a moldura (Fase 0: 13 nós → 250+ depois de ~300 ms).
  // Quem chama só pede a espera na primeira vez em cada app.
  if (enhanced && args.enhanceWaitMs) pause(args.enhanceWaitMs)
  var found = findWindow(args.pid, args.window)
  var nodes = []
  var elements = []
  var queue = [{ el: found.window, parent: -1, depth: 0, path: [] }]
  var truncated = null
  var omitted = 0
  var timeouts = 0
  while (queue.length) {
    if (nodes.length >= maxNodes) { truncated = 'maxNodes'; break }
    if (Date.now() > deadline) { truncated = 'deadline'; break }
    var item = queue.shift()
    var r = read(item.el, textLimit, true)
    if (r.err !== undefined) {
      if (r.err === AX_API_DISABLED) fail('axDenied', 'Accessibility permission is not granted to Orbit.')
      if (r.err === AX_CANNOT_COMPLETE) timeouts++
      continue
    }
    var node = r.node
    node.id = nodes.length
    node.parent = item.parent
    node.depth = item.depth
    node.path = item.path
    nodes.push(node)
    elements.push(item.el)
    if (r.children && item.depth < maxDepth) {
      var count = r.children.length
      var take = Math.min(count, maxChildren)
      for (var c = 0; c < take; c++) {
        queue.push({ el: r.children[c], parent: node.id, depth: item.depth + 1, path: item.path.concat([c]) })
      }
      if (count > take) { node.omittedChildren = count - take; omitted += count - take }
    }
  }
  omitted += queue.length
  if (timeouts && !truncated) truncated = 'axTimeout'
  var focusedId = null
  var focused = copyAttr(app, 'AXFocusedUIElement').value
  if (focused && focused.element) {
    for (var k = 0; k < elements.length; k++) {
      if ($.CFEqual(elements[k], focused.element)) { focusedId = k; break }
    }
  }
  return {
    nodes: nodes,
    focusedId: focusedId,
    truncated: truncated,
    omitted: omitted,
    timeouts: timeouts,
    enhanced: enhanced,
    ms: Date.now() - started,
  }
}

// ------------------------------------------------------------- entrada

var EV = { leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, moved: 5, leftDragged: 6, otherDown: 25, otherUp: 26 }
var FIELD_CLICK_STATE = 1
// Janela sob o ponteiro: com estes campos, o evento entregue por pid acha a
// janela certa mesmo com o app em segundo plano.
var FIELD_WINDOW_UNDER = 91
var FIELD_WINDOW_CAN_HANDLE = 92

function post(ev, mode, pid) {
  if (mode === 'global') $.CGEventPost(0, ev)
  else $.CGEventPostToPid(pid, ev)
}

function mouseEvent(type, x, y, button, windowId, clicks) {
  var ev = $.CGEventCreateMouseEvent($(), type, { x: x, y: y }, button)
  if (windowId) {
    $.CGEventSetIntegerValueField(ev, FIELD_WINDOW_UNDER, windowId)
    $.CGEventSetIntegerValueField(ev, FIELD_WINDOW_CAN_HANDLE, windowId)
  }
  if (clicks) $.CGEventSetIntegerValueField(ev, FIELD_CLICK_STATE, clicks)
  return ev
}

function pause(ms) { delay(ms / 1000) }

// Deslize do cursor REAL até o alvo (só no ponteiro global): em vez de pular,
// percorre uma curva suavizada (ease-in-out) em ~16 ms por passo — a pessoa
// acompanha com os olhos onde o agente vai agir. Abaixo de 4 px não anima.
var GLIDE_MS = 240
function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }
function glide(x, y, ms) {
  var start = $.CGEventGetLocation($.CGEventCreate($()))
  var dx = x - start.x
  var dy = y - start.y
  if (Math.sqrt(dx * dx + dy * dy) < 4) return
  var steps = Math.max(6, Math.round((ms || GLIDE_MS) / 16))
  for (var i = 1; i < steps; i++) {
    var k = easeInOut(i / steps)
    $.CGEventPost(0, mouseEvent(EV.moved, start.x + dx * k, start.y + dy * k, 0, 0, 0))
    pause(16)
  }
}

function opMouse(args) {
  requireTrust()
  var btn = args.button === 'right' ? 1 : args.button === 'middle' ? 2 : 0
  var down = btn === 1 ? EV.rightDown : btn === 2 ? EV.otherDown : EV.leftDown
  var up = btn === 1 ? EV.rightUp : btn === 2 ? EV.otherUp : EV.leftUp
  var mode = args.mode || 'pid'
  if (mode === 'global') glide(args.x, args.y, args.glideMs)
  if (mode === 'global' || args.kind === 'move') post(mouseEvent(EV.moved, args.x, args.y, 0, args.windowId, 0), mode, args.pid)
  if (args.kind === 'move') return { done: 'move' }
  var clicks = args.clicks || 1
  for (var i = 1; i <= clicks; i++) {
    post(mouseEvent(down, args.x, args.y, btn, args.windowId, i), mode, args.pid)
    pause(12)
    post(mouseEvent(up, args.x, args.y, btn, args.windowId, i), mode, args.pid)
    if (i < clicks) pause(40)
  }
  return { done: 'click', clicks: clicks }
}

function opDrag(args) {
  requireTrust()
  var mode = args.mode || 'global'
  var steps = args.steps || 12
  if (mode === 'global') glide(args.from[0], args.from[1], args.glideMs)
  post(mouseEvent(EV.moved, args.from[0], args.from[1], 0, args.windowId, 0), mode, args.pid)
  post(mouseEvent(EV.leftDown, args.from[0], args.from[1], 0, args.windowId, 1), mode, args.pid)
  for (var i = 1; i <= steps; i++) {
    var x = args.from[0] + ((args.to[0] - args.from[0]) * i) / steps
    var y = args.from[1] + ((args.to[1] - args.from[1]) * i) / steps
    pause(16)
    post(mouseEvent(EV.leftDragged, x, y, 0, args.windowId, 1), mode, args.pid)
  }
  post(mouseEvent(EV.leftUp, args.to[0], args.to[1], 0, args.windowId, 1), mode, args.pid)
  return { done: 'drag' }
}

function opScroll(args) {
  requireTrust()
  // A roda age onde o cursor está: no global, ele desliza até lá primeiro.
  if ((args.mode || 'pid') === 'global') {
    glide(args.x, args.y, args.glideMs)
    $.CGEventPost(0, mouseEvent(EV.moved, args.x, args.y, 0, 0, 0))
  }
  var ev = $.CGEventCreateScrollWheelEvent2($(), 0, 2, args.dy || 0, args.dx || 0, 0)
  $.CGEventSetLocation(ev, { x: args.x, y: args.y })
  post(ev, args.mode || 'pid', args.pid)
  return { done: 'scroll' }
}

// Teclas: códigos virtuais e flags resolvidos no driver (TS). Texto vai como
// Unicode, um grapheme por evento — acentos e emoji chegam inteiros.
function opKeys(args) {
  requireTrust()
  var mode = args.mode || 'pid'
  var combos = args.combos || []
  for (var i = 0; i < combos.length; i++) {
    var c = combos[i]
    var down = $.CGEventCreateKeyboardEvent($(), c.code, true)
    var up = $.CGEventCreateKeyboardEvent($(), c.code, false)
    $.CGEventSetFlags(down, c.flags || 0)
    $.CGEventSetFlags(up, c.flags || 0)
    post(down, mode, args.pid)
    pause(8)
    post(up, mode, args.pid)
    pause(20)
  }
  if (typeof args.text === 'string' && args.text) {
    var parts
    try {
      parts = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(args.text), function (s) { return s.segment })
    } catch (_) {
      parts = Array.from(args.text)
    }
    for (var j = 0; j < parts.length; j++) {
      var kd = $.CGEventCreateKeyboardEvent($(), 0, true)
      var ku = $.CGEventCreateKeyboardEvent($(), 0, false)
      // length em unidades UTF-16 — o mesmo que String.length no JS.
      var bytes = $(parts[j]).dataUsingEncoding(UTF16LE).bytes
      $.CGEventKeyboardSetUnicodeString(kd, parts[j].length, bytes)
      $.CGEventKeyboardSetUnicodeString(ku, parts[j].length, bytes)
      post(kd, mode, args.pid)
      post(ku, mode, args.pid)
      pause(6)
    }
  }
  return { done: 'keys' }
}

function opActivate(args) {
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(args.pid)
  if (!app || (app.isNil && app.isNil())) fail('appNotFound', 'The app is no longer running.')
  app.activateWithOptions(2)
  return { done: 'activate' }
}

// Executa uma ação AX. "Não completou" (-25204) não é falha: a ação que abre
// animação ou diálogo costuma rodar e só a resposta atrasar (Fase 0: o botão de
// tela cheia entrou em tela cheia e respondeu -25204). Tratar como falha faria
// tentar outra ação — ou o ancestral — e disparar duas coisas.
function perform(el, action) {
  var err = $.AXUIElementPerformAction(el, $(action))
  if (err === AX_OK) return 'ok'
  if (err === AX_CANNOT_COMPLETE) return 'unconfirmed'
  return 'failed'
}

// Ações por elemento: tudo que o AX resolve sem mexer no ponteiro do usuário.
function opElement(args) {
  requireTrust()
  setGlobalTimeout(args.axTimeout || 1)
  var r = resolvePath(args.pid, args.window, args.path, args.expect)
  var el = r.el
  var info = read(el, 500, true)
  if (info.err !== undefined) fail('axError', 'Could not read the element (AX error ' + info.err + ').')
  var node = info.node
  if (args.kind === 'info') return { node: node }
  if (args.kind === 'press') {
    var wanted = args.actions || ['AXPress']
    for (var i = 0; i < wanted.length; i++) {
      if (node.actions.indexOf(wanted[i]) === -1) continue
      var result = perform(el, wanted[i])
      if (result !== 'failed') return { done: 'press', action: wanted[i], node: node, unconfirmed: result === 'unconfirmed' }
    }
    return { done: null, node: node }
  }
  if (args.kind === 'focus') {
    var fe = $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true))
    return { done: fe === AX_OK ? 'focus' : null, node: node }
  }
  if (args.kind === 'setValue') {
    if (node.secure) fail('secureField', 'Refusing to write into a secure (password) field.')
    var settable = Ref()
    $.AXUIElementIsAttributeSettable(el, $('AXValue'), settable)
    if (!settable[0]) return { done: null, node: node }
    var se = $.AXUIElementSetAttributeValue(el, $('AXValue'), $(args.value))
    if (se !== AX_OK) return { done: null, node: node }
    var after = clip(copyAttr(el, 'AXValue').value, 500)
    return { done: 'setValue', node: node, readBack: after }
  }
  fail('badRequest', 'Unknown element action: ' + args.kind)
}

// Clique por coordenada no modo dirigido. Evento de mouse entregue por pid é
// ignorado pelo AppKit (Fase 0: nem com o app na frente) — então o ponto vira
// elemento pelo hit-test do AX e a ação vai pela acessibilidade: AXPress (ou a
// pedida), menu de contexto, ou foco em campo de texto. Sobe até 4 ancestrais
// porque o hit-test costuma cair num texto ou imagem dentro do botão.
var TEXT_ROLES = { AXTextField: 1, AXTextArea: 1, AXComboBox: 1, AXSearchField: 1 }
function opHit(args) {
  requireTrust()
  setGlobalTimeout(args.axTimeout || 1)
  var out = Ref()
  var err = $.AXUIElementCopyElementAtPosition(appElement(args.pid), args.x, args.y, out)
  if (err !== AX_OK || !out[0]) fail('nothingAtPoint', 'No accessible element of this app at that point.')
  var el = ObjC.castRefToObject(out[0])
  var wanted = args.actions || ['AXPress', 'AXConfirm', 'AXOpen', 'AXPick']
  var first = null
  for (var depth = 0; depth < 5 && el; depth++) {
    var info = read(el, 200, true)
    if (info.err !== undefined) break
    if (!first) first = info.node
    if (info.node.secure && args.focusText) fail('secureField', 'Refusing to focus a secure (password) field.')
    for (var i = 0; i < wanted.length; i++) {
      if (info.node.actions.indexOf(wanted[i]) === -1) continue
      var result = perform(el, wanted[i])
      if (result !== 'failed') return { done: 'press', action: wanted[i], node: info.node, depth: depth, unconfirmed: result === 'unconfirmed' }
    }
    if (args.focusText && TEXT_ROLES[info.node.role]) {
      var fe = $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true))
      if (fe === AX_OK) return { done: 'focus', node: info.node, depth: depth }
    }
    var parent = copyAttr(el, 'AXParent').value
    el = parent && parent.element ? parent.element : null
  }
  return { done: null, node: first }
}

// Rolagem no modo dirigido: a roda do mouse entregue por pid também é
// ignorada (Fase 0). Acha a área de rolagem sob o ponto e move a barra dela
// pelo AXValue (0..1), convertendo os pixels pedidos em fração do conteúdo.
function opScrollAx(args) {
  requireTrust()
  setGlobalTimeout(args.axTimeout || 1)
  var out = Ref()
  if ($.AXUIElementCopyElementAtPosition(appElement(args.pid), args.x, args.y, out) !== AX_OK || !out[0]) {
    return { done: null, reason: 'nothingAtPoint' }
  }
  var el = ObjC.castRefToObject(out[0])
  var vertical = (args.dy || 0) !== 0
  for (var depth = 0; depth < 10 && el; depth++) {
    var role = copyAttr(el, 'AXRole').value
    if (role === 'AXScrollArea') {
      var bar = copyAttr(el, vertical ? 'AXVerticalScrollBar' : 'AXHorizontalScrollBar').value
      if (!bar || !bar.element) return { done: null, reason: 'noScrollBar' }
      var current = copyAttr(bar.element, 'AXValue').value
      if (typeof current !== 'number') return { done: null, reason: 'noScrollBar' }
      var area = copyAttr(el, 'AXSize').value
      var kids = copyAttr(el, 'AXContents').value || copyAttr(el, 'AXChildren').value
      var content = null
      if (kids && kids.array && kids.array.count) content = copyAttr(kids.array.objectAtIndex(0), 'AXSize').value
      var visible = area ? (vertical ? area.h : area.w) : 0
      var total = content ? (vertical ? content.h : content.w) : 0
      var range = total - visible
      if (!(range > 0)) return { done: null, reason: 'nothingToScroll' }
      // Roda positiva = conteúdo desce = barra sobe (valor menor).
      var delta = -(vertical ? args.dy : args.dx) / range
      var next = Math.min(1, Math.max(0, current + delta))
      var err = $.AXUIElementSetAttributeValue(bar.element, $('AXValue'), $.NSNumber.numberWithDouble(next))
      return { done: err === AX_OK ? 'scroll' : null, from: current, to: next }
    }
    var parent = copyAttr(el, 'AXParent').value
    el = parent && parent.element ? parent.element : null
  }
  return { done: null, reason: 'noScrollArea' }
}

// Seleção de texto no elemento com foco do app: o retorno de arrastar e de
// clique duplo/triplo. Sem isto, "arrastei" saía mesmo quando o arrasto não
// selecionou nada (Fase 0: arrasto abaixo da linha de texto).
function opSelection(args) {
  requireTrust()
  setGlobalTimeout(0.5)
  var focused = copyAttr(appElement(args.pid), 'AXFocusedUIElement').value
  if (!focused || !focused.element) return { selection: null }
  var raw = null
  var out = Ref()
  if ($.AXUIElementCopyAttributeValue(focused.element, $('AXSelectedTextRange'), out) === AX_OK) {
    var d = ObjC.unwrap(ObjC.castRefToObject(out[0]).description)
    var m = /location:(\d+) length:(\d+)/.exec(d)
    if (m) raw = { location: Number(m[1]), length: Number(m[2]) }
  }
  if (!raw) return { selection: null }
  var text = copyAttr(focused.element, 'AXSelectedText').value
  return { selection: { location: raw.location, length: raw.length, text: clip(text, 120) } }
}

// O elemento com foco de um app (ou do sistema, sem pid): é o que recebe a
// digitação — o driver confere aqui que não é um campo de senha.
function opFocused(args) {
  requireTrust()
  setGlobalTimeout(0.5)
  var owner = args && args.pid ? appElement(args.pid) : $.AXUIElementCreateSystemWide()
  var r = copyAttr(owner, 'AXFocusedUIElement')
  if (r.err === AX_API_DISABLED) fail('axDenied', 'Accessibility permission is not granted to Orbit.')
  if (!r.value || !r.value.element) return { node: null }
  var info = read(r.value.element, 300, false)
  return { node: info.node || null }
}

var OPS = {
  perms: opPerms,
  apps: opApps,
  tree: opTree,
  restore: opRestore,
  mouse: opMouse,
  drag: opDrag,
  scroll: opScroll,
  keys: opKeys,
  activate: opActivate,
  element: opElement,
  focused: opFocused,
  hit: opHit,
  selection: opSelection,
  scrollAx: opScrollAx,
}

function run(argv) {
  try {
    var req = JSON.parse(argv[0] || '{}')
    var fn = OPS[req.op]
    if (!fn) fail('badRequest', 'Unknown op: ' + req.op)
    return JSON.stringify({ ok: true, result: fn(req.args || {}) })
  } catch (e) {
    return JSON.stringify({ ok: false, error: { code: e.code || 'bridgeError', message: String(e.message || e) } })
  }
}
