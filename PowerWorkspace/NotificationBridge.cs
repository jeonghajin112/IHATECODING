using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PowerWorkspace;

internal sealed record WorkspaceNotification(string SessionId, string? CodexThreadId);

internal static class NotificationBridge
{
    public const string NotifyArgument = "--codex-notify";
    public const int WmCopyData = 0x004A;

    private const long CopyDataSignature = 0x50574E31;
    private const uint SmtoAbortIfHung = 0x0002;
    private const string WindowHandleVariable = "POWERWORKSPACE_NOTIFY_HWND";
    private const string SessionIdVariable = "POWERWORKSPACE_SESSION_ID";
    private static readonly Regex NotifyLinePattern = new(
        @"(?m)^[ \t]*notify[ \t]*=[^\r\n]*",
        RegexOptions.Compiled);
    private static readonly Regex TomlStringPattern = new(
        "\"(?<double>(?:\\\\.|[^\"\\\\])*)\"|'(?<single>[^']*)'",
        RegexOptions.Compiled);

    public static void EnsureCodexNotifyConfigured()
    {
        try
        {
            var executableDirectory = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
            var preferredExecutable = Path.Combine(executableDirectory, "IHATECODING.exe");
            var executable = File.Exists(preferredExecutable)
                ? preferredExecutable
                : Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(executable)) return;

            var codexHome = Environment.GetEnvironmentVariable("CODEX_HOME");
            if (string.IsNullOrWhiteSpace(codexHome))
                codexHome = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".codex");
            var configPath = Path.Combine(codexHome, "config.toml");
            var config = File.Exists(configPath)
                ? File.ReadAllText(configPath, Encoding.UTF8)
                : string.Empty;
            var existingLine = NotifyLinePattern.Match(config);
            var arguments = existingLine.Success
                ? ParseTomlStrings(existingLine.Value)
                : [];
            var markerIndex = arguments.FindIndex(value =>
                string.Equals(value, NotifyArgument, StringComparison.Ordinal));

            var replacementArguments = new List<string> { executable, NotifyArgument };
            if (markerIndex >= 0)
            {
                var chainIndex = arguments.FindIndex(
                    markerIndex + 1,
                    value => string.Equals(value, "--chain", StringComparison.Ordinal));
                if (chainIndex >= 0) replacementArguments.AddRange(arguments.Skip(chainIndex));
            }
            else if (arguments.Count > 0)
            {
                replacementArguments.Add("--chain");
                replacementArguments.AddRange(arguments);
            }

            var replacement = $"notify = [ {string.Join(", ", replacementArguments.Select(TomlString))} ]";
            string updated;
            if (existingLine.Success)
            {
                if (string.Equals(existingLine.Value, replacement, StringComparison.Ordinal)) return;
                updated = config[..existingLine.Index] + replacement + config[(existingLine.Index + existingLine.Length)..];
            }
            else
            {
                var firstTable = Regex.Match(config, @"(?m)^[ \t]*\[");
                var insertionIndex = firstTable.Success ? firstTable.Index : config.Length;
                var before = config[..insertionIndex];
                var after = config[insertionIndex..];
                if (before.Length > 0 && !before.EndsWith('\n')) before += Environment.NewLine;
                updated = before + replacement + Environment.NewLine + after;
            }

            Directory.CreateDirectory(codexHome);
            File.WriteAllText(configPath, updated, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch
        {
            // Notification setup must never prevent the terminal workspace from starting.
        }
    }

