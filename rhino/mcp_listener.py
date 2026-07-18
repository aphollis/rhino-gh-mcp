# -*- coding: utf-8 -*-
"""
mcp_listener.py - run this INSIDE Rhino 8.

How to run:
  1. In Rhino, type the command:  ScriptEditor
  2. Open this file in the Script Editor and press Run (F5).
  3. The listener keeps running in the background until Rhino closes.
     Re-running the script safely restarts it.

It serves newline-delimited JSON over TCP on 127.0.0.1:8765 for the
rhino-gh-mcp Node server:  {"id": 1, "method": "gh.add", "params": {...}}
All Rhino/Grasshopper work is marshalled onto the UI thread.

Written to work in both Rhino 8 CPython 3 and IronPython 2.7.
"""

import json
import re
import socket
import sys
import threading
import time
import traceback

try:
    from io import StringIO
except ImportError:  # IronPython 2 fallback
    from StringIO import StringIO

import clr

clr.AddReference("System.Drawing")
import System
import System.Drawing
import Rhino

HOST = "127.0.0.1"
PORT = 8765
UI_TIMEOUT = 600  # seconds a single command may wait on the UI thread

_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-?([0-9a-fA-F]{4}-?){3}[0-9a-fA-F]{12}$")

_gh_module = None


def GH():
    """Lazy-load the Grasshopper assembly (may not be loaded at Rhino start)."""
    global _gh_module
    if _gh_module is None:
        clr.AddReference("Grasshopper")
        import Grasshopper
        _gh_module = Grasshopper
    return _gh_module


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def to_decimal(v):
    return System.Convert.ToDecimal(float(v))


def safe_str(v):
    if v is None:
        return None
    try:
        return str(v)
    except Exception:
        return None


def run_on_ui(fn, timeout=UI_TIMEOUT):
    """Execute fn() on the Rhino UI thread and return its result."""
    box = {}
    done = threading.Event()

    def wrapper():
        try:
            box["result"] = fn()
        except Exception:
            box["error"] = traceback.format_exc()
        finally:
            done.set()

    Rhino.RhinoApp.InvokeOnUiThread(System.Action(wrapper))
    if not done.wait(timeout):
        raise RuntimeError(
            "Timed out waiting for the Rhino UI thread. Rhino may be busy "
            "or a modal dialog may be open on screen.")
    if "error" in box:
        raise RuntimeError(box["error"])
    return box.get("result")


def get_canvas():
    canvas = GH().Instances.ActiveCanvas
    if canvas is None:
        raise RuntimeError("Grasshopper is not running. Call gh_launch first.")
    return canvas


def get_doc():
    G = GH()
    canvas = get_canvas()
    doc = canvas.Document
    if doc is None:
        doc = G.Kernel.GH_Document()
        G.Instances.DocumentServer.AddDocument(doc)
        canvas.Document = doc
    return doc


# Short stable handles: key -> InstanceGuid string. Lets the agent address
# components by "r"/"c" instead of 36-char GUIDs. Reset on new/cleared docs.
_HANDLES = {}


def register_handle(key, guid):
    if key:
        _HANDLES[str(key)] = str(guid)


def reset_handles():
    _HANDLES.clear()


def find_obj(doc, id_str):
    """Resolve an object by GUID or by a short handle key."""
    s = str(id_str)
    if s in _HANDLES:
        s = _HANDLES[s]
    try:
        target = System.Guid.Parse(s)
    except Exception:
        raise RuntimeError(
            "'%s' is not a known handle or GUID. Known handles: %s" %
            (id_str, ", ".join(sorted(_HANDLES.keys())) or "(none)"))
    for o in doc.Objects:
        if o.InstanceGuid == target:
            return o
    # Stale handle (component was deleted): drop it so it stops resolving.
    for k, v in list(_HANDLES.items()):
        if v == s:
            del _HANDLES[k]
    raise RuntimeError("No object with id/handle %s on the canvas." % id_str)


def messages(obj):
    G = GH()
    out = {"errors": [], "warnings": []}
    if hasattr(obj, "RuntimeMessages"):
        try:
            out["errors"] = [safe_str(m) for m in
                             obj.RuntimeMessages(G.Kernel.GH_RuntimeMessageLevel.Error)]
            out["warnings"] = [safe_str(m) for m in
                               obj.RuntimeMessages(G.Kernel.GH_RuntimeMessageLevel.Warning)]
        except Exception:
            pass
    return out


