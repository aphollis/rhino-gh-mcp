using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Eto.Drawing;
using Eto.Forms;
using Newtonsoft.Json.Linq;

namespace RhinoMcp
{
    /// <summary>
    /// Dockable "Claude" chat panel. Talks to the local agent backend
    /// (agent/server.mjs) which streams newline-delimited JSON events.
    /// </summary>
    [Guid("b3e5d7a9-1c2f-4e6b-8d0a-9f8e7d6c5b4a")]
    public class ChatPanel : Panel
    {
        /// <summary>Max height of the input box, in text lines, before it scrolls.</summary>
        private const int MaxInputLines = 8;
        private const int InputBaseHeight = 28;
        private const int InputLineHeight = 17;

        // (slashCommand, modelId sent to backend, menu label). "" id = Default.
        private static readonly (string Cmd, string Id, string Label)[] Models =
        {
            ("auto", "auto", "Auto (route by task)"),
            ("default", "", "Default model"),
            ("fable", "claude-fable-5", "Fable 5"),
            ("opus", "claude-opus-4-8", "Opus 4.8"),
            ("sonnet", "claude-sonnet-5", "Sonnet 5"),
            ("haiku", "claude-haiku-4-5-20251001", "Haiku 4.5"),
        };

        private readonly TextArea _history;
        private readonly TextArea _input;
        private readonly Button _send;      // toggles Send <-> Stop
        private readonly Button _menuBtn;   // overflow: New chat / History / Model / Help
        private readonly Button _attach;    // paperclip
        private readonly Label _attachLabel;
        private readonly Label _status;
        private readonly List<string> _attachments = new List<string>();

        private string _model;              // stored model id ("auto", "", or a claude id)
        private bool _running;
        private string _sessionId;
        private CancellationTokenSource _cts;
        private HttpResponseMessage _activeResponse;

        private static string SessionsDir =>
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "rhino-gh-mcp", "sessions");

        public ChatPanel()
        {
            _model = LoadSetting("chat_model", "auto");

            _history = new TextArea
            {
                ReadOnly = true,
                Wrap = true,
                Font = new Font(FontFamilies.Sans, 9.5f),
            };
            _input = new TextArea
            {
                Wrap = true,
                Font = new Font(FontFamilies.Sans, 9.5f),
                Height = InputBaseHeight,
                ToolTip = "Enter to send, Shift+Enter for a new line. Type / for commands.",
            };
            _attach = new Button
            {
                ToolTip = "Attach images or files for Claude to look at",
                Width = 30,
            };
            // Drawing needs Rhino's Eto platform; fall back to a glyph if it fails.
            try { _attach.Image = BuildPaperclip(); }
            catch { _attach.Text = "📎"; }
            _menuBtn = new Button { Text = "☰", ToolTip = "New chat, history, model, help", Width = 34 };
            _send = new Button { Text = "Send" };
            _attachLabel = new Label { Font = new Font(FontFamilies.Sans, 8f) };
            _status = new Label { Text = "Ready.", Font = new Font(FontFamilies.Sans, 8f) };

            _attach.Click += (s, e) => PickAttachments();
            _menuBtn.Click += (s, e) => ShowMenu();
            _send.Click += (s, e) => OnSendOrStop();
            _input.KeyDown += (s, e) =>
            {
                if (e.Key == Keys.Enter && !e.Modifiers.HasFlag(Keys.Shift))
                {
                    e.Handled = true;
                    OnSendOrStop();
                }
            };
            _input.TextChanged += (s, e) =>
            {
                UpdateInputHeight();
                if ((_input.Text ?? "").StartsWith("/") && !_running)
                    SetStatus("Commands: /model <name> · /new · /history · /help");
            };
            _input.SizeChanged += (s, e) => UpdateInputHeight();

            // Paperclip pinned to the top-left, next to the (growing) input box.
            var clipHolder = new TableLayout
            {
                Spacing = new Size(0, 0),
                Rows = { new TableRow(_attach), new TableRow(new TableCell(null)) { ScaleHeight = true } },
            };

            Content = new TableLayout
            {
                Padding = 6,
                Spacing = new Size(4, 4),
                Rows =
                {
                    new TableRow(_history) { ScaleHeight = true },
                    new TableRow(_status),
                    new TableRow(new TableLayout
                    {
                        Spacing = new Size(3, 0),
                        Rows = { new TableRow(new TableCell(clipHolder), new TableCell(_input, true)) },
                    }),
                    new TableRow(new TableLayout
                    {
                        Spacing = new Size(4, 0),
                        Rows =
                        {
                            new TableRow(
                                new TableCell(_attachLabel, true),
                                new TableCell(_menuBtn),
                                new TableCell(_send)),
                        },
                    }),
                },
            };

            if (!RestoreMostRecent())
            {
                Append("Claude for Rhino + Grasshopper.\n" +
                       "Try: \"Build a parametric circle extrusion with radius and height sliders.\"\n" +
                       "Enter sends, Shift+Enter adds a line. 📎 attaches files. Type /help for commands.\n");
            }
            SetStatus("Model: " + LabelForId(_model));
        }

