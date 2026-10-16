# Copyright 2026 Jiri Kaan and Wageningen University
# SPDX-License-Identifier: Apache-2.0

"""
Force-directed layout for the CLD graph loaded by sd.py (sd.load_graph).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass
class LaidOutNode:
    id: str
    x: float
    y: float
    r: float
    in_deg: int
    out_deg: int


def _fruchterman_reingold(
    n: int,
    edge_pairs: list[tuple[int, int]],
    width: float,
    height: float,
    iterations: int = 700,
    seed: int = 7,
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    pos = rng.uniform(0, 1, size=(n, 2)) * [width, height]
    if n <= 1:
        return pos

    area = width * height
    k = math.sqrt(area / n) * 0.95
    t = width * 0.06
    dt = t / (iterations + 1)
    center = np.array([width / 2, height / 2])

    for _ in range(iterations):
        delta = pos[:, None, :] - pos[None, :, :]
        dist = np.sqrt((delta**2).sum(-1))
        np.fill_diagonal(dist, np.inf)
        dist = np.maximum(dist, 1.0)
        rep = (k * k) / dist
        disp = (delta / dist[..., None] * rep[..., None]).sum(axis=1)

        for i, j in edge_pairs:
            d = pos[i] - pos[j]
            dist_ij = max(float(np.hypot(*d)), 1.0)
            force = (dist_ij**2) / k
            direction = d / dist_ij
            disp[i] -= direction * force
            disp[j] += direction * force

        # mild centering gravity keeps sparsely-connected nodes from drifting
        disp += (center - pos) * 0.006

        dlen = np.maximum(np.linalg.norm(disp, axis=1), 1e-6)
        scale = np.minimum(dlen, t) / dlen
        pos += disp * scale[:, None]
        pos[:, 0] = np.clip(pos[:, 0], 0, width)
        pos[:, 1] = np.clip(pos[:, 1], 0, height)
        t -= dt

    return pos


def layout_graph(
    nodes: list[str],
    edges: list[tuple[str, str]],
) -> dict[str, LaidOutNode]:
    """Lay the (single, real) causal map out onto the canvas."""
    in_deg: dict[str, int] = {n: 0 for n in nodes}
    out_deg: dict[str, int] = {n: 0 for n in nodes}
    for s, t in edges:
        out_deg[s] += 1
        in_deg[t] += 1

    idx = {node: i for i, node in enumerate(nodes)}
    edge_pairs = [(idx[s], idx[t]) for s, t in edges]

    pad = 80.0
    raw = _fruchterman_reingold(len(nodes), edge_pairs, CANVAS_WIDTH, CANVAS_HEIGHT)

    lo, hi = raw.min(axis=0), raw.max(axis=0)
    span = np.maximum(hi - lo, 1.0)
    scale = min((CANVAS_WIDTH - 2 * pad) / span[0], (CANVAS_HEIGHT - 2 * pad) / span[1])
    centered = (raw - lo) * scale
    offset_x = pad + (CANVAS_WIDTH - 2 * pad - span[0] * scale) / 2
    offset_y = pad + (CANVAS_HEIGHT - 2 * pad - span[1] * scale) / 2

    result: dict[str, LaidOutNode] = {}
    for node in nodes:
        x, y = centered[idx[node]]
        deg = in_deg[node] + out_deg[node]
        r = min(9.0 + 2.8 * math.sqrt(deg), 24.0)
        result[node] = LaidOutNode(
            id=node,
            x=float(offset_x + x),
            y=float(offset_y + y),
            r=r,
            in_deg=in_deg[node],
            out_deg=out_deg[node],
        )
    return result


CANVAS_WIDTH = 1550.0
CANVAS_HEIGHT = 1220.0
