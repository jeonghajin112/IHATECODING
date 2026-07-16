using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace PowerWorkspace;

/// <summary>
/// Runs the real Windows PowerShell 5.1 process through the same node-pty and
/// xterm.js architecture used by modern terminal apps. WebView2 receives only
/// committed IME input, so incomplete Korean composition is never sent to the
/// shell.
/// </summary>
internal sealed class IntegratedPowerShellHost : UserControl, IDisposable
{
    private const int DefaultColumns = 80;
    private const int DefaultRows = 30;
    private const int MaximumOutputBatchCharacters = 512 * 1024;
    private const int MaximumWebStartupAttempts = 3;
    private const int WebStartupAttemptTimeoutMilliseconds = 6000;
    private const int SavedCliInitialDelayMilliseconds = 100;
    private const int CodexStartupSpacingMilliseconds = 250;
    private const int CodexRetryDelayMilliseconds = 1500;
    private const int GrokStartupSpacingMilliseconds = 300;
    private const int GrokImmediateRetryWindowSeconds = 8;
    private const int GrokImmediateRetryDelayMilliseconds = 1800;
    private const uint Th32csSnapProcess = 0x00000002;

    private static readonly SemaphoreSlim StartupGate = new(2, 2);
    private static readonly object CodexStartupScheduleLock = new();
    private static readonly object GrokStartupScheduleLock = new();
    private static readonly Lazy<Task<CoreWebView2Environment>> SharedEnvironment =
        new(CreateSharedEnvironmentAsync);
    private static readonly Lazy<string> TerminalDocumentFolder = new(EnsureTerminalDocument);
    private static long _nextCodexStartupAtMilliseconds;
    private static long _nextGrokStartupAtMilliseconds;

    private readonly WebView2 _webView;
    private readonly ConcurrentQueue<string> _outputQueue = new();
    private readonly StringBuilder _smokeOutput = new();
    private readonly object _smokeOutputLock = new();
    private readonly DispatcherTimer _outputTimer;
    private readonly DispatcherTimer _stateTimer;
    private readonly TaskCompletionSource _webReadySignal =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly string _startDirectory;
    private readonly IntPtr _notificationWindow;

    private PtyBrokerSession? _terminal;
    private TaskCompletionSource? _navigationFailureSignal;
    private long _lastOutputTimestamp = Stopwatch.GetTimestamp();
    private int _outputFlushScheduled;
    private int _columns = DefaultColumns;
    private int _rows = DefaultRows;
    private bool _initializationStarted;
    private bool _sessionStarted;
    private bool _webReady;
    private bool _ready;
    private bool _webHasFocus;
    private bool _exitRaised;
    private bool _stopping;
    private bool _disposed;

    public IntegratedPowerShellHost(
        string startDirectory,
        IntPtr notificationWindow,
        string? codexThreadId = null,
        string? grokSessionId = null)
    {
        ResumeThreadId = Guid.TryParse(codexThreadId, out var parsedThreadId)
            ? parsedThreadId.ToString()
            : null;
        ResumeGrokSessionId = Guid.TryParse(grokSessionId, out var parsedGrokSessionId)
            ? parsedGrokSessionId.ToString()
            : null;

        _startDirectory = startDirectory;
        _notificationWindow = notificationWindow;

        Background = new SolidColorBrush(Color.FromRgb(5, 5, 5));
        Focusable = true;
        _webView = new WebView2
        {
            DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 5, 5, 5),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
            Focusable = true,
        };
        Content = _webView;
        _webView.NavigationCompleted += OnNavigationCompleted;

