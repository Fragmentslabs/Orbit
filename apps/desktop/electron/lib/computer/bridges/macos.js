// macOS bridge of Computer Use: JXA (osascript -l JavaScript) with the ObjC
// bridge. One invocation = one operation: the input JSON arrives in argv[0] and the
// answer comes out as the return of run() (stdout). Nothing here keeps state between
// calls — AXUIElementRef does not survive the process, which is why the element is
// found again by the path (AXChildren indices from the window).
//
// This file is imported with ?raw by the driver and also read by the Phase 0 probe
// (scripts/cu-probe.mjs): the code measured is the same one that runs in the app.

ObjC.import('AppKit')
ObjC.import('ApplicationServices')
ObjC.import('CoreGraphics')

// The default signature asks for UniChar*, and JXA does not convert a JS string to
// that: passed straight through, the string vanishes and the event types key 0 ("a")
// — Phase 0. Rebound with void*, it accepts the UTF-16 bytes of an NSData.
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void*', 'unsigned long', 'void*']])
var UTF16LE = 0x94000100

// Text range (CFRange) for AXSelectedTextRange: JXA does not build the struct on its
// own (an object { location, length } arrives zeroed). The real bytes — two 64-bit
// integers — go in an NSData, and the value comes back wrapped with castRefToObject;
// without the wrapper the set answers OK and selects nothing.
ObjC.bindFunction('AXValueCreate', ['void*', ['int', 'void*']])
var AX_VALUE_CFRANGE = 4
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64(bytes) {
  var out = ''
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=')
  }
  return out
}
function int64le(n) {
  var b = []
  for (var i = 0; i < 8; i++) { b.push(n % 256); n = Math.floor(n / 256) }
  return b
}
function rangeValue(location, length) {
  var data = $.NSData.alloc.initWithBase64EncodedStringOptions($(base64(int64le(location).concat(int64le(length)))), 0)
  return ObjC.castRefToObject($.AXValueCreate(AX_VALUE_CFRANGE, data.bytes))
}

var AX_OK = 0
var AX_API_DISABLED = -25211
var AX_CANNOT_COMPLETE = -25204

// One trip to the app per node: AXUIElementCopyMultipleAttributeValues brings
// everything at once. The order matters — read() reads by position. AXURL stays out:
// only links and web areas have it, and asking for it on every node cost a conversion
// per node.
var ATTRS = [
  'AXRole', 'AXSubrole', 'AXTitle', 'AXValue', 'AXDescription', 'AXPosition', 'AXSize',
  'AXEnabled', 'AXFocused', 'AXChildren', 'AXPlaceholderValue', 'AXHelp', 'AXSelected',
]
var URL_ROLES = { AXLink: 1, AXWebArea: 1 }

// Roles that never have a useful action: skipping CopyActionNames saves one trip to
// the app per node, which is the dominant cost of the tree.
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

// Converts what came from AX to JS. AXValue (point, size, error) has no direct
// conversion in JXA — its textual description is stable and is enough.
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
  // Strings only: deepUnwrap converts the whole array in a single call.
  var names = ObjC.deepUnwrap(ObjC.castRefToObject(out[0]))
  return Array.isArray(names) ? names : []
}

