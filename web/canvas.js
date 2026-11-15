import { ROOT, compatibleWidgetSchema, equal, snapshot, validateChange } from "./diff.js";
import { bounds, edgePath, enclosing, openReadonly, portPosition, strokeMark } from "./graph-view.js";
import { canvasPoint, createGhostLayer } from "./ghost-node.js";
import { resolveExecutionNode } from "./issues.js";

export function restoresNamedWidgets(app) {
  return app.extensionManager.setting.get("Comfy.Workflow.NamedValuesRestore") === true;
}

export function liveSnapshot(app) {
  return snapshot(JSON.parse(JSON.stringify(app.rootGraph.serialize())), { restoreNamed: restoresNamedWidgets(app) });
}

export function liveGraph(root, key) {
  return key === ROOT ? root : root.subgraphs.get(key);
}

function nodeIn(graph, id) {
  return graph?.getNodeById(String(id));
}

function widgetValueStamp(node, change) {
  if (change.kind !== "parameter" && change.to?.kind !== "value") return;
  const widgets = node?.widgets?.filter((widget) => widget.serialize !== false);
  if (!widgets) return;
  const matches = change.name ? widgets.filter(({ name }) => name === change.name) : [];
  // Vue can update the live value before ComfyUI captures a workflow snapshot.
  if (matches.length === 1) return JSON.stringify(matches[0].value);
  if (change.index != null) return JSON.stringify(widgets[change.index]?.value);
  return JSON.stringify(widgets.map(({ name, value }) => [name, value]));
}

