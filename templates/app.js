
// Copyright 2026 Jiri Kaan and Wageningen University
// SPDX-License-Identifier: Apache-2.0

// the page exactly as it loaded, before this script touches the DOM - the
// "Save as web page" option copies it with the DATA line swapped for the
// current diagram (this script is the last thing in <body>, so nothing after
// it is missing). No fetch(location.href): that fails on a local file.
const PAGE_SOURCE_AT_LOAD = document.documentElement.outerHTML;

const svgNS = "http://www.w3.org/2000/svg";
const svg = document.getElementById('svg');
const viewport = document.getElementById('viewport');
const stage = document.getElementById('stage');

// levels are a free-form, fully user-editable grouping/color axis (add,
// rename, recolor, delete - all from the sidebar legend). `levels` is the
// live mutable array; `levelByNum` is rebuilt from it after every change so
// lookups elsewhere stay O(1). Declared this early (rather than next to the
// legend code that edits them) for the same TDZ reason as addNodeMode
// below: buildGraph() resets both from sourceData.levels and runs for the
// first time before this file's execution reaches the legend section.
let levels = DATA.levels.map(l => ({ ...l }));
let levelByNum = new Map();
function rebuildLevelByNum() { levelByNum = new Map(levels.map(l => [l.level, l])); }
rebuildLevelByNum();
let levelIdSeq = levels.reduce((m, l) => Math.max(m, l.level), 0);

// grid containers the level-editing functions below populate - looked up
// this early for the same reason: buildGraph(DATA) (below) ends by calling
// renderAllLevelGrids(), before execution would otherwise reach these.
const levelGrid = document.getElementById('level-grid');
const addNodeLevelGrid = document.getElementById('add-node-level-grid');
const mergeLevelGrid = document.getElementById('merge-level-grid');
const detailLevelGrid = document.getElementById('detail-level-grid');

const edgeLayer = document.createElementNS(svgNS, 'g');
const nodeLayer = document.createElementNS(svgNS, 'g');
const labelLayer = document.createElementNS(svgNS, 'g');
const polarityLayer = document.createElementNS(svgNS, 'g'); // "+"/"-" badges, always on top so they stay legible over crossing edges
viewport.appendChild(edgeLayer);
viewport.appendChild(nodeLayer);
viewport.appendChild(labelLayer);
viewport.appendChild(polarityLayer);

// live graph state - reassigned wholesale by buildGraph(), mutated in place
// by addEdge()/removeEdge()/removeNode()/mergeNodes() as the user edits the diagram
let byId, nodeEls, labelEls, edgeEls, edgeVisuals, neighborIds, liveNodes, activeLevel;
let selected = null;
let suppressClick = false;
let mergeMode = false, mergePicked = [], mergeLevel = 1;

// add-a-new-variable mode - see addNode()/setAddNodeMode() further down.
// Declared this early (rather than next to that code) because buildGraph()
// references it below and runs for the first time before this file's
// execution reaches that later block - a `let` referenced before its own
// declaration line executes throws, even though the reference is inside a
// function body, so the declaration has to sit ahead of buildGraph(DATA).
let addNodeMode = false, addNodeLevel = 1;

// free-arrange mode - see setFreeMode()/togglePin() near the drag-physics
// code below for what "pinned" actually does to a node
let freeMode = false;
// node ids pinned automatically by the *current* free-arrange session (not
// pinned some other way, e.g. a saved loop's own pin button) - tracked so
// turning the mode back off can release exactly those, and only those
let freeModeAutoPinned = new Set();

// "show all loops" mode - see setShowAllLoops() further down. Declared this
// early for the same reason addNodeMode is (see the comment above it):
// resetSpotlightVisuals(), which this reads, runs for the first time via
// buildGraph(DATA) below, before this file's execution reaches the later
// block that would otherwise declare it.
let showAllLoops = false;

// feedback-loop annotation state - loops: [{id, name, type: 'R'|'B', nodes, color}]
let loops = [];
let loopMode = false, loopPicked = [], loopType = 'R';
let loopColorSeq = 0, loopIdSeq = 0;
let highlightedLoopIds = new Set(); // multiple loops can be highlighted at once - see toggleLoopHighlight()

// undo stack - see pushUndoCheckpoint()/undo() further down for what
// actually gets tracked. Declared this early for the same TDZ reason
// addNodeMode/showAllLoops are: the initial-load block below seeds it
// before this file's execution would otherwise reach its later definition.
let undoStack = [];
// the full 8-hue standard categorical palette - see the --loop-N comment
// near :root for how 6/7/8 (blue/orange/green) avoid colliding with those
// hues' other meanings elsewhere on this canvas
const LOOP_COLORS = ['var(--loop-1)', 'var(--loop-2)', 'var(--loop-3)', 'var(--loop-4)', 'var(--loop-5)', 'var(--loop-6)', 'var(--loop-7)', 'var(--loop-8)'];

// one entry per *user-intent* edit (delete/merge/rename/manual link add or
// remove/restore) - not per low-level addEdge()/removeEdge() call, so a
// single delete that bridges five ties logs once, not five times
let changeLog = [];

// "comment on edits" mode - when on, every user edit opens a small dialog
// asking for an optional comment (why it was made), stored on that edit's
// change-log entry. Off by default; any entry can also be commented later
// from the change log itself.
let commentMode = true;
// entries that are bookkeeping, not an edit the user made - never prompted for
const UNPROMPTED_LOG_TYPES = new Set(['history', 'import', 'undo']);
let pendingCommentEntry = null;

function logChange(type, text, comment) {
  const entry = { type, text, comment: comment || '' };
  changeLog.unshift(entry);
  renderChangeLog();
  // one user action can log several entries (a delete that breaks loops
  // also logs each loop removal) - only the first one, the action itself,
  // is prompted for, once the action has finished
  if (commentMode && !UNPROMPTED_LOG_TYPES.has(type) && !pendingCommentEntry) {
    pendingCommentEntry = entry;
    queueMicrotask(() => {
      const e = pendingCommentEntry;
      pendingCommentEntry = null;
      if (e) openCommentModal(e, false);
    });
  }
  return entry;
}

// a log line from a JSON file: a plain string, or {text, comment} once it
// has a comment. Returns {text, comment}, or null if it isn't usable.
function normalizeLogLine(raw) {
  if (typeof raw === 'string') return { text: raw, comment: '' };
  if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
    return { text: raw.text, comment: typeof raw.comment === 'string' ? raw.comment : '' };
  }
  return null;
}

function renderChangeLog() {
  document.getElementById('changelog-count').textContent = changeLog.length;
  const list = document.getElementById('changelog-list');
  list.innerHTML = '';
  if (changeLog.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No edits yet.';
    list.appendChild(li);
    return;
  }
  changeLog.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'type-' + entry.type;
    const row = document.createElement('div');
    row.className = 'changelog-row';
    const text = document.createElement('span');
    text.textContent = entry.text;
    const btn = document.createElement('button');
    btn.className = 'changelog-comment-btn';
    btn.innerHTML = COMMENT_ICON_SVG;
    btn.title = entry.comment ? 'Edit comment' : 'Add a comment';
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', () => openCommentModal(entry, true));
    row.appendChild(text);
    row.appendChild(btn);
    li.appendChild(row);
    if (entry.comment) {
      const c = document.createElement('p');
      c.className = 'changelog-comment';
      c.textContent = entry.comment;
      li.appendChild(c);
    }
    list.appendChild(li);
  });
}

const COMMENT_ICON_SVG = '<svg class="icon-sm" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M1 1.5 H9 V7 H4.5 L2.5 9 V7 H1 Z"/></svg>';
renderChangeLog();

// ---- comment dialog: one edit's change-log entry at a time ----
const commentModal = document.getElementById('comment-modal');
const commentInput = document.getElementById('comment-input');
let commentModalEntry = null;

// fromLog: opened from the change log's own button (editing an existing
// entry) rather than right after an edit in comment mode
function openCommentModal(entry, fromLog) {
  commentModalEntry = entry;
  document.getElementById('comment-action').textContent = entry.text;
  document.getElementById('comment-skip').textContent = fromLog ? 'Cancel' : 'Skip';
  // turning comment mode off only makes sense for the automatic prompt
  document.getElementById('comment-off').style.display = fromLog ? 'none' : '';
  commentInput.value = entry.comment || '';
  commentModal.style.display = 'flex';
  commentInput.focus();
}

function closeCommentModal(save) {
  if (commentModal.style.display === 'none') return;
  if (save && commentModalEntry) {
    commentModalEntry.comment = commentInput.value.trim();
    renderChangeLog();
  }
  commentModal.style.display = 'none';
  commentModalEntry = null;
}

document.getElementById('comment-save').addEventListener('click', () => closeCommentModal(true));
document.getElementById('comment-skip').addEventListener('click', () => closeCommentModal(false));
document.getElementById('comment-off').addEventListener('click', () => {
  closeCommentModal(true);
  setCommentMode(false);
});
commentModal.addEventListener('click', (e) => { if (e.target === commentModal) closeCommentModal(false); });
commentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeCommentModal(true); }
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCommentModal(false); });

function setCommentMode(on) {
  commentMode = on;
  document.getElementById('comment-toggle').dataset.active = on ? '1' : '0';
}
document.getElementById('comment-toggle').addEventListener('click', () => setCommentMode(!commentMode));

// a small "remove" icon reused by every per-row remove button - inline SVG,
// not a text glyph, so it doesn't depend on the embedded fonts (or the
// viewer's system fonts) having an X/multiplication-sign character at all
const X_ICON_SVG = '<svg class="icon-sm" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5"/></svg>';
// same pin glyph as the free-arrange toggle above the canvas, reused at
// per-loop-row scale
const PIN_ICON_SVG = '<svg class="icon-sm" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="3.6" r="1.9"/><path d="M5 5.5 L5 9" /></svg>';
// a small "picture" glyph for "export this loop as a PNG" - same inline-SVG
// reasoning as the two icons above
const PNG_ICON_SVG = '<svg class="icon-sm" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0.8" y="0.8" width="8.4" height="8.4" rx="1.1"/><circle cx="3.4" cy="3.6" r="0.9"/><path d="M9 6.6 L6.4 4.2 L1.8 8.4"/></svg>';
// polarity glyphs - drawn as SVG paths, not text, same reasoning as the
// canvas polarity badge (createPolarityLabel): a "+"/"-"/"+/-" character
// isn't guaranteed to be in every font's fallback chain in every renderer
const POLARITY_PLUS_SVG = '<svg class="icon-sm" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5 2 L5 8 M2 5 L8 5"/></svg>';
const POLARITY_MINUS_SVG = '<svg class="icon-sm" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 5 L8 5"/></svg>';
const POLARITY_UNSET_SVG = '<svg class="icon-sm" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M5 1.6 L5 4.4 M3.2 3 L6.8 3"/><path d="M3.2 7 L6.8 7"/></svg>';

// degree-based dot size, same formula the server-side layout uses - kept
// here so a brand-new merged node gets a correctly-sized dot at creation
function computeRadius(n) {
  return Math.min(9 + 2.8 * Math.sqrt(n.in.length + n.out.length), 24);
}

// ---- node boxes: each variable is a rounded rectangle with its name
// word-wrapped inside. The box is sized for the *bold* label width, since
// a spotlit node's label turns bold and must still fit. n.hw/n.hh are the
// box's half-width/half-height around the node's center (n.x, n.y). ----
const NODE_FONT_PX = 10.5;
const NODE_LINE_H = 13;
const NODE_PAD_X = 7, NODE_PAD_Y = 5;
const NODE_MAX_TEXT_W = 112; // wrap names onto more lines past this width
const NODE_CORNER = 6;
const labelMeasureCtx = document.createElement('canvas').getContext('2d');

function labelTextWidth(s) {
  labelMeasureCtx.font = `700 ${NODE_FONT_PX}px 'Public Sans', sans-serif`;
  return labelMeasureCtx.measureText(s).width;
}

// greedy word wrap - a single word longer than the max width gets a line
// to itself and simply widens the box
function wrapLabel(text) {
  const lines = [];
  let cur = '';
  text.split(/\s+/).filter(Boolean).forEach(w => {
    const candidate = cur ? cur + ' ' + w : w;
    if (!cur || labelTextWidth(candidate) <= NODE_MAX_TEXT_W) cur = candidate;
    else { lines.push(cur); cur = w; }
  });
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// (re)wraps the label's lines into tspans and resizes the box to fit them
function layoutNodeBox(n) {
  const lines = wrapLabel(n.id);
  n.hw = Math.max(...lines.map(labelTextWidth)) / 2 + NODE_PAD_X;
  n.hh = (lines.length * NODE_LINE_H) / 2 + NODE_PAD_Y;
  const t = labelEls.get(n.id);
  if (t) {
    t.replaceChildren();
    const firstY = -((lines.length - 1) * NODE_LINE_H) / 2 + NODE_FONT_PX * 0.35; // 0.35em ~ half the x-height, so the block centers vertically
    lines.forEach((line, i) => {
      const span = document.createElementNS(svgNS, 'tspan');
      span.setAttribute('x', 0);
      span.setAttribute('y', firstY + i * NODE_LINE_H);
      span.textContent = line;
      t.appendChild(span);
    });
  }
  const el = nodeEls.get(n.id);
  if (el) {
    el.setAttribute('width', 2 * n.hw);
    el.setAttribute('height', 2 * n.hh);
  }
  positionNodeEls(n);
}

// moves one node's box + label to its current (n.x, n.y) - the label is
// positioned by transform so its tspans can stay relative to the center
function positionNodeEls(n) {
  const el = nodeEls.get(n.id);
  if (el) {
    el.setAttribute('x', n.x - n.hw);
    el.setAttribute('y', n.y - n.hh);
  }
  const t = labelEls.get(n.id);
  if (t) t.setAttribute('transform', `translate(${n.x},${n.y})`);
}

// dark ink on light fills, white on dark ones (WCAG relative luminance)
function labelColorFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const v = parseInt(m[1], 16);
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(v >> 16 & 255) + 0.7152 * lin(v >> 8 & 255) + 0.0722 * lin(v & 255);
  return L > 0.32 ? '#1d232b' : '#ffffff';
}

function paintNode(id, color) {
  const el = nodeEls.get(id);
  if (el) el.setAttribute('fill', color);
  const t = labelEls.get(id);
  if (t) t.style.fill = labelColorFor(color);
}

// the embedded font may not be decoded yet on first build, so the initial
// measurements could be against a fallback face - re-wrap once it is
document.fonts.load(`700 ${NODE_FONT_PX}px 'Public Sans'`).then(() => {
  if (!liveNodes) return;
  liveNodes.forEach(layoutNodeBox);
  redrawEdgeGeometry();
}).catch(() => {});

// distance from a box's center to its border along unit direction (ux, uy)
function boxPad(n, ux, uy) {
  const hw = n.hw || 0, hh = n.hh || 0;
  const tx = Math.abs(ux) > 1e-6 ? hw / Math.abs(ux) : Infinity;
  const ty = Math.abs(uy) > 1e-6 ? hh / Math.abs(uy) : Infinity;
  return Math.min(tx, ty);
}

// dispatches a node click to whichever mode is active: picking nodes for a
// merge, picking nodes for a feedback loop, or the normal single-select
// spotlight - free-arrange mode doesn't hijack this: every node is already
// pinned in bulk the moment that mode turns on (see setFreeMode()), so a
// click there just selects/inspects the node like normal; dragging (a
// separate pointerdown listener, unaffected by this dispatch) still moves it
function onNodeClick(id) {
  if (mergeMode) {
    toggleMergePick(id);
  } else if (loopMode) {
    toggleLoopPick(id);
  } else {
    selectNode(id);
  }
}

