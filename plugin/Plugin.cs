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
                Panels.RegisterPanel(this, typeof(ChatPanel), "Claude", ClaudeIcon.Create());
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

    }

    /// <summary>
    /// Renders the Claude "spark" logomark as a panel-tab icon: a radial burst
    /// of tapered rays in Claude's terracotta, on a transparent background.
    /// Drawn at runtime so no binary asset needs to ship with the plugin.
    /// </summary>
    internal static class ClaudeIcon
    {
        // Claude brand terracotta.
        private static readonly System.Drawing.Color Terracotta =
            System.Drawing.Color.FromArgb(217, 119, 87);

        // Ray angles (degrees) and relative lengths approximating the Claude
        // logomark's asymmetric burst.
        private static readonly double[] Angles =
            { 90, 122, 155, 180, 205, 238, 270, 302, 335, 8, 40, 65 };
        private static readonly float[] Lengths =
            { 1.00f, 0.62f, 0.90f, 0.55f, 0.90f, 0.62f, 1.00f, 0.62f, 0.90f, 0.55f, 0.90f, 0.62f };

        // Sizes packed into the .ico so Rhino renders a crisp tab icon at any DPI.
        private static readonly int[] IconSizes = { 16, 20, 24, 32, 40, 48, 64 };

        /// <summary>
        /// Build a real multi-resolution .ico using uncompressed 32-bit DIB
        /// frames (not PNG, which GDI+ Icon.ToBitmap mis-decodes, and not
        /// Bitmap.GetHicon, whose mask can come out fully blank on a docked tab
        /// that shows only the icon). DIB frames decode correctly both natively
        /// and through GDI+.
        /// </summary>
        public static System.Drawing.Icon Create()
        {
            var frames = new byte[IconSizes.Length][];
            for (int i = 0; i < IconSizes.Length; i++)
                frames[i] = RenderDibFrame(IconSizes[i]);

            using (var ms = new MemoryStream())
            {
                var bw = new BinaryWriter(ms);
                bw.Write((short)0);                       // reserved
                bw.Write((short)1);                       // type = icon
                bw.Write((short)IconSizes.Length);        // image count

                int offset = 6 + 16 * IconSizes.Length;   // dir header + entries
                for (int i = 0; i < IconSizes.Length; i++)
                {
                    int s = IconSizes[i];
                    bw.Write((byte)(s >= 256 ? 0 : s));   // width
                    bw.Write((byte)(s >= 256 ? 0 : s));   // height
                    bw.Write((byte)0);                    // palette
                    bw.Write((byte)0);                    // reserved
                    bw.Write((short)1);                   // color planes
                    bw.Write((short)32);                  // bits per pixel
                    bw.Write(frames[i].Length);           // bytes in resource
                    bw.Write(offset);                     // offset to frame
                    offset += frames[i].Length;
                }
                foreach (var f in frames)
                    bw.Write(f);

                bw.Flush();
                ms.Position = 0;
                return new System.Drawing.Icon(ms);
            }
        }

        /// <summary>Render one icon frame as an uncompressed 32bpp DIB
        /// (BITMAPINFOHEADER + bottom-up BGRA pixels + a zero AND mask).</summary>
        private static byte[] RenderDibFrame(int size)
        {
            using (var bmp = new System.Drawing.Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            {
                using (var g = System.Drawing.Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    g.Clear(System.Drawing.Color.Transparent);

                    float cx = size / 2f, cy = size / 2f;
                    float inner = size * 0.10f;
                    float outer = size * 0.46f;
                    float width = Math.Max(1.4f, size * 0.12f);

                    using (var pen = new System.Drawing.Pen(Terracotta, width))
                    {
                        pen.StartCap = System.Drawing.Drawing2D.LineCap.Round;
                        pen.EndCap = System.Drawing.Drawing2D.LineCap.Round;
                        for (int i = 0; i < Angles.Length; i++)
                        {
                            double a = Angles[i] * Math.PI / 180.0;
                            float len = inner + (outer - inner) * Lengths[i];
                            float x1 = cx + (float)Math.Cos(a) * inner;
                            float y1 = cy - (float)Math.Sin(a) * inner;
                            float x2 = cx + (float)Math.Cos(a) * len;
                            float y2 = cy - (float)Math.Sin(a) * len;
                            g.DrawLine(pen, x1, y1, x2, y2);
                        }
                    }
                }

                int maskRow = ((size + 31) / 32) * 4; // 1bpp AND mask, dword-aligned
                using (var ms = new MemoryStream())
                {
                    var bw = new BinaryWriter(ms);
                    // BITMAPINFOHEADER: height is doubled (XOR image + AND mask).
                    bw.Write(40);                 // biSize
                    bw.Write(size);               // biWidth
                    bw.Write(size * 2);           // biHeight (XOR + AND)
                    bw.Write((short)1);           // biPlanes
                    bw.Write((short)32);          // biBitCount
                    bw.Write(0);                  // biCompression = BI_RGB
                    bw.Write(0);                  // biSizeImage
                    bw.Write(0);                  // biXPelsPerMeter
                    bw.Write(0);                  // biYPelsPerMeter
                    bw.Write(0);                  // biClrUsed
                    bw.Write(0);                  // biClrImportant

                    // XOR pixels, bottom-up, BGRA.
                    for (int y = size - 1; y >= 0; y--)
                        for (int x = 0; x < size; x++)
                        {
                            var px = bmp.GetPixel(x, y);
                            bw.Write(px.B);
                            bw.Write(px.G);
                            bw.Write(px.R);
                            bw.Write(px.A);
                        }
                    // AND mask all zero: alpha channel governs transparency.
                    for (int y = 0; y < size; y++)
                        bw.Write(new byte[maskRow]);

                    bw.Flush();
                    return ms.ToArray();
                }
            }
        }
    }
}