export function namesOnCanvas(app, graph, expected) {
  const actual = nodeIn(liveGraph(app.rootGraph, graph), expected.id);
  if (!actual?.widgets ||
    !Object.hasOwn(window.LiteGraph?.registered_node_types ?? {}, actual.type) ||
    !compatibleWidgetSchema({ type: actual.type, raw: actual }, expected)) return null;
  const widgets = actual.widgets.filter((widget) => widget.serialize !== false);
  const names = widgets.map((widget) => widget.name);
  if (!names.every(Boolean) || new Set(names).size !== names.length) return null;
  const samePorts = ["inputs", "outputs"].every((side) =>
    (actual[side]?.length ?? 0) === expected[side].length &&
    expected[side].every((port, index) => actual[side][index].name === port.name));
  const saved = expected.raw.widgets_values;
  if (!Array.isArray(saved)) return null;
  if (samePorts && names.length === saved.length) return names;

  // A loaded older node may have new ports or widgets. Use its names only
  // when the saved sequence has a single ordered match in the live values.
  const current = widgets.map((widget) => widget.value ?? null);
  const first = [];
  let index = 0;
  for (const value of saved) {
    while (index < current.length && !equal(current[index], value)) index++;
    if (index === current.length) return null;
    first.push(index++);
  }
  index = current.length - 1;
  for (let i = saved.length - 1; i >= 0; i--) {
    while (index > first[i] && !equal(current[index], saved[i])) index--;
    if (index !== first[i]) return null;
    index--;
  }
  return first.map((index) => names[index]);
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

function drawRemovedEdge(context, edge, endpoint, red, contrast, scale) {
  const { path, start, end } = edgePath(edge, endpoint);
  context.setLineDash([13 / scale, 10 / scale]);
  strokeMark(context, path, red, contrast, 4 / scale, scale);
  context.setLineDash([]);
  for (const [x, y] of [start, end]) {
    const ring = new Path2D();
    ring.arc(x, y, 6 / scale, 0, Math.PI * 2);
    strokeMark(context, ring, red, contrast, 3 / scale, scale);
  }
}

function nodeElement(canvas, id) {
  return canvas.canvas.closest(".graph-canvas-container")
    ?.querySelector(`.lg-node[data-node-id="${CSS.escape(id)}"]`);
}

function widgetElement(host, name) {
  const rows = host?.querySelectorAll(`.lg-node-widget[data-widget-name="${CSS.escape(name)}"]`);
  return rows?.length === 1 && rows[0].getClientRects().length ? rows[0] : null;
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
  } else if (source?.kind === "value" && change.name) {
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
  const [x, y, width, height] = rect;
  const padded = [x - 36, y - 36, width + 72, height + 72];
  const fitScale = Math.min(viewport[2] / Math.max(padded[2], 300), viewport[3] / Math.max(padded[3], 300));
  canvas.ds.fitToBounds(padded, { viewport, zoom: Math.min(0.85, 0.9 / fitScale) });
  canvas.setDirty(true, true);
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function openGraph(canvas, root, { graph, route }) {
  const previous = canvas.graph;
  if (previous === graph) return;
  const start = route.findIndex((step) => step.node.graph === previous);
  if (start < 0 && previous !== root) canvas.setGraph(root);
  for (const step of route.slice(Math.max(start, 0))) {
    canvas.openSubgraph(step.graph, step.node);
    if (canvas.graph !== step.graph) throw new Error("ComfyUI 未能进入目标子图。");
  }
  if (!route.length) canvas.setGraph(graph);
}

function resolveGraph(root, active, key, path) {
  return (key && active && findRoute(active, key)) || resolvePath(root, path);
}

export class CanvasReview {
  constructor(app, sidebar) {
    this.app = app;
    this.sidebar = sidebar;
  }

  get workflowState() {
    return this.app.extensionManager.workflow.activeWorkflow?.activeState;
  }

  async locateIssue(id) {
    const target = resolveExecutionNode(this.app.rootGraph, id);
    if (!target) throw new Error("当前画布中找不到该问题对应的节点。");
    await this.navigate(target, () => this.focusNode(target.node));
  }

  focusNode(node) {
    const { canvas } = this.app;
    canvas.deselectAll();
    canvas.select(node);
    center(canvas, node.boundingRect, this.sidebar);
  }

  async navigate(resolved, focus) {
    const { canvas, rootGraph: root } = this.app;
    const state = this.workflowState;
    const operation = this.operation = Symbol();
    openGraph(canvas, root, resolved);
    this.syncHighlight();
    await nextPaint();
    if (this.operation !== operation || this.app.rootGraphOrUndefined !== root ||
      this.workflowState !== state || canvas.graph !== resolved.graph) return;
    return focus(canvas);
  }

  async locateNode({ graph: key, node, historical, path }, result) {
    const { canvas, rootGraph: root } = this.app;
    const { before, after, head } = result;
    const oldPath = before.paths.get(key);
    const preferred = after.paths.get(key) ?? oldPath;
    const resolved = path ? resolvePath(root, path) : preferred && resolveGraph(root, canvas.graph, key, preferred);
    const target = nodeIn(resolved?.graph, node.id);
    if (target?.type === node.type) {
      return this.navigate(resolved, () => {
        this.focusNode(target);
        return "";
      });
    }
    if (historical && oldPath) {
      const plan = this.selection?.plan;
      if (resolved && plan?.resolved.graph === resolved.graph && plan.historicalNodes.get(node.id)?.type === node.type) {
        return this.navigate(resolved, (canvas) => {
          const card = this.overlay?.cards.get(node.id);
          if (!card) return;
          this.focusGhost(canvas, card);
          return "";
        });
      }
      this.operation = undefined;
      this.showReadonly(before, path ?? oldPath, { node: node.id }, head);
      return "已定位到旧版本节点。";
    }
    throw new Error(`当前画布中找不到对应的节点 #${node.id}。`);
  }

  focusGhost(canvas, card) {
    center(canvas, [card.offsetLeft, card.offsetTop, card.offsetWidth, card.offsetHeight], this.sidebar);
  }

  showReadonly(before, path, focus, head) {
    if (!this.dialog?.open) this.dialog = openReadonly(before, path, focus, head);
  }

  clear() {
    this.operation = undefined;
    this.selection = null;
    this.stopWatching?.();
    this.stopWatching = null;
    this.clearOverlay();
    if (this.dialog?.open) this.dialog.close();
    this.dialog = null;
  }

  clearOverlay() {
    this.overlay?.remove();
    this.overlay = null;
  }

  highlight(change, result) {
    this.clear();
    const { canvas, rootGraph: root } = this.app;
    this.selection = { change, result, root };
    const sync = () => queueMicrotask(() => this.syncHighlight());
    canvas.canvas.addEventListener("litegraph:set-graph", sync);
    this.stopWatching = () => canvas.canvas.removeEventListener("litegraph:set-graph", sync);
    this.syncHighlight();
  }

  syncHighlight(retry = false) {
    const selection = this.selection;
    if (!selection) return;
    const { canvas, rootGraphOrUndefined: root } = this.app;
    const graph = canvas?.graph;
    const targetGraph = root && liveGraph(root, selection.change.graph);
    const node = nodeIn(targetGraph, selection.change.node);
    const view = [canvas, graph, root, this.workflowState, targetGraph?._version, node, node?.mode,
      widgetValueStamp(node, selection.change)];
    if (!retry && selection.view?.every((value, index) => value === view[index])) return;
    selection.view = view;
    selection.plan = null;
    this.clearOverlay();
    if (!graph || root !== selection.root) return;
    let plan;
    try {
      plan = this.prepare(selection.change, selection.result);
    } catch {
      // A stale comparison cannot mark the canvas. Explicit location reports the mismatch.
      return;
    }
    selection.plan = plan;
    if (graph === plan.resolved.graph) this.renderHighlight(plan);
  }

  prepare(change, result) {
    const { app } = this;
    const { before, after } = result;
    const canvas = app.canvas;
    const root = app.rootGraph;
    const workflowState = this.workflowState;
    const oldPath = before.paths.get(change.graph) ?? [];
    const path = after.paths.get(change.graph) ?? oldPath;
    let resolved = resolveGraph(root, canvas.graph, change.graph, path);

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
        const retained = after.graphs.get(candidateKey)?.nodes.get(step.id);
        const current = nodeIn(parent.graph, step.id);
        if (current?.type !== retained?.type) {
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
    const currentGraph = liveSnapshot(app).graphs.get(graphKey);
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
    const historicalNodes = new Map();
    if (ghost) historicalNodes.set(ghost.id, ghost);
    for (const edge of removedEdges) {
      for (const old of [edge.source, edge.target]) {
        if (!old.raw.boundary && currentGraph?.nodes.get(old.id)?.type !== old.type) {
          historicalNodes.set(old.id, old);
        }
      }
    }
    return { change, result, resolved, root, workflowState, graphKey, currentGraph, ghost, removedBranch,
      removedEdges, source, historicalNodes, focus: removedBranch === oldPath ? { node: change.node } : undefined };
  }

  renderHighlight(plan) {
    const { app } = this;
    const { canvas } = app;
    const { change, result: { before, head }, resolved: { graph }, root, workflowState, graphKey,
      currentGraph, ghost, removedBranch, removedEdges, source, focus, historicalNodes } = plan;
    const node = currentGraph?.nodes.get(change.node);
    const ghosts = historicalNodes.size ? createGhostLayer(canvas) : null;
    const cards = new Map();
    for (const old of historicalNodes.values()) {
      const child = before.graphs.get(old.type);
      const branch = old === ghost && removedBranch || (child && [...(before.paths.get(graphKey) ?? []), {
        id: old.id, graph: old.type, name: old.title || child.name || "子图",
      }]);
      const card = ghosts.add(old, before, {
        selected: old === ghost,
        openSubgraph: branch && (() => this.showReadonly(before, branch, old === ghost ? focus : undefined, head)),
        locate: (card) => this.focusGhost(canvas, card),
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
    let markScale;
    const clearMark = () => {
      mark?.target.removeAttribute("data-comfydiff-mark");
      mark?.target.style.removeProperty("--cd-mark-unit");
    };
    const updateMark = () => {
      const next = getMark();
      if (mark?.target !== next?.target || mark?.kind !== next?.kind) {
        clearMark();
        mark = next;
        markScale = undefined;
        mark?.target.setAttribute("data-comfydiff-mark", mark.kind);
      }
      if (mark && markScale !== canvas.ds.scale) {
        markScale = canvas.ds.scale;
        mark.target.style.setProperty("--cd-mark-unit", `${1 / markScale}px`);
      }
    };
    const draw = (context, area) => {
      previousDraw?.call(canvas, context, area);
      if (canvas.graph !== graph || app.rootGraphOrUndefined !== root || this.workflowState !== workflowState) return;
      updateMark();
      ghosts?.sync();
      const scale = canvas.ds.scale;
      const colors = getComputedStyle(document.documentElement);
      const red = colors.getPropertyValue("--cd-mark-deleted").trim();
      const green = colors.getPropertyValue("--cd-mark-added").trim();
      const yellow = colors.getPropertyValue("--cd-mark-modified").trim();
      const contrast = colors.getPropertyValue("--cd-mark-contrast").trim();
      context.save();
      context.lineCap = "round";
      context.globalAlpha = 1;
      context.setLineDash([]);
      if (liveLink && canvas.renderedPaths.has(liveLink)) {
        const linkColor = liveLink.color || canvas.constructor.link_type_colors[liveLink.type] || canvas.default_link_color;
        for (const segment of [liveLink, ...liveReroutes(graph, liveLink)]) {
          if (!segment.path || !canvas.renderedPaths.has(segment)) continue;
          strokeMark(context, segment.path, green, contrast, canvas.connections_width + 14 / scale, scale);
          context.lineWidth = canvas.connections_width;
          context.strokeStyle = linkColor;
          context.stroke(segment.path);
        }
      }
      context.globalAlpha = 0.9;
      for (const edge of removedEdges) drawRemovedEdge(context, edge, endpoint, red, contrast, scale);
      if (livePort || boundaryPort || oldBoundaryPort) {
        const point = boundaryPort ? endpoint(node, boundaryPort, change.side === "inputs") :
          oldBoundaryPort ? portPosition(change.before, oldBoundaryPort, change.side === "inputs") :
          endpoint(node, livePort, true);
        context.globalAlpha = 1;
        if (oldBoundaryPort) {
          context.lineCap = "butt";
          context.setLineDash([8 / scale, 6 / scale]);
        }
        const ring = new Path2D();
        ring.arc(...point, 12 / scale, 0, Math.PI * 2);
        strokeMark(context, ring, oldBoundaryPort ? red : yellow, contrast, 4 / scale, scale);
      }
      context.restore();
    };
    canvas.onDrawForeground = draw;
    const remove = () => {
      if (canvas.onDrawForeground === draw) canvas.onDrawForeground = previousDraw;
      clearMark();
      ghosts?.remove();
      canvas.setDirty(true, true);
    };
    this.overlay = { remove, cards, endpoint };
    updateMark();
    ghosts?.sync();
    canvas.setDirty(true, true);
  }

  async locate(change, result, openOld = false) {
    const plan = this.prepare(change, result);
    const { resolved, currentGraph, ghost, source, removedBranch, focus, removedEdges } = plan;
    return this.navigate(resolved, (canvas) => {
      if (!this.overlay) this.syncHighlight(true);
      if (!this.overlay) return;
      const { cards, endpoint } = this.overlay;
      const node = currentGraph?.nodes.get(change.node);
      const target = !ghost && nodeIn(resolved.graph, change.node);
      const isParameter = source?.kind === "value";
      if (target) {
        canvas.deselectAll();
        canvas.select(target);
      }
      const rects = [...cards.values()].map((card) => [
        card.offsetLeft, card.offsetTop, card.offsetWidth, card.offsetHeight,
      ]);
      if (ghost) {
        canvas.deselectAll();
        cards.get(ghost.id)?.focus({ preventScroll: true });
      } else if (target) {
        const [x, y, width, height] = target.boundingRect;
        const widget = isParameter && change.name && widgetElement(nodeElement(canvas, node.id), change.name);
        if (widget && height > 280 && !removedEdges.length) {
          const [, widgetY] = canvasPoint(canvas, widget, true);
          rects.push([x, Math.max(y, Math.min(widgetY - 140, y + height - 280)), width, 280]);
        } else {
          rects.push([x, y, width, height]);
        }
      } else if (node) {
        rects.push(bounds(node));
      }
      for (const edge of removedEdges) {
        const points = [endpoint(edge.source, edge.out, false), ...edge.points, endpoint(edge.target, edge.port, true)];
        for (const [x, y] of points) rects.push([x, y, 0, 0]);
      }
      center(canvas, enclosing(rects), this.sidebar);
      if (removedEdges.length && isParameter) {
        // Vue updates the widget DOM after the canvas transform changes.
        void nextPaint().then(() => canvas.setDirty(true, true));
      }
      if (openOld && removedBranch) this.showReadonly(result.before, removedBranch, focus, result.head);
      const host = isParameter && target && nodeElement(canvas, node.id);
      if (change.kind === "parameter" && !isParameter) return "已定位到节点，当前版本没有这个参数。";
      if (isParameter && (!change.name || !widgetElement(host, change.name))) {
        if (!change.name) return "已定位到节点，无法可靠匹配参数控件。";
        if (target?.flags.collapsed) return "已定位到节点。展开节点后可查看高亮的参数。";
        return "已定位到节点，画布上没有可高亮的参数控件。";
      }
      return "";
    });
  }
}
