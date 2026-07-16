using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace PowerWorkspace;

internal sealed class NativePowerShellHost : FrameworkElement, IDisposable
{
    private const int GwlStyle = -16;
    private const int GwlExtendedStyle = -20;
    private const int GwlOwner = -8;
    private const int WmClose = 0x0010;
    private const int SwHide = 0;
    private const int SwShowNoActivate = 4;
    private const int SwRestore = 9;
    private const long WsChild = 0x40000000L;
    private const long WsVisible = 0x10000000L;
    private const long WsCaption = 0x00C00000L;
    private const long WsThickFrame = 0x00040000L;
    private const long WsMinimizeBox = 0x00020000L;
    private const long WsMaximizeBox = 0x00010000L;
    private const long WsSystemMenu = 0x00080000L;
    private const long WsPopup = 0x80000000L;
    private const long WsExToolWindow = 0x00000080L;
    private const long WsExAppWindow = 0x00040000L;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpShowWindow = 0x0040;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoSize = 0x0001;
    private const uint EventSystemForeground = 0x0003;
    private const uint EventObjectDestroy = 0x8001;
    private const uint WineventOutOfContext = 0x0000;
    private const uint WineventSkipOwnProcess = 0x0002;
    private const uint GwOwner = 4;
    private const uint Th32csSnapProcess = 0x00000002;
    private const uint KeyeventfKeyUp = 0x0002;
    private const uint KeyeventfUnicode = 0x0004;
    private const uint MouseeventfLeftDown = 0x0002;
    private const uint MouseeventfLeftUp = 0x0004;

    private readonly string _startDirectory;
    private readonly string? _codexThreadId;
    private readonly string? _grokSessionId;
    private readonly string _windowTitle = $"IHATECODING-{Guid.NewGuid():N}";
    private readonly WinEventDelegate _winEventDelegate;
    private Process? _conhostProcess;
    private Process? _powerShellProcess;
    private Window? _ownerWindow;
    private IntPtr _ownerHandle;
    private IntPtr _consoleWindow;
    private IntPtr _foregroundHook;
    private IntPtr _destroyHook;
    private NativeRectangle _lastBounds;
    private bool _ownerEventsAttached;
    private bool _loaded;
    private bool _allowShow;
    private bool _shown;
    private bool _started;
    private bool _focusWhenReady;
    private bool _exitRaised;
    private bool _stopping;
    private bool _disposed;

    public NativePowerShellHost(
        string startDirectory,
        string? codexThreadId = null,
        string? grokSessionId = null)
    {
        _startDirectory = startDirectory;
        _codexThreadId = Guid.TryParse(codexThreadId, out var parsedThreadId)
            ? parsedThreadId.ToString()
            : null;
        _grokSessionId = Guid.TryParse(grokSessionId, out var parsedGrokSessionId)
            ? parsedGrokSessionId.ToString()
            : null;
        _winEventDelegate = OnWinEvent;
        Focusable = false;
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
        LayoutUpdated += OnLayoutUpdated;
        IsVisibleChanged += OnIsVisibleChanged;
    }

    public event EventHandler? Activated;
    public event EventHandler? Exited;

    public string NotificationId { get; } = Guid.NewGuid().ToString("N");
    public string? ResumeThreadId => _codexThreadId;
    public string? ResumeGrokSessionId => _grokSessionId;

    public string? StartupError { get; private set; }
    public bool IsReady =>
        _consoleWindow != IntPtr.Zero &&
        IsWindow(_consoleWindow) &&
        _ownerHandle != IntPtr.Zero &&
        GetWindow(_consoleWindow, GwOwner) == _ownerHandle;

    public bool HasKeyboardFocus =>
        _consoleWindow != IntPtr.Zero && GetForegroundWindow() == _consoleWindow;

    internal bool IsConsoleWindowVisible =>
        _shown &&
        _consoleWindow != IntPtr.Zero &&
        IsWindow(_consoleWindow) &&
        IsWindowVisible(_consoleWindow);

