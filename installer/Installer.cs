using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Installer {
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
    internal static readonly string[] SavedFiles = { "state.json", "naver-auth.json", "coupang-auth.json", "ably-auth.json", "baemin-auth.json", "coupangeats-auth.json", "openai-key.json" };
    [STAThread] static int Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try {
            if (args.Length >= 2 && args[0] == "--test-install") {
                string root = Path.GetFullPath(args[1]);
                if (!root.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(root).StartsWith("review-installer-test-")) return 2;
                string source = null; int port = 14329;
                for (int i = 2; i + 1 < args.Length; i += 2) { if (args[i] == "--legacy") source = args[i + 1]; else if (args[i] == "--port") port = Int32.Parse(args[i + 1]); else return 2; }
                if (port == 4317 || port < 1024 || port > 65535) return 2;
                Install(root, source, port, Path.Combine(root, "test-desktop"), Path.Combine(root, "test-menu"), delegate(string text) { });
                return 0;
            }
            using (var mutex = new Mutex(false, "Local\\ReviewDeskInstaller")) {
                if (!mutex.WaitOne(0)) { MessageBox.Show("설치가 이미 진행 중입니다.", "Review Desk"); return 1; }
                try { Application.Run(new SetupWindow()); } finally { mutex.ReleaseMutex(); }
            }
            return 0;
        } catch (Exception error) {
            if (args.Length > 0) { try { File.WriteAllText(Path.Combine(Path.GetFullPath(args[1]), "test-error.txt"), error.GetType().Name + ": " + error.Message); } catch { } return 1; }
            MessageBox.Show("설치를 완료하지 못했습니다. 기존 프로그램과 저장 정보는 유지됩니다.\n" + Friendly(error), "Review Desk", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
    }
    internal static string Friendly(Exception error) { return error is SetupException ? error.Message : "프로그램 폴더의 쓰기 권한과 디스크 여유 공간을 확인한 뒤 다시 실행해 주세요."; }
    internal static bool HasData(string directory) { foreach (string name in SavedFiles) if (File.Exists(Path.Combine(directory, name))) return true; return false; }
    internal static bool IsLegacy(string root) {
        try { var pkg = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "package.json"))); return Convert.ToString(pkg["name"]) == "teawest-review-desk" && HasData(Path.Combine(root, ".local")); } catch { return false; }
    }
    internal static Dictionary<string, object> Request(int port, string route, object post, int timeout) {
        string origin = "http://127.0.0.1:" + port;
        var request = (HttpWebRequest)WebRequest.Create(origin + route);
        request.Proxy = null; request.Timeout = timeout; request.ReadWriteTimeout = timeout; request.AllowAutoRedirect = false;
        if (post != null) {
            var session = Request(port, "/api/session", null, 5000);
            request.Method = "POST"; request.ContentType = "application/json";
            request.Headers["Origin"] = origin; request.Headers["X-Review-Token"] = Convert.ToString(session["csrf"]);
            byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(post)); request.ContentLength = bytes.Length;
            using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        }
        using (var response = (HttpWebResponse)request.GetResponse()) {
            if (response.StatusCode != HttpStatusCode.OK) throw new SetupException("리뷰 앱 응답을 확인하지 못했습니다.");
            using (var stream = response.GetResponseStream()) using (var output = new MemoryStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) { output.Write(buffer, 0, count); if (output.Length > 32 * 1024 * 1024) throw new SetupException("리뷰 앱 응답이 너무 큽니다."); }
                return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(output.ToArray()));
            }
        }
    }
    internal static Dictionary<string, object> AppInfo(int port) { try { return Request(port, "/api/app/info", null, 1500); } catch { return null; } }
    internal static List<string> FindLegacy(int port) {
        var found = new List<string>(); Action<string> add = delegate(string folder) { if (folder != null && IsLegacy(folder) && !found.Exists(x => String.Equals(x, folder, StringComparison.OrdinalIgnoreCase))) found.Add(folder); };
        var info = AppInfo(port); if (info != null && info.ContainsKey("root")) add(Convert.ToString(info["root"]));
        foreach (var process in LegacyProcesses(null)) add(process.Item2);
        var bases = new List<string> { Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"), Path.GetDirectoryName(Application.ExecutablePath) };
        foreach (string folder in bases) {
            add(folder);
            try {
                int inspected = 0;
                foreach (string child in Directory.EnumerateDirectories(folder)) {
                    if (++inspected > 300) break;
                    if (Path.GetFileName(child).IndexOf("review", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    add(child); int nested = 0;
                    foreach (string sub in Directory.EnumerateDirectories(child)) { if (++nested > 30) break; if (Path.GetFileName(sub).IndexOf("review", StringComparison.OrdinalIgnoreCase) >= 0) add(sub); }
                }
            } catch { }
        }
        return found;
    }
    static List<Tuple<int, string>> LegacyProcesses(string selected) {
        var result = new List<Tuple<int, string>>();
        try {
            using (var search = new ManagementObjectSearcher("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name='node.exe'")) foreach (ManagementObject item in search.Get()) {
                string executable = Convert.ToString(item["ExecutablePath"]), command = Convert.ToString(item["CommandLine"]);
                if (String.IsNullOrEmpty(executable) || !Regex.IsMatch(command, @"(?:^|[\s""/\\])src[/\\]server\.js(?:""|\s|$)", RegexOptions.IgnoreCase)) continue;
                var runtime = Directory.GetParent(executable);
                if (runtime == null || !String.Equals(runtime.Name, "runtime", StringComparison.OrdinalIgnoreCase) || runtime.Parent == null) continue;
                string root = runtime.Parent.FullName;
                if ((selected == null || String.Equals(Path.GetFullPath(selected), root, StringComparison.OrdinalIgnoreCase)) && IsLegacy(root)) result.Add(Tuple.Create(Convert.ToInt32(item["ProcessId"]), root));
            }
        } catch { }
        return result;
    }
    static void StopApp(int port, string source, Action<string> progress) {
        bool listening = false;
        foreach (var endpoint in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()) if (endpoint.Port == port) { listening = true; break; }
        if (!listening) return;
        Dictionary<string, object> session;
        try { session = Request(port, "/api/session", null, 5000); } catch (WebException error) { if (error.Status == WebExceptionStatus.ConnectFailure) return; throw new SetupException("사용 중인 앱이 응답하지 않습니다. PC를 다시 시작한 뒤 설치 파일을 먼저 실행해 주세요."); }
        if (!session.ContainsKey("csrf") || !session.ContainsKey("aiConfigured")) throw new SetupException("다른 프로그램이 실행 주소를 사용하고 있습니다.");
        progress("진행 중인 작업을 저장하고 앱을 재시작할 준비를 합니다…");
        var info = AppInfo(port);
        if (info != null && info.ContainsKey("app") && Convert.ToString(info["app"]) == "teawest-review-desk") {
            try { Request(port, "/api/app/shutdown", new { confirmed = true }, 65000); }
            catch { throw new SetupException("진행 중인 리뷰 작업이 있어 설치를 멈췄습니다. 작업이 끝난 뒤 다시 설치해 주세요."); }
        } else {
            var known = LegacyProcesses(source);
            if (String.IsNullOrEmpty(source) || known.Count != 1) throw new SetupException("기존 앱이 실행 중입니다. 기존 프로그램 폴더를 선택하고 다시 설치해 주세요. 찾기 어려우면 PC를 다시 시작한 뒤 설치 파일을 먼저 실행하세요.");
            var sync = session.ContainsKey("autoSync") ? session["autoSync"] as Dictionary<string, object> : null;
            var jobs = sync != null && sync.ContainsKey("platforms") ? sync["platforms"] as Dictionary<string, object> : null;
            if (jobs != null) foreach (object value in jobs.Values) { var job = value as Dictionary<string, object>; if (job != null && job.ContainsKey("phase") && Convert.ToString(job["phase"]) == "syncing") throw new SetupException("기존 앱이 리뷰를 가져오는 중입니다. 가져오기가 끝난 뒤 설치해 주세요."); }
            using (var process = Process.GetProcessById(known[0].Item1)) {
                string expected = Path.Combine(source, "runtime", "node.exe");
                if (!String.Equals(Path.GetFullPath(process.MainModule.FileName), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase)) throw new SetupException("기존 앱 프로세스를 확인하지 못했습니다.");
                process.Kill(); if (!process.WaitForExit(10000)) throw new SetupException("기존 앱을 종료하지 못했습니다.");
            }
        }
        for (int i = 0; i < 50; i++) { try { Request(port, "/api/session", null, 500); Thread.Sleep(100); } catch { return; } }
        throw new SetupException("앱이 종료되는 중입니다. 잠시 후 다시 설치해 주세요.");
    }
    static string Hash(Stream stream) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    static void Extract(string destination) {
        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("ReviewDesk.Payload.zip")) {
            if (Hash(payload) != BuildInfo.PayloadHash) throw new SetupException("설치 파일이 손상되었습니다. GitHub에서 다시 내려받아 주세요.");
            payload.Position = 0;
            using (var zip = new ZipArchive(payload, ZipArchiveMode.Read)) foreach (var entry in zip.Entries) {
                string name = entry.FullName.Replace('\\', '/');
                if (!name.StartsWith(BuildInfo.PayloadPrefix + "/", StringComparison.Ordinal)) throw new SetupException("설치 파일 구조를 확인하지 못했습니다.");
                string relative = name.Substring(BuildInfo.PayloadPrefix.Length + 1);
                if (String.IsNullOrEmpty(relative)) continue;
                string target = Path.GetFullPath(Path.Combine(destination, relative.Replace('/', Path.DirectorySeparatorChar)));
                if (!target.StartsWith(Path.GetFullPath(destination) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || relative.Contains(":")) throw new SetupException("설치 파일 경로가 올바르지 않습니다.");
                if (name.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (var input = entry.Open()) using (var output = new FileStream(target, FileMode.CreateNew)) input.CopyTo(output);
            }
        }
    }
    static void Verify(string folder) {
        foreach (string line in File.ReadAllLines(Path.Combine(folder, "SHA256SUMS.txt"))) {
            int split = line.IndexOf("  ", StringComparison.Ordinal); if (split != 64) throw new SetupException("설치 파일 검증 정보가 올바르지 않습니다.");
            string file = Path.GetFullPath(Path.Combine(folder, line.Substring(split + 2).Replace('/', Path.DirectorySeparatorChar)));
            if (!file.StartsWith(Path.GetFullPath(folder) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new SetupException("설치 검증 경로가 올바르지 않습니다.");
            using (var input = File.OpenRead(file)) if (Hash(input) != line.Substring(0, 64)) throw new SetupException("프로그램 파일 검증에 실패했습니다. 설치 파일을 다시 받아 주세요.");
        }
    }
    static void SaveCurrent(string root, string folder, int port) {
        string file = Path.Combine(root, "current.json"), temp = file + ".new";
        File.WriteAllText(temp, Json.Serialize(new { version = BuildInfo.Version, folder = folder, port = port }), new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temp, file, file + ".previous", true); else File.Move(temp, file);
    }
    static void Shortcut(string directory, string root) {
        Directory.CreateDirectory(directory);
        Type type = Type.GetTypeFromProgID("WScript.Shell"); object shell = Activator.CreateInstance(type);
        object shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { Path.Combine(directory, "리뷰 관리.lnk") });
        Type shortcutType = shortcut.GetType(); string executable = Path.Combine(root, "ReviewDesk.exe");
        shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { executable });
        shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { root });
        shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { executable + ",0" });
        shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Review Desk 리뷰 관리" });
        shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut); System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
    }
    internal static void Install(string root, string source, int port, string desktop, string menu, Action<string> progress) {
        root = Path.GetFullPath(root); string versions = Path.Combine(root, "versions"), data = Path.Combine(root, "data");
        string currentFile = Path.Combine(root, "current.json");
        if (File.Exists(currentFile)) {
            var current = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(currentFile));
            if (new Version(Convert.ToString(current["version"])) > new Version(BuildInfo.Version)) throw new SetupException("더 최신 버전이 이미 설치되어 있습니다. 바탕화면의 리뷰 관리 바로가기를 실행해 주세요.");
        }
        Directory.CreateDirectory(versions);
        string stage = Path.Combine(versions, ".staging-" + Guid.NewGuid().ToString("N"));
        string folder = BuildInfo.Version + "-" + BuildInfo.PayloadHash.Substring(0, 12), destination = Path.Combine(versions, folder);
        try {
            if (!Directory.Exists(destination)) {
                Directory.CreateDirectory(stage); progress("프로그램 파일을 설치하고 확인합니다…"); Extract(stage); Verify(stage); Directory.Move(stage, destination);
            } else Verify(destination);
            StopApp(port, source, progress);
            if (!HasData(data) && !String.IsNullOrEmpty(source)) {
                if (!IsLegacy(source)) throw new SetupException("기존 리뷰 관리 폴더를 선택해 주세요.");
                progress("이 PC에 저장한 API 키와 로그인 정보를 가져옵니다…");
                var start = new ProcessStartInfo(Path.Combine(destination, "runtime", "node.exe"), Quote(Path.Combine(destination, "scripts", "migrate-legacy.mjs")) + " " + Quote(source) + " " + Quote(data)) { WorkingDirectory = destination, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                start.EnvironmentVariables.Remove("NODE_OPTIONS");
                using (var process = Process.Start(start)) {
                    var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(90000)) { process.Kill(); process.WaitForExit(10000); throw new SetupException("저장 정보 이전 시간이 초과되었습니다. 원본은 유지됩니다. 잠시 후 다시 시도해 주세요."); }
                    if (process.ExitCode != 0) throw new SetupException("기존 저장 정보를 가져오지 못했습니다. 원본은 유지됩니다. 기존 앱에서 암호화된 이전 파일을 만들어 복원해 주세요.");
                }
            }
            Directory.CreateDirectory(data);
            string launcherTemp = Path.Combine(root, "ReviewDesk.exe.new"), launcher = Path.Combine(root, "ReviewDesk.exe");
            using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("ReviewDesk.Launcher.exe")) using (var output = File.Create(launcherTemp)) resource.CopyTo(output);
            if (File.Exists(launcher)) File.Replace(launcherTemp, launcher, launcher + ".previous", true); else File.Move(launcherTemp, launcher);
            // Activation is the final atomic switch. Existing versions and data remain available.
            Shortcut(desktop, root); Shortcut(menu, root); SaveCurrent(root, folder, port);
            progress("설치가 완료되었습니다. 바탕화면의 ‘리뷰 관리’로 실행할 수 있습니다.");
        } finally {
            string resolved = Path.GetFullPath(stage);
            if (!String.Equals(Path.GetDirectoryName(resolved), versions, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(resolved).StartsWith(".staging-")) throw new SetupException("설치 임시 경로를 확인하지 못했습니다.");
            if (Directory.Exists(resolved)) Directory.Delete(resolved, true);
        }
    }
    static string Quote(string value) { return "\"" + value.Replace("\"", "") .TrimEnd('\\') + "\""; }
    internal sealed class SetupException : Exception { internal SetupException(string message) : base(message) { } }
}

