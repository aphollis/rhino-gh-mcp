#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpatialEngine } from "spatial-core";
import { RhinoBridge } from "./bridge.js";
import { RhinoGeometryAdapter } from "./spatial-adapter.js";

const PORT = Number(process.env.RHINO_MCP_PORT ?? 8765);
const bridge = new RhinoBridge("127.0.0.1", PORT);
const spatial = new SpatialEngine(new RhinoGeometryAdapter(bridge));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");

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

3D spatial understanding (space_* tools): for ANY metric question (size,
position, distance, clearance, containment, hollowness, wall thickness) use
these instead of screenshots — they return exact numbers. space_digest =
scene inventory; space_measure = one targeted measurement; space_relations =
collision/containment; space_voxels = volumetric occupancy layers;
space_section = internal profiles; space_views = labeled orthographic PNG.
All accept GH handles, so you can measure recipe outputs without baking.
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
    annotations: { destructiveHint: true },
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
    annotations: { readOnlyHint: true },
    description:
      "Summarize the active Rhino document: file path, model units, layers, and object counts by type.",
    inputSchema: {},
  },
  async () => relay("rhino.scene"),
);

server.registerTool(
  "rhino_capture_viewport",
  {
    annotations: { readOnlyHint: true },
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
    annotations: { idempotentHint: true },
    description: "Launch Grasshopper inside Rhino (no-op if already running). Call once before other gh_* tools.",
    inputSchema: {},
  },
  async () => relay("gh.launch", {}, 120_000),
);

server.registerTool(
  "gh_status",
  {
    annotations: { readOnlyHint: true },
    description: "Check whether Grasshopper is running and describe the active document (file, object count).",
    inputSchema: {},
  },
  async () => relay("gh.status"),
);

server.registerTool(
  "gh_search_components",
  {
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
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
    annotations: { destructiveHint: false },
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
    annotations: { destructiveHint: false, idempotentHint: true },
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
    annotations: { destructiveHint: false, idempotentHint: true },
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
    annotations: { destructiveHint: false },
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
    annotations: { destructiveHint: true },
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
    annotations: { readOnlyHint: true },
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
    annotations: { destructiveHint: true },
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
    annotations: { readOnlyHint: true },
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
    annotations: { idempotentHint: true },
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
    annotations: { destructiveHint: true },
    description: "Create a fresh empty Grasshopper document and make it active on the canvas.",
    inputSchema: {},
  },
  async () => relay("gh.new"),
);

server.registerTool(
  "gh_save",
  {
    annotations: { idempotentHint: true },
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
    annotations: { destructiveHint: true },
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
    annotations: { destructiveHint: false },
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
    annotations: { idempotentHint: true },
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

/* ------------------------------- Templates -------------------------------- */

type Template = {
  name: string;
  description: string;
  parameters?: Array<{ key: string; label?: string; default?: unknown }>;
  recipe: { components: any[]; connections?: any[]; clear?: boolean };
};

function loadTemplates(): Template[] {
  try {
    return fs
      .readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf8")) as Template)
      .filter((t) => t && t.name && t.recipe);
  } catch {
    return [];
  }
}

server.registerTool(
  "gh_list_templates",
  {
    annotations: { readOnlyHint: true },
    description:
      "List the built-in parametric templates (proven Grasshopper definitions). Apply one with " +
      "gh_apply_template instead of building common definitions from scratch — it is far cheaper and " +
      "more reliable. Returns each template's name, description, and exposed parameters.",
    inputSchema: {},
  },
  async () =>
    text(
      loadTemplates().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? [],
      })),
    ),
);

