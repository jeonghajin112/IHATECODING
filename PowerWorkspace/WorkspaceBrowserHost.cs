using System.IO;
using System.Net;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace PowerWorkspace;

/// <summary>
/// A lightweight browser surface used by workspace browser and project-output tabs.
/// Browser tabs deliberately use a profile that is separate from terminal WebView2
/// instances so ordinary web content keeps Chromium's normal site isolation.
/// </summary>
internal sealed class WorkspaceBrowserHost : UserControl, IDisposable
{
    private static readonly Brush SurfaceBrush = BrushFromRgb(8, 8, 8);
    private static readonly Brush ToolbarBrush = BrushFromRgb(14, 14, 14);
    private static readonly Brush FieldBrush = BrushFromRgb(20, 20, 20);
    private static readonly Brush OutlineBrush = BrushFromRgb(48, 48, 48);
    private static readonly Brush MutedTextBrush = BrushFromRgb(166, 166, 166);
    private static readonly object SharedEnvironmentLock = new();
    private static Task<CoreWebView2Environment>? _sharedEnvironmentTask;

    private readonly Button _backButton;
    private readonly Button _forwardButton;
    private readonly Button _reloadButton;
    private readonly TextBox _addressBox;
    private WebView2 _webView;
    private readonly TextBlock _errorText;
    private readonly string _initialUrl;
    private readonly bool _focusAddressOnReady;
    private readonly string? _localContentFolder;
    private readonly string? _virtualHostName;
    private readonly TaskCompletionSource<bool> _firstNavigationCompletion =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private Task? _initializationTask;
    private string? _pendingUrl;
    private Grid _browserSurface = null!;
    private bool _coreEventsAttached;
    private bool _tabActive;
    private bool _recoveringBrowserProcess;
    private long _tabActivityVersion;
    private bool _disposed;

    public WorkspaceBrowserHost(string? initialUrl = null, string? localContentFolder = null)
    {
        if (!string.IsNullOrWhiteSpace(localContentFolder) && Directory.Exists(localContentFolder))
        {
            _localContentFolder = Path.GetFullPath(localContentFolder);
            _virtualHostName = $"preview-{Guid.NewGuid():N}.ihatecoding.local";
            initialUrl = $"https://{_virtualHostName}/index.html";
        }
        _focusAddressOnReady = string.IsNullOrWhiteSpace(initialUrl);
        _initialUrl = NormalizeAddress(initialUrl);
        _pendingUrl = _initialUrl;

        Title = "새 탭";
        Url = _initialUrl;
        Background = SurfaceBrush;
        Focusable = true;

        _backButton = CreateToolbarButton("\u2190", "뒤로 (Alt+Left)");
        _forwardButton = CreateToolbarButton("\u2192", "앞으로 (Alt+Right)");
        _reloadButton = CreateToolbarButton("\u21BB", "새로고침 (F5)");
        _backButton.IsEnabled = false;
        _forwardButton.IsEnabled = false;
        _reloadButton.IsEnabled = false;

        _addressBox = new TextBox
        {
            Text = _focusAddressOnReady ? string.Empty : _initialUrl,
            Height = 27,
            Margin = new Thickness(4, 0, 0, 0),
            Padding = new Thickness(8, 3, 8, 3),
            VerticalContentAlignment = VerticalAlignment.Center,
            Background = FieldBrush,
            Foreground = Brushes.White,
            CaretBrush = Brushes.White,
            SelectionBrush = BrushFromRgb(75, 75, 75),
            BorderBrush = OutlineBrush,
            BorderThickness = new Thickness(1),
            FontFamily = new FontFamily("Segoe UI"),
            FontSize = 12,
            ToolTip = "주소 (Ctrl+L)",
        };

        _webView = CreateWebView();

        _errorText = new TextBlock
        {
            Visibility = Visibility.Collapsed,
            Margin = new Thickness(24),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Foreground = MutedTextBrush,
            FontFamily = new FontFamily("Segoe UI"),
            FontSize = 12,
            TextAlignment = TextAlignment.Center,
            TextWrapping = TextWrapping.Wrap,
        };

        Content = BuildLayout();

        _backButton.Click += OnBackClicked;
        _forwardButton.Click += OnForwardClicked;
        _reloadButton.Click += OnReloadClicked;
        _addressBox.KeyDown += OnAddressKeyDown;
        Loaded += OnLoaded;
        PreviewKeyDown += OnPreviewKeyDown;
    }