internal sealed class SetupWindow : Form {
    readonly string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ReviewDesk");
    readonly Label status = new Label(), hint = new Label(); readonly ComboBox folders = new ComboBox();
    readonly Button install = new Button(), browse = new Button(); readonly ProgressBar progress = new ProgressBar(); bool done, working;
    internal SetupWindow() {
        AutoScaleMode = AutoScaleMode.None; SuspendLayout();
        Text = "Review Desk 설치 · " + BuildInfo.Version; ClientSize = new Size(560, 380); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("맑은 고딕", 10); BackColor = Color.White;
        var title = new Label { Text = "리뷰 관리, 바로 시작하세요.", Font = new Font("맑은 고딕", 20, FontStyle.Bold), AutoSize = true, Location = new Point(28, 26) }; Controls.Add(title);
        var intro = new Label { Text = "이 PC에 설치하고 바탕화면에 바로가기를 만듭니다.\n업데이트해도 저장한 API 키와 로그인 정보는 유지됩니다.", AutoSize = true, Location = new Point(30, 84) }; Controls.Add(intro);
        hint.SetBounds(30, 143, 500, 28); hint.Text = "기존에 사용하던 리뷰 앱 폴더 (처음 사용하면 선택하지 않아도 됩니다)"; hint.Font = new Font(Font.FontFamily, 9); Controls.Add(hint);
        folders.SetBounds(30, 176, 392, 28); folders.DropDownStyle = ComboBoxStyle.DropDownList; folders.Items.Add("처음 설치 · 가져올 저장 정보 없음"); folders.SelectedIndex = 0; Controls.Add(folders);
        browse.Text = "폴더 선택"; browse.SetBounds(430, 175, 100, 30); browse.Click += delegate {
            using (var picker = new FolderBrowserDialog { Description = "기존 ‘리뷰관리 실행.cmd’ 파일이 있는 프로그램 폴더를 선택하세요." }) if (picker.ShowDialog(this) == DialogResult.OK) {
                if (!Installer.IsLegacy(picker.SelectedPath)) { MessageBox.Show(this, "기존 리뷰 앱과 저장 정보가 있는 폴더를 선택해 주세요."); return; }
                if (!folders.Items.Contains(picker.SelectedPath)) folders.Items.Add(picker.SelectedPath); folders.SelectedItem = picker.SelectedPath;
            }
        }; Controls.Add(browse);
        status.SetBounds(30, 222, 500, 48); status.Text = "설치 전, 작성 중인 답글을 저장하고 진행 중인 리뷰 작업을 마쳐 주세요."; Controls.Add(status);
        progress.SetBounds(30, 280, 500, 6); progress.Style = ProgressBarStyle.Marquee; progress.Visible = false; Controls.Add(progress);
        install.Text = "설치하기"; install.SetBounds(370, 311, 160, 42); install.BackColor = Color.FromArgb(23, 107, 85); install.ForeColor = Color.White; install.FlatStyle = FlatStyle.Flat; install.Click += InstallClicked; Controls.Add(install);
        Shown += async delegate {
            if (Installer.HasData(Path.Combine(root, "data"))) { hint.Text = "이 PC에 저장된 정보를 그대로 사용합니다."; folders.Visible = browse.Visible = false; install.Text = "업데이트 설치"; return; }
            install.Enabled = false; hint.Text = "기존 리뷰 앱을 찾고 있습니다…";
            var found = await Task.Run(() => Installer.FindLegacy(4317));
            foreach (string folder in found) folders.Items.Add(folder);
            if (found.Count == 1) folders.SelectedIndex = 1;
            hint.Text = found.Count > 1 ? "기존 앱이 여러 개입니다. 저장 정보를 가져올 폴더를 선택해 주세요." : found.Count == 1 ? "기존 저장 정보를 찾았습니다. 설치할 때 함께 가져옵니다." : "기존 앱을 썼다면 ‘폴더 선택’으로 저장 정보를 가져올 수 있습니다.";
            install.Enabled = true;
        };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (working) e.Cancel = true; };
        // Windows scales the whole .NET Framework window uniformly on mixed-DPI desktops.
        ResumeLayout(true);
    }
    async void InstallClicked(object sender, EventArgs e) {
        if (done) { Process.Start(new ProcessStartInfo(Path.Combine(root, "ReviewDesk.exe")) { UseShellExecute = true }); Close(); return; }
        string source = folders.Visible && folders.SelectedIndex > 0 ? Convert.ToString(folders.SelectedItem) : null;
        working = true; install.Enabled = folders.Enabled = browse.Enabled = false; progress.Visible = true;
        try {
            await Task.Run(() => Installer.Install(root, source, 4317, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Review Desk"), text => BeginInvoke(new Action(() => status.Text = text))));
            done = true; install.Text = "리뷰 앱 열기";
        } catch (Exception error) { status.Text = Installer.Friendly(error); install.Text = "다시 설치"; }
        finally { working = false; progress.Visible = false; install.Enabled = true; folders.Enabled = browse.Enabled = !done; }
    }
}
