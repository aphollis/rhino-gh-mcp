#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RhinoBridge } from "./bridge.js";

const PORT = Number(process.env.RHINO_MCP_PORT ?? 8765);
const bridge = new RhinoBridge("127.0.0.1", PORT);

const INSTRUCTIONS = `
Tools for driving Rhino 8 and Grasshopper live. A listener script must be running
inside Rhino (rhino/mcp_listener.py via the ScriptEditor command).

Typical Grasshopper recipe workflow:
1. gh_launch (once) — start Grasshopper if it isn't open.
2. gh_search_components to find component names, gh_component_info to inspect
   input/output parameter names before wiring.
3. gh_build_recipe to create a whole definition in one call (preferred), or
   gh_add_component / gh_connect / gh_set_value for incremental edits.
4. gh_get_canvas after building — check the errors/warnings on each component.
5. gh_get_output to read computed values, gh_bake to push geometry into the
   Rhino document, rhino_capture_viewport to see the result.

Notes:
- Components are addressed by a short HANDLE (e.g. "r", "c") returned when they
  are created, or by their full instance id/GUID. Prefer handles: gh_build_recipe
  keys and gh_add keys become handles you can pass to gh_connect/gh_set_value/
  gh_get_output/gh_bake. Handles reset when the document is cleared or replaced.
- Param names accept full name, nickname, or 0-based index. If a component has
  a single input/output the param can be omitted. On a wrong param name the tool
  returns the available param names, so you can correct without gh_component_info.
- gh_build_recipe is idempotent by key: re-running with the same keys updates
  those components in place instead of creating duplicates.
- "slider", "panel", "toggle", "valuelist", "button" are accepted as component
  types for the standard input objects; everything else is resolved against the
  installed component library by name or GUID.
- rhino_execute_python is the escape hatch: it runs Python inside Rhino with
  Rhino, rs (rhinoscriptsyntax), sc (scriptcontext) and System preloaded.
  Assign to a variable named result to get a value back.
`.trim();

const server = new McpServer(
  { name: "rhino-grasshopper", version: "0.1.0" },
  { instructions: INSTRUCTIONS },
);

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

function text(value: unknown): ToolResult {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: s }] };
}