    public event EventHandler? TitleChanged;
    public event EventHandler? UrlChanged;

    public string Title { get; private set; }
    public string Url { get; private set; }
    public bool IsBrowserInitialized => _webView.CoreWebView2 is not null;
    public bool IsBrowserSuspended
    {
        get
        {
            try { return _webView.CoreWebView2?.IsSuspended == true; }
            catch { return false; }
        }
    }

    public async Task<bool> WaitForFirstNavigationAsync(TimeSpan timeout)
    {
        if (_disposed || timeout <= TimeSpan.Zero) return false;
        var navigation = _firstNavigationCompletion.Task;
        var completed = await Task.WhenAny(navigation, Task.Delay(timeout));
        return ReferenceEquals(completed, navigation) && await navigation;
    }

    public void SetTabActive(bool active)
    {
        if (_disposed) return;
        if (!Dispatcher.CheckAccess())
        {
            _ = Dispatcher.InvokeAsync(() => SetTabActive(active));
            return;
        }

        _tabActive = active;
        var activityVersion = ++_tabActivityVersion;
        if (active)
        {
            if (_webView.CoreWebView2 is { IsSuspended: true } core)
            {
                try { core.Resume(); } catch { }
            }
            if (IsLoaded) _ = EnsureInitializedAsync();
            return;
        }

        if (_webView.CoreWebView2 is { } inactiveCore)
            _ = SuspendWhenInactiveAsync(inactiveCore, activityVersion);
    }

    public Task EnsureInitializedAsync()
    {
        if (_disposed) return Task.CompletedTask;
        if (!Dispatcher.CheckAccess())
            return Dispatcher.InvokeAsync(EnsureInitializedAsync).Task.Unwrap();

        if (_initializationTask is { IsCompleted: true } && _webView.CoreWebView2 is null)
            _initializationTask = null;
        return _initializationTask ??= InitializeAsync();
    }

    public void Navigate(string? address)
    {
        if (_disposed) return;
        if (!Dispatcher.CheckAccess())
        {
            _ = Dispatcher.InvokeAsync(() => Navigate(address));
            return;
        }

        var normalized = NormalizeAddress(address);
        _pendingUrl = normalized;
        SetUrl(normalized);
        SetAddressText(normalized);
        HideError();

        if (_webView.CoreWebView2 is null)
        {
            if (IsLoaded) _ = EnsureInitializedAsync();
            return;
        }

        NavigateCore(normalized);
    }

    public void GoBack()
    {
        if (_disposed || _webView.CoreWebView2 is not { CanGoBack: true } core) return;
        core.GoBack();
    }

    public void GoForward()
    {
        if (_disposed || _webView.CoreWebView2 is not { CanGoForward: true } core) return;
        core.GoForward();
    }

    public void Reload()
    {
        if (_disposed) return;
        if (_webView.CoreWebView2 is { } core)
        {
            try
            {
                HideError();
                core.Reload();
            }
            catch
            {
                ShowError("브라우저 프로세스를 다시 연결하는 중입니다.");
                _ = Dispatcher.BeginInvoke(
                    DispatcherPriority.Background,
                    new Action(() => _ = RecoverBrowserProcessAsync()));
            }
        }
        else if (IsLoaded)
        {
            _ = EnsureInitializedAsync();
        }
    }

    public void FocusAddressBar()
    {
        if (_disposed) return;
        _ = _addressBox.Focus();
        _addressBox.SelectAll();
    }

    public void Dispose()
    {
        if (_disposed) return;
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.Invoke(Dispose);
            return;
        }