def iter_proxies():
    G = GH()
    for p in G.Instances.ComponentServer.ObjectProxies:
        try:
            if p.Obsolete:
                continue
            if p.Exposure == G.Kernel.GH_Exposure.hidden:
                continue
        except Exception:
            pass
        yield p


def proxy_summary(p):
    d = p.Desc
    info = {"name": safe_str(d.Name), "guid": safe_str(p.Guid)}
    for attr, key in (("NickName", "nickname"), ("Description", "description"),
                      ("Category", "category"), ("SubCategory", "subcategory")):
        try:
            info[key] = safe_str(getattr(d, attr))
        except Exception:
            pass
    return info


SPECIAL_TYPES = ("slider", "number slider", "panel", "toggle", "boolean toggle",
                 "valuelist", "value list", "dropdown", "button")


def make_special(low):
    G = GH()
    if low in ("slider", "number slider"):
        return G.Kernel.Special.GH_NumberSlider()
    if low == "panel":
        return G.Kernel.Special.GH_Panel()
    if low in ("toggle", "boolean toggle"):
        return G.Kernel.Special.GH_BooleanToggle()
    if low in ("valuelist", "value list", "dropdown"):
        return G.Kernel.Special.GH_ValueList()
    if low == "button":
        return G.Kernel.Special.GH_ButtonObject()
    return None


def make_object(type_spec):
    """Create (but do not add) a document object from a type name or GUID."""
    G = GH()
    t = str(type_spec or "").strip()
    if not t:
        raise RuntimeError("Empty component type.")
    low = t.lower()

    obj = make_special(low)
    if obj is not None:
        return obj

    if _GUID_RE.match(t):
        proxy = G.Instances.ComponentServer.EmitObjectProxy(System.Guid.Parse(t))
        if proxy is None:
            raise RuntimeError("No installed component has GUID %s." % t)
        return proxy.CreateInstance()

    exact = []
    partial = []
    for p in iter_proxies():
        d = p.Desc
        name = (safe_str(d.Name) or "").lower()
        nick = ""
        try:
            nick = (safe_str(d.NickName) or "").lower()
        except Exception:
            pass
        if name == low or nick == low:
            exact.append(p)
        elif low in name:
            partial.append(p)

    candidates = exact if exact else partial
    if not candidates:
        raise RuntimeError(
            "No component named '%s'. Use gh_search_components to find the right name." % t)

    if len(candidates) > 1:
        # Prefer real components (things with Params) over floating parameters.
        instances = []
        for p in candidates:
            try:
                inst = p.CreateInstance()
                instances.append((p, inst))
            except Exception:
                pass
        comps = [(p, i) for (p, i) in instances if hasattr(i, "Params")]
        if len(comps) == 1:
            return comps[0][1]
        listing = "; ".join(
            "%s [%s > %s] guid=%s" % (s.get("name"), s.get("category"),
                                      s.get("subcategory"), s.get("guid"))
            for s in [proxy_summary(p) for p in candidates])
        raise RuntimeError(
            "Ambiguous component name '%s'. Candidates: %s. Pass the GUID instead." % (t, listing))

    return candidates[0].CreateInstance()


def apply_props(obj, params):
    """Apply slider/panel/toggle/valuelist values and nickname from params."""
    G = GH()
    tn = obj.GetType().Name

    if tn == "GH_NumberSlider":
        if params.get("min") is not None:
            obj.Slider.Minimum = to_decimal(params["min"])
        if params.get("max") is not None:
            obj.Slider.Maximum = to_decimal(params["max"])
        if params.get("integer"):
            obj.Slider.Type = G.GUI.Base.GH_SliderAccuracy.Integer
        if params.get("value") is not None:
            obj.SetSliderValue(to_decimal(params["value"]))

    elif tn == "GH_Panel":
        txt = params.get("text")
        if txt is None:
            txt = params.get("value")
        if txt is not None:
            if hasattr(obj, "SetUserText"):
                obj.SetUserText(str(txt))
            else:
                obj.UserText = str(txt)

    elif tn == "GH_BooleanToggle":
        if params.get("value") is not None:
            obj.Value = bool(params["value"])

    elif tn == "GH_ValueList":
        items = params.get("items")
        if items:
            obj.ListItems.Clear()
            for it in items:
                if isinstance(it, bool):
                    name, expr = str(it), ("true" if it else "false")
                elif isinstance(it, (int, float)):
                    name, expr = str(it), str(it)
                else:
                    name, expr = str(it), '"%s"' % str(it)
                obj.ListItems.Add(G.Kernel.Special.GH_ValueListItem(name, expr))
        sel = params.get("value")
        if sel is not None:
            try:
                for i in range(obj.ListItems.Count):
                    if obj.ListItems[i].Name == str(sel):
                        obj.SelectItem(i)
                        break
            except Exception:
                pass

    nick = params.get("nickname")
    if nick:
        obj.NickName = str(nick)


