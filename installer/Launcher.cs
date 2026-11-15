using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Launcher {
    [STAThread] static int Main() {
        try {
            string root = Path.GetDirectoryName(Application.ExecutablePath);
            var current = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "current.json")));
            string folder = Convert.ToString(current["folder"]);
            if (!System.Text.RegularExpressions.Regex.IsMatch(folder, @"^\d+\.\d+\.\d+-[a-f0-9]{12}$")) throw new Exception();
            string version = Path.Combine(root, "versions", folder), node = Path.Combine(version, "runtime", "node.exe");
            var start = new ProcessStartInfo(node, "\"" + Path.Combine(version, "scripts", "launch.mjs") + "\"") {
                WorkingDirectory = version, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardError = true, RedirectStandardOutput = true, StandardErrorEncoding = Encoding.UTF8, StandardOutputEncoding = Encoding.UTF8
            };
            start.EnvironmentVariables["REVIEW_DESK_DATA_DIR"] = Path.Combine(root, "data");
            start.EnvironmentVariables["REVIEW_DESK_INSTALL_ROOT"] = root;
            start.EnvironmentVariables["REVIEW_DESK_INSTALLED"] = "1";
            start.EnvironmentVariables["PORT"] = Convert.ToString(current["port"]);
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            using (var process = Process.Start(start)) {
                var error = process.StandardError.ReadToEndAsync();
                var output = process.StandardOutput.ReadToEndAsync();
                if (!process.WaitForExit(35000)) throw new Exception();
                if (process.ExitCode != 0) {
                    MessageBox.Show("리뷰 앱을 시작하지 못했습니다. 다른 폴더의 리뷰 앱이 실행 중이면 설치 파일을 다시 실행해 주세요. 문제가 계속되면 연결 진단 파일을 확인해 주세요.", "Review Desk", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 1;
                }
            }
            return 0;
        } catch {
            MessageBox.Show("설치 정보를 확인하지 못했습니다. Review Desk 설치 파일을 다시 실행해 주세요. 저장된 로그인 정보와 API 키는 유지됩니다.", "Review Desk", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
    }
}
