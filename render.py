"""
CL-DIY - render a causal loop diagram (CLD) as a self-contained,
interactive HTML page: free-arrange nodes, editable levels, link polarity,
feedback-loop annotation, PNG export, undo, all client-side, no server.

The page itself lives in templates/ (page.html markup, style.css, app.js);
render() inlines those, the fonts and the graph data into one HTML file.

Accepts either a .xmile source (a Vensim-style export, parsed via sd.py and
force-directed-laid-out via layout.py) or an already-edited graph export
(.json - the shape the app's own "Download edited graph" button produces:
positions, levels, loops and the change log already baked in, rendered
as-is with no re-layout). With no argument, renders empty.json - a blank
starting diagram - so `python render.py` on its own gives you a working
empty canvas to build a new CLD in.

Usage (needs the project .venv - numpy isn't in system Python, and there's
no bare `python` on PATH here, only `python3`):
    .venv/bin/python render.py                       # blank starter -> cld.html
    .venv/bin/python render.py my-diagram.xmile out.html
    .venv/bin/python render.py my-diagram-edited.json out.html
"""
from __future__ import annotations

import base64
import json
import math
import random
import re
import sys
from pathlib import Path

from sd import load_graph
from layout import layout_graph, CANVAS_WIDTH, CANVAS_HEIGHT
from node_levels import LEVEL_META

FONT_DIR = Path(__file__).parent / "fonts"
TEMPLATE_DIR = Path(__file__).parent / "templates"


def _b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def build_payload(xmile_path: str) -> dict:
    graph = load_graph(xmile_path)
    nodes, edges = graph.nodes, graph.edges
    positions = layout_graph(nodes, edges)

    parents: dict[str, list[str]] = {n: [] for n in nodes}
    children: dict[str, list[str]] = {n: [] for n in nodes}
    for s, t in edges:
        children.setdefault(s, []).append(t)
        parents.setdefault(t, []).append(s)

    default_level = min(LEVEL_META)
    nodes_payload = []
    for n in nodes:
        p = positions[n]
        nodes_payload.append(
            {
                "id": n,
                "x": round(p.x, 1),
                "y": round(p.y, 1),
                "r": round(p.r, 1),
                "level": default_level,
                "in": sorted(set(parents.get(n, []))),
                "out": sorted(set(children.get(n, []))),
            }
        )

    edges_payload = [{"s": s, "t": t} for s, t in edges]

    levels_payload = [
        {"level": lvl, "key": meta["key"], "label": meta["label"], "color": meta["color"]}
        for lvl, meta in sorted(LEVEL_META.items())
    ]

    return {
        "nodes": nodes_payload,
        "edges": edges_payload,
        "levels": levels_payload,
        "canvas": {"w": CANVAS_WIDTH, "h": CANVAS_HEIGHT},
        "counts": {"nodes": len(nodes_payload), "edges": len(edges_payload)},
    }


def _sanitize_levels(raw_levels: object) -> list[dict] | None:
    """Validate a graph export's own "levels" array (a diagram's levels are
    fully user-editable in the app - see node_levels.py) into the same
    shape LEVEL_META produces. Returns None if raw_levels isn't usable, so
    the caller can fall back to the built-in default palette."""
    if not isinstance(raw_levels, list):
        return None
    out: list[dict] = []
    seen_nums: set[int] = set()
    for rl in raw_levels:
        if not isinstance(rl, dict):
            continue
        try:
            num = int(rl.get("level"))
        except (TypeError, ValueError):
            continue
        if num in seen_nums:
            continue
        label = rl.get("label")
        label = label.strip() if isinstance(label, str) and label.strip() else f"Level {num}"
        color = rl.get("color")
        if not (isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color)):
            color = "#6da7ec"
        key = rl.get("key")
        if not (isinstance(key, str) and key.strip()):
            key = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or f"level-{num}"
        seen_nums.add(num)
        out.append({"level": num, "key": key, "label": label, "color": color})
    if not out:
        return None
    return sorted(out, key=lambda l: l["level"])


