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

# Monotonic scene version (PROTOCOL.md section 2). Starts at 1; incremented by
# the dispatcher (Listener._handle) after every SUCCESSFUL mutating call.
# Reported by the space.* commands so spatial-core can invalidate its caches.
SCENE_VERSION = 1


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


def cmd_rhino_selection(params):
    """Currently selected Rhino objects - lets the agent resolve 'this part'."""
    def work():
        doc = Rhino.RhinoDoc.ActiveDoc
        out = []
        for o in doc.Objects.GetSelectedObjects(False, False):
            entry = {"id": safe_str(o.Id),
                     "name": safe_str(o.Name),
                     "type": o.ObjectType.ToString()}
            try:
                entry["layer"] = safe_str(doc.Layers[o.Attributes.LayerIndex].FullPath)
            except Exception:
                entry["layer"] = None
            try:
                b = o.Geometry.GetBoundingBox(True)
                entry["bbox"] = {"min": [b.Min.X, b.Min.Y, b.Min.Z],
                                 "max": [b.Max.X, b.Max.Y, b.Max.Z]}
            except Exception:
                pass
            out.append(entry)
        return {"count": len(out), "objects": out}

    return run_on_ui(work)


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


def cmd_gh_edit(params):
    """Apply a batch of edits (set/connect/disconnect/delete) in one round-trip,
    solving once at the end and reporting per-op results + affected errors."""
    ops = params.get("ops") or []
    if not ops:
        raise RuntimeError("No ops provided.")

    def work():
        doc = get_doc()
        results = []
        touched = set()

        for i, op in enumerate(ops):
            kind = (op.get("op") or "").lower()
            try:
                if kind == "set":
                    obj = find_obj(doc, op.get("id"))
                    tn = obj.GetType().Name
                    if tn in ("GH_NumberSlider", "GH_Panel", "GH_BooleanToggle", "GH_ValueList"):
                        apply_props(obj, op)
                    elif hasattr(obj, "SetPersistentData"):
                        obj.SetPersistentData(op.get("value"))
                    else:
                        raise RuntimeError("cannot set value on %s" % tn)
                    if hasattr(obj, "ExpireSolution"):
                        obj.ExpireSolution(False)
                    touched.add(safe_str(obj.InstanceGuid))
                    results.append({"op": i, "ok": True})
                elif kind == "connect":
                    src = find_obj(doc, op.get("from_id"))
                    tgt = find_obj(doc, op.get("to_id"))
                    sp = resolve_param(src, op.get("from_param"), "output")
                    tp = resolve_param(tgt, op.get("to_param"), "input")
                    if sp not in list(tp.Sources):
                        tp.AddSource(sp)
                    touched.add(safe_str(tgt.InstanceGuid))
                    results.append({"op": i, "ok": True})
                elif kind == "disconnect":
                    tgt = find_obj(doc, op.get("to_id"))
                    tp = resolve_param(tgt, op.get("to_param"), "input")
                    if op.get("from_id"):
                        src = find_obj(doc, op.get("from_id"))
                        tp.RemoveSource(resolve_param(src, op.get("from_param"), "output"))
                    else:
                        tp.RemoveAllSources()
                    touched.add(safe_str(tgt.InstanceGuid))
                    results.append({"op": i, "ok": True})
                elif kind == "delete":
                    obj = find_obj(doc, op.get("id"))
                    guid = str(obj.InstanceGuid)
                    doc.RemoveObject(obj, False)
                    for k, v in list(_HANDLES.items()):
                        if v == guid:
                            del _HANDLES[k]
                    results.append({"op": i, "ok": True})
                else:
                    results.append({"op": i, "ok": False, "error": "unknown op '%s'" % kind})
            except Exception as e:
                results.append({"op": i, "ok": False, "error": safe_str(e)})

        doc.NewSolution(True)

        problems = []
        for guid in touched:
            try:
                obj = find_obj(doc, guid)
            except Exception:
                continue
            m = messages(obj)
            if m["errors"] or m["warnings"]:
                problems.append({"id": guid, "key": handle_for(guid),
                                 "errors": m["errors"], "warnings": m["warnings"]})
        ok = all(r["ok"] for r in results) and not any(p["errors"] for p in problems)
        return {"ok": ok, "results": results, "runtime_problems": problems}

    return run_on_ui(work, timeout=UI_TIMEOUT)


