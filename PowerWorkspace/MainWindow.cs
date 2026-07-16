using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Interop;
using System.Windows.Threading;

namespace PowerWorkspace;

internal sealed class TerminalSession
{
    public required int Number { get; init; }
    public required string ProjectId { get; init; }
    public required string StartDirectory { get; init; }
    public required SavedTerminalState State { get; init; }
    public required bool PersistState { get; init; }
    public required IntegratedPowerShellHost Terminal { get; init; }
    public required Border Panel { get; init; }
    public required Thumb LeftResizeThumb { get; init; }
    public required Thumb RightResizeThumb { get; init; }
    public required Action BeginRename { get; init; }
    public required Action<bool> FinishRename { get; init; }
    public required DropShadowEffect CompletionEffect { get; init; }
    public bool CompletionPending { get; set; }
    public bool CompletionSignalPending { get; set; }
    public long CompletionSignalTimestamp { get; set; }
    public bool Closing { get; set; }
}

public sealed class MainWindow : Window
{
    private const int MaximumSessions = 20;
    private const int WmHotkey = 0x0312;
    private const int WmMouseActivate = 0x0021;
    private const int MaActivate = 1;
    private const int HotkeyAddPowerShell = 1;
    private const int HotkeyClosePowerShell = 2;
    private const int HotkeyMaximizePowerShell = 3;
    private const int SwHide = 0;
    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModShift = 0x0004;
    private const uint ModNoRepeat = 0x4000;
    private const double DragStartDistance = 8;
    private const double DragMinimumReorderDistance = 12;
    private const double DragSlotHysteresis = 18;
    private const double DragBounceBackAngle = 1;
    private const double PaneGap = 10;
    private const double PreferredMinimumPaneWidth = 180;
    private const double PaneResizeSnapDistance = 10;
    private const double PaneResizeSnapReleaseDistance = 16;
    private const double PaneResizeInitialTargetTolerance = 0.75;
    private static readonly TimeSpan DragCandidateHoldTime = TimeSpan.FromMilliseconds(80);
    private static readonly TimeSpan CompletionOutputQuietTime = TimeSpan.FromSeconds(1);

    private static readonly SolidColorBrush BackgroundBrush = Brush("#050505");
    private static readonly SolidColorBrush SurfaceBrush = Brush("#0A0A0B");
    private static readonly SolidColorBrush HeaderBrush = Brush("#111112");
    private static readonly SolidColorBrush PanelBorderBrush = Brush("#29292C");
    private static readonly SolidColorBrush ActiveBorderBrush = Brush("#F4F4F5");
    private static readonly SolidColorBrush TextBrush = Brush("#F4F4F5");
    private static readonly SolidColorBrush MutedBrush = Brush("#85858C");
    private static readonly SolidColorBrush BlueBrush = Brush("#F4F4F5");
    private static readonly SolidColorBrush GreenBrush = Brush("#F4F4F5");
    private static readonly SolidColorBrush GrokBrush = Brush("#A1A1AA");
    private static readonly SolidColorBrush SelectedSurfaceBrush = Brush("#1A1A1C");
    private static readonly SolidColorBrush CompletionBrush = Brush("#F4C95D");
    private static readonly Geometry CodexIconGeometry = IconGeometry(
        "M6.13671 5.82399V4.30398C6.13671 4.17596 6.18431 4.07991 6.29527 4.01598L9.32406 2.256C9.73637 2.01602 10.228 1.90406 10.7353 1.90406C12.6382 1.90406 13.8434 3.3921 13.8434 4.97604C13.8434 5.088 13.8434 5.21602 13.8274 5.34404L10.6877 3.488C10.4975 3.37605 10.3071 3.37605 10.1168 3.488L6.13671 5.82399ZM13.209 11.7441V8.11195C13.209 7.88789 13.1138 7.72791 12.9236 7.61594L8.94344 5.27995L10.2437 4.5279C10.3547 4.46397 10.4499 4.46397 10.5609 4.5279L13.5896 6.28789C14.4619 6.79996 15.0484 7.88789 15.0484 8.94385C15.0484 10.1598 14.335 11.28 13.209 11.7441ZM5.20114 8.54404L3.90086 7.77608C3.78989 7.71215 3.7423 7.6161 3.7423 7.48808V3.96811C3.7423 2.25615 5.04259 0.960061 6.80278 0.960061C7.46883 0.960061 8.08714 1.18413 8.61056 1.58409L5.48672 3.40816C5.29649 3.52012 5.20129 3.68011 5.20129 3.90418L5.20114 8.54404ZM7.99999 10.176L6.13671 9.12005V6.8801L7.99999 5.82414L9.8631 6.8801V9.12005L7.99999 10.176ZM9.19719 15.0401C8.53113 15.0401 7.91282 14.816 7.3894 14.4161L10.5132 12.5919C10.7034 12.48 10.7987 12.3201 10.7987 12.096V7.45596L12.1149 8.22392C12.2258 8.28785 12.2734 8.3839 12.2734 8.51192V12.0319C12.2734 13.7438 10.9572 15.0401 9.19719 15.0401ZM5.43898 11.4721L2.41018 9.71211C1.53796 9.20003 0.95134 8.11211 0.95134 7.05615C0.95134 5.82414 1.68077 4.72016 2.80657 4.25611V7.9041C2.80657 8.12817 2.90177 8.28815 3.092 8.40012L7.05637 10.72L5.75609 11.4721C5.64513 11.5361 5.54993 11.5361 5.43898 11.4721ZM5.26465 14.0961C3.47278 14.0961 2.15658 12.736 2.15658 11.056C2.15658 10.928 2.17249 10.8 2.18826 10.672L5.3121 12.4961C5.50234 12.608 5.69273 12.608 5.88297 12.4961L9.8631 10.1762V11.6962C9.8631 11.8242 9.8155 11.9202 9.70454 11.9841L6.67574 13.7441C6.26344 13.9841 5.77199 14.0961 5.26465 14.0961ZM9.19719 16C11.1159 16 12.7174 14.624 13.0823 12.8C14.8582 12.3359 16 10.6559 16 8.944C16 7.82396 15.5243 6.73603 14.668 5.95201C14.7473 5.61598 14.7949 5.27995 14.7949 4.94407C14.7949 2.65612 12.9554 0.944002 10.8305 0.944002C10.4025 0.944002 9.99013 1.00794 9.57782 1.15201C8.86416 0.447988 7.88099 0 6.80278 0C4.88403 0 3.28254 1.37593 2.91768 3.19999C1.14173 3.66404 0 5.34404 0 7.056C0 8.17604 0.475669 9.26397 1.33197 10.048C1.25269 10.384 1.20509 10.72 1.20509 11.0559C1.20509 13.3438 3.04456 15.0559 5.16946 15.0559C5.59753 15.0559 6.00984 14.9921 6.42215 14.848C7.13565 15.552 8.11882 16 9.19719 16Z");
    private static readonly Geometry GrokIconGeometry = IconGeometry(
        "M4.94 4.96A9.97 9.97 0 0 1 15.775 2.778A8.7 8.7 0 0 1 17.808 3.888L14.802 5.278C12.003 4.101 8.797 4.9 6.84 6.86C4.276 9.425 3.694 13.814 6.48 16.782L6.758 17.066L0.124 23C1.999 21.027 3.895 18.573 2.76 15.81C1.24 12.112 2.125 7.78 4.94 4.96M23.9 0.1C21.636 3.274 20.716 5.489 21.703 9.74L21.696 9.733C22.449 12.934 21.644 16.483 19.043 19.088C15.764 22.373 10.517 23.104 6.196 20.148L9.21 18.75C11.968 19.834 14.985 19.357 17.153 17.186C19.322 15.016 19.808 11.854 18.719 9.223C18.512 8.723 17.891 8.598 17.456 8.919L8.59 15.472L21.29 2.702V2.712Z");

    private readonly Grid _workspace = new() { Margin = new Thickness(3) };
    private readonly StackPanel _usageLeft = new()
    {
        Orientation = Orientation.Horizontal,
        VerticalAlignment = VerticalAlignment.Center,
    };
    private readonly TextBlock _sessionCount = Text("0 / 20", 11, MutedBrush);
    private readonly TextBlock _activeProjectLabel = Text("프로젝트를 선택하세요", 11, MutedBrush);
    private readonly TextBlock _projectCountLabel = Text("0", 10, MutedBrush);
    private readonly ListBox _projectList = new()
    {
        Background = Brushes.Transparent,
        Foreground = TextBrush,
        BorderThickness = new Thickness(0),
        Padding = new Thickness(4, 2, 4, 2),
        HorizontalContentAlignment = HorizontalAlignment.Stretch,
    };
    private readonly List<WorkspaceProject> _projects = [];
    private readonly List<TerminalSession> _sessions = [];
    private readonly Dictionary<string, Border> _projectAlertBadges = new(StringComparer.Ordinal);
    private readonly HashSet<string> _restoredProjects = new(StringComparer.Ordinal);
    private readonly HashSet<int> _registeredHotkeys = [];
    private readonly DispatcherTimer _usageTimer;
    private readonly DispatcherTimer _completionTimer;
    private readonly CodexCompletionWatcher _codexCompletionWatcher;
    private readonly bool _smokeTest = string.Equals(
        Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_TEST"),
        "1",
        StringComparison.Ordinal);
    private readonly bool _smokeVisible = string.Equals(
        Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_VISIBLE"),
        "1",
        StringComparison.Ordinal);

    private TerminalSession? _activeSession;
    private TerminalSession? _maximizedSession;
    private TerminalSession? _draggedSession;
    private TerminalSession? _paneResizeSession;
    private WorkspaceProject? _selectedProject;
    private FrameworkElement? _dragCaptureElement;
    private Border? _dragInsertionLine;
    private Window? _dragInsertionWindow;
    private List<TerminalSession>? _dragOriginalOrder;
    private List<TerminalSession>? _dragPreviewOrder;
    private List<Rect>? _dragSlots;
    private Point _dragStartScreen;
    private Point _dragLastAcceptedScreen;
    private Vector _dragLastAcceptedVector;
    private DateTime _dragCandidateSinceUtc;
    private int _dragSourceSlotIndex = -1;
    private int _dragAcceptedSlotIndex = -1;
    private int _dragCandidateSlotIndex = -1;
    private int _dragPreviousAcceptedSlotIndex = -1;
    private int _paneResizeRow = -1;
    private int _paneResizeLeftColumn = -1;
    private int _terminalVisibilityRefreshVersion;
    private int _nextNumber = 1;
    private double _paneResizeRawBoundaryX;
    private double _paneResizeStartBoundaryX;
    private double _paneResizeStartPointerX;
    private double _paneResizeMinimumBoundaryX;
    private double _paneResizeMaximumBoundaryX;
    private double? _paneResizeSnapTargetX;
    private double? _paneResizeIgnoredInitialTargetX;
    private double[]? _paneResizeStartWidths;
    private List<double>? _paneResizeSnapTargets;
    private bool _usageReadInProgress;
    private bool _suppressProjectSelection;
    private bool _isSessionDragging;
    private bool _dragHasValidDrop;
    private bool _shutdownStarted;
    private HwndSource? _windowSource;