        /* --------------------------- paperclip --------------------------- */

        private static Image BuildPaperclip()
        {
            var bmp = new Bitmap(16, 16, PixelFormat.Format32bppRgba);
            using (var g = new Graphics(bmp))
            {
                g.AntiAlias = true;
                using (var pen = new Pen(Color.FromArgb(120, 120, 120), 1.5f))
                {
                    g.DrawPath(pen, Capsule(4f, 2f, 7f, 12f));
                    g.DrawPath(pen, Capsule(6f, 4.5f, 3f, 7f));
                }
            }
            return bmp;
        }

        private static IGraphicsPath Capsule(float x, float y, float w, float h)
        {
            var p = GraphicsPath.Create();
            p.AddArc(x, y, w, w, 180, 180);                       // top cap
            p.AddLine(x + w, y + w / 2f, x + w, y + h - w / 2f);  // right side
            p.AddArc(x, y + h - w, w, w, 0, 180);                 // bottom cap
            p.AddLine(x, y + h - w / 2f, x, y + w / 2f);          // left side
            p.CloseFigure();
            return p;
        }

        /* ------------------------ slash commands ------------------------- */

        private bool TryHandleSlash(string msg)
        {
            if (!msg.StartsWith("/")) return false;
            var parts = msg.Substring(1).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            var cmd = parts.Length > 0 ? parts[0].ToLowerInvariant() : "";
            var arg = parts.Length > 1 ? parts[1].ToLowerInvariant() : "";

            switch (cmd)
            {
                case "help":
                case "?":
                    ShowHelp();
                    break;
                case "new":
                    ResetChat();
                    break;
                case "history":
                    ShowHistoryDialog();
                    break;
                case "clear":
                    _attachments.Clear();
                    RefreshAttachLabel();
                    SystemLine("Attachments cleared.");
                    break;
                case "model":
                    if (string.IsNullOrEmpty(arg)) ShowModelHelp();
                    else SetModelByName(arg);
                    break;
                default:
                    if (Models.Any(m => m.Cmd == cmd)) SetModelByName(cmd);
                    else SystemLine("Unknown command '/" + cmd + "'. Type /help.");
                    break;
            }
            return true;
        }

        private void SetModelByName(string name)
        {
            var match = Models.FirstOrDefault(m => m.Cmd == name);
            if (match.Cmd == null)
            {
                SystemLine("Unknown model '" + name + "'. Options: " +
                           string.Join(", ", Models.Select(m => m.Cmd)));
                return;
            }
            SetModel(match.Id);
        }

        private void SetModel(string id)
        {
            _model = id;
            SaveSetting("chat_model", id ?? "");
            SystemLine("Model set to " + LabelForId(id) + ".");
            SetStatus("Model: " + LabelForId(id));
        }

        private static string LabelForId(string id)
        {
            foreach (var m in Models)
                if (m.Id == (id ?? "")) return m.Label;
            return id;
        }