def handle_for(guid_str):
    for k, v in _HANDLES.items():
        if v == guid_str:
            return k
    return None


def summarize_obj(o):
    """One compact line per object: handle, type, nickname, and problems only."""
    guid = safe_str(o.InstanceGuid)
    d = {"id": guid, "type": o.GetType().Name,
         "nickname": safe_str(o.NickName) or safe_str(o.Name)}
    key = handle_for(guid)
    if key:
        d["key"] = key
    m = messages(o)
    if m["errors"]:
        d["errors"] = m["errors"]
    if m["warnings"]:
        d["warnings"] = m["warnings"]
    return d


def cmd_gh_canvas(params):
    detail = (params.get("detail") or "summary").lower()

    def work():
        doc = get_doc()
        all_objs = list(doc.Objects)
        n_err = 0
        n_warn = 0
        problems = []
        for o in all_objs:
            m = messages(o)
            if m["errors"]:
                n_err += 1
            if m["warnings"]:
                n_warn += 1

        head = {"file": safe_str(doc.FilePath),
                "object_count": len(all_objs),
                "objects_with_errors": n_err,
                "objects_with_warnings": n_warn}

        if detail == "full":
            head["objects"] = [describe_obj(o) for o in all_objs]
        elif detail == "problems":
            head["objects"] = [describe_obj(o) for o in all_objs if messages(o)["errors"] or messages(o)["warnings"]]
            head["note"] = "Only components with errors/warnings shown. Use detail='full' for everything."
        else:  # summary
            head["objects"] = [summarize_obj(o) for o in all_objs]
            head["note"] = "Compact view (handle, type, problems). Use detail='full' for params/wiring or detail='problems' for only broken components."
        return head

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


# --------------------------------------------------------------------------- #
# spatial commands (PROTOCOL.md sections 1-2)
# --------------------------------------------------------------------------- #

def _bbox_dict(bb):
    return {"min": [float(bb.Min.X), float(bb.Min.Y), float(bb.Min.Z)],
            "max": [float(bb.Max.X), float(bb.Max.Y), float(bb.Max.Z)]}


def _kind_of(geo):
    """Contract kind mapping: closed Brep/Extrusion/closed Mesh -> solid;
    open Brep/Surface -> surface; open Mesh -> mesh; Curve -> curve; else other."""
    RG = Rhino.Geometry
    try:
        if isinstance(geo, RG.Brep):
            return "solid" if geo.IsSolid else "surface"
        if isinstance(geo, RG.Extrusion):
            solid = False
            try:
                solid = bool(geo.IsSolid)
            except Exception:
                try:
                    b = geo.ToBrep()
                    solid = bool(b is not None and b.IsSolid)
                except Exception:
                    solid = False
            return "solid" if solid else "surface"
        if isinstance(geo, RG.Mesh):
            return "solid" if geo.IsClosed else "mesh"
        if isinstance(geo, RG.Surface):
            return "surface"
        if isinstance(geo, RG.Curve):
            return "curve"
    except Exception:
        pass
    return "other"


def _body_props(geo):
    """(kind, bbox, volume, area, centroid) for one geometry. Mass properties
    are kernel-exact when computable, else None (contract: keep shape, use null)."""
    RG = Rhino.Geometry
    kind = _kind_of(geo)
    bb = None
    try:
        bb = geo.GetBoundingBox(True)
    except Exception:
        pass
    mg = geo
    if isinstance(geo, RG.Extrusion):
        # Mass-properties overloads want a Brep, not an Extrusion.
        try:
            b = geo.ToBrep()
            if b is not None:
                mg = b
        except Exception:
            pass
    volume = None
    centroid = None
    area = None
    if kind == "solid":
        try:
            vmp = RG.VolumeMassProperties.Compute(mg)
            if vmp is not None:
                volume = float(vmp.Volume)
                c = vmp.Centroid
                centroid = [float(c.X), float(c.Y), float(c.Z)]
        except Exception:
            pass
    if kind in ("solid", "surface", "mesh"):
        try:
            amp = RG.AreaMassProperties.Compute(mg)
            if amp is not None:
                area = float(amp.Area)
        except Exception:
            pass
    return kind, bb, volume, area, centroid


