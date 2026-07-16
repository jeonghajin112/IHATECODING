using System.IO;
using System.Text;
using System.Text.Json;

namespace PowerWorkspace;

internal sealed record CodexSessionInfo(
    string ThreadId,
    string WorkingDirectory,
    DateTimeOffset StartedAt,
    DateTime UpdatedAtUtc);

internal sealed record CodexSessionMetadata(
    string ThreadId,
    string WorkingDirectory,
    DateTimeOffset StartedAt,
    DateTime UpdatedAtUtc,
    bool IsUserCliSession,
    bool IsSubagent,
    string? ParentThreadId);

internal static class CodexSessionLocator
{
    private static readonly TimeSpan DuplicateReplacementWindow = TimeSpan.FromSeconds(30);

    public static bool RepairSubagentTerminalAssociations(IEnumerable<WorkspaceProject> projects)
    {
        var projectList = projects.ToList();
        var sessions = ReadSessions();
        var reservedUserThreadIds = projectList
            .SelectMany(project => project.Terminals)
            .Select(terminal => terminal.CodexThreadId)
            .Where(threadId =>
                Guid.TryParse(threadId, out var parsed) &&
                TryResolveUserThreadId(parsed.ToString(), out var userThreadId) &&
                string.Equals(parsed.ToString(), userThreadId, StringComparison.OrdinalIgnoreCase))
            .Select(threadId => Guid.Parse(threadId!).ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var changed = false;
        foreach (var project in projectList)
        {
            var affected = project.Terminals
                .Select(terminal =>
                {
                    var normalized = Guid.TryParse(terminal.CodexThreadId, out var parsed)
                        ? parsed.ToString()
                        : null;
                    var userThreadId = normalized is not null &&
                                       TryResolveUserThreadId(normalized, out var resolved) &&
                                       !string.Equals(normalized, resolved, StringComparison.OrdinalIgnoreCase)
                        ? resolved
                        : null;
                    DateTimeOffset? childStartedAt = normalized is not null &&
                                                     TryReadSessionMetadata(normalized, out var childMetadata) &&
                                                     childMetadata.IsSubagent
                        ? childMetadata.StartedAt
                        : null;
                    return (
                        Terminal: terminal,
                        ThreadId: normalized,
                        UserThreadId: userThreadId,
                        ChildStartedAt: childStartedAt);
                })
                .Where(item => item.UserThreadId is not null)
                .ToList();
            if (affected.Count == 0) continue;

            // If a child notification replaced the only reference to its parent,
            // restore that parent directly. Prefer the MAIN pane when several
            // saved child threads share the same root.
            var affectedFamilies = affected
                .GroupBy(item => item.UserThreadId!, StringComparer.OrdinalIgnoreCase)
                .Select(family => (UserThreadId: family.Key, Items: family.ToList()))
                .ToList();
            foreach (var family in affectedFamilies)
            {
                if (reservedUserThreadIds.Contains(family.UserThreadId)) continue;
                var replacement = family.Items
                    .OrderByDescending(item => string.Equals(
                        item.Terminal.Name,
                        "MAIN",
                        StringComparison.OrdinalIgnoreCase))
                    .ThenBy(item => item.Terminal.CreatedAtUtc ?? DateTimeOffset.MaxValue)
                    .First();
                replacement.Terminal.CodexThreadId = family.UserThreadId;
                reservedUserThreadIds.Add(family.UserThreadId);
                affected.Remove(replacement);
                changed = true;
            }

            // Legacy backfill used to treat subagent rollouts as standalone CLI
            // conversations. Re-run the same chronological assignment using only
            // real user CLI sessions for the remaining panes.
            var latestChildStart = affected
                .Where(item => item.ChildStartedAt.HasValue)
                .Select(item => item.ChildStartedAt!.Value)
                .DefaultIfEmpty(DateTimeOffset.MaxValue)
                .Max();
            var candidates = sessions
                .Where(session =>
                    SamePath(session.WorkingDirectory, project.FolderPath) &&
                    session.StartedAt <= latestChildStart &&
                    !reservedUserThreadIds.Contains(session.ThreadId))
                .OrderByDescending(session => session.UpdatedAtUtc)
                .Take(affected.Count)
                .OrderBy(session => session.StartedAt)
                .ToList();
            for (var index = 0; index < Math.Min(affected.Count, candidates.Count); index++)
            {
                affected[index].Terminal.CodexThreadId = candidates[index].ThreadId;
                reservedUserThreadIds.Add(candidates[index].ThreadId);
                changed = true;
            }
            for (var index = candidates.Count; index < affected.Count; index++)
            {
                affected[index].Terminal.CodexThreadId = null;
                changed = true;
            }
        }
        return changed;
    }

    public static bool TryResolveUserThreadId(string? threadId, out string userThreadId)
    {
        userThreadId = string.Empty;
        if (!Guid.TryParse(threadId, out var parsedThreadId)) return false;

        var currentThreadId = parsedThreadId.ToString();
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var depth = 0; depth < 16 && visited.Add(currentThreadId); depth++)
        {
            if (!TryReadSessionMetadata(currentThreadId, out var metadata)) return false;
            if (metadata.IsUserCliSession)
            {
                userThreadId = metadata.ThreadId;
                return true;
            }
            if (!metadata.IsSubagent || metadata.ParentThreadId is null) return false;
            currentThreadId = metadata.ParentThreadId;
        }
        return false;
    }