// trims each end back by that node's own radius (plus a small gap) so the
// line - and its arrowhead - clears the node's fill instead of disappearing
// under it, and returns the trimmed endpoints + control point rather than a
// path string directly - edgeCurve() turns that into "d", pointAtT() turns
// it into a point along the curve for positioning a polarity badge.
// bendOverride, when not null/undefined, replaces the auto-computed bow -
// this is how a manually-dragged edge (see startEdgeDrag()) stays bent
// where the user left it instead of snapping back to the default curve.
// Without an override, a bidirectional pair gets bow=0 (an exact straight
// line, control point on the midpoint) since a curve with arrowheads on
// both ends reads worse than a plain double-headed line - but the user can
// still drag one into a curve deliberately, same as any other edge.
function edgeGeometry(a, b, bidir, bendOverride) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const gap = 3;
  const maxPad = Math.max(dist / 2 - 1, 0); // keeps the two trims from crossing on very short edges
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const nx = -dy, ny = dx;
  const autoBow = bidir ? 0 : Math.min(dist * 0.08, 26);
  const bow = bendOverride != null ? bendOverride : autoBow;
  const cx = mx + (nx / dist) * bow, cy = my + (ny / dist) * bow;
  // a quadratic curve leaves each end heading straight at the control
  // point, so trimming along that direction lands the end exactly on the
  // node box's border, however wide the box or bent the curve
  const trim = (n) => {
    const tx = cx - n.x, ty = cy - n.y;
    const td = Math.hypot(tx, ty) || 1;
    const ux = tx / td, uy = ty / td;
    const pad = Math.min(boxPad(n, ux, uy) + gap, maxPad);
    return [n.x + ux * pad, n.y + uy * pad];
  };
  const [sx, sy] = trim(a);
  const [ex, ey] = trim(b);
  return { sx, sy, ex, ey, cx, cy };
}

function edgeCurve(geo) {
  return `M${geo.sx},${geo.sy} Q${geo.cx},${geo.cy} ${geo.ex},${geo.ey}`;
}

// point at parameter t (0 = source end, 1 = target end) along that same
// quadratic curve - used to plant a polarity badge near the arrowhead it
// belongs to, without duplicating edgeGeometry's endpoint-trimming math
function pointAtT(geo, t) {
  const omt = 1 - t;
  return {
    x: omt * omt * geo.sx + 2 * omt * t * geo.cx + t * t * geo.ex,
    y: omt * omt * geo.sy + 2 * omt * t * geo.cy + t * t * geo.ey,
  };
}

function positionLabel(g, geo, t) {
  const p = pointAtT(geo, t);
  g.setAttribute('transform', `translate(${p.x},${p.y})`);
}

// cheap per-frame geometry update - just moves the existing visual paths
// and polarity badges, doesn't touch which ones exist. Safe to call on
// every drag/sim tick.
function redrawEdgeGeometry() {
  edgeVisuals.forEach((entry) => {
    const geo = edgeGeometry(entry.a, entry.b, entry.bidir, entry.bend);
    const d = edgeCurve(geo);
    entry.el.setAttribute('d', d);
    if (entry.hitEl) entry.hitEl.setAttribute('d', d); // wide invisible drag/hover target, same geometry
    if (entry.stripeEls) entry.stripeEls.forEach(el => el.setAttribute('d', d)); // multi-loop overlay, same geometry as the base path
    if (entry.fwdLabelEl) positionLabel(entry.fwdLabelEl, geo, 0.74); // near the s->t arrowhead, at the target end
    if (entry.revLabelEl) positionLabel(entry.revLabelEl, geo, 0.26); // near the t->s arrowhead, at the source end
  });
}

// small "+"/"-" badge marking one causal link's polarity ("+" = cause and
// effect move the same way, "-" = they move opposite ways - standard CLD
// notation), or the neutral unset glyph when polarity is null. Always
// present on every edge (not just ones already assigned a polarity) so
// there's a button right on the canvas to set one; it stays low-opacity
// until the edge or the badge itself is hovered, so 150-odd of these don't
// clutter a dense diagram at rest (see .polarity-label CSS). Clicking it
// cycles the same way the sidebar's +/- button does. The sign is drawn as a
// path, not an SVG <text> glyph - Unicode's minus sign (U+2212) isn't
// reliably in the embedded font's per-character fallback chain for SVG
// text specifically in every renderer (WebKit/Safari can render nothing
// there instead of falling back to a system font, even where the same
// character renders fine as plain HTML text), so it's drawn directly
// instead, matching how every other icon in this app avoids depending on
// any font having a given glyph at all.
function createPolarityLabel(polarity, s, t) {
  const g = document.createElementNS(svgNS, 'g');
  g.setAttribute('class', 'polarity-label');
  if (polarity) g.dataset.polarity = polarity;
  const circle = document.createElementNS(svgNS, 'circle');
  circle.setAttribute('r', '7');
  const glyph = document.createElementNS(svgNS, 'path');
  glyph.setAttribute('d', polarity === '+' ? 'M-3,0 L3,0 M0,-3 L0,3' : polarity === '-' ? 'M-3,0 L3,0' : 'M-2,-2.5 L2,-2.5 M0,-4.5 L0,-0.5 M-2,2.5 L2,2.5');
  glyph.setAttribute('class', 'polarity-glyph');
  g.appendChild(circle);
  g.appendChild(glyph);
  g.addEventListener('click', (ev) => {
    ev.stopPropagation();
    cyclePolarity(s, t);
    if (selected === s || selected === t) selectNode(selected); // keep the detail panel's own +/- button in sync
  });
  return g;
}

// (re)builds the on-screen edge paths (and any polarity badges) from the
// current edgeEls - call whenever the edge *set* or a polarity changes
// (add/remove/merge/restore/import/polarity edit), not on every animation
// frame. A reciprocal pair (A->B and B->A both saved) collapses into a
// single double-headed path instead of two separate arcs.
function rebuildEdgeVisuals() {
  edgeLayer.replaceChildren();
  polarityLayer.replaceChildren();
  edgeVisuals = [];
  const seen = new Set();
  edgeEls.forEach(e => {
    const key = JSON.stringify(e.s < e.t ? [e.s, e.t] : [e.t, e.s]);
    if (seen.has(key)) return;
    seen.add(key);
    const rev = edgeEls.find(o => o.s === e.t && o.t === e.s);
    const bidir = !!rev;
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'edge-path');
    path.setAttribute('marker-end', 'url(#arrow)');
    if (bidir) path.setAttribute('marker-start', 'url(#arrow)');
    edgeLayer.appendChild(path);

    // wide, invisible sibling path purely for pointer interaction - the
    // visible line is only 1-2px, too thin to reliably grab or hover
    const hit = document.createElementNS(svgNS, 'path');
    hit.setAttribute('class', 'edge-hit');
    edgeLayer.appendChild(hit);

    // always create both badges (not just when a polarity is already set)
    // so there's a button on every edge to assign one - see createPolarityLabel
    const fwdLabelEl = createPolarityLabel(e.polarity, e.s, e.t);
    polarityLayer.appendChild(fwdLabelEl);
    let revLabelEl = null;
    if (bidir) {
      revLabelEl = createPolarityLabel(rev.polarity, rev.s, rev.t);
      polarityLayer.appendChild(revLabelEl);
    }

    const entry = {
      el: path, hitEl: hit, s: e.s, t: e.t, a: byId.get(e.s), b: byId.get(e.t), bidir,
      bend: e.bend != null ? e.bend : (rev && rev.bend != null ? rev.bend : null),
      fwdLabelEl, revLabelEl,
    };
    hit.addEventListener('pointerdown', (ev) => startEdgeDrag(ev, entry));
    hit.addEventListener('pointerenter', () => setEdgeBadgesHovered(entry, true));
    hit.addEventListener('pointerleave', () => setEdgeBadgesHovered(entry, false));
    edgeVisuals.push(entry);
  });
  redrawEdgeGeometry();
}

function setEdgeBadgesHovered(entry, on) {
  if (entry.fwdLabelEl) entry.fwdLabelEl.classList.toggle('edge-hovered', on);
  if (entry.revLabelEl) entry.revLabelEl.classList.toggle('edge-hovered', on);
}

// add a single causal tie, deduped, wiring up spring adjacency + the
// endpoints' in/out lists (used by the detail panel and the spotlight) -
// purely data; call rebuildEdgeVisuals() afterward to reflect it on screen
function addEdge(s, t) {
  if (s === t) return null;
  if (!byId.has(s) || !byId.has(t)) return null;
  if (edgeEls.some(e => e.s === s && e.t === t)) return null;
  const a = byId.get(s), b = byId.get(t);
  const entry = { s, t, polarity: null, bend: null };
  edgeEls.push(entry);

  if (!neighborIds.get(s).includes(t)) neighborIds.get(s).push(t);
  if (!neighborIds.get(t).includes(s)) neighborIds.get(t).push(s);
  if (!a.out.includes(t)) { a.out.push(t); a.out.sort(); }
  if (!b.in.includes(s)) { b.in.push(s); b.in.sort(); }
  return entry;
}

// cycles a link's polarity: unset -> + -> - -> unset. Shared by the
// sidebar's +/- button and clicking a badge directly on the canvas.
function cyclePolarity(s, t) {
  const entry = edgeEls.find(e => e.s === s && e.t === t);
  if (!entry) return null;
  entry.polarity = entry.polarity === null ? '+' : entry.polarity === '+' ? '-' : null;
  const polarityMsg = entry.polarity
    ? `Set polarity of "${s}" -> "${t}" to ${entry.polarity}`
    : `Cleared polarity of "${s}" -> "${t}"`;
  logChange('polarity', polarityMsg);
  pushUndoCheckpoint(polarityMsg);
  rebuildEdgeVisuals();
  return entry.polarity;
}

// purely data, same reasoning as addEdge - call rebuildEdgeVisuals() after
function removeEdge(entry) {
  const idx = edgeEls.indexOf(entry);
  if (idx >= 0) edgeEls.splice(idx, 1);
  const nb1 = neighborIds.get(entry.s);
  if (nb1) neighborIds.set(entry.s, nb1.filter(x => x !== entry.t));
  const nb2 = neighborIds.get(entry.t);
  if (nb2) neighborIds.set(entry.t, nb2.filter(x => x !== entry.s));
  if (byId.has(entry.t)) byId.get(entry.t).in = byId.get(entry.t).in.filter(x => x !== entry.s);
  if (byId.has(entry.s)) byId.get(entry.s).out = byId.get(entry.s).out.filter(x => x !== entry.t);
}

function updateStats() {
  document.getElementById('stat-nodes').textContent = liveNodes.length;
  document.getElementById('stat-edges').textContent = edgeEls.length;
}

// creates one node's box + label + listeners and registers it in the
// live maps - used by buildGraph's initial pass and by mergeNodes() when it
// creates the merged replacement node
function createNodeEl(n) {
  const c = document.createElementNS(svgNS, 'rect');
  c.setAttribute('rx', NODE_CORNER);
  c.setAttribute('class', 'node-dot');
  c.dataset.id = n.id;
  c.dataset.level = n.level;
  c.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (suppressClick) { suppressClick = false; return; }
    onNodeClick(n.id);
  });
  c.addEventListener('pointerdown', (ev) => startNodeDrag(ev, n));
  nodeLayer.appendChild(c);
  nodeEls.set(n.id, c);

  const t = document.createElementNS(svgNS, 'text');
  t.setAttribute('class', 'node-label');
  // an attribute, not CSS - the PNG export clones this into a detached
  // SVG without the page's stylesheet, so a CSS-only centering is lost there
  t.setAttribute('text-anchor', 'middle');
  t.dataset.id = n.id;
  t.dataset.level = n.level;
  labelLayer.appendChild(t);
  labelEls.set(n.id, t);

  paintNode(n.id, levelByNum.get(n.level).color);
  layoutNodeBox(n);
}

// (re)builds the whole diagram from a data object shaped like DATA - used
// once at load and again by "restore full diagram" after a fresh clone
function buildGraph(sourceData) {
  edgeLayer.replaceChildren();
  nodeLayer.replaceChildren();
  labelLayer.replaceChildren();
  polarityLayer.replaceChildren();

  // levels have to be live before createNodeEl() runs below - it looks up
  // each node's fill color via levelByNum, and a restored/imported node can
  // carry a level number the *previous* levelByNum never had (e.g. undoing
  // a level deletion brings back both a node and the level it was on)
  levels = sourceData.levels.map(l => ({ ...l }));
  rebuildLevelByNum();
  levelIdSeq = levels.reduce((m, l) => Math.max(m, l.level), 0);
  activeLevel = {};
  levels.forEach(l => { activeLevel[l.level] = true; });
  const firstLevel = levels[0].level;
  if (!levelByNum.has(addNodeLevel)) addNodeLevel = firstLevel;
  if (!levelByNum.has(mergeLevel)) mergeLevel = firstLevel;

  byId = new Map(sourceData.nodes.map(n => [n.id, n]));
  liveNodes = sourceData.nodes.slice();
  nodeEls = new Map();
  labelEls = new Map();
  edgeEls = [];
  edgeVisuals = [];
  neighborIds = new Map(sourceData.nodes.map(n => [n.id, []]));

  sourceData.nodes.forEach(n => {
    n.x0 = n.x;
    n.y0 = n.y;
    n.vx = 0;
    n.vy = 0;
    n.pinned = false;
    createNodeEl(n);
  });

  sourceData.edges.forEach(e => {
    const entry = addEdge(e.s, e.t);
    if (!entry) return;
    if (e.polarity === '+' || e.polarity === '-') entry.polarity = e.polarity;
    if (typeof e.bend === 'number') entry.bend = e.bend;
  });
  rebuildEdgeVisuals();
  renderAllLevelGrids();

  // node/edge identity isn't preserved across a rebuild, so any saved loops
  // would be pointing at objects that no longer exist - callers that need
  // to keep loops (the initial page load) restore them separately afterward
  // via restoreLoopsAndLogFrom()
  loops = [];
  highlightedLoopIds = new Set();
  if (loopMode) setLoopMode(false);
  if (freeMode) setFreeMode(true); // stays on across a rebuild - re-sweep so the fresh node objects are pinned too
  if (addNodeMode) setAddNodeMode(false);
  if (showAllLoops) setShowAllLoops(false);
  renderLoopList();

  clearSelection();
  updateStats();
}

// restores loops/log from a DATA-shaped object's own .loops/.log/
// .loopsDropped - present when the page was rendered from an exported
// graph JSON (see build_payload_from_json() in render.py); absent for an
// xmile-sourced page, where this is a no-op. Called once at initial page
// load, right after buildGraph(DATA) - buildGraph() itself always resets
// loops to empty and has no idea a source object might carry its own.
function restoreLoopsAndLogFrom(source) {
  if (!Array.isArray(source.loops) && !Array.isArray(source.log)) return;
  (source.loops || []).forEach(rl => {
    loops.push({
      id: 'loop-' + (++loopIdSeq),
      name: rl.name,
      type: rl.type,
      nodes: rl.nodes.slice(),
      color: LOOP_COLORS[loopColorSeq % LOOP_COLORS.length],
    });
    loopColorSeq++;
  });
  renderLoopList();

  (source.log || []).map(normalizeLogLine).filter(Boolean)
    .forEach(l => logChange('history', l.text, l.comment));
  if (source.loopsDropped) {
    logChange('history', `${source.loopsDropped} feedback loop(s) from the source file were dropped - no longer a valid cycle.`);
  }
}

buildGraph(DATA);
restoreLoopsAndLogFrom(DATA);

// baseline for the undo stack - the state as first loaded (whatever that
// is: a bare xmile parse, or a JSON export with its own loops/log already
// restored above), with no "action" of its own to describe
undoStack.push({ snapshot: captureSnapshot(), text: null });
updateUndoButton();

// deletes a node and reconnects its parents directly to its children
// (A -> B -> C becomes A -> C once B is gone), the way "removing a step"
// should behave in a causal chain rather than just severing it
function removeNode(id) {
  if (!byId.has(id)) return;
  const n = byId.get(id);
  const parents = n.in.slice();
  const children = n.out.slice();

  edgeEls.filter(e => e.s === id || e.t === id).forEach(removeEdge);
  parents.forEach(p => children.forEach(c => { if (p !== c) addEdge(p, c); }));

  nodeEls.get(id).remove();
  labelEls.get(id).remove();
  nodeEls.delete(id);
  labelEls.delete(id);
  neighborIds.delete(id);
  byId.delete(id);
  liveNodes = liveNodes.filter(x => x.id !== id);

  rebuildEdgeVisuals();
  updateStats();
  const deleteMsg = `Deleted "${id}" - ${parents.length} cause(s) now connect directly to ${children.length} effect(s)`;
  logChange('delete', deleteMsg);
  pruneInvalidLoops();
  pushUndoCheckpoint(deleteMsg);

  if (selected === id) {
    clearSelection();
  } else if (selected && byId.has(selected)) {
    selectNode(selected); // refresh in/out lists - bridging may have changed them
  }
}

