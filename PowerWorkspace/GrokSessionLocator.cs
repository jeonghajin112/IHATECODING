using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PowerWorkspace;

internal sealed record GrokSessionInfo(
    string SessionId,
    string WorkingDirectory,
    string Summary,
    DateTimeOffset UpdatedAt);

internal static partial class GrokSessionLocator
{
    private static readonly HashSet<string> IgnoredNameTokens = new(StringComparer.OrdinalIgnoreCase)
    {
        "GROK",
        "POWERSHELL",
        "SHELL",
        "CLI",
    };

    public static bool BackfillLegacyTerminals(IEnumerable<WorkspaceProject> projects)
    {
        var projectList = projects.ToList();
        if (!projectList.Any(project => project.Terminals.Any(terminal =>
                terminal.GrokSessionId is null &&
                terminal.Name.Contains("grok", StringComparison.OrdinalIgnoreCase)))) return false;
        var usedSessionIds = projectList
            .SelectMany(project => project.Terminals)
            .Select(terminal => terminal.GrokSessionId)
            .Where(sessionId => Guid.TryParse(sessionId, out _))
            .Select(sessionId => sessionId!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var sessions = ReadSessions();
        var changed = false;

        foreach (var project in projectList)
        {
            var targets = project.Terminals
                .Where(terminal =>
                    terminal.GrokSessionId is null &&
                    terminal.Name.Contains("grok", StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (targets.Count == 0) continue;

            var candidates = sessions
                .Where(session =>
                    SamePath(session.WorkingDirectory, project.FolderPath) &&
                    !usedSessionIds.Contains(session.SessionId))
                .OrderByDescending(session => session.UpdatedAt)
                .ToList();
            if (candidates.Count == 0) continue;

            // Match descriptive pane names before using the chronological fallback.
            foreach (var target in targets.ToArray())
            {
                var targetTokens = NameTokens(target.Name);
                if (targetTokens.Count == 0) continue;
                var best = candidates
                    .Select(session => new
                    {
                        Session = session,
                        Score = targetTokens.Intersect(NameTokens(session.Summary)).Count(),
                    })
                    .Where(match => match.Score > 0)
                    .OrderByDescending(match => match.Score)
                    .ThenByDescending(match => match.Session.UpdatedAt)
                    .FirstOrDefault();
                if (best is null) continue;
                Assign(target, best.Session);
                targets.Remove(target);
                candidates.Remove(best.Session);
            }

            // Unmatched Grok panes receive the remaining recent sessions in pane order.
            for (var index = 0; index < Math.Min(targets.Count, candidates.Count); index++)
                Assign(targets[index], candidates[index]);
        }

        return changed;

        void Assign(SavedTerminalState terminal, GrokSessionInfo session)
        {
            terminal.GrokSessionId = session.SessionId;
            terminal.CodexThreadId = null;
            usedSessionIds.Add(session.SessionId);
            changed = true;
        }
    }

    private static List<GrokSessionInfo> ReadSessions()
    {
        var sessionsRoot = SessionsRoot();
        if (!Directory.Exists(sessionsRoot)) return [];
        var sessions = new List<GrokSessionInfo>();
        try
        {
            foreach (var projectDirectory in Directory.EnumerateDirectories(sessionsRoot))
            {
                foreach (var sessionDirectory in Directory.EnumerateDirectories(projectDirectory))
                {
                    var sessionId = Path.GetFileName(sessionDirectory);
                    if (!Guid.TryParse(sessionId, out var parsedSessionId)) continue;
                    var summaryPath = Path.Combine(sessionDirectory, "summary.json");
                    if (!File.Exists(summaryPath)) continue;
                    try
                    {
                        using var stream = new FileStream(
                            summaryPath,
                            FileMode.Open,
                            FileAccess.Read,
                            FileShare.ReadWrite | FileShare.Delete);
                        using var document = JsonDocument.Parse(stream);
                        var root = document.RootElement;
                        if (!root.TryGetProperty("session_summary", out var summaryValue) ||
                            summaryValue.ValueKind != JsonValueKind.String ||
                            string.IsNullOrWhiteSpace(summaryValue.GetString())) continue;
                        if (!root.TryGetProperty("info", out var info) ||
                            !info.TryGetProperty("cwd", out var cwdValue) ||
                            cwdValue.ValueKind != JsonValueKind.String ||
                            string.IsNullOrWhiteSpace(cwdValue.GetString())) continue;
                        var updatedAt = root.TryGetProperty("updated_at", out var updatedValue) &&
                                        updatedValue.ValueKind == JsonValueKind.String &&
                                        DateTimeOffset.TryParse(
                                            updatedValue.GetString(),
                                            CultureInfo.InvariantCulture,
                                            DateTimeStyles.AssumeUniversal,
                                            out var parsedUpdatedAt)
                            ? parsedUpdatedAt
                            : new DateTimeOffset(File.GetLastWriteTimeUtc(summaryPath), TimeSpan.Zero);
                        sessions.Add(new GrokSessionInfo(
                            parsedSessionId.ToString(),
                            cwdValue.GetString()!,
                            summaryValue.GetString()!,
                            updatedAt));
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
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        return sessions;
    }

    private static HashSet<string> NameTokens(string value) =>
        TokenPattern()
            .Matches(value)
            .Cast<Match>()
            .Select(match => match.Value)
            .Where(token => token.Length >= 3 && !IgnoredNameTokens.Contains(token))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    private static string SessionsRoot()
    {
        var grokHome = Environment.GetEnvironmentVariable("GROK_HOME");
        if (string.IsNullOrWhiteSpace(grokHome))
            grokHome = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".grok");
        return Path.Combine(grokHome, "sessions");
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

    [GeneratedRegex(@"[\p{L}\p{N}]+", RegexOptions.CultureInvariant)]
    private static partial Regex TokenPattern();
}
