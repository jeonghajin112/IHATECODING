using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Win32;

namespace PowerWorkspace;

internal sealed class ProjectDialog : Window
{
    private static readonly SolidColorBrush BackgroundBrush = Brush("#050505");
    private static readonly SolidColorBrush SurfaceBrush = Brush("#111112");
    private static readonly SolidColorBrush DialogBorderBrush = Brush("#303034");
    private static readonly SolidColorBrush TextBrush = Brush("#F4F4F5");
    private static readonly SolidColorBrush MutedBrush = Brush("#85858C");
    private static readonly SolidColorBrush AccentBrush = Brush("#F4F4F5");

    private readonly TextBox _nameBox = InputBox();
    private readonly TextBox _folderBox = InputBox();
    private readonly string? _initialFolder;

    public ProjectDialog(string? initialFolder)
    {
        Title = "새 프로젝트 · IHATECODING";
        Width = 620;
        Height = 270;
        MinWidth = 520;
        MinHeight = 270;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ShowInTaskbar = false;
        Background = BackgroundBrush;
        Foreground = TextBrush;
        FontFamily = new FontFamily("Segoe UI Variable Text");
        SourceInitialized += (_, _) => EnableDarkTitleBar(new WindowInteropHelper(this).Handle);

        _initialFolder = initialFolder;
        _nameBox.MaxLength = 50;
        _folderBox.IsReadOnly = true;

        var folderButton = DialogButton("폴더 선택", SurfaceBrush);
        folderButton.Width = 84;
        folderButton.Click += (_, _) => SelectFolder();

        var folderGrid = new Grid();
        folderGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        folderGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(92) });
        folderGrid.Children.Add(_folderBox);
        Grid.SetColumn(folderButton, 1);
        folderGrid.Children.Add(folderButton);

        var form = new Grid { Margin = new Thickness(26, 22, 26, 20) };
        form.RowDefinitions.Add(new RowDefinition { Height = new GridLength(22) });
        form.RowDefinitions.Add(new RowDefinition { Height = new GridLength(36) });
        form.RowDefinitions.Add(new RowDefinition { Height = new GridLength(12) });
        form.RowDefinitions.Add(new RowDefinition { Height = new GridLength(22) });
        form.RowDefinitions.Add(new RowDefinition { Height = new GridLength(36) });
        form.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        form.RowDefinitions.Add(new RowDefinition { Height = new GridLength(32) });

        AddAt(form, Label("프로젝트 이름"), 0);
        AddAt(form, _nameBox, 1);
        AddAt(form, Label("프로젝트 폴더"), 3);
        AddAt(form, folderGrid, 4);

        var createButton = DialogButton("만들기", AccentBrush);
        createButton.Width = 78;
        createButton.IsDefault = true;
        createButton.Click += (_, _) => CreateProject();
        var cancelButton = DialogButton("취소", SurfaceBrush);
        cancelButton.Width = 70;
        cancelButton.IsCancel = true;

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        actions.Children.Add(cancelButton);
        createButton.Margin = new Thickness(8, 0, 0, 0);
        actions.Children.Add(createButton);
        AddAt(form, actions, 6);
        Content = form;

        Loaded += (_, _) =>
        {
            _nameBox.Focus();
            _nameBox.SelectAll();
        };
    }

    public string ProjectName { get; private set; } = string.Empty;
    public string ProjectFolder { get; private set; } = string.Empty;

    private void SelectFolder()
    {
        var initialDirectory = Directory.Exists(_folderBox.Text)
            ? _folderBox.Text
            : !string.IsNullOrWhiteSpace(_initialFolder) && Directory.Exists(_initialFolder)
                ? _initialFolder
                : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var dialog = new OpenFolderDialog
        {
            Title = "프로젝트 폴더 선택",
            InitialDirectory = initialDirectory,
            Multiselect = false,
        };
        if (dialog.ShowDialog(this) != true) return;

        _folderBox.Text = dialog.FolderName;
        if (_nameBox.Text.Trim().Length == 0)
            _nameBox.Text = Path.GetFileName(dialog.FolderName.TrimEnd(Path.DirectorySeparatorChar)) is { Length: > 0 } name
                ? name
                : "새 프로젝트";
    }

    private void CreateProject()
    {
        var name = _nameBox.Text.Trim();
        var folder = _folderBox.Text.Trim();
        if (name.Length == 0)
        {
            MessageBox.Show(this, "프로젝트 이름을 입력하세요.", "프로젝트", MessageBoxButton.OK, MessageBoxImage.Information);
            _nameBox.Focus();
            return;
        }
        if (!Directory.Exists(folder))
        {
            MessageBox.Show(this, "사용할 프로젝트 폴더를 선택하세요.", "프로젝트", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        ProjectName = name;
        ProjectFolder = Path.GetFullPath(folder);
        DialogResult = true;
    }

    private static TextBox InputBox() => new()
    {
        Height = 30,
        Padding = new Thickness(8, 3, 8, 3),
        VerticalContentAlignment = VerticalAlignment.Center,
        Background = SurfaceBrush,
        Foreground = TextBrush,
        BorderBrush = DialogBorderBrush,
        BorderThickness = new Thickness(1),
        FontSize = 12,
    };

    private static TextBlock Label(string text) => new()
    {
        Text = text,
        Foreground = MutedBrush,
        FontSize = 11,
        VerticalAlignment = VerticalAlignment.Center,
    };

    private static Button DialogButton(string text, Brush background) => new()
    {
        Content = text,
        Height = 32,
        Background = background,
        Foreground = ReferenceEquals(background, AccentBrush) ? BackgroundBrush : TextBrush,
        BorderBrush = ReferenceEquals(background, AccentBrush) ? TextBrush : DialogBorderBrush,
        BorderThickness = new Thickness(1),
        FontWeight = FontWeights.SemiBold,
        Cursor = System.Windows.Input.Cursors.Hand,
    };

    private static void AddAt(Grid grid, UIElement element, int row)
    {
        Grid.SetRow(element, row);
        grid.Children.Add(element);
    }

    private static SolidColorBrush Brush(string value)
    {
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(value));
        brush.Freeze();
        return brush;
    }

    private static void EnableDarkTitleBar(IntPtr window)
    {
        var enabled = 1;
        if (DwmSetWindowAttribute(window, 20, ref enabled, sizeof(int)) != 0)
            _ = DwmSetWindowAttribute(window, 19, ref enabled, sizeof(int));
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        IntPtr window,
        int attribute,
        ref int value,
        int valueSize);
}
