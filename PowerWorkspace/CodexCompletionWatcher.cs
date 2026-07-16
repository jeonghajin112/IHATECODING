using System.IO;
using System.Text;

namespace PowerWorkspace;

/// <summary>
/// Lightweight fallback for Codex's legacy notify command. On Windows, a long
/// completed turn can make the JSON command-line argument exceed the process
/// creation limit before IHATECODING is launched. Watching only the already-bound
/// root rollout files keeps completion alerts reliable without polling or
/// reading conversation history.
/// </summary>
internal sealed class CodexCompletionWatcher : IDisposable
{
    private static readonly byte[] TaskCompleteMarker =
        Encoding.ASCII.GetBytes("\"type\":\"task_complete\"");

    private readonly object _gate = new();
    private readonly Dictionary<string, TailState> _states =
        new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _trackedThreadIds =
        new(StringComparer.OrdinalIgnoreCase);
    private readonly Action<string> _completionCallback;
    private readonly string _sessionsRoot;
    private readonly FileSystemWatcher _watcher;
    private bool _disposed;

    public CodexCompletionWatcher(
        IEnumerable<string?> threadIds,
        Action<string> completionCallback)
    {
        _completionCallback = completionCallback;
        foreach (var threadId in threadIds)
        {
            if (Guid.TryParse(threadId, out var parsed))
                _trackedThreadIds.Add(parsed.ToString());
        }

        var codexHome = Environment.GetEnvironmentVariable("CODEX_HOME");
        if (string.IsNullOrWhiteSpace(codexHome))
            codexHome = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".codex");
        _sessionsRoot = Path.Combine(codexHome, "sessions");
        Directory.CreateDirectory(_sessionsRoot);
        SeedExistingFiles();

        _watcher = new FileSystemWatcher(_sessionsRoot, "*.jsonl")
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
            InternalBufferSize = 16 * 1024,
        };
        _watcher.Changed += OnFileChanged;
        _watcher.Created += OnFileChanged;
        _watcher.Renamed += OnFileRenamed;
        _watcher.Error += OnWatcherError;
        _watcher.EnableRaisingEvents = true;
    }

    public void TrackThread(string? threadId)
    {
        if (!Guid.TryParse(threadId, out var parsed)) return;
        var normalized = parsed.ToString();
        lock (_gate)
        {
            if (_disposed || !_trackedThreadIds.Add(normalized)) return;
        }

        try
        {
            foreach (var path in Directory.EnumerateFiles(
                         _sessionsRoot,
                         $"*{normalized}*.jsonl",
                         SearchOption.AllDirectories))
            {
                if (!TryGetThreadId(path, out var pathThreadId) ||
                    !string.Equals(pathThreadId, normalized, StringComparison.OrdinalIgnoreCase)) continue;
                SeedFileAtEnd(path);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private void SeedExistingFiles()
    {
        try
        {
            foreach (var path in Directory.EnumerateFiles(
                         _sessionsRoot,
                         "*.jsonl",
                         SearchOption.AllDirectories))
            {
                if (!TryGetThreadId(path, out var threadId)) continue;
                lock (_gate)
                {
                    if (!_trackedThreadIds.Contains(threadId)) continue;
                }
                SeedFileAtEnd(path);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private void SeedFileAtEnd(string path)
    {
        try
        {
            var length = new FileInfo(path).Length;
            lock (_gate)
            {
                if (_disposed) return;
                _states[path] = new TailState { Offset = length };
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private void OnFileChanged(object sender, FileSystemEventArgs e) => ScheduleRead(e.FullPath);

    private void OnFileRenamed(object sender, RenamedEventArgs e) => ScheduleRead(e.FullPath);

    private void OnWatcherError(object sender, ErrorEventArgs e)
    {
        string[] paths;
        lock (_gate) paths = _states.Keys.ToArray();
        foreach (var path in paths) ScheduleRead(path);
    }

    private void ScheduleRead(string path)
    {
        if (!TryGetThreadId(path, out var threadId)) return;
        TailState state;
        lock (_gate)
        {
            if (_disposed || !_trackedThreadIds.Contains(threadId)) return;
            if (!_states.TryGetValue(path, out state!))
            {
                // A rollout created after the watcher started must be read from
                // byte zero so even a very fast first turn cannot be missed.
                state = new TailState();
                _states[path] = state;
            }
            if (state.Reading)
            {
                state.ReadAgain = true;
                return;
            }
            state.Reading = true;
        }

        _ = Task.Run(async () =>
        {
            await Task.Delay(60).ConfigureAwait(false);
            while (true)
            {
                var readSucceeded = false;
                for (var attempt = 0; attempt < 3 && !readSucceeded; attempt++)
                {
                    readSucceeded = TryReadNewBytes(path, threadId, state);
                    if (!readSucceeded)
                        await Task.Delay(120 * (attempt + 1)).ConfigureAwait(false);
                }

                lock (_gate)
                {
                    if (_disposed)
                    {
                        state.Reading = false;
                        return;
                    }
                    if (state.ReadAgain)
                    {
                        state.ReadAgain = false;
                        continue;
                    }
                    state.Reading = false;
                    return;
                }
            }
        });
    }

    private bool TryReadNewBytes(string path, string threadId, TailState state)
    {
        try
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 64 * 1024,
                FileOptions.SequentialScan);
            if (stream.Length < state.Offset)
            {
                state.Offset = 0;
                state.Carry = [];
            }
            if (stream.Length == state.Offset) return true;

            stream.Position = state.Offset;
            var buffer = new byte[64 * 1024];
            var completionFound = false;
            int count;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                var combined = new byte[state.Carry.Length + count];
                state.Carry.CopyTo(combined, 0);
                Buffer.BlockCopy(buffer, 0, combined, state.Carry.Length, count);
                if (combined.AsSpan().IndexOf(TaskCompleteMarker) >= 0)
                    completionFound = true;

                state.Offset += count;
                var carryLength = Math.Min(TaskCompleteMarker.Length - 1, combined.Length);
                state.Carry = combined[^carryLength..];
            }

            if (completionFound) _completionCallback(threadId);
            return true;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool TryGetThreadId(string path, out string threadId)
    {
        threadId = string.Empty;
        var name = Path.GetFileNameWithoutExtension(path);
        if (name.Length < 36 || !Guid.TryParse(name[^36..], out var parsed)) return false;
        threadId = parsed.ToString();
        return true;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }
        _watcher.EnableRaisingEvents = false;
        _watcher.Changed -= OnFileChanged;
        _watcher.Created -= OnFileChanged;
        _watcher.Renamed -= OnFileRenamed;
        _watcher.Error -= OnWatcherError;
        _watcher.Dispose();
    }

    private sealed class TailState
    {
        public long Offset { get; set; }
        public byte[] Carry { get; set; } = [];
        public bool Reading { get; set; }
        public bool ReadAgain { get; set; }
    }
}