document.getElementById('delete-btn').addEventListener('click', () => {
  if (selected) removeNode(selected);
});

// wipes down to a blank canvas - for starting a completely new diagram
// rather than editing the loaded one. This pushes its own undo checkpoint
// like every other edit, so the confirm just guards against a stray click -
// one Undo brings everything straight back if it was a mistake.
document.getElementById('clear-all-btn').addEventListener('click', () => {
  if (liveNodes.length === 0) return; // already empty, nothing to confirm
  if (!confirm('Delete all nodes and links? This clears the entire diagram so you can build a new one from scratch.\n\n(Click Undo afterward if you change your mind.)')) return;
  buildGraph({ nodes: [], edges: [], levels }); // keep the current level scheme - only content is being cleared
  changeLog = [];
  logChange('clear-all', 'Cleared the entire diagram - starting fresh');
  pushUndoCheckpoint('Cleared the entire diagram');
});

// ---- merge (and rename, which is just a merge of one) ----
// A -> B -> C, merging B into A becomes A -> C: internal ties between the
// merged nodes are dropped (they'd become a self-loop), and every distinct
// outside parent/child gets exactly one edge to/from the merged node.
function mergeNodes(ids, newName, level) {
  newName = newName.trim();
  if (!newName) return null;

  // renaming/merging onto an existing node's name folds that node into the
  // merge too, rather than silently overwriting or rejecting it
  const mergeSet = new Set(ids);
  liveNodes.forEach(n => { if (n.id === newName) mergeSet.add(n.id); });
  const mergeIds = [...mergeSet].filter(id => byId.has(id));
  if (mergeIds.length === 0) return null;

  let sx = 0, sy = 0;
  mergeIds.forEach(id => { const n = byId.get(id); sx += n.x; sy += n.y; });
  const cx = sx / mergeIds.length, cy = sy / mergeIds.length;

  const parents = new Set();
  const children = new Set();
  mergeIds.forEach(id => {
    const n = byId.get(id);
    n.in.forEach(p => { if (!mergeIds.includes(p)) parents.add(p); });
    n.out.forEach(c => { if (!mergeIds.includes(c)) children.add(c); });
  });

  mergeIds.forEach(id => {
    edgeEls.filter(e => e.s === id || e.t === id).forEach(removeEdge);
  });
  mergeIds.forEach(id => {
    nodeEls.get(id).remove();
    labelEls.get(id).remove();
    nodeEls.delete(id);
    labelEls.delete(id);
    neighborIds.delete(id);
    byId.delete(id);
  });
  liveNodes = liveNodes.filter(n => !mergeIds.includes(n.id));

  const merged = { id: newName, x: cx, y: cy, r: 9, level, in: [], out: [], vx: 0, vy: 0, x0: cx, y0: cy, pinned: false };
  byId.set(newName, merged);
  liveNodes.push(merged);
  neighborIds.set(newName, []);
  createNodeEl(merged);

  parents.forEach(p => addEdge(p, newName));
  children.forEach(c => addEdge(newName, c));

  merged.r = computeRadius(merged);

  rebuildEdgeVisuals();
  updateStats();
  let mergeMsg;
  if (mergeIds.length === 1) {
    // a pure rename doesn't change the graph's structure, just an id - so
    // update any saved loop's reference instead of letting pruneInvalidLoops
    // treat it as a dangling node and drop the loop
    const oldId = mergeIds[0];
    loops.forEach(loop => { loop.nodes = loop.nodes.map(nid => nid === oldId ? newName : nid); });
    mergeMsg = `Renamed "${oldId}" -> "${newName}"`;
    logChange('rename', mergeMsg);
  } else {
    mergeMsg = `Merged "${mergeIds.join('", "')}" -> "${newName}"`;
    logChange('merge', mergeMsg);
  }
  pruneInvalidLoops();
  pushUndoCheckpoint(mergeMsg);
  selectNode(newName);
  return merged;
}

// ---- add a brand-new, unconnected variable ----
// the only way to get a node onto the map that wasn't in the original
// diagram - placed at the current view's center so it's immediately
// visible, then selected so its causes/effects can be wired up right away
// via the detail panel's existing "+ Add a cause/effect" inputs.
function addNode(name, level) {
  name = name.trim();
  if (!name) return { ok: false, error: 'Give it a name.' };
  if (byId.has(name)) return { ok: false, error: `"${name}" already exists.` };

  const rect = stage.getBoundingClientRect();
  const center = clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);

  const n = {
    id: name, x: center.x, y: center.y, r: 9, level,
    in: [], out: [], vx: 0, vy: 0, x0: center.x, y0: center.y, pinned: false,
  };
  byId.set(name, n);
  liveNodes.push(n);
  neighborIds.set(name, []);
  createNodeEl(n);

  updateStats();
  logChange('add-node', `Added new variable "${name}"`);
  pushUndoCheckpoint(`Added new variable "${name}"`);
  return { ok: true, node: n };
}

function showAddNodeStatus(text, isError) {
  const el = document.getElementById('add-node-status');
  el.textContent = text;
  el.classList.toggle('is-error', !!isError);
  el.style.display = text ? '' : 'none';
}

function setAddNodeMode(on) {
  if (on) {
    if (mergeMode) setMergeMode(false); // every picking/creating mode is mutually exclusive (free-arrange isn't one - it stays as-is)
    if (loopMode) setLoopMode(false);
  }
  addNodeMode = on;
  document.getElementById('add-node-toggle').dataset.active = on ? '1' : '0';
  document.getElementById('add-node-panel').style.display = on ? '' : 'none';
  document.getElementById('add-node-name').value = '';
  showAddNodeStatus('', false);
  if (on) {
    clearSelection();
    document.getElementById('add-node-name').focus();
  }
}

document.getElementById('add-node-toggle').addEventListener('click', () => setAddNodeMode(!addNodeMode));
document.getElementById('add-node-cancel').addEventListener('click', () => setAddNodeMode(false));
document.getElementById('add-node-confirm').addEventListener('click', () => {
  const result = addNode(document.getElementById('add-node-name').value, addNodeLevel);
  if (result.ok) {
    setAddNodeMode(false);
    selectNode(result.node.id);
  } else {
    showAddNodeStatus(result.error, true);
  }
});
document.getElementById('add-node-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('add-node-confirm').click();
});

function setMergeMode(on) {
  if (on && loopMode) setLoopMode(false); // the picking modes are mutually exclusive
  if (on && addNodeMode) setAddNodeMode(false);
  mergeMode = on;
  document.getElementById('merge-toggle').dataset.active = on ? '1' : '0';
  document.getElementById('merge-panel').style.display = on ? '' : 'none';
  mergePicked.forEach(id => { const el = nodeEls.get(id); if (el) el.classList.remove('picked'); });
  mergePicked = [];
  const nameInput = document.getElementById('merge-name');
  nameInput.value = '';
  delete nameInput.dataset.userEdited;
  renderMergePanel();
  if (on) clearSelection();
}

function toggleMergePick(id) {
  const idx = mergePicked.indexOf(id);
  if (idx >= 0) {
    mergePicked.splice(idx, 1);
    nodeEls.get(id).classList.remove('picked');
  } else {
    const wasEmpty = mergePicked.length === 0;
    mergePicked.push(id);
    nodeEls.get(id).classList.add('picked');
    if (wasEmpty) {
      const nameInput = document.getElementById('merge-name');
      if (!nameInput.dataset.userEdited) nameInput.value = id;
      setMergeLevelPicker(byId.get(id).level);
    }
  }
  renderMergePanel();
}

function renderMergePanel() {
  document.getElementById('merge-count').textContent = mergePicked.length;
  const list = document.getElementById('merge-picked-list');
  list.innerHTML = '';
  mergePicked.forEach(id => {
    const row = document.createElement('div');
    row.className = 'picked-row';
    const span = document.createElement('span');
    span.textContent = id;
    const btn = document.createElement('button');
    btn.innerHTML = X_ICON_SVG;
    btn.title = 'Remove from merge';
    btn.addEventListener('click', () => toggleMergePick(id));
    row.appendChild(span);
    row.appendChild(btn);
    list.appendChild(row);
  });
  document.getElementById('merge-confirm').disabled = mergePicked.length === 0;
}

function setMergeLevelPicker(level) {
  mergeLevel = level;
  mergeLevelGrid.querySelectorAll('.merge-level-toggle').forEach(b => {
    b.dataset.active = (Number(b.dataset.level) === level) ? '1' : '0';
  });
}

// ---- reassign a node's level from the detail panel ----
function changeNodeLevel(id, newLevel) {
  const n = byId.get(id);
  if (!n || n.level === newLevel) return;
  const oldLabel = levelByNum.get(n.level).label;
  const newLabel = levelByNum.get(newLevel).label;
  n.level = newLevel;

  const el = nodeEls.get(id);
  paintNode(id, levelByNum.get(newLevel).color);
  el.dataset.level = newLevel;
  const label = labelEls.get(id);
  if (label) label.dataset.level = newLevel;

  logChange('subsystem', `Changed subsystem of "${id}": ${oldLabel} -> ${newLabel}`);
  pushUndoCheckpoint(`Changed subsystem of "${id}": ${oldLabel} -> ${newLabel}`);
  refreshLevelVisibility(); // the level filter may now hide/show it differently
  selectNode(id); // refresh the picker's active state
}

document.getElementById('merge-toggle').addEventListener('click', () => setMergeMode(!mergeMode));
document.getElementById('merge-cancel').addEventListener('click', () => setMergeMode(false));
document.getElementById('merge-confirm').addEventListener('click', () => {
  if (mergePicked.length === 0) return;
  const newName = document.getElementById('merge-name').value;
  const result = mergeNodes(mergePicked.slice(), newName, mergeLevel);
  if (result) {
    setMergeMode(false);
  } else {
    document.getElementById('merge-name').focus();
  }
});

// ---- feedback-loop annotation ----
function setLoopMode(on) {
  if (on && mergeMode) setMergeMode(false); // the picking modes are mutually exclusive
  if (on && addNodeMode) setAddNodeMode(false);
  loopMode = on;
  document.getElementById('loop-toggle').dataset.active = on ? '1' : '0';
  document.getElementById('loop-panel').style.display = on ? '' : 'none';
  loopPicked.forEach(id => { const el = nodeEls.get(id); if (el) el.classList.remove('picked'); });
  loopPicked = [];
  document.getElementById('loop-name').value = '';
  setLoopTypePicker('R');
  showLoopStatus('', false);
  renderLoopPanel();
  if (on) clearSelection();
}

function toggleLoopPick(id) {
  const idx = loopPicked.indexOf(id);
  if (idx >= 0) {
    loopPicked.splice(idx, 1);
    nodeEls.get(id).classList.remove('picked');
  } else {
    loopPicked.push(id);
    nodeEls.get(id).classList.add('picked');
  }
  showLoopStatus('', false);
  renderLoopPanel();
}

// picked nodes are listed in click order (order matters for a loop, unlike
// a merge) - misclicks are fixed by removing just that row, no need to
// start over
function renderLoopPanel() {
  document.getElementById('loop-count').textContent = loopPicked.length;
  const list = document.getElementById('loop-picked-list');
  list.innerHTML = '';
  loopPicked.forEach((id, i) => {
    const row = document.createElement('div');
    row.className = 'picked-row';
    const span = document.createElement('span');
    span.textContent = `${i + 1}. ${id}`;
    const btn = document.createElement('button');
    btn.innerHTML = X_ICON_SVG;
    btn.title = 'Remove from loop';
    btn.addEventListener('click', () => toggleLoopPick(id));
    row.appendChild(span);
    row.appendChild(btn);
    list.appendChild(row);
  });
  document.getElementById('loop-confirm').disabled = loopPicked.length < 2;
}

const loopTypeGrid = document.getElementById('loop-type-grid');
[{ key: 'R', label: 'Reinforcing (R)' }, { key: 'B', label: 'Balancing (B)' }].forEach(t => {
  const btn = document.createElement('button');
  btn.className = 'loop-type-toggle';
  btn.dataset.type = t.key;
  btn.dataset.active = t.key === loopType ? '1' : '0';
  btn.textContent = t.label;
  btn.addEventListener('click', () => setLoopTypePicker(t.key));
  loopTypeGrid.appendChild(btn);
});

function setLoopTypePicker(type) {
  loopType = type;
  loopTypeGrid.querySelectorAll('.loop-type-toggle').forEach(b => {
    b.dataset.active = (b.dataset.type === type) ? '1' : '0';
  });
}

function showLoopStatus(text, isError) {
  const el = document.getElementById('loop-status');
  el.textContent = text;
  el.classList.toggle('is-error', !!isError);
  el.style.display = text ? '' : 'none';
}

// a cycle only counts if every consecutive pair - including the wrap-around
// from the last picked node back to the first - is a real causal link
// already in the diagram, in that direction. edgeList defaults to the live
// graph's edges, but importGraph() also runs this against a freshly-parsed
// uploaded file's edges before those are ever wired into the live graph.
function validateLoopCycle(nodeIds, edgeList) {
  edgeList = edgeList || edgeEls;
  for (let i = 0; i < nodeIds.length; i++) {
    const a = nodeIds[i], b = nodeIds[(i + 1) % nodeIds.length];
    if (!edgeList.some(e => e.s === a && e.t === b)) return { ok: false, from: a, to: b };
  }
  return { ok: true };
}

function saveLoop(nodeIds, name, type) {
  name = name.trim();
  if (!name) return null;
  const check = validateLoopCycle(nodeIds);
  if (!check.ok) {
    showLoopStatus(`No direct link from "${check.from}" to "${check.to}" - pick a different order or add that link first.`, true);
    return null;
  }
  const loop = {
    id: 'loop-' + (++loopIdSeq),
    name,
    type,
    nodes: nodeIds.slice(),
    color: LOOP_COLORS[loopColorSeq % LOOP_COLORS.length],
  };
  loopColorSeq++;
  loops.push(loop);
  renderLoopList();
  const loopAddMsg = `Saved feedback loop "${name}" (${type}): ${nodeIds.join(' -> ')} -> ${nodeIds[0]}`;
  logChange('loop-add', loopAddMsg);
  pushUndoCheckpoint(loopAddMsg);
  return loop;
}

function deleteLoop(id) {
  const loop = loops.find(l => l.id === id);
  if (!loop) return;
  loops = loops.filter(l => l.id !== id);
  logChange('loop-remove', `Deleted feedback loop "${loop.name}"`);
  pushUndoCheckpoint(`Deleted feedback loop "${loop.name}"`);
  if (highlightedLoopIds.delete(id)) applySelectedLoopsTint();
  renderLoopList();
}

// re-validates every saved loop after an edit that can remove edges/nodes
// (delete, manual edge-remove, merge) and drops any loop whose cycle no
// longer exists, instead of letting it silently point at stale links
function pruneInvalidLoops() {
  const survivors = [];
  let highlightChanged = false;
  loops.forEach(loop => {
    const stillHasNodes = loop.nodes.every(id => byId.has(id));
    const check = stillHasNodes ? validateLoopCycle(loop.nodes) : { ok: false };
    if (check.ok) {
      survivors.push(loop);
    } else {
      logChange('loop-remove', `Feedback loop "${loop.name}" removed - a link it depended on no longer exists`);
      if (highlightedLoopIds.delete(loop.id)) highlightChanged = true;
    }
  });
  loops = survivors;
  if (highlightChanged) applySelectedLoopsTint();
  renderLoopList();
}

// ---- undo: a stack of full-state snapshots, one per completed edit. Given
// how many different kinds of edits this app supports (delete/merge/
// rename/add node, add/remove a link, polarity, loop save/delete, level
// change, clear-all, restore, import), snapshot-and-restore is far simpler
// and more robust than writing a bespoke inverse for each - the same "just
// recompute everything" philosophy the rest of this file already leans on.
// Dragging a node or edge, bending an edge, and pinning are deliberately
// NOT snapshotted - those are layout, not content, matching how they were
// never written to the change log either. Repeatable: each click steps
// back one more edit, not just a single undo level. A cascading cleanup
// like pruneInvalidLoops() never pushes its own checkpoint - only the
// outer action that triggered it does, once, after the cascade settles -
// so one user action is always exactly one undo step, however many loops
// it happens to break along the way. ----
function captureSnapshot() {
  return {
    nodes: liveNodes.map(n => ({ id: n.id, level: n.level, x: n.x, y: n.y, pinned: !!n.pinned })),
    edges: edgeEls.map(e => ({ s: e.s, t: e.t, polarity: e.polarity, bend: e.bend })),
    loops: loops.map(l => ({ name: l.name, type: l.type, nodes: l.nodes.slice(), color: l.color })),
    levels: levels.map(l => ({ ...l })),
  };
}

