using System.Windows;

namespace PowerWorkspace;

internal enum WorkspaceTabKind
{
    Empty,
    Project,
    Browser,
    Output,
}

internal sealed class WorkspaceTab
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public required WorkspaceTabKind Kind { get; set; }
    public required string Title { get; set; }
    public string? ProjectId { get; set; }
    public FrameworkElement? Content { get; init; }
}