def build_payload_from_json(json_path: str) -> dict:
    """Build the page payload directly from an exported/edited graph JSON -
    the shape the app's own "Download edited graph (.json)" button produces:
    {nodes:[{id,level,x,y}], edges:[{source,target[,polarity]}], loops, log}.
    No layout pass: positions are already baked in. Mirrors importGraph() in
    the embedded JS template (trim/dedupe, level/coordinate fallbacks, edge
    dedup, loop-cycle re-validation) so a JSON export renders identically
    whether it's loaded here or re-uploaded in the browser later.
    """
    raw = json.loads(Path(json_path).read_text())
    if not isinstance(raw.get("nodes"), list) or not isinstance(raw.get("edges"), list):
        raise ValueError(f"{json_path}: not a recognized graph export - missing 'nodes'/'edges' arrays.")

    levels_payload = _sanitize_levels(raw.get("levels")) or [
        {"level": lvl, "key": meta["key"], "label": meta["label"], "color": meta["color"]}
        for lvl, meta in sorted(LEVEL_META.items())
    ]
    valid_levels = {l["level"] for l in levels_payload}
    default_level = min(valid_levels)

    seen_ids: set[str] = set()
    nodes_payload: list[dict] = []
    for rn in raw["nodes"]:
        raw_id = rn.get("id")
        node_id = raw_id.strip() if isinstance(raw_id, str) else ""
        if not node_id or node_id in seen_ids:
            continue
        seen_ids.add(node_id)

        try:
            level = int(rn.get("level"))
        except (TypeError, ValueError):
            level = default_level
        if level not in valid_levels:
            level = default_level

        try:
            x, y = float(rn.get("x")), float(rn.get("y"))
            if not (math.isfinite(x) and math.isfinite(y)):
                raise ValueError
        except (TypeError, ValueError):
            x = CANVAS_WIDTH / 2 + random.uniform(-20, 20)
            y = CANVAS_HEIGHT / 2 + random.uniform(-20, 20)

        nodes_payload.append(
            {"id": node_id, "x": round(x, 1), "y": round(y, 1), "level": level, "in": [], "out": []}
        )
    # an empty nodes list is a legitimate starting point (a brand-new,
    # blank diagram) - not an error

    by_id = {n["id"]: n for n in nodes_payload}
    seen_edge: set[tuple[str, str]] = set()
    edges_payload: list[dict] = []
    for re_ in raw["edges"]:
        s = re_.get("source", re_.get("s"))
        t = re_.get("target", re_.get("t"))
        if s not in by_id or t not in by_id or s == t or (s, t) in seen_edge:
            continue
        seen_edge.add((s, t))
        edge = {"s": s, "t": t}
        if re_.get("polarity") in ("+", "-"):
            edge["polarity"] = re_["polarity"]
        bend = re_.get("bend")
        if isinstance(bend, (int, float)) and math.isfinite(bend):
            edge["bend"] = bend
        edges_payload.append(edge)
        by_id[s]["out"].append(t)
        by_id[t]["in"].append(s)

    for n in nodes_payload:
        deg = len(n["in"]) + len(n["out"])
        n["r"] = round(min(9.0 + 2.8 * math.sqrt(deg), 24.0), 1)

    edge_pairs = {(e["s"], e["t"]) for e in edges_payload}
    loops_payload: list[dict] = []
    loops_dropped = 0
    for rl in raw.get("loops") or []:
        loop_nodes = rl.get("nodes")
        name = rl.get("name").strip() if isinstance(rl.get("name"), str) else ""
        loop_type = rl.get("type") if rl.get("type") in ("R", "B") else "R"
        ok = (
            bool(name)
            and isinstance(loop_nodes, list)
            and len(loop_nodes) >= 2
            and all(nid in by_id for nid in loop_nodes)
        )
        if ok:
            count = len(loop_nodes)
            ok = all((loop_nodes[i], loop_nodes[(i + 1) % count]) in edge_pairs for i in range(count))
        if ok:
            loops_payload.append({"name": name, "type": loop_type, "nodes": loop_nodes})
        else:
            loops_dropped += 1

    log_payload = [line for line in (raw.get("log") or []) if isinstance(line, str)]

    return {
        "nodes": nodes_payload,
        "edges": edges_payload,
        "levels": levels_payload,
        "canvas": {"w": CANVAS_WIDTH, "h": CANVAS_HEIGHT},
        "counts": {"nodes": len(nodes_payload), "edges": len(edges_payload)},
        "loops": loops_payload,
        "log": log_payload,
        "loopsDropped": loops_dropped,
    }


def render(path: str) -> str:
    data = build_payload_from_json(path) if Path(path).suffix.lower() == ".json" else build_payload(path)
    graph_json = json.dumps(data, separators=(",", ":"))

    fonts = {
        "PS_400": _b64(FONT_DIR / "public-sans-400.woff2"),
        "PS_600": _b64(FONT_DIR / "public-sans-600.woff2"),
        "PS_700": _b64(FONT_DIR / "public-sans-700.woff2"),
        "FR_600": _b64(FONT_DIR / "fraunces-600.woff2"),
        "FR_500I": _b64(FONT_DIR / "fraunces-500i.woff2"),
    }

    html = load_template()
    for key, val in fonts.items():
        html = html.replace(f"__{key}__", val)
    html = html.replace("__GRAPH_JSON__", graph_json)
    html = html.replace("__COUNT_N__", str(data["counts"]["nodes"]))
    html = html.replace("__COUNT_E__", str(data["counts"]["edges"]))
    html = html.replace("__CANVAS_W__", str(data["canvas"]["w"]))
    html = html.replace("__CANVAS_H__", str(data["canvas"]["h"]))
    return html


def load_template() -> str:
    """templates/page.html with style.css and app.js inlined into it, so the
    output stays a single self-contained file. The __PLACEHOLDER__ tokens
    left inside (fonts, graph data, counts, canvas size) are filled by
    render()."""
    page = (TEMPLATE_DIR / "page.html").read_text(encoding="utf-8")
    page = page.replace("__STYLE_CSS__", (TEMPLATE_DIR / "style.css").read_text(encoding="utf-8"))
    return page.replace("__APP_JS__", (TEMPLATE_DIR / "app.js").read_text(encoding="utf-8"))


def main() -> None:
    default_src = str(Path(__file__).parent / "empty.json")
    src = sys.argv[1] if len(sys.argv) > 1 else default_src
    dst = sys.argv[2] if len(sys.argv) > 2 else "cld.html"
    html = render(src)
    Path(dst).write_text(html, encoding="utf-8")  # matches the page's <meta charset>, whatever the system locale
    print(f"wrote {dst} ({len(html)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