    public bool FocusConsole()
    {
        if (!Dispatcher.CheckAccess()) return Dispatcher.Invoke(FocusConsole);
        if (!IsReady || !_allowShow)
        {
            _focusWhenReady = true;
            return false;
        }

        _focusWhenReady = false;
        UpdateBounds();
        _ = ShowWindow(_consoleWindow, SwRestore);
        _ = SetForegroundWindow(_consoleWindow);
        _ = SetFocus(_consoleWindow);
        return HasKeyboardFocus;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_disposed) return;
        _loaded = true;
        AttachOwnerWindow();
        try
        {
            _allowShow = false;
            EnsurePowerShellStarted();
            ConfigureConsoleWindow();
            InstallForegroundHook();
            Dispatcher.BeginInvoke(
                System.Windows.Threading.DispatcherPriority.ContextIdle,
                ShowAfterInitialLayout);
        }
        catch (Exception exception)
        {
            StartupError = exception.Message;
            TraceHost($"startup-error title={_windowTitle} error={exception.Message}");
        }
    }

    private void OnUnloaded(object sender, RoutedEventArgs e)
    {
        _loaded = false;
        _allowShow = false;
        HideConsole();
    }

    private void ShowAfterInitialLayout()
    {
        if (_disposed || !_loaded) return;
        _allowShow = true;
        UpdateBounds(force: true);
        if (_focusWhenReady) FocusConsole();
    }

    private void AttachOwnerWindow()
    {
        _ownerWindow ??= Window.GetWindow(this);
        if (_ownerWindow is null) return;
        _ownerHandle = new WindowInteropHelper(_ownerWindow).Handle;
        if (_ownerEventsAttached) return;

        _ownerWindow.LocationChanged += OnOwnerLocationChanged;
        _ownerWindow.SizeChanged += OnOwnerSizeChanged;
        _ownerWindow.StateChanged += OnOwnerStateChanged;
        _ownerWindow.Activated += OnOwnerActivated;
        _ownerEventsAttached = true;
    }

    private void DetachOwnerWindow()
    {
        if (!_ownerEventsAttached || _ownerWindow is null) return;
        _ownerWindow.LocationChanged -= OnOwnerLocationChanged;
        _ownerWindow.SizeChanged -= OnOwnerSizeChanged;
        _ownerWindow.StateChanged -= OnOwnerStateChanged;
        _ownerWindow.Activated -= OnOwnerActivated;
        _ownerEventsAttached = false;
    }

    private void EnsurePowerShellStarted()
    {
        if (_consoleWindow != IntPtr.Zero && IsWindow(_consoleWindow)) return;
        if (_started) throw new InvalidOperationException("PowerShell 창이 이미 종료되었습니다.");

        var windowsTerminalPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft",
            "WindowsApps",
            "wt.exe");
        if (!File.Exists(windowsTerminalPath))
        {
            EnsurePowerShellStartedLegacy();
            return;
        }

        _started = true;
        var systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
        var powerShellPath = Path.Combine(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var autoResumeEnabled = !string.Equals(
            Environment.GetEnvironmentVariable("POWERWORKSPACE_DISABLE_AUTO_RESUME"),
            "1",
            StringComparison.Ordinal);
        var resumeGrok = autoResumeEnabled && _grokSessionId is not null;
        var resumeCodex = autoResumeEnabled && !resumeGrok && _codexThreadId is not null;
        var startupCommand = $"[Console]::Title='{_windowTitle}'";
        if (resumeGrok)
            startupCommand += $"; Start-Sleep -Milliseconds 1200; grok --resume {_grokSessionId}";
        else if (resumeCodex)
            startupCommand +=
                $"; Start-Sleep -Milliseconds 1200; " +
                $"codex resume {_codexThreadId} --dangerously-bypass-approvals-and-sandbox";

        var startInfo = new ProcessStartInfo
        {
            FileName = windowsTerminalPath,
            WorkingDirectory = _startDirectory,
            UseShellExecute = false,
            CreateNoWindow = false,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        startInfo.ArgumentList.Add("--window");
        startInfo.ArgumentList.Add(_windowTitle);
        startInfo.ArgumentList.Add("--focus");
        startInfo.ArgumentList.Add("--pos");
        startInfo.ArgumentList.Add("-32000,-32000");
        startInfo.ArgumentList.Add("--size");
        startInfo.ArgumentList.Add("20,5");
        startInfo.ArgumentList.Add("new-tab");
        startInfo.ArgumentList.Add("--title");
        startInfo.ArgumentList.Add(_windowTitle);
        startInfo.ArgumentList.Add("--suppressApplicationTitle");
        startInfo.ArgumentList.Add("--startingDirectory");
        startInfo.ArgumentList.Add(_startDirectory);
        startInfo.ArgumentList.Add(powerShellPath);
        startInfo.ArgumentList.Add("-NoLogo");
        startInfo.ArgumentList.Add("-NoExit");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add(startupCommand);
        startInfo.Environment["POWERWORKSPACE_NOTIFY_HWND"] =
            _ownerHandle.ToInt64().ToString(CultureInfo.InvariantCulture);
        startInfo.Environment["POWERWORKSPACE_SESSION_ID"] = NotificationId;

        _conhostProcess = Process.Start(startInfo) ??
            throw new InvalidOperationException("Windows Terminal을 시작하지 못했습니다.");
        TraceHost($"windows-terminal-start title={_windowTitle} launcher={_conhostProcess.Id}");

        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < TimeSpan.FromSeconds(10))
        {
            _consoleWindow = FindWindowW("CASCADIA_HOSTING_WINDOW_CLASS", _windowTitle);
            if (_consoleWindow != IntPtr.Zero) break;
            Thread.Sleep(50);
        }
        if (_consoleWindow == IntPtr.Zero)
            throw new InvalidOperationException("Windows Terminal PowerShell 창을 찾지 못했습니다.");

        TraceHost($"windows-terminal-ready title={_windowTitle} hwnd=0x{_consoleWindow.ToInt64():X}");
    }

    private void EnsurePowerShellStartedLegacy()
    {
        if (_consoleWindow != IntPtr.Zero && IsWindow(_consoleWindow)) return;
        if (_started) throw new InvalidOperationException("기본 PowerShell 창이 이미 종료되었습니다.");
        _started = true;

        var systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
        var autoResumeEnabled = !string.Equals(
            Environment.GetEnvironmentVariable("POWERWORKSPACE_DISABLE_AUTO_RESUME"),
            "1",
            StringComparison.Ordinal);
        var resumeGrok = autoResumeEnabled && _grokSessionId is not null;
        var resumeCodex = autoResumeEnabled && !resumeGrok && _codexThreadId is not null;
        var startupCommand = $"[Console]::Title='{_windowTitle}'";
        startupCommand +=
            "; $global:IHATECODING_CODEX=(Get-Command codex.ps1 -ErrorAction SilentlyContinue).Source" +
            "; if ($global:IHATECODING_CODEX) { " +
            "function global:codex { " +
            "& $global:IHATECODING_CODEX --no-alt-screen -c 'tui.animations=false' @args " +
            "} }";
        if (resumeGrok)
            startupCommand +=
                $"; Start-Sleep -Milliseconds 1200; " +
                $"grok --resume {_grokSessionId}";
        else if (resumeCodex)
            startupCommand +=
                $"; Start-Sleep -Milliseconds 1200; " +
                $"codex resume {_codexThreadId} --dangerously-bypass-approvals-and-sandbox";
        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(systemDirectory, "conhost.exe"),
            Arguments =
                $"\"{Path.Combine(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")}\" " +
                $"-NoLogo -NoExit -Command \"{startupCommand}\"",
            WorkingDirectory = _startDirectory,
            UseShellExecute = false,
            CreateNoWindow = false,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        startInfo.Environment["POWERWORKSPACE_NOTIFY_HWND"] =
            _ownerHandle.ToInt64().ToString(CultureInfo.InvariantCulture);
        startInfo.Environment["POWERWORKSPACE_SESSION_ID"] = NotificationId;

        _conhostProcess = Process.Start(startInfo) ??
            throw new InvalidOperationException("기본 PowerShell을 시작하지 못했습니다.");
        TraceHost($"conhost-start title={_windowTitle} pid={_conhostProcess.Id}");
        _conhostProcess.EnableRaisingEvents = true;
        _conhostProcess.Exited += OnConhostExited;

        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < TimeSpan.FromSeconds(5))
        {
            _consoleWindow = FindWindowW("ConsoleWindowClass", _windowTitle);
            if (_consoleWindow != IntPtr.Zero) break;
            if (_conhostProcess.HasExited) break;
            Thread.Sleep(50);
        }
        if (_consoleWindow == IntPtr.Zero)
            throw new InvalidOperationException("기본 PowerShell 창을 찾지 못했습니다.");

        var childDeadline = DateTime.UtcNow.AddSeconds(2);
        while (_powerShellProcess is null && DateTime.UtcNow < childDeadline)
        {
            _powerShellProcess = FindChildProcess(_conhostProcess.Id, "powershell.exe");
            if (_powerShellProcess is null) Thread.Sleep(50);
        }
        TraceHost(
            $"console-ready title={_windowTitle} hwnd=0x{_consoleWindow.ToInt64():X} " +
            $"powershell={_powerShellProcess?.Id.ToString() ?? "not-found"}");
    }

    private static Process? FindChildProcess(int parentProcessId, string executableName)
    {
        var snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
        if (snapshot == new IntPtr(-1)) return null;
        try
        {
            var entry = new ProcessEntry32
            {
                Size = (uint)Marshal.SizeOf<ProcessEntry32>(),
            };
            if (!Process32FirstW(snapshot, ref entry)) return null;
            do
            {
                if (entry.ParentProcessId != (uint)parentProcessId ||
                    !string.Equals(entry.ExeFile, executableName, StringComparison.OrdinalIgnoreCase)) continue;
                try { return Process.GetProcessById((int)entry.ProcessId); } catch { return null; }
            }
            while (Process32NextW(snapshot, ref entry));
            return null;
        }
        finally
        {
            _ = CloseHandle(snapshot);
        }
    }

    private void ConfigureConsoleWindow()
    {
        if (_ownerHandle == IntPtr.Zero || _consoleWindow == IntPtr.Zero) return;
        _ = ShowWindow(_consoleWindow, SwHide);

        var style = GetWindowLongPtrW(_consoleWindow, GwlStyle).ToInt64();
        style &= ~(WsChild | WsVisible | WsCaption | WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSystemMenu);
        style |= WsPopup;
        _ = SetWindowLongPtrW(_consoleWindow, GwlStyle, new IntPtr(style));

        var extendedStyle = GetWindowLongPtrW(_consoleWindow, GwlExtendedStyle).ToInt64();
        extendedStyle &= ~WsExAppWindow;
        extendedStyle |= WsExToolWindow;
        _ = SetWindowLongPtrW(_consoleWindow, GwlExtendedStyle, new IntPtr(extendedStyle));
        _ = SetWindowLongPtrW(_consoleWindow, GwlOwner, _ownerHandle);
    }

    private void OnLayoutUpdated(object? sender, EventArgs e) => UpdateBounds();

    internal void RefreshWindowBounds() => UpdateBounds();

    internal void EnsureWindowVisible()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(EnsureWindowVisible);
            return;
        }
        if (_disposed || !_loaded || !IsVisible || !IsReady) return;
        _allowShow = true;
        UpdateBounds(force: !IsConsoleWindowVisible);
    }

    private void OnIsVisibleChanged(object sender, DependencyPropertyChangedEventArgs e) => UpdateBounds();
    private void OnOwnerLocationChanged(object? sender, EventArgs e) => UpdateBounds();
    private void OnOwnerSizeChanged(object sender, SizeChangedEventArgs e) => UpdateBounds();
    private void OnOwnerStateChanged(object? sender, EventArgs e) => UpdateBounds();
    private void OnOwnerActivated(object? sender, EventArgs e) => UpdateBounds();

    private void UpdateBounds(bool force = false)
    {
        if (_disposed || _consoleWindow == IntPtr.Zero || !IsWindow(_consoleWindow)) return;
        if (!_loaded || !_allowShow || !IsVisible || _ownerWindow?.WindowState == WindowState.Minimized ||
            ActualWidth < 2 || ActualHeight < 2)
        {
            HideConsole();
            return;
        }

        Point topLeft;
        Point bottomRight;
        try
        {
            topLeft = PointToScreen(new Point(0, 0));
            bottomRight = PointToScreen(new Point(ActualWidth, ActualHeight));
        }
        catch (InvalidOperationException)
        {
            return;
        }

        var bounds = new NativeRectangle
        {
            Left = (int)Math.Round(topLeft.X),
            Top = (int)Math.Round(topLeft.Y),
            Right = (int)Math.Round(bottomRight.X),
            Bottom = (int)Math.Round(bottomRight.Y),
        };
        var boundsChanged = !bounds.Equals(_lastBounds);
        var wasVisible = _shown && IsWindowVisible(_consoleWindow);
        if (!force && wasVisible && !boundsChanged) return;
        _lastBounds = bounds;

        _ = SetWindowPos(
            _consoleWindow,
            IntPtr.Zero,
            bounds.Left,
            bounds.Top,
            Math.Max(1, bounds.Right - bounds.Left),
            Math.Max(1, bounds.Bottom - bounds.Top),
            SwpNoActivate | SwpShowWindow);
        if (!wasVisible) _ = ShowWindow(_consoleWindow, SwShowNoActivate);
        _shown = true;
    }

    private void HideConsole()
    {
        if (_consoleWindow != IntPtr.Zero && IsWindow(_consoleWindow)) _ = ShowWindow(_consoleWindow, SwHide);
        _shown = false;
    }

    private void InstallForegroundHook()
    {
        if (_foregroundHook == IntPtr.Zero)
            _foregroundHook = SetWinEventHook(
                EventSystemForeground,
                EventSystemForeground,
                IntPtr.Zero,
                _winEventDelegate,
                0,
                0,
                WineventOutOfContext | WineventSkipOwnProcess);
        if (_destroyHook == IntPtr.Zero)
            _destroyHook = SetWinEventHook(
                EventObjectDestroy,
                EventObjectDestroy,
                IntPtr.Zero,
                _winEventDelegate,
                0,
                0,
                WineventOutOfContext | WineventSkipOwnProcess);
    }

    private void OnWinEvent(
        IntPtr hook,
        uint eventType,
        IntPtr hwnd,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime)
    {
        if (_disposed || hwnd != _consoleWindow) return;
        if (eventType == EventObjectDestroy)
        {
            Dispatcher.BeginInvoke(RaiseExited);
            return;
        }
        if (eventType == EventSystemForeground)
            Dispatcher.BeginInvoke(() => Activated?.Invoke(this, EventArgs.Empty));
    }

    private void OnConhostExited(object? sender, EventArgs e)
    {
        if (_stopping || _disposed) return;
        var exitCode = "unknown";
        try { exitCode = _conhostProcess?.ExitCode.ToString() ?? "null"; } catch { }
        TraceHost($"conhost-exited title={_windowTitle} exit={exitCode}");
        Dispatcher.BeginInvoke(RaiseExited);
    }

    private void RaiseExited()
    {
        if (_stopping || _disposed || _exitRaised) return;
        _exitRaised = true;
        Exited?.Invoke(this, EventArgs.Empty);
    }

    public bool TestKeyboardInputForSmoke()
    {
        if (!IsReady) return false;
        UpdateBounds(force: true);
        _ = SetWindowPos(_consoleWindow, new IntPtr(-1), 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpShowWindow);
        _ = SetForegroundWindow(_consoleWindow);
        _ = SetFocus(_consoleWindow);
        Thread.Sleep(100);

        if (GetWindowRect(_consoleWindow, out var windowBounds) && GetCursorPos(out var originalCursor))
        {
            _ = SetCursorPos(
                windowBounds.Left + Math.Max(8, (windowBounds.Right - windowBounds.Left) / 2),
                windowBounds.Top + Math.Max(8, (windowBounds.Bottom - windowBounds.Top) / 2));
            var clicks = new[] { MouseInput(MouseeventfLeftDown), MouseInput(MouseeventfLeftUp) };
            _ = SendInput((uint)clicks.Length, clicks, Marshal.SizeOf<NativeInput>());
            Thread.Sleep(100);
            _ = SetCursorPos(originalCursor.X, originalCursor.Y);
        }

        var inputs = new List<NativeInput>(10);
        foreach (var character in "exit")
        {
            inputs.Add(UnicodeInput(character, 0));
            inputs.Add(UnicodeInput(character, KeyeventfKeyUp));
        }
        inputs.Add(KeyboardInput(0x0D, 0));
        inputs.Add(KeyboardInput(0x0D, KeyeventfKeyUp));
        var sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<NativeInput>());
        _ = SetWindowPos(_consoleWindow, new IntPtr(-2), 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);
        if (sent != inputs.Count) return false;

        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < TimeSpan.FromSeconds(2))
        {
            if (_powerShellProcess?.HasExited == true || !IsWindow(_consoleWindow)) return true;
            Thread.Sleep(50);
        }
        return false;
    }

    public bool ContainsScreenPoint(int x, int y) =>
        _consoleWindow != IntPtr.Zero &&
        IsWindow(_consoleWindow) &&
        GetWindowRect(_consoleWindow, out var bounds) &&
        x >= bounds.Left && x < bounds.Right && y >= bounds.Top && y < bounds.Bottom;

    public void PrepareForShutdown()
    {
        if (_disposed) return;
        _stopping = true;
        _allowShow = false;
        HideConsole();
    }

    public void Dispose()
    {
        if (_disposed) return;
        TraceHost($"dispose title={_windowTitle}");
        _disposed = true;
        _stopping = true;
        Loaded -= OnLoaded;
        Unloaded -= OnUnloaded;
        LayoutUpdated -= OnLayoutUpdated;
        IsVisibleChanged -= OnIsVisibleChanged;
        DetachOwnerWindow();
        if (_foregroundHook != IntPtr.Zero)
        {
            _ = UnhookWinEvent(_foregroundHook);
            _foregroundHook = IntPtr.Zero;
        }
        if (_destroyHook != IntPtr.Zero)
        {
            _ = UnhookWinEvent(_destroyHook);
            _destroyHook = IntPtr.Zero;
        }
        StopPowerShell();
    }

    private static void TraceHost(string message)
    {
        var path = Environment.GetEnvironmentVariable("POWERWORKSPACE_ADD_TRACE_PATH");
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            File.AppendAllText(
                path,
                $"{DateTime.Now:HH:mm:ss.fff} host {message}{Environment.NewLine}");
        }
        catch
        {
        }
    }

    private void StopPowerShell()
    {
        if (_consoleWindow != IntPtr.Zero && IsWindow(_consoleWindow))
            _ = PostMessageW(_consoleWindow, WmClose, IntPtr.Zero, IntPtr.Zero);
        StopProcess(_powerShellProcess);
        StopProcess(_conhostProcess);
        _powerShellProcess = null;
        _conhostProcess = null;
        _consoleWindow = IntPtr.Zero;
    }

    private static void StopProcess(Process? process)
    {
        if (process is null) return;
        try
        {
            if (!process.HasExited && !process.WaitForExit(200)) process.Kill(entireProcessTree: true);
        }
        catch
        {
            try { if (!process.HasExited) process.Kill(); } catch { }
        }
        finally
        {
            process.Dispose();
        }
    }

    private static NativeInput KeyboardInput(ushort virtualKey, uint flags) => new()
    {
        Type = 1,
        Data = new InputUnion { Keyboard = new KeyboardInputData { VirtualKey = virtualKey, Flags = flags } },
    };

    private static NativeInput UnicodeInput(char character, uint flags) => new()
    {
        Type = 1,
        Data = new InputUnion
        {
            Keyboard = new KeyboardInputData
            {
                ScanCode = character,
                Flags = KeyeventfUnicode | flags,
            },
        },
    };

    private static NativeInput MouseInput(uint flags) => new()
    {
        Type = 0,
        Data = new InputUnion { Mouse = new MouseInputData { Flags = flags } },
    };

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRectangle
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeInput
    {
        public uint Type;
        public InputUnion Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public KeyboardInputData Keyboard;
        [FieldOffset(0)] public MouseInputData Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInputData
    {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInputData
    {
        public int X;
        public int Y;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    private delegate void WinEventDelegate(
        IntPtr hook,
        uint eventType,
        IntPtr hwnd,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowW(string className, string windowName);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtrW(IntPtr window, int index, IntPtr value);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(
        IntPtr window,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr window, out NativeRectangle rectangle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out NativePoint point);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr eventHookModule,
        WinEventDelegate callback,
        uint processId,
        uint threadId,
        uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWinEvent(IntPtr eventHook);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, NativeInput[] inputs, int inputSize);
}