function pushUndoCheckpoint(text) {
  undoStack.push({ snapshot: captureSnapshot(), text });
  updateUndoButton();
}

function restoreSnapshot(snap) {
  // buildGraph() never derives in/out/r itself - every other caller (the
  // initial page-load payload, importGraph()) hands them over already
  // computed, so do the same here rather than leaving them to fill in via
  // a transient invalid state (addEdge()'s own in/out pushes no-op once
  // these are pre-populated, since it already guards with .includes()).
  const parents = new Map(snap.nodes.map(n => [n.id, []]));
  const children = new Map(snap.nodes.map(n => [n.id, []]));
  snap.edges.forEach(e => {
    if (children.has(e.s)) children.get(e.s).push(e.t);
    if (parents.has(e.t)) parents.get(e.t).push(e.s);
  });
  const nodes = snap.nodes.map(n => {
    const node = { id: n.id, level: n.level, x: n.x, y: n.y, in: parents.get(n.id) || [], out: children.get(n.id) || [] };
    node.r = computeRadius(node);
    return node;
  });

  buildGraph({
    nodes,
    edges: snap.edges.map(e => ({ s: e.s, t: e.t, polarity: e.polarity, bend: e.bend })),
    levels: snap.levels,
  });
  snap.nodes.forEach(n => { if (n.pinned) setPinned(n.id, true); });
  // each loop's own color travels with the snapshot (captureSnapshot saves
  // it) rather than being reassigned from the running loopColorSeq counter
  // here - a loop's color should stay exactly what it was before the
  // action being undone, not just "some distinct color"
  loops = snap.loops.map(l => ({
    id: 'loop-' + (++loopIdSeq),
    name: l.name, type: l.type, nodes: l.nodes.slice(), color: l.color,
  }));
  renderLoopList();
}

function undo() {
  if (undoStack.length < 2) return;
  const entry = undoStack.pop();
  restoreSnapshot(undoStack[undoStack.length - 1].snapshot);
  logChange('undo', entry.text ? `Undid: ${entry.text}` : 'Undid the last action');
  updateUndoButton();
}

function updateUndoButton() {
  const btn = document.getElementById('undo-btn');
  if (!btn) return;
  const top = undoStack[undoStack.length - 1];
  const canUndo = undoStack.length >= 2 && !!(top && top.text);
  btn.disabled = !canUndo;
  btn.title = canUndo ? `Undo: ${top.text}` : 'Nothing to undo yet';
}

document.getElementById('undo-btn').addEventListener('click', undo);
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
  // don't hijack native undo while the user is typing in a text field
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  undo();
});

function renderLoopList() {
  if (showAllLoops) applyAllLoopsTint(); // loops just changed (add/delete/prune) - keep the overlay in sync
  const list = document.getElementById('loop-list');
  list.innerHTML = '';
  if (loops.length === 0) {
    const li = document.createElement('li');
    li.className = 'loop-empty';
    li.textContent = 'No feedback loops saved yet.';
    list.appendChild(li);
    return;
  }
  loops.forEach(loop => {
    const li = document.createElement('li');
    li.className = 'loop-row' + (highlightedLoopIds.has(loop.id) ? ' is-active' : '');
    li.dataset.loopId = loop.id;
    li.style.setProperty('--loop-color', loop.color);
    li.addEventListener('click', () => toggleLoopHighlight(loop.id));

    const swatch = document.createElement('span');
    swatch.className = 'swatch';

    const main = document.createElement('div');
    main.className = 'loop-row-main';
    const name = document.createElement('div');
    name.className = 'loop-row-name';
    name.textContent = loop.name;
    const meta = document.createElement('div');
    meta.className = 'loop-row-meta';
    meta.textContent = `${loop.nodes.length} node(s)`;
    main.appendChild(name);
    main.appendChild(meta);

    const badge = document.createElement('span');
    badge.className = 'loop-type-badge';
    badge.textContent = loop.type;

    const loopNodes = loop.nodes.filter(id => byId.has(id));
    const allPinned = loopNodes.length > 0 && loopNodes.every(id => byId.get(id).pinned);
    const pin = document.createElement('button');
    pin.className = 'loop-row-pin';
    pin.dataset.active = allPinned ? '1' : '0';
    pin.innerHTML = PIN_ICON_SVG;
    pin.title = allPinned ? 'Unpin this loop\'s nodes' : 'Pin this loop\'s nodes in place, free of the layout springs';
    pin.addEventListener('click', (ev) => {
      ev.stopPropagation();
      loopNodes.forEach(id => setPinned(id, !allPinned));
    });

    const png = document.createElement('button');
    png.className = 'loop-row-png';
    png.innerHTML = PNG_ICON_SVG;
    png.title = 'Export this loop as a PNG image (exports every currently highlighted loop together if more than one is highlighted)';
    png.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // when this loop is part of a multi-loop highlight, export all of
      // them together rather than just this row's own loop - same button,
      // context-aware, so no separate "export highlighted loops" control
      // is needed
      const exportLoops = (highlightedLoopIds.size > 1 && highlightedLoopIds.has(loop.id))
        ? loops.filter(l => highlightedLoopIds.has(l.id))
        : [loop];
      const nodeIds = Array.from(new Set(exportLoops.flatMap(l => l.nodes))).filter(id => byId.has(id));
      const tintOverrides = exportLoops.length > 1
        ? new Map(edgeVisuals.map(e => [e, loopColorsForEdge(e, exportLoops)]).filter(([, c]) => c.length))
        : null;
      const filename = exportLoops.length > 1
        ? `cld-loops-${exportLoops.map(l => slugForFilename(l.name)).join('-')}.png`
        : `cld-loop-${slugForFilename(loop.name)}.png`;
      openPngExport(() => buildExportSvg({
        nodeIds,
        edgeFilter: (entry) => exportLoops.some(l => edgeInLoop(l, entry)),
        tintColor: exportLoops.length === 1 ? loop.color : undefined,
        tintOverrides,
      }), filename);
    });

    const rm = document.createElement('button');
    rm.className = 'loop-row-remove';
    rm.innerHTML = X_ICON_SVG;
    rm.title = 'Delete this loop';
    rm.addEventListener('click', (ev) => { ev.stopPropagation(); deleteLoop(loop.id); });

    li.appendChild(swatch);
    li.appendChild(main);
    li.appendChild(badge);
    li.appendChild(pin);
    li.appendChild(png);
    li.appendChild(rm);
    list.appendChild(li);
  });
}
renderLoopList();

document.getElementById('loop-toggle').addEventListener('click', () => setLoopMode(!loopMode));
document.getElementById('loop-cancel').addEventListener('click', () => setLoopMode(false));
document.getElementById('loop-confirm').addEventListener('click', () => {
  if (loopPicked.length < 2) return;
  const name = document.getElementById('loop-name').value;
  const loop = saveLoop(loopPicked.slice(), name, loopType);
  if (loop) {
    setLoopMode(false);
    toggleLoopHighlight(loop.id);
  } else {
    document.getElementById('loop-name').focus();
  }
});

// ---- levels: legend, filter, and full CRUD editing ----
// Levels are a free-form grouping/color axis, not a fixed taxonomy - add,
// rename, recolor, or delete them from the sidebar legend at any time.
// `renderAllLevelGrids()` is the one place that repaints every picker that
// lists levels (the legend itself, plus the add-node/merge/detail single-
// select pickers) so they can never drift out of sync with `levels`.

// validates an untrusted "levels" array (an uploaded file, or a re-render
// of DATA.levels) into the {level,key,label,color} shape used everywhere
// else - mirrors _sanitize_levels() in render.py so a JSON export renders
// identically whether it's loaded via the CLI or re-uploaded in the browser
function sanitizeLevels(rawLevels) {
  if (!Array.isArray(rawLevels)) return null;
  const seen = new Set();
  const out = [];
  rawLevels.forEach(rl => {
    if (!rl || typeof rl !== 'object') return;
    const num = Number(rl.level);
    if (!Number.isInteger(num) || seen.has(num)) return;
    const label = typeof rl.label === 'string' && rl.label.trim() ? rl.label.trim() : `Subsystem ${num}`;
    const color = typeof rl.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(rl.color) ? rl.color : '#6da7ec';
    const key = typeof rl.key === 'string' && rl.key.trim()
      ? rl.key.trim()
      : (label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `subsystem-${num}`);
    seen.add(num);
    out.push({ level: num, key, label, color });
  });
  if (!out.length) return null;
  return out.sort((a, b) => a.level - b.level);
}

// small helper: a swatch + label pair, shared by every level picker so a
// color/label edit only has to update `levels` and re-render, never touch
// four different innerHTML templates
function buildSwatchLabel(l) {
  const frag = document.createDocumentFragment();
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = l.color;
  swatch.dataset.swatchLevel = l.level;
  const label = document.createElement('span');
  label.textContent = l.label;
  frag.appendChild(swatch);
  frag.appendChild(label);
  return frag;
}

function renderAddNodeLevelGrid() {
  addNodeLevelGrid.innerHTML = '';
  levels.forEach(l => {
    const btn = document.createElement('button');
    btn.className = 'merge-level-toggle';
    btn.dataset.level = l.level;
    btn.dataset.active = l.level === addNodeLevel ? '1' : '0';
    btn.appendChild(buildSwatchLabel(l));
    btn.addEventListener('click', () => {
      addNodeLevel = l.level;
      addNodeLevelGrid.querySelectorAll('.merge-level-toggle').forEach(b => {
        b.dataset.active = (Number(b.dataset.level) === addNodeLevel) ? '1' : '0';
      });
    });
    addNodeLevelGrid.appendChild(btn);
  });
}

function renderMergeLevelGrid() {
  mergeLevelGrid.innerHTML = '';
  levels.forEach(l => {
    const btn = document.createElement('button');
    btn.className = 'merge-level-toggle';
    btn.dataset.level = l.level;
    btn.dataset.active = '0';
    btn.appendChild(buildSwatchLabel(l));
    btn.addEventListener('click', () => setMergeLevelPicker(l.level));
    mergeLevelGrid.appendChild(btn);
  });
}

function renderDetailLevelGrid() {
  detailLevelGrid.innerHTML = '';
  const n = selected ? byId.get(selected) : null;
  levels.forEach(l => {
    const btn = document.createElement('button');
    btn.className = 'detail-level-toggle';
    btn.dataset.level = l.level;
    btn.dataset.active = (n && n.level === l.level) ? '1' : '0';
    btn.appendChild(buildSwatchLabel(l));
    btn.addEventListener('click', () => {
      if (selected) changeNodeLevel(selected, l.level);
    });
    detailLevelGrid.appendChild(btn);
  });
}

// repaints every node currently on level `l`, plus that level's swatch in
// every other picker - called on every color-input tick (a live drag), so
// it deliberately does NOT touch the legend's own <input type=color> (that
// would blur/reset the native picker mid-drag) or re-render any grid
function applyLevelColorChange(l) {
  nodeEls.forEach((el, id) => { if (byId.get(id).level === l.level) paintNode(id, l.color); });
  document.querySelectorAll(`.swatch[data-swatch-level="${l.level}"]`).forEach(s => { s.style.background = l.color; });
}

function startLevelRename(l, labelEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'level-label-input mini-input';
  input.value = l.label;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('click', (ev) => ev.stopPropagation());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') input.blur();
    if (ev.key === 'Escape') { input.value = l.label; input.blur(); }
  });
  input.addEventListener('blur', () => {
    const newLabel = input.value.trim() || l.label;
    const oldLabel = l.label;
    if (newLabel !== oldLabel) {
      l.label = newLabel;
      logChange('subsystem-edit', `Renamed subsystem "${oldLabel}" -> "${newLabel}"`);
      pushUndoCheckpoint(`Renamed subsystem "${oldLabel}" -> "${newLabel}"`);
    }
    renderAllLevelGrids();
  });
}

function addLevel() {
  const palette = ['#3987e5', '#2f9e6b', '#c98a2c', '#b24f4f', '#7d5bb5', '#1f9aa3', '#c2588a', '#6b7d3d'];
  levelIdSeq += 1;
  const l = { level: levelIdSeq, key: `subsystem-${levelIdSeq}`, label: `Subsystem ${levelIdSeq}`, color: palette[levels.length % palette.length] };
  levels.push(l);
  activeLevel[l.level] = true;
  rebuildLevelByNum();
  logChange('subsystem-edit', `Added subsystem "${l.label}"`);
  pushUndoCheckpoint(`Added subsystem "${l.label}"`);
  renderAllLevelGrids();
}

function deleteLevel(levelNum) {
  if (levels.length <= 1) { alert("Can't delete the last remaining subsystem - every variable needs one."); return; }
  const l = levelByNum.get(levelNum);
  if (!l) return;
  const fallback = levels.find(x => x.level !== levelNum);
  if (!confirm(`Delete subsystem "${l.label}"? Any variable on it moves to "${fallback.label}".`)) return;

  let moved = 0;
  liveNodes.forEach(n => {
    if (n.level !== levelNum) return;
    n.level = fallback.level;
    moved++;
    const el = nodeEls.get(n.id);
    if (el) { paintNode(n.id, fallback.color); el.dataset.level = fallback.level; }
    const label = labelEls.get(n.id);
    if (label) label.dataset.level = fallback.level;
  });

  levels = levels.filter(x => x.level !== levelNum);
  delete activeLevel[levelNum];
  rebuildLevelByNum();
  if (addNodeLevel === levelNum) addNodeLevel = fallback.level;
  if (mergeLevel === levelNum) mergeLevel = fallback.level;
  refreshLevelVisibility();

  let msg = `Deleted subsystem "${l.label}"`;
  if (moved) msg += ` - ${moved} variable(s) moved to "${fallback.label}"`;
  logChange('subsystem-edit', msg);
  pushUndoCheckpoint(msg);
  renderAllLevelGrids();
}

function renderLevelLegend() {
  levelGrid.innerHTML = '';
  levels.forEach(l => {
    const row = document.createElement('div');
    row.className = 'level-toggle';
    row.dataset.active = activeLevel[l.level] ? '1' : '0';

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'swatch level-color-input';
    swatch.value = l.color;
    swatch.title = "Change this subsystem's color";
    swatch.addEventListener('click', (ev) => ev.stopPropagation());
    swatch.addEventListener('input', () => { l.color = swatch.value; applyLevelColorChange(l); });
    swatch.addEventListener('change', () => {
      logChange('subsystem-edit', `Recolored subsystem "${l.label}"`);
      pushUndoCheckpoint(`Recolored subsystem "${l.label}"`);
    });

    const label = document.createElement('span');
    label.className = 'level-label';
    label.textContent = l.label;
    label.title = 'Click to rename this subsystem';
    label.addEventListener('click', (ev) => { ev.stopPropagation(); startLevelRename(l, label); });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'level-delete-btn';
    delBtn.innerHTML = X_ICON_SVG;
    delBtn.title = 'Delete this subsystem';
    delBtn.addEventListener('click', (ev) => { ev.stopPropagation(); deleteLevel(l.level); });

    row.appendChild(swatch);
    row.appendChild(label);
    row.appendChild(delBtn);
    row.addEventListener('click', () => {
      activeLevel[l.level] = !activeLevel[l.level];
      row.dataset.active = activeLevel[l.level] ? '1' : '0';
      refreshLevelVisibility();
    });
    levelGrid.appendChild(row);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'level-add-btn';
  addBtn.textContent = '+ Add a subsystem';
  addBtn.addEventListener('click', addLevel);
  levelGrid.appendChild(addBtn);
}

function renderAllLevelGrids() {
  renderLevelLegend();
  renderAddNodeLevelGrid();
  renderMergeLevelGrid();
  renderDetailLevelGrid();
}

function refreshLevelVisibility() {
  nodeEls.forEach((el, id) => {
    el.style.display = activeLevel[byId.get(id).level] ? '' : 'none';
  });
  labelLayer.querySelectorAll('.node-label').forEach(t => {
    t.style.display = activeLevel[byId.get(t.dataset.id).level] ? '' : 'none';
  });
  edgeVisuals.forEach(({ el, s, t, fwdLabelEl, revLabelEl }) => {
    const visible = activeLevel[byId.get(s).level] && activeLevel[byId.get(t).level];
    el.style.display = visible ? '' : 'none';
    if (fwdLabelEl) fwdLabelEl.style.display = visible ? '' : 'none';
    if (revLabelEl) revLabelEl.style.display = visible ? '' : 'none';
  });
}

// ---- pan / zoom ----
let tx = 0, ty = 0, scale = 1;
const MIN_SCALE = 0.35, MAX_SCALE = 4.5;

function applyTransform() {
  viewport.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
}

function fitToStage() {
  const rect = stage.getBoundingClientRect();
  const s = Math.min(rect.width / DATA.canvas.w, rect.height / DATA.canvas.h) * 0.96;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
  tx = (rect.width - DATA.canvas.w * scale) / 2;
  ty = (rect.height - DATA.canvas.h * scale) / 2;
  applyTransform();
}

let dragging = false, dragStart = null;
stage.addEventListener('pointerdown', (e) => {
  dragging = true;
  stage.classList.add('grabbing');
  dragStart = { x: e.clientX - tx, y: e.clientY - ty };
});
window.addEventListener('pointerup', () => { dragging = false; stage.classList.remove('grabbing'); });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  tx = e.clientX - dragStart.x;
  ty = e.clientY - dragStart.y;
  applyTransform();
});
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = stage.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const worldX = (mx - tx) / scale, worldY = (my - ty) / scale;
  const factor = Math.exp(-e.deltaY * 0.0016);
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
  tx = mx - worldX * scale;
  ty = my - worldY * scale;
  applyTransform();
}, { passive: false });