        _disposed = true;
        _firstNavigationCompletion.TrySetResult(false);
        Loaded -= OnLoaded;
        PreviewKeyDown -= OnPreviewKeyDown;
        _webView.PreviewKeyDown -= OnPreviewKeyDown;
        _backButton.Click -= OnBackClicked;
        _forwardButton.Click -= OnForwardClicked;
        _reloadButton.Click -= OnReloadClicked;
        _addressBox.KeyDown -= OnAddressKeyDown;
        DetachCoreEvents();
        if (_virtualHostName is not null)
        {
            try { _webView.CoreWebView2?.ClearVirtualHostNameToFolderMapping(_virtualHostName); }
            catch { }
        }
        try { _webView.Dispose(); } catch { }
    }

    private Grid BuildLayout()
    {
        var root = new Grid { Background = SurfaceBrush };
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(38) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var toolbar = new Grid
        {
            Background = ToolbarBrush,
            Margin = new Thickness(8, 0, 8, 0),
        };
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        Grid.SetColumn(_backButton, 0);
        Grid.SetColumn(_forwardButton, 1);
        Grid.SetColumn(_reloadButton, 2);
        Grid.SetColumn(_addressBox, 3);
        toolbar.Children.Add(_backButton);
        toolbar.Children.Add(_forwardButton);
        toolbar.Children.Add(_reloadButton);
        toolbar.Children.Add(_addressBox);

        var toolbarBorder = new Border
        {
            Background = ToolbarBrush,
            BorderBrush = OutlineBrush,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = toolbar,
        };
        Grid.SetRow(toolbarBorder, 0);
        root.Children.Add(toolbarBorder);

        _browserSurface = new Grid { Background = SurfaceBrush };
        _browserSurface.Children.Add(_webView);
        _browserSurface.Children.Add(_errorText);
        Grid.SetRow(_browserSurface, 1);
        root.Children.Add(_browserSurface);
        return root;
    }

    private WebView2 CreateWebView()
    {
        var webView = new WebView2
        {
            DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 8, 8, 8),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
            Focusable = true,
        };
        webView.PreviewKeyDown += OnPreviewKeyDown;
        return webView;
    }

    private async Task InitializeAsync()
    {
        try
        {
            var environment = await GetSharedEnvironmentAsync();
            if (_disposed) return;

            var webView = _webView;
            await webView.EnsureCoreWebView2Async(environment);
            if (_disposed || !ReferenceEquals(webView, _webView) || webView.CoreWebView2 is null)
                return;

            var core = webView.CoreWebView2;
            var settings = core.Settings;
            settings.AreDefaultContextMenusEnabled = true;
            settings.AreDevToolsEnabled = true;
            settings.AreBrowserAcceleratorKeysEnabled = true;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = true;
            settings.IsBuiltInErrorPageEnabled = true;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;

            AttachCoreEvents(core);
            if (_virtualHostName is not null && _localContentFolder is not null)
            {
                core.SetVirtualHostNameToFolderMapping(
                    _virtualHostName,
                    _localContentFolder,
                    CoreWebView2HostResourceAccessKind.DenyCors);
            }
            _reloadButton.IsEnabled = true;

            var destination = _pendingUrl ?? _initialUrl;
            _pendingUrl = null;
            NavigateCore(destination);

            if (_focusAddressOnReady)
            {
                await Dispatcher.InvokeAsync(
                    FocusAddressBar,
                    DispatcherPriority.Input);
            }
        }
        catch (Exception exception)
        {
            if (!_disposed)
            {
                ShowError($"브라우저를 시작하지 못했습니다.\n{exception.Message}");
                _initializationTask = null;
            }
        }
    }

    private void AttachCoreEvents(CoreWebView2 core)
    {
        if (_coreEventsAttached) return;
        _coreEventsAttached = true;
        core.HistoryChanged += OnHistoryChanged;
        core.SourceChanged += OnSourceChanged;
        core.DocumentTitleChanged += OnDocumentTitleChanged;
        core.NavigationStarting += OnNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        core.NewWindowRequested += OnNewWindowRequested;
        core.ProcessFailed += OnProcessFailed;
    }

    private void DetachCoreEvents()
    {
        if (!_coreEventsAttached) return;
        _coreEventsAttached = false;
        try
        {
            if (_webView.CoreWebView2 is not { } core) return;
            core.HistoryChanged -= OnHistoryChanged;
            core.SourceChanged -= OnSourceChanged;
            core.DocumentTitleChanged -= OnDocumentTitleChanged;
            core.NavigationStarting -= OnNavigationStarting;
            core.NavigationCompleted -= OnNavigationCompleted;
            core.NewWindowRequested -= OnNewWindowRequested;
            core.ProcessFailed -= OnProcessFailed;
        }
        catch
        {
            // The COM controller can already be gone after a browser-process crash.
        }
    }

    private void NavigateCore(string destination)
    {
        if (_disposed || _webView.CoreWebView2 is null) return;
        try
        {
            HideError();
            _webView.CoreWebView2.Navigate(destination);
        }
        catch (Exception exception)
        {
            ShowError($"이 주소를 열지 못했습니다.\n{exception.Message}");
        }
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (!_disposed && _tabActive) _ = EnsureInitializedAsync();
    }

    private async Task SuspendWhenInactiveAsync(CoreWebView2 core, long activityVersion)
    {
        try
        {
            await Dispatcher.Yield(DispatcherPriority.ContextIdle);
            if (_disposed ||
                _tabActive ||
                activityVersion != _tabActivityVersion ||
                Visibility == Visibility.Visible ||
                !ReferenceEquals(core, _webView.CoreWebView2))
                return;

            _ = await core.TrySuspendAsync();
            if (!_disposed &&
                (_tabActive || activityVersion != _tabActivityVersion) &&
                ReferenceEquals(core, _webView.CoreWebView2) &&
                core.IsSuspended)
                core.Resume();
        }
        catch
        {
            // A tab may be closed or its browser process may exit while suspension is pending.
        }
    }

    private void OnBackClicked(object sender, RoutedEventArgs e) => GoBack();
    private void OnForwardClicked(object sender, RoutedEventArgs e) => GoForward();
    private void OnReloadClicked(object sender, RoutedEventArgs e) => Reload();

    private void OnAddressKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            Navigate(_addressBox.Text);
            _ = _webView.Focus();
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            SetAddressText(Url);
            _ = _webView.Focus();
        }
    }

    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.L && Keyboard.Modifiers.HasFlag(ModifierKeys.Control))
        {
            e.Handled = true;
            FocusAddressBar();
        }
        else if (e.Key == Key.F5)
        {
            e.Handled = true;
            Reload();
        }
        else if ((e.Key == Key.Left || e.SystemKey == Key.Left) &&
                 Keyboard.Modifiers.HasFlag(ModifierKeys.Alt))
        {
            e.Handled = true;
            GoBack();
        }
        else if ((e.Key == Key.Right || e.SystemKey == Key.Right) &&
                 Keyboard.Modifiers.HasFlag(ModifierKeys.Alt))
        {
            e.Handled = true;
            GoForward();
        }
    }

    private void OnHistoryChanged(object? sender, object e) => RefreshNavigationButtons();

    private void OnSourceChanged(object? sender, CoreWebView2SourceChangedEventArgs e)
    {
        if (_webView.CoreWebView2 is { } core) UpdateDisplayedUrl(core.Source);
    }

    private void OnDocumentTitleChanged(object? sender, object e)
    {
        if (_webView.CoreWebView2 is { } core) SetTitle(ResolveTitle(core));
    }

    private void OnNavigationStarting(
        object? sender,
        CoreWebView2NavigationStartingEventArgs e)
    {
        HideError();
        UpdateDisplayedUrl(e.Uri);
    }

    private void OnNavigationCompleted(
        object? sender,
        CoreWebView2NavigationCompletedEventArgs e)
    {
        _firstNavigationCompletion.TrySetResult(e.IsSuccess);
        RefreshNavigationButtons();
        if (_webView.CoreWebView2 is { } core)
        {
            UpdateDisplayedUrl(core.Source);
            SetTitle(ResolveTitle(core));
            if (!_tabActive)
                _ = SuspendWhenInactiveAsync(core, _tabActivityVersion);
        }
    }

    private void OnNewWindowRequested(
        object? sender,
        CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!string.IsNullOrWhiteSpace(e.Uri)) Navigate(e.Uri);
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        if (_disposed) return;
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            ShowError("브라우저 프로세스를 다시 연결하는 중입니다.");
            _ = Dispatcher.BeginInvoke(
                DispatcherPriority.Background,
                new Action(() => _ = RecoverBrowserProcessAsync()));
            return;
        }

        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
        {
            try
            {
                _webView.CoreWebView2?.Reload();
                return;
            }
            catch
            {
                ShowError("브라우저 프로세스를 다시 연결하는 중입니다.");
                _ = Dispatcher.BeginInvoke(
                    DispatcherPriority.Background,
                    new Action(() => _ = RecoverBrowserProcessAsync()));
                return;
            }
        }

        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
            ShowError("페이지가 응답하지 않습니다. F5를 눌러 다시 불러오세요.");
    }

    private async Task RecoverBrowserProcessAsync()
    {
        if (_disposed || _recoveringBrowserProcess) return;
        _recoveringBrowserProcess = true;
        try
        {
            var destination = Url;
            var previous = _webView;
            DetachCoreEvents();
            previous.PreviewKeyDown -= OnPreviewKeyDown;
            if (_virtualHostName is not null)
            {
                try
                {
                    previous.CoreWebView2?.ClearVirtualHostNameToFolderMapping(_virtualHostName);
                }
                catch
                {
                }
            }

            _browserSurface.Children.Remove(previous);
            try { previous.Dispose(); } catch { }

            _webView = CreateWebView();
            _browserSurface.Children.Insert(0, _webView);
            _pendingUrl = destination;
            _initializationTask = null;
            await EnsureInitializedAsync();
            if (!_tabActive && _webView.CoreWebView2 is { } core)
                _ = SuspendWhenInactiveAsync(core, _tabActivityVersion);
        }
        finally
        {
            _recoveringBrowserProcess = false;
        }
    }

    private void RefreshNavigationButtons()
    {
        if (_disposed || _webView.CoreWebView2 is not { } core) return;
        _backButton.IsEnabled = core.CanGoBack;
        _forwardButton.IsEnabled = core.CanGoForward;
        _reloadButton.IsEnabled = true;
    }

    private void UpdateDisplayedUrl(string? value)
    {
        var url = string.IsNullOrWhiteSpace(value) ? "about:blank" : value;
        SetUrl(url);
        if (!_addressBox.IsKeyboardFocusWithin) SetAddressText(url);
    }

    private void SetTitle(string title)
    {
        if (string.Equals(Title, title, StringComparison.Ordinal)) return;
        Title = title;
        TitleChanged?.Invoke(this, EventArgs.Empty);
    }

    private void SetUrl(string url)
    {
        if (string.Equals(Url, url, StringComparison.Ordinal)) return;
        Url = url;
        UrlChanged?.Invoke(this, EventArgs.Empty);
    }

    private void SetAddressText(string url)
    {
        _addressBox.Text = string.Equals(url, "about:blank", StringComparison.OrdinalIgnoreCase)
            ? string.Empty
            : url;
        _addressBox.CaretIndex = _addressBox.Text.Length;
    }

    private void ShowError(string message)
    {
        _errorText.Text = message;
        _errorText.Visibility = Visibility.Visible;
    }

    private void HideError() => _errorText.Visibility = Visibility.Collapsed;

    private static string ResolveTitle(CoreWebView2 core)
    {
        if (!string.IsNullOrWhiteSpace(core.DocumentTitle)) return core.DocumentTitle.Trim();
        if (string.Equals(core.Source, "about:blank", StringComparison.OrdinalIgnoreCase))
            return "새 탭";
        return Uri.TryCreate(core.Source, UriKind.Absolute, out var uri) &&
               !string.IsNullOrWhiteSpace(uri.Host)
            ? uri.Host
            : "브라우저";
    }

    private static string NormalizeAddress(string? address)
    {
        var value = address?.Trim();
        if (string.IsNullOrWhiteSpace(value)) return "about:blank";

        if (Path.IsPathFullyQualified(value) &&
            (File.Exists(value) || Directory.Exists(value)))
            return new Uri(value).AbsoluteUri;

        // "localhost:3000" is otherwise parsed as a custom URI scheme by .NET.
        // Project-output tabs expect it to mean an ordinary local HTTP server.
        if (IsLocalDevelopmentAddress(value) && !value.Contains("://", StringComparison.Ordinal))
            return Uri.TryCreate("http://" + value, UriKind.Absolute, out var local)
                ? local.AbsoluteUri
                : "about:blank";

        if (Uri.TryCreate(value, UriKind.Absolute, out var absolute))
            return IsAllowedScheme(absolute) ? absolute.AbsoluteUri : "about:blank";

        var scheme = IsLocalDevelopmentAddress(value) ? "http://" : "https://";
        return Uri.TryCreate(scheme + value, UriKind.Absolute, out absolute)
            ? IsAllowedScheme(absolute) ? absolute.AbsoluteUri : "about:blank"
            : "about:blank";
    }

    private static bool IsAllowedScheme(Uri address) =>
        address.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
        address.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
        address.Scheme.Equals(Uri.UriSchemeFile, StringComparison.OrdinalIgnoreCase) ||
        address.AbsoluteUri.Equals("about:blank", StringComparison.OrdinalIgnoreCase);

    private static bool IsLocalDevelopmentAddress(string value)
    {
        var candidate = value.Contains("://", StringComparison.Ordinal)
            ? value
            : "http://" + value;
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var address)) return false;

        var host = address.Host;
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
            host.Equals("0.0.0.0", StringComparison.OrdinalIgnoreCase))
            return true;
        return IPAddress.TryParse(host, out var ipAddress) && IPAddress.IsLoopback(ipAddress);
    }

    private static Button CreateToolbarButton(string glyph, string toolTip) => new()
    {
        Content = glyph,
        Width = 30,
        Height = 27,
        Margin = new Thickness(0, 0, 4, 0),
        Padding = new Thickness(0),
        HorizontalContentAlignment = HorizontalAlignment.Center,
        VerticalContentAlignment = VerticalAlignment.Center,
        Background = ToolbarBrush,
        Foreground = Brushes.White,
        BorderBrush = OutlineBrush,
        BorderThickness = new Thickness(1),
        FontFamily = new FontFamily("Segoe UI Symbol"),
        FontSize = 14,
        Focusable = false,
        ToolTip = toolTip,
    };

    private static Brush BrushFromRgb(byte red, byte green, byte blue)
    {
        var brush = new SolidColorBrush(Color.FromRgb(red, green, blue));
        brush.Freeze();
        return brush;
    }

    private static async Task<CoreWebView2Environment> CreateSharedEnvironmentAsync()
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "XXCODING",
            "BrowserWebView2");
        Directory.CreateDirectory(userDataFolder);

        // Do not copy the terminal environment's site-isolation-disabling flags.
        // This profile displays arbitrary web content and uses Chromium defaults.
        return await CoreWebView2Environment.CreateAsync(null, userDataFolder);
    }

    private static Task<CoreWebView2Environment> GetSharedEnvironmentAsync()
    {
        lock (SharedEnvironmentLock)
        {
            if (_sharedEnvironmentTask is null ||
                _sharedEnvironmentTask.IsFaulted ||
                _sharedEnvironmentTask.IsCanceled)
                _sharedEnvironmentTask = CreateSharedEnvironmentAsync();
            return _sharedEnvironmentTask;
        }
    }
}