function errorResult(e: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

async function relay(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<ToolResult> {
  try {
    return text(await bridge.call(method, params, timeoutMs));
  } catch (e) {
    return errorResult(e);
  }
}

/* ------------------------------- Rhino tools ------------------------------ */

server.registerTool(
  "rhino_execute_python",
  {
    description:
      "Run Python code inside Rhino 8 on the UI thread. Preloaded globals: Rhino (RhinoCommon), " +
      "rs (rhinoscriptsyntax), sc (scriptcontext), System, clr. Globals persist between calls. " +
      "print() output is captured; assign to a variable named `result` to return a value. " +
      "Use this for direct Rhino modeling/scene edits or anything the dedicated tools don't cover.",
    inputSchema: {
      code: z.string().describe("Python source to execute inside Rhino"),
    },
  },
  async ({ code }) => relay("rhino.execute", { code }, 300_000),
);

server.registerTool(
  "rhino_scene_info",
  {
    description:
      "Summarize the active Rhino document: file path, model units, layers, and object counts by type.",
    inputSchema: {},
  },
  async () => relay("rhino.scene"),
);

server.registerTool(
  "rhino_capture_viewport",
  {
    description:
      "Capture a Rhino viewport as a PNG image so you can see the current 3D scene. " +
      "Useful after baking Grasshopper geometry or running modeling code.",
    inputSchema: {
      view: z.string().optional().describe("Viewport name (e.g. 'Perspective', 'Top'); defaults to the active view"),
      width: z.number().int().min(64).max(3840).optional().describe("Image width in px (default 960)"),
      height: z.number().int().min(64).max(2160).optional().describe("Image height in px (default 720)"),
    },
  },
  async ({ view, width, height }) => {
    try {
      const r = await bridge.call("rhino.capture", { view, width: width ?? 960, height: height ?? 720 }, 120_000);
      return {
        content: [
          { type: "text", text: `Viewport: ${r.view}` },
          { type: "image", data: r.png_base64, mimeType: "image/png" },
        ],
      };
    } catch (e) {
      return errorResult(e);
    }
  },
);

/* ---------------------------- Grasshopper tools --------------------------- */

server.registerTool(
  "gh_launch",
  {
    description: "Launch Grasshopper inside Rhino (no-op if already running). Call once before other gh_* tools.",
    inputSchema: {},
  },
  async () => relay("gh.launch", {}, 120_000),
);

server.registerTool(
  "gh_status",
  {
    description: "Check whether Grasshopper is running and describe the active document (file, object count).",
    inputSchema: {},
  },
  async () => relay("gh.status"),
);

server.registerTool(
  "gh_search_components",
  {
    description:
      "Search the installed Grasshopper component library by name/description (e.g. 'extrude', 'voronoi', " +
      "'divide curve'). Returns name, category, description and GUID. Use the exact name or GUID when adding.",
    inputSchema: {
      query: z.string().describe("Search text, e.g. 'loft' or 'circle'"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
    },
  },
  async ({ query, limit }) => relay("gh.search", { query, limit }),
);

server.registerTool(
  "gh_component_info",
  {
    description:
      "Inspect a component type before placing it: lists its input and output parameters " +
      "(names, nicknames, types, optionality). Accepts a component name or GUID.",
    inputSchema: {
      type: z.string().describe("Component name (e.g. 'Circle') or GUID"),
    },
  },
  async ({ type }) => relay("gh.info", { type }),
);

const componentProps = {
  nickname: z.string().optional().describe("Display nickname for the component"),
  value: z
    .union([z.number(), z.string(), z.boolean()])
    .optional()
    .describe("Initial value: slider number, panel text, toggle boolean, or value-list selection"),
  min: z.number().optional().describe("Slider minimum"),
  max: z.number().optional().describe("Slider maximum"),
  integer: z.boolean().optional().describe("Make a slider integer-valued"),
  text: z.string().optional().describe("Panel text (alias for value on panels)"),
  items: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .describe("Items for a value list"),
};

server.registerTool(
  "gh_add_component",
  {
    description:
      "Add one component to the Grasshopper canvas. Type is a library name/GUID, or one of the input " +
      "primitives: 'slider' (use min/max/value/integer), 'panel' (use text), 'toggle' (use value), " +
      "'valuelist' (use items), 'button'. Returns the instance id used by gh_connect/gh_set_value. " +
      "For building several components at once prefer gh_build_recipe.",
    inputSchema: {
      type: z.string().describe("Component name, GUID, or slider/panel/toggle/valuelist/button"),
      key: z.string().optional().describe("Short handle to address this component later (auto-assigned if omitted)"),
      x: z.number().optional().describe("Canvas x position (default 100)"),
      y: z.number().optional().describe("Canvas y position (default 100)"),
      ...componentProps,
    },
  },
  async (args) => relay("gh.add", args),
);

server.registerTool(
  "gh_set_value",
  {
    description:
      "Set the value of an existing canvas object: slider number (optionally new min/max), panel text, " +
      "toggle boolean, value-list selection, or persistent data on a floating parameter.",
    inputSchema: {
      id: z.string().describe("Handle or instance id of the object"),
      value: z.union([z.number(), z.string(), z.boolean()]).describe("New value"),
      min: z.number().optional().describe("New slider minimum"),
      max: z.number().optional().describe("New slider maximum"),
    },
  },
  async (args) => relay("gh.set_value", args),
);

server.registerTool(
  "gh_connect",
  {
    description:
      "Wire an output of one component into an input of another. Params accept name, nickname or 0-based " +
      "index and can be omitted when the component has exactly one param on that side (sliders/panels " +
      "never need a param). Returns the target's runtime errors/warnings after solving.",
    inputSchema: {
      from_id: z.string().describe("Source component handle or instance id"),
      from_param: z.string().optional().describe("Source output param (name or index)"),
      to_id: z.string().describe("Target component handle or instance id"),
      to_param: z.string().optional().describe("Target input param (name or index)"),
    },
  },
  async (args) => relay("gh.connect", args),
);

server.registerTool(
  "gh_disconnect",
  {
    description:
      "Remove a wire from a target input. If from_id is omitted, removes ALL sources feeding that input.",
    inputSchema: {
      to_id: z.string().describe("Target component handle or instance id"),
      to_param: z.string().optional().describe("Target input param (name or index)"),
      from_id: z.string().optional().describe("Source component handle/id; omit to clear all sources"),
      from_param: z.string().optional().describe("Source output param"),
    },
  },
  async (args) => relay("gh.disconnect", args),
);

server.registerTool(
  "gh_delete_components",
  {
    description: "Delete objects from the Grasshopper canvas by instance id.",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe("Handles or instance ids to delete"),
    },
  },
  async ({ ids }) => relay("gh.delete", { ids }),
);

server.registerTool(
  "gh_get_canvas",
  {
    description:
      "Get the state of the Grasshopper definition. detail='summary' (default) returns a compact " +
      "line per object (handle, type, nickname, and any errors/warnings) — cheap, use this first. " +
      "detail='problems' returns full detail for only the components that have errors/warnings. " +
      "detail='full' returns everything (params, wiring, data counts) for every object.",
    inputSchema: {
      detail: z.enum(["summary", "problems", "full"]).optional().describe("Verbosity (default summary)"),
    },
  },
  async ({ detail }) => relay("gh.canvas", { detail }, 120_000),
);

server.registerTool(
  "gh_edit",
  {
    description:
      "Apply a batch of edits to the canvas in ONE call, solving once at the end and reporting " +
      "per-op results plus any resulting errors. Prefer this over multiple gh_set_value/gh_connect " +
      "calls. Each op has an 'op' field: " +
      "{op:'set', id, value, min?, max?}, " +
      "{op:'connect', from_id, from_param?, to_id, to_param?}, " +
      "{op:'disconnect', to_id, to_param?, from_id?}, " +
      "{op:'delete', id}. ids may be handles or GUIDs.",
    inputSchema: {
      ops: z
        .array(
          z.object({
            op: z.enum(["set", "connect", "disconnect", "delete"]),
            id: z.string().optional(),
            value: z.union([z.number(), z.string(), z.boolean()]).optional(),
            min: z.number().optional(),
            max: z.number().optional(),
            from_id: z.string().optional(),
            from_param: z.string().optional(),
            to_id: z.string().optional(),
            to_param: z.string().optional(),
          }),
        )
        .min(1)
        .describe("Ordered list of edit operations"),
    },
  },
  async ({ ops }) => relay("gh.edit", { ops }, 300_000),
);

server.registerTool(
  "gh_get_output",
  {
    description:
      "Read the computed data of a component output (or floating param) as text, organised by data-tree " +
      "branch. Use to verify a recipe produces the expected numbers/geometry.",
    inputSchema: {
      id: z.string().describe("Handle or instance id"),
      param: z.string().optional().describe("Output param name/index (default: first/only output)"),
      max_items: z.number().int().min(1).max(1000).optional().describe("Max items to return (default 50)"),
    },
  },
  async (args) => relay("gh.output", args),
);

server.registerTool(
  "gh_recompute",
  {
    description: "Recompute the Grasshopper solution. expire_all=true (default) forces every component to re-solve.",
    inputSchema: {
      expire_all: z.boolean().optional(),
    },
  },
  async (args) => relay("gh.recompute", args, 300_000),
);

server.registerTool(
  "gh_new_document",
  {
    description: "Create a fresh empty Grasshopper document and make it active on the canvas.",
    inputSchema: {},
  },
  async () => relay("gh.new"),
);

server.registerTool(
  "gh_save",
  {
    description: "Save the active Grasshopper definition to a .gh file.",
    inputSchema: {
      path: z.string().describe("Absolute path ending in .gh, e.g. C:\\\\Users\\\\me\\\\recipe.gh"),
    },
  },
  async ({ path }) => relay("gh.save", { path }),
);

server.registerTool(
  "gh_open",
  {
    description: "Open a .gh/.ghx file and make it the active document.",
    inputSchema: {
      path: z.string().describe("Absolute path to the Grasshopper file"),
    },
  },
  async ({ path }) => relay("gh.open", { path }, 180_000),
);

server.registerTool(
  "gh_bake",
  {
    description:
      "Bake the geometry from a component output into the Rhino document (optionally onto a named layer) " +
      "so it becomes real, editable Rhino geometry.",
    inputSchema: {
      id: z.string().describe("Handle or instance id of the component/param to bake"),
      param: z.string().optional().describe("Output param name/index (default: first/only output)"),
      layer: z.string().optional().describe("Layer name to bake onto (created if missing)"),
    },
  },
  async (args) => relay("gh.bake", args, 300_000),
);

const recipeComponent = z.object({
  key: z.string().describe("Unique short key used to reference this component in connections"),
  type: z.string().describe("Component name/GUID, or slider/panel/toggle/valuelist/button"),
  x: z.number().optional().describe("Canvas x (auto-layout if omitted)"),
  y: z.number().optional().describe("Canvas y (auto-layout if omitted)"),
  nickname: z.string().optional(),
  value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
  text: z.string().optional(),
  items: z.array(z.union([z.string(), z.number()])).optional(),
});

const recipeConnection = z.object({
  from: z.string().describe("Key of the source component"),
  from_param: z.string().optional().describe("Source output param (name or index)"),
  to: z.string().describe("Key of the target component"),
  to_param: z.string().optional().describe("Target input param (name or index)"),
});

server.registerTool(
  "gh_build_recipe",
  {
    description:
      "Build a whole Grasshopper definition (a 'recipe') in one call: places all components with automatic " +
      "left-to-right dataflow layout, applies slider/panel/toggle values, wires all connections, solves, and " +
      "reports per-component errors. This is the preferred way to create definitions — much faster than " +
      "adding components one at a time. Verify param names with gh_component_info first if unsure. " +
      "Example: components [{key:'r', type:'slider', min:1, max:20, value:5}, {key:'c', type:'Circle'}], " +
      "connections [{from:'r', to:'c', to_param:'Radius'}].",
    inputSchema: {
      components: z.array(recipeComponent).min(1),
      connections: z.array(recipeConnection).optional(),
      clear: z.boolean().optional().describe("Clear the canvas before building (default false)"),
    },
  },
  async ({ components, connections, clear }) =>
    relay("gh.build", { definition: { components, connections: connections ?? [], clear: clear ?? false } }, 300_000),
);

/* --------------------------------- main ----------------------------------- */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`rhino-gh-mcp: MCP server running on stdio, expecting Rhino listener on 127.0.0.1:${PORT}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
