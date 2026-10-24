// Host do Computer Use no Windows: o C# que o windows.ps1 compila uma vez.
//
// C# 5 de proposito: e o que o Add-Type do PowerShell 5.1 aceita.
//
// Coordenadas: o processo e per-monitor DPI aware (v2), entao UIA, DWM,
// PrintWindow e GetWindowRect falam PIXEL FISICO do desktop virtual. E o
// espaco do contrato no Windows (ver docs/computer-use-windows.md).
//
// Identidade do elemento: cada arvore gera um "ref" por no (RuntimeId da UIA)
// e o host guarda ref -> AutomationElement ate a proxima arvore daquele pid.
// Quando o ref nao serve mais, as acoes caem para o "path" (indices de filhos
// na Control View a partir da janela) e SEMPRE conferem papel e nome antes de
// agir: melhor "indice velho" do que clicar no elemento errado.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public class HostError : Exception
{
    public string Code;
    public HostError(string code, string message) : base(message) { Code = code; }
}

public static class OrbitHost
{
    // ------------------------------------------------------------- Win32

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, int flags);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetRect(IntPtr hwnd, int attribute, out RECT value, int size);

    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);

    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int DWMWA_CLOAKED = 14;
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_APPWINDOW = 0x00040000;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const int GA_ROOT = 2;
    const uint PW_RENDERFULLCONTENT = 2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TOKEN_QUERY = 0x0008;
    const int TokenElevation = 20;
    const int DefaultTextLimit = 300;

    // ------------------------------------------------------------ estado

    static readonly JavaScriptSerializer Json = MakeJson();
    static bool selfElevatedKnown;
    static bool selfElevated;
    static int generation;
    static readonly Dictionary<int, RefMap> Maps = new Dictionary<int, RefMap>();
    static readonly Dictionary<string, string> NameByPath = new Dictionary<string, string>();

    class RefMap
    {
        public int Gen;
        public int WindowId;
        public AutomationElement Root;
        public Dictionary<string, AutomationElement> Elements = new Dictionary<string, AutomationElement>();
    }

    static JavaScriptSerializer MakeJson()
    {
        JavaScriptSerializer s = new JavaScriptSerializer();
        s.MaxJsonLength = int.MaxValue;
        s.RecursionLimit = 200;
        return s;
    }

    static OrbitHost()
    {
        // Antes de QUALQUER chamada de janela ou UIA: -4 = PER_MONITOR_AWARE_V2.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
    }

    // --------------------------------------------------------- protocolo

    /// <summary>Uma linha de pedido -> uma linha de resposta (nunca lanca).</summary>
    public static string Handle(string line)
    {
        object id = null;
        try
        {
            Dictionary<string, object> req = (Dictionary<string, object>)Json.DeserializeObject(line);
            if (req.ContainsKey("id")) id = req["id"];
            string op = Str(req, "op");
            Dictionary<string, object> args = req.ContainsKey("args") ? req["args"] as Dictionary<string, object> : null;
            if (args == null) args = new Dictionary<string, object>();
            object result = Dispatch(op, args);
            return Json.Serialize(Obj("id", id, "ok", true, "result", result));
        }
        catch (HostError e)
        {
            return Json.Serialize(Obj("id", id, "ok", false, "error", Obj("code", e.Code, "message", e.Message)));
        }
        catch (Exception e)
        {
            return Json.Serialize(Obj("id", id, "ok", false, "error", Obj("code", "bridgeError", "message", e.GetType().Name + ": " + e.Message)));
        }
    }

    static object Dispatch(string op, Dictionary<string, object> a)
    {
        switch (op)
        {
            case "ping": return Obj("pong", true);
            case "perms": return OpPerms();
            case "requestScreen": return Obj("before", true, "granted", true);
            case "apps": return OpApps();
            case "tree": return OpTree(a);
            case "capture": return OpCapture(a);
            case "restore": return Obj("done", "restore");
        }
        return DispatchAction(op, a);
    }

    // Ponto de extensao das acoes (mouse, teclado, elemento...): ver windows-host-actions.
    static object DispatchAction(string op, Dictionary<string, object> a)
    {
        throw new HostError("badRequest", "Unknown op: " + op);
    }

    // ----------------------------------------------------------- helpers

    static Dictionary<string, object> Obj(params object[] kv)
    {
        Dictionary<string, object> d = new Dictionary<string, object>();
        for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        return d;
    }

    static string Str(Dictionary<string, object> d, string key)
    {
        object v;
        return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : null;
    }

    static int Int(Dictionary<string, object> d, string key, int fallback)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return fallback;
        try { return Convert.ToInt32(v); } catch (Exception) { return fallback; }
    }

    static bool Bool(Dictionary<string, object> d, string key)
    {
        object v;
        return d.TryGetValue(key, out v) && v is bool && (bool)v;
    }

    static string Clip(string text, int limit)
    {
        if (string.IsNullOrEmpty(text)) return null;
        return text.Length > limit ? text.Substring(0, limit) : text;
    }

    static int[] Frame(RECT r)
    {
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    // ------------------------------------------------- processos e janelas

    static bool SelfElevated()
    {
        if (!selfElevatedKnown)
        {
            IntPtr token;
            int value = 0, returned;
            if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token))
            {
                try { GetTokenInformation(token, TokenElevation, out value, 4, out returned); }
                finally { CloseHandle(token); }
            }
            selfElevated = value != 0;
            selfElevatedKnown = true;
        }
        return selfElevated;
    }

    /// <summary>
    /// O app roda com integridade maior que a nossa? O UIPI descarta mensagens
    /// e SendInput para ele - so recusamos com clareza. Nao conseguir nem abrir
    /// o token do processo e, na pratica, o mesmo sinal.
    /// </summary>
    static bool IsElevatedTarget(IntPtr process)
    {
        if (SelfElevated()) return false;
        if (process == IntPtr.Zero) return true;
        IntPtr token;
        if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return true;
        try
        {
            int value, returned;
            return GetTokenInformation(token, TokenElevation, out value, 4, out returned) && value != 0;
        }
        finally { CloseHandle(token); }
    }

    class ProcInfo
    {
        public int Pid;
        public string Path = "";
        public string Exe = "";
        public string Name = "";
        public string Aumid;
        public bool Elevated;
    }

    static ProcInfo InfoOf(uint pid)
    {
        ProcInfo info = new ProcInfo();
        info.Pid = (int)pid;
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        try
        {
            if (h != IntPtr.Zero)
            {
                StringBuilder sb = new StringBuilder(1024);
                int size = sb.Capacity;
                if (QueryFullProcessImageName(h, 0, sb, ref size)) info.Path = sb.ToString();
                uint len = 256;
                StringBuilder aumid = new StringBuilder((int)len);
                // 0 = sucesso; apps nao empacotados devolvem APPMODEL_ERROR_NO_PACKAGE.
                if (GetApplicationUserModelId(h, ref len, aumid) == 0) info.Aumid = aumid.ToString();
            }
            info.Elevated = IsElevatedTarget(h);
        }
        finally { if (h != IntPtr.Zero) CloseHandle(h); }
        info.Exe = info.Path.Length > 0 ? System.IO.Path.GetFileName(info.Path) : "";
        info.Name = NameOf(info);
        return info;
    }

    static string NameOf(ProcInfo info)
    {
        if (info.Path.Length == 0) return "pid " + info.Pid;
        string cached;
        if (NameByPath.TryGetValue(info.Path, out cached)) return cached;
        string name = null;
        try
        {
            FileVersionInfo v = FileVersionInfo.GetVersionInfo(info.Path);
            name = !string.IsNullOrEmpty(v.FileDescription) ? v.FileDescription : v.ProductName;
        }
        catch (Exception) { }
        if (string.IsNullOrEmpty(name)) name = System.IO.Path.GetFileNameWithoutExtension(info.Path);
        NameByPath[info.Path] = name;
        return name;
    }

    static uint PidOf(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return pid;
    }

    static string TextOf(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ClassOf(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    /// <summary>
    /// O retangulo UNICO de uma janela: o que o DWM desenha, sem a borda
    /// invisivel de ~7 px que o GetWindowRect inclui. Apps, captura e frames da
    /// arvore concordam porque todos partem daqui.
    /// </summary>
    static RECT FrameOf(IntPtr hwnd)
    {
        RECT r;
        if (DwmGetRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.Right > r.Left) return r;
        GetWindowRect(hwnd, out r);
        return r;
    }

    /// <summary>UAC, tela de bloqueio e Ctrl+Alt+Del rodam no desktop seguro: la nada e alcancavel.</summary>
    static void CheckDesktop()
    {
        IntPtr desktop = OpenInputDesktop(0, false, 0x0100);
        if (desktop == IntPtr.Zero)
            throw new HostError("secureDesktop", "A Windows security screen (UAC prompt, lock screen or Ctrl+Alt+Del) is in front. Nothing can be controlled until the user closes it.");
        CloseDesktop(desktop);
    }

    // -------------------------------------------------------------- perms

    static object OpPerms()
    {
        List<object> notes = new List<object>();
        notes.Add(SelfElevated()
            ? "Orbit is running as administrator."
            : "Orbit is running without administrator rights: apps running as administrator cannot be controlled.");
        IntPtr desktop = OpenInputDesktop(0, false, 0x0100);
        if (desktop == IntPtr.Zero) notes.Add("A Windows security screen (UAC, lock screen) is in front right now.");
        else CloseDesktop(desktop);
        return Obj("accessibility", true, "notes", notes);
    }

    // --------------------------------------------------------------- apps

    class WinRow
    {
        public IntPtr Hwnd;
        public ProcInfo Proc;
        public string Title;
        public int[] Frame;
    }

    static List<WinRow> ListWindows()
    {
        List<IntPtr> handles = new List<IntPtr>();
        // EnumWindows devolve na ordem z, da frente para tras.
        EnumWindows(delegate (IntPtr h, IntPtr l) { handles.Add(h); return true; }, IntPtr.Zero);

        Dictionary<uint, ProcInfo> procs = new Dictionary<uint, ProcInfo>();
        List<WinRow> rows = new List<WinRow>();
        foreach (IntPtr h in handles)
        {
            if (!IsWindowVisible(h) || IsIconic(h)) continue;
            int cloaked;
            if (DwmGetInt(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) continue;
            int ex = GetWindowLong(h, GWL_EXSTYLE);
            bool appWindow = (ex & WS_EX_APPWINDOW) != 0;
            if ((ex & WS_EX_TOOLWINDOW) != 0 && !appWindow) continue;
            if ((ex & WS_EX_NOACTIVATE) != 0 && !appWindow) continue;
            string cls = ClassOf(h);
            if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" || cls == "Windows.UI.Core.CoreWindow") continue;
            RECT fr = FrameOf(h);
            if (fr.Right - fr.Left < 2 || fr.Bottom - fr.Top < 2) continue;

            uint pid = PidOf(h);
            ProcInfo proc;
            if (!procs.TryGetValue(pid, out proc)) { proc = InfoOf(pid); procs[pid] = proc; }
            // Apps UWP vivem dentro de um ApplicationFrameWindow do ApplicationFrameHost:
            // o dono de verdade e o processo da CoreWindow filha.
            if (string.Equals(proc.Exe, "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase))
            {
                uint inner = InnerPid(h, pid);
                if (inner == 0) continue;
                if (!procs.TryGetValue(inner, out proc)) { proc = InfoOf(inner); procs[inner] = proc; }
            }
            WinRow row = new WinRow();
            row.Hwnd = h;
            row.Proc = proc;
            row.Title = TextOf(h);
            row.Frame = Frame(fr);
            rows.Add(row);
        }
        return rows;
    }

    static uint InnerPid(IntPtr frameWindow, uint hostPid)
    {
        uint found = 0;
        EnumChildWindows(frameWindow, delegate (IntPtr child, IntPtr l)
        {
            uint p = PidOf(child);
            if (p != 0 && p != hostPid) { found = p; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static object OpApps()
    {
        CheckDesktop();
        List<WinRow> rows = ListWindows();
        IntPtr fg = GetForegroundWindow();
        int activePid = 0;
        foreach (WinRow r in rows) if (r.Hwnd == fg) { activePid = r.Proc.Pid; break; }
        if (activePid == 0 && fg != IntPtr.Zero) activePid = (int)PidOf(fg);

        List<object> apps = new List<object>();
        List<object> windows = new List<object>();
        HashSet<int> seen = new HashSet<int>();
        foreach (WinRow r in rows)
        {
            if (seen.Add(r.Proc.Pid))
            {
                apps.Add(Obj(
                    "pid", r.Proc.Pid,
                    "bundleId", r.Proc.Aumid != null ? r.Proc.Aumid : (r.Proc.Exe.Length > 0 ? r.Proc.Exe : null),
                    "name", r.Proc.Name,
                    "exe", r.Proc.Exe,
                    "active", r.Proc.Pid == activePid,
                    "hidden", false,
                    "elevated", r.Proc.Elevated));
            }
            windows.Add(Obj("id", r.Hwnd.ToInt64(), "pid", r.Proc.Pid, "title", r.Title, "frame", r.Frame));
        }
        return Obj("apps", apps, "windows", windows);
    }

    // --------------------------------------------------------------- tree

    static CacheRequest MakeCache()
    {
        CacheRequest cr = new CacheRequest();
        cr.AutomationElementMode = AutomationElementMode.Full;
        cr.TreeFilter = Automation.ControlViewCondition;
        cr.TreeScope = TreeScope.Element | TreeScope.Children;
        AutomationProperty[] props = new AutomationProperty[] {
            AutomationElement.NameProperty,
            AutomationElement.ControlTypeProperty,
            AutomationElement.BoundingRectangleProperty,
            AutomationElement.IsEnabledProperty,
            AutomationElement.HasKeyboardFocusProperty,
            AutomationElement.IsPasswordProperty,
            AutomationElement.AutomationIdProperty,
            AutomationElement.ClassNameProperty,
            AutomationElement.HelpTextProperty,
            AutomationElement.RuntimeIdProperty,
            AutomationElement.IsInvokePatternAvailableProperty,
            AutomationElement.IsTogglePatternAvailableProperty,
            AutomationElement.IsSelectionItemPatternAvailableProperty,
            AutomationElement.IsExpandCollapsePatternAvailableProperty,
            AutomationElement.IsValuePatternAvailableProperty,
            AutomationElement.IsTextPatternAvailableProperty,
            AutomationElement.IsScrollPatternAvailableProperty,
            ValuePattern.ValueProperty,
            ValuePattern.IsReadOnlyProperty,
            TogglePattern.ToggleStateProperty,
            SelectionItemPattern.IsSelectedProperty,
            ExpandCollapsePattern.ExpandCollapseStateProperty
        };
        foreach (AutomationProperty p in props) cr.Add(p);
        return cr;
    }

    static bool Flag(AutomationElement e, AutomationProperty p)
    {
        try { object v = e.GetCachedPropertyValue(p); return v is bool && (bool)v; }
        catch (Exception) { return false; }
    }

    static string RoleOf(AutomationElement e)
    {
        string n = e.Cached.ControlType.ProgrammaticName;
        int dot = n.LastIndexOf('.');
        return dot >= 0 ? n.Substring(dot + 1) : n;
    }

    class Item
    {
        public AutomationElement El;
        public bool WithKids;
        public int Parent;
        public int Depth;
        public List<int> Path;
    }

    static bool LeafRole(string role)
    {
        return role == "Text" || role == "Image" || role == "Separator" || role == "Thumb";
    }

    static string RefFor(AutomationElement e, int gen, RefMap map)
    {
        string key = null;
        int[] rid = null;
        try { rid = e.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty) as int[]; } catch (Exception) { }
        if (rid != null && rid.Length > 0)
        {
            byte[] bytes = new byte[rid.Length * 4];
            Buffer.BlockCopy(rid, 0, bytes, 0, bytes.Length);
            key = "r:" + gen + ":" + Convert.ToBase64String(bytes);
        }
        else
        {
            key = "k:" + gen + ":" + e.Cached.AutomationId + "|" + RoleOf(e) + "|" + e.Cached.Name;
        }
        // Chaves repetidas (elementos sem RuntimeId e com a mesma identidade) ganham um sufixo.
        string unique = key;
        int n = 1;
        while (map.Elements.ContainsKey(unique)) { n++; unique = key + "#" + n; }
        map.Elements[unique] = e;
        return unique;
    }

    static string Scheme(string raw)
    {
        string v = raw.Trim();
        if (v.Length == 0) return null;
        if (v.IndexOf("://", StringComparison.Ordinal) > 0) return v;
        if (v.StartsWith("about:", StringComparison.OrdinalIgnoreCase) || v.StartsWith("chrome:", StringComparison.OrdinalIgnoreCase)
            || v.StartsWith("edge:", StringComparison.OrdinalIgnoreCase) || v.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return v;
        // O Chromium esconde "https://" na barra de endereco.
        if (v.IndexOf(' ') >= 0) return null;
        return "https://" + v;
    }

    static object OpTree(Dictionary<string, object> a)
    {
        CheckDesktop();
        DateTime started = DateTime.UtcNow;
        int pid = Int(a, "pid", 0);
        int maxNodes = Int(a, "maxNodes", 250);
        int maxDepth = Int(a, "maxDepth", 64);
        int maxChildren = Int(a, "maxChildren", 120);
        int textLimit = Int(a, "textLimit", DefaultTextLimit);
        int deadlineMs = Int(a, "deadlineMs", 6000);
        Dictionary<string, object> win = a.ContainsKey("window") ? a["window"] as Dictionary<string, object> : null;
        if (win == null || !win.ContainsKey("id")) throw new HostError("badRequest", "tree needs window.id (the window handle).");
        IntPtr hwnd = new IntPtr(Convert.ToInt64(win["id"]));
        if (!IsWindow(hwnd)) throw new HostError("windowNotFound", "The window is gone - call cu_apps again.");

        bool enhance = Bool(a, "enhance");
        int wait = Int(a, "enhanceWaitMs", 0);
        // O Chromium/Electron liga a arvore de acessibilidade quando um cliente
        // UIA pergunta, e monta de forma assincrona: na primeira vez o app
        // precisa de um instante.
        if (enhance && wait > 0)
        {
            try { AutomationElement.FromHandle(hwnd); } catch (Exception) { }
            Thread.Sleep(wait);
        }

        AutomationElement root;
        try { root = AutomationElement.FromHandle(hwnd); }
        catch (Exception) { throw new HostError("windowNotFound", "UI Automation could not open that window."); }

        CacheRequest cr = MakeCache();
        int gen = ++generation;
        RefMap map = new RefMap();
        map.Gen = gen;
        map.WindowId = (int)hwnd.ToInt64();
        map.Root = root;
        Maps[pid] = map;

        List<object> nodes = new List<object>();
        List<Dictionary<string, object>> raw = new List<Dictionary<string, object>>();
        Queue<Item> queue = new Queue<Item>();
        AutomationElement rootCached;
        try { rootCached = root.GetUpdatedCache(cr); }
        catch (Exception) { throw new HostError("windowNotFound", "UI Automation could not read that window."); }
        queue.Enqueue(new Item { El = rootCached, WithKids = true, Parent = -1, Depth = 0, Path = new List<int>() });

        string truncated = null;
        int omitted = 0;
        int timeouts = 0;
        int focusedId = -1;
        string addressBar = null;
        int firstDocument = -1;
        DateTime deadline = started.AddMilliseconds(deadlineMs);

        while (queue.Count > 0)
        {
            if (nodes.Count >= maxNodes) { truncated = "maxNodes"; break; }
            if (DateTime.UtcNow > deadline) { truncated = "deadline"; break; }
            Item item = queue.Dequeue();
            AutomationElement e = item.El;
            Dictionary<string, object> node;
            string role;
            try { node = ReadNode(e, textLimit, gen, map, out role); }
            catch (Exception) { timeouts++; continue; }
            int id = nodes.Count;
            node["id"] = id;
            node["parent"] = item.Parent;
            node["depth"] = item.Depth;
            node["path"] = item.Path.ToArray();
            nodes.Add(node);
            raw.Add(node);
            if (focusedId < 0 && e.Cached.HasKeyboardFocus) focusedId = id;
            if (role == "Document" && firstDocument < 0) firstDocument = id;
            if (addressBar == null && role == "Edit" && !e.Cached.HasKeyboardFocus
                && (e.Cached.AutomationId == "addressEditBox" || e.Cached.ClassName == "OmniboxViewViews"))
            {
                object v = node["value"];
                if (v is string) addressBar = Scheme((string)v);
            }

            if (item.Depth >= maxDepth || LeafRole(role)) continue;
            AutomationElementCollection kids = null;
            try
            {
                AutomationElement withKids = item.WithKids ? e : e.GetUpdatedCache(cr);
                kids = withKids.CachedChildren;
            }
            catch (Exception) { timeouts++; }
            if (kids == null) continue;
            int count = kids.Count;
            int take = Math.Min(count, maxChildren);
            node["childCount"] = count;
            for (int i = 0; i < take; i++)
            {
                List<int> path = new List<int>(item.Path);
                path.Add(i);
                queue.Enqueue(new Item { El = kids[i], WithKids = false, Parent = id, Depth = item.Depth + 1, Path = path });
            }
            if (count > take) { node["omittedChildren"] = count - take; omitted += count - take; }
        }
        omitted += queue.Count;

        // A UIA nao tem URL: a da pagina vem da barra de endereco do navegador
        // (so quando ela nao esta com foco - com foco o valor e o que se digita).
        if (addressBar != null && firstDocument >= 0) raw[firstDocument]["url"] = addressBar;
        MarkEditableDocuments(raw, addressBar != null);

        return Obj(
            "nodes", nodes,
            "focusedId", focusedId >= 0 ? (object)focusedId : null,
            "truncated", truncated,
            "omitted", omitted,
            "timeouts", timeouts,
            "enhanced", enhance,
            "ms", (int)(DateTime.UtcNow - started).TotalMilliseconds);
    }

    /// <summary>
    /// "Document" e a pagina no Chromium e tambem a area de texto do Bloco de
    /// Notas: fora de um navegador, um Document com texto vira area de texto
    /// editavel ("editable"), que o format.ts traduz para AXTextArea.
    /// </summary>
    static void MarkEditableDocuments(List<Dictionary<string, object>> nodes, bool inBrowser)
    {
        foreach (Dictionary<string, object> n in nodes)
        {
            if ((string)n["role"] != "Document" || n["url"] != null) continue;
            if (inBrowser) continue;
            if (n.ContainsKey("_writable") && (bool)n["_writable"]) n["subrole"] = "editable";
        }
        foreach (Dictionary<string, object> n in nodes) n.Remove("_writable");
    }

    static Dictionary<string, object> ReadNode(AutomationElement e, int textLimit, int gen, RefMap map, out string role)
    {
        role = RoleOf(e);
        bool secure = e.Cached.IsPassword;
        bool hasValue = Flag(e, AutomationElement.IsValuePatternAvailableProperty);
        bool readOnly = true;
        string value = null;
        if (hasValue && !secure)
        {
            try
            {
                value = Clip(e.GetCachedPropertyValue(ValuePattern.ValueProperty) as string, textLimit);
                object ro = e.GetCachedPropertyValue(ValuePattern.IsReadOnlyProperty);
                readOnly = !(ro is bool) || (bool)ro;
            }
            catch (Exception) { }
        }
        bool writable = hasValue && !readOnly;
        bool selected = false;
        List<object> actions = new List<object>();
        if (Flag(e, AutomationElement.IsInvokePatternAvailableProperty)) AddOnce(actions, "AXPress");
        if (Flag(e, AutomationElement.IsTogglePatternAvailableProperty))
        {
            AddOnce(actions, "AXPress");
            if (value == null)
            {
                try
                {
                    ToggleState st = (ToggleState)e.GetCachedPropertyValue(TogglePattern.ToggleStateProperty);
                    value = st == ToggleState.On ? "1" : "0";
                }
                catch (Exception) { }
            }
        }
        if (Flag(e, AutomationElement.IsSelectionItemPatternAvailableProperty))
        {
            AddOnce(actions, "AXPick");
            selected = Flag(e, SelectionItemPattern.IsSelectedProperty);
        }
        if (Flag(e, AutomationElement.IsExpandCollapsePatternAvailableProperty))
        {
            try
            {
                ExpandCollapseState st = (ExpandCollapseState)e.GetCachedPropertyValue(ExpandCollapsePattern.ExpandCollapseStateProperty);
                if (st == ExpandCollapseState.Collapsed || st == ExpandCollapseState.PartiallyExpanded) AddOnce(actions, "AXExpand");
                else if (st == ExpandCollapseState.Expanded) AddOnce(actions, "AXCollapse");
            }
            catch (Exception) { }
        }
        // Texto sem ValuePattern (Bloco de Notas no Windows 11): o TextPattern devolve o conteudo.
        if (role == "Document" && value == null && !secure && Flag(e, AutomationElement.IsTextPatternAvailableProperty))
        {
            try
            {
                TextPattern tp = (TextPattern)e.GetCurrentPattern(TextPattern.Pattern);
                value = Clip(tp.DocumentRange.GetText(textLimit), textLimit);
                writable = true;
            }
            catch (Exception) { }
        }

        object frame = null;
        System.Windows.Rect r = e.Cached.BoundingRectangle;
        if (!r.IsEmpty && !double.IsInfinity(r.X) && !double.IsInfinity(r.Width))
            frame = new int[] { (int)Math.Round(r.X), (int)Math.Round(r.Y), (int)Math.Round(r.Width), (int)Math.Round(r.Height) };

        Dictionary<string, object> n = new Dictionary<string, object>();
        n["role"] = role;
        n["subrole"] = null;
        n["title"] = Clip(e.Cached.Name, textLimit);
        n["value"] = secure ? null : value;
        n["desc"] = Clip(e.Cached.HelpText, textLimit);
        n["frame"] = frame;
        n["enabled"] = e.Cached.IsEnabled;
        n["focused"] = e.Cached.HasKeyboardFocus;
        n["placeholder"] = null;
        n["help"] = null;
        n["selected"] = selected;
        n["url"] = null;
        n["secure"] = secure;
        n["childCount"] = 0;
        n["actions"] = actions;
        n["ref"] = RefFor(e, gen, map);
        n["_writable"] = writable;
        return n;
    }

    static void AddOnce(List<object> list, string value)
    {
        if (!list.Contains(value)) list.Add(value);
    }

    // ------------------------------------------------------------ capture

    static bool LooksBlack(Bitmap bmp)
    {
        int stepX = Math.Max(1, bmp.Width / 24);
        int stepY = Math.Max(1, bmp.Height / 24);
        for (int y = 0; y < bmp.Height; y += stepY)
            for (int x = 0; x < bmp.Width; x += stepX)
            {
                Color c = bmp.GetPixel(x, y);
                if (c.R != 0 || c.G != 0 || c.B != 0) return false;
            }
        return true;
    }

    /// <summary>Alguma janela de outro app esta por cima de pontos da janela?</summary>
    static bool IsCovered(IntPtr hwnd, RECT fr)
    {
        int w = fr.Right - fr.Left, h = fr.Bottom - fr.Top;
        int[][] points = new int[][] {
            new int[] { w / 2, h / 2 }, new int[] { w / 4, h / 4 }, new int[] { 3 * w / 4, h / 4 },
            new int[] { w / 4, 3 * h / 4 }, new int[] { 3 * w / 4, 3 * h / 4 }
        };
        foreach (int[] p in points)
        {
            POINT pt = new POINT();
            pt.X = fr.Left + p[0];
            pt.Y = fr.Top + p[1];
            IntPtr top = WindowFromPoint(pt);
            if (top == IntPtr.Zero) continue;
            IntPtr root = GetAncestor(top, GA_ROOT);
            if (root != hwnd && PidOf(root) != PidOf(hwnd)) return true;
        }
        return false;
    }

    /// <summary>
    /// PrintWindow(PW_RENDERFULLCONTENT) pede ao proprio app que se desenhe
    /// num bitmap - sai a janela inteira mesmo coberta. Se sair preto (GPU), o
    /// CopyFromScreen so serve com a janela descoberta: copiar a tela com
    /// outra janela por cima mostraria o app errado. Sem nenhum dos dois,
    /// nao ha imagem (e o motivo vai no erro).
    /// </summary>
    static object OpCapture(Dictionary<string, object> a)
    {
        CheckDesktop();
        IntPtr hwnd = new IntPtr(Convert.ToInt64(a["windowId"]));
        string file = Str(a, "file");
        if (string.IsNullOrEmpty(file)) throw new HostError("badRequest", "capture needs a file path.");
        if (!IsWindow(hwnd)) throw new HostError("windowNotFound", "The window is gone - call cu_apps again.");
        if (IsIconic(hwnd)) throw new HostError("windowNotFound", "The window is minimized, so it cannot be captured.");

        RECT outer;
        GetWindowRect(hwnd, out outer);
        RECT fr = FrameOf(hwnd);
        int w = fr.Right - fr.Left, h = fr.Bottom - fr.Top;
        string method = null;
        DateTime t0 = DateTime.UtcNow;

        int ow = outer.Right - outer.Left, oh = outer.Bottom - outer.Top;
        if (ow > 0 && oh > 0)
        {
            using (Bitmap full = new Bitmap(ow, oh, PixelFormat.Format24bppRgb))
            {
                bool ok;
                using (Graphics g = Graphics.FromImage(full))
                {
                    IntPtr hdc = g.GetHdc();
                    try { ok = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT); }
                    finally { g.ReleaseHdc(hdc); }
                }
                if (ok && !LooksBlack(full))
                {
                    int cx = Math.Max(0, fr.Left - outer.Left), cy = Math.Max(0, fr.Top - outer.Top);
                    Rectangle crop = new Rectangle(cx, cy, Math.Min(w, ow - cx), Math.Min(h, oh - cy));
                    using (Bitmap cropped = full.Clone(crop, full.PixelFormat)) cropped.Save(file, ImageFormat.Png);
                    method = "printwindow";
                    w = crop.Width;
                    h = crop.Height;
                }
            }
        }
        if (method == null)
        {
            if (IsCovered(hwnd, fr))
                throw new HostError("unavailable", "The window is covered by another one and the app did not draw itself for the capture (PrintWindow came out black, common with GPU-accelerated apps). The accessibility tree still works.");
            using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(fr.Left, fr.Top, 0, 0, new Size(w, h));
                bmp.Save(file, ImageFormat.Png);
            }
            method = "screen";
        }
        return Obj("file", file, "width", w, "height", h, "method", method, "ms", (int)(DateTime.UtcNow - t0).TotalMilliseconds);
    }
}