def _gh_find_by_guid(target):
    """Find a GH canvas object by InstanceGuid. None if GH absent / not found."""
    try:
        canvas = GH().Instances.ActiveCanvas
    except Exception:
        return None
    if canvas is None or canvas.Document is None:
        return None
    for o in canvas.Document.Objects:
        if o.InstanceGuid == target:
            return o
    return None


def _doc_find_by_guid(target):
    """Find a Rhino DOC object by its Id. None if not found."""
    rdoc = Rhino.RhinoDoc.ActiveDoc
    if rdoc is None:
        return None
    for o in rdoc.Objects:
        try:
            if o.Id == target:
                return o
        except Exception:
            pass
    return None


def _resolve_space_id(id_str):
    """Resolve an id in order: _HANDLES key -> GH canvas object -> doc object.
    Returns ("gh", gh_object) or ("doc", rhino_object)."""
    s = str(id_str)
    if s in _HANDLES:
        try:
            target = System.Guid.Parse(_HANDLES[s])
        except Exception:
            target = None
        if target is not None:
            obj = _gh_find_by_guid(target)
            if obj is not None:
                return ("gh", obj)
    try:
        target = System.Guid.Parse(s)
    except Exception:
        raise RuntimeError(
            "'%s' is not a known handle or GUID. Known handles: %s" %
            (id_str, ", ".join(sorted(_HANDLES.keys())) or "(none)"))
    obj = _gh_find_by_guid(target)
    if obj is not None:
        return ("gh", obj)
    obj = _doc_find_by_guid(target)
    if obj is not None:
        return ("doc", obj)
    raise RuntimeError("No GH or document object with id/handle '%s'." % id_str)


def _gh_geometry_items(obj):
    """All geometric items on a GH object: every output param's VolatileData
    (or the param's own data if it is not a component), converted with
    GH_Convert.ToGeometryBase. Non-geometric items are skipped silently."""
    G = GH()
    plist = []
    if hasattr(obj, "Params"):
        for p in obj.Params.Output:
            plist.append(p)
    else:
        plist.append(obj)
    out = []
    for p in plist:
        try:
            data = p.VolatileData
        except Exception:
            continue
        try:
            paths = list(data.Paths)
        except Exception:
            continue
        for path in paths:
            try:
                branch = data.get_Branch(path)
            except Exception:
                continue
            for item in branch:
                if item is None:
                    continue
                gb = None
                try:
                    gb = G.Kernel.GH_Convert.ToGeometryBase(item)
                except Exception:
                    pass
                if gb is not None:
                    out.append(gb)
    return out


def _gh_handle_body(key, obj):
    """Aggregate a GH handle's geometry into one BodyInfo dict (contract:
    union bbox, sum volume over closed items, itemCount; kind = solid if any
    closed solid item else kind of the first item). None when no geometry."""
    items = _gh_geometry_items(obj)
    if not items:
        return None
    union = None
    any_solid = False
    first_kind = None
    vol_sum = 0.0
    has_vol = False
    area_sum = 0.0
    has_area = False
    cx = 0.0
    cy = 0.0
    cz = 0.0
    for gb in items:
        kind, bb, volume, area, centroid = _body_props(gb)
        if first_kind is None:
            first_kind = kind
        if kind == "solid":
            any_solid = True
        if bb is not None and bb.IsValid:
            if union is None:
                union = bb
            else:
                union = Rhino.Geometry.BoundingBox.Union(union, bb)
        if volume is not None:
            vol_sum += volume
            has_vol = True
            if centroid is not None:
                cx += centroid[0] * volume
                cy += centroid[1] * volume
                cz += centroid[2] * volume
        if area is not None:
            area_sum += area
            has_area = True
    if union is None:
        return None
    centroid_out = None
    if has_vol and vol_sum > 0:
        centroid_out = [cx / vol_sum, cy / vol_sum, cz / vol_sum]
    return {"id": key,
            "name": safe_str(obj.NickName) or safe_str(obj.Name) or None,
            "source": "gh",
            "kind": "solid" if any_solid else (first_kind or "other"),
            "bbox": _bbox_dict(union),
            "volume": vol_sum if has_vol else None,
            "area": area_sum if has_area else None,
            "centroid": centroid_out,
            "itemCount": len(items),
            "layer": None}