        _outputTimer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(16),
        };
        _outputTimer.Tick += OnOutputTimerTick;

        _stateTimer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(300),
        };
        _stateTimer.Tick += OnStateTimerTick;

        Loaded += OnHostLoaded;
        Unloaded += OnHostUnloaded;
        GotKeyboardFocus += (_, _) => Activated?.Invoke(this, EventArgs.Empty);
    }

    public event EventHandler? Activated;
    public event EventHandler? Exited;
    public event EventHandler? UserInput;
    public event EventHandler? PointerDown;

    public string NotificationId { get; } = Guid.NewGuid().ToString("N");
    public string? ResumeThreadId { get; }
    public string? ResumeGrokSessionId { get; }
    public string? StartupError { get; private set; }
    public bool IsReady => _ready && _webReady && _terminal is { IsRunning: true };
    public bool HasKeyboardFocus => _webHasFocus || IsKeyboardFocusWithin;
    public TimeSpan OutputQuietDuration =>
        Stopwatch.GetElapsedTime(Interlocked.Read(ref _lastOutputTimestamp));

    internal bool IsConsoleWindowVisible =>
        IsLoaded && IsVisible && _webView.CoreWebView2 is not null &&
        ActualWidth >= 2 && ActualHeight >= 2;

    public bool FocusConsole()
    {
        if (!Dispatcher.CheckAccess()) return Dispatcher.Invoke(FocusConsole);
        if (_disposed || !IsLoaded) return false;

        _ = Focus();
        _ = _webView.Focus();
        PostToWeb(new { type = "focus" });
        return true;
    }

    internal void RefreshWindowBounds()
    {
        if (_disposed) return;
        InvalidateMeasure();
        InvalidateVisual();
        PostToWeb(new { type = "fit" });
    }

    internal void EnsureWindowVisible()
    {
        if (_disposed) return;
        InvalidateMeasure();
        InvalidateVisual();
        PostToWeb(new { type = "fit" });
    }

    public bool TestKeyboardInputForSmoke()
    {
        if (!IsReady) return false;
        lock (_smokeOutputLock) _smokeOutput.Clear();
        try
        {
            _terminal!.Write(
                "Write-Output 'XXCODING_ASCII_OK'; Write-Output '한글 입력 테스트'; exit\r");
        }
        catch
        {
            return false;
        }

        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < TimeSpan.FromSeconds(4))
        {
            if (_terminal?.HasExited == true)
            {
                lock (_smokeOutputLock)
                {
                    var output = _smokeOutput.ToString();
                    return output.Contains("XXCODING_ASCII_OK", StringComparison.Ordinal) &&
                           output.Contains("한글 입력 테스트", StringComparison.Ordinal);
                }
            }
            Thread.Sleep(50);
        }
        return false;
    }

    public bool ContainsScreenPoint(int x, int y)
    {
        if (!IsLoaded || !IsVisible) return false;
        try
        {
            var topLeft = PointToScreen(new Point(0, 0));
            var bottomRight = PointToScreen(new Point(ActualWidth, ActualHeight));
            return x >= topLeft.X && x < bottomRight.X &&
                   y >= topLeft.Y && y < bottomRight.Y;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    public void PrepareForShutdown()
    {
        _stopping = true;
        _stateTimer.Stop();
        _outputTimer.Stop();
        Visibility = Visibility.Collapsed;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _stopping = true;
        _stateTimer.Stop();
        _outputTimer.Stop();
        Visibility = Visibility.Collapsed;

        if (_terminal is not null)
        {
            _terminal.Ready -= OnTerminalReady;
            _terminal.Output -= OnTerminalOutput;
            _terminal.Error -= OnTerminalError;
            _terminal.Exited -= OnTerminalExited;
        }
        if (_webView.CoreWebView2 is not null)
        {
            _webView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
            _webView.CoreWebView2.ProcessFailed -= OnWebProcessFailed;
        }

        try { _terminal?.Dispose(); } catch { }
        _webView.NavigationCompleted -= OnNavigationCompleted;
        try { _webView.Dispose(); } catch { }
    }

    private void OnHostLoaded(object sender, RoutedEventArgs e)
    {
        _stateTimer.Start();
        if (_initializationStarted || _disposed) return;
        _initializationStarted = true;
        _ = InitializeWebTerminalAsync();
    }

    private void OnHostUnloaded(object sender, RoutedEventArgs e)
    {
        if (!_stopping && !_disposed) _webHasFocus = false;
    }

    private async Task InitializeWebTerminalAsync()
    {
        var entered = false;
        try
        {
            await StartupGate.WaitAsync();
            entered = true;
            if (_disposed) return;

            var environment = await SharedEnvironment.Value;
            if (_disposed) return;

            await _webView.EnsureCoreWebView2Async(environment);
            if (_disposed || _webView.CoreWebView2 is null) return;

            var settings = _webView.CoreWebView2.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDevToolsEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.IsBuiltInErrorPageEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;

            _webView.CoreWebView2.IsMuted = true;
            _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            _webView.CoreWebView2.ProcessFailed += OnWebProcessFailed;
            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "terminal.xxcoding.local",
                TerminalDocumentFolder.Value,
                CoreWebView2HostResourceAccessKind.DenyCors);
            for (var attempt = 1; attempt <= MaximumWebStartupAttempts && !_webReady; attempt++)
            {
                var navigationFailure = new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                _navigationFailureSignal = navigationFailure;
                var documentName = attempt == 1 && string.Equals(
                    Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_FAIL_FIRST_WEB_NAVIGATION"),
                    "1",
                    StringComparison.Ordinal)
                    ? "missing-terminal.html"
                    : "terminal.html";
                _webView.CoreWebView2.Navigate(
                    $"https://terminal.xxcoding.local/{documentName}?v=10&attempt={attempt}");

                var completed = await Task.WhenAny(
                    _webReadySignal.Task,
                    navigationFailure.Task,
                    Task.Delay(WebStartupAttemptTimeoutMilliseconds));
                if (completed == _webReadySignal.Task || _disposed || _webReady) break;

                StartupError = attempt < MaximumWebStartupAttempts
                    ? $"터미널 화면 시작 지연, 재시도 중 ({attempt}/{MaximumWebStartupAttempts})"
                    : $"터미널 화면을 {MaximumWebStartupAttempts}회 시도했지만 시작하지 못했습니다.";
            }
            _navigationFailureSignal = null;
        }
        catch (Exception exception)
        {
            if (!_disposed)
                StartupError = $"터미널 화면 시작 실패: {exception.Message}";
        }
        finally
        {
            _navigationFailureSignal = null;
            if (entered) StartupGate.Release();
        }
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_disposed || _stopping) return;

        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeElement)) return;
            var type = typeElement.GetString();
            switch (type)
            {
                case "ready":
                    ReadTerminalSize(root);
                    _webReady = true;
                    StartupError = null;
                    _webReadySignal.TrySetResult();
                    StartPowerShell();
                    break;

                case "resize":
                    ReadTerminalSize(root);
                    try { _terminal?.Resize(_columns, _rows); } catch { }
                    break;

                case "input":
                    if (!_ready || !root.TryGetProperty("data", out var inputElement)) return;
                    var input = inputElement.GetString();
                    if (!string.IsNullOrEmpty(input))
                    {
                        try { _terminal?.Write(input); } catch { }
                    }
                    break;

                case "user-input":
                    UserInput?.Invoke(this, EventArgs.Empty);
                    break;

                case "focus":
                    _webHasFocus = true;
                    Activated?.Invoke(this, EventArgs.Empty);
                    break;

                case "pointer-down":
                    PointerDown?.Invoke(this, EventArgs.Empty);
                    break;

                case "blur":
                    _webHasFocus = false;
                    break;

                case "copy":
                    if (root.TryGetProperty("data", out var copyElement))
                    {
                        var copiedText = copyElement.GetString();
                        if (!string.IsNullOrEmpty(copiedText)) TrySetClipboardText(copiedText);
                    }
                    break;

                case "paste":
                    PasteClipboardContents();
                    break;

                case "web-error":
                    StartupError = root.TryGetProperty("data", out var errorElement)
                        ? $"터미널 화면 오류: {errorElement.GetString()}"
                        : "터미널 화면 오류";
                    break;
            }
        }
        catch
        {
            // A malformed or late web message must never interrupt the shell.
        }
    }

    private void ReadTerminalSize(JsonElement message)
    {
        if (message.TryGetProperty("columns", out var columnsElement) &&
            columnsElement.TryGetInt32(out var columns))
            _columns = Math.Clamp(columns, 2, 1000);
        if (message.TryGetProperty("rows", out var rowsElement) &&
            rowsElement.TryGetInt32(out var rows))
            _rows = Math.Clamp(rows, 1, 1000);
    }

    private static bool TrySetClipboardText(string text)
    {
        for (var attempt = 0; attempt < 4; attempt++)
        {
            try
            {
                Clipboard.SetDataObject(text, copy: true);
                return true;
            }
            catch
            {
                if (attempt == 3) return false;
                Thread.Sleep(12);
            }
        }
        return false;
    }

    private static string? TryGetClipboardText()
    {
        for (var attempt = 0; attempt < 4; attempt++)
        {
            try
            {
                return Clipboard.ContainsText() ? Clipboard.GetText() : null;
            }
            catch
            {
                if (attempt == 3) return null;
                Thread.Sleep(12);
            }
        }
        return null;
    }

    private void PasteClipboardContents()
    {
        if (TryClipboardContainsImage())
        {
            var target = DetectImagePasteTarget();
            try { _terminal?.Write(ImagePasteSequence(target)); } catch { }
            return;
        }

        var clipboardText = TryGetClipboardText();
        if (!string.IsNullOrEmpty(clipboardText))
            PostToWeb(new { type = "paste", data = clipboardText });
    }

    private static bool TryClipboardContainsImage()
    {
        for (var attempt = 0; attempt < 4; attempt++)
        {
            try
            {
                var data = Clipboard.GetDataObject();
                return data is not null && ClipboardDataContainsImage(data);
            }
            catch
            {
                if (attempt == 3) return false;
                Thread.Sleep(12);
            }
        }
        return false;
    }

    private static bool ClipboardDataContainsImage(IDataObject data)
    {
        if (data.GetDataPresent(DataFormats.Bitmap, autoConvert: true) ||
            data.GetDataPresent(DataFormats.Dib, autoConvert: true) ||
            data.GetDataPresent("PNG", autoConvert: false) ||
            data.GetDataPresent("image/png", autoConvert: false) ||
            data.GetDataPresent("image/jpeg", autoConvert: false))
            return true;

        if (!data.GetDataPresent(DataFormats.FileDrop, autoConvert: true) ||
            data.GetData(DataFormats.FileDrop, autoConvert: true) is not string[] files)
            return false;
        return files.Any(IsImageFile);
    }

    private static bool IsImageFile(string path) =>
        Path.GetExtension(path).ToLowerInvariant() is
            ".png" or ".jpg" or ".jpeg" or ".webp" or ".gif" or
            ".bmp" or ".tif" or ".tiff";

    private ImagePasteTarget DetectImagePasteTarget()
    {
        if (_terminal?.ProcessId is { } shellProcessId &&
            TryFindRunningCli(shellProcessId, out var runningTarget))
            return runningTarget;
        return ResumeGrokSessionId is not null
            ? ImagePasteTarget.Grok
            : ImagePasteTarget.Codex;
    }

    private static bool TryFindRunningCli(int rootProcessId, out ImagePasteTarget target)
    {
        target = ImagePasteTarget.Codex;
        var snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
        if (snapshot == new IntPtr(-1)) return false;
        try
        {
            var children = new Dictionary<uint, List<(uint Id, string Name)>>();
            var entry = new ProcessEntry32
            {
                Size = (uint)Marshal.SizeOf<ProcessEntry32>(),
                ExeFile = string.Empty,
            };
            if (Process32FirstW(snapshot, ref entry))
            {
                do
                {
                    if (!children.TryGetValue(entry.ParentProcessId, out var entries))
                    {
                        entries = [];
                        children[entry.ParentProcessId] = entries;
                    }
                    entries.Add((entry.ProcessId, entry.ExeFile ?? string.Empty));
                    entry.Size = (uint)Marshal.SizeOf<ProcessEntry32>();
                }
                while (Process32NextW(snapshot, ref entry));
            }

            var currentLevel = new List<uint> { (uint)rootProcessId };
            var visited = new HashSet<uint>(currentLevel);
            for (var depth = 0; depth < 12 && currentLevel.Count > 0; depth++)
            {
                var nextLevel = new List<uint>();
                ImagePasteTarget? found = null;
                foreach (var parentId in currentLevel)
                {
                    if (!children.TryGetValue(parentId, out var entries)) continue;
                    foreach (var child in entries)
                    {
                        if (IsGrokProcessName(child.Name))
                            found = ImagePasteTarget.Grok;
                        else if (found is null &&
                                 IsCodexProcessName(child.Name))
                            found = ImagePasteTarget.Codex;
                        if (visited.Add(child.Id)) nextLevel.Add(child.Id);
                    }
                }
                if (found is not null)
                {
                    target = found.Value;
                    return true;
                }
                currentLevel = nextLevel;
            }
            return false;
        }
        finally
        {
            _ = CloseHandle(snapshot);
        }
    }

    private static string ImagePasteSequence(ImagePasteTarget target) =>
        target == ImagePasteTarget.Grok
            ? "\u001bv"
            : "\u0016";

    private static bool IsGrokProcessName(string processName) =>
        string.Equals(processName, "grok.exe", StringComparison.OrdinalIgnoreCase) ||
        processName.StartsWith("grok-", StringComparison.OrdinalIgnoreCase) &&
        processName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);

    private static bool IsCodexProcessName(string processName) =>
        string.Equals(processName, "codex.exe", StringComparison.OrdinalIgnoreCase);

    internal static bool TestImagePasteRoutingForSmoke()
    {
        var textData = new DataObject(DataFormats.UnicodeText, "한글 text paste");
        var imageData = new DataObject();
        imageData.SetData("PNG", new byte[] { 0x89, 0x50, 0x4e, 0x47 });
        imageData.SetData(DataFormats.UnicodeText, "image must win over text");
        var imageFileData = new DataObject();
        imageFileData.SetData(DataFormats.FileDrop, new[] { @"C:\smoke\capture.JPG" });

        return string.Equals(ImagePasteSequence(ImagePasteTarget.Codex), "\u0016", StringComparison.Ordinal) &&
               string.Equals(ImagePasteSequence(ImagePasteTarget.Grok), "\u001bv", StringComparison.Ordinal) &&
               !ClipboardDataContainsImage(textData) &&
               ClipboardDataContainsImage(imageData) &&
               ClipboardDataContainsImage(imageFileData) &&
               IsCodexProcessName("CODEX.EXE") &&
               IsGrokProcessName("grok.exe") &&
               IsGrokProcessName("grok-0.2.93.exe") &&
               !IsGrokProcessName("grok.ps1") &&
               IsImageFile("capture.webp") &&
               !IsImageFile("notes.txt");
    }

    private void StartPowerShell()
    {
        if (_sessionStarted || _disposed || !_webReady) return;
        _sessionStarted = true;
        try
        {
            // Reserve Grok's launch slot immediately before the PTY starts so
            // restored agents are spaced from their real process start time.
            var (powerShellPath, powerShellArguments) = BuildStartupCommand(
                _startDirectory,
                _notificationWindow,
                ResumeThreadId,
                ResumeGrokSessionId);
            _terminal = PtyBroker.Instance.CreateSession();
            _terminal.Ready += OnTerminalReady;
            _terminal.Output += OnTerminalOutput;
            _terminal.Error += OnTerminalError;
            _terminal.Exited += OnTerminalExited;
            _terminal.Start(
                powerShellPath,
                powerShellArguments,
                _startDirectory,
                _columns,
                _rows);
        }
        catch (Exception exception)
        {
            StartupError = $"PowerShell 시작 실패: {exception.Message}";
            RaiseExited();
        }
    }

    private void OnTerminalReady(object? sender, EventArgs e)
    {
        Dispatcher.BeginInvoke(() =>
        {
            if (_disposed || _stopping) return;
            _ready = true;
            StartupError = null;
            try { _terminal?.Resize(_columns, _rows); } catch { }
        });
    }

    private void OnTerminalOutput(object? sender, string data)
    {
        if (_disposed || string.IsNullOrEmpty(data)) return;
        Interlocked.Exchange(ref _lastOutputTimestamp, Stopwatch.GetTimestamp());
        lock (_smokeOutputLock)
        {
            if (_smokeOutput.Length < 1024 * 1024) _smokeOutput.Append(data);
        }
        _outputQueue.Enqueue(data);
        ScheduleOutputFlush();
    }

    private void OnTerminalError(object? sender, string message)
    {
        if (_disposed || _stopping) return;
        Dispatcher.BeginInvoke(() => StartupError = $"PowerShell 터미널 오류: {message}");
    }

    private void OnTerminalExited(object? sender, EventArgs e)
    {
        if (_disposed || _stopping) return;
        Dispatcher.BeginInvoke(RaiseExited);
    }

    private void ScheduleOutputFlush()
    {
        if (Interlocked.Exchange(ref _outputFlushScheduled, 1) != 0) return;
        Dispatcher.BeginInvoke(() =>
        {
            if (_disposed)
            {
                Interlocked.Exchange(ref _outputFlushScheduled, 0);
                return;
            }
            _outputTimer.Start();
        });
    }

    private void OnOutputTimerTick(object? sender, EventArgs e)
    {
        _outputTimer.Stop();
        if (_disposed || !_webReady)
        {
            Interlocked.Exchange(ref _outputFlushScheduled, 0);
            return;
        }

        var output = new StringBuilder();
        while (output.Length < MaximumOutputBatchCharacters &&
               _outputQueue.TryDequeue(out var chunk))
            output.Append(chunk);

        if (output.Length > 0)
            PostToWeb(new { type = "output", data = output.ToString() });

        Interlocked.Exchange(ref _outputFlushScheduled, 0);
        if (!_outputQueue.IsEmpty) ScheduleOutputFlush();
    }

    private void PostToWeb(object message)
    {
        if (_disposed || !_webReady || _webView.CoreWebView2 is null) return;
        try
        {
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));
        }
        catch
        {
        }
    }

    private void OnWebProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        if (_disposed || _stopping) return;
        StartupError = $"터미널 화면 프로세스 오류: {e.ProcessFailedKind}";
        if (!_webReady) _navigationFailureSignal?.TrySetResult();
    }

    private async void OnNavigationCompleted(
        object? sender,
        CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_disposed || _stopping || _webReady) return;
        if (!e.IsSuccess)
        {
            StartupError = $"터미널 문서 로드 실패: {e.WebErrorStatus}";
            _navigationFailureSignal?.TrySetResult();
            return;
        }

        try
        {
            var probe = await _webView.ExecuteScriptAsync(
                "JSON.stringify({terminal:typeof Terminal,fit:typeof FitAddon,xterm:!!document.querySelector('.xterm')})");
            if (!_webReady) StartupError ??= $"터미널 초기화 확인: {probe}";
        }
        catch (Exception exception)
        {
            if (!_webReady) StartupError = $"터미널 초기화 확인 실패: {exception.Message}";
        }
    }

    private void OnStateTimerTick(object? sender, EventArgs e)
    {
        if (_disposed || _stopping || _terminal?.HasExited != true) return;
        RaiseExited();
    }

    private void RaiseExited()
    {
        if (_stopping || _disposed || _exitRaised) return;
        _exitRaised = true;
        Exited?.Invoke(this, EventArgs.Empty);
    }

    private (string Executable, string[] Arguments) BuildStartupCommand(
        string startDirectory,
        IntPtr notificationWindow,
        string? codexThreadId,
        string? grokSessionId)
    {
        var autoResumeEnabled = !string.Equals(
            Environment.GetEnvironmentVariable("POWERWORKSPACE_DISABLE_AUTO_RESUME"),
            "1",
            StringComparison.Ordinal);
        var resumeGrok = autoResumeEnabled && grokSessionId is not null;
        var resumeCodex = autoResumeEnabled && !resumeGrok && codexThreadId is not null;

        var script = new StringBuilder();
        script.Append("Set-Location -LiteralPath '")
            .Append(EscapePowerShell(startDirectory))
            .Append("'; ");
        script.Append("$env:POWERWORKSPACE_NOTIFY_HWND='")
            .Append(notificationWindow.ToInt64())
            .Append("'; ");
        script.Append("$env:POWERWORKSPACE_SESSION_ID='")
            .Append(NotificationId)
            .Append("'");
        if (resumeGrok)
        {
            var delayMilliseconds = ReserveGrokStartupDelayMilliseconds();
            var grokCommandPath = ResolveGrokCommandPath();
            script.Append("; Start-Sleep -Milliseconds ")
                .Append(delayMilliseconds)
                .Append("; $xxGrokStarted=[Diagnostics.Stopwatch]::StartNew(); ");
            AppendGrokResumeCommand(script, grokCommandPath, grokSessionId!);
            script.Append("; $xxGrokSucceeded=$?; if (-not $xxGrokSucceeded -and ")
                .Append("$xxGrokStarted.Elapsed.TotalSeconds -lt ")
                .Append(GrokImmediateRetryWindowSeconds)
                .Append(") { Start-Sleep -Milliseconds ")
                .Append(GrokImmediateRetryDelayMilliseconds)
                .Append("; ");
            AppendGrokResumeCommand(script, grokCommandPath, grokSessionId!);
            script.Append(" }");
        }
        else if (resumeCodex)
        {
            var delayMilliseconds = ReserveCodexStartupDelayMilliseconds();
            script.Append("; Start-Sleep -Milliseconds ")
                .Append(delayMilliseconds)
                .Append("; ");
            AppendCodexResumeCommand(script, codexThreadId!);
            script.Append("; $xxCodexExitCode=$LASTEXITCODE; if ($xxCodexExitCode -eq 1) { ")
                .Append("Write-Host '`n[IHATECODING] Codex 연결이 끊겨 한 번 다시 연결합니다. 방금 입력은 다시 보내 주세요.' ")
                .Append("-ForegroundColor DarkYellow; Start-Sleep -Milliseconds ")
                .Append(CodexRetryDelayMilliseconds)
                .Append("; ");
            AppendCodexResumeCommand(script, codexThreadId!);
            script.Append(" }");
        }

        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script.ToString()));
        var systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
        var powerShellPath = Path.Combine(
            systemDirectory,
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe");
        return
        (
            powerShellPath,
            ["-NoLogo", "-NoExit", "-EncodedCommand", encoded]
        );
    }

    private static int ReserveGrokStartupDelayMilliseconds()
    {
        lock (GrokStartupScheduleLock)
        {
            var now = Environment.TickCount64;
            var earliest = now + SavedCliInitialDelayMilliseconds;
            var scheduled = Math.Max(earliest, _nextGrokStartupAtMilliseconds);
            _nextGrokStartupAtMilliseconds = scheduled + GrokStartupSpacingMilliseconds;
            return checked((int)(scheduled - now));
        }
    }

    private static int ReserveCodexStartupDelayMilliseconds()
    {
        lock (CodexStartupScheduleLock)
        {
            var now = Environment.TickCount64;
            var earliest = now + SavedCliInitialDelayMilliseconds;
            var scheduled = Math.Max(earliest, _nextCodexStartupAtMilliseconds);
            _nextCodexStartupAtMilliseconds = scheduled + CodexStartupSpacingMilliseconds;
            return checked((int)(scheduled - now));
        }
    }

    private static string? ResolveGrokCommandPath()
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var nativeCommandPath = Path.Combine(userProfile, ".grok", "bin", "grok.exe");
        if (File.Exists(nativeCommandPath)) return nativeCommandPath;

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var commandPath = Path.Combine(appData, "npm", "grok.cmd");
        return File.Exists(commandPath) ? commandPath : null;
    }

    private static void AppendGrokResumeCommand(
        StringBuilder script,
        string? commandPath,
        string sessionId)
    {
        script.Append("& ");
        if (commandPath is null)
            script.Append("grok");
        else
            script.Append('\'').Append(EscapePowerShell(commandPath)).Append('\'');
        script.Append(" --resume ").Append(sessionId);
    }

    private static void AppendCodexResumeCommand(StringBuilder script, string threadId) =>
        script.Append("codex resume ")
            .Append(threadId)
            .Append(" --dangerously-bypass-approvals-and-sandbox");

    private static string EscapePowerShell(string value) => value.Replace("'", "''");

    private static async Task<CoreWebView2Environment> CreateSharedEnvironmentAsync()
    {
        // Keep the legacy cache root so the renamed app reuses its WebView profile.
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "XXCODING",
            "WebView2");
        Directory.CreateDirectory(userDataFolder);
        var options = new CoreWebView2EnvironmentOptions
        {
            // All terminal documents are trusted local content. Keeping their
            // renderers in a small shared pool avoids one heavy Chromium
            // renderer per PowerShell pane.
            AdditionalBrowserArguments =
                "--process-per-site --renderer-process-limit=1 --disable-site-isolation-trials",
        };
        return await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
    }

    private static string BuildTerminalDocument()
    {
        var assembly = typeof(IntegratedPowerShellHost).Assembly;
        var document = ReadResource(assembly, "PowerWorkspace.WebTerminal.terminal.html");
        return document
            .Replace(
                "/*XXCODING_XTERM_CSS*/",
                ReadResource(assembly, "PowerWorkspace.WebTerminal.xterm.css"),
                StringComparison.Ordinal)
            .Replace(
                "/*XXCODING_XTERM_JS*/",
                ReadResource(assembly, "PowerWorkspace.WebTerminal.xterm.js"),
                StringComparison.Ordinal)
            .Replace(
                "/*XXCODING_FIT_JS*/",
                ReadResource(assembly, "PowerWorkspace.WebTerminal.addon-fit.js"),
                StringComparison.Ordinal);
    }

    private static string EnsureTerminalDocument()
    {
        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "XXCODING",
            "WebTerminal",
            "xterm-6.1.0-beta.290-r10");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "terminal.html");
        File.WriteAllText(path, BuildTerminalDocument(), new UTF8Encoding(false));
        return folder;
    }

    private static string ReadResource(Assembly assembly, string name)
    {
        using var stream = assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"Missing embedded terminal resource: {name}");
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    private enum ImagePasteTarget
    {
        Codex,
        Grok,
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
