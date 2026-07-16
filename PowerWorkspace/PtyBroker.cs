using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace PowerWorkspace;

internal sealed class PtyBrokerSession : IDisposable
{
    private readonly PtyBroker _broker;
    private int _started;
    private int _disposed;
    private int _exited;

    internal PtyBrokerSession(PtyBroker broker, string id)
    {
        _broker = broker;
        Id = id;
    }

    internal string Id { get; }
    internal bool IsRunning { get; private set; }
    internal bool HasExited => Volatile.Read(ref _exited) != 0;
    internal int? ProcessId { get; private set; }
    internal int? ExitCode { get; private set; }

    internal event EventHandler? Ready;
    internal event EventHandler<string>? Output;
    internal event EventHandler<string>? Error;
    internal event EventHandler? Exited;

    internal void Start(
        string executable,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        int columns,
        int rows)
    {
        if (Interlocked.Exchange(ref _started, 1) != 0)
            throw new InvalidOperationException("The terminal session was already started.");

        _broker.StartSession(this, executable, arguments, workingDirectory, columns, rows);
    }

    internal void Write(string data)
    {
        if (Volatile.Read(ref _disposed) != 0 || HasExited || string.IsNullOrEmpty(data)) return;
        _broker.Send(new { type = "input", id = Id, data });
    }

    internal void Resize(int columns, int rows)
    {
        if (Volatile.Read(ref _disposed) != 0 || HasExited) return;
        _broker.Send(new
        {
            type = "resize",
            id = Id,
            columns = Math.Clamp(columns, 2, 1000),
            rows = Math.Clamp(rows, 1, 1000),
        });
    }

    internal void DispatchStarted(int? processId)
    {
        if (Volatile.Read(ref _disposed) != 0 || HasExited) return;
        ProcessId = processId;
        IsRunning = true;
        Ready?.Invoke(this, EventArgs.Empty);
    }

    internal void DispatchOutput(string data)
    {
        if (Volatile.Read(ref _disposed) == 0 && !string.IsNullOrEmpty(data))
            Output?.Invoke(this, data);
    }

    internal void DispatchError(string message)
    {
        if (Volatile.Read(ref _disposed) == 0)
            Error?.Invoke(this, message);
    }

    internal void DispatchExited(int? exitCode)
    {
        if (Interlocked.Exchange(ref _exited, 1) != 0) return;
        IsRunning = false;
        ExitCode = exitCode;
        Exited?.Invoke(this, EventArgs.Empty);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        IsRunning = false;
        _broker.RemoveSession(Id, kill: !HasExited);
    }
}

internal sealed class PtyBroker
{
    private const string RuntimeVersion = "node-pty-1.1.0-r2";
    private const string ResourcePrefix = "PowerWorkspace.PtyRuntime.";

    private static readonly Lazy<PtyBroker> Shared = new(() => new PtyBroker());
    private static readonly UTF8Encoding Utf8WithoutBom = new(false);
    private static readonly (string Resource, string RelativePath)[] RuntimeFiles =
    [
        ("pty-broker.js", "pty-broker.js"),
        ("package.json", "node_modules/node-pty/package.json"),
        ("LICENSE", "node_modules/node-pty/LICENSE"),
        ("lib.index.js", "node_modules/node-pty/lib/index.js"),
        ("lib.utils.js", "node_modules/node-pty/lib/utils.js"),
        ("lib.terminal.js", "node_modules/node-pty/lib/terminal.js"),
        ("lib.eventEmitter2.js", "node_modules/node-pty/lib/eventEmitter2.js"),
        ("lib.windowsTerminal.js", "node_modules/node-pty/lib/windowsTerminal.js"),
        ("lib.windowsPtyAgent.js", "node_modules/node-pty/lib/windowsPtyAgent.js"),
        ("lib.windowsConoutConnection.js", "node_modules/node-pty/lib/windowsConoutConnection.js"),
        ("lib.conpty_console_list_agent.js", "node_modules/node-pty/lib/conpty_console_list_agent.js"),
        ("lib.shared.conout.js", "node_modules/node-pty/lib/shared/conout.js"),
        ("lib.worker.conoutSocketWorker.js", "node_modules/node-pty/lib/worker/conoutSocketWorker.js"),
        ("prebuilds.win32-x64.conpty.node", "node_modules/node-pty/prebuilds/win32-x64/conpty.node"),
        ("prebuilds.win32-x64.conpty_console_list.node", "node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node"),
    ];

