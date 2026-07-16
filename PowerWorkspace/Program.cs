using System.IO;
using System.Windows;

namespace PowerWorkspace;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Length > 0 && string.Equals(args[0], NotificationBridge.NotifyArgument, StringComparison.Ordinal))
        {
            NotificationBridge.RunNotifier(args);
            return;
        }

        if (string.Equals(
                Environment.GetEnvironmentVariable("POWERWORKSPACE_BACKFILL_ONLY"),
                "1",
                StringComparison.Ordinal))
        {
            var catalog = ProjectStore.Load();
            var changed = CodexSessionLocator.RepairSubagentTerminalAssociations(catalog.Projects);
            changed |= CodexSessionLocator.RepairDuplicateTerminalAssociations(catalog.Projects);
            changed |= CodexSessionLocator.BackfillLegacyTerminals(catalog.Projects);
            changed |= GrokSessionLocator.BackfillLegacyTerminals(catalog.Projects);
            if (changed)
                _ = ProjectStore.Save(catalog.Projects, catalog.SelectedProjectId);
            return;
        }

        TryRemovePreviousBuild();
        NotificationBridge.EnsureCodexNotifyConfigured();
        var application = new Application
        {
            ShutdownMode = ShutdownMode.OnMainWindowClose,
        };
        application.Run(new MainWindow());
    }

    private static void TryRemovePreviousBuild()
    {
        var executableDirectory = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
        var previousBuilds = Directory
            .EnumerateFiles(executableDirectory, "IHATECODING.previous*.exe")
            .Concat(Directory.EnumerateFiles(executableDirectory, "XXCODING.previous*.exe"))
            .Concat(new[]
            {
                Path.Combine(executableDirectory, "XXCODING.exe"),
                Path.Combine(executableDirectory, "PowerWorkspace.exe"),
                Path.Combine(executableDirectory, "PowerWorkspace.previous.exe"),
            });
        foreach (var previousBuild in previousBuilds)
        {
            try
            {
                if (File.Exists(previousBuild)) File.Delete(previousBuild);
            }
            catch
            {
                // The old build can remain locked until its already-open window is closed.
            }
        }
    }
}