def cmd_space_bodies(params):
    scope = str(params.get("scope") or "all").lower()
    if scope not in ("all", "doc", "gh"):
        raise RuntimeError("scope must be 'all', 'doc' or 'gh' (got '%s')." % scope)
    raw_ids = params.get("ids")
    ids_norm = None
    if raw_ids:
        ids_norm = set()
        for i in raw_ids:
            ids_norm.add(str(i))
            ids_norm.add(str(i).lower())

    def wanted(names):
        if ids_norm is None:
            return True
        for n in names:
            if n and (n in ids_norm or n.lower() in ids_norm):
                return True
        return False

    def work():
        rdoc = Rhino.RhinoDoc.ActiveDoc
        bodies = []

        if scope in ("all", "doc") and rdoc is not None:
            OT = Rhino.DocObjects.ObjectType
            for o in rdoc.Objects:
                try:
                    ot = o.ObjectType
                    if ot == OT.Light or ot == OT.Grip:
                        continue
                    oid = safe_str(o.Id)
                    if not wanted([oid]):
                        continue
                    geo = o.Geometry
                    if geo is None:
                        continue
                    kind, bb, volume, area, centroid = _body_props(geo)
                    if bb is None or not bb.IsValid:
                        continue
                    layer = None
                    try:
                        layer = safe_str(rdoc.Layers[o.Attributes.LayerIndex].FullPath)
                    except Exception:
                        pass
                    bodies.append({"id": oid,
                                   "name": safe_str(o.Attributes.Name) or None,
                                   "source": "doc",
                                   "kind": kind,
                                   "bbox": _bbox_dict(bb),
                                   "volume": volume,
                                   "area": area,
                                   "centroid": centroid,
                                   "itemCount": None,
                                   "layer": layer})
                except Exception:
                    continue

        if scope in ("all", "gh"):
            for key in sorted(_HANDLES.keys()):
                guid_str = _HANDLES[key]
                if not wanted([key, guid_str]):
                    continue
                try:
                    target = System.Guid.Parse(guid_str)
                    obj = _gh_find_by_guid(target)
                    if obj is None:
                        continue
                    body = _gh_handle_body(key, obj)
                    if body is not None:
                        bodies.append(body)
                except Exception:
                    continue

        units = "None"
        if rdoc is not None:
            units = rdoc.ModelUnitSystem.ToString()
        return {"units": units,
                "upAxis": "z",
                "sceneVersion": SCENE_VERSION,
                "bodies": bodies}

    return run_on_ui(work, timeout=UI_TIMEOUT)


def _append_tessellation(mesh, gb, mp):
    """Append gb's tessellation to mesh. Returns number of sub-meshes appended."""
    RG = Rhino.Geometry
    if isinstance(gb, RG.Mesh):
        mesh.Append(gb)
        return 1
    sub_t = getattr(RG, "SubD", None)
    if sub_t is not None and isinstance(gb, sub_t):
        try:
            sm = RG.Mesh.CreateFromSubD(gb, 2)
            if sm is not None:
                mesh.Append(sm)
                return 1
        except Exception:
            pass
        return 0
    brep = None
    if isinstance(gb, RG.Brep):
        brep = gb
    elif isinstance(gb, RG.Extrusion):
        try:
            brep = gb.ToBrep()
        except Exception:
            brep = None
    elif isinstance(gb, RG.Surface):
        try:
            brep = gb.ToBrep()
        except Exception:
            brep = None
    if brep is None:
        return 0
    parts = None
    try:
        parts = RG.Mesh.CreateFromBrep(brep, mp)
    except Exception:
        parts = None
    if parts is None:
        return 0
    n = 0
    for m in parts:
        if m is not None:
            mesh.Append(m)
            n += 1
    return n


def _unmeshable_kind(gb):
    RG = Rhino.Geometry
    if isinstance(gb, RG.Curve):
        return "curve"
    if isinstance(gb, (RG.Point, RG.PointCloud)):
        return "point"
    return None


