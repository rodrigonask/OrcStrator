// OrcStrator.exe: the no-console starter that the installer's shortcuts point at.
//
// It does one thing: start the launcher (a setup.ps1) in Windows PowerShell 5.1
// with no console window, then exit. The launcher shows its own window. Any
// arguments are passed through unchanged.
//
// Which setup.ps1 (launcher self-update). MIRRORED by Resolve-OrcLauncherScript
// in installer/setup.ps1; installer/test-launcher-self-update.ps1 checks the two
// agree on every case:
//
//   1. {app} (this exe's folder) is a git checkout: {app}\installer\setup.ps1.
//   2. <data root>\app\current.txt names a version (strict regex), and
//      <data root>\app\versions\<v>\installer\setup.ps1 exists, stays inside
//      <data root>\app\versions and carries the starter contract marker: run
//      THAT copy with -LauncherRoot {app}. That payload was signature and hash
//      verified by the launcher when it was installed, so launcher fixes and
//      key rotations reach installs through normal updates.
//   3. Anything else: {app}\installer\setup.ps1, as before.
//
// Data root, exactly as setup.ps1 resolves it for an installed copy:
// ORCSTRATOR_DATA_DIR (trimmed) when set, else %LOCALAPPDATA%\OrcStrator.
//
//   OrcStrator.exe --print-launcher [<file>]
//     Starts nothing. Writes "script=<path>", "launcherRoot=<path or empty>"
//     and "source=<dev|version|app>" to stdout and, when given, to <file>.
//     Used by installer/release/Assert-InstalledApp.ps1 and the tests.
//
// Compiled at release time by installer/release/Build-Installer.ps1 with the
// .NET Framework csc.exe that ships with Windows, so the build needs no SDK.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;

[assembly: AssemblyTitle("OrcStrator")]
[assembly: AssemblyProduct("OrcStrator")]
[assembly: AssemblyDescription("OrcStrator launcher")]

internal static class OrcStarter
{
    // Must match $versionPattern in Resolve-OrcLauncherScript (setup.ps1).
    private const string VersionPattern = @"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$";
    // Only a setup.ps1 that understands -LauncherRoot carries this line.
    private const string ContractMarker = "orc-starter-contract: launcher-root-v1";
    private const string PrintFlag = "--print-launcher";

    private static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
            sb.Append('\\', slashes); slashes = 0; sb.Append(c);
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private sealed class Pick
    {
        public string Script;
        public string LauncherRoot = "";
        public string Source = "app";
    }

    private static Pick Resolve(string appDir)
    {
        string app = Path.GetFullPath(appDir).TrimEnd('\\');
        var pick = new Pick { Script = Path.Combine(Path.Combine(app, "installer"), "setup.ps1") };
        try
        {
            string gitPath = Path.Combine(app, ".git");
            if (Directory.Exists(gitPath) || File.Exists(gitPath)) { pick.Source = "dev"; return pick; }

            string dataRoot = (Environment.GetEnvironmentVariable("ORCSTRATOR_DATA_DIR") ?? "").Trim();
            if (dataRoot.Length == 0)
            {
                string lad = Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "";
                if (lad.Length == 0) return pick;
                dataRoot = Path.Combine(lad, "OrcStrator");
            }
            string appData = Path.Combine(dataRoot, "app");
            string cur = Path.Combine(appData, "current.txt");
            if (!File.Exists(cur)) return pick;
            string v = File.ReadAllText(cur).Trim().TrimStart((char)0xFEFF).Trim();
            if (!Regex.IsMatch(v, VersionPattern, RegexOptions.CultureInvariant)) return pick;

            string versions = Path.GetFullPath(Path.Combine(appData, "versions")).TrimEnd('\\') + "\\";
            string candidate = Path.GetFullPath(Path.Combine(Path.Combine(Path.Combine(versions, v), "installer"), "setup.ps1"));
            if (!candidate.StartsWith(versions, StringComparison.OrdinalIgnoreCase)) return pick;
            if (!File.Exists(candidate)) return pick;
            if (File.ReadAllText(candidate).IndexOf(ContractMarker, StringComparison.Ordinal) < 0) return pick;

            pick.Script = candidate;
            pick.LauncherRoot = app;
            pick.Source = "version";
        }
        catch
        {
            // Any surprise: the launcher the installer put next to this exe.
            pick = new Pick { Script = Path.Combine(Path.Combine(app, "installer"), "setup.ps1") };
        }
        return pick;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        Pick pick = Resolve(dir);

        if (args.Length > 0 && args[0] == PrintFlag)
        {
            string text = "script=" + pick.Script + "\r\nlauncherRoot=" + pick.LauncherRoot + "\r\nsource=" + pick.Source + "\r\n";
            try { Console.Out.Write(text); Console.Out.Flush(); } catch { }
            if (args.Length > 1)
            {
                try { File.WriteAllText(args[1], text, new UTF8Encoding(false)); } catch { return 1; }
            }
            return 0;
        }

        if (!File.Exists(pick.Script)) return 2;

        string ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                                 @"WindowsPowerShell\v1.0\powershell.exe");
        if (!File.Exists(ps)) ps = "powershell.exe";

        var cmd = new StringBuilder("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ");
        cmd.Append(Quote(pick.Script));
        if (pick.LauncherRoot.Length > 0) { cmd.Append(" -LauncherRoot "); cmd.Append(Quote(pick.LauncherRoot)); }
        foreach (string a in args) { cmd.Append(' '); cmd.Append(Quote(a)); }

        var psi = new ProcessStartInfo(ps, cmd.ToString());
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = dir;
        try { Process.Start(psi); } catch { return 1; }
        return 0;
    }
}