    public static bool IsDescendantOf(string? candidateThreadId, string? ancestorThreadId)
    {
        if (!Guid.TryParse(candidateThreadId, out var parsedCandidate) ||
            !Guid.TryParse(ancestorThreadId, out var parsedAncestor)) return false;
        var candidate = parsedCandidate.ToString();
        var ancestor = parsedAncestor.ToString();
        if (string.Equals(candidate, ancestor, StringComparison.OrdinalIgnoreCase)) return false;

        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var depth = 0; depth < 16 && visited.Add(candidate); depth++)
        {
            if (!TryReadSessionMetadata(candidate, out var metadata) ||
                metadata.ParentThreadId is null) return false;
            if (string.Equals(metadata.ParentThreadId, ancestor, StringComparison.OrdinalIgnoreCase)) return true;
            candidate = metadata.ParentThreadId;
        }
        return false;
    }

    public static bool RepairDuplicateTerminalAssociations(IEnumerable<WorkspaceProject> projects)
    {
        var projectList = projects.ToList();
        var associations = projectList
            .SelectMany(project => project.Terminals.Select(terminal => (Project: project, Terminal: terminal)))
            .Where(item => Guid.TryParse(item.Terminal.CodexThreadId, out _))
            .Select(item =>
            {
                _ = Guid.TryParse(item.Terminal.CodexThreadId, out var parsed);
                return (item.Project, item.Terminal, ThreadId: parsed.ToString());
            })
            .ToList();
        if (!associations
                .GroupBy(item => item.ThreadId, StringComparer.OrdinalIgnoreCase)
                .Any(group => group.Count() > 1)) return false;

        var sessions = ReadSessions();
        var sessionsById = sessions
            .GroupBy(session => session.ThreadId, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                group => group.Key,
                group => group.OrderByDescending(session => session.UpdatedAtUtc).First(),
                StringComparer.OrdinalIgnoreCase);
        var reservedThreadIds = associations
            .Select(item => item.ThreadId)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var seenThreadIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var changed = false;

        foreach (var association in associations)
        {
            if (seenThreadIds.Add(association.ThreadId)) continue;

            sessionsById.TryGetValue(association.ThreadId, out var duplicatedSession);
            var workingDirectory = string.IsNullOrWhiteSpace(association.Terminal.StartDirectory)
                ? association.Project.FolderPath
                : association.Terminal.StartDirectory;
            var replacement = duplicatedSession is null
                ? null
                : sessions
                    .Where(candidate =>
                        !reservedThreadIds.Contains(candidate.ThreadId) &&
                        SamePath(candidate.WorkingDirectory, workingDirectory) &&
                        candidate.StartedAt >= duplicatedSession.StartedAt &&
                        candidate.StartedAt - duplicatedSession.StartedAt <= DuplicateReplacementWindow)
                    .OrderByDescending(candidate => candidate.UpdatedAtUtc)
                    .ThenBy(candidate => candidate.StartedAt)
                    .FirstOrDefault();

            association.Terminal.CodexThreadId = replacement?.ThreadId;
            if (replacement is not null) reservedThreadIds.Add(replacement.ThreadId);
            changed = true;
        }

        return changed;
    }

    public static bool BackfillLegacyTerminals(IEnumerable<WorkspaceProject> projects)
    {
        var projectList = projects.ToList();
        var legacyTerminals = projectList
            .SelectMany(project => project.Terminals)
            .Where(terminal => terminal.CreatedAtUtc is null)
            .ToList();
        if (legacyTerminals.Count == 0) return false;

        var sessions = ReadSessions();
        var usedThreadIds = projectList
            .SelectMany(project => project.Terminals)
            .Select(terminal => terminal.CodexThreadId)
            .Where(threadId => Guid.TryParse(threadId, out _))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        foreach (var project in projectList)
        {
            var targets = project.Terminals
                .Where(terminal =>
                    terminal.CreatedAtUtc is null &&
                    !terminal.Name.Contains("grok", StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (targets.Count == 0) continue;

            var candidates = sessions
                .Where(session =>
                    SamePath(session.WorkingDirectory, project.FolderPath) &&
                    !usedThreadIds.Contains(session.ThreadId))
                .OrderByDescending(session => session.UpdatedAtUtc)
                .Take(targets.Count)
                .OrderBy(session => session.StartedAt)
                .ToList();
            for (var index = 0; index < Math.Min(targets.Count, candidates.Count); index++)
            {
                targets[index].CodexThreadId = candidates[index].ThreadId;
                usedThreadIds.Add(candidates[index].ThreadId);
            }
        }

        var migrationTime = DateTimeOffset.UtcNow;
        foreach (var terminal in legacyTerminals) terminal.CreatedAtUtc = migrationTime;
        return true;
    }

    public static string? FindMostRecentlyUpdated(
        string workingDirectory,
        TimeSpan maximumAge,
        IEnumerable<string?>? excludedThreadIds = null)
    {
        var excluded = excludedThreadIds?
            .Where(threadId => Guid.TryParse(threadId, out _))
            .Select(threadId => threadId!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase) ??
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var cutoff = DateTime.UtcNow - maximumAge;
        return ReadSessions()
            .Where(session =>
                session.UpdatedAtUtc >= cutoff &&
                SamePath(session.WorkingDirectory, workingDirectory) &&
                !excluded.Contains(session.ThreadId))
            .OrderByDescending(session => session.UpdatedAtUtc)
            .Select(session => session.ThreadId)
            .FirstOrDefault();
    }

    private static List<CodexSessionInfo> ReadSessions()
    {
        var sessionsRoot = SessionsRoot();
        if (!Directory.Exists(sessionsRoot)) return [];
        var sessions = new List<CodexSessionInfo>();
        try
        {
            foreach (var path in Directory.EnumerateFiles(sessionsRoot, "*.jsonl", SearchOption.AllDirectories))
            {
                try
                {
                    if (!TryReadSessionMetadataFile(path, out var metadata) ||
                        !metadata.IsUserCliSession) continue;
                    sessions.Add(new CodexSessionInfo(
                        metadata.ThreadId,
                        metadata.WorkingDirectory,
                        metadata.StartedAt,
                        metadata.UpdatedAtUtc));
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
                catch (JsonException)
                {
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        return sessions;
    }

    private static bool TryReadSessionMetadata(
        string threadId,
        out CodexSessionMetadata metadata)
    {
        metadata = default!;
        var sessionsRoot = SessionsRoot();
        if (!Directory.Exists(sessionsRoot)) return false;
        try
        {
            foreach (var path in Directory.EnumerateFiles(
                         sessionsRoot,
                         $"*{threadId}*.jsonl",
                         SearchOption.AllDirectories))
            {
                try
                {
                    if (TryReadSessionMetadataFile(path, out metadata) &&
                        string.Equals(metadata.ThreadId, threadId, StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
                catch (JsonException)
                {
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        metadata = default!;
        return false;
    }

    private static bool TryReadSessionMetadataFile(
        string path,
        out CodexSessionMetadata metadata)
    {
        metadata = default!;
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(
            stream,
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: true,
            bufferSize: 4096,
            leaveOpen: false);
        var firstLine = reader.ReadLine();
        if (string.IsNullOrWhiteSpace(firstLine)) return false;
        using var document = JsonDocument.Parse(firstLine);
        var root = document.RootElement;
        if (!root.TryGetProperty("type", out var type) ||
            !string.Equals(type.GetString(), "session_meta", StringComparison.Ordinal) ||
            !root.TryGetProperty("payload", out var payload)) return false;
        if (!TryGetGuid(payload, "id", out var threadId) &&
            !TryGetGuid(payload, "session_id", out threadId)) return false;
        if (!payload.TryGetProperty("cwd", out var cwd) ||
            cwd.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(cwd.GetString())) return false;

        var hasSource = payload.TryGetProperty("source", out var sourceValue);
        var source = hasSource && sourceValue.ValueKind == JsonValueKind.String
            ? sourceValue.GetString()
            : null;
        var originator = payload.TryGetProperty("originator", out var originatorValue) &&
                         originatorValue.ValueKind == JsonValueKind.String
            ? originatorValue.GetString()
            : null;
        var threadSource = payload.TryGetProperty("thread_source", out var threadSourceValue) &&
                           threadSourceValue.ValueKind == JsonValueKind.String
            ? threadSourceValue.GetString()
            : null;
        var sourceIsSubagent = hasSource &&
                               sourceValue.ValueKind == JsonValueKind.Object &&
                               sourceValue.TryGetProperty("subagent", out _);
        var isSubagent = sourceIsSubagent ||
                         string.Equals(threadSource, "subagent", StringComparison.OrdinalIgnoreCase);
        var isUserCliSession = !isSubagent &&
                               (string.Equals(source, "cli", StringComparison.OrdinalIgnoreCase) ||
                                (!hasSource && string.Equals(
                                    originator,
                                    "codex-tui",
                                    StringComparison.OrdinalIgnoreCase)));
        string? parentThreadId = null;
        if (isSubagent &&
            (TryGetGuid(payload, "parent_thread_id", out var parsedParentThreadId) ||
             TryGetGuid(payload, "forked_from_id", out parsedParentThreadId)))
            parentThreadId = parsedParentThreadId;
        var startedAt = payload.TryGetProperty("timestamp", out var timestamp) &&
                        timestamp.ValueKind == JsonValueKind.String &&
                        DateTimeOffset.TryParse(timestamp.GetString(), out var parsedTimestamp)
            ? parsedTimestamp
            : new DateTimeOffset(File.GetCreationTimeUtc(path), TimeSpan.Zero);
        metadata = new CodexSessionMetadata(
            threadId,
            cwd.GetString()!,
            startedAt,
            File.GetLastWriteTimeUtc(path),
            isUserCliSession,
            isSubagent,
            parentThreadId);
        return true;
    }

    private static bool TryGetGuid(JsonElement element, string propertyName, out string threadId)
    {
        threadId = string.Empty;
        if (!element.TryGetProperty(propertyName, out var property) ||
            property.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(property.GetString(), out var parsed)) return false;
        threadId = parsed.ToString();
        return true;
    }

    private static string SessionsRoot()
    {
        var codexHome = Environment.GetEnvironmentVariable("CODEX_HOME");
        if (string.IsNullOrWhiteSpace(codexHome))
            codexHome = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".codex");
        return Path.Combine(codexHome, "sessions");
    }

    private static bool SamePath(string first, string second)
    {
        try
        {
            return string.Equals(
                Path.GetFullPath(first).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                Path.GetFullPath(second).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}