def _pack_b64(arr, elem_size):
    """base64 of a .NET primitive array's raw little-endian bytes (no Python loops)."""
    byte_len = arr.Length * elem_size
    barr = System.Array.CreateInstance(System.Byte, byte_len)
    System.Buffer.BlockCopy(arr, 0, barr, 0, byte_len)
    return System.Convert.ToBase64String(barr)


def cmd_space_tessellate(params):
    id_str = params.get("id")
    if not id_str:
        raise RuntimeError("An 'id' (guid or handle) is required.")
    density = params.get("density")
    if density is None:
        density = 0.5
    density = float(density)

    def work():
        RG = Rhino.Geometry
        rdoc = Rhino.RhinoDoc.ActiveDoc
        source, obj = _resolve_space_id(id_str)
        if source == "gh":
            geos = _gh_geometry_items(obj)
            if not geos:
                raise RuntimeError(
                    "GH object '%s' has no geometric output items." % id_str)
        else:
            geos = [obj.Geometry]

        mp = RG.MeshingParameters(density)
        mesh = RG.Mesh()
        appended = 0
        unmeshable = None
        for gb in geos:
            if gb is None:
                continue
            n = _append_tessellation(mesh, gb, mp)
            appended += n
            if n == 0 and unmeshable is None:
                unmeshable = _unmeshable_kind(gb)
        if appended == 0 or mesh.Faces.Count == 0:
            if unmeshable is not None:
                raise RuntimeError(
                    "id %s is a %s; not meshable — use space.bodies for its bbox" %
                    (id_str, unmeshable))
            raise RuntimeError("id %s produced no meshable geometry." % id_str)

        mesh.Faces.ConvertQuadsToTriangles()
        mesh.Compact()

        tol = 0.0
        try:
            bb = mesh.GetBoundingBox(True)
            tol = float(bb.Diagonal.Length) * 0.002
        except Exception:
            pass

        verts_f = mesh.Vertices.ToFloatArray()   # Single[] xyz interleaved
        idx = mesh.Faces.ToIntArray(True)        # Int32[] triangle triples
        units = "None"
        if rdoc is not None:
            units = rdoc.ModelUnitSystem.ToString()
        return {"vertices_b64": _pack_b64(verts_f, 4),
                "indices_b64": _pack_b64(idx, 4),
                "vertexCount": mesh.Vertices.Count,
                "triangleCount": mesh.Faces.Count,
                "toleranceEstimate": tol,
                "units": units,
                "sceneVersion": SCENE_VERSION}

    return run_on_ui(work, timeout=UI_TIMEOUT)


HANDLERS = {
    "ping": lambda p: "pong",
    "rhino.execute": cmd_rhino_execute,
    "rhino.scene": cmd_rhino_scene,
    "rhino.capture": cmd_rhino_capture,
    "rhino.selection": cmd_rhino_selection,
    "gh.launch": cmd_gh_launch,
    "gh.status": cmd_gh_status,
    "gh.search": cmd_gh_search,
    "gh.info": cmd_gh_info,
    "gh.add": cmd_gh_add,
    "gh.set_value": cmd_gh_set_value,
    "gh.connect": cmd_gh_connect,
    "gh.disconnect": cmd_gh_disconnect,
    "gh.delete": cmd_gh_delete,
    "gh.edit": cmd_gh_edit,
    "gh.canvas": cmd_gh_canvas,
    "gh.output": cmd_gh_output,
    "gh.recompute": cmd_gh_recompute,
    "gh.new": cmd_gh_new,
    "gh.save": cmd_gh_save,
    "gh.open": cmd_gh_open,
    "gh.bake": cmd_gh_bake,
    "gh.build": cmd_gh_build,
    "space.bodies": cmd_space_bodies,
    "space.tessellate": cmd_space_tessellate,
}

# Methods that can change geometry (PROTOCOL.md section 2). The dispatcher
# bumps SCENE_VERSION after each successful call to one of these.
MUTATING_METHODS = set([
    "gh.add", "gh.set_value", "gh.connect", "gh.disconnect", "gh.delete",
    "gh.edit", "gh.build", "gh.new", "gh.open", "gh.recompute", "gh.bake",
    "rhino.execute",
])


# --------------------------------------------------------------------------- #
# TCP server
# --------------------------------------------------------------------------- #