server.registerTool(
  "gh_apply_template",
  {
    annotations: { idempotentHint: true },
    description:
      "Build one of the built-in templates on the canvas, optionally overriding its exposed parameters. " +
      "Use gh_list_templates first to see names and parameters. Returns the created component handles " +
      "and any errors. Example: name='circle-tower', params={radius: 12, height: 40}.",
    inputSchema: {
      name: z.string().describe("Template name from gh_list_templates"),
      params: z
        .record(z.union([z.number(), z.string(), z.boolean()]))
        .optional()
        .describe("Overrides for exposed parameters, keyed by parameter key"),
      clear: z.boolean().optional().describe("Clear the canvas before building (default false)"),
    },
  },
  async ({ name, params, clear }) => {
    const tpl = loadTemplates().find((t) => t.name === name);
    if (!tpl) {
      return errorResult(
        `No template named '${name}'. Available: ${loadTemplates().map((t) => t.name).join(", ") || "(none)"}`,
      );
    }
    // Apply parameter overrides onto the matching components (by key).
    const components = tpl.recipe.components.map((c) => ({ ...c }));
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        const comp = components.find((c) => c.key === key);
        if (comp) comp.value = value;
      }
    }
    return relay(
      "gh.build",
      {
        definition: {
          components,
          connections: tpl.recipe.connections ?? [],
          clear: clear ?? tpl.recipe.clear ?? false,
        },
      },
      300_000,
    );
  },
);

/* ---------------------------- Spatial reasoning --------------------------- */

async function spatialCall(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (e) {
    return errorResult(e);
  }
}

const idsParam = z
  .array(z.string())
  .optional()
  .describe("Limit to these ids (doc object GUIDs or GH handles); default all bodies");

server.registerTool(
  "space_digest",
  {
    annotations: { readOnlyHint: true },
    description:
      "Metric inventory of the 3D scene: every body's kind, bounding box, overall dimensions, " +
      "kernel-exact volume/area/centroid, and units. Works on Rhino document objects AND Grasshopper " +
      "component outputs by handle (no baking needed). Prefer this over screenshots for any " +
      "size/position/count question — it returns exact numbers.",
    inputSchema: {
      scope: z.enum(["all", "doc", "gh"]).optional().describe("Source filter (default all)"),
      ids: idsParam,
    },
  },
  async ({ scope, ids }) => spatialCall(() => spatial.digest({ scope, ids })),
);

server.registerTool(
  "space_measure",
  {
    annotations: { readOnlyHint: true },
    description:
      "Targeted spatial measurement. op='distance' (a,b): min distance + closest points between two " +
      "bodies. op='bbox' (ids): union bounding box + dims. op='dims' (id): one body's dimensions. " +
      "op='probe' (point): which solids contain the point + nearest body. Pay-per-question — cheapest " +
      "way to answer a specific metric query.",
    inputSchema: {
      op: z.enum(["distance", "bbox", "dims", "probe"]),
      a: z.string().optional().describe("distance: first body id/handle"),
      b: z.string().optional().describe("distance: second body id/handle"),
      id: z.string().optional().describe("dims: body id/handle"),
      ids: z.array(z.string()).optional().describe("bbox: body ids/handles"),
      point: z.array(z.number()).length(3).optional().describe("probe: [x,y,z]"),
    },
  },
  async (args) => spatialCall(() => spatial.measure(args as never)),
);

server.registerTool(
  "space_relations",
  {
    annotations: { readOnlyHint: true },
    description:
      "Pairwise spatial relationships between bodies: clear (with clearance distance), intersects, " +
      "or containment (a_inside_b / b_inside_a). Use to check collisions, clearances, and nesting. " +
      "Pairs are bbox-prefiltered and capped.",
    inputSchema: {
      ids: idsParam,
      maxPairs: z.number().int().min(1).max(100).optional().describe("Pair cap (default 20)"),
    },
  },
  async ({ ids, maxPairs }) => spatialCall(() => spatial.relations({ ids, maxPairs })),
);

server.registerTool(
  "space_voxels",
  {
    annotations: { readOnlyHint: true },
    description:
      "Volumetric occupancy of the scene as stacked ASCII layers ('#'=filled, '.'=empty) along an " +
      "axis — a 3D mental model you can reason over slice by slice. Reveals hollowness, mass " +
      "distribution, and internal structure that no screenshot shows. Default 16-cell resolution.",
    inputSchema: {
      ids: idsParam,
      res: z.number().int().min(4).max(48).optional().describe("Cells along longest axis (default 16)"),
      axis: z.enum(["x", "y", "z"]).optional().describe("Stacking axis (default z)"),
    },
  },
  async ({ ids, res, axis }) => spatialCall(() => spatial.voxels({ ids, res, axis })),
);