def resolve_param(obj, name, direction):
    """Find an input/output param on obj by name, nickname or index."""
    if not hasattr(obj, "Params"):
        return obj  # floating parameter / slider / panel: it IS the param

    plist = obj.Params.Input if direction == "input" else obj.Params.Output
    names = ", ".join([safe_str(p.Name) or "?" for p in plist])

    if name is None or str(name).strip() == "":
        if plist.Count == 1:
            return plist[0]
        raise RuntimeError(
            "Component '%s' has %d %s params (%s) - specify which one." %
            (safe_str(obj.Name), plist.Count, direction, names))

    s = str(name).strip()
    try:
        idx = int(s)
        if 0 <= idx < plist.Count:
            return plist[idx]
        raise RuntimeError(
            "Param index %d out of range on '%s' (%d %s params)." %
            (idx, safe_str(obj.Name), plist.Count, direction))
    except ValueError:
        pass

    low = s.lower()
    for p in plist:
        if (safe_str(p.Name) or "").lower() == low or (safe_str(p.NickName) or "").lower() == low:
            return p
    raise RuntimeError(
        "No %s param '%s' on '%s'. Available: %s" %
        (direction, s, safe_str(obj.Name), names))


def param_info(p, with_data=False):
    info = {"name": safe_str(p.Name), "nickname": safe_str(p.NickName)}
    for attr, key in (("TypeName", "type"), ("Description", "description")):
        try:
            info[key] = safe_str(getattr(p, attr))
        except Exception:
            pass
    try:
        info["optional"] = bool(p.Optional)
    except Exception:
        pass
    if with_data:
        try:
            info["data_count"] = p.VolatileDataCount
        except Exception:
            pass
        try:
            srcs = []
            for s in p.Sources:
                owner = s
                try:
                    owner = s.Attributes.GetTopLevel.DocObject
                except Exception:
                    pass
                srcs.append({"owner_id": safe_str(owner.InstanceGuid),
                             "owner": safe_str(owner.NickName) or safe_str(owner.Name),
                             "param": safe_str(s.Name)})
            if srcs:
                info["sources"] = srcs
        except Exception:
            pass
    return info


def describe_obj(obj):
    d = {"id": safe_str(obj.InstanceGuid),
         "type": obj.GetType().Name,
         "name": safe_str(obj.Name),
         "nickname": safe_str(obj.NickName)}
    try:
        piv = obj.Attributes.Pivot
        d["position"] = [round(piv.X, 1), round(piv.Y, 1)]
    except Exception:
        pass
    d.update(messages(obj))

    tn = d["type"]
    try:
        if tn == "GH_NumberSlider":
            d["value"] = System.Convert.ToDouble(obj.CurrentValue)
            d["min"] = System.Convert.ToDouble(obj.Slider.Minimum)
            d["max"] = System.Convert.ToDouble(obj.Slider.Maximum)
        elif tn == "GH_Panel":
            d["text"] = safe_str(obj.UserText)
        elif tn == "GH_BooleanToggle":
            d["value"] = bool(obj.Value)
        elif tn == "GH_ValueList":
            d["items"] = [safe_str(li.Name) for li in obj.ListItems]
            try:
                d["selected"] = safe_str(obj.FirstSelectedItem.Name)
            except Exception:
                pass
    except Exception:
        pass

    if hasattr(obj, "Params"):
        d["inputs"] = [param_info(p, True) for p in obj.Params.Input]
        d["outputs"] = [param_info(p, True) for p in obj.Params.Output]
    elif hasattr(obj, "Sources"):
        d.update(param_info(obj, True))
    return d