# The listening socket is a .NET Socket stored in AppDomain data. Rationale:
# each script (re)execution gets a fresh Python scope, so a later run has no
# reference to the previous listener socket - and a zombie listener (dead
# accept thread, handle still bound) ignores the polite TCP shutdown. The
# AppDomain is process-global and runtime-agnostic (IronPython and CPython
# both see the same .NET object), so every startup can FORCE-CLOSE its
# predecessor's socket before binding. This is what makes McpListenerRestart
# reliable without restarting Rhino.
APPDOMAIN_SOCKET_KEY = "rhino_gh_mcp_listener_socket"

for _asm in ("System", "System.Net.Sockets", "System.Net.Primitives"):
    try:
        clr.AddReference(_asm)
    except Exception:
        pass

_NL_BYTE = System.Byte(10)


class Listener(object):
    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.stop_flag = False
        self.sock = None

    def start(self):
        domain = System.AppDomain.CurrentDomain
        prev = domain.GetData(APPDOMAIN_SOCKET_KEY)
        if prev is not None:
            try:
                prev.Close()
                print("rhino-gh-mcp: force-closed previous listener socket")
            except Exception:
                pass
            time.sleep(0.2)

        NS = System.Net.Sockets
        self.sock = NS.Socket(NS.AddressFamily.InterNetwork,
                              NS.SocketType.Stream,
                              NS.ProtocolType.Tcp)
        # Still no SO_REUSEADDR: with the force-close above a stuck port now
        # means something OUTSIDE this process owns it - fail loudly.
        try:
            self.sock.Bind(System.Net.IPEndPoint(
                System.Net.IPAddress.Parse(self.host), self.port))
        except Exception:
            raise RuntimeError(
                "Port %d is unavailable (another process may own it). "
                "Check with: netstat -ano | findstr :%d" % (self.port, self.port))
        self.sock.Listen(4)
        domain.SetData(APPDOMAIN_SOCKET_KEY, self.sock)
        t = threading.Thread(target=self._accept_loop)
        t.daemon = True
        t.start()

    def shutdown(self):
        self.stop_flag = True
        try:
            domain = System.AppDomain.CurrentDomain
            # Equality (not `is`): runtime wrappers around the same .NET object
            # can be distinct Python objects; == dispatches to reference-equals.
            if self.sock is not None and domain.GetData(APPDOMAIN_SOCKET_KEY) == self.sock:
                domain.SetData(APPDOMAIN_SOCKET_KEY, None)
        except Exception:
            pass
        try:
            self.sock.Close()
        except Exception:
            pass

    def _accept_loop(self):
        while not self.stop_flag:
            try:
                conn = self.sock.Accept()
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
        # .NET-socket I/O with byte-level newline framing (UTF-8 payloads may
        # split multi-byte chars across Receive calls, so decode per line).
        stream = System.IO.MemoryStream()
        buf = System.Array.CreateInstance(System.Byte, 65536)
        try:
            while not self.stop_flag:
                try:
                    n = conn.Receive(buf)
                except Exception:
                    break
                if n == 0:
                    break
                stream.Write(buf, 0, n)

                data = stream.ToArray()
                total = data.Length
                start = 0
                while True:
                    idx = System.Array.IndexOf(data, _NL_BYTE, start)
                    if idx < 0:
                        break
                    if idx > start:
                        payload = System.Text.Encoding.UTF8.GetString(
                            data, start, idx - start).strip()
                    else:
                        payload = ""
                    start = idx + 1
                    if payload:
                        reply = self._handle(payload)
                        if reply is not None:
                            out = System.Text.Encoding.UTF8.GetBytes(reply + "\n")
                            conn.Send(out)
                        if self.stop_flag:
                            return
                if start > 0:
                    remainder = total - start
                    stream.SetLength(0)
                    if remainder > 0:
                        stream.Write(data, start, remainder)
        except Exception:
            pass
        finally:
            try:
                conn.Close()
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
        global SCENE_VERSION
        try:
            result = fn(params)
        except Exception as e:
            return json.dumps({"id": rid,
                               "error": {"message": safe_str(e) or "unknown error",
                                         "traceback": traceback.format_exc()}})
        if method in MUTATING_METHODS:
            SCENE_VERSION += 1
        return json.dumps({"id": rid, "result": result})


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
