"""
Parse a Vensim-exported XMILE causal loop diagram (CLD) into a simple
node/edge graph structure.

This file is NOT a simulatable stock-and-flow model: every <aux> equation
is the literal placeholder "A FUNCTION OF( ... )" that Vensim writes when a
variable's causal parents were sketched but never quantified. There are no
<stock>/<flow> elements. So instead of running it through an SD engine, we
just read off the declared causal parents of each variable and treat that
as a directed graph: parent -> child.

Every variable and link in the file is kept by default. One optional cleanup
exists for a Vensim quirk: when two diagrams get merged into one file,
Vensim renames the colliding copy's variables with a suffix such as "_0".
If such a copy is not real content, pass drop_suffix="_0" to load_graph()
(or --drop-suffix _0 on the command line) to drop every connected cluster
containing a variable with that suffix.

Usage (no numpy dependency here, so plain python3 is fine):
    python3 sd.py my-diagram.xmile out.json
    python3 sd.py my-diagram.xmile out.json --drop-suffix _0
"""
from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

NS = {"x": "http://docs.oasis-open.org/xmile/ns/XMILE/v1.0"}


@dataclass
class Graph:
    nodes: list[str] = field(default_factory=list)
    edges: list[tuple[str, str]] = field(default_factory=list)


def _split_arg_list(raw: str) -> list[str]:
    """Split the comma-separated argument list inside A FUNCTION OF( ... ),
    respecting double-quoted names that may themselves contain commas or
    escaped quotes (Vensim wraps "weird" variable names in quotes)."""
    args: list[str] = []
    buf = []
    in_quotes = False
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == "\\" and i + 1 < len(raw):
            # keep escaped char as-is (e.g. \" inside a quoted name)
            buf.append(ch)
            buf.append(raw[i + 1])
            i += 2
            continue
        if ch == '"':
            in_quotes = not in_quotes
            buf.append(ch)
        elif ch == "," and not in_quotes:
            args.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    if buf:
        args.append("".join(buf))
    return [normalize_name(a) for a in args if a.strip()]


def normalize_name(name: str) -> str:
    name = name.strip()
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1]
    name = name.replace("_", " ")
    # Vensim encodes the same quoted-name inconsistently: proper escaped
    # quotes in <eqn> references (\"...\") vs bare backslashes in the
    # <aux name=...> attribute (...\...\...). Strip both so e.g.
    # 'Stress, \gehaastheid\' and 'Stress, "gehaastheid"' collapse to the
    # same node instead of becoming two separate nodes.
    name = name.replace('\\"', '"').replace('"', "").replace("\\", "")
    return re.sub(r"\s+", " ", name).strip()


EQN_RE = re.compile(r"A FUNCTION OF\(\s*(.*?)\s*\)\s*$", re.DOTALL)


def parse_xmile(path: str) -> Graph:
    tree = ET.parse(path)
    root = tree.getroot()

    nodes: list[str] = []
    edges: list[tuple[str, str]] = []

    for aux in root.iter("{http://docs.oasis-open.org/xmile/ns/XMILE/v1.0}aux"):
        raw_name = aux.get("name")
        if raw_name is None:
            continue
        child = normalize_name(raw_name)
        nodes.append(child)

        eqn_el = aux.find("x:eqn", NS)
        if eqn_el is None or not eqn_el.text:
            continue
        eqn = eqn_el.text.strip()
        m = EQN_RE.match(eqn)
        if not m:
            continue
        parents = _split_arg_list(m.group(1))
        for parent in parents:
            edges.append((parent, child))

    # some parents may only appear as edge endpoints (not as their own <aux>)
    seen = set(nodes)
    for parent, child in edges:
        for n in (parent, child):
            if n not in seen:
                seen.add(n)
                nodes.append(n)

    return Graph(nodes=nodes, edges=edges)


def components(nodes: list[str], edges: list[tuple[str, str]]) -> list[list[str]]:
    """Group nodes into connected components (edges treated as undirected)."""
    parent = {n: n for n in nodes}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for s, t in edges:
        union(s, t)

    groups: dict[str, list[str]] = {}
    for n in nodes:
        groups.setdefault(find(n), []).append(n)
    return sorted(groups.values(), key=len, reverse=True)


def drop_suffixed_components(
    nodes: list[str], edges: list[tuple[str, str]], suffix: str
) -> tuple[list[str], list[tuple[str, str]]]:
    """Drop every connected component that contains a variable whose raw
    name ends in `suffix` (e.g. "_0", Vensim's collision-renaming suffix
    when two diagrams are merged into one file). Every other component is
    kept as-is, however small: a variable with no causal arrows at all is
    still real content."""
    # names are compared after normalize_name(), which turns "_" into a space
    norm_suffix = normalize_name("x" + suffix)[1:]
    comps = components(nodes, edges)
    real = [c for c in comps if not any(n.endswith(norm_suffix) for n in c)]
    if not real:
        raise ValueError(f"every component contains a '{suffix}'-suffixed variable - nothing to keep")
    keep = {n for c in real for n in c}
    kept_nodes = [n for n in nodes if n in keep]
    kept_edges = [(s, t) for s, t in edges if s in keep and t in keep]
    return kept_nodes, kept_edges


def dedupe_reciprocal_edges(edges: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Collapse a reciprocal A->B / B->A pair down to a single tie (keeping
    whichever direction appears first). Real feedback loops do exist in
    causal maps, but for now each node pair is treated as single-tie."""
    seen_undirected: set[frozenset[str]] = set()
    kept: list[tuple[str, str]] = []
    for s, t in edges:
        key = frozenset((s, t))
        if key in seen_undirected:
            continue
        seen_undirected.add(key)
        kept.append((s, t))
    return kept


def load_graph(path: str, drop_suffix: str | None = None) -> Graph:
    """Parse the file into a graph of every variable and link. With
    drop_suffix (e.g. "_0"), also drop Vensim merged-diagram duplicates via
    drop_suffixed_components(). Reciprocal A->B / B->A pairs are kept as
    real feedback loops - call dedupe_reciprocal_edges() on the result if
    you want them collapsed to a single tie instead."""
    graph = parse_xmile(path)
    if not drop_suffix:
        return graph
    nodes, edges = drop_suffixed_components(graph.nodes, graph.edges, drop_suffix)
    return Graph(nodes=nodes, edges=edges)


def main() -> None:
    ap = argparse.ArgumentParser(description="Parse a Vensim XMILE causal loop diagram into a node/edge JSON graph.")
    ap.add_argument("src", help="input .xmile file")
    ap.add_argument("dst", nargs="?", help="output .json file (omit to print a preview)")
    ap.add_argument("--drop-suffix", metavar="SUFFIX",
                    help='drop every connected cluster containing a variable named with this suffix, e.g. "_0" for Vensim merged-diagram duplicates')
    args = ap.parse_args()
    src, dst = args.src, args.dst

    graph = load_graph(src, drop_suffix=args.drop_suffix)
    print(f"{len(graph.nodes)} nodes, {len(graph.edges)} edges")

    payload = {
        "nodes": [{"id": n} for n in graph.nodes],
        "edges": [{"source": s, "target": t} for s, t in graph.edges],
    }

    if dst:
        with open(dst, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"wrote {dst}")
    else:
        print(json.dumps(payload, indent=2)[:2000])


if __name__ == "__main__":
    main()