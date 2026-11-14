import { ROOT, snapshot, validateChange } from "./diff.js";
import { bounds, enclosing, portPosition, traceEdge, openReadonly } from "./graph-view.js";
import { canvasPoint, createGhostLayer } from "./ghost-node.js";

export function liveSnapshot(app) {
  return snapshot(JSON.parse(JSON.stringify(app.rootGraph.serialize())));
}

export function liveGraph(root, key) {
  return key === ROOT ? root : root.subgraphs.get(key);
}

function nodeIn(graph, id) {
  return graph?.getNodeById(String(id));
}

export function namesOnCanvas(app, graph, expected) {
  const actual = nodeIn(liveGraph(app.rootGraph, graph), expected.id);
  if (actual?.type !== expected.type || !actual.widgets) return null;
  const names = actual.widgets.filter((widget) => widget.serialize !== false).map((widget) => widget.name);
  return names.every(Boolean) && new Set(names).size === names.length ? names : null;
}

function resolvePath(graph, path) {
  const route = [];
  for (const step of path) {
    const node = nodeIn(graph, step.id);
    if (node?.type !== step.graph || !node.subgraph) return null;
    graph = node.subgraph;
    route.push({ graph, node });
  }
  return { graph, route };
}

function findRoute(start, key) {
  const seen = new Set([start]);
  const queue = [{ graph: start, route: [] }];
  for (const entry of queue) {
    if (entry.graph.id === key) return entry;
    for (const node of entry.graph.nodes) {
      const graph = node.subgraph;
      if (!graph || seen.has(graph)) continue;
      seen.add(graph);
      queue.push({ graph, route: [...entry.route, { graph, node }] });
    }
  }
  return null;
}

function livePosition(canvas, graph, current, old, port, input, widgetName) {
  const node = current?.nodes.get(old.id);
  if (node?.type !== old.type) return null;
  const slots = input ? node.inputs : node.outputs;
  const match = slots.find((entry) => entry.key === port.key);
  if (node.raw.boundary) {
    const boundary = input ? graph.outputNode : graph.inputNode;
    const pos = match && boundary?.slots[match.index]?.pos;
    return pos ? [pos[0], pos[1]] : portPosition(node, match ?? port, input);
  }
  const actual = nodeIn(graph, node.id);
  const host = nodeElement(canvas, node.id);
  if (widgetName && host) {
    const widget = widgetElement(host, widgetName);
    if (widget?.getClientRects().length) return canvasPoint(canvas, widget, true);
  }
  if (match) {
    return actual?.getSlotPosition(match.index, input);
  }
  // The node still exists but no longer has this port.
  const [x, y, width, height] = actual?.boundingRect ?? bounds(node);
  return [x + (input ? 0 : width), y + Math.min(height / 2, 24)];
}

function liveReroutes(graph, link) {
  const points = [];
  const seen = new Set();
  let parent = link.parentId;
  while (parent != null && !seen.has(parent)) {
    seen.add(parent);
    const reroute = graph.getReroute(parent);
    if (!reroute) break;
    points.push(reroute);
    parent = reroute.parentId;
  }
  return points;
}

function drawRemovedEdge(context, edge, endpoint, scale) {
  context.setLineDash([7 / scale, 5 / scale]);
  context.globalAlpha = 0.7;
  const points = traceEdge(context, edge, endpoint);
  context.setLineDash([]);
  for (const [x, y] of [points[0], points.at(-1)]) {
    context.beginPath();
    context.arc(x, y, 4 / scale, 0, Math.PI * 2);
    context.stroke();
  }
}

function nodeElement(canvas, id) {
  return canvas.canvas.closest(".graph-canvas-container")
    ?.querySelector(`.lg-node[data-node-id="${CSS.escape(id)}"]`);
}

function widgetElement(host, name) {
  const rows = host.querySelectorAll(`.lg-node-widget[data-widget-name="${CSS.escape(name)}"]`);
  return rows.length === 1 ? rows[0] : null;
}

function markElement(canvas, node, change, source) {
  const host = nodeElement(canvas, node.id);
  if (!host) return null;
  let target = host;
  let kind = change.kind === "added" ? "added" : "changed";
  if (source?.kind === "link" || source?.kind === "exposed") {
    const dots = [...host.querySelectorAll("[data-slot-key]")];
    const dot = dots.find((entry) => entry.dataset.slotKey === `${node.id}-in-${source.port.index}`);
    if (dot) {
      target = dot;
      kind = "port";
    }
  } else if (change.name) {
    target = widgetElement(host, change.name) ?? host;
  }
  return { target, kind };
}

