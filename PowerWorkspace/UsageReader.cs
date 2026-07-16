using System.IO;
using System.Text;
using System.Text.Json;

namespace PowerWorkspace;

internal sealed record LimitSnapshot(
    double UsedPercent,
    int WindowMinutes,
    DateTimeOffset ResetsAt,
    DateTimeOffset UpdatedAt);

internal sealed record ServiceUsage(
    LimitSnapshot? FiveHour,
    LimitSnapshot? Weekly,
    DateTimeOffset? UpdatedAt);

internal sealed record UsageSnapshot(ServiceUsage Codex, ServiceUsage Grok, DateTimeOffset ReadAt);

internal static class UsageReader
{
    private static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private static readonly string CodexSessions = Path.Combine(Home, ".codex", "sessions");
    private static readonly string GrokLog = Path.Combine(Home, ".grok", "logs", "unified.jsonl");

    public static UsageSnapshot ReadAll() => new(ReadCodex(), ReadGrok(), DateTimeOffset.Now);

    private static ServiceUsage ReadCodex()
    {
        if (!Directory.Exists(CodexSessions)) return new(null, null, null);

        FileInfo[] candidates;
        try
        {
            candidates = new DirectoryInfo(CodexSessions)
                .EnumerateFiles("*.jsonl", SearchOption.AllDirectories)
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .Take(12)
                .ToArray();
        }
        catch
        {
            return new(null, null, null);
        }

        var records = new List<LimitSnapshot>();
        foreach (var file in candidates)
        {
            var snapshots = ReadLatestCodexRecord(file.FullName, file.LastWriteTimeUtc);
            if (snapshots is not null) records.AddRange(snapshots);
        }

        var now = DateTimeOffset.UtcNow;
        var current = records.Where(record => record.ResetsAt > now).ToArray();
        var fiveHour = ChooseCurrent(current, record => record.WindowMinutes is >= 240 and <= 360);
        var weekly = ChooseCurrent(current, record => record.WindowMinutes >= 9000);
        DateTimeOffset? updatedAt = records.Count > 0 ? records.Max(record => record.UpdatedAt) : null;
        return new(fiveHour, weekly, updatedAt);
    }

    private static IReadOnlyList<LimitSnapshot>? ReadLatestCodexRecord(string filePath, DateTime fallbackTime)
    {
        var lines = ReadTail(filePath, 512 * 1024).Split('\n');
        for (var index = lines.Length - 1; index >= 0; index--)
        {
            var line = lines[index];
            if (!line.Contains("\"rate_limits\"", StringComparison.Ordinal)) continue;

            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                var rateLimits = root.GetProperty("payload").GetProperty("rate_limits");
                if (!rateLimits.TryGetProperty("limit_id", out var limitId) ||
                    !string.Equals(limitId.GetString(), "codex", StringComparison.Ordinal))
                {
                    continue;
                }

                var updatedAt = root.TryGetProperty("timestamp", out var timestamp) &&
                                DateTimeOffset.TryParse(timestamp.GetString(), out var parsedTimestamp)
                    ? parsedTimestamp
                    : new DateTimeOffset(fallbackTime, TimeSpan.Zero);

                var result = new List<LimitSnapshot>(2);
                AddCodexLimit(rateLimits, "primary", updatedAt, result);
                AddCodexLimit(rateLimits, "secondary", updatedAt, result);
                return result;
            }
            catch (JsonException) { }
            catch (InvalidOperationException) { }
        }

        return null;
    }

    private static void AddCodexLimit(
        JsonElement rateLimits,
        string propertyName,
        DateTimeOffset updatedAt,
        ICollection<LimitSnapshot> output)
    {
        if (!rateLimits.TryGetProperty(propertyName, out var limit) || limit.ValueKind != JsonValueKind.Object) return;
        if (!limit.TryGetProperty("used_percent", out var usedProperty) || !usedProperty.TryGetDouble(out var used)) return;
        if (!limit.TryGetProperty("window_minutes", out var windowProperty) || !windowProperty.TryGetInt32(out var window)) return;
        if (!limit.TryGetProperty("resets_at", out var resetProperty) || !resetProperty.TryGetInt64(out var resetSeconds)) return;

        output.Add(new(
            Math.Clamp(used, 0, 100),
            window,
            DateTimeOffset.FromUnixTimeSeconds(resetSeconds),
            updatedAt));
    }

    private static LimitSnapshot? ChooseCurrent(
        IEnumerable<LimitSnapshot> records,
        Func<LimitSnapshot, bool> predicate)
    {
        var matches = records.Where(predicate).ToArray();
        if (matches.Length == 0) return null;
        var nearestReset = matches.Min(record => record.ResetsAt);
        return matches
            .Where(record => record.ResetsAt == nearestReset)
            .OrderByDescending(record => record.UsedPercent)
            .ThenByDescending(record => record.UpdatedAt)
            .First();
    }

    private static ServiceUsage ReadGrok()
    {
        if (!File.Exists(GrokLog)) return new(null, null, null);
        var lines = ReadTail(GrokLog, 8 * 1024 * 1024).Split('\n');

        for (var index = lines.Length - 1; index >= 0; index--)
        {
            var line = lines[index];
            if (!line.Contains("\"creditUsagePercent\"", StringComparison.Ordinal)) continue;

            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                var config = root.GetProperty("ctx").GetProperty("config");
                if (!config.GetProperty("creditUsagePercent").TryGetDouble(out var used)) continue;

                string? resetText = null;
                if (config.TryGetProperty("currentPeriod", out var period) &&
                    period.ValueKind == JsonValueKind.Object &&
                    period.TryGetProperty("end", out var periodEnd))
                {
                    resetText = periodEnd.GetString();
                }
                else if (config.TryGetProperty("billingPeriodEnd", out var billingEnd))
                {
                    resetText = billingEnd.GetString();
                }

                if (!DateTimeOffset.TryParse(resetText, out var resetsAt)) continue;
                var updatedAt = root.TryGetProperty("ts", out var timestamp) &&
                                DateTimeOffset.TryParse(timestamp.GetString(), out var parsedTimestamp)
                    ? parsedTimestamp
                    : new DateTimeOffset(File.GetLastWriteTimeUtc(GrokLog), TimeSpan.Zero);

                var weekly = new LimitSnapshot(Math.Clamp(used, 0, 100), 10080, resetsAt, updatedAt);
                return new(null, weekly, updatedAt);
            }
            catch (JsonException) { }
            catch (InvalidOperationException) { }
        }

        return new(null, null, null);
    }

    private static string ReadTail(string filePath, int maxBytes)
    {
        try
        {
            using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var bytesToRead = (int)Math.Min(stream.Length, maxBytes);
            var start = Math.Max(0, stream.Length - bytesToRead);
            stream.Seek(start, SeekOrigin.Begin);
            var buffer = new byte[bytesToRead];
            var totalRead = 0;
            while (totalRead < bytesToRead)
            {
                var read = stream.Read(buffer, totalRead, bytesToRead - totalRead);
                if (read == 0) break;
                totalRead += read;
            }

            var text = Encoding.UTF8.GetString(buffer, 0, totalRead);
            if (start > 0)
            {
                var firstNewline = text.IndexOf('\n');
                text = firstNewline >= 0 ? text[(firstNewline + 1)..] : string.Empty;
            }
            return text;
        }
        catch
        {
            return string.Empty;
        }
    }
}
