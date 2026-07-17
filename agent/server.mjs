// Agent backend for the RhinoMcp chat panel.
// Runs the Claude Agent SDK loop with the rhino-grasshopper MCP server
// attached, and streams newline-delimited JSON events over HTTP.
//
// Spawned automatically by the Rhino plugin; can also be run by hand:
//   node agent/server.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const PORT = Number(process.env.AGENT_PORT ?? 8766);

const SYSTEM_APPEND = `
You are embedded in Rhino 8 as a CAD/parametric-design assistant, chatting with
the user through a small panel inside Rhino. The rhino-grasshopper MCP tools
drive the very Rhino instance the user is looking at.

Guidelines:
- For Grasshopper work prefer gh_build_recipe to create whole definitions in
  one call; verify with gh_get_canvas and fix any errors it reports.
- Use gh_search_components / gh_component_info when unsure of component or
  parameter names - do not guess.
- Keep chat replies short; the user can see the canvas and viewport, so
  describe what you built and any sliders they can play with.
- Use rhino_capture_viewport to check visual results after baking or modeling.
- rhino_execute_python runs inside the user's live Rhino session: be careful
  with destructive operations and never delete user geometry unless asked.
`.trim();

function summarize(input) {
  let s;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return s.length > 220 ? s.slice(0, 220) + "..." : s;
}

const IMAGE_MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Build the SDK prompt. Plain text when there are no image attachments;
 * otherwise a single streamed user message whose content blocks embed each
 * image so the model can actually see it. Non-image files are handed to the
 * agent as absolute paths for it to Read on demand.
 */
function buildPrompt(message, attachments, sessionId, send) {
  const files = Array.isArray(attachments) ? attachments : [];
  const images = [];
  const otherPaths = [];

  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (mediaType) {
      try {
        const data = fs.readFileSync(f).toString("base64");
        images.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
      } catch (e) {
        send({ type: "tool_error", message: `Could not read image ${f}: ${e.message}` });
      }
    } else {
      otherPaths.push(f);
    }
  }

  let text = message;
  if (otherPaths.length) {
    text +=
      "\n\nAttached files (use the Read tool to open them):\n" +
      otherPaths.map((p) => `- ${p}`).join("\n");
  }

  if (images.length === 0) {
    return text;
  }

  const content = [{ type: "text", text }, ...images];
  async function* generator() {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: sessionId || "",
    };
  }
  return generator();
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  let message, sessionId, model, attachments;
  try {
    ({ message, sessionId, model, attachments } = JSON.parse(body || "{}"));
  } catch {
    res.writeHead(400);
    res.end("bad json");
    return;
  }
  if (!message) {
    res.writeHead(400);
    res.end("missing message");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
  });
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  const prompt = buildPrompt(message, attachments, sessionId, send);

  const q = query({
    prompt,
    options: {
      cwd: REPO,
      resume: sessionId || undefined,
      ...(model ? { model } : {}),
      permissionMode: "bypassPermissions",
      disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit"],
      mcpServers: {
        "rhino-grasshopper": {
          type: "stdio",
          command: process.execPath,
          args: [path.join(REPO, "dist", "index.js")],
        },
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: SYSTEM_APPEND,
      },
    },
  });

  req.on("close", () => {
    q.interrupt?.().catch(() => {});
  });

  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        send({ type: "session", sessionId: msg.session_id });
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            send({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            send({ type: "tool", name: block.name, input: summarize(block.input) });
          }
        }
      } else if (msg.type === "user") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result" && block.is_error) {
              send({ type: "tool_error", message: summarize(block.content) });
            }
          }
        }
      } else if (msg.type === "result") {
        send({
          type: "done",
          sessionId: msg.session_id,
          cost: msg.total_cost_usd,
          isError: msg.is_error,
          ...(msg.subtype !== "success" ? { note: msg.subtype } : {}),
        });
      }
    }
  } catch (e) {
    try {
      send({ type: "error", message: String(e?.message ?? e) });
    } catch {}
  } finally {
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`rhino-gh-mcp agent server listening on 127.0.0.1:${PORT}`);
});
