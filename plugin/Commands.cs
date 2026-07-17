using Rhino;
using Rhino.Commands;
using Rhino.UI;

namespace RhinoMcp
{
    /// <summary>Open (or focus) the Claude chat panel.</summary>
    public class McpChatCommand : Command
    {
        public override string EnglishName => "McpChat";

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            Panels.OpenPanel(typeof(ChatPanel).GUID);
            return Result.Success;
        }
    }

    /// <summary>Restart the TCP listener (e.g. after editing mcp_listener.py).</summary>
    public class McpListenerRestartCommand : Command
    {
        public override string EnglishName => "McpListenerRestart";

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            try
            {
                RhinoMcpPlugIn.Instance.StartListener();
                RhinoApp.WriteLine("RhinoMcp: listener restarted on 127.0.0.1:8765");
                return Result.Success;
            }
            catch (System.Exception ex)
            {
                RhinoApp.WriteLine("RhinoMcp: " + ex.Message);
                return Result.Failure;
            }
        }
    }

    /// <summary>Stop the agent backend; it restarts on the next chat message.</summary>
    public class McpAgentRestartCommand : Command
    {
        public override string EnglishName => "McpAgentRestart";

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            AgentProcess.Restart();
            RhinoApp.WriteLine("RhinoMcp: agent backend stopped; it will restart on the next chat message.");
            return Result.Success;
        }
    }
}