        private void ShowHelp()
        {
            SystemLine(
                "Commands:\n" +
                "  /model <name>   switch model (auto, default, fable, opus, sonnet, haiku)\n" +
                "  /auto /opus …   shortcut to switch model\n" +
                "  /new            start a new conversation\n" +
                "  /history        restore a previous conversation\n" +
                "  /clear          clear pending attachments\n" +
                "  /help           this list\n" +
                "Current model: " + LabelForId(_model));
        }

        private void ShowModelHelp()
        {
            SystemLine("Current model: " + LabelForId(_model) + ". Switch with: " +
                       string.Join(", ", Models.Select(m => "/" + m.Cmd)));
        }

        /* ---------------------------- menu ------------------------------- */

        private void ShowMenu()
        {
            var menu = new ContextMenu();

            var newItem = new ButtonMenuItem { Text = "New chat" };
            newItem.Click += (s, e) => ResetChat();
            menu.Items.Add(newItem);

            var histItem = new ButtonMenuItem { Text = "History…" };
            histItem.Click += (s, e) => ShowHistoryDialog();
            menu.Items.Add(histItem);

            if (_attachments.Count > 0)
            {
                var clr = new ButtonMenuItem { Text = "Clear attachments" };
                clr.Click += (s, e) => { _attachments.Clear(); RefreshAttachLabel(); };
                menu.Items.Add(clr);
            }

            menu.Items.Add(new SeparatorMenuItem());

            var modelSub = new SubMenuItem { Text = "Model" };
            foreach (var m in Models)
            {
                var id = m.Id;
                var item = new ButtonMenuItem { Text = (_model == id ? "✓ " : "    ") + m.Label };
                item.Click += (s, e) => SetModel(id);
                modelSub.Items.Add(item);
            }
            menu.Items.Add(modelSub);

            menu.Items.Add(new SeparatorMenuItem());

            var help = new ButtonMenuItem { Text = "Help (slash commands)" };
            help.Click += (s, e) => ShowHelp();
            menu.Items.Add(help);

            menu.Show(_menuBtn);
        }

        /* ---------------------------- history ---------------------------- */

        private class SessionInfo
        {
            public string Id;
            public string Title;
            public string Updated;
            public override string ToString()
            {
                var when = Updated;
                if (DateTime.TryParse(Updated, out var dt)) when = dt.ToLocalTime().ToString("g");
                return (string.IsNullOrEmpty(Title) ? "(untitled)" : Title) + "   —   " + when;
            }
        }

        private static List<SessionInfo> ListSessions()
        {
            var list = new List<SessionInfo>();
            try
            {
                if (!Directory.Exists(SessionsDir)) return list;
                foreach (var file in Directory.GetFiles(SessionsDir, "*.json"))
                {
                    try
                    {
                        var o = JObject.Parse(File.ReadAllText(file));
                        list.Add(new SessionInfo
                        {
                            Id = (string)o["id"],
                            Title = (string)o["title"],
                            Updated = (string)o["updatedAt"],
                        });
                    }
                    catch { }
                }
            }
            catch { }
            return list.OrderByDescending(s => s.Updated ?? "").ToList();
        }

        private bool RestoreMostRecent()
        {
            var recent = ListSessions().FirstOrDefault();
            if (recent == null) return false;
            return RestoreSession(recent.Id, quiet: true);
        }

        private bool RestoreSession(string id, bool quiet = false)
        {
            try
            {
                var file = Path.Combine(SessionsDir, id + ".json");
                if (!File.Exists(file)) return false;
                var o = JObject.Parse(File.ReadAllText(file));
                _history.Text = "";
                foreach (var m in (JArray)(o["messages"] ?? new JArray()))
                {
                    var role = (string)m["role"];
                    var text = (string)m["text"] ?? "";
                    if (role == "user")
                    {
                        _history.Append("\nYou: " + text + "\n", true);
                        var att = m["attachments"] as JArray;
                        if (att != null && att.Count > 0)
                            _history.Append("  [attached: " + string.Join(", ", att.Select(a => (string)a)) + "]\n", true);
                    }
                    else if (role == "assistant")
                        _history.Append("\nClaude: " + text + "\n", true);
                    else if (role == "tool")
                        _history.Append("  [tool] " + text + "\n", true);
                }
                _sessionId = id;
                SetStatus(quiet ? "Restored previous conversation." : "Restored.");
                return true;
            }
            catch
            {
                return false;
            }
        }

