// NAgex UIA Test Harness — WPF variant.
//
// Supersedes the WinForms variants for real UIA pattern proof: WinForms
// controls on this real host were verified (empirically, across multiple
// diagnostic passes) to expose zero UIA control patterns at all —
// GetCurrentPattern threw "Unsupported Pattern" for ValuePattern on a
// plain TextBox and InvokePattern on a plain Button, and
// GetSupportedPatterns() returned an empty list — apparently because this
// host's WinForms-to-UIA MSAA bridge does not resolve WindowsForms10.*
// window classes to proper control roles/patterns. WPF has a first-class,
// built-in native UI Automation peer for every control (no MSAA bridging
// involved at all), which is what actually lets this harness prove the
// required patterns on this specific host.
//
// Same safety properties as the other harness variants: zero file I/O,
// zero user data, deterministic AutomationIds (set via
// AutomationProperties.AutomationId, WPF's real, natively-supported
// mechanism), graceful-only close (no kill affordance exposed anywhere in
// this source).
using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace NagexUiaTestHarnessWpf
{
    public class HarnessWindow : Window
    {
        private int clickCount = 0;
        private Label statusLabel;

        public HarnessWindow(string instanceTag)
        {
            Title = "NAgex UIA Test Harness [" + instanceTag + "]";
            Width = 420;
            Height = 460;
            var panel = new StackPanel { Margin = new Thickness(10) };

            var textInput = new TextBox { Height = 24, Margin = new Thickness(0, 0, 0, 8) };
            AutomationProperties.SetAutomationId(textInput, "NagexTestTextInput");
            panel.Children.Add(textInput);

            var buttonRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 8) };
            var button = new Button { Content = "NAgex Test Button", Width = 160 };
            AutomationProperties.SetAutomationId(button, "NagexTestButton");
            statusLabel = new Label { Content = "ClickCount=0", Margin = new Thickness(10, 0, 0, 0) };
            AutomationProperties.SetAutomationId(statusLabel, "NagexTestStatusLabel");
            button.Click += (s, e) => { clickCount += 1; statusLabel.Content = "ClickCount=" + clickCount; };
            buttonRow.Children.Add(button);
            buttonRow.Children.Add(statusLabel);
            panel.Children.Add(buttonRow);

            var checkbox = new CheckBox { Content = "NAgex Test Checkbox", Margin = new Thickness(0, 0, 0, 8) };
            AutomationProperties.SetAutomationId(checkbox, "NagexTestCheckbox");
            panel.Children.Add(checkbox);

            var listBox = new ListBox { Height = 80, Margin = new Thickness(0, 0, 0, 8) };
            AutomationProperties.SetAutomationId(listBox, "NagexTestListBox");
            var itemA = new ListBoxItem { Content = "NagexTestItemA" };
            var itemB = new ListBoxItem { Content = "NagexTestItemB" };
            var itemC = new ListBoxItem { Content = "NagexTestItemC" };
            AutomationProperties.SetAutomationId(itemA, "NagexTestItemA");
            AutomationProperties.SetAutomationId(itemB, "NagexTestItemB");
            AutomationProperties.SetAutomationId(itemC, "NagexTestItemC");
            listBox.Items.Add(itemA);
            listBox.Items.Add(itemB);
            listBox.Items.Add(itemC);
            panel.Children.Add(listBox);

            var scrollViewer = new ScrollViewer { Height = 100, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Margin = new Thickness(0, 0, 0, 8) };
            AutomationProperties.SetAutomationId(scrollViewer, "NagexTestScrollPanel");
            var scrollContent = new StackPanel();
            for (int i = 0; i < 30; i++)
            {
                scrollContent.Children.Add(new Label { Content = "NagexScrollRow" + i });
            }
            scrollViewer.Content = scrollContent;
            panel.Children.Add(scrollViewer);

            var closeButton = new Button { Content = "Close", Width = 80, HorizontalAlignment = HorizontalAlignment.Left };
            AutomationProperties.SetAutomationId(closeButton, "NagexTestCloseButton");
            closeButton.Click += (s, e) => Close();
            panel.Children.Add(closeButton);

            Content = panel;
        }

        [STAThread]
        public static void Main(string[] args)
        {
            string tag = args.Length > 0 ? args[0] : "default";
            var app = new Application();
            app.Run(new HarnessWindow(tag));
        }
    }
}