    public static void RunNotifier(string[] args)
    {
        var jsonIndex = FindJsonPayloadIndex(args);
        var json = jsonIndex >= 0 ? args[jsonIndex] : null;
        ForwardToPreviousNotifier(args, jsonIndex, json);

        if (!TryReadAgentTurnComplete(json, out var codexThreadId)) return;
        codexThreadId ??= CodexSessionLocator.FindMostRecentlyUpdated(
            Environment.CurrentDirectory,
            TimeSpan.FromMinutes(2));
        var handleText = Environment.GetEnvironmentVariable(WindowHandleVariable);
        var sessionId = Environment.GetEnvironmentVariable(SessionIdVariable);
        if (!long.TryParse(handleText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var handleValue) ||
            handleValue == 0 || string.IsNullOrWhiteSpace(sessionId)) return;

        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (TrySendToWorkspace(new IntPtr(handleValue), sessionId, codexThreadId)) return;
            if (attempt < 2) Thread.Sleep(150 * (attempt + 1));
        }
    }

    public static bool TrySendToWorkspace(
        IntPtr workspaceWindow,
        string sessionId,
        string? codexThreadId = null)
    {
        if (workspaceWindow == IntPtr.Zero || string.IsNullOrWhiteSpace(sessionId)) return false;

        var payload = JsonSerializer.Serialize(new WorkspaceNotification(sessionId, codexThreadId));
        var textPointer = Marshal.StringToHGlobalUni(payload);
        try
        {
            var data = new CopyDataStruct
            {
                DataIdentifier = new IntPtr(CopyDataSignature),
                ByteCount = checked((payload.Length + 1) * sizeof(char)),
                Data = textPointer,
            };
            return SendMessageTimeoutW(
                workspaceWindow,
                WmCopyData,
                IntPtr.Zero,
                ref data,
                SmtoAbortIfHung,
                2000,
                out _) != IntPtr.Zero;
        }
        finally
        {
            Marshal.FreeHGlobal(textPointer);
        }
    }

    public static bool TryReadNotification(IntPtr messageData, out WorkspaceNotification notification)
    {
        notification = new WorkspaceNotification(string.Empty, null);
        if (messageData == IntPtr.Zero) return false;

        CopyDataStruct data;
        try { data = Marshal.PtrToStructure<CopyDataStruct>(messageData); }
        catch { return false; }

        if (data.DataIdentifier.ToInt64() != CopyDataSignature ||
            data.Data == IntPtr.Zero || data.ByteCount < sizeof(char) || data.ByteCount > 2048)
            return false;

        var payload = (Marshal.PtrToStringUni(data.Data, data.ByteCount / sizeof(char)) ?? string.Empty)
            .TrimEnd('\0');
        try
        {
            var parsed = JsonSerializer.Deserialize<WorkspaceNotification>(payload);
            if (parsed is null || string.IsNullOrWhiteSpace(parsed.SessionId)) return false;
            notification = parsed;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool TryReadAgentTurnComplete(string? json, out string? codexThreadId)
    {
        codexThreadId = null;
        if (string.IsNullOrWhiteSpace(json)) return false;
        try
        {
            using var document = JsonDocument.Parse(json);
            if (!document.RootElement.TryGetProperty("type", out var type) ||
                !string.Equals(type.GetString(), "agent-turn-complete", StringComparison.Ordinal))
                return false;
            codexThreadId = FindThreadId(document.RootElement);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static string? FindThreadId(JsonElement element, int depth = 0)
    {
        if (depth > 3 || element.ValueKind != JsonValueKind.Object) return null;
        foreach (var property in element.EnumerateObject())
        {
            var normalizedName = property.Name.Replace("-", string.Empty).Replace("_", string.Empty);
            if (normalizedName is "threadid" or "sessionid" or "conversationid" &&
                property.Value.ValueKind == JsonValueKind.String &&
                Guid.TryParse(property.Value.GetString(), out var parsedThreadId))
                return parsedThreadId.ToString();
        }
        foreach (var nestedName in new[] { "payload", "data", "context", "thread", "session" })
        {
            if (element.TryGetProperty(nestedName, out var nested) && FindThreadId(nested, depth + 1) is { } found)
                return found;
        }
        return null;
    }

    private static int FindJsonPayloadIndex(string[] args)
    {
        for (var index = args.Length - 1; index >= 0; index--)
        {
            if (args[index].TrimStart().StartsWith('{')) return index;
        }
        return -1;
    }

    private static List<string> ParseTomlStrings(string line)
    {
        var values = new List<string>();
        foreach (Match match in TomlStringPattern.Matches(line))
        {
            if (match.Groups["single"].Success)
            {
                values.Add(match.Groups["single"].Value);
                continue;
            }

            values.Add(match.Groups["double"].Value
                .Replace("\\\"", "\"")
                .Replace("\\\\", "\\"));
        }
        return values;
    }

    private static string TomlString(string value) =>
        $"\"{value.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"";

    private static void ForwardToPreviousNotifier(string[] args, int jsonIndex, string? json)
    {
        var chainIndex = Array.IndexOf(args, "--chain");
        if (chainIndex < 0 || chainIndex + 1 >= args.Length) return;

        var executable = args[chainIndex + 1];
        var finalArgumentIndex = jsonIndex >= 0 ? jsonIndex : args.Length;
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            for (var index = chainIndex + 2; index < finalArgumentIndex; index++)
                startInfo.ArgumentList.Add(args[index]);
            if (json is not null) startInfo.ArgumentList.Add(json);
            _ = Process.Start(startInfo);
        }
        catch
        {
            // A stale optional notifier must not prevent the workspace notification.
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CopyDataStruct
    {
        public IntPtr DataIdentifier;
        public int ByteCount;
        public IntPtr Data;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutW(
        IntPtr window,
        int message,
        IntPtr wParam,
        ref CopyDataStruct lParam,
        uint flags,
        uint timeout,
        out UIntPtr result);
}
