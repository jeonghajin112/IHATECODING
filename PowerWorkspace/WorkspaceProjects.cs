using System.IO;
using System.Text.Json;

namespace PowerWorkspace;

internal sealed class WorkspaceProject
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");
    public string Name { get; init; } = string.Empty;
    public string FolderPath { get; init; } = string.Empty;
    public List<SavedTerminalState> Terminals { get; set; } = [];
    public Dictionary<string, List<double>> PaneWidthRatios { get; set; } = [];
}

internal sealed class SavedTerminalState
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "PowerShell";
    public string StartDirectory { get; set; } = string.Empty;
    public string? CodexThreadId { get; set; }
    public string? GrokSessionId { get; set; }
    public DateTimeOffset? CreatedAtUtc { get; set; }
    public bool CompletionPending { get; set; }
}

internal sealed class ProjectCatalog
{
    public List<WorkspaceProject> Projects { get; init; } = [];
    public string? SelectedProjectId { get; init; }
}

internal static class ProjectStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    public static ProjectCatalog Load()
    {
        try
        {
            if (!File.Exists(StoragePath)) return new ProjectCatalog();
            var catalog = JsonSerializer.Deserialize<ProjectCatalog>(File.ReadAllText(StoragePath), JsonOptions);
            if (catalog is null) return new ProjectCatalog();

            var validProjects = catalog.Projects
                .Where(project =>
                    !string.IsNullOrWhiteSpace(project.Id) &&
                    !string.IsNullOrWhiteSpace(project.Name) &&
                    !string.IsNullOrWhiteSpace(project.FolderPath))
                .GroupBy(project => project.Id, StringComparer.Ordinal)
                .Select(group => group.First())
                .ToList();
            foreach (var project in validProjects)
            {
                project.Terminals ??= [];
                project.PaneWidthRatios ??= [];
                project.PaneWidthRatios = project.PaneWidthRatios
                    .Where(entry =>
                        !string.IsNullOrWhiteSpace(entry.Key) &&
                        entry.Value is { Count: > 0 } &&
                        entry.Value.All(value => double.IsFinite(value) && value > 0))
                    .ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);
                project.Terminals = project.Terminals
                    .Where(terminal =>
                        !string.IsNullOrWhiteSpace(terminal.Id) &&
                        !string.IsNullOrWhiteSpace(terminal.Name))
                    .GroupBy(terminal => terminal.Id, StringComparer.Ordinal)
                    .Select(group => group.First())
                    .Take(20)
                    .ToList();
                foreach (var terminal in project.Terminals)
                {
                    if (string.IsNullOrWhiteSpace(terminal.StartDirectory))
                        terminal.StartDirectory = project.FolderPath;
                    if (terminal.CodexThreadId is not null && !Guid.TryParse(terminal.CodexThreadId, out _))
                        terminal.CodexThreadId = null;
                    if (terminal.GrokSessionId is not null && !Guid.TryParse(terminal.GrokSessionId, out _))
                        terminal.GrokSessionId = null;
                }
            }
            return new ProjectCatalog
            {
                Projects = validProjects,
                SelectedProjectId = catalog.SelectedProjectId,
            };
        }
        catch
        {
            return new ProjectCatalog();
        }
    }

    public static bool Save(IEnumerable<WorkspaceProject> projects, string? selectedProjectId)
    {
        try
        {
            var directory = Path.GetDirectoryName(StoragePath);
            if (string.IsNullOrWhiteSpace(directory)) return false;
            Directory.CreateDirectory(directory);

            var catalog = new ProjectCatalog
            {
                Projects = projects.ToList(),
                SelectedProjectId = selectedProjectId,
            };
            var temporaryPath = StoragePath + ".tmp";
            File.WriteAllText(temporaryPath, JsonSerializer.Serialize(catalog, JsonOptions));
            File.Move(temporaryPath, StoragePath, overwrite: true);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string StoragePath =>
        Environment.GetEnvironmentVariable("POWERWORKSPACE_PROJECTS_PATH") is { Length: > 0 } overridePath
            ? overridePath
            : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PowerWorkspace",
                "projects.json");
}
