using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class PracticeLauncher
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string FindScript()
    {
        string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        string releaseRoot = Path.Combine(baseDirectory, "release");
        if (Directory.Exists(releaseRoot))
        {
            string[] releaseDirectories = Directory.GetDirectories(releaseRoot);
            foreach (string releaseDirectory in releaseDirectories)
            {
                if (releaseDirectory.IndexOf("EXE", StringComparison.OrdinalIgnoreCase) < 0) continue;
                string candidate = Path.Combine(releaseDirectory, "app", "scripts", "start-practice.ps1");
                if (File.Exists(candidate)) return candidate;
            }
        }
        string[] candidates = new[]
        {
            Path.Combine(baseDirectory, "app", "scripts", "start-practice.ps1"),
            Path.Combine(baseDirectory, "apps", "speaking-practice", "scripts", "start-practice.ps1")
        };

        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static string ReadTail(string value, int maxLength)
    {
        if (String.IsNullOrWhiteSpace(value)) return String.Empty;
        value = value.Trim();
        return value.Length <= maxLength ? value : value.Substring(value.Length - maxLength);
    }

    private static void ShowFailure(string message)
    {
        MessageBox.Show(message, "\u53e3\u8bed\u8ddf\u7ec3\u5ba4\u542f\u52a8\u5931\u8d25", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static string ReadLogs(string logDirectory)
    {
        string[] candidates = new[]
        {
            Path.Combine(logDirectory, "speaking-practice-service.stderr.log"),
            Path.Combine(logDirectory, "speaking-practice.stderr.log"),
            Path.Combine(logDirectory, "speaking-practice-service.stdout.log")
        };
        foreach (string candidate in candidates)
        {
            if (!File.Exists(candidate)) continue;
            string text = ReadTail(File.ReadAllText(candidate), 2400);
            if (!String.IsNullOrWhiteSpace(text)) return text;
        }
        return String.Empty;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string scriptPath = FindScript();
            if (scriptPath == null)
            {
                ShowFailure("\u627e\u4e0d\u5230\u542f\u52a8\u811a\u672c\u3002\u8bf7\u786e\u8ba4 EXE \u4ecd\u653e\u5728\u53e3\u8bed\u8ddf\u7ec3\u5ba4\u8fd0\u884c\u5305\u76ee\u5f55\u5185\u3002\n\n\u8fd0\u884c\u5305\u4e0d\u80fd\u53ea\u4fdd\u7559\u4e00\u4e2a EXE \u6587\u4ef6\u3002\n\u5efa\u8bae\u68c0\u67e5\uff1aapp\\scripts\\start-practice.ps1");
                return 2;
            }

            int preferredPort = 4321;
            bool noOpen = false;
            for (int index = 0; index < args.Length; index++)
            {
                if (String.Equals(args[index], "--no-open", StringComparison.OrdinalIgnoreCase))
                {
                    noOpen = true;
                }
                else if (String.Equals(args[index], "--port", StringComparison.OrdinalIgnoreCase) && index + 1 < args.Length)
                {
                    int parsedPort;
                    if (Int32.TryParse(args[++index], out parsedPort) && parsedPort >= 1024 && parsedPort <= 65535)
                    {
                        preferredPort = parsedPort;
                    }
                }
            }

            string appDirectory = Path.GetDirectoryName(Path.GetDirectoryName(scriptPath));
            string logDirectory = Path.Combine(appDirectory, ".launcher");
            string arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File " + Quote(scriptPath) + " -PreferredPort " + preferredPort;
            if (noOpen) arguments += " -NoOpen";

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = arguments,
                WorkingDirectory = appDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            using (Process process = Process.Start(startInfo))
            {
                if (process == null)
                {
                    ShowFailure("\u65e0\u6cd5\u542f\u52a8 PowerShell\u3002\n\n\u8bf7\u786e\u8ba4 Windows PowerShell \u53ef\u7528\u3002");
                    return 3;
                }

                process.WaitForExit();

                if (process.ExitCode != 0)
                {
                    string detail = ReadLogs(logDirectory);
                    string text = "\u672c\u5730\u670d\u52a1\u6ca1\u6709\u6210\u529f\u542f\u52a8\u3002";
                    if (!String.IsNullOrWhiteSpace(detail)) text += "\n\n" + detail;
                    text += "\n\n\u65e5\u5fd7\u76ee\u5f55\uff1a" + logDirectory;
                    ShowFailure(text);
                    return process.ExitCode;
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            ShowFailure("\u542f\u52a8\u5668\u53d1\u751f\u9519\u8bef\uff1a\n\n" + error.Message);
            return 1;
        }
    }
}
