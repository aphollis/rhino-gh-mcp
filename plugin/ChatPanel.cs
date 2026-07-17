using System;
using System.IO;
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
        private readonly TextArea _history;
        private readonly TextBox _input;
        private readonly Button _send;
        private readonly Button _stop;
        private readonly Button _newChat;
        private readonly Label _status;

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
            _input = new TextBox { PlaceholderText = "Ask Claude to model or build a GH definition..." };
            _send = new Button { Text = "Send" };
            _stop = new Button { Text = "Stop", Enabled = false };
            _newChat = new Button { Text = "New chat" };
            _status = new Label { Text = "Ready.", Font = new Font(FontFamilies.Sans, 8f) };

            _send.Click += (s, e) => Send();
            _stop.Click += (s, e) => CancelActive();
            _newChat.Click += (s, e) => ResetChat();
            _input.KeyDown += (s, e) =>
            {
                if (e.Key == Keys.Enter)
                {
                    e.Handled = true;
                    Send();
                }
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
                        Spacing = new Size(4, 0),
                        Rows =
                        {
                            new TableRow(
                                new TableCell(_input, true),
                                new TableCell(_send),
                                new TableCell(_stop),
                                new TableCell(_newChat)),
                        },
                    }),
                },
            };

            Append("Claude for Rhino + Grasshopper.\n" +
                   "Try: \"Build a parametric circle extrusion with radius and height sliders.\"\n");
        }

        private void ResetChat()
        {
            CancelActive();
            _sessionId = null;
            _history.Text = "";
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

            _input.Text = "";
            _send.Enabled = false;
            _stop.Enabled = true;
            Append("\nYou: " + msg + "\n");
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
    }
}