        private void ShowHistoryDialog()
        {
            var sessions = ListSessions();
            if (sessions.Count == 0)
            {
                MessageBox.Show(this, "No saved conversations yet.", "History");
                return;
            }

            var dlg = new Dialog { Title = "Conversation history", Width = 460, Height = 380, Resizable = true };
            var listBox = new ListBox();
            foreach (var s in sessions) listBox.Items.Add(new ListItem { Text = s.ToString(), Key = s.Id });
            listBox.SelectedIndex = 0;

            var open = new Button { Text = "Open" };
            var cancel = new Button { Text = "Cancel" };
            open.Click += (s, e) => { dlg.Tag = listBox.SelectedKey; dlg.Close(); };
            cancel.Click += (s, e) => { dlg.Tag = null; dlg.Close(); };
            listBox.MouseDoubleClick += (s, e) => { dlg.Tag = listBox.SelectedKey; dlg.Close(); };

            dlg.Content = new TableLayout
            {
                Padding = 8,
                Spacing = new Size(6, 6),
                Rows =
                {
                    new TableRow(new TableCell(listBox, true)) { ScaleHeight = true },
                    new TableRow(new TableLayout
                    {
                        Spacing = new Size(6, 0),
                        Rows = { new TableRow(null, new TableCell(cancel), new TableCell(open)) },
                    }),
                },
            };
            dlg.DefaultButton = open;
            dlg.AbortButton = cancel;
            dlg.ShowModal(this);

            var chosen = dlg.Tag as string;
            if (!string.IsNullOrEmpty(chosen))
            {
                CancelActive();
                RestoreSession(chosen);
            }
        }

        /* -------------------------- attachments -------------------------- */

        private void PickAttachments()
        {
            var dlg = new OpenFileDialog { MultiSelect = true, Title = "Attach files for Claude" };
            if (dlg.ShowDialog(this) != DialogResult.Ok)
                return;
            foreach (var f in dlg.Filenames)
                if (!_attachments.Contains(f))
                    _attachments.Add(f);
            RefreshAttachLabel();
        }

        private void RefreshAttachLabel()
        {
            _attachLabel.Text = _attachments.Count == 0
                ? ""
                : "📎 " + string.Join(", ", _attachments.Select(Path.GetFileName));
        }

        private void UpdateInputHeight()
        {
            var text = _input.Text ?? "";
            var width = _input.Width > 40 ? _input.Width : 300;
            var charsPerLine = Math.Max(24, width / 7);
            var lines = 0;
            foreach (var seg in text.Split('\n'))
                lines += Math.Max(1, (int)Math.Ceiling((double)Math.Max(seg.Length, 1) / charsPerLine));
            lines = Math.Max(1, Math.Min(MaxInputLines, lines));
            var height = InputBaseHeight + (lines - 1) * InputLineHeight;
            if (_input.Height != height)
                _input.Height = height;
        }

        /* ----------------------------- chat ------------------------------ */

        private void ResetChat()
        {
            CancelActive();
            _sessionId = null;
            _history.Text = "";
            _attachments.Clear();
            RefreshAttachLabel();
            SetStatus("New conversation.");
            Append("New chat started.\n");
        }

        private void CancelActive()
        {
            try { _cts?.Cancel(); } catch { }
            try { _activeResponse?.Dispose(); } catch { }
        }

        private void OnSendOrStop()
        {
            if (_running)
            {
                CancelActive();
                return;
            }
            Send();
        }