def stringify_item(item):
    try:
        return item.ToString()
    except Exception:
        return safe_str(item)


# --------------------------------------------------------------------------- #
# command handlers
# --------------------------------------------------------------------------- #

EXEC_GLOBALS = None


def cmd_rhino_execute(params):
    code = params.get("code") or ""

    def work():
        global EXEC_GLOBALS
        if EXEC_GLOBALS is None:
            import rhinoscriptsyntax as rs
            import scriptcontext as sc
            EXEC_GLOBALS = {"Rhino": Rhino, "rs": rs, "sc": sc,
                            "System": System, "clr": clr,
                            "__name__": "__rhino_mcp__"}
        EXEC_GLOBALS.pop("result", None)
        old_stdout = sys.stdout
        sys.stdout = cap = StringIO()
        try:
            exec(code, EXEC_GLOBALS)
        finally:
            sys.stdout = old_stdout
        result = EXEC_GLOBALS.get("result")
        return {"stdout": cap.getvalue()[-20000:],
                "result": None if result is None else safe_str(result)}

    return run_on_ui(work, timeout=UI_TIMEOUT)


def cmd_rhino_scene(params):
    def work():
        doc = Rhino.RhinoDoc.ActiveDoc
        layers = []
        for l in doc.Layers:
            try:
                if not l.IsDeleted:
                    layers.append(l.FullPath)
            except Exception:
                pass
        counts = {}
        total = 0
        for o in doc.Objects:
            total += 1
            t = o.ObjectType.ToString()
            counts[t] = counts.get(t, 0) + 1
        return {"path": safe_str(doc.Path),
                "units": doc.ModelUnitSystem.ToString(),
                "layers": layers,
                "object_total": total,
                "object_counts": counts}

    return run_on_ui(work)


def cmd_rhino_capture(params):
    def work():
        doc = Rhino.RhinoDoc.ActiveDoc
        view = None
        name = params.get("view")
        if name:
            view = doc.Views.Find(str(name), False)
            if view is None:
                raise RuntimeError("No viewport named '%s'." % name)
        if view is None:
            view = doc.Views.ActiveView
        if view is None:
            raise RuntimeError("No active view in Rhino.")
        w = int(params.get("width") or 960)
        h = int(params.get("height") or 720)
        bmp = view.CaptureToBitmap(System.Drawing.Size(w, h))
        if bmp is None:
            raise RuntimeError("Viewport capture failed.")
        ms = System.IO.MemoryStream()
        bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png)
        return {"view": view.ActiveViewport.Name,
                "png_base64": System.Convert.ToBase64String(ms.ToArray())}

    return run_on_ui(work, timeout=120)


def cmd_gh_launch(params):
    def work():
        try:
            if GH().Instances.ActiveCanvas is not None:
                return True
        except Exception:
            pass
        Rhino.RhinoApp.RunScript("_Grasshopper", False)
        return True

    run_on_ui(work, timeout=120)
    for _ in range(60):
        try:
            if GH().Instances.ActiveCanvas is not None:
                return {"running": True}
        except Exception:
            pass
        time.sleep(0.5)
    return {"running": False,
            "note": "Grasshopper may still be loading; check gh_status in a moment."}


def cmd_gh_status(params):
    try:
        canvas = GH().Instances.ActiveCanvas
    except Exception as e:
        return {"running": False, "error": safe_str(e)}
    if canvas is None:
        return {"running": False, "note": "Call gh_launch to start Grasshopper."}
    doc = canvas.Document
    info = {"running": True}
    if doc is not None:
        info["document"] = {"file": safe_str(doc.FilePath),
                            "object_count": doc.ObjectCount}
    return info


