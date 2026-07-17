using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using Rhino;

namespace RhinoMcp
{
    /// <summary>
    /// Manages the Node "agent backend" (agent/server.mjs) that runs the
    /// Claude Agent SDK loop. Started lazily on first chat message.
    /// </summary>
    public static class AgentProcess
    {
        public const int Port = 8766;
        public static string BaseUrl => "http://127.0.0.1:" + Port;

        private static Process _proc;
        private static string _repoRoot;

        public static readonly HttpClient Http = new HttpClient
        {
            Timeout = System.Threading.Timeout.InfiniteTimeSpan,
        };

        /// <summary>Repo root, found by walking up from the plugin assembly.</summary>
        public static string RepoRoot
        {
            get
            {
                if (_repoRoot != null) return _repoRoot;
                try
                {
                    var dir = Path.GetDirectoryName(typeof(AgentProcess).Assembly.Location);
                    for (var i = 0; i < 8 && dir != null; i++)
                    {
                        if (File.Exists(Path.Combine(dir, "agent", "server.mjs")))
                        {
                            _repoRoot = dir;
                            return dir;
                        }
                        dir = Path.GetDirectoryName(dir);
                    }
                }
                catch { }
                return null;
            }
        }

        public static bool IsRunning => _proc != null && !_proc.HasExited;

        /// <summary>Start the agent server if needed. Returns null on success, else an error message.</summary>
        public static async Task<string> EnsureStartedAsync()
        {
            if (IsRunning)
                return null;

            var repo = RepoRoot;
            if (repo == null)
                return "Could not locate the rhino-gh-mcp repo (agent/server.mjs) near the plugin. " +
                       "Keep RhinoMcp.rhp inside the repo's plugin/bin folder.";

            var serverPath = Path.Combine(repo, "agent", "server.mjs");
            if (!Directory.Exists(Path.Combine(repo, "agent", "node_modules")))
                return "Agent dependencies missing. Run 'npm install' in " + Path.Combine(repo, "agent");

            var node = File.Exists(@"C:\Program Files\nodejs\node.exe")
                ? @"C:\Program Files\nodejs\node.exe"
                : "node";

            var psi = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "\"" + serverPath + "\"",
                WorkingDirectory = Path.Combine(repo, "agent"),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.EnvironmentVariables["AGENT_PORT"] = Port.ToString();

            try
            {
                _proc = Process.Start(psi);
            }
            catch (Exception ex)
            {
                return "Could not start node: " + ex.Message;
            }

            _proc.OutputDataReceived += (s, e) => Log(e.Data);
            _proc.ErrorDataReceived += (s, e) => Log(e.Data);
            _proc.BeginOutputReadLine();
            _proc.BeginErrorReadLine();

            for (var i = 0; i < 40; i++)
            {
                if (_proc.HasExited)
                    return "Agent process exited immediately (code " + _proc.ExitCode +
                           "). Check the Rhino command line for its error output.";
                try
                {
                    var r = await Http.GetStringAsync(BaseUrl + "/health").ConfigureAwait(false);
                    if (r.Contains("ok"))
                        return null;
                }
                catch { }
                await Task.Delay(500).ConfigureAwait(false);
            }
            return "Agent server did not become ready on port " + Port + ".";
        }

        public static void Stop()
        {
            try
            {
                if (_proc != null && !_proc.HasExited)
                {
                    // kill the whole tree: node spawns the Claude CLI + MCP server
                    Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + _proc.Id)
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                    });
                }
            }
            catch { }
            _proc = null;
        }

        public static void Restart()
        {
            Stop();
        }

        private static void Log(string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            try
            {
                RhinoApp.InvokeOnUiThread(new Action(() =>
                    RhinoApp.WriteLine("RhinoMcp agent: " + line)));
            }
            catch { }
        }
    }
}