// Point/size arrive as AXValue, which JXA does not convert: its textual description
// is stable ("x:120 y:80", "w:300 h:20").
function struct(o) {
  if (o === null || o === undefined || typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') return null
  var d = ''
  try { d = ObjC.unwrap(o.description) } catch (_) { return null }
  var m
  if ((m = /x:([-\d.]+) y:([-\d.]+)/.exec(d))) return { x: parseFloat(m[1]), y: parseFloat(m[2]) }
  if ((m = /w:([-\d.]+) h:([-\d.]+)/.exec(d))) return { w: parseFloat(m[1]), h: parseFloat(m[2]) }
  return null
}

// Reads the attributes of an element in a single call. A secure field never has its
// value returned — neither to the driver nor to the model.
//
// Conversion: a shallow unwrap of the array and one unwrap per item. Strings,
// numbers, booleans and the children list come out ready; what remains an object is
// AXValue (point, size or a missing attribute). Measured in Phase 0: 4x faster than
// testing the class of each value, which was 65% of the tree time.
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
  // From the raw value: the unwrap of an AXValue is not undefined, it is an empty {}.
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

// Without the permission, AX returns different errors depending on the call (-25211,
// -25204): the explicit check gives a single error, which the driver knows how to
// explain.
function requireTrust() {
  var trusted = $.AXIsProcessTrusted()
  if (!(trusted === true || trusted === 1)) fail('axDenied', 'Accessibility permission is not granted to Orbit.')
}

// Messaging timeout: without this a stuck app holds EACH AX call for ~6 s (system
// default). On the system-wide element it applies to all of them.
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

// The AX window that corresponds to the CGWindowList window: both use the same space
// (points, origin at the top of the main monitor), so the frame matches.
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

// Walks the path again and checks the identity: an index from an old observation that
// today points at another element becomes an error, never a click in the wrong place.
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

// ---------------------------------------------------------------- operations

// Screen Recording request through the official macOS path. It runs in a child of
// Orbit, so the request goes out on behalf of Orbit (responsible process). The
// desktopCapturer alone was not enough in the installed build: macOS denied "by
// policy" without a dialog and without putting Orbit in the list.
function opRequestScreen() {
  ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []])
  ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []])
  var before = $.CGPreflightScreenCaptureAccess()
  var granted = before ? true : $.CGRequestScreenCaptureAccess()
  return { before: before === true, granted: granted === true }
}

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
    // activationPolicy arrives as a string through the bridge.
    if (Number(a.activationPolicy) !== 0) continue
    apps.push({
      pid: a.processIdentifier,
      bundleId: ObjC.unwrap(a.bundleIdentifier) || null,
      name: ObjC.unwrap(a.localizedName) || '',
      active: a.processIdentifier === frontPid,
      hidden: a.hidden === true,
    })
  }
  // On screen, excluding desktop elements, in front-to-back order.
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
      // The title only comes with Screen Recording granted; without it, null.
      title: ObjC.unwrap(d.objectForKey('kCGWindowName')) || null,
      frame: [ObjC.unwrap(b.objectForKey('X')), ObjC.unwrap(b.objectForKey('Y')), w, h],
    })
  }
  return { apps: apps, windows: windows }
}

// Turns on the accessibility tree of Chromium/Electron apps, which by default expose
// almost nothing. AXManualAccessibility is Electron's request and holds for any app
// (native ones just refuse). AXEnhancedUserInterface is Chrome's, but it messes with
// window animation in a native app — only with `full` (Chromium browsers, decided by
// the driver).
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

// BFS tree with a budget (nodes, depth, children per node and deadline): the budget
// covers the window in layers, instead of one big sidebar consuming everything before
// the content. The display order (DFS) is done in the driver.
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
  // Chromium builds the tree asynchronously after the request: read right away, it
  // still has only the chrome (Phase 0: 13 nodes → 250+ after ~300 ms). The caller
  // only asks for the wait the first time in each app.
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

// ------------------------------------------------------------- input

var EV = { leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, moved: 5, leftDragged: 6, otherDown: 25, otherUp: 26 }
var FIELD_CLICK_STATE = 1
// Window under the pointer: with these fields, the event delivered by pid finds the
// right window even with the app in the background.
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

// Slide of the REAL cursor to the target (global pointer only): instead of jumping,
// it travels an eased curve (ease-in-out) at ~16 ms per step — the person follows with
// their eyes where the agent is going to act. Below 4 px it does not animate.
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
  // The wheel acts where the cursor is: in global mode, it slides there first.
  if ((args.mode || 'pid') === 'global') {
    glide(args.x, args.y, args.glideMs)
    $.CGEventPost(0, mouseEvent(EV.moved, args.x, args.y, 0, 0, 0))
  }
  var ev = $.CGEventCreateScrollWheelEvent2($(), 0, 2, args.dy || 0, args.dx || 0, 0)
  $.CGEventSetLocation(ev, { x: args.x, y: args.y })
  post(ev, args.mode || 'pid', args.pid)
  return { done: 'scroll' }
}

