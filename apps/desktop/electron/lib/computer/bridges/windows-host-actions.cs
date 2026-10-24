// Acoes do host do Computer Use no Windows (continuacao de windows-host.cs).
//
// Regras que este arquivo segue:
//  - o modo dirigido age SO pela UI Automation (Invoke, Toggle, Value, Text,
//    Scroll...). Nada de mensagens de janela postadas nem truques com a fila de
//    entrada de outro app: falham sem avisar em Chromium/UWP/WPF;
//  - SetFocus nunca: focar um controle de outro app ativa a janela dele. O
//    "focus" so guarda o elemento como alvo da proxima digitacao;
//  - SendInput so no ponteiro global (opt-in do usuario), e SEMPRE depois de
//    trazer o app para a frente e conferir que a janela certa esta sob o
//    ponto: entrada real no app errado e o pior erro possivel aqui;
//  - toda acao confere a identidade (papel e nome) do elemento antes de agir.
//
// C# 5, como o resto.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using Microsoft.Win32;

public static partial class OrbitHost
{
    // ------------------------------------------------------- Win32 de entrada

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public int dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public int type; public INPUTUNION u; }

    [StructLayout(LayoutKind.Sequential)]
    struct GUITHREADINFO
    {
        public int cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public int dwFlags; }

    delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageText(IntPtr hwnd, int msg, IntPtr wParam, string lParam);
    [DllImport("user32.dll", EntryPoint = "SendMessageW")] static extern IntPtr SendMessagePtr(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);

    const int EM_SETSEL = 0x00B1;
    const int EM_REPLACESEL = 0x00C2;
    const int INPUT_MOUSE = 0;
    const int INPUT_KEYBOARD = 1;
    const int MOUSEEVENTF_MOVE = 0x0001;
    const int MOUSEEVENTF_LEFTDOWN = 0x0002;
    const int MOUSEEVENTF_LEFTUP = 0x0004;
    const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const int MOUSEEVENTF_RIGHTUP = 0x0010;
    const int MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const int MOUSEEVENTF_MIDDLEUP = 0x0040;
    const int MOUSEEVENTF_WHEEL = 0x0800;
    const int MOUSEEVENTF_HWHEEL = 0x1000;
    const int MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const int MOUSEEVENTF_ABSOLUTE = 0x8000;
    const int KEYEVENTF_EXTENDEDKEY = 0x0001;
    const int KEYEVENTF_KEYUP = 0x0002;
    const int KEYEVENTF_UNICODE = 0x0004;
    const int DefaultGlideMs = 240;
    /// <summary>Quanto tempo um "focus" vale como alvo da proxima digitacao.</summary>
    const int FocusTargetSeconds = 10;

    // Flags do combo (as mesmas de keys.ts): shift=1, ctrl=2, alt=4, win=8.
    const int FlagShift = 1, FlagCtrl = 2, FlagAlt = 4, FlagWin = 8;

    class FocusRef
    {
        public AutomationElement El;
        public DateTime At;
    }

    static readonly Dictionary<int, FocusRef> Targets = new Dictionary<int, FocusRef>();

    // ---------------------------------------------------------------- despacho

    static object DispatchAction(string op, Dictionary<string, object> a)
    {
        switch (op)
        {
            case "element": return OpElement(a);
            case "hit": return OpHit(a);
            case "focused": return OpFocused(a);
            case "selection": return OpSelection(a);
            case "scrollAx": return OpScrollAx(a);
            case "keys": return OpKeys(a);
            case "mouse": return OpMouse(a);
            case "drag": return OpDrag(a);
            case "scroll": return OpScroll(a);
            case "activate": return OpActivate(a);
            case "openApp": return OpOpenApp(a);
            // Operacoes do probe do Stage 0 (scripts/cu-probe-win.mjs).
            case "displays": return OpDisplays();
            case "foreground": return OpForeground();
            case "cursor": return OpCursor();
            case "treeBench": return OpTreeBench(a);
        }
        throw new HostError("badRequest", "Unknown op: " + op);
    }

    static double Dbl(Dictionary<string, object> d, string key, double fallback)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return fallback;
        try { return Convert.ToDouble(v); } catch (Exception) { return fallback; }
    }

    static Dictionary<string, object> Dict(Dictionary<string, object> d, string key)
    {
        object v;
        return d.TryGetValue(key, out v) ? v as Dictionary<string, object> : null;
    }

    // ---------------------------------------------------------------- padroes

    static bool TryPattern<T>(AutomationElement e, AutomationPattern pattern, out T result) where T : class
    {
        object o;
        result = null;
        try
        {
            if (e.TryGetCurrentPattern(pattern, out o)) result = o as T;
        }
        catch (ElementNotAvailableException) { }
        return result != null;
    }

    /// <summary>
    /// Roda a chamada numa thread com prazo. Um Invoke que abre um dialogo
    /// modal pode so voltar quando o dialogo fecha: o host nao pode ficar preso.
    /// </summary>
    static bool RunWithTimeout(Action action, int ms, out Exception error)
    {
        Exception captured = null;
        Thread t = new Thread(delegate ()
        {
            try { action(); }
            catch (Exception e) { captured = e; }
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.MTA);
        t.Start();
        if (!t.Join(ms)) { error = null; return false; }
        error = captured;
        return true;
    }

    /// <summary>true = rodou; unconfirmed = o app nao respondeu a tempo (provavelmente rodou).</summary>
    static bool Guarded(Action action, out bool unconfirmed)
    {
        Exception err;
        bool finished = RunWithTimeout(action, 2000, out err);
        unconfirmed = !finished;
        if (!finished) return true;
        if (err == null) return true;
        if (err is ElementNotAvailableException) throw new HostError("staleRef", "The element is gone - call cu_observe again.");
        // Desabilitado, ou o padrao nao vale agora: tenta a proxima opcao.
        return false;
    }

    static bool Perform(AutomationElement el, string action, out bool unconfirmed)
    {
        unconfirmed = false;
        InvokePattern invoke;
        TogglePattern toggle;
        SelectionItemPattern item;
        ExpandCollapsePattern expand;
        switch (action)
        {
            case "AXPress":
            case "AXConfirm":
            case "AXOpen":
                if (TryPattern(el, InvokePattern.Pattern, out invoke)) return Guarded(delegate () { invoke.Invoke(); }, out unconfirmed);
                if (TryPattern(el, TogglePattern.Pattern, out toggle)) return Guarded(delegate () { toggle.Toggle(); }, out unconfirmed);
                if (TryPattern(el, SelectionItemPattern.Pattern, out item)) return Guarded(delegate () { item.Select(); }, out unconfirmed);
                if (TryPattern(el, ExpandCollapsePattern.Pattern, out expand))
                {
                    bool collapsed = expand.Current.ExpandCollapseState == ExpandCollapseState.Collapsed;
                    return Guarded(delegate () { if (collapsed) expand.Expand(); else expand.Collapse(); }, out unconfirmed);
                }
                return false;
            case "AXPick":
                if (TryPattern(el, SelectionItemPattern.Pattern, out item)) return Guarded(delegate () { item.Select(); }, out unconfirmed);
                return false;
            case "AXExpand":
                if (TryPattern(el, ExpandCollapsePattern.Pattern, out expand)) return Guarded(delegate () { expand.Expand(); }, out unconfirmed);
                return false;
            case "AXCollapse":
                if (TryPattern(el, ExpandCollapsePattern.Pattern, out expand)) return Guarded(delegate () { expand.Collapse(); }, out unconfirmed);
                return false;
            case "AXIncrement":
            case "AXDecrement":
                RangeValuePattern range;
                if (!TryPattern(el, RangeValuePattern.Pattern, out range) || range.Current.IsReadOnly) return false;
                double step = range.Current.SmallChange > 0 ? range.Current.SmallChange : 1;
                double next = range.Current.Value + (action == "AXIncrement" ? step : -step);
                next = Math.Max(range.Current.Minimum, Math.Min(range.Current.Maximum, next));
                return Guarded(delegate () { range.SetValue(next); }, out unconfirmed);
            case "AXScrollToVisible":
                ScrollItemPattern scrollItem;
                if (TryPattern(el, ScrollItemPattern.Pattern, out scrollItem)) return Guarded(delegate () { scrollItem.ScrollIntoView(); }, out unconfirmed);
                return false;
        }
        return false;
    }

    // ---------------------------------------------------------------- elemento

    static string RoleLive(AutomationElement e)
    {
        string n = e.Current.ControlType.ProgrammaticName;
        int dot = n.LastIndexOf('.');
        return dot >= 0 ? n.Substring(dot + 1) : n;
    }

    static bool Matches(AutomationElement e, string expectRole, string expectTitle)
    {
        try
        {
            if (expectRole != null && RoleLive(e) != expectRole) return false;
            string name = Clip(e.Current.Name, DefaultTextLimit) ?? "";
            string want = Clip(expectTitle, DefaultTextLimit) ?? "";
            return string.Equals(name, want, StringComparison.Ordinal);
        }
        catch (ElementNotAvailableException) { return false; }
        catch (Exception) { return false; }
    }

    static AutomationElement WalkPath(AutomationElement root, List<int> path)
    {
        AutomationElement cur = root;
        TreeWalker walker = TreeWalker.ControlViewWalker;
        foreach (int index in path)
        {
            AutomationElement child = walker.GetFirstChild(cur);
            for (int i = 0; child != null && i < index; i++) child = walker.GetNextSibling(child);
            if (child == null) return null;
            cur = child;
        }
        return cur;
    }

    static List<int> PathArg(Dictionary<string, object> a)
    {
        List<int> path = new List<int>();
        object v;
        if (a.TryGetValue("path", out v))
        {
            System.Collections.IEnumerable list = v as System.Collections.IEnumerable;
            if (list != null && !(v is string)) foreach (object o in list) path.Add(Convert.ToInt32(o));
        }
        return path;
    }

    /// <summary>
    /// O elemento de um ref (mapa da ultima arvore) ou, sem ele, do path. Em
    /// qualquer caso confere papel e nome: se nao bate, e "indice velho" - nunca
    /// o elemento errado.
    /// </summary>
    static AutomationElement Resolve(int pid, Dictionary<string, object> a)
    {
        Dictionary<string, object> window = Dict(a, "window");
        Dictionary<string, object> expect = Dict(a, "expect");
        string expectRole = expect != null ? Str(expect, "role") : null;
        string expectTitle = expect != null ? Str(expect, "title") : null;
        string key = Str(a, "ref");
        RefMap map;
        Maps.TryGetValue(pid, out map);

        bool identityFailed = false;
        AutomationElement el;
        if (key != null && map != null && map.Elements.TryGetValue(key, out el))
        {
            if (Matches(el, expectRole, expectTitle)) return el;
            identityFailed = true;
        }

        IntPtr hwnd = IntPtr.Zero;
        if (window != null && window.ContainsKey("id")) hwnd = new IntPtr(Convert.ToInt64(window["id"]));
        else if (map != null) hwnd = new IntPtr(map.WindowId);
        if (hwnd != IntPtr.Zero && IsWindow(hwnd))
        {
            List<int> path = PathArg(a);
            AutomationElement root = map != null && map.Root != null && map.WindowId == (int)hwnd.ToInt64() ? map.Root : AutomationElement.FromHandle(hwnd);
            AutomationElement byPath = null;
            try { byPath = WalkPath(root, path); }
            catch (ElementNotAvailableException) { }
            if (byPath != null)
            {
                if (Matches(byPath, expectRole, expectTitle)) return byPath;
                identityFailed = true;
            }
        }
        if (identityFailed)
            throw new HostError("staleIndex", "The element at that index is not the same anymore (its role or name changed) - call cu_observe again.");
        throw new HostError("staleRef", "The element is gone - call cu_observe again and use the new indices.");
    }

    static Dictionary<string, object> Snapshot(AutomationElement el)
    {
        string role;
        AutomationElement cached = el.GetUpdatedCache(MakeCache());
        Dictionary<string, object> n = ReadNode(cached, DefaultTextLimit, 0, new RefMap(), out role);
        n.Remove("ref");
        n.Remove("_writable");
        return n;
    }

    static bool IsTextEntry(AutomationElement e)
    {
        try
        {
            string role = RoleLive(e);
            if (role != "Edit" && role != "Document" && role != "ComboBox") return false;
            ValuePattern vp;
            if (TryPattern(e, ValuePattern.Pattern, out vp) && !vp.Current.IsReadOnly) return true;
            TextPattern tp;
            return TryPattern(e, TextPattern.Pattern, out tp);
        }
        catch (Exception) { return false; }
    }

    static void RememberTarget(int pid, AutomationElement el)
    {
        FocusRef f = new FocusRef();
        f.El = el;
        f.At = DateTime.UtcNow;
        Targets[pid] = f;
    }

    static object OpElement(Dictionary<string, object> a)
    {
        CheckDesktop();
        int pid = Int(a, "pid", 0);
        AutomationElement el = Resolve(pid, a);
        string kind = Str(a, "kind");
        switch (kind)
        {
            case "info":
                return Obj("done", "info", "node", Snapshot(el));
            case "press":
                {
                    List<string> wanted = new List<string>();
                    object v;
                    if (a.TryGetValue("actions", out v) && v is System.Collections.IEnumerable && !(v is string))
                        foreach (object o in (System.Collections.IEnumerable)v) wanted.Add(Convert.ToString(o));
                    if (wanted.Count == 0) wanted.Add("AXPress");
                    foreach (string action in wanted)
                    {
                        bool unconfirmed;
                        if (Perform(el, action, out unconfirmed))
                            return Obj("done", "press", "action", action, "unconfirmed", unconfirmed, "node", Snapshot(el));
                    }
                    return Obj("done", null, "node", Snapshot(el));
                }
            case "focus":
                // Sem SetFocus: so guarda o alvo da proxima digitacao.
                if (!IsTextEntry(el) && !el.Current.IsKeyboardFocusable) return Obj("done", null, "node", Snapshot(el));
                RememberTarget(pid, el);
                return Obj("done", "focus", "node", Snapshot(el));
            case "setValue":
                return SetValue(el, Str(a, "value") ?? "");
            case "select":
                return SelectText(el, Str(a, "find"), Int(a, "occurrence", 1));
        }
        throw new HostError("badRequest", "Unknown element action: " + kind);
    }

    static object SetValue(AutomationElement el, string value)
    {
        ValuePattern vp;
        if (TryPattern(el, ValuePattern.Pattern, out vp) && !vp.Current.IsReadOnly)
        {
            bool unconfirmed;
            if (!Guarded(delegate () { vp.SetValue(value); }, out unconfirmed)) return Obj("done", null, "node", Snapshot(el));
            string after = null;
            try { after = vp.Current.Value; } catch (Exception) { }
            return Obj("done", "setValue", "node", Snapshot(el), "readBack", Clip(after, 300));
        }
        RangeValuePattern range;
        double number;
        if (TryPattern(el, RangeValuePattern.Pattern, out range) && !range.Current.IsReadOnly
            && double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out number))
        {
            bool unconfirmed;
            if (!Guarded(delegate () { range.SetValue(number); }, out unconfirmed)) return Obj("done", null, "node", Snapshot(el));
            return Obj("done", "setValue", "node", Snapshot(el), "readBack", Convert.ToString(range.Current.Value, System.Globalization.CultureInfo.InvariantCulture));
        }
        return Obj("done", null, "node", Snapshot(el));
    }

    // ------------------------------------------------------------------ texto

    /// <summary>Selecao do TextPattern como (inicio, tamanho, texto), contada em caracteres.</summary>
    static bool SelectionOffsets(TextPattern tp, out int location, out int length, out string text)
    {
        location = 0;
        length = 0;
        text = null;
        TextPatternRange[] sel = tp.GetSelection();
        if (sel == null || sel.Length == 0) return false;
        TextPatternRange r = sel[0];
        text = r.GetText(1000000);
        length = text.Length;
        TextPatternRange pre = tp.DocumentRange.Clone();
        pre.MoveEndpointByRange(TextPatternRangeEndpoint.End, r, TextPatternRangeEndpoint.Start);
        location = pre.GetText(-1).Length;
        return true;
    }

    static object SelectText(AutomationElement el, string find, int occurrence)
    {
        TextPattern tp;
        if (TryPattern(el, TextPattern.Pattern, out tp))
        {
            TextPatternRange doc = tp.DocumentRange;
            TextPatternRange target = doc;
            if (!string.IsNullOrEmpty(find))
            {
                // A n-esima ocorrencia: depois de cada achado, busca de novo a partir do fim dele.
                TextPatternRange scope = doc.Clone();
                target = null;
                for (int i = 0; i < Math.Max(1, occurrence); i++)
                {
                    TextPatternRange hit = scope.FindText(find, false, false);
                    if (hit == null) { target = null; break; }
                    target = hit;
                    scope = doc.Clone();
                    scope.MoveEndpointByRange(TextPatternRangeEndpoint.Start, hit, TextPatternRangeEndpoint.End);
                }
                if (target == null) return Obj("done", null, "node", Snapshot(el));
            }
            target.Select();
            int loc, len;
            string txt;
            if (SelectionOffsets(tp, out loc, out len, out txt))
                return Obj("done", "select", "node", Snapshot(el), "selection", Obj("location", loc, "length", len, "text", Clip(txt, 120)));
            return Obj("done", "select", "node", Snapshot(el), "selection", null);
        }
        // Edit Win32 sem TextPattern: o proprio controle seleciona (EM_SETSEL nao ativa janela nenhuma).
        int handle = 0;
        try { handle = el.Current.NativeWindowHandle; } catch (Exception) { }
        ValuePattern vp;
        if (handle != 0 && TryPattern(el, ValuePattern.Pattern, out vp))
        {
            string value = vp.Current.Value ?? "";
            int start = 0, end = value.Length;
            if (!string.IsNullOrEmpty(find))
            {
                int from = 0, found = -1;
                for (int i = 0; i < Math.Max(1, occurrence); i++)
                {
                    found = value.IndexOf(find, from, StringComparison.Ordinal);
                    if (found < 0) break;
                    from = found + find.Length;
                }
                if (found < 0) return Obj("done", null, "node", Snapshot(el));
                start = found;
                end = found + find.Length;
            }
            SendMessagePtr(new IntPtr(handle), EM_SETSEL, new IntPtr(start), new IntPtr(end));
            return Obj("done", "select", "node", Snapshot(el), "selection", Obj("location", start, "length", end - start, "text", Clip(value.Substring(start, end - start), 120)));
        }
        return Obj("done", null, "node", Snapshot(el));
    }

    /// <summary>O elemento que recebe a digitacao do app: o foco da UIA, ou o foco da thread da janela (app em segundo plano).</summary>
    static AutomationElement FocusedOf(int pid)
    {
        AutomationElement f = null;
        try { f = AutomationElement.FocusedElement; }
        catch (Exception) { }
        try
        {
            if (f != null && f.Current.ProcessId == pid) return f;
        }
        catch (Exception) { }
        // App em segundo plano: o foco "do sistema" e de outro app. A thread da
        // janela guarda o proprio controle com foco.
        IntPtr hwnd = WindowOfPid(pid);
        if (hwnd == IntPtr.Zero) return null;
        GUITHREADINFO info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        uint ignored;
        uint thread = GetWindowThreadProcessId(hwnd, out ignored);
        if (GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero)
        {
            try { return AutomationElement.FromHandle(info.hwndFocus); }
            catch (Exception) { }
        }
        return null;
    }

    static string Splice(AutomationElement target, string before, string text)
    {
        try
        {
            TextPattern tp;
            if (TryPattern(target, TextPattern.Pattern, out tp))
            {
                int loc, len;
                string sel;
                if (SelectionOffsets(tp, out loc, out len, out sel) && before.Length >= loc + len
                    && string.CompareOrdinal(before, loc, sel ?? "", 0, len) == 0)
                    return before.Substring(0, loc) + text + before.Substring(loc + len);
            }
        }
        catch (Exception) { }
        return before + text;
    }

    /// <summary>
    /// Texto em segundo plano: Edit/RichEdit nativo troca a selecao pelo proprio
    /// controle (EM_REPLACESEL); o resto vai pelo ValuePattern. Nada de teclado
    /// sintetico: nao ha como garantir qual janela o recebe.
    /// </summary>
    static object InsertText(int pid, string text)
    {
        AutomationElement target = null;
        FocusRef fr;
        if (Targets.TryGetValue(pid, out fr) && (DateTime.UtcNow - fr.At).TotalSeconds < FocusTargetSeconds) target = fr.El;
        if (target == null) target = FocusedOf(pid);
        if (target == null)
            throw new HostError("unavailable", "No text field is focused in this app. Click a text field first, or pass its element index to type.");
        try
        {
            if (target.Current.IsPassword)
                throw new HostError("secureField", "The target is a secure (password) field. Never type passwords, 2FA codes or payment data - ask the user to type it themselves.");
        }
        catch (ElementNotAvailableException) { throw new HostError("staleRef", "The text field is gone - observe again."); }

        string cls = "";
        int handle = 0;
        try { cls = target.Current.ClassName ?? ""; handle = target.Current.NativeWindowHandle; } catch (Exception) { }
        if (handle != 0 && (cls.StartsWith("Edit", StringComparison.Ordinal) || cls.StartsWith("RICHEDIT", StringComparison.OrdinalIgnoreCase)))
        {
            SendMessageText(new IntPtr(handle), EM_REPLACESEL, new IntPtr(1), text);
            return Obj("done", "keys", "method", "EM_REPLACESEL");
        }
        ValuePattern vp;
        if (TryPattern(target, ValuePattern.Pattern, out vp) && !vp.Current.IsReadOnly)
        {
            string before = vp.Current.Value ?? "";
            string after = Splice(target, before, text);
            bool unconfirmed;
            Guarded(delegate () { vp.SetValue(after); }, out unconfirmed);
            string now = vp.Current.Value ?? "";
            if (now != before || text.Length == 0) return Obj("done", "keys", "method", "ValuePattern");
            throw new HostError("unavailable", "The field did not take the text (its value did not change). Use the global pointer to type for real.");
        }
        throw new HostError("unavailable", "That element does not accept text in the background (no editable value). Use the global pointer to type for real.");
    }

    // ------------------------------------------------------------------- hit

    static bool OwnedBy(IntPtr top, int pid)
    {
        if (top == IntPtr.Zero) return false;
        RefMap map;
        if (Maps.TryGetValue(pid, out map) && map.WindowId != 0 && top == new IntPtr(map.WindowId)) return true;
        return PidOf(top) == (uint)pid;
    }

    static object OpHit(Dictionary<string, object> a)
    {
        CheckDesktop();
        int pid = Int(a, "pid", 0);
        double x = Dbl(a, "x", 0), y = Dbl(a, "y", 0);
        POINT pt = new POINT();
        pt.X = (int)Math.Round(x);
        pt.Y = (int)Math.Round(y);
        IntPtr top = GetAncestor(WindowFromPoint(pt), GA_ROOT);
        // Janela de outro app por cima do ponto: a UIA devolveria o elemento DELA.
        if (!OwnedBy(top, pid)) return Obj("done", null, "reason", "covered");
        AutomationElement hit = AutomationElement.FromPoint(new System.Windows.Point(x, y));
        if (hit == null) return Obj("done", null, "reason", "nothingAtPoint");

        List<string> wanted = new List<string>();
        object v;
        if (a.TryGetValue("actions", out v) && v is System.Collections.IEnumerable && !(v is string))
            foreach (object o in (System.Collections.IEnumerable)v) wanted.Add(Convert.ToString(o));
        bool focusText = Bool(a, "focusText");
        Dictionary<string, object> first = null;
        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement el = hit;
        for (int depth = 0; el != null && depth < 7; depth++)
        {
            if (first == null) first = Snapshot(el);
            foreach (string action in wanted)
            {
                bool unconfirmed;
                if (Perform(el, action, out unconfirmed))
                    return Obj("done", "press", "action", action, "unconfirmed", unconfirmed, "node", depth == 0 ? first : Snapshot(el), "depth", depth);
            }
            if (focusText && IsTextEntry(el))
            {
                RememberTarget(pid, el);
                return Obj("done", "focus", "node", depth == 0 ? first : Snapshot(el), "depth", depth);
            }
            if (RoleLive(el) == "Window") break;
            el = walker.GetParent(el);
        }
        return Obj("done", null, "node", first);
    }

    static object OpScrollAx(Dictionary<string, object> a)
    {
        CheckDesktop();
        int pid = Int(a, "pid", 0);
        double x = Dbl(a, "x", 0), y = Dbl(a, "y", 0), dx = Dbl(a, "dx", 0), dy = Dbl(a, "dy", 0);
        POINT pt = new POINT();
        pt.X = (int)Math.Round(x);
        pt.Y = (int)Math.Round(y);
        if (!OwnedBy(GetAncestor(WindowFromPoint(pt), GA_ROOT), pid)) return Obj("done", null, "reason", "covered");
        AutomationElement el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
        if (el == null) return Obj("done", null, "reason", "nothingAtPoint");
        TreeWalker walker = TreeWalker.ControlViewWalker;
        int ticks = (int)Math.Max(1, Math.Min(20, Math.Round(Math.Max(Math.Abs(dx), Math.Abs(dy)) / 60.0)));
        for (int depth = 0; el != null && depth < 12; depth++)
        {
            ScrollPattern sp;
            if (TryPattern(el, ScrollPattern.Pattern, out sp))
            {
                bool vertical = dy != 0 && sp.Current.VerticallyScrollable;
                bool horizontal = dx != 0 && sp.Current.HorizontallyScrollable;
                if (vertical || horizontal)
                {
                    // Roda positiva = conteudo desce (rolar para cima): dy < 0 e rolar PARA BAIXO.
                    ScrollAmount v = !vertical ? ScrollAmount.NoAmount : (dy < 0 ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement);
                    ScrollAmount h = !horizontal ? ScrollAmount.NoAmount : (dx < 0 ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement);
                    for (int i = 0; i < ticks; i++) sp.Scroll(h, v);
                    return Obj("done", "scroll", "ticks", ticks);
                }
            }
            el = walker.GetParent(el);
        }
        return Obj("done", null, "reason", "noScrollArea");
    }

    static object OpFocused(Dictionary<string, object> a)
    {
        CheckDesktop();
        AutomationElement f = FocusedOf(Int(a, "pid", 0));
        if (f == null) return Obj("node", null);
        try { return Obj("node", Snapshot(f)); }
        catch (ElementNotAvailableException) { return Obj("node", null); }
    }

    static object OpSelection(Dictionary<string, object> a)
    {
        CheckDesktop();
        AutomationElement f = FocusedOf(Int(a, "pid", 0));
        TextPattern tp;
        if (f == null || !TryPattern(f, TextPattern.Pattern, out tp)) return Obj("selection", null);
        int loc, len;
        string txt;
        if (!SelectionOffsets(tp, out loc, out len, out txt)) return Obj("selection", null);
        return Obj("selection", Obj("location", loc, "length", len, "text", Clip(txt, 120)));
    }

    // ------------------------------------------------------- janelas e foco

    static IntPtr WindowOfPid(int pid)
    {
        RefMap map;
        if (Maps.TryGetValue(pid, out map) && map.WindowId != 0 && IsWindow(new IntPtr(map.WindowId))) return new IntPtr(map.WindowId);
        foreach (WinRow row in ListWindows()) if (row.Proc.Pid == pid) return row.Hwnd;
        return IntPtr.Zero;
    }

    static IntPtr WindowArg(Dictionary<string, object> a, int pid)
    {
        object v;
        if (a.TryGetValue("windowId", out v) && v != null)
        {
            IntPtr h = new IntPtr(Convert.ToInt64(v));
            if (IsWindow(h)) return h;
        }
        IntPtr byPid = WindowOfPid(pid);
        if (byPid == IntPtr.Zero) throw new HostError("windowNotFound", "The app has no visible window - call cu_apps again.");
        return byPid;
    }

    /// <summary>Traz a janela para a frente (so no ponteiro global, que o usuario ligou) e confirma.</summary>
    static void EnsureFront(IntPtr hwnd)
    {
        if (!IsWindow(hwnd)) throw new HostError("windowNotFound", "The window is gone - call cu_apps again.");
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        if (!InFront(hwnd))
        {
            SetForegroundWindow(hwnd);
            WaitFront(hwnd);
        }
        if (!InFront(hwnd))
        {
            // O Windows so deixa trocar o foco a quem acabou de receber entrada: um toque na tecla Alt libera.
            Send(KeyInput(0x12, 0), KeyInput(0x12, KEYEVENTF_KEYUP));
            SetForegroundWindow(hwnd);
            WaitFront(hwnd);
        }
        if (!InFront(hwnd))
            throw new HostError("unavailable", "Could not bring the app to the front (Windows blocks focus changes in some situations). Nothing was typed or clicked.");
    }

    static bool InFront(IntPtr hwnd)
    {
        IntPtr fg = GetForegroundWindow();
        return fg == hwnd || (fg != IntPtr.Zero && PidOf(fg) == PidOf(hwnd));
    }

    static void WaitFront(IntPtr hwnd)
    {
        for (int i = 0; i < 8 && !InFront(hwnd); i++) Thread.Sleep(40);
    }

    static object OpActivate(Dictionary<string, object> a)
    {
        CheckDesktop();
        EnsureFront(WindowArg(a, Int(a, "pid", 0)));
        return Obj("done", "activate");
    }

    // ------------------------------------------------------------- SendInput

    static void Send(params INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length)
            throw new HostError("elevated", "Windows rejected the input. The app may be running as administrator (Windows blocks a normal app from controlling it) or a security screen is in front.");
    }

    static INPUT KeyInput(ushort vk, int flags)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        bool extended = (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B;
        i.u.ki.dwFlags = flags | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
        return i;
    }

    static INPUT UnicodeInput(char c, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = 0;
        i.u.ki.wScan = c;
        i.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        return i;
    }

    static INPUT MouseInput(int flags, int dx, int dy, int data)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dwFlags = flags;
        i.u.mi.dx = dx;
        i.u.mi.dy = dy;
        i.u.mi.mouseData = data;
        return i;
    }

    static void MoveAbs(int x, int y)
    {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
        int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
        Send(MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0));
    }

    static double EaseInOut(double t)
    {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;
    }

    /// <summary>O cursor desliza ate o alvo em vez de saltar: a pessoa acompanha o que o agente faz.</summary>
    static void Glide(int x, int y, int ms)
    {
        POINT start;
        GetCursorPos(out start);
        double dx = x - start.X, dy = y - start.Y;
        if (Math.Sqrt(dx * dx + dy * dy) < 4) { MoveAbs(x, y); return; }
        int steps = Math.Max(6, (ms > 0 ? ms : DefaultGlideMs) / 16);
        for (int i = 1; i < steps; i++)
        {
            double k = EaseInOut((double)i / steps);
            MoveAbs((int)Math.Round(start.X + dx * k), (int)Math.Round(start.Y + dy * k));
            Thread.Sleep(16);
        }
        MoveAbs(x, y);
    }

    static void RequireGlobal(Dictionary<string, object> a, string what)
    {
        if (Str(a, "mode") != "global")
            throw new HostError("unavailable", what + " needs the global pointer on Windows (it moves the real cursor and brings the app to the front). In directed mode only UI Automation actions work: element indices, set_value, select_text, invoke, and type into a text field.");
    }

    /// <summary>A janela certa esta mesmo sob o ponto? Entrada real no app errado e o pior erro aqui.</summary>
    static void CheckPointOwned(IntPtr hwnd, int x, int y)
    {
        POINT pt = new POINT();
        pt.X = x;
        pt.Y = y;
        IntPtr top = GetAncestor(WindowFromPoint(pt), GA_ROOT);
        if (top != hwnd && PidOf(top) != PidOf(hwnd))
            throw new HostError("unavailable", "Another window is on top of that point, so the click would go to a different app. Nothing was clicked.");
    }

    static object OpMouse(Dictionary<string, object> a)
    {
        CheckDesktop();
        RequireGlobal(a, "Mouse input");
        int pid = Int(a, "pid", 0);
        IntPtr hwnd = WindowArg(a, pid);
        int x = (int)Math.Round(Dbl(a, "x", 0)), y = (int)Math.Round(Dbl(a, "y", 0));
        string kind = Str(a, "kind") ?? "click";
        string button = Str(a, "button") ?? "left";
        int clicks = Math.Max(1, Int(a, "clicks", 1));

        EnsureFront(hwnd);
        CheckPointOwned(hwnd, x, y);
        Glide(x, y, Int(a, "glideMs", DefaultGlideMs));
        if (kind == "move") return Obj("done", "move");

        int down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
        int up = button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
        for (int i = 0; i < clicks; i++)
        {
            Send(MouseInput(down, 0, 0, 0));
            Thread.Sleep(12);
            Send(MouseInput(up, 0, 0, 0));
            if (i + 1 < clicks) Thread.Sleep(40);
        }
        return Obj("done", "click", "clicks", clicks);
    }

    static object OpDrag(Dictionary<string, object> a)
    {
        CheckDesktop();
        RequireGlobal(a, "Dragging");
        int pid = Int(a, "pid", 0);
        IntPtr hwnd = WindowArg(a, pid);
        double[] from = PointArg(a, "from"), to = PointArg(a, "to");
        int fx = (int)Math.Round(from[0]), fy = (int)Math.Round(from[1]), tx = (int)Math.Round(to[0]), ty = (int)Math.Round(to[1]);
        EnsureFront(hwnd);
        CheckPointOwned(hwnd, fx, fy);
        Glide(fx, fy, DefaultGlideMs);
        Send(MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0));
        Thread.Sleep(40);
        int steps = Math.Max(8, Int(a, "steps", 24));
        for (int i = 1; i <= steps; i++)
        {
            double k = (double)i / steps;
            MoveAbs((int)Math.Round(fx + (tx - fx) * k), (int)Math.Round(fy + (ty - fy) * k));
            Thread.Sleep(10);
        }
        Thread.Sleep(40);
        Send(MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0));
        return Obj("done", "drag");
    }

    static double[] PointArg(Dictionary<string, object> a, string key)
    {
        object v;
        System.Collections.IEnumerable list = a.TryGetValue(key, out v) ? v as System.Collections.IEnumerable : null;
        if (list == null) throw new HostError("badRequest", "Missing point: " + key);
        List<double> values = new List<double>();
        foreach (object o in list) values.Add(Convert.ToDouble(o));
        if (values.Count < 2) throw new HostError("badRequest", "Bad point: " + key);
        return new double[] { values[0], values[1] };
    }

    static object OpScroll(Dictionary<string, object> a)
    {
        CheckDesktop();
        RequireGlobal(a, "Wheel scrolling");
        int pid = Int(a, "pid", 0);
        IntPtr hwnd = WindowArg(a, pid);
        int x = (int)Math.Round(Dbl(a, "x", 0)), y = (int)Math.Round(Dbl(a, "y", 0));
        double dx = Dbl(a, "dx", 0), dy = Dbl(a, "dy", 0);
        EnsureFront(hwnd);
        CheckPointOwned(hwnd, x, y);
        Glide(x, y, DefaultGlideMs);
        // act.ts manda pixels (60 por passo) com roda positiva = rolar para cima; o Windows usa 120 por passo
        // e, na horizontal, positivo = direita (o contrario do contrato).
        if (dy != 0) Send(MouseInput(MOUSEEVENTF_WHEEL, 0, 0, (int)Math.Round(dy * 2)));
        if (dx != 0) Send(MouseInput(MOUSEEVENTF_HWHEEL, 0, 0, (int)Math.Round(-dx * 2)));
        return Obj("done", "scroll");
    }

    static void SendCombo(ushort vk, int flags)
    {
        List<INPUT> inputs = new List<INPUT>();
        List<ushort> mods = new List<ushort>();
        if ((flags & FlagCtrl) != 0) mods.Add(0x11);
        if ((flags & FlagShift) != 0) mods.Add(0x10);
        if ((flags & FlagAlt) != 0) mods.Add(0x12);
        if ((flags & FlagWin) != 0) mods.Add(0x5B);
        foreach (ushort m in mods) inputs.Add(KeyInput(m, 0));
        inputs.Add(KeyInput(vk, 0));
        inputs.Add(KeyInput(vk, KEYEVENTF_KEYUP));
        for (int i = mods.Count - 1; i >= 0; i--) inputs.Add(KeyInput(mods[i], KEYEVENTF_KEYUP));
        Send(inputs.ToArray());
    }

    static void SendText(string text)
    {
        foreach (char c in text)
        {
            if (c == '\r') continue;
            if (c == '\n') { SendCombo(0x0D, 0); Thread.Sleep(6); continue; }
            if (c == '\t') { SendCombo(0x09, 0); Thread.Sleep(6); continue; }
            Send(UnicodeInput(c, false), UnicodeInput(c, true));
            Thread.Sleep(4);
        }
    }

    static object OpKeys(Dictionary<string, object> a)
    {
        CheckDesktop();
        int pid = Int(a, "pid", 0);
        string text = Str(a, "text");
        object combosArg;
        System.Collections.IEnumerable combos = a.TryGetValue("combos", out combosArg) ? combosArg as System.Collections.IEnumerable : null;
        bool hasCombos = false;
        if (combos != null) foreach (object o in combos) { hasCombos = true; break; }

        if (Str(a, "mode") != "global")
        {
            // Dirigido: so texto, e so em campo editavel. Atalho de teclado precisaria de entrada real.
            if (hasCombos)
                throw new HostError("unavailable", "Keyboard shortcuts need the global pointer on Windows (they are real key presses and bring the app to the front). In directed mode use set_value, select_text, invoke or an element index instead.");
            if (string.IsNullOrEmpty(text)) return Obj("done", "keys");
            return InsertText(pid, text);
        }

        EnsureFront(WindowArg(a, pid));
        // No ponteiro global o app ja esta na frente por escolha do usuario: aqui o
        // alvo guardado pelo "focus" ganha o foco de verdade, para a digitacao cair nele.
        FocusRef pending;
        if (Targets.TryGetValue(pid, out pending) && (DateTime.UtcNow - pending.At).TotalSeconds < FocusTargetSeconds)
        {
            try { pending.El.SetFocus(); }
            catch (Exception) { }
        }
        if (hasCombos)
        {
            foreach (object o in combos)
            {
                Dictionary<string, object> c = (Dictionary<string, object>)o;
                SendCombo((ushort)Int(c, "code", 0), Int(c, "flags", 0));
                Thread.Sleep(20);
            }
        }
        if (!string.IsNullOrEmpty(text)) SendText(text);
        return Obj("done", "keys");
    }

    // ------------------------------------------------------------- abrir app

    static bool NameMatches(WinRow row, string query)
    {
        string q = query.Trim();
        string exe = row.Proc.Exe ?? "";
        if (string.Equals(exe, q, StringComparison.OrdinalIgnoreCase) || string.Equals(exe, q + ".exe", StringComparison.OrdinalIgnoreCase)) return true;
        if (row.Proc.Aumid != null && string.Equals(row.Proc.Aumid, q, StringComparison.OrdinalIgnoreCase)) return true;
        string name = row.Proc.Name ?? "";
        return string.Equals(name, q, StringComparison.OrdinalIgnoreCase);
    }

    static string AppPathOf(string exe)
    {
        string sub = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe;
        foreach (RegistryHive hive in new RegistryHive[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(hive, RegistryView.Default))
                using (RegistryKey key = baseKey.OpenSubKey(sub))
                {
                    if (key == null) continue;
                    string path = key.GetValue(null) as string;
                    if (!string.IsNullOrEmpty(path)) return path.Trim('"');
                }
            }
            catch (Exception) { }
        }
        return null;
    }

    static string StartMenuLink(string query)
    {
        string best = null;
        foreach (Environment.SpecialFolder folder in new Environment.SpecialFolder[] { Environment.SpecialFolder.Programs, Environment.SpecialFolder.CommonPrograms })
        {
            string dir = Environment.GetFolderPath(folder);
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
            string[] files;
            try { files = Directory.GetFiles(dir, "*.lnk", SearchOption.AllDirectories); }
            catch (Exception) { continue; }
            foreach (string f in files)
            {
                string name = Path.GetFileNameWithoutExtension(f);
                if (name.IndexOf("uninstall", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("desinstal", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                if (string.Equals(name, query, StringComparison.OrdinalIgnoreCase)) return f;
                if (best == null && name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0) best = f;
            }
        }
        return best;
    }

    /// <summary>Apps empacotados (Calculadora, Fotos...) nao tem atalho: o Get-StartApps do Windows conhece o AUMID.</summary>
    static string StartAppsId(string query)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command \"Get-StartApps | ConvertTo-Json -Compress\"");
            psi.RedirectStandardOutput = true;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            using (Process p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd();
                if (!p.WaitForExit(8000)) { try { p.Kill(); } catch (Exception) { } return null; }
                object parsed = Json.DeserializeObject(output);
                System.Collections.IEnumerable list = parsed as System.Collections.IEnumerable;
                Dictionary<string, object> single = parsed as Dictionary<string, object>;
                List<Dictionary<string, object>> entries = new List<Dictionary<string, object>>();
                if (single != null) entries.Add(single);
                else if (list != null) foreach (object o in list) { Dictionary<string, object> d = o as Dictionary<string, object>; if (d != null) entries.Add(d); }
                string contains = null;
                foreach (Dictionary<string, object> d in entries)
                {
                    string name = Str(d, "Name"), id = Str(d, "AppID");
                    if (name == null || id == null) continue;
                    if (string.Equals(name, query, StringComparison.OrdinalIgnoreCase)) return id;
                    if (contains == null && name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0) contains = id;
                }
                return contains;
            }
        }
        catch (Exception) { return null; }
    }

    static bool StartShell(string target, string args)
    {
        try
        {
            ProcessStartInfo psi = args == null ? new ProcessStartInfo(target) : new ProcessStartInfo(target, args);
            psi.UseShellExecute = true;
            Process.Start(psi);
            return true;
        }
        catch (Exception) { return false; }
    }

    /// <summary>
    /// So abre o que e app de verdade: AUMID, exe/atalho por caminho absoluto, App
    /// Paths, programas conhecidos do sistema, atalhos do Menu Iniciar e apps
    /// empacotados. Nunca "executa a string que o modelo mandou".
    /// </summary>
    static bool Launch(string query)
    {
        bool hasSeparator = query.IndexOfAny(new char[] { '\\', '/', ':' }) >= 0;
        if (!hasSeparator && query.IndexOf('!') > 0) return StartShell("explorer.exe", "shell:AppsFolder\\" + query);
        if (Path.IsPathRooted(query))
        {
            string ext = Path.GetExtension(query).ToLowerInvariant();
            if ((ext == ".exe" || ext == ".lnk") && File.Exists(query)) return StartShell(query, null);
            return false;
        }
        if (hasSeparator) return false;
        string exe = query.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? query : query + ".exe";
        string registered = AppPathOf(exe);
        if (registered != null && File.Exists(registered)) return StartShell(registered, null);
        string system = Path.Combine(Environment.SystemDirectory, exe);
        if (File.Exists(system)) return StartShell(system, null);
        string link = StartMenuLink(query);
        if (link != null) return StartShell(link, null);
        string aumid = StartAppsId(query);
        if (aumid != null) return StartShell("explorer.exe", "shell:AppsFolder\\" + aumid);
        return false;
    }

    static WinRow FindRunning(List<WinRow> rows, string query)
    {
        foreach (WinRow r in rows) if (NameMatches(r, query)) return r;
        string q = query.Trim();
        foreach (WinRow r in rows) if (r.Proc.Name != null && r.Proc.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) return r;
        return null;
    }

    static object OpOpenApp(Dictionary<string, object> a)
    {
        CheckDesktop();
        string app = Str(a, "app");
        if (string.IsNullOrWhiteSpace(app)) throw new HostError("badRequest", "open_app needs the app name.");
        string query = app.Trim();

        List<WinRow> rows = ListWindows();
        WinRow running = FindRunning(rows, query);
        if (running != null)
        {
            EnsureFront(running.Hwnd);
            return Obj("done", "activate", "pid", running.Proc.Pid);
        }
        HashSet<long> before = new HashSet<long>();
        foreach (WinRow r in rows) before.Add(r.Hwnd.ToInt64());

        if (!Launch(query)) throw new HostError("appNotFound", "Could not open \"" + query + "\" - check the app name (an executable name, a Start Menu name or an app id).");

        // Abrir leva um instante ate a janela existir.
        for (int i = 0; i < 40; i++)
        {
            Thread.Sleep(200);
            List<WinRow> now = ListWindows();
            WinRow found = FindRunning(now, query);
            if (found == null) foreach (WinRow r in now) if (!before.Contains(r.Hwnd.ToInt64())) { found = r; break; }
            if (found != null) return Obj("done", "launched", "pid", found.Proc.Pid);
        }
        return Obj("done", "launched", "pid", null);
    }

    // ------------------------------------------------------- operacoes do probe

    static object OpForeground()
    {
        IntPtr fg = GetForegroundWindow();
        return Obj("window", fg.ToInt64(), "pid", fg == IntPtr.Zero ? 0 : (int)PidOf(fg), "title", fg == IntPtr.Zero ? null : TextOf(fg));
    }

    static object OpCursor()
    {
        POINT p;
        GetCursorPos(out p);
        return Obj("x", p.X, "y", p.Y);
    }

    static object OpDisplays()
    {
        List<object> monitors = new List<object>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data)
        {
            MONITORINFO info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            GetMonitorInfo(monitor, ref info);
            uint dx = 96, dy = 96;
            try { GetDpiForMonitor(monitor, 0, out dx, out dy); } catch (Exception) { }
            monitors.Add(Obj("frame", Frame(info.rcMonitor), "work", Frame(info.rcWork), "dpi", (int)dx, "scale", dx / 96.0, "primary", (info.dwFlags & 1) != 0));
            return true;
        }, IntPtr.Zero);
        return Obj("monitors", monitors);
    }

    /// <summary>A mesma varredura da arvore SEM CacheRequest (uma chamada por propriedade), para comparar.</summary>
    static object OpTreeBench(Dictionary<string, object> a)
    {
        DateTime started = DateTime.UtcNow;
        IntPtr hwnd = new IntPtr(Convert.ToInt64(Dict(a, "window")["id"]));
        int maxNodes = Int(a, "maxNodes", 1500);
        TreeWalker walker = TreeWalker.ControlViewWalker;
        Queue<AutomationElement> queue = new Queue<AutomationElement>();
        queue.Enqueue(AutomationElement.FromHandle(hwnd));
        int count = 0;
        while (queue.Count > 0 && count < maxNodes)
        {
            AutomationElement e = queue.Dequeue();
            try
            {
                AutomationElement.AutomationElementInformation c = e.Current;
                string touch = c.Name + c.AutomationId + c.ControlType.ProgrammaticName;
                bool flags = c.IsEnabled && c.HasKeyboardFocus && c.IsPassword;
                System.Windows.Rect r = c.BoundingRectangle;
                if (touch.Length < 0 || flags || r.IsEmpty) count += 0;
                count++;
                for (AutomationElement k = walker.GetFirstChild(e); k != null; k = walker.GetNextSibling(k)) queue.Enqueue(k);
            }
            catch (Exception) { }
        }
        return Obj("nodes", count, "ms", (int)(DateTime.UtcNow - started).TotalMilliseconds);
    }
}