def cmd_gh_search(params):
    query = (str(params.get("query") or "")).strip().lower()
    limit = int(params.get("limit") or 20)
    if not query:
        raise RuntimeError("Empty search query.")
    tokens = query.split()

    def work():
        scored = []
        for p in iter_proxies():
            d = p.Desc
            name = (safe_str(d.Name) or "").lower()
            nick, desc, cat = "", "", ""
            try:
                nick = (safe_str(d.NickName) or "").lower()
            except Exception:
                pass
            try:
                desc = (safe_str(d.Description) or "").lower()
            except Exception:
                pass
            try:
                cat = ((safe_str(d.Category) or "") + " " +
                       (safe_str(d.SubCategory) or "")).lower()
            except Exception:
                pass

            score = 0
            if query == name:
                score = 100
            elif query == nick:
                score = 90
            elif name.startswith(query):
                score = 80
            elif query in name:
                score = 60
            elif query in nick:
                score = 50
            else:
                hay = " ".join([name, nick, desc, cat])
                if all(tok in hay for tok in tokens):
                    score = 30
            if score:
                scored.append((score, proxy_summary(p)))

        scored.sort(key=lambda t: (-t[0], t[1].get("name") or ""))
        results = [s for _, s in scored[:limit]]
        return {"total_matches": len(scored), "results": results}

    return run_on_ui(work)


def cmd_gh_info(params):
    def work():
        obj = make_object(params.get("type"))
        d = {"name": safe_str(obj.Name),
             "type": obj.GetType().Name,
             "guid": safe_str(obj.ComponentGuid)}
        try:
            d["description"] = safe_str(obj.Description)
        except Exception:
            pass
        try:
            d["category"] = safe_str(obj.Category) + " > " + safe_str(obj.SubCategory)
        except Exception:
            pass
        if hasattr(obj, "Params"):
            d["inputs"] = [param_info(p) for p in obj.Params.Input]
            d["outputs"] = [param_info(p) for p in obj.Params.Output]
        else:
            d["kind"] = "parameter or input object (acts as a single param)"
        return d

    return run_on_ui(work)


def _auto_key(doc):
    n = 1
    while ("c%d" % n) in _HANDLES:
        n += 1
    return "c%d" % n


def cmd_gh_add(params):
    def work():
        doc = get_doc()
        obj = make_object(params.get("type"))
        obj.CreateAttributes()
        x = float(params.get("x") if params.get("x") is not None else 100)
        y = float(params.get("y") if params.get("y") is not None else 100)
        obj.Attributes.Pivot = System.Drawing.PointF(x, y)
        if not doc.AddObject(obj, False):
            raise RuntimeError("Grasshopper refused to add the object to the canvas.")
        apply_props(obj, params)
        key = params.get("key") or _auto_key(doc)
        register_handle(key, obj.InstanceGuid)
        doc.NewSolution(False)
        d = describe_obj(obj)
        d["key"] = key
        return d

    return run_on_ui(work)


def cmd_gh_set_value(params):
    def work():
        doc = get_doc()
        obj = find_obj(doc, params.get("id"))
        tn = obj.GetType().Name
        if tn in ("GH_NumberSlider", "GH_Panel", "GH_BooleanToggle", "GH_ValueList"):
            apply_props(obj, params)
        elif hasattr(obj, "SetPersistentData"):
            obj.SetPersistentData(params.get("value"))
        else:
            raise RuntimeError(
                "Cannot set a value on a %s. Use sliders/panels/toggles for inputs." % tn)
        if hasattr(obj, "ExpireSolution"):
            obj.ExpireSolution(False)
        doc.NewSolution(False)
        return describe_obj(obj)

    return run_on_ui(work)


def cmd_gh_connect(params):
    def work():
        doc = get_doc()
        src = find_obj(doc, params.get("from_id"))
        tgt = find_obj(doc, params.get("to_id"))
        sp = resolve_param(src, params.get("from_param"), "output")
        tp = resolve_param(tgt, params.get("to_param"), "input")
        tp.AddSource(sp)
        top = tgt
        if hasattr(top, "ExpireSolution"):
            top.ExpireSolution(False)
        doc.NewSolution(False)
        return {"connected": "%s.%s -> %s.%s" %
                             (safe_str(src.NickName) or safe_str(src.Name), safe_str(sp.Name),
                              safe_str(tgt.NickName) or safe_str(tgt.Name), safe_str(tp.Name)),
                "target_state": messages(tgt)}

    return run_on_ui(work)


def cmd_gh_disconnect(params):
    def work():
        doc = get_doc()
        tgt = find_obj(doc, params.get("to_id"))
        tp = resolve_param(tgt, params.get("to_param"), "input")
        if params.get("from_id"):
            src = find_obj(doc, params.get("from_id"))
            sp = resolve_param(src, params.get("from_param"), "output")
            tp.RemoveSource(sp)
        else:
            tp.RemoveAllSources()
        if hasattr(tgt, "ExpireSolution"):
            tgt.ExpireSolution(False)
        doc.NewSolution(False)
        return {"ok": True}

    return run_on_ui(work)