server.registerTool(
  "space_section",
  {
    annotations: { readOnlyHint: true },
    description:
      "Cut the scene with a plane and return the profile loops with lengths, areas, and wall " +
      "thickness (when nested loops exist). The way to inspect internal structure: shells, " +
      "cavities, wall thicknesses.",
    inputSchema: {
      origin: z.array(z.number()).length(3).describe("Point on the cutting plane [x,y,z]"),
      normal: z.array(z.number()).length(3).describe("Plane normal [x,y,z]"),
      ids: idsParam,
    },
  },
  async ({ origin, normal, ids }) =>
    spatialCall(() =>
      spatial.section({
        ids,
        origin: origin as [number, number, number],
        normal: normal as [number, number, number],
      }),
    ),
);

server.registerTool(
  "space_fit",
  {
    annotations: { readOnlyHint: true },
    description:
      "Free-space/placement search: find axis-aligned positions where a box of given dimensions fits " +
      "with a clearance on all sides, avoiding existing geometry. Returns candidate placements (bbox + " +
      "center) sorted by distance to a target point, plus the total number of valid positions. Use for " +
      "'where can this part go?' assembly questions. Grid-approximate — verify a chosen spot with " +
      "space_measure.",
    inputSchema: {
      dims: z.array(z.number().positive()).length(3).describe("Part size [dx,dy,dz] in doc units"),
      clearance: z.number().min(0).optional().describe("Required clearance on all sides (default 0)"),
      ids: idsParam,
      region: z
        .object({
          min: z.array(z.number()).length(3),
          max: z.array(z.number()).length(3),
        })
        .optional()
        .describe("Search region bbox; default = scene bbox expanded by the part size"),
      target: z.array(z.number()).length(3).optional().describe("Prefer placements near this point"),
      res: z.number().int().min(8).max(64).optional().describe("Grid cells along longest axis (default 32)"),
      maxResults: z.number().int().min(1).max(20).optional().describe("Candidates to return (default 5)"),
    },
  },
  async ({ dims, clearance, ids, region, target, res, maxResults }) =>
    spatialCall(() =>
      spatial.fit({
        dims: dims as [number, number, number],
        clearance,
        ids,
        region: region as { min: [number, number, number]; max: [number, number, number] } | undefined,
        target: target as [number, number, number] | undefined,
        res,
        maxResults,
      }),
    ),
);

server.registerTool(
  "space_views",
  {
    annotations: { readOnlyHint: true },
    description:
      "Neutral engineering multiview of the geometry: one PNG with four labeled orthographic tiles " +
      "(top / front / right / iso), depth-shaded with a scale grid, plus a text legend. Better than " +
      "a perspective screenshot for understanding form — no camera guesswork.",
    inputSchema: {
      ids: idsParam,
      tile: z.number().int().min(120).max(480).optional().describe("Pixels per tile (default 240)"),
    },
  },
  async ({ ids, tile }) => {
    try {
      const r = await spatial.views({ ids, tile });
      return {
        content: [
          { type: "text", text: r.legend },
          { type: "image", data: r.png.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.registerTool(
  "space_pick",
  {
    description:
      "Identify what is under a pixel of the MOST RECENT space_views image (call with the SAME ids " +
      "and tile as that space_views call). px/py are full-image coordinates (0..2*tile). Returns the " +
      "quadrant name and the hit body id/name + 3D world point, or null for background. Use when you " +
      "see something in a rendered view and need to know which body it is.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      px: z.number().int().min(0).describe("Pixel x in the full views image"),
      py: z.number().int().min(0).describe("Pixel y in the full views image"),
      ids: idsParam,
      tile: z.number().int().min(120).max(480).optional().describe("Tile size used in the space_views call (default 240)"),
    },
  },
  async ({ px, py, ids, tile }) => spatialCall(() => spatial.pick({ px, py, ids, tile })),
);

server.registerTool(
  "rhino_get_selection",
  {
    description:
      "List the objects the user currently has SELECTED in Rhino (id, name, type, layer, bbox). " +
      "Call this whenever the user says 'this', 'these', 'the selected part' — it resolves what " +
      "they are pointing at.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
  },
  async () => relay("rhino.selection"),
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