    public MainWindow()
    {
        Title = "IHATECODING";
        Width = 1440;
        Height = 900;
        MinWidth = 900;
        MinHeight = 600;
        WindowState = _smokeTest ? WindowState.Normal : WindowState.Maximized;
        ShowInTaskbar = !_smokeTest || _smokeVisible;
        Background = BackgroundBrush;
        FontFamily = new FontFamily("Segoe UI Variable Text");
        UseLayoutRounding = true;

        if (_smokeTest && !_smokeVisible)
        {
            Left = -32000;
            Top = -32000;
            Opacity = 0;
        }

        var root = new Grid { Background = BackgroundBrush };
        root.AddHandler(
            Mouse.PreviewMouseDownEvent,
            new MouseButtonEventHandler((_, _) => ClearActiveSessionSelection()),
            handledEventsToo: true);
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(240) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(54) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) });

        var sidebar = BuildProjectSidebar();
        Grid.SetRowSpan(sidebar, 3);
        root.Children.Add(sidebar);

        var toolbar = BuildToolbar();
        Grid.SetRow(toolbar, 0);
        Grid.SetColumn(toolbar, 1);
        root.Children.Add(toolbar);

        var workspaceFrame = new Border { Background = BackgroundBrush, Child = _workspace };
        Grid.SetRow(workspaceFrame, 1);
        Grid.SetColumn(workspaceFrame, 1);
        root.Children.Add(workspaceFrame);

        var usageBar = new Border
        {
            Background = HeaderBrush,
            BorderBrush = PanelBorderBrush,
            BorderThickness = new Thickness(0, 1, 0, 0),
            Padding = new Thickness(16, 0, 16, 0),
            Child = _usageLeft,
        };
        Grid.SetRow(usageBar, 2);
        Grid.SetColumn(usageBar, 1);
        root.Children.Add(usageBar);
        Content = root;
        LoadProjects();

        _workspace.SizeChanged += (_, _) =>
        {
            if (!_isSessionDragging) UpdateLiveSessionGridPositions();
        };

        _usageTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(15) };
        _usageTimer.Tick += async (_, _) => await RefreshUsageAsync();
        _completionTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(60) };
        _completionTimer.Tick += OnCompletionTimerTick;
        _codexCompletionWatcher = new CodexCompletionWatcher(
            _projects.SelectMany(project => project.Terminals)
                .Select(terminal => terminal.CodexThreadId),
            threadId =>
            {
                if (_shutdownStarted) return;
                _ = Dispatcher.BeginInvoke(() => HandleWatchedCodexCompletion(threadId));
            });

        RebuildLayout();
        AddHandler(Keyboard.PreviewKeyDownEvent, new KeyEventHandler(OnPreviewKeyDown), true);
        Loaded += OnLoadedAsync;
        SourceInitialized += OnSourceInitialized;
        Activated += (_, _) => RegisterHotkeys();
        Deactivated += (_, _) =>
        {
            UnregisterHotkeys();
            ClearActiveSessionSelection();
        };
        Closing += OnClosing;
    }

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        if (_smokeTest)
        {
            var smokeFolder = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var projectSmokeFolder = Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_PROJECT_FOLDER");
            WorkspaceProject smokeTargetProject;
            if (!string.IsNullOrWhiteSpace(projectSmokeFolder))
            {
                var savedCatalog = ProjectStore.Load();
                var smokeProject = savedCatalog.Projects.FirstOrDefault(project =>
                    SamePath(project.FolderPath, projectSmokeFolder));
                if (smokeProject is null)
                {
                    smokeProject = new WorkspaceProject
                    {
                        Name = "Smoke Project",
                        FolderPath = projectSmokeFolder,
                    };
                    if (!ProjectStore.Save([smokeProject], smokeProject.Id)) Environment.ExitCode = 8;
                }
                LoadProjects();
                if (_selectedProject is null ||
                    !string.Equals(_selectedProject.Id, smokeProject.Id, StringComparison.Ordinal) ||
                    !SamePath(_selectedProject.FolderPath, projectSmokeFolder))
                    Environment.ExitCode = 9;
                if (_projectList.Items.Count != _projects.Count || _projectList.SelectedItem is null)
                    Environment.ExitCode = 11;
                smokeTargetProject = _selectedProject ?? smokeProject;
            }
            else
            {
                smokeTargetProject = _selectedProject ?? new WorkspaceProject
                {
                    Id = "smoke-project",
                    Name = "Smoke Project",
                    FolderPath = smokeFolder,
                };
                _selectedProject = smokeTargetProject;
            }
            var restoreOnly = string.Equals(
                Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_RESTORE_ONLY"),
                "1",
                StringComparison.Ordinal);
            if (restoreOnly)
            {
                _selectedProject = smokeTargetProject;
                ActivateProject(smokeTargetProject);
                if (_sessions.Count != smokeTargetProject.Terminals.Count) Environment.ExitCode = 13;
                if (_sessions.Any(session =>
                        session.CompletionPending != session.State.CompletionPending))
                    Environment.ExitCode = 18;
                var expectedThreadId = Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_EXPECT_THREAD");
                if (!string.IsNullOrWhiteSpace(expectedThreadId) &&
                    _sessions.All(session =>
                        !string.Equals(session.Terminal.ResumeThreadId, expectedThreadId, StringComparison.Ordinal)))
                    Environment.ExitCode = 14;
                var expectedGrokSessionId =
                    Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_EXPECT_GROK_SESSION");
                if (!string.IsNullOrWhiteSpace(expectedGrokSessionId) &&
                    _sessions.All(session =>
                        !string.Equals(
                            session.Terminal.ResumeGrokSessionId,
                            expectedGrokSessionId,
                            StringComparison.Ordinal)))
                    Environment.ExitCode = 20;
                if (string.Equals(
                        Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_SWITCH_PROJECTS"),
                        "1",
                        StringComparison.Ordinal))
                {
                    var originalSession = SessionsForProject(smokeTargetProject.Id).FirstOrDefault();
                    var otherProject = _projects.FirstOrDefault(project =>
                        !string.Equals(project.Id, smokeTargetProject.Id, StringComparison.Ordinal));
                    if (originalSession is null || otherProject is null)
                    {
                        Environment.ExitCode = 15;
                    }
                    else
                    {
                        var originalDeadline = DateTime.UtcNow.AddSeconds(5);
                        while (!originalSession.Terminal.IsReady && DateTime.UtcNow < originalDeadline)
                            await Task.Delay(50);
                        ActivateProject(otherProject);
                        if (SessionsForProject(otherProject.Id).Count != otherProject.Terminals.Count)
                            Environment.ExitCode = 16;
                        var otherDeadline = DateTime.UtcNow.AddSeconds(5);
                        while (SessionsForProject(otherProject.Id).Any(session => !session.Terminal.IsReady) &&
                               DateTime.UtcNow < otherDeadline)
                            await Task.Delay(50);
                        ActivateProject(smokeTargetProject);
                        if (!SessionsForProject(smokeTargetProject.Id).Contains(originalSession))
                            Environment.ExitCode = 17;
                    }
                }
            }
            else
            {
                _restoredProjects.Add(smokeTargetProject.Id);
                var paneText = Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_PANES");
                var paneCount = int.TryParse(paneText, out var requested)
                    ? Math.Clamp(requested, 1, MaximumSessions)
                    : 1;
                for (var index = 0; index < paneCount; index++)
                {
                    var fileNotificationThreadId = string.Equals(
                        Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_FILE_NOTIFICATION"),
                        "1",
                        StringComparison.Ordinal) && index == 0
                        ? Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_NOTIFICATION_THREAD") ??
                          "11111111-1111-1111-1111-111111111111"
                        : null;
                    var state = new SavedTerminalState
                    {
                        Name = $"PowerShell {index + 1}",
                        StartDirectory = smokeTargetProject.FolderPath,
                        CodexThreadId = fileNotificationThreadId,
                    };
                    AddPowerShell(smokeTargetProject, state, persistState: false, resumeSavedCli: false, focus: false);
                }
            }
            if (!string.IsNullOrWhiteSpace(projectSmokeFolder) &&
                SessionsForProject(smokeTargetProject.Id)
                    .Any(session => !SamePath(session.StartDirectory, projectSmokeFolder)))
                Environment.ExitCode = 10;
            var smokeAddText = Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_ADD_COUNT");
            var smokeAddCount = int.TryParse(smokeAddText, out var requestedAdds)
                ? Math.Clamp(requestedAdds, 0, MaximumSessions - 1)
                : string.Equals(
                    Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_ADD_AFTER_START"),
                    "1",
                    StringComparison.Ordinal)
                    ? 1
                    : 0;
            if (smokeAddCount > 0 && string.Equals(
                    Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_MAXIMIZE_BEFORE_ADD"),
                    "1",
                    StringComparison.Ordinal))
            {
                _maximizedSession = SessionsForProject(smokeTargetProject.Id).FirstOrDefault();
                RebuildLayout();
            }
            for (var addIndex = 0; addIndex < smokeAddCount; addIndex++)
            {
                var countBeforeAdd = SessionsForProject(smokeTargetProject.Id).Count;
                AddPowerShellInSelectedProject();
                if (SessionsForProject(smokeTargetProject.Id).Count != countBeforeAdd + 1)
                {
                    Environment.ExitCode = 19;
                    break;
                }
            }
            if (smokeAddCount > 0 &&
                (_maximizedSession is not null ||
                 _workspace.Children.Count != SessionsForProject(smokeTargetProject.Id).Count))
                Environment.ExitCode = 19;
        }
        else if (_selectedProject is not null)
        {
            ActivateProject(_selectedProject);
        }

        if (_smokeTest && string.Equals(
                Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_ADD_ONLY"),
                "1",
                StringComparison.Ordinal))
        {
            var addDeadline = DateTime.UtcNow.AddSeconds(15);
            while (_sessions.Any(session => !session.Terminal.IsReady) && DateTime.UtcNow < addDeadline)
                await Task.Delay(100);
            if (_sessions.Any(session => !session.Terminal.IsReady)) Environment.ExitCode = 2;
            if (_sessions.Any(session => session.Terminal.StartupError is not null))
            {
                TracePowerShellAdd("smoke-startup-error " + string.Join(" | ",
                    _sessions.Select(session => session.Terminal.StartupError)));
                Environment.ExitCode = 3;
            }
            var visibilityDeadline = DateTime.UtcNow.AddSeconds(2);
            while (_sessions.Any(session => !session.Terminal.IsConsoleWindowVisible) &&
                   DateTime.UtcNow < visibilityDeadline)
                await Task.Delay(50);
            if (_sessions.Any(session => !session.Terminal.IsConsoleWindowVisible))
                Environment.ExitCode = 22;
            if (!VerifyPaneWidthResizeForSmoke()) Environment.ExitCode = 21;
            if (!VerifyPaneWidthSnapForSmoke()) Environment.ExitCode = 23;
            if (int.TryParse(
                    Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_HOLD_MS"),
                    out var smokeHoldMilliseconds) && smokeHoldMilliseconds > 0)
                await Task.Delay(Math.Clamp(smokeHoldMilliseconds, 1, 10000));
            Close();
            return;
        }

        _usageTimer.Start();
        await RefreshUsageAsync();
        if (!_smokeTest) return;

        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (_sessions.Any(session => !session.Terminal.IsReady) && DateTime.UtcNow < deadline)
            await Task.Delay(100);
        if (_sessions.Any(session => !session.Terminal.IsReady)) Environment.ExitCode = 2;
        if (!IntegratedPowerShellHost.TestImagePasteRoutingForSmoke()) Environment.ExitCode = 27;
        if (_sessions.Any(session => session.Terminal.StartupError is not null))
        {
            TracePowerShellAdd("smoke-startup-error " + string.Join(" | ",
                _sessions.Select(session => session.Terminal.StartupError)));
            Environment.ExitCode = 3;
        }
        var notificationTestSession = _activeSession ?? SelectedProjectSessions().FirstOrDefault();
        if (notificationTestSession is not null && _windowSource is not null)
        {
            var executablePath = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(executablePath))
            {
                Environment.ExitCode = 5;
            }
            else
            {
                var smokeNotificationThreadId =
                    Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_NOTIFICATION_THREAD") ??
                    "11111111-1111-1111-1111-111111111111";
                var useFileNotification = string.Equals(
                    Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_FILE_NOTIFICATION"),
                    "1",
                    StringComparison.Ordinal);
                if (useFileNotification)
                {
                    var codexHome = Environment.GetEnvironmentVariable("CODEX_HOME") ??
                                    Path.Combine(
                                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                                        ".codex");
                    var smokeSessionFolder = Path.Combine(codexHome, "sessions", "smoke");
                    Directory.CreateDirectory(smokeSessionFolder);
                    var smokeSessionPath = Path.Combine(
                        smokeSessionFolder,
                        $"rollout-smoke-{smokeNotificationThreadId}.jsonl");
                    File.WriteAllText(
                        smokeSessionPath,
                        JsonSerializer.Serialize(new
                        {
                            timestamp = DateTimeOffset.UtcNow,
                            type = "session_meta",
                            payload = new
                            {
                                id = smokeNotificationThreadId,
                                cwd = notificationTestSession.StartDirectory,
                                source = "cli",
                            },
                        }) + Environment.NewLine);
                    await Task.Delay(100);
                    File.AppendAllText(
                        smokeSessionPath,
                        JsonSerializer.Serialize(new
                        {
                            timestamp = DateTimeOffset.UtcNow,
                            type = "event_msg",
                            payload = new { type = "task_complete" },
                        }) + Environment.NewLine);
                }
                else
                {
                    var notifierInfo = new ProcessStartInfo
                    {
                        FileName = executablePath,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                    };
                    notifierInfo.ArgumentList.Add(NotificationBridge.NotifyArgument);
                    notifierInfo.ArgumentList.Add(
                        JsonSerializer.Serialize(new Dictionary<string, string>
                        {
                            ["type"] = "agent-turn-complete",
                            ["thread-id"] = smokeNotificationThreadId,
                        }));
                    notifierInfo.Environment["POWERWORKSPACE_NOTIFY_HWND"] =
                        _windowSource.Handle.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
                    notifierInfo.Environment["POWERWORKSPACE_SESSION_ID"] =
                        notificationTestSession.Terminal.NotificationId;
                    using var notifierProcess = Process.Start(notifierInfo);
                    if (notifierProcess is null || !notifierProcess.WaitForExit(3000)) Environment.ExitCode = 5;
                }
            }
            var signalDeadline = DateTime.UtcNow.AddSeconds(2);
            while (!notificationTestSession.CompletionSignalPending &&
                   !notificationTestSession.CompletionPending &&
                   DateTime.UtcNow < signalDeadline)
                await Task.Delay(25);
            var expectNotificationIgnored = string.Equals(
                Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_EXPECT_NOTIFICATION_IGNORED"),
                "1",
                StringComparison.Ordinal);
            if (expectNotificationIgnored)
            {
                var expectedCurrentThreadId =
                    Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_EXPECT_THREAD");
                if (notificationTestSession.CompletionSignalPending ||
                    notificationTestSession.CompletionPending ||
                    notificationTestSession.State.CompletionPending ||
                    (!string.IsNullOrWhiteSpace(expectedCurrentThreadId) &&
                     !string.Equals(
                         notificationTestSession.State.CodexThreadId,
                         expectedCurrentThreadId,
                         StringComparison.OrdinalIgnoreCase)))
                    Environment.ExitCode = 24;
            }
            else
            {
                if (!notificationTestSession.CompletionSignalPending ||
                    notificationTestSession.CompletionPending ||
                    notificationTestSession.State.CompletionPending)
                    Environment.ExitCode = 6;
                AcknowledgeCompletion(notificationTestSession);
                if (!notificationTestSession.CompletionSignalPending)
                    Environment.ExitCode = 25;
                var completionDeadline = DateTime.UtcNow.AddSeconds(4);
                while (!notificationTestSession.CompletionPending && DateTime.UtcNow < completionDeadline)
                    await Task.Delay(50);
                if (!notificationTestSession.CompletionPending ||
                    !notificationTestSession.State.CompletionPending)
                    Environment.ExitCode = 6;
                var expectedNotificationThreadId =
                    Environment.GetEnvironmentVariable("POWERWORKSPACE_SMOKE_NOTIFICATION_THREAD") ??
                    "11111111-1111-1111-1111-111111111111";
                if (!string.Equals(
                        notificationTestSession.State.CodexThreadId,
                        expectedNotificationThreadId,
                        StringComparison.Ordinal))
                    Environment.ExitCode = 12;
                AcknowledgeCompletion(notificationTestSession);
                if (notificationTestSession.CompletionPending ||
                    notificationTestSession.State.CompletionPending ||
                    notificationTestSession.Panel.Effect is not null)
                    Environment.ExitCode = 7;
            }
        }
        if (!_smokeVisible && _activeSession is not null)
        {
            _activeSession.BeginRename();
            await Task.Delay(100);
            _activeSession.FinishRename(false);
            await Task.Delay(100);
        }
        if (_smokeVisible && _activeSession is not null)
        {
            if (!_activeSession.Terminal.TestKeyboardInputForSmoke()) Environment.ExitCode = 4;
        }
        Close();
    }

    private UIElement BuildToolbar()
    {
        var addButton = ToolbarButton("＋  PowerShell", BlueBrush);
        addButton.Click += (_, _) => AddPowerShellInSelectedProject();

        var left = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(16, 0, 0, 0),
        };
        left.Children.Add(Spaced(addButton, 0, 16));
        left.Children.Add(Spaced(Text("CURRENT", 9, MutedBrush, FontWeights.SemiBold), 0, 8));
        left.Children.Add(_activeProjectLabel);

        var right = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 16, 0),
        };
        right.Children.Add(Spaced(Text("Ctrl+Shift+T  추가   Ctrl+Shift+W  닫기   Alt+Enter  확대", 10, MutedBrush), 0, 16));
        right.Children.Add(_sessionCount);

        var grid = new Grid { Background = HeaderBrush };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(left);
        Grid.SetColumn(right, 2);
        grid.Children.Add(right);

        return new Border
        {
            Background = HeaderBrush,
            BorderBrush = PanelBorderBrush,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = grid,
        };
    }

    private UIElement BuildProjectSidebar()
    {
        var brand = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(16, 0, 12, 0),
        };
        var brandMarkText = Text("IH", 10, BackgroundBrush, FontWeights.Bold);
        brandMarkText.HorizontalAlignment = HorizontalAlignment.Center;
        brand.Children.Add(Spaced(new Border
        {
            Width = 27,
            Height = 27,
            Background = TextBrush,
            CornerRadius = new CornerRadius(5),
            Child = brandMarkText,
        }, 0, 10));
        var brandCopy = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        brandCopy.Children.Add(Text("IHATECODING", 13, TextBrush, FontWeights.Bold));
        var brandCaption = Text("TERMINAL WORKSPACE", 8, MutedBrush, FontWeights.SemiBold);
        brandCaption.Margin = new Thickness(0, 1, 0, 0);
        brandCopy.Children.Add(brandCaption);
        brand.Children.Add(brandCopy);

        var sectionTitle = Text("프로젝트", 12, TextBrush, FontWeights.SemiBold);
        var sectionHeader = new Grid { Margin = new Thickness(12, 0, 12, 0) };
        sectionHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3) });
        sectionHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        sectionHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        sectionHeader.Children.Add(new Border
        {
            Width = 3,
            Height = 18,
            CornerRadius = new CornerRadius(2),
            Background = BlueBrush,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center,
        });
        Grid.SetColumn(sectionTitle, 1);
        sectionTitle.Margin = new Thickness(9, 0, 0, 0);
        sectionHeader.Children.Add(sectionTitle);
        Grid.SetColumn(_projectCountLabel, 2);
        sectionHeader.Children.Add(_projectCountLabel);

        _projectList.SelectionChanged += OnProjectSelectionChanged;
        _projectList.Resources[SystemColors.HighlightBrushKey] = SelectedSurfaceBrush;
        _projectList.Resources[SystemColors.HighlightTextBrushKey] = TextBrush;
        _projectList.Resources[SystemColors.InactiveSelectionHighlightBrushKey] = SelectedSurfaceBrush;
        _projectList.Resources[SystemColors.InactiveSelectionHighlightTextBrushKey] = TextBrush;
        ScrollViewer.SetHorizontalScrollBarVisibility(_projectList, ScrollBarVisibility.Disabled);
        ScrollViewer.SetVerticalScrollBarVisibility(_projectList, ScrollBarVisibility.Auto);

        var createButton = ToolbarButton("＋ 새 프로젝트", SurfaceBrush);
        createButton.HorizontalAlignment = HorizontalAlignment.Stretch;
        createButton.Margin = new Thickness(14, 9, 14, 12);
        createButton.Click += (_, _) => CreateProject();

        var layout = new Grid { Background = SurfaceBrush };
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(56) });
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(44) });
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(58) });
        layout.Children.Add(brand);
        Grid.SetRow(sectionHeader, 1);
        layout.Children.Add(sectionHeader);
        Grid.SetRow(_projectList, 2);
        layout.Children.Add(_projectList);
        Grid.SetRow(createButton, 3);
        layout.Children.Add(createButton);

        return new Border
        {
            Background = SurfaceBrush,
            BorderBrush = PanelBorderBrush,
            BorderThickness = new Thickness(0, 0, 1, 0),
            Child = layout,
        };
    }

    private void LoadProjects()
    {
        var catalog = ProjectStore.Load();
        var changed = CodexSessionLocator.RepairSubagentTerminalAssociations(catalog.Projects);
        changed |= CodexSessionLocator.RepairDuplicateTerminalAssociations(catalog.Projects);
        if (!_smokeTest)
        {
            changed |= CodexSessionLocator.BackfillLegacyTerminals(catalog.Projects);
            changed |= GrokSessionLocator.BackfillLegacyTerminals(catalog.Projects);
        }
        if (changed) _ = ProjectStore.Save(catalog.Projects, catalog.SelectedProjectId);
        _projects.Clear();
        _projects.AddRange(catalog.Projects);
        _selectedProject = _projects.FirstOrDefault(project =>
            string.Equals(project.Id, catalog.SelectedProjectId, StringComparison.Ordinal)) ??
            _projects.FirstOrDefault();
        RefreshProjectList();
    }

    private bool CreateProject()
    {
        var dialog = new ProjectDialog(_selectedProject?.FolderPath)
        {
            Owner = this,
        };
        if (dialog.ShowDialog() != true) return false;

        var existingProject = _projects.FirstOrDefault(project =>
            SamePath(project.FolderPath, dialog.ProjectFolder));
        if (existingProject is not null)
        {
            _selectedProject = existingProject;
            RefreshProjectList();
            ActivateProject(existingProject);
            return true;
        }

        var project = new WorkspaceProject
        {
            Name = UniqueProjectName(dialog.ProjectName),
            FolderPath = dialog.ProjectFolder,
        };
        _projects.Add(project);
        _selectedProject = project;
        RefreshProjectList();
        if (!ProjectStore.Save(_projects, project.Id))
        {
            MessageBox.Show(
                this,
                "프로젝트를 만들었지만 목록을 저장하지 못했습니다.",
                "프로젝트",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
        ActivateProject(project);
        return true;
    }

    private void OnProjectSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressProjectSelection ||
            _projectList.SelectedItem is not ListBoxItem { Tag: WorkspaceProject project }) return;
        ActivateProject(project);
    }

    private void ActivateProject(WorkspaceProject project)
    {
        ClearActiveSessionSelection();
        _selectedProject = project;
        _maximizedSession = null;
        EnsureProjectSessionsStarted(project);
        UpdateActiveProjectLabel();
        SaveProjectSelection();
        RebuildLayout();
        foreach (var session in SelectedProjectSessions()) UpdateSessionAppearance(session);
    }

    private void EnsureProjectSessionsStarted(WorkspaceProject project)
    {
        if (!_restoredProjects.Add(project.Id)) return;
        foreach (var state in project.Terminals.Take(MaximumSessions))
            AddPowerShell(
                project,
                state,
                persistState: true,
                resumeSavedCli: true,
                focus: false,
                rebuildLayout: false);
    }

    private List<TerminalSession> SessionsForProject(string projectId) =>
        _sessions.Where(session => string.Equals(session.ProjectId, projectId, StringComparison.Ordinal)).ToList();

    private List<TerminalSession> SelectedProjectSessions() =>
        _selectedProject is null ? [] : SessionsForProject(_selectedProject.Id);

    private void RefreshProjectList()
    {
        _suppressProjectSelection = true;
        _projectList.Items.Clear();
        _projectAlertBadges.Clear();
        ListBoxItem? selectedItem = null;
        foreach (var project in _projects)
        {
            var name = Text(project.Name, 11, TextBrush, FontWeights.SemiBold);
            name.TextTrimming = TextTrimming.CharacterEllipsis;
            var path = Text(project.FolderPath, 9, MutedBrush);
            path.Margin = new Thickness(0, 3, 0, 0);
            path.TextTrimming = TextTrimming.CharacterEllipsis;
            path.ToolTip = project.FolderPath;
            var details = new StackPanel();
            details.Children.Add(name);
            details.Children.Add(path);

            var alertLabel = Text(string.Empty, 10, CompletionBrush, FontWeights.Bold);
            alertLabel.HorizontalAlignment = HorizontalAlignment.Center;
            var alertBadge = new Border
            {
                MinWidth = 20,
                Height = 20,
                Margin = new Thickness(7, 0, 0, 0),
                Padding = new Thickness(4, 0, 4, 0),
                Background = Brush("#3B3015"),
                BorderBrush = CompletionBrush,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                VerticalAlignment = VerticalAlignment.Center,
                Visibility = Visibility.Collapsed,
                Child = alertLabel,
            };
            _projectAlertBadges[project.Id] = alertBadge;

            var content = new Grid();
            content.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            content.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            content.Children.Add(details);
            Grid.SetColumn(alertBadge, 1);
            content.Children.Add(alertBadge);

            var item = new ListBoxItem
            {
                Tag = project,
                Content = content,
                MinHeight = 54,
                Padding = new Thickness(11, 7, 9, 7),
                Margin = new Thickness(7, 3, 7, 3),
                Background = Brushes.Transparent,
                Foreground = TextBrush,
                BorderBrush = PanelBorderBrush,
                BorderThickness = new Thickness(1),
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
                Cursor = Cursors.Hand,
                ToolTip = project.FolderPath,
            };
            item.Selected += (_, _) =>
            {
                item.Background = SelectedSurfaceBrush;
                item.BorderBrush = ActiveBorderBrush;
            };
            item.Unselected += (_, _) =>
            {
                item.Background = Brushes.Transparent;
                item.BorderBrush = PanelBorderBrush;
            };
            _projectList.Items.Add(item);
            UpdateProjectAlertBadge(project);
            if (ReferenceEquals(project, _selectedProject)) selectedItem = item;
        }
        _projectList.SelectedItem = selectedItem;
        _projectCountLabel.Text = _projects.Count.ToString();
        UpdateActiveProjectLabel();
        _suppressProjectSelection = false;
    }

    private void UpdateActiveProjectLabel()
    {
        _activeProjectLabel.Text = _selectedProject?.Name ?? "프로젝트를 선택하세요";
        _activeProjectLabel.Foreground = _selectedProject is null ? MutedBrush : TextBrush;
        _activeProjectLabel.ToolTip = _selectedProject?.FolderPath ?? "왼쪽에서 프로젝트를 선택하세요.";
    }

    private void SaveProjectSelection() =>
        _ = ProjectStore.Save(_projects, _selectedProject?.Id);

    private void UpdateProjectAlertBadge(WorkspaceProject project)
    {
        if (!_projectAlertBadges.TryGetValue(project.Id, out var badge) ||
            badge.Child is not TextBlock label) return;
        var alertCount = project.Terminals.Count(terminal => terminal.CompletionPending);
        label.Text = alertCount.ToString();
        badge.ToolTip = $"미확인 작업 완료 알림 {alertCount}개";
        badge.Visibility = alertCount > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private string UniqueProjectName(string requestedName)
    {
        if (_projects.All(project => !string.Equals(project.Name, requestedName, StringComparison.CurrentCultureIgnoreCase)))
            return requestedName;

        for (var suffix = 2; ; suffix++)
        {
            var candidate = $"{requestedName} ({suffix})";
            if (_projects.All(project => !string.Equals(project.Name, candidate, StringComparison.CurrentCultureIgnoreCase)))
                return candidate;
        }
    }

    private void AddPowerShellInSelectedProject()
    {
        TracePowerShellAdd(
            $"request selected={_selectedProject?.Id ?? "null"} " +
            $"sessions={(_selectedProject is null ? -1 : SessionsForProject(_selectedProject.Id).Count)}");
        if (_selectedProject is null && !CreateProject()) return;
        if (_selectedProject is null) return;
        if (!Directory.Exists(_selectedProject.FolderPath))
        {
            MessageBox.Show(
                this,
                $"프로젝트 폴더를 찾을 수 없습니다.\n{_selectedProject.FolderPath}",
                "프로젝트",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            return;
        }
        EnsureProjectSessionsStarted(_selectedProject);
        TracePowerShellAdd(
            $"after-restore project={_selectedProject.Id} " +
            $"sessions={SessionsForProject(_selectedProject.Id).Count} saved={_selectedProject.Terminals.Count}");
        if (SessionsForProject(_selectedProject.Id).Count >= MaximumSessions)
        {
            TracePowerShellAdd("blocked maximum-sessions");
            System.Media.SystemSounds.Beep.Play();
            return;
        }

        var terminalNumber = 1;
        while (_selectedProject.Terminals.Any(state =>
                   string.Equals(state.Name, $"PowerShell {terminalNumber}", StringComparison.CurrentCultureIgnoreCase)))
            terminalNumber++;
        var state = new SavedTerminalState
        {
            Name = $"PowerShell {terminalNumber}",
            StartDirectory = _selectedProject.FolderPath,
            CreatedAtUtc = DateTimeOffset.UtcNow,
        };
        _maximizedSession = null;
        TracePowerShellAdd($"creating name={state.Name}");
        AddPowerShell(_selectedProject, state, persistState: true, resumeSavedCli: false, focus: true);
    }

    private void AddPowerShell(
        WorkspaceProject project,
        SavedTerminalState state,
        bool persistState,
        bool resumeSavedCli,
        bool focus,
        bool rebuildLayout = true)
    {
        TracePowerShellAdd(
            $"add-enter project={project.Id} sessions={SessionsForProject(project.Id).Count} name={state.Name}");
        if (SessionsForProject(project.Id).Count >= MaximumSessions)
        {
            System.Media.SystemSounds.Beep.Play();
            return;
        }
        var startDirectory = string.IsNullOrWhiteSpace(state.StartDirectory)
            ? project.FolderPath
            : state.StartDirectory;
        if (!Directory.Exists(startDirectory)) startDirectory = Environment.CurrentDirectory;
        state.StartDirectory = startDirectory;

        var resumeCodexThreadId = resumeSavedCli ? state.CodexThreadId : null;
        var resumeGrokSessionId = resumeSavedCli ? state.GrokSessionId : null;
        var duplicateAssociationRemoved = false;
        if (resumeCodexThreadId is not null && _sessions.Any(session =>
                string.Equals(
                    session.Terminal.ResumeThreadId,
                    resumeCodexThreadId,
                    StringComparison.OrdinalIgnoreCase)))
        {
            state.CodexThreadId = null;
            resumeCodexThreadId = null;
            duplicateAssociationRemoved = true;
        }
        if (resumeGrokSessionId is not null && _sessions.Any(session =>
                string.Equals(
                    session.Terminal.ResumeGrokSessionId,
                    resumeGrokSessionId,
                    StringComparison.OrdinalIgnoreCase)))
        {
            state.GrokSessionId = null;
            resumeGrokSessionId = null;
            duplicateAssociationRemoved = true;
        }
        if (duplicateAssociationRemoved && persistState) SaveProjectSelection();

        var number = _nextNumber++;
        var terminal = new IntegratedPowerShellHost(
            startDirectory,
            _windowSource?.Handle ?? new WindowInteropHelper(this).Handle,
            resumeCodexThreadId,
            resumeGrokSessionId)
        {
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
        };

        var title = Text(state.Name, 11, TextBrush, FontWeights.SemiBold);
        title.MaxWidth = 180;
        title.TextTrimming = TextTrimming.CharacterEllipsis;
        title.ToolTip = "더블클릭하면 이름을 바꿀 수 있습니다.";
        var titleEditor = new TextBox
        {
            Width = 180,
            Height = 26,
            MaxLength = 40,
            Visibility = Visibility.Collapsed,
            VerticalContentAlignment = VerticalAlignment.Center,
            Padding = new Thickness(7, 0, 7, 0),
            FontSize = 11,
            Background = SurfaceBrush,
            Foreground = TextBrush,
            BorderBrush = ActiveBorderBrush,
            BorderThickness = new Thickness(1),
        };
        var titleHost = new Grid { VerticalAlignment = VerticalAlignment.Center };
        titleHost.Children.Add(title);
        titleHost.Children.Add(titleEditor);
        var renaming = false;

        void BeginRename()
        {
            if (renaming) return;
            renaming = true;
            titleEditor.Text = title.Text;
            title.Visibility = Visibility.Collapsed;
            titleEditor.Visibility = Visibility.Visible;
            titleEditor.Focus();
            titleEditor.SelectAll();
        }

        void FinishRename(bool save)
        {
            if (!renaming) return;
            renaming = false;
            var renamed = titleEditor.Text.Trim();
            if (save && renamed.Length > 0)
            {
                title.Text = renamed;
                state.Name = renamed;
                if (persistState) SaveProjectSelection();
            }
            titleEditor.Visibility = Visibility.Collapsed;
            title.Visibility = Visibility.Visible;
            Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, terminal.FocusConsole);
        }

        titleEditor.KeyDown += (_, args) =>
        {
            if (args.Key == Key.Enter)
            {
                FinishRename(save: true);
                args.Handled = true;
            }
            else if (args.Key == Key.Escape)
            {
                FinishRename(save: false);
                args.Handled = true;
            }
        };
        titleEditor.LostKeyboardFocus += (_, _) => FinishRename(save: true);
        var pathLabel = Text(ShortPath(startDirectory), 10, MutedBrush);
        pathLabel.TextTrimming = TextTrimming.CharacterEllipsis;
        pathLabel.ToolTip = startDirectory;

        var maximizeButton = PanelButton("□", "이 PowerShell만 크게 보기");
        var closeButton = PanelButton("×", "PowerShell 닫기");
        var headerGrid = new Grid { Height = 34, Background = HeaderBrush };
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(34) });
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) });
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) });

        var icon = Text("›", 16, TextBrush, FontWeights.SemiBold);
        icon.HorizontalAlignment = HorizontalAlignment.Center;
        headerGrid.Children.Add(icon);
        Grid.SetColumn(titleHost, 1);
        headerGrid.Children.Add(titleHost);
        Grid.SetColumn(pathLabel, 2);
        pathLabel.Margin = new Thickness(9, 0, 9, 0);
        headerGrid.Children.Add(pathLabel);
        Grid.SetColumn(maximizeButton, 3);
        headerGrid.Children.Add(maximizeButton);
        Grid.SetColumn(closeButton, 4);
        headerGrid.Children.Add(closeButton);

        var panelGrid = new Grid();
        panelGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(34) });
        panelGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        panelGrid.Children.Add(new Border
        {
            Background = HeaderBrush,
            BorderBrush = PanelBorderBrush,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = headerGrid,
        });
        Grid.SetRow(terminal, 1);
        panelGrid.Children.Add(terminal);

        var panelShell = new Grid { Background = SurfaceBrush };
        panelShell.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(6) });
        panelShell.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        panelShell.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(6) });
        Grid.SetColumn(panelGrid, 1);
        panelShell.Children.Add(panelGrid);

        var leftResizeThumb = PaneResizeThumb();
        var rightResizeThumb = PaneResizeThumb();
        Grid.SetColumn(leftResizeThumb, 0);
        Grid.SetColumn(rightResizeThumb, 2);
        Panel.SetZIndex(leftResizeThumb, 1000);
        Panel.SetZIndex(rightResizeThumb, 1000);
        panelShell.Children.Add(leftResizeThumb);
        panelShell.Children.Add(rightResizeThumb);

        var panel = new Border
        {
            Background = SurfaceBrush,
            BorderBrush = PanelBorderBrush,
            BorderThickness = new Thickness(2),
            CornerRadius = new CornerRadius(5),
            Margin = new Thickness(5),
            Child = panelShell,
        };
        var session = new TerminalSession
        {
            Number = number,
            ProjectId = project.Id,
            StartDirectory = startDirectory,
            State = state,
            PersistState = persistState,
            Terminal = terminal,
            Panel = panel,
            LeftResizeThumb = leftResizeThumb,
            RightResizeThumb = rightResizeThumb,
            BeginRename = BeginRename,
            FinishRename = FinishRename,
            CompletionEffect = new DropShadowEffect
            {
                Color = (Color)ColorConverter.ConvertFromString("#F4C95D"),
                BlurRadius = 18,
                ShadowDepth = 0,
                Opacity = 0.9,
                RenderingBias = RenderingBias.Performance,
            },
            CompletionPending = state.CompletionPending,
        };

        if (persistState && project.Terminals.All(item =>
                !string.Equals(item.Id, state.Id, StringComparison.Ordinal)))
        {
            project.Terminals.Add(state);
            SaveProjectSelection();
        }
        _sessions.Add(session);
        _codexCompletionWatcher.TrackThread(state.CodexThreadId);
        TracePowerShellAdd($"add-complete project={project.Id} sessions={SessionsForProject(project.Id).Count}");
        if (session.CompletionPending && !_completionTimer.IsEnabled) _completionTimer.Start();
        terminal.Activated += (_, _) =>
        {
            if (!session.Closing && _sessions.Contains(session))
            {
                SetActive(session);
            }
        };
        terminal.UserInput += (_, _) =>
        {
            if (!session.Closing && _sessions.Contains(session))
            {
                SetActive(session);
            }
        };
        terminal.PointerDown += (_, _) =>
        {
            if (!session.Closing && _sessions.Contains(session))
            {
                AcknowledgeCompletion(session);
                SetActive(session);
            }
        };
        terminal.Exited += (_, _) =>
        {
            if (!session.Closing) CloseSession(session);
        };
        terminal.GotKeyboardFocus += (_, _) =>
        {
            SetActive(session);
        };
        panel.PreviewMouseDown += (_, _) =>
        {
            AcknowledgeCompletion(session);
            SetActive(session);
        };
        headerGrid.PreviewMouseLeftButtonDown += (_, args) =>
            BeginSessionDrag(session, headerGrid, args);
        headerGrid.PreviewMouseMove += (_, args) =>
            ContinueSessionDrag(session, headerGrid, args);
        headerGrid.PreviewMouseLeftButtonUp += (_, args) =>
            EndSessionDrag(session, args);
        headerGrid.LostMouseCapture += (_, _) =>
        {
            if (ReferenceEquals(_draggedSession, session)) CancelSessionDrag();
        };
        leftResizeThumb.DragStarted += (_, _) =>
        {
            AcknowledgeCompletion(session);
            SetActive(session);
            BeginPaneResize(session, resizeFromLeft: true);
        };
        leftResizeThumb.DragDelta += (_, args) =>
            ResizePaneWidth(session, resizeFromLeft: true, args.HorizontalChange);
        leftResizeThumb.DragCompleted += (_, _) => CompletePaneResize(session);
        rightResizeThumb.DragStarted += (_, _) =>
        {
            AcknowledgeCompletion(session);
            SetActive(session);
            BeginPaneResize(session, resizeFromLeft: false);
        };
        rightResizeThumb.DragDelta += (_, args) =>
            ResizePaneWidth(session, resizeFromLeft: false, args.HorizontalChange);
        rightResizeThumb.DragCompleted += (_, _) => CompletePaneResize(session);
        titleHost.MouseLeftButtonDown += (_, args) =>
        {
            AcknowledgeCompletion(session);
            SetActive(session);
            if (args.ClickCount != 2) return;
            BeginRename();
            args.Handled = true;
        };
        maximizeButton.Click += (_, _) => ToggleMaximize(session);
        closeButton.Click += (_, _) => CloseSession(session);

        if (focus) SetActive(session);
        else UpdateSessionAppearance(session);
        if (rebuildLayout) RebuildLayout();
        if (focus) Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, terminal.FocusConsole);
    }

    private void BeginSessionDrag(
        TerminalSession session,
        FrameworkElement header,
        MouseButtonEventArgs args)
    {
        if (args.ClickCount != 1 ||
            args.LeftButton != MouseButtonState.Pressed ||
            _maximizedSession is not null ||
            SelectedProjectSessions().Count < 2 ||
            IsDragControl(args.OriginalSource as DependencyObject)) return;

        ResetPaneResizeState();
        CancelSessionDrag();
        if (!GetCursorPos(out var cursor)) return;
        var originalOrder = SelectedProjectSessions();
        var slots = CaptureDragSlots(originalOrder);
        var sourceSlotIndex = originalOrder.IndexOf(session);
        if (sourceSlotIndex < 0 || slots.Count != originalOrder.Count || !header.CaptureMouse()) return;

        _draggedSession = session;
        _dragCaptureElement = header;
        _dragOriginalOrder = originalOrder;
        _dragPreviewOrder = originalOrder.ToList();
        _dragSlots = slots;
        _dragHasValidDrop = false;
        _dragStartScreen = new Point(cursor.X, cursor.Y);
        _dragLastAcceptedScreen = _dragStartScreen;
        _dragLastAcceptedVector = default;
        _dragCandidateSinceUtc = DateTime.UtcNow;
        _dragSourceSlotIndex = sourceSlotIndex;
        _dragAcceptedSlotIndex = sourceSlotIndex;
        _dragCandidateSlotIndex = sourceSlotIndex;
        _dragPreviousAcceptedSlotIndex = -1;
    }

    private void ContinueSessionDrag(
        TerminalSession session,
        FrameworkElement header,
        MouseEventArgs args)
    {
        if (!ReferenceEquals(_draggedSession, session)) return;
        if (args.LeftButton != MouseButtonState.Pressed)
        {
            CancelSessionDrag();
            return;
        }
        if (!GetCursorPos(out var cursor)) return;

        if (!_isSessionDragging)
        {
            var movedX = Math.Abs(cursor.X - _dragStartScreen.X);
            var movedY = Math.Abs(cursor.Y - _dragStartScreen.Y);
            if (movedX < DragStartDistance && movedY < DragStartDistance) return;
            _isSessionDragging = true;
            session.FinishRename(false);
            session.Panel.Opacity = 0.82;
            session.Panel.BorderThickness = new Thickness(3);
            session.Panel.RenderTransform = new TranslateTransform();
            Panel.SetZIndex(session.Panel, 900);
            header.Cursor = Cursors.SizeAll;
        }

        MoveDraggedSession(cursor.X, cursor.Y);
        UpdateSessionDragPosition(cursor.X, cursor.Y);
        args.Handled = true;
    }

    private void EndSessionDrag(TerminalSession session, MouseButtonEventArgs args)
    {
        if (!ReferenceEquals(_draggedSession, session)) return;
        var commit = _isSessionDragging;
        if (commit && GetCursorPos(out var cursor))
        {
            MoveDraggedSession(cursor.X, cursor.Y);
            UpdateSessionDragPosition(cursor.X, cursor.Y, forceCandidate: true);
        }
        CompleteSessionDrag(commit);
        if (commit) args.Handled = true;
    }

    private void CancelSessionDrag() => CompleteSessionDrag(commit: false);

    private void CompleteSessionDrag(bool commit)
    {
        var source = _draggedSession;
        var capture = _dragCaptureElement;
        var originalOrder = _dragOriginalOrder;
        var previewOrder = _dragPreviewOrder;
        var wasDragging = _isSessionDragging;
        var validDrop = _dragHasValidDrop;

        _draggedSession = null;
        _dragCaptureElement = null;
        _dragOriginalOrder = null;
        _dragPreviewOrder = null;
        _dragSlots = null;
        _isSessionDragging = false;
        _dragHasValidDrop = false;
        _dragSourceSlotIndex = -1;
        _dragAcceptedSlotIndex = -1;
        _dragCandidateSlotIndex = -1;
        _dragPreviousAcceptedSlotIndex = -1;
        _dragLastAcceptedVector = default;

        HideSessionInsertionLine();
        if (source is not null)
        {
            source.Panel.Opacity = 1;
            source.Panel.BorderThickness = new Thickness(2);
            source.Panel.RenderTransform = Transform.Identity;
            Panel.SetZIndex(source.Panel, 0);
        }
        if (capture is not null)
        {
            capture.Cursor = null;
            if (ReferenceEquals(Mouse.Captured, capture)) capture.ReleaseMouseCapture();
        }

        if (!wasDragging || source is null) return;
        if (!commit || !validDrop)
        {
            if (originalOrder is not null) ApplyProjectSessionOrder(originalOrder);
        }
        else
        {
            if (previewOrder is not null) ApplyProjectSessionOrder(previewOrder);
            PersistProjectSessionOrder(source.ProjectId);
        }

        UpdateLiveSessionGridPositions();
        SetActive(source);
        Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, source.Terminal.FocusConsole);
    }

    private void MoveDraggedSession(int x, int y)
    {
        if (_draggedSession?.Panel.RenderTransform is not TranslateTransform translation) return;
        translation.X = x - _dragStartScreen.X;
        translation.Y = y - _dragStartScreen.Y;
        _draggedSession.Terminal.RefreshWindowBounds();
    }

    private void UpdateSessionDragPosition(int x, int y, bool forceCandidate = false)
    {
        var source = _draggedSession;
        var originalOrder = _dragOriginalOrder;
        var slots = _dragSlots;
        if (source is null ||
            originalOrder is null ||
            slots is null ||
            slots.Count != originalOrder.Count ||
            _dragSourceSlotIndex < 0 ||
            _dragAcceptedSlotIndex < 0) return;

        if (!WorkspaceContainsScreenPoint(x, y))
        {
            _dragHasValidDrop = false;
            _dragCandidateSlotIndex = _dragAcceptedSlotIndex;
            _dragCandidateSinceUtc = DateTime.UtcNow;
            HideSessionInsertionLine();
            return;
        }

        _dragHasValidDrop = true;
        var sourceSlot = slots[_dragSourceSlotIndex];
        var draggedCenter = new Point(
            sourceSlot.X + sourceSlot.Width / 2 + x - _dragStartScreen.X,
            sourceSlot.Y + sourceSlot.Height / 2 + y - _dragStartScreen.Y);
        var nearestSlotIndex = ClosestSlotIndex(draggedCenter, slots);
        var now = DateTime.UtcNow;

        // Keep the accepted slot until the dragged pane has clearly crossed the
        // boundary. This Schmitt-trigger style margin prevents edge jitter.
        var acceptedDistance = Distance(draggedCenter, CenterOf(slots[_dragAcceptedSlotIndex]));
        var nearestDistance = Distance(draggedCenter, CenterOf(slots[nearestSlotIndex]));
        if (nearestSlotIndex != _dragAcceptedSlotIndex &&
            nearestDistance + DragSlotHysteresis >= acceptedDistance)
        {
            nearestSlotIndex = _dragAcceptedSlotIndex;
        }

        if (nearestSlotIndex == _dragAcceptedSlotIndex)
        {
            _dragCandidateSlotIndex = nearestSlotIndex;
            _dragCandidateSinceUtc = now;
            ShowAcceptedSlotInsertionLine();
            return;
        }

        if (nearestSlotIndex != _dragCandidateSlotIndex)
        {
            _dragCandidateSlotIndex = nearestSlotIndex;
            _dragCandidateSinceUtc = now;
            if (!forceCandidate)
            {
                ShowAcceptedSlotInsertionLine();
                return;
            }
        }

        var movement = new Vector(
            x - _dragLastAcceptedScreen.X,
            y - _dragLastAcceptedScreen.Y);
        if (movement.Length < DragMinimumReorderDistance ||
            (!forceCandidate && now - _dragCandidateSinceUtc < DragCandidateHoldTime))
        {
            ShowAcceptedSlotInsertionLine();
            return;
        }

        // Do not bounce straight back merely because panes underneath the cursor
        // moved. A deliberate direction change is still accepted immediately.
        if (nearestSlotIndex == _dragPreviousAcceptedSlotIndex &&
            _dragLastAcceptedVector.Length >= DragMinimumReorderDistance &&
            AngleBetween(_dragLastAcceptedVector, movement) < DragBounceBackAngle)
        {
            ShowAcceptedSlotInsertionLine();
            return;
        }

        var previewOrder = BuildDragPreviewOrder(originalOrder, source, nearestSlotIndex);
        _dragPreviewOrder = previewOrder;
        ApplyDragPreviewOrder(previewOrder);
        _dragPreviousAcceptedSlotIndex = _dragAcceptedSlotIndex;
        _dragAcceptedSlotIndex = nearestSlotIndex;
        _dragCandidateSlotIndex = nearestSlotIndex;
        _dragCandidateSinceUtc = now;
        _dragLastAcceptedVector = movement;
        _dragLastAcceptedScreen = new Point(x, y);
        ShowAcceptedSlotInsertionLine();
    }

    private static List<TerminalSession> BuildDragPreviewOrder(
        IReadOnlyList<TerminalSession> originalOrder,
        TerminalSession source,
        int slotIndex)
    {
        var previewOrder = originalOrder
            .Where(session => !ReferenceEquals(session, source))
            .ToList();
        previewOrder.Insert(Math.Clamp(slotIndex, 0, previewOrder.Count), source);
        return previewOrder;
    }

    private static int ClosestSlotIndex(Point point, IReadOnlyList<Rect> slots)
    {
        var closestIndex = 0;
        var closestDistanceSquared = double.MaxValue;
        for (var index = 0; index < slots.Count; index++)
        {
            var center = CenterOf(slots[index]);
            var deltaX = point.X - center.X;
            var deltaY = point.Y - center.Y;
            var distanceSquared = deltaX * deltaX + deltaY * deltaY;
            if (distanceSquared >= closestDistanceSquared) continue;
            closestIndex = index;
            closestDistanceSquared = distanceSquared;
        }
        return closestIndex;
    }

    private static Point CenterOf(Rect rect) =>
        new(rect.X + rect.Width / 2, rect.Y + rect.Height / 2);

    private static double Distance(Point first, Point second)
    {
        var deltaX = first.X - second.X;
        var deltaY = first.Y - second.Y;
        return Math.Sqrt(deltaX * deltaX + deltaY * deltaY);
    }

    private static double AngleBetween(Vector first, Vector second)
    {
        var lengths = first.Length * second.Length;
        if (lengths <= double.Epsilon) return 0;
        var cosine = Math.Clamp(Vector.Multiply(first, second) / lengths, -1, 1);
        return Math.Acos(cosine);
    }

    private static List<Rect> CaptureDragSlots(IReadOnlyList<TerminalSession> order)
    {
        var slots = new List<Rect>(order.Count);
        try
        {
            foreach (var session in order)
            {
                var panel = session.Panel;
                if (!panel.IsVisible || panel.ActualWidth < 1 || panel.ActualHeight < 1) return [];
                var topLeft = panel.PointToScreen(new Point(0, 0));
                slots.Add(new Rect(topLeft.X, topLeft.Y, panel.ActualWidth, panel.ActualHeight));
            }
        }
        catch (InvalidOperationException)
        {
            return [];
        }
        return slots;
    }

    private bool WorkspaceContainsScreenPoint(int x, int y)
    {
        try
        {
            var topLeft = _workspace.PointToScreen(new Point(0, 0));
            var bottomRight = _workspace.PointToScreen(
                new Point(_workspace.ActualWidth, _workspace.ActualHeight));
            return x >= topLeft.X && x < bottomRight.X &&
                   y >= topLeft.Y && y < bottomRight.Y;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private void ApplyProjectSessionOrder(IReadOnlyList<TerminalSession> order)
    {
        if (order.Count == 0) return;
        var projectId = order[0].ProjectId;
        if (order.Any(session =>
                !string.Equals(session.ProjectId, projectId, StringComparison.Ordinal))) return;

        var projectIndices = Enumerable.Range(0, _sessions.Count)
            .Where(index => string.Equals(_sessions[index].ProjectId, projectId, StringComparison.Ordinal))
            .ToArray();
        if (projectIndices.Length != order.Count) return;
        for (var index = 0; index < order.Count; index++)
            _sessions[projectIndices[index]] = order[index];
    }

    private void UpdateLiveSessionGridPositions()
    {
        var visibleSessions = SelectedProjectSessions();
        if (_maximizedSession is not null || visibleSessions.Count == 0) return;
        ApplyWorkspacePanelLayout(visibleSessions);
    }

    private void ScheduleTerminalVisibilityRefresh()
    {
        if (_selectedProject is null) return;
        var projectId = _selectedProject.Id;
        var version = ++_terminalVisibilityRefreshVersion;
        _ = RefreshTerminalVisibilityAsync(projectId, version);
    }

    private async Task RefreshTerminalVisibilityAsync(string projectId, int version)
    {
        await Dispatcher.Yield(DispatcherPriority.ContextIdle);
        foreach (var delay in new[] { 0, 120, 350, 800, 1600 })
        {
            if (delay > 0) await Task.Delay(delay);
            if (version != _terminalVisibilityRefreshVersion ||
                _selectedProject is null ||
                !string.Equals(_selectedProject.Id, projectId, StringComparison.Ordinal)) return;

            UpdateLiveSessionGridPositions();
            var visibleSessions = SelectedProjectSessions();
            if (_maximizedSession is not null)
                visibleSessions = visibleSessions
                    .Where(session => ReferenceEquals(session, _maximizedSession))
                    .ToList();
            foreach (var session in visibleSessions)
                session.Terminal.EnsureWindowVisible();
            if (visibleSessions.All(session => session.Terminal.IsConsoleWindowVisible)) return;
        }
    }

    private void ApplyDragPreviewOrder(IReadOnlyList<TerminalSession> previewOrder)
    {
        if (_maximizedSession is not null || previewOrder.Count == 0) return;
        ApplyWorkspacePanelLayout(previewOrder);
    }

    private void ApplyWorkspacePanelLayout(IReadOnlyList<TerminalSession> order)
    {
        if (order.Count == 0 || _workspace.ActualWidth < 1 || _workspace.ActualHeight < 1) return;

        var (columns, rows) = LayoutFor(order.Count);
        var project = _projects.FirstOrDefault(item =>
            string.Equals(item.Id, order[0].ProjectId, StringComparison.Ordinal));
        var rowHeight = _workspace.ActualHeight / rows;
        var halfGap = PaneGap / 2;

        for (var row = 0; row < rows; row++)
        {
            var firstIndex = row * columns;
            var itemCount = Math.Min(columns, Math.Max(0, order.Count - firstIndex));
            if (itemCount == 0) continue;

            var ratios = GetPaneWidthRatios(project, columns, rows, row);
            var cellLeft = 0d;
            for (var column = 0; column < columns; column++)
            {
                var cellWidth = column == columns - 1
                    ? _workspace.ActualWidth - cellLeft
                    : _workspace.ActualWidth * ratios[column];
                if (column < itemCount)
                {
                    var session = order[firstIndex + column];
                    session.LeftResizeThumb.Visibility = column > 0
                        ? Visibility.Visible
                        : Visibility.Collapsed;
                    session.RightResizeThumb.Visibility = column + 1 < itemCount
                        ? Visibility.Visible
                        : Visibility.Collapsed;

                    if (!_isSessionDragging || !ReferenceEquals(session, _draggedSession))
                    {
                        SetPanelBounds(
                            session.Panel,
                            cellLeft + halfGap,
                            row * rowHeight + halfGap,
                            Math.Max(20, cellWidth - PaneGap),
                            Math.Max(20, rowHeight - PaneGap));
                    }
                }
                cellLeft += cellWidth;
            }
        }
        _workspace.UpdateLayout();
    }

    private static void SetPanelBounds(Border panel, double left, double top, double width, double height)
    {
        Grid.SetColumn(panel, 0);
        Grid.SetRow(panel, 0);
        panel.HorizontalAlignment = HorizontalAlignment.Left;
        panel.VerticalAlignment = VerticalAlignment.Top;
        panel.Margin = new Thickness(left, top, 0, 0);
        panel.Width = width;
        panel.Height = height;
    }

    private static void SetPanelToFillWorkspace(Border panel)
    {
        Grid.SetColumn(panel, 0);
        Grid.SetRow(panel, 0);
        panel.HorizontalAlignment = HorizontalAlignment.Stretch;
        panel.VerticalAlignment = VerticalAlignment.Stretch;
        panel.Margin = new Thickness(5);
        panel.Width = double.NaN;
        panel.Height = double.NaN;
    }

    private static string PaneWidthRatioKey(int columns, int rows, int row) =>
        $"{columns}x{rows}:row-{row}";

    private static List<double> GetPaneWidthRatios(
        WorkspaceProject? project,
        int columns,
        int rows,
        int row)
    {
        var key = PaneWidthRatioKey(columns, rows, row);
        if (project is not null &&
            project.PaneWidthRatios.TryGetValue(key, out var saved) &&
            saved.Count == columns &&
            saved.All(value => double.IsFinite(value) && value > 0))
        {
            var total = saved.Sum();
            if (double.IsFinite(total) && total > 0)
            {
                var normalized = saved.Select(value => value / total).ToList();
                project.PaneWidthRatios[key] = normalized;
                return normalized;
            }
        }

        var equal = Enumerable.Repeat(1d / columns, columns).ToList();
        if (project is not null) project.PaneWidthRatios[key] = equal;
        return equal;
    }

    private void BeginPaneResize(TerminalSession session, bool resizeFromLeft)
    {
        ResetPaneResizeState();
        if (_selectedProject is null || _isSessionDragging || _maximizedSession is not null ||
            !string.Equals(session.ProjectId, _selectedProject.Id, StringComparison.Ordinal) ||
            _workspace.ActualWidth < 1) return;

        var order = SelectedProjectSessions();
        var sessionIndex = order.IndexOf(session);
        if (sessionIndex < 0) return;

        var (columns, rows) = LayoutFor(order.Count);
        var row = sessionIndex / columns;
        var column = sessionIndex % columns;
        var itemCount = Math.Min(columns, order.Count - row * columns);
        var leftColumn = resizeFromLeft ? column - 1 : column;
        var rightColumn = leftColumn + 1;
        if (leftColumn < 0 || rightColumn >= itemCount) return;

        var ratios = GetPaneWidthRatios(_selectedProject, columns, rows, row);
        var widths = ratios.Select(value => value * _workspace.ActualWidth).ToArray();
        var widthBeforePair = widths.Take(leftColumn).Sum();
        var startBoundary = widthBeforePair + widths[leftColumn];
        var averageWidth = _workspace.ActualWidth / columns;
        var minimumWidth = Math.Min(
            PreferredMinimumPaneWidth,
            Math.Max(80, averageWidth * 0.72));

        _paneResizeSession = session;
        _paneResizeRow = row;
        _paneResizeLeftColumn = leftColumn;
        _paneResizeStartWidths = widths;
        _paneResizeStartBoundaryX = startBoundary;
        _paneResizeStartPointerX = Mouse.GetPosition(_workspace).X;
        _paneResizeMinimumBoundaryX = widthBeforePair + minimumWidth;
        _paneResizeMaximumBoundaryX =
            widthBeforePair + widths[leftColumn] + widths[rightColumn] - minimumWidth;
        _paneResizeRawBoundaryX = startBoundary;
        _paneResizeSnapTargets = GetPaneResizeSnapTargets(order, columns, rows, row);

        var initialTarget = FindClosestPaneResizeSnapTarget(
            startBoundary,
            _paneResizeSnapTargets,
            _paneResizeMinimumBoundaryX,
            _paneResizeMaximumBoundaryX,
            ignoredTarget: null);
        if (initialTarget is double target &&
            Math.Abs(target - startBoundary) <= PaneResizeInitialTargetTolerance)
            _paneResizeIgnoredInitialTargetX = target;
    }

    private List<double> GetPaneResizeSnapTargets(
        IReadOnlyList<TerminalSession> order,
        int columns,
        int rows,
        int resizedRow)
    {
        var targets = new List<double>();
        if (_selectedProject is null || _workspace.ActualWidth < 1) return targets;

        for (var row = 0; row < rows; row++)
        {
            if (row == resizedRow) continue;
            var firstIndex = row * columns;
            var itemCount = Math.Min(columns, Math.Max(0, order.Count - firstIndex));
            if (itemCount < 2) continue;

            var ratios = GetPaneWidthRatios(_selectedProject, columns, rows, row);
            var cumulativeRatio = 0d;
            for (var boundary = 1; boundary < itemCount; boundary++)
            {
                cumulativeRatio += ratios[boundary - 1];
                var target = cumulativeRatio * _workspace.ActualWidth;
                if (!double.IsFinite(target) ||
                    targets.Any(existing => Math.Abs(existing - target) <= 0.5)) continue;
                targets.Add(target);
            }
        }

        targets.Sort();
        return targets;
    }

    private static double? FindClosestPaneResizeSnapTarget(
        double rawBoundary,
        IEnumerable<double> targets,
        double minimumBoundary,
        double maximumBoundary,
        double? ignoredTarget)
    {
        double? closest = null;
        var closestDistance = double.MaxValue;
        foreach (var target in targets)
        {
            if (target < minimumBoundary || target > maximumBoundary ||
                ignoredTarget is double ignored && Math.Abs(target - ignored) <= 0.5) continue;
            var distance = Math.Abs(target - rawBoundary);
            if (distance >= closestDistance) continue;
            closest = target;
            closestDistance = distance;
        }
        return closest;
    }

    private double ResolvePaneResizeBoundary(
        double rawBoundary,
        IReadOnlyList<double> snapTargets,
        double minimumBoundary,
        double maximumBoundary,
        bool trackedDrag)
    {
        rawBoundary = Math.Clamp(rawBoundary, minimumBoundary, maximumBoundary);
        if (!trackedDrag)
        {
            var nearestTarget = FindClosestPaneResizeSnapTarget(
                rawBoundary,
                snapTargets,
                minimumBoundary,
                maximumBoundary,
                ignoredTarget: null);
            return nearestTarget is double target && Math.Abs(target - rawBoundary) <= PaneResizeSnapDistance
                ? target
                : rawBoundary;
        }

        _paneResizeRawBoundaryX = rawBoundary;
        if (_paneResizeIgnoredInitialTargetX is double ignored &&
            Math.Abs(rawBoundary - ignored) > PaneResizeSnapReleaseDistance)
            _paneResizeIgnoredInitialTargetX = null;

        if (_paneResizeSnapTargetX is double activeTarget)
        {
            var targetStillValid =
                activeTarget >= minimumBoundary &&
                activeTarget <= maximumBoundary &&
                snapTargets.Any(target => Math.Abs(target - activeTarget) <= 0.5);
            if (targetStillValid &&
                Math.Abs(rawBoundary - activeTarget) <= PaneResizeSnapReleaseDistance)
                return activeTarget;
            _paneResizeSnapTargetX = null;
        }

        var closestTarget = FindClosestPaneResizeSnapTarget(
            rawBoundary,
            snapTargets,
            minimumBoundary,
            maximumBoundary,
            _paneResizeIgnoredInitialTargetX);
        if (closestTarget is double closest &&
            Math.Abs(closest - rawBoundary) <= PaneResizeSnapDistance)
        {
            _paneResizeSnapTargetX = closest;
            return closest;
        }

        return rawBoundary;
    }

    private void ResizePaneWidth(TerminalSession session, bool resizeFromLeft, double horizontalChange)
    {
        if (!double.IsFinite(horizontalChange) ||
            _selectedProject is null || _isSessionDragging || _maximizedSession is not null ||
            !string.Equals(session.ProjectId, _selectedProject.Id, StringComparison.Ordinal)) return;

        var order = SelectedProjectSessions();
        var sessionIndex = order.IndexOf(session);
        if (sessionIndex < 0 || _workspace.ActualWidth < 1) return;

        var (columns, rows) = LayoutFor(order.Count);
        var row = sessionIndex / columns;
        var column = sessionIndex % columns;
        var itemCount = Math.Min(columns, order.Count - row * columns);
        var leftColumn = resizeFromLeft ? column - 1 : column;
        var rightColumn = leftColumn + 1;
        if (leftColumn < 0 || rightColumn >= itemCount) return;

        var trackedDrag =
            ReferenceEquals(_paneResizeSession, session) &&
            _paneResizeRow == row &&
            _paneResizeLeftColumn == leftColumn &&
            _paneResizeStartWidths?.Length == columns;
        if (!trackedDrag && Math.Abs(horizontalChange) < 0.01) return;

        double[] widths;
        double startBoundary;
        double minimumBoundary;
        double maximumBoundary;
        double rawBoundary;
        IReadOnlyList<double> snapTargets;

        if (trackedDrag)
        {
            widths = (double[])_paneResizeStartWidths!.Clone();
            startBoundary = _paneResizeStartBoundaryX;
            minimumBoundary = _paneResizeMinimumBoundaryX;
            maximumBoundary = _paneResizeMaximumBoundaryX;
            rawBoundary = startBoundary + Mouse.GetPosition(_workspace).X - _paneResizeStartPointerX;
            snapTargets = _paneResizeSnapTargets ?? [];
        }
        else
        {
            var ratios = GetPaneWidthRatios(_selectedProject, columns, rows, row);
            widths = ratios.Select(value => value * _workspace.ActualWidth).ToArray();
            var widthBeforePair = widths.Take(leftColumn).Sum();
            startBoundary = widthBeforePair + widths[leftColumn];
            var averageWidth = _workspace.ActualWidth / columns;
            var minimumWidth = Math.Min(
                PreferredMinimumPaneWidth,
                Math.Max(80, averageWidth * 0.72));
            minimumBoundary = widthBeforePair + minimumWidth;
            maximumBoundary =
                widthBeforePair + widths[leftColumn] + widths[rightColumn] - minimumWidth;
            rawBoundary = startBoundary + horizontalChange;
            snapTargets = GetPaneResizeSnapTargets(order, columns, rows, row);
        }

        var finalBoundary = ResolvePaneResizeBoundary(
            rawBoundary,
            snapTargets,
            minimumBoundary,
            maximumBoundary,
            trackedDrag);
        var appliedDelta = finalBoundary - startBoundary;
        if (Math.Abs(appliedDelta) < 0.01) return;

        widths[leftColumn] += appliedDelta;
        widths[rightColumn] -= appliedDelta;
        var widthTotal = widths.Sum();
        var updatedRatios = widths.Select(width => width / widthTotal).ToList();
        _selectedProject.PaneWidthRatios[PaneWidthRatioKey(columns, rows, row)] = updatedRatios;
        ApplyWorkspacePanelLayout(order);
    }

    private void CompletePaneResize(TerminalSession session)
    {
        ResetPaneResizeState();
        if (_selectedProject is null ||
            !string.Equals(session.ProjectId, _selectedProject.Id, StringComparison.Ordinal)) return;
        SaveProjectSelection();
        Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, session.Terminal.FocusConsole);
    }

    private void ResetPaneResizeState()
    {
        _paneResizeSession = null;
        _paneResizeRow = -1;
        _paneResizeLeftColumn = -1;
        _paneResizeStartWidths = null;
        _paneResizeSnapTargets = null;
        _paneResizeSnapTargetX = null;
        _paneResizeIgnoredInitialTargetX = null;
        _paneResizeRawBoundaryX = 0;
        _paneResizeStartBoundaryX = 0;
        _paneResizeStartPointerX = 0;
        _paneResizeMinimumBoundaryX = 0;
        _paneResizeMaximumBoundaryX = 0;
    }

    private bool VerifyPaneWidthResizeForSmoke()
    {
        if (_selectedProject is null || _maximizedSession is not null) return true;
        var order = SelectedProjectSessions();
        var (columns, _) = LayoutFor(order.Count);
        if (order.Count < 2 || columns < 2 || _workspace.ActualWidth < 1) return true;

        var first = order[0];
        var second = order[1];
        var originalRatios = _selectedProject.PaneWidthRatios.ToDictionary(
            entry => entry.Key,
            entry => entry.Value.ToList(),
            StringComparer.Ordinal);
        ApplyWorkspacePanelLayout(order);
        var firstWidth = first.Panel.ActualWidth;
        var secondWidth = second.Panel.ActualWidth;
        var firstHeight = first.Panel.ActualHeight;
        var secondHeight = second.Panel.ActualHeight;

        ResizePaneWidth(first, resizeFromLeft: false, horizontalChange: 40);
        _workspace.UpdateLayout();
        var resizedCorrectly =
            first.Panel.ActualWidth > firstWidth + 10 &&
            second.Panel.ActualWidth < secondWidth - 10 &&
            Math.Abs(first.Panel.ActualHeight - firstHeight) < 1 &&
            Math.Abs(second.Panel.ActualHeight - secondHeight) < 1;

        _selectedProject.PaneWidthRatios = originalRatios;
        ApplyWorkspacePanelLayout(order);
        return resizedCorrectly;
    }

    private bool VerifyPaneWidthSnapForSmoke()
    {
        if (_selectedProject is null || _maximizedSession is not null ||
            _workspace.ActualWidth < 1) return true;
        var order = SelectedProjectSessions();
        var (columns, rows) = LayoutFor(order.Count);
        if (columns < 2 || rows < 2 || order.Count <= columns) return true;

        var comparisonRow = -1;
        for (var row = 1; row < rows; row++)
        {
            var itemCount = Math.Min(columns, Math.Max(0, order.Count - row * columns));
            if (itemCount < 2) continue;
            comparisonRow = row;
            break;
        }
        if (comparisonRow < 0) return true;

        var originalRatios = _selectedProject.PaneWidthRatios.ToDictionary(
            entry => entry.Key,
            entry => entry.Value.ToList(),
            StringComparer.Ordinal);
        try
        {
            var equalRatios = Enumerable.Repeat(1d / columns, columns).ToList();
            for (var row = 0; row < rows; row++)
                _selectedProject.PaneWidthRatios[PaneWidthRatioKey(columns, rows, row)] =
                    equalRatios.ToList();

            var offset = PaneResizeSnapReleaseDistance + 8;
            var firstRowRatios = equalRatios.ToList();
            firstRowRatios[0] -= offset / _workspace.ActualWidth;
            firstRowRatios[1] += offset / _workspace.ActualWidth;
            _selectedProject.PaneWidthRatios[PaneWidthRatioKey(columns, rows, 0)] = firstRowRatios;
            ApplyWorkspacePanelLayout(order);

            var targetBoundary = _workspace.ActualWidth / columns;
            ResizePaneWidth(
                order[0],
                resizeFromLeft: false,
                horizontalChange: offset - PaneResizeSnapDistance / 2);
            var snappedRatios = GetPaneWidthRatios(_selectedProject, columns, rows, 0);
            var snappedBoundary = snappedRatios[0] * _workspace.ActualWidth;
            var snappedExactly = Math.Abs(snappedBoundary - targetBoundary) <= 0.5;

            var targets = GetPaneResizeSnapTargets(order, columns, rows, resizedRow: 0);
            _paneResizeSnapTargetX = targetBoundary;
            _paneResizeIgnoredInitialTargetX = null;
            var heldBoundary = ResolvePaneResizeBoundary(
                targetBoundary + PaneResizeSnapDistance + 2,
                targets,
                0,
                _workspace.ActualWidth,
                trackedDrag: true);
            var releasedBoundary = ResolvePaneResizeBoundary(
                targetBoundary + PaneResizeSnapReleaseDistance + 2,
                targets,
                0,
                _workspace.ActualWidth,
                trackedDrag: true);
            var hysteresisWorks =
                Math.Abs(heldBoundary - targetBoundary) <= 0.5 &&
                releasedBoundary > targetBoundary + PaneResizeSnapDistance;
            return snappedExactly && hysteresisWorks;
        }
        finally
        {
            ResetPaneResizeState();
            _selectedProject.PaneWidthRatios = originalRatios;
            ApplyWorkspacePanelLayout(order);
        }
    }

    private void PersistProjectSessionOrder(string projectId)
    {
        var project = _projects.FirstOrDefault(item =>
            string.Equals(item.Id, projectId, StringComparison.Ordinal));
        if (project is null) return;

        var orderedStates = SessionsForProject(projectId)
            .Where(session => session.PersistState)
            .Select(session => session.State)
            .ToList();
        var orderedIds = orderedStates
            .Select(state => state.Id)
            .ToHashSet(StringComparer.Ordinal);
        orderedStates.AddRange(project.Terminals.Where(state => !orderedIds.Contains(state.Id)));
        project.Terminals = orderedStates.Take(MaximumSessions).ToList();
        SaveProjectSelection();
    }

    private void ShowAcceptedSlotInsertionLine()
    {
        var slots = _dragSlots;
        if (slots is null ||
            _dragAcceptedSlotIndex < 0 ||
            _dragAcceptedSlotIndex >= slots.Count) return;

        if (_dragInsertionWindow is null)
        {
            _dragInsertionLine = new Border
            {
                Background = Brush("#68686D"),
                CornerRadius = new CornerRadius(1),
                IsHitTestVisible = false,
                SnapsToDevicePixels = true,
            };
            _dragInsertionWindow = new Window
            {
                AllowsTransparency = true,
                Background = Brushes.Transparent,
                WindowStyle = WindowStyle.None,
                ResizeMode = ResizeMode.NoResize,
                ShowInTaskbar = false,
                ShowActivated = false,
                Topmost = true,
                Focusable = false,
                IsHitTestVisible = false,
                WindowStartupLocation = WindowStartupLocation.Manual,
                Content = _dragInsertionLine,
                Owner = this,
            };
        }

        if (_dragInsertionLine is null || _dragInsertionWindow is null) return;

        var slot = slots[_dragAcceptedSlotIndex];
        var (columns, _) = LayoutFor(slots.Count);
        var column = _dragAcceptedSlotIndex % columns;
        // Only vertical separators are used. At the first column the separator
        // sits on the slot's right edge; elsewhere it sits on the left edge.
        var boundaryX = column == 0 && columns > 1 ? slot.Right + 5 : slot.Left - 5;
        _dragInsertionWindow.Left = boundaryX - 4;
        _dragInsertionWindow.Top = slot.Top + 3;
        _dragInsertionWindow.Width = 8;
        _dragInsertionWindow.Height = Math.Max(20, slot.Height - 6);
        _dragInsertionLine.Width = 2;
        _dragInsertionLine.Height = double.NaN;
        _dragInsertionLine.HorizontalAlignment = HorizontalAlignment.Center;
        _dragInsertionLine.VerticalAlignment = VerticalAlignment.Stretch;
        _dragInsertionLine.Margin = new Thickness(0, 7, 0, 7);
        if (!_dragInsertionWindow.IsVisible) _dragInsertionWindow.Show();
    }

    private void HideSessionInsertionLine()
    {
        if (_dragInsertionWindow?.IsVisible == true) _dragInsertionWindow.Hide();
    }

    private static Thumb PaneResizeThumb() => new()
    {
        HorizontalAlignment = HorizontalAlignment.Stretch,
        VerticalAlignment = VerticalAlignment.Stretch,
        Background = Brushes.Transparent,
        BorderThickness = new Thickness(0),
        Opacity = 0.01,
        Cursor = Cursors.SizeWE,
        Focusable = false,
        ToolTip = "좌우로 드래그해 폭 조절",
    };

    private static bool IsDragControl(DependencyObject? source)
    {
        while (source is not null)
        {
            if (source is Button or TextBox or Thumb) return true;
            source = VisualTreeHelper.GetParent(source);
        }
        return false;
    }

    private static void TracePowerShellAdd(string message)
    {
        var path = Environment.GetEnvironmentVariable("POWERWORKSPACE_ADD_TRACE_PATH");
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            File.AppendAllText(
                path,
                $"{DateTime.Now:HH:mm:ss.fff} {message}{Environment.NewLine}");
        }
        catch
        {
        }
    }

    private void CloseSession(TerminalSession session)
    {
        if (!_sessions.Contains(session)) return;
        session.Closing = true;
        StopTerminal(session.Terminal);
        _sessions.Remove(session);
        var project = _projects.FirstOrDefault(item =>
            string.Equals(item.Id, session.ProjectId, StringComparison.Ordinal));
        if (session.PersistState && project is not null)
        {
            project.Terminals.RemoveAll(item => string.Equals(item.Id, session.State.Id, StringComparison.Ordinal));
            SaveProjectSelection();
            UpdateProjectAlertBadge(project);
        }
        if (_maximizedSession == session) _maximizedSession = null;
        if (_activeSession == session) _activeSession = null;
        RebuildLayout();
    }

    private static void StopTerminal(IntegratedPowerShellHost terminal) => terminal.Dispose();

    private void SetActive(TerminalSession session)
    {
        if (_selectedProject is null ||
            !string.Equals(session.ProjectId, _selectedProject.Id, StringComparison.Ordinal)) return;
        _activeSession = session;
        foreach (var item in SelectedProjectSessions())
            UpdateSessionAppearance(item);
    }

    private void ClearActiveSessionSelection()
    {
        var previousActive = _activeSession;
        if (previousActive is null) return;
        _activeSession = null;
        UpdateSessionAppearance(previousActive);
    }

    private void QueueCompletion(TerminalSession session)
    {
        if (session.Closing ||
            !_sessions.Contains(session) ||
            session.CompletionPending ||
            session.CompletionSignalPending) return;
        session.CompletionSignalPending = true;
        session.CompletionSignalTimestamp = Stopwatch.GetTimestamp();
        if (!_completionTimer.IsEnabled) _completionTimer.Start();
    }

    private void MarkCompletion(TerminalSession session)
    {
        session.CompletionSignalPending = false;
        session.CompletionSignalTimestamp = 0;
        if (session.Closing || !_sessions.Contains(session)) return;
        if (session.CompletionPending) return;
        session.CompletionPending = true;
        session.State.CompletionPending = true;
        if (session.PersistState) SaveProjectSelection();
        var project = _projects.FirstOrDefault(item =>
            string.Equals(item.Id, session.ProjectId, StringComparison.Ordinal));
        if (project is not null) UpdateProjectAlertBadge(project);
        UpdateSessionAppearance(session);
        if (!_smokeTest) System.Media.SystemSounds.Asterisk.Play();
        if (!_completionTimer.IsEnabled) _completionTimer.Start();
    }

    private void AcknowledgeCompletion(TerminalSession session)
    {
        // A completion signal waits briefly for the final terminal output to
        // settle. Focus or typing during that hidden period must not consume
        // an alert that has never been shown.
        if (!session.CompletionPending) return;

        session.CompletionSignalPending = false;
        session.CompletionSignalTimestamp = 0;
        session.CompletionPending = false;
        session.State.CompletionPending = false;
        if (session.PersistState) SaveProjectSelection();
        var project = _projects.FirstOrDefault(item =>
            string.Equals(item.Id, session.ProjectId, StringComparison.Ordinal));
        if (project is not null) UpdateProjectAlertBadge(project);
        UpdateSessionAppearance(session);
        StopCompletionTimerIfIdle();
    }

    private void StopCompletionTimerIfIdle()
    {
        if (_sessions.All(item => !item.CompletionPending && !item.CompletionSignalPending))
            _completionTimer.Stop();
    }

    private void UpdateSessionAppearance(TerminalSession session)
    {
        if (session.CompletionPending)
        {
            session.Panel.BorderBrush = CompletionBrush;
            session.Panel.Effect = session.CompletionEffect;
            return;
        }

        session.Panel.BorderBrush = session == _activeSession ? ActiveBorderBrush : PanelBorderBrush;
        session.Panel.Effect = null;
    }

    private void OnCompletionTimerTick(object? sender, EventArgs e)
    {
        var completionCandidates = _sessions.Where(session => session.CompletionSignalPending).ToArray();
        foreach (var session in completionCandidates)
        {
            if (session.CompletionSignalTimestamp <= 0 ||
                Stopwatch.GetElapsedTime(session.CompletionSignalTimestamp) < CompletionOutputQuietTime ||
                session.Terminal.OutputQuietDuration < CompletionOutputQuietTime) continue;
            MarkCompletion(session);
        }

        var pendingSessions = _sessions.Where(session => session.CompletionPending).ToArray();
        var hasCompletionCandidates = _sessions.Any(session => session.CompletionSignalPending);
        if (pendingSessions.Length == 0 && !hasCompletionCandidates)
        {
            _completionTimer.Stop();
            return;
        }

        var pulse = (Math.Sin(Environment.TickCount64 / 260d) + 1d) / 2d;
        foreach (var session in pendingSessions.Where(session =>
                     _selectedProject is not null &&
                     string.Equals(session.ProjectId, _selectedProject.Id, StringComparison.Ordinal)))
        {
            session.CompletionEffect.Opacity = 0.35 + pulse * 0.6;
            session.CompletionEffect.BlurRadius = 10 + pulse * 10;
        }

        // Acknowledgement is driven by the terminal's real focus/input events
        // and the WPF pane click handlers. GetAsyncKeyState's low-order bit is
        // a process-wide "pressed since the last query" flag, so polling it
        // here could consume an old click and erase a newly-created alert
        // before the user ever saw it.
    }

    private void HandleWatchedCodexCompletion(string threadId)
    {
        if (_shutdownStarted) return;
        var session = _sessions.FirstOrDefault(item =>
            string.Equals(
                item.State.CodexThreadId,
                threadId,
                StringComparison.OrdinalIgnoreCase));
        if (session is not null) QueueCompletion(session);
    }

    private void ToggleMaximize(TerminalSession session)
    {
        _maximizedSession = _maximizedSession == session ? null : session;
        RebuildLayout();
        Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, session.Terminal.FocusConsole);
    }

    private void RebuildLayout()
    {
        ResetPaneResizeState();
        var visibleSessions = SelectedProjectSessions();
        _workspace.Children.Clear();
        _workspace.RowDefinitions.Clear();
        _workspace.ColumnDefinitions.Clear();
        _sessionCount.Text = $"{visibleSessions.Count} / {MaximumSessions}";

        if (visibleSessions.Count == 0)
        {
            _workspace.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            _workspace.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var empty = new StackPanel
            {
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            empty.Children.Add(Text(">_", 28, BlueBrush, FontWeights.Bold));
            var hint = Text("왼쪽에서 프로젝트를 선택한 뒤 ＋ PowerShell을 눌러 세션을 추가하세요.", 13, MutedBrush);
            hint.Margin = new Thickness(0, 8, 0, 0);
            empty.Children.Add(hint);
            _workspace.Children.Add(empty);
            return;
        }

        if (_maximizedSession is not null && visibleSessions.Contains(_maximizedSession))
        {
            _workspace.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            _workspace.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            SetPanelToFillWorkspace(_maximizedSession.Panel);
            _maximizedSession.LeftResizeThumb.Visibility = Visibility.Collapsed;
            _maximizedSession.RightResizeThumb.Visibility = Visibility.Collapsed;
            _workspace.Children.Add(_maximizedSession.Panel);
            ScheduleTerminalVisibilityRefresh();
            return;
        }

        _workspace.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _workspace.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        foreach (var session in visibleSessions)
        {
            Grid.SetColumn(session.Panel, 0);
            Grid.SetRow(session.Panel, 0);
            _workspace.Children.Add(session.Panel);
        }
        ApplyWorkspacePanelLayout(visibleSessions);
        Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, UpdateLiveSessionGridPositions);
        ScheduleTerminalVisibilityRefresh();
    }

    private async Task RefreshUsageAsync()
    {
        if (_usageReadInProgress) return;
        _usageReadInProgress = true;
        try
        {
            var usage = await Task.Run(UsageReader.ReadAll);
            RenderUsage(usage);
        }
        finally
        {
            _usageReadInProgress = false;
        }
    }

    private void RenderUsage(UsageSnapshot usage)
    {
        _usageLeft.Children.Clear();
        _usageLeft.Children.Add(Spaced(ServiceIcon(CodexIconGeometry, GreenBrush, "Codex"), 0, 6));
        _usageLeft.Children.Add(Spaced(ServiceLabel("CODEX", TextBrush, FontWeights.Bold), 0, 10));
        _usageLeft.Children.Add(Spaced(LimitView("5시간", usage.Codex.FiveHour, GreenBrush), 0, 12));
        _usageLeft.Children.Add(LimitView("주간", usage.Codex.Weekly, GreenBrush, showRemaining: true));
        _usageLeft.Children.Add(Spaced(ServiceLabel("│", PanelBorderBrush), 12, 12));
        _usageLeft.Children.Add(Spaced(ServiceIcon(GrokIconGeometry, GrokBrush, "Grok"), 0, 6));
        _usageLeft.Children.Add(Spaced(ServiceLabel("GROK", TextBrush, FontWeights.Bold), 0, 10));
        _usageLeft.Children.Add(LimitView("주간", usage.Grok.Weekly, GrokBrush, showRemaining: true));
    }

    private static FrameworkElement LimitView(
        string label,
        LimitSnapshot? limit,
        Brush accent,
        bool showRemaining = false)
    {
        var panel = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
        };
        panel.Children.Add(Spaced(Text(label, 10, MutedBrush), 0, 5));
        if (limit is null)
        {
            panel.Children.Add(Text("--", 10, MutedBrush));
            return panel;
        }

        var percentage = Math.Clamp(
            showRemaining ? 100 - limit.UsedPercent : limit.UsedPercent,
            0,
            100);
        panel.Children.Add(Spaced(new ProgressBar
        {
            Minimum = 0,
            Maximum = 100,
            Value = percentage,
            Width = 48,
            Height = 4,
            Foreground = accent,
            Background = PanelBorderBrush,
            BorderThickness = new Thickness(0),
            VerticalAlignment = VerticalAlignment.Center,
        }, 0, 5));
        var percentageLabel = showRemaining
            ? $"{Math.Round(percentage):0}% 남음"
            : $"{Math.Round(percentage):0}%";
        panel.Children.Add(Spaced(Text(percentageLabel, 10, TextBrush, FontWeights.SemiBold), 0, 5));
        panel.Children.Add(Text(FormatRemaining(limit.ResetsAt), 10, MutedBrush));
        return panel;
    }

    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Shift) && e.Key == Key.T)
        {
            AddPowerShellInSelectedProject();
            e.Handled = true;
        }
        else if (Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Shift) &&
                 e.Key == Key.W && _activeSession is not null)
        {
            CloseSession(_activeSession);
            e.Handled = true;
        }
        else if (Keyboard.Modifiers == ModifierKeys.Alt && e.SystemKey == Key.Enter && _activeSession is not null)
        {
            ToggleMaximize(_activeSession);
            e.Handled = true;
        }
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_shutdownStarted) return;
        _shutdownStarted = true;
        ResetPaneResizeState();
        HideSessionInsertionLine();
        _dragInsertionWindow?.Close();
        _dragInsertionWindow = null;
        _dragInsertionLine = null;
        UnregisterHotkeys();
        _windowSource?.RemoveHook(HandleWindowMessage);
        _usageTimer.Stop();
        _completionTimer.Stop();
        _codexCompletionWatcher.Dispose();

        if (_windowSource is not null) _ = ShowWindow(_windowSource.Handle, SwHide);

        foreach (var session in _sessions)
        {
            session.Closing = true;
            session.Terminal.PrepareForShutdown();
        }

        foreach (var session in _sessions.ToArray())
        {
            StopTerminal(session.Terminal);
        }

        // Native TerminalControl HWND teardown can serialize or occasionally
        // wait indefinitely when many panes close together. The window is
        // already hidden and all owned shells have been stopped, so end the
        // process before WPF begins that visible, pane-by-pane teardown.
        Environment.Exit(Environment.ExitCode);
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        _windowSource = (HwndSource?)PresentationSource.FromVisual(this);
        if (_windowSource is not null) EnableDarkTitleBar(_windowSource.Handle);
        _windowSource?.AddHook(HandleWindowMessage);
        RegisterHotkeys();
    }

    private IntPtr HandleWindowMessage(
        IntPtr window,
        int message,
        IntPtr wParam,
        IntPtr lParam,
        ref bool handled)
    {
        if (message == WmMouseActivate)
        {
            handled = true;
            return new IntPtr(MaActivate);
        }

        if (message == NotificationBridge.WmCopyData &&
            NotificationBridge.TryReadNotification(lParam, out var notification))
        {
            var session = _sessions.FirstOrDefault(item =>
                string.Equals(item.Terminal.NotificationId, notification.SessionId, StringComparison.Ordinal));
            if (session is not null)
            {
                HandleCodexCompletionNotification(session, notification.CodexThreadId);
            }
            handled = true;
            return new IntPtr(1);
        }

        if (message != WmHotkey) return IntPtr.Zero;

        switch (wParam.ToInt32())
        {
            case HotkeyAddPowerShell:
                AddPowerShellInSelectedProject();
                break;
            case HotkeyClosePowerShell when _activeSession is not null:
                CloseSession(_activeSession);
                break;
            case HotkeyMaximizePowerShell when _activeSession is not null:
                ToggleMaximize(_activeSession);
                break;
            default:
                return IntPtr.Zero;
        }
        handled = true;
        return IntPtr.Zero;
    }

    private void HandleCodexCompletionNotification(
        TerminalSession session,
        string? notifiedThreadId)
    {
        var normalizedNotification = Guid.TryParse(notifiedThreadId, out var parsedNotification)
            ? parsedNotification.ToString()
            : null;
        var normalizedCurrent = Guid.TryParse(session.State.CodexThreadId, out var parsedCurrent)
            ? parsedCurrent.ToString()
            : null;

        if (normalizedNotification is not null)
        {
            if (string.Equals(
                    normalizedNotification,
                    normalizedCurrent,
                    StringComparison.OrdinalIgnoreCase))
            {
                QueueCompletion(session);
                return;
            }

            // Subagents inherit the pane's notification environment. Their
            // completion is not the parent turn completing, and must neither
            // overwrite the pane's resume ID nor light its completion border.
            if (normalizedCurrent is not null &&
                CodexSessionLocator.IsDescendantOf(normalizedNotification, normalizedCurrent)) return;
            if (CodexSessionLocator.TryResolveUserThreadId(
                    normalizedNotification,
                    out var userThreadId) &&
                !string.Equals(
                    normalizedNotification,
                    userThreadId,
                    StringComparison.OrdinalIgnoreCase))
            {
                var currentHasSameRoot = normalizedCurrent is not null &&
                                         CodexSessionLocator.TryResolveUserThreadId(
                                             normalizedCurrent,
                                             out var currentUserThreadId) &&
                                         string.Equals(
                                             currentUserThreadId,
                                             userThreadId,
                                             StringComparison.OrdinalIgnoreCase);
                if (!currentHasSameRoot) AssociateCodexThread(session, userThreadId);
                return;
            }

            AssociateCodexThread(session, normalizedNotification);
            QueueCompletion(session);
            return;
        }

        // Older notify payloads may omit the thread id. If this pane already
        // has a valid association, keep it instead of guessing another recent
        // thread from the same working directory.
        if (normalizedCurrent is not null)
        {
            QueueCompletion(session);
            return;
        }

        var fallbackThreadId = CodexSessionLocator.FindMostRecentlyUpdated(
            session.StartDirectory,
            TimeSpan.FromMinutes(2),
            _projects.SelectMany(project => project.Terminals)
                .Select(terminal => terminal.CodexThreadId));
        AssociateCodexThread(session, fallbackThreadId);
        QueueCompletion(session);
    }

    private void AssociateCodexThread(TerminalSession session, string? codexThreadId)
    {
        if (!Guid.TryParse(codexThreadId, out var parsedThreadId)) return;
        var normalizedThreadId = parsedThreadId.ToString();
        if (string.Equals(session.State.CodexThreadId, normalizedThreadId, StringComparison.Ordinal)) return;
        if (CodexSessionLocator.IsDescendantOf(
                normalizedThreadId,
                session.State.CodexThreadId)) return;
        if (_projects
            .SelectMany(project => project.Terminals)
            .Any(terminal =>
                !ReferenceEquals(terminal, session.State) &&
                string.Equals(
                    terminal.CodexThreadId,
                    normalizedThreadId,
                    StringComparison.OrdinalIgnoreCase))) return;
        session.State.CodexThreadId = normalizedThreadId;
        _codexCompletionWatcher.TrackThread(normalizedThreadId);
        if (session.PersistState) SaveProjectSelection();
    }

    private void RegisterHotkeys()
    {
        if (_windowSource is null) return;
        RegisterHotkey(HotkeyAddPowerShell, ModControl | ModShift | ModNoRepeat, 0x54);
        RegisterHotkey(HotkeyClosePowerShell, ModControl | ModShift | ModNoRepeat, 0x57);
        RegisterHotkey(HotkeyMaximizePowerShell, ModAlt | ModNoRepeat, 0x0D);
    }

    private void RegisterHotkey(int id, uint modifiers, uint key)
    {
        if (_windowSource is null || _registeredHotkeys.Contains(id)) return;
        if (RegisterHotKey(_windowSource.Handle, id, modifiers, key)) _registeredHotkeys.Add(id);
    }

    private void UnregisterHotkeys()
    {
        if (_windowSource is null) return;
        foreach (var id in _registeredHotkeys.ToArray()) _ = UnregisterHotKey(_windowSource.Handle, id);
        _registeredHotkeys.Clear();
    }

    private static (int Columns, int Rows) LayoutFor(int count) => count switch
    {
        <= 1 => (1, 1),
        2 => (2, 1),
        <= 4 => (2, 2),
        <= 6 => (3, 2),
        <= 8 => (4, 2),
        9 => (3, 3),
        <= 12 => (4, 3),
        <= 15 => (5, 3),
        16 => (4, 4),
        _ => (5, 4),
    };

    private static Button ToolbarButton(string label, Brush background)
    {
        var primary = ReferenceEquals(background, BlueBrush);
        return new Button
        {
            Content = label,
            Height = 32,
            Padding = new Thickness(13, 0, 13, 0),
            Background = background,
            Foreground = primary ? BackgroundBrush : TextBrush,
            BorderBrush = primary ? TextBrush : PanelBorderBrush,
            BorderThickness = new Thickness(1),
            FontSize = 11,
            FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center,
            Cursor = Cursors.Hand,
        };
    }

    private static Button PanelButton(string label, string toolTip) => new()
    {
        Content = label,
        Width = 26,
        Height = 26,
        Padding = new Thickness(0),
        Background = Brushes.Transparent,
        Foreground = MutedBrush,
        BorderThickness = new Thickness(0),
        FontSize = 13,
        VerticalAlignment = VerticalAlignment.Center,
        ToolTip = toolTip,
        Cursor = Cursors.Hand,
    };

    private static TextBlock ServiceLabel(string value, Brush brush, FontWeight? weight = null) =>
        Text(value, 10, brush, weight);

    private static FrameworkElement ServiceIcon(Geometry geometry, Brush brush, string toolTip) =>
        new System.Windows.Shapes.Path
        {
            Data = geometry,
            Fill = brush,
            Width = 14,
            Height = 14,
            Stretch = Stretch.Uniform,
            VerticalAlignment = VerticalAlignment.Center,
            SnapsToDevicePixels = true,
            ToolTip = toolTip,
        };

    private static TextBlock Text(string value, double size, Brush brush, FontWeight? weight = null) => new()
    {
        Text = value,
        FontSize = size,
        Foreground = brush,
        FontWeight = weight ?? FontWeights.Normal,
        VerticalAlignment = VerticalAlignment.Center,
    };

    private static T Spaced<T>(T element, double left, double right) where T : FrameworkElement
    {
        element.Margin = new Thickness(left, 0, right, 0);
        return element;
    }

    private static SolidColorBrush Brush(string color)
    {
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(color));
        brush.Freeze();
        return brush;
    }

    private static Geometry IconGeometry(string data)
    {
        var geometry = Geometry.Parse(data);
        geometry.Freeze();
        return geometry;
    }

    private static string ShortPath(string path)
    {
        var trimmed = path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return Path.GetFileName(trimmed) is { Length: > 0 } name ? name : path;
    }

    private static bool SamePath(string first, string second)
    {
        try
        {
            var firstPath = Path.GetFullPath(first)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var secondPath = Path.GetFullPath(second)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.Equals(firstPath, secondPath, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static string FormatRemaining(DateTimeOffset reset)
    {
        var remaining = reset - DateTimeOffset.UtcNow;
        if (remaining <= TimeSpan.Zero) return "곧 초기화";
        if (remaining.TotalDays >= 1) return $"{(int)remaining.TotalDays}일 {remaining.Hours}시간";
        if (remaining.TotalHours >= 1) return $"{(int)remaining.TotalHours}시간 {remaining.Minutes}분";
        return $"{Math.Max(1, remaining.Minutes)}분";
    }

    private static void EnableDarkTitleBar(IntPtr window)
    {
        var enabled = 1;
        if (DwmSetWindowAttribute(window, 20, ref enabled, sizeof(int)) != 0)
            _ = DwmSetWindowAttribute(window, 19, ref enabled, sizeof(int));
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint virtualKey);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnregisterHotKey(IntPtr window, int id);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        IntPtr window,
        int attribute,
        ref int value,
        int valueSize);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out NativePoint point);
}