// Keys: virtual codes and flags resolved in the driver (TS). Text goes as Unicode, one
// grapheme per event — accents and emoji arrive whole.
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
      // length in UTF-16 units — the same as String.length in JS.
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

// Runs an AX action. "Did not complete" (-25204) is not a failure: the action that
// opens an animation or a dialog usually runs and only the answer is late (Phase 0:
// the full screen button went full screen and answered -25204). Treating it as a
// failure would make it try another action — or the ancestor — and fire two things.
function perform(el, action) {
  var err = $.AXUIElementPerformAction(el, $(action))
  if (err === AX_OK) return 'ok'
  if (err === AX_CANNOT_COMPLETE) return 'unconfirmed'
  return 'failed'
}

// Actions by element: everything AX resolves without touching the user's pointer.
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
  if (args.kind === 'select') {
    // The WHOLE value (the one from the tree comes clipped): AX indices are UTF-16,
    // the same as the JS String's.
    var full = copyAttr(el, 'AXValue').value
    if (typeof full !== 'string') fail('badRequest', 'The element has no text to select.')
    var start = 0
    var length = full.length
    if (typeof args.find === 'string' && args.find.length) {
      var occurrence = Math.max(1, args.occurrence || 1)
      var at = -1
      for (var k = 0; k < occurrence; k++) {
        at = full.indexOf(args.find, at + 1)
        if (at === -1) break
      }
      if (at === -1) fail('textNotFound', 'Text not found in the element' + (occurrence > 1 ? ' (occurrence ' + occurrence + ')' : '') + ': ' + JSON.stringify(args.find))
      start = at
      length = args.find.length
    }
    $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true))
    var se = $.AXUIElementSetAttributeValue(el, $('AXSelectedTextRange'), rangeValue(start, length))
    if (se !== AX_OK) return { done: null, node: node }
    var picked = copyAttr(el, 'AXSelectedText').value
    return { done: 'select', node: node, selection: { location: start, length: length, text: clip(picked, 120) } }
  }
  fail('badRequest', 'Unknown element action: ' + args.kind)
}

// Click by coordinate in directed mode. A mouse event delivered by pid is ignored by
// AppKit (Phase 0: not even with the app in front) — so the point becomes an element
// through the AX hit-test and the action goes through accessibility: AXPress (or the
// requested one), context menu, or focus on a text field. It goes up to 4 ancestors
// because the hit-test usually lands on a text or image inside the button.
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

// Scroll in directed mode: the mouse wheel delivered by pid is ignored too (Phase 0).
// It finds the scroll area under the point and moves its bar through AXValue (0..1),
// converting the requested pixels into a fraction of the content.
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
      // Positive wheel = content goes down = bar goes up (smaller value).
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

// Text selection in the app's focused element: the return of dragging and of a
// double/triple click. Without it, "I dragged" came out even when the drag selected
// nothing (Phase 0: a drag below the text line).
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

// Text selected in the app, WITHOUT the 120-character cut of opSelection: it is what
// the overlay (⇧⌘space) delivers to the model when the person asks "translate this".
// Returns null when there is no selection — never the whole text of the field.
function opReadSelection(args) {
  requireTrust()
  setGlobalTimeout(0.8)
  var focused = copyAttr(appElement(args.pid), 'AXFocusedUIElement').value
  if (!focused || !focused.element) return { selection: null }
  var picked = copyAttr(focused.element, 'AXSelectedText').value
  if (picked === null || picked === undefined) return { selection: null }
  var text = String(picked)
  if (!text.trim()) return { selection: null }
  // 20k is a context ceiling, not a selection one: a whole document selected by
  // accident cannot become the message.
  return { selection: { location: 0, length: text.length, text: text.slice(0, 20000) } }
}

// The focused element of an app (or of the system, without a pid): it is what receives
// the typing — the driver checks here that it is not a password field.
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
  requestScreen: opRequestScreen,
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
  readSelection: opReadSelection,
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