def cmd_gh_delete(params):
    ids = params.get("ids") or []

    def work():
        doc = get_doc()
        removed = 0
        for id_str in ids:
            try:
                obj = find_obj(doc, id_str)
                guid = str(obj.InstanceGuid)
                doc.RemoveObject(obj, False)
                for k, v in list(_HANDLES.items()):
                    if v == guid:
                        del _HANDLES[k]
                removed += 1
            except Exception:
                pass
        doc.NewSolution(False)
        return {"removed": removed, "requested": len(ids)}

    return run_on_ui(work)


def cmd_gh_canvas(params):
    def work():
        doc = get_doc()
        objs = [describe_obj(o) for o in doc.Objects]
        n_err = sum(1 for o in objs if o.get("errors"))
        n_warn = sum(1 for o in objs if o.get("warnings"))
        return {"file": safe_str(doc.FilePath),
                "object_count": len(objs),
                "objects_with_errors": n_err,
                "objects_with_warnings": n_warn,
                "objects": objs}

    return run_on_ui(work, timeout=120)


def cmd_gh_output(params):
    def work():
        doc = get_doc()
        obj = find_obj(doc, params.get("id"))
        p = resolve_param(obj, params.get("param"), "output")
        max_items = int(params.get("max_items") or 50)
        data = p.VolatileData
        branches = []
        collected = 0
        for path in data.Paths:
            branch = data.get_Branch(path)
            items = []
            for item in branch:
                if collected < max_items:
                    items.append(stringify_item(item))
                    collected += 1
            branches.append({"path": safe_str(path),
                             "count": branch.Count,
                             "items": items})
        total = data.DataCount
        return {"param": safe_str(p.Name),
                "total_items": total,
                "returned_items": collected,
                "truncated": collected < total,
                "branches": branches,
                "state": messages(obj)}

    return run_on_ui(work)


def cmd_gh_recompute(params):
    expire_all = params.get("expire_all")
    if expire_all is None:
        expire_all = True

    def work():
        doc = get_doc()
        doc.NewSolution(bool(expire_all))
        objs = list(doc.Objects)
        errs = []
        for o in objs:
            m = messages(o)
            if m["errors"]:
                errs.append({"id": safe_str(o.InstanceGuid),
                             "name": safe_str(o.NickName) or safe_str(o.Name),
                             "errors": m["errors"]})
        return {"recomputed": True, "object_count": len(objs), "errors": errs}

    return run_on_ui(work, timeout=UI_TIMEOUT)


def cmd_gh_new(params):
    def work():
        G = GH()
        canvas = get_canvas()
        doc = G.Kernel.GH_Document()
        G.Instances.DocumentServer.AddDocument(doc)
        canvas.Document = doc
        doc.NewSolution(True)
        reset_handles()
        return {"created": True}

    return run_on_ui(work)


def cmd_gh_save(params):
    path = params.get("path")
    if not path:
        raise RuntimeError("A file path is required.")

    def work():
        G = GH()
        doc = get_doc()
        io_ = G.Kernel.GH_DocumentIO(doc)
        ok = False
        try:
            ok = io_.SaveQuiet(str(path))
        except Exception:
            doc.FilePath = str(path)
            ok = io_.SaveQuiet()
        if not ok:
            raise RuntimeError("Grasshopper failed to save to %s" % path)
        return {"saved": str(path), "object_count": doc.ObjectCount}

    return run_on_ui(work)


def cmd_gh_open(params):
    path = params.get("path")
    if not path:
        raise RuntimeError("A file path is required.")

    def work():
        G = GH()
        canvas = get_canvas()
        io_ = G.Kernel.GH_DocumentIO()
        if not io_.Open(str(path)):
            raise RuntimeError("Could not open %s" % path)
        doc = io_.Document
        G.Instances.DocumentServer.AddDocument(doc)
        canvas.Document = doc
        doc.NewSolution(True)
        return {"opened": str(path), "object_count": doc.ObjectCount}

    return run_on_ui(work, timeout=UI_TIMEOUT)


