using System;
using System.IO;
using System.Runtime.InteropServices;
using Rhino;
using Rhino.PlugIns;
using Rhino.UI;

[assembly: Guid("8d2f34a1-6b7e-4c5d-a9f0-1e2b3c4d5e6f")]
[assembly: PlugInDescription(DescriptionType.Organization, "aphollis")]
[assembly: PlugInDescription(DescriptionType.Email, "nerfdorito@gmail.com")]
[assembly: PlugInDescription(DescriptionType.WebSite, "https://github.com/aphollis/rhino-gh-mcp")]

namespace RhinoMcp
{
    public class RhinoMcpPlugIn : PlugIn
    {
        public static RhinoMcpPlugIn Instance { get; private set; }

        private int _startAttempts;
        private bool _listenerStarted;

        public RhinoMcpPlugIn()
        {
            Instance = this;
        }

        public override PlugInLoadTime LoadTime => PlugInLoadTime.AtStartup;

        protected override LoadReturnCode OnLoad(ref string errorMessage)
        {
            try
            {
                Panels.RegisterPanel(this, typeof(ChatPanel), "Claude", CreateIcon());
            }
            catch (Exception ex)
            {
                RhinoApp.WriteLine("RhinoMcp: could not register chat panel: " + ex.Message);
            }

            // Defer listener start until Rhino is idle so the IronPython plugin
            // is fully loaded and startup isn't slowed down.
            RhinoApp.Idle += OnIdleStartListener;
            RhinoApp.Closing += (s, e) => AgentProcess.Stop();
            return LoadReturnCode.Success;
        }

        private void OnIdleStartListener(object sender, EventArgs e)
        {
            _startAttempts++;
            try
            {
                StartListener();
                _listenerStarted = true;
                RhinoApp.Idle -= OnIdleStartListener;
                RhinoApp.WriteLine("RhinoMcp: listener running on 127.0.0.1:8765 (MCP agents can now drive Rhino/Grasshopper).");
            }
            catch (Exception ex)
            {
                if (_startAttempts >= 5)
                {
                    RhinoApp.Idle -= OnIdleStartListener;
                    RhinoApp.WriteLine("RhinoMcp: failed to start listener after 5 attempts: " + ex.Message);
                }
            }
        }

        public void StartListener()
        {
            var py = Rhino.Runtime.PythonScript.Create();
            if (py == null)
                throw new InvalidOperationException("IronPython engine is not available yet.");
            py.ExecuteScript(LoadListenerScript());
        }

        public bool ListenerStarted => _listenerStarted;

        private static string LoadListenerScript()
        {
            // Prefer the file on disk (editable without recompiling) and fall
            // back to the copy embedded at build time.
            var repo = AgentProcess.RepoRoot;
            if (repo != null)
            {
                var onDisk = Path.Combine(repo, "rhino", "mcp_listener.py");
                if (File.Exists(onDisk))
                    return File.ReadAllText(onDisk);
            }
            using (var stream = typeof(RhinoMcpPlugIn).Assembly
                       .GetManifestResourceStream("RhinoMcp.mcp_listener.py"))
            using (var reader = new StreamReader(stream))
            {
                return reader.ReadToEnd();
            }
        }

        private static System.Drawing.Icon CreateIcon()
        {
            var bmp = new System.Drawing.Bitmap(32, 32);
            using (var g = System.Drawing.Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(System.Drawing.Color.Transparent);
                using (var brush = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(204, 102, 51)))
                    g.FillEllipse(brush, 2, 2, 28, 28);
                using (var pen = new System.Drawing.Pen(System.Drawing.Color.White, 3))
                    g.DrawArc(pen, 9, 9, 14, 14, 40, 280);
            }
            return System.Drawing.Icon.FromHandle(bmp.GetHicon());
        }
    }
}