document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.25));
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(0.8));
document.getElementById('zoom-reset').addEventListener('click', fitToStage);
function zoomBy(f) {
  const rect = stage.getBoundingClientRect();
  const mx = rect.width / 2, my = rect.height / 2;
  const worldX = (mx - tx) / scale, worldY = (my - ty) / scale;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * f));
  tx = mx - worldX * scale;
  ty = my - worldY * scale;
  applyTransform();
}

window.addEventListener('resize', fitToStage);
fitToStage();

// ---- drag nodes, with a light force simulation so neighbors follow and
// strangers get pushed out of the way (repulsion + edge springs), the way
// force-directed graph tools (D3-force and friends) normally behave. No
// anchor pulling nodes back to their original spot - deceleration alone
// settles it, so you can drag a whole cluster out and it stays put. ----
const REPEL_DIST = 210;   // nodes closer than this actively push apart
const REPEL_K = 2600;
const SPRING_LEN = 145;   // edges relax toward this length
const SPRING_K = 0.02;
const DAMPING = 0.80;
const MAX_STEP = 30;      // per-frame speed cap, keeps it from ever exploding
const REST_SPEED = 0.05;  // below this, a node counts as stopped
const MAX_SETTLE_FRAMES = 400; // safety cap so it can't idle forever

let dragNode = null;
let dragEdge = null;
const MAX_BEND = 220; // px - keeps a dragged edge from bowing into an absurd loop
let simRunning = false;
let settleFrames = 0;

function clientToWorld(clientX, clientY) {
  const rect = stage.getBoundingClientRect();
  return {
    x: (clientX - rect.left - tx) / scale,
    y: (clientY - rect.top - ty) / scale,
  };
}

function applyPositions() {
  liveNodes.forEach(positionNodeEls);
  redrawEdgeGeometry();
}

function simTick() {
  const draggedId = dragNode ? dragNode.id : null;
  liveNodes.forEach(a => {
    if (a.id === draggedId) return; // pinned to the pointer directly, not physics
    // free-arrange mode suspends the simulation entirely - only the node
    // you're actually holding moves, nothing else follows or gets pushed
    // aside. An individually pinned node stays fixed the same way even
    // outside free-arrange mode.
    if (freeMode || a.pinned) return;

    let fx = 0, fy = 0;
    liveNodes.forEach(b => {
      if (a === b) return;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 0.01;
      if (d < REPEL_DIST) {
        const f = REPEL_K / (d * d);
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }
    });

    neighborIds.get(a.id).forEach(nbId => {
      const b = byId.get(nbId);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d - SPRING_LEN) * SPRING_K;
      fx += (dx / d) * f;
      fy += (dy / d) * f;
    });

    a.vx = (a.vx + fx) * DAMPING;
    a.vy = (a.vy + fy) * DAMPING;
    const speed = Math.hypot(a.vx, a.vy);
    if (speed > MAX_STEP) {
      a.vx = (a.vx / speed) * MAX_STEP;
      a.vy = (a.vy / speed) * MAX_STEP;
    }
    a.x += a.vx;
    a.y += a.vy;
  });

  applyPositions();

  if (dragNode) {
    requestAnimationFrame(simTick);
    return;
  }

  settleFrames++;
  const stillMoving = liveNodes.some(n => Math.hypot(n.vx, n.vy) > REST_SPEED);
  if (stillMoving && settleFrames < MAX_SETTLE_FRAMES) {
    requestAnimationFrame(simTick);
  } else {
    simRunning = false;
  }
}

function startSim() {
  if (!simRunning) {
    simRunning = true;
    requestAnimationFrame(simTick);
  }
}

function startNodeDrag(ev, n) {
  ev.stopPropagation();
  if (ev.button !== undefined && ev.button !== 0) return;
  if (dragEdge) return; // an edge drag already owns this pointer gesture
  const el = nodeEls.get(n.id);
  el.setPointerCapture(ev.pointerId);
  el.classList.add('dragging');
  const w = clientToWorld(ev.clientX, ev.clientY);
  // remember the offset between the grab point and the node's center, so
  // grabbing off-center doesn't snap the node to the cursor on the first move
  dragNode = { id: n.id, pointerId: ev.pointerId, offX: w.x - n.x, offY: w.y - n.y, moved: false };
  n.vx = 0;
  n.vy = 0;
  settleFrames = 0;
  startSim();
}

window.addEventListener('pointermove', (ev) => {
  if (!dragNode || ev.pointerId !== dragNode.pointerId) return;
  dragNode.moved = true;
  const n = byId.get(dragNode.id);
  const w = clientToWorld(ev.clientX, ev.clientY);
  n.x = w.x - dragNode.offX;
  n.y = w.y - dragNode.offY;
  if (!simRunning) applyPositions();
});

window.addEventListener('pointerup', (ev) => {
  if (!dragNode || ev.pointerId !== dragNode.pointerId) return;
  nodeEls.get(dragNode.id).classList.remove('dragging');
  suppressClick = dragNode.moved;
  // entering free-arrange mode already pins every existing node (see
  // setFreeMode()) - this only matters for a node created *during* free
  // mode (add/merge), which missed that sweep: dragging it pins it too, and
  // into the same auto-pinned set, so it's released the same way as every
  // other node once free mode is turned back off
  if (freeMode && dragNode.moved) {
    setPinned(dragNode.id, true);
    freeModeAutoPinned.add(dragNode.id);
  }
  dragNode = null;
  settleFrames = 0;
});

// ---- drag an edge to bend it - grabbing anywhere along its (wide,
// invisible .edge-hit) length and moving the pointer bows the curve toward
// it, same "grab it, it stays exactly where you leave it" feel as dragging
// a node, but with no physics involved: nothing else reacts. The bend is a
// single signed perpendicular offset from the straight line between the
// two nodes (same convention edgeGeometry()'s auto-bow already uses), so
// it stays sensible even if a node is moved afterward. Stored on the
// logical edge(s) - both directions of a bidirectional pair, kept in sync
// - so it survives a rebuild (merge/restore/import) the same way polarity
// does, not just on the transient visual entry. ----
function startEdgeDrag(ev, entry) {
  ev.stopPropagation();
  if (ev.button !== undefined && ev.button !== 0) return;
  if (dragNode) return; // a node drag already owns this pointer gesture
  entry.hitEl.setPointerCapture(ev.pointerId);
  entry.hitEl.classList.add('dragging');
  dragEdge = { entry, pointerId: ev.pointerId, moved: false };
}

window.addEventListener('pointermove', (ev) => {
  if (!dragEdge || ev.pointerId !== dragEdge.pointerId) return;
  dragEdge.moved = true;
  const { entry } = dragEdge;
  const { a, b } = entry;
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist, ny = dx / dist; // same unit normal edgeGeometry()'s auto-bow uses
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const w = clientToWorld(ev.clientX, ev.clientY);
  const bend = Math.max(-MAX_BEND, Math.min(MAX_BEND, (w.x - mx) * nx + (w.y - my) * ny));
  entry.bend = bend;
  const fwd = edgeEls.find(e => e.s === entry.s && e.t === entry.t);
  if (fwd) fwd.bend = bend;
  if (entry.bidir) {
    const rev = edgeEls.find(e => e.s === entry.t && e.t === entry.s);
    if (rev) rev.bend = bend;
  }
  redrawEdgeGeometry();
});

window.addEventListener('pointerup', (ev) => {
  if (!dragEdge || ev.pointerId !== dragEdge.pointerId) return;
  dragEdge.entry.hitEl.classList.remove('dragging');
  dragEdge = null;
});

document.getElementById('reset-layout').addEventListener('click', () => {
  liveNodes.forEach(n => {
    n.x = n.x0; n.y = n.y0; n.vx = 0; n.vy = 0;
    if (n.pinned) {
      n.pinned = false;
      const el = nodeEls.get(n.id);
      if (el) el.classList.remove('pinned');
    }
  });
  edgeEls.forEach(e => { e.bend = null; });
  edgeVisuals.forEach(entry => { entry.bend = null; });
  applyPositions();
});

// ---- free-arrange mode: pin nodes so the layout springs leave them alone,
// letting you pull a node (or a whole feedback loop's worth of them) clear
// of the tangle without it drifting back once you let go ----
function togglePin(id) {
  const n = byId.get(id);
  if (!n) return;
  setPinned(id, !n.pinned);
}

function setPinned(id, pinned) {
  const n = byId.get(id);
  if (!n || n.pinned === pinned) return;
  n.pinned = pinned;
  const el = nodeEls.get(id);
  if (el) el.classList.toggle('pinned', pinned);
  if (!pinned) startSim(); // released back into the live layout - let it settle again
  renderLoopList(); // a loop row's pin button reflects whether all its nodes are pinned
}

// independent of the merge/loop/add-node modes - those only change what a
// click does, so picking nodes for a merge never unfreezes the diagram
function setFreeMode(on) {
  freeMode = on;
  document.getElementById('free-toggle').dataset.active = on ? '1' : '0';
  stage.classList.toggle('free-arrange', on);
  if (on) {
    clearSelection();
    // freezes the whole diagram at once - every node not already pinned for
    // some other reason (e.g. a saved loop's own pin button) - so nothing
    // drifts while you rearrange things. Only the nodes pinned *by this
    // sweep* get tracked here, so turning the toggle back off releases
    // exactly those and leaves an independently-pinned node alone.
    freeModeAutoPinned.clear();
    liveNodes.forEach(n => {
      if (n.pinned) return;
      n.pinned = true;
      freeModeAutoPinned.add(n.id);
      const el = nodeEls.get(n.id);
      if (el) el.classList.add('pinned');
    });
    renderLoopList(); // a loop row's pin button reflects whether all its nodes are pinned
  } else {
    // turning the toggle back off is what actually resumes the layout
    // springs for everything this session froze - not just a label flip
    let releasedAny = false;
    freeModeAutoPinned.forEach(id => {
      const n = byId.get(id);
      if (!n || !n.pinned) return; // gone, or already released by hand (e.g. a loop's pin button) - leave as-is
      n.pinned = false;
      const el = nodeEls.get(id);
      if (el) el.classList.remove('pinned');
      releasedAny = true;
    });
    freeModeAutoPinned.clear();
    if (releasedAny) { startSim(); renderLoopList(); }
  }
}

document.getElementById('free-toggle').addEventListener('click', () => setFreeMode(!freeMode));
// physics off by default: the page opens with every node frozen where the
// layout put it - toggle free-arrange off to let the springs run
setFreeMode(true);

// ---- selection / spotlight ----
// shared dim/undim mechanic behind both single-node selection and
// feedback-loop highlighting: dim everything, then light up a subset of
// nodes/edges in a given tint. litNodeIds stay at full opacity; isEdgeLit(e)
// decides which edges get the tinted "lit" treatment; boldNodeIds get bold
// labels (selectNode bolds only the exact node clicked; a loop bolds all of
// its nodes, since there's no single "selected" one).
function applySpotlight(litNodeIds, isEdgeLit, boldNodeIds, tintColor) {
  svg.style.setProperty('--arrow-lit-color', tintColor);
  nodeEls.forEach((el, nid) => { el.style.opacity = litNodeIds.has(nid) ? '1' : '0.16'; });
  labelLayer.querySelectorAll('.node-label').forEach(t => {
    const on = litNodeIds.has(t.dataset.id);
    t.style.opacity = on ? '1' : '0.12';
    t.style.fontWeight = boldNodeIds.has(t.dataset.id) ? '700' : '400';
  });
  edgeVisuals.forEach((entry) => {
    const { el, bidir, fwdLabelEl, revLabelEl } = entry;
    const touches = isEdgeLit(entry);
    const op = touches ? '1' : '0.07';
    el.style.opacity = op;
    if (fwdLabelEl) fwdLabelEl.style.opacity = op;
    if (revLabelEl) revLabelEl.style.opacity = op;
    const marker = touches ? 'url(#arrow-lit)' : 'url(#arrow)';
    el.setAttribute('marker-end', marker);
    if (bidir) el.setAttribute('marker-start', marker); // double-headed edges light up on both ends together
    if (touches) {
      el.style.stroke = tintColor;
      el.style.strokeWidth = '1.8';
    } else {
      el.style.stroke = '';
      el.style.strokeWidth = '';
    }
  });
}

function resetSpotlightVisuals() {
  svg.style.removeProperty('--arrow-lit-color');
  nodeEls.forEach(el => { el.style.opacity = ''; });
  labelLayer.querySelectorAll('.node-label').forEach(t => { t.style.opacity = ''; t.style.fontWeight = ''; });
  edgeVisuals.forEach((entry) => {
    const { el, bidir, fwdLabelEl, revLabelEl } = entry;
    if (entry.stripeEls) { entry.stripeEls.forEach(s => s.remove()); entry.stripeEls = null; } // leftover multi-loop stripes from applySelectedLoopsTint()/applyAllLoopsTint()
    el.style.opacity = '';
    if (fwdLabelEl) fwdLabelEl.style.opacity = '';
    if (revLabelEl) revLabelEl.style.opacity = '';
    el.setAttribute('marker-end', 'url(#arrow)');
    if (bidir) el.setAttribute('marker-start', 'url(#arrow)');
    el.style.stroke = '';
    el.style.strokeWidth = '';
  });
  // "show all loops" is a persistent view mode, not a transient spotlight -
  // a plain deselect click (clearSelection/clearLoopHighlight, both of
  // which reset through here) shouldn't dismiss it, so reassert it
  if (showAllLoops) applyAllLoopsTint();
}

function clearSelection() {
  selected = null;
  resetSpotlightVisuals();
  document.getElementById('detail').classList.remove('open');
}

function selectNode(id) {
  const n = byId.get(id);
  if (!n) return;
  clearLoopHighlight(); // the spotlight mechanisms never run at once
  if (showAllLoops) setShowAllLoops(false);
  selected = id;

  const related = new Set([id, ...n.in, ...n.out]);
  applySpotlight(related, (e) => e.s === id || e.t === id, new Set([id]), 'var(--spotlight)');

  renderDetailLevelGrid();

  document.getElementById('detail-name').textContent = n.id;
  fillList('detail-in', n.in, id, 'in');
  fillList('detail-out', n.out, id, 'out');
  document.getElementById('detail').classList.add('open');
}