        private async void Send()
        {
            var msg = (_input.Text ?? "").Trim();
            if (msg.Length == 0)
                return;

            // Slash commands are handled locally and never sent to the agent.
            if (TryHandleSlash(msg))
            {
                _input.Text = "";
                UpdateInputHeight();
                return;
            }

            var attachments = _attachments.ToList();
            _attachments.Clear();
            RefreshAttachLabel();
            _input.Text = "";
            UpdateInputHeight();
            _running = true;
            _send.Text = "Stop";

            Append("\nYou: " + msg + "\n");
            if (attachments.Count > 0)
                Append("  [attached: " + string.Join(", ", attachments.Select(Path.GetFileName)) + "]\n");
            SetStatus("Starting agent...");

            try
            {
                var err = await AgentProcess.EnsureStartedAsync();
                if (err != null)
                {
                    Append("\n[agent unavailable] " + err + "\n");
                    SetStatus("Agent unavailable.");
                    return;
                }

                SetStatus("Thinking...");
                _cts = new CancellationTokenSource();
                var body = new JObject { ["message"] = msg };
                if (_sessionId != null)
                    body["sessionId"] = _sessionId;
                if (!string.IsNullOrEmpty(_model))
                    body["model"] = _model;
                if (attachments.Count > 0)
                    body["attachments"] = new JArray(attachments.ToArray());

                var request = new HttpRequestMessage(HttpMethod.Post, AgentProcess.BaseUrl + "/chat")
                {
                    Content = new StringContent(body.ToString(), Encoding.UTF8, "application/json"),
                };

                using (var response = await AgentProcess.Http.SendAsync(
                           request, HttpCompletionOption.ResponseHeadersRead, _cts.Token))
                {
                    _activeResponse = response;
                    using (var stream = await response.Content.ReadAsStreamAsync())
                    using (var reader = new StreamReader(stream))
                    {
                        string line;
                        while ((line = await reader.ReadLineAsync()) != null)
                        {
                            if (line.Trim().Length == 0) continue;
                            HandleEvent(line);
                        }
                    }
                }
                SetStatus("Ready.");
            }
            catch (OperationCanceledException)
            {
                Append("\n[stopped]\n");
                SetStatus("Stopped.");
            }
            catch (Exception) when (_cts != null && _cts.IsCancellationRequested)
            {
                Append("\n[stopped]\n");
                SetStatus("Stopped.");
            }
            catch (Exception ex)
            {
                Append("\n[error] " + ex.Message + "\n");
                SetStatus("Error.");
            }
            finally
            {
                _activeResponse = null;
                _cts = null;
                _running = false;
                Application.Instance.AsyncInvoke(() => _send.Text = "Send");
            }
        }

        private void HandleEvent(string line)
        {
            JObject evt;
            try { evt = JObject.Parse(line); }
            catch { return; }

            var type = (string)evt["type"];
            switch (type)
            {
                case "session":
                    _sessionId = (string)evt["sessionId"] ?? _sessionId;
                    break;
                case "routed":
                    SetStatus("Auto-routed to " + (string)evt["model"] + "...");
                    break;
                case "text":
                    Append("\nClaude: " + (string)evt["text"] + "\n");
                    break;
                case "tool":
                    Append("  [tool] " + (string)evt["name"] + " " + (string)evt["input"] + "\n");
                    SetStatus("Running " + (string)evt["name"] + "...");
                    break;
                case "tool_error":
                    Append("  [tool error] " + (string)evt["message"] + "\n");
                    break;
                case "done":
                    _sessionId = (string)evt["sessionId"] ?? _sessionId;
                    var cost = evt["cost"];
                    SetStatus(cost != null
                        ? string.Format("Done (${0:F3} this session).", (double)cost)
                        : "Done.");
                    break;
                case "error":
                    Append("\n[agent error] " + (string)evt["message"] + "\n");
                    break;
            }
        }

        private void Append(string text)
        {
            Application.Instance.AsyncInvoke(() => _history.Append(text, true));
        }

        private void SystemLine(string text)
        {
            Append("\n· " + text + "\n");
        }

        private void SetStatus(string text)
        {
            Application.Instance.AsyncInvoke(() => _status.Text = text);
        }

        private static string LoadSetting(string key, string fallback)
        {
            try
            {
                return RhinoMcpPlugIn.Instance.Settings.GetString(key, fallback);
            }
            catch
            {
                return fallback;
            }
        }

        private static void SaveSetting(string key, string value)
        {
            try
            {
                RhinoMcpPlugIn.Instance.Settings.SetString(key, value);
            }
            catch { }
        }
    }
}