def cmd_gh_bake(params):
    def work():
        G = GH()
        doc = get_doc()
        rdoc = Rhino.RhinoDoc.ActiveDoc
        obj = find_obj(doc, params.get("id"))
        p = resolve_param(obj, params.get("param"), "output")

        attr = rdoc.CreateDefaultAttributes()
        layer = params.get("layer")
        if layer:
            idx = rdoc.Layers.FindByFullPath(str(layer), -1)
            if idx < 0:
                new_layer = Rhino.DocObjects.Layer()
                new_layer.Name = str(layer)
                idx = rdoc.Layers.Add(new_layer)
            if idx >= 0:
                attr.LayerIndex = idx

        added = []
        skipped = 0
        data = p.VolatileData
        for path in data.Paths:
            for item in data.get_Branch(path):
                if item is None:
                    continue
                gb = None
                try:
                    gb = G.Kernel.GH_Convert.ToGeometryBase(item)
                except Exception:
                    pass
                if gb is None:
                    skipped += 1
                    continue
                gid = rdoc.Objects.Add(gb, attr)
                if gid != System.Guid.Empty:
                    added.append(safe_str(gid))
        rdoc.Views.Redraw()
        return {"baked": len(added), "skipped_non_geometry": skipped,
                "rhino_ids": added[:25]}

    return run_on_ui(work, timeout=UI_TIMEOUT)


def cmd_gh_build(params):
    definition = params.get("definition") or params
    comps = definition.get("components") or []
    conns = definition.get("connections") or []
    if not comps:
        raise RuntimeError("The recipe has no components.")

    def work():
        doc = get_doc()
        if definition.get("clear"):
            for o in list(doc.Objects):
                doc.RemoveObject(o, False)
            reset_handles()

        # Idempotency: if a key already maps to a live component, reuse it
        # (update props + rewire) instead of creating a duplicate.
        existing = {}
        for c in comps:
            key = c.get("key")
            guid = _HANDLES.get(str(key)) if key else None
            if guid:
                try:
                    existing[key] = find_obj(doc, key)
                except Exception:
                    pass

        # dataflow layout: column = longest path from any source
        col = {}
        for c in comps:
            col[c.get("key")] = 0
        for _ in range(len(comps) + 1):
            changed = False
            for cn in conns:
                f, t = cn.get("from"), cn.get("to")
                if f in col and t in col and col[t] < col[f] + 1:
                    col[t] = col[f] + 1
                    changed = True
            if not changed:
                break

        slots = {}
        made = {}
        build_errors = []
        for c in comps:
            key = c.get("key")
            if not key:
                build_errors.append("component missing 'key': %s" % json.dumps(c))
                continue
            try:
                if key in existing:
                    # Reuse the live component: update its editable props in place.
                    obj = existing[key]
                    apply_props(obj, c)
                else:
                    obj = make_object(c.get("type"))
                    obj.CreateAttributes()
                    cc = col.get(key, 0)
                    slot = slots.get(cc, 0)
                    slots[cc] = slot + 1
                    x = float(c["x"]) if c.get("x") is not None else 80.0 + cc * 260.0
                    y = float(c["y"]) if c.get("y") is not None else 80.0 + slot * 130.0
                    obj.Attributes.Pivot = System.Drawing.PointF(x, y)
                    doc.AddObject(obj, False)
                    apply_props(obj, c)
                    register_handle(key, obj.InstanceGuid)
                made[key] = obj
            except Exception as e:
                build_errors.append("component '%s': %s" % (key, e))

        for cn in conns:
            fk, tk = cn.get("from"), cn.get("to")
            try:
                src = made.get(fk)
                tgt = made.get(tk)
                if src is None:
                    raise RuntimeError("unknown source key '%s'" % fk)
                if tgt is None:
                    raise RuntimeError("unknown target key '%s'" % tk)
                sp = resolve_param(src, cn.get("from_param"), "output")
                tp = resolve_param(tgt, cn.get("to_param"), "input")
                # Avoid duplicate wires when re-running an idempotent build.
                if sp not in list(tp.Sources):
                    tp.AddSource(sp)
            except Exception as e:
                build_errors.append("connection %s -> %s: %s" % (fk, tk, e))

        doc.NewSolution(True)

        result = {"components": {}, "build_errors": build_errors, "runtime_problems": []}
        for key in made:
            obj = made[key]
            result["components"][key] = {"id": safe_str(obj.InstanceGuid),
                                         "name": safe_str(obj.Name)}
            m = messages(obj)
            if m["errors"] or m["warnings"]:
                result["runtime_problems"].append(
                    {"key": key, "errors": m["errors"], "warnings": m["warnings"]})
        result["ok"] = not build_errors and not any(
            p["errors"] for p in result["runtime_problems"])
        return result

    return run_on_ui(work, timeout=UI_TIMEOUT)