// clicking a loop in the right-hand list toggles it into/out of the set of
// currently-highlighted loops (checkbox-like - any number can be on at
// once), spotlighting the union of their nodes and each loop's own
// consecutive-pair links, each tinted in its own color (an edge shared by
// 2+ highlighted loops gets the same dashed multi-color stripe treatment
// as "show all loops", via paintEdgeStripes())
function toggleLoopHighlight(id) {
  const loop = loops.find(l => l.id === id);
  if (!loop) return;
  clearSelection(); // the spotlight mechanisms never run at once
  if (showAllLoops) setShowAllLoops(false);
  if (highlightedLoopIds.has(id)) highlightedLoopIds.delete(id);
  else highlightedLoopIds.add(id);
  applySelectedLoopsTint();

  document.querySelectorAll('.loop-row').forEach(r => {
    r.classList.toggle('is-active', highlightedLoopIds.has(r.dataset.loopId));
  });
}

// extracts the N from a 'var(--loop-N)' string, to pick the matching
// per-color lit arrowhead marker (#arrow-lit-N) - same regex idea as
// resolveLoopColor() below, just for a marker id instead of a resolved color
function loopColorIndex(varStr) {
  const m = /--loop-(\d+)/.exec(varStr);
  return m ? m[1] : '1';
}

function applySelectedLoopsTint() {
  if (highlightedLoopIds.size === 0) { resetSpotlightVisuals(); return; }
  const selectedLoops = loops.filter(l => highlightedLoopIds.has(l.id));
  const nodeSet = new Set();
  selectedLoops.forEach(l => l.nodes.forEach(id => nodeSet.add(id)));

  nodeEls.forEach((el, nid) => { el.style.opacity = nodeSet.has(nid) ? '1' : '0.16'; });
  labelLayer.querySelectorAll('.node-label').forEach(t => {
    const on = nodeSet.has(t.dataset.id);
    t.style.opacity = on ? '1' : '0.12';
    t.style.fontWeight = on ? '700' : '400';
  });

  edgeVisuals.forEach(entry => {
    const colors = loopColorsForEdge(entry, selectedLoops);
    paintEdgeStripes(entry, colors);
    const op = colors.length ? '1' : '0.07';
    entry.el.style.opacity = op;
    if (entry.fwdLabelEl) entry.fwdLabelEl.style.opacity = op;
    if (entry.revLabelEl) entry.revLabelEl.style.opacity = op;
    if (colors.length === 1) {
      entry.el.style.stroke = colors[0];
      entry.el.style.strokeWidth = '1.8';
      const marker = `url(#arrow-lit-${loopColorIndex(colors[0])})`;
      entry.el.setAttribute('marker-end', marker);
      if (entry.bidir) entry.el.setAttribute('marker-start', marker);
    } else {
      // 0 owners (dimmed) or 2+ owners (base stays neutral, stripes carry the color) - either way, no single tint color applies to the base path
      entry.el.style.stroke = '';
      entry.el.style.strokeWidth = '';
      entry.el.setAttribute('marker-end', 'url(#arrow)');
      if (entry.bidir) entry.el.setAttribute('marker-start', 'url(#arrow)');
    }
  });
}

function clearLoopHighlight() {
  highlightedLoopIds.clear();
  resetSpotlightVisuals();
  document.querySelectorAll('.loop-row.is-active').forEach(r => r.classList.remove('is-active'));
}

// ---- "show all loops": tints every edge that belongs to a saved loop with
// that loop's color, all at once - unlike toggleLoopHighlight(), which only
// ever dims/spotlights the loops explicitly picked in the sidebar. An edge
// shared by 2+ saved loops cycles through all of their colors as a dashed
// stripe (see STRIPE_DASH below) rather than picking one or hiding the
// overlap - which loops share a link is exactly the kind of thing this view
// exists to surface. Mutually exclusive with node selection and loop
// highlighting (both turn this off - see selectNode()/toggleLoopHighlight()
// above); merge/loop-pick/free-arrange/add-node modes are untouched by it,
// since none of them share this visual channel. ----

// true if this edge's endpoints are a consecutive pair in loop's cycle,
// checked both orderings for a collapsed bidirectional edge - same
// reasoning as applySelectedLoopsTint()'s per-edge color lookup
function edgeInLoop(loop, entry) {
  for (let i = 0; i < loop.nodes.length; i++) {
    const a = loop.nodes[i], b = loop.nodes[(i + 1) % loop.nodes.length];
    if ((entry.s === a && entry.t === b) || (entry.bidir && entry.t === a && entry.s === b)) return true;
  }
  return false;
}

// every loop in loopSubset (default: every saved loop) this edge belongs
// to, in that subset's order (possibly empty, possibly more than one - a
// shared link is common in a real CLD). Callers pass a narrower subset to
// restrict to just the loops currently highlighted/being exported.
function loopColorsForEdge(entry, loopSubset = loops) {
  return loopSubset.filter(loop => edgeInLoop(loop, entry)).map(loop => loop.color);
}

// shared by the live "show all loops"/multi-loop-highlight overlays and the
// PNG-export mirror of them: a stripe cycle's dash length in px, and the
// dasharray/dashoffset for the i-th of n colors sharing one edge, so a run
// of them interleaves into a single repeating multi-color stripe along the
// same path geometry instead of n solid lines stacked on top of each other.
const STRIPE_DASH = 7;
function stripeDashArray(n) {
  return `${STRIPE_DASH} ${STRIPE_DASH * (n - 1)}`;
}
function stripeDashOffset(i) {
  return String(i * STRIPE_DASH);
}

// paints (or clears) entry's dashed multi-color stripe overlay for a
// 2+-owner edge - shared by applyAllLoopsTint() and applySelectedLoopsTint()
// so the two overlays can't drift apart. Always clears any prior stripes
// first; rebuilds them only when colors has 2+ entries (a 0- or 1-color
// edge is tinted via its own single stroke instead, by the caller).
function paintEdgeStripes(entry, colors) {
  if (entry.stripeEls) { entry.stripeEls.forEach(el => el.remove()); entry.stripeEls = null; }
  if (colors.length < 2) return;
  // 2+ owners: leave the base path exactly as its plain default (stroke
  // untouched by the caller) so its arrowhead marker keeps painting
  // normally - SVG markers aren't guaranteed to render on an unstroked
  // path - and layer n dashed, offset stripes on top of the same geometry,
  // no markers on them, so together they cover the line in a repeating
  // color cycle.
  const d = entry.el.getAttribute('d');
  entry.stripeEls = colors.map((color, i) => {
    const stripe = document.createElementNS(svgNS, 'path');
    stripe.setAttribute('class', 'edge-path edge-stripe');
    stripe.setAttribute('d', d);
    stripe.setAttribute('fill', 'none');
    stripe.style.stroke = color;
    stripe.style.strokeWidth = '2.2';
    stripe.setAttribute('stroke-dasharray', stripeDashArray(colors.length));
    stripe.setAttribute('stroke-dashoffset', stripeDashOffset(i));
    entry.el.insertAdjacentElement('afterend', stripe);
    return stripe;
  });
}

function applyAllLoopsTint() {
  if (!showAllLoops) { resetSpotlightVisuals(); return; } // that also clears any stripe overlay left over from this or applySelectedLoopsTint()
  // full recompute every call (cheap at this graph's size), same philosophy
  // rebuildEdgeVisuals() already applies to the edge set generally
  edgeVisuals.forEach(entry => {
    const colors = loopColorsForEdge(entry);
    paintEdgeStripes(entry, colors);
    if (colors.length <= 1) {
      const tint = colors[0] || '';
      entry.el.style.stroke = tint;
      entry.el.style.strokeWidth = tint ? '1.8' : '';
    }
  });
}

function setShowAllLoops(on) {
  if (on) {
    clearSelection();     // the spotlight mechanisms never run at once
    clearLoopHighlight();
  }
  showAllLoops = on;
  document.getElementById('all-loops-toggle').dataset.active = on ? '1' : '0';
  applyAllLoopsTint();
}

document.getElementById('all-loops-toggle').addEventListener('click', () => setShowAllLoops(!showAllLoops));

function clearAll() {
  clearSelection();
  clearLoopHighlight();
}

// direction: 'in' means items are causes of otherId (item -> otherId);
// 'out' means items are effects of otherId (otherId -> item) - needed so the
// per-row remove button knows which (source, target) pair to sever
function fillList(elId, items, otherId, direction) {
  const ul = document.getElementById(elId);
  ul.innerHTML = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'detail-empty';
    li.textContent = 'none';
    ul.appendChild(li);
    return;
  }
  items.forEach(item => {
    const li = document.createElement('li');
    li.className = 'edge-row';

    const s = direction === 'in' ? item : otherId;
    const t = direction === 'in' ? otherId : item;
    const entry = edgeEls.find(e => e.s === s && e.t === t);

    const pol = document.createElement('button');
    pol.className = 'edge-polarity-btn';
    const paintPol = () => {
      const p = entry ? entry.polarity : null;
      pol.dataset.polarity = p || '';
      pol.innerHTML = p === '+' ? POLARITY_PLUS_SVG : p === '-' ? POLARITY_MINUS_SVG : POLARITY_UNSET_SVG;
      pol.title = p
        ? `Polarity: ${p === '+' ? 'same direction (+)' : 'opposite direction (-)'} - click to change`
        : 'Polarity not set - click to mark same (+) or opposite (-) direction';
    };
    paintPol();
    pol.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cyclePolarity(s, t);
      paintPol();
    });

    const btn = document.createElement('button');
    btn.className = 'edge-name-btn';
    btn.textContent = item;
    btn.addEventListener('click', () => selectNode(item));

    const rm = document.createElement('button');
    rm.className = 'edge-remove';
    rm.innerHTML = X_ICON_SVG;
    rm.title = 'Remove this link';
    rm.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (entry) {
        removeEdge(entry);
        logChange('remove-edge', `Removed link "${s}" -> "${t}"`);
        pruneInvalidLoops();
        pushUndoCheckpoint(`Removed link "${s}" -> "${t}"`);
      }
      refreshNodeVisual(s);
      refreshNodeVisual(t);
      rebuildEdgeVisuals();
      updateStats();
      selectNode(otherId);
    });

    li.appendChild(pol);
    li.appendChild(btn);
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

// re-derives a node's degree-based size after a manual add/remove-edge
// edit - kept on the data, though the drawn box is now sized by its label
function refreshNodeVisual(id) {
  const n = byId.get(id);
  if (!n) return;
  n.r = computeRadius(n);
}

function wireEdgeAdder(inputId, resultsId, direction) {
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultsId);

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = '';
    if (q.length < 1 || !selected) return;
    const matches = liveNodes
      .filter(n => n.id !== selected && n.id.toLowerCase().includes(q))
      .slice(0, 8);
    matches.forEach(n => {
      const btn = document.createElement('button');
      btn.className = 'result-item';
      btn.textContent = n.id;
      btn.addEventListener('click', () => {
        const s = direction === 'in' ? n.id : selected;
        const t = direction === 'in' ? selected : n.id;
        if (addEdge(s, t)) {
          logChange('add-edge', `Added link "${s}" -> "${t}"`);
          pushUndoCheckpoint(`Added link "${s}" -> "${t}"`);
        }
        refreshNodeVisual(s);
        refreshNodeVisual(t);
        rebuildEdgeVisuals();
        updateStats();
        input.value = '';
        results.innerHTML = '';
        selectNode(selected);
      });
      results.appendChild(btn);
    });
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { results.innerHTML = ''; }, 150);
  });
}
wireEdgeAdder('add-in-input', 'add-in-results', 'in');
wireEdgeAdder('add-out-input', 'add-out-results', 'out');

stage.addEventListener('click', () => clearAll());
document.getElementById('clear-btn').addEventListener('click', clearSelection);

// ---- rename (implemented as mergeNodes([id], newName, level) - a merge of one) ----
const nameDisplay = document.getElementById('detail-name');
const nameEditInput = document.getElementById('detail-name-input');

document.getElementById('rename-btn').addEventListener('click', () => {
  if (!selected) return;
  nameEditInput.value = selected;
  nameDisplay.style.display = 'none';
  nameEditInput.style.display = '';
  nameEditInput.focus();
  nameEditInput.select();
});

function commitRename() {
  if (nameEditInput.style.display === 'none') return; // not actively editing
  const oldName = selected;
  const newName = nameEditInput.value.trim();
  nameEditInput.style.display = 'none';
  nameDisplay.style.display = '';
  if (newName && newName !== oldName) {
    mergeNodes([oldName], newName, byId.get(oldName).level);
  }
}

nameEditInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { nameEditInput.blur(); }
  if (e.key === 'Escape') { nameEditInput.style.display = 'none'; nameDisplay.style.display = ''; nameEditInput.blur(); }
});
nameEditInput.addEventListener('blur', commitRename);

// ---- export ----
const exportModal = document.getElementById('export-modal');
const exportTextarea = document.getElementById('export-textarea');
const exportCopyBtn = document.getElementById('export-copy');

// ---- save dialog: one Save button, three formats ----
const saveModal = document.getElementById('save-modal');
document.getElementById('save-btn').addEventListener('click', () => { saveModal.style.display = 'flex'; });
function closeSaveModal() { saveModal.style.display = 'none'; }
document.getElementById('save-close').addEventListener('click', closeSaveModal);
saveModal.addEventListener('click', (e) => { if (e.target === saveModal) closeSaveModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSaveModal(); });
document.getElementById('save-json').addEventListener('click', () => {
  closeSaveModal();
  exportText(JSON.stringify(exportPayload(), null, 2), 'cld-edited.json', 'application/json', 'Edited graph JSON');
});
document.getElementById('save-html').addEventListener('click', () => {
  closeSaveModal();
  exportText(buildSavedPage(), 'cld-diagram.html', 'text/html', 'Web page (save as a .html file)');
});
document.getElementById('save-csv').addEventListener('click', () => {
  closeSaveModal();
  exportChangeLogCsv();
});
document.getElementById('save-xmile').addEventListener('click', () => {
  closeSaveModal();
  exportText(buildXmile(), 'cld-diagram.xmile', 'application/xml', 'Vensim XMILE');
});

