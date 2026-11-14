import { nodeLabel, ROOT } from "./diff.js";

export function bounds(node) {
  const { pos, size } = node.raw;
  return [pos?.[0] ?? 0, pos?.[1] ?? 0, Math.max(size?.[0] ?? 150, 70), Math.max(size?.[1] ?? 60, 30)];
}

export function enclosing(rects) {
  if (!rects.length) return [0, 0, 160, 100];
  const left = Math.min(...rects.map(([x]) => x));
  const top = Math.min(...rects.map(([, y]) => y));
  const right = Math.max(...rects.map(([x, , w]) => x + w));
  const bottom = Math.max(...rects.map(([, y, , h]) => y + h));
  return [left, top, Math.max(right - left, 40), Math.max(bottom - top, 40)];
}

export function portPosition(node, port, input) {
  const [x, y, width] = bounds(node);
  if (node.raw.boundary && port.pos) return [port.pos[0], port.pos[1]];
  return [x + (input ? 0 : width), y + 12 + 20 * port.index];
}

export function traceEdge(context, edge, endpoint = portPosition) {
  const points = [
    endpoint(edge.source, edge.out, false),
    ...edge.points,
    endpoint(edge.target, edge.port, true),
  ];
  const path = new Path2D();
  path.moveTo(...points[0]);
  for (let index = 1; index < points.length; index++) {
    const [x, y] = points[index - 1];
    const [endX, endY] = points[index];
    const bend = Math.max(24, Math.hypot(endX - x, endY - y) / 3);
    path.bezierCurveTo(x + bend, y, endX - bend, endY, endX, endY);
  }
  context.stroke(path);
  return points;
}

export function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = content;
  return node;
}

export function openReadonly(snapshot, path, focus, head) {
  const dialog = element("dialog", "comfydiff-readonly");
  const toolbar = element("header", "cd-readonly-header");
  const title = element("strong", "", `HEAD ${head.slice(0, 7)} · 已删除子图 · 只读`);
  const close = element("button", "", "返回画布");
  close.type = "button";
  close.onclick = () => dialog.close();
  toolbar.append(title, close);
  const crumbs = element("nav", "cd-crumbs");
  crumbs.setAttribute("aria-label", "旧子图路径");
  const viewport = element("div", "cd-readonly-viewport");
  viewport.setAttribute("aria-label", "只读子图画布");
  const canvas = element("canvas");
  const layer = element("div", "cd-readonly-nodes");
  viewport.append(canvas, layer);
  dialog.append(toolbar, crumbs, viewport);
  document.body.append(dialog);
  dialog.setAttribute("aria-label", title.textContent);
  let current = [...path];
  let graph;
  let scale = 1;
  let offset = [0, 0];
  let drag;
  let selected = focus;

  function draw() {
    if (!graph) return;
    const ratio = window.devicePixelRatio || 1;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext("2d");
    context.setTransform(ratio * scale, 0, 0, ratio * scale, ratio * offset[0], ratio * offset[1]);
    const style = getComputedStyle(dialog);
    context.lineWidth = 2 / scale;
    for (const edge of graph.edges) {
      const highlighted = selected?.edge?.id === edge.id || selected?.node === edge.source.id ||
        selected?.node === edge.target.id;
      context.strokeStyle = style.getPropertyValue(highlighted ? "--cd-red" : "--cd-muted").trim();
      context.setLineDash(highlighted ? [6 / scale, 4 / scale] : []);
      traceEdge(context, edge);
    }
    layer.style.transform = `translate(${offset[0]}px, ${offset[1]}px) scale(${scale})`;
  }

  function navigate() {
    graph = snapshot.graphs.get(current.at(-1)?.graph ?? ROOT);
    if (!graph) return;
    crumbs.replaceChildren();
    current.forEach((step, index) => {
      const button = element("button", "", `${index ? "› " : ""}${step.name} #${step.id}`);
      button.type = "button";
      button.disabled = index === current.length - 1;
      button.onclick = () => {
        current = current.slice(0, index + 1);
        selected = undefined;
        navigate();
      };
      crumbs.append(button);
    });
    layer.replaceChildren();
    for (const node of graph.nodes.values()) {
      const [x, y, width, height] = bounds(node);
      const child = snapshot.graphs.get(node.type);
      const item = element(child ? "button" : "div", "cd-readonly-node", nodeLabel(node, snapshot));
      if (child) {
        item.type = "button";
        item.onclick = () => {
          current.push({ graph: node.type, id: node.id, name: node.title || child.name || "子图" });
          selected = undefined;
          navigate();
        };
      }
      item.classList.toggle("cd-readonly-selected", selected?.node === node.id);
      Object.assign(item.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
      layer.append(item);
      for (const input of [true, false]) {
        for (const port of input ? node.inputs : node.outputs) {
          const [portX, portY] = portPosition(node, port, input);
          const dot = element("span", "cd-readonly-port");
          dot.title = port.label ?? port.name ?? "";
          Object.assign(dot.style, { left: `${portX}px`, top: `${portY}px` });
          layer.append(dot);
        }
      }
    }
    const focusNodes = selected?.edge ? [selected.edge.source, selected.edge.target] :
      [graph.nodes.get(selected?.node)].filter(Boolean);
    const [x, y, width, height] = enclosing((focusNodes.length ? focusNodes : [...graph.nodes.values()]).map(bounds));
    scale = Math.max(0.03, Math.min(1.1, viewport.clientWidth / (width + 100), viewport.clientHeight / (height + 100)));
    offset = [viewport.clientWidth / 2 - (x + width / 2) * scale, viewport.clientHeight / 2 - (y + height / 2) * scale];
    draw();
  }

  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const box = viewport.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const next = Math.max(0.03, Math.min(4, scale * Math.exp(-event.deltaY * 0.002)));
    offset = [x - (x - offset[0]) * next / scale, y - (y - offset[1]) * next / scale];
    scale = next;
    draw();
  }, { passive: false });
  viewport.onpointerdown = (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    drag = [event.clientX - offset[0], event.clientY - offset[1]];
    viewport.setPointerCapture(event.pointerId);
  };
  viewport.onpointermove = (event) => {
    if (!drag) return;
    offset = [event.clientX - drag[0], event.clientY - drag[1]];
    draw();
  };
  viewport.onlostpointercapture = () => { drag = undefined; };
  const observer = new ResizeObserver(draw);
  observer.observe(viewport);
  dialog.addEventListener("close", () => {
    observer.disconnect();
    dialog.remove();
  }, { once: true });
  dialog.showModal();
  navigate();
  return dialog;
}