    private readonly ConcurrentDictionary<string, PtyBrokerSession> _sessions = new();
    private readonly object _processLock = new();
    private readonly object _writeLock = new();
    private Process? _process;
    private StreamWriter? _writer;
    private string? _lastBrokerError;
    private bool _shuttingDown;

    private PtyBroker()
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Shutdown();
    }

    internal static PtyBroker Instance => Shared.Value;

    internal PtyBrokerSession CreateSession()
    {
        var id = Guid.NewGuid().ToString("N");
        var session = new PtyBrokerSession(this, id);
        if (!_sessions.TryAdd(id, session))
            throw new InvalidOperationException("Could not allocate a terminal session.");
        return session;
    }

    internal void StartSession(
        PtyBrokerSession session,
        string executable,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        int columns,
        int rows)
    {
        EnsureStarted();
        Send(new
        {
            type = "start",
            id = session.Id,
            file = executable,
            args = arguments,
            cwd = workingDirectory,
            columns = Math.Clamp(columns, 2, 1000),
            rows = Math.Clamp(rows, 1, 1000),
        });
    }

    internal void Send(object message)
    {
        var payload = JsonSerializer.Serialize(message);
        lock (_writeLock)
        {
            if (_writer is null)
                throw new InvalidOperationException(_lastBrokerError ?? "The terminal backend is not running.");
            _writer.WriteLine(payload);
            _writer.Flush();
        }
    }

    internal void RemoveSession(string id, bool kill)
    {
        if (!_sessions.TryRemove(id, out _)) return;
        if (!kill) return;
        try { Send(new { type = "kill", id }); } catch { }
    }

    private void EnsureStarted()
    {
        lock (_processLock)
        {
            if (_process is { HasExited: false } && _writer is not null) return;
            if (_shuttingDown) throw new InvalidOperationException("The terminal backend is shutting down.");

            var runtimeDirectory = ExtractRuntime();
            var nodePath = FindNodeExecutable()
                ?? throw new FileNotFoundException(
                    "Node.js를 찾지 못했습니다. Codex CLI에서 사용하는 Node.js를 설치한 뒤 다시 실행해 주세요.");
            var brokerPath = Path.Combine(runtimeDirectory, "pty-broker.js");
            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                WorkingDirectory = runtimeDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardInputEncoding = Utf8WithoutBom,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            startInfo.ArgumentList.Add(brokerPath);
            startInfo.Environment["NODE_NO_WARNINGS"] = "1";

            var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            process.Exited += OnBrokerExited;
            if (!process.Start())
                throw new InvalidOperationException("터미널 백엔드를 시작하지 못했습니다.");

            _lastBrokerError = null;
            _process = process;
            _writer = process.StandardInput;
            _writer.AutoFlush = true;
            _ = Task.Run(() => ReadMessagesAsync(process));
            _ = Task.Run(() => ReadErrorsAsync(process));
        }
    }

    private async Task ReadMessagesAsync(Process process)
    {
        try
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                if (line.Length == 0) continue;
                DispatchMessage(line);
            }
        }
        catch (Exception exception)
        {
            _lastBrokerError = exception.Message;
        }
    }

    private async Task ReadErrorsAsync(Process process)
    {
        try
        {
            var error = await process.StandardError.ReadToEndAsync();
            if (!string.IsNullOrWhiteSpace(error)) _lastBrokerError = error.Trim();
        }
        catch
        {
        }
    }

    private void DispatchMessage(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var type = root.TryGetProperty("type", out var typeElement)
                ? typeElement.GetString()
                : null;
            if (type is "broker-ready") return;

            var id = root.TryGetProperty("id", out var idElement)
                ? idElement.GetString()
                : null;
            if (string.IsNullOrEmpty(id) || !_sessions.TryGetValue(id, out var session))
            {
                if (type is "fatal" or "error" && root.TryGetProperty("message", out var globalMessage))
                    _lastBrokerError = globalMessage.GetString();
                return;
            }

            switch (type)
            {
                case "started":
                    session.DispatchStarted(
                        root.TryGetProperty("pid", out var pid) && pid.TryGetInt32(out var processId)
                            ? processId
                            : null);
                    break;
                case "output":
                    if (root.TryGetProperty("data", out var data))
                        session.DispatchOutput(data.GetString() ?? string.Empty);
                    break;
                case "error":
                    var message = root.TryGetProperty("message", out var messageElement)
                        ? messageElement.GetString() ?? "Unknown terminal error."
                        : "Unknown terminal error.";
                    session.DispatchError(message);
                    session.DispatchExited(null);
                    _sessions.TryRemove(id, out _);
                    break;
                case "exit":
                    session.DispatchExited(
                        root.TryGetProperty("exitCode", out var exitCodeElement) &&
                        exitCodeElement.TryGetInt32(out var exitCode)
                            ? exitCode
                            : null);
                    _sessions.TryRemove(id, out _);
                    break;
            }
        }
        catch (Exception exception)
        {
            _lastBrokerError = exception.Message;
        }
    }

    private void OnBrokerExited(object? sender, EventArgs e)
    {
        lock (_processLock)
        {
            if (!ReferenceEquals(_process, sender)) return;
            try
            {
                if (_lastBrokerError is null && _process is not null)
                    _lastBrokerError = $"터미널 백엔드가 종료되었습니다. (코드 {_process.ExitCode})";
            }
            catch
            {
                _lastBrokerError ??= "터미널 백엔드가 종료되었습니다.";
            }
            _writer = null;
            _process = null;
        }

        foreach (var pair in _sessions.ToArray())
        {
            pair.Value.DispatchError(_lastBrokerError ?? "터미널 백엔드가 종료되었습니다.");
            pair.Value.DispatchExited(null);
            _sessions.TryRemove(pair.Key, out _);
        }
    }

    private void Shutdown()
    {
        lock (_processLock)
        {
            if (_shuttingDown) return;
            _shuttingDown = true;
        }

        try { Send(new { type = "shutdown" }); } catch { }
        try
        {
            if (_process is { HasExited: false })
            {
                if (!_process.WaitForExit(800)) _process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
        }
    }

    private static string ExtractRuntime()
    {
        // Keep the legacy cache root so upgrades reuse the existing PTY runtime.
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "XXCODING",
            "PtyRuntime",
            RuntimeVersion);
        Directory.CreateDirectory(root);

        var assembly = typeof(PtyBroker).Assembly;
        foreach (var (resource, relativePath) in RuntimeFiles)
        {
            var outputPath = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
            var directory = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            using var input = assembly.GetManifestResourceStream(ResourcePrefix + resource)
                ?? throw new InvalidOperationException($"Missing embedded PTY resource: {resource}");
            if (File.Exists(outputPath) && new FileInfo(outputPath).Length == input.Length) continue;

            var temporaryPath = $"{outputPath}.{Environment.ProcessId}.tmp";
            using (var output = new FileStream(
                       temporaryPath,
                       FileMode.Create,
                       FileAccess.Write,
                       FileShare.None))
                input.CopyTo(output);
            File.Move(temporaryPath, outputPath, overwrite: true);
        }
        return root;
    }

    private static string? FindNodeExecutable()
    {
        var explicitPath = Environment.GetEnvironmentVariable("IHATECODING_NODE_PATH");
        if (string.IsNullOrWhiteSpace(explicitPath))
            explicitPath = Environment.GetEnvironmentVariable("XXCODING_NODE_PATH");
        if (!string.IsNullOrWhiteSpace(explicitPath) && File.Exists(explicitPath)) return explicitPath;

        foreach (var path in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                     .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(path.Trim('"'), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
            }
        }

        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }
}
