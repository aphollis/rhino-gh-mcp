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

/** Compact component reference, loaded once into the cached system prompt so
 *  the agent rarely needs gh_component_info. Format: "Name: in(A,B) -> out(C)". */
function loadReference() {
  try {
    const ref = JSON.parse(fs.readFileSync(path.join(REPO, "docs", "gh_reference.json"), "utf8"));
    const lines = ref.components.map(
      (c) => `${c.name}: in(${c.in.join(", ")}) -> out(${c.out.join(", ")})`,
    );
    const prims = Object.entries(ref.primitives).map(([k, v]) => `${k} = ${v}`);
    return (
      "\n\nComponent reference (exact param names for common components; " +
      "use gh_component_info only for components NOT listed here, or if a wiring fails):\n" +
      "Input primitives: " + prims.join(" | ") + "\n" +
      lines.join("\n")
    );
  } catch {
    return "";
  }
}

const SYSTEM_APPEND = `
You are embedded in Rhino 8 as a CAD/parametric-design assistant, chatting with
the user through a small panel inside Rhino. The rhino-grasshopper MCP tools
drive the very Rhino instance the user is looking at.

Guidelines:
- Before building a common definition from scratch, check gh_list_templates —
  if one fits, gh_apply_template with parameter overrides is far cheaper and
  more reliable than composing it yourself.
- For Grasshopper work prefer gh_build_recipe to create whole definitions in
  one call; it returns per-component errors, so you usually do NOT need a
  separate gh_get_canvas afterwards. It is idempotent by key: re-run with the
  same keys to tweak rather than duplicate.
- For several edits at once use gh_edit (one batched call), not many
  gh_set_value/gh_connect calls.
- gh_get_canvas defaults to a compact summary; only ask for detail='full' when
  you truly need params/wiring.
- Prefer the component reference below for param names; only call
  gh_component_info for components not listed there, or if a wiring fails.
- Keep chat replies short; the user can see the canvas and viewport, so
  describe what you built and any sliders they can play with.
- Use rhino_capture_viewport to check visual results after baking or modeling.
- rhino_execute_python runs inside the user's live Rhino session: be careful
  with destructive operations and never delete user geometry unless asked.
`.trim() + loadReference();

function summarize(input) {
  let s;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return s.length > 220 ? s.slice(0, 220) + "..." : s;
}

// Auto model routing: cheap model for mechanical edits, stronger for design.
const ROUTE_FAST = "claude-haiku-4-5-20251001";
const ROUTE_STRONG = "claude-sonnet-5";
const MECHANICAL = /\b(set|change|adjust|tweak|update|rename|move|delete|remove|undo|redo|toggle|increase|decrease|bigger|smaller|value|slider|bake|capture|screenshot|show|open|save|clear|recompute)\b/i;
const DESIGN = /\b(design|create|build|model|generate|make|parametric|facade|structure|pattern|lattice|surface|form|geometry)\b/i;

/** Pick a model when the client asked for "auto"; otherwise honor its choice. */
function routeModel(requested, message) {
  if (requested && requested !== "auto") return requested;
  if (!requested) return undefined; // "Default model" -> let the SDK decide
  const m = message || "";
  const short = m.length < 120;
  if (DESIGN.test(m)) return ROUTE_STRONG;
  if (MECHANICAL.test(m) && short) return ROUTE_FAST;
  return ROUTE_STRONG;
}

const METRICS_PATH = path.join(__dirname, "metrics.jsonl");

/** Append one per-request metrics record for benchmarking each phase. */
function recordMetrics(rec) {
  try {
    const u = rec.usage || {};
    const line = {
      ts: new Date().toISOString(),
      label: rec.label,
      model: rec.model,
      turns: rec.turns,
      toolCalls: rec.toolCalls,
      toolCounts: rec.toolCounts,
      inputTokens: u.input_tokens ?? null,
      outputTokens: u.output_tokens ?? null,
      cacheReadTokens: u.cache_read_input_tokens ?? null,
      cacheCreateTokens: u.cache_creation_input_tokens ?? null,
      cost: rec.cost ?? null,
      durationMs: rec.durationMs,
      isError: rec.isError,
      subtype: rec.subtype,
    };
    fs.appendFileSync(METRICS_PATH, JSON.stringify(line) + "\n");
  } catch (e) {
    console.error("metrics write failed:", e.message);
  }
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
  let message, sessionId, model, attachments, label;
  try {
    ({ message, sessionId, model, attachments, label } = JSON.parse(body || "{}"));
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

  let toolCalls = 0;
  const toolCounts = {};
  const startedAt = Date.now();

  const prompt = buildPrompt(message, attachments, sessionId, send);
  const routedModel = routeModel(model, message);
  if (model === "auto" && routedModel) {
    send({ type: "routed", model: routedModel });
  }

  const q = query({
    prompt,
    options: {
      cwd: REPO,
      resume: sessionId || undefined,
      ...(routedModel ? { model: routedModel } : {}),
      permissionMode: "bypassPermissions",
      disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit"],
      mcpServers: {
        "rhino-grasshopper": {
          type: "stdio",
          command: process.execPath,
          args: [path.join(REPO, "dist", "index.js")],
          // Include all tools in the turn-1 (cached) prompt instead of making
          // the agent ToolSearch for them each session.
          alwaysLoad: true,
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
            toolCalls++;
            const short = block.name.replace(/^mcp__rhino-grasshopper__/, "");
            toolCounts[short] = (toolCounts[short] || 0) + 1;
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
        recordMetrics({
          label: label || null,
          model: routedModel || "default",
          turns: msg.num_turns,
          toolCalls,
          toolCounts,
          usage: msg.usage || null,
          cost: msg.total_cost_usd,
          durationMs: Date.now() - startedAt,
          isError: msg.is_error,
          subtype: msg.subtype,
        });
        send({
          type: "done",
          sessionId: msg.session_id,
          cost: msg.total_cost_usd,
          isError: msg.is_error,
          turns: msg.num_turns,
          toolCalls,
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