HANDLERS = {
    "ping": lambda p: "pong",
    "rhino.execute": cmd_rhino_execute,
    "rhino.scene": cmd_rhino_scene,
    "rhino.capture": cmd_rhino_capture,
    "gh.launch": cmd_gh_launch,
    "gh.status": cmd_gh_status,
    "gh.search": cmd_gh_search,
    "gh.info": cmd_gh_info,
    "gh.add": cmd_gh_add,
    "gh.set_value": cmd_gh_set_value,
    "gh.connect": cmd_gh_connect,
    "gh.disconnect": cmd_gh_disconnect,
    "gh.delete": cmd_gh_delete,
    "gh.canvas": cmd_gh_canvas,
    "gh.output": cmd_gh_output,
    "gh.recompute": cmd_gh_recompute,
    "gh.new": cmd_gh_new,
    "gh.save": cmd_gh_save,
    "gh.open": cmd_gh_open,
    "gh.bake": cmd_gh_bake,
    "gh.build": cmd_gh_build,
}


# --------------------------------------------------------------------------- #
# TCP server
# --------------------------------------------------------------------------- #

class Listener(object):
    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.stop_flag = False
        self.sock = None

    def start(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((self.host, self.port))
        self.sock.listen(1)
        t = threading.Thread(target=self._accept_loop)
        t.daemon = True
        t.start()

    def shutdown(self):
        self.stop_flag = True
        try:
            self.sock.close()
        except Exception:
            pass

    def _accept_loop(self):
        while not self.stop_flag:
            try:
                conn, _ = self.sock.accept()
            except Exception:
                break
            # Handle each client on its own thread so that a persistent
            # connection (the MCP server keeps one open) never blocks other
            # clients. All Rhino work still serializes at the UI-thread
            # boundary via run_on_ui, so this is safe.
            t = threading.Thread(target=self._serve_safe, args=(conn,))
            t.daemon = True
            t.start()

    def _serve_safe(self, conn):
        try:
            self._serve(conn)
        except Exception:
            pass

    def _serve(self, conn):
        buf = b""
        try:
            while not self.stop_flag:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        payload = line.decode("utf-8")
                    except Exception:
                        payload = line
                    reply = self._handle(payload)
                    if reply is not None:
                        conn.sendall((reply + "\n").encode("utf-8"))
                    if self.stop_flag:
                        return
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _handle(self, payload):
        try:
            req = json.loads(payload)
        except Exception:
            return json.dumps({"id": None,
                               "error": {"message": "invalid JSON request"}})
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}

        if method == "sys.shutdown":
            self.shutdown()
            return json.dumps({"id": rid, "result": "shutting down"})

        fn = HANDLERS.get(method)
        if fn is None:
            return json.dumps({"id": rid,
                               "error": {"message": "unknown method '%s'" % method}})
        try:
            return json.dumps({"id": rid, "result": fn(params)})
        except Exception as e:
            return json.dumps({"id": rid,
                               "error": {"message": safe_str(e) or "unknown error",
                                         "traceback": traceback.format_exc()}})


def kill_previous_instance():
    """If an older listener owns the port, ask it to shut down."""
    try:
        s = socket.create_connection((HOST, PORT), 1)
        s.sendall(b'{"id":0,"method":"sys.shutdown"}\n')
        try:
            s.recv(1024)
        except Exception:
            pass
        s.close()
        time.sleep(0.6)
    except Exception:
        pass


def main():
    kill_previous_instance()
    listener = Listener(HOST, PORT)
    listener.start()
    print("rhino-gh-mcp listener running on %s:%d" % (HOST, PORT))
    print("Leave Rhino open. Re-run this script any time to restart the listener.")


main()
