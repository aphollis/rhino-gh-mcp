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

        private readonly TextArea _history;
        private readonly TextArea _input;
        private readonly Button _send;
        private readonly Button _stop;
        private readonly Button _newChat;
        private readonly Button _attach;
        private readonly Button _clearAttach;
        private readonly DropDown _model;
        private readonly Label _attachLabel;
        private readonly Label _status;
        private readonly List<string> _attachments = new List<string>();

        private string _sessionId;
        private CancellationTokenSource _cts;
        private HttpResponseMessage _activeResponse;

        public ChatPanel()
        {
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
                ToolTip = "Enter to send, Shift+Enter for a new line",
            };
            _send = new Button { Text = "Send" };
            _stop = new Button { Text = "Stop", Enabled = false };
            _newChat = new Button { Text = "New chat" };
            _attach = new Button { Text = "Attach", ToolTip = "Attach images or files for Claude to look at" };
            _clearAttach = new Button { Text = "✕", Enabled = false, ToolTip = "Remove attachments" };
            _attachLabel = new Label { Font = new Font(FontFamilies.Sans, 8f) };
            _status = new Label { Text = "Ready.", Font = new Font(FontFamilies.Sans, 8f) };

            _model = new DropDown();
            _model.Items.Add(new ListItem { Text = "Default model", Key = "" });
            _model.Items.Add(new ListItem { Text = "Fable 5", Key = "claude-fable-5" });
            _model.Items.Add(new ListItem { Text = "Opus 4.8", Key = "claude-opus-4-8" });
            _model.Items.Add(new ListItem { Text = "Sonnet 5", Key = "claude-sonnet-5" });
            _model.Items.Add(new ListItem { Text = "Haiku 4.5", Key = "claude-haiku-4-5-20251001" });
            _model.SelectedKey = LoadSetting("chat_model", "");
            if (_model.SelectedIndex < 0)
                _model.SelectedIndex = 0;
            _model.SelectedKeyChanged += (s, e) => SaveSetting("chat_model", _model.SelectedKey ?? "");

            _send.Click += (s, e) => Send();
            _stop.Click += (s, e) => CancelActive();
            _newChat.Click += (s, e) => ResetChat();
            _attach.Click += (s, e) => PickAttachments();
            _clearAttach.Click += (s, e) =>
            {
                _attachments.Clear();
                RefreshAttachLabel();
            };
            _input.KeyDown += (s, e) =>
            {
                if (e.Key == Keys.Enter && !e.Modifiers.HasFlag(Keys.Shift))
                {
                    e.Handled = true;
                    Send();
                }
            };
            _input.TextChanged += (s, e) => UpdateInputHeight();
            _input.SizeChanged += (s, e) => UpdateInputHeight();

            Content = new TableLayout
            {
                Padding = 6,
                Spacing = new Size(4, 4),
                Rows =
                {
                    new TableRow(_history) { ScaleHeight = true },
                    new TableRow(_status),
                    new TableRow(new TableCell(_input, true)),
                    new TableRow(new TableLayout
                    {
                        Spacing = new Size(4, 0),
                        Rows =
                        {
                            new TableRow(
                                new TableCell(_attach),
                                new TableCell(_clearAttach),
                                new TableCell(_model),
                                new TableCell(_attachLabel, true),
                                new TableCell(_stop),
                                new TableCell(_send),
                                new TableCell(_newChat)),
                        },
                    }),
                },
            };

            Append("Claude for Rhino + Grasshopper.\n" +
                   "Try: \"Build a parametric circle extrusion with radius and height sliders.\"\n" +
                   "Enter sends, Shift+Enter adds a line. Attach images/files with the Attach button.\n");
        }

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
                : string.Join(", ", _attachments.Select(Path.GetFileName));
            _clearAttach.Enabled = _attachments.Count > 0;
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

        private async void Send()
        {
            var msg = (_input.Text ?? "").Trim();
            if (msg.Length == 0 || !_send.Enabled)
                return;

            var attachments = _attachments.ToList();
            _attachments.Clear();
            RefreshAttachLabel();
            _input.Text = "";
            UpdateInputHeight();
            _send.Enabled = false;
            _stop.Enabled = true;

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
                if (!string.IsNullOrEmpty(_model.SelectedKey))
                    body["model"] = _model.SelectedKey;
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
                _send.Enabled = true;
                _stop.Enabled = false;
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
            Application.Instance.AsyncInvoke(() =>
            {
                _history.Append(text, true);
            });
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