// a copy of this page with the current diagram baked in as its DATA - the
// same shape render.py embeds, so the saved file opens exactly like one
// built with `render.py my-diagram.json out.html`
function buildSavedPage() {
  const data = {
    nodes: liveNodes.map(n => ({
      id: n.id, level: n.level,
      x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10,
      r: n.r, in: n.in.slice(), out: n.out.slice(),
    })),
    edges: edgeEls.map(e => ({ s: e.s, t: e.t, polarity: e.polarity || null, bend: e.bend != null ? Math.round(e.bend * 10) / 10 : null })),
    levels: levels.map(l => ({ level: l.level, key: l.key, label: l.label, color: l.color })),
    canvas: DATA.canvas,
    counts: { nodes: liveNodes.length, edges: edgeEls.length },
    ...(({ loops, log }) => ({ loops, log }))(exportPayload()),
    loopsDropped: 0,
  };
  // escape "<" (so a node name holding a closing script tag can't end the
  // script early)
  // and everything non-ASCII, like render.py's json.dumps
  const json = JSON.stringify(data).replace(/[<\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const marker = 'const DATA = ';
  const start = PAGE_SOURCE_AT_LOAD.indexOf(marker);
  const end = PAGE_SOURCE_AT_LOAD.indexOf('\n', start);
  return PAGE_SOURCE_AT_LOAD.slice(0, start) + marker + json + ';' + PAGE_SOURCE_AT_LOAD.slice(end);
}

// Vensim-style XMILE: one <aux> per variable, its causes as
// "A FUNCTION OF(...)" - exactly what parseXmile() below (and sd.py) reads
// back. Positions, polarity, subsystems and loops have no place in it.
function buildXmile() {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Vensim writes spaces as "_" and quotes names with other punctuation
  const vensimName = id => {
    const n = id.replace(/["\\]/g, '').replace(/\s+/g, '_');
    return /^[A-Za-z0-9_]+$/.test(n) ? n : '"' + n + '"';
  };
  const auxes = liveNodes.map(n => {
    const causes = n.in.map(vensimName).join(',');
    return `\t\t\t<aux name="${esc(vensimName(n.id))}">\n\t\t\t\t<eqn>A FUNCTION OF(${esc(causes)})</eqn>\n\t\t\t</aux>`;
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<xmile version="1.0" xmlns="${XMILE_NS}">`,
    '\t<header>',
    '\t\t<vendor>CL-DIY</vendor>',
    '\t\t<product version="1.0">CL-DIY</product>',
    '\t</header>',
    '\t<sim_specs>',
    '\t\t<start>0</start>',
    '\t\t<stop>100</stop>',
    '\t\t<dt>1</dt>',
    '\t</sim_specs>',
    '\t<model>',
    '\t\t<variables>',
    ...auxes,
    '\t\t</variables>',
    '\t</model>',
    '</xmile>',
    '',
  ].join('\n');
}

// the slim, documented JSON export format - also what render.py and the
// upload button read
function exportPayload() {
  return {
    nodes: liveNodes.map(n => ({
      id: n.id,
      level: n.level,
      x: Math.round(n.x * 10) / 10,
      y: Math.round(n.y * 10) / 10,
    })),
    edges: edgeEls.map(e => {
      const o = { source: e.s, target: e.t };
      if (e.polarity) o.polarity = e.polarity;
      if (e.bend != null) o.bend = Math.round(e.bend * 10) / 10;
      return o;
    }),
    loops: loops.map(l => ({ name: l.name, type: l.type, nodes: l.nodes })), // no color - reassigned fresh on import
    levels: levels.map(l => ({ level: l.level, key: l.key, label: l.label, color: l.color })),
    // oldest first; a plain string unless the entry has a comment
    log: changeLog.slice().reverse().map(e => e.comment ? { text: e.text, comment: e.comment } : e.text),
  };
}

// one row per change-log entry, oldest first - for a spreadsheet or a
// methods appendix. Entries replayed from an uploaded file keep their text
// and comment but show as "history", since their original type isn't saved.
// (also offered in the Save dialog)
function exportChangeLogCsv() {
  const cell = v => /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const rows = [['step', 'type', 'action', 'comment']];
  changeLog.slice().reverse().forEach((e, i) => rows.push([String(i + 1), e.type, e.text, e.comment || '']));
  const csv = rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  exportText(csv, 'cld-change-log.csv', 'text/csv', 'Change log CSV', '\uFEFF'); // BOM so Excel reads it as UTF-8
}
document.getElementById('export-log-btn').addEventListener('click', exportChangeLogCsv);

// best-effort real download of text, plus the guaranteed fallback: the same
// text, pre-selected, in a copyable box. bom (optional) is prepended to the
// downloaded file only, never the copyable text.
function exportText(text, filename, mime, heading, bom) {
  // artifact pages are sandboxed and the download can be silently blocked,
  // so it's a bonus, never the only path to the data
  try {
    const blob = new Blob([(bom || '') + text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    // ignore - the modal below is the guaranteed fallback
  }

  document.getElementById('export-heading').textContent = heading;
  exportTextarea.value = text;
  exportModal.style.display = 'flex';
  exportTextarea.focus();
  exportTextarea.select();
}

exportCopyBtn.addEventListener('click', () => {
  exportTextarea.focus();
  exportTextarea.select();
  const reset = () => { exportCopyBtn.textContent = 'Copy to clipboard'; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(exportTextarea.value).then(() => {
      exportCopyBtn.textContent = 'Copied!';
      setTimeout(reset, 1500);
    }).catch(() => {
      exportCopyBtn.textContent = 'Selected - press Cmd/Ctrl+C';
      setTimeout(reset, 2500);
    });
  } else {
    exportCopyBtn.textContent = 'Selected - press Cmd/Ctrl+C';
    setTimeout(reset, 2500);
  }
});

document.getElementById('export-close').addEventListener('click', () => {
  exportModal.style.display = 'none';
});
exportModal.addEventListener('click', (e) => {
  if (e.target === exportModal) exportModal.style.display = 'none';
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && exportModal.style.display !== 'none') {
    exportModal.style.display = 'none';
  }
});

// ---- PNG export ----
// Builds a standalone, self-contained <svg> for export: tight-cropped to
// nodeIds' bounding box (+ padding), with every included element's current
// *computed* style baked on as explicit attributes (so it renders correctly
// once fully detached from this page's CSS custom properties/theme), and
// this page's already-embedded @font-face rules inlined (pulled from
// document.styleSheets at runtime, not re-embedded from Python a second
// time) so exported text keeps its real font instead of falling back.
// Both the whole-diagram and single-loop export paths call this one
// function - nodeIds/edgeFilter narrow what's included; tintColor (single
// loop) or tintOverrides (the "show all loops" overlay) color the edges.
function buildExportSvg({ nodeIds, edgeFilter, tintColor, tintOverrides }) {
  // cloneWithBakedStyle() below bakes each node/label's *current* computed
  // opacity - if some other loop (or a selected node) is currently
  // spotlighted on the live page, a node this export includes but that
  // spotlight doesn't may be sitting at the live page's dimmed opacity
  // (e.g. 0.16) right now, which would otherwise get baked into this
  // export even though it has nothing to do with what's being exported
  // here. Clear whatever's live, build the export, then restore it exactly
  // - all synchronously, so nothing repaints in between and the user never
  // sees a flash.
  const hadLoopHighlight = highlightedLoopIds.size > 0;
  const hadAllLoopsTint = showAllLoops;
  const hadSelection = selected !== null;
  if (hadLoopHighlight || hadAllLoopsTint || hadSelection) resetSpotlightVisuals();
  try {
    return buildExportSvgInner({ nodeIds, edgeFilter, tintColor, tintOverrides });
  } finally {
    if (hadLoopHighlight) applySelectedLoopsTint();
    else if (hadAllLoopsTint) applyAllLoopsTint();
    else if (hadSelection) selectNode(selected);
  }
}

function buildExportSvgInner({ nodeIds, edgeFilter, tintColor, tintOverrides }) {
  const nodeIdSet = new Set(nodeIds);
  const PAD = 36;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodeIds.forEach(id => {
    const n = byId.get(id);
    if (!n) return;
    // the label sits inside its box, so the box alone is the full extent
    minX = Math.min(minX, n.x - n.hw);
    minY = Math.min(minY, n.y - n.hh);
    maxX = Math.max(maxX, n.x + n.hw);
    maxY = Math.max(maxY, n.y + n.hh);
  });
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; } // empty-selection guard
  const vb = { x: minX - PAD, y: minY - PAD, w: (maxX - minX) + 2 * PAD, h: (maxY - minY) + 2 * PAD };

  const out = document.createElementNS(svgNS, 'svg');
  out.setAttribute('xmlns', svgNS);
  out.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  out.setAttribute('width', Math.round(vb.w));
  out.setAttribute('height', Math.round(vb.h));

  const styleEl = document.createElementNS(svgNS, 'style');
  let fontCss = '';
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; } // a cross-origin sheet would throw; none expected in this self-contained page
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) fontCss += rule.cssText + '\n';
    }
  }
  styleEl.textContent = fontCss;
  out.appendChild(styleEl);

  const rootStyle = getComputedStyle(document.documentElement);
  const plainArrowColor = rootStyle.getPropertyValue('--edge').trim();
  const litArrowColor = tintColor ? resolveLoopColor(tintColor) : null;

  const defs = document.createElementNS(svgNS, 'defs');
  defs.appendChild(makeArrowMarker('exp-arrow', plainArrowColor));
  if (litArrowColor) defs.appendChild(makeArrowMarker('exp-arrow-lit', litArrowColor));
  out.appendChild(defs);

  const edgeLayerOut = document.createElementNS(svgNS, 'g');
  const polarityLayerOut = document.createElementNS(svgNS, 'g');
  edgeVisuals.forEach(entry => {
    if (!nodeIdSet.has(entry.s) || !nodeIdSet.has(entry.t)) return;
    if (edgeFilter && !edgeFilter(entry)) return;
    const override = tintOverrides && tintOverrides.get(entry); // undefined, or a non-empty color array
    const clone = entry.el.cloneNode(false);
    // the live edge may currently carry an inline style (from spotlight/
    // tint highlighting, e.g. style="stroke: var(--loop-3)") that cloneNode
    // copies verbatim - an inline style always wins over the presentation
    // attributes set below, and that copied var() reference resolves to
    // nothing once detached from this page, silently blanking the stroke.
    // Drop it so the attributes below are what actually renders.
    clone.removeAttribute('style');
    clone.setAttribute('fill', 'none');
    if (tintColor) {
      clone.setAttribute('stroke', litArrowColor);
      clone.setAttribute('stroke-width', '1.8');
      clone.setAttribute('marker-end', 'url(#exp-arrow-lit)');
      if (entry.bidir) clone.setAttribute('marker-start', 'url(#exp-arrow-lit)');
    } else if (override && override.length === 1) {
      clone.setAttribute('stroke', resolveLoopColor(override[0]));
      clone.setAttribute('stroke-width', '1.8');
      clone.setAttribute('marker-end', 'url(#exp-arrow)');
      if (entry.bidir) clone.setAttribute('marker-start', 'url(#exp-arrow)');
    } else {
      // plain/neutral - either untinted, or (below) the base an edge shared
      // by 2+ loops sits under its own dashed color stripes
      clone.setAttribute('stroke', plainArrowColor);
      clone.setAttribute('stroke-width', '1');
      clone.setAttribute('marker-end', 'url(#exp-arrow)');
      if (entry.bidir) clone.setAttribute('marker-start', 'url(#exp-arrow)');
    }
    edgeLayerOut.appendChild(clone);
    if (override && override.length >= 2) {
      // multi-loop edge: the plain clone above carries the arrowhead(s);
      // layer dashed, offset, colored stripes on top of the same geometry,
      // no markers on them, mirroring applyAllLoopsTint()'s live rendering
      const d = clone.getAttribute('d');
      override.forEach((color, i) => {
        const stripe = document.createElementNS(svgNS, 'path');
        stripe.setAttribute('d', d);
        stripe.setAttribute('fill', 'none');
        stripe.setAttribute('stroke', resolveLoopColor(color));
        stripe.setAttribute('stroke-width', '2.2');
        stripe.setAttribute('stroke-dasharray', stripeDashArray(override.length));
        stripe.setAttribute('stroke-dashoffset', stripeDashOffset(i));
        edgeLayerOut.appendChild(stripe);
      });
    }
    // only assigned polarities make it into an export - the neutral "unset"
    // badge is an on-canvas editing affordance, not part of the diagram -
    // and none at all when the toolbar's +/- toggle is off
    if (exportShowPolarity) {
      [entry.fwdLabelEl, entry.revLabelEl].forEach(labelEl => {
        if (labelEl && labelEl.dataset.polarity) polarityLayerOut.appendChild(cloneWithBakedStyle(labelEl));
      });
    }
  });
  out.appendChild(edgeLayerOut);

  const nodeLayerOut = document.createElementNS(svgNS, 'g');
  const labelLayerOut = document.createElementNS(svgNS, 'g');
  nodeIds.forEach(id => {
    const nEl = nodeEls.get(id), lEl = labelEls.get(id);
    if (nEl) nodeLayerOut.appendChild(cloneWithBakedStyle(nEl));
    if (lEl) labelLayerOut.appendChild(cloneWithBakedStyle(lEl));
  });
  out.appendChild(nodeLayerOut);
  out.appendChild(labelLayerOut);
  out.appendChild(polarityLayerOut);

  return out;
}

function makeArrowMarker(id, color) {
  const marker = document.createElementNS(svgNS, 'marker');
  marker.setAttribute('id', id);
  marker.setAttribute('viewBox', '0 0 8 8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '4');
  marker.setAttribute('markerWidth', '7.5');
  marker.setAttribute('markerHeight', '7.5');
  marker.setAttribute('orient', 'auto-start-reverse');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'M0,0 L8,4 L0,8 Z');
  path.setAttribute('fill', color);
  marker.appendChild(path);
  return marker;
}

// resolves a 'var(--loop-N)' string (as stored on a loop object) to its
// current concrete color, for baking into a detached export SVG that has
// no access to this page's CSS custom properties
function resolveLoopColor(varStr) {
  const m = /--loop-\d+/.exec(varStr);
  if (!m) return varStr;
  return getComputedStyle(document.documentElement).getPropertyValue(m[0]).trim();
}

// clones el (deep, so child content survives) and bakes each element's own
// current *computed* presentation onto its corresponding clone, so it
// renders correctly with zero external CSS once fully detached (used for
// nodes, labels, polarity badges). Recurses into descendants rather than
// only baking el itself - a polarity badge is a <g> wrapping a <circle>
// and a <path>, each styled by its own CSS selector (".polarity-label
// circle"/".polarity-glyph"), not by anything on the <g> itself; baking
// only the wrapper left both children with none of that styling once
// detached, which is why every polarity badge used to export as an
// unstyled black disc regardless of its sign.
function cloneWithBakedStyle(el) {
  const clone = el.cloneNode(true);
  const bake = (src, dst) => {
    const cs = getComputedStyle(src);
    ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight']
      .forEach(prop => {
        const v = cs.getPropertyValue(prop);
        if (v) dst.style.setProperty(prop, v);
      });
  };
  bake(el, clone);
  const srcDescendants = el.querySelectorAll('*');
  const cloneDescendants = clone.querySelectorAll('*');
  srcDescendants.forEach((child, i) => bake(child, cloneDescendants[i]));
  return clone;
}

const EXPORT_UPSCALE = 3; // crisp output for pasting into slides/docs

// background: 'transparent' paints nothing behind the diagram, or a CSS
// color (e.g. 'white') fills the whole canvas first
function exportSvgToPngBlob(svgEl, background) {
  return new Promise((resolve, reject) => {
    const w = Number(svgEl.getAttribute('width')), h = Number(svgEl.getAttribute('height'));
    const xml = new XMLSerializer().serializeToString(svgEl);
    const svgDataUri = 'data:image/svg+xml;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(xml)));

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * EXPORT_UPSCALE));
      canvas.height = Math.max(1, Math.round(h * EXPORT_UPSCALE));
      const ctx = canvas.getContext('2d');
      if (background && background !== 'transparent') {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/png');
    };
    img.onerror = () => reject(new Error('SVG failed to rasterize'));
    img.src = svgDataUri;
  });
}

// a real download attempt - if the page's sandbox blocks it, the export
// dialog's preview image stays open to right-click/long-press and save
function downloadPng(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    // ignore - the dialog's preview is the fallback
  }
}

// ---- PNG export dialog: every PNG button (whole diagram, per loop) opens
// this first, with a live preview, instead of downloading straight away.
// The two options persist for the rest of the session. ----
let exportShowPolarity = true;  // whether exports include the +/- badges (read by buildExportSvgInner)
let exportBackground = 'white'; // 'white' or 'transparent'
let pngExportPending = null;    // { build, filename, blob } for the dialog currently open
let pngPreviewSeq = 0;          // drops a stale preview if the options change mid-render

const pngExportModal = document.getElementById('png-export-modal');
const pngExportImg = document.getElementById('png-export-img');
const pngExportDownloadBtn = document.getElementById('png-export-download');

// build() returns the export SVG - called again whenever an option changes,
// so it must read the diagram fresh rather than reuse one SVG
function openPngExport(build, filename) {
  pngExportPending = { build, filename, blob: null };
  syncPngOptionButtons();
  pngExportModal.style.display = 'flex';
  renderPngPreview();
}

async function renderPngPreview() {
  if (!pngExportPending) return;
  const seq = ++pngPreviewSeq;
  pngExportDownloadBtn.disabled = true;
  const blob = await exportSvgToPngBlob(pngExportPending.build(), exportBackground);
  if (seq !== pngPreviewSeq || !pngExportPending) return;
  pngExportPending.blob = blob;
  // a data URL, not an object URL, so right-click "Save Image As..." works
  // even after the dialog's state moves on
  const reader = new FileReader();
  reader.onload = () => { if (seq === pngPreviewSeq) pngExportImg.src = reader.result; };
  reader.readAsDataURL(blob);
  pngExportDownloadBtn.disabled = false;
}

function syncPngOptionButtons() {
  pngExportModal.querySelectorAll('[data-png-polarity]').forEach(b => {
    b.dataset.active = (b.dataset.pngPolarity === '1') === exportShowPolarity ? '1' : '0';
  });
  pngExportModal.querySelectorAll('[data-png-bg]').forEach(b => {
    b.dataset.active = b.dataset.pngBg === exportBackground ? '1' : '0';
  });
}

pngExportModal.querySelectorAll('[data-png-polarity]').forEach(b => b.addEventListener('click', () => {
  exportShowPolarity = b.dataset.pngPolarity === '1';
  syncPngOptionButtons();
  renderPngPreview();
}));
pngExportModal.querySelectorAll('[data-png-bg]').forEach(b => b.addEventListener('click', () => {
  exportBackground = b.dataset.pngBg;
  syncPngOptionButtons();
  renderPngPreview();
}));

function closePngExport() {
  pngExportPending = null;
  pngPreviewSeq++;
  pngExportModal.style.display = 'none';
  pngExportImg.removeAttribute('src');
}

pngExportDownloadBtn.addEventListener('click', () => {
  if (!pngExportPending || !pngExportPending.blob) return;
  // the dialog stays open afterward - a sandbox-blocked download fails
  // silently, so the preview has to remain available to save by hand
  downloadPng(pngExportPending.blob, pngExportPending.filename);
});

function slugForFilename(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram';
}

document.getElementById('export-png-btn').addEventListener('click', () => {
  openPngExport(() => {
    const tintOverrides = showAllLoops ? new Map(edgeVisuals.map(e => [e, loopColorsForEdge(e)]).filter(([, c]) => c.length)) : null;
    return buildExportSvg({
      nodeIds: liveNodes.map(n => n.id),
      edgeFilter: () => true,
      tintOverrides,
    });
  }, 'cld-diagram.png');
});

document.getElementById('png-export-close').addEventListener('click', closePngExport);
pngExportModal.addEventListener('click', (e) => {
  if (e.target === pngExportModal) closePngExport();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pngExportModal.style.display !== 'none') closePngExport();
});

// ---- import ----
// Reads a previously-exported {nodes:[{id,level,x,y}], edges:[{source,target}],
// log:[...]} file back into the live graph - the only way to resume an edit
// session, since a fresh page load always starts from the pristine DATA.
const importStatus = document.getElementById('import-status');

function showImportStatus(text, isError) {
  importStatus.textContent = text;
  importStatus.classList.toggle('is-error', !!isError);
  importStatus.style.display = '';
  clearTimeout(showImportStatus._t);
  showImportStatus._t = setTimeout(() => { importStatus.style.display = 'none'; }, 4000);
}

// ---- raw .xmile upload: a client-side port of sd.py's parser, so a
// Vensim-style export can be dropped straight onto the running page
// instead of needing the CLI (which needs numpy for layout.py's layout -
// not available in a browser). No positions/levels/loops/history exist in
// this format, so nodes land at the current default level with random
// positions the live force simulation (startSim(), already used for drag
// physics) settles afterward - layout.py's own 700-iteration numpy layout
// isn't ported, this reuses the settle behavior the page already has. ----

const XMILE_NS = 'http://docs.oasis-open.org/xmile/ns/XMILE/v1.0';
const XMILE_EQN_RE = /^A FUNCTION OF\(\s*([\s\S]*?)\s*\)\s*$/;

// mirrors sd.py's normalize_name(): trim, unwrap a "quoted" name, turn
// Vensim's underscore-for-space encoding back into spaces, drop stray
// escaped/bare quotes and backslashes, collapse whitespace
function normalizeName(name) {
  name = name.trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1);
  }
  name = name.replace(/_/g, ' ');
  name = name.replace(/\\"/g, '"').replace(/"/g, '').replace(/\\/g, '');
  return name.replace(/\s+/g, ' ').trim();
}

// mirrors sd.py's _split_arg_list(): comma-splits an "A FUNCTION OF(...)"
// argument list, respecting "quoted, names" that may contain their own
// commas, normalizing each surviving token
function splitArgList(raw) {
  const args = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      buf += ch + raw[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      buf += ch;
    } else if (ch === ',' && !inQuotes) {
      args.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) args.push(buf);
  return args.filter(a => a.trim()).map(normalizeName);
}

// mirrors sd.py's parse_xmile(): every <aux>'s name becomes a node, its
// <eqn>'s "A FUNCTION OF(parent, ...)" becomes parent -> node edges; a
// parent/child that never appears as its own <aux> still becomes a node
function parseXmile(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Could not parse this as XML.');
  }
  const nodes = [];
  const seen = new Set();
  const edges = [];
  const addNode = (n) => { if (!seen.has(n)) { seen.add(n); nodes.push(n); } };

  const auxEls = doc.getElementsByTagNameNS(XMILE_NS, 'aux');
  for (const auxEl of auxEls) {
    const rawName = auxEl.getAttribute('name');
    if (rawName === null) continue;
    const child = normalizeName(rawName);
    addNode(child);

    const eqnEl = Array.from(auxEl.children).find(c => c.localName === 'eqn');
    if (!eqnEl || !eqnEl.textContent) continue;
    const m = XMILE_EQN_RE.exec(eqnEl.textContent.trim());
    if (!m) continue;
    splitArgList(m[1]).forEach(parent => edges.push({ s: parent, t: child }));
  }
  edges.forEach(({ s, t }) => { addNode(s); addNode(t); });
  if (!nodes.length) throw new Error('No variables found in this file.');
  return { nodes, edges };
}

// mirrors sd.py's drop_suffixed_components(): finds every connected
// component (edges treated as undirected) containing a variable whose name
// ends in " 0" - Vensim's "_0" collision-renaming suffix from merging two
// diagrams into one file, after normalizeName() turned "_" into a space.
// Returns the set of variables in those components, or null when there are
// none, or when *every* component has one (dropping would leave nothing).
const VENSIM_DUP_SUFFIX = ' 0';
function findSuffixedClusters(nodes, edges) {
  const parent = new Map(nodes.map(n => [n, n]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  edges.forEach(({ s, t }) => {
    const rs = find(s), rt = find(t);
    if (rs !== rt) parent.set(rs, rt);
  });
  const groups = new Map();
  nodes.forEach(n => {
    const root = find(n);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n);
  });
  const suffixed = [...groups.values()].filter(comp => comp.some(n => n.endsWith(VENSIM_DUP_SUFFIX)));
  if (suffixed.length === 0 || suffixed.length === groups.size) return null;
  return { nodeIds: new Set(suffixed.flat()), clusterCount: suffixed.length };
}

// turns a parsed .xmile ({nodes, edges} from parseXmile, optionally minus a
// set of variables to drop) into the same {nodes, edges, levels, log, loops,
// loopsDropped} shape importGraph() produces, so it drops into the exact
// same buildGraph() call site - see the comment block above for what's
// necessarily missing (positions/levels/loops/history) compared to a JSON export
function xmileToGraph(parsed, dropIds) {
  const real = dropIds
    ? { nodes: parsed.nodes.filter(n => !dropIds.has(n)), edges: parsed.edges.filter(({ s, t }) => !dropIds.has(s) && !dropIds.has(t)) }
    : parsed;

  const defaultLevel = levels[0].level;
  const nodes = real.nodes.map(id => ({
    id,
    level: defaultLevel,
    x: Math.random() * DATA.canvas.w,
    y: Math.random() * DATA.canvas.h,
    in: [], out: [],
  }));
  const byIdLocal = new Map(nodes.map(n => [n.id, n]));

  const seenEdge = new Set();
  const edges = [];
  real.edges.forEach(({ s, t }) => {
    if (!byIdLocal.has(s) || !byIdLocal.has(t) || s === t) return;
    const key = s + ' ' + t;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ s, t, polarity: null, bend: null });
    byIdLocal.get(s).out.push(t);
    byIdLocal.get(t).in.push(s);
  });

  nodes.forEach(n => { n.r = computeRadius(n); });

  return {
    nodes, edges,
    levels: levels.map(l => ({ ...l })),
    log: [], loops: [], loopsDropped: 0,
  };
}

// converts an exported (or hand-edited) file into the shape buildGraph()
// expects - {nodes:[{id,x,y,r,level,in,out}], edges:[{s,t}], levels} - same
// derivation build_payload() does in Python, just re-run client-side since
// an uploaded file only carries the slim export fields
function importGraph(raw) {
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new Error('Not a recognized graph file.');
  }

  // a diagram's levels travel with it (see sanitizeLevels()) - fall back to
  // this page's own starting palette only if the file predates that (an
  // older export, or one with no "levels" field at all)
  const importedLevels = sanitizeLevels(raw.levels) || DATA.levels.map(l => ({ ...l }));
  const importedLevelNums = new Set(importedLevels.map(l => l.level));
  const defaultImportedLevel = importedLevels[0].level;

  const seenIds = new Set();
  const nodes = [];
  raw.nodes.forEach(rn => {
    const id = typeof rn.id === 'string' ? rn.id.trim() : '';
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    let level = Number(rn.level);
    if (!importedLevelNums.has(level)) level = defaultImportedLevel;
    let x = Number(rn.x), y = Number(rn.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      x = DATA.canvas.w / 2 + (Math.random() * 40 - 20);
      y = DATA.canvas.h / 2 + (Math.random() * 40 - 20);
    }
    nodes.push({ id, level, x, y, in: [], out: [] });
  });
  // an empty nodes list is a legitimate import (e.g. a blank template that
  // only carries a level scheme) - not an error

  const byIdLocal = new Map(nodes.map(n => [n.id, n]));
  const seenEdge = new Set();
  const edges = [];
  raw.edges.forEach(re => {
    const s = re.source ?? re.s, t = re.target ?? re.t;
    if (!byIdLocal.has(s) || !byIdLocal.has(t) || s === t) return;
    const key = s + ' ' + t;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    const polarity = re.polarity === '+' || re.polarity === '-' ? re.polarity : null;
    const bend = typeof re.bend === 'number' && Number.isFinite(re.bend) ? re.bend : null;
    edges.push({ s, t, polarity, bend });
    byIdLocal.get(s).out.push(t);
    byIdLocal.get(t).in.push(s);
  });

  nodes.forEach(n => { n.r = computeRadius(n); });

  const log = Array.isArray(raw.log) ? raw.log.map(normalizeLogLine).filter(Boolean) : [];

  // keep only loops whose nodes all survived and whose cycle still holds
  // against the imported edges - re-validated the same way a freshly-picked
  // loop would be, since the file may have been hand-edited
  const rawLoops = Array.isArray(raw.loops) ? raw.loops : [];
  let loopsDropped = 0;
  const importedLoops = [];
  rawLoops.forEach(rl => {
    const loopNodes = Array.isArray(rl.nodes) ? rl.nodes : [];
    const type = rl.type === 'B' ? 'B' : 'R';
    const name = typeof rl.name === 'string' ? rl.name.trim() : '';
    const allExist = loopNodes.length >= 2 && loopNodes.every(id => byIdLocal.has(id));
    const check = allExist ? validateLoopCycle(loopNodes, edges) : { ok: false };
    if (name && check.ok) {
      importedLoops.push({ id: 'loop-' + (++loopIdSeq), name, type, nodes: loopNodes.slice(), color: LOOP_COLORS[loopColorSeq % LOOP_COLORS.length] });
      loopColorSeq++;
    } else {
      loopsDropped++;
    }
  });

  return { nodes, edges, levels: importedLevels, log, loops: importedLoops, loopsDropped };
}

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-selecting the same filename later
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    // sniff by extension first, falling back to content - catches a
    // misnamed or extensionless .xmile file the same way either path works
    const isXmile = file.name.toLowerCase().endsWith('.xmile') || /<xmile[\s>]/i.test(text.slice(0, 2000));

    try {
      if (!isXmile) { applyImport(importGraph(JSON.parse(text)), false, 0); return; }
      const parsed = parseXmile(text);
      const dup = findSuffixedClusters(parsed.nodes, parsed.edges);
      if (!dup) { applyImport(xmileToGraph(parsed, null), true, 0); return; }
      // a likely Vensim merged-diagram duplicate - let the user decide
      // before anything is loaded (see the xmile-dup dialog below)
      askAboutXmileDuplicates(dup, (choice) => {
        if (choice === 'drop') applyImport(xmileToGraph(parsed, dup.nodeIds), true, dup.nodeIds.size);
        else if (choice === 'keep') applyImport(xmileToGraph(parsed, null), true, 0);
        else showImportStatus('Upload cancelled - the diagram is unchanged.');
      });
    } catch (err) {
      showImportStatus(err.message || 'Could not read that file.', true);
    }
  };
  reader.onerror = () => showImportStatus('Could not read that file.', true);
  reader.readAsText(file);
});

// ---- "merged duplicate diagram?" dialog for .xmile uploads ----
const xmileDupModal = document.getElementById('xmile-dup-modal');
let xmileDupCallback = null;

function askAboutXmileDuplicates(dup, callback) {
  xmileDupCallback = callback;
  document.getElementById('xmile-dup-count').textContent = dup.nodeIds.size;
  document.getElementById('xmile-dup-clusters').textContent = dup.clusterCount;
  const examples = [...dup.nodeIds].filter(n => n.endsWith(VENSIM_DUP_SUFFIX)).slice(0, 4);
  document.getElementById('xmile-dup-examples').textContent = 'For example: ' + examples.map(n => `"${n}"`).join(', ') + (dup.nodeIds.size > examples.length ? ', ...' : '');
  xmileDupModal.style.display = 'flex';
}

// choice: 'drop', 'keep', or 'cancel' (Escape / clicking outside the box)
function closeXmileDupModal(choice) {
  if (xmileDupModal.style.display === 'none') return;
  xmileDupModal.style.display = 'none';
  const cb = xmileDupCallback;
  xmileDupCallback = null;
  if (cb) cb(choice);
}
document.getElementById('xmile-dup-drop').addEventListener('click', () => closeXmileDupModal('drop'));
document.getElementById('xmile-dup-keep').addEventListener('click', () => closeXmileDupModal('keep'));
xmileDupModal.addEventListener('click', (e) => { if (e.target === xmileDupModal) closeXmileDupModal('cancel'); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeXmileDupModal('cancel'); });

// loads an already-converted graph (from a JSON export or a .xmile) into
// the live page, replacing the current diagram. droppedCount is how many
// merged-duplicate variables the user chose to drop from a .xmile, for the log.
function applyImport(converted, isXmile, droppedCount) {
  setMergeMode(false);
  buildGraph(converted); // resets loops = [] as part of the rebuild
  // a .xmile carries no positions - settle the random scatter above (which
  // needs the physics running, so free-arrange has to come off for it)
  if (isXmile) { setFreeMode(false); startSim(); }

  loops = converted.loops;
  renderLoopList();

  // replay the uploaded file's own history (already oldest-first) as
  // muted "history" entries, then log the import itself as the newest
  // entry, so the panel reads as a continuous timeline across sessions
  changeLog = [];
  converted.log.forEach(l => logChange('history', l.text, l.comment));

  let importMsg, statusMsg;
  if (isXmile) {
    importMsg = `Loaded ${converted.nodes.length} variable(s), ${converted.edges.length} link(s) from a .xmile file - positions, subsystems, and loops aren't in that format, so this is a fresh layout in the default subsystem. Assign subsystems and add feedback loops as usual.`;
    statusMsg = `Loaded ${converted.nodes.length} variable(s), ${converted.edges.length} link(s) from .xmile - no positions/subsystems/loops in that format.`;
    if (droppedCount) {
      importMsg += ` Dropped ${droppedCount} variable(s) from a merged duplicate diagram (names ending in "_0").`;
      statusMsg += ` Dropped ${droppedCount} merged-duplicate variable(s).`;
    }
  } else {
    importMsg = `Loaded ${converted.nodes.length} node(s), ${converted.edges.length} edge(s) from uploaded file`;
    if (converted.loops.length) importMsg += `, ${converted.loops.length} loop(s)`;
    if (converted.loopsDropped) importMsg += ` (${converted.loopsDropped} loop(s) dropped - no longer a valid cycle)`;
    statusMsg = `Loaded ${converted.nodes.length} node(s), ${converted.edges.length} edge(s).`;
    if (converted.loopsDropped) statusMsg += ` ${converted.loopsDropped} loop(s) dropped.`;
  }
  logChange('import', importMsg);
  pushUndoCheckpoint(importMsg);
  showImportStatus(statusMsg);
}

// ---- search ----
const searchInput = document.getElementById('search');
const resultsEl = document.getElementById('results');
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  resultsEl.innerHTML = '';
  if (q.length < 2) return;
  const matches = liveNodes.filter(n => n.id.toLowerCase().includes(q)).slice(0, 8);
  matches.forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'result-item';
    btn.textContent = n.id;
    btn.addEventListener('click', () => { selectNode(n.id); resultsEl.innerHTML = ''; searchInput.value = n.id; });
    resultsEl.appendChild(btn);
  });
});
