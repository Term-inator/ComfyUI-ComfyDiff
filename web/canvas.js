import { ROOT, snapshot, nodeLabel, validateChange } from "./diff.js";
import { bounds, enclosing, portPosition, traceEdge, element, openReadonly } from "./graph-view.js";

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

function livePosition(graph, current, old, port, input) {
  const node = current?.nodes.get(old.id);
  const slots = input ? node?.inputs : node?.outputs;
  const match = node?.type === old.type && slots?.find((entry) => entry.key === port.key);
  if (!match) return portPosition(old, port, input);
  if (node.raw.boundary) {
    const boundary = input ? graph.outputNode : graph.inputNode;
    const pos = boundary?.slots[match.index]?.pos;
    return pos ? [pos[0], pos[1]] : portPosition(node, match, input);
  }
  const actual = nodeIn(graph, node.id);
  return actual?.getSlotPosition(match.index, input) ?? portPosition(node, match, input);
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

function drawGhost(context, node, oldGraph, before, scale) {
  const [x, y, width, height] = bounds(node);
  const titleHeight = 24;
  context.setLineDash([7 / scale, 5 / scale]);
  context.globalAlpha = 0.18;
  context.fillStyle = context.strokeStyle;
  context.fillRect(x, y - titleHeight, width, height + titleHeight);
  context.globalAlpha = 0.9;
  context.strokeRect(x, y - titleHeight, width, height + titleHeight);
  context.setLineDash([]);
  context.font = "600 13px system-ui";
  context.fillText(`− ${nodeLabel(node, before)}`, x + 8, y - 8, width - 16);
  context.font = "11px system-ui";
  for (const edge of oldGraph.incident.get(node.id) ?? []) {
    const input = edge.target.id === node.id;
    const port = input ? edge.port : edge.out;
    if (port.name) {
      const [portX, portY] = portPosition(node, port, input);
      context.textAlign = input ? "left" : "right";
      context.fillText(port.name, portX + (input ? 6 : -6), portY + 4, width - 16);
    }
  }
}

function markElement(canvas, node, change, source) {
  const root = canvas.canvas.closest(".graph-canvas-container") ?? canvas.canvas.parentElement;
  const nodes = [...root.querySelectorAll(`.lg-node[data-node-id="${CSS.escape(node.id)}"]`)];
  const host = nodes.length === 1 ? nodes[0] : null;
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
    const rows = host.querySelectorAll(`[data-widget-name="${CSS.escape(change.name)}"].lg-node-widget`);
    if (rows.length === 1) target = rows[0];
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
    const endpoint = (old, port, input) => livePosition(graph, currentGraph, old, port, input);
    const livePort = source?.port ?? change.to?.port;
    const boundaryPort = change.kind === "boundary" && change.to;
    const oldBoundaryPort = change.kind === "boundary" && !change.to && change.from;
    const liveLink = source?.edge && graph.getLink(source.edge.nativeId);
    const getMark = () => !ghost && node && markElement(canvas, node, change, source);
    const focus = removedBranch && removedBranch === oldPath ? { node: change.node, edge: change.from?.edge } : undefined;
    const showDeleted = () => {
      if (this.dialog?.open) return;
      this.dialog = openReadonly(before, removedBranch, focus, head);
    };
    const button = removedBranch && element("button", "cd-ghost-button", "查看已删除子图");
    if (button) {
      button.type = "button";
      button.onclick = showDeleted;
      document.body.append(button);
    }

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
      if (ghost) drawGhost(context, ghost, oldGraph, before, scale);
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
      if (button) {
        const [x, y] = bounds(ghost);
        const [left, top] = canvas.ds.convertOffsetToCanvas([x, y - 24]);
        const rect = canvas.canvas.getBoundingClientRect();
        button.hidden = left < 0 || left > rect.width - 30 || top < 25 || top > rect.height;
        button.style.left = `${rect.left + left}px`;
        button.style.top = `${rect.top + top - 28}px`;
      }
    };
    canvas.onDrawForeground = draw;
    const invalidate = () => {
      if (canvas.graph !== graph) this.clear();
    };
    canvas.canvas.addEventListener("litegraph:set-graph", invalidate);
    this.cleanup = () => {
      if (canvas.onDrawForeground === draw) canvas.onDrawForeground = previousDraw;
      mark?.target.removeAttribute("data-comfydiff-mark");
      button?.remove();
      canvas.canvas.removeEventListener("litegraph:set-graph", invalidate);
      canvas.setDirty(true, true);
    };
    updateMark();
    const rects = [];
    if (ghost) rects.push(bounds(ghost));
    else if (target) rects.push(Array.from(target.boundingRect));
    else if (node) rects.push(bounds(node));
    for (const edge of removedEdges) {
      for (const [x, y] of [endpoint(edge.source, edge.out, false), ...edge.points, endpoint(edge.target, edge.port, true)]) {
        rects.push([x, y, 0, 0]);
      }
    }
    center(canvas, enclosing(rects), this.sidebar);
    canvas.setDirty(true, true);
    if (openOld && button) showDeleted();
    return true;
  }
}
