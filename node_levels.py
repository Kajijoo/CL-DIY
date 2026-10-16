# Copyright 2026 Jiri Kaan and Wageningen University
# SPDX-License-Identifier: Apache-2.0

"""
Default starting "levels" — a free-form grouping axis used to color-code
and filter nodes (e.g. proximate vs. distal causes, or whatever axis
matters for a given diagram).

Levels are fully editable inside the running app itself: add, rename,
recolor, reorder-by-number, or delete a level from the sidebar legend, and
the choice is saved with the diagram (exported JSON, undo history, the
lot). LEVEL_META here only supplies the starting palette handed to a
brand-new/empty diagram, or to a .xmile source that carries no level
information of its own — build_payload_from_json() prefers whatever
"levels" a JSON export already carries over this default.
"""
from __future__ import annotations

LEVEL_META = {
    1: {"key": "level-1", "label": "Level 1", "color": "#3987e5"},
    2: {"key": "level-2", "label": "Level 2", "color": "#2f9e6b"},
    3: {"key": "level-3", "label": "Level 3", "color": "#c98a2c"},
    4: {"key": "level-4", "label": "Level 4", "color": "#b24f4f"},
}