function center(canvas, rect, sidebar) {
  const canvasRect = canvas.canvas.getBoundingClientRect();
  const panelRect = sidebar?.getBoundingClientRect();
  const covered = panelRect && panelRect.left <= canvasRect.left + 60
    ? Math.max(0, Math.min(panelRect.right - canvasRect.left, canvasRect.width * 0.7)) : 0;
  const viewport = [covered, 0, Math.max(1, canvasRect.width - covered), canvasRect.height];
  canvas.ds.fitToBounds(rect, { viewport });
  canvas.setDirty(true, true);
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export class CanvasReview {
  constructor(app, sidebar) {
    this.app = app;
    this.sidebar = sidebar;
  }

  clear() {
    this.operation = undefined;
    if (this.dialog?.open) this.dialog.close();
    this.dialog = null;
    this.cleanup?.();
    this.cleanup = null;
  }

  async locate(change, result, openOld = false) {
    this.clear();
    const operation = Symbol();
    this.operation = operation;
    const { app } = this;
    const { before, after, head } = result;
    const canvas = app.canvas;
    const root = app.rootGraph;
    const graphState = root.state;
    const current = liveSnapshot(app);
    const oldPath = before.paths.get(change.graph) ?? [];
    const path = after.paths.get(change.graph) ?? oldPath;
    const activeRoute = change.graph && canvas.graph && findRoute(canvas.graph, change.graph);
    let resolved = activeRoute || resolvePath(root, path);

    let graphKey = change.graph;
    let ghost;
    let removedBranch;
    let removedEdges = [];
    let source;
    if (!resolved && change.kind === "deleted" && !after.paths.has(change.graph)) {
      for (let index = oldPath.length - 1; index >= 0; index--) {
        const parent = resolvePath(root, oldPath.slice(0, index));
        if (!parent) continue;
        const step = oldPath[index];
        const candidateKey = oldPath[index - 1]?.graph ?? ROOT;
        if (nodeIn(parent.graph, step.id)) {
          throw new Error("当前画布中的子图入口与比较结果不同。");
        }
        ghost = before.graphs.get(candidateKey).nodes.get(step.id);
        graphKey = candidateKey;
        removedBranch = oldPath;
        resolved = parent;
        break;
      }
    }
    if (!resolved) throw new Error("当前画布中找不到对应的子图路径。");
    const { graph, route } = resolved;
    const currentGraph = current.graphs.get(graphKey);
    if (!removedBranch) {
      const validation = validateChange(change, currentGraph);
      if (typeof validation === "string" && validation) throw new Error(validation);
      source = validation?.source;
      if (change.kind === "deleted") {
        ghost = change.before;
        if (before.graphs.has(ghost.type)) removedBranch = [...oldPath, {
          id: ghost.id, graph: ghost.type, name: ghost.title || before.graphs.get(ghost.type).name || "子图",
        }];
      }
    }
    const oldGraph = before.graphs.get(graphKey);
    if (ghost) removedEdges = oldGraph.incident.get(ghost.id) ?? [];
    if (change.from?.kind === "link") removedEdges = [change.from.edge];
    const previous = canvas.graph;
    if (previous !== graph) {
      const start = route.findIndex((step) => step.node.graph === previous);
      if (start < 0 && previous !== root) canvas.setGraph(root);
      for (const step of route.slice(Math.max(start, 0))) {
        canvas.openSubgraph(step.graph, step.node);
        if (canvas.graph !== step.graph) throw new Error("ComfyUI 未能进入目标子图。");
      }
      if (!route.length) canvas.setGraph(graph);
    }
    await nextPaint();
    if (this.operation !== operation || app.rootGraph !== root || root.state !== graphState || canvas.graph !== graph) return;

    const node = currentGraph?.nodes.get(change.node);
    const target = ghost ? null : nodeIn(graph, change.node);
    if (target) {
      canvas.deselectAll();
      canvas.select(target);
    }
    const historicalNodes = new Map();
    if (ghost) historicalNodes.set(ghost.id, ghost);
    for (const edge of removedEdges) {
      for (const old of [edge.source, edge.target]) {
        if (!old.raw.boundary && currentGraph?.nodes.get(old.id)?.type !== old.type) {
          historicalNodes.set(old.id, old);
        }
      }
    }
    const ghosts = historicalNodes.size ? createGhostLayer(canvas) : null;
    const cards = new Map();
    const focus = removedBranch && removedBranch === oldPath ? { node: change.node, edge: change.from?.edge } : undefined;
    const openBranch = (branch, selection) => {
      if (!this.dialog?.open) this.dialog = openReadonly(before, branch, selection, head);
    };
    for (const old of historicalNodes.values()) {
      const child = before.graphs.get(old.type);
      const branch = old === ghost && removedBranch || (child && [...(before.paths.get(graphKey) ?? []), {
        id: old.id, graph: old.type, name: old.title || child.name || "子图",
      }]);
      const card = ghosts.add(old, before, {
        selected: old === ghost,
        openSubgraph: branch && (() => openBranch(branch, old === ghost ? focus : undefined)),
        redraw: () => canvas.setDirty(true, true),
      });
      cards.set(old.id, card);
    }
    const endpoint = (old, port, input) => {
      const widget = input && old.id === change.node && source?.kind === "value" ? change.name : null;
      return ghosts?.position(old, port, input) ??
        livePosition(canvas, graph, currentGraph, old, port, input, widget) ?? portPosition(old, port, input);
    };
    const livePort = source?.port ?? change.to?.port;
    const boundaryPort = change.kind === "boundary" && change.to;
    const oldBoundaryPort = change.kind === "boundary" && !change.to && change.from;
    const liveLink = source?.edge && graph.getLink(source.edge.nativeId);
    const getMark = () => !ghost && node && markElement(canvas, node, change, source);
    const previousDraw = canvas.onDrawForeground;
    let mark;
    const updateMark = () => {
      const next = getMark();
      if (mark?.target !== next?.target || mark?.kind !== next?.kind) {
        mark?.target.removeAttribute("data-comfydiff-mark");
        mark = next;
        mark?.target.setAttribute("data-comfydiff-mark", mark.kind);
      }
    };
    const draw = function (context, area) {
      previousDraw?.call(this, context, area);
      if (canvas.graph !== graph || app.rootGraph !== root || root.state !== graphState) return;
      updateMark();
      ghosts?.sync();
      const scale = canvas.ds.scale;
      const colors = getComputedStyle(document.documentElement);
      const red = colors.getPropertyValue("--cd-red").trim();
      const green = colors.getPropertyValue("--cd-green").trim();
      const yellow = colors.getPropertyValue("--cd-yellow").trim();
      context.save();
      context.lineCap = "round";
      context.strokeStyle = green;
      context.lineWidth = canvas.connections_width + 5 / scale;
      context.globalAlpha = 0.7;
      if (liveLink && canvas.renderedPaths.has(liveLink)) {
        for (const segment of [liveLink, ...liveReroutes(graph, liveLink)]) {
          if (!segment.path || !canvas.renderedPaths.has(segment)) continue;
          context.stroke(segment.path);
          context.save();
          context.lineWidth = canvas.connections_width;
          context.strokeStyle = liveLink.color || canvas.constructor.link_type_colors[liveLink.type] || canvas.default_link_color;
          context.globalAlpha = 1;
          context.stroke(segment.path);
          context.restore();
        }
      }
      context.strokeStyle = red;
      context.lineWidth = 2 / scale;
      for (const edge of removedEdges) drawRemovedEdge(context, edge, endpoint, scale);
      if (livePort || boundaryPort || oldBoundaryPort) {
        const point = boundaryPort ? endpoint(node, boundaryPort, change.side === "inputs") :
          oldBoundaryPort ? portPosition(change.before, oldBoundaryPort, change.side === "inputs") :
          endpoint(node, livePort, true);
        context.globalAlpha = 1;
        context.strokeStyle = oldBoundaryPort ? red : yellow;
        context.setLineDash(oldBoundaryPort ? [4 / scale, 3 / scale] : []);
        context.beginPath();
        context.arc(...point, 8 / scale, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();
    };
    canvas.onDrawForeground = draw;
    const invalidate = () => {
      if (canvas.graph !== graph) this.clear();
    };
    canvas.canvas.addEventListener("litegraph:set-graph", invalidate);
    this.cleanup = () => {
      if (canvas.onDrawForeground === draw) canvas.onDrawForeground = previousDraw;
      mark?.target.removeAttribute("data-comfydiff-mark");
      ghosts?.remove();
      canvas.canvas.removeEventListener("litegraph:set-graph", invalidate);
      canvas.setDirty(true, true);
    };
    updateMark();
    const rects = [];
    ghosts?.sync();
    for (const old of historicalNodes.values()) {
      const [x, y] = bounds(old);
      const card = cards.get(old.id);
      rects.push([x, y, card.offsetWidth, card.offsetHeight]);
    }
    if (ghost) {
      canvas.deselectAll();
      cards.get(ghost.id).focus({ preventScroll: true });
    }
    else if (target) rects.push(Array.from(target.boundingRect));
    else if (node) rects.push(bounds(node));
    for (const edge of removedEdges) {
      for (const [x, y] of [endpoint(edge.source, edge.out, false), ...edge.points, endpoint(edge.target, edge.port, true)]) {
        rects.push([x, y, 0, 0]);
      }
    }
    center(canvas, enclosing(rects), this.sidebar);
    canvas.setDirty(true, true);
    // Vue updates the widget DOM after the canvas transform changes.
    if (removedEdges.length && source?.kind === "value") {
      await nextPaint();
      if (this.operation !== operation) return;
      canvas.setDirty(true, true);
    }
    if (openOld && removedBranch) openBranch(removedBranch, focus);
    return true;
  }
}
